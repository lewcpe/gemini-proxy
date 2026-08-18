// CORS is opt-in. The previous `access-control-allow-origin: *` let any page a
// user visited drive the proxy from their browser; for a proxy consumed by CLIs
// and SDKs, no CORS headers at all is the correct default.
export function corsHeaders(request, env) {
  const configured = typeof env?.ALLOWED_ORIGINS === "string" ? env.ALLOWED_ORIGINS.trim() : "";
  if (!configured) return {};

  const allowList = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const wildcard = allowList.includes("*");
  const origin = request.headers.get("origin");

  if (!wildcard && (!origin || !allowList.includes(origin))) return {};

  return {
    "access-control-allow-origin": wildcard ? "*" : origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-api-key, authorization, anthropic-version, anthropic-beta",
    "access-control-max-age": "86400",
    ...(wildcard ? {} : { vary: "Origin" }),
  };
}

export function errorResponse(status, type, message, cors = {}) {
  return Response.json(
    { type: "error", error: { type, message } },
    { status, headers: { ...cors, "content-type": "application/json" } },
  );
}

export function jsonResponse(payload, cors = {}, status = 200) {
  return Response.json(payload, {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

// Reads the body with a hard ceiling so an oversized upload cannot be buffered
// into worker memory or forwarded upstream on our key.
export async function readJsonBody(request, maxBytes) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { error: { status: 413, type: "invalid_request_error", message: `request body exceeds ${maxBytes} bytes` } };
  }

  let raw;
  try {
    raw = await readLimited(request, maxBytes);
  } catch (err) {
    if (err?.code === "TOO_LARGE") {
      return {
        error: { status: 413, type: "invalid_request_error", message: `request body exceeds ${maxBytes} bytes` },
      };
    }
    return { error: { status: 400, type: "invalid_request_error", message: "could not read request body" } };
  }

  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: { status: 400, type: "invalid_request_error", message: "body must be valid JSON" } };
  }
}

async function readLimited(request, maxBytes) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        const error = new Error("body too large");
        error.code = "TOO_LARGE";
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}
