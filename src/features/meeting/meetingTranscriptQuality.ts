import { detectQuestion } from '../../audio/transcriptUtils.ts';

const spokenRequestOpening = /^(?:i need help|i want to know|i'd like to know|i would like to know|help me|please|could you|can you|would you|tell me|explain|describe|compare|summarize|show me|introduce yourself)\b/i;

export function hasMeetingRequestIntent(transcript: string) {
  const text = transcript.trim();
  return detectQuestion(text).isQuestion || spokenRequestOpening.test(text);
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
