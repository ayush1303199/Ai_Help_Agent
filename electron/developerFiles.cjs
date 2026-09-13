const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 2000;
const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

let projectRoot = null;

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function realPathOrParent(target) {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await realPathOrParent(parent), path.basename(target));
  }
}

async function validateProjectRoot() {
  if (!projectRoot) throw new Error('No project folder selected.');
  const root = await fs.realpath(projectRoot);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error('Invalid project path.');
  return root;
}

async function resolveProjectPath(relativePath = '.') {
  const root = await validateProjectRoot();
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    throw new Error('Access denied: project paths must be relative.');
  }
  const requested = path.resolve(root, relativePath || '.');
  const realTarget = await realPathOrParent(requested);
  if (!isInsideRoot(root, realTarget)) {
    throw new Error('Access denied: the requested path is outside the selected project.');
  }
  return { root, target: realTarget };
}

async function chooseProjectFolder(dialog) {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true, projectRoot };
  projectRoot = await fs.realpath(result.filePaths[0]);
  return { canceled: false, projectRoot };
}

async function listDirectory(relativePath = '.') {
  const { target } = await resolveProjectPath(relativePath);
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error('The requested path is not a directory.');
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries
    .filter((entry) => !IGNORED_NAMES.has(entry.name))
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

async function readFile(relativePath) {
  const { target } = await resolveProjectPath(relativePath);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('The requested path is not a file.');
  if (stat.size > MAX_FILE_BYTES) throw new Error('File is too large to read (512KB limit).');
  return { path: relativePath, content: await fs.readFile(target, 'utf8') };
}

async function searchCode(query) {
  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!normalizedQuery) throw new Error('Search query is required.');
  const { root } = await validateProjectRoot();
  const results = [];
  let filesVisited = 0;

  async function walk(relativeDirectory) {
    if (results.length >= MAX_SEARCH_RESULTS || filesVisited >= MAX_SEARCH_FILES) return;
    const directory = await resolveProjectPath(relativeDirectory);
    const entries = await fs.readdir(directory.target, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS || filesVisited >= MAX_SEARCH_FILES) return;
      if (IGNORED_NAMES.has(entry.name)) continue;
      const childRelative = relativeDirectory === '.' ? entry.name : path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      filesVisited += 1;
      const target = await resolveProjectPath(childRelative);
      const stat = await fs.stat(target.target);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(target.target, 'utf8');
      const lines = content.split(/\r?\n/);
      const nameMatch = entry.name.toLowerCase().includes(normalizedQuery);
      if (nameMatch) {
        results.push({
          path: childRelative,
          line: 0,
          text: entry.name,
          matchType: 'filename',
        });
      }
      lines.forEach((line, lineIndex) => {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        if (line.toLowerCase().includes(normalizedQuery)) {
          results.push({
            path: childRelative,
            line: lineIndex + 1,
            text: line.slice(0, 240),
            matchType: 'content',
          });
        }
      });
    }
  }

  await walk('.');
  return { query, results, filesVisited, truncated: results.length >= MAX_SEARCH_RESULTS || filesVisited >= MAX_SEARCH_FILES };
}

function clearProject() {
  projectRoot = null;
}

module.exports = { chooseProjectFolder, listDirectory, readFile, searchCode, clearProject };
