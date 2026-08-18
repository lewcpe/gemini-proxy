// The model id is interpolated into the upstream URL path. Left unvalidated, a
// caller could send "gemini/../tunedModels/foo" and reach arbitrary
// generativelanguage.googleapis.com resources on our key, or "gemini-x?alt=sse&"
// to inject query parameters. Anchored pattern + no dot-segments + percent
// encoding at the call site.
const MODEL_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

export function isValidModelId(value) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 64 && MODEL_ID_PATTERN.test(value) && !value.includes("..")
  );
}

export function resolveModel(requested, env) {
  // Anything not named gemini-* is an Anthropic alias the client picked; those
  // all map onto the configured default model.
  const candidate = typeof requested === "string" && requested.startsWith("gemini") ? requested : env.GEMINI_MODEL_ID;

  if (typeof candidate !== "string" || candidate === "") {
    return { error: { status: 500, type: "api_error", message: "GEMINI_MODEL_ID is not configured" } };
  }
  if (!isValidModelId(candidate)) {
    return { error: { status: 400, type: "invalid_request_error", message: `model: invalid model id "${candidate}"` } };
  }

  const allowList = parseAllowList(env.GEMINI_ALLOWED_MODELS);
  if (allowList && !allowList.includes(candidate)) {
    return {
      error: { status: 403, type: "permission_error", message: `model: "${candidate}" is not in GEMINI_ALLOWED_MODELS` },
    };
  }

  return { model: candidate };
}

function parseAllowList(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Anthropic aliases are advertised so that clients with hardcoded Claude model
// names work unmodified; every one of them is served by GEMINI_MODEL_ID.
const ALIAS_MODELS = [
  { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5 (alias -> configured Gemini model)" },
  { id: "claude-3-5-sonnet-20241022", display_name: "Claude Sonnet 3.5 (alias -> configured Gemini model)" },
  { id: "claude-3-7-sonnet-20250219", display_name: "Claude Sonnet 3.7 (alias -> configured Gemini model)" },
];

const GEMINI_MODELS = [
  { id: "gemini-3.7-flash", display_name: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash", display_name: "Gemini 3.6 Flash" },
];

const CREATED_AT = "2024-01-01T00:00:00Z";

// Anthropic's list shape, not OpenAI's: {data: [{type: "model", ...}], has_more}.
export function modelCatalog(env) {
  const seen = new Set();
  const entries = [];
  for (const entry of [...GEMINI_MODELS, ...ALIAS_MODELS]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  const configured = env?.GEMINI_MODEL_ID;
  if (isValidModelId(configured) && !seen.has(configured)) {
    entries.unshift({ id: configured, display_name: configured });
  }

  const data = entries.map((entry) => ({
    type: "model",
    id: entry.id,
    display_name: entry.display_name,
    created_at: CREATED_AT,
  }));

  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}
