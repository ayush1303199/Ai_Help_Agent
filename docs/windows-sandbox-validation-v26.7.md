# Milestone V26.7 — Windows Sandbox Validation & Boundary Assessment (Fail-Closed)

## Executive Summary
This document records the empirical findings of the **Milestone V26.7** Windows Sandbox evaluation. The objective was to determine whether Windows Sandbox can serve as an OS-enforced execution boundary for the AI Help Agent coding agent without weakening fail-closed isolation or enabling unverified host execution.

**Final Determination: BLOCKED (Fail-Closed).**
While `WindowsSandbox.exe` is physically present on Windows 11 Pro, optional-feature verification requires administrative elevation, and Windows Sandbox natively lacks a headless host-observed execution lifecycle. In accordance with milestone requirements, all Windows project execution remains strictly fail-closed. Target project `C:\Users\Admin\Downloads\Hello` was not executed.

---

## 1. Host Capability Discovery Evidence

Read-only inspection was conducted from an unprivileged user context without modifying system policy, installing software, or executing project commands:

| Capability / Prerequisite | Observed Value | Status | Evidence Source |
| :--- | :--- | :---: | :--- |
| **OS Edition & Build** | Microsoft Windows 11 Pro 64-bit (10.0.26200) | **VERIFIED** | `Win32_OperatingSystem` query |
| **Windows Sandbox Executable** | `C:\Windows\System32\WindowsSandbox.exe` (v10.0.26100.1) | **VERIFIED** | File existence & FileVersionInfo |
| **HV Host Service (`HvHost`)** | `Running` (Manual start) | **VERIFIED** | `Get-Service HvHost` |
| **Hyper-V Compute (`vmcompute`)** | `Running` (Manual start) | **VERIFIED** | `Get-Service vmcompute` |
| **Sandbox Feature State** | `Containers-DisposableClientVM` | **UNVERIFIED** | DISM query failed: requires elevation (`0x80070005`) |
| **Headless CLI Supervisor** | Native headless pipe / stdout redirection | **UNSUPPORTED** | Win32 architecture: GUI-only desktop app |
| **Target Project Isolation** | `C:\Users\Admin\Downloads\Hello` | **BLOCKED** | Fail-closed gate enforced in `projectProcessIsolation.cjs` |

### Concrete Elevation Blocker
Executing `Get-WindowsOptionalFeature -Online -FeatureName 'Containers-DisposableClientVM'` returned:
```text
Get-WindowsOptionalFeature : The requested operation requires elevation.
    + FullyQualifiedErrorId : Microsoft.Dism.Commands.GetWindowsOptionalFeatureCommand
```
Because the agent operates under standard user privileges without interactive administrative prompts, feature state cannot be authoritatively queried via DISM.

---

## 2. What Was Tested vs. What Was Not Tested

### What Was Actually Tested
1. **Host Environment Probing:** Read-only queries of OS version, build, service status (`HvHost`, `vmcompute`), and filesystem presence of `WindowsSandbox.exe`.
2. **Process Isolation Gate Invariants:** Executed `runtime_handoff_tests.mjs`, verifying that production `executeBuildPlan` unconditionally rejects unverified Windows execution with `PROCESS_ISOLATION_GATE` and ensures adapter call count is strictly `0`.
3. **Adversarial Input Immunity:** Tested that caller-supplied `plan.runtime`, `plan.selectedRuntime`, forged mock objects, or arbitrary properties are discarded.
4. **Authoritative Evidence Freshness:** Verified that provider descriptors with stale timestamps (> 5 min) in `defaultRegistry` fail closed before any adapter invocation.
5. **Pre-Execution Pipeline Guards:** Verified that unauthorized project roots (`AUTHORIZATION_GATE`), shell metacharacters (`COMMAND_SAFETY_GATE`), and missing dependencies (`DEPENDENCY_PREREQUISITE_GATE`) prevent adapter invocation.
6. **Regression Invariants:** Executed `npm run test:build-orchestrator` and `npm run test:isolation-provider` confirming complete compliance.

### What Was NOT Tested (Intentionally Blocked)
1. **Target Project Execution:** Neither `C:\Users\Admin\Downloads\Hello` nor any of its package scripts were invoked.
2. **Interactive Sandbox Launch:** `WindowsSandbox.exe` was **not launched** because launching a GUI window in an automated pipeline without an established headless attestation protocol or verified feature enablement violates fail-closed safety.
3. **Privileged System Modification:** No features were enabled via DISM, no registry keys altered, and no services reconfigured.
4. **Host Fallback Execution:** No host process execution was used as a fallback.

---

## 3. Security Boundary Verification Results

The 9 mandatory isolation contract properties were evaluated against the Windows Sandbox architectural model:

| Property | Windows Sandbox Capability | Verification Result |
| :--- | :--- | :--- |
| **1. Original Workspace Read-Only** | Supported via `.wsb` `<MappedFolder><ReadOnly>true</ReadOnly></MappedFolder>` | **Enforceable by Config** |
| **2. Disposable Staging Directory** | Host staging directory mapped into guest; destroyed on exit | **Enforceable by Host** |
| **3. Credential & Secret Scrubbing** | Guest runs in separate MicroVM under `WDAGUtilityAccount`; zero access to host DPAPI or tokens | **Enforced by Hyper-V Boundary** |
| **4. Default-Deny Networking** | Supported via `.wsb` `<Networking>Disable</Networking>` | **Enforceable by Config; Requires Guest Probe** |
| **5. Process Containment & Termination** | All guest processes die with the MicroVM | **Lacks Native Completion Notification** |
| **6. Hard Resource Limits** | Memory cap supported (`<MemoryInMB>`); **CPU quota & PID limits UNSUPPORTED** in `.wsb` | **PARTIAL / DEFICIENT** |
| **7. Artifact Allowlisting** | Mapped output folder requires host-side allowlist scanning before sync-back | **Enforceable by Host** |
| **8. Fail-Closed on Failure / Timeout** | Host supervisor must discard staging directory on non-zero exit or timeout | **Enforceable by Host** |
| **9. Audit Trail Recording** | Host records plan digest, execution receipt, and cleanup status | **Enforceable by Host** |

---

## 4. Remaining Blockers and Prerequisites

1. **Elevation Requirement for Feature Attestation:**
   Standard user accounts cannot verify whether `Containers-DisposableClientVM` is enabled in the operating system.
2. **Absence of Headless CLI Execution:**
   `WindowsSandbox.exe` is an interactive Win32 GUI application designed for human desktop use. When invoked with a `.wsb` file, it spawns a GUI window. It does not stream stdout/stderr to the calling console, nor does it return the guest command's exit code to the host parent process.
3. **Missing Resource Controls in `.wsb`:**
   Windows Sandbox configuration format does not support CPU bandwidth throttling (percentage or core quotas) or process count (PID) limits.
4. **Missing Guest-to-Host Completion Protocol:**
   Because there is no native completion signal, an automated runner must rely on polling an output directory for a guest-written completion file, followed by externally killing `WindowsSandbox.exe` via `taskkill`. If the guest command hangs, the sandbox remains open until the host deadline timer forcefully kills it.

---

## 5. Recommended Implementation Steps

To achieve genuine, automated OS-enforced isolation on Windows, the recommended architectural path is:

1. **Phase 1 — Prototype a Dedicated Headless Attestation Protocol:**
   Create a host-guest file-based IPC contract:
   - Host generates `.wsb` mapping a read-only workspace and a writable ephemeral exchange directory.
   - Guest `<LogonCommand>` executes a wrapper script that runs the command, redirects stdout/stderr to files, writes `exit_code.json`, and computes a SHA-256 digest.
   - Host supervisor watches the exchange directory, enforces a wall-clock deadline, reads the receipt, kills `WindowsSandbox.exe`, and verifies process absence.
2. **Phase 2 — Evaluate WSL 2 Container Isolation as Alternative:**
   Because `wsl.exe` is already installed and supports headless execution (`wsl.exe -d Ubuntu --exec ...`) with Linux cgroups (memory, CPU, PID limits) and network namespaces (`unshare -n`), WSL 2 offers a more native, headless isolation architecture for developer workloads on Windows than interactive Windows Sandbox.
3. **Phase 3 — Formal Independent Verification Suite:**
   Before unblocking Windows execution, implement adversarial tests verifying that network egress fails, host credentials cannot be read, and memory ceilings are strictly observed.

---

## 6. Changed Files and Final Git Status

- **Modified Files:**
  - `docs/windows-sandbox-validation-v26.7.md` (this report)
  - `electron/coding-pipeline/test/runtime_handoff_tests.mjs` (safety gate tests from V26.5 preserved)
- **Production Isolation State:**
  - `electron/coding-pipeline/projectProcessIsolation.cjs` remains strictly **BLOCKED** on Windows.
  - Target project `C:\Users\Admin\Downloads\Hello` remains completely blocked.
- **Git Status:**
  ```text
   M electron/coding-pipeline/test/runtime_handoff_tests.mjs
  ?? docs/windows-sandbox-validation-v26.7.md
  ```
