# Module boundaries and engineering rules

This repository uses feature ownership rather than a full runtime rewrite. Existing
HTTP, WebSocket, Electron, provider, and UI contracts remain unchanged.

## Runtime facts

- Renderer: React + Vite, composed by `src/App.tsx`.
- Electron main process: `electron/main.cjs`.
- Typed renderer bridge: `electron/preload.cjs` and `src/electron.d.ts`.
- HTTP backend: FastAPI on port `3001`.
- WebSocket backend: port `3002`.
- Backend packaging: PyInstaller through `scripts/build-backend.mjs`.
- Production desktop packaging: Electron Builder through `npm run desktop:build`.
- Generated `build/` and `dist/` directories are local artifacts and must not be
  committed.

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
- `src/history` owns the unified history contract and persistence primitives.
  History intentionally supports `assistant`, `developer`, and `general` modes;
  it must not be split into per-feature stores without an explicit migration plan.

`src/App.tsx` is the composition root. It currently owns cross-feature state and
passes existing handlers into feature UI. Moving state or behavior is a separate,
test-backed change and is intentionally not part of this structural step.
When extracting responsibilities from `App.tsx`, move one cohesive lifecycle or
workflow at a time into a feature hook/service, preserve its public props, and
add targeted coverage before moving the next responsibility. Splitting only to
reduce line count is not an architectural improvement.

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

## Change-size policy

For a focused bug fix, inspect the affected dependency path and protected
contracts; do not perform a repository-wide architecture rewrite. A complete
architecture comparison and migration plan is required only for a major
structural change.

For architecture changes, record:

1. Current state and evidence from source/runtime paths.
2. The problem and affected boundaries.
3. Considered options and the selected decision.
4. Migration steps, blast radius, and test plan.

For focused changes, the final report may be concise: changed files, behavior,
tests, build/runtime validation, and remaining risks.

## Protected behavior

Unless source evidence proves a defect, preserve:

- Meeting Assistant speech, transcription, overlay, shortcuts, and live state.
- Coding Agent approval, repository access, tool execution, and verification gates.
- General Assistant isolation from repository and shell capabilities.
- Existing HTTP, WebSocket, IPC, provider, STT, persistence, and packaging
  contracts.
