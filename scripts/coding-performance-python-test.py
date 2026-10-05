import asyncio
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch
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
from coding_intelligence import (
    DatabaseCapability,
    DatabasePerformanceEngine,
    DatabaseSession,
    DatabaseSessionManager,
)
from index import DISALLOWED_PROJECT_NAMES

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

    # 5. Verify model intent selection routes to measured performance execution
    print("[TEST] 4. Simulating _run_coding_turn with live performance evidence...")
    runtime_provider = SimpleNamespace(id="test-provider", type="custom-openai", model="gpt-4o")
    sent_events = []

    async def send_json(payload):
        sent_events.append(payload)

    session = DatabaseSession(
        project_id="test-project",
        repository_id="test-repository",
        project_root=str(proj_dir),
        database_type="mysql",
        database_name="sample_store",
        connection_state="CONNECTED",
    )
    measured_report = {
        "ok": True,
        "content": "### SLOW QUERIES\nSELECT * FROM `orders` — average 42.0 ms",
        "queries": [{"rawQuery": "SELECT * FROM `orders`", "averageTimeMs": 42.0}],
        "candidate": {"rawQuery": "SELECT * FROM `orders`", "averageTimeMs": 42.0},
        "timingMs": 42.0,
        "evidenceQuality": "VERIFIED_LIVE",
    }
    state = {"pending": {}, "completed": {}, "tasks": set()}
    select_slow_queries = AsyncMock(return_value={
        "is_deterministic": True,
        "capability": DatabaseCapability.DATABASE_SLOW_QUERIES,
        "arguments": {},
        "resolved_by_model": True,
    })

    async def run_turn():
        with patch.object(DatabaseSessionManager, "get_or_create_session", return_value=session), \
             patch.object(DatabasePerformanceEngine, "autonomous_investigate_expensive_queries", return_value=measured_report), \
             patch("coding_websocket._resolve_database_action_with_model", new=select_slow_queries), \
             patch("coding_websocket.complete_coding_model", side_effect=AssertionError("Performance inquiry must not call the LLM")):
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

    assert select_slow_queries.await_count == 1, "Performance intent must be resolved from model context before execution"
    done_msg = next(m for m in sent_events if m.get("type") == "done")
    content = done_msg.get("content", "")
    assert "average 42.0 ms" in content, "Must include the measured performance report"
    assert done_msg.get("intent") == DatabaseCapability.DATABASE_SLOW_QUERIES
    assert done_msg.get("proposalRequired") is False, "Done message must have proposalRequired=False"
    assert done_msg.get("readOnly") is True, "Done message must have readOnly=True"
    assert done_msg.get("confidence") == "MEASURED"
    assert not any(event.get("type") == "tool_call" for event in sent_events)
    print("  -> Passed: Model-selected performance action returns measured query evidence")

    print("[TEST] 6. Verifying unavailable runtime statistics never invent a slow query...")
    unavailable_report = {
        "ok": True,
        "content": "Runtime query statistics are unavailable; no query was ranked.",
        "queries": [],
        "candidate": None,
        "timingMs": None,
        "evidenceQuality": "UNVERIFIED",
    }
    sent_events_unavailable = []
    async def send_json_unavailable(payload):
        sent_events_unavailable.append(payload)

    async def run_turn_unavailable():
        with patch.object(DatabaseSessionManager, "get_or_create_session", return_value=session), \
             patch.object(DatabasePerformanceEngine, "autonomous_investigate_expensive_queries", return_value=unavailable_report), \
             patch("coding_websocket._resolve_database_action_with_model", new=select_slow_queries), \
             patch("coding_websocket.complete_coding_model", side_effect=AssertionError("Performance inquiry must not call the LLM")):
            await _run_coding_turn(
                {
                    "requestId": "req-perf-unavailable-103",
                    "conversationId": "conv-perf-unavailable",
                    "sessionId": "conv-perf-unavailable",
                    "scope": ".",
                    "projectRoot": str(proj_dir),
                    "messages": [{"role": "user", "content": "which query is take time"}],
                },
                send_json_unavailable,
                {"pending": {}, "completed": {}, "tasks": set()},
                SimpleNamespace(get_active_provider=lambda: runtime_provider),
                Path("config.json"),
            )

    asyncio.run(run_turn_unavailable())
    assert select_slow_queries.await_count == 2
    done_unavailable = next(event for event in sent_events_unavailable if event.get("type") == "done")
    assert "Runtime query statistics are unavailable" in done_unavailable.get("content", "")
    assert "14.2" not in done_unavailable.get("content", "")
    assert "orders" not in done_unavailable.get("content", "")
    assert done_unavailable.get("confidence") == "UNVERIFIED"
    print("  -> Passed: Missing measurements are explicit and produce no synthetic query or timing")

    print("[SUCCESS] All Python performance investigation checks passed successfully!")
finally:
    import shutil
    shutil.rmtree(tmp_dir, ignore_errors=True)
