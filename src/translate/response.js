import { newMessageId, packToolUseId } from "./ids.js";

const REFUSAL_FINISH_REASONS = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "RECITATION", "SPII", "IMAGE_SAFETY"]);

export function mapStopReason(finishReason, hasToolUse) {
  // Truncation outranks tool use: a functionCall cut short by the token budget
  // has incomplete arguments, and reporting `tool_use` invites the client to
  // execute it anyway.
  if (finishReason === "MAX_TOKENS") return "max_tokens";
  if (REFUSAL_FINISH_REASONS.has(finishReason)) return "refusal";
  if (hasToolUse) return "tool_use";
  return "end_turn";
}

// Gemini's promptTokenCount is inclusive of cachedContentTokenCount, whereas
// Anthropic's input_tokens excludes cache reads. Forwarding the raw number makes
// every cached turn double-count against client-side cost accounting.
export function toUsage(usageMetadata) {
  const usage = usageMetadata ?? {};
  const cached = usage.cachedContentTokenCount ?? 0;
  const prompt = usage.promptTokenCount ?? 0;
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    // Gemini's implicit caching has no explicit write step to bill for.
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

// Anthropic strips a matched stop sequence and names it in stop_sequence.
// Gemini usually strips it too but reports finishReason STOP either way, giving
// us no way to tell a stop-sequence hit from a natural ending — so this is a
// safety net for the case where the sequence does reach the output, not a
// reliable signal. See the stop-sequence caveat in the README.
export function detectStopSequence(text, stopSequences) {
  if (typeof text !== "string" || !Array.isArray(stopSequences)) return null;
  for (const sequence of stopSequences) {
    if (typeof sequence === "string" && sequence && text.endsWith(sequence)) return sequence;
  }
  return null;
}

export function toAnthropicResponse(geminiResponse, requestedModel, stopSequences) {
  const candidate = geminiResponse?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content = [];
  let hasToolUse = false;

  for (const part of parts) {
    if (!part || part.thought) continue;
    if (typeof part.text === "string") {
      if (!part.text) continue;
      const last = content[content.length - 1];
      if (last?.type === "text") last.text += part.text;
      else content.push({ type: "text", text: part.text });
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

  let stopReason = mapStopReason(candidate?.finishReason, hasToolUse);
  let stopSequence = null;
  if (stopReason === "end_turn") {
    const lastBlock = content[content.length - 1];
    const matched = lastBlock?.type === "text" ? detectStopSequence(lastBlock.text, stopSequences) : null;
    if (matched) {
      lastBlock.text = lastBlock.text.slice(0, -matched.length);
      if (!lastBlock.text) content.pop();
      stopReason = "stop_sequence";
      stopSequence = matched;
    }
  }

  return {
    id: newMessageId(),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage: toUsage(geminiResponse?.usageMetadata),
  };
}
