import os
import json
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
_bundle_root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
_settings_path = Path(os.getenv("AI_RUNTIME_SETTINGS_PATH", _bundle_root / "runtimeSettings.json"))
if not _settings_path.exists():
    _settings_path = Path(__file__).resolve().parents[2] / "src" / "config" / "runtimeSettings.json"
try:
    RUNTIME_SETTINGS = json.loads(_settings_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise RuntimeError(f"Application runtime settings could not be loaded from {_settings_path}.") from error

SERVICES = RUNTIME_SETTINGS["services"]
CLIENT_SETTINGS = RUNTIME_SETTINGS["client"]
BACKEND_SETTINGS = RUNTIME_SETTINGS["backend"]
DEVELOPER_SETTINGS = RUNTIME_SETTINGS["developer"]
ELECTRON_SETTINGS = RUNTIME_SETTINGS["electron"]


def _setting(environment_name: str, value: int | float) -> int | float:
    configured = os.getenv(environment_name)
    return type(value)(configured) if configured is not None else value


PORT = int(_setting("PORT", SERVICES["http"]["port"]))
WS_PORT = int(_setting("WS_PORT", SERVICES["websocket"]["port"]))
CODING_WS_PORT = int(_setting("CODING_WS_PORT", SERVICES["codingWebsocket"]["port"]))
MAX_PDF_MB = int(_setting("MAX_PDF_MB", BACKEND_SETTINGS["maxPdfMb"]))
MAX_TOKENS = int(_setting("AI_MAX_TOKENS", BACKEND_SETTINGS["maxCompletionTokens"]))
PROVIDER_RETRY_ATTEMPTS = int(BACKEND_SETTINGS["providerRetryAttempts"])
PROVIDER_RETRY_MAX_SECONDS = float(BACKEND_SETTINGS["providerRetryMaxSeconds"])
MAX_MODEL_INPUT_CHARS = int(_setting("AI_MAX_INPUT_CHARS", BACKEND_SETTINGS["maxModelInputChars"]))
MAX_MODEL_MESSAGE_CHARS = int(_setting("AI_MAX_MESSAGE_CHARS", BACKEND_SETTINGS["maxModelMessageChars"]))
MAX_MODEL_SYSTEM_CHARS = int(_setting("AI_MAX_SYSTEM_CHARS", BACKEND_SETTINGS["maxModelSystemChars"]))
GENERAL_CONTEXT_CHAR_BUDGET = int(_setting("AI_GENERAL_CONTEXT_CHARS", BACKEND_SETTINGS["generalContextCharBudget"]))
GENERAL_CONTEXT_MESSAGE_CHARS = int(_setting("AI_GENERAL_MESSAGE_CHARS", BACKEND_SETTINGS["generalContextMessageChars"]))
GENERAL_FORCED_CONTEXT_MESSAGE_CHARS = int(BACKEND_SETTINGS["generalForcedContextMessageChars"])
GENERAL_MINIMUM_MESSAGE_BUDGET_CHARS = int(BACKEND_SETTINGS["generalMinimumMessageBudgetChars"])
GENERAL_RETRY_DELAY_SECONDS = float(BACKEND_SETTINGS["generalRetryDelaySeconds"])
MODEL_REQUEST_TIMEOUT_SECONDS = float(BACKEND_SETTINGS["modelRequestTimeoutSeconds"])
MODEL_CATALOG_TIMEOUT_SECONDS = float(BACKEND_SETTINGS["modelCatalogTimeoutSeconds"])
STT_REQUEST_TIMEOUT_SECONDS = float(BACKEND_SETTINGS["sttRequestTimeoutSeconds"])
CODING_COMPLETION_TOKENS = int(BACKEND_SETTINGS["codingCompletionTokens"])
CODING_TOOL_ROUNDS = int(BACKEND_SETTINGS["codingToolRounds"])
CODING_CONVERSATION_CHARS = int(BACKEND_SETTINGS["codingConversationChars"])
CODING_TOOL_RESULT_CHARS = int(BACKEND_SETTINGS["codingToolResultChars"])
CODING_FINAL_EVIDENCE_CHARS = int(BACKEND_SETTINGS["codingFinalEvidenceChars"])
CODING_TOOL_WAIT_TIMEOUT_SECONDS = float(BACKEND_SETTINGS["codingToolWaitTimeoutSeconds"])
CODING_MAX_HISTORY_MESSAGES = int(BACKEND_SETTINGS["codingMaxHistoryMessages"])
CODING_MAX_PATH_CHARS = int(BACKEND_SETTINGS["codingMaxPathChars"])
CODING_MAX_REQUEST_CHARS = int(BACKEND_SETTINGS["codingMaxRequestChars"])
PROVIDER_ERROR_MAX_CHARS = int(BACKEND_SETTINGS["providerErrorMaxChars"])
AGENT_ACTIVITY_MAX_ENTRIES = int(BACKEND_SETTINGS["agentActivityMaxEntries"])
TRANSCRIPTION_PROMPT = os.getenv("TRANSCRIPTION_PROMPT", BACKEND_SETTINGS["transcriptionPrompt"])
CONFIG_PATH = Path(os.getenv("AI_PROVIDER_CONFIG_PATH", Path.home() / ".ai-help-agent" / "provider-config.json"))
STT_TRANSCRIPTION_PROMPT = TRANSCRIPTION_PROMPT
MEETING_TRANSCRIPTION_PROMPT = BACKEND_SETTINGS["meetingTranscriptionPrompt"]
