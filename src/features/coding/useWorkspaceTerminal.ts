import { useMemo, useState } from 'react';
import type { CodingActivity } from './codingTransport';
import { loadWorkspaceFileTree, readWorkspaceFile } from './workspaceProjectApi';

export interface WorkspaceTerminalEntry {
  id: string;
  timestamp: string;
  label: string;
  detail: string;
}

interface UseWorkspaceTerminalOptions {
  activity: CodingActivity[];
  projectRoot: string | null;
  projectStatus?: string;
  brokerStatus: string;
  onSynchronizeBroker: () => void | Promise<void>;
}

function activityEntry(item: CodingActivity): WorkspaceTerminalEntry {
  if (!('event' in item)) {
    return {
      id: item.id,
      timestamp: item.timestamp || new Date().toISOString(),
      label: `[${item.phase.toUpperCase()}]`,
      detail: item.message,
    };
  }
  const result = item.result;
  const details = [
    result?.executionStatus,
    result?.command ? `command: ${result.command}` : '',
    result?.exitCode !== undefined ? `exit: ${result.exitCode ?? 'not run'}` : '',
    result?.evidenceState ? `evidence: ${result.evidenceState}` : '',
    result?.paths?.length ? `files: ${result.paths.join(', ')}` : '',
    item.error?.message || '',
  ].filter(Boolean).join(' · ');
  const output = [result?.stdout && `stdout:\n${result.stdout}`, result?.stderr && `stderr:\n${result.stderr}`]
    .filter(Boolean)
    .join('\n');
  return {
    id: item.activityId,
    timestamp: item.timestamp,
    label: `[${item.activityType}:${item.status}]`,
    detail: `${item.action.tool}${item.action.target ? ` · ${item.action.target}` : ''}${details ? ` · ${details}` : ''}${output ? `\n${output}` : ''}`,
  };
}

export function useWorkspaceTerminal({
  activity,
  projectRoot,
  projectStatus,
  brokerStatus,
  onSynchronizeBroker,
}: UseWorkspaceTerminalOptions) {
  const [manualEntries, setManualEntries] = useState<WorkspaceTerminalEntry[]>([]);
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const activityEntries = useMemo(
    () => activity.map(activityEntry).filter((entry) => !clearedAt || entry.timestamp > clearedAt),
    [activity, clearedAt],
  );
  const entries = useMemo(
    () => [...activityEntries, ...manualEntries].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-500),
    [activityEntries, manualEntries],
  );

  const append = (label: string, detail: string) => {
    setManualEntries((previous) => [...previous, {
      id: `terminal-${Date.now()}-${Math.random()}`,
      timestamp: new Date().toISOString(),
      label,
      detail,
    }].slice(-200));
  };

  const runCommand = async (rawCommand = command) => {
    const [name, ...arguments_] = rawCommand.trim().split(/\s+/);
    const argument = arguments_.join(' ');
    if (!name) return;
    if (name === 'clear') {
      setManualEntries([]);
      setClearedAt(new Date().toISOString());
      setCommand('');
      return;
    }
    setBusy(true);
    try {
      if (!projectRoot) throw new Error('Attach a trusted workspace before using inspection commands.');
      if (name === 'status') {
        append('[STATUS]', `Project ${projectStatus || 'unknown'} · broker ${brokerStatus} · shell execution blocked unless isolation is verified.`);
      } else if (name === 'tree') {
        const result = await loadWorkspaceFileTree();
        const paths: string[] = [];
        const collectPaths = (nodes: Awaited<ReturnType<typeof loadWorkspaceFileTree>>['nodes']) => {
          for (const node of nodes) {
            paths.push(`${node.type === 'directory' ? '📁' : '📄'} ${node.path}`);
            if (node.children) collectPaths(node.children);
          }
        };
        collectPaths(result.nodes);
        const shown = paths.slice(0, 200);
        append('[TREE]', `${paths.length} authorized workspace entries${result.truncated ? ' (bounded preview)' : ''}:\n${shown.join('\n')}${paths.length > shown.length ? `\n… ${paths.length - shown.length} more entries omitted` : ''}`);
      } else if (name === 'cat' && argument) {
        const file = await readWorkspaceFile(argument);
        append(`[CAT ${file.path}]`, file.content.slice(0, 16000) || '(empty file)');
      } else if (name === 'verify-routes') {
        const latest = activity.slice().reverse().find((item) => (
          'event' in item && /verif|route|integration/i.test(`${item.activityType} ${item.action.tool}`)
        ));
        const result = latest && 'event' in latest ? latest.result : undefined;
        append('[VERIFY:STATIC_WIRING]', result?.executionStatus
          ? `Latest recorded result: ${result.executionStatus}${result.exitCode !== undefined ? ` (exit ${result.exitCode ?? 'not run'})` : ''}. No generated project code was run by this command.`
          : 'No route verification result is recorded. This read-only command does not execute project code or claim live reachability.');
      } else if (name === 'resync-broker') {
        append('[BROKER]', 'Trusted broker synchronization requested.');
        await onSynchronizeBroker();
      } else if (name === 'cat') {
        throw new Error('Usage: cat <workspace-relative-file>');
      } else {
        throw new Error('Supported safe commands: tree, cat <file>, status, verify-routes, resync-broker, clear.');
      }
    } catch (error) {
      append('[ERROR]', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setCommand('');
    }
  };

  return {
    entries,
    command,
    setCommand,
    busy,
    runCommand,
    copy: async () => navigator.clipboard.writeText(entries
      .map((entry) => `${entry.timestamp} ${entry.label} ${entry.detail}`)
      .join('\n')),
  };
}
