const fs = require('node:fs/promises');
const path = require('node:path');
const { PROJECT_MANIFESTS, VERIFICATION_PROFILES } = require('./projectRegistries.cjs');

function manifestMatches(name, pattern) {
  if (pattern.startsWith('*')) return name.toLowerCase().endsWith(pattern.slice(1).toLowerCase());
  return name.toLowerCase() === pattern.toLowerCase();
}

function ignored(name) {
  const lower = String(name || '').toLowerCase();
  return new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'vendor', '.idea', '.vscode', 'tmp', 'temp']).has(lower)
    || lower.endsWith('.log');
}

async function detectProject(root) {
  const files = new Set();
  const rootFiles = new Set();
  const extensions = new Map();
  async function walk(relativeDirectory, depth = 0) {
    if (depth > 8) return;
    let entries;
    try { entries = await fs.readdir(path.join(root, relativeDirectory), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (ignored(entry.name)) continue;
      const relative = relativeDirectory === '.' ? entry.name : path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      files.add(entry.name);
      if (relativeDirectory === '.') rootFiles.add(entry.name);
      const extension = path.extname(entry.name).toLowerCase();
      if (extension) extensions.set(extension, (extensions.get(extension) || 0) + 1);
    }
  }
  await walk('.');
  const manifestHit = PROJECT_MANIFESTS
    .map((profile) => ({ profile, matches: profile.files.filter((file) => [...rootFiles].some((name) => manifestMatches(name, file))) }))
    .filter((item) => item.matches.length)
    .sort((a, b) => b.profile.priority - a.profile.priority)[0];
  const extensionProfile = [...PROJECT_MANIFESTS]
    .map((profile) => ({ profile, count: profile.extensions.reduce((sum, ext) => sum + (extensions.get(ext) || 0), 0) }))
    .sort((a, b) => b.count - a.count || b.profile.priority - a.profile.priority)[0]?.profile;
  const profile = manifestHit?.profile || extensionProfile;
  const type = profile?.type || 'unknown';
  return {
    type,
    language: profile?.language || 'unknown',
    manifest: manifestHit?.matches[0] || null,
    confidence: manifestHit ? 'manifest' : profile ? 'extension-guess' : 'unknown',
    profile: VERIFICATION_PROFILES[type] || { checks: [], fallbacks: [] },
    hasPhpUnitConfig: rootFiles.has('phpunit.xml') || rootFiles.has('phpunit.xml.dist'),
    composer: rootFiles.has('composer.json') ? 'composer.json' : null,
    hasPackageJson: rootFiles.has('package.json'),
    extensions: profile?.extensions || [],
    detectedFiles: files.size,
  };
}

module.exports = { detectProject, PROJECT_MANIFESTS, VERIFICATION_PROFILES };
