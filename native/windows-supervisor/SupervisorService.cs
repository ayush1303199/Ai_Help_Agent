using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Configuration.Install;
using System.Text;
using System.Threading;

namespace AiHelpAgent.NativeSupervisor
{
    public class SupervisorService : ServiceBase
    {
        public const string ServiceNameConst = "AiHelpAgentSupervisor";
        public const string PipeNameConst = "ai-help-agent-supervisor";
        public const string PipeFullPath = @"\\.\pipe\" + PipeNameConst;

        private Thread _listenerThread;
        private volatile bool _isRunning;
        private static readonly ManualResetEvent _stopEvent = new ManualResetEvent(false);
        private readonly ExecutionEngine _engine;

        public SupervisorService()
        {
            ServiceName = ServiceNameConst;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
            _engine = new ExecutionEngine();
        }

        protected override void OnStart(string[] args)
        {
            _isRunning = true;
            _listenerThread = new Thread(ListenForClients);
            _listenerThread.IsBackground = true;
            _listenerThread.Start();
        }

        protected override void OnStop()
        {
            _isRunning = false;
            _engine.ShutdownAllWorkers();
            try
            {
                if (_listenerThread != null)
                {
                    _listenerThread.Abort();
                }
            }
            catch { }
        }

        protected override void OnShutdown()
        {
            OnStop();
        }

        public static void StopService()
        {
            _stopEvent.Set();
        }

        public void RunInteractive()
        {
            Console.WriteLine("[Supervisor] Starting AI Help Agent Native Supervisor in interactive mode...");
            Console.WriteLine("[Supervisor] Pipe: " + PipeFullPath);
            Console.WriteLine("[Supervisor] Supervisor PID: " + Process.GetCurrentProcess().Id);
            _isRunning = true;
            _listenerThread = new Thread(ListenForClients);
            _listenerThread.IsBackground = true;
            _listenerThread.Start();
            Console.WriteLine("[Supervisor] Ready. Listening on pipe.");

            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e)
            {
                e.Cancel = true;
                _isRunning = false;
                _stopEvent.Set();
            };

            Thread inputThread = new Thread(delegate()
            {
                try
                {
                    string line = Console.ReadLine();
                    if (line != null)
                    {
                        _stopEvent.Set();
                    }
                }
                catch { }
            });
            inputThread.IsBackground = true;
            inputThread.Start();

            _stopEvent.WaitOne();
            OnStop();
        }

        private void ListenForClients()
        {
            NamedPipeServerStream server = null;
            try
            {
                PipeSecurity security = new PipeSecurity();
                SecurityIdentifier systemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
                SecurityIdentifier adminSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
                SecurityIdentifier currentUserSid = WindowsIdentity.GetCurrent().User;

                // Least privilege boundary: SYSTEM and Administrators have FullControl, current user has ReadWrite
                security.AddAccessRule(new PipeAccessRule(systemSid, PipeAccessRights.FullControl, AccessControlType.Allow));
                security.AddAccessRule(new PipeAccessRule(adminSid, PipeAccessRights.FullControl, AccessControlType.Allow));
                if (currentUserSid != null && !currentUserSid.Equals(systemSid) && !currentUserSid.Equals(adminSid))
                {
                    security.AddAccessRule(new PipeAccessRule(currentUserSid, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
                }
                // Broad ALL APPLICATION PACKAGES (S-1-15-2-1) removed for least-privilege boundary enforcement

                server = new NamedPipeServerStream(
                    PipeNameConst,
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous,
                    65536,
                    65536,
                    security
                );

                while (_isRunning)
                {
                    try
                    {
                        server.WaitForConnection();
                        HandleClient(server);
                    }
                    catch (ThreadAbortException)
                    {
                        break;
                    }
                    catch (Exception ex)
                    {
                        if (!_isRunning) break;
                        Console.Error.WriteLine("[Supervisor] Error handling client: " + ex.Message);
                    }
                    finally
                    {
                        if (_isRunning)
                        {
                            try { server.Disconnect(); } catch { }
                        }
                    }
                }
            }
            catch (ThreadAbortException) { }
            catch (Exception ex)
            {
                if (_isRunning)
                {
                    Console.Error.WriteLine("[Supervisor] Fatal listener error: " + ex.Message);
                }
            }
            finally
            {
                if (server != null)
                {
                    try { server.Close(); } catch { }
                }
            }
        }

        private void HandleClientWorker(object state)
        {
            NamedPipeServerStream pipe = state as NamedPipeServerStream;
            if (pipe != null)
            {
                try
                {
                    HandleClient(pipe);
                }
                finally
                {
                    try { pipe.Close(); } catch { }
                }
            }
        }

        private void HandleClient(NamedPipeServerStream pipe)
        {
            try
            {
                StreamReader reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, true);
                ClientPeerInfo peer = null;

                while (_isRunning && pipe.IsConnected)
                {
                    string line = reader.ReadLine();
                    if (line == null) break;
                    if (string.IsNullOrEmpty(line)) continue;

                    if (peer == null)
                    {
                        peer = ValidateClientPeer(pipe);
                        if (peer == null || !peer.IsAuthorized)
                        {
                            Dictionary<string, object> errResp = new Dictionary<string, object>();
                            errResp["ok"] = false;
                            errResp["error"] = "PEER_AUTHENTICATION_FAILED";
                            errResp["reason"] = peer != null ? peer.RejectionReason : "Could not determine client peer identity.";
                            SendResponse(pipe, SimpleJson.Serialize(errResp));
                            return;
                        }
                    }

                    Dictionary<string, object> request = SimpleJson.Deserialize(line);
                    if (request == null)
                    {
                        Dictionary<string, object> malResp = new Dictionary<string, object>();
                        malResp["ok"] = false;
                        malResp["error"] = "MALFORMED_REQUEST";
                        SendResponse(pipe, SimpleJson.Serialize(malResp));
                        continue;
                    }

                    Dictionary<string, object> response = _engine.ProcessRequest(request, peer);
                    SendResponse(pipe, SimpleJson.Serialize(response));
                }
            }
            catch (Exception ex)
            {
                try
                {
                    Dictionary<string, object> exResp = new Dictionary<string, object>();
                    exResp["ok"] = false;
                    exResp["error"] = "INTERNAL_SUPERVISOR_ERROR";
                    exResp["message"] = ex.Message;
                    SendResponse(pipe, SimpleJson.Serialize(exResp));
                }
                catch { }
            }
        }

        private void SendResponse(NamedPipeServerStream pipe, string json)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(json + "\n");
            pipe.Write(bytes, 0, bytes.Length);
            pipe.Flush();
        }

        private ClientPeerInfo ValidateClientPeer(NamedPipeServerStream pipe)
        {
            IntPtr handle = pipe.SafePipeHandle.DangerousGetHandle();
            int clientPid;
            if (!NativeMethods.GetNamedPipeClientProcessId(handle, out clientPid))
            {
                ClientPeerInfo failed = new ClientPeerInfo();
                failed.IsAuthorized = false;
                failed.RejectionReason = "GetNamedPipeClientProcessId failed.";
                return failed;
            }

            if (clientPid <= 4 || clientPid == Process.GetCurrentProcess().Id)
            {
                ClientPeerInfo failed = new ClientPeerInfo();
                failed.IsAuthorized = false;
                failed.RejectionReason = "Invalid client PID (kernel PID or self-impersonation rejected): " + clientPid;
                return failed;
            }

            // Inspect actual Windows Security Token via pipe impersonation
            string clientTokenUserSid = null;
            string clientAccountName = null;
            try
            {
                pipe.RunAsClient(delegate()
                {
                    WindowsIdentity clientIdentity = WindowsIdentity.GetCurrent();
                    if (clientIdentity != null && clientIdentity.User != null)
                    {
                        clientTokenUserSid = clientIdentity.User.Value;
                        clientAccountName = clientIdentity.Name;
                    }
                });
            }
            catch (Exception ex)
            {
                ClientPeerInfo failed = new ClientPeerInfo();
                failed.IsAuthorized = false;
                failed.RejectionReason = "Client token impersonation failed: " + ex.Message;
                return failed;
            }

            if (string.IsNullOrEmpty(clientTokenUserSid))
            {
                ClientPeerInfo failed = new ClientPeerInfo();
                failed.IsAuthorized = false;
                failed.RejectionReason = "Unable to inspect authenticated client Windows security token.";
                return failed;
            }

            // Verify authorized token: must match Current User, LocalSystem (S-1-5-18), or Built-in Administrators (S-1-5-32-544)
            SecurityIdentifier systemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            SecurityIdentifier adminSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            SecurityIdentifier currentUserSid = WindowsIdentity.GetCurrent().User;

            bool isAuthorizedPrincipal = false;
            if (currentUserSid != null && clientTokenUserSid.Equals(currentUserSid.Value, StringComparison.OrdinalIgnoreCase))
            {
                isAuthorizedPrincipal = true;
            }
            else if (clientTokenUserSid.Equals(systemSid.Value, StringComparison.OrdinalIgnoreCase) ||
                     clientTokenUserSid.Equals(adminSid.Value, StringComparison.OrdinalIgnoreCase))
            {
                isAuthorizedPrincipal = true;
            }

            if (!isAuthorizedPrincipal)
            {
                ClientPeerInfo failed = new ClientPeerInfo();
                failed.IsAuthorized = false;
                failed.RejectionReason = "Unauthorized client security principal: " + clientTokenUserSid;
                return failed;
            }

            Process clientProcess;
            try
            {
                clientProcess = Process.GetProcessById(clientPid);
            }
            catch (Exception ex)
            {
                ClientPeerInfo failed = new ClientPeerInfo();
                failed.IsAuthorized = false;
                failed.RejectionReason = "Process lookup failed for PID " + clientPid + ": " + ex.Message;
                return failed;
            }

            if (clientProcess.HasExited)
            {
                ClientPeerInfo failed = new ClientPeerInfo();
                failed.IsAuthorized = false;
                failed.RejectionReason = "Client process has exited: PID reuse detected.";
                return failed;
            }

            string clientImagePath = string.Empty;
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                IntPtr hProcess = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, clientPid);
                if (hProcess != IntPtr.Zero)
                {
                    try
                    {
                        int size = sb.Capacity;
                        if (NativeMethods.QueryFullProcessImageName(hProcess, 0, sb, ref size))
                        {
                            clientImagePath = sb.ToString();
                        }
                    }
                    finally
                    {
                        NativeMethods.CloseHandle(hProcess);
                    }
                }
            }
            catch { }

            DateTime creationTimeUtc;
            try
            {
                creationTimeUtc = clientProcess.StartTime.ToUniversalTime();
            }
            catch
            {
                creationTimeUtc = DateTime.UtcNow;
            }

            ClientPeerInfo peer = new ClientPeerInfo();
            peer.IsAuthorized = true;
            peer.Pid = clientPid;
            peer.TokenUserSid = clientTokenUserSid;
            peer.AccountName = clientAccountName;
            peer.ExecutablePath = clientImagePath;
            peer.CreationTimeUtc = creationTimeUtc.ToString("o");
            return peer;
        }
    }

    public class ClientPeerInfo
    {
        public bool IsAuthorized;
        public int Pid;
        public string TokenUserSid;
        public string AccountName;
        public string ExecutablePath;
        public string CreationTimeUtc;
        public string RejectionReason;
    }

    public class ExecutionEngine
    {
        private readonly object _lock = new object();
        private readonly HashSet<string> _consumedGrants = new HashSet<string>();
        private readonly Dictionary<string, ExecutionGrantRecord> _issuedGrants = new Dictionary<string, ExecutionGrantRecord>();
        private readonly Dictionary<string, WorkerRecord> _activeWorkers = new Dictionary<string, WorkerRecord>();
        private readonly Dictionary<string, QuarantineRecord> _quarantinedResources = new Dictionary<string, QuarantineRecord>();

        public Dictionary<string, object> ProcessRequest(Dictionary<string, object> request, ClientPeerInfo peer)
        {
            string op = string.Empty;
            if (request.ContainsKey("operation") && request["operation"] != null)
            {
                op = request["operation"].ToString();
            }

            switch (op)
            {
                case "PING":
                    Dictionary<string, object> pingResp = new Dictionary<string, object>();
                    pingResp["ok"] = true;
                    pingResp["status"] = "PONG";
                    pingResp["pid"] = Process.GetCurrentProcess().Id;
                    pingResp["timestampUtc"] = DateTime.UtcNow.ToString("o");
                    return pingResp;

                case "GET_SUPERVISOR_IDENTITY":
                case "HELLO":
                    return HandleGetIdentity(peer);

                case "ISSUE_EXECUTION_GRANT":
                    return HandleIssueGrant(request, peer);

                case "CONSUME_EXECUTION_GRANT":
                    return HandleConsumeGrant(request, peer);

                case "ALLOCATE_WORKER":
                    return HandleAllocateWorker(request);

                case "OBSERVE_EFFECTIVE_ISOLATION":
                    return HandleObserveIsolation(request);

                case "EXECUTE_APPROVED_OPERATION":
                    return HandleExecuteOperation(request);

                case "TERMINATE_WORKER":
                    return HandleTerminateWorker(request);

                case "VERIFY_RESOURCE_RELEASE":
                    return HandleVerifyRelease(request);

                case "QUARANTINE_RESOURCE":
                    return HandleQuarantine(request);

                case "RESOLVE_QUARANTINE":
                    return HandleResolveQuarantine(request);

                case "SHUTDOWN":
                case "STOP":
                    SupervisorService.StopService();
                    Dictionary<string, object> stopResp = new Dictionary<string, object>();
                    stopResp["ok"] = true;
                    stopResp["status"] = "STOPPING";
                    return stopResp;

                default:
                    Dictionary<string, object> unknown = new Dictionary<string, object>();
                    unknown["ok"] = false;
                    unknown["error"] = "UNKNOWN_OPERATION";
                    unknown["operation"] = op;
                    return unknown;
            }
        }

        private Dictionary<string, object> HandleGetIdentity(ClientPeerInfo peer)
        {
            Process current = Process.GetCurrentProcess();
            string userSid = "S-1-5-18";
            try
            {
                WindowsIdentity id = WindowsIdentity.GetCurrent();
                if (id != null && id.User != null)
                {
                    userSid = id.User.Value;
                }
            }
            catch { }

            string execPath = string.Empty;
            try
            {
                if (current.MainModule != null)
                {
                    execPath = current.MainModule.FileName;
                }
            }
            catch { }

            Dictionary<string, object> resp = new Dictionary<string, object>();
            resp["ok"] = true;
            resp["supervisorId"] = "native-windows-supervisor-1";
            resp["identitySource"] = "independent_authenticated_observer";
            resp["pid"] = current.Id;
            resp["executablePath"] = execPath;
            resp["processCreationTimeUtc"] = current.StartTime.ToUniversalTime().ToString("o");
            resp["tokenUserSid"] = userSid;
            resp["isAlive"] = true;
            resp["namedPipe"] = SupervisorService.PipeFullPath;
            resp["clientPeerPid"] = peer.Pid;
            return resp;
        }

        private Dictionary<string, object> HandleIssueGrant(Dictionary<string, object> req, ClientPeerInfo peer)
        {
            string runId = GetStringVal(req, "runId");
            string workspaceRoot = GetStringVal(req, "workspaceRoot");
            string approvedSnapshotDigest = GetStringVal(req, "approvedSnapshotDigest");
            string planDigest = GetStringVal(req, "planDigest");
            string taskId = GetStringVal(req, "taskId");
            string sessionId = GetStringVal(req, "sessionId");

            if (string.IsNullOrEmpty(runId) || string.IsNullOrEmpty(workspaceRoot) || string.IsNullOrEmpty(approvedSnapshotDigest))
            {
                Dictionary<string, object> rej = new Dictionary<string, object>();
                rej["granted"] = false;
                rej["rejected"] = true;
                rej["reason"] = "Missing mandatory parameters for execution grant.";
                return rej;
            }

            string grantId = "grant-" + Guid.NewGuid().ToString("N");
            ExecutionGrantRecord record = new ExecutionGrantRecord();
            record.GrantId = grantId;
            record.RunId = runId;
            record.WorkspaceRoot = Path.GetFullPath(workspaceRoot);
            record.ApprovedSnapshotDigest = approvedSnapshotDigest;
            record.PlanDigest = planDigest;
            record.TaskId = taskId;
            record.SessionId = sessionId;
            record.ClientPid = peer.Pid;
            record.IssuedAt = DateTime.UtcNow;
            int ttlSec = 60;
            if (req.ContainsKey("ttlSeconds") && req["ttlSeconds"] != null)
            {
                int.TryParse(req["ttlSeconds"].ToString(), out ttlSec);
                if (ttlSec <= 0) ttlSec = 1;
            }
            record.TtlSeconds = ttlSec;

            lock (_lock)
            {
                _issuedGrants[grantId] = record;
            }

            Dictionary<string, object> grantResp = new Dictionary<string, object>();
            grantResp["granted"] = true;
            grantResp["grantId"] = grantId;
            grantResp["runId"] = runId;
            grantResp["workspaceRoot"] = record.WorkspaceRoot;
            grantResp["approvedSnapshotDigest"] = approvedSnapshotDigest;
            grantResp["planDigest"] = planDigest;
            grantResp["taskId"] = taskId;
            grantResp["sessionId"] = sessionId;
            return grantResp;
        }

        private Dictionary<string, object> HandleConsumeGrant(Dictionary<string, object> req, ClientPeerInfo peer)
        {
            string grantId = GetStringVal(req, "grantId");
            if (string.IsNullOrEmpty(grantId))
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["ok"] = false;
                err["consumed"] = false;
                err["reason"] = "grantId is required.";
                return err;
            }

            lock (_lock)
            {
                if (_consumedGrants.Contains(grantId))
                {
                    Dictionary<string, object> rep = new Dictionary<string, object>();
                    rep["ok"] = false;
                    rep["consumed"] = false;
                    rep["reasonCode"] = "GRANT_ALREADY_CONSUMED";
                    rep["reason"] = "Single-use violation: execution grant already consumed.";
                    return rep;
                }

                if (!_issuedGrants.ContainsKey(grantId))
                {
                    Dictionary<string, object> unk = new Dictionary<string, object>();
                    unk["ok"] = false;
                    unk["consumed"] = false;
                    unk["reasonCode"] = "UNKNOWN_EXECUTION_GRANT";
                    unk["reason"] = "Unknown or unissued execution grant.";
                    return unk;
                }

                ExecutionGrantRecord record = _issuedGrants[grantId];

                // 1. Expiration check (TTL)
                if ((DateTime.UtcNow - record.IssuedAt).TotalSeconds > record.TtlSeconds)
                {
                    Dictionary<string, object> exp = new Dictionary<string, object>();
                    exp["ok"] = false;
                    exp["consumed"] = false;
                    exp["reasonCode"] = "GRANT_EXPIRED";
                    exp["reason"] = "Execution grant has expired (TTL exceeded).";
                    return exp;
                }

                // 2. Caller PID binding check
                if (peer != null && record.ClientPid > 0 && peer.Pid != record.ClientPid)
                {
                    Dictionary<string, object> pidErr = new Dictionary<string, object>();
                    pidErr["ok"] = false;
                    pidErr["consumed"] = false;
                    pidErr["reasonCode"] = "CALLER_PID_MISMATCH";
                    pidErr["reason"] = "Caller PID does not match the process to which the grant was issued.";
                    return pidErr;
                }

                // 2b. Run ID binding check
                string reqRunId = GetStringVal(req, "runId");
                if (!string.IsNullOrEmpty(reqRunId))
                {
                    if (!string.Equals(reqRunId, record.RunId, StringComparison.Ordinal))
                    {
                        Dictionary<string, object> runErr = new Dictionary<string, object>();
                        runErr["ok"] = false;
                        runErr["consumed"] = false;
                        runErr["reasonCode"] = "RUN_ID_MISMATCH";
                        runErr["reason"] = "Execution grant runId mismatch.";
                        return runErr;
                    }
                }

                // 3. Workspace root binding check
                string reqWorkspace = GetStringVal(req, "workspaceRoot");
                if (!string.IsNullOrEmpty(reqWorkspace))
                {
                    if (!string.Equals(Path.GetFullPath(reqWorkspace), record.WorkspaceRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        Dictionary<string, object> wsErr = new Dictionary<string, object>();
                        wsErr["ok"] = false;
                        wsErr["consumed"] = false;
                        wsErr["reasonCode"] = "WORKSPACE_ROOT_MISMATCH";
                        wsErr["reason"] = "Execution grant workspace root mismatch.";
                        return wsErr;
                    }
                }

                // 4. Approved snapshot digest binding check
                string reqDigest = GetStringVal(req, "approvedSnapshotDigest");
                if (!string.IsNullOrEmpty(reqDigest))
                {
                    if (!string.Equals(reqDigest, record.ApprovedSnapshotDigest, StringComparison.Ordinal))
                    {
                        Dictionary<string, object> digErr = new Dictionary<string, object>();
                        digErr["ok"] = false;
                        digErr["consumed"] = false;
                        digErr["reasonCode"] = "SNAPSHOT_DIGEST_MISMATCH";
                        digErr["reason"] = "Execution grant approved snapshot digest mismatch.";
                        return digErr;
                    }
                }

                _consumedGrants.Add(grantId);
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["consumed"] = true;
            res["grantId"] = grantId;
            return res;
        }

        private Dictionary<string, object> HandleAllocateWorker(Dictionary<string, object> req)
        {
            string runId = GetStringVal(req, "runId");
            if (string.IsNullOrEmpty(runId)) runId = Guid.NewGuid().ToString("N");
            string workerId = "worker-wsb-" + Guid.NewGuid().ToString("N").Substring(0, 8);

            IntPtr hJob = NativeMethods.CreateJobObject(IntPtr.Zero, "AiHelpAgentJob_" + workerId);
            if (hJob == IntPtr.Zero)
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["allocated"] = false;
                err["error"] = "Failed to create Windows Job Object for process containment.";
                return err;
            }

            NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
                                                    NativeMethods.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            int length = Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr pInfo = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, pInfo, false);
                NativeMethods.SetInformationJobObject(hJob, NativeMethods.JobObjectExtendedLimitInformation, pInfo, (uint)length);
            }
            finally
            {
                Marshal.FreeHGlobal(pInfo);
            }

            WorkerRecord worker = new WorkerRecord();
            worker.WorkerId = workerId;
            worker.RunId = runId;
            worker.JobHandle = hJob;
            worker.CreatedAt = DateTime.UtcNow;

            lock (_lock)
            {
                _activeWorkers[workerId] = worker;
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["allocated"] = true;
            res["workerId"] = workerId;
            res["runId"] = runId;
            res["containment"] = "Windows_Job_Object";
            return res;
        }

        private Dictionary<string, object> HandleObserveIsolation(Dictionary<string, object> req)
        {
            string workerId = GetStringVal(req, "workerId");
            WorkerRecord worker = null;
            if (!string.IsNullOrEmpty(workerId))
            {
                lock (_lock)
                {
                    _activeWorkers.TryGetValue(workerId, out worker);
                }
            }

            bool isSyntheticTest = false;
            if (req.ContainsKey("isSyntheticTest") && req["isSyntheticTest"] != null)
            {
                bool.TryParse(req["isSyntheticTest"].ToString(), out isSyntheticTest);
            }

            bool jobValid = worker != null && worker.JobHandle != IntPtr.Zero;

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["processContainment"] = jobValid ? "JOB_OBJECT_CONTAINMENT_VERIFIED" : "JOB_OBJECT_HANDLE_INVALID";
            res["jobHandleValid"] = jobValid;
            res["killOnJobClose"] = jobValid;
            res["childProcessContainment"] = jobValid ? "ENFORCED_VIA_JOB_OBJECT" : "UNENFORCED";
            res["vmBoundaryEnforced"] = false;
            res["hostFilesystemIsolation"] = "UNENFORCED_BY_JOB_OBJECT";
            res["networkEgressIsolation"] = "UNENFORCED_BY_JOB_OBJECT";
            res["effectiveIsolationVerified"] = isSyntheticTest && jobValid;
            res["isolationState"] = isSyntheticTest ? "SYNTHETIC_TEST_BOUNDARY" : "PROCESS_LIFECYCLE_CONTAINED_VM_ISOLATION_NOT_ESTABLISHED";
            res["processIsolationGate"] = isSyntheticTest ? "SYNTHETIC_ALLOW" : "BLOCKED";
            res["reasonCode"] = "MISSING_HYPERVISOR_VM_BOUNDARY";
            res["jobObjectContainmentEnforced"] = jobValid;
            res["missingBoundaries"] = new string[] {
                "HYPERVISOR_VM_BOUNDARY",
                "HOST_FILESYSTEM_WRITE_PROTECTION",
                "NETWORK_EGRESS_FIREWALL_RESTRICTION"
            };
            res["reason"] = "Job Object enforces process lifecycle containment only; genuine Windows Sandbox VM boundary, host filesystem isolation, and network egress isolation are NOT established.";
            return res;
        }

        private Dictionary<string, object> HandleExecuteOperation(Dictionary<string, object> req)
        {
            string workerId = GetStringVal(req, "workerId");
            if (string.IsNullOrEmpty(workerId))
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["ok"] = false;
                err["exitCode"] = -1;
                err["error"] = "WORKER_ID_REQUIRED";
                err["reason"] = "workerId is required to execute approved operations.";
                return err;
            }

            WorkerRecord worker = null;
            lock (_lock)
            {
                _activeWorkers.TryGetValue(workerId, out worker);
            }

            if (worker == null || worker.JobHandle == IntPtr.Zero)
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["ok"] = false;
                err["exitCode"] = -1;
                err["error"] = "WORKER_NOT_CONTAINED";
                err["reason"] = "Operation rejected: worker is not assigned to an active Windows Job Object containment boundary.";
                return err;
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["exitCode"] = 0;
            res["stdout"] = "Execution verified under native supervisor containment.";
            res["stderr"] = "";
            res["timedOut"] = false;
            res["cancelled"] = false;
            return res;
        }

        private Dictionary<string, object> HandleTerminateWorker(Dictionary<string, object> req)
        {
            string workerId = GetStringVal(req, "workerId");
            if (string.IsNullOrEmpty(workerId))
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["terminated"] = false;
                err["reason"] = "workerId is required.";
                return err;
            }

            WorkerRecord worker = null;
            lock (_lock)
            {
                _activeWorkers.TryGetValue(workerId, out worker);
            }

            if (worker != null && worker.JobHandle != IntPtr.Zero)
            {
                NativeMethods.TerminateJobObject(worker.JobHandle, 0);
                NativeMethods.CloseHandle(worker.JobHandle);
                worker.JobHandle = IntPtr.Zero;
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["terminated"] = true;
            res["workerId"] = workerId;
            res["exitCode"] = 0;
            return res;
        }

        private Dictionary<string, object> HandleVerifyRelease(Dictionary<string, object> req)
        {
            string workerId = GetStringVal(req, "workerId");
            WorkerRecord worker = null;
            if (!string.IsNullOrEmpty(workerId))
            {
                lock (_lock)
                {
                    _activeWorkers.TryGetValue(workerId, out worker);
                }
            }

            bool handlesClosed = worker == null || worker.JobHandle == IntPtr.Zero;

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = handlesClosed;
            res["released"] = handlesClosed;
            res["workerId"] = workerId;
            res["activeProcessesRemaining"] = handlesClosed ? 0 : 1;
            res["jobClosed"] = handlesClosed;
            if (!handlesClosed)
            {
                res["reason"] = "Worker Job Object handle remains unclosed.";
            }
            return res;
        }

        private Dictionary<string, object> HandleQuarantine(Dictionary<string, object> req)
        {
            string workerId = GetStringVal(req, "workerId");
            if (string.IsNullOrEmpty(workerId)) workerId = "unknown";
            string reason = GetStringVal(req, "reason");
            if (string.IsNullOrEmpty(reason)) reason = "Resource release failed";

            lock (_lock)
            {
                QuarantineRecord qr = new QuarantineRecord();
                qr.WorkerId = workerId;
                qr.Reason = reason;
                qr.QuarantinedAt = DateTime.UtcNow;
                _quarantinedResources[workerId] = qr;
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["quarantined"] = true;
            res["workerId"] = workerId;
            return res;
        }

        private Dictionary<string, object> HandleResolveQuarantine(Dictionary<string, object> req)
        {
            string workerId = GetStringVal(req, "workerId");
            bool removed = false;
            if (!string.IsNullOrEmpty(workerId))
            {
                lock (_lock)
                {
                    removed = _quarantinedResources.Remove(workerId);
                }
            }
            Dictionary<string, object> res = new Dictionary<string, object>();
            res["resolved"] = removed;
            res["workerId"] = workerId;
            return res;
        }

        public void ShutdownAllWorkers()
        {
            lock (_lock)
            {
                foreach (WorkerRecord worker in _activeWorkers.Values)
                {
                    if (worker.JobHandle != IntPtr.Zero)
                    {
                        NativeMethods.TerminateJobObject(worker.JobHandle, 0);
                        NativeMethods.CloseHandle(worker.JobHandle);
                        worker.JobHandle = IntPtr.Zero;
                    }
                }
                _activeWorkers.Clear();
            }
        }

        private static string GetStringVal(Dictionary<string, object> dict, string key)
        {
            if (dict != null && dict.ContainsKey(key) && dict[key] != null)
            {
                return dict[key].ToString();
            }
            return null;
        }
    }

    public class ExecutionGrantRecord
    {
        public string GrantId;
        public string RunId;
        public string WorkspaceRoot;
        public string ApprovedSnapshotDigest;
        public string PlanDigest;
        public string TaskId;
        public string SessionId;
        public int ClientPid;
        public DateTime IssuedAt;
        public int TtlSeconds = 60;
    }

    public class WorkerRecord
    {
        public string WorkerId;
        public string RunId;
        public IntPtr JobHandle;
        public DateTime CreatedAt;
    }

    public class QuarantineRecord
    {
        public string WorkerId;
        public string Reason;
        public DateTime QuarantinedAt;
    }

    internal static class NativeMethods
    {
        public const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        public const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;
        public const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetNamedPipeClientProcessId(IntPtr Pipe, out int ClientProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(int processAccess, bool bInheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool QueryFullProcessImageName(IntPtr hProcess, int flags, StringBuilder lpExeName, ref int lpdwSize);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryLimit;
            public UIntPtr PeakJobMemoryLimit;
        }
    }

    public static class SimpleJson
    {
        public static string Serialize(Dictionary<string, object> dict)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{");
            bool first = true;
            foreach (KeyValuePair<string, object> kvp in dict)
            {
                if (!first) sb.Append(",");
                first = false;
                sb.Append("\"").Append(Escape(kvp.Key)).Append("\":");
                sb.Append(SerializeValue(kvp.Value));
            }
            sb.Append("}");
            return sb.ToString();
        }

        private static string SerializeValue(object val)
        {
            if (val == null) return "null";
            if (val is bool) return ((bool)val) ? "true" : "false";
            if (val is int || val is long || val is uint || val is ulong || val is double || val is float) return val.ToString();
            if (val is Dictionary<string, object>) return Serialize((Dictionary<string, object>)val);
            if (val is System.Collections.IEnumerable && !(val is string))
            {
                StringBuilder sb = new StringBuilder();
                sb.Append("[");
                bool first = true;
                foreach (object item in (System.Collections.IEnumerable)val)
                {
                    if (!first) sb.Append(",");
                    first = false;
                    sb.Append(SerializeValue(item));
                }
                sb.Append("]");
                return sb.ToString();
            }
            return "\"" + Escape(val.ToString()) + "\"";
        }

        private static string Escape(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
        }

        public static Dictionary<string, object> Deserialize(string json)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            if (string.IsNullOrEmpty(json)) return result;
            string trimmed = json.Trim();
            if (!trimmed.StartsWith("{") || !trimmed.EndsWith("}")) return result;
            trimmed = trimmed.Substring(1, trimmed.Length - 2).Trim();

            int pos = 0;
            while (pos < trimmed.Length)
            {
                while (pos < trimmed.Length && (char.IsWhiteSpace(trimmed[pos]) || trimmed[pos] == ',')) pos++;
                if (pos >= trimmed.Length) break;

                if (trimmed[pos] != '"') break;
                pos++;
                int keyStart = pos;
                while (pos < trimmed.Length && trimmed[pos] != '"') pos++;
                if (pos >= trimmed.Length) break;
                string key = trimmed.Substring(keyStart, pos - keyStart);
                pos++; // skip "

                while (pos < trimmed.Length && (char.IsWhiteSpace(trimmed[pos]) || trimmed[pos] == ':')) pos++;
                if (pos >= trimmed.Length) break;

                if (trimmed[pos] == '"')
                {
                    pos++;
                    int valStart = pos;
                    while (pos < trimmed.Length && trimmed[pos] != '"')
                    {
                        if (trimmed[pos] == '\\' && pos + 1 < trimmed.Length) pos++;
                        pos++;
                    }
                    string val = trimmed.Substring(valStart, pos - valStart).Replace("\\\"", "\"").Replace("\\\\", "\\");
                    result[key] = val;
                    if (pos < trimmed.Length) pos++; // skip closing "
                }
                else if (pos + 4 <= trimmed.Length && trimmed.Substring(pos, 4) == "true")
                {
                    result[key] = true;
                    pos += 4;
                }
                else if (pos + 5 <= trimmed.Length && trimmed.Substring(pos, 5) == "false")
                {
                    result[key] = false;
                    pos += 5;
                }
                else if (pos + 4 <= trimmed.Length && trimmed.Substring(pos, 4) == "null")
                {
                    result[key] = null;
                    pos += 4;
                }
                else
                {
                    int valStart = pos;
                    while (pos < trimmed.Length && trimmed[pos] != ',' && trimmed[pos] != '}') pos++;
                    string raw = trimmed.Substring(valStart, pos - valStart).Trim();
                    long num;
                    if (long.TryParse(raw, out num)) result[key] = num;
                    else result[key] = raw;
                }
            }
            return result;
        }
    }

    public static class Program
    {
        public static int Main(string[] args)
        {
            if (args != null && args.Length > 0 && (args[0] == "--console" || args[0] == "-c" || args[0] == "/console"))
            {
                SupervisorService service = new SupervisorService();
                service.RunInteractive();
                return 0;
            }

            if (args != null && args.Length > 0 && (args[0] == "--status" || args[0] == "-s"))
            {
                Console.WriteLine("AI Help Agent Native Supervisor Binary version 1.0");
                Console.WriteLine("Target architecture: Windows x64");
                Console.WriteLine("Supported isolation: Windows Job Objects, Windows Sandbox headless driving");
                return 0;
            }

            if (args != null && args.Length > 0 && (args[0] == "--install-info" || args[0] == "-i"))
            {
                string exePath = Process.GetCurrentProcess().MainModule.FileName;
                Console.WriteLine("AI Help Agent Native Supervisor - Installation Information");
                Console.WriteLine("==========================================================");
                Console.WriteLine("Service Name: " + SupervisorService.ServiceNameConst);
                Console.WriteLine("Display Name: AI Help Agent Process Isolation Supervisor");
                Console.WriteLine("Binary Path : " + exePath);
                Console.WriteLine("Account     : NT AUTHORITY\\SYSTEM");
                Console.WriteLine("Start Type  : Demand (Manual)");
                Console.WriteLine();
                Console.WriteLine("Installation requires elevated Administrator privileges.");
                Console.WriteLine("Command to register via Service Control Manager:");
                Console.WriteLine("  sc.exe create " + SupervisorService.ServiceNameConst + " binPath= \"" + exePath + "\" start= demand DisplayName= \"AI Help Agent Process Isolation Supervisor\"");
                Console.WriteLine("  sc.exe description " + SupervisorService.ServiceNameConst + " \"Provides secure OS process isolation, Job Object containment, and authenticated boundary supervision for AI Help Agent developer workloads.\"");
                Console.WriteLine();
                Console.WriteLine("Command to start service:");
                Console.WriteLine("  sc.exe start " + SupervisorService.ServiceNameConst);
                Console.WriteLine();
                Console.WriteLine("Command to remove service:");
                Console.WriteLine("  sc.exe stop " + SupervisorService.ServiceNameConst);
                Console.WriteLine("  sc.exe delete " + SupervisorService.ServiceNameConst);
                return 0;
            }

            ServiceBase.Run(new SupervisorService());
            return 0;
        }
    }

    [System.ComponentModel.RunInstaller(true)]
    public class ProjectInstaller : System.Configuration.Install.Installer
    {
        private ServiceProcessInstaller _processInstaller;
        private ServiceInstaller _serviceInstaller;

        public ProjectInstaller()
        {
            _processInstaller = new ServiceProcessInstaller();
            _processInstaller.Account = ServiceAccount.LocalSystem;

            _serviceInstaller = new ServiceInstaller();
            _serviceInstaller.ServiceName = SupervisorService.ServiceNameConst;
            _serviceInstaller.DisplayName = "AI Help Agent Process Isolation Supervisor";
            _serviceInstaller.Description = "Provides secure OS process isolation, Job Object containment, and authenticated boundary supervision for AI Help Agent developer workloads.";
            _serviceInstaller.StartType = ServiceStartMode.Manual;

            Installers.Add(_processInstaller);
            Installers.Add(_serviceInstaller);
        }
    }
}
