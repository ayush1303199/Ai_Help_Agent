import asyncio
import contextlib
import io
import json
import socket
import sqlite3
import sys
import tempfile
import unittest
import httpx
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, patch

from starlette.datastructures import UploadFile


SERVER_SRC = Path(__file__).resolve().parents[1] / "server" / "src"
sys.path.insert(0, str(SERVER_SRC))

from agent_control_service import AgentControlService  # noqa: E402
from coding_provider import (  # noqa: E402
    CODING_MAX_COMPLETION_TOKENS,
    _anthropic_request,
    _candidates,
    _gemini_request,
    _normalize,
    complete_coding_model,
    ModelOutputValidationError,
    normalize_model_output,
)
from coding_intelligence import (  # noqa: E402
    DatabaseCapability,
    DATABASE_CREDENTIAL_REQUEST_PATTERN,
    DATABASE_CONNECTION_STATUS_PATTERN,
    DatabaseEvidenceSource,
    DatabaseExecutionProof,
    DatabaseIntelligenceEngine,
    DatabasePerformanceEngine,
    ConfigurationSymbolResolver,
    DatabaseEvidenceStore,
    DatabaseSchemaKnowledgeStore,
    DatabaseSession,
    DatabaseSessionManager,
    DatabaseState,
    DatabaseTargetRegistry,
    EngineeringCommandNormalizer,
    QueryToSourceMapper,
    SecretTransformer,
)
from coding_websocket import (  # noqa: E402
    MAX_CODING_CONVERSATION_CHARS,
    MAX_CODING_FINAL_EVIDENCE_CHARS,
    MAX_CODING_TOOL_ROUNDS,
    _coding_task_steps,
    _coding_finalization_messages,
    _compact_coding_conversation,
    _is_unified_diff_response,
    _has_read_file_evidence,
    _proposal_prompt_instruction,
    _proposal_goal,
    _proposal_response_shape,
    _match_pending_database_clarification,
    _has_verified_live_database_evidence,
    _is_contextual_database_credential_request,
    _resolve_semantic_task_with_model,
    _summarize_database_connection_status,
    _build_semantic_task,
    _validate_task_action_selection,
    _requires_proposal,
    _requires_proposal_for_conversation,
    _serialize_coding_tool_result,
    _compile_agent_task_context,
    _resume_semantic_task,
    _action_fingerprint,
    _next_credential_investigation_action,
    _update_task_completeness,
    _update_task_from_tool_result,
    _requires_investigation_evidence_gate,
    _investigation_evidence_gate,
    _validate_tool_call,
    _run_coding_turn,
    run_coding_websocket_server,
    classify_task_intent,
    understand_human_request,
    TaskIntent,
)
from stt_service import SttService  # noqa: E402
from provider_registry import ProviderInstance, ProviderRegistry, ProviderStatus  # noqa: E402
from provider_presets import PROVIDER_PRESETS  # noqa: E402
from provider_model_contract import (  # noqa: E402
    PROVIDER_REGISTRY,
    provider_capability_states,
    provider_model_error,
    provider_model_for_capability,
)


class AgentWebSocketIsolationTests(unittest.IsolatedAsyncioTestCase):
    def test_websocket_paths_are_agent_specific(self):
        import index

        self.assertEqual(index.websocket_agent_for_path("/"), "assistant")
        self.assertEqual(index.websocket_agent_for_path("/assistant"), "assistant")
        self.assertEqual(index.websocket_agent_for_path("/meeting"), "meeting")
        self.assertEqual(index.websocket_agent_for_path("/general"), "general")
        with self.assertRaisesRegex(ValueError, "Unknown agent endpoint"):
            index.websocket_agent_for_path("/coding")

    async def test_agent_endpoints_reject_cross_agent_chat_payloads(self):
        import index

        cases = [
            ({"type": "chat", "mode": "direct", "requestId": "assistant-on-general"}, "general"),
            ({"type": "chat", "mode": "general", "general": True, "requestId": "general-on-assistant"}, "assistant"),
            ({"type": "chat", "agent": "assistant", "mode": "direct", "requestId": "assistant-on-meeting"}, "meeting"),
            ({"type": "chat", "agent": "meeting", "mode": "direct", "requestId": "meeting-on-assistant"}, "assistant"),
            ({"type": "chat", "agent": "general", "mode": "general", "general": True, "requestId": "general-on-meeting"}, "meeting"),
        ]
        for payload, expected_agent in cases:
            sent = []

            async def send_json(message):
                sent.append(message)

            await index.handle_connection_payload(
                json.dumps(payload),
                send_json,
                index.new_connection_state(),
                expected_agent=expected_agent,
            )
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0]["type"], "error")
            self.assertEqual(sent[0]["requestId"], payload["requestId"])
            self.assertIn("endpoint", sent[0]["message"])

    async def test_dedicated_agent_endpoints_dispatch_matching_payload(self):
        import index

        cases = [
            ({"type": "chat", "agent": "assistant", "mode": "direct", "requestId": "assistant-request"}, "assistant"),
            ({"type": "chat", "agent": "meeting", "mode": "direct", "requestId": "meeting-request"}, "meeting"),
            ({"type": "chat", "mode": "general", "general": True, "requestId": "general-request"}, "general"),
        ]
        for payload, expected_agent in cases:
            state = index.new_connection_state()

            async def send_json(_message):
                return None

            with patch.object(index, "process_chat_payload", new_callable=AsyncMock) as process:
                await index.handle_connection_payload(
                    json.dumps(payload),
                    send_json,
                    state,
                    expected_agent=expected_agent,
                )
                await asyncio.sleep(0)
                process.assert_awaited_once()
            await index.close_connection_state(state)


class AgentControlServiceTests(unittest.TestCase):
    def test_browser_requires_permission_and_http_url(self):
        service = AgentControlService()

        with self.assertRaisesRegex(Exception, "permission is disabled"):
            service.open_target("browser", "https://example.com")

        service.update_permissions({"openBrowser": True})
        with self.assertRaisesRegex(Exception, "Only http and https URLs"):
            service.open_target("browser", "file:///tmp/private")

        with patch("agent_control_service.webbrowser.open", return_value=True) as open_browser:
            service.open_target("browser", "https://example.com")

        open_browser.assert_called_once()
        self.assertEqual(service.activity[0]["target"], "browser")

    def test_activity_history_is_bounded(self):
        service = AgentControlService()
        for index in range(service.MAX_ACTIVITY + 5):
            service.record_activity(f"target-{index}")

        self.assertEqual(len(service.activity), service.MAX_ACTIVITY)
        self.assertEqual(service.activity[0]["target"], f"target-{service.MAX_ACTIVITY + 4}")

    def test_only_known_targets_and_permission_keys_are_accepted(self):
        service = AgentControlService()
        permissions = service.update_permissions({"openNotepad": True, "openUnknown": True})

        self.assertTrue(permissions["openNotepad"])
        self.assertNotIn("openUnknown", permissions)
        with self.assertRaisesRegex(Exception, "Unsupported safe action"):
            service.open_target("powershell")


class SttServiceTests(unittest.TestCase):
    def setUp(self):
        self.service = SttService(
            get_provider=lambda: None,
            get_speech_capable_provider=lambda: None,
            get_api_key=lambda _provider_id: "",
            transcription_prompt="prompt",
            max_upload_mb=1,
            retry_attempts=0,
            retry_delay=lambda _error, _attempt: 0,
            retryable=lambda _error: False,
        )

    def test_missing_key_for_speech_capable_provider_is_classified_as_auth_error(self):
        provider = SimpleNamespace(
            id="gemini-instance",
            type="gemini",
            model="gemini-3.6-flash",
            base_url="https://generativelanguage.googleapis.com/v1beta",
        )
        service = SttService(
            get_provider=lambda: None,
            get_speech_capable_provider=lambda: provider,
            get_api_key=lambda _provider_id: "",
            transcription_prompt="Transcribe only spoken words.",
            max_upload_mb=1,
            retry_attempts=0,
            retry_delay=lambda _error, _attempt: 0,
            retryable=lambda _error: False,
        )
        audio = UploadFile(
            filename="segment.webm",
            file=io.BytesIO(b"audio"),
            headers={"content-type": "audio/webm"},
        )

        result = asyncio.run(service.transcribe(SimpleNamespace(headers={}), audio))

        self.assertEqual(result.status_code, 502)
        response_data = json.loads(result.body)
        self.assertEqual(response_data["classification"], "STT_AUTH_ERROR")
        self.assertIn("has no available API key", response_data["error"])

    def test_missing_speech_capable_provider_remains_unsupported(self):
        audio = UploadFile(
            filename="segment.webm",
            file=io.BytesIO(b"audio"),
            headers={"content-type": "audio/webm"},
        )

        result = asyncio.run(self.service.transcribe(SimpleNamespace(headers={}), audio))

        self.assertEqual(result.status_code, 503)
        self.assertEqual(json.loads(result.body)["classification"], "STT_PROVIDER_UNSUPPORTED")

    def test_classifies_provider_failures_without_exposing_details(self):
        self.assertEqual(self.service.classify_error(Exception("401 unauthorized")), "STT_AUTH_ERROR")
        self.assertEqual(self.service.classify_error(Exception("429 rate limit")), "STT_RATE_LIMIT")
        self.assertEqual(self.service.classify_error(Exception("unsupported codec")), "STT_UNSUPPORTED_AUDIO")
        self.assertEqual(self.service.classify_error(TimeoutError("timed out")), "STT_TIMEOUT")

    def test_classifies_unknown_failures_safely(self):
        self.assertEqual(self.service.classify_error(RuntimeError("unexpected provider detail")), "STT_UNKNOWN")

    def test_gemini_native_audio_transcription_uses_audio_part_and_returns_transcript(self):
        provider = SimpleNamespace(
            id="gemini-instance",
            type="gemini",
            model="gemini-3.6-flash",
            base_url="https://generativelanguage.googleapis.com/v1beta",
        )
        service = SttService(
            get_provider=lambda: provider,
            get_speech_capable_provider=lambda: provider,
            get_api_key=lambda _provider_id: "test-key",
            transcription_prompt="Transcribe only spoken words.",
            max_upload_mb=1,
            retry_attempts=0,
            retry_delay=lambda _error, _attempt: 0,
            retryable=lambda _error: False,
        )
        response = SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {
                "candidates": [{
                    "content": {"parts": [{"text": "Turn on the lights."}]},
                }],
            },
        )
        audio = UploadFile(
            filename="segment.webm",
            file=io.BytesIO(b"audio"),
            headers={"content-type": "audio/webm;codecs=opus"},
        )

        with patch("stt_service.httpx.post", return_value=response) as post:
            result = asyncio.run(service.transcribe(SimpleNamespace(headers={}), audio))

        self.assertEqual(result["text"], "Turn on the lights.")
        self.assertEqual(result["classification"], "STT_SUCCESS")
        self.assertEqual(
            post.call_args.args[0],
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
        )
        self.assertEqual(post.call_args.kwargs["headers"]["x-goog-api-key"], "test-key")
        request = post.call_args.kwargs["json"]
        self.assertEqual(request["contents"][0]["role"], "user")
        self.assertEqual(request["contents"][0]["parts"][1], {
            "inlineData": {"mimeType": "audio/webm", "data": "YXVkaW8="},
        })

    def test_meeting_audio_uses_meeting_specific_transcription_prompt(self):
        provider = SimpleNamespace(
            id="gemini-instance",
            type="gemini",
            model="gemini-3.6-flash",
            base_url="https://generativelanguage.googleapis.com/v1beta",
        )
        service = SttService(
            get_provider=lambda: provider,
            get_speech_capable_provider=lambda: provider,
            get_api_key=lambda _provider_id: "test-key",
            transcription_prompt="generic prompt",
            meeting_transcription_prompt="meeting-only exact speech prompt",
            max_upload_mb=1,
            retry_attempts=0,
            retry_delay=lambda _error, _attempt: 0,
            retryable=lambda _error: False,
        )
        response = SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"candidates": [{"content": {"parts": [{"text": "What is JavaScript?"}]}}]},
        )
        audio = UploadFile(
            filename="meeting.webm",
            file=io.BytesIO(b"audio"),
            headers={"content-type": "audio/webm"},
        )

        with patch("stt_service.httpx.post", return_value=response) as post:
            result = asyncio.run(service.transcribe(
                SimpleNamespace(headers={"x-stt-source": "meeting_microphone"}),
                audio,
            ))

        self.assertEqual(result["text"], "What is JavaScript?")
        prompt = post.call_args.kwargs["json"]["contents"][0]["parts"][0]["text"]
        self.assertTrue(prompt.startswith("meeting-only exact speech prompt"))
        self.assertNotIn("generic prompt", prompt)

    def test_default_meeting_prompt_preserves_hinglish_without_translation(self):
        from backend_config import MEETING_TRANSCRIPTION_PROMPT

        self.assertIn("original language or languages spoken", MEETING_TRANSCRIPTION_PROMPT)
        self.assertIn("Preserve language switches and word order", MEETING_TRANSCRIPTION_PROMPT)
        self.assertIn("without forcing transliteration", MEETING_TRANSCRIPTION_PROMPT)
        self.assertIn("Never translate, paraphrase", MEETING_TRANSCRIPTION_PROMPT)
        self.assertIn("repeat words that were not spoken", MEETING_TRANSCRIPTION_PROMPT)
        self.assertNotIn("JavaScript, API, API key, and database", MEETING_TRANSCRIPTION_PROMPT)

    def test_meeting_audio_applies_language_and_bounded_glossary_hints(self):
        from urllib.parse import quote

        provider = SimpleNamespace(
            id="gemini-instance",
            type="gemini",
            model="gemini-3.6-flash",
            base_url="https://generativelanguage.googleapis.com/v1beta",
        )
        service = SttService(
            get_provider=lambda: provider,
            get_speech_capable_provider=lambda: provider,
            get_api_key=lambda _provider_id: "test-key",
            transcription_prompt="generic prompt",
            meeting_transcription_prompt="meeting prompt",
            max_upload_mb=1,
            retry_attempts=0,
            retry_delay=lambda _error, _attempt: 0,
            retryable=lambda _error: False,
        )
        response = SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"candidates": [{"content": {"parts": [{"text": "What is Spring Boot?"}]}}]},
        )
        audio = UploadFile(
            filename="meeting.webm",
            file=io.BytesIO(b"audio"),
            headers={"content-type": "audio/webm"},
        )
        with patch("stt_service.httpx.post", return_value=response) as post:
            result = asyncio.run(service.transcribe(
                SimpleNamespace(headers={
                    "x-stt-source": "meeting_microphone",
                    "x-stt-language": "hinglish",
                    "x-stt-glossary": quote("Spring Boot, Kubernetes"),
                }),
                audio,
            ))

        self.assertEqual(result["text"], "What is Spring Boot?")
        prompt = post.call_args.kwargs["json"]["contents"][0]["parts"][0]["text"]
        self.assertIn("Preserve naturally mixed Hindi and English exactly as spoken.", prompt)
        self.assertIn("Do not translate or paraphrase the utterance.", prompt)
        self.assertNotIn("Roman/Latin script", prompt)
        self.assertIn("Spring Boot, Kubernetes", prompt)
        self.assertIn("Never insert a term that is not audible.", prompt)

    def test_openai_meeting_transcription_passes_hindi_language_to_whisper(self):
        provider = SimpleNamespace(
            id="openai-instance",
            type="openai",
            model="gpt-4o-mini",
            base_url="https://api.openai.com/v1",
        )
        service = SttService(
            get_provider=lambda: provider,
            get_speech_capable_provider=lambda: provider,
            get_api_key=lambda _provider_id: "test-key",
            transcription_prompt="generic prompt",
            meeting_transcription_prompt="meeting prompt",
            max_upload_mb=1,
            retry_attempts=0,
            retry_delay=lambda _error, _attempt: 0,
            retryable=lambda _error: False,
        )
        create_transcription = Mock(return_value="यह क्या है?")
        client = SimpleNamespace(audio=SimpleNamespace(
            transcriptions=SimpleNamespace(create=create_transcription),
        ))
        audio = UploadFile(
            filename="meeting.webm",
            file=io.BytesIO(b"audio"),
            headers={"content-type": "audio/webm"},
        )
        with patch.dict("os.environ", {"TRANSCRIPTION_MODEL": ""}), patch(
            "stt_service.OpenAI", return_value=client
        ):
            result = asyncio.run(service.transcribe(
                SimpleNamespace(headers={
                    "x-stt-source": "meeting_microphone",
                    "x-stt-language": "hi",
                    "x-stt-glossary": "Spring%20Boot",
                }),
                audio,
            ))

        self.assertEqual(result["text"], "यह क्या है?")
        options = create_transcription.call_args.kwargs
        self.assertEqual(options["language"], "hi")
        self.assertIn("Spring Boot", options["prompt"])

    def test_openai_meeting_mixed_language_uses_multilingual_whisper(self):
        provider = SimpleNamespace(
            id="groq-instance",
            type="groq",
            model="whisper-large-v3-turbo",
            base_url="https://api.groq.com/openai/v1",
        )
        service = SttService(
            get_provider=lambda: provider,
            get_speech_capable_provider=lambda: provider,
            get_api_key=lambda _provider_id: "test-key",
            transcription_prompt="generic prompt",
            meeting_transcription_prompt=(
                "Transcribe only audible words in their original language. "
                "Do not translate or paraphrase."
            ),
            max_upload_mb=1,
            retry_attempts=0,
            retry_delay=lambda _error, _attempt: 0,
            retryable=lambda _error: False,
        )
        for language in ("auto", "hinglish"):
            with self.subTest(language=language):
                create_transcription = Mock(return_value="Mujhe JavaScript API samjhao.")
                client = SimpleNamespace(audio=SimpleNamespace(
                    transcriptions=SimpleNamespace(create=create_transcription),
                ))
                audio = UploadFile(
                    filename="meeting.webm",
                    file=io.BytesIO(b"audio"),
                    headers={"content-type": "audio/webm"},
                )
                with patch.dict("os.environ", {"TRANSCRIPTION_MODEL": ""}), patch(
                    "stt_service.OpenAI", return_value=client
                ):
                    result = asyncio.run(service.transcribe(
                        SimpleNamespace(headers={
                            "x-stt-source": "meeting_microphone",
                            "x-stt-language": language,
                        }),
                        audio,
                    ))

                self.assertEqual(result["text"], "Mujhe JavaScript API samjhao.")
                options = create_transcription.call_args.kwargs
                self.assertNotIn("language", options, "Mixed-language audio should be auto-detected, not forced to Hindi.")
                self.assertEqual(options["model"], "whisper-large-v3")
                if language == "hinglish":
                    self.assertIn("Preserve naturally mixed Hindi and English exactly as spoken.", options["prompt"])
                    self.assertIn("Do not translate or paraphrase the utterance.", options["prompt"])
                    self.assertNotIn("Roman/Latin script", options["prompt"])

    def test_development_diagnostics_capture_upstream_status_and_bounded_retry_safely(self):
        import index

        provider = SimpleNamespace(
            id="gemini-instance",
            type="gemini",
            model="gemini-3.6-flash",
            base_url="https://generativelanguage.googleapis.com/v1beta",
        )
        service = SttService(
            get_provider=lambda: provider,
            get_speech_capable_provider=lambda: provider,
            get_api_key=lambda _provider_id: "test-key",
            transcription_prompt="Transcribe only spoken words.",
            max_upload_mb=1,
            retry_attempts=1,
            retry_delay=index.provider_retry_delay_seconds,
            retryable=index.is_stt_retryable,
        )
        rate_limited = httpx.Response(
            429,
            headers={"Retry-After": "0.001"},
            request=httpx.Request("POST", "https://generativelanguage.googleapis.com/test"),
        )
        successful = SimpleNamespace(
            status_code=200,
            raise_for_status=lambda: None,
            json=lambda: {
                "candidates": [{
                    "content": {"parts": [{"text": "A test transcript."}]},
                }],
            },
        )
        audio = UploadFile(
            filename="segment.webm",
            file=io.BytesIO(b"audio"),
            headers={"content-type": "audio/webm"},
        )
        output = io.StringIO()

        with contextlib.redirect_stdout(output), patch(
            "stt_service.httpx.post",
            side_effect=[rate_limited, successful],
        ) as post:
            result = asyncio.run(service.transcribe(SimpleNamespace(headers={
                "x-stt-session-id": "session-1",
                "x-stt-segment-id": "segment-1",
                "x-stt-source": "microphone",
                "x-stt-audio-duration-ms": "1200",
            }), audio))

        self.assertEqual(result["text"], "A test transcript.")
        self.assertEqual(post.call_count, 2)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        upstream_failure = next(event for event in events if event["event"] == "STT_DIAGNOSTIC_UPSTREAM_FAILED")
        self.assertEqual(upstream_failure["status"], 429)
        self.assertEqual(upstream_failure["retryCount"], 0)
        self.assertTrue(upstream_failure["willRetry"])
        self.assertEqual(upstream_failure["backoffMs"], 1)
        upstream_start = next(event for event in events if event["event"] == "STT_DIAGNOSTIC_UPSTREAM_STARTED")
        self.assertEqual(upstream_start["provider"], "gemini")
        self.assertEqual(upstream_start["modelId"], "gemini-3.6-flash")
        self.assertEqual(upstream_start["endpointHost"], "generativelanguage.googleapis.com")
        request_start = next(event for event in events if event["event"] == "STT_DIAGNOSTIC_REQUEST_STARTED")
        self.assertEqual(request_start["source"], "microphone")
        self.assertEqual(request_start["audioDurationMs"], 1200)
        self.assertNotIn("test-key", output.getvalue())
        self.assertNotIn("YXVkaW8=", output.getvalue())


class CodingIntentTests(unittest.TestCase):
    def test_explanatory_questions_do_not_create_change_proposals(self):
        self.assertFalse(_requires_proposal("What does this function do?"))
        self.assertFalse(_requires_proposal("Explain how this controller handles queries."))
        self.assertFalse(_requires_proposal("How can I fix this error?"))

    def test_direct_change_requests_create_change_proposals(self):
        self.assertTrue(_requires_proposal("Fix N+1 queries in the academic controllers."))
        self.assertTrue(_requires_proposal("Explain this bug and then fix it."))
        self.assertTrue(_requires_proposal("Naya validation rule add karo email field ke liye."))
        self.assertTrue(_requires_proposal(
            "AdmOuPrgList.php ke getProgrammes() method mein duplicate-query issue ka fix proposal/diff banao."
        ))

    def test_coding_task_plan_requires_flow_trace_and_behavior_preservation(self):
        analysis_steps = _coding_task_steps(False)
        proposal_steps = _coding_task_steps(True)

        self.assertTrue(any("callers, callees, and data/state" in step for step in analysis_steps))
        self.assertTrue(any("tests, configuration, and contracts" in step for step in analysis_steps))
        self.assertTrue(any("existing behavior to preserve" in step for step in proposal_steps))
        self.assertIn("Prepare a validated diff from inspected source for explicit approval", proposal_steps)
        self.assertNotIn("Report findings, the task checklist, and any unverified checks", proposal_steps)

    def test_follow_up_pasted_diff_keeps_the_active_proposal_goal(self):
        messages = [
            {"role": "user", "content": "Fix the duplicate query in getProgrammes and prepare a proposal."},
            {"role": "assistant", "content": "I identified repeated database queries."},
            {"role": "user", "content": "--- a/models/AdmOuPrgList.php\n+++ b/models/AdmOuPrgList.php\n@@ -1 +1 @@\n-old\n+new"},
        ]

        self.assertTrue(_requires_proposal_for_conversation(messages))
        self.assertEqual(_proposal_goal([
            message["content"] for message in messages if message["role"] == "user"
        ]), messages[0]["content"])

    def test_explanatory_follow_up_does_not_inherit_an_older_proposal_goal(self):
        messages = [
            {"role": "user", "content": "Fix the duplicate query in getProgrammes and prepare a proposal."},
            {"role": "assistant", "content": "I identified repeated database queries."},
            {"role": "user", "content": "Explain what this diff does."},
        ]

        self.assertFalse(_requires_proposal_for_conversation(messages))


class CodingConversationBudgetTests(unittest.TestCase):
    def test_tool_results_are_bounded(self):
        serialized = _serialize_coding_tool_result({
            "ok": True,
            "tool": "read_file",
            "data": {"path": "models/AdmOuPrgList.php", "content": "x" * 12000},
        })

        self.assertLessEqual(len(serialized), 6000)
        parsed = json.loads(serialized)
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["data"]["path"], "models/AdmOuPrgList.php")
        self.assertIn("[Tool result truncated", parsed["data"]["content"])
        self.assertTrue(_has_read_file_evidence([{
            "role": "tool",
            "name": "read_file",
            "content": serialized,
        }]))

    def test_compaction_keeps_system_context_latest_request_and_recent_tool_exchange(self):
        messages = [
            {"role": "system", "content": "system instructions"},
            {"role": "system", "content": "task context"},
            {"role": "user", "content": "current request"},
        ]
        for index in range(8):
            messages.extend([
                {"role": "assistant", "tool_calls": [{"id": f"call-{index}"}]},
                {"role": "tool", "tool_call_id": f"call-{index}", "content": "x" * 4000},
            ])

        compacted = _compact_coding_conversation(messages)

        self.assertLessEqual(sum(len(str(message)) for message in compacted), MAX_CODING_CONVERSATION_CHARS + 500)
        self.assertEqual(compacted[:2], messages[:2])
        self.assertEqual(compacted[2]["content"], "current request")
        self.assertEqual(compacted[-2]["tool_calls"][0]["id"], "call-7")
        self.assertEqual(compacted[-1]["tool_call_id"], "call-7")

    def test_finalization_removes_tool_protocol_but_preserves_read_evidence(self):
        messages = [
            {"role": "system", "content": "Follow the project safety rules."},
            {"role": "system", "content": "Current optional scope: .\nTask plan: inspect the academic module."},
            {"role": "user", "content": "Optimize academic queries."},
            {"role": "assistant", "tool_calls": [{
                "id": "call-1",
                "function": {"name": "read_file", "arguments": "{\"relativePath\":\"modules/academic/controller.js\"}"},
            }]},
            {
                "role": "tool",
                "tool_call_id": "call-1",
                "name": "read_file",
                "content": "{\"relativePath\":\"modules/academic/controller.js\",\"content\":\"SELECT * FROM students\"}",
            },
        ]

        finalized = _coding_finalization_messages(messages)

        self.assertEqual([item["role"] for item in finalized], ["system", "user"])
        self.assertIn("Optimize academic queries.", finalized[1]["content"])
        self.assertIn("Project scope: .", finalized[1]["content"])
        self.assertIn("SELECT * FROM students", finalized[1]["content"])
        self.assertIn("read_file", finalized[1]["content"])
        self.assertFalse(any(item.get("role") == "tool" or item.get("tool_calls") for item in finalized))
        self.assertIn("Finish the response now.", finalized[0]["content"])
        self.assertIn("distinguish observations from hypotheses", finalized[0]["content"])
        self.assertIn("do not force a fixed report template", finalized[0]["content"])

    def test_finalization_uses_task_state_without_fixed_intent_formatting(self):
        task = _build_semantic_task(
            request_id="finalization-task",
            user_message="Why is the database connection unavailable?",
            intent="DATABASE_INVESTIGATION",
            resources=["DATABASE", "CODE"],
            target="active project connection",
            project_root="C:\\project",
            scope=".",
            architecture={},
            required_evidence=["Configuration", "runtime connection"],
            conversation_message_count=1,
        )

        finalized = _coding_finalization_messages(
            [{"role": "user", "content": "Why is the database connection unavailable?"}],
            task_state=task,
        )

        self.assertIn("Current authoritative AgentTaskState", finalized[0]["content"])
        self.assertIn('"primary": "DATABASE_INVESTIGATION"', finalized[0]["content"])
        self.assertIn("distinguish source configuration, active session state, and live runtime verification", finalized[0]["content"])
        self.assertNotIn("### DATABASE DISCOVERY & INSPECTION", finalized[0]["content"])
        self.assertNotIn("### DIRECT ANSWER", finalized[0]["content"])

    def test_proposal_finalization_retains_the_active_goal_and_rejects_diff_summarization(self):
        original_request = "Fix the duplicate query in getProgrammes and prepare a proposal."
        messages = [
            {"role": "system", "content": "Follow the project safety rules."},
            {"role": "user", "content": original_request},
            {"role": "assistant", "content": "I identified repeated database queries."},
            {"role": "user", "content": "--- a/models/AdmOuPrgList.php\n+++ b/models/AdmOuPrgList.php\n@@ -1 +1 @@\n-old\n+new"},
            {"role": "tool", "name": "read_file", "content": "source evidence"},
        ]

        finalized = _coding_finalization_messages(messages, proposal_required=True)

        self.assertIn(original_request, finalized[1]["content"])
        self.assertIn("do not merely summarize or repeat it", finalized[0]["content"])

    def test_proposal_prompt_has_explicit_git_diff_example_and_stronger_retry(self):
        instruction = _proposal_prompt_instruction()
        retry_instruction = _proposal_prompt_instruction(retry=True)

        self.assertIn("--- a/path/to/file", instruction)
        self.assertIn("+++ b/path/to/file", instruction)
        self.assertIn("@@ -10,2 +10,2 @@", instruction)
        self.assertIn("Do not include explanations, Markdown fences, or text outside the diff.", instruction)
        self.assertIn("previous response did not match", retry_instruction)
        self.assertNotIn("previous response did not match", instruction)

    def test_proposal_response_diagnostics_classify_only_redacted_shape(self):
        diff = "--- a/src/controller.js\n+++ b/src/controller.js\n@@ -1 +1 @@\n-old\n+new"
        prose = "I recommend reusing the existing query result."

        self.assertTrue(_is_unified_diff_response(diff))
        self.assertFalse(_is_unified_diff_response(prose))
        self.assertEqual(
            _proposal_response_shape(prose),
            {
                "chars": len(prose),
                "lines": 1,
                "fileHeaderCount": 0,
                "hunkCount": 0,
                "markdownFenced": False,
                "startsWithDiff": False,
                "startsWithProse": True,
                "noChanges": False,
                "validDiffShape": False,
            },
        )

    def test_finalization_evidence_and_generation_budget_are_bounded(self):
        messages = [
            {"role": "system", "content": "System context."},
            {"role": "system", "content": "Current optional scope: ."},
            {"role": "user", "content": "Fix the academic query."},
            {"role": "assistant", "tool_calls": [{"id": "call-1"}]},
            {"role": "tool", "tool_call_id": "call-1", "name": "read_file", "content": "x" * 9000},
        ]

        finalized = _coding_finalization_messages(messages)

        self.assertLessEqual(len(finalized[1]["content"]), MAX_CODING_FINAL_EVIDENCE_CHARS + 200)
        self.assertIn("[Earlier tool evidence omitted.]", finalized[1]["content"])
        self.assertEqual(CODING_MAX_COMPLETION_TOKENS, 1024)

    def test_provider_repo_browser_alias_uses_the_confined_read_file_tool(self):
        for tool_name in ("open_file", "repo_browser.read_file", "repo_browser.open_file"):
            with self.subTest(tool_name=tool_name):
                name, arguments = _validate_tool_call({
                    "function": {
                        "name": tool_name,
                        "arguments": "{\"path\":\"modules/academic/controller.js\"}",
                    },
                })

                self.assertEqual((name, arguments), ("read_file", {"relativePath": "modules/academic/controller.js"}))
        self.assertEqual(MAX_CODING_TOOL_ROUNDS, 7)


class CodingProviderNormalizationTests(unittest.TestCase):
    def test_populated_content_keeps_priority_over_alternate_fields(self):
        message = {"role": "assistant", "content": "normal answer", "reasoning_content": "private reasoning"}

        self.assertEqual(_normalize(message), message)

    def test_reasoning_fields_are_not_exposed_as_answer_content(self):
        message = {"role": "assistant", "content": None, "reasoning_content": "usable answer"}

        self.assertIsNone(_normalize(message)["content"])

        message = {"role": "assistant", "content": "", "reasoning": "private reasoning"}

        self.assertEqual(_normalize(message), message)

    def test_final_text_fields_fill_empty_content(self):
        message = {"role": "assistant", "content": None, "output_text": "usable final answer"}

        self.assertEqual(_normalize(message)["content"], "usable final answer")

    def test_tool_calls_are_preserved_when_text_content_is_empty(self):
        tool_calls = [{"id": "call-1", "function": {"name": "search_code", "arguments": "{}"}}]
        message = {"role": "assistant", "content": "", "reasoning_content": "thinking", "tool_calls": tool_calls}

        normalized = _normalize(message)
        self.assertEqual(normalized["tool_calls"], tool_calls)
        self.assertEqual(normalized["content"], "")
        self.assertEqual(normalized["reasoning_content"], "thinking")


class CodingProviderToolChoiceTests(unittest.TestCase):
    def test_malformed_model_output_is_rejected_with_safe_diagnostics(self):
        with self.assertLogs("coding_provider", level="ERROR") as captured:
            with self.assertRaises(ModelOutputValidationError) as raised:
                normalize_model_output(
                    None,
                    provider="groq",
                    model="test-model",
                    request_id="request-123",
                    session_id="session-456",
                )

        self.assertIn("request-123", captured.output[0])
        self.assertIn("session-456", captured.output[0])
        self.assertEqual(raised.exception.diagnostic["outputType"], "NoneType")
        self.assertNotIn("secret", captured.output[0].lower())

    def test_malformed_nested_tool_output_does_not_break_diagnostics(self):
        with self.assertRaises(ModelOutputValidationError) as raised:
            normalize_model_output(
                {"role": "assistant", "tool_calls": [{"function": "invalid"}]},
                provider="groq",
                model="test-model",
            )

        self.assertIsNone(raised.exception.diagnostic["toolName"])

    def test_empty_openai_choice_is_rejected_before_coding_tool_routing(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            registry = ProviderRegistry(str(Path(temporary_directory) / "provider-config.json"))
            registry.add_provider("groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "test-key")
            client = Mock()
            client.chat.completions.create.return_value.choices = []

            with patch("coding_provider.OpenAI", return_value=client):
                with self.assertLogs("coding_provider", level="ERROR") as captured:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "Coding Agent provider request failed.*could not be interpreted",
                    ):
                        complete_coding_model(
                            registry,
                            Path("unused-provider-config.json"),
                            [{"role": "user", "content": "Inspect the project."}],
                            [{"type": "function", "function": {"name": "search_code"}}],
                            request_id="empty-output-request",
                            session_id="empty-output-session",
                        )

        self.assertIn("empty-output-request", captured.output[0])
        self.assertIn("empty-output-session", captured.output[0])

    def test_current_target_requires_owned_session_and_does_not_invent_target(self):
        result = ConfigurationSymbolResolver.verify_live_database_identity(
            ".",
            {"engine": "mysql", "targetId": "DB-001"},
            session=None,
        )

        self.assertFalse(result["connected"])
        self.assertEqual(result["status"], "NOT_VERIFIED")
        self.assertIsNone(result["targetId"])

    def test_current_schema_refresh_is_not_misrouted_as_current_database_target(self):
        refresh = DatabaseSessionManager.resolve_database_intent(
            "refresh current database schema"
        )
        self.assertEqual(refresh["capability"], DatabaseCapability.DATABASE_LIST_TABLES)
        self.assertTrue(refresh["arguments"]["learn_schema"])
        self.assertTrue(refresh["arguments"]["refresh_schema"])

        current_target = DatabaseSessionManager.resolve_database_intent(
            "which db connection current now"
        )
        self.assertEqual(
            current_target["capability"],
            DatabaseCapability.DATABASE_CURRENT_TARGET,
        )

    def test_unconfigured_database_does_not_default_to_verified_mysql_or_measured(self):
        health = DatabaseIntelligenceEngine.real_connect_and_health_check("", {})
        self.assertEqual(health["status"], "NOT_CONFIGURED")
        self.assertEqual(health["state"], DatabaseState.DISCONNECTED)
        self.assertEqual(health["engine"], "unknown")
        self.assertIsNone(health["database"])
        self.assertIsNone(health["host"])
        self.assertIsNone(health["port"])

        session = DatabaseSession(
            project_id="audit",
            repository_id="audit",
            database_type="unknown",
            database_name=None,
            connection_state=DatabaseState.DISCONNECTED,
            session_id="coding-conversation",
        )
        self.assertFalse(session.to_safe_dict()["engineVerified"])
        self.assertFalse(_has_verified_live_database_evidence({
            "executionStatus": "SUCCESS",
            "liveDatabase": {"status": "NOT_VERIFIED", "evidence": None},
        }))
        self.assertFalse(_has_verified_live_database_evidence({
            "mode": "LIVE",
            "source": DatabaseEvidenceSource.LIVE_DB_EXECUTION,
            "executionStatus": "SUCCESS",
            "evidenceId": "live-proof",
        }))
        proof = DatabaseExecutionProof(
            evidence_id="live-proof",
            database_session_id="database-session",
            database_engine="sqlite",
            operation=DatabaseCapability.DATABASE_HEALTH_CHECK,
            source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
            mode="LIVE",
            execution_status="SUCCESS",
        )
        DatabaseEvidenceStore.record_proof(proof)
        self.assertTrue(_has_verified_live_database_evidence({
            "evidenceId": proof.evidence_id,
        }))

        verified_session = DatabaseSession(
            project_id="audit",
            repository_id="audit",
            database_type="sqlite",
            database_name="live.sqlite",
            connection_state=DatabaseState.CONNECTED,
            session_id="database-session",
        )
        verified_session.health_proof = DatabaseExecutionProof(
            database_session_id="database-session",
            database_engine="sqlite",
            operation=DatabaseCapability.DATABASE_HEALTH_CHECK,
            source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
            mode="LIVE",
            execution_status="SUCCESS",
        )
        self.assertTrue(verified_session.to_safe_dict()["engineVerified"])

    def test_current_target_does_not_reuse_session_from_deleted_project(self):
        original_sessions = DatabaseSessionManager._sessions
        original_sessions_by_id = DatabaseSessionManager._sessions_by_id
        original_active_session = DatabaseSessionManager._active_session
        try:
            with tempfile.TemporaryDirectory() as temporary_directory:
                stale_session = DatabaseSession(
                    project_id="stale-project",
                    repository_id="stale-project",
                    database_type="sqlite",
                    database_name="deleted.sqlite",
                    connection_state=DatabaseState.HEALTH_CHECKED,
                    project_root=temporary_directory,
                    session_id="stale-database-session",
                )
                DatabaseSessionManager._sessions = {
                    temporary_directory: stale_session,
                }
                DatabaseSessionManager._sessions_by_id = {
                    "stale-database-session": stale_session,
                }
                DatabaseSessionManager._active_session = stale_session

            self.assertIsNone(DatabaseSessionManager.get_session(session_id="stale-database-session"))
            self.assertEqual(stale_session.connection_state, DatabaseState.DISCONNECTED)
            self.assertFalse(stale_session.to_safe_dict()["engineVerified"])
        finally:
            DatabaseSessionManager._sessions = original_sessions
            DatabaseSessionManager._sessions_by_id = original_sessions_by_id
            DatabaseSessionManager._active_session = original_active_session

    def test_database_tool_endpoint_executes_sql_through_owned_project_session(self):
        import index

        database_config = {"engine": "mysql", "database": "admissions"}
        db_session = Mock()
        execution = {
            "ok": True,
            "executionStatus": "SUCCESS",
            "executed": True,
            "rows": [{"id": 32875}],
            "rowCount": 1,
        }
        with patch.object(index, "get_backend_project_state", return_value={
            "attached": True,
            "projectRoot": "C:/projects/admissions",
        }), patch.object(
            index.DatabaseIntelligenceEngine,
            "discover_database_configuration",
            return_value=database_config,
        ), patch.object(
            index.DatabaseSessionManager,
            "get_or_create_session",
            return_value=db_session,
        ) as get_session, patch.object(
            index.DatabaseSessionManager,
            "execute_database_capability",
            return_value=execution,
        ) as execute:
            result = index.execute_coding_tool_endpoint({
                "name": "execute_sql",
                "arguments": {"sql": "SELECT * FROM admission"},
            })

        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["rows"], [{"id": 32875}])
        get_session.assert_called_once_with("C:/projects/admissions", db_config=database_config)
        execute.assert_called_once_with(
            DatabaseCapability.DATABASE_QUERY,
            {"sql": "SELECT * FROM admission"},
            db_session,
            "C:/projects/admissions",
        )

    def test_database_tool_endpoint_rejects_sql_without_an_attached_project(self):
        import index

        with patch.object(index, "get_backend_project_state", return_value={
            "attached": False,
            "projectRoot": None,
        }), patch.object(index.DatabaseIntelligenceEngine, "discover_database_configuration") as discover:
            result = index.execute_coding_tool_endpoint({
                "name": "execute_sql",
                "arguments": {"sql": "SELECT * FROM admission"},
            })

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "PROJECT_NOT_ATTACHED")
        discover.assert_not_called()

    def test_mysql_select_uses_live_read_only_connection_and_returns_actual_rows(self):
        from datetime import datetime
        from decimal import Decimal

        cursor = Mock()
        cursor.description = (("id",), ("status",), ("created_at",), ("paid_amount",))
        cursor.fetchmany.return_value = [{
            "id": 32875,
            "status": "Admission Granted",
            "created_at": datetime(2026, 8, 6, 15, 58, 35),
            "paid_amount": Decimal("435235.00"),
        }]
        connection = Mock()
        connection.cursor.return_value = cursor
        mysql = SimpleNamespace(connect=Mock(return_value=connection))
        session = DatabaseSession(
            project_id="test-project",
            repository_id="test-repository",
            project_root=".",
            database_type="mysql",
            database_name="admissions",
            connection_state="CONNECTED",
            safe_host="db.internal",
            safe_port=3307,
        )
        session._protected_credentials = {"username": "app_user", "password": "test-only-secret"}

        with patch.dict(sys.modules, {"pymysql": mysql}):
            result = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_QUERY,
                {"sql": "SELECT * FROM admission"},
                session,
                ".",
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["executionStatus"], "SUCCESS")
        self.assertEqual(result["rows"][0]["id"], 32875)
        self.assertEqual(result["rows"][0]["paid_amount"], "435235.00")
        self.assertEqual(result["rowCount"], 1)
        self.assertIn('"created_at": "2026-08-06 15:58:35"', result["content"])
        mysql.connect.assert_called_once()
        connection_args = mysql.connect.call_args.kwargs
        self.assertEqual(connection_args["database"], "admissions")
        self.assertEqual(connection_args["user"], "app_user")
        self.assertEqual(connection_args["password"], "test-only-secret")
        self.assertEqual(connection_args["init_command"], "SET SESSION TRANSACTION READ ONLY")
        connection.begin.assert_called_once()
        connection.rollback.assert_called_once()
        connection.close.assert_called_once()
        self.assertNotIn("test-only-secret", json.dumps(result))

    def test_mysql_query_without_real_connection_fails_instead_of_fabricating_rows(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            result = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_QUERY,
                {"sql": "SELECT * FROM admission"},
                DatabaseSession(
                    project_id="test-project",
                    repository_id="test-repository",
                    project_root=temporary_directory,
                    database_type="mysql",
                    database_name="admissions",
                    connection_state="NOT_CONNECTED",
                ),
                temporary_directory,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["executionStatus"], "FAILED")
        self.assertEqual(result["error"]["code"], "DATABASE_NOT_CONNECTED")
        self.assertNotIn('"1": 1', result["content"])

    def test_select_request_with_hindi_display_instruction_runs_as_deterministic_sql(self):
        resolved = DatabaseSessionManager.resolve_database_intent("select * from admission data dikho")

        self.assertTrue(resolved["is_deterministic"])
        self.assertEqual(resolved["capability"], DatabaseCapability.DATABASE_QUERY)
        self.assertEqual(resolved["arguments"]["sql"], "select * from admission")

    def test_count_total_admission_data_resolves_to_safe_count_operation(self):
        for request in (
            "count total admission data",
            "count admissions",
            "how many admission records",
        ):
            with self.subTest(request=request):
                resolved = DatabaseSessionManager.resolve_database_intent(request)
                self.assertTrue(resolved["is_deterministic"])
                self.assertEqual(resolved["capability"], DatabaseCapability.DATABASE_COUNT_RECORDS)
                self.assertIn("admission", resolved["arguments"]["entity"].lower())

    def test_count_total_personal_routes_to_deterministic_count_and_clarifies_ambiguous_tables(self):
        resolved = DatabaseSessionManager.resolve_database_intent("count total personal")
        self.assertTrue(resolved["is_deterministic"])
        self.assertEqual(resolved["capability"], DatabaseCapability.DATABASE_COUNT_RECORDS)
        self.assertEqual(resolved["arguments"]["entity"], "personal")

        with tempfile.TemporaryDirectory() as temporary_directory:
            db_path = Path(temporary_directory) / "personal.sqlite"
            connection = sqlite3.connect(db_path)
            connection.execute("CREATE TABLE adm_user_personal (id INTEGER PRIMARY KEY)")
            connection.executemany("INSERT INTO adm_user_personal DEFAULT VALUES", [(), (), ()])
            connection.execute("CREATE TABLE adm_staff_personal (id INTEGER PRIMARY KEY)")
            connection.commit()
            connection.close()
            session = DatabaseSession(
                project_id="personal-count-test",
                repository_id="personal-count-test",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name="personal.sqlite",
                connection_state=DatabaseState.CONNECTED,
                sqlite_file=str(db_path),
            )

            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"), patch.object(
                DatabaseIntelligenceEngine, "execute_safe_query"
            ) as run_count:
                ambiguous = DatabaseSessionManager.execute_database_capability(
                    resolved["capability"],
                    resolved["arguments"],
                    session,
                    temporary_directory,
                )

            self.assertTrue(ambiguous["ok"])
            self.assertEqual(ambiguous["executionStatus"], "NEEDS_CLARIFICATION")
            self.assertFalse(ambiguous["executed"])
            self.assertGreaterEqual(len(ambiguous["candidateTables"]), 2)
            run_count.assert_not_called()

            models_directory = Path(temporary_directory) / "models"
            models_directory.mkdir()
            (models_directory / "UserPersonal.php").write_text(
                '<?php $query = "SELECT * FROM adm_user_personal";',
                encoding="utf-8",
            )
            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"):
                source_supported = DatabaseSessionManager.execute_database_capability(
                    resolved["capability"],
                    resolved["arguments"],
                    session,
                    temporary_directory,
                )

            self.assertTrue(source_supported["ok"])
            self.assertEqual(source_supported["executionStatus"], "SUCCESS")
            self.assertEqual(source_supported["table"], "adm_user_personal")
            self.assertEqual(source_supported["totalRecords"], 3)
            self.assertIn(
                "project source-query evidence",
                source_supported["content"],
            )
            self.assertEqual(
                source_supported["targetResolution"]["sourceQueries"][0]["table"],
                "adm_user_personal",
            )

            connection = sqlite3.connect(db_path)
            connection.execute("DROP TABLE adm_staff_personal")
            connection.commit()
            connection.close()
            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"):
                counted = DatabaseSessionManager.execute_database_capability(
                    resolved["capability"],
                    resolved["arguments"],
                    session,
                    temporary_directory,
                )

            self.assertTrue(counted["ok"])
            self.assertEqual(counted["table"], "adm_user_personal")
            self.assertEqual(counted["totalRecords"], 3)

    def test_count_refreshes_verified_schema_when_initial_live_table_listing_is_empty(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            db_path = Path(temporary_directory) / "personal.sqlite"
            connection = sqlite3.connect(db_path)
            connection.execute("CREATE TABLE adm_user_personal (id INTEGER PRIMARY KEY)")
            connection.executemany(
                "INSERT INTO adm_user_personal DEFAULT VALUES",
                [(), (), ()],
            )
            connection.commit()
            connection.close()
            session = DatabaseSession(
                project_id="personal-count-refresh-test",
                repository_id="personal-count-refresh-test",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name="personal.sqlite",
                connection_state=DatabaseState.CONNECTED,
                sqlite_file=str(db_path),
            )
            original_execute = DatabaseSessionManager.execute_database_capability
            empty_listing_returned = False

            def execute_with_transient_empty_listing(capability, arguments, active_session, root):
                nonlocal empty_listing_returned
                if (
                    capability == DatabaseCapability.DATABASE_LIST_TABLES
                    and not arguments
                    and not empty_listing_returned
                ):
                    empty_listing_returned = True
                    return {"ok": True, "tables": [], "executionStatus": "SUCCESS"}
                return original_execute(capability, arguments, active_session, root)

            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"), patch.object(
                DatabaseSessionManager,
                "execute_database_capability",
                side_effect=execute_with_transient_empty_listing,
            ):
                counted = DatabaseSessionManager.execute_database_capability(
                    DatabaseCapability.DATABASE_COUNT_RECORDS,
                    {"entity": "personal"},
                    session,
                    temporary_directory,
                )

            self.assertTrue(empty_listing_returned)
            self.assertTrue(counted["ok"])
            self.assertEqual(counted["executionStatus"], "SUCCESS")
            self.assertEqual(counted["table"], "adm_user_personal")
            self.assertEqual(counted["totalRecords"], 3)

    def test_count_does_not_run_when_fresh_live_schema_has_no_accessible_tables(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            db_path = Path(temporary_directory) / "empty.sqlite"
            sqlite3.connect(db_path).close()
            session = DatabaseSession(
                project_id="empty-database-count-test",
                repository_id="empty-database-count-test",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name="empty.sqlite",
                connection_state=DatabaseState.CONNECTED,
                sqlite_file=str(db_path),
            )

            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"), patch.object(
                DatabaseIntelligenceEngine, "execute_safe_query"
            ) as run_count:
                result = DatabaseSessionManager.execute_database_capability(
                    DatabaseCapability.DATABASE_COUNT_RECORDS,
                    {"entity": "personal"},
                    session,
                    temporary_directory,
                )

            self.assertFalse(result["ok"])
            self.assertEqual(result["executionStatus"], "NO_LIVE_TABLES")
            self.assertFalse(result["executed"])
            self.assertIn("fresh live-schema check found no accessible tables", result["content"])
            self.assertIn("No count query was run", result["content"])
            run_count.assert_not_called()

    def test_human_database_requests_resolve_actions_targets_and_task_references(self):
        count = DatabaseSessionManager.resolve_database_intent("how many users")
        self.assertTrue(count["is_deterministic"])
        self.assertEqual(count["capability"], DatabaseCapability.DATABASE_COUNT_RECORDS)
        self.assertEqual(count["arguments"]["entity"], "user")

        for request, expected_target in (
            ("show me user data", "user"),
            ("show latest 10 users", "user"),
        ):
            with self.subTest(request=request):
                resolved = DatabaseSessionManager.resolve_database_intent(request)
                self.assertTrue(resolved["is_deterministic"])
                self.assertEqual(resolved["capability"], DatabaseCapability.DATABASE_QUERY)
                self.assertEqual(resolved["arguments"]["entity"], expected_target)
        self.assertFalse(
            DatabaseSessionManager.resolve_database_intent("show users")["is_deterministic"],
            "An unqualified object name must not be assumed to be a database table.",
        )

        location = DatabaseSessionManager.resolve_database_intent("where user email")
        self.assertTrue(location["is_deterministic"])
        self.assertEqual(location["arguments"]["schema_query"]["kind"], "column_location")
        self.assertEqual(location["arguments"]["schema_query"]["term"], "email")
        self.assertEqual(location["arguments"]["schema_query"]["context"], "user")
        exists = DatabaseSessionManager.resolve_database_intent(
            "does table payment_transaction exist"
        )
        self.assertEqual(exists["arguments"]["schema_query"]["kind"], "table_exists")
        described = DatabaseSessionManager.resolve_database_intent("show user table")
        self.assertEqual(described["capability"], DatabaseCapability.DATABASE_DESCRIBE_TABLE)
        self.assertEqual(described["arguments"]["table"], "user")
        indexes = DatabaseSessionManager.resolve_database_intent("show user indexes")
        self.assertEqual(indexes["capability"], DatabaseCapability.DATABASE_LIST_INDEXES)
        self.assertEqual(indexes["arguments"]["table"], "user")

        prior_count = {
            "capability": DatabaseCapability.DATABASE_COUNT_RECORDS,
            "arguments": {"entity": "users"},
            "table": "users",
        }
        how_many = DatabaseSessionManager.resolve_database_intent(
            "how many?",
            task_context=prior_count,
        )
        self.assertEqual(how_many["capability"], DatabaseCapability.DATABASE_COUNT_RECORDS)
        self.assertEqual(how_many["arguments"]["entity"], "users")
        same_for_payment = DatabaseSessionManager.resolve_database_intent(
            "same for payment",
            task_context=prior_count,
        )
        self.assertEqual(same_for_payment["capability"], DatabaseCapability.DATABASE_COUNT_RECORDS)
        self.assertEqual(same_for_payment["arguments"]["entity"], "payment")
        corrected = DatabaseSessionManager.resolve_database_intent(
            "No, I mean payment_transaction",
            task_context=prior_count,
        )
        self.assertEqual(corrected["arguments"]["entity"], "payment_transaction")

        semantics = {
            "how many users": ("COUNT", "verified total count"),
            "show users": ("LIST", "bounded records or requested catalog"),
            "show user table": ("SCHEMA", "verified table schema"),
            "where is user email stored": ("LOCATE", "source or schema location"),
            "how is this data fetched": ("DATA_FLOW_TRACE", "actual application data flow"),
            "how do I fetch users": ("FETCH_GUIDANCE", "project-specific retrieval guidance"),
            "which query fetches this": ("LOCATE_QUERY", "source query and its evidence"),
            "why is this query slow": (
                "PERFORMANCE_ANALYSIS",
                "measured performance evidence and supported cause",
            ),
            "which database is connected": ("RUNTIME_DATABASE_STATUS", "verified active database target"),
            "which migration created this": ("SOURCE_LOOKUP", "migration file and schema change evidence"),
        }
        for request, expected in semantics.items():
            with self.subTest(semantic_request=request):
                understood = understand_human_request(request)
                self.assertEqual(
                    (understood["action"], understood["expected_output"]),
                    expected,
                )
                self.assertEqual(understood["evidence_confidence"], "UNVERIFIED")
        self.assertEqual(classify_task_intent("how many users")["intent"], TaskIntent.DATABASE_INVESTIGATION)
        self.assertEqual(classify_task_intent("show users")["intent"], TaskIntent.DATABASE_INVESTIGATION)
        self.assertEqual(classify_task_intent("how many users")["confidence"], "UNVERIFIED")
        active_today = understand_human_request("how many active users today")
        self.assertEqual(active_today["target"], "users")
        self.assertEqual(active_today["constraints"], ["active", "today"])
        self.assertEqual(understand_human_request("count total personal")["target"], "personal")

    def test_semantic_task_contract_keeps_intent_target_resources_and_evidence_distinct(self):
        task = _build_semantic_task(
            request_id="semantic-task-1",
            user_message="How is this data fetched?",
            intent="DATA_FLOW_TRACE",
            resources=["CODE", "API", "DATABASE"],
            target="this data",
            project_root="C:\\project",
            scope="src",
            architecture={"languages": ["php"], "frameworks": ["yii"]},
            required_evidence=["route", "controller", "query"],
            verification_plan="Trace the request and response path.",
            conversation_message_count=3,
        )

        self.assertEqual(task["taskId"], "semantic-task-1")
        self.assertEqual(task["intent"]["primary"], "DATA_FLOW_TRACE")
        self.assertEqual(task["target"]["userReference"], "this data")
        self.assertEqual(task["resolvedResources"], ["CODE", "API", "DATABASE"])
        self.assertTrue(task["conversationContext"]["used"])
        self.assertEqual(task["projectContext"]["frameworks"], ["yii"])
        self.assertEqual(task["requiredEvidence"], ["route", "controller", "query"])
        self.assertEqual(task["verificationPlan"], "Trace the request and response path.")
        self.assertFalse(task["clarificationRequired"])

    def test_task_state_links_tool_facts_to_evidence_and_synchronizes_working_memory(self):
        task = _build_semantic_task(
            request_id="state-action-1",
            user_message="Find the request handler.",
            intent="CODE_QUESTION",
            resources=["CODE"],
            target="request handler",
            project_root="C:\\project",
            scope="src",
            architecture={},
            required_evidence=["Read the handler source."],
            conversation_message_count=1,
        )
        action = {
            "actionId": "action-read-handler",
            "tool": "read_file",
            "target": "src/handler.py",
            "arguments": {"relativePath": "src/handler.py"},
            "expectedEvidence": "Read the handler source.",
            "resultEvidenceIds": [],
        }
        task["actions"].append(action)

        _update_task_from_tool_result(
            task,
            action,
            {"ok": True, "data": {"path": "src/handler.py", "content": "def handle(): pass"}},
            '{"ok":true,"data":{"path":"src/handler.py","content":"def handle(): pass"}}',
            "state-action-1",
        )

        self.assertEqual(action["status"], "SUCCESS")
        evidence_ids = {item["evidenceId"] for item in task["evidence"]}
        self.assertEqual(action["resultEvidenceIds"], ["ev-action-read-handler"])
        self.assertTrue(all(item["evidenceId"] in evidence_ids for item in task["facts"]))
        self.assertEqual(task["unknowns"], [])
        self.assertEqual(task["knowledgeRevision"], 1)
        self.assertEqual(task["workingMemory"]["previousActions"], task["actions"])
        self.assertEqual(task["resources"][0]["status"], "AVAILABLE")
        compiled = _compile_agent_task_context(task)
        self.assertEqual(compiled["actions"], task["actions"][-8:])
        self.assertEqual(
            compiled["workingMemory"]["candidateResources"],
            ["CODE"],
        )
        self.assertEqual(
            compiled["workingMemory"]["completedInvestigations"],
            [],
        )

    def test_explicit_continue_resumes_the_same_task_and_working_memory(self):
        prior = _build_semantic_task(
            request_id="task-original-turn",
            session_id="continue-session",
            user_message="Find the configured database username.",
            intent="DATABASE_CREDENTIAL_REQUEST",
            resources=["DATABASE", "CONFIGURATION"],
            target="database configuration",
            project_root="C:\\project",
            scope=".",
            architecture={},
            required_evidence=["Resolve the configured username."],
            conversation_message_count=1,
        )
        prior["reasoningCycle"] = 3
        prior["actions"].append({
            "actionId": "task-original-turn:database:1",
            "tool": "DATABASE_CREDENTIAL_REQUEST",
            "status": "SUCCESS",
        })
        prior["evidence"].append({
            "evidenceId": "ev-task-original-turn",
            "summary": '{"username":"NOT_RESOLVED"}',
        })
        prior["workingMemory"]["previousActions"] = prior["actions"]

        current = _build_semantic_task(
            request_id="task-continue-turn",
            session_id="continue-session",
            user_message="continue",
            intent="UNRESOLVED",
            resources=[],
            target=None,
            project_root="C:\\project",
            scope=".",
            architecture={},
            conversation_message_count=3,
            conversation_messages=[
                {"role": "user", "content": prior["originalRequest"]},
                {"role": "assistant", "content": "The username is not resolved yet."},
                {"role": "user", "content": "continue"},
            ],
        )

        resumed = _resume_semantic_task(prior, current, "continue", "task-continue-turn")
        compiled = _compile_agent_task_context(resumed)

        self.assertEqual(resumed["taskId"], prior["taskId"])
        self.assertEqual(resumed["turnId"], "task-continue-turn")
        self.assertEqual(resumed["originalRequest"], prior["originalRequest"])
        self.assertEqual(resumed["currentRequest"], "continue")
        self.assertEqual(resumed["reasoningCycle"], 3)
        self.assertEqual(resumed["actions"], prior["actions"])
        self.assertEqual(resumed["evidence"], prior["evidence"])
        self.assertTrue(resumed["conversationContext"]["continuityDetected"])
        self.assertEqual(compiled["currentRequest"], "continue")

    def test_task_evidence_keeps_redacted_json_parseable(self):
        task = _build_semantic_task(
            request_id="state-json-evidence",
            user_message="Show the configured database username.",
            intent="DATABASE_INVESTIGATION",
            resources=["DATABASE"],
            target="database configuration",
            project_root="C:\\project",
            scope=".",
            architecture={},
            conversation_message_count=1,
        )
        action = {
            "actionId": "action-database-credentials",
            "tool": "DATABASE_CREDENTIAL_REQUEST",
            "target": "active database",
            "arguments": {"properties": ["username"]},
            "resultEvidenceIds": [],
        }
        task["actions"].append(action)
        result = {
            "ok": True,
            "username": "app_user",
            "password": "never-persist-this-password",
            "content": "username: app_user",
        }

        _update_task_from_tool_result(
            task,
            action,
            result,
            json.dumps(result),
            "state-json-evidence",
        )

        evidence = task["evidence"][0]
        summary = json.loads(evidence["summary"])
        self.assertEqual(summary["username"], "app_user")
        self.assertEqual(summary["password"], "[REDACTED]")
        self.assertNotIn("never-persist-this-password", evidence["summary"])

    def test_task_state_failed_action_adds_no_evidence_and_retains_unknown(self):
        task = _build_semantic_task(
            request_id="state-action-failure",
            user_message="Find the request handler.",
            intent="CODE_QUESTION",
            resources=["CODE"],
            target="request handler",
            project_root="C:\\project",
            scope="src",
            architecture={},
            required_evidence=["Read the handler source."],
            conversation_message_count=1,
        )
        action = {
            "actionId": "action-read-handler-failed",
            "tool": "read_file",
            "target": "src/handler.py",
            "arguments": {"relativePath": "src/handler.py"},
            "expectedEvidence": "Read the handler source.",
            "resultEvidenceIds": [],
        }
        task["actions"].append(action)

        _update_task_from_tool_result(
            task,
            action,
            {"ok": False, "error": "file not found"},
            '{"ok":false,"error":"file not found"}',
            "state-action-failure",
        )

        self.assertEqual(action["status"], "FAILED")
        self.assertEqual(task["evidence"], [])
        self.assertEqual(task["facts"], [])
        self.assertEqual(task["unknowns"][0]["question"], "Read the handler source.")
        self.assertEqual(task["failedActions"][0]["knowledgeRevision"], 0)
        self.assertEqual(task["resources"][0]["status"], "UNAVAILABLE")

    def test_task_state_redacts_secrets_from_persisted_memory(self):
        task = _build_semantic_task(
            request_id="state-safe-memory",
            user_message="Check database password=supersecret123",
            intent="DATABASE_INVESTIGATION",
            resources=["DATABASE"],
            target="password=supersecret123",
            project_root="C:\\project",
            scope=".",
            architecture={},
            required_evidence=["Inspect password=supersecret123 safely."],
            conversation_message_count=1,
        )

        self.assertNotIn("supersecret123", json.dumps(task))
        self.assertIn("[REDACTED]", task["userMessage"])

    def test_show_records_resolves_live_table_bounds_rows_and_clarifies_ambiguous_target(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            db_path = Path(temporary_directory) / "records.sqlite"
            connection = sqlite3.connect(db_path)
            connection.execute(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, created_at DATETIME)"
            )
            connection.executemany(
                "INSERT INTO users (email, created_at) VALUES (?, ?)",
                [
                    ("first@example.test", "2026-10-01 10:00:00"),
                    ("second@example.test", "2026-10-02 10:00:00"),
                    ("third@example.test", "2026-10-03 10:00:00"),
                ],
            )
            connection.execute("CREATE TABLE adm_user_personal (id INTEGER PRIMARY KEY)")
            connection.execute("INSERT INTO adm_user_personal DEFAULT VALUES")
            connection.execute("CREATE TABLE adm_staff_personal (id INTEGER PRIMARY KEY)")
            connection.execute("INSERT INTO adm_staff_personal DEFAULT VALUES")
            connection.commit()
            connection.close()
            session = DatabaseSession(
                project_id="list-records-test",
                repository_id="list-records-test",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name="records.sqlite",
                connection_state=DatabaseState.CONNECTED,
                sqlite_file=str(db_path),
            )

            latest_intent = DatabaseSessionManager.resolve_database_intent("show latest 2 users")
            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"):
                latest = DatabaseSessionManager.execute_database_capability(
                    latest_intent["capability"],
                    latest_intent["arguments"],
                    session,
                    temporary_directory,
                )

            self.assertTrue(latest["ok"])
            self.assertEqual(latest["table"], "users")
            self.assertEqual(latest["rowCount"], 2)
            self.assertEqual(
                [row["email"] for row in latest["rows"]],
                ["third@example.test", "second@example.test"],
            )
            self.assertIn("ORDER BY created_at DESC LIMIT 2", latest["content"])

            describe_intent = DatabaseSessionManager.resolve_database_intent("show user table")
            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"):
                described = DatabaseSessionManager.execute_database_capability(
                    describe_intent["capability"],
                    describe_intent["arguments"],
                    session,
                    temporary_directory,
                )
            self.assertTrue(described["ok"])
            self.assertEqual(described["table"], "users")
            self.assertIn("email", [column["name"] for column in described["columns"]])

            ambiguous_intent = DatabaseSessionManager.resolve_database_intent("show personal data")
            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"), patch.object(
                DatabaseIntelligenceEngine, "execute_safe_query"
            ) as execute_query:
                ambiguous = DatabaseSessionManager.execute_database_capability(
                    ambiguous_intent["capability"],
                    ambiguous_intent["arguments"],
                    session,
                    temporary_directory,
                )

            self.assertTrue(ambiguous["ok"])
            self.assertEqual(ambiguous["executionStatus"], "NEEDS_CLARIFICATION")
            self.assertFalse(ambiguous["executed"])
            self.assertEqual(
                set(ambiguous["candidateTables"]),
                {"adm_user_personal", "adm_staff_personal"},
            )
            execute_query.assert_not_called()

    def test_filtered_count_uses_live_schema_and_never_drops_requested_conditions(self):
        request = "how many active users today"
        resolved = DatabaseSessionManager.resolve_database_intent(request)
        self.assertTrue(resolved["is_deterministic"])
        self.assertEqual(resolved["capability"], DatabaseCapability.DATABASE_COUNT_RECORDS)
        self.assertEqual(resolved["arguments"]["entity"], "user")
        self.assertEqual(set(resolved["arguments"]["filters"]), {"active", "today"})
        self.assertEqual(
            understand_human_request(request)["constraints"],
            ["active", "today"],
        )

        with tempfile.TemporaryDirectory() as temporary_directory:
            db_path = Path(temporary_directory) / "filtered-users.sqlite"
            connection = sqlite3.connect(db_path)
            connection.execute(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, is_active BOOLEAN, created_at DATE)"
            )
            connection.execute(
                "INSERT INTO users (is_active, created_at) VALUES "
                "(1, CURRENT_DATE), (1, DATE('now', '-1 day')), (0, CURRENT_DATE)"
            )
            connection.commit()
            connection.close()
            session = DatabaseSession(
                project_id="filtered-count-test",
                repository_id="filtered-count-test",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name="filtered-users.sqlite",
                connection_state=DatabaseState.CONNECTED,
                sqlite_file=str(db_path),
            )

            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"):
                counted = DatabaseSessionManager.execute_database_capability(
                    resolved["capability"],
                    resolved["arguments"],
                    session,
                    temporary_directory,
                )

            self.assertTrue(counted["ok"])
            self.assertEqual(counted["executionStatus"], "SUCCESS")
            self.assertEqual(counted["totalRecords"], 1)
            self.assertIn("is_active = 1", counted["content"])
            self.assertIn("created_at is today", counted["content"])

            unresolved_db = sqlite3.connect(db_path)
            unresolved_db.execute("DROP TABLE users")
            unresolved_db.execute(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, status INTEGER, created_at DATE)"
            )
            unresolved_db.execute(
                "INSERT INTO users (status, created_at) VALUES "
                "(1, CURRENT_DATE), (0, CURRENT_DATE)"
            )
            unresolved_db.commit()
            unresolved_db.close()
            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"), patch.object(
                DatabaseIntelligenceEngine, "execute_safe_query", wraps=DatabaseIntelligenceEngine.execute_safe_query
            ) as run_query:
                needs_clarification = DatabaseSessionManager.execute_database_capability(
                    resolved["capability"],
                    resolved["arguments"],
                    session,
                    temporary_directory,
                )

            self.assertTrue(needs_clarification["ok"])
            self.assertEqual(needs_clarification["executionStatus"], "NEEDS_CLARIFICATION")
            self.assertFalse(needs_clarification["executed"])
            self.assertIn("no count query was run", needs_clarification["content"].lower())
            self.assertTrue(
                all("SELECT COUNT(*)" not in call.args[1] for call in run_query.call_args_list)
            )

    def test_count_arbitrary_misspelled_table_identifier_matches_unique_live_table(self):
        request = "count total adm_user_prgramme_selection"
        resolved = DatabaseSessionManager.resolve_database_intent(request)
        self.assertTrue(resolved["is_deterministic"])
        self.assertEqual(resolved["capability"], DatabaseCapability.DATABASE_COUNT_RECORDS)
        self.assertEqual(resolved["arguments"]["entity"], "adm_user_prgramme_selection")
        sql_resolved = DatabaseSessionManager.resolve_database_intent(
            "SELECT COUNT(*) AS total FROM adm_user_prgramme_selection;"
        )
        self.assertTrue(sql_resolved["is_deterministic"])
        self.assertEqual(
            sql_resolved["capability"],
            DatabaseCapability.DATABASE_COUNT_RECORDS,
        )
        self.assertEqual(
            sql_resolved["arguments"]["entity"],
            "adm_user_prgramme_selection",
        )

        with tempfile.TemporaryDirectory() as temporary_directory:
            db_path = Path(temporary_directory) / "admissions.sqlite"
            connection = sqlite3.connect(db_path)
            connection.execute(
                "CREATE TABLE adm_user_programme_selection (id INTEGER PRIMARY KEY)"
            )
            connection.executemany(
                "INSERT INTO adm_user_programme_selection DEFAULT VALUES",
                [(), (), ()],
            )
            connection.commit()
            connection.close()
            session = DatabaseSession(
                project_id="table-typo-count-test",
                repository_id="table-typo-count-test",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name="admissions.sqlite",
                connection_state=DatabaseState.CONNECTED,
                sqlite_file=str(db_path),
            )

            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"):
                counted = DatabaseSessionManager.execute_database_capability(
                    DatabaseCapability.DATABASE_COUNT_RECORDS,
                    resolved["arguments"],
                    session,
                    temporary_directory,
                )
                sql_counted = DatabaseSessionManager.execute_database_capability(
                    sql_resolved["capability"],
                    sql_resolved["arguments"],
                    session,
                    temporary_directory,
                )
            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseIntelligenceEngine, "execute_safe_query") as run_count:
                unknown = DatabaseSessionManager.execute_database_capability(
                    DatabaseCapability.DATABASE_COUNT_RECORDS,
                    {"entity": "unrelated_table_identifier"},
                    session,
                    temporary_directory,
                )
                run_count.assert_not_called()

        self.assertTrue(counted["ok"])
        self.assertEqual(counted["table"], "adm_user_programme_selection")
        self.assertEqual(counted["totalRecords"], 3)
        self.assertTrue(sql_counted["ok"])
        self.assertEqual(sql_counted["table"], counted["table"])
        self.assertEqual(sql_counted["totalRecords"], counted["totalRecords"])
        self.assertFalse(unknown["ok"])
        self.assertEqual(unknown["executionStatus"], "NOT_FOUND")
        self.assertFalse(unknown["executed"])
        self.assertNotIn("clarificationOptions", unknown)

    def test_count_long_table_identifier_does_not_substitute_short_substring_table(self):
        request = "count total adm_user_prgramme_personal"
        resolved = DatabaseSessionManager.resolve_database_intent(request)
        self.assertTrue(resolved["is_deterministic"])
        self.assertEqual(
            resolved["arguments"]["entity"],
            "adm_user_prgramme_personal",
        )

        with tempfile.TemporaryDirectory() as temporary_directory:
            db_path = Path(temporary_directory) / "admissions.sqlite"
            connection = sqlite3.connect(db_path)
            for table in (
                "adm_user",
                "adm_user_programme_selection",
                "adm_user_programme_personal_details",
            ):
                connection.execute(f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY)')
            connection.executemany(
                "INSERT INTO adm_user (id) VALUES (?)",
                [(1,), (2,)],
            )
            connection.commit()
            connection.close()
            session = DatabaseSession(
                project_id="long-table-identifier-count-test",
                repository_id="long-table-identifier-count-test",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name="admissions.sqlite",
                connection_state=DatabaseState.CONNECTED,
                sqlite_file=str(db_path),
            )

            with patch.object(
                DatabaseTargetRegistry,
                "get_target",
                return_value=None,
            ), patch.object(
                DatabaseTargetRegistry,
                "get_active_target",
                return_value=None,
            ), patch.object(DatabaseEvidenceStore, "record_proof"):
                result = DatabaseSessionManager.execute_database_capability(
                    resolved["capability"],
                    resolved["arguments"],
                    session,
                    temporary_directory,
                )

        self.assertTrue(result["ok"])
        self.assertEqual(result["executionStatus"], "NEEDS_CLARIFICATION")
        self.assertFalse(result["executed"])
        self.assertNotIn("totalRecords", result)
        self.assertEqual(
            set(result["candidateTables"]),
            {
                "adm_user",
                "adm_user_programme_personal_details",
                "adm_user_programme_selection",
            },
        )
        self.assertIn("2. `adm_user_programme_selection`", result["content"])

    def test_schema_learning_fingerprints_live_metadata_and_serves_cached_searches(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            store = DatabaseSchemaKnowledgeStore(str(root / "schema-knowledge.json"))
            original_store = DatabaseSessionManager.schema_knowledge_store
            self.addCleanup(
                setattr,
                DatabaseSessionManager,
                "schema_knowledge_store",
                original_store,
            )
            DatabaseSessionManager.schema_knowledge_store = store
            db_path = root / "selected.sqlite"
            other_db_path = root / "another.sqlite"
            other = sqlite3.connect(other_db_path)
            other.execute("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)")
            other.commit()
            other.close()

            connection = sqlite3.connect(db_path)
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute(
                "CREATE TABLE app_user ("
                "id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)"
            )
            connection.execute(
                "CREATE TABLE admission ("
                "id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, "
                "FOREIGN KEY (user_id) REFERENCES app_user(id))"
            )
            connection.execute("CREATE INDEX idx_admission_user ON admission(user_id)")
            connection.commit()
            connection.close()

            session = DatabaseSession(
                project_id="schema-learning-test",
                repository_id="schema-learning-test",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name="selected.sqlite",
                connection_state=DatabaseState.CONNECTED,
                sqlite_file=str(db_path),
                session_id="schema-learning-session",
            )
            learn_intent = DatabaseSessionManager.resolve_database_intent(
                "this is my database, read and understand its schema"
            )
            self.assertTrue(learn_intent["is_deterministic"])
            self.assertEqual(learn_intent["capability"], DatabaseCapability.DATABASE_LIST_TABLES)
            self.assertTrue(learn_intent["arguments"]["learn_schema"])

            learned = DatabaseSessionManager.execute_database_capability(
                learn_intent["capability"],
                learn_intent["arguments"],
                session,
                temporary_directory,
            )

            self.assertTrue(learned["ok"])
            self.assertEqual(learned["executionStatus"], "SUCCESS")
            self.assertEqual(learned["resultSource"], DatabaseEvidenceSource.LIVE_DB_EXECUTION)
            self.assertEqual(set(learned["tables"]), {"app_user", "admission"})
            knowledge = learned["schemaKnowledge"]
            self.assertEqual(knowledge["provenance"]["databaseSessionId"], session.session_id)
            self.assertTrue(knowledge["fingerprint"])
            self.assertEqual(
                knowledge["schema"]["details"]["admission"]["foreign_keys"][0]["referencedTable"],
                "app_user",
            )
            persisted = store.load(session.schema_knowledge_key())
            self.assertEqual(persisted["fingerprint"], knowledge["fingerprint"])
            restarted_session = DatabaseSession(
                project_id="schema-learning-test",
                repository_id="schema-learning-test",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name="selected.sqlite",
                connection_state=DatabaseState.CONNECTED,
                sqlite_file=str(db_path),
                session_id="schema-learning-session-after-restart",
            )
            self.assertTrue(restarted_session.restore_schema_knowledge(persisted))
            self.assertEqual(
                restarted_session.get_schema_knowledge()["fingerprint"],
                knowledge["fingerprint"],
            )
            session = restarted_session

            column_intent = DatabaseSessionManager.resolve_database_intent(
                "where is user email stored"
            )
            self.assertEqual(
                column_intent["arguments"]["schema_query"]["kind"],
                "column_location",
            )
            with patch.object(
                DatabaseIntelligenceEngine,
                "inspect_database_schema",
                side_effect=AssertionError("A learned schema search must use the verified session cache."),
            ):
                column_result = DatabaseSessionManager.execute_database_capability(
                    column_intent["capability"],
                    column_intent["arguments"],
                    session,
                    temporary_directory,
                )
                references_intent = DatabaseSessionManager.resolve_database_intent(
                    "which tables reference app_user"
                )
                references_result = DatabaseSessionManager.execute_database_capability(
                    references_intent["capability"],
                    references_intent["arguments"],
                    session,
                    temporary_directory,
                )
                indexes_intent = DatabaseSessionManager.resolve_database_intent(
                    "what indexes exist on admission"
                )
                indexes_result = DatabaseSessionManager.execute_database_capability(
                    indexes_intent["capability"],
                    indexes_intent["arguments"],
                    session,
                    temporary_directory,
                )

            self.assertIn("`app_user.email`", column_result["content"])
            self.assertEqual(column_result["resultSource"], "CACHED_VERIFIED_SCHEMA")
            self.assertIn("Cached previously verified schema", column_result["content"])
            self.assertIn(knowledge["fingerprint"], column_result["content"])
            self.assertIn("`admission`", references_result["content"])
            self.assertIn("foreign keys", references_result["content"])
            self.assertIn("idx_admission_user", indexes_result["content"])

            old_fingerprint = knowledge["fingerprint"]
            old_discovered_at = knowledge["discoveredAt"]
            connection = sqlite3.connect(db_path)
            connection.execute("ALTER TABLE app_user ADD COLUMN display_name TEXT")
            connection.commit()
            connection.close()
            refresh_intent = DatabaseSessionManager.resolve_database_intent(
                "check current live schema"
            )
            self.assertTrue(refresh_intent["arguments"]["refresh_schema"])
            refreshed = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_LIST_TABLES,
                {**refresh_intent["arguments"], "learn_schema": True},
                session,
                temporary_directory,
            )
            self.assertNotEqual(refreshed["schemaFingerprint"], old_fingerprint)
            self.assertTrue(refreshed["schemaChanged"])
            self.assertEqual(refreshed["schemaKnowledge"]["discoveredAt"], refreshed["schemaKnowledge"]["lastVerifiedAt"])
            self.assertNotEqual(refreshed["schemaKnowledge"]["discoveredAt"], old_discovered_at)
            self.assertIn(
                "display_name",
                [
                    column["name"]
                    for column in refreshed["schemaKnowledge"]["schema"]["details"]["app_user"]["columns"]
                ],
            )

    def test_database_clarification_accepts_option_number(self):
        clarification = "Choose a table: 1. `users`; 2. `accounts`"
        pending = {
            "capability": DatabaseCapability.DATABASE_COUNT_RECORDS,
            "clarificationContent": clarification,
            "clarificationType": "table",
            "arguments": {"entity": "account"},
            "request": "count accounts",
            "options": [
                {"label": "users", "value": "users"},
                {"label": "accounts", "value": "accounts"},
            ],
        }
        resumed = _match_pending_database_clarification(
            pending,
            [
                {"role": "user", "content": "count accounts"},
                {"role": "assistant", "content": clarification},
                {"role": "user", "content": "option 2"},
            ],
            project_root="",
        )
        self.assertEqual(resumed["arguments"]["entity"], "accounts")
        self.assertEqual(resumed["original_request"], "count accounts")

        corrected = _match_pending_database_clarification(
            pending,
            [
                {"role": "user", "content": "count accounts"},
                {"role": "assistant", "content": clarification},
                {"role": "user", "content": "No, I mean student_accounts"},
            ],
            project_root="",
        )
        self.assertEqual(corrected["arguments"]["entity"], "student_accounts")
        self.assertEqual(corrected["capability"], DatabaseCapability.DATABASE_COUNT_RECORDS)

    def test_count_paid_admission_resolves_to_pay_status_filter_and_counts_only_paid_rows(self):
        for request in ("count paid admission data", "count paid admissions"):
            with self.subTest(request=request):
                resolved = DatabaseSessionManager.resolve_database_intent(request)
                self.assertTrue(resolved["is_deterministic"])
                self.assertEqual(resolved["capability"], DatabaseCapability.DATABASE_COUNT_RECORDS)
                self.assertEqual(resolved["arguments"]["payment_filter"], "paid")
                self.assertIn("admission", resolved["arguments"]["entity"].lower())

        with tempfile.TemporaryDirectory() as temporary_directory:
            db_path = Path(temporary_directory) / "admissions.sqlite"
            connection = sqlite3.connect(db_path)
            connection.execute("CREATE TABLE admission (id INTEGER PRIMARY KEY, pay_status INTEGER)")
            connection.executemany(
                "INSERT INTO admission (pay_status) VALUES (?)",
                [(9,), (9,), (9,), (9,), (9,), (9,), (0,)],
            )
            connection.commit()
            connection.close()
            session = DatabaseSession(
                project_id="paid-count-test",
                repository_id="paid-count-test",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name="admissions.sqlite",
                connection_state=DatabaseState.CONNECTED,
                sqlite_file=str(db_path),
            )

            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"):
                counted = DatabaseSessionManager.execute_database_capability(
                    DatabaseCapability.DATABASE_COUNT_RECORDS,
                    {"entity": "admission", "payment_filter": "paid"},
                    session,
                    temporary_directory,
                )

            self.assertTrue(counted["ok"])
            self.assertEqual(counted["executionStatus"], "NEEDS_CLARIFICATION")
            self.assertFalse(counted["executed"])
            self.assertEqual(
                [option["value"] for option in counted["clarificationOptions"]],
                ["0", "9"],
            )
            self.assertIn("Choose the value that represents paid", counted["content"])

            count_request = DatabaseSessionManager.resolve_database_intent(
                "count paid admission where pay_status = 9"
            )
            self.assertEqual(count_request["arguments"]["entity"], "admission")
            self.assertEqual(count_request["arguments"]["payment_value"], "9")
            self.assertEqual(count_request["arguments"]["payment_column"], "pay_status")
            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"):
                confirmed_count = DatabaseSessionManager.execute_database_capability(
                    DatabaseCapability.DATABASE_COUNT_RECORDS,
                    {**count_request["arguments"], "payment_filter": "paid"},
                    session,
                    temporary_directory,
                )
            self.assertTrue(confirmed_count["ok"])
            self.assertEqual(confirmed_count["totalRecords"], 6)
            self.assertIn("**Paid records:** 6", confirmed_count["content"])
            self.assertIn("`pay_status = 9`", confirmed_count["content"])

            connection = sqlite3.connect(db_path)
            connection.execute("DELETE FROM admission")
            connection.executemany(
                "INSERT INTO admission (pay_status) VALUES (?)",
                [("paid",), ("unpaid",), ("pending",)],
            )
            connection.commit()
            connection.close()
            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"):
                inferred_count = DatabaseSessionManager.execute_database_capability(
                    DatabaseCapability.DATABASE_COUNT_RECORDS,
                    {"entity": "admission", "payment_filter": "paid"},
                    session,
                    temporary_directory,
                )
            self.assertTrue(inferred_count["ok"])
            self.assertEqual(inferred_count["totalRecords"], 1)
            self.assertIn("`pay_status = paid`", inferred_count["content"])

    def test_count_admission_data_uses_live_sqlite_rows_and_never_guesses_ambiguous_tables(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            db_path = Path(temporary_directory) / "admissions.sqlite"
            connection = sqlite3.connect(db_path)
            connection.execute("CREATE TABLE admission (id INTEGER PRIMARY KEY, applicant TEXT)")
            connection.executemany(
                "INSERT INTO admission (applicant) VALUES (?)",
                [("A",), ("B",), ("C",)],
            )
            connection.commit()
            connection.close()
            session = DatabaseSession(
                project_id="count-test",
                repository_id="count-test",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name="admissions.sqlite",
                connection_state=DatabaseState.CONNECTED,
                sqlite_file=str(db_path),
            )

            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"):
                counted = DatabaseSessionManager.execute_database_capability(
                    DatabaseCapability.DATABASE_COUNT_RECORDS,
                    {"entity": "admission"},
                    session,
                    temporary_directory,
                )

            self.assertTrue(counted["ok"])
            self.assertEqual(counted["table"], "admission")
            self.assertEqual(counted["totalRecords"], 3)
            self.assertIn("Total records:** 3", counted["content"])
            self.assertTrue(counted["executed"])

            connection = sqlite3.connect(db_path)
            connection.execute("CREATE TABLE app_application_archive (id INTEGER)")
            connection.execute("CREATE TABLE student_application_history (id INTEGER)")
            connection.commit()
            connection.close()
            with patch.object(DatabaseTargetRegistry, "get_target", return_value=None), patch.object(
                DatabaseTargetRegistry, "get_active_target", return_value=None
            ), patch.object(DatabaseEvidenceStore, "record_proof"), patch.object(
                DatabaseIntelligenceEngine, "execute_safe_query"
            ) as run_count:
                ambiguous = DatabaseSessionManager.execute_database_capability(
                    DatabaseCapability.DATABASE_COUNT_RECORDS,
                    {"entity": "application"},
                    session,
                    temporary_directory,
                )

            self.assertTrue(ambiguous["ok"])
            self.assertEqual(ambiguous["executionStatus"], "NEEDS_CLARIFICATION")
            self.assertFalse(ambiguous["executed"])
            self.assertEqual(len(ambiguous["candidateTables"]), 2)
            run_count.assert_not_called()

    def test_hinglish_slow_query_request_uses_deterministic_performance_path(self):
        for request in ("which query is take time", "which query takes time", "which query is taking time"):
            with self.subTest(request=request):
                resolved = DatabaseSessionManager.resolve_database_intent(request)
                self.assertTrue(resolved["is_deterministic"])
                self.assertEqual(resolved["capability"], DatabaseCapability.DATABASE_SLOW_QUERIES)

    def test_show_database_connection_routes_to_status_without_schema_or_config_dump(self):
        request = "show my db connection"
        resolved = DatabaseSessionManager.resolve_database_intent(request)
        intent = classify_task_intent(request)

        self.assertTrue(DATABASE_CONNECTION_STATUS_PATTERN.search(request))
        self.assertTrue(resolved["is_deterministic"])
        self.assertEqual(resolved["capability"], DatabaseCapability.DATABASE_CURRENT_TARGET)
        self.assertEqual(intent["intent"], TaskIntent.DATABASE_CURRENT_TARGET)
        for short_request in ("show my db", "show my database"):
            with self.subTest(request=short_request):
                short_resolved = DatabaseSessionManager.resolve_database_intent(short_request)
                short_intent = classify_task_intent(short_request)
                self.assertTrue(DATABASE_CONNECTION_STATUS_PATTERN.search(short_request))
                self.assertTrue(short_resolved["is_deterministic"])
                self.assertEqual(short_resolved["capability"], DatabaseCapability.DATABASE_CURRENT_TARGET)
                self.assertEqual(short_intent["intent"], TaskIntent.DATABASE_CURRENT_TARGET)

        session = DatabaseSession(
            project_id="test-project",
            repository_id="test-repository",
            project_root=".",
            database_type="mysql",
            database_name="admissions",
            connection_state="CONNECTED",
            target_id="DB-001",
            safe_host="db.internal",
            safe_port=3306,
        )
        config = {
            "status": "CONFIGURED",
            "configFile": "config/db.php",
            "fileContent": "'password' => 'must-not-be-shown'",
            "engine": "mysql",
            "database": {"value": "admissions", "status": "RESOLVED"},
            "host": {"value": "db.internal", "status": "RESOLVED"},
            "port": {"value": 3306, "status": "RESOLVED"},
            "username": {"value": "app_user", "status": "RESOLVED"},
            "activeComponent": "Yii::$app->db",
            "componentClass": "yii\\db\\Connection",
        }
        live = {
            "status": "LIVE_VERIFIED",
            "connected": True,
            "database": "admissions",
            "host": "mysql-node",
            "port": 3306,
            "engine": "mysql",
        }
        with patch.object(
            ConfigurationSymbolResolver,
            "inspect_project_database_configuration",
            return_value=config,
        ), patch.object(
            ConfigurationSymbolResolver,
            "verify_live_database_identity",
            return_value=live,
        ):
            result = DatabaseSessionManager.execute_database_capability(
                resolved["capability"],
                {"user_request": request},
                session,
                ".",
            )

        self.assertTrue(result["ok"])
        self.assertIn("DATABASE CONNECTION STATUS", result["content"])
        self.assertIn("LIVE_VERIFIED", result["content"])
        self.assertIn("Username:** app_user", result["content"])
        self.assertNotIn("INSPECTED CONFIGURATION FILE", result["content"])
        self.assertNotIn("must-not-be-shown", result["content"])
        self.assertNotIn("Relevant table/query discovered", result["content"])
        self.assertNotIn("SCAN TABLE orders", result["content"])

    def test_mysql_query_performance_uses_live_digest_statistics(self):
        session = SimpleNamespace(
            database_type="mysql",
            database_name="appdb",
            sqlite_file=None,
            safe_host="localhost",
            safe_port=3306,
            target_id="DB-001",
            _protected_credentials={"username": "configured_user", "password": "test-secret"},
        )
        digest = {
            "query_digest": "SELECT * FROM `adm_user_academic`",
            "executions": 4,
            "total_time_ms": 200.0,
            "average_time_ms": 50.0,
            "max_time_ms": 75.0,
            "rows_examined": 400,
            "rows_sent": 400,
        }
        with tempfile.TemporaryDirectory() as project_root, patch.object(
            DatabaseIntelligenceEngine,
            "execute_safe_query",
            return_value={"ok": True, "rows": [digest]},
        ) as execute_query:
            source_dir = Path(project_root) / "controllers"
            source_dir.mkdir()
            (source_dir / "AcademicController.php").write_text(
                "<?php\n"
                "class AcademicController {\n"
                "    public function actionIndex() {\n"
                "        foreach ($applications as $application) {\n"
                "            $academic = AdmUserAcademic::find()->where(['id' => $application->id])->one();\n"
                "        }\n"
                "    }\n"
                "}\n",
                encoding="utf-8",
            )
            result = DatabasePerformanceEngine.autonomous_investigate_expensive_queries(
                project_root,
                session=session,
                intent_detail="average_time",
            )

        self.assertEqual(result["evidenceQuality"], "VERIFIED_LIVE")
        self.assertEqual(result["timingMs"], 50.0)
        self.assertEqual(result["candidate"]["executionCount"], 4)
        self.assertIn("50.000 ms", result["content"])
        self.assertIn("#### Query 1 (average: 50.000 ms)", result["content"])
        self.assertIn("```sql\nSELECT * FROM `adm_user_academic`\n```", result["content"])
        self.assertNotIn("test-secret", result["content"])
        self.assertEqual(result["candidate"]["sourceCandidates"][0]["sourceFile"], "controllers/AcademicController.php")
        self.assertEqual(result["candidate"]["sourceCandidates"][0]["functionName"], "actionIndex")
        self.assertIsNotNone(result["candidate"]["sourceCandidates"][0]["loopContextLine"])
        self.assertIn("not counts for one academic action or request", result["content"])
        self.assertIn("SCHEMA_NAME = DATABASE()", execute_query.call_args.args[1])
        self.assertIn("EVENTS_STATEMENTS_SUMMARY_BY_DIGEST", execute_query.call_args.args[1])

    def test_query_source_mapping_requires_query_evidence_not_only_a_table_name(self):
        with tempfile.TemporaryDirectory() as project_root:
            source_dir = Path(project_root) / "models"
            source_dir.mkdir()
            (source_dir / "Academic.php").write_text(
                "<?php\n"
                "class Academic {\n"
                "    public function label() {\n"
                "        return 'adm_user_academic';\n"
                "    }\n"
                "}\n",
                encoding="utf-8",
            )

            result = QueryToSourceMapper.map_query_to_source(
                project_root,
                "SELECT * FROM `adm_user_academic`",
            )

        self.assertEqual(result["status"], "SOURCE_MAPPING_UNVERIFIED")
        self.assertIsNone(result["sourceFile"])

    def test_missing_performance_samples_never_fabricate_query_timings(self):
        session = SimpleNamespace(
            database_type="mysql",
            database_name="appdb",
            sqlite_file=None,
            safe_host="localhost",
            safe_port=3306,
            target_id="DB-001",
            _protected_credentials={},
        )
        with tempfile.TemporaryDirectory() as project_root, patch.object(
            DatabaseIntelligenceEngine,
            "execute_safe_query",
            return_value={"ok": False, "error": {"code": "DATABASE_QUERY_FAILED"}},
        ):
            result = DatabasePerformanceEngine.autonomous_investigate_expensive_queries(
                project_root,
                session=session,
                intent_detail="average_time",
            )

        self.assertIsNone(result["timingMs"])
        self.assertEqual(result["evidenceQuality"], "UNVERIFIED")
        self.assertEqual(result["queries"], [])
        self.assertIn("Runtime query statistics are unavailable", result["content"])
        self.assertNotIn("14.2", result["content"])
        self.assertNotIn("orders", result["content"])

    def test_performance_investigation_without_live_evidence_does_not_invent_orders_or_plan(self):
        candidate = {
            "rawQuery": "SELECT * FROM personal",
            "averageTimeMs": None,
            "rowsExamined": None,
            "rowsReturned": None,
        }
        with tempfile.TemporaryDirectory() as project_root, patch.object(
            DatabasePerformanceEngine,
            "rank_queries",
            return_value=[candidate],
        ), patch.object(
            QueryToSourceMapper,
            "map_query_to_source",
            return_value={},
        ), patch.object(
            DatabaseIntelligenceEngine,
            "inspect_database_schema",
            return_value={"tables": ["personal"], "schema_details": {}},
        ), patch.object(
            DatabaseIntelligenceEngine,
            "execute_query_and_explain",
            return_value={},
        ):
            result = DatabasePerformanceEngine.autonomous_investigate_expensive_queries(
                project_root,
                intent_detail="average_time",
            )

        self.assertIsNone(result["timingMs"])
        self.assertIsNone(result["classification"])
        self.assertEqual(result["evidenceQuality"], "UNVERIFIED")
        self.assertIn("UNAVAILABLE (no live query plan)", result["content"])
        self.assertIn("UNAVAILABLE (insufficient evidence)", result["content"])
        self.assertNotIn("orders", result["content"])
        self.assertNotIn("models/Order.php", result["content"])
        self.assertNotIn("SCAN TABLE", result["content"])
        self.assertNotIn("14.2", result["content"])
        self.assertNotIn("1000", result["content"])

    def test_database_investigation_report_does_not_invent_query_or_orders_scan(self):
        report = DatabaseIntelligenceEngine.format_database_investigation_report(
            {},
            {"connected": False, "status": "UNVERIFIED"},
            {"tables": ["personal"], "schema_details": {}},
        )

        self.assertIn("Database connection not verified.", report)
        self.assertIn("Connection: NOT_VERIFIED", report)
        self.assertIn("UNAVAILABLE (no query evidence)", report)
        self.assertIn("UNAVAILABLE (no query plan evidence)", report)
        self.assertIn("UNAVAILABLE (no query-specific timing evidence)", report)
        self.assertNotIn("orders", report)
        self.assertNotIn("SCAN TABLE", report)
        self.assertNotIn("Full Table Scan", report)
        self.assertNotIn("unindexed sequential scanning", report)

    def test_hinglish_database_credentials_request_is_deterministic_and_reports_configured_user(self):
        for request in (
            "mydb connection user and passwd kiya hai",
            "show my db username and password",
            "show my db username and passwod",
            "sow my db useranme and passwod",
        ):
            with self.subTest(request=request):
                resolved = DatabaseSessionManager.resolve_database_intent(request)
                self.assertTrue(resolved["is_deterministic"])
                self.assertEqual(resolved["capability"], DatabaseCapability.DATABASE_CREDENTIAL_REQUEST)
                normalized = EngineeringCommandNormalizer.normalize(request)
                self.assertTrue(DATABASE_CREDENTIAL_REQUEST_PATTERN.search(normalized))
                if request.startswith("sow "):
                    self.assertIn("username", normalized)

        session = DatabaseSession(
            project_id="test-project",
            repository_id="test-repository",
            project_root=".",
            database_type="mysql",
            database_name="admissions",
            connection_state="CONNECTED",
            target_id="DB-004",
        )
        discovered = {
            "username": "configured_user",
            "configFile": "config/db.php",
            "has_credentials": True,
            "_symbol_details": {"hasPassword": True},
        }
        credentials = {"username": "configured_user", "password": "test-only-secret"}
        with patch.object(
            DatabaseIntelligenceEngine,
            "discover_database_configuration",
            return_value=discovered,
        ), patch.object(
            ConfigurationSymbolResolver,
            "get_credential",
            return_value=credentials,
        ), patch.object(
            DatabaseTargetRegistry,
            "get_active_target",
            return_value=SimpleNamespace(
                target_id="DB-004",
                username="stale_user",
                config_file="old/config.php",
            ),
        ):
            result = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
                {},
                session,
                ".",
            )
            username_result = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
                {"properties": ["username"]},
                session,
                ".",
            )

        self.assertTrue(result["ok"])
        self.assertIn("**Database:** admissions", result["content"])
        self.assertIn("**Username:** configured_user", result["content"])
        self.assertIn("**Credential status:** CONFIGURED", result["content"])
        self.assertIn("**Password:** [REDACTED]", result["content"])
        self.assertNotIn("test-only-secret", result["content"])
        self.assertNotIn("test-only-secret", json.dumps(result))
        self.assertEqual(result["credentialSource"], "config/db.php")
        self.assertEqual(result["database"], "admissions")
        self.assertEqual(result["password"], "[REDACTED]")
        self.assertEqual(result["targetId"], "DB-004")
        self.assertNotIn("stale_user", result["content"])
        self.assertEqual(username_result["content"], "username: configured_user")
        self.assertNotIn("test-only-secret", username_result["content"])

    def test_credential_capability_does_not_claim_password_is_configured_without_evidence(self):
        session = DatabaseSession(
            project_id="test-project",
            repository_id="test-repository",
            project_root=".",
            database_type="unknown",
            database_name=None,
            connection_state="DISCONNECTED",
            target_id=None,
        )
        with patch.object(
            DatabaseIntelligenceEngine,
            "discover_database_configuration",
            return_value={"discovered": False, "engine": "unknown"},
        ), patch.object(
            ConfigurationSymbolResolver,
            "get_credential",
            return_value={},
        ), patch.object(
            DatabaseTargetRegistry,
            "get_active_target",
            return_value=None,
        ):
            result = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
                {},
                session,
                ".",
            )

        self.assertEqual(result["credentialStatus"], "NOT_VERIFIED")
        self.assertIn("**Credential status:** NOT_VERIFIED", result["content"])
        self.assertIn("**Credential source:** NOT_RESOLVED", result["content"])
        self.assertEqual(result["credentialSource"], "NOT_RESOLVED")
        self.assertEqual(result["password"], "[REDACTED]")

    def test_credential_planner_avoids_repeating_actions_without_new_evidence(self):
        task = {
            "knowledgeRevision": 0,
            "requiredFacts": [{"name": "username", "status": "NOT_YET_RESOLVED"}],
            "actions": [],
        }
        first = _next_credential_investigation_action(task, ".")
        self.assertEqual(first["tool"], "search_code")
        self.assertEqual(first["arguments"]["query"], "DB_USERNAME")
        task["actions"].append({
            "tool": first["tool"],
            "target": first["target"],
            "fingerprint": first["fingerprint"],
            "status": "SUCCESS",
            "lastResult": {"data": {"results": []}},
            "resultKnowledgeRevision": 0,
        })

        second = _next_credential_investigation_action(task, ".")
        self.assertIsNotNone(second)
        self.assertNotEqual(second["fingerprint"], first["fingerprint"])
        self.assertEqual(second["tool"], "search_code")
        self.assertEqual(second["arguments"]["query"], "DB_USER")

    def test_credential_task_only_requires_requested_properties(self):
        task = _build_semantic_task(
            request_id="credential-field-scope",
            user_message="show my db username",
            intent=TaskIntent.DATABASE_CREDENTIAL_REQUEST,
            resources=["DATABASE", "CONFIGURATION"],
            target=None,
            project_root=".",
            scope=".",
            architecture={},
            capability=DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
            capability_arguments={},
        )
        self.assertEqual(
            [fact["name"] for fact in task["requiredFacts"]],
            ["username"],
        )
        self.assertEqual(task["capabilityArguments"]["properties"], ["username"])

    def test_typoed_credential_fields_become_required_task_facts(self):
        task = _build_semantic_task(
            request_id="credential-typos",
            user_message="sow my db useranme and passwod",
            intent=TaskIntent.DATABASE_CREDENTIAL_REQUEST,
            resources=["DATABASE", "CONFIGURATION"],
            target=None,
            project_root=".",
            scope=".",
            architecture={},
            capability=DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
            capability_arguments={},
        )
        self.assertEqual(
            [fact["name"] for fact in task["requiredFacts"]],
            ["passwordPresence", "username"],
        )
        self.assertEqual(
            task["capabilityArguments"]["properties"],
            ["password", "username"],
        )

    def test_credential_task_completion_requires_verified_required_facts(self):
        task = {
            "requiredFacts": [
                {"name": "username", "status": "NOT_YET_RESOLVED"},
                {"name": "databaseName", "status": "VERIFIED", "value": "admissions"},
            ],
            "investigationExhausted": True,
            "workingMemory": {},
        }
        _update_task_completeness(task)
        self.assertFalse(task["requiredEvidenceSatisfied"])
        self.assertFalse(task["objectiveSatisfied"])
        self.assertEqual([fact["name"] for fact in task["workingMemory"]["unresolvedFacts"]], ["username"])

    def test_generic_username_password_request_uses_redacted_database_credential_path(self):
        request = "show my username and passwd"
        self.assertTrue(_is_contextual_database_credential_request(request, [
            {"role": "user", "content": "Explain the login form."},
            {"role": "user", "content": request},
        ]))
        self.assertTrue(_is_contextual_database_credential_request(request, [
            {"role": "user", "content": "SELECT COUNT(*) FROM adm_user_programme_selection"},
            {"role": "assistant", "content": "There are 11 rows."},
            {"role": "user", "content": request},
        ]))
        self.assertTrue(_is_contextual_database_credential_request(
            "show db username and passwd",
            [{"role": "user", "content": "show db username and passwd"}],
        ))

    def test_standalone_credential_fields_require_recent_database_context(self):
        prior_turns = [
            {"role": "user", "content": "show me all table"},
            {
                "role": "assistant",
                "content": "### DATABASE TABLES INSPECTION\nDatabase: final_admission\nTables found: 200",
            },
        ]
        self.assertFalse(_is_contextual_database_credential_request(
            "show me username",
            [*prior_turns, {"role": "user", "content": "show me username"}],
        ))
        self.assertFalse(_is_contextual_database_credential_request(
            "what login name is configured for the database",
            [*prior_turns, {"role": "user", "content": "what login name is configured for the database"}],
        ))
        self.assertTrue(_is_contextual_database_credential_request(
            "show me passwd",
            [*prior_turns, {"role": "user", "content": "show me passwd"}],
        ))
        for request in ("show username", "show user name"):
            with self.subTest(request=request):
                resolved = DatabaseSessionManager.resolve_database_intent(request)
                self.assertFalse(resolved["is_deterministic"])

    def test_table_list_and_connected_database_phrasings_resolve_deterministically(self):
        for table_request in ("show me all table", "show my all table"):
            with self.subTest(request=table_request):
                table_intent = DatabaseSessionManager.resolve_database_intent(table_request)
                self.assertTrue(table_intent["is_deterministic"])
                self.assertEqual(table_intent["capability"], DatabaseCapability.DATABASE_LIST_TABLES)
                self.assertEqual(classify_task_intent(table_request)["intent"], TaskIntent.DATABASE_LIST_TABLES)

        for request in (
            "show me database which one connected",
            "which database one connected",
        ):
            with self.subTest(request=request):
                resolved = DatabaseSessionManager.resolve_database_intent(request)
                self.assertTrue(resolved["is_deterministic"])
                self.assertEqual(resolved["capability"], DatabaseCapability.DATABASE_CURRENT_TARGET)
                self.assertEqual(classify_task_intent(request)["intent"], TaskIntent.DATABASE_CURRENT_TARGET)

    def test_model_database_action_selection_is_allowlisted_and_validated(self):
        selected = _validate_task_action_selection({
            "tool_calls": [{
                "function": {
                    "name": "select_task_action",
                    "arguments": json.dumps({
                        "operation": DatabaseCapability.DATABASE_COUNT_RECORDS,
                        "arguments": {
                            "entity": "personal",
                            "filters": ["active"],
                            "row_limit": 100,
                        },
                    }),
                },
            }],
        })
        self.assertEqual(selected["capability"], DatabaseCapability.DATABASE_COUNT_RECORDS)
        self.assertEqual(selected["arguments"]["entity"], "personal")
        self.assertEqual(selected["arguments"]["filters"], ["active"])
        self.assertEqual(selected["arguments"]["row_limit"], 50)
        self.assertTrue(selected["resolved_by_model"])

        omitted_arguments = _validate_task_action_selection({
            "tool_calls": [{
                "function": {
                    "name": "select_task_action",
                    "arguments": json.dumps({
                        "operation": DatabaseCapability.DATABASE_LIST_DATABASES,
                    }),
                },
            }],
        })
        self.assertEqual(omitted_arguments["capability"], DatabaseCapability.DATABASE_LIST_DATABASES)
        self.assertEqual(omitted_arguments["arguments"], {})

        property_selection = _validate_task_action_selection({
            "tool_calls": [{
                "function": {
                    "name": "select_task_action",
                    "arguments": json.dumps({
                        "operation": DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
                        "arguments": {"properties": ["username", "password"]},
                    }),
                },
            }],
        })
        self.assertEqual(
            property_selection["arguments"]["properties"],
            ["username", "password"],
        )
        with self.assertRaisesRegex(RuntimeError, "unsupported database configuration properties"):
            _validate_task_action_selection({
                "tool_calls": [{
                    "function": {
                        "name": "select_task_action",
                        "arguments": json.dumps({
                            "operation": DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
                            "arguments": {"properties": ["apiKey"]},
                        }),
                    },
                }],
            })

        code_route = _validate_task_action_selection({
            "tool_calls": [{
                "function": {
                    "name": "select_task_action",
                    "arguments": json.dumps({"operation": "ROUTE_TO_CODE"}),
                },
            }],
        })
        self.assertFalse(code_route["is_deterministic"])
        self.assertTrue(code_route["route_to_code"])

        clarification = _validate_task_action_selection({
            "tool_calls": [{
                "function": {
                    "name": "select_task_action",
                    "arguments": json.dumps({
                        "operation": "CLARIFY",
                        "arguments": {},
                        "clarification": "Which of these two databases do you mean?",
                    }),
                },
            }],
        })
        self.assertEqual(clarification["clarification"], "Which of these two databases do you mean?")

        answer = _validate_task_action_selection({
            "tool_calls": [{
                "function": {
                    "name": "select_task_action",
                    "arguments": json.dumps({
                        "operation": "ANSWER",
                        "answer": "The active database is admissions.",
                    }),
                },
            }],
        })
        self.assertEqual(answer["answer"], "The active database is admissions.")

        for selection in (
            {"operation": "DROP_DATABASE", "arguments": {}},
            {"operation": DatabaseCapability.DATABASE_QUERY, "arguments": {"sql": "DROP TABLE users"}},
            {"operation": DatabaseCapability.DATABASE_COUNT_RECORDS, "arguments": {"entity": "users", "unsafe": True}},
            {"operation": "ROUTE_TO_CODE", "confidence": 1.1},
            {"operation": "ROUTE_TO_CODE", "resources": [{"type": "DATABASE"}]},
            {
                "operation": DatabaseCapability.DATABASE_LIST_TABLES,
                "intent": "SOURCE_CHANGE",
                "arguments": {},
            },
        ):
            with self.subTest(selection=selection), self.assertRaises(RuntimeError):
                _validate_task_action_selection({
                    "tool_calls": [{
                        "function": {
                            "name": "select_task_action",
                            "arguments": json.dumps(selection),
                        },
                    }],
                })

    def test_database_intent_model_receives_full_conversation_and_only_action_selector(self):
        messages = [
            {"role": "user", "content": "Which database is connected?"},
            {"role": "assistant", "content": "Connected database: admissions."},
            {"role": "user", "content": "show my all table"},
        ]
        provider = SimpleNamespace(id="configured-coding-provider")
        response = {
            "role": "assistant",
            "tool_calls": [{
                "id": "select-db-action",
                "function": {
                    "name": "select_task_action",
                    "arguments": json.dumps({
                        "operation": DatabaseCapability.DATABASE_LIST_TABLES,
                        "arguments": {},
                        "intent": "LIST_TABLES",
                        "goal": "List tables in the active database.",
                        "resources": [{
                            "type": "DATABASE",
                            "reason": "The requested evidence is the active live schema.",
                            "confidence": 0.99,
                        }],
                        "target": "tables",
                        "target_type": "DATABASE",
                        "confidence": 0.98,
                        "target_candidates": [{
                            "value": "admissions tables",
                            "type": "database_schema",
                            "evidence": "The conversation identifies admissions as the active database.",
                            "score": 0.92,
                        }],
                        "required_evidence": ["live schema"],
                        "verification_plan": "List tables from the active database session.",
                    }),
                },
            }],
        }
        registry = SimpleNamespace()
        safe_context = {
            "engine": "mysql",
            "database": "admissions",
            "connectionState": "CONNECTED",
            "targetId": "DB-001",
        }
        with patch(
            "coding_websocket.complete_coding_model",
            return_value=(response, provider),
        ) as complete:
            selected = asyncio.run(_resolve_semantic_task_with_model(
                registry,
                Path("unused-provider-config.json"),
                messages,
                safe_context,
                provider.id,
                "database-intent-request",
                "database-intent-session",
            ))

        self.assertEqual(selected["capability"], DatabaseCapability.DATABASE_LIST_TABLES)
        self.assertTrue(selected["resolved_by_model"])
        self.assertEqual(selected["semanticTask"]["intent"], "LIST_TABLES")
        self.assertEqual(selected["semanticTask"]["goal"], "List tables in the active database.")
        self.assertEqual(selected["semanticTask"]["resourceCandidates"], ["DATABASE"])
        self.assertEqual(selected["semanticTask"]["target"], "tables")
        self.assertEqual(selected["semanticTask"]["targetType"], "DATABASE")
        self.assertEqual(selected["semanticTask"]["confidence"], 0.98)
        self.assertEqual(selected["semanticTask"]["targetCandidates"][0]["value"], "admissions tables")
        self.assertEqual(selected["semanticTask"]["targetCandidates"][0]["score"], 0.92)
        self.assertEqual(selected["semanticTask"]["resourceDetails"][0]["reason"], "The requested evidence is the active live schema.")
        self.assertEqual(selected["semanticTask"]["selectedAction"], DatabaseCapability.DATABASE_LIST_TABLES)
        self.assertEqual(selected["semanticTask"]["requiredEvidence"], ["live schema"])
        self.assertEqual(selected["semanticTask"]["verificationPlan"], "List tables from the active database session.")
        call = complete.call_args
        self.assertEqual(call.args[2][-3:], messages)
        self.assertEqual(
            call.args[2][0]["content"].split("Safe task context: ", 1)[1],
            json.dumps(safe_context, ensure_ascii=False),
        )
        self.assertEqual([tool["function"]["name"] for tool in call.args[3]], ["select_task_action"])
        self.assertEqual(call.args[4], provider.id)
        self.assertTrue(call.args[5], "Action resolution must require a structured model tool call.")
        self.assertEqual(
            call.args[3][0]["function"]["parameters"]["required"],
            ["operation"],
            "Providers must not be required to emit an empty nested arguments object.",
        )
        self.assertIn("ROUTE_TO_CODE", call.args[3][0]["function"]["parameters"]["properties"]["operation"]["enum"])
        self.assertIn("safe task-scoped working memory", call.args[2][0]["content"])
        self.assertIn("entire supplied conversation", call.args[2][0]["content"])

    def test_provider_messages_hash_credentials_before_external_request(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            registry = ProviderRegistry(str(Path(temporary_directory) / "provider-config.json"))
            registry.add_provider("groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "test-key")
            client = Mock()
            client.chat.completions.create.return_value.choices = [
                SimpleNamespace(message=SimpleNamespace(model_dump=lambda exclude_none: {
                    "role": "assistant",
                    "content": "Credential references are protected.",
                })),
            ]
            messages = [
                {
                    "role": "user",
                    "content": (
                        "Config: 'username' => 'db_operator', 'password' => 'provider-only-secret-7', "
                        "'api_key' => 'sk-abcdefghijklmnop'; Bearer abcdefghijklmnop"
                    ),
                },
                {
                    "role": "tool",
                    "content": json.dumps({"database_password": "tool-only-secret-8"}),
                },
            ]

            with patch("coding_provider.OpenAI", return_value=client):
                complete_coding_model(
                    registry,
                    Path("unused-provider-config.json"),
                    messages,
                )

        sent_messages = json.dumps(client.chat.completions.create.call_args.kwargs["messages"])
        self.assertNotIn("provider-only-secret-7", sent_messages)
        self.assertNotIn("tool-only-secret-8", sent_messages)
        self.assertNotIn("db_operator", sent_messages)
        self.assertNotIn("sk-abcdefghijklmnop", sent_messages)
        self.assertNotIn("abcdefghijklmnop", sent_messages)
        self.assertIn("secret:password:", sent_messages)
        self.assertIn("secret:username:", sent_messages)
        self.assertIn("secret:api_key:", sent_messages)
        self.assertIn("secret:bearer-token:", sent_messages)
        self.assertIn("secret:database_password:", sent_messages)
        self.assertIn("provider-only-secret-7", json.dumps(messages))
        self.assertIn("tool-only-secret-8", json.dumps(messages))

    def test_database_urls_discover_postgres_supabase_and_mongodb_without_provider_secrets(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            urls = (
                ("DATABASE_URL", "postgresql://db_user:pg-secret@db.example:5433/admissions", "postgresql"),
                ("SUPABASE_DB_URL", "postgresql://postgres:sb-secret@db.project.supabase.co:5432/postgres", "postgresql"),
                ("MONGODB_URI", "mongodb+srv://mongo_user:mg-secret@cluster.example/app", "mongodb"),
            )
            for env_key, connection_uri, expected_engine in urls:
                (root / ".env").write_text(f"{env_key}={connection_uri}\n", encoding="utf-8")
                discovered = DatabaseIntelligenceEngine.discover_database_configuration(str(root))
                credentials = ConfigurationSymbolResolver.get_credential(str(root))
                self.assertEqual(discovered["engine"], expected_engine)
                self.assertEqual(discovered["host"], connection_uri.split("@", 1)[1].split("/", 1)[0].split(":", 1)[0].replace("mongodb+srv://", ""))
                self.assertEqual(credentials["connection_uri"], connection_uri)
                sanitized = SecretTransformer.sanitize_context_for_llm({**discovered, **credentials})
                self.assertNotIn("pg-secret", json.dumps(sanitized))
                self.assertNotIn("sb-secret", json.dumps(sanitized))
                self.assertNotIn("mg-secret", json.dumps(sanitized))
                self.assertIn("secret:db-password:", json.dumps(sanitized))
                config_details = ConfigurationSymbolResolver.inspect_project_database_configuration(str(root))
                local_report = ConfigurationSymbolResolver.format_connection_status_report(
                    config_details,
                    credentials=credentials,
                )
                self.assertIn(credentials["username"], local_report)
                self.assertIn("**Password:** [REDACTED]", local_report)
                self.assertNotIn(credentials["password"], local_report)

    def test_h2_spring_configuration_is_discovered_and_secrets_stay_provider_sanitized(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            config_file = root / "application.properties"
            config_file.write_text(
                "spring.datasource.url=jdbc:h2:file:./data/admissions;AUTO_SERVER=TRUE\n"
                "spring.datasource.username=sa\n"
                "spring.datasource.password=h2-local-secret\n",
                encoding="utf-8",
            )

            config = ConfigurationSymbolResolver.inspect_project_database_configuration(str(root))
            credentials = ConfigurationSymbolResolver.get_credential(str(root))
            discovered = DatabaseIntelligenceEngine.discover_database_configuration(str(root))

            self.assertTrue(config["discovered"])
            self.assertEqual(config["engine"], "h2")
            self.assertEqual(config["database"]["value"], "admissions")
            self.assertEqual(config["username"]["value"], "sa")
            self.assertTrue(config["hasPassword"])
            self.assertEqual(credentials["password"], "h2-local-secret")
            self.assertEqual(credentials["connection_uri"], "jdbc:h2:file:./data/admissions;AUTO_SERVER=TRUE")
            self.assertEqual(discovered["engine"], "h2")
            sanitized = SecretTransformer.sanitize_context_for_llm({
                **discovered,
                **credentials,
                "fileContent": config["fileContent"],
            })
            self.assertNotIn("h2-local-secret", json.dumps(sanitized))
            self.assertIn("secret:password:", json.dumps(sanitized))
            sanitized_uri = SecretTransformer.sanitize_context_for_llm({
                "connection_uri": "jdbc:h2:file:./data/admissions;USER=sa;PASSWORD=h2-uri-secret"
            })
            self.assertNotIn("h2-uri-secret", json.dumps(sanitized_uri))

    def test_h2_jdbc_parsing_and_read_only_query_adapter(self):
        file_url = "jdbc:h2:file:./data/admissions;AUTO_SERVER=TRUE"
        parsed_file = DatabaseIntelligenceEngine.parse_database_url(file_url)
        parsed_tcp = DatabaseIntelligenceEngine.parse_database_url("jdbc:h2:tcp://db.internal:9123/~/admissions")
        parsed_memory = DatabaseIntelligenceEngine.parse_database_url("jdbc:h2:mem:admissions")
        self.assertEqual(parsed_file["engine"], "h2")
        self.assertEqual(parsed_file["database"], "admissions")
        self.assertTrue(parsed_file["file_database"])
        self.assertEqual((parsed_tcp["host"], parsed_tcp["port"]), ("db.internal", 9123))
        self.assertEqual(parsed_tcp["database"], "admissions")
        self.assertTrue(parsed_memory["in_memory"])

        cursor = Mock()
        cursor.description = [("ANSWER",)]
        cursor.fetchmany.return_value = [(42,)]
        connection = Mock()
        connection.cursor.return_value = cursor
        connection.jconn = Mock()
        fake_jaydebeapi = SimpleNamespace(connect=Mock(return_value=connection))
        with tempfile.TemporaryDirectory() as temporary_directory, patch.dict(
            sys.modules, {"jaydebeapi": fake_jaydebeapi}
        ), patch.object(DatabaseIntelligenceEngine, "_find_h2_jar", return_value="h2.jar"):
            opened = DatabaseIntelligenceEngine._open_h2_connection(
                temporary_directory,
                {"engine": "h2", "connection_uri": file_url, "username": "sa"},
            )
            self.assertIs(opened, connection)
            self.assertEqual(
                fake_jaydebeapi.connect.call_args.args[1],
                f"{file_url};ACCESS_MODE_DATA=r",
            )
            connection.jconn.setReadOnly.assert_called_once_with(True)

            with patch.object(DatabaseIntelligenceEngine, "_open_h2_connection", return_value=connection):
                result = DatabaseIntelligenceEngine.execute_safe_query(
                    temporary_directory,
                    "SELECT 42 AS answer",
                    {"engine": "h2", "database": "admissions", "connection_uri": file_url},
                )
            self.assertTrue(result["ok"])
            self.assertEqual(result["rows"], [{"ANSWER": 42}])
            self.assertEqual(result["mode"], "READ_ONLY")

            with patch.object(DatabaseIntelligenceEngine, "_open_h2_connection") as open_h2:
                rejected = DatabaseIntelligenceEngine.execute_safe_query(
                    temporary_directory,
                    "DELETE FROM USERS",
                    {"engine": "h2", "database": "admissions", "connection_uri": file_url},
                )
            self.assertFalse(rejected["ok"])
            open_h2.assert_not_called()

            cursor.fetchall.side_effect = [
                [("USERS",)],
                [("ID", "INTEGER", "NO"), ("NAME", "VARCHAR", "YES")],
                [("ID",)],
                [("IDX_USERS_NAME", "NON_UNIQUE", "NAME")],
            ]
            with patch.object(DatabaseIntelligenceEngine, "_open_h2_connection", return_value=connection), patch.object(
                DatabaseEvidenceStore, "record_proof"
            ):
                schema = DatabaseIntelligenceEngine.inspect_database_schema(
                    temporary_directory,
                    {"engine": "h2", "database": "admissions", "connection_uri": file_url},
                )
            self.assertEqual(schema["tables"], ["USERS"])
            self.assertEqual(schema["schema_details"]["USERS"]["primary_keys"], ["ID"])
            self.assertFalse(schema["schema_details"]["USERS"]["indexes"][0]["unique"])

            unavailable_memory = DatabaseIntelligenceEngine.real_connect_and_health_check(
                temporary_directory,
                {"engine": "h2", "connection_uri": "jdbc:h2:mem:admissions"},
            )
            self.assertFalse(unavailable_memory["connected"])
            self.assertEqual(unavailable_memory["classification"], "H2_IN_MEMORY_NOT_ACCESSIBLE")
            self.assertIn("Java application's JVM", unavailable_memory["message"])

            with self.assertRaisesRegex(ValueError, "in-memory databases"):
                DatabaseIntelligenceEngine._open_h2_connection(
                    temporary_directory,
                    {"engine": "h2", "connection_uri": "jdbc:h2:mem:admissions"},
                )

    def test_postgresql_read_only_query_uses_read_only_transaction(self):
        cursor = Mock()
        cursor.description = [SimpleNamespace(name="answer")]
        cursor.fetchmany.return_value = [(42,)]
        connection = Mock()
        connection.cursor.return_value = cursor
        fake_psycopg = SimpleNamespace(connect=Mock(return_value=connection))

        with patch.dict(sys.modules, {"psycopg": fake_psycopg}):
            result = DatabaseIntelligenceEngine.execute_safe_query(
                ".",
                "SELECT 42 AS answer",
                {"engine": "postgresql", "database": "app", "connection_uri": "postgresql://user:pass@db/app"},
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["rows"], [{"answer": 42}])
        self.assertEqual(result["mode"], "READ_ONLY")
        self.assertEqual(cursor.execute.call_args_list[0].args[0], "SET TRANSACTION READ ONLY")
        self.assertEqual(cursor.execute.call_args_list[1].args[0], "SELECT 42 AS answer")
        connection.rollback.assert_called_once()
        connection.close.assert_called_once()

    def test_postgresql_and_mongodb_health_checks_require_live_driver_responses(self):
        pg_cursor = MagicMock()
        pg_cursor.fetchone.side_effect = [(1,), ("admissions", "10.0.0.8", 5432)]
        pg_connection = MagicMock()
        pg_connection.cursor.return_value.__enter__.return_value = pg_cursor
        mongo_client = MagicMock()
        mongo_client.address = ("mongo.internal", 27017)
        fake_psycopg = SimpleNamespace(connect=Mock(return_value=pg_connection))
        fake_pymongo = SimpleNamespace(MongoClient=Mock(return_value=mongo_client))

        with patch.dict(sys.modules, {"psycopg": fake_psycopg, "pymongo": fake_pymongo}), patch.object(
            DatabaseEvidenceStore, "record_proof"
        ):
            postgres = DatabaseIntelligenceEngine.real_connect_and_health_check(
                ".",
                {"engine": "postgresql", "connection_uri": "postgresql://user:pass@db/app"},
            )
            mongodb = DatabaseIntelligenceEngine.real_connect_and_health_check(
                ".",
                {"engine": "mongodb", "connection_uri": "mongodb://user:pass@db/app"},
            )

        self.assertTrue(postgres["connected"])
        self.assertEqual(postgres["database"], "admissions")
        self.assertEqual(postgres["host"], "10.0.0.8")
        self.assertEqual(postgres["port"], 5432)
        self.assertTrue(mongodb["connected"])
        self.assertEqual(mongodb["engine"], "mongodb")
        self.assertEqual(mongodb["host"], "mongo.internal")
        mongo_client.close.assert_called_once()

    def test_postgresql_and_mysql_schema_operations_use_live_catalog_queries(self):
        pg_cursor = Mock()
        pg_cursor.fetchall.side_effect = [
            [("users",)],
            [("users",)],
            [("id", "integer", "NO", True), ("name", "text", "YES", False)],
        ]
        pg_connection = Mock()
        pg_connection.cursor.return_value = pg_cursor
        mysql_cursor = Mock()
        mysql_cursor.fetchmany.return_value = [("app",)]
        mysql_cursor.fetchall.side_effect = [
            [("users",)],
            [("users",)],
            [("id", "int", "NO", "PRI")],
        ]
        mysql_connection = Mock()
        mysql_connection.cursor.return_value = mysql_cursor
        session_pg = DatabaseSession(
            project_id="test-project",
            repository_id="test-repository",
            project_root=".",
            database_type="postgresql",
            database_name="app",
            connection_state="CONNECTED",
        )
        session_pg._protected_credentials = {"connection_uri": "postgresql://user:pass@db/app"}
        session_mysql = DatabaseSession(
            project_id="test-project",
            repository_id="test-repository",
            project_root=".",
            database_type="mysql",
            database_name="app",
            connection_state="CONNECTED",
            safe_host="db.internal",
            safe_port=3306,
        )
        session_mysql._protected_credentials = {"username": "user", "password": "pass"}

        with patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=Mock(return_value=pg_connection)), "pymysql": SimpleNamespace(connect=Mock(return_value=mysql_connection))}), patch.object(
            DatabaseEvidenceStore, "record_proof"
        ):
            pg_tables = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_LIST_TABLES, {}, session_pg, "."
            )
            pg_columns = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_DESCRIBE_TABLE, {"table": "users"}, session_pg, "."
            )
            mysql_dbs = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_LIST_DATABASES, {}, session_mysql, "."
            )
            mysql_tables = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_LIST_TABLES, {}, session_mysql, "."
            )
            mysql_columns = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_DESCRIBE_TABLE, {"table": "users"}, session_mysql, "."
            )

        self.assertEqual(pg_tables["tables"], ["users"])
        self.assertEqual(pg_columns["columns"][0]["name"], "id")
        self.assertEqual(pg_columns["columns"][0]["pk"], True)
        self.assertEqual(mysql_dbs["databases"], ["app"])
        self.assertEqual(mysql_tables["tables"], ["users"])
        self.assertEqual(mysql_columns["columns"][0]["name"], "id")
        self.assertEqual(mysql_columns["columns"][0]["pk"], True)

    def test_mongodb_lists_live_collections_and_reads_limited_documents(self):
        collection = Mock()
        cursor = MagicMock()
        cursor.limit.return_value = cursor
        cursor.__iter__.return_value = iter([{"_id": "doc-1", "name": "Ada"}])
        cursor.explain.return_value = {
            "executionStats": {"nReturned": 1},
            "queryPlanner": {"winningPlan": {"stage": "IXSCAN"}},
        }
        collection.find.return_value = cursor
        database = MagicMock()
        database.list_collection_names.return_value = ["users"]
        database.__getitem__.return_value = collection
        client = MagicMock()
        client.__getitem__.return_value = database
        fake_pymongo = SimpleNamespace(MongoClient=Mock(return_value=client))
        session = DatabaseSession(
            project_id="test-project",
            repository_id="test-repository",
            project_root=".",
            database_type="mongodb",
            database_name="app",
            connection_state="CONNECTED",
        )
        session._protected_credentials = {
            "connection_uri": "mongodb://user:password@db.example/app",
        }

        with patch.dict(sys.modules, {"pymongo": fake_pymongo}), patch.object(DatabaseEvidenceStore, "record_proof"):
            listed = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_LIST_TABLES, {}, session, "."
            )
            found = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_QUERY,
                {"collection": "users", "filter": {}},
                session,
                ".",
            )
            explained = DatabaseSessionManager.execute_database_capability(
                DatabaseCapability.DATABASE_EXPLAIN,
                {"collection": "users", "filter": {}},
                session,
                ".",
            )

        self.assertTrue(listed["ok"])
        self.assertIn("users", listed["tables"])
        self.assertEqual(listed["content"], "- `users`")
        self.assertTrue(found["ok"])
        self.assertEqual(found["rows"], [{"_id": "doc-1", "name": "Ada"}])
        self.assertEqual(found["mode"], "LIVE")
        self.assertTrue(explained["ok"])
        self.assertIn("IXSCAN", explained["content"])
        self.assertGreaterEqual(fake_pymongo.MongoClient.call_count, 2)

    def test_missing_requested_config_does_not_substitute_another_file_or_database(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "config").mkdir()
            (root / "config" / "db.php").write_text(
                "<?php return ['dsn' => 'mysql:host=db.internal;dbname=app_db'];",
                encoding="utf-8",
            )
            unrelated_db = root / "unrelated.sqlite"
            unrelated_db.touch()
            missing_config = ConfigurationSymbolResolver.inspect_project_database_configuration(
                temporary_directory,
                specific_file="config.php",
            )
            session = DatabaseSession(
                project_id="test-project",
                repository_id="test-repository",
                project_root=temporary_directory,
                database_type="sqlite",
                database_name=None,
                connection_state="NOT_CONNECTED",
                target_id=None,
            )
            live = ConfigurationSymbolResolver.verify_live_database_identity(
                temporary_directory,
                {"engine": "sqlite", "sqliteFile": "configured.sqlite"},
                session=session,
            )

        self.assertEqual(missing_config["status"], "NOT_FOUND")
        self.assertEqual(missing_config["configFile"], "config.php")
        self.assertEqual(live["status"], "NOT_VERIFIED")
        self.assertIsNone(live["database"])
        self.assertIsNone(live["targetId"])

    def test_compound_current_target_reports_missing_requested_file_and_discovered_config(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            config_dir = root / "config"
            config_dir.mkdir()
            (config_dir / "db.php").write_text(
                "<?php return [\n"
                "    'dsn' => 'mysql:host=db.internal;dbname=app_db',\n"
                "    'username' => 'app_user',\n"
                "    'password' => 'test-only-secret',\n"
                "];\n",
                encoding="utf-8",
            )
            session = DatabaseSession(
                project_id="test-project",
                repository_id="test-repository",
                project_root=temporary_directory,
                database_type="mysql",
                database_name="app_db",
                connection_state="CONNECTED",
                target_id=None,
                safe_host="db.internal",
            )
            fake_mysql = SimpleNamespace(
                connect=Mock(side_effect=OSError("connection unavailable"))
            )

            try:
                with patch.dict(sys.modules, {"pymysql": fake_mysql}):
                    result = DatabaseSessionManager.execute_database_capability(
                        DatabaseCapability.DATABASE_CURRENT_TARGET,
                        {"configFile": "config.php", "user_request": "open config.php and current database"},
                        session,
                        temporary_directory,
                    )
            finally:
                ConfigurationSymbolResolver._credential_vault.pop(
                    str(root.resolve()).lower(),
                    None,
                )

        report = result["content"]
        self.assertIn("Requested configuration file config.php was not found", report)
        self.assertIn("INSPECTED CONFIGURATION FILE: config/db.php", report)
        self.assertNotIn("INSPECTED CONFIGURATION FILE: config.php", report)
        self.assertNotIn("DB-001", report)
        preview = report.split("### DATABASE CONNECTION STATUS", 1)[0]
        self.assertNotIn("test-only-secret", preview)
        self.assertIn("**Password:** [REDACTED]", report)
        self.assertNotIn("test-only-secret", report)
        self.assertEqual(result["status"], "FAILED")

    def test_mysql_current_target_records_live_runtime_identity(self):
        session = DatabaseSession(
            project_id="test-project",
            repository_id="test-repository",
            project_root=".",
            database_type="mysql",
            database_name="configured_db",
            connection_state="NOT_CONNECTED",
            target_id=None,
            safe_host="db.internal",
            safe_port=3306,
        )
        session._protected_credentials = {"username": "app_user", "password": "test-password"}
        cursor = Mock()
        cursor.fetchone.return_value = ("actual_db", "mysql-node-2", 3307)
        connection = Mock()
        connection.cursor.return_value = cursor
        config = {
            "engine": "mysql",
            "host": {"value": "db.internal"},
            "database": {"value": "configured_db"},
            "port": {"value": 3306},
            "username": {"value": "app_user"},
        }

        with patch.dict(sys.modules, {"pymysql": SimpleNamespace(connect=Mock(return_value=connection))}):
            with patch.object(DatabaseEvidenceStore, "record_proof"):
                result = ConfigurationSymbolResolver.verify_live_database_identity(
                    ".",
                    config,
                    session=session,
                )

        self.assertEqual(result["status"], "LIVE_VERIFIED")
        self.assertEqual(result["database"], "actual_db")
        self.assertEqual(result["host"], "mysql-node-2")
        self.assertEqual(result["port"], 3307)
        self.assertIsNone(result["targetId"])
        self.assertEqual(result["databaseSessionId"], session.session_id)
        self.assertTrue(result["evidence"]["executed"])
        self.assertNotIn("test-password", json.dumps(result))
        self.assertEqual(session.safe_host, "db.internal")
        self.assertEqual(session.safe_port, 3306)
        report = ConfigurationSymbolResolver.format_connection_status_report(config, result)
        self.assertIn("MISMATCH DETECTED", report)
        credential_report = ConfigurationSymbolResolver.format_connection_status_report(
            config,
            result,
            credentials={"username": "app_user", "password": "test-password"},
        )
        self.assertIn("- **Username:** app_user", credential_report)
        self.assertIn("- **Password:** [REDACTED]", credential_report)
        self.assertNotIn("test-password", credential_report)
        cursor.execute.assert_called_once_with("SELECT DATABASE(), @@hostname, @@port;")
        connection.close.assert_called_once()

    def test_openai_compatible_coding_requests_explicitly_allow_needed_tools(self):
        for provider_type, model, base_url in (
            ("groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1"),
            ("gemini", "gemini-3.6-flash", "https://generativelanguage.googleapis.com/v1beta/openai"),
        ):
            with self.subTest(provider=provider_type), tempfile.TemporaryDirectory() as temporary_directory:
                registry = ProviderRegistry(str(Path(temporary_directory) / "provider-config.json"))
                provider = registry.add_provider(provider_type, model, base_url, "test-key")
                client = Mock()
                client.chat.completions.create.return_value.choices = [
                    SimpleNamespace(message=SimpleNamespace(model_dump=lambda exclude_none: {
                        "role": "assistant",
                        "content": "I will inspect the relevant files.",
                    })),
                ]

                with patch("coding_provider.OpenAI", return_value=client):
                    message, selected_provider = complete_coding_model(
                        registry,
                        Path("unused-provider-config.json"),
                        [{"role": "user", "content": "Search for duplicate queries."}],
                        [{"type": "function", "function": {"name": "search_code"}}],
                    )

                request = client.chat.completions.create.call_args.kwargs
                self.assertEqual(request["tool_choice"], "auto")
                self.assertTrue(request["tools"])
                self.assertEqual(selected_provider.id, provider.id)
                self.assertEqual(message["content"], "I will inspect the relevant files.")

    def test_openai_compatible_finalization_does_not_send_tool_choice(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            registry = ProviderRegistry(str(Path(temporary_directory) / "provider-config.json"))
            registry.add_provider("groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "test-key")
            client = Mock()
            client.chat.completions.create.return_value.choices = [
                SimpleNamespace(message=SimpleNamespace(model_dump=lambda exclude_none: {
                    "role": "assistant",
                    "content": "Final answer.",
                })),
            ]

            with patch("coding_provider.OpenAI", return_value=client):
                complete_coding_model(
                    registry,
                    Path("unused-provider-config.json"),
                    [{"role": "user", "content": "Summarize the inspected code."}],
                    None,
                )

        self.assertNotIn("tool_choice", client.chat.completions.create.call_args.kwargs)

    def test_openai_compatible_proposal_inspection_requires_a_tool_call(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            registry = ProviderRegistry(str(Path(temporary_directory) / "provider-config.json"))
            registry.add_provider("groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "test-key")
            client = Mock()
            client.chat.completions.create.return_value.choices = [
                SimpleNamespace(message=SimpleNamespace(model_dump=lambda exclude_none: {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{"id": "read-1", "function": {
                        "name": "read_file",
                        "arguments": "{\"relativePath\":\"models/AdmOuPrgList.php\"}",
                    }}],
                })),
            ]

            with patch("coding_provider.OpenAI", return_value=client):
                message, _ = complete_coding_model(
                    registry,
                    Path("unused-provider-config.json"),
                    [{"role": "user", "content": "Prepare a proposal."}],
                    [{"type": "function", "function": {"name": "read_file"}}],
                    require_tool_call=True,
                )

        self.assertEqual(client.chat.completions.create.call_args.kwargs["tool_choice"], "required")
        self.assertTrue(message["tool_calls"])

    def test_required_tool_refusal_retries_with_auto_instead_of_aborting_request(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            registry = ProviderRegistry(str(Path(temporary_directory) / "provider-config.json"))
            registry.add_provider("groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "test-key")
            client = Mock()
            client.chat.completions.create.side_effect = [
                RuntimeError("Tool choice is required, but model did not call a tool"),
                SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(model_dump=lambda exclude_none: {
                    "role": "assistant",
                    "content": "Please specify which file you want me to inspect.",
                }))]),
            ]

            with patch("coding_provider.OpenAI", return_value=client):
                message, provider = complete_coding_model(
                    registry,
                    Path("unused-provider-config.json"),
                    [{"role": "user", "content": "Read the relevant source file."}],
                    [{"type": "function", "function": {"name": "read_file"}}],
                    require_tool_call=True,
                )

        self.assertEqual(client.chat.completions.create.call_count, 2)
        self.assertEqual(client.chat.completions.create.call_args_list[0].kwargs["tool_choice"], "required")
        self.assertEqual(client.chat.completions.create.call_args_list[1].kwargs["tool_choice"], "auto")
        self.assertIn("specify which file", message["content"])
        self.assertEqual(provider.type, "groq")

    def test_native_gemini_coding_requests_explicitly_use_auto_function_calling(self):
        provider = SimpleNamespace(
            type="gemini",
            model="gemini-3.6-flash",
            base_url="https://generativelanguage.googleapis.com/v1beta",
        )
        response = Mock()
        response.json.return_value = {
            "candidates": [{
                "content": {"parts": [{"text": "I will inspect the project."}]},
            }],
        }
        tool = {"function": {"name": "search_code", "parameters": {"type": "object", "properties": {}}}}

        with patch("coding_provider.httpx.post", return_value=response) as post:
            _gemini_request(
                provider,
                "test-key",
                [{"role": "user", "content": "Search for duplicate queries."}],
                [tool],
            )

        request = post.call_args.kwargs["json"]
        self.assertEqual(request["toolConfig"], {"functionCallingConfig": {"mode": "AUTO"}})

    def test_native_gemini_proposal_inspection_requires_a_function_call(self):
        provider = SimpleNamespace(
            type="gemini",
            model="gemini-3.6-flash",
            base_url="https://generativelanguage.googleapis.com/v1beta",
        )
        response = Mock()
        response.json.return_value = {"candidates": [{"content": {"parts": []}}]}
        tool = {"function": {"name": "read_file", "parameters": {"type": "object", "properties": {}}}}

        with patch("coding_provider.httpx.post", return_value=response) as post:
            _gemini_request(
                provider,
                "test-key",
                [{"role": "user", "content": "Prepare a proposal."}],
                [tool],
                require_tool_call=True,
            )

        self.assertEqual(
            post.call_args.kwargs["json"]["toolConfig"],
            {"functionCallingConfig": {"mode": "ANY"}},
        )

    def test_anthropic_proposal_inspection_requires_a_tool_call(self):
        provider = SimpleNamespace(
            type="anthropic",
            model="claude-test",
            base_url="https://api.anthropic.com/v1",
        )
        response = Mock()
        response.json.return_value = {"content": []}
        tool = {"function": {"name": "read_file", "parameters": {"type": "object", "properties": {}}}}

        with patch("coding_provider.httpx.post", return_value=response) as post:
            _anthropic_request(
                provider,
                "test-key",
                [{"role": "user", "content": "Prepare a proposal."}],
                [tool],
                require_tool_call=True,
            )

        self.assertEqual(post.call_args.kwargs["json"]["tool_choice"], {"type": "any"})


class CodingDatabaseFastPathTests(unittest.IsolatedAsyncioTestCase):
    async def test_typoed_database_credential_request_uses_redacted_fast_path(self):
        with tempfile.TemporaryDirectory() as project_root:
            sent = []

            async def send_json(payload):
                sent.append(payload)

            session = SimpleNamespace(
                project_root=project_root,
                database_type="mysql",
                database_name="test_db",
                connection_state="CONNECTED",
                target_id="DB-TEST",
                safe_host="db.internal",
                safe_port=3306,
                connection_capabilities={},
                to_safe_dict=lambda: {"targetId": "DB-TEST"},
            )
            secret = "do-not-return-this-password"
            result = {
                "ok": True,
                "capability": DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
                "content": (
                    "### DATABASE CREDENTIALS REPORT\n"
                    "- **Username:** app_user\n"
                    "- **Password:** [REDACTED]"
                ),
                "credentialStatus": "CONFIGURED",
                "username": "app_user",
                "database": "test_db",
                "password": "[REDACTED]",
                "executionStatus": "SUCCESS",
                "executed": True,
            }
            with patch(
                "coding_websocket.ProjectContextLock.resolve_authoritative_root",
                return_value=project_root,
            ), patch("coding_websocket.ProjectContextLock.lock"), patch(
                "coding_websocket.set_backend_project_state"
            ), patch("coding_websocket.detect_project_architecture", return_value={}), patch.object(
                DatabaseIntelligenceEngine,
                "discover_database_configuration",
                return_value={
                    "discovered": True,
                    "engine": "mysql",
                    "database": "test_db",
                    "username": "app_user",
                    "has_credentials": True,
                },
            ), patch.object(
                DatabaseIntelligenceEngine,
                "check_database_capabilities",
                return_value={"available_paths": ["application_client"]},
            ), patch.object(
                ConfigurationSymbolResolver,
                "get_credential",
                return_value={"username": "app_user", "password": secret},
            ), patch.object(
                DatabaseSessionManager,
                "get_session",
                return_value=session,
            ), patch.object(
                DatabaseSessionManager,
                "get_or_create_session",
                return_value=session,
            ), patch(
                "coding_websocket._resolve_semantic_task_with_model",
                new=AsyncMock(side_effect=AssertionError("credential request must not reach the model")),
            ) as resolve_task, patch.object(
                DatabaseSessionManager,
                "execute_database_capability",
                return_value=result,
            ) as execute_capability:
                await _run_coding_turn(
                    {
                        "requestId": "typoed-db-credentials",
                        "sessionId": "typoed-db-credentials-session",
                        "projectRoot": project_root,
                        "messages": [{
                            "role": "user",
                            "content": "sow my db useranme and passwod",
                        }],
                    },
                    send_json,
                    {"pending": {}, "completed": {}, "tasks": set()},
                    None,
                    "",
                )

            resolve_task.assert_not_awaited()
            execute_capability.assert_called_once_with(
                DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
                {},
                unittest.mock.ANY,
                project_root=project_root,
            )
            done = next(message for message in sent if message.get("type") == "done")
            self.assertEqual(done["intent"], TaskIntent.DATABASE_CREDENTIAL_REQUEST)
            self.assertIn("Username:** app_user", done["content"])
            self.assertIn("Password:** [REDACTED]", done["content"])
            self.assertNotIn(secret, json.dumps(sent))

    async def test_unresolved_database_credentials_are_not_marked_completed(self):
        sent = []

        async def send_json(payload):
            sent.append(payload)

        session = SimpleNamespace(
            project_root="",
            database_type="unknown",
            database_name=None,
            connection_state="DISCONNECTED",
            target_id=None,
            safe_host=None,
            safe_port=None,
            connection_capabilities={},
            to_safe_dict=lambda: {"connectionState": "DISCONNECTED"},
        )
        with patch(
            "coding_websocket.ProjectContextLock.resolve_authoritative_root",
            return_value="",
        ), patch("coding_websocket.ProjectContextLock.lock"), patch(
            "coding_websocket.set_backend_project_state"
        ), patch("coding_websocket.detect_project_architecture", return_value={}), patch.object(
            DatabaseIntelligenceEngine,
            "discover_database_configuration",
            return_value={
                "discovered": False,
                "status": "DB_CONFIG_NOT_FOUND",
                "configFile": None,
                "engine": "unknown",
                "database": None,
                "username": None,
            },
        ), patch.object(
            DatabaseIntelligenceEngine,
            "check_database_capabilities",
            return_value={"available_paths": []},
        ), patch.object(
            ConfigurationSymbolResolver,
            "get_credential",
            return_value={},
        ), patch.object(
            DatabaseSessionManager,
            "get_session",
            return_value=session,
        ), patch.object(
            DatabaseSessionManager,
            "get_or_create_session",
            return_value=session,
        ), patch(
            "coding_websocket._resolve_semantic_task_with_model",
            new=AsyncMock(side_effect=AssertionError("deterministic request must not use the model")),
        ) as resolve_task, patch.object(
            DatabaseSessionManager,
            "execute_database_capability",
            return_value={
                "ok": True,
                "capability": DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
                "content": (
                    "Username: NOT_RESOLVED\nPassword: [REDACTED]\n"
                    "Credential source: NOT_RESOLVED"
                ),
                "credentialStatus": "NOT_VERIFIED",
                "username": "NOT_RESOLVED",
                "database": "NOT_RESOLVED",
                "password": "[REDACTED]",
                "executionStatus": "SUCCESS",
                "executed": True,
            },
        ):
            await _run_coding_turn(
                {
                    "requestId": "unresolved-credential-evidence",
                    "sessionId": "unresolved-credential-evidence-session",
                    "messages": [{
                        "role": "user",
                        "content": "sow my db useranme and passwod",
                    }],
                },
                send_json,
                {"pending": {}, "completed": {}, "tasks": set()},
                None,
                "",
            )

        resolve_task.assert_not_awaited()
        done = next(message for message in sent if message.get("type") == "done")
        self.assertEqual(
            done["status"],
            "BLOCKED",
            json.dumps({
                "taskStatus": done["agentTaskState"].get("status"),
                "requiredFacts": done["agentTaskState"].get("requiredFacts"),
                "content": done.get("content"),
            }),
        )
        self.assertEqual(done["agentTaskState"]["status"], "BLOCKED")
        self.assertIn("**Username:** Not confirmed", done["content"])
        self.assertIn("Password:** [REDACTED]", done["content"])
        self.assertIsNotNone(done["agentTaskState"]["nextAction"])

    async def test_database_reasoning_replans_after_failure_and_uses_evolved_state(self):
        with tempfile.TemporaryDirectory() as project_root:
            sent = []
            decisions = [
                {
                    "is_deterministic": True,
                    "capability": DatabaseCapability.DATABASE_COUNT_RECORDS,
                    "arguments": {"entity": "users"},
                    "resolved_by_model": True,
                    "semanticTask": {
                        "intent": "COUNT",
                        "goal": "Count users and inspect their schema if needed.",
                        "resourceCandidates": ["DATABASE"],
                        "resolvedResources": ["DATABASE"],
                        "resourceDetails": [],
                        "confidence": 0.9,
                    },
                },
                {
                    "is_deterministic": True,
                    "capability": DatabaseCapability.DATABASE_DESCRIBE_TABLE,
                    "arguments": {"table": "users"},
                    "resolved_by_model": True,
                    "semanticTask": {"reasoningSummary": "Inspect the count target schema."},
                },
                {
                    "is_deterministic": True,
                    "capability": DatabaseCapability.DATABASE_CURRENT_TARGET,
                    "arguments": {},
                    "resolved_by_model": True,
                    "semanticTask": {"reasoningSummary": "The schema inspection failed; gather connection evidence instead."},
                },
                {
                    "is_deterministic": False,
                    "answer": "There are 3 users; schema inspection failed, but the database connection is available.",
                    "semanticTask": {"reasoningSummary": "The evidence now answers the user."},
                },
            ]
            results = [
                {"ok": True, "content": "3 users", "executionStatus": "SUCCESS", "databaseType": "mysql"},
                {"ok": False, "content": "Schema inspection failed", "executionStatus": "FAILED", "databaseType": "mysql"},
                {"ok": True, "content": "Connection is active", "executionStatus": "SUCCESS", "databaseType": "mysql"},
            ]
            state_snapshots = []
            session = SimpleNamespace(
                project_root=project_root,
                target_id="DB-TEST",
                database_type="mysql",
                database_name="test_db",
                connection_state="CONNECTED",
                connection_capabilities={},
                to_safe_dict=lambda: {"targetId": "DB-TEST"},
            )

            async def send_json(payload):
                sent.append(payload)

            async def resolve_task(*args):
                state_snapshots.append(args[3].get("activeTaskState") or {})
                return decisions.pop(0)

            def execute_database_action(*_args, **_kwargs):
                return results.pop(0)

            with patch("coding_websocket.ProjectContextLock.resolve_authoritative_root", return_value=project_root), patch(
                "coding_websocket.ProjectContextLock.lock"
            ), patch("coding_websocket.set_backend_project_state"), patch(
                "coding_websocket.detect_project_architecture", return_value={}
            ), patch.object(
                DatabaseIntelligenceEngine,
                "discover_database_configuration",
                return_value={"engine": "mysql", "database": "test_db"},
            ), patch.object(
                DatabaseIntelligenceEngine,
                "check_database_capabilities",
                return_value={"available_paths": ["application_client"]},
            ), patch.object(
                DatabaseSessionManager,
                "get_session",
                return_value=session,
            ), patch.object(
                DatabaseSessionManager,
                "get_or_create_session",
                return_value=session,
            ), patch(
                "coding_websocket._resolve_semantic_task_with_model",
                new=AsyncMock(side_effect=resolve_task),
            ) as resolve_action, patch.object(
                DatabaseSessionManager,
                "execute_database_capability",
                side_effect=execute_database_action,
            ) as execute_capability:
                await _run_coding_turn(
                    {
                        "requestId": "database-replan-after-failure",
                        "sessionId": "database-replan-after-failure-session",
                        "projectRoot": project_root,
                        "messages": [{"role": "user", "content": "Count users and inspect the relevant evidence."}],
                    },
                    send_json,
                    {"pending": {}, "completed": {}, "tasks": set()},
                    SimpleNamespace(get_active_provider=lambda: SimpleNamespace(id="test-provider")),
                    "",
                )

            self.assertEqual(resolve_action.await_count, 4)
            self.assertEqual(
                [call.args[0] for call in execute_capability.call_args_list],
                [
                    DatabaseCapability.DATABASE_COUNT_RECORDS,
                    DatabaseCapability.DATABASE_DESCRIBE_TABLE,
                    DatabaseCapability.DATABASE_CURRENT_TARGET,
                ],
            )
            self.assertGreater(
                state_snapshots[2]["revision"],
                state_snapshots[1]["revision"],
            )
            done = next(message for message in sent if message.get("type") == "done")
            state = done["agentTaskState"]
            self.assertEqual(done["status"], "COMPLETED")
            self.assertEqual(done["content"], "There are 3 users; schema inspection failed, but the database connection is available.")
            self.assertEqual(state["reasoningCycle"], 4)
            self.assertEqual(
                [item["decision"] for item in state["reasoningHistory"]],
                [
                    DatabaseCapability.DATABASE_COUNT_RECORDS,
                    DatabaseCapability.DATABASE_DESCRIBE_TABLE,
                    DatabaseCapability.DATABASE_CURRENT_TARGET,
                    "ANSWER",
                ],
            )
            self.assertEqual(
                [item["status"] for item in state["actions"]],
                ["SUCCESS", "FAILED", "SUCCESS"],
            )
            self.assertTrue(state["evidence"])
            self.assertTrue(state["observations"])
            self.assertIsNone(state["nextAction"])

    async def test_followup_database_clarification_preserves_blocked_state_and_options(self):
        with tempfile.TemporaryDirectory() as project_root:
            sent = []
            question = "Could not determine which value in `pay_status` means paid."
            options = [
                {"value": "0", "label": "0 (1 rows)"},
                {"value": "9", "label": "9 (2 rows)"},
            ]
            decisions = [
                {
                    "is_deterministic": True,
                    "capability": DatabaseCapability.DATABASE_LIST_TABLES,
                    "arguments": {},
                    "resolved_by_model": True,
                    "semanticTask": {
                        "intent": "DATABASE_INVESTIGATION",
                        "goal": "Inspect and count paid admission records.",
                        "resourceCandidates": ["DATABASE"],
                        "resolvedResources": ["DATABASE"],
                        "confidence": 0.9,
                    },
                },
                {
                    "is_deterministic": True,
                    "capability": DatabaseCapability.DATABASE_COUNT_RECORDS,
                    "arguments": {"entity": "admissions", "payment_filter": "paid"},
                    "resolved_by_model": True,
                    "semanticTask": {"reasoningSummary": "Count paid admissions from the discovered tables."},
                },
                {
                    "is_deterministic": False,
                    "clarification": question,
                    "semanticTask": {"reasoningSummary": "The paid status value remains ambiguous."},
                },
            ]
            results = [
                {
                    "ok": True,
                    "content": "Tables: admissions, users",
                    "executionStatus": "SUCCESS",
                    "databaseType": "mysql",
                },
                {
                    "ok": True,
                    "content": question,
                    "executionStatus": "NEEDS_CLARIFICATION",
                    "clarificationType": "payment_status_value",
                    "clarificationOptions": options,
                    "databaseType": "mysql",
                },
            ]
            state_snapshots = []
            session = SimpleNamespace(
                project_root=project_root,
                target_id="DB-TEST",
                database_type="mysql",
                database_name="test_db",
                connection_state="CONNECTED",
                connection_capabilities={},
                to_safe_dict=lambda: {"targetId": "DB-TEST"},
            )

            async def send_json(payload):
                sent.append(payload)

            async def resolve_task(*args):
                state_snapshots.append(args[3].get("activeTaskState") or {})
                return decisions.pop(0)

            with patch("coding_websocket.ProjectContextLock.resolve_authoritative_root", return_value=project_root), patch(
                "coding_websocket.ProjectContextLock.lock"
            ), patch("coding_websocket.set_backend_project_state"), patch(
                "coding_websocket.detect_project_architecture", return_value={}
            ), patch.object(
                DatabaseIntelligenceEngine,
                "discover_database_configuration",
                return_value={"engine": "mysql", "database": "test_db"},
            ), patch.object(
                DatabaseIntelligenceEngine,
                "check_database_capabilities",
                return_value={"available_paths": ["application_client"]},
            ), patch.object(
                DatabaseSessionManager,
                "get_session",
                return_value=session,
            ), patch.object(
                DatabaseSessionManager,
                "get_or_create_session",
                return_value=session,
            ), patch(
                "coding_websocket._resolve_semantic_task_with_model",
                new=AsyncMock(side_effect=resolve_task),
            ) as resolve_action, patch.object(
                DatabaseSessionManager,
                "execute_database_capability",
                side_effect=lambda *_args, **_kwargs: results.pop(0),
            ) as execute_capability:
                await _run_coding_turn(
                    {
                        "requestId": "database-followup-clarification",
                        "sessionId": "database-followup-clarification-session",
                        "projectRoot": project_root,
                        "messages": [{
                            "role": "user",
                            "content": "Investigate paid admission records and determine which status values qualify.",
                        }],
                    },
                    send_json,
                    {"pending": {}, "completed": {}, "tasks": set()},
                    SimpleNamespace(get_active_provider=lambda: SimpleNamespace(id="test-provider")),
                    "",
                )

            self.assertEqual(resolve_action.await_count, 3)
            self.assertEqual(execute_capability.call_count, 2)
            blocked_state = state_snapshots[2]
            self.assertEqual(blocked_state["actions"][-1]["status"], "BLOCKED")
            self.assertTrue(any(item.get("question") == question for item in blocked_state["unknowns"]))
            done = next(message for message in sent if message.get("type") == "done")
            self.assertEqual(done["status"], "NEEDS_CLARIFICATION")
            self.assertTrue(done["needsClarification"])
            self.assertEqual(done["content"], question)
            self.assertEqual(done["clarificationOptions"], options)
            self.assertEqual(done["agentTaskState"]["status"], "NEEDS_CLARIFICATION")
            self.assertEqual(done["agentTaskState"]["nextActionName"], "CLARIFY")
            self.assertTrue(done["agentTaskState"]["clarificationRequired"])

    async def test_connection_status_uses_normal_concise_coding_agent_answer(self):
        provider = SimpleNamespace(id="status-provider", type="groq", model="test-model")
        result = {
            "content": (
                "### DATABASE CONNECTION STATUS\n"
                "- **Engine:** Unknown\n"
                "- **Status:** NOT_VERIFIED\n"
                "Password: super-secret-value"
            ),
            "engine": None,
            "database": None,
            "status": "NOT_VERIFIED",
            "activeSessionState": "DISCONNECTED",
            "configuredDatabase": {
                "password": "super-secret-value",
                "status": "CONFIGURED",
                "configFile": "config/database.php",
                "engine": "mysql",
                "database": {"value": "shop", "status": "RESOLVED"},
            },
            "liveDatabase": {
                "connected": False,
                "status": "NOT_VERIFIED",
            },
        }
        answer = "I couldn't verify a live database connection, and no database configuration was found in the project."
        with patch(
            "coding_websocket.complete_coding_model",
            return_value=({"role": "assistant", "content": answer}, provider),
        ) as complete:
            summarized, selected_provider = await _summarize_database_connection_status(
                SimpleNamespace(),
                Path("provider-config.json"),
                [{"role": "user", "content": "show my db connection"}],
                result,
                provider.id,
                "connection-status-request",
                "connection-status-session",
            )

        self.assertEqual(summarized, answer)
        self.assertEqual(selected_provider, provider)
        summary_request = complete.call_args.args[2][-1]["content"]
        sent_messages = json.dumps(complete.call_args.args[2], ensure_ascii=False)
        self.assertNotIn("super-secret-value", sent_messages)
        self.assertIn("NOT_VERIFIED", sent_messages)
        self.assertIn('"connected": false', summary_request)
        self.assertIn("activeSession", summary_request)
        self.assertIn("runtimeVerification", summary_request)
        self.assertIn("configured status alone never proves", complete.call_args.args[2][0]["content"])
        self.assertIn("normal conversational style", complete.call_args.args[2][0]["content"])

    async def test_code_only_request_gets_model_semantic_decision_before_investigation(self):
        with tempfile.TemporaryDirectory() as project_root:
            sent = []

            async def send_json(payload):
                sent.append(payload)

            provider = SimpleNamespace(id="test-provider", type="groq", model="test-model")
            with patch("coding_websocket.ProjectContextLock.resolve_authoritative_root", return_value=project_root), patch(
                "coding_websocket.ProjectContextLock.lock"
            ), patch("coding_websocket.set_backend_project_state"), patch(
                "coding_websocket.detect_project_architecture", return_value={}
            ), patch.object(
                DatabaseIntelligenceEngine,
                "discover_database_configuration",
                return_value={"engine": "mysql", "database": "test_db"},
            ) as discover_database, patch.object(
                DatabaseIntelligenceEngine,
                "check_database_capabilities",
                return_value={"available_paths": ["application_client"]},
            ), patch(
                "coding_websocket._resolve_semantic_task_with_model",
                new=AsyncMock(return_value={
                    "is_deterministic": False,
                    "route_to_code": True,
                    "resolved_by_model": True,
                    "semanticTask": {
                        "intent": "CODE_QUESTION",
                        "goal": "Locate the request lifecycle.",
                        "resourceCandidates": ["CODE", "REPOSITORY"],
                        "confidence": 0.96,
                    },
                }),
            ) as resolve_action, patch(
                "coding_websocket.complete_coding_model",
                return_value=({"role": "assistant", "content": "The connection helper is in src/db.py."}, provider),
            ), patch.object(
                DatabaseSessionManager,
                "execute_database_capability",
            ) as execute_capability:
                await _run_coding_turn(
                    {
                        "requestId": "route-db-code-question",
                        "sessionId": "route-db-code-question-session",
                        "projectRoot": project_root,
                        "messages": [{"role": "user", "content": "Where is the request lifecycle implemented?"}],
                    },
                    send_json,
                    {"pending": {}, "completed": {}, "tasks": set()},
                    SimpleNamespace(get_active_provider=lambda: provider),
                    "",
                )

            resolve_action.assert_awaited_once()
            discover_database.assert_not_called()
            execute_capability.assert_not_called()
            done = next(message for message in sent if message.get("type") == "done")
            self.assertIn("src/db.py", done["content"])
            self.assertEqual(done["semanticTask"]["resolvedResources"], ["CODE", "REPOSITORY"])
            self.assertEqual(done["semanticTask"]["intent"]["primary"], "CODE_QUESTION")
            self.assertEqual(done["semanticTask"]["confidence"], 0.96)

    async def test_model_decision_retains_all_resources_for_compound_code_investigation(self):
        with tempfile.TemporaryDirectory() as project_root:
            sent = []

            async def send_json(payload):
                sent.append(payload)

            provider = SimpleNamespace(id="test-provider", type="groq", model="test-model")
            with patch("coding_websocket.ProjectContextLock.resolve_authoritative_root", return_value=project_root), patch(
                "coding_websocket.ProjectContextLock.lock"
            ), patch("coding_websocket.set_backend_project_state"), patch(
                "coding_websocket.detect_project_architecture", return_value={}
            ), patch.object(
                DatabaseIntelligenceEngine,
                "discover_database_configuration",
                return_value={"engine": "mysql", "database": "test_db"},
            ) as discover_database, patch.object(
                DatabaseIntelligenceEngine,
                "check_database_capabilities",
                return_value={"available_paths": ["application_client"]},
            ), patch(
                "coding_websocket._resolve_semantic_task_with_model",
                new=AsyncMock(return_value={
                    "is_deterministic": False,
                    "route_to_code": True,
                    "resolved_by_model": True,
                    "semanticTask": {
                        "intent": "DATA_FLOW_TRACE",
                        "goal": "Trace the data from request to database and response.",
                        "resourceCandidates": ["CODE", "API", "DATABASE"],
                        "requiredEvidence": ["route", "query", "response"],
                        "confidence": 0.91,
                    },
                }),
            ), patch(
                "coding_websocket.complete_coding_model",
                return_value=({"role": "assistant", "content": "The request is served by the existing API path."}, provider),
            ), patch.object(
                DatabaseSessionManager,
                "execute_database_capability",
            ) as execute_capability:
                await _run_coding_turn(
                    {
                        "requestId": "compound-data-flow",
                        "sessionId": "compound-data-flow-session",
                        "projectRoot": project_root,
                        "messages": [{
                            "role": "user",
                            "content": "Trace this data through the API and show how the database result reaches the response.",
                        }],
                    },
                    send_json,
                    {"pending": {}, "completed": {}, "tasks": set()},
                    SimpleNamespace(get_active_provider=lambda: provider),
                    "",
                )

            discover_database.assert_called_once()
            execute_capability.assert_not_called()
            done = next(message for message in sent if message.get("type") == "done")
            self.assertEqual(done["semanticTask"]["resolvedResources"], ["CODE", "API", "DATABASE"])
            self.assertEqual(done["semanticTask"]["requiredEvidence"], ["route", "query", "response"])
            self.assertEqual(done["semanticTask"]["status"], "COMPLETED")

    async def test_follow_up_turn_reuses_task_scoped_semantic_memory(self):
        with tempfile.TemporaryDirectory() as project_root:
            sent = []
            resolver_contexts = []
            provider = SimpleNamespace(id="test-provider", type="groq", model="test-model")
            decisions = iter([
                {
                    "is_deterministic": False,
                    "route_to_code": True,
                    "resolved_by_model": True,
                    "semanticTask": {
                        "intent": "CODE_QUESTION",
                        "goal": "Locate the request handler.",
                        "resourceCandidates": ["CODE", "REPOSITORY"],
                        "confidence": 0.9,
                    },
                },
                {
                    "is_deterministic": False,
                    "route_to_code": True,
                    "resolved_by_model": True,
                    "semanticTask": {
                        "intent": "DATA_FLOW_TRACE",
                        "goal": "Trace the same flow for payment.",
                        "target": "payment",
                        "resourceCandidates": ["CODE", "API", "DATABASE"],
                        "confidence": 0.93,
                    },
                },
            ])

            async def send_json(payload):
                sent.append(payload)

            async def resolve_task(*args):
                resolver_contexts.append(args[3])
                return next(decisions)

            with patch("coding_websocket.ProjectContextLock.resolve_authoritative_root", return_value=project_root), patch(
                "coding_websocket.ProjectContextLock.lock"
            ), patch("coding_websocket.set_backend_project_state"), patch(
                "coding_websocket.detect_project_architecture", return_value={}
            ), patch(
                "coding_websocket._resolve_semantic_task_with_model",
                new=AsyncMock(side_effect=resolve_task),
            ), patch(
                "coding_websocket.complete_coding_model",
                return_value=({"role": "assistant", "content": "The handler is in src/handler.py."}, provider),
            ), patch.object(
                DatabaseIntelligenceEngine,
                "discover_database_configuration",
                return_value={"engine": "mysql", "database": "test_db"},
            ) as discover_database, patch.object(
                DatabaseIntelligenceEngine,
                "check_database_capabilities",
                return_value={"available_paths": ["application_client"]},
            ):
                state = {"pending": {}, "completed": {}, "tasks": set()}
                await _run_coding_turn(
                    {
                        "requestId": "semantic-follow-up-1",
                        "sessionId": "semantic-follow-up-session",
                        "projectRoot": project_root,
                        "messages": [{"role": "user", "content": "Where is the request handler?"}],
                    },
                    send_json,
                    state,
                    SimpleNamespace(get_active_provider=lambda: provider),
                    "",
                )
                assistant_answer = next(
                    message["content"]
                    for message in reversed(sent)
                    if message.get("type") == "done"
                )
                await _run_coding_turn(
                    {
                        "requestId": "semantic-follow-up-2",
                        "sessionId": "semantic-follow-up-session",
                        "projectRoot": project_root,
                        "messages": [
                            {"role": "user", "content": "Where is the request handler?"},
                            {"role": "assistant", "content": assistant_answer},
                            {"role": "user", "content": "trace the same for payment"},
                        ],
                    },
                    send_json,
                    state,
                    SimpleNamespace(get_active_provider=lambda: provider),
                    "",
                )

            prior_task_memory = resolver_contexts[1]["priorTaskState"]
            self.assertEqual(prior_task_memory["intent"]["primary"], "CODE_QUESTION")
            self.assertEqual(prior_task_memory["goal"]["statement"], "Locate the request handler.")
            self.assertEqual(resolver_contexts[1]["activeTaskTarget"], None)
            self.assertEqual(discover_database.call_count, 1)
            latest_done = next(message for message in reversed(sent) if message.get("type") == "done")
            self.assertEqual(latest_done["semanticTask"]["target"]["userReference"], "payment")
            self.assertEqual(latest_done["semanticTask"]["resolvedResources"], ["CODE", "API", "DATABASE"])

    async def test_explicit_code_request_survives_semantic_provider_failure(self):
        with tempfile.TemporaryDirectory() as project_root:
            sent = []
            provider = SimpleNamespace(id="test-provider", type="groq", model="test-model")

            async def send_json(payload):
                sent.append(payload)

            with patch("coding_websocket.ProjectContextLock.resolve_authoritative_root", return_value=project_root), patch(
                "coding_websocket.ProjectContextLock.lock"
            ), patch("coding_websocket.set_backend_project_state"), patch(
                "coding_websocket.detect_project_architecture", return_value={}
            ), patch.object(
                DatabaseIntelligenceEngine,
                "discover_database_configuration",
                return_value={"engine": "mysql", "database": "test_db"},
            ) as discover_database, patch(
                "coding_websocket._resolve_semantic_task_with_model",
                new=AsyncMock(side_effect=RuntimeError("temporary provider failure")),
            ), patch(
                "coding_websocket.complete_coding_model",
                return_value=({"role": "assistant", "content": "The helper is in src/db.py."}, provider),
            ), patch.object(
                DatabaseSessionManager,
                "execute_database_capability",
            ) as execute_capability:
                await _run_coding_turn(
                    {
                        "requestId": "route-explicit-code-after-provider-failure",
                        "sessionId": "route-explicit-code-after-provider-failure",
                        "projectRoot": project_root,
                        "messages": [{
                            "role": "user",
                            "content": "Why is the database connection helper failing?",
                        }],
                    },
                    send_json,
                    {"pending": {}, "completed": {}, "tasks": set()},
                    SimpleNamespace(get_active_provider=lambda: provider),
                    "",
                )

            discover_database.assert_not_called()
            execute_capability.assert_not_called()
            self.assertFalse(any(message.get("type") == "error" for message in sent))
            done = next(message for message in sent if message.get("type") == "done")
            self.assertIn("src/db.py", done["content"])
            self.assertEqual(done["intent"], "CODE_QUESTION")

    async def test_deterministic_database_operation_runs_without_a_provider(self):
        with tempfile.TemporaryDirectory() as project_root:
            sent = []

            async def send_json(payload):
                sent.append(payload)

            session = SimpleNamespace(
                project_root=project_root,
                database_type="mysql",
                database_name="test_db",
                connection_state="CONNECTED",
                target_id="DB-TEST",
            )
            with patch("coding_websocket.ProjectContextLock.resolve_authoritative_root", return_value=project_root), patch(
                "coding_websocket.ProjectContextLock.lock"
            ), patch("coding_websocket.set_backend_project_state"), patch(
                "coding_websocket.detect_project_architecture", return_value={}
            ), patch.object(
                DatabaseIntelligenceEngine,
                "discover_database_configuration",
                return_value={"engine": "mysql", "database": "test_db"},
            ), patch.object(
                DatabaseIntelligenceEngine,
                "check_database_capabilities",
                return_value={"available_paths": ["application_client"]},
            ), patch.object(
                DatabaseSessionManager,
                "get_session",
                return_value=session,
            ), patch(
                "coding_websocket._resolve_semantic_task_with_model",
                new=AsyncMock(side_effect=RuntimeError("No provider is configured for the Coding Agent.")),
            ), patch(
                "coding_websocket.complete_coding_model",
                return_value=(
                    {"role": "assistant", "content": "I could not confirm live table data without a model."},
                    SimpleNamespace(id="fallback-provider", type="test", model="test"),
                ),
            ), patch.object(
                DatabaseSessionManager,
                "execute_database_capability",
                return_value={
                    "ok": True,
                    "content": "Tables: admissions, users",
                    "executionStatus": "SUCCESS",
                    "databaseType": "mysql",
                },
            ) as execute_capability:
                await _run_coding_turn(
                    {
                        "requestId": "database-intent-provider-failure",
                        "sessionId": "database-intent-provider-failure-session",
                        "projectRoot": project_root,
                        "messages": [{"role": "user", "content": "show all tables"}],
                    },
                    send_json,
                    {"pending": {}, "completed": {}, "tasks": set()},
                    None,
                    "",
                )

            execute_capability.assert_called_once_with(
                DatabaseCapability.DATABASE_LIST_TABLES,
                {},
                unittest.mock.ANY,
                project_root=project_root,
            )
            done = next(message for message in sent if message.get("type") == "done")
            self.assertEqual(done["status"], "COMPLETED")
            self.assertIn("Tables: admissions, users", done["content"])
            self.assertEqual(done["agentTaskState"]["failures"], [])
            self.assertIsNone(done["agentTaskState"]["execution"]["result"].get("password"))

    async def test_unresolved_credential_scan_replans_to_repository_search(self):
        with tempfile.TemporaryDirectory() as project_root:
            sent = []
            provider = SimpleNamespace(id="test-provider", type="groq", model="test-model")

            async def send_json(payload):
                sent.append(payload)

            with patch("coding_websocket.ProjectContextLock.resolve_authoritative_root", return_value=project_root), patch(
                "coding_websocket.ProjectContextLock.lock"
            ), patch("coding_websocket.set_backend_project_state"), patch(
                "coding_websocket.detect_project_architecture", return_value={}
            ), patch.object(
                DatabaseIntelligenceEngine,
                "discover_database_configuration",
                return_value={
                    "discovered": False,
                    "status": "DB_CONFIG_NOT_FOUND",
                    "configFile": None,
                    "engine": "unknown",
                    "database": None,
                    "username": None,
                },
            ), patch.object(
                DatabaseIntelligenceEngine,
                "check_database_capabilities",
                return_value={"available_paths": []},
            ), patch.object(
                DatabaseSessionManager,
                "execute_database_capability",
            ) as execute_capability, patch(
                "coding_websocket._resolve_semantic_task_with_model",
                new=AsyncMock(return_value={
                    "is_deterministic": True,
                    "capability": DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
                    "arguments": {},
                    "resolved_by_model": True,
                    "semanticTask": {
                        "intent": "DATABASE_CREDENTIAL_REQUEST",
                        "goal": "Find the configured database username.",
                        "resourceCandidates": ["DATABASE", "CONFIGURATION"],
                        "requiredEvidence": ["Configured database username."],
                        "confidence": 0.9,
                    },
                }),
            ), patch(
                "coding_websocket.complete_coding_model",
                side_effect=[
                    (
                        {"role": "assistant", "content": "I should inspect the project source."},
                        provider,
                    ),
                    (
                        {
                            "role": "assistant",
                            "content": (
                                "The project-source search did not resolve a database username. "
                                "No connection metadata can be confirmed from the available evidence."
                            ),
                        },
                        provider,
                    ),
                ],
            ) as complete_model, patch(
                "coding_websocket.MAX_CODING_TOOL_ROUNDS",
                2,
            ), patch(
                "coding_websocket._wait_for_tool",
                new=AsyncMock(return_value={"ok": True, "data": {"matches": []}}),
            ):
                await _run_coding_turn(
                    {
                        "requestId": "credential-unresolved-replan",
                        "sessionId": "credential-unresolved-replan-session",
                        "projectRoot": project_root,
                        "messages": [{
                            "role": "user",
                            "content": "sow my db useranme and passwod",
                        }],
                    },
                    send_json,
                    {"pending": {}, "completed": {}, "tasks": set()},
                    SimpleNamespace(get_active_provider=lambda: provider),
                    "",
                )

            execute_capability.assert_not_called()
            complete_model.assert_not_called()
            done = next(message for message in sent if message.get("type") == "done")
            self.assertEqual(
                done["status"],
                "INVESTIGATION_INCOMPLETE",
                json.dumps({
                    "taskStatus": done["agentTaskState"].get("status"),
                    "unknowns": done["agentTaskState"].get("unknowns"),
                    "actions": done["agentTaskState"].get("actions"),
                    "resources": done["agentTaskState"].get("resolvedResources"),
                }),
            )
            self.assertIn("couldn't verify every requested database credential detail", done["content"])
            self.assertIn("Username: not confirmed", done["content"])
            self.assertIn("Password presence: not confirmed", done["content"])
            self.assertIn("Password value: [REDACTED]", done["content"])
            self.assertIn("does not verify a live database connection", done["content"])
            self.assertEqual(done["agentTaskState"]["status"], "BLOCKED")
            self.assertEqual(done["agentTaskState"]["intent"]["primary"], "DATABASE_CREDENTIAL_REQUEST")
            self.assertIn("CODE", done["agentTaskState"]["resolvedResources"])
            self.assertEqual(
                [call["name"] for call in done["toolCalls"]],
                ["search_code", "search_code"],
            )
            self.assertEqual(done["toolCalls"][0]["arguments"]["query"], "DB_USERNAME")
            self.assertEqual(done["toolCalls"][1]["arguments"]["query"], "DB_PASSWORD")
            self.assertTrue(done["agentTaskState"]["unknowns"])
            self.assertFalse(any(
                event.get("event") == "TASK_COMPLETED"
                for event in done["lifecycleEvents"]
            ))

    async def test_database_requests_are_model_resolved_then_use_safe_capabilities(self):
        scenarios = [
            (
                [{"role": "user", "content": "show my db"}],
                DatabaseCapability.DATABASE_CURRENT_TARGET,
            ),
            (
                [
                    {"role": "user", "content": "SELECT COUNT(*) FROM adm_user_programme_selection"},
                    {"role": "assistant", "content": "There are 11 rows."},
                    {"role": "user", "content": "show my username and passwd"},
                ],
                DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
            ),
            (
                [
                    {"role": "user", "content": "show me all table"},
                ],
                DatabaseCapability.DATABASE_LIST_TABLES,
            ),
            (
                [
                    {"role": "user", "content": "show my all table"},
                ],
                DatabaseCapability.DATABASE_LIST_TABLES,
            ),
            (
                [
                    {"role": "user", "content": "show me database which one connected"},
                ],
                DatabaseCapability.DATABASE_CURRENT_TARGET,
            ),
            (
                [
                    {"role": "user", "content": "show me database which one connected"},
                    {"role": "assistant", "content": "Connected database: test_db (MySQL)."},
                    {"role": "user", "content": "show me username"},
                ],
                DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
            ),
        ]

        for index, (messages, expected_capability) in enumerate(scenarios):
            with self.subTest(capability=expected_capability), tempfile.TemporaryDirectory() as project_root:
                sent = []
                execution_order = []
                session = SimpleNamespace(
                    project_root=project_root,
                    target_id="DB-TEST",
                    database_type="mysql",
                    database_name="test_db",
                    connection_state="CONNECTED",
                    connection_capabilities={},
                    to_safe_dict=lambda: {"targetId": "DB-TEST"},
                )

                async def send_json(payload):
                    sent.append(payload)

                registry = SimpleNamespace(
                    get_active_provider=lambda: SimpleNamespace(id="test-provider")
                )
                status_provider = SimpleNamespace(id="test-provider", type="groq", model="test-model")
                resolve_call_count = 0

                async def resolve_task(*_args):
                    nonlocal resolve_call_count
                    resolve_call_count += 1
                    execution_order.append("understand")
                    active_state = _args[3].get("activeTaskState") or {}
                    if active_state.get("actions"):
                        execution_order.append("replan")
                        return {
                            "is_deterministic": False,
                            "answer": (
                                "The database connection status is not verified."
                                if expected_capability == DatabaseCapability.DATABASE_CURRENT_TARGET
                                else "The configured username is configured_user."
                            ),
                            "resolved_by_model": True,
                            "semanticTask": {"reasoningSummary": "The latest evidence is sufficient."},
                        }
                    return {
                        "is_deterministic": True,
                        "capability": expected_capability,
                        "arguments": (
                            {"properties": ["username"]}
                            if expected_capability == DatabaseCapability.DATABASE_CREDENTIAL_REQUEST
                            else {}
                        ),
                        "resolved_by_model": True,
                    }

                resolve_action = AsyncMock(side_effect=resolve_task)

                def execute_database_action(*_args, **_kwargs):
                    execution_order.append("inspect_and_verify")
                    return capability_result

                def summarize_status(*_args):
                    execution_order.append("natural_answer")
                    return (
                        {"role": "assistant", "content": "The database connection status is not verified."},
                        status_provider,
                    )

                capability_result = {
                    "ok": True,
                    "content": "Password: [REDACTED]",
                    "executionStatus": "SUCCESS",
                    "databaseType": "mysql",
                    "executed": True,
                }
                with patch("coding_websocket.ProjectContextLock.resolve_authoritative_root", return_value=project_root), patch(
                    "coding_websocket.ProjectContextLock.lock"
                ), patch("coding_websocket.set_backend_project_state"), patch(
                    "coding_websocket.detect_project_architecture", return_value={}
                ), patch.object(
                    DatabaseIntelligenceEngine,
                    "discover_database_configuration",
                    return_value={
                        "engine": "mysql",
                        "database": "test_db",
                        "username": "configured_user",
                        "has_credentials": True,
                    },
                ), patch.object(
                    DatabaseIntelligenceEngine,
                    "check_database_capabilities",
                    return_value={"available_paths": ["application_client"]},
                ), patch.object(
                    DatabaseSessionManager,
                    "get_session",
                    return_value=session,
                ), patch.object(
                    DatabaseSessionManager,
                    "get_or_create_session",
                    return_value=session,
                ), patch.object(
                    DatabaseSessionManager,
                    "execute_database_capability",
                    side_effect=execute_database_action,
                ) as execute_capability, patch(
                    "coding_websocket._resolve_semantic_task_with_model",
                    resolve_action,
                ), patch(
                    "coding_websocket.complete_coding_model",
                    side_effect=summarize_status,
                ):
                    await _run_coding_turn(
                        {
                            "requestId": f"db-fast-path-{index}",
                            "sessionId": f"db-fast-path-session-{index}",
                            "projectRoot": project_root,
                            "messages": messages,
                        },
                        send_json,
                        {"pending": {}, "completed": {}, "tasks": set()},
                        registry,
                        "",
                    )

                is_contextual_username = messages[-1]["content"] == "show me username"
                self.assertEqual(resolve_action.await_count, 2 if is_contextual_username else 0)
                if is_contextual_username:
                    self.assertEqual(
                        resolve_action.await_args_list[0].args[2],
                        messages,
                        "The model must receive the full user/assistant context for a property-only follow-up.",
                    )
                self.assertEqual(execute_capability.call_args.args[0], expected_capability)
                done = next(message for message in sent if message.get("type") == "done")
                self.assertEqual(done["status"], "COMPLETED")
                if expected_capability == DatabaseCapability.DATABASE_CURRENT_TARGET:
                    self.assertEqual(done["content"], "The database connection status is not verified.")
                    self.assertNotIn("DATABASE CONNECTION STATUS", done["content"])
                    self.assertEqual(
                        execution_order,
                        ["inspect_and_verify", "natural_answer"],
                    )
                    self.assertEqual(
                        done["semanticTask"]["requiredEvidence"],
                        [
                            "What database configuration is declared for the active project?",
                            "What is the active session state for the active project database?",
                            "Did live runtime verification confirm a database connection?",
                        ],
                    )
                    self.assertEqual(
                        [item["kind"] for item in done["semanticTask"]["evidencePlan"]],
                        ["PROJECT_CONFIGURATION", "ACTIVE_DATABASE_SESSION", "LIVE_RUNTIME_VERIFICATION"],
                    )
                    state = done["agentTaskState"]
                    evidence_ids = {item["evidenceId"] for item in state["evidence"]}
                    self.assertTrue(all(item["evidenceId"] in evidence_ids for item in state["facts"]))
                    self.assertFalse(state["verification"]["passed"])
                    self.assertIn(
                        "Did live runtime verification confirm a database connection?",
                        [item["question"] for item in state["unknowns"]],
                    )
                    self.assertEqual(state["resources"][0]["status"], "UNKNOWN")
                else:
                    self.assertNotIn("test-only-secret", done["content"])
                    if expected_capability == DatabaseCapability.DATABASE_CREDENTIAL_REQUEST:
                        if is_contextual_username:
                            self.assertIn("configured_user", done["content"])
                        else:
                            self.assertIn("[REDACTED]", done["content"])
                    else:
                        self.assertIn("[REDACTED]", done["content"])


class CodingProposalRetryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        async def resolve_task(_registry, _config, messages, *_args):
            latest_request = next(
                (str(item.get("content") or "") for item in reversed(messages) if item.get("role") == "user"),
                "",
            )
            is_change = _requires_proposal_for_conversation(messages)
            intent = "SOURCE_CHANGE" if is_change else "CODE_QUESTION"
            return {
                "is_deterministic": False,
                "route_to_code": True,
                "resolved_by_model": True,
                "semanticTask": {
                    "intent": intent,
                    "goal": latest_request,
                    "resourceCandidates": ["CODE", "REPOSITORY"],
                    "confidence": 0.9,
                },
            }

        self.semantic_resolver = patch(
            "coding_websocket._resolve_semantic_task_with_model",
            new=AsyncMock(side_effect=resolve_task),
        )
        self.semantic_resolver.start()
        self.addCleanup(self.semantic_resolver.stop)

    async def test_ambiguous_proposal_request_returns_clarification_without_http_tool_choice_failure(self):
        sent = []
        configured_provider = SimpleNamespace(id="global-gemini-instance")
        runtime_provider = SimpleNamespace(
            id="groq-fallback-instance",
            type="groq",
            model="openai/gpt-oss-20b",
        )

        async def send_json(payload):
            sent.append(payload)

        with patch(
            "coding_websocket.complete_coding_model",
            return_value=(
                {"role": "assistant", "content": "Could you specify which file or issue you'd like to address?"},
                runtime_provider,
            ),
        ) as complete:
            await _run_coding_turn(
                {
                    "requestId": "proposal-clarification",
                    "scope": ".",
                    "providerId": "stale-client-provider",
                    "messages": [{"role": "user", "content": "fix ka proposal/diff banao"}],
                },
                send_json,
                {"pending": {}, "completed": {}, "tasks": set()},
                SimpleNamespace(get_active_provider=lambda: configured_provider),
                Path("provider-config.json"),
            )

        done = next(message for message in sent if message.get("type") == "done")
        self.assertEqual(done["content"], "Could you specify which file or issue you'd like to address?")
        self.assertFalse(done["proposalRequired"])
        self.assertEqual(done["providerId"], runtime_provider.id)
        self.assertEqual(done["configuredProviderId"], configured_provider.id)
        self.assertTrue(done["fallback"])
        self.assertIsNone(complete.call_args.args[4], "Client-supplied provider IDs must not override global selection.")
        self.assertFalse(complete.call_args.args[5], "The first turn must not force a tool call.")

    async def test_coding_turn_ignores_stale_client_provider_and_pins_actual_runtime_instance(self):
        sent = []
        active_provider = SimpleNamespace(id="global-gemini-instance")
        runtime_provider = SimpleNamespace(
            id="global-gemini-instance",
            type="gemini",
            model="gemini-3.6-flash",
        )
        responses = iter([
            ({
                "role": "assistant",
                "tool_calls": [{
                    "id": "read-1",
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": json.dumps({"relativePath": "src/example.py"}),
                    },
                }],
            }, runtime_provider),
            ({"role": "assistant", "content": "The inspected file declares the requested function."}, runtime_provider),
        ])

        async def send_json(payload):
            sent.append(payload)

        with patch(
            "coding_websocket.complete_coding_model",
            side_effect=lambda *args, **kwargs: next(responses),
        ) as complete, patch(
            "coding_websocket._wait_for_tool",
            new=AsyncMock(return_value={
                "ok": True,
                "data": {"path": "src/example.py", "content": "def target():\n    return None\n"},
            }),
        ):
            await _run_coding_turn(
                {
                    "requestId": "coding-provider-pin",
                    "scope": ".",
                    "providerId": "stale-groq-instance",
                    "messages": [{"role": "user", "content": "Explain the target function."}],
                },
                send_json,
                {"pending": {}, "completed": {}, "tasks": set()},
                SimpleNamespace(get_active_provider=lambda: active_provider),
                Path("provider-config.json"),
            )

        done = next((message for message in sent if message.get("type") == "done"), None)
        self.assertIsNotNone(done, sent)
        self.assertEqual(complete.call_args_list[0].args[4], None)
        self.assertEqual(complete.call_args_list[1].args[4], runtime_provider.id)
        self.assertEqual(done["providerId"], runtime_provider.id)
        self.assertEqual(done["provider"], "gemini")
        self.assertEqual(done["model"], "gemini-3.6-flash")
        self.assertFalse(done["fallback"])
        self.assertEqual(done["semanticTask"]["status"], "COMPLETED")
        self.assertEqual(done["semanticTask"]["workingMemory"]["previousActions"][0]["tool"], "read_file")
        self.assertTrue(done["semanticTask"]["workingMemory"]["completedInvestigations"])

    async def test_proposal_search_is_followed_by_a_required_source_read(self):
        provider = SimpleNamespace(type="groq", model="test-model")
        diff = (
            "--- a/models/AdmOuPrgList.php\n"
            "+++ b/models/AdmOuPrgList.php\n"
            "@@ -1 +1 @@\n"
            "-return $query->all();\n"
            "+return $query->all();\n"
        )
        responses = iter([
            ({
                "role": "assistant",
                "tool_calls": [{
                    "id": "search-1",
                    "function": {"name": "search_code", "arguments": "{\"query\":\"getProgrammes\"}"},
                }],
            }, provider),
            ({
                "role": "assistant",
                "tool_calls": [{
                    "id": "read-1",
                    "function": {
                        "name": "read_file",
                        "arguments": "{\"relativePath\":\"models/AdmOuPrgList.php\"}",
                    },
                }],
            }, provider),
            ({"role": "assistant", "content": diff}, provider),
        ])
        state = {"pending": {}, "completed": {}, "tasks": set()}
        sent = []

        async def send_json(payload):
            sent.append(payload)
            if payload.get("type") != "tool_call":
                return
            tool_name = payload["name"]
            data = (
                {"results": [{"path": "models/AdmOuPrgList.php"}]}
                if tool_name == "search_code"
                else {"path": "models/AdmOuPrgList.php", "content": "<?php\nreturn $query->all();\n"}
            )
            state["completed"][f"{payload['requestId']}:{payload['toolCallId']}"] = {
                "ok": True,
                "tool": tool_name,
                "data": data,
            }

        with patch("coding_websocket.complete_coding_model", side_effect=lambda *args, **kwargs: next(responses)) as complete:
            await _run_coding_turn(
                {
                    "requestId": "proposal-must-read",
                    "scope": ".",
                    "messages": [{"role": "user", "content": "Fix the duplicate query and prepare a proposal."}],
                },
                send_json,
                state,
                object(),
                Path("provider-config.json"),
            )

        self.assertEqual([call["name"] for call in next(
            event for event in sent if event.get("type") == "done"
        )["toolCalls"]], ["search_code", "read_file"])
        read_attempt = complete.call_args_list[1]
        self.assertEqual([tool["function"]["name"] for tool in read_attempt.args[3]], ["read_file"])
        self.assertTrue(read_attempt.args[5])

    async def test_duplicate_successful_tool_read_uses_cached_evidence_and_finalizes(self):
        provider = SimpleNamespace(type="groq", model="test-model")
        duplicate_read = {
            "role": "assistant",
            "tool_calls": [{
                "id": "read-source",
                "function": {
                    "name": "read_file",
                    "arguments": "{\"relativePath\":\"models/AdmOuPrgList.php\"}",
                },
            }],
        }
        diff = (
            "--- a/models/AdmOuPrgList.php\n"
            "+++ b/models/AdmOuPrgList.php\n"
            "@@ -1 +1 @@\n"
            "-return $query->all();\n"
            "+return $query->all();\n"
        )
        responses = iter([
            (duplicate_read, provider),
            ({**duplicate_read, "tool_calls": [{**duplicate_read["tool_calls"][0], "id": "read-source-again"}]}, provider),
            ({"role": "assistant", "content": diff}, provider),
        ])
        state = {"pending": {}, "completed": {}, "tasks": set()}
        sent = []

        async def send_json(payload):
            sent.append(payload)
            if payload.get("type") == "tool_call":
                state["completed"][f"{payload['requestId']}:{payload['toolCallId']}"] = {
                    "ok": True,
                    "tool": "read_file",
                    "data": {
                        "path": "models/AdmOuPrgList.php",
                        "content": "<?php\nreturn $query->all();\n",
                    },
                }

        with patch(
            "coding_websocket.complete_coding_model",
            side_effect=lambda *args, **kwargs: next(responses),
        ) as complete:
            await _run_coding_turn(
                {
                    "requestId": "proposal-duplicate-read",
                    "scope": "models",
                    "messages": [{
                        "role": "user",
                        "content": "Fix the duplicate query and prepare a proposal.",
                    }],
                },
                send_json,
                state,
                object(),
                Path("provider-config.json"),
            )

        done = next(event for event in sent if event.get("type") == "done")
        self.assertEqual(done["content"], diff.strip())
        self.assertTrue(done["proposalRequired"])
        self.assertEqual(len([event for event in sent if event.get("type") == "tool_call"]), 1)
        self.assertEqual(complete.call_count, 3)
        finalization_messages = complete.call_args_list[-1].args[2]
        self.assertIn("return $query->all()", finalization_messages[1]["content"])

    async def test_follow_up_diff_is_treated_as_an_active_proposal_request(self):
        diff = "--- a/models/AdmOuPrgList.php\n+++ b/models/AdmOuPrgList.php\n@@ -1 +1 @@\n-old\n+new"
        provider = SimpleNamespace(type="groq", model="test-model")
        sent = []

        messages = [
            {"role": "user", "content": "Fix the duplicate query in getProgrammes and prepare a proposal."},
            {"role": "assistant", "content": "I found repeated query work in the method."},
            {"role": "user", "content": diff},
        ]
        responses = iter([
            ({
                "role": "assistant",
                "tool_calls": [{
                    "id": "read-source",
                    "function": {
                        "name": "read_file",
                        "arguments": "{\"relativePath\":\"models/AdmOuPrgList.php\"}",
                    },
                }],
            }, provider),
            ({"role": "assistant", "content": diff}, provider),
        ])

        async def send_json(payload):
            sent.append(payload)
            if payload.get("type") == "tool_call":
                state["completed"][f"{payload['requestId']}:{payload['toolCallId']}"] = {
                    "ok": True,
                    "data": {
                        "path": "models/AdmOuPrgList.php",
                        "content": "<?php\nfunction getProgrammes() { return []; }\n",
                    },
                }

        state = {"pending": {}, "completed": {}, "tasks": set()}
        with patch("coding_websocket.complete_coding_model", side_effect=lambda *args, **kwargs: next(responses)) as complete:
            await _run_coding_turn(
                {"requestId": "proposal-follow-up", "scope": ".", "messages": messages},
                send_json,
                state,
                object(),
                Path("provider-config.json"),
            )

        done = next(message for message in sent if message.get("type") == "done")
        self.assertTrue(done["proposalRequired"])
        self.assertEqual(done["content"], diff)
        prompt = complete.call_args.args[2]
        self.assertIn("active change request", prompt[0]["content"])
        self.assertIn(messages[0]["content"], prompt[1]["content"])
        self.assertIn("do not merely summarize or repeat it", prompt[0]["content"])
        first_call = complete.call_args_list[0]
        self.assertFalse(first_call.kwargs.get("require_tool_call", False), "The initial call must allow tool discovery or a clarification answer.")
        self.assertFalse(
            complete.call_args_list[1].kwargs.get("require_tool_call", False),
            "Once the required source was read, tool calling must be optional again.",
        )

    async def test_proposal_without_file_inspection_fails_instead_of_claiming_no_changes(self):
        sent = []

        async def send_json(payload):
            sent.append(payload)

        with patch(
            "coding_websocket.complete_coding_model",
            return_value=({"role": "assistant", "content": "NO_CHANGES"}, SimpleNamespace(type="groq", model="test-model")),
        ) as complete:
            await _run_coding_turn(
                {
                    "requestId": "proposal-needs-evidence",
                    "scope": ".",
                    "messages": [{"role": "user", "content": "Fix the duplicate query and prepare a proposal."}],
                },
                send_json,
                {"pending": {}, "completed": {}, "tasks": set()},
                object(),
                Path("provider-config.json"),
            )

        error = next(message for message in sent if message.get("type") == "error")
        self.assertIn("could not read any project source file", error["message"])
        self.assertTrue(complete.call_args.args[5])

    async def test_invalid_proposal_format_gets_one_strict_retry_and_redacted_diagnostic(self):
        responses = iter([
            ({
                "role": "assistant",
                "tool_calls": [{
                    "id": "read-1",
                    "function": {
                        "name": "read_file",
                        "arguments": "{\"relativePath\":\"src/academic.js\"}",
                    },
                }],
            }, SimpleNamespace(type="groq", model="test-model")),
            ({"role": "assistant", "content": "I recommend reusing the existing query result."}, SimpleNamespace(type="groq", model="test-model")),
            ({
                "role": "assistant",
                "content": (
                    "--- a/src/academic.js\n+++ b/src/academic.js\n@@ -1 +1 @@\n-old\n+new"
                ),
            }, SimpleNamespace(type="groq", model="test-model")),
        ])
        sent = []

        async def send_json(payload):
            sent.append(payload)
            if payload.get("type") == "tool_call":
                state["completed"][f"{payload['requestId']}:{payload['toolCallId']}"] = {
                    "ok": True,
                    "data": {"path": "src/academic.js", "content": "const items = load();\n"},
                }

        output = io.StringIO()
        state = {"pending": {}, "completed": {}, "tasks": set()}
        with patch("coding_websocket.complete_coding_model", side_effect=lambda *args, **kwargs: next(responses)):
            with contextlib.redirect_stdout(output):
                await _run_coding_turn(
                    {
                        "requestId": "test-request",
                        "scope": ".",
                        "messages": [{"role": "user", "content": "Fix repeated academic queries."}],
                    },
                    send_json,
                    state,
                    object(),
                    Path("provider-config.json"),
                )

        done = next(message for message in sent if message.get("type") == "done")
        self.assertTrue(done["proposalRequired"])
        self.assertTrue(_is_unified_diff_response(done["content"]))
        self.assertEqual(done["content"].splitlines()[0], "--- a/src/academic.js")
        self.assertIn('"validDiffShape": false', output.getvalue())
        self.assertNotIn("I recommend reusing", output.getvalue())


class LegacyNodeMigrationCoverageTests(unittest.TestCase):
    def test_shared_registry_replaces_legacy_gemini_capability_lookup(self):
        self.assertEqual(
            provider_capability_states("gemini", "gemini-3.6-flash")["toolCalling"],
            "SUPPORTED",
        )
        self.assertEqual(
            provider_capability_states("gemini", "gemini-3.6-flash")["toolCalling"],
            "SUPPORTED",
        )
        self.assertNotEqual(
            provider_capability_states("gemini", "gemini-1.0-pro-vision")["toolCalling"],
            "SUPPORTED",
        )
        self.assertEqual(
            provider_capability_states("groq", "openai/gpt-oss-20b")["toolCalling"],
            "SUPPORTED",
        )
        self.assertEqual(
            provider_capability_states("gemini", "gemini-unknown")["toolCalling"],
            "UNKNOWN",
        )

    def test_coding_provider_candidates_follow_global_active_provider_and_fallback_setting(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_path = Path(temporary_directory) / "provider-config.json"
            registry = ProviderRegistry(str(config_path))
            gemini = registry.add_provider(
                "gemini",
                "gemini-3.6-flash",
                "https://generativelanguage.googleapis.com/v1beta",
                "gemini-test-value",
            )
            gemini_second = registry.add_provider(
                "gemini",
                "gemini-3.6-flash",
                "https://generativelanguage.googleapis.com/v1beta",
                "gemini-second-test-value",
                label="Gemini second instance",
                create_new=True,
            )
            groq = registry.add_provider(
                "groq",
                "openai/gpt-oss-20b",
                "https://api.groq.com/openai/v1",
                "groq-test-value",
            )
            disabled = registry.add_provider(
                "openai",
                "gpt-4o-mini",
                "https://api.openai.com/v1",
                "openai-test-value",
            )
            registry.set_provider_enabled(disabled.id, False)
            registry.set_active_provider(gemini_second.id)

            candidates = _candidates(registry)
            self.assertEqual([provider.id for provider in candidates], [gemini_second.id, gemini.id, groq.id])

            registry.fallback_enabled = False
            candidates_without_fallback = _candidates(registry)
            self.assertEqual([provider.id for provider in candidates_without_fallback], [gemini_second.id])

            registry.save_to_file()
            restarted = ProviderRegistry(str(config_path))
            restarted.initialize({}, {})
            self.assertEqual(restarted.active_provider_id, gemini_second.id)
            self.assertEqual([provider.id for provider in _candidates(restarted)], [gemini_second.id])

            restarted.set_active_provider(groq.id)
            self.assertEqual([provider.id for provider in _candidates(restarted)], [groq.id])

    def test_coding_runtime_uses_the_exact_global_provider_instance_credentials_and_model(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            registry = ProviderRegistry(str(Path(temporary_directory) / "provider-config.json"))
            first = registry.add_provider(
                "groq",
                "openai/gpt-oss-20b",
                "https://api.groq.com/openai/v1",
                "first-instance-key",
                label="Groq first",
            )
            selected = registry.add_provider(
                "groq",
                "llama-3.3-70b-versatile",
                "https://api.groq.com/openai/v1",
                "selected-instance-key",
                label="Groq selected",
                create_new=True,
            )
            registry.set_active_provider(selected.id)
            registry.fallback_enabled = False
            client = Mock()
            client.chat.completions.create.return_value.choices = [
                SimpleNamespace(message=SimpleNamespace(model_dump=lambda exclude_none: {
                    "role": "assistant",
                    "content": "Selected instance response.",
                })),
            ]

            with patch("coding_provider.OpenAI", return_value=client) as openai_client:
                message, runtime_provider = complete_coding_model(
                    registry,
                    Path("unused-provider-config.json"),
                    [{"role": "user", "content": "Check the active configured provider."}],
                )

        self.assertEqual(runtime_provider.id, selected.id)
        self.assertNotEqual(runtime_provider.id, first.id)
        self.assertEqual(runtime_provider.model, "llama-3.3-70b-versatile")
        self.assertEqual(message["content"], "Selected instance response.")
        self.assertEqual(openai_client.call_args.kwargs["api_key"], "selected-instance-key")
        self.assertEqual(
            client.chat.completions.create.call_args.kwargs["model"],
            "llama-3.3-70b-versatile",
        )

    def test_coding_runtime_tracks_global_provider_switches_with_provider_specific_adapters(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            registry = ProviderRegistry(str(Path(temporary_directory) / "provider-config.json"))
            groq = registry.add_provider(
                "groq",
                "openai/gpt-oss-20b",
                "https://api.groq.com/openai/v1",
                "groq-instance-key",
            )
            gemini = registry.add_provider(
                "gemini",
                "gemini-3.6-flash",
                "https://generativelanguage.googleapis.com/v1beta",
                "gemini-instance-key",
                create_new=True,
            )
            registry.fallback_enabled = False
            tool = {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a project file.",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
            groq_client = Mock()
            groq_client.chat.completions.create.return_value.choices = [
                SimpleNamespace(message=SimpleNamespace(model_dump=lambda exclude_none: {
                    "role": "assistant",
                    "content": "Groq response.",
                })),
            ]
            gemini_response = Mock()
            gemini_response.json.return_value = {
                "candidates": [{
                    "content": {
                        "parts": [{
                            "functionCall": {
                                "name": "read_file",
                                "args": {"relativePath": "src/example.py"},
                            },
                        }],
                    },
                }],
            }

            registry.set_active_provider(groq.id)
            with patch("coding_provider.OpenAI", return_value=groq_client) as openai_client:
                groq_message, groq_runtime = complete_coding_model(
                    registry,
                    Path("unused-provider-config.json"),
                    [{"role": "user", "content": "Inspect the project."}],
                    [tool],
                )
            registry.set_active_provider(gemini.id)
            with patch("coding_provider.httpx.post", return_value=gemini_response) as gemini_post:
                gemini_message, gemini_runtime = complete_coding_model(
                    registry,
                    Path("unused-provider-config.json"),
                    [{"role": "user", "content": "Inspect the project."}],
                    [tool],
                )

        self.assertEqual(groq_runtime.id, groq.id)
        self.assertEqual(groq_runtime.model, "openai/gpt-oss-20b")
        self.assertEqual(openai_client.call_args.kwargs["api_key"], "groq-instance-key")
        self.assertEqual(groq_client.chat.completions.create.call_args.kwargs["model"], "openai/gpt-oss-20b")
        self.assertEqual(groq_client.chat.completions.create.call_args.kwargs["tools"], [tool])
        self.assertEqual(groq_message["content"], "Groq response.")
        self.assertEqual(gemini_runtime.id, gemini.id)
        self.assertEqual(gemini_runtime.model, "gemini-3.6-flash")
        self.assertEqual(gemini_post.call_args.args[0], "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent")
        self.assertEqual(gemini_post.call_args.kwargs["headers"]["x-goog-api-key"], "gemini-instance-key")
        self.assertEqual(gemini_post.call_args.kwargs["json"]["tools"][0]["functionDeclarations"][0]["name"], "read_file")
        self.assertEqual(len(gemini_message["tool_calls"]), 1)

    def test_coding_provider_rejects_invalid_or_unavailable_global_configuration(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            registry = ProviderRegistry(str(Path(temporary_directory) / "provider-config.json"))
            provider = registry.add_provider(
                "groq",
                "openai/gpt-oss-20b",
                "https://api.groq.com/openai/v1",
                "test-key",
            )
            registry.set_api_key(provider.id, "")
            with patch("coding_provider.resolve_api_key", return_value=""):
                with self.assertRaisesRegex(RuntimeError, "no API key is available"):
                    complete_coding_model(
                        registry,
                        Path("unused-provider-config.json"),
                        [{"role": "user", "content": "Check configuration."}],
                    )

            with self.assertRaisesRegex(RuntimeError, "no longer configured"):
                _candidates(registry, "removed-provider-instance")

            provider.model = "unsupported-model"
            self.assertEqual(_candidates(registry), [])
            with self.assertRaisesRegex(RuntimeError, "No provider is configured"):
                complete_coding_model(
                    registry,
                    Path("unused-provider-config.json"),
                    [{"role": "user", "content": "Check invalid model handling."}],
                )

    def test_coding_gemini_adapter_preserves_request_tool_and_error_contracts(self):
        signature = "opaque-migration-thought-signature"
        provider = SimpleNamespace(
            type="gemini",
            model="gemini-3.6-flash",
            base_url="https://generativelanguage.googleapis.com/v1beta",
        )
        tool = {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a project file.",
                "parameters": {
                    "type": "object",
                    "required": ["relativePath"],
                    "properties": {"relativePath": {"type": "string"}},
                    "additionalProperties": False,
                },
            },
        }
        response = SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {
                "candidates": [{
                    "content": {
                        "role": "model",
                        "parts": [
                            {
                                "functionCall": {
                                    "name": "read_file",
                                    "args": {"relativePath": "package.json"},
                                },
                                "thoughtSignature": signature,
                            },
                            {"text": "I will inspect the project metadata."},
                        ],
                    },
                }],
            },
        )

        with patch("coding_provider.httpx.post", return_value=response) as post:
            assistant_message = _gemini_request(
                provider,
                "test-key",
                [
                    {"role": "system", "content": "Use read-only tools."},
                    {"role": "user", "content": "Read package.json."},
                ],
                [tool],
            )
            first_request = post.call_args.kwargs["json"]

            _gemini_request(
                provider,
                "test-key",
                [
                    {"role": "user", "content": "Read package.json."},
                    assistant_message,
                    {
                        "role": "tool",
                        "tool_call_id": assistant_message["tool_calls"][0]["id"],
                        "name": "read_file",
                        "content": '{"ok":true,"text":"{}"}',
                    },
                ],
                None,
            )

        self.assertEqual(
            post.call_args_list[0].args[0],
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
        )
        self.assertEqual(post.call_args_list[0].kwargs["headers"]["x-goog-api-key"], "test-key")
        self.assertEqual(first_request["systemInstruction"], {"parts": [{"text": "Use read-only tools."}]})
        self.assertEqual(first_request["contents"][0], {
            "role": "user",
            "parts": [{"text": "Read package.json."}],
        })
        self.assertEqual(
            first_request["tools"][0]["functionDeclarations"],
            [{
                "name": "read_file",
                "description": "Read a project file.",
                "parameters": {
                    "type": "object",
                    "required": ["relativePath"],
                    "properties": {"relativePath": {"type": "string"}},
                },
            }],
        )
        self.assertEqual(assistant_message["content"], "I will inspect the project metadata.")
        self.assertEqual(assistant_message["tool_calls"][0]["function"]["name"], "read_file")
        self.assertEqual(assistant_message["tool_calls"][0]["thought_signature"], signature)
        follow_up_parts = [
            part
            for content in post.call_args_list[1].kwargs["json"]["contents"]
            for part in content["parts"]
        ]
        self.assertIn(
            {
                "functionCall": {"name": "read_file", "args": {"relativePath": "package.json"}},
                "thoughtSignature": signature,
            },
            follow_up_parts,
        )
        self.assertIn(
            {"functionResponse": {"name": "read_file", "response": {"ok": True, "text": "{}"}}},
            follow_up_parts,
        )

    def test_current_coding_loop_reads_scoped_evidence_before_answering(self):
        provider = SimpleNamespace(type="gemini", model="gemini-3.6-flash")
        responses = [
            ({
                "role": "assistant",
                "tool_calls": [{
                    "id": "search-1",
                    "type": "function",
                    "function": {"name": "search_code", "arguments": '{"query":"slow SQL query"}'},
                }],
            }, provider),
            ({
                "role": "assistant",
                "tool_calls": [{
                    "id": "read-1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": '{"relativePath":"src/data.py"}'},
                }],
            }, provider),
            ({"role": "assistant", "content": "The query loop in src/data.py is the likely bottleneck."}, provider),
        ]
        payload = {
            "requestId": "migration-contract",
            "scope": "src",
            "messages": [{"role": "user", "content": "Which query is slow?"}],
        }
        state = {"pending": {}, "completed": {}, "tasks": set()}
        events = []
        tool_results = {
            "search-1": {"ok": True, "data": {"results": [{"path": "src/data.py"}]}},
            "read-1": {"ok": True, "data": {"path": "src/data.py", "content": "query = load_records()"}},
        }

        async def send_json(event):
            events.append(event)
            if event.get("type") == "tool_call":
                key = f"{event['requestId']}:{event['toolCallId']}"
                state["completed"][key] = tool_results[event["toolCallId"]]

        with patch(
            "coding_websocket._resolve_semantic_task_with_model",
            new=AsyncMock(return_value={"is_deterministic": False}),
        ), patch("coding_websocket.complete_coding_model", side_effect=responses) as complete:
            asyncio.run(_run_coding_turn(payload, send_json, state, None, Path("unused-config.json")))

        done = next(event for event in events if event.get("type") == "done")
        self.assertEqual(
            [event["name"] for event in events if event.get("type") == "tool_call"],
            ["search_code", "read_file"],
        )
        self.assertEqual(
            [event["phase"] for event in events if event.get("type") == "activity"],
            ["understanding", "understanding", "reading", "context", "context"],
        )
        self.assertEqual(done["content"], "The query loop in src/data.py is the likely bottleneck.")
        self.assertFalse(done["proposalRequired"])
        self.assertEqual(done["plan"]["scope"], "src")
        self.assertEqual(len(done["toolCalls"]), 2)
        self.assertEqual(complete.call_count, 3)

        initial_messages = complete.call_args_list[0].args[2]
        self.assertIn("Never write files", initial_messages[0]["content"])
        self.assertIn("Investigate safe candidate targets and required resources before asking for clarification", initial_messages[0]["content"])
        self.assertIn("trace the existing execution path", initial_messages[0]["content"])
        self.assertIn("explicitly preserve existing behavior outside the requested fix", initial_messages[0]["content"])
        self.assertIn("never claim which query is actually fastest or slowest from source code alone", initial_messages[0]["content"])
        self.assertIn("actual ranking requires database execution plans or profiling", initial_messages[0]["content"])
        self.assertIn("Current optional scope: src", initial_messages[1]["content"])
        initial_plan = next(
            event["plan"]
            for event in events
            if event.get("phase") == "understanding" and "plan" in event
        )
        self.assertTrue(any("callers, callees, and data/state" in step for step in initial_plan["steps"]))
        final_messages = complete.call_args_list[-1].args[2]
        self.assertTrue(any(
            item.get("role") == "tool" and "query = load_records()" in str(item.get("content"))
            for item in final_messages
        ))


class ProviderModelValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "provider-config.json"
        self.registry = ProviderRegistry(str(self.config_path))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_gemini_environment_preset_uses_shared_registry_default(self):
        self.assertEqual(
            PROVIDER_PRESETS["gemini"]["model"],
            PROVIDER_REGISTRY["gemini"]["defaultModel"],
        )
        self.assertEqual(
            PROVIDER_PRESETS["gemini"]["baseURL"],
            PROVIDER_REGISTRY["gemini"]["baseURL"],
        )

    def test_invalid_provider_model_pair_is_rejected_before_registry_mutation(self):
        with self.assertRaisesRegex(ValueError, "not supported by the selected provider"):
            self.registry.add_provider(
                "groq",
                "gemini-1.5-pro",
                "https://api.groq.com/openai/v1",
                "secret",
            )

        self.assertEqual(self.registry.get_all_providers(), [])
        self.assertEqual(
            provider_model_error("groq", "gemini-1.5-pro")["code"],
            "MODEL_NOT_SUPPORTED_BY_PROVIDER",
        )

    def test_valid_registered_and_custom_models_are_accepted(self):
        groq = self.registry.add_provider(
            "groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "secret"
        )
        gemini = self.registry.add_provider(
            "gemini", "gemini-3.6-flash", "https://generativelanguage.googleapis.com/v1beta", "secret"
        )
        custom = self.registry.add_provider("custom", "my-private-model", "https://llm.example/v1", "secret")

        self.assertEqual([groq.type, gemini.type, custom.model], ["groq", "gemini", "my-private-model"])
        self.assertIsNone(provider_model_error("custom", "my-private-model", "https://llm.example/v1"))
        self.assertEqual(provider_model_for_capability("groq", "vision"), "qwen/qwen3.8-27b")
        self.assertIsNone(provider_model_for_capability("deepseek", "vision"))


    def test_image_requests_are_identified_without_treating_text_requests_as_vision(self):
        import index

        self.assertTrue(index.messages_contain_image([{
            "role": "user",
            "content": [
                {"type": "text", "text": "Read this screen."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
            ],
        }]))
        self.assertFalse(index.messages_contain_image([{
            "role": "user",
            "content": "Answer this text question.",
        }]))

    def test_vision_request_uses_registered_vision_model_without_changing_saved_model(self):
        import index

        provider = SimpleNamespace(
            id="groq-provider",
            type="groq",
            model="openai/gpt-oss-20b",
            base_url="https://api.groq.com/openai/v1",
            enabled=True,
        )
        response = SimpleNamespace(choices=[
            SimpleNamespace(message=SimpleNamespace(content="The visible answer.", tool_calls=None)),
        ])
        create_completion = Mock(return_value=response)
        client = SimpleNamespace(chat=SimpleNamespace(
            completions=SimpleNamespace(create=create_completion),
        ))
        with patch.object(index, "provider_candidates", return_value=[provider]), patch.object(
            index, "get_api_key", return_value="test-key"
        ), patch.object(index, "OpenAI", return_value=client), patch.object(
            index, "registry"
        ) as registry:
            message, used_provider = index.complete_model(
                [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Read this screen."},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
                    ],
                }],
                provider_id=provider.id,
                required_capability="vision",
            )
            vision_call = create_completion.call_args
            index.complete_model(
                [{"role": "user", "content": "Answer this text question."}],
                provider_id=provider.id,
            )

        self.assertEqual(vision_call.kwargs["model"], "qwen/qwen3.8-27b")
        self.assertEqual(vision_call.kwargs["temperature"], 0.1)
        self.assertEqual(used_provider.model, "qwen/qwen3.8-27b")
        self.assertEqual(provider.model, "openai/gpt-oss-20b", "Vision routing must not mutate the saved provider model.")
        self.assertEqual(message["content"], "The visible answer.")
        self.assertEqual(registry.update_provider_status.call_count, 2)
        self.assertEqual(create_completion.call_args.kwargs["model"], "openai/gpt-oss-20b")
        self.assertEqual(create_completion.call_args.kwargs["temperature"], 0.3)

    def test_vision_request_fails_clearly_when_provider_has_no_registered_vision_model(self):
        import index

        provider = SimpleNamespace(
            id="text-only-provider",
            type="deepseek",
            model="deepseek-chat",
            base_url="https://api.deepseek.com/v1",
            enabled=True,
        )
        with patch.object(index, "provider_candidates", return_value=[provider]):
            with self.assertRaisesRegex(index.HTTPException, "no registered vision-capable model"):
                index.complete_model(
                    [{
                        "role": "user",
                        "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}],
                    }],
                    provider_id=provider.id,
                    required_capability="vision",
                )

    def test_dummy_registry_entry_drives_backend_validation_capabilities_and_persistence(self):
        import provider_model_contract

        fixture_registry = {
            "dummy-provider": {
                "displayName": "Dummy Provider",
                "baseURL": "https://dummy.example/v1",
                "adapter": "openai-compatible",
                "defaultModel": "dummy-model",
                "models": [{
                    "id": "dummy-model",
                    "displayName": "Dummy Model",
                    "supportsToolCalling": True,
                }],
                "capabilities": {"streaming": "SUPPORTED"},
            },
        }
        with patch.object(provider_model_contract, "PROVIDER_REGISTRY", fixture_registry):
            dummy = self.registry.add_provider(
                "dummy-provider",
                "dummy-model",
                "https://dummy.example/v1",
                "dummy-test-secret",
                create_new=True,
            )
            self.registry.save_to_file()
            self.assertEqual(
                provider_model_contract.provider_capability_states(dummy.type, dummy.model)["streaming"],
                "SUPPORTED",
            )
            restored = ProviderRegistry(str(self.config_path))
            restored.initialize({}, {})
            self.assertEqual(restored.get_provider(dummy.id).model, "dummy-model")
            self.assertIsNotNone(provider_model_error("dummy-provider", "wrong-model", "https://dummy.example/v1"))
        # The patched contract must reject unsupported models for the full lifecycle.
        with patch.object(provider_model_contract, "PROVIDER_REGISTRY", fixture_registry):
            self.assertIsNotNone(provider_model_contract.provider_model_error(
                "dummy-provider", "wrong-model", "https://dummy.example/v1"
            ))
        self.assertIsNotNone(provider_model_error("custom", "my-private-model", "file:///private"))

    def test_legacy_invalid_pair_is_retained_but_excluded_from_runtime(self):
        self.config_path.write_text(json.dumps({
            "providers": [{
                "id": "groq-legacy",
                "type": "groq",
                "model": "gemini-1.5-pro",
                "baseURL": "https://api.groq.com/openai/v1",
                "enabled": True,
                "priority": 1,
                "hasApiKey": True,
                "status": "CONFIGURED",
            }],
            "activeProvider": "groq-legacy",
        }), encoding="utf-8")

        loaded = ProviderRegistry(str(self.config_path))
        loaded.initialize({}, {})
        legacy = loaded.get_provider("groq-legacy")

        self.assertIsNotNone(legacy)
        self.assertEqual(legacy.status, ProviderStatus.CONFIGURATION_INVALID)
        self.assertEqual(legacy.model, "gemini-1.5-pro")
        self.assertEqual(loaded.get_eligible_providers(), [])
        self.assertEqual(loaded.get_api_key("groq-legacy"), "")
        self.assertEqual(legacy.to_dict()["configurationError"]["code"], "MODEL_NOT_SUPPORTED_BY_PROVIDER")

    def test_retired_gemini_models_migrate_to_the_shared_default_on_restart(self):
        default_model = PROVIDER_REGISTRY["gemini"]["defaultModel"]
        for model in ("gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-pro", "gemini-2.5-flash"):
            provider_id = f"gemini-legacy-{model.rsplit('-', 1)[-1]}"
            self.config_path.write_text(json.dumps({
                "providers": [{
                    "id": provider_id,
                    "type": "gemini",
                    "model": model,
                    "baseURL": "https://generativelanguage.googleapis.com/v1beta",
                    "enabled": True,
                    "priority": 1,
                    "hasApiKey": True,
                    "status": "CONFIGURATION_INVALID",
                }],
                "activeProvider": provider_id,
            }), encoding="utf-8")

            loaded = ProviderRegistry(str(self.config_path))
            loaded.initialize({}, {})
            legacy = loaded.get_provider(provider_id)

            self.assertIsNotNone(legacy)
            self.assertEqual(legacy.status, ProviderStatus.CONFIGURED)
            self.assertEqual(legacy.model, default_model)
            self.assertTrue(legacy.has_api_key)
            self.assertEqual([item.id for item in loaded.get_eligible_providers()], [provider_id])
            persisted_provider = json.loads(self.config_path.read_text(encoding="utf-8"))["providers"][0]
            self.assertEqual(persisted_provider["id"], provider_id)
            self.assertEqual(persisted_provider["model"], default_model)
            self.assertNotIn("apiKey", persisted_provider)

    def test_both_provider_save_routes_reject_before_persisting(self):
        import index

        with patch.object(index, "registry", self.registry):
            payload = {
                "provider": "groq",
                "type": "groq",
                "model": "gemini-1.5-pro",
                "baseURL": "https://api.groq.com/openai/v1",
                "apiKey": "secret",
            }
            with self.assertRaises(index.HTTPException) as legacy_error:
                index.legacy_provider_setup(payload)
            with self.assertRaises(index.HTTPException) as plural_error:
                index.add_or_update_provider(payload)

        self.assertEqual(legacy_error.exception.status_code, 400)
        self.assertEqual(plural_error.exception.status_code, 400)
        self.assertEqual(legacy_error.exception.detail["code"], "MODEL_NOT_SUPPORTED_BY_PROVIDER")
        self.assertEqual(plural_error.exception.detail["code"], "MODEL_NOT_SUPPORTED_BY_PROVIDER")
        self.assertEqual(self.registry.get_all_providers(), [])
        self.assertFalse(self.config_path.exists())

    def test_repairing_legacy_pair_preserves_provider_identity_and_runtime_key(self):
        import index

        invalid = index.ProviderRegistry(str(self.config_path))
        provider = ProviderInstance(
            "groq-legacy",
            "groq",
            "gemini-1.5-pro",
            "https://api.groq.com/openai/v1",
            has_api_key=True,
            status=ProviderStatus.CONFIGURATION_INVALID,
        )
        provider.configuration_error = provider_model_error(provider.type, provider.model, provider.base_url)
        invalid.providers[provider.id] = provider
        invalid._runtime_api_keys[provider.id] = "runtime-secret"

        with patch.object(index, "registry", invalid):
            index.update_provider(provider.id, {"model": "openai/gpt-oss-20b"})

        self.assertEqual(provider.id, "groq-legacy")
        self.assertEqual(provider.model, "openai/gpt-oss-20b")
        self.assertIsNone(provider.configuration_error)
        self.assertEqual(invalid.get_api_key(provider.id), "runtime-secret")
        persisted = json.loads(self.config_path.read_text(encoding="utf-8"))
        saved = persisted["providers"][0]
        self.assertEqual(saved["id"], "groq-legacy")
        self.assertEqual(saved["model"], "openai/gpt-oss-20b")
        self.assertNotIn("apiKey", saved)

    def test_saving_repaired_model_clears_stale_configuration_diagnostic(self):
        import index

        invalid = ProviderRegistry(str(self.config_path))
        provider = ProviderInstance(
            "gemini-legacy",
            "gemini",
            "gemini-1.5-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            has_api_key=True,
            status=ProviderStatus.CONFIGURATION_INVALID,
            failure_category="MODEL_NOT_SUPPORTED_BY_PROVIDER",
        )
        provider.configuration_error = provider_model_error(provider.type, provider.model, provider.base_url)
        invalid.providers[provider.id] = provider
        invalid._runtime_api_keys[provider.id] = "synthetic-test-secret"
        invalid.active_provider_id = provider.id

        with patch.object(index, "registry", invalid):
            result = index.add_or_update_provider({
                "providerId": provider.id,
                "adapterType": "gemini",
                "model": "gemini-3.6-flash",
                "baseURL": provider.base_url,
            })

        self.assertEqual(provider.model, "gemini-3.6-flash")
        self.assertEqual(provider.status, ProviderStatus.CONFIGURED)
        self.assertIsNone(provider.configuration_error)
        self.assertIsNone(provider.failure_category)
        self.assertIsNone(provider.failure_diagnostic)
        self.assertTrue(result["provider"]["configurationValid"])
        self.assertNotIn("failureCategory", result["provider"])

    def test_legacy_invalid_pair_allows_unrelated_provider_updates(self):
        import index

        invalid = ProviderRegistry(str(self.config_path))
        provider = ProviderInstance(
            "groq-legacy",
            "groq",
            "gemini-1.5-pro",
            "https://api.groq.com/openai/v1",
            enabled=True,
            has_api_key=True,
            status=ProviderStatus.CONFIGURATION_INVALID,
        )
        provider.configuration_error = provider_model_error(provider.type, provider.model, provider.base_url)
        invalid.providers[provider.id] = provider

        with patch.object(index, "registry", invalid):
            index.update_provider(provider.id, {"enabled": False})

        self.assertFalse(provider.enabled)
        self.assertEqual(provider.model, "gemini-1.5-pro")
        self.assertEqual(provider.status, ProviderStatus.CONFIGURATION_INVALID)
        self.assertIsNotNone(provider.configuration_error)

    def test_invalid_legacy_provider_is_blocked_from_request_candidates(self):
        import index

        invalid = ProviderRegistry(str(self.config_path))
        provider = ProviderInstance(
            "groq-legacy",
            "groq",
            "gemini-1.5-pro",
            "https://api.groq.com/openai/v1",
            has_api_key=True,
            status=ProviderStatus.CONFIGURATION_INVALID,
        )
        invalid.providers[provider.id] = provider

        with patch.object(index, "registry", invalid):
            with self.assertRaises(index.HTTPException) as error:
                index.provider_candidates(provider.id)

        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(error.exception.detail["code"], "MODEL_NOT_SUPPORTED_BY_PROVIDER")


class VisionModelPayloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_multimodal_chat_payload_requests_vision_model(self):
        import index

        provider = SimpleNamespace(type="groq", model="openai/gpt-oss-20b")
        send_messages = []

        async def send_json(message):
            send_messages.append(message)

        with patch.object(index, "call_model", return_value=("Read answer.", provider)) as call_model:
            await index.process_chat_payload({
                "requestId": "screen-read",
                "providerId": "groq-provider",
                "mode": "direct",
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Read this screen."},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
                    ],
                }],
            }, send_json, index.new_connection_state())

        self.assertEqual(call_model.call_args.kwargs["required_capability"], "vision")
        self.assertEqual(send_messages[-1]["type"], "done")
        self.assertEqual(send_messages[-1]["content"], "Read answer.")

    async def test_text_only_chat_keeps_the_current_model(self):
        import index

        provider = SimpleNamespace(type="groq", model="openai/gpt-oss-20b")

        async def send_json(_message):
            return None

        with patch.object(index, "call_model", return_value=("Text answer.", provider)) as call_model:
            await index.process_chat_payload({
                "requestId": "text-chat",
                "providerId": "groq-provider",
                "mode": "direct",
                "messages": [{"role": "user", "content": "Answer this text question."}],
            }, send_json, index.new_connection_state())

        self.assertIsNone(call_model.call_args.kwargs["required_capability"])


class ProviderSecretLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "provider-config.json"
        self.registry = ProviderRegistry(str(self.config_path))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_gemini_save_keeps_runtime_key_and_reports_configured_without_serializing_secret(self):
        import index

        private_test_value = "synthetic-test-secret-do-not-log"
        with patch.object(index, "registry", self.registry):
            result = index.add_or_update_provider({
                "adapterType": "gemini",
                "model": "gemini-3.6-flash",
                "baseURL": "https://generativelanguage.googleapis.com/v1beta",
                "apiKey": private_test_value,
            })
            provider_id = result["provider"]["id"]
            self.assertTrue(index.get_api_key(provider_id) == private_test_value)

        self.assertEqual(result["provider"]["status"], ProviderStatus.CONFIGURED.value)
        self.assertTrue(result["provider"]["hasApiKey"])
        self.assertFalse(private_test_value in json.dumps(result))
        self.assertFalse(private_test_value in self.config_path.read_text(encoding="utf-8"))

    def test_existing_provider_edit_post_saves_api_key_immediately_without_persisting_secret(self):
        import index

        private_test_value = "synthetic-existing-provider-edit-secret"
        provider = self.registry.add_provider(
            "gemini",
            "gemini-3.6-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            "",
            create_new=True,
        )
        self.registry.save_to_file()

        with patch.object(index, "registry", self.registry):
            result = index.add_or_update_provider({
                "providerId": provider.id,
                "adapterType": "gemini",
                "model": "gemini-3.6-flash",
                "baseURL": provider.base_url,
                "apiKey": private_test_value,
            })

            self.assertTrue(index.provider_response_data(provider)["hasApiKey"])
            self.assertEqual(index.get_api_key(provider.id), private_test_value)

        self.assertTrue(result["provider"]["hasApiKey"])
        self.assertEqual(result["provider"]["status"], ProviderStatus.CONFIGURED.value)
        self.assertFalse(private_test_value in json.dumps(result))
        persisted = self.config_path.read_text(encoding="utf-8")
        self.assertFalse(private_test_value in persisted)
        self.assertTrue(json.loads(persisted)["providers"][0]["hasApiKey"])

    def test_groq_and_gemini_use_the_same_runtime_secret_resolution_path(self):
        import index

        with patch.object(index, "registry", self.registry):
            groq = self.registry.add_provider(
                "groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "groq-test-value"
            )
            gemini = self.registry.add_provider(
                "gemini", "gemini-3.6-flash", "https://generativelanguage.googleapis.com/v1beta", "gemini-test-value"
            )

            self.assertTrue(index.get_api_key(groq.id) == "groq-test-value")
            self.assertTrue(index.get_api_key(gemini.id) == "gemini-test-value")
            self.assertTrue(index.provider_response_data(gemini)["hasApiKey"])

    def test_backend_restart_requires_renderer_secret_rehydration(self):
        import index

        original_key = "gemini-restart-test-key"
        provider = self.registry.add_provider(
            "gemini",
            "gemini-3.6-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            original_key,
        )
        self.registry.save_to_file()

        restarted = ProviderRegistry(str(self.config_path))
        restarted.initialize({}, {})
        loaded = restarted.get_provider(provider.id)
        self.assertTrue(loaded.has_api_key)
        self.assertEqual(restarted.get_api_key(provider.id), "")
        self.assertNotIn(original_key, self.config_path.read_text(encoding="utf-8"))

        with patch.object(index, "registry", restarted):
            restored = index.update_provider(provider.id, {"apiKey": original_key})
            self.assertTrue(index.provider_response_data(loaded)["hasApiKey"])

        self.assertEqual(restored["provider"]["id"], provider.id)
        self.assertTrue(restored["provider"]["hasApiKey"])

    def test_retired_model_secret_rehydration_preserves_identity_after_model_migration(self):
        import index

        self.config_path.write_text(json.dumps({
            "providers": [{
                "id": "gemini-retired",
                "type": "gemini",
                "model": "gemini-2.0-pro",
                "baseURL": "https://generativelanguage.googleapis.com/v1beta",
                "enabled": True,
                "priority": 1,
                "hasApiKey": True,
                "status": "CONFIGURATION_INVALID",
            }],
            "activeProvider": "gemini-retired",
        }), encoding="utf-8")
        restarted = ProviderRegistry(str(self.config_path))
        restarted.initialize({}, {})
        provider = restarted.get_provider("gemini-retired")

        with patch.object(index, "registry", restarted):
            restored = index.update_provider(provider.id, {"apiKey": "rehydrated-test-secret"})
            restored_has_api_key = index.provider_response_data(provider)["hasApiKey"]

        self.assertTrue(restored_has_api_key)
        self.assertEqual(restarted.get_api_key(provider.id), "rehydrated-test-secret")
        self.assertEqual(provider.model, PROVIDER_REGISTRY["gemini"]["defaultModel"])
        self.assertEqual(provider.status, ProviderStatus.CONFIGURED)
        self.assertIsNone(provider.configuration_error)
        self.assertEqual(restored["provider"]["id"], provider.id)
        self.assertTrue(restored["provider"]["hasApiKey"])
        self.assertNotIn("rehydrated-test-secret", self.config_path.read_text(encoding="utf-8"))

    def test_multiple_instances_of_one_adapter_keep_identity_and_credentials_across_restart(self):
        import index

        first = self.registry.add_provider(
            "gemini",
            "gemini-3.6-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            "first-instance-secret",
            label="Gemini primary",
            create_new=True,
        )
        second = self.registry.add_provider(
            "gemini",
            "gemini-3.6-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            "second-instance-secret",
            label="Gemini backup",
            create_new=True,
        )
        self.assertNotEqual(first.id, second.id)
        self.registry.save_to_file()

        restarted = ProviderRegistry(str(self.config_path))
        restarted.initialize({}, {})
        self.assertEqual([item.id for item in restarted.get_all_providers()], [first.id, second.id])
        self.assertEqual(restarted.get_api_key(first.id), "")
        self.assertEqual(restarted.get_api_key(second.id), "")

        with patch.object(index, "registry", restarted):
            for provider, secret in ((first, "first-instance-secret"), (second, "second-instance-secret")):
                result = index.add_or_update_provider({
                    "providerId": provider.id,
                    "adapterType": "gemini",
                    "model": provider.model,
                    "baseURL": provider.base_url,
                    "apiKey": secret,
                    "label": provider.label,
                })
                self.assertEqual(result["provider"]["id"], provider.id)
            self.assertEqual(index.get_api_key(first.id), "first-instance-secret")
            self.assertEqual(index.get_api_key(second.id), "second-instance-secret")
            self.assertEqual(len(restarted.get_all_providers()), 2)

    def test_provider_save_api_creates_distinct_instances_when_requested(self):
        import index

        with patch.object(index, "registry", self.registry):
            first = index.add_or_update_provider({
                "adapterType": "gemini",
                "model": "gemini-3.6-flash",
                "baseURL": "https://generativelanguage.googleapis.com/v1beta",
                "apiKey": "first-instance-secret",
                "createNew": True,
            })
            second = index.add_or_update_provider({
                "adapterType": "gemini",
                "model": "gemini-3.6-flash",
                "baseURL": "https://generativelanguage.googleapis.com/v1beta",
                "apiKey": "second-instance-secret",
                "createNew": True,
            })

        self.assertNotEqual(first["provider"]["id"], second["provider"]["id"])
        self.assertEqual(len(second["providers"]), 2)
        self.assertNotIn("first-instance-secret", json.dumps(second))
        self.assertNotIn("second-instance-secret", json.dumps(second))


class ProviderActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "provider-config.json"
        self.registry = ProviderRegistry(str(self.config_path))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_non_groq_provider_can_be_first_and_becomes_active_without_groq(self):
        gemini = self.registry.add_provider(
            "gemini",
            "gemini-3.6-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-test-value",
        )

        self.assertEqual(self.registry.get_active_provider().id, gemini.id)
        self.assertEqual(self.registry.get_eligible_providers(), [gemini])

    def test_deleting_groq_activates_highest_priority_remaining_provider(self):
        import index

        groq = self.registry.add_provider(
            "groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "groq-test-value"
        )
        gemini = self.registry.add_provider(
            "gemini",
            "gemini-3.6-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-test-value",
        )
        groq.priority = 1
        gemini.priority = 2
        self.registry.active_provider_id = groq.id

        with patch.object(index, "registry", self.registry):
            result = index.delete_provider(groq.id)
            candidates = index.provider_candidates()

        self.assertEqual(self.registry.get_active_provider().id, gemini.id)
        self.assertEqual(self.registry.active_provider_id, gemini.id)
        self.assertEqual(result["activeProvider"], gemini.id)
        self.assertEqual([provider.id for provider in candidates], [gemini.id])

    def test_priority_reorder_changes_active_provider_independent_of_insertion_order(self):
        groq = self.registry.add_provider(
            "groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "groq-test-value"
        )
        gemini = self.registry.add_provider(
            "gemini",
            "gemini-3.6-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-test-value",
        )

        self.assertTrue(self.registry.reorder_providers([gemini.id, groq.id]))

        self.assertEqual(self.registry.get_active_provider().id, gemini.id)
        self.assertEqual(
            [provider.id for provider in self.registry.get_eligible_providers()],
            [gemini.id, groq.id],
        )

    def test_disabling_active_provider_selects_next_priority_eligible_provider(self):
        groq = self.registry.add_provider(
            "groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "groq-test-value"
        )
        gemini = self.registry.add_provider(
            "gemini",
            "gemini-3.6-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-test-value",
        )
        self.registry.reorder_providers([groq.id, gemini.id])

        self.registry.set_provider_enabled(groq.id, False)

        self.assertEqual(self.registry.get_active_provider().id, gemini.id)

    def test_active_selection_and_priority_reorder_require_valid_complete_instances(self):
        first = self.registry.add_provider(
            "groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "groq-test-value",
            create_new=True,
        )
        second = self.registry.add_provider(
            "groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "groq-backup-value",
            create_new=True,
        )

        self.assertFalse(self.registry.reorder_providers([first.id, first.id]))
        self.assertFalse(self.registry.reorder_providers([first.id]))
        self.assertTrue(self.registry.reorder_providers([second.id, first.id]))
        self.assertEqual([item.priority for item in self.registry.get_all_providers()], [1, 2])
        self.assertFalse(self.registry.set_active_provider("missing-provider"))
        self.registry.set_provider_enabled(second.id, False)
        self.assertFalse(self.registry.set_active_provider(second.id))
        self.assertTrue(self.registry.set_active_provider(first.id))
        self.assertTrue(self.registry.delete_provider(second.id))
        self.assertEqual(first.priority, 1)

    def test_active_provider_api_rejects_disabled_provider(self):
        import index

        provider = self.registry.add_provider(
            "gemini",
            "gemini-3.6-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-test-value",
        )
        with patch.object(index, "registry", self.registry):
            selected = index.set_active_provider({"providerId": provider.id})
            self.assertEqual(selected["activeProvider"], provider.id)
            self.registry.set_provider_enabled(provider.id, False)
            with self.assertRaises(index.HTTPException) as error:
                index.set_active_provider({"providerId": provider.id})
        self.assertEqual(error.exception.status_code, 400)


class ProviderDiagnosticCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "provider-config.json"
        self.registry = ProviderRegistry(str(self.config_path))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_gemini_model_catalog_uses_key_header_and_returns_only_generation_models(self):
        import index

        provider = self.registry.add_provider(
            "gemini",
            "gemini-3.6-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-model-catalog-test-key",
        )
        response = SimpleNamespace(
            status_code=200,
            json=lambda: {
                "models": [
                    {
                        "name": "models/gemini-3.6-flash",
                        "supportedGenerationMethods": ["generateContent", "countTokens"],
                    },
                    {
                        "name": "models/gemini-embedding",
                        "supportedGenerationMethods": ["embedContent"],
                    },
                    {"name": "gemini-invalid-name", "supportedGenerationMethods": ["generateContent"]},
                ],
            },
        )

        with patch.object(index, "registry", self.registry), patch.object(index.httpx, "get", return_value=response) as get:
            result = index.list_provider_models(provider.id)

        self.assertEqual(result["models"], [{
            "id": "gemini-3.6-flash",
            "supportedGenerationMethods": ["generateContent", "countTokens"],
        }])
        self.assertEqual(get.call_args.args[0], f"{provider.base_url}/models")
        self.assertEqual(get.call_args.kwargs["headers"], {"x-goog-api-key": "gemini-model-catalog-test-key"})
        self.assertEqual(get.call_args.kwargs["params"], {"pageSize": 100})
        self.assertNotIn("gemini-model-catalog-test-key", json.dumps(result))

    def test_gemini_model_catalog_redacts_upstream_errors(self):
        import index

        provider = self.registry.add_provider(
            "gemini",
            "gemini-3.6-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-model-catalog-test-key",
        )
        response = SimpleNamespace(
            status_code=403,
            text='{"error":{"message":"Key gemini-model-catalog-test-key is invalid"}}',
        )
        with patch.object(index, "registry", self.registry), patch.object(index.httpx, "get", return_value=response):
            with self.assertRaises(index.HTTPException) as error:
                index.list_provider_models(provider.id)

        self.assertEqual(error.exception.status_code, 403)
        self.assertNotIn("gemini-model-catalog-test-key", str(error.exception.detail))
        self.assertEqual(error.exception.detail["code"], "INVALID_OR_MISSING_KEY")

    def test_gemini_model_not_found_is_not_classified_as_rate_limited(self):
        import index

        error = index.ProviderRequestError(
            "gemini",
            404,
            '{"error":{"message":"models/gemini-1.5-flash is not found for API version v1beta or is not supported for generateContent."}}',
        )

        self.assertEqual(index.provider_status_for_error(error), ProviderStatus.MODEL_UNAVAILABLE)
        self.assertEqual(
            index.classify_provider_error(404, error.response_body)["category"],
            "MODEL_UNAVAILABLE",
        )

    def test_quota_exhaustion_is_reported_separately_from_temporary_rate_limits(self):
        import index

        quota_error = index.ProviderRequestError(
            "gemini",
            429,
            '{"error":{"message":"You exceeded your current quota; check plan and billing."}}',
        )
        rate_limit_error = index.ProviderRequestError(
            "gemini",
            429,
            '{"error":{"message":"Too many requests; retry after the current window."}}',
        )

        self.assertEqual(index.provider_failure_classification(quota_error), "QUOTA_EXCEEDED")
        self.assertEqual(index.provider_failure_classification(rate_limit_error), "RATE_LIMIT")

    def test_gemini_tool_schema_removes_unsupported_keywords_recursively(self):
        import index

        schema = {
            "type": "object",
            "additionalProperties": False,
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "properties": {
                "entries": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "name": {"type": "string", "$schema": "ignored"},
                        },
                    },
                },
            },
        }

        converted = index._gemini_tools([{
            "type": "function",
            "function": {"name": "inspect", "parameters": schema},
        }])

        self.assertEqual(converted[0]["parameters"], {
            "type": "object",
            "properties": {
                "entries": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"name": {"type": "string"}},
                    },
                },
            },
        })

    def test_gemini_tool_call_round_trip_preserves_thought_signature(self):
        import index

        signature = "opaque-gemini-thought-signature"
        normalized = index._normalize_gemini_response({
            "candidates": [{
                "content": {
                    "parts": [{
                        "functionCall": {"name": "inspect", "args": {"path": "."}},
                        "thoughtSignature": signature,
                    }],
                },
            }],
        })

        _system, contents = index._gemini_contents([normalized])

        self.assertEqual(
            contents[0]["parts"][0]["thoughtSignature"],
            signature,
        )

    def test_coding_gemini_tool_call_round_trip_preserves_thought_signature(self):
        signature = "opaque-coding-gemini-thought-signature"
        provider = SimpleNamespace(base_url="https://generativelanguage.example/v1beta", model="gemini-3.6-flash")
        response = SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {
                "candidates": [{
                    "content": {
                        "parts": [{
                            "functionCall": {"name": "navigate", "args": {"url": "https://example.com"}},
                            "thoughtSignature": signature,
                        }],
                    },
                }],
            },
        )

        tool_schema = {
            "type": "object",
            "additionalProperties": False,
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "properties": {
                "url": {"type": "string", "additionalProperties": False},
            },
        }
        tools = [{"function": {"name": "navigate", "parameters": tool_schema}}]
        with patch("coding_provider.httpx.post", return_value=response) as post:
            assistant_message = _gemini_request(
                provider,
                "test-key",
                [{"role": "user", "content": "Open the example site."}],
                tools,
            )
            self.assertEqual(
                post.call_args.kwargs["json"]["tools"][0]["functionDeclarations"][0]["parameters"],
                {"type": "object", "properties": {"url": {"type": "string"}}},
            )
            self.assertEqual(
                assistant_message["tool_calls"][0]["thought_signature"],
                signature,
            )

            _gemini_request(
                provider,
                "test-key",
                [
                    {"role": "user", "content": "Open the example site."},
                    assistant_message,
                    {
                        "role": "tool",
                        "tool_call_id": assistant_message["tool_calls"][0]["id"],
                        "name": "navigate",
                        "content": '{"opened": true}',
                    },
                ],
                None,
            )

        follow_up_contents = post.call_args.kwargs["json"]["contents"]
        model_parts = [
            part
            for content in follow_up_contents
            if content["role"] == "model"
            for part in content["parts"]
        ]
        function_part = next(part for part in model_parts if "functionCall" in part)
        self.assertEqual(function_part["thoughtSignature"], signature)
        self.assertEqual(
            function_part["functionCall"],
            {"name": "navigate", "args": {"url": "https://example.com"}},
        )

    def test_shared_classifier_covers_provider_neutral_http_categories(self):
        from provider_service import classify_provider_error

        cases = [
            (401, "invalid API key", "INVALID_OR_MISSING_KEY"),
            (429, "rate limit exceeded", "QUOTA_EXCEEDED"),
            (400, "invalid model name", "INVALID_MODEL_OR_REQUEST_FORMAT"),
            (402, "billing payment required", "BILLING_REQUIRED"),
            (500, "internal server failure", "PROVIDER_SERVICE_UNAVAILABLE"),
            (None, "socket timeout", "PROVIDER_SERVICE_UNAVAILABLE"),
            (400, "unclassified provider detail", "UNKNOWN"),
        ]
        for status, raw_message, expected in cases:
            with self.subTest(status=status, raw_message=raw_message):
                self.assertEqual(classify_provider_error(status, raw_message)["category"], expected)

    def test_error_redaction_preserves_multikilobyte_messages_and_marks_oversize(self):
        from provider_service import PROVIDER_ERROR_MAX_CHARS, redact_provider_error

        message = "Invalid JSON payload: " + ("field detail " * 180)
        self.assertGreater(len(message), 2000)
        self.assertEqual(redact_provider_error(message), message)

        oversized = "x" * (PROVIDER_ERROR_MAX_CHARS + 20)
        safe = redact_provider_error(oversized)
        self.assertTrue(safe.startswith("x" * PROVIDER_ERROR_MAX_CHARS))
        self.assertIn("[Diagnostic truncated after 10000 characters.]", safe)

    def test_gemini_http_error_keeps_exact_self_test_body_and_redacts_key(self):
        import index

        api_key = "AIza" + ("A" * 35)
        error_body = json.dumps({
            "error": {
                "code": 400,
                "message": "Invalid JSON payload received. " + ("Unknown name at contents.parts. " * 60),
                "keyEcho": api_key,
            },
        })
        captured_call = {}

        class FakeResponse:
            status_code = 400
            text = error_body

        class FakeClient:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def post(self, url, **kwargs):
                captured_call["url"] = url
                captured_call.update(kwargs)
                return FakeResponse()

        request_body = {"contents": [{"role": "user", "parts": [{"text": "self-test"}]}]}
        with patch.object(index.httpx, "Client", return_value=FakeClient()):
            with self.assertRaises(index.ProviderRequestError) as raised:
                index._post_provider_json(
                    "gemini",
                    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
                    {"x-goog-api-key": api_key, "content-type": "application/json"},
                    request_body,
                    capture_request=True,
                )

        error = raised.exception
        self.assertEqual(error.status_code, 400)
        self.assertEqual(error.response_body, error_body.replace(api_key, "[REDACTED]"))
        self.assertGreater(len(error.response_body), 500)
        self.assertNotIn(api_key, str(error))
        self.assertEqual(captured_call["content"], error.request_capture["body"].encode("utf-8"))
        self.assertNotIn("json", captured_call)
        self.assertEqual(json.loads(error.request_capture["body"]), request_body)
        self.assertEqual(error.request_capture["url"], captured_call["url"])

    def test_self_test_persists_full_redacted_error_and_captured_request(self):
        import index

        with tempfile.TemporaryDirectory() as temp_dir:
            registry = ProviderRegistry(str(Path(temp_dir) / "provider-config.json"))
            provider = registry.add_provider(
                "gemini",
                "gemini-3.6-flash",
                "https://generativelanguage.googleapis.com/v1beta",
                "synthetic-secret",
            )
            response_body = '{"error":{"code":400,"message":"' + ("Detailed field error. " * 70) + '"}}'
            request_capture = {
                "method": "POST",
                "url": "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
                "body": '{"contents":[{"role":"user","parts":[{"text":"self-test"}]}]}',
            }
            with patch.object(index, "registry", registry), patch.object(
                index,
                "complete_model",
                side_effect=index.ProviderRequestError(
                    "gemini",
                    400,
                    response_body,
                    request_capture,
                    ("synthetic-secret",),
                ),
            ):
                result = index.self_test({"provider_id": provider.id})

            self.assertEqual(result["failureDetails"]["rawMessage"], response_body)
            self.assertEqual(result["failureDetails"]["requestCapture"], request_capture)
            self.assertGreater(len(result["error"]), 500)
            self.assertNotIn("synthetic-secret", json.dumps(result))
            saved_provider = registry.get_provider(provider.id).to_dict()
            self.assertEqual(saved_provider["failureDetails"]["requestCapture"], request_capture)

    def test_self_test_classifies_wrapped_provider_error_from_upstream_status(self):
        import index

        with tempfile.TemporaryDirectory() as temp_dir:
            registry = ProviderRegistry(str(Path(temp_dir) / "provider-config.json"))
            provider = registry.add_provider(
                "gemini",
                "gemini-3.6-flash",
                "https://generativelanguage.googleapis.com/v1beta",
                "synthetic-secret",
            )
            response_body = json.dumps({
                "error": {
                    "code": 400,
                    "message": "Invalid JSON payload received. Unknown name 'additionalProperties'.",
                },
            })
            upstream_error = index.ProviderRequestError(
                "gemini",
                400,
                response_body,
                {"method": "POST", "url": "https://example.invalid", "body": "{}"},
                ("synthetic-secret",),
            )

            def raise_wrapped_error(*_args, **_kwargs):
                raise index.HTTPException(
                    status_code=502,
                    detail=f"Provider error: {upstream_error}",
                ) from upstream_error

            with patch.object(index, "registry", registry), patch.object(
                index,
                "complete_model",
                side_effect=raise_wrapped_error,
            ):
                result = index.self_test({"provider_id": provider.id})

            self.assertEqual(result["failureCategory"], "INVALID_MODEL_OR_REQUEST_FORMAT")
            self.assertEqual(result["failureDetails"]["statusCode"], 400)
            self.assertEqual(result["failureDetails"]["rawMessage"], response_body)
            self.assertNotIn("synthetic-secret", json.dumps(result))


class SpeechProviderSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = Path(self.temp_dir.name) / "provider-config.json"
        self.registry = ProviderRegistry(str(self.config_path))
        self.groq = self.registry.add_provider(
            "groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1", "groq-test-value"
        )
        self.openai = self.registry.add_provider(
            "openai", "gpt-4o-mini", "https://api.openai.com/v1", "openai-test-value"
        )
        self.gemini = self.registry.add_provider(
            "gemini", "gemini-3.6-flash", "https://generativelanguage.googleapis.com/v1beta", "gemini-test-value"
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_automatic_selection_uses_first_key_configured_speech_provider_by_priority(self):
        import index

        self.registry.reorder_providers([self.openai.id, self.groq.id, self.gemini.id])
        with patch.object(index, "registry", self.registry):
            self.assertEqual(index.get_stt_provider().id, self.openai.id)

    def test_explicit_selection_accepts_gemini_and_existing_speech_providers(self):
        import index

        with patch.object(index, "registry", self.registry):
            gemini_selection = index.update_stt_provider({"providerId": self.gemini.id})
            selected = index.update_stt_provider({"providerId": self.openai.id})

        self.assertEqual(gemini_selection["sttProvider"], self.gemini.id)
        self.assertEqual(gemini_selection["effectiveSttProvider"], self.gemini.id)
        self.assertEqual(selected["sttProvider"], self.openai.id)
        self.assertEqual(selected["effectiveSttProvider"], self.openai.id)

    def test_deleting_selected_speech_provider_clears_selection_and_uses_eligible_alternative(self):
        import index

        self.registry.stt_provider_id = self.groq.id
        with patch.object(index, "registry", self.registry):
            result = index.delete_provider(self.groq.id)

        self.assertIsNone(result["sttProvider"])
        self.assertEqual(result["effectiveSttProvider"], self.openai.id)
        self.assertIsNone(self.registry.stt_provider_id)

    def test_automatic_selection_reports_unavailable_when_no_speech_provider_remains(self):
        import index

        self.registry.delete_provider(self.groq.id)
        self.registry.delete_provider(self.openai.id)
        self.registry.delete_provider(self.gemini.id)
        with patch.object(index, "registry", self.registry):
            self.assertIsNone(index.get_stt_provider())

    def test_automatic_speech_selection_uses_gemini_when_no_openai_compatible_provider_exists(self):
        import index

        self.registry.delete_provider(self.groq.id)
        self.registry.delete_provider(self.openai.id)
        with patch.object(index, "registry", self.registry):
            self.assertEqual(index.get_stt_provider().id, self.gemini.id)


class DatabaseEvidenceIntegrityTests(unittest.TestCase):
    def test_unregistered_live_label_cannot_upgrade_database_evidence(self):
        DatabaseEvidenceStore.clear()
        self.assertFalse(_has_verified_live_database_evidence(
            {"evidenceQuality": "VERIFIED_LIVE", "evidenceId": "invented-proof"},
            {"evidenceQuality": "VERIFIED_LIVE"},
        ))

        proof = DatabaseExecutionProof(
            database_session_id="session-1",
            engine="sqlite",
            operation="DATABASE_QUERY",
            source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
            mode="LIVE",
            execution_status="SUCCESS",
            query="SELECT name FROM sqlite_master",
        )
        DatabaseEvidenceStore.record_proof(proof)
        self.assertTrue(_has_verified_live_database_evidence(
            {"evidenceId": proof.evidence_id},
        ))
        DatabaseEvidenceStore.clear()

    def test_unknown_engine_does_not_probe_sqlite_files_as_live_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            database_file = Path(directory) / "project.db"
            connection = sqlite3.connect(database_file)
            connection.execute("CREATE TABLE local_data (id INTEGER PRIMARY KEY)")
            connection.close()

            result = DatabaseIntelligenceEngine.list_tables(directory, {})

        self.assertEqual(result["status"], "UNAVAILABLE")
        self.assertEqual(result["engine"], "unknown")
        self.assertEqual(result["tables"], [])
        self.assertFalse(result["executed"])
        self.assertNotEqual(result["evidenceQuality"], "VERIFIED_LIVE")

    def test_inspection_request_requires_evidence_and_notification_reuse_gate(self):
        request = (
            "Inspect current implementation, find existing reusable patterns and DB constraints, "
            "compare the safest options, and recommend the minimal change. Do not modify anything."
        )
        self.assertTrue(_requires_investigation_evidence_gate(request))
        task_state = {
            "investigationEvidenceGate": {"databaseSchemaRequired": True},
            "actions": [
                {
                    "tool": "read_file",
                    "target": "src/notifications.ts",
                    "status": "SUCCESS",
                    "resultEvidenceIds": ["read-current"],
                    "lastResult": {
                        "ok": True,
                        "data": {
                            "path": "src/notifications.ts",
                            "content": "export function notify() { return reuseNotification(); }",
                        },
                    },
                },
                {
                    "tool": "search_code",
                    "target": "notification reusable patterns",
                    "status": "SUCCESS",
                    "resultEvidenceIds": ["search-reuse"],
                    "lastResult": {
                        "ok": True,
                        "data": {
                            "results": [{
                                "path": "src/notification-service.ts",
                                "text": "export function reuseNotification() {}",
                            }],
                        },
                    },
                },
                {
                    "tool": "search_code",
                    "target": "existing similar notification implementations",
                    "status": "SUCCESS",
                    "resultEvidenceIds": ["search-similar"],
                    "lastResult": {
                        "ok": True,
                        "data": {
                            "results": [
                                {"path": "src/alert-notifications.ts", "text": "notifyUser();"},
                                {"path": "src/email-notifications.ts", "text": "notifyUser();"},
                            ],
                        },
                    },
                },
                {
                    "tool": "inspect_database_schema",
                    "target": "active database",
                    "status": "SUCCESS",
                    "resultEvidenceIds": ["schema-unavailable"],
                    "lastResult": {
                        "ok": True,
                        "status": "UNAVAILABLE",
                        "executionStatus": "UNAVAILABLE",
                        "executed": False,
                    },
                },
            ],
        }
        answer = (
            "Option A reuses the pattern in notification-service.ts; Option B keeps a local implementation. "
            "The minimal change is in notifications.ts."
        )

        gate = _investigation_evidence_gate(task_state, answer)

        self.assertEqual(
            {key: value["status"] for key, value in gate["statuses"].items()},
            {
                "CURRENT_IMPLEMENTATION": "VERIFIED",
                "PROJECT_REUSABLE_PATTERNS": "VERIFIED",
                "EXISTING_SIMILAR_IMPLEMENTATIONS": "VERIFIED",
                "DB_SCHEMA_CONSTRAINTS": "UNAVAILABLE",
                "OPTIONS_COMPARISON": "VERIFIED",
                "MINIMAL_CHANGE_IMPACT": "VERIFIED",
            },
        )
        self.assertNotIn("unique constraint", answer.lower())
        single_read_gate = _investigation_evidence_gate({
            "investigationEvidenceGate": {"databaseSchemaRequired": True},
            "actions": task_state["actions"][:1],
        }, "Option A or Option B is best.")
        self.assertEqual(single_read_gate["statuses"]["CURRENT_IMPLEMENTATION"]["status"], "VERIFIED")
        self.assertEqual(single_read_gate["statuses"]["PROJECT_REUSABLE_PATTERNS"]["status"], "NOT_VERIFIED")
        self.assertEqual(single_read_gate["statuses"]["EXISTING_SIMILAR_IMPLEMENTATIONS"]["status"], "NOT_VERIFIED")
        self.assertEqual(single_read_gate["statuses"]["DB_SCHEMA_CONSTRAINTS"]["status"], "NOT_VERIFIED")
        self.assertEqual(single_read_gate["statuses"]["OPTIONS_COMPARISON"]["status"], "NOT_VERIFIED")

    def test_benchmark_without_live_measurement_returns_unavailable_without_claims(self):
        session = DatabaseSession(
            project_id="evidence-test",
            repository_id="evidence-test",
            database_type="sqlite",
            database_name="unverified",
            project_root="",
        )

        result = DatabaseSessionManager.execute_database_capability(
            DatabaseCapability.DATABASE_BENCHMARK,
            {},
            session,
            "",
        )

        self.assertEqual(result["executionStatus"], "UNAVAILABLE")
        self.assertEqual(result["evidenceQuality"], "UNVERIFIED")
        self.assertFalse(result["executed"])
        for field in (
            "baselineLatencyMs",
            "optimizedLatencyMs",
            "speedup",
            "rowsExamined",
            "accessType",
            "indexUsed",
        ):
            self.assertIsNone(result[field], field)
        self.assertNotIn("orders", result["content"].lower())
        self.assertNotIn("index", result["content"].lower())

    def test_bootstrap_health_check_does_not_claim_execution_or_timing(self):
        result = DatabaseIntelligenceEngine.bootstrap_safe_health_check({"engine": "sqlite"})

        self.assertEqual(result["healthQuery"], "SELECT 1")
        self.assertEqual(result["status"], "NOT_VERIFIED")
        self.assertIsNone(result["timing_ms"])

    def test_live_sqlite_health_check_reports_measured_success(self):
        with tempfile.TemporaryDirectory() as directory:
            database_file = Path(directory) / "health.sqlite"
            connection = sqlite3.connect(database_file)
            connection.execute("SELECT 1")
            connection.close()

            with patch(
                "coding_intelligence.time.perf_counter",
                side_effect=[12.0, 12.025],
            ):
                result = DatabaseIntelligenceEngine.real_connect_and_health_check(
                    directory,
                    {"engine": "sqlite", "sqlite_file": str(database_file)},
                )

        self.assertTrue(result["connected"])
        self.assertEqual(result["healthCheck"], "HEALTHY")
        self.assertEqual(result["healthQuery"], "SELECT 1")
        self.assertEqual(result["timing_ms"], 25.0)
        self.assertIsNotNone(result["health_proof"])

    def test_diagnostic_availability_requires_a_registered_runtime_tool(self):
        unavailable = DatabaseIntelligenceEngine.check_database_capabilities(
            "",
            available_tools=[],
        )
        unknown = DatabaseIntelligenceEngine.check_database_capabilities("")
        available = DatabaseIntelligenceEngine.check_database_capabilities(
            "",
            available_tools=["run_verification"],
        )

        path = "safe_database_diagnostic_endpoint"
        self.assertFalse(unavailable["paths_status"][path])
        self.assertFalse(unknown["paths_status"][path])
        self.assertTrue(available["paths_status"][path])

    def test_missing_runtime_query_statistics_remain_unavailable(self):
        session = DatabaseSession(
            project_id="evidence-test",
            repository_id="evidence-test",
            database_type="mysql",
            database_name="runtime-stats",
        )
        response = {
            "ok": True,
            "rows": [{
                "query_digest": "SELECT id FROM records",
                "executions": None,
                "total_time_ms": None,
                "average_time_ms": None,
                "max_time_ms": None,
                "rows_examined": None,
                "rows_sent": None,
            }],
        }

        with patch.object(DatabaseIntelligenceEngine, "execute_safe_query", return_value=response):
            rows = DatabasePerformanceEngine._mysql_runtime_query_stats(
                "",
                session,
                "slow",
            )

        self.assertEqual(len(rows), 1)
        for field in (
            "executionCount",
            "totalTimeMs",
            "averageTimeMs",
            "maxTimeMs",
            "rowsExamined",
            "rowsReturned",
        ):
            self.assertIsNone(rows[0][field], field)


class CodingRequestAuthenticationTests(unittest.TestCase):
    def test_coding_http_requires_launch_token_and_trusted_origin(self):
        import index
        from fastapi.testclient import TestClient

        trusted_origin = next(
            origin
            for origin in index.TRUSTED_RENDERER_ORIGINS
            if origin != "null"
        )
        with TestClient(index.app) as client:
            missing_token = client.get(
                "/api/coding/project-state",
                headers={"Origin": trusted_origin},
            )
            untrusted_origin = client.get(
                "/api/coding/project-state",
                headers={
                    "Origin": "https://untrusted.example",
                    "X-Coding-Auth": index.CODING_AUTH_TOKEN,
                },
            )
            authenticated = client.get(
                "/api/coding/project-state",
                headers={
                    "Origin": trusted_origin,
                    "X-Coding-Auth": index.CODING_AUTH_TOKEN,
                },
            )
            preflight = client.options(
                "/api/coding/project-state",
                headers={
                    "Origin": trusted_origin,
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "x-coding-auth",
                },
            )

        self.assertEqual(missing_token.status_code, 401)
        self.assertEqual(untrusted_origin.status_code, 401)
        self.assertEqual(authenticated.status_code, 200)
        self.assertEqual(preflight.status_code, 200)


class CodingWebSocketAuthenticationTests(unittest.IsolatedAsyncioTestCase):
    async def test_websocket_requires_trusted_origin_and_launch_token(self):
        import websockets
        from websockets.exceptions import ConnectionClosed

        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        origin = "http://localhost:3000"
        server = asyncio.create_task(
            run_coding_websocket_server(
                port,
                registry=None,
                config_path="",
                auth_token="test-launch-token",
                trusted_origins=[origin],
            )
        )
        uri = f"ws://127.0.0.1:{port}"
        try:
            async with websockets.connect(uri, origin=origin) as readiness_probe:
                await readiness_probe.close()

            with self.assertRaises(Exception):
                await websockets.connect(uri, origin="https://untrusted.example")

            async with websockets.connect(uri, origin=origin) as unauthenticated:
                await unauthenticated.send(json.dumps({"type": "chat", "requestId": "unauth"}))
                with self.assertRaises(ConnectionClosed):
                    await unauthenticated.recv()

            async with websockets.connect(uri, origin=origin) as authenticated:
                await authenticated.send(
                    json.dumps({"type": "authenticate", "token": "test-launch-token"})
                )
                acknowledgement = json.loads(await authenticated.recv())
                self.assertEqual(acknowledgement, {"type": "authenticated", "authenticated": True})
        finally:
            server.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await server


if __name__ == "__main__":
    unittest.main(verbosity=2)
