# Module boundaries

This repository uses feature ownership rather than a full runtime rewrite. Existing
HTTP, WebSocket, Electron, provider, and UI contracts remain unchanged.

## Renderer

- `src/features/meeting` owns Meeting Assistant page-level UI.
  `MeetingAssistantWorkspace` contains setup, audio status, active capture,
  transcript, and text-send presentation. Speech capture, transcript processing,
  meeting context, and overlay behavior remain on their existing stable services
  until they can be extracted with tests.
- `src/features/coding` owns Coding Agent page-level UI and the existing developer
  workflow handlers. `CodingAgentWorkspace` contains project browsing, code search,
  proposal review, approval, apply/verify, and conversation presentation.
  Repository access, proposal approval, apply, and verification remain behind the
  existing Electron bridge.
- `src/features/general` owns General Agent page-level UI and its existing task
  workflow handlers. `GeneralAgentWorkspace` contains the task form, progress,
  answer, confirmation, and lifecycle controls; `App.tsx` still owns the state
  and handlers passed into it.
- `src/ui/header` owns shared application navigation and header controls.
- `src/ui` owns reusable presentation components shared by more than one feature.
- `src/audio`, `src/documents`, `src/context`, and `src/config` are shared or
  infrastructure-facing modules. Features use their public functions rather than
  another feature's internal state.

`src/App.tsx` is the composition root. It currently owns cross-feature state and
passes existing handlers into feature UI. Moving state or behavior is a separate,
test-backed change and is intentionally not part of this structural step.

## Backend

- `server/src/index.py` remains the HTTP/WebSocket composition root.
- `server/src/backend_config.py` owns environment-backed runtime configuration.
- `server/src/agent_control_service.py` owns loopback-controlled desktop
  permissions, allow-listed local target opening, and agent activity history.
- `server/src/stt_service.py` owns multipart audio transcription, STT provider
  selection, retry handling, safe failure classification, and transcription
  response logging. The `/api/transcribe-audio` route remains in `index.py` as
  a thin HTTP adapter.
- `server/src/provider_service.py` owns provider capability and credential lookup.
- `server/src/provider_registry.py` owns provider persistence and lifecycle state.
- Provider, STT, General Agent, and Coding Agent behavior must preserve the current
  HTTP and WebSocket contracts while future extraction proceeds.

## Dependency direction

```text
feature UI -> existing application handlers -> shared services/infrastructure
backend routes -> feature/provider services -> provider infrastructure
```

Feature modules must not import another feature's internal state or services.
