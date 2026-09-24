# AI Help Agent engineering rules

## Coding Agent pipeline

Changes to the Coding/Developer Agent must use the existing pipeline owner:

1. Renderer coding UI requests a typed Developer IPC operation.
2. `electron/main.cjs` validates renderer ownership and project ownership.
3. `electron/developerAgent.cjs` owns the lifecycle:
   `reading -> understanding -> proposal_ready -> awaiting_approval ->
   approved -> applying -> verifying -> completed`.
4. Verification runs only through the allow-listed command policy.
5. Repository writes require an approved proposal and snapshot validation.
6. Failed apply/verification paths must preserve recovery, rollback, audit, and
   session ownership behavior.

Do not implement Coding Agent changes in Meeting, General, shared history, or
provider UI modules. Do not create a second developer-agent service or bypass
`developerAgent.cjs`. If a shared capability is needed, define and test a
small contract first.

## Safe change workflow

For a Coding Agent change, inspect the affected IPC handler and pipeline stage,
make the smallest isolated change, then run:

```text
npm run test:developer-agent
npm run test:developer-lifecycle
npm run test:architecture
npm run lint
npm run typecheck
npm test
```

Run the production build when Electron or packaging code changes. Never claim
runtime or installer verification unless it was actually launched successfully.
