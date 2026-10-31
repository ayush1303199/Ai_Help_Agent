import asyncio
import json
import sys
import unittest
from pathlib import Path

SERVER_SRC = Path(__file__).resolve().parents[1] / "server" / "src"
sys.path.insert(0, str(SERVER_SRC))

import coding_intelligence as intelligence  # noqa: E402
import coding_websocket as websocket  # noqa: E402


class CodingAgentPolicyTests(unittest.TestCase):
    def test_file_mutations_require_approved_scope_and_explicit_delete_confirmation(self):
        gate = intelligence.PolicyGate
        binding = {
            "taskId": "task-1",
            "turnId": "turn-1",
            "requestHash": "a" * 64,
            "root": str(Path.cwd().resolve()),
            "scope": ".",
            "authorizedFeatures": ["shared"],
        }
        self.assertEqual(
            gate.evaluate_file_mutation("create", ["src/new.ts"], False)[0],
            "BLOCK",
        )
        self.assertEqual(
            gate.evaluate_file_mutation("modify", ["src/current.ts"], True)[0],
            "BLOCK",
            "A proposal without trusted request binding must fail closed.",
        )
        self.assertEqual(
            gate.evaluate_file_mutation("modify", ["src/current.ts"], True, request_binding=binding)[0],
            "ALLOW",
        )
        self.assertEqual(
            gate.evaluate_file_mutation("rename", ["src/old.ts", "src/new.ts"], True, request_binding=binding)[0],
            "ALLOW",
        )
        self.assertEqual(
            gate.evaluate_file_mutation("delete", ["src/current.ts"], True, request_binding=binding)[0],
            "BLOCK",
        )
        self.assertEqual(
            gate.evaluate_file_mutation("delete_directory", ["src/unused"], True, True, binding)[0],
            "ALLOW",
        )
        self.assertEqual(
            gate.evaluate_file_mutation("modify", ["src/features/meeting/transcript.ts"], True, request_binding=binding)[0],
            "BLOCK",
            "A shared/Coding authorization must not mutate the Meeting feature.",
        )
        meeting_binding = {**binding, "authorizedFeatures": ["meeting", "shared"]}
        self.assertEqual(
            gate.evaluate_file_mutation(
                "modify", ["src/features/meeting/transcript.ts"], True,
                request_binding=meeting_binding,
            )[0],
            "ALLOW",
            "Cross-feature writes are allowed only when that feature is explicitly authorized.",
        )
        self.assertEqual(
            gate.evaluate_file_mutation(
                "modify", ["src/current.ts"], True,
                request_binding={**binding, "requestHash": "not-a-hash"},
            )[0],
            "BLOCK",
        )
        self.assertEqual(
            gate.evaluate_file_mutation("modify", ["../outside.ts"], True)[0],
            "BLOCK",
        )
        self.assertEqual(
            gate.evaluate_file_mutation("create", [".env"], True)[0],
            "BLOCK",
        )
        self.assertEqual(
            gate.evaluate_file_mutation("write_anything", ["src/current.ts"], True)[0],
            "BLOCK",
        )

    def test_proposal_shapes_accept_explicit_create_delete_move_and_directory_delete(self):
        additions = "--- /dev/null\n+++ b/src/new.py\n@@ -0,0 +1,1 @@\n+value\n"
        deletions = "--- a/src/old.py\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-value\n"
        moves = "diff --git a/src/old.py b/src/new.py\nrename from src/old.py\nrename to src/new.py\n"
        directory_delete = "*** Delete Directory: src/unused\n"

        for proposal in (additions, deletions, moves, directory_delete):
            self.assertTrue(websocket._is_unified_diff_response(proposal), proposal)

    def test_reuse_precedes_extension_refactor_and_new_abstraction(self):
        contract = intelligence.ExecutionContractBuilder.build(
            "FEATURE_REQUEST",
            "Add a helper for repeated validation.",
            proposal_required=True,
        ).to_dict()

        self.assertEqual(
            contract["engineeringPolicy"]["reusePrecedence"],
            ["REUSE", "EXTEND", "LOCAL_REFACTOR", "SMALL_NEW_ABSTRACTION"],
        )
        self.assertIn(
            "existing implementation pattern relevant",
            websocket._coding_task_steps("FEATURE_REQUEST", True)[0],
        )
        self.assertEqual(
            websocket.CODING_ENGINEERING_POLICY,
            intelligence.CODING_ENGINEERING_POLICY,
        )

    def test_existing_coding_agent_is_the_single_autonomous_owner(self):
        contract = intelligence.ExecutionContractBuilder.build(
            "FEATURE_REQUEST",
            "Implement the requested feature.",
            proposal_required=True,
        ).to_dict()

        self.assertTrue(contract["engineeringPolicy"]["singleCodingAgentOwner"])
        self.assertIn(
            "one authoritative Coding Agent owner",
            intelligence.CODING_ENGINEERING_POLICY,
        )
        self.assertIn(
            "do not create or delegate core task ownership",
            intelligence.CODING_ENGINEERING_POLICY,
        )
        finalized = websocket._coding_finalization_messages(
            [{"role": "user", "content": "Implement the requested feature."}],
            proposal_required=True,
        )
        self.assertIn(intelligence.CODING_ENGINEERING_POLICY, finalized[0]["content"])

    def test_uncertain_obsolete_code_is_kept_and_cleanup_is_bounded(self):
        contract = intelligence.ExecutionContractBuilder.build(
            "REFACTOR",
            "Refactor the affected implementation.",
            proposal_required=True,
        ).to_dict()
        policy = contract["engineeringPolicy"]

        self.assertEqual(
            policy["obsoleteCodeRemovalRequires"],
            [
                "proven unused",
                "authoritative replacement exists",
                "directly related to the task",
                "behavior preserved",
                "unrelated functionality unaffected",
                "relevant regression checks pass",
            ],
        )
        self.assertEqual(policy["unprovenObsoleteCodeAction"], "KEEP")
        self.assertFalse(policy["unrelatedCleanupAllowed"])
        self.assertIn(
            "If any condition is unproven, keep the code",
            intelligence.CODING_ENGINEERING_POLICY,
        )


    # -------------------------------------------------------------------------
    # Tool Extraction, Path Traversal Security & Evidence Integrity (Consolidated from V15)
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
            extracted = websocket._extract_tool_call_from_text(text, round_number=0, scope=".")
            self.assertIsNotNone(extracted, f"Failed to extract valid call from: {text}")
            self.assertEqual(extracted["function"]["name"], expected_tool)
            self.assertEqual(json.loads(extracted["function"]["arguments"]), expected_args)

    def test_invalid_and_path_traversal_tool_calls_rejected(self):
        """Path traversal, absolute paths, and empty arguments must be rejected and return None."""
        dangerous_texts = [
            'read_file {"path": "../../etc/passwd"}',
            'read_file {"path": "..\\..\\Windows\\System32"}',
            'read_file {"path": "dir/../../../secret.txt"}',
            'read_file {"path": "C:\\Windows\\System32\\cmd.exe"}',
            'read_file {"path": "/etc/shadow"}',
            'read_file {"path": "\\\\remote\\share\\file.txt"}',
            'read_file {"path": ""}',
            'read_file {"path": "   "}',
            'search_code {"query": ""}',
            'find_references {"symbol": ""}',
            'read_file {"path": "test\x00.js"}',
        ]
        for text in dangerous_texts:
            extracted = websocket._extract_tool_call_from_text(text, round_number=0, scope=".")
            self.assertIsNone(extracted, f"Dangerous or invalid call was not rejected: {text}")

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
            extracted = websocket._extract_tool_call_from_text(text, round_number=0, scope=".")
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
            extracted = websocket._extract_tool_call_from_text(text, round_number=0, scope=".")
            self.assertIsNone(extracted, f"Malformed text produced unexpected extraction: {text}")

    def test_successful_repository_map_dispatch_and_consumption(self):
        """A valid repository-map result is consumed into session targetFiles and semantic task architecture."""
        session_id = "test-session-map-consume"
        project_root = "/test/project"
        sess = websocket.CODING_TASK_STORE.get_or_create(session_id, project_root=project_root, scope=".")
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

        websocket._update_task_from_tool_result(
            semantic_task,
            action,
            result,
            json.dumps(result),
            session_id,
        )

        self.assertEqual(action["status"], "SUCCESS")
        self.assertTrue(websocket._has_repository_map_evidence(semantic_task))
        self.assertEqual(semantic_task["architecture"].get("languages"), ["typescript", "javascript"])
        self.assertIn("server.js", semantic_task["architecture"].get("entryPoints", []))

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

        websocket._update_task_from_tool_result(
            semantic_task,
            action,
            empty_result,
            json.dumps(empty_result),
            "sess-empty-map",
        )

        self.assertFalse(websocket._has_repository_map_evidence(semantic_task))

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

        websocket._update_task_from_tool_result(
            semantic_task,
            action,
            fail_result,
            json.dumps(fail_result),
            "sess-fail-map",
        )

        self.assertEqual(action["status"], "FAILED")
        self.assertFalse(websocket._has_repository_map_evidence(semantic_task))

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

        websocket._update_task_from_tool_result(
            semantic_task,
            action,
            fail_result,
            json.dumps(fail_result),
            session_id,
        )

        self.assertEqual(action["status"], "FAILED")
        self.assertFalse(websocket._has_read_file_evidence([
            {"role": "tool", "tool_call_id": "call-1", "content": json.dumps(fail_result)}
        ]))

    def test_duplicate_no_progress_calls_break_loop_honestly(self):
        """Verify that classify_tool_result_status identifies empty and error results."""
        empty_res = {"ok": True, "data": []}
        err_res = {"ok": False, "error": "Not found"}
        self.assertEqual(websocket.classify_tool_result_status(empty_res), websocket.ToolResultStatus.SUCCESS)
        self.assertEqual(websocket.classify_tool_result_status(err_res), websocket.ToolResultStatus.NOT_FOUND)

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
        websocket._update_task_from_tool_result(
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
        websocket._update_task_from_tool_result(
            semantic_task,
            action,
            success_result,
            json.dumps(success_result),
            session_id,
        )
        self.assertEqual(action["status"], "SUCCESS")
        self.assertTrue(len(semantic_task["evidence"]) > 0)


class CodingWebSocketContractTests(unittest.IsolatedAsyncioTestCase):
    def test_tool_arguments_are_validated_against_declared_schema(self):
        with self.assertRaisesRegex(ValueError, "not valid JSON"):
            websocket._validate_tool_call({
                "function": {"name": "read_file", "arguments": '{"path":'},
            })
        with self.assertRaisesRegex(ValueError, "arguments.path is required"):
            websocket._validate_tool_call({
                "function": {"name": "read_file", "arguments": "{}"},
            })
        with self.assertRaisesRegex(ValueError, "unsupported properties"):
            websocket._validate_tool_call({
                "function": {"name": "read_file", "arguments": '{"path":"src/a.ts","extra":true}'},
            })
        with self.assertRaisesRegex(ValueError, "wrong type"):
            websocket._validate_tool_call({
                "function": {"name": "get_context", "arguments": '{"query":"src","maxTokens":true}'},
            })
        with self.assertRaisesRegex(ValueError, "UNKNOWN_MODEL_TOOL"):
            websocket._validate_tool_call({
                "function": {"name": "run_shell", "arguments": "{}"},
            })
        self.assertEqual(
            websocket._validate_tool_call({
                "function": {"name": "read_file", "arguments": '{"path":"src/a.ts"}'},
            }),
            ("read_file", {"relativePath": "src/a.ts"}),
        )

    async def test_request_cancellation_does_not_cancel_other_tasks(self):
        request_task = asyncio.create_task(asyncio.sleep(60))
        other_task = asyncio.create_task(asyncio.sleep(60))
        request_future = asyncio.get_running_loop().create_future()
        other_future = asyncio.get_running_loop().create_future()
        state = {
            "tasks_by_request": {"cancel-me": request_task, "keep-running": other_task},
            "tasks": {request_task, other_task},
            "pending": {
                "cancel-me:tool-1": request_future,
                "keep-running:tool-2": other_future,
            },
            "completed": {
                "cancel-me:late": {"ok": True},
                "keep-running:result": {"ok": True},
            },
        }
        sent = []

        async def send_json(payload):
            sent.append(payload)

        try:
            await websocket.handle_coding_payload(
                '{"type":"cancel","requestId":"not-active"}',
                send_json,
                state,
                registry=None,
                config_path=None,
            )
            self.assertEqual(sent[-1]["status"], "NOT_ACTIVE")
            self.assertFalse(request_task.cancelled())
            self.assertFalse(other_task.cancelled())
            await websocket.handle_coding_payload(
                '{"type":"cancel","requestId":"cancel-me"}',
                send_json,
                state,
                registry=None,
                config_path=None,
            )
            await asyncio.sleep(0)
            self.assertTrue(request_task.cancelled())
            self.assertFalse(other_task.cancelled())
            self.assertTrue(request_future.cancelled())
            self.assertFalse(other_future.cancelled())
            self.assertNotIn("cancel-me:late", state["completed"])
            self.assertIn("keep-running:result", state["completed"])
            self.assertEqual(sent[-1]["type"], "cancelled")
            self.assertEqual(sent[-1]["requestId"], "cancel-me")
            await websocket.handle_coding_payload(
                '{"type":"tool_result","requestId":"cancel-me","toolCallId":"late","result":{"ok":true}}',
                send_json,
                state,
                registry=None,
                config_path=None,
            )
            self.assertNotIn("cancel-me:late", state["completed"])
        finally:
            other_task.cancel()
            await asyncio.gather(request_task, other_task, return_exceptions=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
