# Adding an isolated agent

This guide describes the intended boundary for a future agent. It does not claim
that every current agent is fully self-contained: shared provider/configuration,
history, and composition state still live in `src/App.tsx`, while each agent's
transport and workflow controller should remain under its feature namespace.

## Module layout

For an agent named `research`, create only the modules it needs, following this
shape:

```text
src/features/research/
  ResearchAgentPage.tsx
  ResearchAgentWorkspace.tsx
  researchTransport.ts
  researchSessionStore.ts       # only if it owns durable renderer state
electron/researchAgent.cjs      # if it needs privileged Electron lifecycle/tools
server/src/research_service.py  # if it needs backend/provider operations
scripts/research-agent-test.mjs # or the repository's existing test style
```

Keep feature-specific state, lifecycle, transport, provider request shaping,
and persistence inside that agent's namespace. Use a dedicated IPC channel,
WebSocket endpoint, or HTTP route where appropriate; its transport should own
the request/response contract. Add a thin composition adapter in `electron/main.cjs`
or `server/src/index.py` only to register/route the agent's contract. Those
composition roots may import each agent's public module, but agent-owned modules
must not import another agent's internals.

## Shared capabilities

Reuse these existing capabilities instead of cloning them:

- Provider configuration and credentials: `src/config/*` and the backend
  provider registry/service.
- Unified conversation history: `src/history/historyService.ts`, using the
  agent's existing history mode or adding one through an explicit contract
  change.
- Application mounting and shared navigation: `src/App.tsx` and shared
  components under `src/ui/`.
- Generic audio, document, context, and screen-reading utilities when their
  contract is genuinely agent-neutral.

Do not put agent-specific workflow state or business rules in those shared
modules. A shared utility should have a neutral API, no dependency on an agent
implementation, and more than one legitimate caller (or a deliberate stable
platform contract).

## Composition and isolation rules

1. The feature page/workspace owns rendering; a feature-local controller or
   transport owns its workflow and session state.
2. Electron main and FastAPI modules validate ownership and adapt privileged
   requests. They do not absorb another agent's lifecycle.
3. A backend composition root may register all independent agent services.
   Provider registry and neutral infrastructure may be shared; provider request
   formatting and agent lifecycle remain local to the owning agent.
4. Add only the mount/navigation and public-contract wiring required in
   `src/App.tsx`. Do not add the new workflow's handlers, reducers, or request
   dispatch to its already-large stateful body.
5. An agent-to-agent handoff must be an explicit, typed public contract and a
   tested integration point; it must not be implemented by importing or
   mutating the other agent's internal state.
6. Extend `scripts/architecture-boundary-test.mjs` with the new ownership root
   and test fixture. Add focused lifecycle/transport tests and run
   `npm run test:architecture`.
7. Do not refactor existing agents as part of adding the new one. If a shared
   contract must change, isolate and review that contract separately.

## Current architecture caveat

The renderer experiences now use feature-owned controllers and transports:
Assistant uses `src/features/assistant` and `/assistant`, Meeting uses
`src/features/meeting` and `/meeting`, General uses `/general`, and Coding uses
its dedicated transport. `src/App.tsx` remains the application shell and composition root for shared
provider configuration, context, history, and navigation. Assistant, Meeting,
Coding, and General each have a feature-owned page/workspace folder; Assistant
and Meeting also have independent transports and endpoints. Agent-owned UI,
request lifecycle, and errors/status should stay local to the owning feature.
The shell routes typed mode changes and supplies intentionally shared
capabilities; it must not combine agent output or block one page based on
another page's busy state. The architecture boundary test prevents direct
cross-agent imports and guards page/controller ownership contracts.
