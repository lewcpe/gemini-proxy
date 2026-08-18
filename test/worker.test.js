import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";

const ENV = {
  GEMINI_API_KEY: "gemini-secret",
  GEMINI_MODEL_ID: "gemini-3.7-flash",
  PROXY_API_KEY: "proxy-secret",
};

const MESSAGE_BODY = { model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

function post(path, body, headers = { "x-api-key": ENV.PROXY_API_KEY }) {
  return new Request(`https://proxy.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path, headers = { "x-api-key": ENV.PROXY_API_KEY }) {
  return new Request(`https://proxy.test${path}`, { method: "GET", headers });
}

function geminiReply(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const OK_REPLY = {
  candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
};

let fetchMock;

beforeEach(() => {
  // A fresh Response per call: a Response body can only be consumed once.
  fetchMock = vi.fn(() => Promise.resolve(geminiReply(OK_REPLY)));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authentication", () => {
  it("rejects a request with no key", async () => {
    const response = await worker.fetch(post("/v1/messages", MESSAGE_BODY, {}), ENV);
    expect(response.status).toBe(401);
    expect((await response.json()).error.type).toBe("authentication_error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong key", async () => {
    const response = await worker.fetch(post("/v1/messages", MESSAGE_BODY, { "x-api-key": "nope" }), ENV);
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts x-api-key and Authorization: Bearer alike", async () => {
    for (const headers of [{ "x-api-key": ENV.PROXY_API_KEY }, { authorization: `Bearer ${ENV.PROXY_API_KEY}` }]) {
      const response = await worker.fetch(post("/v1/messages", MESSAGE_BODY, headers), ENV);
      expect(response.status).toBe(200);
    }
  });

  it("fails closed when PROXY_API_KEY is unset rather than serving an open proxy", async () => {
    const response = await worker.fetch(post("/v1/messages", MESSAGE_BODY), { ...ENV, PROXY_API_KEY: undefined });
    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toMatch(/PROXY_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("guards the models endpoint too", async () => {
    expect((await worker.fetch(get("/v1/models", {}), ENV)).status).toBe(401);
  });

  it("leaves the health check open but reveals no configuration", async () => {
    const response = await worker.fetch(get("/health", {}), ENV);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ ok: true, upstream: "google-ai-studio" });
    expect(JSON.stringify(payload)).not.toContain(ENV.GEMINI_MODEL_ID);
  });
});

describe("model resolution", () => {
  const upstreamUrl = () => fetchMock.mock.calls[0][0];

  it("maps an Anthropic alias onto the configured Gemini model", async () => {
    await worker.fetch(post("/v1/messages", MESSAGE_BODY), ENV);
    expect(upstreamUrl()).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent");
  });

  it("refuses a model id that would escape the models path", async () => {
    // "gemini/../tunedModels/foo" previously resolved to
    // /v1beta/models/tunedModels/foo, reaching other resources on our key.
    for (const model of ["gemini/../tunedModels/foo", "gemini-x?alt=sse&x=", "gemini..flash", "gemini#frag", "gemini/../.."]) {
      const response = await worker.fetch(post("/v1/messages", { ...MESSAGE_BODY, model }), ENV);
      expect(response.status, model).toBe(400);
      expect((await response.json()).error.message, model).toMatch(/invalid model id/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours a configured allow list", async () => {
    const env = { ...ENV, GEMINI_ALLOWED_MODELS: "gemini-3.7-flash" };
    const allowed = await worker.fetch(post("/v1/messages", { ...MESSAGE_BODY, model: "gemini-3.7-flash" }), env);
    expect(allowed.status).toBe(200);

    const denied = await worker.fetch(post("/v1/messages", { ...MESSAGE_BODY, model: "gemini-3.6-flash" }), env);
    expect(denied.status).toBe(403);
  });

  it("passes an explicit gemini model straight through", async () => {
    await worker.fetch(post("/v1/messages", { ...MESSAGE_BODY, model: "gemini-2.5-pro" }), ENV);
    expect(upstreamUrl()).toContain("/models/gemini-2.5-pro:generateContent");
  });
});

describe("request validation", () => {
  const cases = [
    ["missing messages", { max_tokens: 10 }, /messages/],
    ["empty messages", { max_tokens: 10, messages: [] }, /messages/],
    ["missing max_tokens", { messages: [{ role: "user", content: "hi" }] }, /max_tokens/],
    ["non-integer max_tokens", { max_tokens: "10", messages: [{ role: "user", content: "hi" }] }, /max_tokens/],
    ["zero max_tokens", { max_tokens: 0, messages: [{ role: "user", content: "hi" }] }, /max_tokens/],
    ["non-string model", { model: 7, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, /model/],
    ["no translatable content", { max_tokens: 10, messages: [{ role: "user", content: [] }] }, /no translatable content/],
  ];

  for (const [name, body, pattern] of cases) {
    it(`rejects ${name}`, async () => {
      const response = await worker.fetch(post("/v1/messages", body), ENV);
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toMatch(pattern);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("rejects a non-JSON body", async () => {
    const request = new Request("https://proxy.test/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ENV.PROXY_API_KEY },
      body: "not json",
    });
    const response = await worker.fetch(request, ENV);
    expect(response.status).toBe(400);
  });

  it("rejects an oversized body before forwarding it upstream", async () => {
    const env = { ...ENV, MAX_REQUEST_BYTES: 200 };
    const big = { ...MESSAGE_BODY, messages: [{ role: "user", content: "x".repeat(5000) }] };
    const response = await worker.fetch(post("/v1/messages", big), env);
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("responses", () => {
  it("returns an Anthropic message", async () => {
    const response = await worker.fetch(post("/v1/messages", MESSAGE_BODY), ENV);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
    });
  });

  it("sends the key to Gemini in the x-goog-api-key header", async () => {
    await worker.fetch(post("/v1/messages", MESSAGE_BODY), ENV);
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.headers["x-goog-api-key"]).toBe(ENV.GEMINI_API_KEY);
    expect(url).not.toContain(ENV.GEMINI_API_KEY);
  });

  it("maps upstream status codes to Anthropic error types", async () => {
    const expectations = [
      [400, "invalid_request_error", 400],
      [403, "authentication_error", 403],
      [429, "rate_limit_error", 429],
      [500, "api_error", 502],
      [529, "overloaded_error", 529],
    ];
    for (const [upstreamStatus, type, expectedStatus] of expectations) {
      fetchMock.mockResolvedValueOnce(geminiReply({ error: { message: "boom" } }, upstreamStatus));
      const response = await worker.fetch(post("/v1/messages", MESSAGE_BODY), ENV);
      expect(response.status, `upstream ${upstreamStatus}`).toBe(expectedStatus);
      expect((await response.json()).error.type).toBe(type);
    }
  });

  it("surfaces a prompt block as an invalid_request_error", async () => {
    fetchMock.mockResolvedValueOnce(geminiReply({ promptFeedback: { blockReason: "SAFETY" } }));
    const response = await worker.fetch(post("/v1/messages", MESSAGE_BODY), ENV);
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/SAFETY/);
  });

  it("reports an upstream timeout as 504", async () => {
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const response = await worker.fetch(post("/v1/messages", MESSAGE_BODY), { ...ENV, UPSTREAM_TIMEOUT_MS: 10 });
    expect(response.status).toBe(504);
  });

  it("streams when asked", async () => {
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(OK_REPLY)}\n\n`));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
    const response = await worker.fetch(post("/v1/messages", { ...MESSAGE_BODY, stream: true }), ENV);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(fetchMock.mock.calls[0][0]).toContain(":streamGenerateContent?alt=sse");
    expect(await response.text()).toContain("event: message_start");
  });
});

describe("thinking", () => {
  const thoughtReply = {
    candidates: [
      {
        content: {
          parts: [{ text: "weighing it up", thought: true, thoughtSignature: "c2ln" }, { text: "the answer" }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6 },
  };

  it("asks Gemini for thought summaries only when thinking is enabled", async () => {
    await worker.fetch(post("/v1/messages", MESSAGE_BODY), ENV);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).generationConfig?.thinkingConfig?.includeThoughts).toBeUndefined();

    fetchMock.mockClear();
    await worker.fetch(post("/v1/messages", { ...MESSAGE_BODY, thinking: { type: "enabled", budget_tokens: 16000 } }), ENV);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    });
  });

  it("returns thinking blocks end to end", async () => {
    fetchMock.mockResolvedValueOnce(geminiReply(thoughtReply));
    const response = await worker.fetch(
      post("/v1/messages", { ...MESSAGE_BODY, thinking: { type: "enabled", budget_tokens: 1024 } }),
      ENV,
    );
    const payload = await response.json();
    expect(payload.content).toEqual([
      { type: "thinking", thinking: "weighing it up", signature: "c2ln" },
      { type: "text", text: "the answer" },
    ]);
    expect(payload.usage.output_tokens).toBe(10);
  });

  it("withholds thinking blocks when the client did not ask for them", async () => {
    fetchMock.mockResolvedValueOnce(geminiReply(thoughtReply));
    const payload = await (await worker.fetch(post("/v1/messages", MESSAGE_BODY), ENV)).json();
    expect(payload.content).toEqual([{ type: "text", text: "the answer" }]);
  });

  it("round-trips a thinking block back to Gemini as a signed thought part", async () => {
    const body = {
      ...MESSAGE_BODY,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "weighing it up", signature: "c2ln" },
            { type: "text", text: "the answer" },
          ],
        },
        { role: "user", content: "why?" },
      ],
    };
    await worker.fetch(post("/v1/messages", body), ENV);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.contents[1].parts).toEqual([
      { text: "weighing it up", thought: true, thoughtSignature: "c2ln" },
      { text: "the answer" },
    ]);
  });
});

describe("models endpoint", () => {
  it("returns the Anthropic list shape, not OpenAI's", async () => {
    const payload = await (await worker.fetch(get("/v1/models"), ENV)).json();
    expect(payload.has_more).toBe(false);
    expect(payload.object).toBeUndefined();
    for (const entry of payload.data) {
      expect(entry.type).toBe("model");
      expect(entry).toHaveProperty("display_name");
      expect(entry).toHaveProperty("created_at");
      expect(entry.owned_by).toBeUndefined();
    }
    expect(payload.data.map((entry) => entry.id)).toContain("gemini-3.7-flash");
  });
});

describe("count_tokens", () => {
  it("translates Gemini's totalTokens into input_tokens", async () => {
    fetchMock.mockResolvedValueOnce(geminiReply({ totalTokens: 42 }));
    const response = await worker.fetch(
      post("/v1/messages/count_tokens", { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }),
      ENV,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 42 });
    expect(fetchMock.mock.calls[0][0]).toContain(":countTokens");
  });

  it("does not require max_tokens", async () => {
    fetchMock.mockResolvedValueOnce(geminiReply({ totalTokens: 1 }));
    const response = await worker.fetch(
      post("/v1/messages/count_tokens", { messages: [{ role: "user", content: "hi" }] }),
      ENV,
    );
    expect(response.status).toBe(200);
  });
});

describe("CORS", () => {
  const origin = { origin: "https://app.test", "x-api-key": ENV.PROXY_API_KEY };

  it("sends no CORS headers by default", async () => {
    const response = await worker.fetch(post("/v1/messages", MESSAGE_BODY, origin), ENV);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("echoes only a configured origin", async () => {
    const env = { ...ENV, ALLOWED_ORIGINS: "https://app.test" };
    const allowed = await worker.fetch(post("/v1/messages", MESSAGE_BODY, origin), env);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(allowed.headers.get("vary")).toBe("Origin");

    const other = await worker.fetch(post("/v1/messages", MESSAGE_BODY, { ...origin, origin: "https://evil.test" }), env);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("still supports explicit wildcard opt-in", async () => {
    const env = { ...ENV, ALLOWED_ORIGINS: "*" };
    const response = await worker.fetch(new Request("https://proxy.test/v1/messages", { method: "OPTIONS" }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("routing", () => {
  it("404s an unknown path without asking for credentials", async () => {
    const response = await worker.fetch(get("/nope", {}), ENV);
    expect(response.status).toBe(404);
  });

  it("serves the unversioned aliases", async () => {
    expect((await worker.fetch(post("/messages", MESSAGE_BODY), ENV)).status).toBe(200);
    expect((await worker.fetch(get("/models"), ENV)).status).toBe(200);
  });
});
