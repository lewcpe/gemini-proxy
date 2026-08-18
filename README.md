# Cloudflare Worker Anthropic-to-Gemini Proxy

A lightweight, high-performance Cloudflare Worker proxy that translates the **Anthropic Messages API** (`/v1/messages`) to Google AI Studio's **Gemini API** (`generateContent` & `streamGenerateContent`).

It allows clients designed for Claude / Anthropic API (such as OpenCode, LiteLLM, VS Code extensions, or the official Anthropic SDK) to use Google Gemini models (e.g., `gemini-3.7-flash`, `gemini-3.6-flash`) seamlessly without modifying client code.

---

## Features

- **Full Anthropic Messages API Compatibility**: Supports `/v1/messages` and `/messages` endpoints for non-streaming JSON responses and SSE (`text/event-stream`) streaming.
- **Model Discovery Endpoint**: `GET /v1/models` and `GET /models` list available models (including `claude-sonnet-4-5`, `claude-3-7-sonnet-20250219`, `gemini-3.7-flash`, and `gemini-3.6-flash`).
- **Tool Calling & Round-Trip Support**: Translates Anthropic `tools` and `tool_choice` into Gemini `functionDeclarations` and `toolConfig`.
- **Gemini 3 Thought Signature Preservation**: Automatically embeds Gemini 3 `thoughtSignature` into `tool_use_id` (`toolu_...__ts__<base64url>`) to preserve function call verification signatures across multi-turn tool interactions.
- **Robust JSON Schema Sanitizer**: Automatically cleans tool parameter schemas by stripping unsupported keywords (`propertyNames`, `exclusiveMinimum`, `exclusiveMaximum`, `patternProperties`, `$schema`, `additionalProperties`, etc.), converting `const` to `enum: [val]`, and filtering `required` arrays against `properties`.
- **Prompt Caching Reporting**: Maps Gemini's implicit context caching token metadata (`cachedContentTokenCount` for prompts $\ge 4,096$ tokens) to Anthropic's `cache_read_input_tokens` and `cache_creation_input_tokens` fields in the `usage` object.
- **Gemini 3 Thinking Config**: Translates Anthropic thinking requests into Gemini 3 `thinkingLevel` (`high` / `low`).
- **Multimodal Support**: Base64 inline image support (`image/png`, `image/jpeg`, `image/webp`, `image/gif`).
- **Standardized Error Mapping**: Converts Gemini upstream HTTP errors (400, 401, 404, 429, 529) to Anthropic JSON error formats (`rate_limit_error`, `invalid_request_error`, etc.).

---

## Quick Start

### 1. Installation & Environment Setup

Clone the repository and install dependencies:

```bash
npm install
```

Create a `.dev.vars` file for local development (or `.env`):

```env
GEMINI_API_KEY=your_google_ai_studio_api_key
GEMINI_MODEL_ID=gemini-3.7-flash
```

### 2. Run Locally

Start the local Wrangler development server:

```bash
npm run dev
```

The proxy will run on `http://localhost:8787`.

### 3. Deploy to Cloudflare Workers

Set your Gemini API key in Cloudflare Workers secrets and deploy:

```bash
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```

---

## API Endpoints

### `POST /v1/messages` (or `/messages`)

Translates Anthropic Messages requests to Gemini API.

#### Request Example (Anthropic Format)

```bash
curl http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 300,
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

#### Response Example (Anthropic Format)

```json
{
  "id": "msg_6bf3ed40b67a41b2a0f92599b0",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-5",
  "content": [
    { "type": "text", "text": "Hello! How can I help you today?" }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 54,
    "output_tokens": 26,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

---

### `GET /v1/models` (or `/models`)

Returns available models for client discovery.

```json
{
  "object": "list",
  "data": [
    { "id": "claude-sonnet-4-5", "object": "model", "created": 1700000000, "owned_by": "anthropic" },
    { "id": "claude-3-5-sonnet-20241022", "object": "model", "created": 1700000000, "owned_by": "anthropic" },
    { "id": "claude-3-7-sonnet-20250219", "object": "model", "created": 1700000000, "owned_by": "anthropic" },
    { "id": "gemini-3.7-flash", "object": "model", "created": 1700000000, "owned_by": "google" },
    { "id": "gemini-3.6-flash", "object": "model", "created": 1700000000, "owned_by": "google" }
  ]
}
```

---

### `GET /health` (or `/`)

Health check endpoint.

```json
{
  "ok": true,
  "upstream": "google-ai-studio",
  "model": "gemini-3.7-flash"
}
```

---

## Testing with Official Anthropic SDK

You can test the proxy using Python's official `anthropic` client:

```bash
uv run --with anthropic python scripts/sdk_test.py
```

`scripts/sdk_test.py` validates non-streaming text, SSE streaming text, tool calling, and multi-turn tool result round-trips.

---

## Technical Details

### Thought Signature Round-Tripping

Gemini 3 thinking models require the `thoughtSignature` from a previous tool call part to be present when submitting tool results in conversation history.

The proxy encodes and decodes signatures directly within the `tool_use.id`:

```text
toolu_<uuid>__ts__<base64url(thoughtSignature)>
```

When receiving `tool_result`, the proxy extracts the signature and attaches `thoughtSignature` back onto the Gemini `functionCall` part in the content history.

### Schema Sanitization

Gemini API rejects non-standard or unsupported JSON Schema keywords. The proxy sanitizes parameter schemas by:
1. Stripping `$schema`, `$id`, `$ref`, `additionalProperties`, `propertyNames`, `patternProperties`, `exclusiveMinimum`, `exclusiveMaximum`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`, `maxProperties`, `dependentRequired`, `dependentSchemas`, `contains`, `title`, and `default`.
2. Converting `const: "val"` to `enum: ["val"]`.
3. Validating and filtering `required` property arrays so every required key exists in `properties`.

---

## License

MIT
