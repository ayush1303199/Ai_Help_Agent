import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { renderAnswerMarkdown } from './App';

type OverlayState = {
  answer: string;
  status: string;
};

function closeOverlay() {
  void window.electronAPI?.closeOverlay();
  if (!window.electronAPI) window.close();
}

export default function Overlay() {
  const [state, setState] = useState<OverlayState>({ answer: '', status: 'ready' });

  useEffect(() => {
    document.documentElement.classList.add('overlay-document');
    document.body.classList.add('overlay-body');
    if (typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel('meeting-ai-overlay');
    channel.onmessage = (event) => {
      if (event.data?.type === 'state') {
        setState({ answer: String(event.data.answer || ''), status: String(event.data.status || 'ready') });
      }
    };
    channel.postMessage({ type: 'overlay-ready' });
    return () => {
      channel.close();
      document.documentElement.classList.remove('overlay-document');
      document.body.classList.remove('overlay-body');
    };
  }, []);

  const statusLabel = state.status === 'listening'
    ? 'Listening'
    : state.status === 'thinking'
      ? 'Thinking'
      : state.status === 'answer'
        ? 'Answer ready'
        : state.status === 'transcribing'
          ? 'Transcribing'
          : 'Ready';

  return (
    <main className="overlay-shell">
      <div className="overlay-dragbar">
        <span className="overlay-status"><span className="overlay-dot" />{statusLabel}</span>
        <button className="overlay-close no-drag" onClick={closeOverlay} aria-label="Close overlay"><X className="h-4 w-4" /></button>
      </div>
      <section className="overlay-answer">
        {state.answer ? renderAnswerMarkdown(state.answer) : <p className="overlay-placeholder">Waiting for an answer...</p>}
      </section>
    </main>
  );
}
