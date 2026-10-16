# Independent Host-Observation Boundary

## Decision and security objective

There is no trusted host evidence issuer or independently authenticated
observation channel in the current architecture. Execution therefore remains
blocked. The contracts and test fixtures in this repository can validate
structure and fail-closed decisions; they cannot establish runtime isolation,
host observation, or cleanup.

The design goal for a future implementation is to make claims verifiable by a
component that observes the host/runtime independently of the renderer,
provider adapter, worker, or guest. It is not a defense against an attacker
controlling the host operating system, kernel, service administrator, or the
trusted observer's signing keys. Such an attacker can falsify process,
filesystem, network, and resource observations unless a stronger external
attestation root is introduced.

## Threat model

| Component | Trust | Possible attacks or failures |
| --- | --- | --- |
| Renderer and renderer-originated IPC callers | Untrusted | Can forge requests, provenance labels, approvals, IDs, timestamps, capability flags, and reports; can replay or omit requests. Main-process ownership and input validation reduce confused-deputy risk but do not make renderer data observational evidence. |
| Provider adapters and ordinary Electron/Node modules | Not independent | Can return arbitrary objects, lie about their source, drop or replay observations, and contradict another component. Same-process code shares authority and memory; module privacy, object freezing, booleans, and labels do not authenticate it. |
| Worker or guest | Untrusted | Can control its output files and messages, lie about execution and cleanup, omit reports, and replay old reports. Guest output must never attest to host termination, resource deletion, host staging deletion, handle release, or secure erasure. |
| Future host observer | Conditionally trusted only after implementation and deployment review | Must obtain observations through a host API outside the worker/guest trust domain, bind them to a fresh operation, and authenticate its channel. It remains vulnerable to host administrators, OS compromise, observer compromise, and unsupported platform semantics. |
| Evidence consumers and shared execution gate | Must fail closed | Can make an authorization mistake if they treat valid structure, approvals, adapter flags, or one lifecycle observation as another claim. A valid observation is not itself execution authorization. |

An attacker may forge, replay, omit, delay, reorder, or contradict any message
from the renderer, adapter, worker, or guest. The future observer is the only
component proposed to attest host-side facts, and only where it can directly
query an authoritative host API. Where the platform cannot independently
observe a fact, its state remains `UNCERTAIN` or `NOT_ESTABLISHED`.

## Observation-channel alternatives

| Design | Boundary and authentication | Binding, replay, and freshness | Failure and platform limitations | Prerequisites and trade-off |
| --- | --- | --- | --- | --- |
| Separately launched per-user helper | A dedicated executable can use OS-enforced IPC ACLs and peer identity, then authenticate its messages with an ephemeral session key established over that protected channel. It must validate the Electron main peer and reject renderer peers. Process separation alone is insufficient: same-user code may often launch or impersonate an equivalent process unless executable identity, privileges, and IPC policy are independently enforced. | Main allocates an unpredictable run ID and operation nonce; helper captures provider/runtime/resource identity itself, binds every message to run, resource, operation, sequence number, and monotonic observation time, and rejects duplicate nonces. Wall-clock timestamps alone do not prevent replay. | Crash, disconnect, timeout, partial reads, or contradictory observations invalidate the affected operation and retain/quarantine resources. Windows named-pipe ACLs and token identity need careful service/user scoping. macOS XPC/launchd entitlements and code-signing identity require distribution setup. Linux Unix-socket peer credentials and filesystem permissions vary by service manager and namespace. | Requires a signed/versioned installer, update and rollback policy, protected executable/configuration paths, narrowly scoped privileges, authenticated IPC, lifecycle supervision, and platform-specific review. Narrowly scoped per-user helper is the smallest viable first experiment, but not authorized here. |
| Dedicated service with separately controlled lifecycle | A managed service (for example, a Windows service, launchd daemon, or systemd unit) can have a distinct OS identity and protected lifecycle. Authenticate using OS peer credentials plus a challenge-bound session protocol; do not rely on a caller-supplied service name or PID. | Same run/resource/operation/nonce binding is required. Service-side durable replay state or an authenticated operation ledger is needed if replay must be rejected across restarts. Freshness requires monotonic sequencing plus bounded age; wall time is supplemental. | Service unavailability or loss of its state blocks new execution. On restart, uncertain active resources remain quarantined pending authoritative reconciliation. Platform service managers provide different controls and do not prove what the service actually observed. | Stronger privilege separation and lifecycle control, but materially more operational complexity: privileged installation, service hardening, upgrade security, logging, health monitoring, and recovery procedures. A service still trusts the host OS and its administrators. |
| Verified runtime integration | A runtime-specific host component (for example, a container daemon or OS sandbox API) may expose process, resource, and policy state outside the guest. The observer must authenticate the exact daemon/API endpoint, reject remote or ambiguous endpoints when local host observation is required, and verify immutable runtime/image/configuration identity. | Each observation is bound to daemon identity, runtime object ID, run ID, image digest, operation ID, and current configuration. Query state after the operation; reject stale objects, reused names, mismatches, and incomplete event streams. | Daemon/API disconnects, event gaps, ambiguous endpoints, and partial teardown yield uncertain state. Windows, macOS, and Linux may route container workloads through different VM/daemon layers; host process visibility does not automatically establish guest process or network state. | Requires a supported runtime version, verified local endpoint and permissions, immutable image/configuration policy, runtime-specific observer, and integration/incident testing. This is the most direct source for runtime facts, but does not automatically prove endpoint policy, host staging removal, or secure erasure. |

No alternative is trusted merely because it is a separate process or service.
The enforced OS identity, executable provenance, protected lifecycle, IPC
authentication, host observation API, privilege scope, and recovery behavior
must each be independently reviewed and tested before any issuer can be
considered.

## Evidence protocol

Every protocol record is an observation, not an authorization token. A future
authenticated record should include at minimum:

```text
protocolVersion
observerIdentity
observerBuildIdentity
runId
providerId
providerConfigDigest
resourceId
runtimeIdentity
operationId
operationType
sequenceNumber
nonce
observedAtMonotonic
observedAtWallClock
expiresAt
result
completeness
contradictionReference
channelAuthentication
```

`observerIdentity`, `observerBuildIdentity`, `channelAuthentication`, result,
and completeness must be established by the observer/channel, not copied from
an adapter or guest object. Bindings must be compared with the main process's
independently retained expected run context. Evidence is scoped to one
operation and one resource. Use unpredictable run/operation nonces and
monotonic sequence numbers; persist replay state across observer restarts when
the design claims cross-restart replay rejection. Reject duplicate sequence
numbers/nonces, mismatched bindings, expired/future observations, missing
fields, contradictory results, and incomplete observation sets. Missing or
unverifiable records yield `UNCERTAIN`/`NOT_ESTABLISHED`, never an implicit
success.

The protocol must keep these evidence types independent:

| Evidence type | What the observer must independently query | Does not establish |
| --- | --- | --- |
| Runtime identity/configuration | Runtime API identity, immutable runtime/image digest, effective launch configuration, and resource identity | Network enforcement, successful command execution, or teardown |
| Endpoint/network-policy enforcement | Effective host/runtime policy and, where required, independently observed traffic outcomes at the enforcement point | That a guest attempted all relevant destinations, or process/resource cleanup |
| Process creation | Host/runtime process identity, parent/run association, executable identity, and start observation | Process success, termination, or resource deletion |
| Process termination | Authoritative process exit/absence observation tied to the created process identity | Container/VM deletion, handles released, staging cleanup, or secure erasure |
| Resource creation | Host/runtime resource ID, owner/run association, and immutable configuration at creation | Process identity, policy enforcement, or later deletion |
| Resource deletion | Authoritative runtime lookup/event confirming that exact resource is absent after deletion | Process termination unless independently observed, staging cleanup, handle release, or erasure |
| Staging cleanup | Host filesystem operation and post-operation verification on the exact run-scoped staging path | Guest resource deletion, process termination, secure erasure, or deletion of unrelated files |
| Handle/resource release | Relevant host handle/lease/resource enumeration showing the scoped resource is no longer held | Staging cleanup, process termination, or secure erasure |
| Secure erasure | Only a storage-specific primitive and independently verifiable completion covering the exact data/media scope | Ordinary file deletion, unlink, trim, container removal, or overwrite on storage with unknown snapshots/copy-on-write behavior |

`cleanupVerified` may be an aggregate for reporting only if its required
component claims are explicitly enumerated and independently satisfied. It
must not replace or cause any component observation. Secure erasure is
`NOT_ESTABLISHED` unless the exact storage technology, snapshots/replicas,
remapping, encryption-key lifecycle, and erase primitive support that claim.

## Current implementation boundary

The renderer/IPC path carries requests into Electron main; main owns the
developer-agent lifecycle and process launch routing. Provider adapters,
the evidence contract, and Electron main execute within the same application
trust domain. The provider wrapper marks fallback observations as
`untrusted-caller-input`; the evidence contract only validates shape and
bindings and returns `NOT_ESTABLISHED` without a trusted verifier. The Windows
Sandbox runner checks its private authorization set and then calls the shared
isolation gate before spawning; no supported issuer can populate that set.
The shared gate remains unavailable. Docker/provider and Windows Sandbox
adapter outputs do not create host authority.

Capability-state metadata is descriptive and never authorizes execution:

| State | Meaning |
| --- | --- |
| `SUPPORTED` | The adapter declares that a capability is implemented for its platform; this is not runtime evidence. |
| `UNSUPPORTED` | The adapter declares that the platform or implementation does not provide the capability. |
| `BLOCKED` | The capability is deliberately unavailable under the current policy or unmet prerequisites. |
| `UNCERTAIN` | Available observations are conflicting or cannot be interpreted reliably. |
| `NOT_ESTABLISHED` | No sufficient evidence establishes whether the capability is present or effective. |

Provider capability metadata is not authenticated host observation. In
particular, `SUPPORTED`, adapter initialization, fixture success, and
configuration values must never promote the shared gate or replace
operation-bound evidence from an independently trusted observer.

The lifecycle contract now has separate operation names for runtime identity,
endpoint policy, process creation/termination, resource creation/deletion,
staging removal, handle release, and secure erasure. These are structural
bindings only. Valid-looking records still return `NOT_ESTABLISHED`, and
operation mismatches return `BLOCKED`; no replay-resistant issuer exists.

The test scripts that exercise these contracts are offline or mocked. Their
temporary filesystem fixtures and injected observations validate decisions
and cleanup code paths only. They do not prove real runtime behavior.

## Proposed first Windows enforcement path

The smallest credible Windows implementation is a separately installed,
signed, narrowly privileged native broker service that owns command launch,
policy setup, process observation, and cleanup. It must not be implemented as
an ordinary Electron/Node module: same-process code cannot independently
authenticate its own claims. The current Windows Sandbox runner is not this
broker and remains disabled; its launcher and guest-result observations do
not establish guest-worker identity or termination.

| Requirement | Proposed enforcement | Independent verification before enabling |
| --- | --- | --- |
| Approved command scope | Main-process gate supplies an immutable, one-run approved command manifest: exact executable identity, argument vector, working directory, environment allowlist, snapshot digest, and time/resource bounds. The broker accepts requests only from the authenticated main-process peer, validates schema and policy, and rejects arbitrary shell strings, renderer-originated requests, changed digests, and reused run IDs. Human approval remains separate from the broker's one-time execution authorization. | IPC integration tests prove renderer rejection and approved-scope matching. Host tests inspect the broker's received request and actual process token/command line against the approved manifest. |
| Dedicated worker identity | Broker creates a run-specific AppContainer SID and restricted token, launches the command under that identity, and records the resulting token SID and process creation identity. The service, not the renderer or worker, owns identity creation and binding. | Query the live process token from the host and compare its AppContainer SID, user SID, integrity level, enabled capabilities, and privilege set with the broker's run record. |
| Filesystem boundary | Broker copies only the approved project snapshot into a run-scoped staging directory. ACLs grant the AppContainer access only to that directory and required read-only system paths. The worker never receives direct access to the source checkout, broker state, credentials, or unrelated user data. Result files are untrusted until independently re-read and validated by the main process. | Inspect effective access tokens and ACL access checks; attempt reads/writes to approved and forbidden paths in a disposable environment; verify the staged input digest before launch and output scope before use. |
| Network and endpoint boundary | Default is no network capability. Add host WFP policy bound to the run's AppContainer identity as defense in depth; permit no endpoints unless a future explicit policy requires them. Do not use an application proxy as a substitute for default-deny OS enforcement. | Inspect effective WFP filters and the process identity from the host, then attempt loopback, private, public, DNS, proxy, and alternate-protocol access from the worker. Missing policy or observer access blocks the run. |
| Resource and execution limits | Assign the suspended process to a Job Object before resuming it; disallow breakaway and configure kill-on-close, active-process count, memory, and CPU limits. The broker also enforces a monotonic wall-clock deadline and output cap, then terminates the whole job on cancellation or timeout. | Query Job Object limits and membership from the host; exercise child-process creation, fork/bomb bounds, memory/CPU pressure, output overflow, cancellation, and wall-clock timeout in disposable tests. |
| Process-tree termination | Keep the Job Object and process handles in the broker. On completion/cancel, terminate the job if needed and wait for authoritative job/process handles to signal; separately record each worker/process-tree observation. Never infer worker termination from broker or launcher exit. | Confirm the job has zero active processes and all tracked process handles have signaled after termination. A broker crash or lost event stream leaves the run unestablished and quarantined. |
| Cleanup and erasure | After process-tree absence, close scoped handles, remove only that run's staging root, and verify its absence. Report handle release, staging removal, resource cleanup, and secure erasure independently. Ordinary deletion is not secure-erasure evidence. | Enumerate scoped handles/resources and verify the exact staging path is absent. Secure erasure remains unavailable unless the exact storage and erase primitive provide independently verifiable semantics. |

AppContainer plus Job Objects provides kernel-enforced boundaries, not a
hypervisor boundary and not protection from a compromised Windows kernel,
administrator, or broker. If the threat model requires a VM boundary, use a
separately managed Hyper-V guest design only after a trusted host API can
observe guest identity, worker termination, and resource teardown; Windows
Sandbox's current launcher/result path does not provide those facts. No
desktop-host or unrestricted-process fallback is allowed when a control is
unavailable. The broker must be signed, protected against replacement and
rollback, least-privileged, updated independently, and tested on supported
Windows builds before the gate can recognize it.

### Authorization and evidence lifecycle

The developer proposal/approval lifecycle authorizes a specific project
modification; it does not authorize arbitrary command execution. After
approval, the main-process gate must independently resolve an allow-listed
command and exact approved snapshot/plan, then request one single-use run
authorization from the broker over authenticated IPC. Neither UI state,
approval booleans, preflight output, adapter capabilities, nor the existence
of an adapter may mint that authorization. The broker enforces command scope
and resource policy before creating a process; a denial or missing broker
leaves the shared gate blocked and must not fall back to desktop execution.

For each run, the broker creates a unique run ID and retains the expected
provider, AppContainer SID, resource IDs, operation IDs, and approved digest.
It emits a strictly sequenced operation record only after host observation:
process creation, runtime/token identity, effective network policy, resource
creation, worker/process-tree termination, handle release, staging removal,
and resource cleanup are separate observations. Launcher termination,
guest/VM termination, worker termination, and process-tree termination are
distinct subjects and cannot substitute for one another. Cleanup, resource
deletion, handle release, and secure erasure are also separate claims.

The broker's protected named-pipe endpoint must restrict clients by OS
identity and verified application identity; the broker authenticates its
client peer, and the main process authenticates the service endpoint using
protected service identity and a challenge-bound session channel. Each record
binds protocol/build identity, run/provider/config digest, expected worker and
resource, operation ID/type, unique nonce, monotonically increasing sequence,
monotonic and wall-clock observation times, expiry, result, and completeness.
The broker persists consumed operation IDs/nonces and sequence state across
restarts. If its ledger is lost, a resource is orphaned, the channel is
contradictory, or observation is incomplete, execution remains blocked and
resources are quarantined until reconciled by host observation.

The gate validates authenticated broker identity and bindings against its own
retained context; it does not trust a signature, token, timestamp, source
string, or `authenticated: true` field supplied by the renderer, guest, or
ordinary provider code. The in-process
`createLifecycleObservationLedger()` added to the structural contract rejects
duplicate IDs/nonces and non-increasing sequences only for the lifetime of
that ledger. It is an offline review aid, has no authenticated issuer or
durable replay state, is not wired into production authorization, and cannot
establish any host fact.

## Unresolved prerequisites and explicit non-claims

Before implementation of a genuine observer/issuer, the project needs:

1. Implement and security-review the selected Windows broker architecture,
   including service installation, executable integrity, named-pipe ACLs,
   peer authentication, privilege scope, update/rollback, and crash recovery.
2. Implement host-side process/token, AppContainer, WFP, Job Object, handle,
   and exact-path cleanup observers; test each against the actual supported
   Windows versions. The current Windows Sandbox runner does not provide these
   observations.
3. Implement an authenticated protocol verifier in the shared gate, including
   durable replay state, broker restart reconciliation, and negative tests for
   forged, replayed, stale, mismatched, partial, and contradictory records.
4. Independently review command authorization semantics, approved snapshot
   binding, and all process-creation entry points before a broker can accept
   work.
5. Complete separate runtime, adversarial policy, cancellation, and teardown
   validation on a disposable Windows host after explicit authorization in a
   future task.

The issuer is unavailable. Runtime isolation, endpoint enforcement,
host-observed teardown, replay rejection by a future issuer, and secure
erasure are all `NOT ESTABLISHED`. No issuer authorization, host fallback, or
project execution route is enabled by this design.

## Production lifecycle availability and call graph

The mapping in `sandboxResourceLifecycle.cjs` is a structural validator
contract, not an observation registry. The current production code does not
construct typed, issuer-authenticated lifecycle evidence for any mapped
operation. The following inventory distinguishes raw observations from
validated or trusted evidence:

| Claim / operation | Production raw observation source | Structural validation path | Production consumer / gate impact | Availability |
| --- | --- | --- | --- | --- |
| `runtimeIdentityVerified` / `runtime-identity-observation` | Docker `inspectDockerHost()` and `validateObservedContainerConfiguration()` inspect daemon/image/configuration; Windows builds a `.wsb` configuration. Neither emits a lifecycle claim record. | `evaluateLifecycleClaim()` can validate a caller-supplied record, but no production caller supplies one. | No lifecycle consumer. Evidence manifest validation never receives this claim. No gate effect. | Structurally defined; raw observations exist; typed producer and consumer absent; host-authoritative verification unavailable; not authorization eligible. |
| `networkPolicyEnforced` / `endpoint-policy-observation` | Docker endpoint-policy checks and the synthetic loopback probe produce configuration/test observations. Windows `.wsb` configuration disables networking, but this is configuration, not effective enforcement observation. | No production `evaluateLifecycleClaim()` caller. The result-envelope evaluator can reject untrusted output but does not authenticate network facts. | No lifecycle consumer or gate binding. | Structurally defined; raw checks exist; typed producer/consumer absent; effective enforcement unverified; not authorization eligible. |
| `processCreated` / `process-creation` | `windowsSandboxRunner.runWindowsSandboxCommand()` calls `spawn()` for the Sandbox launcher; Docker probe receives a container ID from `docker run`. | No production typed lifecycle validation. `evaluateLifecycleClaim()` is only called by tests and exposed as a Docker adapter method. | No lifecycle consumer. Runner calls `requireProjectProcessIsolation()` before spawn, which remains blocked. | Structurally defined; raw launch events exist; typed producer/consumer absent; host-authoritative verification unavailable; not authorization eligible. |
| `processTerminated` / `process-termination` | Windows runner `waitForSandboxShutdown()` observes the **launcher** PID and remaining Sandbox client PIDs; Docker probe observes container state `exited`. Neither observes a guest worker PID as a typed claim. | No production typed lifecycle validation. | Windows downstream consumes `launcherTerminated` and other raw lifecycle values in `developerFiles.applyWindowsCleanupOutcome()`. It does not consume a typed `processTerminated` claim; result-channel authentication remains hard-coded false. | Structurally defined; raw launcher/container observations exist; worker-process typed producer absent; no trusted consumer; not authorization eligible. |
| `resourceCreated` / `resource-creation` | Windows lifecycle `createResource()` creates host staging state; Docker probe records the runtime-returned container ID. | No production typed lifecycle validation. | No lifecycle consumer or gate binding. | Structurally defined; raw/resource bookkeeping exists; typed producer/consumer absent; host-authoritative verification unavailable; not authorization eligible. |
| `resourceDeleted` / `resource-deletion` | Windows shutdown callback can report `sandboxResourceAbsent`; Docker probe issues removal then inspect/list queries. | The Docker adapter exposes `evaluateLifecycle(claim, evidence, expectedContext)` and forwards explicit expected bindings. No production call site uses it; missing expected context returns `BLOCKED`; complete caller records remain `NOT_ESTABLISHED`. | Windows raw `resourceDeleted` reaches cleanup result checks, not the shared execution gate. No typed consumer. | Structurally defined; raw reports exist; typed producer absent; validator exposed but no production consumer; host-authoritative verification unavailable; not authorization eligible. |
| `stagingDirectoryRemoved` / `staging-directory-removal` | Windows lifecycle removes the temporary root and checks for absence; Docker probe removes staging and checks `stat()` for `ENOENT`. | No production typed lifecycle validation. Windows cleanup result carries `stagingDirectoryDeleted`; it is a raw operation result and now includes `evidenceState: NOT_ESTABLISHED`. | Windows `developerFiles.applyWindowsCleanupOutcome()` checks the raw field together with run ID and other conditions; unauthenticated guest result channel forces failure. No execution-gate authorization. | Structurally defined; raw post-delete checks exist; typed producer/consumer absent; no trusted verifier; not authorization eligible. |
| `sandboxHandlesReleased` / `handle-release` | Windows injected shutdown callback may report this boolean; the runner's built-in shutdown wait does not populate it. Docker has no corresponding observation. | No production typed lifecycle validation. A callback-supplied boolean is not authenticated. | Windows adapter/helper may require the field for cleanup bookkeeping; no shared-gate consumer. | Structurally defined; injected/mock producer only in helper path; production trusted producer absent; no trusted consumer; not authorization eligible. |
| `secureErasureProven` / `secure-erasure` | No producer. File and container removal are not erase evidence. | Lifecycle status is explicitly `NOT_ESTABLISHED`; structurally valid records still cannot establish it. | No consumer. | Structurally defined as unavailable; producer and consumer absent; not authorization eligible. |
| `cleanupVerified` / `cleanup-verification` | Docker combines process/container/staging/listener observations; Windows combines launcher shutdown, Sandbox absence/handles (where callback supplies them), and staging deletion. | Raw aggregate booleans are not passed to `evaluateLifecycleClaim()` in production. | Windows `applyWindowsCleanupOutcome()` consumes raw fields, but the false result-channel-authentication constant prevents success. Docker synthetic probe may report its own synthetic classification, but that is not shared-gate evidence. | Structurally defined; raw aggregate producers exist; typed producer/consumer absent; host authority unavailable; not authorization eligible. |

Actual security-sensitive call order remains: developer-files/environment
callers invoke `requireProjectProcessIsolation()`; Windows runner also invokes
it before its `spawn()`. The shared gate checks platform/status and validates
execution evidence, while the evidence contract returns
`HOST_VERIFIER_NOT_ESTABLISHED` without a trusted verifier. Provider result
collection passes caller-provided fields through untrusted classification.
No lifecycle operation bypasses this gate to authorize project execution.

`evaluateLifecycleClaim()` is directly exercised by the offline evidence
contract test and exposed through the Docker adapter; repository search found
no production call to either API. The Docker adapter method requires the
caller's expected run/provider/worker/resource context and forwards it, but
there is no production typed-evidence caller. This is intentionally an
unavailable integration, not a producer to fabricate.

The Windows lifecycle bookkeeping previously labeled launcher shutdown as
generic `processTerminated`. It now returns `launcherTerminated` separately
and marks its returned observation `evidenceState: NOT_ESTABLISHED`. The
guest/worker process termination claim has no production host observer and
therefore remains unavailable.

## Broker security review

The review found no exploitable authorization bypass in the inspected gate,
evidence contract, or Windows runner: the shared gate is unavailable and
rejects execution before the runner can launch. Structurally valid,
unauthenticated observations remain `NOT_ESTABLISHED`. The following are
implementation blockers and trust-boundary requirements, not claims that a
broker already exists:

| Rank | Area | Finding / required control | Current disposition |
| --- | --- | --- | --- |
| 1 | Process containment, network, and IPC | No broker, authenticated IPC, AppContainer/Job Object enforcement, or effective host network policy exists. An adapter or service process alone would not establish any of these properties. | Critical enablement blocker; gate remains blocked. |
| 2 | Broker identity, installation, and updates | The design names a separately installed service but does not yet define an approved signer/publisher, protected binary/configuration paths, service SID, anti-rollback policy, update authorization, or recovery from a partially applied update. | Must be specified and reviewed before IPC trusts the service. |
| 3 | IPC client authentication and authorization | A named-pipe ACL is necessary but not sufficient. The broker must verify the connecting process token and expected signed main-process identity, reject renderer/user impersonation, constrain pipe instances/remote clients, and authorize every operation against the authenticated session. The main process must likewise authenticate the service endpoint. | Must be implemented and adversarially tested before any command request is accepted. |
| 4 | Run scope, expiry, cancellation, and revocation | Human approval is not process authorization. There is no broker-issued, one-use authorization bound to a specific immutable command/snapshot, resource, expiry, and cancellation state. | Must be implemented with a single-use run protocol; denial, expiry, cancellation, or revoked session means no launch or continued execution. |
| 5 | Replay and concurrency | The in-process lifecycle ledger is neither durable nor a trust anchor. It cannot prevent replay across restarts, concurrent requests, or process races. | Require serialized per-run transitions and durable atomic nonce/sequence reservation before accepting an operation; reconcile unknown in-flight runs on restart. |
| 6 | Snapshot/path TOCTOU and cleanup | Path strings and preflight hashes can become stale between validation, copy, launch, and cleanup. Reparse points, hard links, junctions, case/normalization behavior, and directory replacement can escape naive path checks. | Open handles with reparse-point-aware checks; stage from a stable snapshot, hash the staged bytes, use broker-generated directories/ACLs, and delete only the exact broker-owned object after worker absence. |
| 7 | Least privilege and process lifecycle | AppContainer/restricted-token capability selection, Job Object assignment before resume, breakaway prevention, process identity binding, timeout, cancellation, and crash handling are not implemented. | Broker must launch suspended, assign all required restrictions before resume, retain process/job handles, enforce bounds, and quarantine any uncertain partial setup or teardown. |
| 8 | Evidence, audit, and privacy | No authenticated host observer or durable operation ledger exists. Logs can leak source paths, command arguments, environment data, or project output if not minimized. | Authenticate protocol records, retain minimal signed/bound audit metadata with access/retention controls, redact secrets, and reject incomplete or contradictory sequences. |
| 9 | Host compromise and erasure | The proposed broker still trusts the Windows kernel, service-control administrators, broker signing/update roots, and its own observer implementation. File deletion does not establish secure erasure. | Explicitly out of scope: compromised kernel/admin, broker signing-key compromise, and unsupported storage erase semantics. Secure-erasure evidence remains `NOT_ESTABLISHED`. |
| 10 | Lifecycle-state consistency | The generic resource lifecycle could delete staging and release its lease after a started run even when the shutdown callback omitted resource absence or handle-release evidence. The Windows adapter's stricter wrapper rejected this, but the underlying lifecycle contract did not enforce it. | Fixed: started-run cleanup now validates launcher PID/termination, zero remaining clients and owned processes, resource absence, handle release, and verified staging removal before releasing the lease. Failure retains quarantine and the active lease. |

### Smallest reviewable implementation sequence

Every runtime acceptance step below is a future, separately authorized Windows
test on a disposable host. Offline tests validate schemas and failure handling
only; they do not establish OS enforcement.

| Stage | Component, boundary, inputs, and privilege | Enforcement and outputs | Failure behavior | Offline tests; required Windows acceptance; exit review |
| --- | --- | --- | --- | --- |
| 0. Broker identity and packaging | Native service installer and broker binary form a separate trust domain. Release inputs include an Authenticode-signed broker, a signed release manifest, an approved publisher key policy, service configuration, and monotonic release/policy versions. Install/update is an explicit administrator action; runtime service identity is a dedicated restricted service identity, not LocalSystem by default. | Verify the package and each executable's Authenticode chain, code-signing EKU, timestamp/revocation policy, and exact authorized publisher key against a trust policy shipped with the signed client/release. Inspect the actual running service process through OS handles and SCM/service identity; do not trust process name, path string, or broker-supplied identity. Install binaries under administrator-writable-only Program Files location; keep mutable config and replay/audit state separate under service-owned ACLs. Verify signed update metadata and payload, monotonically advance a protected minimum version/policy epoch, stage and verify before atomic activation, and preserve a known-good recovery path only when an explicit signed recovery authorization permits it. | Any missing signature, unknown/rotated signer, invalid chain/EKU/timestamp, revocation uncertainty under required policy, binary/manifest mismatch, writable install path, version rollback, corrupt policy, or partial update refuses service trust and IPC; execution remains blocked. No fallback to a user-writable copy. | Offline: schema/canonicalization/version-policy tests and injected verifier outcomes; these do not test real signatures. Windows: validate release-signed artifacts, WinVerifyTrust results and pinned publisher, actual service process/token/image identity, ACLs, update authenticity, downgrade/recovery rejection, partial update recovery, and service restart behavior. Security review must approve publisher and root-key lifecycle, signer rotation, privilege list, installer/update design, and recovery before Stage 1. |
| 1. Authenticated IPC | Main-process client and broker service only; renderer never connects. Inputs are bounded, versioned frames with strict schemas, authenticated peer credentials, challenge, and protocol negotiation. Broker verifies client token plus signed application identity and binds the session to the authenticated logon SID and Windows session ID; it rejects cross-user/session reuse. Main verifies broker service identity using the connected pipe's server PID, a process handle/token and service SID, SCM service configuration, and the actual executable's pinned signature/version; no process name, self-reported metadata, or path string alone is trusted. | Local-only named pipe with restrictive DACL, remote-client rejection, impersonation-safe peer checks, per-session challenge-derived channel key, bounded framing, request IDs, and authorization on every operation. Outputs are authenticated replies tied to the active channel. Hold/revalidate OS handles to prevent PID reuse and ensure the verified file identity corresponds to the protected running image. | Wrong peer, impersonation, session switch, malformed/oversized frame, downgrade, timeout, duplicate request, or channel loss rejects and closes the session; active jobs are cancelled or quarantined, never detached to host. | Offline: parser/property tests, forged peer/identity/frame fixtures, replayed challenge, disconnect and concurrency state model. Windows: test ACL/peer identity, remote rejection, process impersonation, pipe squatting, cross-session isolation, restart, and disconnect. Security review approves peer-auth protocol and named-pipe ACL before Stage 2. |
| 2. Run request and snapshot binding | Main execution gate owns approval and exact expected context; broker independently validates it. Inputs include unpredictable run ID, project/snapshot digest, exact executable identity and argv (no shell string), working directory, environment allowlist, resource limits, broker-measured monotonic deadline/expiry, cancellation/revocation handle, and operation nonce. No added privilege beyond the broker's controlled staging access. | Broker reopens/validates a stable snapshot, rejects reparse points/unsupported path forms, copies into a broker-generated run directory, hashes staged bytes, binds all fields to one immutable manifest, and consumes authorization once. The human approval remains separate. | Changed snapshot/command, path race, duplicate run, expired/unknown approval, missing field, revoked session, or ambiguous ownership rejects before process creation; no scope expansion and no automatic retry. | Offline: schema fuzzing, digest mismatch, traversal/reparse/hard-link fixtures where safe, changed argv/env/snapshot, duplicate/expired/cancelled authorization. Windows: race/reparse-point and staged-hash tests with disposable directories. Security review approves command allowlist, path semantics, and exact approval binding before Stage 3. |
| 3. Process identity and containment | Broker creates the per-run worker and is the only process allowed to create it. Inputs are the validated manifest and run-scoped staging root. Broker needs only the OS rights necessary to create/inspect the restricted worker; avoid broad administrator privileges. | Create run-specific AppContainer/restricted token; create process suspended; configure Job Object (no breakaway, kill-on-close, active process, memory/CPU limits); assign process before resume; retain process and job handles. Output binds process creation time/PID/token SID to the run. | Token/job setup failure, assignment race, unsupported policy, timeout, or process-creation ambiguity terminates any partial job where safely possible and leaves resource quarantined; never resume unrestricted. | Offline: injected API/state-machine failures and ordering assertions. Windows: inspect token SID/integrity/privileges/capabilities, assignment-before-resume, child containment, breakaway denial, limits, cancellation, and job-close behavior. Security review approves native API sequence and least-privilege rights before Stage 4. |
| 4. Effective network policy | Broker/WFP policy is separate from guest configuration. Input is a default-deny policy bound to the run identity; any future exception must be exact and approved, not broad hostname/port inference. Policy installation needs only scoped WFP management rights. | No network capability by default plus host WFP filters bound to AppContainer SID; atomically install and verify policy before resume, monitor effective filter state while running, and remove only run-scoped filters after termination. | Filter install/verification loss, policy mutation, WFP service outage, or ambiguous endpoint state prevents launch or terminates/quarantines the run. No proxy or desktop network fallback. | Offline: policy compilation/matching and missing/contradictory state fixtures. Windows: inspect active filters and test loopback, LAN, internet, DNS, proxy, IPv4/IPv6, alternate protocols, and policy removal/race during run. Security review approves policy scope and mutation monitoring before Stage 5. |
| 5. Host-observed lifecycle and cleanup | Broker owns process/job/runtime handles and all run-scoped resource IDs; worker outputs are untrusted. Inputs are host queries, process handle signals, WFP/Job state, and broker-owned directory handles. | Emit separate observations for launcher, guest/runtime, worker, process tree, runtime resource absence, handle release, staging deletion, and cleanup. Bind each to run/resource/operation. Cleanup exact broker-owned paths only after process-tree absence; secure erase remains a separate unavailable claim. | Missing/contradictory observation, stale handle, failed deletion, broker crash, or unknown resource keeps lease active and quarantines it; deletion of a staging path never substitutes for termination/resource absence. | Offline: structural binding and cleanup order/failure fixtures. Windows: kill worker/child/broker at each stage, force handle contention, verify job empty/resource absent/exact path absent, and test restart reconciliation. Security review approves evidence source and cleanup semantics before Stage 6. |
| 6. Durable authorization, replay, audit, and recovery | Broker ledger is protected service state, separate from the Electron process and worker. Inputs are authenticated operation requests and monotonic broker sequence. Requires narrowly scoped write access to service-owned durable storage. | Atomically reserve one-use authorization, nonce, operation ID, and sequence before side effects; serialize per-run transitions; persist enough state to reject replay after restart; reconcile orphaned jobs/resources before accepting new runs. Keep minimal privacy-reviewed audit data; do not store secrets or project output by default. | Ledger corruption/unavailability, sequence conflict, service restart with uncertain active run, or audit write failure blocks new work and quarantines affected resources; never reset replay state to accept requests. | Offline: concurrent reservation, crash points, transaction/rollback, duplicate nonce/sequence, corruption and recovery model tests. Windows: kill/restart service during setup/run/cleanup, race concurrent clients, restore stale ledger snapshot, verify no duplicate execution and correct quarantine. Security review approves durability/ACL/retention/recovery before Stage 7. |
| 7. Gate integration | Electron main's shared execution gate is the only caller allowed to request a broker run; renderer receives status only. Inputs are current user approval plus independently revalidated proposal, exact plan, snapshot, and broker handshake. No adapter flag or UI capability grants authority. | Add a typed main-to-broker API only after Stages 0-6 pass; gate checks current approval/scope and authenticated broker response before any process can start. Every process-capable route must call this gate; remove no existing denial until inventory/tests prove coverage. | Any missing stage, stale approval, broker denial, IPC loss, verification failure, or unexpected status yields `BLOCKED`; no desktop-host, direct spawn, or adapter fallback. | Offline: entrypoint inventory, forged renderer/capability/preflight, missing evidence, error/cancel/timeout, and spawn-not-called assertions. Windows: end-to-end acceptance only after user authorization, independently inspect token/policy/job/teardown evidence. Final security review validates all entrypoints, deployed service identity, evidence provenance, and rollback plan before any execution policy change. |

### Trust assumptions and non-goals

The design trusts the Windows kernel and documented OS APIs to enforce token,
AppContainer, Job Object, ACL, and WFP semantics; the service-control and
machine administrators; the broker's signed build and update roots; and the
reviewed broker code to query those APIs correctly. These assumptions require
version-specific Windows testing and supply-chain controls, but cannot prove
correct behavior on a compromised host. A same-user attacker may still be
able to inject into or debug processes depending on token, mitigation, and
machine policy; this must be measured and either constrained or declared out
of scope. Do not claim resistance to kernel/admin compromise, malicious
firmware, signing-key compromise, or unsupported Windows versions.

Project snapshots and output may contain personal or proprietary data. The
broker should keep command/environment allowlists, redact secret-bearing
values, avoid recording source/output contents, constrain audit access, define
retention/deletion, and avoid crash dumps containing project memory. Secure
erasure cannot be claimed for ordinary staging deletion, SSD remapping,
copy-on-write storage, backups, snapshots, or unknown replicas. It remains
`NOT_ESTABLISHED` absent a storage-specific, independently verified erase
mechanism.

### Stage 0 identity and update decisions

**No production publisher or key is selected by this repository.** The
publisher identity, release-signing key custody, offline root policy, signer
rotation process, and revocation policy are release-owner decisions that must
be recorded and reviewed before a broker binary is built. Do not pin a
placeholder certificate, use a development/test key, or let a renderer,
broker response, environment variable, or installer command choose the
trusted publisher at runtime.

The intended policy is a dedicated broker code-signing identity whose
authorized public key (or narrowly scoped signer-certificate set) is pinned
through a signed release trust policy. Windows Authenticode verification must
validate the signature, chain, code-signing EKU, timestamp, and configured
revocation semantics; the exact signer must also match the authorized policy.
Certificate renewal is handled by a reviewed, signed overlap policy, not by
matching a display name alone. The client must be distributed from a
separately trusted signed release so an attacker cannot replace both the
broker and the policy used to trust it.

The client authenticates the broker through a local-only named-pipe connection
and OS-observed endpoint identity. It obtains the server process ID from the
pipe, opens and retains the process handle, verifies the process token's
expected service SID, checks the SCM service identity/configuration, and
verifies the actual loaded executable against the authorized signer and
signed release manifest. The service image must reside in a protected
administrator-owned install directory; a mutable user path or self-reported
image name is never sufficient. The protocol then performs a fresh challenge
bound to the authenticated pipe session before any Stage 1 request. OS
identity, signature, or image-verification ambiguity closes the pipe and
returns unavailable. PID reuse, service replacement, pipe squatting, and
image replacement between inspection and use require handle-based identity
checks and protected installation paths; a pathname-only `WinVerifyTrust`
check is insufficient on its own.

The service binary and updater metadata require separate verification:

* **Installer:** Verify the installer signature and expected publisher, then
  independently verify every installed service executable before registering
  or starting it. Install the service binary under administrator-writable-only
  Program Files; keep mutable configuration, durable authorization/replay
  state, and audit data separate under service-ACL-protected locations. Use a
  dedicated restricted service identity with only required rights and a
  service SID, not LocalSystem or user-writable executable/config paths.
* **Update:** Fetch only signed release metadata and payloads from the
  configured release channel. Verify metadata with a release root and payload
  signature plus exact digest/version before staging. Recheck signer policy,
  service identity, target path, and permissions before activation. TLS is
  transport protection, not artifact authenticity.
* **Anti-downgrade:** Persist a monotonic minimum release version and
  trust-policy epoch in service-protected state. Reject older versions,
  expired metadata, signer downgrade, and policy rollback even if an old
  artifact is correctly signed. Recovery to an older known-good binary
  requires separate signed recovery authorization with a higher policy epoch
  and exact target digest/version; never reset the monotonic counter. If
  protected state is missing, corrupt, restored from an older snapshot, or
  inaccessible, refuse broker trust and require administrator-managed
  recovery.
* **Activation and recovery:** Download and validate before touching the
  active image; install to a new protected versioned location, verify it, then
  switch service configuration atomically where supported. Preserve the
  previous known-good image and durable ledger until health checks finish. If
  update, service start, identity verification, or rollback authorization
  fails, stop/disable broker use and keep project execution blocked. Never
  silently launch a portable or user-writable broker copy.

Repository inspection found only desktop packaging configuration in
`package.json`: electron-builder targets per-user NSIS and portable artifacts;
the generic publishing URL is a placeholder; no broker service installer,
publisher pin, Authenticode signing policy, auto-updater, or anti-downgrade
state policy is defined in the checked-in configuration. This desktop package
must not be treated as a broker installer or trust anchor. External CI signing
or release policy was not inspected and is not established here.

Offline tests can validate strict release-manifest parsing, canonicalized
version ordering, malformed/unknown trust-policy rejection, duplicate signer
entries, expiry handling, and that verifier failure maps to unavailable.
Injected verification outcomes or test certificates do not prove production
publisher trust and must never be accepted by release builds. Real identity
claims require the actual release-signed installer and broker, Windows trust
verification on supported OS versions, process/token/SCM/pipe identity
inspection, protected-path ACL checks, signer rotation/revocation tests,
anti-downgrade and authorized recovery tests, and partial-update/service-crash
acceptance tests. None of those artifacts or runtime checks is available in
this stage.

**Stage 1 entry criteria:** Release owners select and document the publisher
and offline trust-root custody; a signed client and broker release policy
exist; the installer and updater enforce signatures, protected paths,
monotonic version/policy state, and fail-closed recovery; independent Windows
review verifies the actual running service image/token and signer. Only then
may Stage 1 design and offline IPC protocol tests begin. This does not authorize
project execution; later stages and their reviews remain required.

## Stage 0 readiness gate

Stage 0 is currently **NOT READY**. The repository has no production publisher
identity, release trust root, signed broker artifact, broker installer,
updater, signature policy, or anti-downgrade mechanism. This is an explicit
readiness decision, not a claim that an external release system does not
exist: external CI, certificate custody, release hosting, and organizational
signing policy were not inspected.

### Confirmed repository facts

* `package.json` identifies the desktop application as version `0.0.0` and
  configures electron-builder with `nsis` and `portable` Windows targets. The
  NSIS configuration is per-user (`perMachine: false`), allows installation
  directory changes, and is not a privileged broker installer.
* The configured generic publish URL is `https://example.invalid/ai-help-agent`.
  It is a placeholder, not an identified release channel.
* The desktop build script explicitly uses `--publish never`. The package
  manifest and repository search found no `electron-updater`/`autoUpdater`,
  Authenticode publisher pin, broker service installer, checked-in code
  signing policy, or anti-downgrade/recovery state implementation.
* Repository search found no matching `.github` workflow files or other
  checked-in release workflow/signing scripts. This is scoped to repository
  contents, not external organization or CI configuration.
* The Windows Sandbox runner resolves the inbox `WindowsSandbox.exe`; it is
  not a broker package or an installed service identity. The shared execution
  gate remains blocked. No broker authenticity or release signature has been
  verified.

### Readiness prerequisites

“Evidence” means artifacts or observed results required to close the gate.
Design documents, fixtures, injected verifier responses, self-reported fields,
and unsigned local builds are not substitutes for production release evidence.

| Prerequisite | Required evidence | Responsible party | Implementation dependency | Failure behavior / current blocker |
| --- | --- | --- | --- | --- |
| Publisher identity and trusted root | Written approval naming the legal release publisher; dedicated code-signing identity and public-key/certificate policy; offline root-key custody, access control, backup/recovery, compromise response, signer-rotation overlap, and revocation procedure. Evidence must identify which independent signed client/release policy anchors the broker signer. | Release owner and security/key-management owner | Must precede signing or verifier policy. The repository must not supply or infer the publisher. | Missing, ambiguous, revoked, or unapproved signer means reject the artifact and mark broker unavailable. **Blocked: no publisher/root selected in-repo or supplied for this task.** |
| Authenticode, timestamp, and revocation policy | A reviewed Windows verification policy defining chain building, required code-signing EKU, exact signer authorization (not display-name matching), timestamp authority/validation, revocation behavior for online/offline states, certificate renewal, and supported Windows versions; release-signed sample installer and broker artifact for acceptance. | Release owner plus Windows security reviewer | Depends on publisher/root policy; runtime client verifier and installer both need the same versioned policy. | Any signature, chain, EKU, timestamp, identity, or required revocation uncertainty fails closed. **Blocked: no signed artifacts or policy.** |
| Broker installation and protected ACLs | Reviewed install model identifying machine/per-user scope, installer privilege, service account/SID, binary/config/data paths, ACLs, service-control rights, upgrade/repair/uninstall behavior, and evidence that untrusted users cannot replace binaries or security configuration. | Windows packaging/installer owner plus security reviewer | Depends on publisher/signature verification. Runtime service identity must be selected before IPC client authentication. | Writable path, mismatched service identity, unexpected service configuration, partial install, or ACL uncertainty means do not trust/start broker. **Blocked: no broker installer, service, or ACL design tested on Windows.** |
| Signed update metadata and payloads | Authenticated release-metadata format and offline root/key policy; metadata and payload signatures/digests; channel, expiry, version, target platform/architecture, and signer binding; key-rotation and compromised-channel procedures. A release-signed update bundle must be available for acceptance. | Release engineering owner and security/key-management owner | Depends on trusted root and installed verifier. Transport TLS alone is insufficient. | Missing, expired, malformed, unsigned, digest-mismatched, wrong-channel, or unknown-signer update is rejected; current trusted image remains only if its health and policy are still verified. **Blocked: no update system or signed metadata.** |
| Anti-downgrade and recovery | Protected monotonic minimum release and policy epoch, storage/ACL design and rollback resistance assumptions; defined response to corrupted/missing/restored state; separate signed recovery authorization naming exact older artifact digest/version with a newer policy epoch; exercised recovery bundle. | Release owner, installer/update implementer, and security reviewer | Depends on signed update policy and protected service state; cannot be established by comparing version strings supplied by the broker. | Lower epoch/version, state rollback/corruption, or unsigned recovery refuses broker trust and requires controlled administrator recovery; never reset counters to recover. **Blocked: no durable state or recovery policy implemented.** |
| Client-to-broker identity verification | Protocol design and implementation for local-only named-pipe server discovery; OS-observed pipe server PID; retained process handle; token/service SID and SCM configuration checks; protected running image identity and pinned signer/version verification; fresh challenge bound to the pipe; PID-reuse and replacement defenses. Include adversarial pipe-squatting/impersonation cases. | Electron main-process/platform owner and Windows security reviewer | Depends on trusted publisher, installed service identity, and protected paths. Must be complete before Stage 1 can accept any IPC request. | Name, path, PID alone, or broker-supplied metadata is never sufficient. Any uncertainty closes the channel and leaves the broker unavailable. **Blocked: no broker process or IPC verifier.** |
| Independent Windows acceptance evidence | Test records on supported Windows versions for real release-signed binaries, WinVerifyTrust/publisher policy, service/process/token/image identity, installation ACLs, update signature, signer rotation/revocation, downgrade/recovery, partial update/service crash, and fail-closed behavior. Record OS/build, artifact hashes, signer identity, commands/results, and independent reviewer disposition without exposing secrets. | Independent Windows test owner and security reviewer | Depends on all prior prerequisites and actual signed release artifacts; requires explicit future authorization for installation/runtime tests. | Missing or inconclusive acceptance evidence means Stage 0 remains not ready and Stage 1 does not begin. **Blocked: no artifacts or runtime acceptance performed.** |

### Work that can begin without production signing credentials

After release-owner decisions define the manifest shape and version semantics,
credential-independent code may implement strict parsing/canonicalization,
schema bounds, digest and version comparisons, expiry checks, signer-policy
matching interfaces, and fail-closed state transitions behind injected
platform-verifier interfaces. Offline tests can cover malformed manifests,
unknown publishers, missing fields, invalid versions, expiry, downgrade,
corrupt state, and verifier errors. The injected verifier must always be
explicitly marked test-only and unavailable to production builds; fake keys or
test signatures must not be treated as trusted publisher evidence.

Work that can proceed now without making release-owner choices is limited to
an implementation proposal and code review checklist. Do not select a signer,
root, endpoint, certificate subject, installer mode, version counter store, or
recovery authority by inference. Do not add an apparently complete verifier
whose policy inputs are placeholders, and do not wire any identity result into
the execution gate. Existing unauthenticated host observations remain
`NOT_ESTABLISHED`.

**Stage 1 gate:** Do not begin authenticated IPC implementation until the
publisher/root, Authenticode and revocation policy, protected installation
model, signed update and recovery policy, client identity-verification design,
and independent Windows acceptance evidence above have been supplied and
reviewed. Passing offline schema tests is necessary for implementation quality
but is not sufficient to pass this gate.

## Stage 0A credential-independent validation disposition

Stage 0A review found no existing broker release-manifest parser, trust-policy
schema, version-policy module, or updater configuration to extend. The
execution-evidence manifest and lifecycle contracts describe project-run
observations, not signed software-release metadata; reusing them for publisher
trust would conflate unrelated trust domains. The shared project-execution
gate remains blocked and is not a consumer of Stage 0A validation.

No new parser or policy code is added in Stage 0A because its authoritative
input contract is not yet defined. In particular, choosing a schema version,
publisher identifier representation, release-channel value, artifact
platform/architecture vocabulary, signature-envelope format, SemVer/build
precedence semantics, timestamp/revocation behavior, or source of the
minimum-version baseline would be a security policy decision, not neutral
parsing work. Guessing those values would create a misleading implementation
that could appear production-ready while trusting an unapproved format.

Before credential-independent validator implementation can begin, the release
owner and security reviewer must approve a versioned, canonical specification
covering:

1. Required manifest and trust-policy fields, exact JSON/canonicalization
   rules, duplicate/unknown field behavior, size/depth limits, and supported
   schema versions.
2. Publisher identity as a cryptographic identifier (not a display name),
   signer-key/certificate representation, signer rotation and overlap, and
   the independently signed policy that anchors the publisher.
3. Artifact digest algorithm, digest encoding, product/component identity,
   platform and architecture values, release channel, and exact binding of
   metadata to installer/broker bytes.
4. Version syntax and ordering: release version versus policy epoch, treatment
   of prerelease/build metadata, equality/reinstall behavior, and how a
   strictly newer signed recovery authorization may permit a previously
   released binary without lowering the policy epoch.
5. Expiry and clock-skew handling, Authenticode timestamp requirements,
   revocation behavior when Windows is offline or revocation status is
   unknown, and the distinction between metadata expiry and artifact
   signature validity.
6. The authoritative minimum-version/policy-epoch store, its owner and
   protection/rollback assumptions, and fail-closed behavior when it is
   absent, corrupt, inaccessible, or restored from backup.
7. Typed status/reason codes separating structural validity, trust-policy
   match, cryptographic verification, installed-image identity, and update
   authorization. Structural parsing alone must return no authenticity or
   readiness claim.

Once this contract is approved, safe implementation can proceed without the
production private key: a pure parser/schema validator, canonical field
normalizer, version/epoch comparator, and state-transition evaluator can
consume verifier outcomes as explicit typed inputs. The production adapter
must call the real Windows trust-verification implementation and remain
unavailable if it is absent or errors. Offline tests may inject outcomes to
prove parser and fail-closed state transitions, but those fixtures must be
clearly structural/model tests and must never emit `signatureVerified`,
`publisherTrusted`, `installedBinaryAuthentic`, or `updateSafe` as facts.
No fake certificate/key, mock signature verifier, default trust root, or
test-only pass path may ship in production.

The Stage 0A test plan after specification approval is: (a) parser tests for
missing, malformed, duplicate, unknown, oversized, and unsupported-version
fields; (b) structural/trust status separation tests for absent publisher/root
and unverified signature; (c) ordering tests for lower/equal/higher release
and policy versions, including missing/corrupt baseline and authorized
recovery; and (d) state-machine tests proving caller-supplied success claims,
expiry, verifier error, revocation uncertainty, or inconsistent artifact
digests never yield readiness. Test these without importing process-launch or
network code. Actual Authenticode, certificate chain, revocation, installation
ACL, service identity, update, and recovery properties require genuine
release-signed artifacts and independent Windows acceptance; offline tests
cannot establish them.

**Disposition:** Documentation and test-plan work only is safe before those
decisions. Stage 0A policy code is not yet safely implementable from current
repository inputs. Stage 1 IPC remains explicitly prohibited until Stage 0's
readiness prerequisites and this Stage 0A contract have been reviewed and
accepted. Missing or unauthenticated host observations continue to be
`NOT_ESTABLISHED`.
