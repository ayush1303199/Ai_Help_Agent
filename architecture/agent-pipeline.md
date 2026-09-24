# Coding Agent pipeline

The Coding/Developer Agent has one pipeline owner: `electron/developerAgent.cjs`.
This is an explicit bounded context, not a second parallel architecture.

```text
Coding UI
   |
   v
Typed Developer IPC
   |
   v
Electron main ownership/project checks
   |
   v
developerAgent.cjs
   |
   +--> read and understand
   +--> validate proposal
   +--> await explicit approval
   +--> apply snapshot-checked patch
   +--> run allow-listed verification
   +--> complete, recover, rollback, or fail
```

## Ownership

- `src/features/coding` owns Coding Agent presentation and user interaction.
- `electron/main.cjs` owns the privileged IPC adapter and renderer/project
  ownership checks.
- `electron/developerAgent.cjs` owns task state, proposals, approval, apply,
  verification, recovery, rollback, session binding, durability, and audit.
- Developer file/index/context modules provide bounded infrastructure; they do
  not replace the lifecycle owner.

## Change rule

Every Coding Agent modification must identify its pipeline stage and change
only that stage plus the smallest required contract surface. Meeting,
General, unified history, provider, STT, and overlay code are protected from
Coding Agent changes unless a separately justified shared contract is required.

The pipeline is intentionally a local Electron capability rather than a
microservice. It keeps privileged operations close to the desktop security
boundary while remaining independently testable through the Developer Agent
contract tests.

## Required invariants

- No repository write before explicit approval.
- Proposal targets remain inside the selected project root.
- Files changed after proposal creation cause apply to fail safely.
- Verification commands come from the allow-list.
- Renderer session ownership is checked for every privileged operation.
- Apply and verification failures retain recovery/rollback behavior.
- Durability and audit failures are surfaced rather than silently ignored.
