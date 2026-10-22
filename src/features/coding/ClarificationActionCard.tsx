interface ClarificationActionCardProps {
  prompt: string;
  targets: Array<{ path: string; classification: string }>;
  busy: boolean;
  onChoose: (resolution: 'UPDATE_AND_INTEGRATE' | 'REPLACE_TARGETS' | 'KEEP_AND_SCAFFOLD') => void;
}

const resolutions = [
  {
    id: 'UPDATE_AND_INTEGRATE',
    label: 'Update & Integrate Existing Files',
    detail: 'Include the identified existing targets in the approved integration proposal.',
  },
  {
    id: 'REPLACE_TARGETS',
    label: 'Replace Target Files',
    detail: 'Generate replacements for the identified targets; review the exact diff before approval.',
  },
  {
    id: 'KEEP_AND_SCAFFOLD',
    label: 'Keep Existing & Scaffold Missing',
    detail: 'Leave identified targets untouched and create a separate, statically wired scaffold.',
  },
] as const;

export function ClarificationActionCard({
  prompt,
  targets,
  busy,
  onChoose,
}: ClarificationActionCardProps) {
  return (
    <section aria-label="Workspace integration decision" className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="text-xs leading-relaxed text-amber-100">{prompt}</p>
      {targets.length > 0 && (
        <ul className="mt-2 space-y-1 text-[10px] text-slate-300">
          {targets.map((target) => (
            <li key={target.path} className="font-mono">
              {target.classification} · {target.path}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {resolutions.map((resolution) => (
          <button
            key={resolution.id}
            type="button"
            disabled={busy}
            title={resolution.detail}
            onClick={() => onChoose(resolution.id)}
            className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-[10px] font-medium text-sky-100 hover:bg-sky-500/20 disabled:opacity-40"
          >
            {resolution.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-slate-500">A selected action starts a new proposal. No workspace write occurs until you approve its exact diff.</p>
    </section>
  );
}
