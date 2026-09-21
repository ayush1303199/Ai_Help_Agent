import type { SttFailureClassification } from './sttTypes';

export interface SttSegmentRequest {
  audio: Blob;
  endpoint: string;
  sessionId: string;
  segmentId: string;
  payloadName: string;
}

export interface SttSegmentResponse {
  text: string;
  status: number;
}

export async function transcribeAudioSegment({
  audio,
  endpoint,
  sessionId,
  segmentId,
  payloadName,
}: SttSegmentRequest): Promise<SttSegmentResponse> {
  if (audio.size === 0) {
    throw Object.assign(new Error('No audio signal was captured.'), {
      classification: 'AUDIO_CAPTURE_NO_SIGNAL' as SttFailureClassification,
    });
  }

  const formData = new FormData();
  formData.append('file', audio, payloadName);
  const response = await fetch(endpoint, {
    method: 'POST',
    body: formData,
    headers: {
      'X-STT-Session-ID': sessionId,
      'X-STT-Segment-ID': segmentId,
    },
  });

  let data: { text?: unknown; error?: string; detail?: string; classification?: SttFailureClassification } = {};
  try {
    data = await response.json();
  } catch {
    if (!response.ok) {
      throw Object.assign(new Error(`Transcription failed with HTTP ${response.status}.`), {
        classification: 'STT_RESPONSE_PARSE_ERROR' as SttFailureClassification,
      });
    }
  }

  if (!response.ok) {
    const classification = data.classification || 'STT_UNKNOWN';
    throw Object.assign(
      new Error(data.error || data.detail || `Transcription failed with HTTP ${response.status}.`),
      { classification, status: response.status },
    );
  }

  return {
    text: String(data.text || ''),
    status: response.status,
  };
}
