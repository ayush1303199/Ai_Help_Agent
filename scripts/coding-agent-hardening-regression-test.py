import asyncio
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

SERVER_SRC = Path(__file__).resolve().parents[1] / "server" / "src"
sys.path.insert(0, str(SERVER_SRC))

import coding_intelligence as intelligence  # noqa: E402
import coding_provider as provider  # noqa: E402
import coding_websocket as websocket  # noqa: E402


class CodingAgentHardeningRegressionTests(unittest.TestCase):
    def setUp(self):
        intelligence.DatabaseEvidenceStore.clear()
        intelligence.DatabasePerformanceEngine._query_stats.clear()

    def tearDown(self):
        intelligence.DatabaseEvidenceStore.clear()
        intelligence.DatabasePerformanceEngine._query_stats.clear()

    @staticmethod
    def _create_database(path: Path, table_name: str):
        connection = sqlite3.connect(path)
        try:
            connection.execute(f'CREATE TABLE "{table_name}" (id INTEGER PRIMARY KEY)')
            connection.commit()
        finally:
            connection.close()

    def test_provider_failures_distinguish_quota_throttling_auth_and_transport(self):
        class ProviderError(Exception):
            def __init__(self, message, status_code=None):
                super().__init__(message)
                self.status_code = status_code

        cases = (
            (
                ProviderError("Daily token quota exhausted; resets tomorrow", 429),
                "PROVIDER_QUOTA_EXHAUSTED",
                False,
                "CHECK_PROVIDER_QUOTA_RESET",
            ),
            (
                ProviderError("429 Too Many Requests: rate limit, retry after 30 seconds", 429),
                "PROVIDER_THROTTLED",
                True,
                "WAIT_FOR_PROVIDER_RETRY_WINDOW",
            ),
            (
                ProviderError("Invalid API key", 401),
                "PROVIDER_AUTH_ERROR",
                False,
                "CHECK_CREDENTIALS_AND_PROVIDER_PERMISSIONS",
            ),
            (
                ProviderError("Connection refused"),
                "PROVIDER_NETWORK_FAILURE",
                True,
                "RETRY_AFTER_NETWORK_RECOVERY",
            ),
            (
                ProviderError("Request timed out"),
                "LLM_PROVIDER_TIMEOUT",
                True,
                "RETRY_AFTER_PROVIDER_TIMEOUT",
            ),
            (
                ProviderError("Provider server error", 503),
                "PROVIDER_SERVICE_UNAVAILABLE",
                True,
                "WAIT_FOR_PROVIDER_RECOVERY",
            ),
        )
        for error, expected_category, expected_retryable, expected_action in cases:
            with self.subTest(category=expected_category):
                classification = websocket.classify_provider_exception(error)
                self.assertEqual(classification["category"], expected_category)
                self.assertEqual(classification["retryable"], expected_retryable)
                self.assertEqual(classification["suggestedAction"], expected_action)
                self.assertEqual(
                    classification["classification"],
                    "EXTERNAL_RESOURCE_FAILURE",
                )
                user_message = websocket._provider_failure_user_message(error, classification)
                self.assertIn("saved as incomplete", user_message)
                self.assertIn("continue this conversation", user_message)
        ambiguous_limit = websocket.classify_provider_exception(
            ProviderError("429", 429)
        )
        self.assertEqual(ambiguous_limit["category"], "PROVIDER_LIMIT_TYPE_UNKNOWN")
        self.assertFalse(ambiguous_limit["retryable"])

        class RetryAfterResponse:
            status_code = 429
            headers = {"retry-after": "15"}

        retry_after_error = ProviderError("429", 429)
        retry_after_error.response = RetryAfterResponse()
        retry_after_classification = websocket.classify_provider_exception(retry_after_error)
        self.assertEqual(retry_after_classification["category"], "PROVIDER_THROTTLED")
        self.assertEqual(retry_after_classification["retryAfterSeconds"], 15)
        with patch.object(websocket.time, "time", return_value=100):
            self.assertEqual(
                websocket._provider_recovery_wait_remaining({
                    "classification": "PROVIDER_THROTTLED",
                    "retryAfterSeconds": 30,
                    "recordedAt": 85,
                }),
                15,
            )
        self.assertIn(
            "15 seconds",
            websocket._provider_failure_user_message(
                retry_after_error,
                retry_after_classification,
            ),
        )
        exhausted_quota = websocket.classify_provider_exception(
            ProviderError("429: daily token quota exhausted; reset in 24 hours", 429)
        )
        self.assertIn(
            "reset window",
            websocket._provider_failure_user_message(
                ProviderError("429: daily token quota exhausted; reset in 24 hours", 429),
                exhausted_quota,
            ),
        )

    def test_provider_failure_preserves_incomplete_task_for_safe_continuation(self):
        project_root = str(Path("C:/workspace/project"))
        prior_task = {
            "taskId": "task-1",
            "turnId": "turn-1",
            "status": "UNDERSTANDING",
            "assistantContent": "An error was returned before the task finished.",
            "projectContext": {"root": project_root},
            "originalRequest": "Inspect the request execution lifecycle.",
            "userRequest": "Inspect the request execution lifecycle.",
            "goal": {"statement": "Inspect the request execution lifecycle."},
            "facts": [{"id": "fact-1", "statement": "A confirmed observation."}],
            "unknowns": [{"id": "unknown-1", "question": "What remains unverified?"}],
            "evidence": [{"id": "evidence-1", "content": "Confirmed source evidence."}],
            "actions": [{"id": "action-1", "status": "COMPLETED"}],
            "timestamps": {"createdAt": "2026-01-01T00:00:00Z", "completedAt": None},
            "nextAction": {"tool": "inspect_next_source", "reason": "Continue evidence gathering."},
            "failures": [],
            "workingMemory": {
                "currentRequest": "Inspect the request execution lifecycle.",
                "knownFacts": [{"id": "fact-1"}],
            },
            "conversationContext": {"recentMessages": [], "continuityDetected": False},
        }
        quota_error = RuntimeError("Daily token quota exhausted")
        quota_classification = websocket.classify_provider_exception(quota_error)
        self.assertTrue(
            websocket._record_provider_failure(
                prior_task,
                quota_error,
                quota_classification,
                "turn-1",
                "session-1",
            ),
            "An exhausted daily quota stays resumable without being marked retryable.",
        )
        self.assertEqual(prior_task["status"], "INCOMPLETE")
        self.assertEqual(prior_task["providerRecovery"]["retryable"], False)
        self.assertEqual(
            prior_task["nextAction"]["tool"],
            "inspect_next_source",
            "The last uncompleted action must remain available for continuation.",
        )
        self.assertEqual(prior_task["facts"][0]["id"], "fact-1")
        self.assertEqual(prior_task["evidence"][0]["id"], "evidence-1")
        continuation_messages = [
            {"role": "user", "content": "Inspect the request execution lifecycle."},
            {"role": "assistant", "content": "Provider request failed with HTTP 429."},
            {"role": "user", "content": "Continue this task after the provider is available."},
        ]

        self.assertTrue(
            websocket._matches_prior_semantic_task(
                continuation_messages,
                prior_task,
                project_root,
            )
        )
        self.assertFalse(
            websocket._matches_prior_semantic_task(
                continuation_messages,
                {**prior_task, "status": "FAILED"},
                project_root,
            ),
            "Only tasks explicitly retained as provider-recoverable may bypass assistant-content matching.",
        )
        self.assertFalse(
            websocket._matches_prior_semantic_task(
                continuation_messages,
                prior_task,
                str(Path("C:/workspace/other-project")),
            ),
            "Provider recovery must remain bound to the original project.",
        )

        resumed = websocket._resume_semantic_task(
            prior_task,
            {"turnId": "turn-2"},
            continuation_messages[-1]["content"],
            "turn-2",
        )
        self.assertEqual(resumed["status"], "UNDERSTANDING")
        self.assertEqual(resumed["taskId"], "task-1")
        self.assertEqual(resumed["turnId"], "turn-2")
        self.assertEqual(resumed["originalRequest"], prior_task["originalRequest"])
        self.assertEqual(resumed["goal"], prior_task["goal"])
        self.assertEqual(resumed["facts"], prior_task["facts"])
        self.assertEqual(resumed["unknowns"], prior_task["unknowns"])
        self.assertEqual(resumed["evidence"], prior_task["evidence"])
        self.assertEqual(resumed["actions"], prior_task["actions"])
        self.assertEqual(resumed["providerRecovery"]["state"], "RESUMED")
        self.assertEqual(
            resumed["providerRecovery"]["classification"],
            prior_task["providerRecovery"]["classification"],
        )

    def test_resumed_task_evidence_is_distinguished_from_provider_tool_results(self):
        project_root = str(Path("C:/workspace/project"))
        original_request = "Inspect the request execution lifecycle."
        source_evidence = {
            "evidenceId": "ev-read-source",
            "taskId": "task-source-resume",
            "sessionId": "source-resume-session",
            "projectRoot": project_root,
            "scope": ".",
            "type": "FILE",
            "source": "read_file",
            "target": "src/handler.py",
            "summary": '{"data":{"path":"src/handler.py","content":"def handle(): pass"}}',
            "provenance": "READ_ONLY_TOOL_RESULT",
            "verified": True,
        }
        prior_task = {
            "taskId": "task-source-resume",
            "turnId": "turn-provider-failure",
            "status": "INCOMPLETE",
            "originalRequest": original_request,
            "userRequest": original_request,
            "goal": {"statement": original_request},
            "projectContext": {"root": project_root},
            "evidence": [source_evidence],
            "providerRecovery": {
                "state": "WAITING_FOR_PROVIDER",
                "classification": "PROVIDER_QUOTA_EXHAUSTED",
                "retryable": False,
            },
            "conversationContext": {"recentMessages": [], "continuityDetected": False},
            "workingMemory": {},
            "timestamps": {},
        }
        resumed = websocket._resume_semantic_task(
            prior_task,
            {"turnId": "turn-resume"},
            "Continue the saved task.",
            "turn-resume",
        )
        task_state = websocket._compile_agent_task_context(resumed)
        messages = [
            {
                "role": "system",
                "content": (
                    "Current bounded AgentTaskState (authoritative):\n"
                    + json.dumps(task_state, ensure_ascii=False)
                ),
            },
            {"role": "user", "content": "Continue the saved task."},
        ]

        compiled, _tools, metrics = provider.compile_coding_context(
            messages,
            None,
            SimpleNamespace(type="openai", model="gpt-4o-mini"),
            compaction_pass=0,
        )
        payload_metrics = provider._payload_component_metrics({
            "messages": compiled,
            "tools": [],
        })

        self.assertEqual(resumed["taskId"], prior_task["taskId"])
        self.assertEqual(resumed["originalRequest"], original_request)
        self.assertEqual(resumed["evidence"], [source_evidence])
        self.assertEqual(metrics["selectedEvidenceCount"], 0)
        self.assertEqual(metrics["selectedToolResultCount"], 0)
        self.assertEqual(metrics["selectedEvidenceCountBasis"], "provider tool-result messages only")
        self.assertEqual(metrics["selectedTaskEvidenceCount"], 1)
        self.assertEqual(metrics["selectedHistoricalSourceEvidenceCount"], 1)
        self.assertFalse(metrics["historicalSourceEvidenceFreshnessChecked"])
        self.assertEqual(payload_metrics["toolResultSizeBytes"], 2)
        self.assertEqual(payload_metrics["selectedTaskEvidenceCount"], 1)
        self.assertEqual(payload_metrics["selectedHistoricalSourceEvidenceCount"], 1)
        self.assertFalse(websocket._has_read_source_evidence(compiled))

    def test_websocket_blocks_unconfirmed_provider_retry_before_repository_or_model_work(self):
        with tempfile.TemporaryDirectory(prefix="coding-provider-recovery-") as root:
            session_id = "provider-recovery-gate-test"
            prior_task = {
                "taskId": "task-provider-recovery",
                "turnId": "turn-provider-failure",
                "status": "INCOMPLETE",
                "assistantContent": "The configured provider's quota is exhausted.",
                "projectContext": {"root": str(Path(root).resolve())},
                "originalRequest": "Inspect how provider failures affect task continuation.",
                "goal": {"statement": "Inspect how provider failures affect task continuation."},
                "facts": [{"id": "fact-confirmed", "statement": "A repository fact."}],
                "unknowns": [{"id": "unknown-open", "question": "What remains?"}],
                "evidence": [{"id": "evidence-confirmed", "content": "A confirmed observation."}],
                "actions": [{"id": "action-complete", "status": "COMPLETED"}],
                "nextAction": {"tool": "inspect_next_source", "reason": "Continue the saved investigation."},
                "failures": [],
                "timestamps": {"createdAt": "2026-01-01T00:00:00Z", "completedAt": None},
                "workingMemory": {"knownFacts": [{"id": "fact-confirmed"}]},
                "conversationContext": {"recentMessages": [], "continuityDetected": False},
                "providerRecovery": {
                    "state": "WAITING_FOR_PROVIDER",
                    "classification": "PROVIDER_QUOTA_EXHAUSTED",
                    "retryable": False,
                    "suggestedAction": "CHECK_PROVIDER_QUOTA_RESET",
                },
            }
            session = websocket.CODING_TASK_STORE.get_or_create(
                session_id,
                project_root=str(Path(root).resolve()),
            )
            session["agentTaskState"] = prior_task
            events = []

            async def send_json(event):
                events.append(event)

            payload = {
                "requestId": "provider-recovery-gate-turn",
                "conversationId": session_id,
                "sessionId": session_id,
                "projectRoot": root,
                "messages": [
                    {"role": "user", "content": prior_task["originalRequest"]},
                    {"role": "assistant", "content": prior_task["assistantContent"]},
                    {"role": "user", "content": "Continue the saved task using its original objective and confirmed evidence."},
                ],
            }
            websocket_state = {"pending": {}, "completed": {}, "tasks": set()}

            async def send_request():
                await websocket.handle_coding_payload(
                    json.dumps({"type": "chat", **payload}),
                    send_json,
                    websocket_state,
                    registry=None,
                    config_path="",
                )
                await asyncio.gather(*list(websocket_state["tasks"]))

            try:
                with patch.object(websocket, "get_backend_project_state", return_value={"projectRoot": root}), \
                     patch.object(websocket.DatabaseSessionManager, "get_session", return_value=None), \
                     patch.object(websocket.ProjectContextLock, "resolve_authoritative_root", return_value=root), \
                     patch.object(websocket, "register_coding_request_context", return_value={"projectId": "project", "repositoryId": "repo"}), \
                     patch.object(websocket.UNIVERSAL_INDEX, "scan_and_update") as scan, \
                     patch.object(websocket, "complete_coding_model") as provider:
                    asyncio.run(send_request())

                self.assertEqual(events[-1]["type"], "error")
                self.assertEqual(events[-1]["category"], "PROVIDER_QUOTA_EXHAUSTED")
                self.assertIn("No provider request was sent", events[-1]["message"])
                self.assertEqual(events[-1]["agentTaskState"]["evidence"], prior_task["evidence"])
                self.assertEqual(events[-1]["agentTaskState"]["nextAction"], prior_task["nextAction"])
                self.assertEqual(session["agentTaskState"], prior_task)
                scan.assert_not_called()
                provider.assert_not_called()
            finally:
                websocket.CODING_TASK_STORE._sessions.pop(session_id, None)

    def test_websocket_provider_quota_failure_emits_structured_incomplete_recovery_state(self):
        with tempfile.TemporaryDirectory(prefix="coding-provider-failure-") as root:
            session_id = "provider-quota-failure-websocket-test"
            original_request = "Inspect the provider error path and preserve the investigation."
            session = websocket.CODING_TASK_STORE.get_or_create(session_id, project_root=str(Path(root).resolve()))
            events = []
            provider = SimpleNamespace(id="mock-quota-provider", type="mock", model="quota-test")

            async def send_json(event):
                events.append(event)
            websocket_state = {"pending": {}, "completed": {}, "tasks": set()}

            async def send_request():
                await websocket.handle_coding_payload(
                    json.dumps({
                        "type": "chat",
                        "requestId": "provider-quota-failure-turn",
                        "conversationId": session_id,
                        "sessionId": session_id,
                        "projectRoot": root,
                        "messages": [{"role": "user", "content": original_request}],
                    }),
                    send_json,
                    websocket_state,
                    registry=SimpleNamespace(get_active_provider=lambda: provider),
                    config_path="",
                )
                await asyncio.gather(*list(websocket_state["tasks"]))

            semantic_resolution = {
                "is_deterministic": False,
                "route_to_code": True,
                "resolved_by_model": True,
                "semanticTask": {
                    "intent": "GENERAL_REPOSITORY_TASK",
                    "goal": original_request,
                    "resourceCandidates": ["CODE", "REPOSITORY"],
                    "resolvedResources": ["CODE", "REPOSITORY"],
                },
            }
            try:
                with patch.object(websocket, "get_backend_project_state", return_value={"projectRoot": root}), \
                     patch.object(websocket.DatabaseSessionManager, "get_session", return_value=None), \
                     patch.object(websocket.ProjectContextLock, "resolve_authoritative_root", return_value=root), \
                     patch.object(websocket, "register_coding_request_context", return_value={"projectId": "project", "repositoryId": "repo"}), \
                     patch.object(websocket.UNIVERSAL_INDEX, "scan_and_update"), \
                     patch.object(websocket.ProjectContextLock, "lock"), \
                     patch.object(websocket, "_resolve_semantic_task_with_model", new=AsyncMock(return_value=semantic_resolution)), \
                     patch.object(websocket.DatabaseSessionManager, "resolve_database_intent", return_value={"is_deterministic": False}), \
                     patch.object(websocket, "complete_coding_model", side_effect=RuntimeError(
                         "429: daily token quota exhausted; resets tomorrow"
                     )) as complete_model:
                    asyncio.run(send_request())

                failure = next(event for event in events if event.get("type") == "error")
                self.assertEqual(complete_model.call_count, 1)
                self.assertEqual(failure["category"], "PROVIDER_QUOTA_EXHAUSTED")
                self.assertFalse(failure["retryable"])
                self.assertEqual(failure["providerRecovery"]["state"], "WAITING_FOR_PROVIDER")
                self.assertEqual(failure["agentTaskState"]["status"], "INCOMPLETE")
                self.assertEqual(failure["agentTaskState"]["originalRequest"], original_request)
                self.assertIsNotNone(failure["agentTaskState"]["nextAction"])
                self.assertIn("check the provider's quota", failure["message"])
            finally:
                websocket.CODING_TASK_STORE._sessions.pop(session_id, None)

    def test_confirmed_provider_recovery_reaches_mocked_model_with_saved_task_context(self):
        with tempfile.TemporaryDirectory(prefix="coding-provider-resume-") as root:
            session_id = "provider-recovery-resume-test"
            project_root = str(Path(root).resolve())
            original_request = "Inspect how provider failures affect task continuation."
            prior_task = websocket._build_semantic_task(
                request_id="turn-provider-failure",
                session_id=session_id,
                user_message=original_request,
                intent="GENERAL_REPOSITORY_TASK",
                resources=["CODE", "REPOSITORY"],
                target=None,
                project_root=project_root,
                scope=".",
                architecture={},
                required_evidence=[],
                conversation_message_count=2,
                conversation_messages=[],
            )
            prior_task.update({
                "taskId": "task-provider-resume",
                "turnId": "turn-provider-failure",
                "status": "INCOMPLETE",
                "assistantContent": "The configured provider's quota is exhausted.",
                "originalRequest": original_request,
                "userRequest": original_request,
                "facts": [{"id": "fact-confirmed", "statement": "A repository fact."}],
                "unknowns": [{"id": "unknown-open", "question": "What remains?"}],
                "evidence": [{"id": "evidence-confirmed", "content": "A confirmed observation."}],
                "actions": [{"id": "action-complete", "status": "COMPLETED"}],
                "nextAction": {"tool": "inspect_next_source", "reason": "Continue the saved investigation."},
                "providerRecovery": {
                    "state": "WAITING_FOR_PROVIDER",
                    "classification": "PROVIDER_QUOTA_EXHAUSTED",
                    "retryable": False,
                    "suggestedAction": "CHECK_PROVIDER_QUOTA_RESET",
                    "providerId": "mock-recovered-provider",
                },
            })
            session = websocket.CODING_TASK_STORE.get_or_create(session_id, project_root=project_root)
            session["agentTaskState"] = prior_task
            events = []
            provider = SimpleNamespace(id="mock-recovered-provider", type="mock", model="recovered")

            async def send_json(event):
                events.append(event)

            payload = {
                "requestId": "provider-recovery-resume-turn",
                "conversationId": session_id,
                "sessionId": session_id,
                "projectRoot": root,
                "resumeProviderTask": True,
                "messages": [
                    {"role": "user", "content": original_request},
                    {"role": "assistant", "content": prior_task["assistantContent"]},
                    {"role": "user", "content": "Continue the saved task using its original objective and confirmed evidence."},
                ],
            }
            websocket_state = {"pending": {}, "completed": {}, "tasks": set()}

            async def send_request():
                await websocket.handle_coding_payload(
                    json.dumps({"type": "chat", **payload}),
                    send_json,
                    websocket_state,
                    registry=SimpleNamespace(get_active_provider=lambda: provider),
                    config_path="",
                )
                await asyncio.gather(*list(websocket_state["tasks"]))

            semantic_resolution = {
                "is_deterministic": False,
                "route_to_code": True,
                "resolved_by_model": True,
                "semanticTask": {
                    "intent": "GENERAL_REPOSITORY_TASK",
                    "goal": original_request,
                    "resourceCandidates": ["CODE", "REPOSITORY"],
                    "resolvedResources": ["CODE", "REPOSITORY"],
                    "continuityDetected": True,
                },
            }
            try:
                with patch.object(websocket, "get_backend_project_state", return_value={"projectRoot": root}), \
                     patch.object(websocket.DatabaseSessionManager, "get_session", return_value=None), \
                     patch.object(websocket.ProjectContextLock, "resolve_authoritative_root", return_value=root), \
                     patch.object(websocket, "register_coding_request_context", return_value={"projectId": "project", "repositoryId": "repo"}), \
                     patch.object(websocket.UNIVERSAL_INDEX, "scan_and_update"), \
                     patch.object(websocket.ProjectContextLock, "lock"), \
                     patch.object(websocket, "clear_coding_provider_quota_block") as clear_quota_block, \
                     patch.object(websocket, "_resolve_semantic_task_with_model", new=AsyncMock(return_value=semantic_resolution)), \
                     patch.object(websocket.DatabaseSessionManager, "resolve_database_intent", return_value={"is_deterministic": False}), \
                     patch.object(
                         websocket,
                         "complete_coding_model",
                         return_value=(
                             {"role": "assistant", "content": "The saved task resumed using its confirmed evidence."},
                             provider,
                         ),
                     ) as complete_model:
                    asyncio.run(send_request())

                self.assertGreater(complete_model.call_count, 0)
                self.assertTrue(any(event.get("type") == "done" for event in events), events[-3:])
                final_state = session["agentTaskState"]
                self.assertEqual(final_state["originalRequest"], original_request)
                self.assertEqual(final_state["facts"][0]["id"], "fact-confirmed")
                self.assertEqual(final_state["evidence"][0]["id"], "evidence-confirmed")
                self.assertEqual(final_state["actions"][0]["id"], "action-complete")
                self.assertEqual(final_state["providerRecovery"]["state"], "RESUMED")
                clear_quota_block.assert_called_once_with("mock-recovered-provider")
            finally:
                websocket.CODING_TASK_STORE._sessions.pop(session_id, None)

    def test_sqlite_resolver_uses_explicit_target_and_rejects_ambiguity(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            self._create_database(root_path / "first.sqlite", "first_table")
            self._create_database(root_path / "selected.sqlite", "selected_table")

            result = intelligence.DatabaseIntelligenceEngine.execute_safe_query(
                root,
                "SELECT name FROM sqlite_master WHERE type = 'table'",
                {
                    "engine": "sqlite",
                    "database": "selected",
                    "sqlite_file": "selected.sqlite",
                },
            )
            self.assertTrue(result["ok"])
            self.assertEqual(
                [row["name"] for row in result["rows"]],
                ["selected_table"],
            )

            ambiguous = intelligence.DatabaseIntelligenceEngine.execute_safe_query(
                root,
                "SELECT name FROM sqlite_master WHERE type = 'table'",
                {"engine": "sqlite"},
            )
            self.assertFalse(ambiguous["ok"])
            self.assertEqual(
                ambiguous["error"]["code"],
                "DATABASE_TARGET_AMBIGUOUS",
            )

    def test_sqlite_query_explain_uses_configured_target(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            self._create_database(root_path / "first.sqlite", "first_table")
            self._create_database(root_path / "selected.sqlite", "selected_table")

            result = intelligence.DatabaseIntelligenceEngine.execute_query_and_explain(
                root,
                "SELECT * FROM selected_table",
                {"engine": "sqlite", "sqlite_file": "selected.sqlite"},
            )
            self.assertEqual(result["status"], "SUCCESS")
            self.assertTrue(result["executed"])

    def test_sql_policy_blocks_ask_and_blocked_repo_sql_before_execution(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "target.sqlite"
            self._create_database(database, "records")
            connection = sqlite3.connect(database)
            try:
                connection.execute("INSERT INTO records (id) VALUES (1)")
                connection.commit()
            finally:
                connection.close()

            for statement, expected_policy in (
                ("UPDATE records SET id = 2", "ASK"),
                ("DROP TABLE records", "BLOCK"),
            ):
                with self.subTest(policy=expected_policy):
                    result = intelligence.DatabaseIntelligenceEngine.execute_query_and_explain(
                        root,
                        statement,
                        {"engine": "sqlite", "sqlite_file": "target.sqlite"},
                    )
                    self.assertFalse(result["executed"])
                    self.assertEqual(result["executionStatus"], "BLOCKED")

            connection = sqlite3.connect(database)
            try:
                self.assertEqual(connection.execute("SELECT id FROM records").fetchone()[0], 1)
            finally:
                connection.close()

            allowed = intelligence.DatabaseIntelligenceEngine.execute_safe_query(
                root,
                "SELECT id FROM records",
                {"engine": "sqlite", "sqlite_file": "target.sqlite"},
            )
            self.assertTrue(allowed["ok"])
            self.assertTrue(allowed["executed"])

    def test_health_proof_is_bound_to_matching_database_session_and_identity(self):
        proof = intelligence.DatabaseExecutionProof(
            database_session_id="db-session-a",
            project_id="project-a",
            repository_id="repo-a",
            database_engine="sqlite",
            operation=intelligence.DatabaseCapability.DATABASE_HEALTH_CHECK,
            source=intelligence.DatabaseEvidenceSource.LIVE_DB_EXECUTION,
            mode="LIVE",
            execution_status="SUCCESS",
            query="SELECT 1",
            metadata={"targetId": "target-a"},
        )
        session = intelligence.DatabaseSession(
            project_id="project-a",
            repository_id="repo-a",
            database_type="sqlite",
            database_name="database-a",
            connection_handle=object(),
            session_id="db-session-a",
            target_id="target-a",
        )
        session.health_proof = proof
        intelligence.DatabaseEvidenceStore.record_proof(proof)

        self.assertTrue(session.binding.bind_proof(proof))
        self.assertTrue(
            intelligence.DatabaseResultValidator.validate_session_evidence(session)["valid"]
        )

        other_session = intelligence.DatabaseSession(
            project_id="project-a",
            repository_id="repo-a",
            database_type="sqlite",
            database_name="database-a",
            connection_handle=object(),
            session_id="db-session-b",
            target_id="target-a",
        )
        other_session.health_proof = proof
        self.assertFalse(other_session.binding.bind_proof(proof))
        self.assertFalse(
            intelligence.DatabaseResultValidator.validate_session_evidence(other_session)["valid"]
        )

    def test_database_session_reuse_requires_matching_identity_and_bound_proof(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "target.sqlite"
            self._create_database(database, "records")
            project_identity = Path(root).name
            proof = intelligence.DatabaseExecutionProof(
                database_session_id="bound-session",
                project_id=project_identity,
                repository_id=project_identity,
                database_engine="sqlite",
                operation=intelligence.DatabaseCapability.DATABASE_HEALTH_CHECK,
                source=intelligence.DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                mode="LIVE",
                execution_status="SUCCESS",
                query="SELECT 1",
                metadata={"targetId": "target-a"},
            )
            existing = intelligence.DatabaseSession(
                project_id=project_identity,
                repository_id=project_identity,
                database_type="sqlite",
                database_name="target",
                connection_handle=str(database),
                sqlite_file=str(database),
                session_id="bound-session",
                project_root=root,
                target_id="target-a",
            )
            existing.health_proof = proof
            config = {
                "engine": "sqlite",
                "database": "target",
                "sqlite_file": str(database),
                "target_id": "target-a",
            }
            with patch.object(intelligence.DatabaseSessionManager, "_sessions", {root: existing}), \
                    patch.object(intelligence.DatabaseSessionManager, "_sessions_by_id", {
                    "bound-session": existing,
                }), \
                    patch.object(intelligence.DatabaseSessionManager, "_active_session", existing), \
                    patch.object(intelligence.DatabaseTargetRegistry, "get_active_target", return_value=None), \
                    patch.object(
                    intelligence.DatabaseIntelligenceEngine,
                    "real_connect_and_health_check",
                ) as health_check:
                result = intelligence.DatabaseSessionManager.get_or_create_session(
                    root,
                    session_id="renderer-session",
                    db_config=config,
                )

            self.assertIs(result, existing)
            self.assertEqual(result.session_id, "bound-session")
            health_check.assert_not_called()

    def test_database_session_replacement_checks_new_target_and_preserves_on_failure(self):
        with tempfile.TemporaryDirectory() as root:
            old_database = Path(root) / "old.sqlite"
            new_database = Path(root) / "new.sqlite"
            self._create_database(old_database, "old_records")
            self._create_database(new_database, "new_records")
            project_identity = Path(root).name
            proof = intelligence.DatabaseExecutionProof(
                database_session_id="old-session",
                project_id=project_identity,
                repository_id=project_identity,
                database_engine="sqlite",
                operation=intelligence.DatabaseCapability.DATABASE_HEALTH_CHECK,
                source=intelligence.DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                mode="LIVE",
                execution_status="SUCCESS",
                query="SELECT 1",
            )
            existing = intelligence.DatabaseSession(
                project_id=project_identity,
                repository_id=project_identity,
                database_type="sqlite",
                database_name="old",
                connection_handle=str(old_database),
                sqlite_file=str(old_database),
                session_id="old-session",
                project_root=root,
            )
            existing.health_proof = proof
            config = {
                "engine": "sqlite",
                "database": "new",
                "sqlite_file": str(new_database),
            }
            with (
                patch.object(intelligence.DatabaseSessionManager, "_sessions", {root: existing}),
                patch.object(intelligence.DatabaseSessionManager, "_sessions_by_id", {
                    "old-session": existing,
                }),
                patch.object(intelligence.DatabaseSessionManager, "_active_session", existing),
                patch.object(intelligence.DatabaseTargetRegistry, "get_active_target", return_value=None),
                patch.object(
                    intelligence.DatabaseIntelligenceEngine,
                    "real_connect_and_health_check",
                    return_value={"connected": False, "state": intelligence.DatabaseState.DISCONNECTED},
                ),
                patch.object(
                    intelligence.DatabaseIntelligenceEngine,
                    "check_database_capabilities",
                    return_value={"available_paths": []},
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "existing connected session was preserved"):
                    intelligence.DatabaseSessionManager.get_or_create_session(
                        root,
                        session_id="new-session",
                        db_config=config,
                    )
                self.assertIs(intelligence.DatabaseSessionManager._sessions[root], existing)
                self.assertEqual(existing.session_id, "old-session")

    def test_database_session_capacity_preserves_active_session(self):
        with tempfile.TemporaryDirectory() as root:
            active = intelligence.DatabaseSession(
                project_id="active-project",
                repository_id="active-project",
                database_type="sqlite",
                database_name="active",
                connection_handle=object(),
                session_id="active-session",
                project_root=root,
            )
            replacement = intelligence.DatabaseSession(
                project_id="new-project",
                repository_id="new-project",
                database_type="sqlite",
                database_name="new",
                connection_handle=object(),
                session_id="new-session",
                project_root="new-project",
            )
            with patch.object(intelligence.DatabaseSessionManager, "MAX_SESSIONS", 1), \
                    patch.object(intelligence.DatabaseSessionManager, "_sessions", {root: active}), \
                    patch.object(intelligence.DatabaseSessionManager, "_sessions_by_id", {
                    active.session_id: active,
                }), \
                    patch.object(intelligence.DatabaseSessionManager, "_active_session", active):
                with self.assertRaisesRegex(RuntimeError, "active database sessions were retained"):
                    intelligence.DatabaseSessionManager.register_session(
                        "new-project",
                        replacement,
                    )
                self.assertIs(intelligence.DatabaseSessionManager._sessions[root], active)
                self.assertEqual(active.session_id, "active-session")

    def test_evidence_capacity_does_not_evict_active_session_proof(self):
        active_proof = intelligence.DatabaseExecutionProof(
            evidence_id="active-proof",
            database_session_id="active-session",
        )
        new_proof = intelligence.DatabaseExecutionProof(
            evidence_id="new-proof",
            database_session_id="active-session",
        )
        active_session = intelligence.DatabaseSession(
            project_id="active-project",
            repository_id="active-project",
            database_type="sqlite",
            database_name="active",
            connection_handle=object(),
            session_id="active-session",
        )
        with patch.object(intelligence.DatabaseEvidenceStore, "MAX_PROOFS", 1), \
                patch.object(intelligence.DatabaseEvidenceStore, "_records", {
                active_proof.evidence_id: active_proof,
            }), \
                patch.object(intelligence.DatabaseEvidenceStore, "_session_records", {
                active_session.session_id: [active_proof.evidence_id],
            }), \
                patch.object(intelligence.DatabaseSessionManager, "_sessions", {
                "active-project": active_session,
            }):
            with self.assertRaisesRegex(RuntimeError, "active-session proofs were retained"):
                intelligence.DatabaseEvidenceStore.record_proof(new_proof)
            self.assertIs(
                intelligence.DatabaseEvidenceStore.get_proof(active_proof.evidence_id),
                active_proof,
            )

    def test_credential_vault_capacity_does_not_evict_active_project(self):
        with tempfile.TemporaryDirectory() as root:
            active = intelligence.DatabaseSession(
                project_id="active-project",
                repository_id="active-project",
                database_type="sqlite",
                database_name="active",
                connection_handle=object(),
                session_id="active-session",
                project_root=root,
            )
            active_key = intelligence.os.path.abspath(root).lower()
            other_key = intelligence.os.path.abspath("other-project").lower()
            with patch.object(intelligence.ConfigurationSymbolResolver, "MAX_CREDENTIAL_PROJECTS", 1), \
                    patch.object(intelligence.ConfigurationSymbolResolver, "_credential_vault", {
                    active_key: {"username": "retained"},
                }), \
                    patch.object(intelligence.DatabaseSessionManager, "_sessions", {
                    root: active,
                }):
                with self.assertRaisesRegex(RuntimeError, "credentials for active database sessions were retained"):
                    intelligence.ConfigurationSymbolResolver.store_credential(
                        "other-project",
                        username="new-user",
                    )
                self.assertEqual(
                    intelligence.ConfigurationSymbolResolver._credential_vault[active_key]["username"],
                    "retained",
                )
                self.assertNotIn(
                    other_key,
                    intelligence.ConfigurationSymbolResolver._credential_vault,
                )

    def test_partial_repository_scan_preserves_unseen_indexed_files(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            first = root_path / "a.py"
            second = root_path / "z.py"
            first.write_text("def alpha():\n    return 1\n", encoding="utf-8")
            second.write_text("def retained_symbol():\n    return 2\n", encoding="utf-8")
            index = intelligence.IncrementalRepositoryIndex(root)
            walk_result = [(root, [], ["a.py", "z.py"])]
            with patch.object(intelligence.os, "walk", return_value=walk_result):
                index.scan_and_update(max_files=10)

            first.write_text("def alpha():\n    return 3\n", encoding="utf-8")
            with patch.object(intelligence.os, "walk", return_value=walk_result):
                index.scan_and_update(max_files=1)
            self.assertIn("z.py", index._file_hashes)
            self.assertTrue(index.search_symbols("retained_symbol"))

            second.unlink()
            with patch.object(intelligence.os, "walk", return_value=[(root, [], ["a.py"])]):
                index.scan_and_update(max_files=10)
            self.assertNotIn("z.py", index._file_hashes)

    def test_query_statistics_are_scoped_per_project_and_bounded(self):
        sql = "SELECT id FROM records WHERE id = 1"
        fingerprint = intelligence.DatabaseQueryFingerprinter.compute_fingerprint(sql)
        intelligence.DatabasePerformanceEngine.record_query_execution(
            sql, 2.0, 1, target_id="same-target", project_root="C:/project-a",
            project_id="project-a", repository_id="repo-a",
        )
        intelligence.DatabasePerformanceEngine.record_query_execution(
            sql, 9.0, 1, target_id="same-target", project_root="C:/project-b",
            project_id="project-b", repository_id="repo-b",
        )

        project_a = intelligence.DatabasePerformanceEngine.get_query_stat(
            fingerprint, project_root="C:/project-a", target_id="same-target"
        )
        project_b = intelligence.DatabasePerformanceEngine.get_query_stat(
            fingerprint, project_root="C:/project-b", target_id="same-target"
        )
        self.assertEqual(project_a["executionCount"], 1)
        self.assertEqual(project_a["averageTimeMs"], 2.0)
        self.assertEqual(project_b["executionCount"], 1)
        self.assertEqual(project_b["averageTimeMs"], 9.0)

    def test_capability_resolution_is_exact_and_references_are_not_fabricated(self):
        self.assertIsNone(intelligence.CapabilityIntelligenceEngine.resolve_capability("delete_file"))
        self.assertIsNone(intelligence.CapabilityIntelligenceEngine.resolve_capability("sh"))
        self.assertEqual(
            intelligence.CapabilityIntelligenceEngine.resolve_capability("ls"),
            intelligence.CanonicalCapability.DIRECTORY_LIST,
        )

        graph = intelligence.LazyCodeGraph(
            intelligence.IncrementalRepositoryIndex()
        ).expand_symbol_references("missing_symbol")
        self.assertIsNone(graph["referencesCount"])
        self.assertFalse(graph["referencesVerified"])
        self.assertEqual(graph["status"], "UNAVAILABLE")

    def test_windows_verification_command_keeps_backslashes_and_blocks_chaining(self):
        module_os_name = intelligence.os.name
        try:
            intelligence.os.name = "nt"
            decision, _ = intelligence.PolicyGate.evaluate_command(
                r"node.exe tests\run.js",
                approved_scripts={"tests/run.js"},
            )
            self.assertEqual(decision, "ALLOW")
            blocked, _ = intelligence.PolicyGate.evaluate_command(
                r"node.exe tests\run.js & whoami",
                approved_scripts={"tests/run.js"},
            )
            self.assertEqual(blocked, "BLOCK")
        finally:
            intelligence.os.name = module_os_name

    def test_missing_sql_is_rejected_and_prompt_guard_is_not_claimed_as_enforced(self):
        result = intelligence.DatabaseIntelligenceEngine.execute_safe_query(".", "")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "SQL_REQUIRED")
        self.assertEqual(intelligence.PromptInjectionGuard.SANITIZATION_STATUS, "UNAVAILABLE")
        self.assertEqual(
            intelligence.PromptInjectionGuard.sanitize_untrusted_text("sample"),
            "sample",
        )

    def test_renderer_tool_results_are_redacted_before_model_context_serialization(self):
        serialized = websocket._serialize_coding_tool_result({
            "ok": True,
            "data": {"DB_PASSWORD": "root", "content": "non-secret source"},
        })
        self.assertNotIn("root", serialized)
        self.assertIn("[REDACTED]", serialized)
        self.assertIn("non-secret source", serialized)


class CodingWebSocketTimeoutRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_wait_for_tool_timeout_has_explicit_error(self):
        state = {"completed": {}, "pending": {}}
        with patch.object(websocket, "CODING_TOOL_WAIT_TIMEOUT_SECONDS", 0.001):
            with self.assertRaisesRegex(
                TimeoutError,
                "Timed out waiting for the renderer",
            ):
                await websocket._wait_for_tool(state, "request", "tool")

    async def test_request_cancellation_wait_is_bounded_by_runtime_configuration(self):
        self.assertEqual(websocket.CODING_CANCELLATION_TIMEOUT_SECONDS, 5)
        cancellation_seen = asyncio.Event()
        hold_task = asyncio.Event()

        async def cancellation_resistant_task():
            try:
                await hold_task.wait()
            except asyncio.CancelledError:
                cancellation_seen.set()
                await hold_task.wait()

        task = asyncio.create_task(cancellation_resistant_task())
        await asyncio.sleep(0)
        events = []

        async def send_json(event):
            events.append(event)

        state = {
            "completed": {},
            "pending": {},
            "tasks_by_request": {"request": task},
            "cancelled_request_ids": [],
        }
        try:
            with patch.object(websocket, "CODING_CANCELLATION_TIMEOUT_SECONDS", 0.001):
                await websocket.handle_coding_payload(
                    '{"type":"cancel","requestId":"request"}',
                    send_json,
                    state,
                    registry=None,
                    config_path=None,
                )
            self.assertTrue(cancellation_seen.is_set())
            self.assertEqual(events[0]["status"], "CANCELLED")
            self.assertTrue(events[0]["cleanupTimedOut"])
        finally:
            hold_task.set()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_connection_rejects_chat_when_active_task_limit_is_reached(self):
        state = {
            "pending": {},
            "completed": {},
            "tasks": {object()},
            "authenticated": True,
        }
        events = []

        async def send_json(event):
            events.append(event)

        with patch.object(websocket, "MAX_CONCURRENT_CODING_TASKS", 1):
            await websocket.handle_coding_payload(
                '{"type":"chat","requestId":"request","messages":[{"role":"user","content":"hello"}]}',
                send_json,
                state,
                registry=None,
                config_path=None,
            )

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "error")
        self.assertEqual(len(state["tasks"]), 1)


if __name__ == "__main__":
    unittest.main()
