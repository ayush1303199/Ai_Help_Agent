import asyncio
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
