import { AlertCircle } from 'lucide-react';
import { AnswerSessionView } from '../../ui/AnswerSessionView';
import type { MeetingAudioMode } from '../../app/appTypes';

interface AnsweredSegment {
  question: string;
  answer: string;
}

interface MeetingAssistantWorkspaceProps {
  sessionActive: boolean;
  meetingAudioMode: MeetingAudioMode;
  displayedAudioSourceLabel: string;
  displayedAudioStatus: string;
  microphoneStatus: string;
  systemAudioStatus: string;
  audioLevel: number;
  meetingMenuOpen: boolean;
  statusTone: string;
  statusLabel: string;
  pipelineStatus: string;
  liveTranscript: string;
  lastQuestion: string;
  lastAnswer: string;
  answeredSegments: AnsweredSegment[];
  transcriptOpen: boolean;
  error: string;
  input: string;
  isRecording: boolean;
  isTranscribing: boolean;
  chatStreaming: boolean;
  onAudioModeChange: (mode: MeetingAudioMode) => void;
  onTestAudio: () => void;
  onStartCapture: () => void;
  onStopCapture: () => void;
  onTranscriptToggle: () => void;
  onInputChange: (value: string) => void;
  onSendMessage: () => void;
}

const audioModeLabels: Record<MeetingAudioMode, string> = {
  microphone: 'Microphone',
  system: 'System / Internal Audio',
  meeting: 'Microphone + System / Internal Audio',
};

export function MeetingAssistantWorkspace({
  sessionActive,
  meetingAudioMode,
  displayedAudioSourceLabel,
  displayedAudioStatus,
  microphoneStatus,
  systemAudioStatus,
  audioLevel,
  meetingMenuOpen,
  statusTone,
  statusLabel,
  pipelineStatus,
  liveTranscript,
  lastQuestion,
  lastAnswer,
  answeredSegments,
  transcriptOpen,
  error,
  input,
  isRecording,
  isTranscribing,
  chatStreaming,
  onAudioModeChange,
  onTestAudio,
  onStartCapture,
  onStopCapture,
  onTranscriptToggle,
  onInputChange,
  onSendMessage,
}: MeetingAssistantWorkspaceProps) {
  if (!sessionActive) {
    return (
      <section className="m-auto w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900/80 p-6 shadow-2xl">
        <div className="mb-6 text-center"><h2 className="text-2xl font-semibold">Meeting AI Assistant</h2><p className="mt-2 text-sm text-slate-400">Listen to internal system audio and get concise answers.</p></div>
        <div className="space-y-4">
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">Audio source<select value={meetingAudioMode} onChange={(event) => onAudioModeChange(event.target.value as MeetingAudioMode)} aria-label="Audio source" className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-200"><option value="microphone">Microphone (spoken questions)</option><option value="system">System / Internal Audio (meeting sound)</option><option value="meeting">Microphone + System / Internal Audio</option></select></label>
          <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm"><div className="flex justify-between"><span className="text-slate-400">Device</span><span className="max-w-[12rem] truncate text-slate-200">{displayedAudioSourceLabel}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">Audio status</span><span className="text-emerald-300">● {displayedAudioStatus}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">Microphone</span><span className={`font-semibold ${microphoneStatus === 'connected' ? 'text-emerald-300' : 'text-slate-500'}`}>{microphoneStatus === 'connected' ? 'ON' : 'OFF'}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">System audio</span><span className={`font-semibold ${systemAudioStatus === 'connected' || systemAudioStatus === 'testing' ? 'text-emerald-300' : 'text-slate-500'}`}>{systemAudioStatus === 'testing' ? 'TESTING' : systemAudioStatus === 'connected' ? 'ON' : 'OFF'}</span></div><div className="mt-3"><div className="mb-1 flex justify-between text-[11px] text-slate-500"><span>Audio level</span><span>{audioLevel}%</span></div><div className="flex h-2 gap-1">{Array.from({ length: 10 }, (_, index) => <span key={index} className={`flex-1 rounded ${audioLevel >= (index + 1) * 10 ? 'bg-emerald-400' : 'bg-slate-700'}`} />)}</div></div></div>
          <p className="text-center text-[11px] text-slate-500">Choose microphone, internal system audio, or both. System audio requires the Electron desktop app and a playback source.</p>
          <div className="flex gap-2"><button type="button" onClick={onTestAudio} className="flex-1 rounded-lg border border-emerald-500/40 px-3 py-2.5 text-sm text-emerald-300 hover:bg-emerald-500/10">Test Audio</button><button type="button" onClick={onStartCapture} className="flex-1 rounded-lg bg-emerald-500 px-3 py-2.5 text-sm font-medium text-slate-950 hover:bg-emerald-400">Start Listening</button></div>
          {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs leading-relaxed text-rose-300"><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col">
      {meetingMenuOpen && <div className="mb-4 rounded-xl border border-slate-700 bg-slate-900 p-4 text-xs"><div className="flex justify-between"><span className="text-slate-400">Audio source</span><span>{audioModeLabels[meetingAudioMode]}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">Device</span><span className="max-w-[14rem] truncate">{displayedAudioSourceLabel}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">Audio status</span><span>{displayedAudioStatus}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">Microphone</span><span className={microphoneStatus === 'connected' ? 'text-emerald-300' : 'text-slate-500'}>{microphoneStatus === 'connected' ? 'ON' : 'OFF'}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">System audio</span><span className={systemAudioStatus === 'connected' ? 'text-emerald-300' : 'text-slate-500'}>{systemAudioStatus === 'connected' ? 'ON' : 'OFF'}</span></div>{isRecording || isTranscribing ? <button type="button" onClick={onStopCapture} className="mt-3 rounded-lg border border-slate-600 px-3 py-2 text-slate-300 hover:border-rose-400">Stop Listening</button> : <button type="button" onClick={onStartCapture} className="mt-3 rounded-lg border border-emerald-500/40 px-3 py-2 text-emerald-300 hover:border-emerald-400">Start Listening</button>}</div>}
      <div className="mb-5 text-center"><p className={`text-sm font-medium ${statusTone}`}>● {statusLabel}</p><p className="mt-2 text-xs text-slate-500">{pipelineStatus === 'listening' ? 'Listening for a question' : pipelineStatus === 'thinking' ? 'Generating answer...' : 'Your answer will appear below'}</p></div>
      <div className="mb-4"><p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-slate-500">Last heard</p><p className="truncate text-sm text-slate-300">{liveTranscript || 'Waiting for speech...'}</p></div>
      <AnswerSessionView lastQuestion={lastQuestion} lastAnswer={lastAnswer} isThinking={pipelineStatus === 'thinking'} answeredSegments={answeredSegments} />
      <div className="mt-4 flex items-center justify-between"><button type="button" onClick={onTranscriptToggle} className="text-xs text-emerald-300 hover:text-emerald-200">{transcriptOpen ? 'Hide full transcript' : 'View full transcript'}</button>{isRecording || isTranscribing ? <button type="button" onClick={onStopCapture} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-rose-400">Stop Listening</button> : <button type="button" onClick={onStartCapture} className="rounded-lg border border-emerald-500/40 px-3 py-2 text-xs text-emerald-300 hover:border-emerald-400">Start Listening</button>}</div>
      {transcriptOpen && <div className="mt-3 max-h-48 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm leading-relaxed text-slate-300">{liveTranscript || 'No transcript captured yet.'}</div>}
      {error && <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}
      <div className="mt-5 flex gap-2"><input value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSendMessage(); } }} placeholder="Ask a text question..." className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400" /><button onClick={onSendMessage} disabled={!input.trim() || chatStreaming} className="rounded-lg bg-emerald-500 px-4 text-sm font-medium text-slate-950 disabled:opacity-40">Send</button></div>
    </section>
  );
}
