import { useCallback, useEffect, useRef, useState } from 'react';
import { EyeOff, Minus, PanelTop, Sparkles, X } from 'lucide-react';
import { renderAnswerMarkdown } from './ui/answerMarkdown';

type OverlayVisibility = 'VISIBLE' | 'MINIMIZED' | 'HIDDEN';
type OverlayTab = 'answer' | 'analysis' | 'summary' | 'action-items';

type OverlayBounds = { x: number; y: number; width: number; height: number };

type OverlayState = {
  answer?: string;
  question?: string;
  analysis?: string | string[] | null;
  summary?: string | string[] | null;
  actionItems?: unknown;
  status?: string;
  visibility?: OverlayVisibility;
  lowVisibility?: boolean;
  autoHideEnabled?: boolean;
  autoHideDelay?: number;
  alwaysOnTop?: boolean;
  activeTab?: OverlayTab;
  bounds?: OverlayBounds;
  expandedBounds?: OverlayBounds;
};

const defaultOverlayState: OverlayState = {
  answer: '',
  question: '',
  analysis: null,
  summary: null,
  actionItems: null,
  status: 'ready',
  visibility: 'VISIBLE',
  lowVisibility: false,
  autoHideEnabled: true,
  autoHideDelay: 5000,
  alwaysOnTop: true,
  activeTab: 'answer',
  bounds: { x: 0, y: 0, width: 620, height: 420 },
  expandedBounds: { x: 0, y: 0, width: 620, height: 420 },
};

const tabConfig: Array<{ id: OverlayTab; label: string }> = [
  { id: 'answer', label: 'AI Answer' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'summary', label: 'Summary' },
  { id: 'action-items', label: 'Action items' },
];

function normalizeTabContent(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => normalizeTabContent(item)).filter(Boolean).join('\n\n');
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return '';
}

function getStatusLabel(status?: string) {
  switch (status) {
    case 'listening':
      return 'Listening';
    case 'thinking':
      return 'Thinking';
    case 'answer':
      return 'Answer ready';
    case 'transcribing':
      return 'Transcribing';
    default:
      return 'Ready';
  }
}

function renderTabBody(tab: OverlayTab, state: OverlayState) {
  const fallbackCopy: Record<OverlayTab, string> = {
    answer: 'No answer received yet.',
    analysis: 'No analysis available yet.',
    summary: 'No summary available yet.',
    'action-items': 'No action items were provided.',
  };

  let content = '';
  if (tab === 'answer') {
    content = normalizeTabContent(state.answer ?? '');
  } else if (tab === 'analysis') {
    content = normalizeTabContent(state.analysis ?? '');
  } else if (tab === 'summary') {
    content = normalizeTabContent(state.summary ?? '');
  } else {
    const actionItems = state.actionItems;
    content = normalizeTabContent(actionItems);
  }

  if (!content.trim()) {
    if (tab !== 'answer' || !state.question?.trim()) {
      return <p className="overlay-empty-state">{fallbackCopy[tab]}</p>;
    }
  }

  return (
    <div className="overlay-tab-scroll">
      {tab === 'answer' && state.question?.trim() && (
        <div className="overlay-question" aria-label="Detected question">
          <span className="overlay-question-label">Question</span>
          <p>{state.question.trim()}</p>
        </div>
      )}
      {content.trim() ? renderAnswerMarkdown(content) : <p className="overlay-empty-state">{fallbackCopy[tab]}</p>}
    </div>
  );
}

function closeOverlay() {
  void window.electronAPI?.closeOverlay();
  if (!window.electronAPI) window.close();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeOverlayState(previous: OverlayState, incoming: unknown): OverlayState {
  if (!isRecord(incoming)) return previous;
  const next = { ...previous };
  if (typeof incoming.answer === 'string') next.answer = incoming.answer;
  if (typeof incoming.status === 'string') next.status = incoming.status;
  if (incoming.analysis === null || typeof incoming.analysis === 'string' || Array.isArray(incoming.analysis)) {
    next.analysis = incoming.analysis as OverlayState['analysis'];
  }
  if (incoming.summary === null || typeof incoming.summary === 'string' || Array.isArray(incoming.summary)) {
    next.summary = incoming.summary as OverlayState['summary'];
  }
  if (Object.prototype.hasOwnProperty.call(incoming, 'actionItems')) next.actionItems = incoming.actionItems;
  if (incoming.visibility === 'VISIBLE' || incoming.visibility === 'MINIMIZED' || incoming.visibility === 'HIDDEN') {
    next.visibility = incoming.visibility;
  }
  if (typeof incoming.lowVisibility === 'boolean') next.lowVisibility = incoming.lowVisibility;
  if (typeof incoming.autoHideEnabled === 'boolean') next.autoHideEnabled = incoming.autoHideEnabled;
  if (typeof incoming.autoHideDelay === 'number' && Number.isFinite(incoming.autoHideDelay)) {
    next.autoHideDelay = incoming.autoHideDelay;
  }
  if (typeof incoming.alwaysOnTop === 'boolean') next.alwaysOnTop = incoming.alwaysOnTop;
  if (incoming.activeTab === 'answer' || incoming.activeTab === 'analysis' || incoming.activeTab === 'summary' || incoming.activeTab === 'action-items') {
    next.activeTab = incoming.activeTab;
  }
  const incomingBounds = incoming.bounds;
  if (isRecord(incomingBounds)
    && ['x', 'y', 'width', 'height'].every((key) => typeof incomingBounds[key] === 'number' && Number.isFinite(incomingBounds[key]))) {
    next.bounds = incomingBounds as OverlayBounds;
  }
  const incomingExpandedBounds = incoming.expandedBounds;
  if (isRecord(incomingExpandedBounds)
    && ['x', 'y', 'width', 'height'].every((key) => typeof incomingExpandedBounds[key] === 'number' && Number.isFinite(incomingExpandedBounds[key]))) {
    next.expandedBounds = incomingExpandedBounds as OverlayBounds;
  }
  return next;
}

export default function Overlay() {
  const [state, setState] = useState<OverlayState>(defaultOverlayState);
  const [interactiveLowVisibility, setInteractiveLowVisibility] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const timerRef = useRef<number | null>(null);

  const activeTab = state.activeTab ?? 'answer';
  const statusLabel = getStatusLabel(state.status);
  const effectiveLowVisibility = state.visibility === 'VISIBLE' && (state.lowVisibility === true || interactiveLowVisibility);

  const applyPreferences = useCallback(async (patch: Partial<OverlayState>) => {
    setState((previous) => mergeOverlayState(previous, patch));
    if (!window.electronAPI) return;
    try {
      const persisted = await window.electronAPI.setOverlayPreferences(patch);
      setState((previous) => mergeOverlayState(previous, persisted));
    } catch {
      const persisted = await window.electronAPI.getOverlayPreferences().catch(() => null);
      if (persisted) setState((previous) => mergeOverlayState(previous, persisted));
    }
  }, []);

  const runOverlayAction = (action: (() => Promise<OverlayRendererState>) | undefined) => {
    if (!action) return;
    void action()
      .then((nextState) => setState((previous) => mergeOverlayState(previous, nextState)))
      .catch(() => {
        void window.electronAPI?.getOverlayPreferences()
          .then((nextState) => setState((previous) => mergeOverlayState(previous, nextState)))
          .catch(() => undefined);
      });
  };

  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    const handleChannelMessage = (event: MessageEvent<unknown>) => {
      if (!isRecord(event.data)) return;
      if (event.data.type === 'state') {
        setState((previous) => mergeOverlayState(previous, event.data));
      }
      if (event.data.type === 'overlay-ready') {
        channel?.postMessage({ type: 'state' });
      }
    };

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel('meeting-ai-overlay');
        channel.onmessage = handleChannelMessage;
        channel.postMessage({ type: 'overlay-ready' });
      } catch {
        channel = null;
      }
    }

    const removeOverlayStateListener = window.electronAPI?.onOverlayState((nativeState) => {
      setState((previous) => mergeOverlayState(previous, nativeState));
    });
    void window.electronAPI?.getOverlayPreferences().then((preferences) => {
      if (preferences) {
        setState((previous) => mergeOverlayState(previous, preferences));
      }
    }).catch(() => undefined);

    return () => {
      removeOverlayStateListener?.();
      if (channel) {
        channel.onmessage = null;
        channel.close();
      }
    };
  }, []);

  useEffect(() => {
    if (state.visibility !== 'VISIBLE' || !state.autoHideEnabled) {
      setInteractiveLowVisibility(false);
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (isHovered || isFocused) {
      setInteractiveLowVisibility(false);
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    timerRef.current = window.setTimeout(() => {
      setInteractiveLowVisibility(true);
      void applyPreferences({ lowVisibility: true });
    }, Number(state.autoHideDelay ?? 5000));

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [state.visibility, state.autoHideEnabled, state.autoHideDelay, isHovered, isFocused, applyPreferences]);

  useEffect(() => {
    if (state.visibility !== 'VISIBLE') return;
    if (isHovered || isFocused) {
      const nextLowVisibility = false;
      if (state.lowVisibility !== nextLowVisibility || interactiveLowVisibility) {
        setInteractiveLowVisibility(false);
        void applyPreferences({ lowVisibility: false });
      }
    }
  }, [state.lowVisibility, interactiveLowVisibility, isHovered, isFocused, state.visibility, applyPreferences]);

  if (state.visibility === 'HIDDEN') return null;

  if (state.visibility === 'MINIMIZED') {
    return (
      <div className="overlay-mini-shell" role="status" aria-live="polite">
        <div className="overlay-mini-glow" />
        <div className="overlay-mini-main">
          <div className="overlay-mini-icon"><Sparkles size={14} /></div>
          <div className="overlay-mini-copy">
            <strong>Assistant</strong>
            <span>{statusLabel}</span>
          </div>
        </div>
        <div className="overlay-mini-actions">
          <button type="button" className="overlay-mini-button no-drag" aria-label="Expand overlay" onClick={() => runOverlayAction(window.electronAPI?.expandOverlay)}>
            <PanelTop size={14} />
          </button>
          <button type="button" className="overlay-mini-button no-drag" aria-label="Hide overlay" onClick={() => runOverlayAction(window.electronAPI?.hideOverlay)}>
            <EyeOff size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <main
      className={`overlay-shell ${effectiveLowVisibility ? 'overlay-shell-low-visibility' : ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocusCapture={() => setIsFocused(true)}
      onBlurCapture={() => setIsFocused(false)}
    >
      <header className="overlay-header" aria-label="Overlay controls">
        <div className="overlay-header-title">
          <span className="overlay-brand-mark"><Sparkles size={12} /></span>
          <div>
            <strong>Assistant</strong>
            <small>{statusLabel}</small>
          </div>
        </div>
        <div className="overlay-controls no-drag">
          <button
            type="button"
            className="overlay-action-button"
            aria-label={state.autoHideEnabled ? 'Disable auto hide' : 'Enable auto hide'}
            onClick={() => void applyPreferences({ autoHideEnabled: !state.autoHideEnabled })}
          >
            {state.autoHideEnabled ? 'Auto hide on' : 'Auto hide off'}
          </button>
          <button type="button" className="overlay-icon-button" aria-label="Minimize overlay" onClick={() => runOverlayAction(window.electronAPI?.minimizeOverlay)}>
            <Minus size={14} />
          </button>
          <button type="button" className="overlay-action-button overlay-hide-button" aria-label="Hide assistant overlay" title="Hide assistant overlay" onClick={() => runOverlayAction(window.electronAPI?.hideOverlay)}>
            <EyeOff size={14} />
            <span>Hide</span>
          </button>
          <button type="button" className="overlay-icon-button overlay-icon-button-danger" aria-label="Close overlay" title="Close assistant overlay" onClick={closeOverlay}>
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="overlay-tabs no-drag" role="tablist" aria-label="Assistant overlay tabs">
        {tabConfig.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`overlay-tab-${tab.id}`}
            aria-controls={`overlay-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            className={`overlay-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => void applyPreferences({ activeTab: tab.id })}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section
        id={`overlay-panel-${activeTab}`}
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={`overlay-tab-${activeTab}`}
        className="overlay-view"
        aria-live="polite"
      >
        {renderTabBody(activeTab, state)}
      </section>
    </main>
  );
}
