const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
      return handleMessages(request, env);
    }
    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return Response.json(
        {
          object: "list",
          data: [
            { id: "claude-sonnet-4-5", object: "model", created: 1700000000, owned_by: "anthropic" },
            { id: "claude-3-5-sonnet-20241022", object: "model", created: 1700000000, owned_by: "anthropic" },
            { id: "claude-3-7-sonnet-20250219", object: "model", created: 1700000000, owned_by: "anthropic" },
            { id: "gemini-3.7-flash", object: "model", created: 1700000000, owned_by: "google" },
            { id: "gemini-3.6-flash", object: "model", created: 1700000000, owned_by: "google" },
          ],
        },
        { headers: corsHeaders() },
      );
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json(
        { ok: true, upstream: "google-ai-studio", model: env.GEMINI_MODEL_ID },
        { headers: corsHeaders() },
      );
    }
    return errorResponse(404, "not_found_error", `unknown route: ${request.method} ${url.pathname}`);
  },
};

async function handleMessages(request, env) {
  if (!env.GEMINI_API_KEY) {
    return errorResponse(500, "api_error", "GEMINI_API_KEY is not configured");
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request_error", "body must be valid JSON");
  }
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(400, "invalid_request_error", "messages: Field required");
  }
  if (body.max_tokens == null) {
    return errorResponse(400, "invalid_request_error", "max_tokens: Field required");
  }

  const model = resolveModel(body.model, env);
  const geminiRequest = toGeminiRequest(body, model);
  const streaming = body.stream === true;
  const endpoint = streaming
    ? `${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse`
    : `${GEMINI_BASE}/models/${model}:generateContent`;

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify(geminiRequest),
    });
  } catch (err) {
    return errorResponse(502, "api_error", `failed to reach Gemini: ${err?.message ?? err}`);
  }

  if (!upstream.ok) {
    return upstreamErrorResponse(upstream);
  }

  if (streaming) {
    return new Response(translateStream(upstream, body.model), {
      status: 200,
      headers: { ...corsHeaders(), "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  let geminiResponse;
  try {
    geminiResponse = await upstream.json();
  } catch {
    return errorResponse(502, "api_error", "Gemini returned invalid JSON");
  }

  if (!geminiResponse.candidates?.length) {
    const blockReason = geminiResponse.promptFeedback?.blockReason;
    if (blockReason) {
      return errorResponse(400, "invalid_request_error", `request blocked by Gemini: ${blockReason}`);
    }
  }

  return Response.json(toAnthropicResponse(geminiResponse, body.model), {
    status: 200,
    headers: { ...corsHeaders(), "content-type": "application/json" },
  });
}

function resolveModel(requested, env) {
  if (typeof requested === "string" && requested.startsWith("gemini")) {
    return requested;
  }
  return env.GEMINI_MODEL_ID;
}

function toGeminiRequest(body, model) {
  const request = { contents: toGeminiContents(body.messages, model) };

  const systemText = toSystemText(body.system);
  if (systemText) {
    request.systemInstruction = { parts: [{ text: systemText }] };
  }

  const generationConfig = {};
  if (body.max_tokens != null) generationConfig.maxOutputTokens = body.max_tokens;
  if (body.temperature != null) generationConfig.temperature = body.temperature;
  if (body.top_p != null) generationConfig.topP = body.top_p;
  if (body.top_k != null) generationConfig.topK = body.top_k;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    generationConfig.stopSequences = body.stop_sequences;
  }
  const thinkingConfig = toThinkingConfig(body.thinking, model);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig;
  }

  const declarations = toFunctionDeclarations(body.tools);
  if (declarations.length > 0) {
    request.tools = [{ functionDeclarations: declarations }];
    const toolConfig = toToolConfig(body.tool_choice);
    if (toolConfig) request.toolConfig = toolConfig;
  }

  return request;
}

function toThinkingConfig(thinking, model) {
  const isGemini3 = typeof model === "string" && model.includes("gemini-3");
  if (thinking && typeof thinking === "object" && thinking.type === "enabled") {
    if (isGemini3) {
      return { thinkingLevel: (thinking.budget_tokens ?? 0) >= 8192 ? "high" : "low" };
    }
    return { thinkingBudget: thinking.budget_tokens ?? -1 };
  }
  if (isGemini3) return { thinkingLevel: "low" };
  if (thinking && typeof thinking === "object" && thinking.type === "disabled") {
    return { thinkingBudget: 0 };
  }
  return null;
}

function toSystemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

function toGeminiContents(messages, model) {
  const toolUseNames = new Map();
  const contents = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user";
    const parts = toGeminiParts(message.content, message.role, toolUseNames, model);
    if (parts.length === 0) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }
  return contents;
}

function toGeminiParts(content, role, toolUseNames, model) {
  const parts = [];
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content ?? [];
  for (const block of blocks) {
    if (typeof block === "string") {
      if (block) parts.push({ text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text) parts.push({ text: block.text });
        break;
      case "image": {
        const part = imageSourceToPart(block.source);
        if (part) parts.push(part);
        break;
      }
      case "tool_use": {
        if (block.id && block.name) toolUseNames.set(block.id, block.name);
        const { cleanId, signature } = unpackToolUseId(block.id);
        const functionCall = { name: block.name, args: block.input ?? {} };
        if (forwardsFunctionCallId(model) && cleanId) functionCall.id = cleanId;
        const part = { functionCall };
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
        break;
      }
      case "tool_result":
        parts.push(toFunctionResponsePart(block, toolUseNames, model));
        break;
      default:
        break;
    }
  }
  return parts;
}

function imageSourceToPart(source) {
  if (!source || typeof source !== "object") return null;
  if (source.type === "base64" && typeof source.data === "string") {
    return { inlineData: { mimeType: source.media_type ?? "image/png", data: source.data } };
  }
  return null;
}

function toFunctionResponsePart(block, toolUseNames, model) {
  const name = toolUseNames.get(block.tool_use_id) ?? block.tool_use_id ?? "unknown_tool";
  const { cleanId } = unpackToolUseId(block.tool_use_id);
  let text = "";
  const mediaParts = [];
  const content = block.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") {
        text += item;
      } else if (item?.type === "text" && typeof item.text === "string") {
        text += text ? `\n${item.text}` : item.text;
      } else if (item?.type === "image") {
        const part = imageSourceToPart(item.source);
        if (part) mediaParts.push(part);
      }
    }
  }
  if (block.is_error && text) {
    text = `[error] ${text}`;
  }
  const functionResponse = { name, response: { content: text || " " } };
  if (forwardsFunctionCallId(model) && cleanId) functionResponse.id = cleanId;
  if (mediaParts.length > 0) functionResponse.parts = mediaParts;
  return { functionResponse };
}

function forwardsFunctionCallId(model) {
  return typeof model === "string" && model.includes("gemini-3");
}

const SIG_SEPARATOR = "__ts__";

function toBase64Url(value) {
  return value.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return padded + "=".repeat((4 - (padded.length % 4)) % 4);
}

function packToolUseId(functionCall, thoughtSignature) {
  const base = functionCall.id ?? newToolUseId();
  if (!thoughtSignature) return base;
  return `${base}${SIG_SEPARATOR}${toBase64Url(thoughtSignature)}`;
}

function unpackToolUseId(id) {
  if (typeof id !== "string") return { cleanId: null, signature: null };
  const separatorIndex = id.indexOf(SIG_SEPARATOR);
  if (separatorIndex < 0) return { cleanId: id, signature: null };
  return {
    cleanId: id.slice(0, separatorIndex),
    signature: fromBase64Url(id.slice(separatorIndex + SIG_SEPARATOR.length)),
  };
}

function toFunctionDeclarations(tools) {
  if (!Array.isArray(tools)) return [];
  const declarations = [];
  for (const tool of tools) {
    if (!tool?.name || typeof tool.name !== "string") continue;
    const declaration = { name: tool.name };
    if (typeof tool.description === "string" && tool.description) declaration.description = tool.description;
    if (tool.input_schema && typeof tool.input_schema === "object") {
      declaration.parameters = sanitizeSchema(tool.input_schema);
    }
    declarations.push(declaration);
  }
  return declarations;
}

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "additionalProperties",
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
  "title",
  "default",
]);

function sanitizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema && typeof schema === "object") {
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
      if (key === "const") {
        if (!out.enum) out.enum = [value];
      } else {
        out[key] = sanitizeSchema(value);
      }
    }
    if (out.required && Array.isArray(out.required)) {
      if (out.properties && typeof out.properties === "object") {
        const validKeys = new Set(Object.keys(out.properties));
        out.required = out.required.filter((name) => typeof name === "string" && validKeys.has(name));
        if (out.required.length === 0) {
          delete out.required;
        }
      } else {
        delete out.required;
      }
    }
    return out;
  }
  return schema;
}

function toToolConfig(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return null;
  const config = {};
  if (toolChoice.type === "auto") config.mode = "AUTO";
  else if (toolChoice.type === "any") config.mode = "ANY";
  else if (toolChoice.type === "none") config.mode = "NONE";
  else if (toolChoice.type === "tool" && toolChoice.name) {
    config.mode = "ANY";
    config.allowedFunctionNames = [toolChoice.name];
  } else {
    return null;
  }
  return { functionCallingConfig: config };
}

function mapStopReason(finishReason, hasToolUse) {
  if (hasToolUse) return "tool_use";
  switch (finishReason) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "RECITATION":
    case "SPII":
    case "IMAGE_SAFETY":
      return "refusal";
    default:
      return "end_turn";
  }
}

function toAnthropicResponse(geminiResponse, requestedModel) {
  const candidate = geminiResponse.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content = [];
  let hasToolUse = false;
  for (const part of parts) {
    if (!part || part.thought) continue;
    if (typeof part.text === "string") {
      content.push({ type: "text", text: part.text });
    } else if (part.functionCall) {
      hasToolUse = true;
      content.push({
        type: "tool_use",
        id: packToolUseId(part.functionCall, part.thoughtSignature),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }
  const usage = geminiResponse.usageMetadata ?? {};
  return {
    id: newMessageId(),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: mapStopReason(candidate?.finishReason, hasToolUse),
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount ?? 0,
      output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: usage.cachedContentTokenCount ?? 0,
    },
  };
}

async function* geminiSseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data);
        } catch {
          // keep-alive or malformed line
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function translateStream(upstream, requestedModel) {
  const encoder = new TextEncoder();
  const messageId = newMessageId();
  let blockIndex = -1;
  let openBlock = null;
  let finishReason = null;
  let hasToolUse = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let started = false;
  let finished = false;

  const format = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(format(event, data)));

      const openTextBlock = () => {
        closeBlock();
        blockIndex += 1;
        openBlock = { kind: "text" };
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        });
      };

      const openToolBlock = (functionCall, thoughtSignature) => {
        closeBlock();
        blockIndex += 1;
        hasToolUse = true;
        openBlock = { kind: "tool_use", args: {} };
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "tool_use",
            id: packToolUseId(functionCall, thoughtSignature),
            name: functionCall.name,
            input: {},
          },
        });
      };

      const closeBlock = () => {
        if (!openBlock) return;
        if (openBlock.kind === "tool_use") {
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(openBlock.args ?? {}) },
          });
        }
        send("content_block_stop", { type: "content_block_stop", index: blockIndex });
        openBlock = null;
      };

      const sendStart = () => {
        if (started) return;
        started = true;
        send("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: requestedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: inputTokens,
              output_tokens: 0,
              cache_creation_input_tokens: cacheCreationTokens,
              cache_read_input_tokens: cacheReadTokens,
            },
          },
        });
      };

      const sendEnd = () => {
        if (finished) return;
        finished = true;
        closeBlock();
        sendStart();
        if (blockIndex < 0) {
          openTextBlock();
          closeBlock();
        }
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: mapStopReason(finishReason, hasToolUse), stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        send("message_stop", { type: "message_stop" });
      };

      try {
        for await (const chunk of geminiSseEvents(upstream.body)) {
          if (chunk.error) {
            throw new Error(chunk.error.message ?? "Gemini stream error");
          }
          const usage = chunk.usageMetadata;
          if (usage) {
            inputTokens = usage.promptTokenCount ?? inputTokens;
            outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
            cacheReadTokens = usage.cachedContentTokenCount ?? cacheReadTokens;
          }
          sendStart();
          const candidate = chunk.candidates?.[0];
          if (!candidate) continue;
          if (candidate.finishReason) finishReason = candidate.finishReason;
          for (const part of candidate.content?.parts ?? []) {
            if (!part || part.thought) continue;
            if (typeof part.text === "string") {
              if (!part.text) continue;
              if (!openBlock || openBlock.kind !== "text") openTextBlock();
              send("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "text_delta", text: part.text },
              });
            } else if (part.functionCall) {
              if (part.functionCall.name) openToolBlock(part.functionCall, part.thoughtSignature);
              if (openBlock?.kind === "tool_use" && part.functionCall.args) {
                Object.assign(openBlock.args, part.functionCall.args);
              }
            }
          }
        }
        sendEnd();
      } catch (err) {
        sendEnd();
        send("error", {
          type: "error",
          error: { type: "api_error", message: `stream interrupted: ${err?.message ?? err}` },
        });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
}

function newMessageId() {
  return `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

function newToolUseId() {
  return `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

async function upstreamErrorResponse(upstream) {
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
  return errorResponse(status, type, `gemini: ${message}`);
}

function errorResponse(status, type, message) {
  return Response.json(
    { type: "error", error: { type, message } },
    { status, headers: { ...corsHeaders(), "content-type": "application/json" } },
  );
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "*",
  };
}
