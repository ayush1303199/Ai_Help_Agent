import { runtimeConfig } from '../../config/runtimeConfig';
import { codingFetch } from './codingTransport';

export interface WorkspaceDirectoryEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface WorkspaceFileTreeNode extends WorkspaceDirectoryEntry {
  path: string;
  children?: WorkspaceFileTreeNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function listWorkspaceDirectory(path: string): Promise<WorkspaceDirectoryEntry[]> {
  if (window.electronAPI?.listDeveloperDirectory) {
    return window.electronAPI.listDeveloperDirectory(path);
  }
  const response = await codingFetch(
    `${runtimeConfig.services.http.baseUrl}/api/coding/list-directory?path=${encodeURIComponent(path)}`,
  );
  if (!response.ok) throw new Error(`Workspace listing failed with HTTP ${response.status}.`);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) throw new Error('Workspace listing returned an invalid response.');
  return value.flatMap((entry): WorkspaceDirectoryEntry[] => (
    typeof entry === 'object' && entry !== null
      && typeof entry.name === 'string'
      && (entry.type === 'file' || entry.type === 'directory')
      ? [{
          name: entry.name,
          type: entry.type,
          ...(typeof entry.size === 'number' && Number.isFinite(entry.size) ? { size: entry.size } : {}),
        }]
      : []
  ));
}

export async function readWorkspaceFile(path: string): Promise<{ path: string; content: string }> {
  if (window.electronAPI?.readDeveloperFile) {
    return window.electronAPI.readDeveloperFile(path);
  }
  const response = await codingFetch(
    `${runtimeConfig.services.http.baseUrl}/api/coding/read-file?path=${encodeURIComponent(path)}`,
  );
  if (!response.ok) throw new Error(`Workspace file read failed with HTTP ${response.status}.`);
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.content !== 'string') {
    throw new Error('Workspace file read returned an invalid response.');
  }
  return { path: value.path, content: value.content };
}

export async function loadWorkspaceFileTree(): Promise<{ nodes: WorkspaceFileTreeNode[]; truncated: boolean }> {
  const root: WorkspaceFileTreeNode[] = [];
  const pending: Array<{ path: string; nodes: WorkspaceFileTreeNode[]; depth: number }> = [
    { path: '.', nodes: root, depth: 0 },
  ];
  let visited = 0;
  let truncated = false;
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    if (current.depth >= 32 || visited >= 20000) {
      truncated = true;
      continue;
    }
    const entries = await listWorkspaceDirectory(current.path);
    for (const entry of entries) {
      if (visited >= 20000) {
        truncated = true;
        break;
      }
      visited += 1;
      const path = current.path === '.' ? entry.name : `${current.path}/${entry.name}`;
      const node: WorkspaceFileTreeNode = { ...entry, path };
      current.nodes.push(node);
      if (entry.type === 'directory') {
        pending.push({ path, nodes: node.children = [], depth: current.depth + 1 });
      }
    }
  }
  return { nodes: root, truncated };
}
