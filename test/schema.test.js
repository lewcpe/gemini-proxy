import { describe, expect, it } from "vitest";
import { isEmptyObjectSchema, sanitizeSchema } from "../src/translate/schema.js";

describe("sanitizeSchema", () => {
  it("inlines $ref and drops $defs instead of leaving an untyped husk", () => {
    const out = sanitizeSchema({
      type: "object",
      properties: { addr: { $ref: "#/$defs/Address" } },
      required: ["addr"],
      $defs: { Address: { type: "object", properties: { city: { type: "string" } } } },
    });

    expect(out.$defs).toBeUndefined();
    expect(out.properties.addr).toEqual({ type: "object", properties: { city: { type: "string" } } });
    expect(out.required).toEqual(["addr"]);
  });

  it("resolves $ref through #/definitions and JSON-pointer escapes", () => {
    const out = sanitizeSchema({
      type: "object",
      properties: { a: { $ref: "#/definitions/we~1ird" } },
      definitions: { "we/ird": { type: "string" } },
    });
    expect(out.properties.a).toEqual({ type: "string" });
  });

  it("lets sibling keys override the inlined target", () => {
    const out = sanitizeSchema({
      type: "object",
      properties: { a: { $ref: "#/$defs/S", description: "override" } },
      $defs: { S: { type: "string", description: "original" } },
    });
    expect(out.properties.a).toEqual({ type: "string", description: "override" });
  });

  it("terminates recursive $ref without blowing the stack", () => {
    const out = sanitizeSchema({
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
    });
    expect(out.properties.node.properties.child).toEqual({ type: "object" });
  });

  it("falls back to a typed object for an unresolvable $ref", () => {
    const out = sanitizeSchema({ type: "object", properties: { a: { $ref: "#/$defs/Missing" } } });
    expect(out.properties.a).toEqual({ type: "object" });
  });

  it("does not fetch external $ref documents", () => {
    const out = sanitizeSchema({ type: "object", properties: { a: { $ref: "https://evil.test/schema.json" } } });
    expect(out.properties.a).toEqual({ type: "object" });
  });

  it("strips unsupported keywords", () => {
    const out = sanitizeSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      title: "Thing",
      additionalProperties: false,
      properties: { n: { type: "integer", minimum: 1, maximum: 10, default: 3 } },
    });
    expect(out).toEqual({ type: "object", properties: { n: { type: "integer" } } });
  });

  it("keeps only formats Gemini understands", () => {
    const out = sanitizeSchema({
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        when: { type: "string", format: "date-time" },
      },
    });
    expect(out.properties.url).toEqual({ type: "string" });
    expect(out.properties.when).toEqual({ type: "string", format: "date-time" });
  });

  it("converts const to enum and infers its type", () => {
    expect(sanitizeSchema({ const: "z" })).toEqual({ type: "string", enum: ["z"] });
    expect(sanitizeSchema({ const: 4 })).toEqual({ type: "integer", enum: [4] });
  });

  it("collapses Optional[X] anyOf into a nullable schema", () => {
    const out = sanitizeSchema({
      type: "object",
      properties: { note: { anyOf: [{ type: "string" }, { type: "null" }] } },
    });
    expect(out.properties.note).toEqual({ type: "string", nullable: true });
  });

  it("keeps genuine unions as anyOf and rewrites oneOf to anyOf", () => {
    const out = sanitizeSchema({ oneOf: [{ type: "string" }, { type: "integer" }] });
    expect(out).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] });
  });

  it("collapses array-valued type into a scalar plus nullable", () => {
    expect(sanitizeSchema({ type: ["string", "null"] })).toEqual({ type: "string", nullable: true });
  });

  it("merges allOf branches", () => {
    const out = sanitizeSchema({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "integer" } }, required: ["b"] },
      ],
    });
    expect(out.type).toBe("object");
    expect(Object.keys(out.properties).sort()).toEqual(["a", "b"]);
    expect(out.required.sort()).toEqual(["a", "b"]);
  });

  it("drops required entries with no matching property", () => {
    const out = sanitizeSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a", "ghost"] });
    expect(out.required).toEqual(["a"]);
  });

  it("removes required entirely when nothing survives", () => {
    const out = sanitizeSchema({ type: "object", properties: {}, required: ["ghost"] });
    expect(out.required).toBeUndefined();
  });

  it("gives every node a type", () => {
    const out = sanitizeSchema({ properties: { a: { items: { type: "string" } } } });
    expect(out.type).toBe("object");
    expect(out.properties.a.type).toBe("array");
  });

  it("passes through non-object inputs untouched", () => {
    expect(sanitizeSchema(null)).toBeNull();
    expect(sanitizeSchema("x")).toBe("x");
  });
});

describe("isEmptyObjectSchema", () => {
  it("detects zero-argument parameter schemas", () => {
    expect(isEmptyObjectSchema({ type: "object", properties: {} })).toBe(true);
    expect(isEmptyObjectSchema({ type: "object" })).toBe(true);
    expect(isEmptyObjectSchema({ type: "object", properties: { a: { type: "string" } } })).toBe(false);
  });
});
