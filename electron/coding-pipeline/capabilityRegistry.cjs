/**
 * Capability-based Tool Registry for Coding Agent.
 * Zero-hardcoding, provider-agnostic, capability-driven.
 */

const CAPABILITY_REGISTRY = Object.freeze({
  read_file: {
    capability: 'filesystem.read',
    description: 'Read contents of a single source or configuration file within project boundary.',
    riskLevel: 'LOW',
    costScore: 1,
    permissions: ['read'],
    informationGain: 'HIGH',
  },
  list_directory: {
    capability: 'filesystem.list',
    description: 'List directories and files to discover repository structure.',
    riskLevel: 'LOW',
    costScore: 1,
    permissions: ['read'],
    informationGain: 'MEDIUM',
  },
  search_code: {
    capability: 'code.search',
    description: 'Full-text code search across project files within scope.',
    riskLevel: 'LOW',
    costScore: 2,
    permissions: ['read'],
    informationGain: 'HIGH',
  },
  search_symbols: {
    capability: 'symbol.search',
    description: 'Lookup indexed symbol definitions (classes, functions, interfaces).',
    riskLevel: 'LOW',
    costScore: 2,
    permissions: ['read'],
    informationGain: 'HIGH',
  },
  find_references: {
    capability: 'symbol.references',
    description: 'Trace all callers and references for a specific symbol across the project.',
    riskLevel: 'LOW',
    costScore: 3,
    permissions: ['read'],
    informationGain: 'CRITICAL',
  },
  get_context: {
    capability: 'context.assemble',
    description: 'Assemble ranked, bounded source context around a topic or query.',
    riskLevel: 'LOW',
    costScore: 3,
    permissions: ['read'],
    informationGain: 'HIGH',
  },
  run_verification: {
    capability: 'execution.verification',
    description: 'Execute allow-listed verification script (typecheck, lint, test, build).',
    riskLevel: 'MEDIUM',
    costScore: 5,
    permissions: ['execute:allowlisted'],
    informationGain: 'CRITICAL',
  },
  dev_server_probe: {
    capability: 'runtime.devserver',
    description: 'Probe or discover running dev server port and health.',
    riskLevel: 'LOW',
    costScore: 2,
    permissions: ['read', 'network:local'],
    informationGain: 'HIGH',
  },
  browser_verify: {
    capability: 'runtime.browser',
    description: 'Inspect DOM, console, and network for user-visible flows.',
    riskLevel: 'MEDIUM',
    costScore: 6,
    permissions: ['browser:task_owned'],
    informationGain: 'CRITICAL',
  },
});

function scoreToolSelection({ toolName, target, purpose, taskContext = {}, recentTools = [] }) {
  const toolDef = CAPABILITY_REGISTRY[toolName];
  if (!toolDef) return { score: 0, eligible: false, reason: 'Unknown tool' };

  let score = 50;

  // Information gain boost
  if (toolDef.informationGain === 'CRITICAL') score += 30;
  else if (toolDef.informationGain === 'HIGH') score += 20;
  else if (toolDef.informationGain === 'MEDIUM') score += 10;

  // Duplicate penalty
  const duplicates = recentTools.filter((t) => t.tool === toolName && t.target === target);
  if (duplicates.length > 0) {
    score -= (duplicates.length * 25);
  }

  // Cost penalty
  score -= (toolDef.costScore * 2);

  // Goal relevance
  const queryWords = String(purpose || '').toLowerCase().split(/\s+/).filter(Boolean);
  const targetWords = String(target || '').toLowerCase().split(/[\\/._-]+/).filter(Boolean);
  const matches = queryWords.filter((w) => targetWords.includes(w)).length;
  score += Math.min(matches * 5, 20);

  return {
    score: Math.max(score, 0),
    eligible: score > 15,
    toolName,
    riskLevel: toolDef.riskLevel,
    permissions: toolDef.permissions,
  };
}

module.exports = {
  CAPABILITY_REGISTRY,
  scoreToolSelection,
};
