import { describe, expect, it, vi } from "vitest";
import { translateStream } from "../src/translate/stream.js";

// Builds a fake upstream whose SSE body is delivered in the given raw chunks,
// so tests can control exactly where the byte boundaries fall.
function fakeUpstream(chunks, { keepOpen = false } = {}) {
  const encoder = new TextEncoder();
  let cancelled = null;
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      // keepOpen models an upstream still generating when the client hangs up,
      // which is the only situation in which cancellation has anything to do.
      if (!keepOpen) controller.close();
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  return { upstream: { body }, cancelled: () => cancelled };
}

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

async function collect(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return parseEvents(text);
}

function parseEvents(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    const eventLine = block.match(/^event: (.+)$/m);
    const dataLine = block.match(/^data: (.+)$/m);
    if (eventLine && dataLine) events.push({ event: eventLine[1], data: JSON.parse(dataLine[1]) });
  }
  return events;
}

const textChunk = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] } }], ...extra });

describe("translateStream", () => {
  it("emits a well-formed Anthropic event sequence", async () => {
    const { upstream } = fakeUpstream([
      sse(textChunk("Hel")),
      sse(textChunk("lo")),
      sse({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } }),
    ]);
    const events = await collect(translateStream(upstream, { model: "claude-sonnet-4-5" }));

    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0].data.message.model).toBe("claude-sonnet-4-5");
    expect(events.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text)).toEqual(["Hel", "lo"]);
    expect(events.at(-2).data.delta.stop_reason).toBe("end_turn");
    expect(events.at(-2).data.usage).toEqual({
      input_tokens: 9,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("reports an interrupted stream as an error, not a completed turn", async () => {
    // The original implementation emitted message_delta + message_stop before
    // the error, so a client finalised a truncated response as successful.
    const { upstream } = fakeUpstream([sse(textChunk("partial")), sse({ error: { message: "upstream exploded" } })]);
    const events = await collect(translateStream(upstream, { model: "m" }));

    const names = events.map((e) => e.event);
    expect(names).toContain("error");
    expect(names).not.toContain("message_stop");
    expect(names).not.toContain("message_delta");
    expect(names.indexOf("content_block_stop")).toBeLessThan(names.indexOf("error"));
    expect(events.at(-1).data.error.message).toMatch(/upstream exploded/);
  });

  it("excludes cached tokens from streamed usage", async () => {
    const { upstream } = fakeUpstream([
      sse({
        candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 900, candidatesTokenCount: 5 },
      }),
    ]);
    const events = await collect(translateStream(upstream, { model: "m" }));
    expect(events.at(-2).data.usage).toEqual({
      input_tokens: 100,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 900,
    });
  });

  it("reports max_tokens even when a tool call was started", async () => {
    const { upstream } = fakeUpstream([
      sse({ candidates: [{ content: { parts: [{ functionCall: { name: "f", args: { a: 1 } } }] } }] }),
      sse({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
    ]);
    const events = await collect(translateStream(upstream, { model: "m" }));
    expect(events.at(-2).data.delta.stop_reason).toBe("max_tokens");
  });

  it("streams a tool call with accumulated arguments", async () => {
    const { upstream } = fakeUpstream([
      sse({
        candidates: [{ content: { parts: [{ functionCall: { id: "c1", name: "get_weather", args: { city: "Berlin" } } }] } }],
      }),
      sse({ candidates: [{ finishReason: "STOP" }] }),
    ]);
    const events = await collect(translateStream(upstream, { model: "m" }));

    const start = events.find((e) => e.event === "content_block_start");
    expect(start.data.content_block).toMatchObject({ type: "tool_use", id: "c1", name: "get_weather", input: {} });
    const delta = events.find((e) => e.event === "content_block_delta");
    expect(JSON.parse(delta.data.delta.partial_json)).toEqual({ city: "Berlin" });
    expect(events.at(-2).data.delta.stop_reason).toBe("tool_use");
  });

  it("always emits at least one content block", async () => {
    const { upstream } = fakeUpstream([sse({ candidates: [{ finishReason: "STOP" }] })]);
    const events = await collect(translateStream(upstream, { model: "m" }));
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("reassembles SSE events split across byte boundaries", async () => {
    const payload = sse(textChunk("hello"));
    const { upstream } = fakeUpstream([
      payload.slice(0, 12),
      payload.slice(12),
      sse({ candidates: [{ finishReason: "STOP" }] }),
    ]);
    const events = await collect(translateStream(upstream, { model: "m" }));
    expect(events.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text)).toEqual(["hello"]);
  });

  it("skips thought parts and keep-alive lines", async () => {
    const { upstream } = fakeUpstream([
      ": keep-alive\n\n",
      sse({ candidates: [{ content: { parts: [{ text: "hidden", thought: true }, { text: "shown" }] } }] }),
      "data: [DONE]\n\n",
      sse({ candidates: [{ finishReason: "STOP" }] }),
    ]);
    const events = await collect(translateStream(upstream, { model: "m" }));
    expect(events.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text)).toEqual(["shown"]);
  });

  it("withholds and strips a stop sequence spanning two deltas", async () => {
    const { upstream } = fakeUpstream([
      sse(textChunk("one two EN")),
      sse(textChunk("D")),
      sse({ candidates: [{ finishReason: "STOP" }] }),
    ]);
    const events = await collect(translateStream(upstream, { model: "m", stopSequences: ["END"] }));

    const text = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text)
      .join("");
    expect(text).toBe("one two ");
    expect(events.at(-2).data.delta.stop_reason).toBe("stop_sequence");
    expect(events.at(-2).data.delta.stop_sequence).toBe("END");
  });

  it("flushes withheld text when no stop sequence matches", async () => {
    const { upstream } = fakeUpstream([sse(textChunk("one two")), sse({ candidates: [{ finishReason: "STOP" }] })]);
    const events = await collect(translateStream(upstream, { model: "m", stopSequences: ["END"] }));
    const text = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text)
      .join("");
    expect(text).toBe("one two");
    expect(events.at(-2).data.delta.stop_reason).toBe("end_turn");
  });

  it("omits thought parts unless thinking was requested", async () => {
    const { upstream } = fakeUpstream([
      sse({ candidates: [{ content: { parts: [{ text: "hidden", thought: true }, { text: "shown" }] } }] }),
      sse({ candidates: [{ finishReason: "STOP" }] }),
    ]);
    const events = await collect(translateStream(upstream, { model: "m" }));
    expect(events.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text)).toEqual(["shown"]);
  });

  it("streams a thinking block ahead of the answer", async () => {
    const { upstream } = fakeUpstream([
      sse({ candidates: [{ content: { parts: [{ text: "step one ", thought: true }] } }] }),
      sse({ candidates: [{ content: { parts: [{ text: "step two", thought: true, thoughtSignature: "c2ln" }] } }] }),
      sse({ candidates: [{ content: { parts: [{ text: "answer" }] } }] }),
      sse({ candidates: [{ finishReason: "STOP" }] }),
    ]);
    const events = await collect(translateStream(upstream, { model: "m", includeThinking: true }));

    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const [thinkingStart, answerStart] = events.filter((e) => e.event === "content_block_start");
    expect(thinkingStart.data.content_block).toEqual({ type: "thinking", thinking: "" });
    expect(thinkingStart.data.index).toBe(0);
    expect(answerStart.data.content_block).toEqual({ type: "text", text: "" });
    expect(answerStart.data.index).toBe(1);

    const deltas = events.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta);
    expect(deltas).toEqual([
      { type: "thinking_delta", thinking: "step one " },
      { type: "thinking_delta", thinking: "step two" },
      // Anthropic delivers the signature as the last delta of the block.
      { type: "signature_delta", signature: "c2ln" },
      { type: "text_delta", text: "answer" },
    ]);
  });

  it("accepts a signature arriving in its own thought part", async () => {
    const { upstream } = fakeUpstream([
      sse({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }] } }] }),
      sse({ candidates: [{ content: { parts: [{ thought: true, thoughtSignature: "c2ln" }] } }] }),
      sse({ candidates: [{ finishReason: "STOP" }] }),
    ]);
    const events = await collect(translateStream(upstream, { model: "m", includeThinking: true }));
    const deltas = events.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta);
    expect(deltas.at(-1)).toEqual({ type: "signature_delta", signature: "c2ln" });
  });

  it("emits no signature_delta when Gemini sends no signature", async () => {
    const { upstream } = fakeUpstream([
      sse({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }] } }] }),
      sse({ candidates: [{ finishReason: "STOP" }] }),
    ]);
    const events = await collect(translateStream(upstream, { model: "m", includeThinking: true }));
    expect(events.some((e) => e.data.delta?.type === "signature_delta")).toBe(false);
  });

  it("does not withhold thinking text for stop-sequence matching", async () => {
    // Stop sequences apply to the answer, not the thought summary.
    const { upstream } = fakeUpstream([
      sse({ candidates: [{ content: { parts: [{ text: "considering END", thought: true }] } }] }),
      sse({ candidates: [{ finishReason: "STOP" }] }),
    ]);
    const events = await collect(translateStream(upstream, { model: "m", includeThinking: true, stopSequences: ["END"] }));
    const deltas = events.filter((e) => e.data.delta?.type === "thinking_delta").map((e) => e.data.delta.thinking);
    expect(deltas).toEqual(["considering END"]);
    expect(events.at(-2).data.delta.stop_reason).toBe("end_turn");
  });

  it("aborts the upstream when the client hangs up", async () => {
    const { upstream, cancelled } = fakeUpstream([sse(textChunk("hi"))], { keepOpen: true });
    const abortController = new AbortController();
    const onAbort = vi.fn();
    abortController.signal.addEventListener("abort", onAbort);

    const stream = translateStream(upstream, { model: "m", abortController });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel("client gone");

    expect(onAbort).toHaveBeenCalled();
    expect(cancelled()).toBe("client gone");
  });
});
