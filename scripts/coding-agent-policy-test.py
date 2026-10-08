import sys
import unittest
from pathlib import Path

SERVER_SRC = Path(__file__).resolve().parents[1] / "server" / "src"
sys.path.insert(0, str(SERVER_SRC))

import coding_intelligence as intelligence  # noqa: E402
import coding_websocket as websocket  # noqa: E402


class CodingAgentPolicyTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
