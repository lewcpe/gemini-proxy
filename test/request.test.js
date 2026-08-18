import { describe, expect, it } from "vitest";
import {
  imageSourceToPart,
  resolveServiceTier,
  toFunctionDeclarations,
  toGeminiContents,
  toGeminiRequest,
  toSystemText,
  toThinkingConfig,
  toToolConfig,
} from "../src/translate/request.js";

describe("toGeminiContents", () => {
  it("maps roles and merges consecutive same-role turns", () => {
    const contents = toGeminiContents(
      [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
      ],
      "gemini-3.7-flash",
    );
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "a" }, { text: "b" }] },
      { role: "model", parts: [{ text: "c" }] },
    ]);
  });

  it("drops messages that produce no parts", () => {
    expect(toGeminiContents([{ role: "user", content: [] }], "m")).toEqual([]);
    expect(toGeminiContents([{ role: "user", content: [{ type: "text", text: "" }] }], "m")).toEqual([]);
  });

  it("ignores block types with no Gemini equivalent", () => {
    const contents = toGeminiContents(
      [
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "opaque" },
            { type: "text", text: "hi" },
          ],
        },
      ],
      "m",
    );
    expect(contents[0].parts).toEqual([{ text: "hi" }]);
  });

  it("replays a thinking block as a signed thought part", () => {
    const contents = toGeminiContents(
      [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "c2ln" },
            { type: "text", text: "hi" },
          ],
        },
      ],
      "gemini-3.7-flash",
    );
    expect(contents[0].parts).toEqual([{ text: "hmm", thought: true, thoughtSignature: "c2ln" }, { text: "hi" }]);
  });

  it("replays an unsigned thinking block without a signature field", () => {
    const contents = toGeminiContents(
      [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "" }] }],
      "gemini-3.7-flash",
    );
    expect(contents[0].parts).toEqual([{ text: "hmm", thought: true }]);
  });

  it("drops an empty thinking block", () => {
    expect(toGeminiContents([{ role: "assistant", content: [{ type: "thinking", thinking: "" }] }], "m")).toEqual([]);
  });

  it("forwards the function call id and thought signature for gemini-3", () => {
    const contents = toGeminiContents(
      [{ role: "assistant", content: [{ type: "tool_use", id: "call_1__ts__YWJj", name: "f", input: { x: 1 } }] }],
      "gemini-3.7-flash",
    );
    expect(contents[0].parts[0]).toEqual({
      functionCall: { name: "f", args: { x: 1 }, id: "call_1" },
      thoughtSignature: "YWJj",
    });
  });

  it("omits the function call id for non-gemini-3 models", () => {
    const contents = toGeminiContents(
      [{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "f", input: {} }] }],
      "gemini-2.5-flash",
    );
    expect(contents[0].parts[0].functionCall.id).toBeUndefined();
  });

  it("resolves the tool name from the preceding tool_use", () => {
    const contents = toGeminiContents(
      [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1__ts__YWJj", name: "get_weather", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1__ts__YWJj", content: "18C" }] },
      ],
      "gemini-3.7-flash",
    );
    expect(contents[1].parts[0].functionResponse).toEqual({
      name: "get_weather",
      response: { content: "18C" },
      id: "call_1",
    });
  });

  it("falls back to the clean id, never the packed one, when history is absent", () => {
    // The packed id carries a base64 signature suffix that is not a legal
    // function name; sending it upstream fails the whole request.
    const contents = toGeminiContents(
      [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1__ts__YWJj", content: "ok" }] }],
      "gemini-3.7-flash",
    );
    expect(contents[0].parts[0].functionResponse.name).toBe("call_1");
  });

  it("marks error tool results and never sends an empty response body", () => {
    const contents = toGeminiContents(
      [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: "" }] },
      ],
      "m",
    );
    expect(contents[0].parts[0].functionResponse.response.content).toBe("[error] boom");
    expect(contents[0].parts[1].functionResponse.response.content).toBe(" ");
  });

  it("carries images out of a tool result", () => {
    const contents = toGeminiContents(
      [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: [
                { type: "text", text: "see" },
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } },
              ],
            },
          ],
        },
      ],
      "m",
    );
    const { functionResponse } = contents[0].parts[0];
    expect(functionResponse.response.content).toBe("see");
    expect(functionResponse.parts).toEqual([{ inlineData: { mimeType: "image/jpeg", data: "AAA" } }]);
  });
});

describe("imageSourceToPart", () => {
  it("accepts supported media types and defaults the rest to png", () => {
    expect(imageSourceToPart({ type: "base64", media_type: "image/webp", data: "AA" })).toEqual({
      inlineData: { mimeType: "image/webp", data: "AA" },
    });
    expect(imageSourceToPart({ type: "base64", media_type: "image/tiff", data: "AA" }).inlineData.mimeType).toBe("image/png");
  });

  it("rejects url sources and empty data", () => {
    expect(imageSourceToPart({ type: "url", url: "https://example.test/a.png" })).toBeNull();
    expect(imageSourceToPart({ type: "base64", data: "" })).toBeNull();
    expect(imageSourceToPart(null)).toBeNull();
  });
});

describe("toSystemText", () => {
  it("accepts a plain string and a block array", () => {
    expect(toSystemText("be brief")).toBe("be brief");
    expect(
      toSystemText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
    expect(toSystemText(undefined)).toBe("");
  });
});

describe("toThinkingConfig", () => {
  it("maps a budget to a gemini-3 thinking level", () => {
    expect(toThinkingConfig({ type: "enabled", budget_tokens: 16000 }, "gemini-3.7-flash")).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    });
    expect(toThinkingConfig({ type: "enabled", budget_tokens: 1000 }, "gemini-3.7-flash")).toEqual({
      thinkingLevel: "low",
      includeThoughts: true,
    });
  });

  it("requests thought summaries only when thinking is enabled", () => {
    // Without includeThoughts, Gemini returns no thought parts at all.
    expect(toThinkingConfig(undefined, "gemini-3.7-flash").includeThoughts).toBeUndefined();
    expect(toThinkingConfig({ type: "disabled" }, "gemini-2.5-pro").includeThoughts).toBeUndefined();
  });

  it("uses a token budget for older models", () => {
    expect(toThinkingConfig({ type: "enabled", budget_tokens: 1000 }, "gemini-2.5-pro")).toEqual({
      thinkingBudget: 1000,
      includeThoughts: true,
    });
    expect(toThinkingConfig({ type: "disabled" }, "gemini-2.5-pro")).toEqual({ thinkingBudget: 0 });
  });

  it("returns null when the model has no thinking knob", () => {
    expect(toThinkingConfig(undefined, "gemini-2.5-pro")).toBeNull();
  });
});

describe("toFunctionDeclarations", () => {
  it("sanitizes the input schema", () => {
    const [declaration] = toFunctionDeclarations([
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          $schema: "http://json-schema.org/draft-07/schema#",
          properties: { location: { type: "string" } },
          required: ["location"],
          additionalProperties: false,
        },
      },
    ]);
    expect(declaration).toEqual({
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
    });
  });

  it("omits parameters for a zero-argument tool", () => {
    const [declaration] = toFunctionDeclarations([{ name: "ping", input_schema: { type: "object", properties: {} } }]);
    expect(declaration).toEqual({ name: "ping" });
  });

  it("skips malformed tools", () => {
    expect(toFunctionDeclarations([{ description: "no name" }, null, "x"])).toEqual([]);
    expect(toFunctionDeclarations(undefined)).toEqual([]);
  });
});

describe("toToolConfig", () => {
  it("maps every tool_choice form", () => {
    expect(toToolConfig({ type: "auto" })).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(toToolConfig({ type: "any" })).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(toToolConfig({ type: "none" })).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(toToolConfig({ type: "tool", name: "f" })).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] },
    });
    expect(toToolConfig({ type: "bogus" })).toBeNull();
    expect(toToolConfig(undefined)).toBeNull();
  });
});

describe("toGeminiRequest", () => {
  it("builds generationConfig from Anthropic sampling params", () => {
    const request = toGeminiRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        system: "be brief",
        max_tokens: 100,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 20,
        stop_sequences: ["END", ""],
      },
      "gemini-2.5-flash",
    );
    expect(request.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
    expect(request.generationConfig).toEqual({
      maxOutputTokens: 100,
      temperature: 0.5,
      topP: 0.9,
      topK: 20,
      stopSequences: ["END"],
    });
    expect(request.tools).toBeUndefined();
  });

  it("attaches tools and tool config together", () => {
    const request = toGeminiRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
        tools: [{ name: "f", input_schema: { type: "object", properties: { a: { type: "string" } } } }],
        tool_choice: { type: "any" },
      },
      "gemini-2.5-flash",
    );
    expect(request.tools[0].functionDeclarations).toHaveLength(1);
    expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
  });

  it("includes service_tier when set in request body or options", () => {
    const requestFromEnv = toGeminiRequest({ messages: [{ role: "user", content: "hi" }] }, "gemini-3.7-flash", {
      env: { SERVICE_TIER: "flex" },
    });
    expect(requestFromEnv.service_tier).toBe("flex");

    const requestFromBody = toGeminiRequest(
      { messages: [{ role: "user", content: "hi" }], service_tier: "flex" },
      "gemini-3.7-flash",
    );
    expect(requestFromBody.service_tier).toBe("flex");
  });
});

describe("resolveServiceTier", () => {
  it("prioritizes body service_tier over env", () => {
    expect(resolveServiceTier({ service_tier: "flex" }, { env: { SERVICE_TIER: "standard" } })).toBe("flex");
    expect(resolveServiceTier({ serviceTier: "flex" })).toBe("flex");
    expect(resolveServiceTier({ extra_body: { service_tier: "flex" } })).toBe("flex");
  });

  it("falls back to env SERVICE_TIER", () => {
    expect(resolveServiceTier({}, { env: { SERVICE_TIER: "flex" } })).toBe("flex");
    expect(resolveServiceTier({}, { env: { GEMINI_SERVICE_TIER: "flex" } })).toBe("flex");
  });

  it("returns null when no service tier is specified", () => {
    expect(resolveServiceTier({}, {})).toBeNull();
  });
});
