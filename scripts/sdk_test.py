import json
import time

import anthropic

client = anthropic.Anthropic(base_url="http://localhost:8787", api_key="test")

tools = [
    {
        "name": "get_weather",
        "description": "Get the weather for a location",
        "input_schema": {
            "type": "object",
            "$schema": "http://json-schema.org/draft-07/schema#",
            "properties": {"location": {"type": "string"}},
            "required": ["location"],
            "additionalProperties": False,
        },
    }
]

def with_retry(fn, max_retries=3):
    for i in range(max_retries):
        try:
            return fn()
        except anthropic.RateLimitError as e:
            print(f"Rate limited (attempt {i+1}/{max_retries}), waiting 3s...")
            time.sleep(3)
    return fn()

MODEL = "gemini-3.7-flash"

print(f"== non-stream ({MODEL}) ==")
msg = with_retry(lambda: client.messages.create(
    model=MODEL,
    max_tokens=300,
    messages=[{"role": "user", "content": "Reply with only: PONG"}],
))
print(msg.stop_reason, msg.usage, [b.text for b in msg.content if b.type == "text"])
assert any(b.type == "text" and "PONG" in b.text for b in msg.content)

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
    final = stream.get_final_message()
    return text, final

text, final = with_retry(run_stream)
print(repr(text), final.stop_reason, final.usage.output_tokens)
assert text.strip()

time.sleep(3)

print(f"== tool use + round trip ({MODEL}) ==")
msg = with_retry(lambda: client.messages.create(
    model=MODEL,
    max_tokens=500,
    tools=tools,
    messages=[{"role": "user", "content": "What is the weather in Berlin?"}],
))
tool_block = next(b for b in msg.content if b.type == "tool_use")
print(msg.stop_reason, tool_block.name, tool_block.input)
assert msg.stop_reason == "tool_use"

time.sleep(3)

msg2 = with_retry(lambda: client.messages.create(
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
))
print(msg2.stop_reason, json.dumps([b.model_dump() for b in msg2.content])[:200])
assert any(b.type == "text" for b in msg2.content)

print("ALL OK")

