# Coding Agent mutation enforcement

## Project subprocess isolation

The temporary workspace copy, filtered environment, and project-root checks are
not an operating-system security boundary. Temporary copies omit recognized
credential directories/files, but this is only data minimization. No verified
sandbox runner is currently configured. `projectProcessIsolation.cjs` therefore fails closed:
project verification commands, project Git subprocesses, and project dev-server
commands do not start on any platform. Dev-server startup is rejected before a
workspace copy or child process is created. This is a deliberate feature
restriction, not a claim that the copy is isolated.

Re-enable these operations only after a platform-specific runner has been
implemented and verified to restrict filesystem access (including absolute
paths and symlinks), credentials, network capabilities, and child-process
lifetime. Until then, verification is unexecuted and cannot satisfy an
approval's verification requirement.

## Mutation-path inventory

| Path | Mutation or execution boundary | Regression coverage |
|---|---|---|
| Proposal create/modify and atomic file replacement | `developerAgent.apply` -> `applyChanges` -> per-target `authorizeMutation` immediately before temporary-file creation and atomic rename; main-process callback checks task/session/project ownership and calls the backend `PolicyGate`. | `developer-agent-test.mjs`; `developer-repair-ipc-integration-test.mjs` |
| Proposal delete and directory delete | Per-target PolicyGate check; main process requires a separate dialog confirmation for the exact target, then the target snapshot is revalidated before deletion. | `developer-agent-test.mjs`; `developer-repair-ipc-integration-test.mjs` |
| Rename | Destination uses the approved rename operation; source removal is a second `delete` operation with its own immediate confirmation and snapshot revalidation. | `developer-agent-test.mjs` |
| Apply-failure rollback and user undo | `restoreBeforeSnapshot` authorizes each restore write. Removing an existing target/directory is separately authorized as deletion and requires the main-process confirmation; snapshots are rechecked after confirmation. | `developer-agent-test.mjs`; `developer-lifecycle-test.mjs`; `developer-repair-ipc-integration-test.mjs` |
| Multi-repository rollback | Production entry is the owner-validated main-process IPC handler. It validates task/project scope, confirms deletion separately, and calls the same backend PolicyGate before each direct write or unlink. The general authorizer-registration export was removed. | `coding-blind-reality-stage19-test.mjs`; `developer-repair-ipc-integration-test.mjs` |
| Callback-based coordinated apply | Disabled before invoking the caller callback because it could mutate undeclared paths. | `coding-blind-reality-stage19-test.mjs` |
| Checkpoint restore | Restores app-owned task state, not repository files; requires the owning session and selected project root. It is not an alternate file-restore API. | `developer-repair-ipc-integration-test.mjs`; checkpoint lifecycle tests |
| Coding WebSocket tools and renderer IPC | Project inspection tools are read-only. Changes become proposals; project writes are performed by the main-process proposal apply/undo IPC path above. | Architecture test; Coding Agent IPC integration tests |
| MCP adapter | Built-in filesystem tools are read-only; the built-in runtime tool is a stub unless an in-process handler is registered. `registerTool` accepts executable callbacks and is not an OS security boundary. | MCP adapter and architecture tests |
| Project verification and dev-server scripts | Fail closed before spawning because no verified OS sandbox exists. Temporary copies and environment filtering are not treated as containment. | `developer-lifecycle-test.mjs`; `developer-runtime-state-test.mjs` |
| Project-root Git inspection and changed-PHP discovery | Fail closed before spawning. Multi-repository baseline capture no longer invokes Git; its pre-existing-change status is explicitly `NOT_VERIFIED_NO_OS_SANDBOX`. | `developer-lifecycle-test.mjs`; multi-repository tests |
| Developer task journal and audit log | App-owned persistence under application data; not a project-file mutation path. The audit records operation/path/decision metadata, not credential values. | Developer lifecycle and audit tests |
| Checkpoints, artifacts, semantic index cache, overlay state | App-owned persistence in configured application storage. Artifact/checkpoint paths are application-owned; semantic-index and overlay writes do not target the selected project. | Developer pipeline, checkpoint, artifact, and runtime-settings tests |
| Provider configuration and Coding Intelligence schema cache | App-owned provider/database metadata persistence in `provider_registry.py` and `coding_intelligence.py`; these are outside the project-file PolicyGate path and were not modified in this remediation. Their application-level settings/database authorization remains a separate trust boundary. | Provider configuration and backend persistence tests |

## In-process trust boundary

Rollback authorization is supplied through the main-process-owned IPC flow;
the coordinator no longer exports an authorizer-registration function. This
prevents model/tool interfaces from registering an alternate callback through
the supported tool surface. The proposal apply/undo internals likewise receive
their authorizer from the main-process IPC path. These are application call-path
constraints, not a defense against arbitrary malicious JavaScript already
executing with unrestricted access inside the Electron main process. The generic
MCP adapter can also accept an in-process callback. Such code shares the process
privilege boundary and requires process isolation or application integrity
controls, not another in-process policy check.
