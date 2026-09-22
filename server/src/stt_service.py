import json
import os
import time
import uuid
from datetime import datetime
from io import BytesIO
from typing import Any, Callable, Dict, Optional

import httpx
from fastapi import HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from openai import OpenAI


class SttService:
    """Transcribes completed audio segments without owning HTTP route wiring."""

    def __init__(
        self,
        get_provider: Callable[[], Optional[Any]],
        get_api_key: Callable[[str], str],
        transcription_prompt: str,
        max_upload_mb: int,
        retry_attempts: int,
        retry_delay: Callable[[Exception, int], float],
        retryable: Callable[[Exception], bool],
    ) -> None:
        self._get_provider = get_provider
        self._get_api_key = get_api_key
        self._transcription_prompt = transcription_prompt
        self._max_upload_bytes = max_upload_mb * 1024 * 1024
        self._max_upload_mb = max_upload_mb
        self._retry_attempts = retry_attempts
        self._retry_delay = retry_delay
        self._retryable = retryable

    @staticmethod
    def classify_error(error: Exception) -> str:
        status = getattr(error, "status_code", None)
        message = str(error).lower()
        if status in (401, 403) or any(token in message for token in ("unauthorized", "forbidden", "api key", "authentication")):
            return "STT_AUTH_ERROR"
        if status == 429 or "rate limit" in message or "too many requests" in message:
            return "STT_RATE_LIMIT"
        if status in (404, 405, 501) or any(token in message for token in ("not found", "method not allowed", "transcription is not supported", "audio transcription")):
            return "STT_PROVIDER_ERROR"
        if status in (400, 422):
            return "STT_BAD_REQUEST"
        if "unsupported" in message or "codec" in message or "mime" in message or "audio format" in message:
            return "STT_UNSUPPORTED_AUDIO"
        if isinstance(error, (TimeoutError, httpx.TimeoutException)) or "timeout" in message or "timed out" in message:
            return "STT_TIMEOUT"
        if isinstance(error, (ConnectionError, httpx.ConnectError, httpx.NetworkError)) or "connection" in message or "network" in message:
            return "STT_NETWORK_ERROR"
        return "STT_UNKNOWN"

    async def transcribe(self, request: Request, file: UploadFile) -> Dict[str, Any] | JSONResponse:
        stt_session = request.headers.get("x-stt-session-id", str(uuid.uuid4()))
        segment_id = request.headers.get("x-stt-segment-id", "unknown")
        if not file.filename:
            return JSONResponse(
                status_code=400,
                content={"error": "No audio recording uploaded.", "classification": "STT_BAD_REQUEST"},
            )

        started_at = datetime.now().timestamp()
        try:
            contents = await file.read()
            payload_size = len(contents)
            print(json.dumps({
                "event": "STT_REQUEST_STARTED",
                "sttSession": stt_session,
                "segmentId": segment_id,
                "payloadBytes": payload_size,
                "encoding": file.content_type or "unknown",
            }))
            if payload_size == 0:
                return JSONResponse(
                    status_code=400,
                    content={"error": "No audio signal was captured.", "classification": "AUDIO_CAPTURE_NO_SIGNAL"},
                )
            if payload_size > self._max_upload_bytes:
                return JSONResponse(
                    status_code=400,
                    content={"error": f"File exceeds {self._max_upload_mb}MB limit.", "classification": "STT_BAD_REQUEST"},
                )
            provider = self._get_provider()
            if not provider:
                return JSONResponse(
                    status_code=503,
                    content={"error": "No speech-capable STT provider is configured.", "classification": "STT_PROVIDER_UNSUPPORTED"},
                )
            api_key = self._get_api_key(provider.id)
            if not api_key:
                return JSONResponse(
                    status_code=502,
                    content={"error": "Speech-to-text provider is not configured.", "classification": "STT_AUTH_ERROR"},
                )

            client = OpenAI(api_key=api_key, base_url=provider.base_url or None)
            transcription_model = os.getenv("TRANSCRIPTION_MODEL") or (
                "whisper-1" if provider.type.lower() == "openai" else "whisper-large-v3-turbo"
            )
            options: Dict[str, Any] = {
                "file": (file.filename, BytesIO(contents), file.content_type or "audio/webm"),
                "model": transcription_model,
                "response_format": "text",
                "prompt": self._transcription_prompt,
                "temperature": 0,
            }
            language = os.getenv("TRANSCRIPTION_LANGUAGE", "").strip()
            if language:
                options["language"] = language

            for attempt in range(self._retry_attempts + 1):
                try:
                    transcript = client.audio.transcriptions.create(**options)
                    break
                except Exception as error:
                    if attempt >= self._retry_attempts or not self._retryable(error):
                        raise
                    time.sleep(self._retry_delay(error, attempt))
            text = str(transcript).strip()
            duration_ms = round((datetime.now().timestamp() - started_at) * 1000)
            print(json.dumps({
                "event": "STT_RESPONSE_RECEIVED",
                "sttSession": stt_session,
                "segmentId": segment_id,
                "status": 200,
                "durationMs": duration_ms,
                "transcriptLength": len(text),
                "classification": "STT_SUCCESS",
            }))
            return {"text": text, "confidence": None, "isFinal": True, "classification": "STT_SUCCESS"}
        except Exception as error:
            classification = self.classify_error(error)
            duration_ms = round((datetime.now().timestamp() - started_at) * 1000)
            print(json.dumps({
                "event": "STT_RESPONSE_FAILED",
                "sttSession": stt_session,
                "segmentId": segment_id,
                "durationMs": duration_ms,
                "classification": classification,
                "errorType": type(error).__name__,
            }))
            return JSONResponse(
                status_code=502,
                content={"error": "Audio transcription failed.", "classification": classification},
            )
