import { describe, expect, it } from "vitest";
import { mapStopReason, toAnthropicResponse, toUsage } from "../src/translate/response.js";

describe("toUsage", () => {
  it("excludes cached tokens from input_tokens", () => {
    // Gemini's promptTokenCount is inclusive of the cached prefix; Anthropic's
    // input_tokens is not. Forwarding it raw double-counts every cached turn.
    expect(toUsage({ promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 50 })).toEqual({
      input_tokens: 200,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 800,
    });
  });

  it("counts thinking tokens as output", () => {
    expect(toUsage({ candidatesTokenCount: 10, thoughtsTokenCount: 40 }).output_tokens).toBe(50);
  });

  it("never reports negative input tokens", () => {
    expect(toUsage({ promptTokenCount: 5, cachedContentTokenCount: 9 }).input_tokens).toBe(0);
  });

  it("defaults to zeroes when usage is absent", () => {
    expect(toUsage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

describe("mapStopReason", () => {
  it("reports truncation even when a tool call was emitted", () => {
    // A functionCall cut off by the token budget has incomplete arguments;
    // reporting tool_use would invite the client to execute it.
    expect(mapStopReason("MAX_TOKENS", true)).toBe("max_tokens");
  });

  it("maps safety finish reasons to refusal", () => {
    for (const reason of ["SAFETY", "PROHIBITED_CONTENT", "RECITATION", "SPII", "BLOCKLIST", "IMAGE_SAFETY"]) {
      expect(mapStopReason(reason, false)).toBe("refusal");
    }
  });

  it("reports tool_use for a complete tool call", () => {
    expect(mapStopReason("STOP", true)).toBe("tool_use");
  });

  it("falls back to end_turn", () => {
    expect(mapStopReason("STOP", false)).toBe("end_turn");
    expect(mapStopReason(undefined, false)).toBe("end_turn");
  });
});

describe("toAnthropicResponse", () => {
  const withParts = (parts, extra = {}) => ({
    candidates: [{ content: { parts }, finishReason: "STOP", ...extra }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
  });

  it("translates text into a single content block", () => {
    const out = toAnthropicResponse(withParts([{ text: "hello " }, { text: "world" }]), "claude-sonnet-4-5");
    expect(out.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.model).toBe("claude-sonnet-4-5");
    expect(out.id).toMatch(/^msg_/);
  });

  it("omits thought parts when thinking was not requested", () => {
    const out = toAnthropicResponse(withParts([{ text: "secret", thought: true }, { text: "shown" }]), "m");
    expect(out.content).toEqual([{ type: "text", text: "shown" }]);
  });

  it("emits a thinking block when thinking was requested", () => {
    const out = toAnthropicResponse(
      withParts([{ text: "let me think", thought: true, thoughtSignature: "YWJj" }, { text: "answer" }]),
      "m",
      { includeThinking: true },
    );
    expect(out.content).toEqual([
      { type: "thinking", thinking: "let me think", signature: "YWJj" },
      { type: "text", text: "answer" },
    ]);
  });

  it("merges split thought parts and keeps the signature wherever it lands", () => {
    const out = toAnthropicResponse(
      withParts([
        { text: "step one ", thought: true },
        { text: "step two", thought: true },
        { thought: true, thoughtSignature: "c2ln" },
        { text: "answer" },
      ]),
      "m",
      { includeThinking: true },
    );
    expect(out.content).toEqual([
      { type: "thinking", thinking: "step one step two", signature: "c2ln" },
      { type: "text", text: "answer" },
    ]);
  });

  it("backfills a signature that arrives on the trailing answer part", () => {
    // How Gemini actually reports it: the thought part is unsigned and the
    // signature rides on a later part with no `thought` flag.
    const out = toAnthropicResponse(
      withParts([
        { text: "reasoning", thought: true },
        { text: "answer", thoughtSignature: "c2ln" },
      ]),
      "m",
      { includeThinking: true },
    );
    expect(out.content).toEqual([
      { type: "thinking", thinking: "reasoning", signature: "c2ln" },
      { type: "text", text: "answer" },
    ]);
  });

  it("backfills from an empty trailing signature part", () => {
    const out = toAnthropicResponse(
      withParts([{ text: "reasoning", thought: true }, { text: "answer" }, { text: "", thoughtSignature: "c2ln" }]),
      "m",
      { includeThinking: true },
    );
    expect(out.content[0]).toEqual({ type: "thinking", thinking: "reasoning", signature: "c2ln" });
  });

  it("does not let a functionCall signature overwrite the thinking block", () => {
    // That one is already preserved inside the tool_use id.
    const out = toAnthropicResponse(
      withParts([
        { text: "reasoning", thought: true, thoughtSignature: "dGhvdWdodA" },
        { functionCall: { id: "c1", name: "f", args: {} }, thoughtSignature: "Y2FsbA" },
      ]),
      "m",
      { includeThinking: true },
    );
    expect(out.content[0].signature).toBe("dGhvdWdodA");
    expect(out.content[1].id).toBe("c1__ts__Y2FsbA");
  });

  it("defaults the signature to an empty string when Gemini sends none", () => {
    const out = toAnthropicResponse(withParts([{ text: "hmm", thought: true }]), "m", { includeThinking: true });
    expect(out.content).toEqual([{ type: "thinking", thinking: "hmm", signature: "" }]);
  });

  it("keeps thinking blocks ahead of a tool call", () => {
    const out = toAnthropicResponse(
      withParts([{ text: "picking a tool", thought: true }, { functionCall: { id: "c1", name: "f", args: {} } }]),
      "m",
      { includeThinking: true },
    );
    expect(out.content.map((block) => block.type)).toEqual(["thinking", "tool_use"]);
    expect(out.stop_reason).toBe("tool_use");
  });

  it("packs the thought signature into the tool_use id", () => {
    const out = toAnthropicResponse(
      withParts([{ functionCall: { id: "call_1", name: "get_weather", args: { city: "Berlin" } }, thoughtSignature: "YWJj" }]),
      "m",
    );
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content[0]).toEqual({
      type: "tool_use",
      id: "call_1__ts__YWJj",
      name: "get_weather",
      input: { city: "Berlin" },
    });
  });

  it("strips a matched stop sequence and names it", () => {
    const out = toAnthropicResponse(withParts([{ text: "one two END" }]), "m", { stopSequences: ["END"] });
    expect(out.stop_reason).toBe("stop_sequence");
    expect(out.stop_sequence).toBe("END");
    expect(out.content).toEqual([{ type: "text", text: "one two " }]);
  });

  it("drops the block entirely when it was only the stop sequence", () => {
    const out = toAnthropicResponse(withParts([{ text: "END" }]), "m", { stopSequences: ["END"] });
    expect(out.content).toEqual([]);
    expect(out.stop_sequence).toBe("END");
  });

  it("leaves stop_sequence null when nothing matched", () => {
    const out = toAnthropicResponse(withParts([{ text: "one two" }]), "m", { stopSequences: ["END"] });
    expect(out.stop_reason).toBe("end_turn");
    expect(out.stop_sequence).toBeNull();
  });

  it("handles an empty candidate list", () => {
    const out = toAnthropicResponse({}, "m");
    expect(out.content).toEqual([]);
    expect(out.stop_reason).toBe("end_turn");
  });
});
