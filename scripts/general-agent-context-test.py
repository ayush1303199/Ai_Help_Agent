import asyncio
import json
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
    assert all(call["tool_choice"] == "auto" for call in calls)
    assert not any(message.get("type") == "error" for message in sent)

    calls, sent = await run_case(2)
    assert len(calls) == 2, "context failure must not retry more than once"
    error = next(message for message in sent if message.get("type") == "error")
    assert error["failureClassification"] == "CONTEXT_TOO_LARGE"
    assert error["contextMetrics"]["compactionStatus"] == "BLOCKED_CONTEXT_LIMIT"
    assert "too large" in error["message"].lower()

    evidence_fallback = index.general_evidence_fallback([
        {
            "role": "tool",
            "content": '{"observation":{"title":"Free AI courses","url":"https://example.test/courses","results":[{"title":"Machine Learning course","url":"https://example.test/ml","snippet":"Free beginner course"}]}}',
        },
    ])
    assert "rate-limited" in evidence_fallback
    assert "Machine Learning course" in evidence_fallback
    assert "https://example.test/ml" in evidence_fallback
    blocked_fallback = index.general_evidence_fallback([{
        "role": "tool",
        "content": '{"observation":{"url":"https://www.google.com/sorry/index?continue=https://www.google.com/search","title":"Google Sorry","pageState":"CAPTCHA_REQUIRED","visibleText":"Verify you are human","results":[]}}',
    }])
    assert "could not complete" in blocked_fallback.lower()
    assert "google.com/sorry" not in blocked_fallback
    search_page_fallback = index.general_evidence_fallback([{
        "role": "tool",
        "content": json.dumps({
            "observation": {
                "url": "https://html.duckduckgo.com/html/?q=free+ai+ml+courses",
                "title": "free ai ml courses at DuckDuckGo",
                "visibleText": "All Regions Argentina Australia Any Time Past Day",
                "results": [],
            },
        }),
    }])
    assert "could not complete" in search_page_fallback.lower()
    assert "All Regions" not in search_page_fallback
    assert "duckduckgo.com" not in search_page_fallback
    assert index.general_evidence_fallback([{"role": "user", "content": "no evidence"}]) == ""
    assert index.is_tool_compatibility_error(index.ToolCompatibilityError(
        "groq", "text-only-model", "browser tools are not supported",
    ))
    continuation_evidence = index.general_evidence_fallback([{
        "role": "system",
        "content": (
            "UNTRUSTED_EXTERNAL_CONTENT from the same task-scoped native browser.\n"
            "URL: https://example.test/google-ml\n"
            "Title: Machine Learning | Google for Developers\n"
            "Visible text:\nFree machine learning course"
        ),
    }])
    assert "Machine Learning | Google for Developers" in continuation_evidence
    assert "https://example.test/google-ml" in continuation_evidence
    assert "Free machine learning course" in continuation_evidence
    target_messages = [
        {"role": "user", "content": "Find three free AI/ML courses without purchasing"},
        {"role": "system", "content": "Requested result count: 3"},
        {
            "role": "tool",
            "content": '{"observation":{"results":[{"title":"Course A","url":"https://example.test/a"},{"title":"Course B","url":"https://example.test/b"}]}}',
        },
    ]
    assert index.requested_general_result_count(target_messages) == 3
    assert "duckduckgo.com" in index.general_search_url(target_messages, 0)
    assert "free+online" in index.general_search_url(target_messages, 1)
    assert index.observed_general_result_count(target_messages) == 2
    assert index.observed_general_result_count([{
        "role": "tool",
        "content": '{"observation":{"results":[]},"resultSetSummary":{"count":3}}',
    }]) == 3
    assert index.observed_general_result_count([
        {"role": "tool", "content": '{"observation":{"url":"https://example.test/page"}}'},
    ]) == 0
    course_messages = [
        {"role": "user", "content": "Find three free AI/ML courses without purchase"},
        {"role": "tool", "content": json.dumps({"observation": {
            "url": "https://course.fast.ai/",
            "title": "Practical Deep Learning for Coders",
            "visibleText": "This free course teaches deep learning and machine learning. No purchase required.",
            "results": [],
        }})},
        {"role": "tool", "content": json.dumps({"observation": {
            "url": "https://developers.google.com/machine-learning/crash-course",
            "title": "Machine Learning Crash Course",
            "visibleText": "A free machine learning course with interactive exercises. No purchase required.",
            "results": [],
        }})},
        {"role": "tool", "content": json.dumps({"observation": {
            "url": "https://ocw.mit.edu/machine-learning",
            "title": "Introduction to Machine Learning",
            "visibleText": "Open courseware for machine learning. Free access; no purchase required.",
            "results": [],
        }})},
    ]
    course_candidates = index.general_research_candidates(course_messages)
    assert len(course_candidates) == 3
    assert index.verified_general_result_count(course_messages) == 3
    course_markdown = index.general_research_results_markdown(course_messages)
    assert "Verified research results" in course_markdown
    assert "Practical Deep Learning for Coders" in course_markdown
    assert "https://developers.google.com/machine-learning/crash-course" in course_markdown
    assert "purchase requirement evidence" in course_markdown.lower()
    assert index.general_research_candidates([
        {"role": "user", "content": "Find three free AI/ML courses"},
        {"role": "tool", "content": json.dumps({"observation": {
            "url": "https://example.test/paid",
            "title": "Paid Machine Learning Course",
            "visibleText": "Machine learning course. Purchase required.",
            "results": [],
        }})},
    ]) == []
    documentation_messages = [
        {"role": "user", "content": "Find official Spring Boot documentation"},
        {"role": "tool", "content": json.dumps({"observation": {
            "url": "https://spring.io/projects/spring-boot",
            "title": "Spring Boot",
            "visibleText": "Official Spring Boot project documentation and reference.",
            "results": [],
        }})},
    ]
    assert len(index.general_research_candidates(documentation_messages)) == 1
    normalized_page = index.compact_general_tool_result({
        "ok": True,
        "tool": "navigate",
        "data": {
            "observation": {
                "url": "https://example.test/course",
                "title": "Machine Learning Course",
                "visibleText": "Free machine learning course with no purchase required.",
                "results": [],
            },
            "task": {
                "taskMemory": {
                    "resultSet": [{
                        "title": "Machine Learning Course",
                        "url": "https://example.test/course",
                        "snippet": "Free machine learning course with no purchase required.",
                        "source": "example.test",
                    }],
                },
            },
        },
    })
    normalized_messages = [
        {"role": "user", "content": "Find one free machine learning course without purchase"},
        {"role": "tool", "content": normalized_page},
    ]
    assert len(index.general_research_candidates(normalized_messages)) == 1
    paired_messages, _ = index.compact_general_context([
        {"role": "system", "content": "system"},
        {"role": "user", "content": "Find courses"},
        {"role": "assistant", "content": None, "tool_calls": [{
            "id": "call-1",
            "type": "function",
            "function": {"name": "navigate", "arguments": "{\"url\":\"https://example.test\"}"},
        }]},
        {"role": "tool", "tool_call_id": "call-1", "name": "navigate", "content": "{}"},
    ], [{"type": "function", "function": {"name": "navigate"}}], force=True)
    assert any(message.get("role") == "assistant" and message.get("tool_calls") for message in paired_messages)
    assert any(message.get("role") == "tool" and message.get("name") == "navigate" for message in paired_messages)
    paired_roles = [message.get("role") for message in paired_messages]
    assistant_index = paired_roles.index("assistant")
    tool_index = paired_roles.index("tool")
    assert assistant_index < tool_index
    markdown = index.general_observed_results_markdown([{
        "role": "tool",
        "content": '{"observation":{"results":[{"title":"Course A","url":"https://example.test/a","snippet":"Free course"},{"title":"Course B","url":"https://example.test/b","snippet":"Open access"}]}}',
    }])
    assert "## All observed results" in markdown
    assert "Course A" in markdown and "Course B" in markdown
    assert "https://example.test/a" in markdown

    print('{"runtime":"general-agent-context","bounded":true,"singleRetry":true,"terminalClassification":true}')


if __name__ == "__main__":
    asyncio.run(main())
