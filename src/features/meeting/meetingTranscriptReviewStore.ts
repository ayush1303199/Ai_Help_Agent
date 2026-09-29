import {
  pruneMeetingRecords,
  readMeetingHistoryRetention,
  type MeetingHistoryRetentionDays,
} from '../../history/meetingHistoryRetention.ts';

export const MEETING_TRANSCRIPT_REVIEW_STORAGE_KEY = 'meeting-transcript-review-queue';
export const MAX_PENDING_TRANSCRIPT_REVIEWS = 30;
const MAX_REVIEW_TEXT_CHARS = 4000;

export interface PendingTranscriptReview {
  id: string;
  text: string;
  createdAt: string;
}

export interface TranscriptReviewReadResult {
  reviews: PendingTranscriptReview[];
  error: string | null;
}

function isPendingTranscriptReview(value: unknown): value is PendingTranscriptReview {
  if (!value || typeof value !== 'object') return false;
  const review = value as Partial<PendingTranscriptReview>;
  return typeof review.id === 'string'
    && Boolean(review.id.trim())
    && typeof review.text === 'string'
    && Boolean(review.text.trim())
    && review.text.length <= MAX_REVIEW_TEXT_CHARS
    && (review.createdAt === undefined || typeof review.createdAt === 'string');
}

export function prunePendingTranscriptReviews(
  reviews: PendingTranscriptReview[],
  retention: MeetingHistoryRetentionDays,
  now = Date.now(),
) {
  return pruneMeetingRecords(reviews, retention, now);
}

export function readPendingTranscriptReviews(
  retention = readMeetingHistoryRetention(),
  now = Date.now(),
): TranscriptReviewReadResult {
  try {
    const stored = localStorage.getItem(MEETING_TRANSCRIPT_REVIEW_STORAGE_KEY);
    if (!stored) return { reviews: [], error: null };
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return { reviews: [], error: 'Saved transcript reviews are invalid and could not be restored.' };
    }
    const reviews = parsed.filter(isPendingTranscriptReview)
      .slice(0, MAX_PENDING_TRANSCRIPT_REVIEWS)
      .map((review) => ({
        ...review,
        createdAt: review.createdAt && Number.isFinite(Date.parse(review.createdAt))
          ? review.createdAt
          : new Date(now).toISOString(),
      }));
    return {
      reviews: prunePendingTranscriptReviews(reviews, retention, now),
      error: null,
    };
  } catch {
    return { reviews: [], error: 'Saved transcript reviews could not be read from local storage.' };
  }
}

export function writePendingTranscriptReviews(
  reviews: PendingTranscriptReview[],
  retention = readMeetingHistoryRetention(),
  now = Date.now(),
): boolean {
  try {
    localStorage.setItem(
      MEETING_TRANSCRIPT_REVIEW_STORAGE_KEY,
      JSON.stringify(prunePendingTranscriptReviews(
        reviews,
        retention,
        now,
      ).slice(0, MAX_PENDING_TRANSCRIPT_REVIEWS)),
    );
    return true;
  } catch {
    return false;
  }
}
