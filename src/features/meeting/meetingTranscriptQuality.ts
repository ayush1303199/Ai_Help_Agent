import { detectQuestion } from '../../audio/transcriptUtils.ts';

const spokenRequestOpening = /^(?:i need help|i want to know|i'd like to know|i would like to know|help me|please|could you|can you|would you|tell me|explain|describe|compare|summarize|show me|introduce yourself)\b/i;

export function hasMeetingRequestIntent(transcript: string) {
  const text = transcript.trim();
  return detectQuestion(text).isQuestion || spokenRequestOpening.test(text);
}

export function adaptiveSilenceTimeoutMs(baseSilenceMs: number, speechDurationMs: number) {
  const extensionMs = Math.min(800, Math.floor(Math.max(0, speechDurationMs) / 8000) * 200);
  return Math.max(0, baseSilenceMs) + extensionMs;
}

export function adaptiveAudioLevelThreshold(baseThreshold: number, recentLevels: number[]) {
  const validLevels = recentLevels.filter((level) => Number.isFinite(level) && level >= 0).sort((a, b) => a - b);
  if (validLevels.length < 4) return Math.max(0, baseThreshold);
  const noiseFloor = validLevels[Math.floor((validLevels.length - 1) * 0.25)];
  return Math.min(
    Math.max(0, baseThreshold) + 10,
    Math.max(Math.max(0, baseThreshold), noiseFloor + 1.5),
  );
}

export function limitMeetingTranscriptHistory<T extends { id: string; source: string; text: string; createdAt: string }>(
  entries: unknown,
  maxEntries: number,
): T[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is T => (
    Boolean(entry)
    && typeof entry === 'object'
    && typeof entry.id === 'string'
    && typeof entry.source === 'string'
    && typeof entry.text === 'string'
    && typeof entry.createdAt === 'string'
  )).slice(0, Math.max(0, Math.floor(maxEntries)));
}

export function buildTranscriptSummaryPrompt(source: string, transcript: string, maxChars: number) {
  const instruction = `Summarize this ${source} meeting transcript and list the action items.`;
  const truncationNotice = '\n\n[Transcript truncated to fit the configured context limit.]';
  const limit = Math.max(0, Math.floor(maxChars));
  const transcriptBudget = Math.max(0, limit - instruction.length - 2 - truncationNotice.length);
  const content = transcript.slice(0, transcriptBudget);
  return `${instruction}\n\n${content}${content.length < transcript.length ? truncationNotice : ''}`;
}

export function meetingAudioDiagnostic({
  microphoneUnavailable,
  systemAudioMode,
  isRecording,
  signalDetected,
  elapsedMs,
}: {
  microphoneUnavailable: boolean;
  systemAudioMode: boolean;
  isRecording: boolean;
  signalDetected: boolean;
  elapsedMs: number;
}) {
  if (microphoneUnavailable && !systemAudioMode) {
    return 'No microphone device is available. Connect a microphone or choose another audio source.';
  }
  if (isRecording && !signalDetected && elapsedMs >= 4000) {
    return systemAudioMode
      ? 'No audio signal yet. Check the selected microphone and shared system source, and enable Share audio if needed.'
      : 'No audio signal yet. Check microphone permission/device and speak near the selected mic.';
  }
  return isRecording && signalDetected ? 'Audio signal detected.' : '';
}

export function shouldBufferShortTranscript(
  transcript: string,
  segmentDurationMs: number,
  minimumSilenceMs: number,
  maxWords: number,
  maxDurationMs: number,
) {
  const text = transcript.trim();
  const wordCount = text.match(/[\p{L}\p{N}']+/gu)?.length ?? 0;
  return wordCount > 0
    && wordCount <= maxWords
    && segmentDurationMs >= minimumSilenceMs
    && segmentDurationMs <= maxDurationMs
    && !/[!?]$/.test(text);
}

export function joinShortTranscriptContinuation(previous: string, current: string) {
  const previousText = previous.trim().replace(/[.!?…]+$/g, '').trim();
  const currentText = current.trim();
  const previousWordCount = previousText.match(/[\p{L}\p{N}']+/gu)?.length ?? 0;
  if (!previousText || !currentText || previousWordCount > 2) return null;
  return `${previousText} ${currentText}`.replace(/\s+/g, ' ').trim();
}

export function hasRepeatedSpeechLoop(transcript: string) {
  const words = transcript.toLocaleLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length < 6) return false;

  for (let phraseLength = 3; phraseLength <= 6; phraseLength += 1) {
    const occurrences = new Map<string, number[]>();
    for (let start = 0; start + phraseLength <= words.length; start += 1) {
      const phrase = words.slice(start, start + phraseLength).join(' ');
      const positions = occurrences.get(phrase) || [];
      positions.push(start);
      occurrences.set(phrase, positions);
    }
    for (const positions of occurrences.values()) {
      let repetitions = 0;
      let previousEnd = -1;
      for (const start of positions) {
        if (start < previousEnd) continue;
        repetitions += 1;
        previousEnd = start + phraseLength;
      }
      if (repetitions >= 3 && repetitions * phraseLength >= words.length * 0.35) return true;
    }
  }

  for (let phraseLength = 1; phraseLength <= 4; phraseLength += 1) {
    for (let start = 0; start + phraseLength * 3 <= words.length; start += 1) {
      let repetitions = 1;
      while (
        start + (repetitions + 1) * phraseLength <= words.length
        && words.slice(start, start + phraseLength).every((word, index) => (
          word === words[start + repetitions * phraseLength + index]
        ))
      ) {
        repetitions += 1;
      }
      const repeatedWordCount = repetitions * phraseLength;
      if (repetitions >= 3 && repeatedWordCount >= words.length * 0.35) return true;
    }
  }
  return false;
}
