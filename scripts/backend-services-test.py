import asyncio
import contextlib
import io
import json
import sys
import tempfile
import unittest
import httpx
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from starlette.datastructures import UploadFile


SERVER_SRC = Path(__file__).resolve().parents[1] / "server" / "src"
sys.path.insert(0, str(SERVER_SRC))

from agent_control_service import AgentControlService  # noqa: E402
from coding_provider import CODING_MAX_COMPLETION_TOKENS, _candidates, _gemini_request, _normalize  # noqa: E402
from coding_websocket import (  # noqa: E402
    MAX_CODING_CONVERSATION_CHARS,
    MAX_CODING_FINAL_EVIDENCE_CHARS,
    MAX_CODING_TOOL_ROUNDS,
    _coding_finalization_messages,
    _compact_coding_conversation,
    _is_unified_diff_response,
    _proposal_prompt_instruction,
    _proposal_response_shape,
    _requires_proposal,
    _serialize_coding_tool_result,
    _validate_tool_call,
    _run_coding_turn,
)
from stt_service import SttService  # noqa: E402
from provider_registry import ProviderInstance, ProviderRegistry, ProviderStatus  # noqa: E402
from provider_model_contract import provider_capability_states, provider_model_error  # noqa: E402


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


class CodingConversationBudgetTests(unittest.TestCase):
    def test_tool_results_are_bounded(self):
        serialized = _serialize_coding_tool_result({"content": "x" * 12000})

        self.assertLessEqual(len(serialized), 6000)

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
        name, arguments = _validate_tool_call({
            "function": {
                "name": "repo_browser.read_file",
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


class CodingProposalRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_proposal_format_gets_one_strict_retry_and_redacted_diagnostic(self):
        responses = iter([
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

        output = io.StringIO()
        with patch("coding_websocket.complete_coding_model", side_effect=lambda *args, **kwargs: next(responses)):
            with contextlib.redirect_stdout(output):
                await _run_coding_turn(
                    {
                        "requestId": "test-request",
                        "scope": ".",
                        "messages": [{"role": "user", "content": "Fix repeated academic queries."}],
                    },
                    send_json,
                    {"pending": {}, "completed": {}, "tasks": set()},
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
            provider_capability_states("gemini", "gemini-2.0-flash")["toolCalling"],
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

    def test_coding_provider_candidates_follow_registry_priority_and_configuration(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            registry = ProviderRegistry(str(Path(temporary_directory) / "provider-config.json"))
            gemini = registry.add_provider(
                "gemini",
                "gemini-3.6-flash",
                "https://generativelanguage.googleapis.com/v1beta",
                "gemini-test-value",
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
            registry.reorder_providers([groq.id, gemini.id, disabled.id])

            candidates = _candidates(registry)

        self.assertEqual([provider.id for provider in candidates], [groq.id, gemini.id])
        self.assertEqual(candidates[0].id, registry.active_provider_id)

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

        with patch("coding_websocket.complete_coding_model", side_effect=responses) as complete:
            asyncio.run(_run_coding_turn(payload, send_json, state, None, Path("unused-config.json")))

        done = next(event for event in events if event.get("type") == "done")
        self.assertEqual(
            [event["name"] for event in events if event.get("type") == "tool_call"],
            ["search_code", "read_file"],
        )
        self.assertEqual(
            [event["phase"] for event in events if event.get("type") == "activity"],
            ["understanding", "reading", "context", "context"],
        )
        self.assertEqual(done["content"], "The query loop in src/data.py is the likely bottleneck.")
        self.assertFalse(done["proposalRequired"])
        self.assertEqual(done["plan"]["scope"], "src")
        self.assertEqual(len(done["toolCalls"]), 2)
        self.assertEqual(complete.call_count, 3)

        initial_messages = complete.call_args_list[0].args[2]
        self.assertIn("Never write files", initial_messages[0]["content"])
        self.assertIn("When multiple plausible targets remain", initial_messages[0]["content"])
        self.assertIn("Current optional scope: src", initial_messages[1]["content"])
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

    def test_retired_gemini_models_are_retained_but_excluded_from_runtime(self):
        for model in ("gemini-1.5-pro", "gemini-1.5-flash"):
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
                    "status": "CONFIGURED",
                }],
                "activeProvider": provider_id,
            }), encoding="utf-8")

            loaded = ProviderRegistry(str(self.config_path))
            loaded.initialize({}, {})
            legacy = loaded.get_provider(provider_id)

            self.assertIsNotNone(legacy)
            self.assertEqual(legacy.status, ProviderStatus.CONFIGURATION_INVALID)
            self.assertEqual(legacy.model, model)
            self.assertEqual(loaded.get_eligible_providers(), [])
            self.assertEqual(
                legacy.to_dict()["configurationError"]["code"],
                "MODEL_NOT_SUPPORTED_BY_PROVIDER",
            )

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

    def test_retired_model_secret_rehydration_preserves_invalid_state_and_identity(self):
        import index

        invalid = ProviderRegistry(str(self.config_path))
        provider = ProviderInstance(
            "gemini-retired",
            "gemini",
            "gemini-1.5-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            enabled=True,
            has_api_key=True,
            status=ProviderStatus.CONFIGURATION_INVALID,
        )
        provider.configuration_error = provider_model_error(provider.type, provider.model, provider.base_url)
        invalid.providers[provider.id] = provider

        with patch.object(index, "registry", invalid):
            restored = index.update_provider(provider.id, {"apiKey": "rehydrated-test-secret"})
            restored_has_api_key = index.provider_response_data(provider)["hasApiKey"]

        self.assertTrue(restored_has_api_key)
        self.assertEqual(invalid.get_api_key(provider.id), "rehydrated-test-secret")
        self.assertEqual(provider.model, "gemini-1.5-flash")
        self.assertEqual(provider.status, ProviderStatus.CONFIGURATION_INVALID)
        self.assertIsNotNone(provider.configuration_error)
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
            "gemini-2.5-flash",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-model-catalog-test-key",
        )
        response = SimpleNamespace(
            status_code=200,
            json=lambda: {
                "models": [
                    {
                        "name": "models/gemini-2.5-flash",
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
            "id": "gemini-2.5-flash",
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
            "gemini-2.5-flash",
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
