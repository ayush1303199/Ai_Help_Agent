import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { EyeOff, Minus, PanelTop, Plus, Search, Sparkles, X } from 'lucide-react';
import { renderAnswerMarkdown } from './ui/answerMarkdown';

type OverlayVisibility = 'VISIBLE' | 'MINIMIZED' | 'HIDDEN';
type OverlayTab = 'answer' | 'analysis' | 'summary' | 'action-items';

type OverlayBounds = { x: number; y: number; width: number; height: number };
const OVERLAY_MIN_OPACITY = 0.2;
const OVERLAY_MAX_OPACITY = 1;
const OVERLAY_OPACITY_STEP = 0.1;

type OverlayState = {
  answer?: string;
  question?: string;
  analysis?: string | string[] | null;
  summary?: string | string[] | null;
  actionItems?: unknown;
  status?: string;
  visibility?: OverlayVisibility;
  lowVisibility?: boolean;
  opacity?: number;
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
  opacity: 1,
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
  if (typeof incoming.opacity === 'number' && Number.isFinite(incoming.opacity)) {
    next.opacity = Math.min(OVERLAY_MAX_OPACITY, Math.max(OVERLAY_MIN_OPACITY, incoming.opacity));
  }
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
  const [searchText, setSearchText] = useState('');
  const [searchError, setSearchError] = useState('');
  const timerRef = useRef<number | null>(null);
  const overlayChannelRef = useRef<BroadcastChannel | null>(null);

  const activeTab = state.activeTab ?? 'answer';
  const statusLabel = getStatusLabel(state.status);
  const effectiveLowVisibility = state.visibility === 'VISIBLE' && (state.lowVisibility === true || interactiveLowVisibility);
  const opacity = state.opacity ?? 1;
  const opacityPercent = Math.round(opacity * 100);
  const visualOpacity = effectiveLowVisibility && !isHovered && !isFocused
    ? Math.min(opacity, 0.38)
    : opacity;

  const adjustOpacity = (delta: number) => {
    const nextOpacity = Math.min(
      OVERLAY_MAX_OPACITY,
      Math.max(OVERLAY_MIN_OPACITY, Math.round((opacity + delta) * 10) / 10),
    );
    if (nextOpacity !== opacity) void applyPreferences({ opacity: nextOpacity });
  };

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
      if (event.data.type === 'overlay-search-error' && typeof event.data.message === 'string') {
        setSearchError(event.data.message);
      }
      if (event.data.type === 'overlay-ready') {
        channel?.postMessage({ type: 'state' });
      }
    };

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel('meeting-ai-overlay');
        channel.onmessage = handleChannelMessage;
        overlayChannelRef.current = channel;
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
      overlayChannelRef.current = null;
    };
  }, []);

  const submitOverlaySearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = searchText.trim();
    if (!question) return;
    if (!overlayChannelRef.current) {
      setSearchError('AI search is unavailable. Reopen the assistant window and try again.');
      return;
    }
    setState((previous) => ({ ...previous, activeTab: 'answer', status: 'thinking' }));
    void applyPreferences({ activeTab: 'answer' });
    overlayChannelRef.current.postMessage({ type: 'overlay-question', question });
    setSearchText('');
    setSearchError('');
  };

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
      style={{ opacity: visualOpacity }}
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
          <div className="overlay-opacity-controls" aria-label="Overlay transparency controls">
            <button
              type="button"
              className="overlay-icon-button"
              aria-label="Decrease overlay opacity (more transparent)"
              title="More transparent"
              onClick={() => adjustOpacity(-OVERLAY_OPACITY_STEP)}
              disabled={opacity <= OVERLAY_MIN_OPACITY}
            >
              <Minus size={14} />
            </button>
            <span className="overlay-opacity-label" aria-live="polite">Opacity {opacityPercent}%</span>
            <button
              type="button"
              className="overlay-icon-button"
              aria-label="Increase overlay opacity (less transparent)"
              title="Less transparent"
              onClick={() => adjustOpacity(OVERLAY_OPACITY_STEP)}
              disabled={opacity >= OVERLAY_MAX_OPACITY}
            >
              <Plus size={14} />
            </button>
          </div>
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

      <form className="overlay-search no-drag" onSubmit={submitOverlaySearch}>
        <label className="overlay-search-label" htmlFor="overlay-ai-search">Ask AI</label>
        <div className="overlay-search-row">
          <input
            id="overlay-ai-search"
            value={searchText}
            onChange={(event) => {
              setSearchText(event.target.value);
              if (searchError) setSearchError('');
            }}
            placeholder="Search with AI..."
            aria-label="Search with AI"
            maxLength={2000}
          />
          <button type="submit" className="overlay-search-button" disabled={!searchText.trim()} aria-label="Send search to AI">
            <Search size={15} />
            <span>Ask</span>
          </button>
        </div>
        {searchError && <p className="overlay-search-error" role="alert">{searchError}</p>}
      </form>

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
