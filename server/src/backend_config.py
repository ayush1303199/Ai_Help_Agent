import os
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.getenv("PORT", "3001"))
WS_PORT = int(os.getenv("WS_PORT", "3002"))
MAX_PDF_MB = int(os.getenv("MAX_PDF_MB", "10"))
MAX_TOKENS = int(os.getenv("AI_MAX_TOKENS", "384"))
PROVIDER_RETRY_ATTEMPTS = 1
PROVIDER_RETRY_MAX_SECONDS = 4.0
MAX_MODEL_INPUT_CHARS = int(os.getenv("AI_MAX_INPUT_CHARS", "14000"))
MAX_MODEL_MESSAGE_CHARS = int(os.getenv("AI_MAX_MESSAGE_CHARS", "1800"))
MAX_MODEL_SYSTEM_CHARS = int(os.getenv("AI_MAX_SYSTEM_CHARS", "13000"))
GENERAL_CONTEXT_CHAR_BUDGET = int(os.getenv("AI_GENERAL_CONTEXT_CHARS", "18000"))
GENERAL_CONTEXT_MESSAGE_CHARS = int(os.getenv("AI_GENERAL_MESSAGE_CHARS", "2200"))
CONFIG_PATH = Path(os.getenv("AI_PROVIDER_CONFIG_PATH", Path.home() / ".ai-help-agent" / "provider-config.json"))
STT_TRANSCRIPTION_PROMPT = os.getenv(
    "TRANSCRIPTION_PROMPT",
    (
        "Transcribe only the words spoken in the audio. Do not paraphrase, complete, "
        "or convert a request into a self-answer. Preserve clearly spoken technical "
        "product names exactly. Technical vocabulary: Spring Boot, Spring Security, "
        "dependency injection, Hibernate, JPA, Java, JavaScript, TypeScript, React, "
        "React.js, Node.js, Python, FastAPI, OpenAI, Copilot, Groq, API, REST API, "
        "Microservices, SQL, PostgreSQL, MySQL, Docker, Kubernetes, AWS, Azure, GitHub. "
        "If a word is uncertain, return the audible wording instead of inventing a correction."
    ),
)
