// This worker holds a Gemini API key and will spend it for anyone who can reach
// it. workers.dev hostnames are enumerable and routinely scanned, so the proxy
// fails closed: without PROXY_API_KEY configured it serves nothing.

// Comparing SHA-256 digests rather than the raw strings keeps the comparison
// both constant-time and constant-length, so neither the key nor its length
// leaks through response timing.
export async function constantTimeEquals(a, b) {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const viewA = new Uint8Array(digestA);
  const viewB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < viewA.length; i++) diff |= viewA[i] ^ viewB[i];
  return diff === 0;
}

export function presentedKey(request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) return apiKey;
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1];
  }
  return null;
}

export async function authorize(request, env) {
  const expected = env.PROXY_API_KEY;
  if (typeof expected !== "string" || expected === "") {
    return {
      ok: false,
      status: 500,
      type: "api_error",
      message: "PROXY_API_KEY is not configured; refusing to serve an unauthenticated proxy",
    };
  }

  const presented = presentedKey(request);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      type: "authentication_error",
      message: "missing API key; supply it via the x-api-key or Authorization: Bearer header",
    };
  }
  if (!(await constantTimeEquals(presented, expected))) {
    return { ok: false, status: 401, type: "authentication_error", message: "invalid API key" };
  }
  return { ok: true };
}
