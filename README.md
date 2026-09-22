# Meeting AI Assistant

Meeting AI Assistant is a desktop interview and meeting assistant built with
Electron, React, TypeScript, Vite, and a local Python AI service. It can listen
to spoken questions, meeting playback, or both, transcribe complete utterances,
and send grounded questions to a configured AI provider.

The application also supports resume and job-description context, reusable
candidate profiles, interview domain/background configuration, an always-on-top
answer overlay, document Q&A, developer workflows, and General Agent
capabilities.

## Features

- **Direct and LangChain modes** for AI chat requests.
- **Voice-to-text interview flow** with silence detection, transcript cleanup,
  continuation handling, duplicate suppression, and question detection.
- **Three audio capture modes**:
  - Microphone (external microphone or headset).
  - System / Internal Audio (meeting, browser, speaker, or playback audio).
  - Microphone + System / Internal Audio.
- **Windows system-audio loopback** through Electron display capture.
- **Microphone device selection** with persisted device choice and safe fallback
  when a device is disconnected.
- **Resume, job-description, PDF, upload, and trained-profile context**.
- **Canonical interview configuration**:
  - Domain selection, including Software Engineer, Cloud Architect/Engineer,
    AI/ML Engineer, Custom Prompt, and Planning & Scheduling Engineer.
  - Searchable technical Background selection, including All Technologies,
    Swift (iOS), Kotlin (Android), and Dart/Flutter.
- **Candidate-grounded interview answers** that prioritize supplied evidence and
  avoid unsupported claims.
- **Always-on-top overlay** with:
  - AI search input.
  - Answer, Analysis, Summary, and Action Items tabs.
  - Opacity controls from 20% to 100%.
  - Visibility, minimize, auto-hide, bounds, and always-on-top preferences.
- **Runtime provider registry** with provider ordering, enable/disable controls,
  self-tests, and bounded fallback/retry behavior.
- **Developer Agent and General Agent** workflows with guarded desktop/browser
  actions and confirmation gates.

## Application Modes

The top-level mode selector keeps assistant, developer, and General Agent state
separate:

| Mode | Purpose |
| --- | --- |
| **Assistant** | Ask questions by text or voice, use interview context, stream answers, and send results to the overlay. |
| **Developer** | Inspect a user-selected project, search code, understand repository structure, run approved verification scripts, and create guarded change proposals. |
| **General Agent** | Research or prepare bounded browser/computer tasks through a capability registry, login handoff, confirmation, and verification lifecycle. |

Assistant mode has two request paths:

- **Direct** sends a grounded request through the local provider boundary.
- **LangChain** uses the LangChain-compatible request path when that mode is
  selected in the UI.

Developer mode is deliberately scoped to the selected project root. Its
read/search tools include directory listing, file reading, code search, symbol
search, repository mapping, reference lookup, and bounded context assembly.
Verification commands are selected from the project's declared scripts and are
run with output limits and environment redaction. Change proposals use content
snapshots so a proposal cannot silently overwrite a file that changed after it
was reviewed.

General Agent tasks use explicit phases such as planning, researching,
preparing, waiting for login, waiting for confirmation, executing, verifying,
recovering, completed, blocked, failed, and cancelled. Read-only research can
continue without an external-action confirmation. External communication,
financial actions, account changes, destructive actions, form submission,
orders, bookings, and payments require a user-controlled handoff or explicit
confirmation.

## Architecture

```text
Electron main process
  ├─ secure overlay window and IPC
  ├─ Windows system-audio loopback handler
  └─ launches/coordinates the desktop UI

React + Vite renderer
  ├─ interview and chat UI
  ├─ microphone/system-audio capture
  ├─ MediaRecorder segmentation
  ├─ STT request pipeline
  ├─ context and profile management
  └─ answer overlay

Python FastAPI service
  ├─ HTTP API on http://localhost:3001
  ├─ WebSocket chat service on ws://localhost:3002
  ├─ PDF extraction
  ├─ audio transcription
  ├─ provider registry and self-tests
  └─ Direct/General/Developer request handling
```

## Request and Audio Flow

Text requests follow this path:

```text
text input or overlay search
  -> request preparation and duplicate protection
  -> resume/JD/profile/document context resolution
  -> interview system prompt construction
  -> WebSocket request to the Python service
  -> provider selection, retry, fallback, and bounded compaction
  -> streamed answer and final response
  -> main chat and overlay Answer/Analysis/Summary/Action Items
```

Voice requests use the same final request path:

```text
microphone/system audio
  -> MediaRecorder segment
  -> silence/end-of-utterance detection
  -> POST /api/transcribe-audio
  -> transcript cleanup and technical-term normalization
  -> continuation joining and question detection
  -> complete question sent to the assistant
```

Partial speech, repeated noise, and transcripts that are not a complete
question are not sent as AI questions. A failed provider request is surfaced as
an error; the UI does not claim that an answer or agent task completed when it
did not.

## Requirements

- Node.js 18 or newer.
- npm.
- Python 3.10 or newer.
- A configured AI provider API key. Groq is the default provider.
- Electron is required for system/internal audio capture.
- Windows 10/11 is recommended for built-in system loopback capture.

Python 3.14 currently emits an OpenAI/Pydantic compatibility warning during
startup. The warning does not prevent the service from running, but Python 3.10
through 3.13 may provide a quieter environment.

## Installation

Clone the repository and install the frontend/Electron dependencies:

```bash
npm install
```

Install the Python service dependencies:

```bash
python -m pip install -r server/requirements.txt
```

Create `server/.env` from the variables below. Do not commit this file:

```env
LLM_PROVIDER=groq
GROQ_API_KEY=your_groq_api_key

PORT=3001
WS_PORT=3002
MAX_PDF_MB=10
AI_MAX_TOKENS=384
```

The Python service uses the configured provider preset model by default. The
model, base URL, priority, enable/disable state, fallback behavior, and API key
can be managed from **Configuration** (AI provider settings). A custom OpenAI-compatible
provider can be added there without changing source code.
Runtime provider configuration is persisted outside the repository, normally
under:

```text
~/.ai-help-agent/provider-config.json
```

API keys are not included in frontend local storage or provider-list responses.

### Provider presets

The Python provider registry includes presets for:

- Groq
- OpenAI
- Gemini
- Anthropic
- Cohere
- DeepSeek
- OpenRouter
- Mistral
- xAI
- Perplexity

Provider instances can be enabled or disabled, reordered by priority, self
tested, and used as bounded fallbacks for transient provider failures. The
active provider and non-secret provider metadata survive backend restarts in
the user configuration file.

Backend provider metadata is maintained in `server/src/provider_presets.py`,
while renderer provider choices are maintained in `src/config/providerPresets.ts`.
Runtime credentials remain outside source control.

### Architecture map

- `src/config/` — renderer runtime URLs, limits, and provider catalog.
- `src/ai/interviewContext.ts` — domain/background catalogs, persisted context,
  microphone device normalization/selection, and canonical interview context
  construction.
- `src/ai/interviewSystemPrompt.ts` — the canonical interview policy and
  prompt builder used by Direct and voice requests.
- `src/audio/` — transcript normalization and question preparation.
- `src/audio/sttService.ts` — the existing STT HTTP request boundary and
  response/error contract.
- `src/documents/documentService.ts` — shared PDF validation, extraction
  requests, and pasted Job Description normalization for Resume and Job
  Description inputs.
- `src/context/` — Resume, Job Description, profile, and document context
  resolution.
- `src/ui/` — answer, context, provider, confirmation, and overlay-facing UI.
- `server/src/provider_presets.py` — backend provider catalog.
- `server/src/provider_registry.py` — provider discovery, selection, health,
  and fallback state.
- `server/src/index.py` — HTTP/WebSocket boundary and request orchestration.
- `electron/` — native window, display/overlay, IPC, and desktop capture
  boundary.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `groq` | Default provider type. |
| `<PROVIDER>_API_KEY` | unset | API key for a configured provider, for example `GROQ_API_KEY` or `OPENAI_API_KEY`. |
| `PORT` | `3001` | FastAPI HTTP port. |
| `WS_PORT` | `3002` | Chat WebSocket port. |
| `MAX_PDF_MB` | `10` | Maximum accepted PDF size in megabytes. |
| `AI_MAX_TOKENS` | `384` | Maximum provider response tokens. |
| `AI_MAX_INPUT_CHARS` | `14000` | Maximum compacted model input size. |
| `AI_MAX_MESSAGE_CHARS` | `1800` | Maximum individual message size. |
| `AI_MAX_SYSTEM_CHARS` | `13000` | Maximum system-prompt size. |
| `AI_GENERAL_CONTEXT_CHARS` | `18000` | General Agent context budget. |
| `AI_GENERAL_MESSAGE_CHARS` | `2200` | General Agent message budget. |
| `AI_PROVIDER_CONFIG_PATH` | `~/.ai-help-agent/provider-config.json` | Override the provider metadata path. |
| `TRANSCRIPTION_MODEL` | provider default | Override the speech-to-text model. |
| `TRANSCRIPTION_LANGUAGE` | provider default | Optional transcription language hint. |
| `TRANSCRIPTION_PROMPT` | technical vocabulary prompt | Improve recognition of technical terms. |
| `AI_AUTO_FALLBACK` | enabled | Set to `false` to disable provider fallback. |

The renderer also accepts Vite environment overrides, so development, staging,
and packaged launches do not need API URLs or client limits hardcoded in
`App.tsx`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | `http://localhost:3001` | HTTP API base URL. |
| `VITE_WS_URL` | `ws://localhost:3002` | Chat WebSocket URL. |
| `VITE_MAX_CHAT_HISTORY_MESSAGES` | `4` | Number of recent chat messages retained per request. |
| `VITE_MAX_CHAT_MESSAGE_CHARS` | `900` | Maximum client-side chat message length. |
| `VITE_MAX_CONTEXT_CHARS` | `6000` | Client-side context budget. |
| `VITE_MAX_PDF_SIZE_BYTES` | `20971520` | Maximum client-side PDF size. |
| `VITE_PDF_CONTEXT_BUDGET_RATIO` | `0.65` | Fraction of context budget available to extracted PDF text. |
| `VITE_PDF_UPLOAD_TIMEOUT_MS` | `20000` | PDF upload timeout. |
| `VITE_SYSTEM_AUDIO_SILENCE_MS` | `2000` | Silence after speech before an utterance is submitted to STT and the AI assistant. |
| `VITE_SYSTEM_AUDIO_LEVEL_THRESHOLD` | `2` | System-audio level threshold. |

## Running the Application

### Full Electron development mode

Use this for the complete application, including microphone and internal
system-audio capture:

```bash
npm run dev
```

The launcher starts:

- Python HTTP API: `http://localhost:3001`
- Python WebSocket service: `ws://localhost:3002`
- Vite renderer: `http://localhost:5174`
- Electron desktop application

The launcher performs a preflight check and refuses to stop unrelated
processes that already own the required ports.

The equivalent explicit command is:

```bash
npm run electron:dev
```

To run only the startup checks:

```bash
npm run preflight
```

### Start the Electron shell manually

If the backend and Vite renderer are already running:

```bash
npm run electron:start
```

### Renderer-only development

```bash
npm run web:dev
```

This starts a browser-only Vite session. It is useful for UI work, but it does
not provide Electron's Windows system-audio loopback handler. Use
`npm run dev` to test internal audio.

### Start the Python service directly

```bash
npm run server:dev
```

The service can also be started with Uvicorn:

```bash
cd server
python -m uvicorn src.index:app --host 0.0.0.0 --port 3001
```

The Uvicorn command exposes the HTTP application only. Use
`npm run server:dev` or `npm run dev` when the WebSocket chat service on port
3002 is also required.

### Preview a production build

```bash
npm run build
npm run preview
```

## Audio Capture

Open **Meetings** and choose an audio source:

1. **Microphone** — captures the selected microphone from
   **Context → Audio → Microphone**.
2. **System / Internal Audio** — captures computer playback through Electron's
   display-media loopback.
3. **Microphone + System / Internal Audio** — mixes both sources into one
   recording stream.

For system audio:

- Run the Electron desktop app, not only the browser renderer.
- Make sure the meeting, browser, or other playback source is producing sound.
- Use **Test Audio** before **Start Listening**.
- In the capture permission flow, allow audio sharing.
- On Windows, the app uses the selected display/window playback source and
  records the loopback audio track; the video track is discarded.

On macOS or Linux, system-audio capture depends on the platform and an
available virtual audio route. A tool such as BlackHole or a comparable
loopback device may be required. The application does not install or configure
third-party audio drivers.

If a requested system-audio source cannot be opened, the app reports the
failure instead of silently claiming that system audio is connected.

## Interview Context

The **Context** panel provides:

- Domain.
- Searchable Background technology chips.
- Microphone selector.
- Resume PDF upload.
- Job Description PDF upload or pasted text.
- Session uploads.
- Reusable trained profiles.

The selected Domain and Background are inserted into the interview system
prompt as focus signals. Resume, job-description, profile, and uploaded
documents remain evidence sources. Background selections do not prove that a
candidate has experience with a technology; answers must rely on supplied
candidate evidence.

Context configuration is persisted locally under the versioned key
`interview-context-v1`. Saved legacy domain names are migrated to their current
canonical labels.

The configuration shape is:

```ts
{
  domain: string | null;
  background: string[];
  microphoneDeviceId: string | null;
}
```

Microphone IDs are used only to restore the local input-device selection. They
are not included in the interview prompt, provider diagnostics, or AI request
metadata.

## Overlay

Use the **Overlay** control to open the answer window. The overlay is an
always-on-top Electron window and can be configured with:

- Opacity increase/decrease controls.
- Answer, Analysis, Summary, and Action Items tabs.
- AI search from the overlay.
- Minimize, hide, close, and restore actions.
- Auto-hide delay.
- Always-on-top behavior.
- Window size and position persistence.

Overlay preferences are stored in the Electron user-data directory, not in the
repository.

The overlay receives its final answer from the same completion boundary as the
main chat. This keeps overlay search, voice answers, typed answers, and derived
tabs consistent. Analysis, Summary, and Action Items are generated from the
completed answer when the provider does not return separate tab content.

## Developer Agent

Developer mode is intended for repository-aware assistance, not unrestricted
computer control. The user first selects a project folder. All file and
verification operations are checked to remain inside that project root.

Available project operations include:

- Choose, clear, and inspect the selected project.
- List directories and read selected source files.
- Search source text, symbols, definitions, and references.
- Build a deterministic repository map with languages, frameworks, entry points,
  source directories, test directories, and configuration files.
- Assemble bounded code context for an AI request.
- Run approved project verification scripts.
- Request a change proposal from searched files.
- Approve and apply a proposal only after content snapshots still match.
- Inspect task state, progress, verification results, and audit events.

The Developer Agent rejects path traversal, unsafe command syntax, arbitrary
shell commands, access outside the selected root, and attempts to expose
credentials. The agent state and context are isolated from Assistant and
General Agent modes.

## General Agent

General Agent capability categories include:

- Web research, navigation, extraction, comparison, and summarization.
- Product, grocery, food, travel, flight, train, bus, hotel, taxi, and price
  research.
- Shopping, orders, returns, tracking, commerce, and payment handoff.
- Email, messaging, social media, comments, notifications, calendar, meetings,
  reminders, and tasks.
- Documents, PDF, spreadsheet, forms, and file management.
- Isolated browser tasks and allow-listed desktop/development applications.
- Account workflows and authenticated workflows through user-controlled login
  handoff.

The default capability registry separates provider availability from capability
definition. The implemented browser provider is an isolated, task-scoped
Electron browser context that does not import personal cookies. Other provider
slots explicitly report when they require login, permission, or future
implementation.

Sensitive values such as passwords, one-time codes, payment card data, tokens,
cookies, credentials, and API keys are redacted from task observations and
handoff summaries. The agent stops or waits for the user when a task requires
login, confirmation, payment entry, or an unsupported capability.

## Persistence and Local Data

| Data | Storage |
| --- | --- |
| Interview Domain, Background, microphone selection | Browser local storage, `interview-context-v1`. |
| Chat and current UI state | Renderer session state. |
| Overlay bounds, opacity, active tab, auto-hide, always-on-top | Electron user-data directory. |
| Provider order, enabled state, active provider, non-secret metadata | `~/.ai-help-agent/provider-config.json` by default. |
| Provider API keys | Running service memory and environment/runtime configuration; never source control. |
| Developer journal and audit events | Local Electron application data. |
| Uploaded resume, job description, and documents | Local application/session state unless included in an AI request. |

Delete the provider configuration file only when you intentionally want to
remove saved runtime provider settings. Deleting it does not revoke an API key
at the provider.

## HTTP API

The Python service exposes these main endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Provider and service health status. |
| `GET /api/settings/providers` | List configured providers without secrets. |
| `GET /api/settings/providers/capabilities` | Provider capability information. |
| `POST /api/settings/providers` | Add or update a provider. |
| `POST /api/settings/provider` | Configure the active provider through the compatibility endpoint. |
| `PATCH /api/settings/providers/{provider_id}` | Update provider metadata or enabled state. |
| `DELETE /api/settings/providers/{provider_id}` | Remove a provider. |
| `POST /api/settings/providers/reorder` | Change provider priority. |
| `POST /api/settings/providers/self-test` | Test provider connectivity/capabilities. |
| `POST /api/settings/agent` | Update local agent permission settings. |
| `POST /api/extract-pdf` | Extract text from a PDF upload. |
| `POST /api/transcribe-audio` | Transcribe a recorded audio segment. |
| `GET /api/agent/activity` | Read local agent activity. |
| `POST /api/agent/open` | Request an allow-listed local action. |

The chat WebSocket endpoint is:

```text
ws://localhost:3002/ws
```

The renderer sends chat payloads over WebSocket and receives token, done, tool,
and error events. The service keeps provider diagnostics bounded and does not
include microphone device IDs in prompts or provider metadata.

## Important Project Files

```text
electron/
  main.cjs                  Electron windows, IPC, overlay, system loopback
  preload.cjs               Context-isolated renderer API

src/
  App.tsx                   Main assistant UI and capture pipeline
  Overlay.tsx               Answer overlay UI
  audio/transcriptUtils.ts  Transcript cleanup and question detection
  ai/interviewContext.ts    Domain, Background, microphone persistence
  ai/interviewSystemPrompt.ts
                            Grounded interview prompt builder

server/src/
  index.py                  FastAPI routes, WebSocket, STT, provider boundary
  provider_registry.py      Provider lifecycle, persistence, and fallback

scripts/
  test-all.mjs              Aggregate regression suite
  assistant-smoke-test.mjs  Assistant and audio-path assertions
  interview-context-test.mjs
                            Context and microphone selection tests
  configuration-ui-test.mjs
                            Configuration action and modal wiring test
  interview-context-backend-test.py
                            Provider-boundary metadata test
```

## Verification

Run the focused checks:

```bash
npm run test:assistant-smoke
npm run test:interview-context
python scripts/interview-context-backend-test.py
```

Run the overlay and context UI checks:

```bash
npm run test:overlay
npm run test:context-dialog
npm run test:configuration-ui
```

Run the Developer Agent checks:

```bash
npm run test:developer-agent
npm run test:developer-gates
npm run test:developer-lifecycle
```

Run the General Agent checks:

```bash
npm run test:general-agent-runtime
npm run test:general-agent-context
npm run test:general-agent-provider-compatibility
npm run test:general-agent-capability
npm run test:general-agent-benchmark
npm run test:general-agent-execution
npm run test:general-agent-execution-integration
npm run test:general-agent-electron-browser
```

Run protocol and provider compatibility checks:

```bash
npm run test:phase8
npm run test:gemini-protocol
```

Run the full checks:

```bash
npm test
# equivalent:
npm run test
npm run lint
npm run typecheck
npm run build
git diff --check
```

The following commands require live provider credentials, a running service,
or an interactive Electron/browser environment and are not part of the normal
offline test pass:

```bash
npm run validate:provider-live-e2e
npm run validate:general-agent-real
npm run validate:general-agent-provider-browser
```

The live Electron audio path should be verified manually by testing each
source mode:

1. Microphone.
2. System / Internal Audio.
3. Microphone + System / Internal Audio.

## Troubleshooting

### Cannot reach the AI server

Check the service health endpoint:

```text
http://localhost:3001/api/health
```

If it is unavailable, run `npm run server:dev` or restart with `npm run dev`.
Confirm that ports 3001 and 3002 are not owned by an unrelated process.

### Internal audio is unavailable

- Confirm that the app is running in Electron.
- Do not use only `npm run web:dev`.
- Confirm that playback audio is active.
- Allow display and audio capture.
- Use **Test Audio** and select a playback source.
- Check the platform's loopback or virtual-device configuration.

### Microphone is unavailable

- Open **Context → Audio → Microphone**.
- Select an available input device.
- Check the operating-system microphone permission.
- Disconnect/reconnect the device and reopen the selector.
- Restart the Electron app if the operating system has changed the device list.

### Provider errors or rate limits

- Check `/api/health`.
- Open Configuration and run a provider self-test.
- Confirm the configured model supports the selected operation.
- Configure a second provider and enable fallback when appropriate.
- Retry after a provider rate limit window expires.

### Electron launcher or broken-pipe errors

- Restart with `npm run dev` after closing stale Electron/Vite processes.
- Confirm ports 3001, 3002, and 5174 are available.
- A Windows `EPIPE`/broken-pipe message from a closing Electron child process
  is handled narrowly by the launcher; unrelated startup errors remain visible.
- If the launcher reports a child exit, check the backend health endpoint and
  the terminal output rather than relying only on the wrapper's final exit code.

### PDF or document answers are generic

- Confirm the document appears in the active session context.
- Use a focused question that refers to the document.
- For interview answers, select the correct profile, Resume, and Job
  Description before submitting the question.

## Security and Privacy

- Never commit `.env`, API keys, provider config files, or captured documents.
- API keys are sent only to the local service and are not rendered in provider
  list responses.
- Provider diagnostics use bounded metadata and redact sensitive error fields.
- Microphone device IDs are retained only for local device selection and are
  not sent to the AI provider.
- Agent desktop actions are allow-listed and require local permission gates.
- Uploaded documents and chat history are handled locally by the application
  unless their content is included in an AI request.
- The development service listens on `0.0.0.0` for local Electron coordination;
  do not expose ports 3001 or 3002 directly to the public internet. Use a
  firewall or bind to a restricted interface for shared environments.

## License

No license file is currently included in this repository.
