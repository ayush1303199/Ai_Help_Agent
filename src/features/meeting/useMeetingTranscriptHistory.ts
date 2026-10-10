import { useEffect, useMemo, useState } from 'react';
import { writeAppState } from '../../config/appStateStorage.ts';
import {
  DEFAULT_MEETING_HISTORY_RETENTION_DAYS,
  isMeetingHistoryRetentionDue,
  readMeetingHistoryRetention,
  type HistorySession,
  type MeetingHistoryRetentionDays,
  pruneMeetingRecords,
  writeMeetingHistoryRetention,
} from '../../history/historyService';
import { limitMeetingTranscriptHistory } from './meetingTranscriptQuality';

export interface MeetingTranscript {
  id: string;
  source: string;
  text: string;
  rawText?: string;
  normalizedText?: string;
  createdAt: string;
}

export interface MeetingAnsweredSegment {
  question: string;
  answer: string;
  createdAt?: string;
}

export function useMeetingTranscriptHistory(maxSessions: number, maxTranscripts: number) {
  const [historyRetentionDays, setHistoryRetentionDaysState] = useState<MeetingHistoryRetentionDays>(
    readMeetingHistoryRetention,
  );
  const [transcripts, setTranscripts] = useState<MeetingTranscript[]>(() => {
    try {
      return limitMeetingTranscriptHistory<MeetingTranscript>(
        JSON.parse(localStorage.getItem('meeting-transcripts') || '[]'),
        maxTranscripts,
      ).filter((entry) => pruneMeetingRecords([entry], readMeetingHistoryRetention()).length > 0);
    } catch {
      return [];
    }
  });
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [answeredSegments, setAnsweredSegments] = useState<MeetingAnsweredSegment[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem('meeting-chat-state') || '[]');
      return Array.isArray(stored) ? stored.filter((item): item is MeetingAnsweredSegment => (
        Boolean(item)
        && typeof item === 'object'
        && typeof item.question === 'string'
        && typeof item.answer === 'string'
      )).map((item) => ({
        ...item,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      })).filter((entry) => pruneMeetingRecords([entry], readMeetingHistoryRetention()).length > 0).slice(0, maxSessions) : [];
    } catch {
      return [];
    }
  });
  const [meetingConversationId, setMeetingConversationId] = useState(() => {
    try {
      return localStorage.getItem('meeting-history-conversation-id') || crypto.randomUUID();
    } catch {
      return crypto.randomUUID();
    }
  });

  useEffect(() => {
    writeAppState('meeting-chat-state', JSON.stringify(
      pruneMeetingRecords(answeredSegments, historyRetentionDays).slice(0, maxSessions),
    ));
  }, [answeredSegments, historyRetentionDays, maxSessions]);

  useEffect(() => {
    writeAppState('meeting-history-conversation-id', meetingConversationId);
  }, [meetingConversationId]);

  useEffect(() => {
    const bounded = pruneMeetingRecords(transcripts, historyRetentionDays).slice(0, maxTranscripts);
    if (bounded.length !== transcripts.length) setTranscripts(bounded);
    writeAppState('meeting-transcripts', JSON.stringify(bounded));
  }, [historyRetentionDays, maxTranscripts, transcripts]);

  useEffect(() => {
    const pruneExpiredMeetingData = () => {
      if (isMeetingHistoryRetentionDue(historyRetentionDays)) {
        if (writeMeetingHistoryRetention(DEFAULT_MEETING_HISTORY_RETENTION_DAYS)) {
          setHistoryRetentionDaysState(DEFAULT_MEETING_HISTORY_RETENTION_DAYS);
        }
      }
      setTranscripts((current) => {
        const retained = pruneMeetingRecords(current, historyRetentionDays);
        return retained.length === current.length ? current : retained;
      });
      setAnsweredSegments((current) => {
        const retained = pruneMeetingRecords(current, historyRetentionDays);
        return retained.length === current.length ? current : retained;
      });
    };
    pruneExpiredMeetingData();
    const timer = window.setInterval(pruneExpiredMeetingData, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [historyRetentionDays]);

  const filteredTranscripts = useMemo(() => transcripts.filter((item) =>
    item.text.toLowerCase().includes(transcriptSearch.toLowerCase()) ||
    item.source.toLowerCase().includes(transcriptSearch.toLowerCase()),
  ), [transcriptSearch, transcripts]);

  const appendAnsweredSegment = (segment: MeetingAnsweredSegment) => {
    setAnsweredSegments((previous) => [...previous, { ...segment, createdAt: new Date().toISOString() }].slice(-30));
  };

  const restoreMeetingHistory = (session: HistorySession) => {
    const restored: MeetingAnsweredSegment[] = [];
    for (let index = 0; index < session.messages.length - 1; index += 1) {
      const question = session.messages[index];
      const answer = session.messages[index + 1];
      if (question.role === 'user' && answer.role === 'assistant' && answer.content.trim()) {
        restored.push({ question: question.content, answer: answer.content, createdAt: session.updatedAt });
        index += 1;
      }
    }
    setMeetingConversationId(session.id.replace(/^meeting-/, '') || crypto.randomUUID());
    setAnsweredSegments(restored.slice(-maxSessions));
    return restored[restored.length - 1];
  };

  const addTranscript = (transcript: MeetingTranscript) => {
    setTranscripts((current) => [transcript, ...current].slice(0, maxTranscripts));
  };

  const deleteTranscript = (id: string) => {
    setTranscripts((current) => current.filter((transcript) => transcript.id !== id));
  };

  const clearMeetingHistory = () => {
    setTranscripts([]);
    setAnsweredSegments([]);
    setMeetingConversationId(crypto.randomUUID());
    setTranscriptSearch('');
  };

  const setHistoryRetentionDays = (days: MeetingHistoryRetentionDays) => {
    if (!writeMeetingHistoryRetention(days)) return false;
    setHistoryRetentionDaysState(days);
    setTranscripts((current) => pruneMeetingRecords(current, days));
    setAnsweredSegments((current) => pruneMeetingRecords(current, days));
    return true;
  };

  return {
    transcripts,
    transcriptSearch,
    setTranscriptSearch,
    answeredSegments,
    meetingConversationId,
    filteredTranscripts,
    appendAnsweredSegment,
    restoreMeetingHistory,
    addTranscript,
    deleteTranscript,
    clearMeetingHistory,
    historyRetentionDays,
    setHistoryRetentionDays,
  };
}
