const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const RESOURCE_OPERATIONS = Object.freeze({
  'app-state': new Set(['write', 'append', 'replace', 'remove']),
  audit: new Set(['append', 'write', 'replace', 'remove']),
  cache: new Set(['write', 'replace', 'remove']),
  checkpoint: new Set(['write', 'replace', 'remove']),
  artifact: new Set(['write', 'replace', 'remove']),
  credential: new Set(['write', 'replace', 'remove']),
});

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function nearestExistingPath(target) {
  let current = target;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function authorizeAppOwnedMutation({ root, target, resource, operation }) {
  const allowed = RESOURCE_OPERATIONS[resource];
  if (!allowed || !allowed.has(operation)) {
    throw new Error('Application persistence operation is not allow-listed.');
  }
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const isRootTarget = absoluteRoot === absoluteTarget;
  if (!isWithin(absoluteRoot, absoluteTarget) || (isRootTarget && operation !== 'write')) {
    throw new Error('Application persistence target is outside its configured storage root.');
  }

  let realRoot;
  let rootMissing = false;
  try {
    realRoot = await fs.realpath(absoluteRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.realpath(await nearestExistingPath(absoluteRoot));
    realRoot = absoluteRoot;
    rootMissing = true;
  }
  if (isRootTarget) return absoluteRoot;
  if (rootMissing) {
    const targetId = crypto.createHash('sha256').update(path.relative(absoluteRoot, absoluteTarget)).digest('hex').slice(0, 16);
    console.info(JSON.stringify({ event: 'app_persistence_authorized', resource, operation, targetId, decision: 'ALLOW' }));
    return absoluteTarget;
  }

  const existing = await nearestExistingPath(absoluteTarget);
  const realExisting = await fs.realpath(existing);
  const resolvedTarget = path.resolve(realExisting, path.relative(existing, absoluteTarget));
  if (!isWithin(realRoot, resolvedTarget) || !isWithin(realRoot, realExisting)) {
    throw new Error('Application persistence target escapes through a symlink.');
  }
  const targetId = crypto.createHash('sha256').update(path.relative(realRoot, resolvedTarget)).digest('hex').slice(0, 16);
  console.info(JSON.stringify({
    event: 'app_persistence_authorized',
    resource,
    operation,
    targetId,
    decision: 'ALLOW',
  }));
  return resolvedTarget;
}

module.exports = { authorizeAppOwnedMutation };
