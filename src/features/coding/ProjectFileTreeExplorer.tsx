import { useEffect, useMemo, useRef, useState } from 'react';
import {
  loadWorkspaceFileTree,
  readWorkspaceFile,
  type WorkspaceFileTreeNode,
} from './workspaceProjectApi';

interface AppliedFile {
  path: string;
}

interface ProjectFileTreeExplorerProps {
  projectRoot: string;
  refreshVersion: string | number;
  appliedFiles: AppliedFile[];
}

function formatSize(size?: number): string {
  if (size === undefined) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function filterTree(nodes: WorkspaceFileTreeNode[], query: string): WorkspaceFileTreeNode[] {
  if (!query) return nodes;
  return nodes.flatMap((node) => {
    const children = node.children ? filterTree(node.children, query) : [];
    return node.name.toLowerCase().includes(query) || children.length
      ? [{ ...node, children }]
      : [];
  });
}

export function ProjectFileTreeExplorer({ projectRoot, refreshVersion, appliedFiles }: ProjectFileTreeExplorerProps) {
  const [nodes, setNodes] = useState<WorkspaceFileTreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['.']));
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [changeBadges, setChangeBadges] = useState<Map<string, 'NEW' | 'MODIFIED'>>(() => new Map());
  const previousPaths = useRef<Set<string> | null>(null);
  const previousRoot = useRef(projectRoot);
  const appliedFilesKey = appliedFiles
    .map((file) => file.path.replace(/\\/g, '/').replace(/^\.\//, ''))
    .join('\n');

  useEffect(() => {
    let active = true;
    if (previousRoot.current !== projectRoot) {
      previousPaths.current = null;
      previousRoot.current = projectRoot;
    }
    setLoading(true);
    setError(null);
    void loadWorkspaceFileTree()
      .then((result) => {
        if (!active) return;
        const currentPaths = new Set<string>();
        const collectPaths = (items: WorkspaceFileTreeNode[]) => {
          items.forEach((node) => {
            currentPaths.add(node.path.replace(/\\/g, '/'));
            if (node.children) collectPaths(node.children);
          });
        };
        collectPaths(result.nodes);
        if (previousPaths.current) {
          const nextBadges = new Map<string, 'NEW' | 'MODIFIED'>();
          for (const path of appliedFilesKey.split('\n').filter(Boolean)) {
            if (currentPaths.has(path)) nextBadges.set(path, previousPaths.current.has(path) ? 'MODIFIED' : 'NEW');
          }
          setChangeBadges(nextBadges);
        } else {
          setChangeBadges(new Map());
        }
        previousPaths.current = currentPaths;
        setNodes(result.nodes);
        setTruncated(result.truncated);
        setExpanded(new Set(['.']));
        setSelected(null);
        setPreview('');
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [projectRoot, refreshVersion, appliedFilesKey, refreshAttempt]);

  const visibleNodes = useMemo(() => filterTree(nodes, search.trim().toLowerCase()), [nodes, search]);
  const appliedPaths = useMemo(() => new Set(appliedFilesKey.split('\n').filter(Boolean)), [appliedFilesKey]);

  const openFile = async (path: string) => {
    setSelected(path);
    setPreview('Loading preview…');
    try {
      const file = await readWorkspaceFile(path);
      setPreview(file.content);
    } catch (reason) {
      setPreview(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const renderNode = (node: WorkspaceFileTreeNode, depth = 0) => {
    const isDirectory = node.type === 'directory';
    const isExpanded = expanded.has(node.path) || Boolean(search.trim());
    return (
      <div key={node.path}>
        <button
          type="button"
          onClick={() => {
            if (isDirectory) {
              setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              });
            } else {
              void openFile(node.path);
            }
          }}
          className={`flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11px] hover:bg-slate-800 ${selected === node.path ? 'bg-slate-800 text-sky-200' : 'text-slate-300'}`}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          <span>{isDirectory ? (isExpanded ? '▾' : '▸') : '·'}</span>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {!isDirectory && <span className="shrink-0 text-[9px] text-slate-500">{formatSize(node.size)}</span>}
          {appliedPaths.has(node.path.replace(/\\/g, '/')) && changeBadges.get(node.path.replace(/\\/g, '/')) && (
            <span className="rounded bg-emerald-500/15 px-1 text-[9px] text-emerald-300">
              {changeBadges.get(node.path.replace(/\\/g, '/'))}
            </span>
          )}
        </button>
        {isDirectory && isExpanded && (node.children || []).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <section aria-label="Live project explorer" className="min-w-0 rounded-lg border border-slate-700 bg-slate-950/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-slate-200">Live project explorer</h3>
          <p className="truncate text-[10px] text-slate-500">{projectRoot}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500">{loading ? 'Loading…' : `${nodes.length} root entries`}</span>
          <button
            type="button"
            onClick={() => setRefreshAttempt((value) => value + 1)}
            disabled={loading}
            className="rounded border border-slate-600 px-2 py-1 text-[10px] text-slate-300 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>
      <input
        aria-label="Search project files"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search files and folders"
        className="mb-2 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-400"
      />
      {error && <p role="alert" className="mb-2 text-[11px] text-rose-300">{error}</p>}
      {truncated && <p role="status" className="mb-2 text-[10px] text-amber-300">Tree preview is bounded at 20,000 entries or 32 folder levels.</p>}
      <div className="grid min-h-40 gap-3 md:grid-cols-2">
        <div className="max-h-72 overflow-auto rounded border border-slate-800 p-1">
          {!loading && !error && nodes.length === 0
            ? <p className="p-3 text-[11px] text-slate-400">This attached folder is empty and ready for files.</p>
            : visibleNodes.map((node) => renderNode(node))}
        </div>
        <div className="min-h-40 overflow-auto rounded border border-slate-800 bg-slate-950 p-2">
          <p className="mb-1 truncate text-[10px] text-slate-500">{selected || 'Select a file to preview it'}</p>
          {selected && <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-slate-300">{preview}</pre>}
        </div>
      </div>
    </section>
  );
}
