import { unpackToolUseId } from "./ids.js";
import { isEmptyObjectSchema, sanitizeSchema } from "./schema.js";

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);

export function toGeminiRequest(body, model) {
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
    generationConfig.stopSequences = body.stop_sequences.filter((entry) => typeof entry === "string" && entry);
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

export function toThinkingConfig(thinking, model) {
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

export function toSystemText(system) {
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

export function toGeminiContents(messages, model) {
  const toolUseNames = new Map();
  const contents = [];
  for (const message of messages) {
    const role = message?.role === "assistant" ? "model" : "user";
    const parts = toGeminiParts(message?.content, toolUseNames, model);
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

function toGeminiParts(content, toolUseNames, model) {
  const parts = [];
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
  if (!Array.isArray(blocks)) return parts;

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
        // thinking, redacted_thinking, document, ... have no Gemini equivalent.
        break;
    }
  }
  return parts;
}

export function imageSourceToPart(source) {
  if (!source || typeof source !== "object") return null;
  if (source.type !== "base64" || typeof source.data !== "string" || !source.data) return null;
  const mimeType = SUPPORTED_IMAGE_TYPES.has(source.media_type) ? source.media_type : "image/png";
  return { inlineData: { mimeType, data: source.data } };
}

function toFunctionResponsePart(block, toolUseNames, model) {
  const { cleanId } = unpackToolUseId(block.tool_use_id);
  // The map is keyed by the full packed id because that is what the client
  // echoes back. When the matching tool_use turn is absent from history we fall
  // back to the *clean* id — the packed form carries a base64 signature suffix
  // that is not a legal function name.
  const name = toolUseNames.get(block.tool_use_id) ?? cleanId ?? "unknown_tool";

  let text = "";
  const mediaParts = [];
  const content = block.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") {
        text += text ? `\n${item}` : item;
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

export function toFunctionDeclarations(tools) {
  if (!Array.isArray(tools)) return [];
  const declarations = [];
  for (const tool of tools) {
    if (!tool?.name || typeof tool.name !== "string") continue;
    const declaration = { name: tool.name };
    if (typeof tool.description === "string" && tool.description) {
      declaration.description = tool.description;
    }
    if (tool.input_schema && typeof tool.input_schema === "object") {
      const parameters = sanitizeSchema(tool.input_schema);
      if (!isEmptyObjectSchema(parameters)) declaration.parameters = parameters;
    }
    declarations.push(declaration);
  }
  return declarations;
}

export function toToolConfig(toolChoice) {
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
