import { newMessageId, packToolUseId } from "./ids.js";
import { detectStopSequence, mapStopReason, toUsage } from "./response.js";

// Takes a reader rather than the body so the caller retains the handle needed
// to cancel it: once the reader holds the lock, body.cancel() throws.
export async function* geminiSseEvents(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) break;
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

export function translateStream(upstream, options = {}) {
  const { model: requestedModel, stopSequences = [], abortController = null, includeThinking = false } = options;
  const encoder = new TextEncoder();
  const messageId = newMessageId();
  const reader = upstream.body?.getReader() ?? null;

  // Stop sequences arrive inside the text deltas. Hold back a tail long enough
  // to retract a match before it reaches the client, but only when the request
  // actually asked for one — otherwise stream through untouched.
  const holdBack = stopSequences.length > 0 ? Math.max(...stopSequences.map((entry) => entry.length)) : 0;

  let blockIndex = -1;
  let openBlock = null;
  let finishReason = null;
  let hasToolUse = false;
  let usageMetadata = null;
  let started = false;
  let terminated = false;
  let accumulatedText = "";
  let pendingText = "";
  let emittedLength = 0;

  const format = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(format(event, data)));

      const sendTextDelta = (text) => {
        if (!text) return;
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text },
        });
        emittedLength += text.length;
      };

      const flushPending = () => {
        const text = pendingText;
        pendingText = "";
        sendTextDelta(text);
      };

      const closeBlock = () => {
        if (!openBlock) return;
        if (openBlock.kind === "text") {
          flushPending();
        } else if (openBlock.kind === "thinking") {
          // Anthropic delivers the signature as a final delta before the stop.
          if (openBlock.signature) {
            send("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "signature_delta", signature: openBlock.signature },
            });
          }
        } else if (openBlock.kind === "tool_use") {
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(openBlock.args ?? {}) },
          });
        }
        send("content_block_stop", { type: "content_block_stop", index: blockIndex });
        openBlock = null;
      };

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

      const openThinkingBlock = () => {
        closeBlock();
        blockIndex += 1;
        openBlock = { kind: "thinking", signature: "" };
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "thinking", thinking: "" },
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

      const pushText = (text) => {
        accumulatedText += text;
        if (holdBack <= 0) {
          sendTextDelta(text);
          return;
        }
        pendingText += text;
        if (pendingText.length > holdBack) {
          const flushable = pendingText.slice(0, pendingText.length - holdBack);
          pendingText = pendingText.slice(pendingText.length - holdBack);
          sendTextDelta(flushable);
        }
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
            usage: { ...toUsage(usageMetadata), output_tokens: 0 },
          },
        });
      };

      // Retract a trailing stop sequence from the withheld tail. holdBack is the
      // longest stop sequence, so the match always lies inside pendingText.
      const settleStopSequence = () => {
        if (openBlock?.kind !== "text") return null;
        const matched = detectStopSequence(accumulatedText, stopSequences);
        if (!matched) {
          flushPending();
          return null;
        }
        const desiredLength = accumulatedText.length - matched.length;
        pendingText = "";
        if (desiredLength > emittedLength) {
          sendTextDelta(accumulatedText.slice(emittedLength, desiredLength));
        }
        return matched;
      };

      const sendEnd = () => {
        if (terminated) return;
        terminated = true;
        sendStart();
        const stopSequence = settleStopSequence();
        closeBlock();
        if (blockIndex < 0) {
          // Anthropic messages always carry at least one content block.
          openTextBlock();
          closeBlock();
        }
        send("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: stopSequence ? "stop_sequence" : mapStopReason(finishReason, hasToolUse),
            stop_sequence: stopSequence,
          },
          usage: toUsage(usageMetadata),
        });
        send("message_stop", { type: "message_stop" });
      };

      // A failed stream must NOT be terminated as a successful turn: emitting
      // message_delta/message_stop first would let the client treat a truncated
      // response as complete, with the error arriving after it stopped looking.
      const sendError = (err) => {
        if (terminated) return;
        terminated = true;
        sendStart();
        if (openBlock) {
          send("content_block_stop", { type: "content_block_stop", index: blockIndex });
          openBlock = null;
        }
        send("error", {
          type: "error",
          error: { type: "api_error", message: `stream interrupted: ${err?.message ?? err}` },
        });
      };

      try {
        if (!reader) throw new Error("upstream returned no body");
        for await (const chunk of geminiSseEvents(reader)) {
          if (chunk.error) throw new Error(chunk.error.message ?? "Gemini stream error");
          if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
          sendStart();

          const candidate = chunk.candidates?.[0];
          if (!candidate) continue;
          if (candidate.finishReason) finishReason = candidate.finishReason;

          for (const part of candidate.content?.parts ?? []) {
            if (!part) continue;
            if (part.thought) {
              if (!includeThinking) continue;
              // Note: Gemini usually sends the turn's signature on a trailing
              // part *after* the answer text, by which point this block has
              // closed and its signature_delta has already gone out. Streamed
              // thinking blocks are therefore often unsigned. That is safe —
              // Gemini accepts unsigned thought parts replayed in history.
              const thought = typeof part.text === "string" ? part.text : "";
              if (thought && openBlock?.kind !== "thinking") openThinkingBlock();
              if (openBlock?.kind !== "thinking") continue;
              // A trailing part may carry only the signature for the thought
              // that preceded it.
              if (part.thoughtSignature) openBlock.signature = part.thoughtSignature;
              if (thought) {
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "thinking_delta", thinking: thought },
                });
              }
              continue;
            }
            if (typeof part.text === "string") {
              if (!part.text) continue;
              if (openBlock?.kind !== "text") openTextBlock();
              pushText(part.text);
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
        sendError(err);
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },

    // Without this, a client hanging up mid-stream leaves the upstream response
    // draining in the background — still generating, still billed.
    cancel(reason) {
      abortController?.abort(reason);
      try {
        return reader?.cancel(reason).catch(() => {});
      } catch {
        // The reader releases its lock once the body is drained; by then there
        // is nothing left to cancel, but fall back rather than throw.
        return upstream.body?.cancel(reason).catch(() => {});
      }
    },
  });
}
