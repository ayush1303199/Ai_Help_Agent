import asyncio
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SERVER_SRC = Path(__file__).resolve().parents[1] / "server" / "src"
sys.path.insert(0, str(SERVER_SRC))

import coding_intelligence as intelligence  # noqa: E402
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
