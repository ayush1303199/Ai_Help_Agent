import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SERVER_SRC = Path(__file__).resolve().parents[1] / "server" / "src"
sys.path.insert(0, str(SERVER_SRC))

from agent_control_service import AgentControlService  # noqa: E402
from stt_service import SttService  # noqa: E402


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
            get_api_key=lambda _provider_id: "",
            transcription_prompt="prompt",
            max_upload_mb=1,
            retry_attempts=0,
            retry_delay=lambda _error, _attempt: 0,
            retryable=lambda _error: False,
        )

    def test_classifies_provider_failures_without_exposing_details(self):
        self.assertEqual(self.service.classify_error(Exception("401 unauthorized")), "STT_AUTH_ERROR")
        self.assertEqual(self.service.classify_error(Exception("429 rate limit")), "STT_RATE_LIMIT")
        self.assertEqual(self.service.classify_error(Exception("unsupported codec")), "STT_UNSUPPORTED_AUDIO")
        self.assertEqual(self.service.classify_error(TimeoutError("timed out")), "STT_TIMEOUT")

    def test_classifies_unknown_failures_safely(self):
        self.assertEqual(self.service.classify_error(RuntimeError("unexpected provider detail")), "STT_UNKNOWN")


if __name__ == "__main__":
    unittest.main(verbosity=2)
