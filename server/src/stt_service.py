import json
import os
import sys
import time
import uuid
import base64
from datetime import datetime
from io import BytesIO
from typing import Any, Callable, Dict, Optional
from urllib.parse import quote, unquote, urlparse

import httpx
from fastapi import HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from python_compat import configure_runtime_warnings
from backend_config import STT_REQUEST_TIMEOUT_SECONDS

configure_runtime_warnings()

from openai import OpenAI


class SttService:
    """Transcribes completed audio segments without owning HTTP route wiring."""

    def __init__(
        self,
        get_provider: Callable[[], Optional[Any]],
        get_speech_capable_provider: Callable[[], Optional[Any]],
        get_api_key: Callable[[str], str],
        transcription_prompt: str,
        max_upload_mb: int,
        retry_attempts: int,
        retry_delay: Callable[[Exception, int], float],
        retryable: Callable[[Exception], bool],
        meeting_transcription_prompt: str = "",
    ) -> None:
        self._get_provider = get_provider
        self._get_speech_capable_provider = get_speech_capable_provider
        self._get_api_key = get_api_key
        self._transcription_prompt = transcription_prompt
        self._meeting_transcription_prompt = meeting_transcription_prompt or transcription_prompt
        self._max_upload_bytes = max_upload_mb * 1024 * 1024
        self._max_upload_mb = max_upload_mb
        self._retry_attempts = retry_attempts
        self._retry_delay = retry_delay
        self._retryable = retryable
        self._active_requests = 0
        self._diagnostics_enabled = not getattr(sys, "frozen", False)

    def _diagnostic(self, event: str, **fields: Any) -> None:
        if self._diagnostics_enabled:
            print(json.dumps({
                "event": event,
                "timestamp": datetime.now().astimezone().isoformat(),
                **fields,
            }, ensure_ascii=False))

    @staticmethod
    def _status_code(error: Exception) -> Optional[int]:
        status = getattr(error, "status_code", None) or getattr(error, "status", None)
        if status is None:
            response = getattr(error, "response", None)
            status = getattr(response, "status_code", None)
        return status if isinstance(status, int) else None

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
        request_id = request.headers.get("x-stt-request-id") or segment_id
        source = request.headers.get("x-stt-source", "unknown").lower()
        if source not in {
            "microphone",
            "video",
            "system_audio",
            "mixed",
            "meeting_microphone",
            "meeting_system_audio",
            "meeting_mixed",
            "unknown",
        }:
            source = "unknown"
        transcription_prompt = (
            self._meeting_transcription_prompt
            if source.startswith("meeting_")
            else self._transcription_prompt
        )
        stt_language = "auto"
        if source.startswith("meeting_"):
            stt_language = request.headers.get("x-stt-language", "auto").strip().lower()
            if stt_language not in {"auto", "en", "hi", "hinglish"}:
                stt_language = "auto"
            glossary = unquote(request.headers.get("x-stt-glossary", ""))[:1000]
            glossary_terms = [
                term.strip()[:80]
                for term in glossary.replace("\r", "\n").replace(",", "\n").splitlines()
                if term.strip()
            ][:30]
            language_instructions = {
                "en": "Transcribe in English.",
                "hi": "Transcribe in Hindi.",
                "hinglish": "Preserve naturally mixed Hindi and English words and the script actually spoken.",
            }
            language_instruction = language_instructions.get(stt_language)
            if language_instruction:
                transcription_prompt += f" {language_instruction}"
            if glossary_terms:
                transcription_prompt += (
                    " Use these terms as spelling hints only when they are clearly spoken: "
                    + ", ".join(glossary_terms)
                    + ". Never insert a term that is not audible."
                )
        try:
            audio_duration_ms = max(0, int(request.headers.get("x-stt-audio-duration-ms", "")))
        except (TypeError, ValueError):
            audio_duration_ms = None
        if not file.filename:
            return JSONResponse(
                status_code=400,
                content={"error": "No audio recording uploaded.", "classification": "STT_BAD_REQUEST"},
            )

        started_at = datetime.now().timestamp()
        self._active_requests += 1
        concurrency = self._active_requests
        self._diagnostic(
            "STT_DIAGNOSTIC_REQUEST_STARTED",
            requestId=request_id,
            sttSession=stt_session,
            segmentId=segment_id,
            source=source,
            audioDurationMs=audio_duration_ms,
            concurrency=concurrency,
        )
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
                speech_provider = self._get_speech_capable_provider()
                if speech_provider:
                    return JSONResponse(
                        status_code=502,
                        content={
                            "error": "The configured speech-capable provider has no available API key.",
                            "classification": "STT_AUTH_ERROR",
                        },
                    )
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

            if provider.type.lower() == "gemini":
                mime_type = (file.content_type or "audio/webm").split(";", 1)[0].strip()
                body = {
                    "contents": [{
                        "role": "user",
                        "parts": [
                            {"text": (
                                f"{transcription_prompt} "
                                "Return only the transcript, preserving the original language. "
                                "Do not answer or summarize it."
                            )},
                            {"inlineData": {
                                "mimeType": mime_type,
                                "data": base64.b64encode(contents).decode("ascii"),
                            }},
                        ],
                    }],
                }
                url = (
                    f"{provider.base_url.rstrip('/')}/models/"
                    f"{quote(provider.model, safe='')}:generateContent"
                )
                parsed_endpoint = urlparse(url)
                for attempt in range(self._retry_attempts + 1):
                    self._diagnostic(
                        "STT_DIAGNOSTIC_UPSTREAM_STARTED",
                        requestId=request_id,
                        sttSession=stt_session,
                        segmentId=segment_id,
                        source=source,
                        providerId=provider.id,
                        provider=provider.type,
                        modelId=provider.model,
                        endpointHost=parsed_endpoint.hostname,
                        endpointPath=parsed_endpoint.path,
                        attempt=attempt + 1,
                        maxAttempts=self._retry_attempts + 1,
                        concurrency=concurrency,
                    )
                    try:
                        response = httpx.post(
                            url,
                            headers={"x-goog-api-key": api_key, "content-type": "application/json"},
                            json=body,
                            timeout=STT_REQUEST_TIMEOUT_SECONDS,
                        )
                        self._diagnostic(
                            "STT_DIAGNOSTIC_UPSTREAM_RESPONSE",
                            requestId=request_id,
                            segmentId=segment_id,
                            providerId=provider.id,
                            provider=provider.type,
                            modelId=provider.model,
                            status=getattr(response, "status_code", None),
                            attempt=attempt + 1,
                        )
                        response.raise_for_status()
                        payload = response.json()
                        parts = (payload.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
                        text = "".join(str(part.get("text") or "") for part in parts).strip()
                        break
                    except Exception as error:
                        retryable = self._retryable(error)
                        retry_delay = self._retry_delay(error, attempt) if retryable and attempt < self._retry_attempts else 0
                        response_headers = getattr(getattr(error, "response", None), "headers", None)
                        retry_after = response_headers.get("retry-after") if response_headers else None
                        self._diagnostic(
                            "STT_DIAGNOSTIC_UPSTREAM_FAILED",
                            requestId=request_id,
                            segmentId=segment_id,
                            providerId=provider.id,
                            provider=provider.type,
                            modelId=provider.model,
                            status=self._status_code(error),
                            errorType=type(error).__name__,
                            classification=self.classify_error(error),
                            attempt=attempt + 1,
                            retryCount=attempt,
                            willRetry=attempt < self._retry_attempts and retryable,
                            retryAfter=retry_after,
                            backoffMs=round(retry_delay * 1000),
                        )
                        if attempt >= self._retry_attempts or not retryable:
                            raise
                        time.sleep(retry_delay)
            else:
                client = OpenAI(api_key=api_key, base_url=provider.base_url or None)
                transcription_model = os.getenv("TRANSCRIPTION_MODEL") or (
                    "whisper-1" if provider.type.lower() == "openai" else "whisper-large-v3-turbo"
                )
                options: Dict[str, Any] = {
                    "file": (file.filename, BytesIO(contents), file.content_type or "audio/webm"),
                    "model": transcription_model,
                    "response_format": "text",
                    "prompt": transcription_prompt,
                    "temperature": 0,
                }
                language = os.getenv("TRANSCRIPTION_LANGUAGE", "").strip()
                if source.startswith("meeting_"):
                    language = stt_language if stt_language in {"en", "hi"} else ""
                if language:
                    options["language"] = language

                for attempt in range(self._retry_attempts + 1):
                    parsed_endpoint = urlparse(provider.base_url or "")
                    self._diagnostic(
                        "STT_DIAGNOSTIC_UPSTREAM_STARTED",
                        requestId=request_id,
                        sttSession=stt_session,
                        segmentId=segment_id,
                        source=source,
                        providerId=provider.id,
                        provider=provider.type,
                        modelId=transcription_model,
                        endpointHost=parsed_endpoint.hostname,
                        endpointPath=f"{parsed_endpoint.path.rstrip('/')}/audio/transcriptions",
                        attempt=attempt + 1,
                        maxAttempts=self._retry_attempts + 1,
                        concurrency=concurrency,
                    )
                    try:
                        transcript = client.audio.transcriptions.create(**options)
                        break
                    except Exception as error:
                        retryable = self._retryable(error)
                        retry_delay = self._retry_delay(error, attempt) if retryable and attempt < self._retry_attempts else 0
                        response_headers = getattr(getattr(error, "response", None), "headers", None)
                        retry_after = response_headers.get("retry-after") if response_headers else None
                        self._diagnostic(
                            "STT_DIAGNOSTIC_UPSTREAM_FAILED",
                            requestId=request_id,
                            segmentId=segment_id,
                            providerId=provider.id,
                            provider=provider.type,
                            modelId=transcription_model,
                            status=self._status_code(error),
                            errorType=type(error).__name__,
                            classification=self.classify_error(error),
                            attempt=attempt + 1,
                            retryCount=attempt,
                            willRetry=attempt < self._retry_attempts and retryable,
                            retryAfter=retry_after,
                            backoffMs=round(retry_delay * 1000),
                        )
                        if attempt >= self._retry_attempts or not retryable:
                            raise
                        time.sleep(retry_delay)
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
                "requestId": request_id,
                "durationMs": duration_ms,
                "status": self._status_code(error),
                "classification": classification,
                "errorType": type(error).__name__,
            }))
            return JSONResponse(
                status_code=502,
                content={"error": "Audio transcription failed.", "classification": classification},
            )
        finally:
            self._active_requests = max(0, self._active_requests - 1)
            self._diagnostic(
                "STT_DIAGNOSTIC_REQUEST_FINISHED",
                requestId=request_id,
                sttSession=stt_session,
                segmentId=segment_id,
                source=source,
                activeRequests=self._active_requests,
                durationMs=round((datetime.now().timestamp() - started_at) * 1000),
            )
