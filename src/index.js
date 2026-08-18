import { authorize } from "./auth.js";
import { corsHeaders, errorResponse, jsonResponse, readJsonBody } from "./http.js";
import { modelCatalog, resolveModel } from "./models.js";
import { thinkingEnabled, toGeminiRequest } from "./translate/request.js";
import { toAnthropicResponse } from "./translate/response.js";
import { translateStream } from "./translate/stream.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;

const MESSAGES_PATHS = new Set(["/v1/messages", "/messages"]);
const COUNT_TOKENS_PATHS = new Set(["/v1/messages/count_tokens", "/messages/count_tokens"]);
const MODELS_PATHS = new Set(["/v1/models", "/models"]);
const HEALTH_PATHS = new Set(["/", "/health"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Unauthenticated so uptime checks work; deliberately says nothing about
    // the configured model or upstream credentials.
    if (request.method === "GET" && HEALTH_PATHS.has(url.pathname)) {
      return jsonResponse({ ok: true, upstream: "google-ai-studio" }, cors);
    }

    const isKnownRoute =
      (request.method === "POST" && (MESSAGES_PATHS.has(url.pathname) || COUNT_TOKENS_PATHS.has(url.pathname))) ||
      (request.method === "GET" && MODELS_PATHS.has(url.pathname));
    if (!isKnownRoute) {
      return errorResponse(404, "not_found_error", `unknown route: ${request.method} ${url.pathname}`, cors);
    }

    const auth = await authorize(request, env);
    if (!auth.ok) {
      return errorResponse(auth.status, auth.type, auth.message, cors);
    }

    if (request.method === "GET") {
      return jsonResponse(modelCatalog(env), cors);
    }
    if (COUNT_TOKENS_PATHS.has(url.pathname)) {
      return handleCountTokens(request, env, cors);
    }
    return handleMessages(request, env, cors);
  },
};

async function handleMessages(request, env, cors) {
  const prepared = await prepareRequest(request, env, cors);
  if (prepared.response) return prepared.response;
  const { body, model, geminiRequest } = prepared;

  const streaming = body.stream === true;
  const endpoint = streaming
    ? `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    : `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;

  const call = await callGemini(endpoint, geminiRequest, env, cors);
  if (call.response) return call.response;
  const { upstream, controller, clearTimer } = call;

  if (streaming) {
    // The connect timeout has done its job now that headers are in; the body is
    // bounded by the client and by the worker's own limits from here.
    clearTimer();
    const stream = translateStream(upstream, {
      model: body.model,
      stopSequences: Array.isArray(body.stop_sequences) ? body.stop_sequences.filter((s) => typeof s === "string" && s) : [],
      abortController: controller,
      includeThinking: thinkingEnabled(body),
    });
    return new Response(stream, {
      status: 200,
      headers: { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  let geminiResponse;
  try {
    geminiResponse = await upstream.json();
  } catch {
    return errorResponse(502, "api_error", "Gemini returned invalid JSON", cors);
  } finally {
    clearTimer();
  }

  if (!geminiResponse.candidates?.length) {
    const blockReason = geminiResponse.promptFeedback?.blockReason;
    if (blockReason) {
      return errorResponse(400, "invalid_request_error", `request blocked by Gemini: ${blockReason}`, cors);
    }
  }

  const message = toAnthropicResponse(geminiResponse, body.model, {
    stopSequences: body.stop_sequences,
    includeThinking: thinkingEnabled(body),
  });
  return jsonResponse(message, cors);
}

async function handleCountTokens(request, env, cors) {
  const prepared = await prepareRequest(request, env, cors, { requireMaxTokens: false });
  if (prepared.response) return prepared.response;
  const { model, geminiRequest } = prepared;

  const endpoint = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:countTokens`;
  const payload = {
    generateContentRequest: {
      model: `models/${model}`,
      contents: geminiRequest.contents,
      ...(geminiRequest.systemInstruction ? { systemInstruction: geminiRequest.systemInstruction } : {}),
      ...(geminiRequest.tools ? { tools: geminiRequest.tools } : {}),
    },
  };

  const call = await callGemini(endpoint, payload, env, cors);
  if (call.response) return call.response;

  try {
    const counted = await call.upstream.json();
    return jsonResponse({ input_tokens: counted.totalTokens ?? 0 }, cors);
  } catch {
    return errorResponse(502, "api_error", "Gemini returned invalid JSON", cors);
  } finally {
    call.clearTimer();
  }
}

// Shared parse/validate/translate path for both message routes.
async function prepareRequest(request, env, cors, { requireMaxTokens = true } = {}) {
  if (!env.GEMINI_API_KEY) {
    return { response: errorResponse(500, "api_error", "GEMINI_API_KEY is not configured", cors) };
  }

  const maxBytes = positiveInteger(env.MAX_REQUEST_BYTES) ?? DEFAULT_MAX_REQUEST_BYTES;
  const parsed = await readJsonBody(request, maxBytes);
  if (parsed.error) {
    return { response: errorResponse(parsed.error.status, parsed.error.type, parsed.error.message, cors) };
  }
  const body = parsed.value;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { response: errorResponse(400, "invalid_request_error", "body must be a JSON object", cors) };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { response: errorResponse(400, "invalid_request_error", "messages: Field required", cors) };
  }
  if (body.model != null && typeof body.model !== "string") {
    return { response: errorResponse(400, "invalid_request_error", "model: Input should be a valid string", cors) };
  }
  if (requireMaxTokens) {
    if (body.max_tokens == null) {
      return { response: errorResponse(400, "invalid_request_error", "max_tokens: Field required", cors) };
    }
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
      return {
        response: errorResponse(400, "invalid_request_error", "max_tokens: Input should be a positive integer", cors),
      };
    }
  }

  const resolved = resolveModel(body.model, env);
  if (resolved.error) {
    return { response: errorResponse(resolved.error.status, resolved.error.type, resolved.error.message, cors) };
  }

  const geminiRequest = toGeminiRequest(body, resolved.model, { env });
  if (geminiRequest.contents.length === 0) {
    return {
      response: errorResponse(400, "invalid_request_error", "messages: no translatable content in any message", cors),
    };
  }

  return { body, model: resolved.model, geminiRequest };
}

async function callGemini(endpoint, payload, env, cors) {
  const timeoutMs = positiveInteger(env.UPSTREAM_TIMEOUT_MS) ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs);
  const clearTimer = () => clearTimeout(timer);

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimer();
    if (controller.signal.aborted) {
      return { response: errorResponse(504, "api_error", `Gemini did not respond within ${timeoutMs}ms`, cors) };
    }
    return { response: errorResponse(502, "api_error", `failed to reach Gemini: ${err?.message ?? err}`, cors) };
  }

  if (!upstream.ok) {
    const response = await upstreamErrorResponse(upstream, cors);
    clearTimer();
    return { response };
  }

  return { upstream, controller, clearTimer };
}

async function upstreamErrorResponse(upstream, cors) {
  let message = `Gemini returned HTTP ${upstream.status}`;
  try {
    const payload = await upstream.json();
    if (payload?.error?.message) message = payload.error.message;
  } catch {
    // body was not JSON
  }

  let type = "api_error";
  let status = upstream.status;
  if (status === 400) type = "invalid_request_error";
  else if (status === 401 || status === 403) type = "authentication_error";
  else if (status === 404) type = "not_found_error";
  else if (status === 429) type = "rate_limit_error";
  else if (status === 529) type = "overloaded_error";
  else if (status >= 500) status = 502;

  return errorResponse(status, type, `gemini: ${message}`, cors);
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
