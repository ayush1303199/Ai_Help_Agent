import sys
import os
import json
import asyncio
from pathlib import Path
from unittest.mock import patch

# Add server/src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "server" / "src"))

from coding_websocket import (
    CODING_TASK_STORE,
    TaskIntent,
    classify_task_intent,
    compute_next_best_action,
    _run_coding_turn,
    set_backend_project_state,
)
from index import search_coding_code_endpoint, read_coding_file_endpoint, execute_coding_tool_endpoint

async def test_candidate_portal():
    candidate_root = "C:/Users/Admin/Documents/candidate-portal-2026"
    if not os.path.exists(candidate_root):
        print(f"Candidate portal root {candidate_root} does not exist, skipping live test.")
        return

    # Attach candidate-portal-2026
    set_backend_project_state(candidate_root)
    session_id = "test-candidate-portal-session"
    request_id = "test-req-001"
    
    # 1. User message classification
    user_prompt = "which query is take time"
    intent_info = classify_task_intent(user_prompt)
    print("Classified intent:", intent_info)
    assert intent_info["intent"] == TaskIntent.PERFORMANCE_INVESTIGATION
    assert intent_info["proposal_required"] is False
    
    # 2. Search endpoint test
    search_res = search_coding_code_endpoint(query="query", scope="controllers")
    print(f"Search results count: {len(search_res['results'])}")
    has_search_api = any("SearchApiController" in r["path"] for r in search_res["results"])
    assert has_search_api, "SearchApiController should be found in search results"
    print("Search found SearchApiController.php!")
    
    # 3. Read file endpoint test with scoped and unscoped paths
    read_scoped = read_coding_file_endpoint("controllers/SearchApiController.php", scope="controllers")
    assert "SELECT" in read_scoped["content"]
    assert "faq" in read_scoped["content"]
    
    read_unscoped = read_coding_file_endpoint("SearchApiController.php", scope="controllers")
    assert "SELECT" in read_unscoped["content"]
    assert "faq" in read_unscoped["content"]
    print("Read file works with both scoped and unscoped path!")

    # 4. Full autonomous turn simulation where LLM returns prose (like groq did in user screenshot)
    sent_messages = []
    async def mock_send(msg):
        sent_messages.append(msg)

    # Mock complete_coding_model to return conversational prose with NO tool calls
    prose_msg = {
        "role": "assistant",
        "content": "I'm unable to locate any database queries in the current project. If you can point me to the relevant controller or model file, I can inspect it directly."
    }

    # Bridge tool calls to real backend execute_coding_tool_endpoint
    async def mock_wait_for_tool(state, req_id, call_id):
        tool_call = state.get("pending_tool_call")
        name = tool_call.get("name")
        args = tool_call.get("arguments")
        res = execute_coding_tool_endpoint({"name": name, "arguments": args, "scope": "controllers"})
        return res

    state = {}
    async def custom_send(msg):
        sent_messages.append(msg)
        if msg.get("type") == "tool_call":
            state["pending_tool_call"] = msg
            call_id = msg.get("toolCallId")
            res = execute_coding_tool_endpoint({"name": msg.get("name"), "arguments": msg.get("arguments"), "scope": "controllers"})
            state.setdefault("tool_results", {})[call_id] = res

    async def patched_wait(st, req_id, call_id):
        return st.get("tool_results", {}).get(call_id, {"ok": False})

    with patch("coding_websocket.complete_coding_model", return_value=(prose_msg, None)):
        with patch("coding_websocket._wait_for_tool", side_effect=patched_wait):
            await _run_coding_turn(
                {
                    "requestId": request_id,
                    "conversationId": session_id,
                    "projectRoot": candidate_root,
                    "scope": "controllers",
                    "messages": [{"role": "user", "content": user_prompt}],
                },
                custom_send,
                state,
                None,
                None,
            )

    done_msg = next((m for m in sent_messages if m.get("type") == "done"), None)
    assert done_msg is not None, "A done message must be emitted"
    print("Done message status:", done_msg.get("status"))
    print("Done message filesRead:", [f["path"] for f in done_msg.get("filesRead", [])])
    assert len(done_msg.get("filesRead", [])) > 0, "filesRead must NOT be empty!"
    assert any("SearchApiController" in f["path"] for f in done_msg.get("filesRead", [])), "SearchApiController must be in filesRead!"
    
    content = done_msg.get("content", "")
    print("Content preview:\n", content[:300])
    assert "**QUERY:**" in content
    assert "faq" in content.lower()
    assert "controllers/searchapicontroller.php" in content.lower()
    assert "code-level" in content.lower()
    print("[SUCCESS] All candidate portal end-to-end checks PASSED!")

if __name__ == "__main__":
    asyncio.run(test_candidate_portal())
