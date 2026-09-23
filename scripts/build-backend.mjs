import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const python = process.platform === 'win32' ? 'python' : 'python3';
const outputRoot = path.join(root, 'build', 'backend-dist');
const workRoot = path.join(root, 'build', 'backend-work');
const specRoot = path.join(root, 'build', 'backend-spec');
const args = [
  '-m', 'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onedir',
  '--name', 'ai-help-agent-backend',
  '--distpath', outputRoot,
  '--workpath', workRoot,
  '--specpath', specRoot,
  '--paths', path.join(root, 'server', 'src'),
  '--collect-all', 'websockets',
  path.join(root, 'server', 'src', 'index.py'),
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(workRoot, { recursive: true });
await new Promise((resolve, reject) => {
  const child = spawn(python, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`PyInstaller exited with code ${code}.`)));
});
