/**
 * Generic Coding Skills System for Omni Coding Agent.
 * Reusable software-engineering skills with playbooks, preconditions,
 * information-gain capability requirements, and postconditions.
 * Zero-hardcoding, project-agnostic.
 */

const CODING_SKILLS = Object.freeze({
  bug_investigation: {
    id: 'bug_investigation',
    name: 'Bug Investigation & Root Cause Isolation',
    category: 'diagnostic',
    description: 'Systematic root cause isolation, error reproduction, stack trace tracing, and minimal patch point identification.',
    requiredCapabilities: ['code.search', 'symbol.references', 'filesystem.read', 'execution.verification'],
    preconditions: ['reproduction_context_or_stack_trace_available'],
    postconditions: ['root_cause_identified', 'failing_test_or_minimal_repro_defined', 'candidate_patch_points_located'],
    playbookSteps: [
      { step: 1, action: 'reproduce_or_isolate_error', purpose: 'Capture exact error output, stack trace, and failing condition' },
      { step: 2, action: 'trace_symbol_references', purpose: 'Trace data flow and call stack backward from error point' },
      { step: 3, action: 'inspect_source_boundaries', purpose: 'Read relevant source modules to locate precondition violations' },
      { step: 4, action: 'synthesize_root_cause', purpose: 'Formulate minimal causal hypothesis and verify absence of contradictions' },
      { step: 5, action: 'identify_minimal_patch', purpose: 'Isolate minimal localized edit point preserving overall architecture' },
    ],
  },
  performance_analysis: {
    id: 'performance_analysis',
    name: 'Performance & Latency Optimization',
    category: 'optimization',
    description: 'Detect latency bottlenecks, memory leaks, algorithmic complexity hotspots, unneeded re-renders, and I/O overhead.',
    requiredCapabilities: ['code.search', 'filesystem.read', 'execution.verification'],
    preconditions: ['performance_target_or_slow_path_identified'],
    postconditions: ['bottleneck_located', 'complexity_quantified', 'optimization_proposal_formulated'],
    playbookSteps: [
      { step: 1, action: 'profile_slow_path', purpose: 'Inspect execution time, loops, database calls, or bundle size metrics' },
      { step: 2, action: 'analyze_computational_complexity', purpose: 'Identify algorithmic hotspots (O(n^2), redundant transformations)' },
      { step: 3, action: 'audit_io_and_caching', purpose: 'Examine disk, network, and memory usage for caching opportunities' },
      { step: 4, action: 'prepare_low_overhead_patch', purpose: 'Formulate optimized implementation without breaking contracts' },
      { step: 5, action: 'benchmark_comparison', purpose: 'Verify latency or resource reduction against baseline' },
    ],
  },
  api_debugging: {
    id: 'api_debugging',
    name: 'API & Protocol Debugging',
    category: 'diagnostic',
    description: 'Validate request/response schemas, header parsing, payload validation, status codes, route matching, and error handling.',
    requiredCapabilities: ['code.search', 'filesystem.read', 'runtime.devserver'],
    preconditions: ['api_route_or_endpoint_identified'],
    postconditions: ['schema_mismatch_or_routing_defect_identified', 'spec_compliant_fix_designed'],
    playbookSteps: [
      { step: 1, action: 'inspect_route_definition', purpose: 'Locate endpoint handler, middleware chain, and parameter parsing' },
      { step: 2, action: 'validate_payload_schema', purpose: 'Compare request/response contracts against actual serialization' },
      { step: 3, action: 'trace_error_status_codes', purpose: 'Inspect error handling, catch blocks, and status code propagation' },
      { step: 4, action: 'verify_endpoint_contracts', purpose: 'Test with edge-case payloads, empty bodies, and invalid types' },
    ],
  },
  db_debugging: {
    id: 'db_debugging',
    name: 'Database & Migration Debugging',
    category: 'data',
    description: 'Schema migration inspection, query efficiency, ORM mapping consistency, index utilization, and transaction boundaries.',
    requiredCapabilities: ['code.search', 'filesystem.read'],
    preconditions: ['model_or_migration_context_available'],
    postconditions: ['data_integrity_verified', 'query_or_schema_issue_resolved'],
    playbookSteps: [
      { step: 1, action: 'inspect_schema_definitions', purpose: 'Review table definitions, foreign keys, and migration history' },
      { step: 2, action: 'trace_model_queries', purpose: 'Examine ORM queries, N+1 issues, and transaction isolation' },
      { step: 3, action: 'validate_migration_idempotence', purpose: 'Ensure migrations can roll back and apply cleanly' },
      { step: 4, action: 'verify_query_safety', purpose: 'Check parameterized query usage and SQL injection prevention' },
    ],
  },
  security_review: {
    id: 'security_review',
    name: 'Security Review & Vulnerability Remediation',
    category: 'security',
    description: 'Vulnerability audit for injection flaws, path traversal, secret exposure, authorization bypass, and unvalidated input.',
    requiredCapabilities: ['code.search', 'filesystem.read', 'execution.verification'],
    preconditions: ['codebase_or_target_module_available'],
    postconditions: ['vulnerabilities_classified', 'security_remediation_designed', 'zero_secret_leakage_guaranteed'],
    playbookSteps: [
      { step: 1, action: 'scan_input_sanitization', purpose: 'Check all external input vectors for SQLi, XSS, SSRF, command injection' },
      { step: 2, action: 'audit_path_traversal', purpose: 'Ensure file access checks boundaries and rejects path traversal sequences' },
      { step: 3, action: 'inspect_secret_handling', purpose: 'Verify secrets are not hardcoded or leaked into client bundles or logs' },
      { step: 4, action: 'verify_auth_boundaries', purpose: 'Check role-based access control and token validation' },
      { step: 5, action: 'enforce_defense_in_depth', purpose: 'Propose sanitization, allow-listing, and hardened defaults' },
    ],
  },
  ui_verification: {
    id: 'ui_verification',
    name: 'UI & Browser Visual Verification',
    category: 'frontend',
    description: 'Verify element visibility, state transitions, layout regressions, accessibility labels, and console error capture.',
    requiredCapabilities: ['runtime.browser', 'runtime.devserver', 'filesystem.read'],
    preconditions: ['dev_server_or_html_bundle_available'],
    postconditions: ['dom_evidence_recorded', 'no_unhandled_console_errors', 'visual_contract_satisfied'],
    playbookSteps: [
      { step: 1, action: 'probe_dev_server', purpose: 'Ensure local server is running and endpoint responds with 200' },
      { step: 2, action: 'navigate_and_capture_state', purpose: 'Load target route, inspect DOM elements and layout' },
      { step: 3, action: 'audit_console_and_network', purpose: 'Verify zero runtime errors, broken assets, or 404/500 responses' },
      { step: 4, action: 'verify_interactive_flows', purpose: 'Test user interaction states (clicks, inputs, modals)' },
      { step: 5, action: 'record_browser_evidence', purpose: 'Persist verification evidence with status code and DOM metrics' },
    ],
  },
  migration: {
    id: 'migration',
    name: 'Framework & API Migration',
    category: 'refactoring',
    description: 'Framework/library version upgrades, deprecated API substitution, codemod application, and breaking change mitigation.',
    requiredCapabilities: ['filesystem.read', 'code.search', 'execution.verification'],
    preconditions: ['target_upgrade_version_or_deprecated_pattern_identified'],
    postconditions: ['all_deprecated_usages_replaced', 'typecheck_and_tests_pass'],
    playbookSteps: [
      { step: 1, action: 'catalog_deprecated_usages', purpose: 'Search codebase for all call sites of legacy API or library' },
      { step: 2, action: 'map_migration_signatures', purpose: 'Establish replacement mapping between old and new API contracts' },
      { step: 3, action: 'apply_staged_substitutions', purpose: 'Update modules incrementally with intermediate verification' },
      { step: 4, action: 'update_project_manifests', purpose: 'Synchronize package.json / requirements / configuration' },
      { step: 5, action: 'run_regression_battery', purpose: 'Verify full suite of tests, linter, and typechecker' },
    ],
  },
  refactoring: {
    id: 'refactoring',
    name: 'Safe Behavior-Preserving Refactoring',
    category: 'refactoring',
    description: 'Structural code reorganization, dead code elimination, modular decomposition while strictly preserving external behavior.',
    requiredCapabilities: ['filesystem.read', 'symbol.references', 'code.search', 'execution.verification'],
    preconditions: ['test_coverage_or_baseline_snapshot_available'],
    postconditions: ['code_structure_improved', 'all_existing_tests_pass', 'no_behavioral_regression'],
    playbookSteps: [
      { step: 1, action: 'capture_baseline_snapshot', purpose: 'Record pre-refactor state, tests, and public interface signatures' },
      { step: 2, action: 'isolate_refactoring_scope', purpose: 'Identify targets, extract duplicate logic, decompose monolithic functions' },
      { step: 3, action: 'apply_incremental_edits', purpose: 'Apply small, verified edits preserving existing symbol contracts' },
      { step: 4, action: 'verify_public_api_invariants', purpose: 'Confirm no external callers break' },
      { step: 5, action: 'run_comprehensive_verification', purpose: 'Execute unit and integration tests to confirm behavior parity' },
    ],
  },
  test_repair: {
    id: 'test_repair',
    name: 'Test Failure Repair & Flakiness Fix',
    category: 'testing',
    description: 'Identify failing assertions, distinguish test defects from code defects, repair mocks/fixtures, and verify test passes.',
    requiredCapabilities: ['execution.verification', 'filesystem.read', 'code.search'],
    preconditions: ['failing_test_name_or_suite_identified'],
    postconditions: ['test_passes_deterministically', 'fixtures_and_mocks_accurate'],
    playbookSteps: [
      { step: 1, action: 'execute_focused_test', purpose: 'Run failing test isolatedly and parse assertion failure' },
      { step: 2, action: 'classify_defect_nature', purpose: 'Determine if code broke, test assertion is outdated, or fixture is invalid' },
      { step: 3, action: 'repair_test_or_code', purpose: 'Apply minimal fix targeting root cause of discrepancy' },
      { step: 4, action: 'verify_determinism', purpose: 'Run test repeatedly to ensure zero flakiness' },
      { step: 5, action: 'verify_suite_health', purpose: 'Confirm neighboring tests continue to pass' },
    ],
  },
  dependency_upgrade: {
    id: 'dependency_upgrade',
    name: 'Dependency Upgrade & Compatibility Repair',
    category: 'maintenance',
    description: 'Audit dependency graph, check breaking changes, upgrade version constraints, resolve lockfile conflicts, and verify test battery.',
    requiredCapabilities: ['filesystem.read', 'execution.verification'],
    preconditions: ['dependency_manifest_available'],
    postconditions: ['dependency_updated', 'lockfile_consistent', 'build_and_tests_pass'],
    playbookSteps: [
      { step: 1, action: 'audit_dependency_manifest', purpose: 'Read package.json / requirements.txt / pom.xml to inspect version constraints' },
      { step: 2, action: 'check_breaking_changes', purpose: 'Analyze changelogs and API differences for target version' },
      { step: 3, action: 'update_version_specifiers', purpose: 'Safely update manifest and lockfiles' },
      { step: 4, action: 'resolve_peer_conflicts', purpose: 'Verify peer dependency compatibility' },
      { step: 5, action: 'execute_full_verification', purpose: 'Run build, typecheck, and test battery' },
    ],
  },
});

class SkillSystem {
  constructor() {
    this._skills = new Map();
    for (const [id, def] of Object.entries(CODING_SKILLS)) {
      this._skills.set(id, { ...def });
    }
  }

  registerSkill(skillDef) {
    if (!skillDef || !skillDef.id || !skillDef.name) {
      throw new Error('Skill definition must have id and name');
    }
    this._skills.set(skillDef.id, { ...skillDef });
  }

  getSkill(skillId) {
    return this._skills.get(skillId) || null;
  }

  listSkills() {
    return Array.from(this._skills.values());
  }

  selectBestSkill({ goal = '', intent = '', context = {} }) {
    const text = `${goal} ${intent} ${context.summary || ''}`.toLowerCase();
    let bestSkill = null;
    let highestScore = -1;

    for (const skill of this._skills.values()) {
      let score = 0;

      // Intent matches
      if (intent && skill.id.toLowerCase().includes(intent.toLowerCase().replace(/_/g, ''))) {
        score += 40;
      }

      // Keyword matching
      const keywords = {
        bug_investigation: ['bug', 'fix', 'error', 'exception', 'fail', 'crash', 'issue', 'defect', 'broken'],
        performance_analysis: ['performance', 'slow', 'latency', 'optimize', 'memory', 'cpu', 'leak', 'benchmark'],
        api_debugging: ['api', 'endpoint', 'rest', 'route', 'http', 'payload', 'status', 'request', 'response'],
        db_debugging: ['database', 'db', 'sql', 'migration', 'orm', 'query', 'schema', 'table'],
        security_review: ['security', 'vulnerability', 'cve', 'xss', 'injection', 'auth', 'token', 'secret', 'sanitize'],
        ui_verification: ['ui', 'frontend', 'visual', 'button', 'screen', 'browser', 'dom', 'css', 'layout', 'render'],
        migration: ['migrate', 'upgrade framework', 'deprecat', 'codemod', 'breaking change', 'v2', 'v3'],
        refactoring: ['refactor', 'clean', 'extract', 'reorganize', 'simplify', 'modular', 'structure'],
        test_repair: ['test', 'assertion', 'fixture', 'mock', 'flaky', 'spec', 'unit test'],
        dependency_upgrade: ['dependency', 'package', 'npm', 'pip', 'lockfile', 'version bump', 'outdated'],
      };

      const words = keywords[skill.id] || [];
      for (const w of words) {
        if (text.includes(w)) {
          score += 15;
        }
      }

      if (score > highestScore) {
        highestScore = score;
        bestSkill = skill;
      }
    }

    // Default to bug_investigation if no strong match
    if (!bestSkill || highestScore <= 0) {
      bestSkill = this._skills.get('bug_investigation');
      highestScore = 10;
    }

    return {
      skill: bestSkill,
      confidence: Math.min(highestScore / 100, 1.0),
      playbook: bestSkill.playbookSteps,
    };
  }

  generatePlan(skillId, taskContext = {}) {
    const skill = this.getSkill(skillId);
    if (!skill) return null;

    return {
      skillId: skill.id,
      skillName: skill.name,
      category: skill.category,
      steps: skill.playbookSteps.map((step, idx) => ({
        index: idx + 1,
        name: step.action,
        purpose: step.purpose,
        status: 'pending',
        requiredCapabilities: skill.requiredCapabilities,
      })),
      preconditions: [...skill.preconditions],
      postconditions: [...skill.postconditions],
      generatedAt: new Date().toISOString(),
    };
  }
}

const skillSystem = new SkillSystem();

module.exports = {
  CODING_SKILLS,
  SkillSystem,
  skillSystem,
};
