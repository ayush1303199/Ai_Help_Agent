"""Production WebSocket investigation-budget regression using controlled adapters."""

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

SERVER_SRC = Path(__file__).resolve().parents[1] / "server" / "src"
sys.path.insert(0, str(SERVER_SRC))

import coding_websocket


class CodingInvestigationBudgetTests(unittest.TestCase):
    def test_exhausted_proposal_investigation_returns_resumable_incomplete_result(self):
        with tempfile.TemporaryDirectory(prefix="coding-investigation-budget-") as temp_root:
            project = Path(temp_root)
            provider = SimpleNamespace(
                id="controlled-provider",
                type="groq",
                model="controlled-test-model",
            )
            sent = []

            async def send_json(payload):
                sent.append(payload)

            response = {
                "role": "assistant",
                "tool_calls": [{
                    "id": "search-personal-controller",
                    "type": "function",
                    "function": {
                        "name": "search_code",
                        "arguments": "{\"query\":\"PersonalController\"}",
                    },
                }],
            }
            state = {"pending": {}, "completed": {}, "tasks": set()}
            with patch(
                "coding_websocket.MAX_CODING_TOOL_ROUNDS",
                1,
            ), patch(
                "coding_websocket.complete_coding_model",
                return_value=(response, provider),
            ) as complete_model, patch(
                "coding_websocket._wait_for_tool",
                new=AsyncMock(return_value={
                    "ok": False,
                    "error": {
                        "code": "CONTROLLED_SEARCH_FAILURE",
                        "message": "The fixture search adapter is unavailable.",
                    },
                }),
            ):
                asyncio.run(coding_websocket._run_coding_turn(
                    {
                        "requestId": "investigation-budget-request",
                        "sessionId": "investigation-budget-session",
                        "projectRoot": str(project),
                        "scope": ".",
                        "messages": [{
                            "role": "user",
                            "content": "Fix the PersonalController bug and prepare a proposal.",
                        }],
                    },
                    send_json,
                    state,
                    SimpleNamespace(get_active_provider=lambda: provider),
                    "",
                ))

            done = next((item for item in sent if item.get("type") == "done"), None)
            self.assertIsNotNone(done, sent)
            self.assertEqual(done["status"], "INVESTIGATION_INCOMPLETE")
            self.assertIn("No root cause or proposal is claimed", done["content"])
            self.assertIn("Send 'continue' to resume", done["content"])
            self.assertFalse(done["proposalRequired"])
            self.assertEqual(done["semanticTask"]["status"], "INVESTIGATION_INCOMPLETE")
            continuation = done["semanticTask"]["continuation"]
            self.assertEqual(continuation["status"], "READY_TO_RESUME")
            self.assertTrue(continuation["nextAction"]["tool"])
            self.assertEqual(continuation["completedToolCalls"][0]["round"], 1)
            self.assertEqual(
                [item["name"] for item in done["toolCalls"]],
                ["search_code"],
            )
            self.assertEqual(complete_model.call_count, 2)
            self.assertFalse(any(
                "No more tools are available" in str(call.args[2])
                for call in complete_model.call_args_list
            ))
            self.assertFalse(any(
                event.get("event") == "TASK_COMPLETED"
                for event in done["lifecycleEvents"]
            ))


if __name__ == "__main__":
    unittest.main()
