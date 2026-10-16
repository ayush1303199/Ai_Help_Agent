# Windows Sandbox cleanup-reporting trust boundary

## Status and decision

**Status: execution remains disabled; no trusted guest-to-host
result/cleanup-reporting channel has been established.**

The diagnostic `windowsSandboxProviderAdapter.cjs` is also deliberately
disabled. It builds a constrained configuration only from adapter-owned
temporary directories and exposes an injected lifecycle contract for tests,
but no production Windows API in this repository independently binds
`WindowsSandboxClient.exe`, its VM/resource identity, and final handle release
to one runner invocation. Launcher exit plus a global client-process count
cannot establish that every handle to that Sandbox instance has been released
or that the resource has actually been destroyed. Consequently the adapter
does not launch guests, reports runtime availability and independent
verification as false, and retains/quarantines staging data if the required
host lifecycle observation is absent or incomplete. Passing its injected
dependency tests is contract validation, not host runtime evidence.

The runner currently writes `cleanup.json` under the Sandbox results directory.
That directory is mounted writable in the guest. Source inspection does not
establish that project-controlled code cannot create, replace, or modify this
file. Therefore the current report must not be treated as authenticated
cleanup evidence.

Windows project-controlled execution remains disabled until a trusted
guest-to-host reporting channel and its access boundary have been independently
designed and validated. The current runner correlates guest reports to a unique
run ID, but that ID is guest-readable and guest-writable and therefore provides
freshness checking only, not authenticity. Do not infer that the existing
Sandbox configuration, a unique channel name, or guest process identity
provides that trust boundary.

The current implementation adds bounded host-side waiting, a host termination
attempt against the runner-owned launcher, host observation of launcher/client
exit, and post-removal verification of the runner-owned staging directory.
These changes do not authenticate guest output or authorize execution.

## Scope and non-goals

This design note:

- Does not claim Windows OS-level containment.
- Does not authenticate the current `cleanup.json` or `result.json`.
- Does not authorize Windows project execution.
- Does not authorize resource deletion.
- Does not establish that a named pipe, socket, broker, guest ACL, or separate
  file is secure.

Project exit status and guest cleanup status are separate evidence. A successful
project result must not compensate for failed, missing, malformed, or
untrusted cleanup evidence.

## Current flow and evidence

The runner creates a temporary root, then its `control` and `results`
subdirectories. It writes the guest bootstrap, invocation script, command
configuration, and toolchain into `control`. The generated Windows Sandbox
configuration maps the selected project read-only, `control` read-only, and
`results` writable into the guest. The bootstrap launches the restricted guest
process; that process copies the project into a writable guest workspace and
runs the requested verification command.

The host creates a unique run ID and places it in the guest command
configuration. The guest echoes it in `result.json` and `cleanup.json`, and the
host rejects missing, malformed, or cross-run reports. Since `results` is
guest-writable, this does not prove that the project-controlled process cannot
forge or replace either file; both reports remain untrusted claims.

On host deadline, cancellation, or invalid/missing result, the runner requests
cancellation and attempts to terminate only its owned launcher process. This
request is not proof that the guest terminated. The host separately waits for
the launcher to exit and for new `WindowsSandboxClient.exe` processes to
disappear, then removes the root recorded in its private lifecycle record and
checks that the path is absent. Failed or uncertain termination or removal
retains quarantine and the active lease. This process-list check is an
environment-level observation, not a cryptographically bound guest identity.

The result envelope keeps guest result and cleanup content in
`untrustedWorkerClaims`; it does not promote probe output or guest cleanup
status to `appVerifiedFacts`. The caller also refuses success because no
host-authenticated result channel exists. Secure erasure remains
`NOT_ESTABLISHED`.

Relevant implementation references:

- `electron/coding-pipeline/windowsSandboxRunner.cjs`
  - Guest cleanup report path and best-effort writer: lines 22-36.
  - Account-cleanup and shutdown-command outcomes and report writes: lines
    97-158.
  - Sandbox folder mappings and read/write settings: lines 390-403.
  - Run-bound guest result schema and host-side deadline/cancellation:
    lines 413-524.
  - Sandbox-client process inspection, launcher termination attempt, and
    launcher/client shutdown wait: lines 526-613.
  - Runner-owned temporary paths, run identity, launcher spawn, result
    collection, and lifecycle cleanup: lines 650-836.
- `electron/coding-pipeline/sandboxResourceLifecycle.cjs`
  - Private resource ownership and lease state: lines 38-71.
  - Deletion eligibility, host-observed shutdown, verified staging removal,
    resource state, and quarantine on error: lines 22-26 and 98-196.
- `electron/coding-pipeline/projectProcessIsolation.cjs`
  - Windows-disabled status and fail-closed isolation gate: lines 1-2, 15-30,
    and 49-56.
- `electron/developerFiles.cjs`
  - Production runner call and fail-closed cleanup/result-channel handling:
    lines 990-1030 and 1138-1198.
- `scripts/developer-runtime-state-test.mjs`
  - Existing source assertions and fake lifecycle/shutdown tests: lines 123-166,
    188-250, and 275-369. These tests do not establish a guest-to-host trust
    boundary or Windows containment.

Line references describe the source inspected when this note was written and
may shift as files change.

## Required cleanup evidence contract

After a trusted reporting channel is designed, the host parser must accept only
this exact property set:

```json
{
  "version": 1,
  "runId": "host-generated-run-id",
  "complete": true,
  "accountCleanup": "succeeded",
  "shutdownCommand": "succeeded"
}
```

Requirements:

| Property | Required value |
|---|---|
| `version` | Integer exactly `1` |
| `runId` | Exact host-generated run ID for this invocation; correlation only, not authentication |
| `complete` | Boolean exactly `true` |
| `accountCleanup` | Exactly `succeeded` or `failed` |
| `shutdownCommand` | Exactly `succeeded` or `failed` |

Reject missing or extra properties, incorrect types, `unknown`, malformed
data, incomplete reports, and any other status combination. Keep the project
command's exit status in a separate result field. Cleanup evidence must never
select a filesystem path, create or modify a resource record, or authorize
deletion.

Strict parsing is necessary but not sufficient: a perfectly formed report is
not trustworthy unless the reporting channel proves that project-controlled
code cannot forge, replace, or replay it.

## Trust-boundary requirements before selecting a transport

Any proposed design must establish, from implementation and independent
validation:

1. **Sender identity:** How the host distinguishes the intended guest bootstrap
   from the project command and any child process.
2. **Receiver identity:** Which host process receives the report and why the
   guest cannot impersonate or redirect that receiver.
3. **Transport and access controls:** How data crosses the guest/host boundary,
   which principals can connect or write, and how those controls are enforced
   rather than assumed.
4. **Forgery and replay resistance:** How reports are bound to the active
   runner invocation and rejected if project-controlled code fabricates,
   changes, duplicates, or replays a message.
5. **Failure behavior:** Missing, unauthenticated, malformed, incomplete, or
   late reports must fail closed and must not turn a successful project exit
   into overall verification success.
6. **Deletion separation:** Report content cannot influence the deletion
   target or bypass the lifecycle manager's independent shutdown confirmation.

The repository currently provides no source-established host-controlled
guest-reporting endpoint. The launcher is spawned with ignored stdio, and
process exit metadata does not communicate the guest result or cleanup
outcomes. Existing localhost sockets in the Electron main process are
backend-port checks, not a guest-reporting path. No guest-to-host named pipe or
socket is implemented in the inspected runner. These observations do not prove
that such mechanisms are impossible; they mean their security and feasibility
have not been established here.

## Independent shutdown and resource safeguards

The following invariants remain mandatory regardless of the reporting design:

- Launcher exit, including signal termination, is only launcher-process
  evidence. It does not replace the wait for the Sandbox client to shut down.
- A started Sandbox resource may be removed only after the independent
  launcher/client shutdown observation succeeds.
- Deletion uses only the temporary root recorded for the private runner-owned
  resource handle.
- Shutdown inspection errors, timeout, uncertain launch state, failed staging
  removal, or failed post-removal verification retain quarantine and block
  another launch.
- Cleanup-report fields never authorize deletion or clear quarantine.

## Implementation gates

1. **Design approval:** Document and review the sender identity, receiver,
   transport, access controls, per-run binding, replay/forgery resistance, and
   failure behavior. If the project process cannot be shown to lack access,
   defer.
2. **Transport implementation:** Implement only the approved reporting
   channel. Keep it separate from project result data and independent of the
   deletion decision.
3. **Strict parsing:** Enforce the exact schema above. Missing or untrusted
   evidence fails closed; project exit status remains separately represented.
4. **Focused tests:** Test parser and caller behavior, channel-level
   authentication/forgery handling, project-result/cleanup-result separation,
   and the unchanged shutdown/deletion invariants using bounded fakes where
   possible. Do not present these tests as proof of OS containment.
5. **Windows runtime validation:** Separately validate the actual guest/host
   access boundary, sender identity, report integrity, failure behavior,
   launcher/client shutdown confirmation, and resource retention/deletion on a
   Windows environment. Keep project execution disabled until the required
   isolation mechanism itself has been independently reviewed and verified.

## Acceptance criteria

- Missing, unauthenticated, forged, malformed, failed, or incomplete cleanup
  evidence cannot yield overall verification success.
- The host accepts only the exact schema and value constraints above.
- Project exit status and cleanup outcome remain separate evidence.
- Report content never chooses a path or authorizes resource deletion.
- Launcher termination never substitutes for Sandbox-client shutdown
  confirmation.
- Resource deletion remains limited to the private runner-owned recorded root.
- Failure to establish or validate the reporting boundary keeps Windows
  project-controlled execution disabled.

## Unverified assumptions and limitations

Source inspection does not establish whether a project-controlled guest
process can modify the current report or result files under actual Windows
Sandbox guest permissions. It also does not establish whether a guest can
reach a prospective host broker, named pipe, socket, or other endpoint, or
whether the bootstrap can be distinguished from the project process at that
endpoint. These require a concrete design and Windows runtime validation.

No source-level test or report schema alone proves Windows OS-level containment.
