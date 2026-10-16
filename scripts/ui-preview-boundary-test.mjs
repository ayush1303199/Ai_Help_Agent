import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previewEntry = path.join(repoRoot, 'src', 'preview', 'main.tsx');
const visited = new Set();
const pending = [previewEntry];
const forbiddenImport = /(?:^|\/)(?:App\.tsx|features\/|config\/|history\/|documents\/|electron\.d\.ts$)/i;
const allowedPackages = new Set(['react', 'react-dom/client']);
const forbiddenRuntimeAccess = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|WebTransport|sendBeacon|localStorage|sessionStorage|indexedDB|caches|ipcRenderer|require|showOpenFilePicker|showSaveFilePicker|FileReader)\b|window\s*\.\s*electronAPI|node:|process\s*\.\s*env|document\s*\.\s*cookie/;

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

function relativeImportPaths(source) {
  return importSpecifiers(source)
    .filter((specifier) => specifier.startsWith('.'));
}

function importSpecifiers(source) {
  return [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
}

async function resolveSourceImport(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base, ...['.tsx', '.ts', '.jsx', '.js', '.css'].map((extension) => `${base}${extension}`)];
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`Could not resolve preview source import "${specifier}" from ${path.relative(repoRoot, importer)}.`);
}

while (pending.length > 0) {
  const filePath = pending.pop();
  if (!filePath || visited.has(filePath)) continue;
  visited.add(filePath);
  const source = await readText(filePath);
  const relativePath = path.relative(repoRoot, filePath).replaceAll(path.sep, '/');
  assert.equal(forbiddenImport.test(relativePath), false, `Forbidden preview dependency: ${relativePath}`);
  if (/\.(?:tsx?|jsx?)$/i.test(filePath)) {
    assert.equal(forbiddenRuntimeAccess.test(source), false, `Service/runtime access found in ${relativePath}`);
    for (const specifier of importSpecifiers(source).filter((item) => !item.startsWith('.'))) {
      assert.equal(allowedPackages.has(specifier), true, `Unapproved preview runtime dependency "${specifier}" in ${relativePath}`);
    }
  } else if (/\.css$/i.test(filePath)) {
    assert.doesNotMatch(source, /@import|url\(\s*['"]?(?:https?:|\/\/)/i, `External stylesheet dependency found in ${relativePath}`);
  }
  for (const specifier of relativeImportPaths(source)) {
    pending.push(await resolveSourceImport(filePath, specifier));
  }
}

const previewFiles = await Promise.all([
  readText(path.join(repoRoot, 'src', 'preview', 'PreviewApp.tsx')),
  readText(path.join(repoRoot, 'src', 'preview', 'fixtures.ts')),
]);
const [previewAppSource, fixtureSource] = previewFiles;
assert.match(previewAppSource, /Preview — sample data, no services connected/);
assert.match(previewAppSource, /onClick=\{\(\) => setMode\(item\.id\)\}/);
assert.equal((previewAppSource.match(/onClick=/g) || []).length, 1);
assert.match(previewAppSource, /disabled/);
assert.doesNotMatch(fixtureSource, /^\s*(?:import|export\s+\{)/m);
assert.doesNotMatch(fixtureSource, /\b(?:fetch|WebSocket|localStorage|sessionStorage|window|process)\b/);
assert.match(fixtureSource, /Sample provider/);
assert.match(fixtureSource, /Example only/);

const previewMain = await readText(path.join(repoRoot, 'src', 'preview', 'main.tsx'));
assert.match(previewMain, /import \{ PREVIEW_FIXTURES \} from '\.\/fixtures'/);
assert.match(previewMain, /fixtures=\{PREVIEW_FIXTURES\}/);
const previewHtml = await readText(path.join(repoRoot, 'preview.html'));
assert.match(previewHtml, /connect-src 'none'/);
assert.match(previewHtml, /src\/preview\/main\.tsx/);

const previewShell = await readText(path.join(repoRoot, 'electron', 'uiPreviewMain.cjs'));
assert.match(previewShell, /throw new Error\(/);
assert.match(previewShell, /no independently verified OS isolation attestation is available/i);
assert.doesNotMatch(previewShell, /\b(?:require|spawn|fork|fetch|BrowserWindow|preload|backendProcess)\b/i);

const packageJson = JSON.parse(await readText(path.join(repoRoot, 'package.json')));
assert.equal(packageJson.scripts.dev, 'npm run electron:dev');
assert.equal(packageJson.scripts['electron:dev'], 'npm run preflight && node scripts/electron-dev.mjs');
assert.equal(packageJson.scripts['electron:start'], 'electron electron/main.cjs');
assert.equal(Object.values(packageJson.scripts).some((script) => /uiPreviewMain|preview\.html/i.test(script)), false);

const normalRendererEntry = await readText(path.join(repoRoot, 'src', 'main.tsx'));
assert.match(normalRendererEntry, /import App from '\.\/App\.tsx'/);
assert.match(normalRendererEntry, /isOverlay \? <Overlay \/> : <App \/>/);
const electronMain = await readText(path.join(repoRoot, 'electron', 'main.cjs'));
assert.match(electronMain, /preload: path\.join\(__dirname, 'preload\.cjs'\)/);
assert.match(electronMain, /await startPackagedBackend\(\)/);
assert.match(electronMain, /const codingAuthToken = process\.env\.AI_CODING_AUTH_TOKEN/);
assert.match(electronMain, /codingMutationHandshakeSecret/);
const backendAuth = await readText(path.join(repoRoot, 'server', 'src', 'index.py'));
assert.match(backendAuth, /hmac\.compare_digest\(supplied_token, CODING_AUTH_TOKEN\)/);
const isolationModule = await readText(path.join(repoRoot, 'electron', 'coding-pipeline', 'projectProcessIsolation.cjs'));
assert.match(isolationModule, /function requireProjectProcessIsolation\(operation,/);
assert.match(isolationModule, /if \(process\.platform === 'win32' \|\| !status\.available \|\| !status\.verified\)/);

console.log('UI preview static boundary checks passed.');
