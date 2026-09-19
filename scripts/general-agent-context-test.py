import asyncio
import sys
from types import SimpleNamespace

from fastapi import HTTPException

sys.path.insert(0, "server/src")
import index  # noqa: E402


async def run_case(provider_failures: int):
    calls = []
    original_complete_model = index.complete_model

    def fake_complete_model(
        messages,
        provider_id=None,
        tools=None,
        tool_choice=None,
        allow_tool_compatibility_fallback=False,
        request_id=None,
    ):
        calls.append({
            "messages": messages,
            "tools": tools,
            "tool_choice": tool_choice,
            "allow_tool_compatibility_fallback": allow_tool_compatibility_fallback,
        })
        if len(calls) <= provider_failures:
            raise HTTPException(status_code=413, detail="provider context limit")
        return (
            {"role": "assistant", "content": "The observed result is ready."},
            SimpleNamespace(type="test-provider", model="test-model"),
        )

    index.complete_model = fake_complete_model
    sent = []

    async def send_json(payload):
        sent.append(payload)

    try:
        payload = {
            "type": "chat",
            "mode": "general",
            "general": True,
            "requestId": "context-test",
            "messages": [{"role": "user", "content": "Find cheap pizza. " + ("history " * 5000)}],
        }
        await index.process_chat_payload(payload, send_json, index.new_connection_state())
    finally:
        index.complete_model = original_complete_model
    return calls, sent


async def main():
    compacted, metrics = index.compact_general_context(
        [{"role": "system", "content": "system"}, {"role": "user", "content": "x" * 50000}],
        index.GENERAL_TOOLS,
        force=True,
    )
    assert metrics["compacted"] is True
    assert metrics["estimatedInputChars"] <= index.GENERAL_CONTEXT_CHAR_BUDGET
    assert len(compacted) == 2

    calls, sent = await run_case(1)
    assert len(calls) == 2, "413 recovery must make exactly one retry"
    done = next(message for message in sent if message.get("type") == "done")
    assert done["contextMetrics"]["retryCount"] == 1
    assert done["contextMetrics"]["compactionStatus"] == "RETRY_COMPACTED"
    assert all(call["tool_choice"] != "none" for call in calls)
    assert not any(message.get("type") == "error" for message in sent)

    calls, sent = await run_case(2)
    assert len(calls) == 2, "context failure must not retry more than once"
    error = next(message for message in sent if message.get("type") == "error")
    assert error["failureClassification"] == "CONTEXT_TOO_LARGE"
    assert error["contextMetrics"]["compactionStatus"] == "BLOCKED_CONTEXT_LIMIT"
    assert "too large" in error["message"].lower()

    print('{"runtime":"general-agent-context","bounded":true,"singleRetry":true,"terminalClassification":true}')


if __name__ == "__main__":
    asyncio.run(main())
