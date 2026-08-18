# PROJECT.md — agent handoff

Orientation for an AI agent picking up this repo. The README is user-facing documentation; this file is working state, hard-won facts, and open threads. Keep both current — if you change behaviour, update the README too.

---

## What this is

A Cloudflare Worker that presents the **Anthropic Messages API** and serves it from **Google AI Studio's Gemini API**. Clients written against Claude (OpenCode, LiteLLM, the Anthropic SDKs, Claude Code) point at this worker and talk to Gemini unmodified.

Single-purpose translation layer. No database, no durable objects, no build step — plain ESM on workerd.

---

## Current status (2026-08-18)

| | |
| --- | --- |
| Remote | `git@github.com:lewcpe/gemini-proxy.git` (renamed from `litellm-validator` mid-session) |
| `main` | `60590f1` — security hardening + test suite, squash-merged via PR #1 |
| In flight | **PR #2 — thinking-block passthrough**, branch `thinking-passthrough` (`c5d0009`), OPEN, not yet merged |
| Tests | 124 passing, offline, no network or API key needed |
| Lint | Biome clean |

### Branch hygiene note

Local `main` is 1 behind `origin/main`; local `harden-proxy` still points at the pre-squash commit `ca2f609` and is dead — its content is in `main` via the squash. Safe to delete once PR #2 lands:

```bash
git checkout main && git pull
git branch -D harden-proxy && git push origin --delete harden-proxy
```

### History

The repo began as a single 656-line `src/index.js`. A review found it was an unauthenticated public proxy backed by the owner's Gemini key, with a URL-injection hole and several translation bugs. PR #1 fixed that and split the file into modules so the logic was reachable from tests. PR #2 adds thinking blocks, the one advertised feature that was never implemented.

---

## Layout

```
src/
  index.js            routing, auth gate, upstream fetch, error mapping
  auth.js             constant-time API key check
  http.js             CORS, error/JSON responses, size-capped body reader
  models.js           model id validation, allow list, model catalog
  translate/
    request.js        Anthropic request  -> Gemini generateContent
    response.js       Gemini response    -> Anthropic message
    stream.js         Gemini SSE         -> Anthropic SSE
    schema.js         JSON Schema        -> Gemini's OpenAPI subset
    ids.js            tool_use id <-> thought signature packing
test/                 vitest, one file per module
scripts/sdk_test.py   live smoke test, real quota, not in CI
```

Translation functions are pure and exported specifically so they can be unit-tested without a worker runtime. Keep them that way — the previous version was untestable because everything was module-private.

---

## Commands

```bash
npm test                 # offline suite — run this before every commit
npm run lint             # biome check
npm run format           # biome check --write
npm run dev              # wrangler dev on :8787
npx wrangler deploy --dry-run   # confirms it still bundles for workerd
```

`npm test` runs in Node, not workerd. It covers the logic; it does **not** prove Workers compatibility. After touching runtime-facing code, also run the dry-run and ideally `wrangler dev` + curl.

Live smoke test (spends real quota):

```bash
npm run dev   # separate terminal
export PROXY_API_KEY=$(grep '^PROXY_API_KEY=' .dev.vars | cut -d= -f2)
uv run --with anthropic python scripts/sdk_test.py
```

### Secrets

`.dev.vars` (gitignored, `0600`) holds `GEMINI_API_KEY` and a generated `PROXY_API_KEY`. A duplicate `.env` holding the same key was deleted. **Never commit these**; the working practice in this repo is to grep the staged diff for the key values before committing.

---

## Gemini API facts learned the hard way

These were established empirically against the live API. Do not "simplify" the code that depends on them without re-testing — several look like over-engineering and are not.

**Thought signatures**

- Gemini emits the turn's `thoughtSignature` on a **trailing part with an empty `text` and no `thought` flag** — usually the answer part, *not* the thought part. Naive code drops it.
- A **fabricated or mangled signature is a hard 400**: `Corrupted thought signature`. An **absent** signature is accepted fine. So: never invent one; dropping is always the safe fallback.
- Replaying a real signature attached to a thought part is accepted, with or without the answer text alongside it. That is why `response.js` backfills it onto the thinking block.
- Anthropic's wire format has no field for a signature on a `tool_use`, so it is packed into the id as `toolu_<id>__ts__<base64url(sig)>` and unpacked on the way back. Base64 payloads are never `1 mod 4` characters long — that check is what stops a client id containing `__ts__` from being mangled.

**Thinking**

- `thinkingConfig.includeThoughts: true` is **required** or Gemini returns no thought parts at all.
- Thought summaries are split across multiple parts and must be merged.
- Short prompts often produce *no* summary even with thinking enabled and a large `thoughtsTokenCount`. Don't assume a thinking block will be present.

**Stop sequences**

- Gemini strips the matched sequence itself and reports `finishReason: "STOP"` for **both** a stop-sequence hit and a natural ending — the two are indistinguishable upstream. So `stop_reason` usually reads `end_turn`, not `stop_sequence`. The stripping logic in `response.js`/`stream.js` is a safety net for the case where a sequence does leak into output, not a reliable signal.

**Usage accounting**

- `promptTokenCount` is **inclusive** of `cachedContentTokenCount`; Anthropic's `input_tokens` **excludes** cache reads. Forwarding it raw double-counts every cached turn. See `toUsage`.

**Schemas**

- Gemini rejects the whole request on an unknown JSON Schema keyword, and requires a `type` on every node.
- `$ref` must be **inlined**, not stripped — stripping leaves an untyped `{}` that Gemini rejects, which breaks every Pydantic/zod nested model.
- `format` is validated against a short list; `format: "uri"` 400s a whole tool call.
- Constraint keywords (`minimum`, `pattern`, ...) are deliberately dropped rather than forwarded. This is the previous author's empirically-derived list. Loosening it needs live testing.

---

## Security invariants

Do not regress these. Each has a test.

1. **Fails closed.** No `PROXY_API_KEY` configured ⇒ 500, never an open relay. Auth is checked before any upstream call.
2. **Model ids are validated and percent-encoded** before going into the upstream URL. `gemini/../tunedModels/foo` previously escaped `/models/` and reached other Google API resources on the owner's key.
3. **CORS is opt-in** via `ALLOWED_ORIGINS`, default off.
4. **Bodies are capped before buffering**; upstream calls time out.
5. `/health` is deliberately unauthenticated and deliberately reveals no configuration.

---

## Known gaps / candidate next work

Nothing here is committed to — read as a backlog, confirm with the user before starting.

- **Streamed thinking blocks are usually unsigned.** The trailing signature arrives after the block has closed and its `signature_delta` has been sent. Harmless today. Fixing it would mean buffering thinking, which costs streaming latency.
- **`cache_creation_input_tokens` is always 0.** Gemini's implicit caching has no write step to report. Explicit `cachedContents` is unimplemented.
- **Claude model ids are aliases.** `claude-sonnet-4-5` serves `GEMINI_MODEL_ID`, and the response echoes the Claude name back — so cost dashboards attribute usage to a model that was never called. Intentional for client compatibility; worth revisiting.
- **No rate limiting.** Auth is the only spend control. A Cloudflare Rate Limiting binding was suggested and not built.
- **`redacted_thinking` is dropped** upstream — opaque, nothing to reconstruct.
- **No types.** `npx wrangler types` + JSDoc/`checkJs` would get most of TypeScript's value with no build step.

---

## Conventions

- Tests are the contract. Every bug fixed in PR #1 has a test naming the failure mode; keep that up rather than adding generic coverage.
- Comments explain *why*, especially where the code encodes a Gemini quirk from the list above. Several of those comments are the only record of a finding — don't strip them as noise.
- Biome enforces formatting; run `npm run format` before committing.
- Commit messages state the user-visible consequence of a bug, not just the change.
- Work happens on a branch with a PR, never directly on `main`.
