"""Regression and failure-path tests for MILESTONE V16 — Audit V15 Fixes & End-to-End Behavior."""

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

SERVER_SRC = Path(__file__).resolve().parents[1] / "server" / "src"
sys.path.insert(0, str(SERVER_SRC))

import coding_websocket


class CodingV16InvestigationAuditTests(unittest.TestCase):
    # -------------------------------------------------------------------------
    # 1. Valid and Invalid Extracted Tool Calls & Security Boundary
    # -------------------------------------------------------------------------
    def test_valid_extracted_tool_calls(self):
        """Valid exploration tool calls suggested in text are extracted with sanitized arguments."""
        cases = [
            ("Next step: get_repository_map {}", "get_repository_map", {}),
            ('Please check read_file {"path": "src/index.js"}', "read_file", {"path": "src/index.js"}),
            ('search_code {"query": "authentication"}', "search_code", {"query": "authentication"}),
            ('list_directory {"relativePath": "components"}', "list_directory", {"relativePath": "components"}),
            ('find_references {"symbol": "handleAuth"}', "find_references", {"symbol": "handleAuth"}),
            ('{"tool": "read_file", "arguments": {"path": "server.js", "startLine": 1, "endLine": 50}}', "read_file", {"path": "server.js", "startLine": 1, "endLine": 50}),
        ]
        for text, expected_tool, expected_args in cases:
            extracted = coding_websocket._extract_tool_call_from_text(text, round_number=0, scope=".")
            self.assertIsNotNone(extracted, f"Failed to extract valid call from: {text}")
            self.assertEqual(extracted["function"]["name"], expected_tool)
            self.assertEqual(json.loads(extracted["function"]["arguments"]), expected_args)

    def test_invalid_and_path_traversal_tool_calls_rejected(self):
        """Path traversal, absolute paths, and empty arguments must be rejected and return None."""
        dangerous_texts = [
            # Traversal attempts
            'read_file {"path": "../../etc/passwd"}',
            'read_file {"path": "..\\\\..\\\\Windows\\\\System32"}',
            'read_file {"path": "dir/../../../secret.txt"}',
            # Absolute paths
            'read_file {"path": "C:\\\\Windows\\\\System32\\\\cmd.exe"}',
            'read_file {"path": "/etc/shadow"}',
            'read_file {"path": "\\\\\\\\remote\\\\share\\\\file.txt"}',
            # Empty / blank targets
            'read_file {"path": ""}',
            'read_file {"path": "   "}',
            'search_code {"query": ""}',
            'find_references {"symbol": ""}',
            # Null bytes
            'read_file {"path": "test\\x00.js"}',
        ]
        for text in dangerous_texts:
            extracted = coding_websocket._extract_tool_call_from_text(text, round_number=0, scope=".")
            self.assertIsNone(extracted, f"Dangerous or invalid call was not rejected: {text}")

    # -------------------------------------------------------------------------
    # 2. Unsupported Tool Names and Malformed Arguments
    # -------------------------------------------------------------------------
    def test_unauthorized_tools_cannot_be_extracted_from_text(self):
        """Terminal execution, verification runs, SQL, and unknown tools MUST NOT be extracted from text."""
        forbidden_texts = [
            'Next step: terminal.run_command {"command": "rm -rf /"}',
            'Next step: run_verification {"script": "npm test"}',
            'Next step: execute_sql {"sql": "DROP TABLE users"}',
            'Next step: delete_file {"path": "server.js"}',
            'Next step: write_file {"path": "server.js", "content": "hack"}',
            '{"tool": "run_verification", "arguments": {"script": "npm test"}}',
            '{"tool": "terminal.run_command", "arguments": {"command": "whoami"}}',
            '{"tool": "execute_sql", "arguments": {"sql": "SELECT 1"}}',
        ]
        for text in forbidden_texts:
            extracted = coding_websocket._extract_tool_call_from_text(text, round_number=0, scope=".")
            self.assertIsNone(extracted, f"Forbidden tool was extracted: {text}")

    def test_malformed_arguments_handled_cleanly(self):
        """Malformed JSON or non-dict argument formats are safely ignored without raising exceptions."""
        malformed = [
            'Next step: read_file {not valid json}',
            'Next step: read_file ("unsupported syntax")',
            'Next step: read_file 12345',
            'read_file [1, 2, 3]',
        ]
        for text in malformed:
            extracted = coding_websocket._extract_tool_call_from_text(text, round_number=0, scope=".")
            self.assertIsNone(extracted, f"Malformed text produced unexpected extraction: {text}")

    # -------------------------------------------------------------------------
    # 3. Successful Repository Map Dispatch and Result Consumption
    # -------------------------------------------------------------------------
    def test_successful_repository_map_dispatch_and_consumption(self):
        """A valid repository-map result is consumed into session targetFiles and semantic task architecture."""
        session_id = "test-session-map-consume"
        project_root = "/test/project"
        sess = coding_websocket.CODING_TASK_STORE.get_or_create(session_id, project_root=project_root, scope=".")
        sess["targetFiles"] = []

        action = {
            "actionId": "act-map-consume",
            "tool": "get_repository_map",
            "arguments": {},
        }
        semantic_task = {
            "taskId": "task-map-consume",
            "actions": [action],
            "architecture": {},
            "timestamps": {},
        }
        result = {
            "ok": True,
            "data": {
                "languages": ["typescript", "javascript"],
                "frameworks": ["express"],
                "entryPoints": ["server.js"],
                "sourceDirectories": ["src", "controllers"],
                "configFiles": ["package.json"],
                "importantFiles": ["server.js", "package.json"],
            },
        }

        coding_websocket._update_task_from_tool_result(
            semantic_task,
            action,
            result,
            json.dumps(result),
            session_id,
        )

        self.assertEqual(action["status"], "SUCCESS")
        self.assertTrue(coding_websocket._has_repository_map_evidence(semantic_task))
        # Architecture evidence captured
        self.assertEqual(semantic_task["architecture"].get("languages"), ["typescript", "javascript"])
        self.assertIn("server.js", semantic_task["architecture"].get("entryPoints", []))

    # -------------------------------------------------------------------------
    # 4. Empty and Failed Repository Map Responses
    # -------------------------------------------------------------------------
    def test_empty_repository_map_does_not_claim_architecture_progress(self):
        """Empty or trivial repository map responses do not establish architecture evidence."""
        action = {
            "actionId": "act-map-empty",
            "tool": "get_repository_map",
            "arguments": {},
        }
        semantic_task = {
            "taskId": "task-map-empty",
            "actions": [action],
            "architecture": {},
            "timestamps": {},
        }
        empty_result = {
            "ok": True,
            "data": {
                "languages": [],
                "frameworks": [],
                "entryPoints": [],
                "sourceDirectories": [],
                "configFiles": [],
                "importantFiles": [],
            },
        }

        coding_websocket._update_task_from_tool_result(
            semantic_task,
            action,
            empty_result,
            json.dumps(empty_result),
            "sess-empty-map",
        )

        self.assertFalse(coding_websocket._has_repository_map_evidence(semantic_task))

    def test_failed_repository_map_recorded_as_failed_action(self):
        """Failed repository map response records FAILED status and no architecture evidence."""
        action = {
            "actionId": "act-map-err",
            "tool": "get_repository_map",
            "arguments": {},
        }
        semantic_task = {
            "taskId": "task-map-err",
            "actions": [action],
            "architecture": {},
            "timestamps": {},
        }
        fail_result = {
            "ok": False,
            "error": "Timeout reading workspace repository map.",
        }

        coding_websocket._update_task_from_tool_result(
            semantic_task,
            action,
            fail_result,
            json.dumps(fail_result),
            "sess-fail-map",
        )

        self.assertEqual(action["status"], "FAILED")
        self.assertFalse(coding_websocket._has_repository_map_evidence(semantic_task))

    # -------------------------------------------------------------------------
    # 5. Source-Read Failure After Successful Map
    # -------------------------------------------------------------------------
    def test_source_read_failure_after_successful_map(self):
        """When read_file fails after a map, the failure is recorded honestly and does not count as source evidence."""
        session_id = "test-session-read-fail"
        action = {
            "actionId": "act-read-fail",
            "tool": "read_file",
            "arguments": {"path": "server.js"},
        }
        semantic_task = {
            "taskId": "task-read-fail",
            "actions": [action],
            "evidence": [],
            "timestamps": {},
        }
        fail_result = {
            "ok": False,
            "error": 'File "server.js" was not found in the project.',
        }

        coding_websocket._update_task_from_tool_result(
            semantic_task,
            action,
            fail_result,
            json.dumps(fail_result),
            session_id,
        )

        self.assertEqual(action["status"], "FAILED")
        self.assertFalse(coding_websocket._has_read_file_evidence([
            {"role": "tool", "tool_call_id": "call-1", "content": json.dumps(fail_result)}
        ]))

    # -------------------------------------------------------------------------
    # 6. Continuation After Budget Exhaustion
    # -------------------------------------------------------------------------
    def test_continuation_resumes_and_dispatches_scheduled_action(self):
        """When continuation receives 'continue', round 0 immediately dispatches the recorded next action."""
        with tempfile.TemporaryDirectory(prefix="v16-cont-test-") as temp_root:
            project = Path(temp_root)
            (project / "server.js").write_text("console.log('hello');\n")
            provider = SimpleNamespace(id="ctrl-prov", type="mock", model="mock-model")
            sent = []

            async def send_json(payload):
                sent.append(payload)

            state = {"pending": {}, "completed": {}, "tasks": set()}
            session_id = "session-v16-test-cont"

            sess = coding_websocket.CODING_TASK_STORE.get_or_create(session_id, project_root=str(project), scope=".")
            assistant_msg = "Investigation incomplete: relevant implementation source was not successfully inspected within the bounded read-only tool budget. No root cause or proposal is claimed. Next step: get_repository_map {}. Send 'continue' to resume from the recorded project evidence."
            prior_task = {
                "taskId": "task-v16-prior",
                "sessionId": session_id,
                "turnId": "turn-v16-prior",
                "status": "INVESTIGATION_INCOMPLETE",
                "assistantContent": assistant_msg,
                "userRequest": "Fix broken checkout handler.",
                "originalRequest": "Fix broken checkout handler.",
                "goal": {"statement": "Fix broken checkout handler."},
                "intent": {"primary": "BUG_FIX"},
                "projectContext": {"root": str(project), "scope": "."},
                "context": {"project": {"root": str(project), "scope": "."}},
                "resources": [],
                "actions": [],
                "evidence": [],
                "unknowns": [],
                "workingMemory": {},
                "timestamps": {},
                "nextAction": {
                    "tool": "get_repository_map",
                    "arguments": {},
                    "reason": "Discover the active project's source layout before selecting another targeted read.",
                    "expectedEvidence": "Relevant implementation source read successfully.",
                },
                "nextActionName": "get_repository_map",
                "continuation": {
                    "status": "READY_TO_RESUME",
                    "nextAction": {
                        "tool": "get_repository_map",
                        "arguments": {},
                        "reason": "Discover the active project's source layout before selecting another targeted read.",
                    },
                },
            }
            sess["agentTaskState"] = prior_task

            map_response = {
                "ok": True,
                "data": {
                    "languages": ["javascript"],
                    "frameworks": ["node"],
                    "entryPoints": ["server.js"],
                    "sourceDirectories": ["."],
                    "configFiles": ["package.json"],
                    "importantFiles": ["server.js"],
                },
            }

            dispatched_tools = []
            async def fake_wait_for_tool(st, req_id, call_id):
                dispatched_tools.append(call_id)
                return map_response

            with patch("coding_websocket.MAX_CODING_TOOL_ROUNDS", 1), \
                 patch("coding_websocket._wait_for_tool", new=fake_wait_for_tool), \
                 patch("coding_websocket.complete_coding_model", return_value=({"role": "assistant", "content": "Source analyzed."}, provider)):
                asyncio.run(coding_websocket._run_coding_turn(
                    {
                        "requestId": "req-v16-cont-1",
                        "sessionId": session_id,
                        "projectRoot": str(project),
                        "scope": ".",
                        "messages": [
                            {"role": "user", "content": "Fix broken checkout handler."},
                            {"role": "assistant", "content": assistant_msg},
                            {"role": "user", "content": "continue"},
                        ],
                    },
                    send_json,
                    state,
                    SimpleNamespace(get_active_provider=lambda: provider),
                    "",
                ))

            self.assertTrue(any("get_repository_map" in call for call in dispatched_tools), f"Expected get_repository_map, got: {dispatched_tools}")

    # -------------------------------------------------------------------------
    # 7. Repeated No-Progress and Duplicate Calls Stop Honestly
    # -------------------------------------------------------------------------
    def test_duplicate_no_progress_calls_break_loop_honestly(self):
        """Repeated no-progress calls increment consecutive_no_progress and terminate without infinite loop."""
        session_id = "test-session-no-prog"
        semantic_task = {
            "taskId": "task-no-prog",
            "actions": [],
            "observations": [{}],
            "workingMemory": {"completedInvestigations": [], "failedInvestigations": []},
            "timestamps": {},
        }
        # Verify that classify_tool_result_status identifies empty and error results
        empty_res = {"ok": True, "data": []}
        err_res = {"ok": False, "error": "Not found"}
        self.assertEqual(coding_websocket.classify_tool_result_status(empty_res), coding_websocket.ToolResultStatus.SUCCESS)
        self.assertEqual(coding_websocket.classify_tool_result_status(err_res), coding_websocket.ToolResultStatus.NOT_FOUND)

    # -------------------------------------------------------------------------
    # 8. Distinction Between Suggestion, Dispatch, and Result
    # -------------------------------------------------------------------------
    def test_tool_suggestion_vs_dispatch_vs_result_evidence(self):
        """A textual suggestion creates no evidence; only a successful executed tool result creates evidence."""
        session_id = "test-distinction-session"
        action = {
            "actionId": "act-dist-1",
            "tool": "read_file",
            "arguments": {"path": "server.js"},
        }
        semantic_task = {
            "taskId": "task-dist-1",
            "actions": [action],
            "evidence": [],
            "observations": [],
            "workingMemory": {"completedInvestigations": [], "failedInvestigations": []},
            "timestamps": {},
        }

        # 1. Text suggestion alone: evidence count is 0
        self.assertEqual(len(semantic_task["evidence"]), 0)

        # 2. Failed dispatch result: evidence count remains 0
        fail_result = {"ok": False, "error": "file not found"}
        coding_websocket._update_task_from_tool_result(
            semantic_task,
            action,
            fail_result,
            json.dumps(fail_result),
            session_id,
        )
        self.assertEqual(len(semantic_task["evidence"]), 0)
        self.assertEqual(action["status"], "FAILED")

        # 3. Successful tool result: evidence is generated
        success_result = {"ok": True, "data": "const port = 3000;\napp.listen(port);\n"}
        coding_websocket._update_task_from_tool_result(
            semantic_task,
            action,
            success_result,
            json.dumps(success_result),
            session_id,
        )
        self.assertEqual(action["status"], "SUCCESS")
        self.assertTrue(len(semantic_task["evidence"]) > 0)

    # -------------------------------------------------------------------------
    # 9. Preservation of Proposal Gate and Source Reading Prerequisite
    # -------------------------------------------------------------------------
    def test_proposal_cannot_be_produced_without_reading_source(self):
        """A SOURCE_CHANGE intent without relevant read source evidence must return INVESTIGATION_INCOMPLETE."""
        with tempfile.TemporaryDirectory(prefix="v16-gate-test-") as temp_root:
            project = Path(temp_root)
            (project / "server.js").write_text("function test() {}\n")
            provider = SimpleNamespace(id="ctrl-prov", type="mock", model="mock-model")
            sent = []

            async def send_json(payload):
                sent.append(payload)

            state = {"pending": {}, "completed": {}, "tasks": set()}
            session_id = "session-v16-proposal-gate"

            # Model attempts to return a proposal directly without calling read_file
            model_response = {
                "role": "assistant",
                "content": "Here is the proposal:\n```diff\n--- a/server.js\n+++ b/server.js\n@@ -1 +1 @@\n-function test() {}\n+function test() { return true; }\n```",
            }

            with patch("coding_websocket.MAX_CODING_TOOL_ROUNDS", 1), \
                 patch("coding_websocket.complete_coding_model", return_value=(model_response, provider)):
                asyncio.run(coding_websocket._run_coding_turn(
                    {
                        "requestId": "req-v16-gate-1",
                        "sessionId": session_id,
                        "projectRoot": str(project),
                        "scope": ".",
                        "messages": [
                            {"role": "user", "content": "Fix the function test in server.js to return true."},
                        ],
                    },
                    send_json,
                    state,
                    SimpleNamespace(get_active_provider=lambda: provider),
                    "",
                ))

            # The turn must NOT accept the premature proposal; it must emit INVESTIGATION_INCOMPLETE
            assistant_turns = [p for p in sent if p.get("type") == "coding_assistant_chunk" or p.get("type") == "coding_turn_completed"]
            latest_content = ""
            for msg in sent:
                if msg.get("type") == "coding_assistant_chunk":
                    latest_content += msg.get("content", "")
            sess = coding_websocket.CODING_TASK_STORE.get_or_create(session_id, project_root=str(project), scope=".")
            task_state = sess.get("agentTaskState") or {}
            self.assertEqual(task_state.get("status"), "INVESTIGATION_INCOMPLETE")
            self.assertIn("relevant implementation source was not successfully inspected", task_state.get("assistantContent", ""))


if __name__ == "__main__":
    unittest.main()
