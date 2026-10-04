import asyncio
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path("server/src").resolve()))
from coding_websocket import (
    _run_coding_turn,
    _validate_tool_call,
    resolve_tool_capability,
    TaskIntent,
    classify_task_intent,
    compute_next_best_action,
    set_backend_project_state,
    CODING_TOOLS,
)
from index import execute_coding_tool_endpoint, DISALLOWED_PROJECT_NAMES

# 1. Verify TaskIntent on multiple inquiry phrases
print("[TEST] 1. Classifying intent for performance queries vs fix queries...")
perf_queries = [
    "which query is take time",
    "which query is slow?",
    "measure the actual performance.",
    "measure it",
    "run EXPLAIN",
    "run EXPLAIN ANALYZE",
    "check database query performance",
    "find the bottleneck",
]
for q in perf_queries:
    intent = classify_task_intent(q)
    assert intent["intent"] == TaskIntent.PERFORMANCE_INVESTIGATION, f"Failed on '{q}': expected PERFORMANCE_INVESTIGATION, got {intent['intent']}"
    assert intent["proposal_required"] is False, f"Failed on '{q}': proposal_required must be False"

# Verify fix query requires proposal
fix_intent = classify_task_intent("fix the slow query")
assert fix_intent["intent"] == TaskIntent.PERFORMANCE_FIX, f"Expected PERFORMANCE_FIX, got {fix_intent['intent']}"
assert fix_intent["proposal_required"] is True, "Fix query must require proposal"
print("  -> Passed: All inquiry queries classified as PERFORMANCE_INVESTIGATION (proposal_required=False) and fix query as PERFORMANCE_FIX (proposal_required=True)")

# 2. Verify Tool Resolution and Alias Normalization
print("[TEST] 2. Verifying tool capability resolution & validation...")
assert resolve_tool_capability("repo_browser.search_code") == "search_code"
assert resolve_tool_capability("repo_browser.read_file") == "read_file"
assert resolve_tool_capability("repo_browser.list_directory") == "list_directory"
assert resolve_tool_capability("find_code") == "search_code"
assert resolve_tool_capability("open_file") == "read_file"

c_name, norm_args = _validate_tool_call({
    "id": "c1",
    "type": "function",
    "function": {"name": "repo_browser.search_code", "arguments": json.dumps({"pattern": "SELECT *"})},
})
assert c_name == "search_code", f"Expected search_code, got {c_name}"
assert norm_args["query"] == "SELECT *", f"Expected normalized query, got {norm_args}"

c_name, norm_args = _validate_tool_call({
    "id": "c2",
    "type": "function",
    "function": {"name": "repo_browser.read_file", "arguments": json.dumps({"path": "models/Order.php"})},
})
assert c_name == "read_file", f"Expected read_file, got {c_name}"
assert norm_args["relativePath"] == "models/Order.php", f"Expected relativePath, got {norm_args}"

# Graceful rejection of unknown tools via ValueError
try:
    _validate_tool_call({
        "id": "c3",
        "type": "function",
        "function": {"name": "unknown_broken_tool", "arguments": "{}"},
    })
    assert False, "Unknown tool should raise ValueError"
except ValueError:
    pass
print("  -> Passed: Tool resolution and alias normalization verified")

# 3. Verify Project Name Blacklist
print("[TEST] 3. Verifying DISALLOWED_PROJECT_NAMES blacklist...")
blacklist_samples = ["the", "faq", "code-level", "query", "table", "measured", "evidence", "explain"]
for word in blacklist_samples:
    assert word in DISALLOWED_PROJECT_NAMES, f"'{word}' must be in DISALLOWED_PROJECT_NAMES"
print("  -> Passed: Blacklist contains all disallowed project tokens")

# 4. Verify Next Best Action
print("[TEST] 4. Verifying compute_next_best_action...")
action = compute_next_best_action({}, classify_task_intent("which query is take time"))
assert action["action"] == "search_code", f"Expected search_code action, got {action['action']}"
assert action["target"] == "query", f"Expected target query, got {action['target']}"
print(f"  -> Passed: Action is {action['action']} targeting '{action['target']}'")

# 5. Verify Tool Schema Invariants
print("[TEST] 5. Verifying tool availability contract...")
tool_names = [t["function"]["name"] for t in CODING_TOOLS]
assert "search_code" in tool_names, "search_code must be in CODING_TOOLS"
assert "read_file" in tool_names, "read_file must be in CODING_TOOLS"
print("  -> Passed: All read tools are declared in CODING_TOOLS")

# 4. Set up mock repository on disk
tmp_dir = tempfile.mkdtemp()
try:
    proj_dir = Path(tmp_dir) / "sample-store"
    (proj_dir / "models").mkdir(parents=True, exist_ok=True)
    order_file = proj_dir / "models" / "Order.php"
    order_file.write_text(
        "<?php\n"
        "class Order {\n"
        "    public function getSlowOrders() {\n"
        "        // Unindexed filter query taking significant time under load\n"
        "        return $this->db->query(\"SELECT * FROM orders WHERE status = 'pending'\");\n"
        "    }\n"
        "}\n"
    )
    set_backend_project_state(str(proj_dir))

    # 5. Live Simulation of _run_coding_turn with real tool execution
    print("[TEST] 4. Simulating _run_coding_turn with real backend tool execution...")
    runtime_provider = SimpleNamespace(id="test-provider", type="custom-openai", model="gpt-4o")

    responses = iter([
        ({
            "role": "assistant",
            "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {"name": "repo_browser.search_code", "arguments": json.dumps({"pattern": "query"})},
            }],
        }, runtime_provider),
        ({
            "role": "assistant",
            "tool_calls": [{
                "id": "call-2",
                "type": "function",
                "function": {"name": "read_file", "arguments": json.dumps({"relativePath": "models/Order.php"})},
            }],
        }, runtime_provider),
        ({
            "role": "assistant",
            "content": (
                "### DIRECT ANSWER\n"
                "The query taking time is the unindexed pending order query in `Order::getSlowOrders`.\n\n"
                "**QUERY:**\n"
                "`SELECT * FROM orders WHERE status = 'pending'`\n\n"
                "**LOCATION:**\n"
                "`models/Order.php:Order::getSlowOrders:4`\n\n"
                "**EVIDENCE:**\n"
                "Source inspection confirms filtering on `status = 'pending'` without a database index or request cache. Runtime query timing is not currently available.\n\n"
                "**EXECUTION:**\n"
                "Called per HTTP request when fetching orders.\n\n"
                "**CAUSE:**\n"
                "Lack of index on status column leads to full table scans as orders table grows.\n\n"
                "**CONFIDENCE:**\n"
                "CODE-LEVEL\n\n"
                "**NEXT STEP:**\n"
                "Add index on `orders(status)` and profile with DB EXPLAIN."
            ),
        }, runtime_provider),
    ])

    sent_events = []
    tool_queries_checked = []

    async def send_json(payload):
        sent_events.append(payload)

    async def mock_wait_for_tool(state, request_id, tool_call_id):
        # Find the tool call that was sent
        tc = next(m for m in reversed(sent_events) if m.get("type") == "tool_call" and m.get("toolCallId") == tool_call_id)
        name = tc["name"]
        args = tc.get("arguments", {})
        if name == "search_code":
            tool_queries_checked.append(args.get("query", ""))
        # Execute through the actual backend tool endpoint
        res = execute_coding_tool_endpoint({"name": name, "arguments": args, "scope": "."})
        return res

    state = {"pending": {}, "completed": {}, "tasks": set()}

    async def run_turn():
        with patch("coding_websocket.complete_coding_model", side_effect=lambda *args, **kwargs: next(responses)), \
             patch("coding_websocket._wait_for_tool", side_effect=mock_wait_for_tool):
            await _run_coding_turn(
                {
                    "requestId": "req-perf-101",
                    "conversationId": "conv-perf-active",
                    "sessionId": "conv-perf-active",
                    "scope": ".",
                    "projectRoot": str(proj_dir),
                    "messages": [{"role": "user", "content": "which query is take time"}],
                },
                send_json,
                state,
                SimpleNamespace(get_active_provider=lambda: runtime_provider),
                Path("config.json"),
            )

    asyncio.run(run_turn())

    # Verify tool calls executed
    assert len(tool_queries_checked) > 0, "search_code should have been called"
    print(f"  -> Observed search queries: {tool_queries_checked}")

    # Verify negative constraint: NO project attachment searches!
    forbidden = ["select folder", "project-discover", "setauthoritativeproject", "project-state"]
    for q in tool_queries_checked:
        for f in forbidden:
            assert f not in q.lower(), f"Forbidden search term '{f}' used during performance investigation!"
    print("  -> Passed: Zero project attachment searches occurred")

    # Verify final response contract
    done_msg = next(m for m in sent_events if m.get("type") == "done")
    content = done_msg.get("content", "")
    assert "**QUERY:**" in content, "Missing QUERY in response"
    assert "**LOCATION:**" in content, "Missing LOCATION in response"
    assert "**EVIDENCE:**" in content, "Missing EVIDENCE in response"
    assert "**CONFIDENCE:**" in content, "Missing CONFIDENCE in response"
    assert "CONFIDENCE:\nCODE-LEVEL" in content or "CODE-LEVEL" in content, "Confidence must be CODE-LEVEL"
    assert "Runtime query timing is not currently available" in content, "Must state runtime timing is not currently available"
    assert "Coding conversation ownership was lost" not in content, "Must not contain ownership error"
    assert done_msg.get("status") == "INVESTIGATION_COMPLETE", f"Expected INVESTIGATION_COMPLETE, got {done_msg.get('status')}"
    assert done_msg.get("proposalRequired") is False, "Done message must have proposalRequired=False"
    assert done_msg.get("readOnly") is True, "Done message must have readOnly=True"
    assert done_msg.get("confidence") == "CODE-LEVEL", f"Expected confidence CODE-LEVEL, got {done_msg.get('confidence')}"
    print("  -> Passed: Performance Response Contract & Done metadata completely satisfied")

    # 6. Test Autonomous Probe when LLM returns prose without tool calls
    print("[TEST] 6. Simulating autonomous probe recovery when model returns prose without tool calls...")
    probe_provider = SimpleNamespace(id="probe-provider", type="custom-openai", model="gpt-oss-20b")
    prose_responses = iter([
        ({
            "role": "assistant",
            "content": "I couldn't locate any database queries in the codebase. If you have a specific file, let me know.",
        }, probe_provider),
        ({
            "role": "assistant",
            "content": "Let me check the code.",
        }, probe_provider),
        ({
            "role": "assistant",
            "content": (
                "### DIRECT ANSWER\n"
                "The query taking time is the unindexed pending order query in `Order::getSlowOrders`.\n\n"
                "**QUERY:**\n"
                "`SELECT * FROM orders WHERE status = 'pending'`\n\n"
                "**LOCATION:**\n"
                "`models/Order.php:Order::getSlowOrders:4`\n\n"
                "**EVIDENCE:**\n"
                "Source inspection confirms unindexed filter query. Runtime query timing is not currently available.\n\n"
                "**EXECUTION:**\n"
                "Executed per request.\n\n"
                "**CAUSE:**\n"
                "Full table scan on orders without index.\n\n"
                "**CONFIDENCE:**\n"
                "CODE-LEVEL\n\n"
                "**NEXT STEP:**\n"
                "Add database index on orders(status)."
            ),
        }, probe_provider),
    ])

    sent_events_probe = []
    tools_called_probe = []

    async def send_json_probe(payload):
        sent_events_probe.append(payload)

    async def mock_wait_for_tool_probe(state, request_id, tool_call_id):
        tc = next(m for m in reversed(sent_events_probe) if m.get("type") == "tool_call" and m.get("toolCallId") == tool_call_id)
        name = tc["name"]
        args = tc.get("arguments", {})
        tools_called_probe.append(name)
        res = execute_coding_tool_endpoint({"name": name, "arguments": args, "scope": "."})
        return res

    state_probe = {"pending": {}, "completed": {}, "tasks": set()}

    async def run_turn_probe():
        with patch("coding_websocket.complete_coding_model", side_effect=lambda *args, **kwargs: next(prose_responses)), \
             patch("coding_websocket._wait_for_tool", side_effect=mock_wait_for_tool_probe):
            await _run_coding_turn(
                {
                    "requestId": "req-perf-probe-102",
                    "conversationId": "conv-perf-probe",
                    "sessionId": "conv-perf-probe",
                    "scope": ".",
                    "projectRoot": str(proj_dir),
                    "messages": [{"role": "user", "content": "which query is take time"}],
                },
                send_json_probe,
                state_probe,
                SimpleNamespace(get_active_provider=lambda: probe_provider),
                Path("config.json"),
            )

    asyncio.run(run_turn_probe())

    assert "search_code" in tools_called_probe, f"Expected search_code in autonomous tools called, got {tools_called_probe}"
    assert "read_file" in tools_called_probe, f"Expected read_file in autonomous tools called, got {tools_called_probe}"
    print(f"  -> Observed autonomous probe tools: {tools_called_probe}")

    done_probe = next(m for m in sent_events_probe if m.get("type") == "done")
    content_probe = done_probe.get("content", "")
    assert "**QUERY:**" in content_probe, "Missing QUERY in autonomous probe response"
    assert "SELECT * FROM orders WHERE status = 'pending'" in content_probe, "Query text missing in autonomous probe response"
    assert "**LOCATION:**" in content_probe, "Missing LOCATION in autonomous probe response"
    assert "models/Order.php" in content_probe, "File path missing in autonomous probe response"
    assert done_probe.get("status") == "INVESTIGATION_COMPLETE", f"Expected INVESTIGATION_COMPLETE, got {done_probe.get('status')}"
    print("  -> Passed: Autonomous probe successfully discovered query without relying on LLM tool call!")

    print("[SUCCESS] All Python performance investigation checks passed successfully!")
finally:
    import shutil
    shutil.rmtree(tmp_dir, ignore_errors=True)
