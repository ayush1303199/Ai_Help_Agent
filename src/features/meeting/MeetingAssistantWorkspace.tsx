import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { AnswerSessionView } from '../../ui/AnswerSessionView';
import type { MeetingAudioMode } from '../../app/appTypes';
import type { MeetingHistoryRetentionDays } from '../../history/historyService';
import type { MeetingTranscriptionLanguage } from './useMeetingAssistantController';
import { ScreenReadingButton } from '../screen-reading/ScreenReadingButton';
import { HistoryRetentionControl } from '../history/HistoryRetentionControl';
import { meetingAudioDiagnostic } from './meetingTranscriptQuality';

interface AnsweredSegment {
  question: string;
  answer: string;
}

interface SavedTranscript {
  id: string;
  source: string;
  text: string;
  createdAt?: string;
}

interface StageTimings {
  transcriptionMs?: number;
  answerMs?: number;
}

interface MeetingAssistantWorkspaceProps {
  sessionActive: boolean;
  meetingAudioMode: MeetingAudioMode;
  transcriptionLanguage: MeetingTranscriptionLanguage;
  reviewBeforeSend: boolean;
  pendingTranscriptReviews: { id: string; text: string }[];
  displayedAudioSourceLabel: string;
  displayedAudioStatus: string;
  microphoneStatus: string;
  microphoneUnavailable: boolean;
  systemAudioStatus: string;
  audioLevel: number;
  audioSignalDetected: boolean;
  meetingMenuOpen: boolean;
  statusLabel: string;
  pipelineStatus: string;
  pipelineElapsedMs: number;
  lastStageTimings: StageTimings;
  liveTranscript: string;
  lastQuestion: string;
  lastAnswer: string;
  answeredSegments: AnsweredSegment[];
  transcripts: SavedTranscript[];
  transcriptSearch: string;
  filteredTranscripts: SavedTranscript[];
  transcriptOpen: boolean;
  error: string;
  input: string;
  isRecording: boolean;
  isTranscribing: boolean;
  chatStreaming: boolean;
  onAudioModeChange: (mode: MeetingAudioMode) => void;
  onTranscriptionLanguageChange: (language: MeetingTranscriptionLanguage) => void;
  onReviewBeforeSendChange: (enabled: boolean) => void;
  onSendReviewedTranscript: (id: string, text: string) => void;
  onSkipReviewedTranscript: (id: string) => void;
  onTestAudio: () => void;
  onStartCapture: () => void;
  onStopCapture: () => void;
  onCancelRequest: () => boolean;
  onOpenAudioSettings: () => void;
  onTranscriptToggle: () => void;
  onInputChange: (value: string) => void;
  onSendMessage: () => void;
  onReadScreen: () => void;
  screenReading: boolean;
  screenReadingEnabled: boolean;
  onTranscriptSearchChange: (value: string) => void;
  onUseTranscript: (transcript: SavedTranscript) => void;
  onSaveTranscript: () => void;
  onSendTranscript: (text: string) => void;
  onDeleteTranscript: (id: string) => void;
  onClearHistory: () => void;
  historyRetentionDays: MeetingHistoryRetentionDays;
  onRetentionDaysChange: (days: MeetingHistoryRetentionDays) => void;
}

function SavedMeetingHistory({
  transcripts,
  filteredTranscripts,
  transcriptSearch,
  answeredCount,
  onTranscriptSearchChange,
  onUseTranscript,
  onDeleteTranscript,
  onClearHistory,
}: {
  transcripts: SavedTranscript[];
  filteredTranscripts: SavedTranscript[];
  transcriptSearch: string;
  answeredCount: number;
  onTranscriptSearchChange: (value: string) => void;
  onUseTranscript: (transcript: SavedTranscript) => void;
  onDeleteTranscript: (id: string) => void;
  onClearHistory: () => void;
}) {
  const [copiedTranscriptId, setCopiedTranscriptId] = useState('');
  const [transcriptActionError, setTranscriptActionError] = useState('');
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);

  const copyTranscript = async (transcript: SavedTranscript) => {
    try {
      await navigator.clipboard.writeText(transcript.text);
      setCopiedTranscriptId(transcript.id);
      setTranscriptActionError('');
    } catch (error) {
      setTranscriptActionError(error instanceof Error
        ? `Could not copy transcript: ${error.message}`
        : 'Could not copy transcript. Check clipboard permission.');
    }
  };

  return (
    <div className="space-y-3 border-t border-slate-800 pt-3">
      {transcripts.length > 0 ? (
        <>
          <input value={transcriptSearch} onChange={(event) => onTranscriptSearchChange(event.target.value)} placeholder="Search saved transcripts" aria-label="Search saved transcripts" className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 outline-none" />
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {filteredTranscripts.map((transcript) => (
              <div key={transcript.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-slate-800">
                <button type="button" onClick={() => onUseTranscript(transcript)} className="min-w-0 flex-1 text-left text-xs text-slate-300">
                  <span className="text-emerald-300">{transcript.source}</span> {transcript.text}
                </button>
                <button type="button" onClick={() => void copyTranscript(transcript)} className="shrink-0 text-[11px] text-slate-400 hover:text-emerald-300">
                  {copiedTranscriptId === transcript.id ? 'Copied' : 'Copy'}
                </button>
                <button type="button" onClick={() => onDeleteTranscript(transcript.id)} className="shrink-0 text-[11px] text-slate-400 hover:text-rose-300" aria-label={`Delete transcript from ${transcript.source}`}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        </>
      ) : <p className="text-xs text-slate-500">No saved transcripts. {answeredCount} saved answer{answeredCount === 1 ? '' : 's'}.</p>}
      <div className="border-t border-slate-800 pt-3">
        {confirmClearHistory ? (
          <div role="alert" className="space-y-2">
            <p className="text-xs text-amber-200">Delete all locally saved Meeting transcripts and answers? Other agent history will stay unchanged.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmClearHistory(false)} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300">Cancel</button>
              <button type="button" onClick={() => { onClearHistory(); setConfirmClearHistory(false); }} className="rounded-md border border-rose-500/40 px-3 py-1.5 text-xs text-rose-300">Delete Meeting data</button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmClearHistory(true)} className="text-xs text-rose-300 hover:text-rose-200">
            Clear saved Meeting data
          </button>
        )}
      </div>
      {transcriptActionError && <p role="alert" className="text-xs text-rose-300">{transcriptActionError}</p>}
    </div>
  );
}

export function MeetingAssistantWorkspace({
  sessionActive,
  meetingAudioMode,
  transcriptionLanguage,
  reviewBeforeSend,
  pendingTranscriptReviews,
  displayedAudioSourceLabel,
  displayedAudioStatus,
  microphoneStatus,
  microphoneUnavailable,
  systemAudioStatus,
  audioLevel,
  audioSignalDetected,
  meetingMenuOpen,
  statusLabel,
  pipelineStatus,
  pipelineElapsedMs,
  lastStageTimings,
  liveTranscript,
  lastQuestion,
  lastAnswer,
  answeredSegments,
  transcripts,
  transcriptSearch,
  filteredTranscripts,
  transcriptOpen,
  error,
  input,
  isRecording,
  isTranscribing,
  chatStreaming,
  onAudioModeChange,
  onTranscriptionLanguageChange,
  onReviewBeforeSendChange,
  onSendReviewedTranscript,
  onSkipReviewedTranscript,
  onTestAudio,
  onStartCapture,
  onStopCapture,
  onCancelRequest,
  onOpenAudioSettings,
  onTranscriptToggle,
  onInputChange,
  onSendMessage,
  onReadScreen,
  screenReading,
  screenReadingEnabled,
  onTranscriptSearchChange,
  onUseTranscript,
  onSaveTranscript,
  onSendTranscript,
  onDeleteTranscript,
  onClearHistory,
  historyRetentionDays,
  onRetentionDaysChange,
}: MeetingAssistantWorkspaceProps) {
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [editedTranscript, setEditedTranscript] = useState(liveTranscript);
  const [reviewedTranscript, setReviewedTranscript] = useState('');
  const activeReview = pendingTranscriptReviews[0] || null;
  useEffect(() => {
    setEditedTranscript(liveTranscript);
    setEditingTranscript(false);
  }, [liveTranscript]);
  useEffect(() => {
    setReviewedTranscript(activeReview?.text || '');
  }, [activeReview?.id, activeReview?.text]);

  const audioDiagnostic = meetingAudioDiagnostic({
    microphoneUnavailable,
    systemAudioMode: meetingAudioMode !== 'microphone',
    isRecording: isRecording && pipelineStatus === 'listening',
    signalDetected: audioSignalDetected,
    elapsedMs: pipelineElapsedMs,
  });
  const questionComposer = (
    <div className="flex gap-2">
      <input
        value={input}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSendMessage();
          }
        }}
        placeholder="Ask the assistant..."
        className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-400"
      />
      <button
        type="button"
        onClick={onSendMessage}
        disabled={!input.trim() || chatStreaming}
        className="rounded-lg bg-emerald-500 px-4 text-sm font-medium text-slate-950 disabled:opacity-40"
      >
        Send
      </button>
    </div>
  );
  const transcriptionSettings = (
    <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/70 p-3">
      <label className="block text-xs font-medium text-slate-300">
        Transcription language
        <select
          value={transcriptionLanguage}
          disabled={isRecording || isTranscribing}
          onChange={(event) => onTranscriptionLanguageChange(event.target.value as MeetingTranscriptionLanguage)}
          aria-label="Transcription language"
          className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200"
        >
          <option value="auto">Auto-detect (recommended)</option>
          <option value="en">English</option>
          <option value="hi">Hindi</option>
          <option value="hinglish">Hindi + English (mixed)</option>
        </select>
      </label>
      <label className="flex items-start gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={reviewBeforeSend}
            disabled={isRecording || isTranscribing}
            onChange={(event) => onReviewBeforeSendChange(event.target.checked)}
            aria-label="Review transcript before sending"
            className="mt-0.5 accent-emerald-400"
          />
          <span>
            Review transcript before sending
            <span className="mt-1 block text-[11px] text-slate-500">Check or edit each spoken question before it goes to the AI.</span>
          </span>
      </label>
    </div>
  );
  if (!sessionActive) {
    return (
      <section className="m-auto w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900/80 p-6 shadow-2xl">
        <div className="space-y-4">
          <div className="text-center">
            <h1 className="text-xl font-semibold text-slate-100">Meeting AI Assistant</h1>
            <p className="mt-1 text-xs text-slate-400">Set up and test audio, then start listening for questions.</p>
          </div>
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">Audio source<select value={meetingAudioMode} onChange={(event) => onAudioModeChange(event.target.value as MeetingAudioMode)} aria-label="Audio source" className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-200"><option value="microphone">Microphone (spoken questions)</option><option value="system">System / Internal Audio (meeting sound)</option><option value="meeting">Microphone + System / Internal Audio</option></select></label>
          {transcriptionSettings}
          <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm"><div className="flex justify-between"><span className="text-slate-400">Device</span><span className="max-w-[12rem] truncate text-slate-200">{displayedAudioSourceLabel}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">Audio status</span><span className="text-emerald-300">● {displayedAudioStatus}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">Microphone</span><span className={`font-semibold ${microphoneStatus === 'connected' ? 'text-emerald-300' : 'text-slate-500'}`}>{microphoneStatus === 'connected' ? 'ON' : 'OFF'}</span></div><div className="mt-2 flex justify-between"><span className="text-slate-400">System audio</span><span className={`font-semibold ${systemAudioStatus === 'connected' || systemAudioStatus === 'testing' ? 'text-emerald-300' : 'text-slate-500'}`}>{systemAudioStatus === 'testing' ? 'TESTING' : systemAudioStatus === 'connected' ? 'ON' : 'OFF'}</span></div><div className="mt-3"><div className="mb-1 flex justify-between text-[11px] text-slate-500"><span>Audio level</span><span>{audioLevel}%</span></div><div className="flex h-2 gap-1">{Array.from({ length: 10 }, (_, index) => <span key={index} className={`flex-1 rounded ${audioLevel >= (index + 1) * 10 ? 'bg-emerald-400' : 'bg-slate-700'}`} />)}</div></div></div>
          <p className="text-center text-[11px] text-slate-500">Choose microphone, internal system audio, or both. System audio requires the Electron desktop app and a playback source.</p>
          <div className="flex gap-2"><button type="button" onClick={onTestAudio} className="flex-1 rounded-lg border border-emerald-500/40 px-3 py-2.5 text-sm text-emerald-300 hover:bg-emerald-500/10">{meetingAudioMode === 'microphone' ? 'Test Microphone' : meetingAudioMode === 'system' ? 'Test System Audio' : 'Test Both Sources'}</button><button type="button" onClick={onStartCapture} className="flex-1 rounded-lg bg-emerald-500 px-3 py-2.5 text-sm font-medium text-slate-950 hover:bg-emerald-400">Start Listening</button></div>
          {statusLabel !== 'Ready' && <p role="status" aria-live="polite" aria-atomic="true" className="text-center text-xs text-emerald-300">{statusLabel}</p>}
          <ScreenReadingButton chatStreaming={chatStreaming} onReadScreen={onReadScreen} screenReading={screenReading} enabled={screenReadingEnabled} />
          <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
            <HistoryRetentionControl
              value={historyRetentionDays}
              onChange={onRetentionDaysChange}
              label="Auto-delete saved history"
              ariaLabel="Meeting history retention"
            />
          </div>
          {(transcripts.length > 0 || answeredSegments.length > 0) && (
            <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
              <button type="button" onClick={onTranscriptToggle} aria-expanded={transcriptOpen} className="text-xs text-emerald-300 hover:text-emerald-200">
                {transcriptOpen ? 'Hide saved Meeting data' : 'Manage saved Meeting data'}
              </button>
              {transcriptOpen && (
                <div className="mt-3">
                  <SavedMeetingHistory
                    transcripts={transcripts}
                    filteredTranscripts={filteredTranscripts}
                    transcriptSearch={transcriptSearch}
                    answeredCount={answeredSegments.length}
                    onTranscriptSearchChange={onTranscriptSearchChange}
                    onUseTranscript={onUseTranscript}
                    onDeleteTranscript={onDeleteTranscript}
                    onClearHistory={onClearHistory}
                  />
                </div>
              )}
            </div>
          )}
          {audioDiagnostic && (
            <div className="space-y-2 text-center">
              <p role="status" className={`text-xs ${audioSignalDetected ? 'text-emerald-300' : 'text-amber-300'}`}>{audioDiagnostic}</p>
              {!audioSignalDetected && <button type="button" onClick={onOpenAudioSettings} className="text-xs text-emerald-300 underline">Check audio device settings</button>}
            </div>
          )}
          {error && <div role="alert" aria-live="assertive" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs leading-relaxed text-rose-300"><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col">
      <div className="mb-4">
        {questionComposer}
        <button
          type="button"
          onClick={onOpenAudioSettings}
          aria-expanded={meetingMenuOpen}
          className="mt-2 text-xs text-emerald-300 hover:text-emerald-200"
        >
          {meetingMenuOpen ? 'Hide speech recognition settings' : 'Speech recognition settings'}
        </button>
      </div>
      {meetingMenuOpen && <div className="mb-4">{transcriptionSettings}</div>}
      <div className="mb-3 rounded-xl border border-slate-700/80 bg-slate-900/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p role="status" aria-live="polite" aria-atomic="true" className={`text-sm font-semibold ${pipelineStatus === 'error' ? 'text-rose-300' : pipelineStatus === 'answer' ? 'text-emerald-300' : 'text-sky-300'}`}>● {statusLabel}</p>
            <p className="mt-1 text-xs text-slate-400">
              {pipelineStatus === 'listening'
                ? 'Listening for a question'
                : pipelineStatus === 'transcribing'
                  ? 'Converting speech to text'
                  : pipelineStatus === 'thinking'
                    ? 'Preparing your answer'
                    : pipelineStatus === 'answer'
                      ? 'Your latest answer is ready'
                      : pipelineStatus === 'error'
                        ? 'Check the message below and try again'
                        : 'Type a question or start listening'}
              {['listening', 'transcribing', 'thinking'].includes(pipelineStatus) && (
                <span className="ml-2 text-slate-500" aria-live="off">{Math.floor(pipelineElapsedMs / 1000)}s</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isRecording || isTranscribing
              ? <button type="button" onClick={onStopCapture} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-rose-400">Stop Listening</button>
              : <button type="button" onClick={onStartCapture} className="rounded-lg border border-emerald-500/40 px-3 py-2 text-xs text-emerald-300 hover:border-emerald-400">Start Listening</button>}
            {(isTranscribing || chatStreaming) && (
              <button type="button" onClick={onCancelRequest} className="rounded-lg border border-amber-500/40 px-3 py-2 text-xs text-amber-300 hover:border-amber-400">
                Cancel {chatStreaming ? 'answer' : 'transcription'}
              </button>
            )}
          </div>
        </div>
        {lastStageTimings.transcriptionMs !== undefined && lastStageTimings.answerMs !== undefined && (
          <p className="mt-2 border-t border-slate-800 pt-2 text-[11px] text-slate-500">
            Last request: transcription {(lastStageTimings.transcriptionMs / 1000).toFixed(1)}s · AI {(lastStageTimings.answerMs / 1000).toFixed(1)}s
          </p>
        )}
        {audioDiagnostic && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-500/5 px-3 py-2">
            <p role="status" className={`text-xs ${audioSignalDetected ? 'text-emerald-300' : 'text-amber-300'}`}>{audioDiagnostic}</p>
            {!audioSignalDetected && <button type="button" onClick={onOpenAudioSettings} className="shrink-0 text-xs text-emerald-300 underline">Check audio device settings</button>}
          </div>
        )}
      </div>
      <div className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-slate-700/70 bg-slate-900/40 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Last heard</p>
          <p className="break-words text-sm leading-relaxed text-slate-300" style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}>{liveTranscript || 'Waiting for speech...'}</p>
        </div>
        {liveTranscript && <button type="button" onClick={onSaveTranscript} className="shrink-0 rounded-lg border border-emerald-500/40 px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-500/10">Save transcript</button>}
      </div>
      {activeReview && (
        <div className="mb-4 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-xs font-medium text-amber-200">
            Review spoken question{pendingTranscriptReviews.length > 1 ? ` (${pendingTranscriptReviews.length} waiting)` : ''}
          </p>
          <textarea
            value={reviewedTranscript}
            onChange={(event) => setReviewedTranscript(event.target.value)}
            aria-label="Review recognized transcript before sending"
            rows={2}
            className="w-full resize-y rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-400"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onSendReviewedTranscript(activeReview.id, reviewedTranscript)}
              disabled={!reviewedTranscript.trim() || chatStreaming}
              className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-40"
            >
              Send to AI
            </button>
            <button
              type="button"
              onClick={() => onSkipReviewedTranscript(activeReview.id)}
              disabled={chatStreaming}
              className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300 disabled:opacity-40"
            >
              Skip
            </button>
          </div>
        </div>
      )}
      {liveTranscript && (
        <div className="mb-4">
          <button
            type="button"
            className="text-xs text-emerald-300 hover:text-emerald-200"
            onClick={() => setEditingTranscript((editing) => !editing)}
          >
            {editingTranscript ? 'Cancel transcript edit' : 'Edit transcript before sending'}
          </button>
          {editingTranscript && (
            <div className="mt-2 space-y-2">
              <textarea
                value={editedTranscript}
                onChange={(event) => setEditedTranscript(event.target.value)}
                aria-label="Edit recognized transcript"
                rows={3}
                className="w-full resize-y rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-400"
              />
              <button
                type="button"
                onClick={() => onSendTranscript(editedTranscript)}
                disabled={!editedTranscript.trim() || chatStreaming}
                className="rounded-lg border border-emerald-500/40 px-3 py-2 text-xs text-emerald-300 disabled:opacity-40"
              >
                Send edited question
              </button>
            </div>
          )}
        </div>
      )}
      <AnswerSessionView lastQuestion={lastQuestion} lastAnswer={lastAnswer} isThinking={pipelineStatus === 'thinking'} answeredSegments={answeredSegments} />
      <div className="mt-4 flex items-center justify-between"><button type="button" onClick={onTranscriptToggle} className="text-xs text-emerald-300 hover:text-emerald-200">{transcriptOpen ? 'Hide full transcript' : 'View full transcript'}</button></div>
      {transcriptOpen && (
        <div className="mt-3 space-y-3 rounded-xl border border-slate-700 bg-slate-900 p-4">
          <p className="text-sm leading-relaxed text-slate-300">{liveTranscript || 'No transcript captured yet.'}</p>
          <HistoryRetentionControl
            value={historyRetentionDays}
            onChange={onRetentionDaysChange}
            label="Auto-delete saved history"
            ariaLabel="Meeting history retention"
          />
          {(transcripts.length > 0 || answeredSegments.length > 0) && (
            <SavedMeetingHistory
              transcripts={transcripts}
              filteredTranscripts={filteredTranscripts}
              transcriptSearch={transcriptSearch}
              answeredCount={answeredSegments.length}
              onTranscriptSearchChange={onTranscriptSearchChange}
              onUseTranscript={onUseTranscript}
              onDeleteTranscript={onDeleteTranscript}
              onClearHistory={onClearHistory}
            />
          )}
        </div>
      )}
      <ScreenReadingButton chatStreaming={chatStreaming} onReadScreen={onReadScreen} screenReading={screenReading} enabled={screenReadingEnabled} />
      {error && <div role="alert" aria-live="assertive" className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"><AlertCircle className="mr-2 inline h-4 w-4" />{error}</div>}
    </section>
  );
}
