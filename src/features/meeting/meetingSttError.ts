import type { SttFailureClassification } from '../../audio/sttTypes';

export function meetingSttUserError(classification: SttFailureClassification, fallback: string) {
  switch (classification) {
    case 'AUDIO_PERMISSION':
      return 'Microphone permission was denied or blocked. Allow microphone access and try again.';
    case 'AUDIO_CAPTURE_NO_SIGNAL':
      return 'No usable audio signal was captured. Speak closer to the microphone and try again.';
    case 'STT_AUTH_ERROR':
      return 'The speech-to-text provider key is missing or was rejected. Save a valid key in Settings → Configured Providers.';
    case 'STT_BAD_REQUEST':
    case 'STT_UNSUPPORTED_AUDIO':
      return 'The speech-to-text provider rejected this audio format.';
    case 'STT_RATE_LIMIT':
      return 'The speech-to-text provider is temporarily rate-limited. Please try again shortly.';
    case 'STT_TIMEOUT':
      return 'The speech-to-text provider timed out. Please try again.';
    case 'STT_NETWORK_ERROR':
      return 'The speech-to-text provider could not be reached. Check the connection and try again.';
    case 'STT_RESPONSE_PARSE_ERROR':
      return 'The speech-to-text response was invalid. Please try again.';
    case 'STT_PROVIDER_ERROR':
      return 'The selected speech provider rejected transcription. Choose another speech-capable provider in Settings and try again.';
    case 'STT_PROVIDER_UNSUPPORTED':
      return 'No enabled provider with speech-transcription support is available. Configure or enable a speech-capable provider in Settings.';
    default:
      return fallback;
  }
}
