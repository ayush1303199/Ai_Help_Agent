"""
Unit test suite for coding_intelligence.py:
Tests SecretProtector, IncrementalRepositoryIndex, LazyCodeGraph,
AdaptiveSearchRouter, CodingMemorySystem, DatabaseIntelligenceEngine,
PolicyGate, SelfDebugController, and EvidenceEventStream.
"""

import os
import sys
import tempfile
import time
from pathlib import Path

# Add server/src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "server" / "src"))

from coding_intelligence import (
    ConfigurationSymbolResolver,
    SecretProtector,
    IncrementalRepositoryIndex,
    LazyCodeGraph,
    AdaptiveSearchRouter,
    CodingMemorySystem,
    MemoryStatus,
    DatabaseIntelligenceEngine,
    DbFailureClassification,
    DatabaseCapabilityPath,
    PolicyGate,
    SelfDebugController,
    FailureClassification,
    EvidenceEventStream,
)


def test_secret_protector():
    print("[TEST] SecretProtector: Redacting API keys, passwords, and tokens...")
    text_with_secrets = (
        "Here is an API key: sk-ant-api03-abcdef1234567890abcdef1234567890 and "
        "another OpenAI key: sk-abcdef1234567890abcdef1234567890. "
        "Database url is mysql://root:super_secret_password@localhost:3306/prod_db. "
        "Bearer token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMC6Y53iMTGeWJaBgGVY5Q. "
        "Normal code: function calculateTotal(items) { return items.length; }"
    )
    redacted = SecretProtector.redact_text(text_with_secrets)
    assert "[REDACTED]" in redacted
    assert "super_secret_password" not in redacted
    assert "calculateTotal" in redacted

    data = {
        "user": "admin",
        "api_token": "sk-1234567890abcdef1234567890abcdef12",
        "nested": {"db_pass": "my_db_password", "normal": "safe_value"},
        "items": ["token: ghp_1234567890abcdef1234567890abcdef123456", "regular item"],
    }
    redacted_data = SecretProtector.redact_data(data)
    assert "my_db_password" not in str(redacted_data)
    assert "safe_value" in str(redacted_data)
    print("  -> PASSED: SecretProtector safely redacts credentials and secrets.")


def test_incremental_repository_index_and_graph():
    print("[TEST] IncrementalRepositoryIndex & LazyCodeGraph...")
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        # Create a sample PHP file and TypeScript file
        php_file = tmp_path / "UserController.php"
        php_file.write_text(
            """<?php
class UserController {
    public function actionIndex() {
        $users = User::find()->all();
        $orders = Yii::$app->db->createCommand("SELECT * FROM orders WHERE status = 'Active'")->queryAll();
        return $this->render('index', ['users' => $users]);
    }

    public function actionProfile() {
        return $this->render('profile');
    }
}
""",
            encoding="utf-8",
        )

        ts_file = tmp_path / "server.ts"
        ts_file.write_text(
            """
import express from 'express';
const app = express();

app.get('/api/users', (req, res) => {
    res.json({ users: [] });
});

export class OrderService {
    async getOrders() {
        return [];
    }
}
""",
            encoding="utf-8",
        )

        index = IncrementalRepositoryIndex()
        res = index.scan_and_update(str(tmp_path))
        assert res["added"] == 2
        assert res["updated"] == 0

        # Symbol searches
        user_syms = index.search_symbols("UserController")
        assert len(user_syms) >= 1
        assert user_syms[0]["name"] == "UserController"
        assert user_syms[0]["kind"] == "class"

        order_syms = index.search_symbols("OrderService")
        assert len(order_syms) >= 1
        assert order_syms[0]["name"] == "OrderService"

        # Routes
        routes = index.get_routes()
        assert len(routes) >= 1
        assert routes[0]["method"] == "GET"
        assert routes[0]["route"] == "/api/users"

        # DB references
        dbs = index.get_db_references()
        assert any(d["table"].lower() == "orders" for d in dbs)

        # Code graph
        graph = LazyCodeGraph(index)
        refs = graph.get_symbol_references("UserController")
        assert refs["referencesCount"] >= 1

        # Test incremental scan
        res_unchanged = index.scan_and_update(str(tmp_path))
        assert res_unchanged["unchanged"] == 2
        assert res_unchanged["added"] == 0

    print("  -> PASSED: IncrementalRepositoryIndex and LazyCodeGraph successfully indexed and resolved symbols.")


def test_adaptive_search_router():
    print("[TEST] AdaptiveSearchRouter: Expanding concepts and ranking candidates...")
    router = AdaptiveSearchRouter()
    queries = router.expand_query("performance", "Which query is taking time in the database?")
    assert len(queries) >= 3
    assert any("query" in q or "slow" in q or "explain" in q for q in queries)

    files = [
        "README.md",
        "controllers/SearchApiController.php",
        "models/SearchLog.php",
        "views/site/about.php",
        "tests/unit/SearchTest.php",
    ]
    ranked = router.rank_search_candidates("slow search query", files)
    assert len(ranked) > 0
    # SearchApiController or SearchLog should be ranked high
    top_candidates = [c[0] for c in ranked[:3]]
    assert any("SearchApiController" in c or "SearchLog" in c for c in top_candidates)
    print("  -> PASSED: AdaptiveSearchRouter expanded concepts and ranked candidates effectively.")


def test_coding_memory_system():
    print("[TEST] CodingMemorySystem: 4-Tier Memory & Fact Superseding...")
    memory = CodingMemorySystem()
    f1 = memory.record_repository_fact("framework", "Yii2", source="composer.json")
    assert f1["status"] == MemoryStatus.VALID

    # Update fact with new discovery - old fact should be superseded
    f2 = memory.record_repository_fact("framework", "Yii2-Advanced", source="architecture_scan")
    assert f2["status"] == MemoryStatus.VALID

    valid_facts = memory.get_valid_repository_facts()
    assert len(valid_facts) == 1
    assert valid_facts[0]["value"] == "Yii2-Advanced"

    # Task Hypotheses & Failed Attempts
    memory.record_task_hypothesis("task-1", "Hypothesis: missing index on status column")
    memory.record_failed_attempt("task-1", "read_file", "File does not exist: NonExistent.php")
    assert len(memory.task_memory["task-1"]) == 2
    assert memory.task_memory["task-1"][1]["status"] == MemoryStatus.CONTRADICTED
    print("  -> PASSED: CodingMemorySystem maintained valid/superseded facts and hypotheses.")


def test_database_intelligence_and_policy_gate():
    print("[TEST] DatabaseIntelligenceEngine & Executable PolicyGate...")
    # Safe diagnostic queries
    safe_queries = [
        "SELECT id, question, answer FROM faq WHERE status = 'Active'",
        "EXPLAIN SELECT * FROM orders WHERE customer_id = 12",
        "EXPLAIN ANALYZE SELECT * FROM users",
        "SHOW TABLES",
        "SHOW CREATE TABLE faq",
        "SHOW INDEXES FROM candidate",
        "DESCRIBE portal_logs",
    ]
    for sq in safe_queries:
        ok, msg = DatabaseIntelligenceEngine.sanitize_and_validate_sql(sq)
        assert ok, f"Expected safe for '{sq}', got {msg}"

    # Destructive SQL queries - must be blocked
    destructive_queries = [
        "DROP TABLE users;",
        "DROP DATABASE production;",
        "TRUNCATE TABLE audit_log;",
        "DELETE FROM sessions WHERE id = 1;",
        "ALTER TABLE users DROP COLUMN password_hash;",
    ]
    for dq in destructive_queries:
        ok, msg = DatabaseIntelligenceEngine.sanitize_and_validate_sql(dq)
        assert not ok, f"Expected blocked for '{dq}', but was permitted"
        assert "DESTRUCTIVE_SQL_BLOCKED" in msg or "UNAUTHORIZED_SQL" in msg

    # PolicyGate command checks
    blocked_commands = [
        "rm -rf /",
        "rm -f -r node_modules",
        "git reset --hard HEAD~1",
        "git push origin main --force",
        "git push -f",
        "del /s /q C:\\*",
        "rmdir /s /q build",
        "cat .env",
    ]
    for cmd in blocked_commands:
        decision, reason = PolicyGate.evaluate_command(cmd)
        assert decision == "BLOCK", f"Expected BLOCK for '{cmd}', got {decision} ({reason})"

    # PolicyGate file write without proposal approval
    decision, reason = PolicyGate.evaluate_file_write("controllers/SearchController.php", proposal_approved=False)
    assert decision == "BLOCK"

    decision, reason = PolicyGate.evaluate_file_write("controllers/SearchController.php", proposal_approved=True)
    assert decision == "ALLOW"

    # Writing to .env must be blocked even if approved
    decision, reason = PolicyGate.evaluate_file_write(".env", proposal_approved=True)
    assert decision == "BLOCK"
    print("  -> PASSED: DatabaseIntelligenceEngine and PolicyGate strictly enforced non-destructive safety.")


def test_self_debug_controller_and_event_stream():
    print("[TEST] SelfDebugController & EvidenceEventStream...")
    controller = SelfDebugController("task-123")
    assert controller.can_recover()

    controller.record_attempt("run_test", FailureClassification.TEST, "Expected 200, got 500")
    assert controller.iteration == 1
    assert not controller.has_repeated_failure("run_test")

    controller.record_attempt("run_test", FailureClassification.TEST, "Still got 500")
    assert controller.has_repeated_failure("run_test")

    # EvidenceEventStream
    stream = EvidenceEventStream()
    stream.emit("TASK_CREATED", {"taskId": "task-123", "intent": "BUG_INVESTIGATION"})
    stream.emit("FILE_READ", {"path": "src/index.ts"})
    stream.emit("TEST_EXECUTED", {"command": "npm test", "exitCode": 0})
    stream.emit("TASK_COMPLETED", {"taskId": "task-123"})

    events = stream.get_events()
    assert len(events) == 4
    assert [e["event"] for e in events] == ["TASK_CREATED", "FILE_READ", "TEST_EXECUTED", "TASK_COMPLETED"]
    print("  -> PASSED: SelfDebugController tracked iterations and EvidenceEventStream recorded audit log.")


def test_database_autonomous_execution_contract():
    print("[TEST] Database Autonomous Execution Contract: Discovery, Capability Paths, Classification, Performance Report...")
    # 1. Discover database configuration from project files
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        config_dir = tmp_path / "config"
        config_dir.mkdir(parents=True)
        db_file = config_dir / "db.php"
        db_file.write_text("""<?php
return [
    'class' => 'yii\\db\\Connection',
    'dsn' => 'mysql:host=db.internal.net;port=3306;dbname=production_portal',
    'username' => 'portal_app_user',
    'password' => 'super_secret_production_password_xyz',
    'charset' => 'utf8mb4',
];
""", encoding="utf-8")

        db_info = DatabaseIntelligenceEngine.discover_database_configuration(str(tmp_path), arch={"frameworks": ["Yii2"]})
        assert db_info["discovered"] is True
        assert db_info["engine"] == "mysql"
        assert db_info["host"] == "db.internal.net"
        assert db_info["port"] == 3306
        assert db_info["database"] == "production_portal"
        assert db_info["username"] == "portal_app_user"
        assert db_info["existing_utility"] == "Yii::$app->db"
        assert db_info["driver"] == "yii\\db\\Connection"
        assert "super_secret_production_password_xyz" not in str(db_info)

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        (tmp_path / "requirements.php").write_text(
            "<?php\n"
            "// Database requirements for PDO extensions.\n"
            "$requirements = ['name' => 'PDO MySQL extension'];\n",
            encoding="utf-8",
        )

        requested_missing = ConfigurationSymbolResolver.inspect_project_database_configuration(
            str(tmp_path), specific_file="config.php"
        )
        assert requested_missing["status"] == "NOT_FOUND"
        assert requested_missing["configFile"] == "config.php"
        missing_report = ConfigurationSymbolResolver.format_connection_status_report(
            requested_missing, include_file_preview=True
        )
        assert "requested file config.php was not found" in missing_report.lower()
        assert "requirements.php" not in missing_report

        discovered = ConfigurationSymbolResolver.inspect_project_database_configuration(str(tmp_path))
        assert discovered["status"] == "NOT_FOUND"

        unrelated_file = ConfigurationSymbolResolver.inspect_project_database_configuration(
            str(tmp_path), specific_file="requirements.php"
        )
        assert unrelated_file["status"] == "NOT_CONFIGURED"
        assert unrelated_file["activeComponent"] == "Unknown"
        unrelated_report = ConfigurationSymbolResolver.format_connection_status_report(
            unrelated_file, include_file_preview=True
        )
        assert "does not contain database connection settings" in unrelated_report
        assert "- **Status:** NOT_CONFIGURED" in unrelated_report
        assert "INSPECTED CONFIGURATION FILE" not in unrelated_report
        assert "$requirements" not in unrelated_report

    # 2. Check all 8 capability paths
    caps = DatabaseIntelligenceEngine.check_database_capabilities(
        project_root=str(Path(__file__).parent.parent),
        available_tools=["run_verification", "read_file", "search_code"]
    )
    assert caps["any_available"] is True
    assert DatabaseCapabilityPath.DIAGNOSTIC_ENDPOINT in caps["available_paths"]
    assert DatabaseCapabilityPath.APPLICATION_RUNTIME in caps["available_paths"]
    assert DatabaseCapabilityPath.ORM_CONNECTION in caps["available_paths"]
    assert len(caps["paths_status"]) == 8

    # 3. Classify all 11 failure types
    assert DatabaseIntelligenceEngine.classify_db_error("Query timed out after 30s") == DbFailureClassification.DB_TIMEOUT
    assert DatabaseIntelligenceEngine.classify_db_error("Access denied for user 'root'@'localhost'") == DbFailureClassification.DB_AUTHENTICATION_FAILED
    assert DatabaseIntelligenceEngine.classify_db_error("Permission denied to access schema public") == DbFailureClassification.DB_PERMISSION_DENIED
    assert DatabaseIntelligenceEngine.classify_db_error("Connection refused connect ECONNREFUSED 127.0.0.1:3306") == DbFailureClassification.DB_CONNECTION_FAILED
    assert DatabaseIntelligenceEngine.classify_db_error("Network unreachable getaddrinfo failed") == DbFailureClassification.DB_NETWORK_FAILED
    assert DatabaseIntelligenceEngine.classify_db_error("Table 'orders' doesn't exist") == DbFailureClassification.DB_SCHEMA_ACCESS_FAILED
    assert DatabaseIntelligenceEngine.classify_db_error("Database password required or missing credentials") == DbFailureClassification.DB_CREDENTIALS_UNAVAILABLE
    assert DatabaseIntelligenceEngine.classify_db_error("PDO driver not found in runtime") == DbFailureClassification.DB_CLIENT_UNAVAILABLE
    assert DatabaseIntelligenceEngine.classify_db_error("Tool unknown or unsupported tool") == DbFailureClassification.DB_TOOL_UNAVAILABLE
    assert DatabaseIntelligenceEngine.classify_db_error("Database configuration missing or not found") == DbFailureClassification.DB_CONFIG_NOT_FOUND
    assert DatabaseIntelligenceEngine.classify_db_error("SQL syntax error near SELECT") == DbFailureClassification.DB_QUERY_FAILED

    # 4. Safe health check query: no live execution, so it must remain unverified
    health = DatabaseIntelligenceEngine.bootstrap_safe_health_check(db_info)
    assert health["healthQuery"] == "SELECT 1"
    assert health["status"] == "NOT_VERIFIED"
    assert health["timing_ms"] is None

    # 5. Format performance contract report (11 fields, confidence contract)
    # Static code inspection: CODE-LEVEL
    report_static = DatabaseIntelligenceEngine.format_performance_contract_report(
        query="SELECT * FROM candidate_activity WHERE status = 'Active'",
        file_symbol="CandidateActivityController::actionIndex",
        database="portal_db",
        actual_timing=None,
        explain_plan=None,
    )
    assert report_static["confidence"] == "CODE-LEVEL"
    assert "- **QUERY:**" in report_static["markdown"]
    assert "- **FILE / SYMBOL:**" in report_static["markdown"]
    assert "- **DATABASE:**" in report_static["markdown"]
    assert "- **ACTUAL TIMING:**" in report_static["markdown"]
    assert "- **ROWS EXAMINED:**" in report_static["markdown"]
    assert "- **ROWS RETURNED:**" in report_static["markdown"]
    assert "- **INDEX USED:**" in report_static["markdown"]
    assert "- **ACCESS TYPE:**" in report_static["markdown"]
    assert "- **EXPLAIN:**" in report_static["markdown"]
    assert "- **BOTTLENECK:**" in report_static["markdown"]
    assert "- **CONFIDENCE:** CODE-LEVEL" in report_static["markdown"]

    # Measured execution: MEASURED (never CODE-LEVEL after actual DB measurement!)
    report_measured = DatabaseIntelligenceEngine.format_performance_contract_report(
        query="SELECT * FROM orders WHERE user_id = 45",
        file_symbol="OrderService::getUserOrders",
        database="shop_db",
        actual_timing="142.5ms",
        rows_examined=15000,
        rows_returned=3,
        index_used="PRIMARY",
        access_type="range",
        explain_plan="id: 1, select_type: SIMPLE, table: orders, type: range, rows: 15000",
        bottleneck="Range scan over 15000 records",
    )
    assert report_measured["confidence"] == "MEASURED"
    assert report_measured["actualTiming"] == "142.5ms"
    assert report_measured["rowsExamined"] == 15000
    assert "- **CONFIDENCE:** MEASURED" in report_measured["markdown"]

    # Unverified: UNVERIFIED
    report_unverified = DatabaseIntelligenceEngine.format_performance_contract_report(
        query="",
        confidence="UNVERIFIED",
    )
    assert report_unverified["confidence"] == "UNVERIFIED"

    print("  -> PASSED: Database Autonomous Execution Contract strictly validated across all 5 verification axes.")


if __name__ == "__main__":
    print("======================================================================")
    print("CODING INTELLIGENCE ENGINE — COMPREHENSIVE UNIT TEST SUITE")
    print("======================================================================")
    test_secret_protector()
    test_incremental_repository_index_and_graph()
    test_adaptive_search_router()
    test_coding_memory_system()
    test_database_intelligence_and_policy_gate()
    test_self_debug_controller_and_event_stream()
    test_database_autonomous_execution_contract()
    print("======================================================================")
    print("ALL 7 CODING INTELLIGENCE UNIT TESTS PASSED (100% SUCCESS)!")
    print("======================================================================")
