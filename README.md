# Cloudflare Worker Anthropic-to-Gemini Proxy

A Cloudflare Worker that translates the **Anthropic Messages API** (`/v1/messages`) to Google AI Studio's **Gemini API** (`generateContent` & `streamGenerateContent`).

It lets clients built for the Claude / Anthropic API (OpenCode, LiteLLM, VS Code extensions, the official Anthropic SDKs) drive Gemini models without changing client code.

---

## Security model

**The proxy spends your Gemini API key on behalf of whoever can reach it.** `*.workers.dev` hostnames are enumerable and routinely scanned, so it is designed to fail closed:

- **`PROXY_API_KEY` is required.** Callers present it via `x-api-key` or `Authorization: Bearer`. Without the secret configured, the worker serves `500` rather than becoming an open relay. Comparison is constant-time over SHA-256 digests, so neither the key nor its length leaks through timing.
- **Model ids are validated** against an anchored pattern and percent-encoded before being interpolated into the upstream URL. Without this, `gemini/../tunedModels/foo` reaches unrelated `generativelanguage.googleapis.com` resources on your key.
- **CORS is off by default.** Set `ALLOWED_ORIGINS` only if a browser needs to call the proxy directly; a wildcard plus a client-held key means any page can spend your quota.
- **Request bodies are capped** (`MAX_REQUEST_BYTES`) and **upstream calls time out** (`UPSTREAM_TIMEOUT_MS`).
- **Optional model allow list** via `GEMINI_ALLOWED_MODELS` restricts which upstream models callers may select.

`/health` is intentionally unauthenticated for uptime checks and reveals no configuration.

---

## Features

- **Anthropic Messages API compatibility** — `/v1/messages` and `/messages`, non-streaming JSON and SSE streaming.
- **Token counting** — `/v1/messages/count_tokens`, backed by Gemini `:countTokens`. Required by Claude Code and `client.messages.count_tokens()`.
- **Model discovery** — `GET /v1/models` in Anthropic's list shape.
- **Tool calling & round-trips** — Anthropic `tools` / `tool_choice` to Gemini `functionDeclarations` / `toolConfig`.
- **Gemini 3 thought-signature preservation** — signatures are packed into `tool_use.id` so they survive multi-turn tool use.
- **JSON Schema sanitizer** — inlines `$ref`, merges `allOf`, collapses `anyOf: [X, null]` to `nullable`, and strips keywords Gemini rejects.
- **Accurate usage accounting** — cached tokens are reported as `cache_read_input_tokens` and excluded from `input_tokens`.
- **Stop sequences** — forwarded to Gemini; if a matched sequence reaches the output it is stripped and reported via `stop_reason` / `stop_sequence`, in both streaming and non-streaming modes. See the caveat below.
- **Multimodal** — base64 inline images (`image/png`, `image/jpeg`, `image/webp`, `image/heic`, `image/heif`).
- **Error mapping** — Gemini HTTP errors become Anthropic error objects (`rate_limit_error`, `invalid_request_error`, ...).

### Known gaps

- **Thinking blocks are not returned.** Gemini's thought parts are dropped rather than surfaced as Anthropic `thinking` content blocks. `thinking` in a *request* is still honoured and mapped to Gemini's `thinkingLevel` / `thinkingBudget`.
- **`cache_creation_input_tokens` is always `0`.** Gemini's implicit caching has no explicit write step to report.
- **Claude model ids are aliases.** Requesting `claude-sonnet-4-5` serves `GEMINI_MODEL_ID`; the response echoes the requested name back, so downstream cost dashboards will attribute usage to a Claude model that was never called.
- **Schema constraint keywords are dropped** (`minimum`, `pattern`, `minItems`, ...) rather than forwarded. They are advisory for the model, and forwarding them has been observed to 400.
- **`stop_reason: "stop_sequence"` is best-effort.** Gemini strips the matched sequence itself and reports `finishReason: "STOP"` for both a natural ending and a stop-sequence hit, so the two are indistinguishable upstream. In practice the generation *does* stop at the sequence and the sequence *is* absent from the output — but `stop_reason` will usually read `end_turn`. The proxy's stripping logic is a safety net for the case where a sequence does leak into the output.

---

## Quick Start

```bash
npm install
```

Create `.dev.vars` for local development:

```env
GEMINI_API_KEY=your_google_ai_studio_api_key
GEMINI_MODEL_ID=gemini-3.7-flash
PROXY_API_KEY=a_long_random_string_clients_must_present
```

Generate a proxy key with `openssl rand -hex 32`.

```bash
npm run dev     # http://localhost:8787
npm test        # offline unit suite
npm run lint    # biome
```

### Deploy

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put PROXY_API_KEY
npm run deploy
```

### Configuration

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | secret | — | Google AI Studio key. Required. |
| `PROXY_API_KEY` | secret | — | Key callers must present. Required; the worker refuses to serve without it. |
| `GEMINI_MODEL_ID` | var | `gemini-3.7-flash` | Model used for any non-`gemini*` requested model. |
| `GEMINI_ALLOWED_MODELS` | var | *(empty)* | Comma-separated allow list of upstream models. Empty means any valid `gemini*` id. |
| `ALLOWED_ORIGINS` | var | *(empty)* | Comma-separated CORS origins, or `*`. Empty means no CORS headers. |
| `MAX_REQUEST_BYTES` | var | `10485760` | Request body ceiling. |
| `UPSTREAM_TIMEOUT_MS` | var | `120000` | Timeout for the upstream connection. |

---

## API Endpoints

### `POST /v1/messages` (or `/messages`)

```bash
curl http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $PROXY_API_KEY" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 300,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

```json
{
  "id": "msg_6bf3ed40b67a41b2a0f92599b0",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-5",
  "content": [{ "type": "text", "text": "Hello! How can I help you today?" }],
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

### `POST /v1/messages/count_tokens`

```json
{ "input_tokens": 42 }
```

### `GET /v1/models`

```json
{
  "data": [
    { "type": "model", "id": "gemini-3.7-flash", "display_name": "Gemini 3.7 Flash", "created_at": "2024-01-01T00:00:00Z" }
  ],
  "has_more": false,
  "first_id": "gemini-3.7-flash",
  "last_id": "claude-3-7-sonnet-20250219"
}
```

### `GET /health` (or `/`)

Unauthenticated. `{ "ok": true, "upstream": "google-ai-studio" }`

---

## Layout

```
src/
  index.js            routing, auth gate, upstream call, error mapping
  auth.js             constant-time API key check
  http.js             CORS, error/JSON responses, size-capped body reader
  models.js           model id validation, allow list, model catalog
  translate/
    request.js        Anthropic request  -> Gemini generateContent
    response.js       Gemini response    -> Anthropic message
    stream.js         Gemini SSE         -> Anthropic SSE
    schema.js         JSON Schema -> Gemini's OpenAPI subset
    ids.js            tool_use id <-> thought signature packing
test/                 offline unit suite (npm test)
scripts/sdk_test.py   live smoke test against a running proxy
```

---

## Technical Details

### Thought-signature round-tripping

Gemini 3 requires the `thoughtSignature` from a previous tool call to be replayed when tool results are submitted. The Anthropic wire format has no field for it, so the proxy packs it into the id the client already echoes back:

```text
toolu_<uuid>__ts__<base64url(thoughtSignature)>
```

On `tool_result` the signature is unpacked and reattached to the Gemini `functionCall` part. An id whose tail is not valid base64url is treated as a plain id, so client-generated ids that happen to contain the separator still round-trip.

### Schema sanitization

Gemini accepts a narrow OpenAPI-flavoured subset of JSON Schema and rejects the whole request on an unknown keyword. The sanitizer:

1. **Inlines `$ref`** against `#/$defs` and `#/definitions`, with cycle detection (recursive models terminate as untyped objects). Stripping the keyword instead — as an earlier version did — left an untyped `{}` that Gemini rejects, breaking every Pydantic/zod nested model.
2. **Merges `allOf`**, rewrites `oneOf` to `anyOf`, and collapses `anyOf: [X, {type: "null"}]` (i.e. `Optional[X]`) to `X` plus `nullable: true`.
3. **Strips unsupported keywords** and filters `format` to the values Gemini accepts, so `format: "uri"` no longer 400s a whole tool call.
4. **Converts `const` to `enum: [value]`** and filters `required` against `properties`.
5. **Guarantees a `type` on every node**, and omits `parameters` entirely for zero-argument tools.

### Testing

`npm test` runs an offline suite (no network, no API key) covering schema sanitization, request/response translation, SSE stream translation, id packing, auth, routing, and model-id validation.

`scripts/sdk_test.py` is a live end-to-end check with the official Anthropic Python SDK; it spends real quota and is kept out of CI.

```bash
export PROXY_API_KEY=$(grep '^PROXY_API_KEY=' .dev.vars | cut -d= -f2)
uv run --with anthropic python scripts/sdk_test.py
```

---

## License

MIT — see [LICENSE](LICENSE).
