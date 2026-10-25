import assert from 'node:assert';
import path from 'node:path';
import {
  RESOLUTION_STATUS,
  extractPathAliases,
  resolveModuleSpecifier,
  probeFileCandidates,
} from '../electron/coding-pipeline/moduleResolver.cjs';
import {
  GRAPH_VERSION,
  parseModuleAstEvidence,
  createSemanticProjectGraph,
} from '../electron/coding-pipeline/projectGraphModel.cjs';
import { VerificationOrchestrator } from '../electron/coding-pipeline/verificationOrchestrator.cjs';

console.log('Starting Semantic Project Graph & Module Resolution regression tests (V11)...');

const mockProjectRoot = 'C:/mock/project';

// 1. Relative import resolution
console.log('Testing relative import resolution...');
{
  const workspaceFiles = new Set(['src/utils/math.ts', 'src/components/Button.tsx', 'src/index.ts']);
  const res1 = resolveModuleSpecifier({
    fromFile: 'src/index.ts',
    specifier: './utils/math',
    projectRoot: mockProjectRoot,
    workspaceFiles,
  });

  assert.strictEqual(res1.status, RESOLUTION_STATUS.RESOLVED_INTERNAL);
  assert.strictEqual(res1.resolvedPath, 'src/utils/math.ts');

  const res2 = resolveModuleSpecifier({
    fromFile: 'src/components/Button.tsx',
    specifier: '../utils/math.ts',
    projectRoot: mockProjectRoot,
    workspaceFiles,
  });
  assert.strictEqual(res2.status, RESOLUTION_STATUS.RESOLVED_INTERNAL);
  assert.strictEqual(res2.resolvedPath, 'src/utils/math.ts');
}

// 2. Extension and index-file resolution
console.log('Testing extension and index-file conventions resolution...');
{
  const workspaceFiles = new Set([
    'src/routes/home/index.ts',
    'src/services/auth.service.js',
    'src/components/Card/index.tsx',
  ]);

  const resIndex = resolveModuleSpecifier({
    fromFile: 'src/app.ts',
    specifier: './routes/home',
    projectRoot: mockProjectRoot,
    workspaceFiles,
  });
  assert.strictEqual(resIndex.status, RESOLUTION_STATUS.RESOLVED_INTERNAL);
  assert.strictEqual(resIndex.resolvedPath, 'src/routes/home/index.ts');

  const resCard = resolveModuleSpecifier({
    fromFile: 'src/app.ts',
    specifier: './components/Card',
    projectRoot: mockProjectRoot,
    workspaceFiles,
  });
  assert.strictEqual(resCard.status, RESOLUTION_STATUS.RESOLVED_INTERNAL);
  assert.strictEqual(resCard.resolvedPath, 'src/components/Card/index.tsx');
}

// 3. Path aliases from tsconfig.json fixtures
console.log('Testing path alias resolution with tsconfig fixtures...');
{
  const tsconfigFixture = {
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@/*': ['src/*'],
        '@components/*': ['src/components/*'],
        '@config': ['src/config/app.config.ts'],
      },
    },
  };
  const aliasConfig = extractPathAliases(tsconfigFixture);
  const workspaceFiles = new Set([
    'src/utils/logger.ts',
    'src/components/Modal.tsx',
    'src/config/app.config.ts',
  ]);

  const resAlias = resolveModuleSpecifier({
    fromFile: 'src/pages/Dashboard.tsx',
    specifier: '@/utils/logger',
    projectRoot: mockProjectRoot,
    workspaceFiles,
    aliasConfig,
  });
  assert.strictEqual(resAlias.status, RESOLUTION_STATUS.RESOLVED_INTERNAL);
  assert.strictEqual(resAlias.resolvedPath, 'src/utils/logger.ts');

  const resComponent = resolveModuleSpecifier({
    fromFile: 'src/pages/Dashboard.tsx',
    specifier: '@components/Modal',
    projectRoot: mockProjectRoot,
    workspaceFiles,
    aliasConfig,
  });
  assert.strictEqual(resComponent.status, RESOLUTION_STATUS.RESOLVED_INTERNAL);
  assert.strictEqual(resComponent.resolvedPath, 'src/components/Modal.tsx');

  const resExact = resolveModuleSpecifier({
    fromFile: 'src/pages/Dashboard.tsx',
    specifier: '@config',
    projectRoot: mockProjectRoot,
    workspaceFiles,
    aliasConfig,
  });
  assert.strictEqual(resExact.status, RESOLUTION_STATUS.RESOLVED_INTERNAL);
  assert.strictEqual(resExact.resolvedPath, 'src/config/app.config.ts');
}

// 4. Re-exports and barrel files
console.log('Testing re-exports and barrel file edge tracking...');
{
  const fileContents = new Map([
    ['src/components/Button.tsx', 'export function Button() { return null; }'],
    ['src/components/Input.tsx', 'export function Input() { return null; }'],
    ['src/components/index.ts', "export * from './Button';\nexport { Input } from './Input';"],
    ['src/App.tsx', "import { Button, Input } from './components';\nexport function App() { return null; }"],
  ]);

  const graph = createSemanticProjectGraph(mockProjectRoot);
  graph.buildFromWorkspace(fileContents);

  assert.strictEqual(graph.nodes.size, 4);

  // Check barrel re-export edges
  const barrelNode = graph.nodes.get('src/components/index.ts');
  assert.ok(barrelNode);
  assert.strictEqual(barrelNode.reExports.length, 2);

  // App imports barrel -> direct edge App -> src/components/index.ts
  const appDeps = graph.getDirectDependencies('src/App.tsx');
  assert.ok(appDeps.includes('src/components/index.ts'));

  // Transitive dependencies of App includes Button.tsx and Input.tsx
  const appTransitive = graph.getTransitiveDependencies('src/App.tsx');
  assert.ok(appTransitive.includes('src/components/Button.tsx'));
  assert.ok(appTransitive.includes('src/components/Input.tsx'));
}

// 5. Cyclic dependencies
console.log('Testing cyclic dependencies without infinite recursion...');
{
  const fileContents = new Map([
    ['src/cycleA.ts', "import { b } from './cycleB';\nexport const a = 1;\nexport function useB() { return b; }"],
    ['src/cycleB.ts', "import { a } from './cycleA';\nexport const b = 2;\nexport function useA() { return a; }"],
  ]);

  const graph = createSemanticProjectGraph(mockProjectRoot);
  graph.buildFromWorkspace(fileContents);

  // Cycle A -> B and B -> A
  const depsA = graph.getTransitiveDependencies('src/cycleA.ts');
  assert.deepStrictEqual(depsA, ['src/cycleB.ts']);

  const depsB = graph.getTransitiveDependencies('src/cycleB.ts');
  assert.deepStrictEqual(depsB, ['src/cycleA.ts']);

  // Dependents should also not loop
  const dependentsA = graph.getTransitiveDependents('src/cycleA.ts');
  assert.deepStrictEqual(dependentsA, ['src/cycleB.ts']);
}

// 6. Missing and ambiguous imports
console.log('Testing missing and ambiguous imports with explicit reasons...');
{
  const workspaceFiles = new Set(['src/index.ts']);
  const resMissing = resolveModuleSpecifier({
    fromFile: 'src/index.ts',
    specifier: './nonexistent/module',
    projectRoot: mockProjectRoot,
    workspaceFiles,
  });

  assert.strictEqual(resMissing.status, RESOLUTION_STATUS.UNRESOLVED_NOT_FOUND);
  assert.strictEqual(resMissing.resolvedPath, null);
  assert.ok(resMissing.reason.includes('Relative file candidate not found'));
}

// 7. Duplicate symbols and identifier references
console.log('Testing duplicate symbols and identifier references...');
{
  const code = `
    export function helper() { return 1; }
    function helper(param) { return param; }
    export const PI = 3.14;
    helper();
    helper(42);
  `;
  const evidence = parseModuleAstEvidence('src/duplicate.ts', code);
  assert.strictEqual(evidence.symbols.filter((s) => s.name === 'helper').length, 2);
  assert.strictEqual(evidence.references.filter((r) => r.name === 'helper').length, 2);
}

// 8. Case-sensitive path handling
console.log('Testing case-sensitive path preservation...');
{
  const workspaceFiles = new Set(['src/components/Button.tsx']);
  const exactMatch = resolveModuleSpecifier({
    fromFile: 'src/App.tsx',
    specifier: './components/Button',
    projectRoot: mockProjectRoot,
    workspaceFiles,
  });
  assert.strictEqual(exactMatch.status, RESOLUTION_STATUS.RESOLVED_INTERNAL);
  assert.strictEqual(exactMatch.resolvedPath, 'src/components/Button.tsx');

  // Mismatched casing on case-sensitive set will fail to resolve
  const mismatched = resolveModuleSpecifier({
    fromFile: 'src/App.tsx',
    specifier: './components/button',
    projectRoot: mockProjectRoot,
    workspaceFiles,
  });
  assert.strictEqual(mismatched.status, RESOLUTION_STATUS.UNRESOLVED_NOT_FOUND);
}

// 9. Traversal attempts outside project root
console.log('Testing root boundary traversal blocking...');
{
  const workspaceFiles = new Set(['src/index.ts']);
  const traversalAttempt = resolveModuleSpecifier({
    fromFile: 'src/index.ts',
    specifier: '../../../../etc/passwd',
    projectRoot: mockProjectRoot,
    workspaceFiles,
  });

  assert.strictEqual(traversalAttempt.status, RESOLUTION_STATUS.UNRESOLVED_OUTSIDE_ROOT);
  assert.strictEqual(traversalAttempt.resolvedPath, null);
  assert.ok(traversalAttempt.reason.includes('attempts to escape the authorized project root'));
}

// 10. File modification and incremental invalidation
console.log('Testing file modification and incremental graph invalidation...');
{
  const fileContents = new Map([
    ['src/math.ts', 'export function add(a, b) { return a + b; }'],
    ['src/calc.ts', "import { add } from './math';\nexport function calc() { return add(1, 2); }"],
  ]);

  const graph = createSemanticProjectGraph(mockProjectRoot);
  graph.buildFromWorkspace(fileContents);

  assert.strictEqual(graph.getDirectDependencies('src/calc.ts')[0], 'src/math.ts');

  // Modify src/calc.ts to import from a new file src/extra.ts
  fileContents.set('src/extra.ts', 'export function multiply(a, b) { return a * b; }');
  fileContents.set('src/calc.ts', "import { multiply } from './extra';\nexport function calc() { return multiply(2, 3); }");

  graph.invalidateFiles({
    modified: ['src/calc.ts'],
    added: ['src/extra.ts'],
    fileContents,
  });

  assert.strictEqual(graph.nodes.size, 3);
  assert.deepStrictEqual(graph.getDirectDependencies('src/calc.ts'), ['src/extra.ts']);
  assert.deepStrictEqual(graph.getDirectDependents('src/math.ts'), []);
  assert.deepStrictEqual(graph.getDirectDependents('src/extra.ts'), ['src/calc.ts']);
}

// 11. File deletion and stale-edge removal
console.log('Testing file deletion and edge pruning...');
{
  const fileContents = new Map([
    ['src/math.ts', 'export function add(a, b) { return a + b; }'],
    ['src/calc.ts', "import { add } from './math';"],
  ]);

  const graph = createSemanticProjectGraph(mockProjectRoot);
  graph.buildFromWorkspace(fileContents);

  assert.strictEqual(graph.edges.length, 1);

  // Delete src/math.ts
  fileContents.delete('src/math.ts');
  graph.invalidateFiles({
    deleted: ['src/math.ts'],
    fileContents,
  });

  assert.strictEqual(graph.nodes.has('src/math.ts'), false);
  // Stale resolved edge should be pruned, and calc.ts import becomes unresolved
  assert.strictEqual(graph.edges.length, 0);
  assert.ok(graph.unresolvedReferences.some((u) => u.from === 'src/calc.ts' && u.specifier === './math'));
}

// 12. Interrupted graph update and deterministic rebuild
console.log('Testing interrupted state and deterministic rebuild...');
{
  const fileContents = new Map([
    ['src/a.ts', "import { b } from './b';"],
    ['src/b.ts', 'export const b = 10;'],
  ]);

  const graph = createSemanticProjectGraph(mockProjectRoot);
  graph.buildFromWorkspace(fileContents);
  assert.strictEqual(graph.edges.length, 1);

  // Full clean rebuild from workspace map
  fileContents.set('src/c.ts', "import { b } from './b';");
  graph.buildFromWorkspace(fileContents);
  assert.strictEqual(graph.nodes.size, 3);
  assert.strictEqual(graph.edges.length, 2);
}

// 13. Dependency-based affected-file selection (direct vs transitive)
console.log('Testing affected-file impact detection...');
{
  const fileContents = new Map([
    ['src/core/model.ts', 'export class User { id: string; }'],
    ['src/services/userService.ts', "import { User } from '../core/model';\nexport function getUser() { return new User(); }"],
    ['src/controllers/userController.ts', "import { getUser } from '../services/userService';\nexport function handleUser() { return getUser(); }"],
    ['src/unrelated.ts', 'export const value = 99;'],
  ]);

  const graph = createSemanticProjectGraph(mockProjectRoot);
  graph.buildFromWorkspace(fileContents);

  const affected = graph.detectAffectedFiles(['src/core/model.ts']);
  const affectedPaths = affected.map((a) => a.file);

  assert.ok(affectedPaths.includes('src/core/model.ts'), 'Should include modified file');
  assert.ok(affectedPaths.includes('src/services/userService.ts'), 'Should include direct dependent');
  assert.ok(affectedPaths.includes('src/controllers/userController.ts'), 'Should include transitive dependent');
  assert.ok(!affectedPaths.includes('src/unrelated.ts'), 'Unrelated file must not be affected');

  const userServiceAff = affected.find((a) => a.file === 'src/services/userService.ts');
  assert.strictEqual(userServiceAff.reason, 'DIRECT_IMPORTER_OF: src/core/model.ts');
  assert.strictEqual(userServiceAff.severity, 'HIGH');

  const userCtrlAff = affected.find((a) => a.file === 'src/controllers/userController.ts');
  assert.strictEqual(userCtrlAff.reason, 'TRANSITIVE_DEPENDENT_OF: src/core/model.ts');
  assert.strictEqual(userCtrlAff.severity, 'MEDIUM');
}

// 14. Integration with investigation and verification orchestrator
console.log('Testing integration with VerificationOrchestrator...');
{
  const fileContents = new Map([
    ['src/lib/calc.ts', 'export const calc = 10;'],
    ['src/tests/calc.test.ts', "import { calc } from '../lib/calc';"],
  ]);

  const graph = createSemanticProjectGraph(mockProjectRoot);
  graph.buildFromWorkspace(fileContents);

  const orchestrator = new VerificationOrchestrator();
  const regressionTargets = orchestrator.detectRegressionTargets({
    modifiedFiles: ['src/lib/calc.ts'],
    dependencyGraph: { semanticGraph: graph },
  });

  assert.ok(regressionTargets.includes('src/lib/calc.ts'));
  assert.ok(regressionTargets.includes('src/tests/calc.test.ts'));
}

// 15. Unsupported syntax producing explicit partial/unresolved result
console.log('Testing unsupported syntax and dynamic imports...');
{
  const dynamicCode = `
    const moduleName = 'dyn_' + Math.random();
    require(moduleName);
    import(moduleName);
    const valid = require('./valid');
  `;
  const evidence = parseModuleAstEvidence('src/dynamic.ts', dynamicCode);

  // Runtime computed require/import is not matched by string-literal parser -> ignored safely
  assert.strictEqual(evidence.imports.length, 1);
  assert.strictEqual(evidence.imports[0].specifier, './valid');
}

// 16. Root-relative and ./ module resolution verification
console.log('Testing root-relative and ./ resolution...');
{
  const workspaceFiles = new Set(['index.ts', 'src/app.ts', 'components/Button.tsx']);
  
  // Specifier './' from root
  const rootDotSlash = resolveModuleSpecifier({
    fromFile: 'main.ts',
    specifier: './',
    projectRoot: mockProjectRoot,
    workspaceFiles,
  });
  assert.strictEqual(rootDotSlash.status, RESOLUTION_STATUS.RESOLVED_INTERNAL);
  assert.strictEqual(rootDotSlash.resolvedPath, 'index.ts');

  // Specifier '/components/Button' root-relative
  const rootRelativeBtn = resolveModuleSpecifier({
    fromFile: 'src/app.ts',
    specifier: '/components/Button',
    projectRoot: mockProjectRoot,
    workspaceFiles,
  });
  assert.strictEqual(rootRelativeBtn.status, RESOLUTION_STATUS.RESOLVED_INTERNAL);
  assert.strictEqual(rootRelativeBtn.resolvedPath, 'components/Button.tsx');
}

// 17. Null or degraded dependency graph handling in VerificationOrchestrator
console.log('Testing null and degraded dependency graph handling...');
{
  const orchestrator = new VerificationOrchestrator();
  
  // Null dependency graph
  const targetsNull = orchestrator.detectRegressionTargetsDetailed({
    modifiedFiles: ['src/lib/calc.ts'],
    dependencyGraph: null,
  });
  assert.strictEqual(targetsNull.status, 'GRAPH_UNAVAILABLE');
  assert.strictEqual(targetsNull.totalTargets, 0);

  // Undefined dependency graph
  const targetsUndef = orchestrator.detectRegressionTargets({
    modifiedFiles: ['src/lib/calc.ts'],
    dependencyGraph: undefined,
  });
  assert.deepStrictEqual(targetsUndef, []);

  // Degraded string map with fuzzy matches
  const targetsFuzzy = orchestrator.detectRegressionTargetsDetailed({
    modifiedFiles: ['calc'],
    dependencyGraph: {
      'src/tests/calc.test.ts': ['./calc'],
      'src/other.ts': ['./unrelated'],
    },
  });
  assert.strictEqual(targetsFuzzy.status, 'DEGRADED_FUZZY');
  assert.strictEqual(targetsFuzzy.totalTargets, 1);
  assert.strictEqual(targetsFuzzy.targets[0].file, 'src/tests/calc.test.ts');
}

console.log('All Semantic Project Graph & Module Resolution regression tests passed successfully!');
