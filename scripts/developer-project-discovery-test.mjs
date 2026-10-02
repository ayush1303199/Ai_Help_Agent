import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import developerFiles from '../electron/developerFiles.cjs';

const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.coding-discovery-test-'));
const originalRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
const uniqueOwner = 71001;
const ambiguousOwner = 71002;
const auditDirectory = path.join(testRoot, 'application-data-audit');
try {
  const searchRootA = path.join(testRoot, 'projects-a');
  const searchRootB = path.join(testRoot, 'projects-b');
  const uniqueProject = path.join(searchRootA, 'candidate-unique-discovery-test');
  const ambiguousProjectA = path.join(searchRootA, 'candidate-ambiguous-discovery-test');
  const ambiguousProjectB = path.join(searchRootB, 'candidate-ambiguous-discovery-test');
  const ignoredProject = path.join(searchRootA, 'node_modules', 'candidate-ignored-discovery-test');
  const vendorProject = path.join(searchRootA, 'vendor', 'candidate-vendor-discovery-test');
  const tooDeepProject = path.join(searchRootA, 'one', 'two', 'three', 'candidate-too-deep-discovery-test');

  await Promise.all([
    fs.mkdir(uniqueProject, { recursive: true }),
    fs.mkdir(ambiguousProjectA, { recursive: true }),
    fs.mkdir(ambiguousProjectB, { recursive: true }),
    fs.mkdir(ignoredProject, { recursive: true }),
    fs.mkdir(vendorProject, { recursive: true }),
    fs.mkdir(tooDeepProject, { recursive: true }),
  ]);
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = [searchRootA, searchRootB].join(path.delimiter);

  const roots = developerFiles.getProjectDiscoveryRoots();
  assert.ok(roots.includes(path.resolve(searchRootA)));
  assert.ok(roots.includes(path.resolve(searchRootB)));
  assert.ok(roots.every((root) => root.toLowerCase() !== path.parse(root).root.toLowerCase()));
  if (process.platform === 'win32') {
    const currentRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = 'C:\\';
    assert.throws(() => developerFiles.getProjectDiscoveryRoots(), /Invalid Coding project discovery root/);
    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = currentRoots;
  }

  const unique = await developerFiles.discoverProjectByName('candidate-unique-discovery-test', uniqueOwner);
  assert.equal(unique.projectRoot, await fs.realpath(uniqueProject));
  assert.deepEqual(unique.matches, [await fs.realpath(uniqueProject)]);
  assert.equal(developerFiles.getProjectRoot(uniqueOwner), await fs.realpath(uniqueProject));
  developerFiles.configureAuditDirectory(auditDirectory);
  await developerFiles.listDirectory('.', uniqueOwner);
  assert.equal((await fs.readdir(uniqueProject)).includes('.dev-mode-audit.log'), false);
  assert.equal((await fs.readdir(auditDirectory)).length, 1);
  await assert.rejects(
    () => developerFiles.readFile('../outside.txt', uniqueOwner),
    /outside the selected project|outside the selected root/i,
  );

  const ambiguous = await developerFiles.discoverProjectByName('candidate-ambiguous-discovery-test', ambiguousOwner);
  assert.equal(ambiguous.projectRoot, null);
  assert.deepEqual(ambiguous.matches, [await fs.realpath(ambiguousProjectA), await fs.realpath(ambiguousProjectB)].sort());
  assert.equal(developerFiles.getProjectRoot(ambiguousOwner), null);

  const selected = await developerFiles.discoverProjectByName(ambiguous.matches[0], ambiguousOwner);
  assert.equal(selected.projectRoot, ambiguous.matches[0]);
  assert.equal(developerFiles.getProjectRoot(ambiguousOwner), ambiguous.matches[0]);

  const ignored = await developerFiles.discoverProjectByName('candidate-ignored-discovery-test', 71003);
  assert.equal(ignored.matches.length, 0);
  const vendor = await developerFiles.discoverProjectByName('candidate-vendor-discovery-test', 71005);
  assert.equal(vendor.matches.length, 0);
  const tooDeep = await developerFiles.discoverProjectByName('candidate-too-deep-discovery-test', 71004);
  assert.equal(tooDeep.matches.length, 0);

  // Cross-project generic tests: project-alpha (Node), project-beta (PHP), project-gamma (Go)
  const projectAlpha = path.join(searchRootA, 'project-alpha');
  const projectBeta = path.join(searchRootA, 'project-beta');
  const projectGamma = path.join(searchRootB, 'project-gamma');
  await Promise.all([
    fs.mkdir(path.join(projectAlpha, 'src'), { recursive: true }),
    fs.mkdir(path.join(projectBeta, 'models'), { recursive: true }),
    fs.mkdir(path.join(projectGamma, 'pkg'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(projectAlpha, 'package.json'), JSON.stringify({ name: 'project-alpha' }), 'utf8'),
    fs.writeFile(path.join(projectAlpha, 'src', 'BillingService.js'), 'module.exports = {};', 'utf8'),
    fs.writeFile(path.join(projectAlpha, 'src', 'CommonUtil.ts'), 'export const x = 1;', 'utf8'),
    fs.writeFile(path.join(projectBeta, 'composer.json'), JSON.stringify({ name: 'project-beta' }), 'utf8'),
    fs.writeFile(path.join(projectBeta, 'models', 'Account.php'), '<?php class Account {}', 'utf8'),
    fs.writeFile(path.join(projectGamma, 'go.mod'), 'module project-gamma', 'utf8'),
    fs.writeFile(path.join(projectGamma, 'pkg', 'CommonUtil.ts'), 'export const y = 2;', 'utf8'),
  ]);

  // Generic directory match
  const alphaResult = await developerFiles.discoverProjectByName('project-alpha', 71010);
  assert.equal(alphaResult.projectRoot, await fs.realpath(projectAlpha));
  developerFiles.releaseProject(71010);

  // Case-insensitive match
  const alphaCaseResult = await developerFiles.discoverProjectByName('PROJECT-ALPHA', 71011);
  assert.equal(alphaCaseResult.projectRoot, await fs.realpath(projectAlpha));
  developerFiles.releaseProject(71011);

  // Target file discovery resolves to enclosing project root
  const fileResult = await developerFiles.discoverProjectByName('BillingService.js', 71012);
  assert.equal(fileResult.projectRoot, await fs.realpath(projectAlpha));
  developerFiles.releaseProject(71012);

  const phpFileResult = await developerFiles.discoverProjectByName('Account.php', 71013);
  assert.equal(phpFileResult.projectRoot, await fs.realpath(projectBeta));
  developerFiles.releaseProject(71013);

  // Ambiguous target filename in multiple projects returns all matches without guessing
  const ambiguousFile = await developerFiles.discoverProjectByName('CommonUtil.ts', 71014);
  assert.equal(ambiguousFile.projectRoot, null);
  assert.equal(ambiguousFile.matches.length, 2);
  assert.deepEqual(ambiguousFile.matches, [await fs.realpath(projectAlpha), await fs.realpath(projectGamma)].sort());
  developerFiles.releaseProject(71014);

  // Non-existent target returns 0 matches
  const nonExistent = await developerFiles.discoverProjectByName('totally-missing-target.xyz', 71015);
  assert.equal(nonExistent.matches.length, 0);
  assert.equal(nonExistent.projectRoot, null);
  developerFiles.releaseProject(71015);

  console.log('Coding project discovery tests passed (unique/ambiguous match, bounds, exclusions, cross-project, and file resolution).');
} finally {
  developerFiles.releaseProject(uniqueOwner);
  developerFiles.releaseProject(ambiguousOwner);
  developerFiles.releaseProject(71003);
  developerFiles.releaseProject(71004);
  developerFiles.releaseProject(71005);
  developerFiles.configureAuditDirectory(null);
  if (originalRoots === undefined) delete process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  else process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = originalRoots;
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
