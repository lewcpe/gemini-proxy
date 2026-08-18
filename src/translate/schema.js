// Gemini accepts a narrow OpenAPI-flavoured subset of JSON Schema and rejects
// the request outright when it meets a keyword it does not know. Clients built
// on Pydantic, zod, or the MCP SDK routinely emit the full draft-2020-12
// vocabulary, so tool schemas have to be rewritten before they go upstream.

// Keys Gemini rejects outright. Constraint keywords (minimum, pattern, ...) are
// dropped rather than forwarded: they are advisory for the model anyway, and
// forwarding them has been observed to 400.
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "$comment",
  "definitions",
  "additionalProperties",
  "additionalItems",
  "prefixItems",
  "propertyNames",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "dependentRequired",
  "dependentSchemas",
  "contains",
  "if",
  "then",
  "else",
  "not",
  "readOnly",
  "writeOnly",
  "deprecated",
  "examples",
  "title",
  "default",
]);

// Gemini validates `format` against a short list and 400s on anything else,
// which is how `format: "uri"` from a Pydantic model breaks a whole tool call.
const SUPPORTED_FORMATS = new Set(["enum", "date-time", "float", "double", "int32", "int64"]);

const MAX_DEPTH = 64;

export function sanitizeSchema(schema) {
  return walk(schema, schema, new Set(), 0);
}

function walk(node, root, refStack, depth) {
  if (Array.isArray(node)) return node.map((item) => walk(item, root, refStack, depth + 1));
  if (!node || typeof node !== "object") return node;
  if (depth > MAX_DEPTH) return { type: "object" };

  if (typeof node.$ref === "string") return inlineRef(node, root, refStack, depth);
  if (Array.isArray(node.allOf)) return mergeAllOf(node, root, refStack, depth);

  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) return collapseVariants(node, variants, root, refStack, depth);

  return plainNode(node, root, refStack, depth);
}

// `$ref` has no Gemini equivalent, so the target is inlined. Stripping the
// keyword and leaving the empty husk behind — as the first version did — yields
// an untyped `{}` that Gemini rejects.
function inlineRef(node, root, refStack, depth) {
  if (refStack.has(node.$ref)) {
    // Recursive models cannot be inlined to a fixed depth. An untyped object is
    // the least-wrong terminator: the model can still fill it in.
    return ensureType({ ...omit(node, ["$ref"]), type: "object" });
  }
  const target = resolvePointer(root, node.$ref);
  if (!target || typeof target !== "object") return { type: "object" };

  const nextStack = new Set(refStack).add(node.$ref);
  const inlined = walk(target, root, nextStack, depth + 1);
  // Sibling keys next to a $ref (description, ...) override the target's.
  // rawNode, not plainNode: a defaulted `type` here would mask the target's.
  const siblings = rawNode(omit(node, ["$ref"]), root, refStack, depth);
  return ensureType({ ...inlined, ...siblings });
}

function mergeAllOf(node, root, refStack, depth) {
  let merged = {};
  for (const branch of node.allOf) {
    merged = mergeSchemas(merged, walk(branch, root, refStack, depth + 1));
  }
  const rest = rawNode(omit(node, ["allOf"]), root, refStack, depth);
  return ensureType(mergeSchemas(merged, rest));
}

// `anyOf: [X, {type: "null"}]` is how every Optional[X] arrives. Gemini models
// it as `nullable`, and a single surviving variant is better expressed inline
// than as a one-element union.
function collapseVariants(node, variants, root, refStack, depth) {
  const walked = variants.map((variant) => walk(variant, root, refStack, depth + 1));
  const nonNull = walked.filter((variant) => variant?.type !== "null");
  const nullable = walked.length !== nonNull.length;
  const rest = rawNode(omit(node, ["anyOf", "oneOf"]), root, refStack, depth);

  if (nonNull.length === 1) {
    return ensureType({ ...nonNull[0], ...rest, ...(nullable ? { nullable: true } : {}) });
  }
  return ensureType({
    ...rest,
    anyOf: nonNull.length > 0 ? nonNull : [{ type: "object" }],
    ...(nullable ? { nullable: true } : {}),
  });
}

function plainNode(node, root, refStack, depth) {
  return ensureType(rawNode(node, root, refStack, depth));
}

// Recursion descends only into positions that actually hold schemas. Walking
// every value blindly would treat the `properties` map — and the `enum` value
// list — as schema nodes and stamp a spurious `type` onto them.
function rawNode(node, root, refStack, depth) {
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "const") {
      out.enum = [value];
      if (out.type === undefined) out.type = jsonTypeOf(value);
    } else if (key === "format") {
      if (SUPPORTED_FORMATS.has(value)) out.format = value;
    } else if (key === "properties") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const properties = {};
        for (const [name, subSchema] of Object.entries(value)) {
          properties[name] = walk(subSchema, root, refStack, depth + 1);
        }
        out.properties = properties;
      }
    } else if (key === "items") {
      out.items = walk(value, root, refStack, depth + 1);
    } else if (key === "type") {
      // Draft-2020 allows `type: ["string", "null"]`; Gemini wants a scalar.
      if (Array.isArray(value)) {
        const named = value.filter((entry) => entry !== "null");
        if (value.includes("null")) out.nullable = true;
        out.type = named[0] ?? "object";
      } else {
        out.type = value;
      }
    } else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      // Only reachable as a sibling of $ref; the normal paths intercept these.
      out.anyOf = (Array.isArray(value) ? value : []).map((entry) => walk(entry, root, refStack, depth + 1));
    } else {
      // enum values, required, description, ... are data, not schemas.
      out[key] = value;
    }
  }

  if (Array.isArray(out.required)) {
    const validKeys = new Set(out.properties && typeof out.properties === "object" ? Object.keys(out.properties) : []);
    out.required = out.required.filter((name) => typeof name === "string" && validKeys.has(name));
    if (out.required.length === 0) delete out.required;
  }

  return out;
}

// Gemini requires a `type` on every schema node.
function ensureType(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  if (node.type !== undefined || Array.isArray(node.anyOf)) return node;
  if (node.properties !== undefined) return { type: "object", ...node };
  if (node.items !== undefined) return { type: "array", ...node };
  if (Array.isArray(node.enum)) return { type: jsonTypeOf(node.enum[0]), ...node };
  return { type: "object", ...node };
}

function mergeSchemas(a, b) {
  if (!b || typeof b !== "object") return a;
  const out = { ...a, ...b };
  if (a.properties || b.properties) {
    out.properties = { ...(a.properties ?? {}), ...(b.properties ?? {}) };
  }
  if (a.required || b.required) {
    out.required = [...new Set([...(a.required ?? []), ...(b.required ?? [])])];
  }
  return out;
}

function resolvePointer(root, ref) {
  if (!ref.startsWith("#")) return undefined; // external documents are unfetchable here
  const path = ref.slice(1).replace(/^\//, "");
  if (!path) return root;
  let node = root;
  for (const rawSegment of path.split("/")) {
    if (node == null || typeof node !== "object") return undefined;
    const segment = decodeURIComponent(rawSegment).replaceAll("~1", "/").replaceAll("~0", "~");
    node = Array.isArray(node) ? node[Number(segment)] : node[segment];
  }
  return node;
}

function jsonTypeOf(value) {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (Array.isArray(value)) return "array";
  return "object";
}

function omit(node, keys) {
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

// A parameter schema with no properties should be omitted entirely rather than
// sent as an empty object, which Gemini rejects for zero-argument tools.
export function isEmptyObjectSchema(schema) {
  return (
    !!schema &&
    typeof schema === "object" &&
    schema.type === "object" &&
    (!schema.properties || Object.keys(schema.properties).length === 0) &&
    !schema.anyOf
  );
}
