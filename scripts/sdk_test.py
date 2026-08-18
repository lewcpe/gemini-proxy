"""Live smoke test against a running proxy, using the official Anthropic SDK.

This talks to the real Gemini API and costs quota, so it is not part of `npm
test` — the unit suite under test/ covers the translation logic offline. Run it
before a deploy to confirm the wire format still satisfies a real client.

    npm run dev                       # in another terminal
    uv run --with anthropic python scripts/sdk_test.py
"""

import json
import os
import sys
import time

import anthropic

BASE_URL = os.environ.get("PROXY_BASE_URL", "http://localhost:8787")
API_KEY = os.environ.get("PROXY_API_KEY")
MODEL = os.environ.get("PROXY_TEST_MODEL", "gemini-3.7-flash")

if not API_KEY:
    sys.exit(
        "PROXY_API_KEY is not set. The proxy refuses unauthenticated requests.\n"
        "Copy the value from .dev.vars, e.g.:\n"
        "  export PROXY_API_KEY=$(grep '^PROXY_API_KEY=' .dev.vars | cut -d= -f2)"
    )

client = anthropic.Anthropic(base_url=BASE_URL, api_key=API_KEY)

tools = [
    {
        "name": "get_weather",
        "description": "Get the weather for a location",
        "input_schema": {
            "type": "object",
            "$schema": "http://json-schema.org/draft-07/schema#",
            "properties": {"location": {"$ref": "#/$defs/Location"}},
            "required": ["location"],
            "additionalProperties": False,
            "$defs": {"Location": {"type": "string", "description": "City name"}},
        },
    }
]


def with_retry(fn, max_retries=3):
    for i in range(max_retries):
        try:
            return fn()
        except anthropic.RateLimitError:
            print(f"Rate limited (attempt {i + 1}/{max_retries}), waiting 3s...")
            time.sleep(3)
    return fn()


print(f"== auth rejection ({BASE_URL}) ==")
try:
    anthropic.Anthropic(base_url=BASE_URL, api_key="wrong-key").messages.create(
        model=MODEL, max_tokens=10, messages=[{"role": "user", "content": "hi"}]
    )
    raise AssertionError("proxy accepted a bad API key")
except anthropic.AuthenticationError:
    print("rejected a bad key as expected")

print(f"== non-stream ({MODEL}) ==")
msg = with_retry(
    lambda: client.messages.create(
        model=MODEL,
        max_tokens=300,
        messages=[{"role": "user", "content": "Reply with only: PONG"}],
    )
)
print(msg.stop_reason, msg.usage, [b.text for b in msg.content if b.type == "text"])
assert any(b.type == "text" and "PONG" in b.text for b in msg.content)

time.sleep(3)

print(f"== count_tokens ({MODEL}) ==")
counted = with_retry(
    lambda: client.messages.count_tokens(
        model=MODEL, messages=[{"role": "user", "content": "How many tokens is this?"}]
    )
)
print(counted)
assert counted.input_tokens > 0

time.sleep(3)

print(f"== stream ({MODEL}) ==")


def run_stream():
    text = ""
    with client.messages.stream(
        model=MODEL,
        max_tokens=200,
        messages=[{"role": "user", "content": "Count from 1 to 5."}],
    ) as stream:
        for t in stream.text_stream:
            text += t
        return text, stream.get_final_message()


text, final = with_retry(run_stream)
print(repr(text), final.stop_reason, final.usage.output_tokens)
assert text.strip()

time.sleep(3)

print(f"== stop sequence ({MODEL}) ==")
stopped = with_retry(
    lambda: client.messages.create(
        model=MODEL,
        max_tokens=200,
        stop_sequences=["4"],
        messages=[{"role": "user", "content": "Count from 1 to 9, separated by spaces."}],
    )
)
print(stopped.stop_reason, stopped.stop_sequence, [b.text for b in stopped.content if b.type == "text"])
assert "4" not in "".join(b.text for b in stopped.content if b.type == "text")

time.sleep(3)

print(f"== tool use + round trip ({MODEL}) ==")
msg = with_retry(
    lambda: client.messages.create(
        model=MODEL,
        max_tokens=500,
        tools=tools,
        messages=[{"role": "user", "content": "What is the weather in Berlin?"}],
    )
)
tool_block = next(b for b in msg.content if b.type == "tool_use")
print(msg.stop_reason, tool_block.name, tool_block.input)
assert msg.stop_reason == "tool_use"

time.sleep(3)

msg2 = with_retry(
    lambda: client.messages.create(
        model=MODEL,
        max_tokens=500,
        tools=tools,
        messages=[
            {"role": "user", "content": "What is the weather in Berlin?"},
            {"role": "assistant", "content": [tool_block.model_dump()]},
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_block.id,
                        "content": "18C and rainy",
                    }
                ],
            },
        ],
    )
)
print(msg2.stop_reason, json.dumps([b.model_dump() for b in msg2.content])[:200])
assert any(b.type == "text" for b in msg2.content)

print("ALL OK")
