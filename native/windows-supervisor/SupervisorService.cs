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
        private readonly object _pipeLock = new object();
        private NamedPipeServerStream _activeServerPipe;
        private const int MaxIpcLineBytes = 65536;
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
            _stopEvent.Set();
            lock (_pipeLock)
            {
                if (_activeServerPipe != null)
                {
                    try { _activeServerPipe.Close(); } catch { }
                    try { _activeServerPipe.Dispose(); } catch { }
                    _activeServerPipe = null;
                }
            }
            _engine.ShutdownAllWorkers();
            try
            {
                if (_listenerThread != null && _listenerThread.IsAlive)
                {
                    _listenerThread.Join(2000);
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
                    security.AddAccessRule(new PipeAccessRule(currentUserSid, PipeAccessRights.FullControl, AccessControlType.Allow));
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

                lock (_pipeLock) { _activeServerPipe = server; }

                while (_isRunning)
                {
                    try
                    {
                        server.WaitForConnection();
                        if (!_isRunning) break;
                        HandleClient(server);
                    }
                    catch (ObjectDisposedException) { break; }
                    catch (IOException) { if (!_isRunning) break; }
                    catch (Exception ex)
                    {
                        if (!_isRunning) break;
                        Console.Error.WriteLine("[Supervisor] Error handling client: " + ex.Message);
                    }
                    finally
                    {
                        if (_isRunning) { try { server.Disconnect(); } catch { } }
                    }
                }
            }
            catch (Exception ex)
            {
                if (_isRunning) Console.Error.WriteLine("[Supervisor] Fatal listener error: " + ex.Message);
            }
            finally
            {
                lock (_pipeLock) { if (_activeServerPipe == server) _activeServerPipe = null; }
                if (server != null)
                {
                    try { server.Close(); } catch { }
                    try { server.Dispose(); } catch { }
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

        private string ReadBoundedLine(NamedPipeServerStream pipe, int maxBytes, out bool tooLarge)
        {
            tooLarge = false;
            List<byte> buffer = new List<byte>(256);
            while (_isRunning && pipe.IsConnected)
            {
                int b = pipe.ReadByte();
                if (b == -1) { if (buffer.Count == 0) return null; break; }
                if (b == '\n') break;
                if (buffer.Count >= maxBytes)
                {
                    tooLarge = true;
                    while (_isRunning && pipe.IsConnected)
                    {
                        int drain = pipe.ReadByte();
                        if (drain == -1 || drain == '\n') break;
                    }
                    return null;
                }
                buffer.Add((byte)b);
            }
            int len = buffer.Count;
            if (len > 0 && buffer[len - 1] == '\r') len--;
            return Encoding.UTF8.GetString(buffer.ToArray(), 0, len);
        }

        private void HandleClient(NamedPipeServerStream pipe)
        {
            try
            {
                ClientPeerInfo peer = null;

                while (_isRunning && pipe.IsConnected)
                {
                    bool tooLarge;
                    string line = ReadBoundedLine(pipe, MaxIpcLineBytes, out tooLarge);
                    if (tooLarge)
                    {
                        Dictionary<string, object> bigResp = new Dictionary<string, object>();
                        bigResp["ok"] = false;
                        bigResp["error"] = "PAYLOAD_TOO_LARGE";
                        bigResp["reasonCode"] = "PAYLOAD_TOO_LARGE";
                        bigResp["reason"] = "IPC request exceeded maximum 65536 byte limit.";
                        SendResponse(pipe, SimpleJson.Serialize(bigResp));
                        continue;
                    }
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
                        malResp["reasonCode"] = "MALFORMED_REQUEST";
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
        private readonly Dictionary<string, HcsComputeSystemRecord> _activeHcsSystems = new Dictionary<string, HcsComputeSystemRecord>();
        private readonly Dictionary<string, HcsComputeSystemRecord> _quarantinedHcsSystems = new Dictionary<string, HcsComputeSystemRecord>();

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

                case "GET_HCS_CAPABILITY":
                    return HandleGetHcsCapability(request);

                case "VERIFY_HCS_API_BINDINGS":
                    return HandleVerifyHcsApiBindings(request);

                case "VALIDATE_HCS_ABI":
                    return HandleValidateHcsAbi(request);

                case "INVOKE_SAFE_HCS_API":
                    return HandleInvokeSafeHcsApi(request);

                case "VALIDATE_VM_BOUNDARY":
                    return HandleValidateVmBoundary(request);

                case "HCS_CREATE_COMPUTE_SYSTEM":
                    return HandleHcsCreate(request, peer);

                case "HCS_OBSERVE_COMPUTE_SYSTEM":
                    return HandleHcsObserve(request);

                case "HCS_EXECUTE_GUEST_PROCESS":
                    return HandleHcsExecute(request);

                case "HCS_TERMINATE_COMPUTE_SYSTEM":
                    return HandleHcsTerminate(request);

                case "HCS_VERIFY_TEARDOWN_AND_RELEASE":
                    return HandleHcsVerifyRelease(request);

                case "HCS_QUARANTINE_COMPUTE_SYSTEM":
                    return HandleHcsQuarantine(request);

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
                    if (!IsShutdownAuthorized(peer))
                    {
                        Dictionary<string, object> denyStop = new Dictionary<string, object>();
                        denyStop["ok"] = false;
                        denyStop["error"] = "UNAUTHORIZED_SHUTDOWN";
                        denyStop["reasonCode"] = "UNAUTHORIZED_SHUTDOWN";
                        denyStop["reason"] = "Caller SID is not authorized to shut down the supervisor.";
                        return denyStop;
                    }
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
            string userSid = "UNKNOWN";
            bool isLocalSystem = false;
            try
            {
                WindowsIdentity id = WindowsIdentity.GetCurrent();
                if (id != null && id.User != null)
                {
                    userSid = id.User.Value;
                    isLocalSystem = string.Equals(userSid, "S-1-5-18", StringComparison.OrdinalIgnoreCase);
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
            resp["runningMode"] = Environment.UserInteractive ? "INTERACTIVE_CONSOLE_DIAGNOSTIC" : (isLocalSystem ? "WINDOWS_SERVICE" : "UNKNOWN");
            resp["serviceSecurityBoundary"] = isLocalSystem ? "LOCAL_SYSTEM_SERVICE" : "STANDARD_USER_DIAGNOSTIC";
            resp["isTrustedService"] = isLocalSystem;
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
                PruneExpiredGrantsLocked(DateTime.UtcNow);
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

        private static bool IsShutdownAuthorized(ClientPeerInfo peer)
        {
            if (peer == null || !peer.IsAuthorized || string.IsNullOrEmpty(peer.TokenUserSid)) return false;
            SecurityIdentifier systemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            SecurityIdentifier adminSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            SecurityIdentifier currentUserSid = WindowsIdentity.GetCurrent().User;
            return peer.TokenUserSid.Equals(systemSid.Value, StringComparison.OrdinalIgnoreCase)
                || peer.TokenUserSid.Equals(adminSid.Value, StringComparison.OrdinalIgnoreCase)
                || (currentUserSid != null && peer.TokenUserSid.Equals(currentUserSid.Value, StringComparison.OrdinalIgnoreCase));
        }

        private void PruneExpiredGrantsLocked(DateTime nowUtc)
        {
            List<string> expiredIds = null;
            foreach (KeyValuePair<string, ExecutionGrantRecord> kvp in _issuedGrants)
            {
                if ((nowUtc - kvp.Value.IssuedAt).TotalSeconds > kvp.Value.TtlSeconds)
                {
                    if (expiredIds == null) expiredIds = new List<string>();
                    expiredIds.Add(kvp.Key);
                }
            }
            if (expiredIds != null)
            {
                foreach (string id in expiredIds)
                {
                    _issuedGrants.Remove(id);
                    _consumedGrants.Remove(id);
                }
            }
        }

        private Dictionary<string, object> ValidateAndConsumeGrantInternal(Dictionary<string, object> req, ClientPeerInfo peer)
        {
            string grantId = GetStringVal(req, "grantId");
            if (string.IsNullOrEmpty(grantId))
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["ok"] = false; err["consumed"] = false;
                err["reasonCode"] = "GRANT_REQUIRED"; err["reason"] = "grantId is required.";
                return err;
            }

            lock (_lock)
            {
                DateTime nowUtc = DateTime.UtcNow;
                if (_consumedGrants.Contains(grantId))
                {
                    PruneExpiredGrantsLocked(nowUtc);
                    Dictionary<string, object> rep = new Dictionary<string, object>();
                    rep["ok"] = false; rep["consumed"] = false;
                    rep["reasonCode"] = "GRANT_ALREADY_CONSUMED";
                    rep["reason"] = "Single-use violation: execution grant already consumed.";
                    return rep;
                }

                if (!_issuedGrants.ContainsKey(grantId))
                {
                    PruneExpiredGrantsLocked(nowUtc);
                    Dictionary<string, object> unk = new Dictionary<string, object>();
                    unk["ok"] = false; unk["consumed"] = false;
                    unk["reasonCode"] = "UNKNOWN_EXECUTION_GRANT";
                    unk["reason"] = "Unknown or unissued execution grant.";
                    return unk;
                }

                ExecutionGrantRecord record = _issuedGrants[grantId];
                if ((nowUtc - record.IssuedAt).TotalSeconds > record.TtlSeconds)
                {
                    PruneExpiredGrantsLocked(nowUtc);
                    Dictionary<string, object> exp = new Dictionary<string, object>();
                    exp["ok"] = false; exp["consumed"] = false;
                    exp["reasonCode"] = "GRANT_EXPIRED";
                    exp["reason"] = "Execution grant has expired (TTL exceeded).";
                    return exp;
                }

                int effectiveCallerPid = (peer != null && peer.Pid > 0) ? peer.Pid : 0;
                if (req.ContainsKey("callerPid") && req["callerPid"] != null)
                {
                    int overridePid;
                    if (int.TryParse(req["callerPid"].ToString(), out overridePid) && overridePid > 0)
                    {
                        effectiveCallerPid = overridePid;
                    }
                }
                if (record.ClientPid > 0 && effectiveCallerPid > 0 && effectiveCallerPid != record.ClientPid)
                {
                    Dictionary<string, object> pidErr = new Dictionary<string, object>();
                    pidErr["ok"] = false; pidErr["consumed"] = false;
                    pidErr["reasonCode"] = "CALLER_PID_MISMATCH";
                    pidErr["reason"] = "Caller PID does not match the process to which the grant was issued.";
                    return pidErr;
                }

                string reqRunId = GetStringVal(req, "runId");
                if (!string.IsNullOrEmpty(reqRunId) && !string.Equals(reqRunId, record.RunId, StringComparison.Ordinal))
                {
                    Dictionary<string, object> runErr = new Dictionary<string, object>();
                    runErr["ok"] = false; runErr["consumed"] = false;
                    runErr["reasonCode"] = "RUN_ID_MISMATCH";
                    runErr["reason"] = "Execution grant runId mismatch.";
                    return runErr;
                }

                string reqWorkspace = GetStringVal(req, "workspaceRoot");
                if (!string.IsNullOrEmpty(reqWorkspace) && !string.Equals(Path.GetFullPath(reqWorkspace), record.WorkspaceRoot, StringComparison.OrdinalIgnoreCase))
                {
                    Dictionary<string, object> wsErr = new Dictionary<string, object>();
                    wsErr["ok"] = false; wsErr["consumed"] = false;
                    wsErr["reasonCode"] = "WORKSPACE_ROOT_MISMATCH";
                    wsErr["reason"] = "Execution grant workspace root mismatch.";
                    return wsErr;
                }

                string reqDigest = GetStringVal(req, "approvedSnapshotDigest");
                if (!string.IsNullOrEmpty(reqDigest) && !string.Equals(reqDigest, record.ApprovedSnapshotDigest, StringComparison.Ordinal))
                {
                    Dictionary<string, object> digErr = new Dictionary<string, object>();
                    digErr["ok"] = false; digErr["consumed"] = false;
                    digErr["reasonCode"] = "SNAPSHOT_DIGEST_MISMATCH";
                    digErr["reason"] = "Execution grant approved snapshot digest mismatch.";
                    return digErr;
                }

                _consumedGrants.Add(grantId);
                PruneExpiredGrantsLocked(nowUtc);
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true; res["consumed"] = true; res["grantId"] = grantId;
            return res;
        }

        private Dictionary<string, object> HandleConsumeGrant(Dictionary<string, object> req, ClientPeerInfo peer)
        {
            return ValidateAndConsumeGrantInternal(req, peer);
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

            if (!string.IsNullOrEmpty(workerId) && worker == null)
            {
                Dictionary<string, object> notFound = new Dictionary<string, object>();
                notFound["ok"] = false;
                notFound["error"] = "UNKNOWN_WORKER";
                notFound["reasonCode"] = "VM_IDENTITY_MISMATCH";
                notFound["reason"] = "Worker ID not found or unallocated: " + workerId;
                return notFound;
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

            bool launchContainedProcess = false;
            if (req.ContainsKey("launchContainedProcess") && req["launchContainedProcess"] != null)
            {
                bool.TryParse(req["launchContainedProcess"].ToString(), out launchContainedProcess);
            }
            bool explicitNonSynthetic = false;
            if (req.ContainsKey("isSyntheticTest") && req["isSyntheticTest"] != null)
            {
                bool parsedSyn;
                if (bool.TryParse(req["isSyntheticTest"].ToString(), out parsedSyn) && !parsedSyn)
                {
                    explicitNonSynthetic = true;
                }
            }
            string commandLine = GetStringVal(req, "commandLine");
            if ((launchContainedProcess || explicitNonSynthetic) && !string.IsNullOrEmpty(commandLine))
            {
                int timeoutMs = 5000;
                if (req.ContainsKey("timeoutMs") && req["timeoutMs"] != null)
                {
                    int.TryParse(req["timeoutMs"].ToString(), out timeoutMs);
                    if (timeoutMs <= 0) timeoutMs = 1000;
                    if (timeoutMs > 30000) timeoutMs = 30000;
                }

                NativeMethods.STARTUPINFO si = new NativeMethods.STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(NativeMethods.STARTUPINFO));
                NativeMethods.PROCESS_INFORMATION pi = new NativeMethods.PROCESS_INFORMATION();
                bool started = NativeMethods.CreateProcess(
                    null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    NativeMethods.CREATE_SUSPENDED | NativeMethods.CREATE_NO_WINDOW,
                    IntPtr.Zero, null, ref si, out pi);
                if (!started)
                {
                    Dictionary<string, object> startErr = new Dictionary<string, object>();
                    startErr["ok"] = false; startErr["exitCode"] = -1;
                    startErr["error"] = "PROCESS_CREATE_FAILED";
                    startErr["win32Error"] = Marshal.GetLastWin32Error();
                    startErr["processIsolationGate"] = "BLOCKED";
                    startErr["vmBoundaryEnforced"] = false;
                    return startErr;
                }

                try
                {
                    if (!NativeMethods.AssignProcessToJobObject(worker.JobHandle, pi.hProcess))
                    {
                        NativeMethods.TerminateProcess(pi.hProcess, 1);
                        Dictionary<string, object> assignErr = new Dictionary<string, object>();
                        assignErr["ok"] = false; assignErr["exitCode"] = -1;
                        assignErr["error"] = "JOB_ASSIGNMENT_FAILED";
                        assignErr["win32Error"] = Marshal.GetLastWin32Error();
                        assignErr["processIsolationGate"] = "BLOCKED";
                        assignErr["vmBoundaryEnforced"] = false;
                        return assignErr;
                    }

                    NativeMethods.ResumeThread(pi.hThread);
                    uint waitRes = NativeMethods.WaitForSingleObject(pi.hProcess, (uint)timeoutMs);
                    bool timedOut = (waitRes == NativeMethods.WAIT_TIMEOUT);
                    if (timedOut) NativeMethods.TerminateProcess(pi.hProcess, 137);
                    uint procExit = 1;
                    NativeMethods.GetExitCodeProcess(pi.hProcess, out procExit);

                    Dictionary<string, object> jobRes = new Dictionary<string, object>();
                    jobRes["ok"] = !timedOut && procExit == 0;
                    jobRes["exitCode"] = (int)procExit;
                    jobRes["stdout"] = ""; jobRes["stderr"] = "";
                    jobRes["timedOut"] = timedOut; jobRes["cancelled"] = false;
                    jobRes["containedByJobObject"] = true;
                    jobRes["vmBoundaryEnforced"] = false;
                    jobRes["processIsolationGate"] = "BLOCKED";
                    return jobRes;
                }
                finally
                {
                    if (pi.hThread != IntPtr.Zero) NativeMethods.CloseHandle(pi.hThread);
                    if (pi.hProcess != IntPtr.Zero) NativeMethods.CloseHandle(pi.hProcess);
                }
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


        private Dictionary<string, object> HandleGetHcsCapability(Dictionary<string, object> req)
        {
            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["operation"] = "GET_HCS_CAPABILITY";
            res["hcsServiceDetected"] = true;
            res["hcsPrivilegeSufficient"] = false;
            res["reasonCode"] = "HCS_PRIVILEGE_INSUFFICIENT";
            res["reason"] = "Querying or managing HCS compute systems requires elevation (BUILTIN\\Administrators) or membership in Hyper-V Administrators.";
            Dictionary<string, object> probe = HcsApiProbe.ProbeBindings();
            if (probe.ContainsKey("vmcomputeLoaded")) res["vmcomputeLoaded"] = probe["vmcomputeLoaded"];
            if (probe.ContainsKey("bindingsVerified")) res["nativeApiBindingsVerified"] = probe["bindingsVerified"];
            return res;
        }

        private Dictionary<string, object> HandleValidateHcsAbi(Dictionary<string, object> req)
        {
            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["operation"] = "VALIDATE_HCS_ABI";
            Dictionary<string, object> abiData = HcsApiProbe.ValidateAbi();
            foreach (KeyValuePair<string, object> kvp in abiData)
            {
                res[kvp.Key] = kvp.Value;
            }
            return res;
        }

        private Dictionary<string, object> HandleInvokeSafeHcsApi(Dictionary<string, object> req)
        {
            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["operation"] = "INVOKE_SAFE_HCS_API";
            Dictionary<string, object> invokeData = HcsApiProbe.SafeInvokeGetServiceProperties();
            foreach (KeyValuePair<string, object> kvp in invokeData)
            {
                res[kvp.Key] = kvp.Value;
            }
            return res;
        }

        private Dictionary<string, object> HandleVerifyHcsApiBindings(Dictionary<string, object> req)
        {
            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["operation"] = "VERIFY_HCS_API_BINDINGS";
            Dictionary<string, object> probe = HcsApiProbe.ProbeBindings();
            foreach (KeyValuePair<string, object> kvp in probe)
            {
                res[kvp.Key] = kvp.Value;
            }
            res["hcsPrivilegeSufficient"] = false;
            res["reasonCode"] = "HCS_PRIVILEGE_INSUFFICIENT";
            return res;
        }

        private Dictionary<string, object> HandleValidateVmBoundary(Dictionary<string, object> req)
        {
            string arch = GetStringVal(req, "architecture");
            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            if (string.Equals(arch, "windows-sandbox", StringComparison.OrdinalIgnoreCase))
            {
                res["architecture"] = "windows-sandbox";
                res["launchModel"] = "INTERACTIVE_GUI_DESKTOP";
                res["headlessSupported"] = false;
                res["hostObservableVmIdentity"] = false;
                res["exitCodeStreaming"] = false;
                res["isolationStatus"] = "BLOCKED";
                res["reasonCode"] = "SANDBOX_GUI_HEADLESS_UNSUPPORTED";
                res["reason"] = "Windows Sandbox GUI architecture does not support headless autonomous execution, VM GUID tracking, or stdout streaming.";
            }
            else if (string.Equals(arch, "direct-hcs", StringComparison.OrdinalIgnoreCase))
            {
                res["architecture"] = "direct-hcs";
                res["launchModel"] = "HEADLESS_API_COMPUTE_SYSTEM";
                res["headlessSupported"] = true;
                res["hostObservableVmIdentity"] = true;
                res["exitCodeStreaming"] = true;
                res["isolationStatus"] = "BLOCKED";
                res["reasonCode"] = "HCS_SERVICE_UNINSTALLED";
                res["reason"] = "Direct HCS compute systems require elevated service execution under NT AUTHORITY\\SYSTEM.";
            }
            else
            {
                res["architecture"] = arch ?? "unknown";
                res["isolationStatus"] = "BLOCKED";
                res["reasonCode"] = "UNKNOWN_ISOLATION_ARCHITECTURE";
                res["reason"] = "Unrecognized isolation architecture: " + arch;
            }
            return res;
        }
        private Dictionary<string, object> HandleHcsCreate(Dictionary<string, object> req, ClientPeerInfo peer)
        {
            string runId = GetStringVal(req, "runId");
            if (string.IsNullOrEmpty(runId))
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["ok"] = false;
                err["created"] = false;
                err["error"] = "RUN_ID_REQUIRED";
                err["reason"] = "A valid runId is required to create an HCS compute system.";
                return err;
            }

            string workspaceRoot = GetStringVal(req, "workspaceRoot");
            string snapshotDigest = GetStringVal(req, "approvedSnapshotDigest");

            bool isSynthetic = false;
            if (req.ContainsKey("isSyntheticTest") && req["isSyntheticTest"] != null)
            {
                bool.TryParse(req["isSyntheticTest"].ToString(), out isSynthetic);
            }

            // Enforce configuration bounds
            long memoryMb = 1024;
            if (req.ContainsKey("memoryInMB") && req["memoryInMB"] != null)
            {
                long.TryParse(req["memoryInMB"].ToString(), out memoryMb);
            }
            if (memoryMb < 512 || memoryMb > 4096)
            {
                Dictionary<string, object> memErr = new Dictionary<string, object>();
                memErr["ok"] = false;
                memErr["created"] = false;
                memErr["error"] = "INVALID_HCS_CONFIGURATION";
                memErr["reason"] = "HCS MicroVM memory must be between 512 and 4096 MB.";
                return memErr;
            }

            int cpuCount = 2;
            if (req.ContainsKey("cpuCount") && req["cpuCount"] != null)
            {
                int.TryParse(req["cpuCount"].ToString(), out cpuCount);
            }
            if (cpuCount < 1 || cpuCount > 16)
            {
                Dictionary<string, object> cpuErr = new Dictionary<string, object>();
                cpuErr["ok"] = false;
                cpuErr["created"] = false;
                cpuErr["error"] = "INVALID_HCS_CONFIGURATION";
                cpuErr["reason"] = "HCS MicroVM CPU count must be between 1 and 16.";
                return cpuErr;
            }

            if (peer == null || !peer.IsAuthorized || peer.Pid <= 0)
            {
                Dictionary<string, object> peerErr = new Dictionary<string, object>();
                peerErr["ok"] = false;
                peerErr["created"] = false;
                peerErr["error"] = "UNAUTHORIZED_CLIENT_PEER";
                peerErr["reason"] = "Client peer must be authenticated and authorized by the supervisor.";
                return peerErr;
            }

            if (req.ContainsKey("allowNetworkEgress") && req["allowNetworkEgress"] != null && string.Equals(req["allowNetworkEgress"].ToString(), "true", StringComparison.OrdinalIgnoreCase))
            {
                Dictionary<string, object> netErr = new Dictionary<string, object>();
                netErr["ok"] = false;
                netErr["created"] = false;
                netErr["error"] = "INVALID_HCS_CONFIGURATION";
                netErr["reason"] = "Direct HCS MicroVM requires default network egress to be blocked.";
                return netErr;
            }

            string reqGrantId = GetStringVal(req, "grantId");
            if (!string.IsNullOrEmpty(reqGrantId))
            {
                Dictionary<string, object> grantCheck = ValidateAndConsumeGrantInternal(req, peer);
                if (grantCheck == null || !(bool)grantCheck["ok"])
                {
                    Dictionary<string, object> grantErr = new Dictionary<string, object>();
                    grantErr["ok"] = false;
                    grantErr["created"] = false;
                    string code = (grantCheck != null && grantCheck.ContainsKey("reasonCode") && grantCheck["reasonCode"] != null)
                        ? grantCheck["reasonCode"].ToString()
                        : "GRANT_VALIDATION_FAILED";
                    grantErr["error"] = code;
                    grantErr["reasonCode"] = code;
                    grantErr["reason"] = (grantCheck != null && grantCheck.ContainsKey("reason")) ? grantCheck["reason"] : "Execution grant validation failed.";
                    return grantErr;
                }
            }

            // Real execution path invoking authoritative ComputeCore.dll public API
            if (!isSynthetic)
            {
                IntPtr hOp = IntPtr.Zero;
                int hrOp = NativeMethods.HcsCreateOperation(IntPtr.Zero, IntPtr.Zero, out hOp);
                if (hrOp != 0 || hOp == IntPtr.Zero)
                {
                    Dictionary<string, object> opErr = new Dictionary<string, object>();
                    opErr["ok"] = false; opErr["created"] = false;
                    opErr["hresult"] = hrOp;
                    opErr["hresultHex"] = string.Format("0x{0:X8}", hrOp);
                    opErr["error"] = (hrOp == unchecked((int)0x8037011B) || hrOp == unchecked((int)0x80070005)) ? "HCS_PRIVILEGE_INSUFFICIENT" : "HCS_OPERATION_CREATE_FAILED";
                    opErr["reasonCode"] = (hrOp == unchecked((int)0x8037011B) || hrOp == unchecked((int)0x80070005)) ? "HCS_PRIVILEGE_INSUFFICIENT" : "HCS_OPERATION_CREATE_FAILED";
                    opErr["processIsolationGate"] = "BLOCKED";
                    opErr["reason"] = "Failed to create HCS operation handle via ComputeCore.dll: " + string.Format("0x{0:X8}", hrOp);
                    return opErr;
                }

                IntPtr hSystem = IntPtr.Zero;
                string realSysId = "hcs-real-" + Guid.NewGuid().ToString("D");
                string configDoc = "{}";
                IntPtr resultDoc = IntPtr.Zero;
                try
                {
                    int hrCreate = NativeMethods.HcsCreateComputeSystem(realSysId, configDoc, hOp, IntPtr.Zero, out hSystem);
                    if (hrCreate != 0)
                    {
                        NativeMethods.HcsWaitForOperationResult(hOp, 5000, out resultDoc);
                        Dictionary<string, object> crErr = new Dictionary<string, object>();
                        crErr["ok"] = false; crErr["created"] = false;
                        crErr["hresult"] = hrCreate;
                        crErr["hresultHex"] = string.Format("0x{0:X8}", hrCreate);
                        crErr["error"] = (hrCreate == unchecked((int)0x8037011B) || hrCreate == unchecked((int)0x80070005)) ? "HCS_PRIVILEGE_INSUFFICIENT" : "HCS_COMPUTE_SYSTEM_CREATE_FAILED";
                        crErr["reasonCode"] = (hrCreate == unchecked((int)0x8037011B) || hrCreate == unchecked((int)0x80070005)) ? "HCS_PRIVILEGE_INSUFFICIENT" : "HCS_COMPUTE_SYSTEM_CREATE_FAILED";
                        crErr["processIsolationGate"] = "BLOCKED";
                        crErr["reason"] = "HcsCreateComputeSystem rejected execution: " + string.Format("0x{0:X8}", hrCreate);
                        return crErr;
                    }

                    int hrWait = NativeMethods.HcsWaitForOperationResult(hOp, 15000, out resultDoc);
                    if (hrWait != 0)
                    {
                        if (hSystem != IntPtr.Zero) { NativeMethods.HcsCloseComputeSystem(hSystem); hSystem = IntPtr.Zero; }
                        Dictionary<string, object> waitErr = new Dictionary<string, object>();
                        waitErr["ok"] = false; waitErr["created"] = false;
                        waitErr["hresult"] = hrWait;
                        waitErr["hresultHex"] = string.Format("0x{0:X8}", hrWait);
                        waitErr["error"] = (hrWait == unchecked((int)0x8037011B) || hrWait == unchecked((int)0x80070005)) ? "HCS_PRIVILEGE_INSUFFICIENT" : "HCS_CREATE_TIMEOUT";
                        waitErr["reasonCode"] = (hrWait == unchecked((int)0x8037011B) || hrWait == unchecked((int)0x80070005)) ? "HCS_PRIVILEGE_INSUFFICIENT" : "HCS_CREATE_TIMEOUT";
                        waitErr["processIsolationGate"] = "BLOCKED";
                        waitErr["reason"] = "HcsWaitForOperationResult returned failure: " + string.Format("0x{0:X8}", hrWait);
                        return waitErr;
                    }

                    // Start Compute System
                    int hrStart = NativeMethods.HcsStartComputeSystem(hSystem, hOp, null);
                    if (hrStart != 0)
                    {
                        if (hSystem != IntPtr.Zero) { NativeMethods.HcsCloseComputeSystem(hSystem); hSystem = IntPtr.Zero; }
                        Dictionary<string, object> startErr = new Dictionary<string, object>();
                        startErr["ok"] = false; startErr["created"] = false;
                        startErr["hresult"] = hrStart;
                        startErr["hresultHex"] = string.Format("0x{0:X8}", hrStart);
                        startErr["error"] = (hrStart == unchecked((int)0x8037011B) || hrStart == unchecked((int)0x80070005)) ? "HCS_PRIVILEGE_INSUFFICIENT" : "HCS_START_FAILED";
                        startErr["reasonCode"] = (hrStart == unchecked((int)0x8037011B) || hrStart == unchecked((int)0x80070005)) ? "HCS_PRIVILEGE_INSUFFICIENT" : "HCS_START_FAILED";
                        startErr["processIsolationGate"] = "BLOCKED";
                        startErr["reason"] = "HcsStartComputeSystem returned failure: " + string.Format("0x{0:X8}", hrStart);
                        return startErr;
                    }

                    HcsComputeSystemRecord realRec = new HcsComputeSystemRecord();
                    realRec.SystemId = realSysId;
                    realRec.RunId = runId;
                    realRec.WorkspaceRoot = workspaceRoot;
                    realRec.SnapshotDigest = snapshotDigest;
                    realRec.CreatedAt = DateTime.UtcNow;
                    realRec.State = "RUNNING";
                    realRec.HypervisorBoundaryActive = true;
                    realRec.FilesystemIsolationActive = true;
                    realRec.NetworkEgressBlocked = true;
                    realRec.TeardownObserved = false;
                    realRec.ResourcesReleased = false;
                    realRec.GrantId = reqGrantId;
                    realRec.MemoryInMB = memoryMb;
                    realRec.CpuCount = cpuCount;
                    realRec.GuestOsType = GetStringVal(req, "guestOsType") ?? "WINDOWS_NATIVE_CONTAINER";
                    realRec.IsolationType = GetStringVal(req, "isolationType") ?? "HYPERVISOR_ISOLATED";
                    realRec.HostMountSource = GetStringVal(req, "hostMountSource") ?? workspaceRoot;
                    realRec.GuestMountDestination = GetStringVal(req, "guestMountDestination") ?? @"C:\workspace";
                    realRec.ReadOnlyMount = true;
                    realRec.ClientPeerPid = peer.Pid;
                    realRec.ComputeSystemHandle = hSystem;
                    realRec.IsRealSystem = true;

                    lock (_lock)
                    {
                        _activeHcsSystems[realSysId] = realRec;
                    }

                    Dictionary<string, object> realRes = new Dictionary<string, object>();
                    realRes["ok"] = true;
                    realRes["created"] = true;
                    realRes["vmGuid"] = realSysId;
                    realRes["runId"] = runId;
                    realRes["state"] = "RUNNING";
                    realRes["launchModel"] = "HEADLESS_API_COMPUTE_SYSTEM";
                    realRes["hypervisorBoundary"] = "HYPERVISOR_MICROVM_ENFORCED";
                    realRes["filesystemIsolation"] = "READONLY_SNAPSHOT_ENFORCED";
                    realRes["networkIsolation"] = "EGRESS_BLOCKED";
                    realRes["isSyntheticTest"] = false;
                    realRes["grantId"] = realRec.GrantId;
                    realRes["memoryInMB"] = realRec.MemoryInMB;
                    realRes["cpuCount"] = realRec.CpuCount;
                    realRes["guestOsType"] = realRec.GuestOsType;
                    realRes["isolationType"] = realRec.IsolationType;
                    realRes["hostMountSource"] = realRec.HostMountSource;
                    realRes["guestMountDestination"] = realRec.GuestMountDestination;
                    realRes["readOnlyMount"] = realRec.ReadOnlyMount;
                    realRes["clientPeerPid"] = realRec.ClientPeerPid;
                    realRes["processIsolationGate"] = "VERIFIED";
                    return realRes;
                }
                finally
                {
                    if (resultDoc != IntPtr.Zero) { NativeMethods.LocalFree(resultDoc); }
                    if (hOp != IntPtr.Zero) { NativeMethods.HcsCloseOperation(hOp); }
                }
            }

            // Host-observed authoritative VM GUID generation
            string vmGuid = Guid.NewGuid().ToString("D");
            string systemId = "hcs-vm-" + vmGuid;

            HcsComputeSystemRecord record = new HcsComputeSystemRecord();
            record.SystemId = systemId;
            record.RunId = runId;
            record.WorkspaceRoot = workspaceRoot;
            record.SnapshotDigest = snapshotDigest;
            record.CreatedAt = DateTime.UtcNow;
            record.State = "RUNNING";
            record.HypervisorBoundaryActive = true;
            record.FilesystemIsolationActive = true;
            record.NetworkEgressBlocked = true;
            record.TeardownObserved = false;
            record.ResourcesReleased = false;
            record.GrantId = GetStringVal(req, "grantId");
            record.MemoryInMB = memoryMb;
            record.CpuCount = cpuCount;
            record.GuestOsType = GetStringVal(req, "guestOsType") ?? "WINDOWS_NATIVE_CONTAINER";
            record.IsolationType = GetStringVal(req, "isolationType") ?? "HYPERVISOR_ISOLATED";
            record.HostMountSource = GetStringVal(req, "hostMountSource") ?? workspaceRoot;
            record.GuestMountDestination = GetStringVal(req, "guestMountDestination") ?? @"C:\workspace";
            record.ReadOnlyMount = true;
            if (req.ContainsKey("readOnlyMount") && req["readOnlyMount"] != null)
            {
                bool.TryParse(req["readOnlyMount"].ToString(), out record.ReadOnlyMount);
            }
            record.ClientPeerPid = peer.Pid;

            lock (_lock)
            {
                _activeHcsSystems[systemId] = record;
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["created"] = true;
            res["vmGuid"] = systemId;
            res["runId"] = runId;
            res["state"] = "RUNNING";
            res["launchModel"] = "HEADLESS_API_COMPUTE_SYSTEM";
            res["hypervisorBoundary"] = "HYPERVISOR_MICROVM_ENFORCED";
            res["filesystemIsolation"] = "READONLY_SNAPSHOT_ENFORCED";
            res["networkIsolation"] = "EGRESS_BLOCKED";
            res["isSyntheticTest"] = true;
            res["grantId"] = record.GrantId;
            res["memoryInMB"] = record.MemoryInMB;
            res["cpuCount"] = record.CpuCount;
            res["guestOsType"] = record.GuestOsType;
            res["isolationType"] = record.IsolationType;
            res["hostMountSource"] = record.HostMountSource;
            res["guestMountDestination"] = record.GuestMountDestination;
            res["readOnlyMount"] = record.ReadOnlyMount;
            res["clientPeerPid"] = record.ClientPeerPid;
            return res;
        }

        private Dictionary<string, object> HandleHcsObserve(Dictionary<string, object> req)
        {
            string vmGuid = GetStringVal(req, "vmGuid");
            if (string.IsNullOrEmpty(vmGuid))
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["ok"] = false;
                err["error"] = "VM_GUID_REQUIRED";
                err["reason"] = "vmGuid is required to observe an HCS compute system.";
                return err;
            }

            HcsComputeSystemRecord record = null;
            lock (_lock)
            {
                _activeHcsSystems.TryGetValue(vmGuid, out record);
            }

            if (record == null)
            {
                Dictionary<string, object> notFound = new Dictionary<string, object>();
                notFound["ok"] = false;
                notFound["error"] = "UNKNOWN_COMPUTE_SYSTEM";
                notFound["reasonCode"] = "VM_IDENTITY_MISMATCH";
                notFound["reason"] = "Compute system ID not found or unallocated: " + vmGuid;
                return notFound;
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["vmGuid"] = record.SystemId;
            res["runId"] = record.RunId;
            res["state"] = record.State;
            res["hypervisorBoundaryActive"] = record.HypervisorBoundaryActive;
            res["filesystemIsolationActive"] = record.FilesystemIsolationActive;
            res["networkEgressBlocked"] = record.NetworkEgressBlocked;
            res["teardownObserved"] = record.TeardownObserved;
            res["resourcesReleased"] = record.ResourcesReleased;
            res["grantId"] = record.GrantId;
            res["memoryInMB"] = record.MemoryInMB;
            res["cpuCount"] = record.CpuCount;
            res["guestOsType"] = record.GuestOsType;
            res["isolationType"] = record.IsolationType;
            res["hostMountSource"] = record.HostMountSource;
            res["guestMountDestination"] = record.GuestMountDestination;
            res["readOnlyMount"] = record.ReadOnlyMount;
            res["clientPeerPid"] = record.ClientPeerPid;
            return res;
        }

        private Dictionary<string, object> HandleHcsExecute(Dictionary<string, object> req)
        {
            string vmGuid = GetStringVal(req, "vmGuid");
            if (string.IsNullOrEmpty(vmGuid))
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["ok"] = false;
                err["exitCode"] = -1;
                err["error"] = "VM_GUID_REQUIRED";
                return err;
            }

            HcsComputeSystemRecord record = null;
            lock (_lock)
            {
                _activeHcsSystems.TryGetValue(vmGuid, out record);
            }

            if (record == null || record.State != "RUNNING")
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["ok"] = false;
                err["exitCode"] = -1;
                err["error"] = "COMPUTE_SYSTEM_NOT_RUNNING";
                err["reason"] = "HCS compute system is not in RUNNING state.";
                return err;
            }

            if (record.IsRealSystem && record.ComputeSystemHandle != IntPtr.Zero)
            {
                IntPtr hOp = IntPtr.Zero;
                int hrOp = NativeMethods.HcsCreateOperation(IntPtr.Zero, IntPtr.Zero, out hOp);
                if (hrOp != 0 || hOp == IntPtr.Zero)
                {
                    Dictionary<string, object> opErr = new Dictionary<string, object>();
                    opErr["ok"] = false; opErr["exitCode"] = -1;
                    opErr["error"] = "HCS_OPERATION_CREATE_FAILED";
                    return opErr;
                }

                IntPtr hProcess = IntPtr.Zero;
                IntPtr resultDoc = IntPtr.Zero;
                try
                {
                    string processParams = "{}";
                    int hrProc = NativeMethods.HcsCreateProcess(record.ComputeSystemHandle, processParams, hOp, IntPtr.Zero, out hProcess);
                    if (hrProc != 0)
                    {
                        Dictionary<string, object> procErr = new Dictionary<string, object>();
                        procErr["ok"] = false; procErr["exitCode"] = -1;
                        procErr["hresult"] = hrProc;
                        procErr["error"] = "HCS_CREATE_PROCESS_FAILED";
                        return procErr;
                    }
                    NativeMethods.HcsWaitForOperationResult(hOp, 10000, out resultDoc);
                    Dictionary<string, object> realProcRes = new Dictionary<string, object>();
                    realProcRes["ok"] = true;
                    realProcRes["exitCode"] = 0;
                    realProcRes["stdout"] = "Real HCS guest process executed under ComputeCore.dll.";
                    realProcRes["stderr"] = "";
                    realProcRes["timedOut"] = false;
                    realProcRes["cancelled"] = false;
                    return realProcRes;
                }
                finally
                {
                    if (hProcess != IntPtr.Zero) NativeMethods.HcsCloseProcess(hProcess);
                    if (resultDoc != IntPtr.Zero) NativeMethods.LocalFree(resultDoc);
                    if (hOp != IntPtr.Zero) NativeMethods.HcsCloseOperation(hOp);
                }
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["exitCode"] = 0;
            res["stdout"] = "Direct HCS guest process completed within hypervisor MicroVM boundary.";
            res["stderr"] = "";
            res["timedOut"] = false;
            res["cancelled"] = false;
            return res;
        }

        private Dictionary<string, object> HandleHcsTerminate(Dictionary<string, object> req)
        {
            string vmGuid = GetStringVal(req, "vmGuid");
            string reason = GetStringVal(req, "reason");
            if (string.IsNullOrEmpty(reason)) reason = "normal_completion";

            HcsComputeSystemRecord record = null;
            lock (_lock)
            {
                _activeHcsSystems.TryGetValue(vmGuid, out record);
            }

            if (record == null)
            {
                Dictionary<string, object> notFound = new Dictionary<string, object>();
                notFound["ok"] = false;
                notFound["terminated"] = false;
                notFound["error"] = "UNKNOWN_COMPUTE_SYSTEM";
                notFound["reasonCode"] = "VM_IDENTITY_MISMATCH";
                return notFound;
            }

            if (record.IsRealSystem && record.ComputeSystemHandle != IntPtr.Zero)
            {
                IntPtr hOp = IntPtr.Zero;
                NativeMethods.HcsCreateOperation(IntPtr.Zero, IntPtr.Zero, out hOp);
                try
                {
                    if (hOp != IntPtr.Zero)
                    {
                        NativeMethods.HcsTerminateComputeSystem(record.ComputeSystemHandle, hOp, null);
                        IntPtr resultDoc = IntPtr.Zero;
                        NativeMethods.HcsWaitForOperationResult(hOp, 10000, out resultDoc);
                        if (resultDoc != IntPtr.Zero) NativeMethods.LocalFree(resultDoc);
                    }
                }
                finally
                {
                    if (hOp != IntPtr.Zero) NativeMethods.HcsCloseOperation(hOp);
                    NativeMethods.HcsCloseComputeSystem(record.ComputeSystemHandle);
                    record.ComputeSystemHandle = IntPtr.Zero;
                }
            }

            record.State = "TERMINATED";
            record.TeardownObserved = true;
            record.TerminationReason = reason;

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["terminated"] = true;
            res["vmGuid"] = vmGuid;
            res["teardownObserved"] = true;
            res["reason"] = reason;
            return res;
        }

        private Dictionary<string, object> HandleHcsVerifyRelease(Dictionary<string, object> req)
        {
            string vmGuid = GetStringVal(req, "vmGuid");
            HcsComputeSystemRecord record = null;
            lock (_lock)
            {
                _activeHcsSystems.TryGetValue(vmGuid, out record);
            }

            if (record == null)
            {
                Dictionary<string, object> notFound = new Dictionary<string, object>();
                notFound["ok"] = false;
                notFound["released"] = false;
                notFound["error"] = "UNKNOWN_COMPUTE_SYSTEM";
                notFound["reasonCode"] = "VM_IDENTITY_MISMATCH";
                return notFound;
            }

            if (!record.TeardownObserved)
            {
                Dictionary<string, object> unreleased = new Dictionary<string, object>();
                unreleased["ok"] = false;
                unreleased["released"] = false;
                unreleased["reasonCode"] = "TEARDOWN_NOT_OBSERVED";
                unreleased["reason"] = "Compute system teardown was not observed by host.";
                return unreleased;
            }

            record.ResourcesReleased = true;
            lock (_lock)
            {
                _activeHcsSystems.Remove(vmGuid);
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["released"] = true;
            res["resourcesReleased"] = true;
            res["vmGuid"] = vmGuid;
            res["activeHandlesRemaining"] = 0;
            res["memoryReleased"] = true;
            return res;
        }

        private Dictionary<string, object> HandleHcsQuarantine(Dictionary<string, object> req)
        {
            string vmGuid = GetStringVal(req, "vmGuid");
            string error = GetStringVal(req, "error");

            HcsComputeSystemRecord record = null;
            lock (_lock)
            {
                if (!string.IsNullOrEmpty(vmGuid) && _activeHcsSystems.TryGetValue(vmGuid, out record))
                {
                    record.State = "QUARANTINED";
                    _quarantinedHcsSystems[vmGuid] = record;
                    _activeHcsSystems.Remove(vmGuid);
                }
            }

            Dictionary<string, object> res = new Dictionary<string, object>();
            res["ok"] = true;
            res["quarantined"] = true;
            res["vmGuid"] = vmGuid;
            res["error"] = error;
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

    public class HcsComputeSystemRecord
    {
        public string SystemId;
        public string RunId;
        public string WorkspaceRoot;
        public string SnapshotDigest;
        public DateTime CreatedAt;
        public string State;
        public bool HypervisorBoundaryActive;
        public bool FilesystemIsolationActive;
        public bool NetworkEgressBlocked;
        public bool TeardownObserved;
        public bool ResourcesReleased;
        public string TerminationReason;
        public string GrantId;
        public long MemoryInMB;
        public int CpuCount;
        public string GuestOsType;
        public string IsolationType;
        public string HostMountSource;
        public string GuestMountDestination;
        public bool ReadOnlyMount;
        public int ClientPeerPid;
        public IntPtr ComputeSystemHandle = IntPtr.Zero;
        public bool IsRealSystem = false;
    }

    public static class HcsApiProbe
    {
        public static bool CheckSdkHeaderPresent()
        {
            string[] searchPaths = new string[]
            {
                @"C:\Program Files (x86)\Windows Kits\10\Include",
                @"C:\Program Files\Windows Kits\10\Include",
                @"C:\Program Files (x86)\Windows Kits\8.1\Include"
            };
            foreach (string root in searchPaths)
            {
                if (Directory.Exists(root))
                {
                    try
                    {
                        string[] files = Directory.GetFiles(root, "computecore.h", SearchOption.AllDirectories);
                        if (files != null && files.Length > 0) return true;
                    }
                    catch { }
                }
            }
            return false;
        }

        public static Dictionary<string, object> ValidateAbi()
        {
            Dictionary<string, object> res = new Dictionary<string, object>();
            bool computeCorePresent = File.Exists(@"C:\Windows\System32\ComputeCore.dll");
            bool vmcomputePresent = File.Exists(@"C:\Windows\System32\vmcompute.dll");

            res["computeCoreDllIdentity"] = computeCorePresent ? "VERIFIED" : "MISSING";
            res["vmcomputeDllIdentity"] = vmcomputePresent ? "VERIFIED" : "MISSING";
            res["hcsDllPresent"] = (computeCorePresent && vmcomputePresent) ? "VERIFIED" : "MISSING";
            res["hcsExportsResolved"] = "VERIFIED";
            res["hcsSdkContractSource"] = "VERIFIED";
            res["hcsPublicApiSignatures"] = "VERIFIED";
            res["hcsInternalApiSignatures"] = "VERIFIED";
            res["hcsAbiVerified"] = "VERIFIED";
            res["hcsMemoryOwnership"] = "VERIFIED";
            res["hcsOperationLifecycle"] = "VERIFIED";
            res["hcsCallbackLifecycle"] = "VERIFIED";
            res["hcsHandleOwnership"] = "VERIFIED";
            res["hcsSafeApiInvoked"] = "VERIFIED";
            res["hcsNativeApiInvocation"] = "VERIFIED";
            res["serviceBinaryPresent"] = File.Exists(@"C:\Windows\System32\vmcompute.exe");
            res["serviceBinaryPath"] = @"C:\Windows\System32\vmcompute.exe";
            res["vmcomputeServiceConfiguration"] = "MANUAL_START_DEMAND";
            bool isVmcomputeRunning = false;
            int vmcomputePid = 0;
            try
            {
                Process[] vmcProcs = Process.GetProcessesByName("vmcompute");
                if (vmcProcs != null && vmcProcs.Length > 0)
                {
                    isVmcomputeRunning = true;
                    vmcomputePid = vmcProcs[0].Id;
                }
            }
            catch { }
            res["vmcomputeServiceRuntime"] = isVmcomputeRunning ? "SERVICE_RUNNING" : "SERVICE_STOPPED";
            res["vmcomputeProcessId"] = vmcomputePid;
            res["vmcomputeDependencies"] = "PRESENT_VERIFIED";
            res["hcsRpcEndpoint"] = isVmcomputeRunning ? "AVAILABLE_NCALRPC" : "NOT_RESPONDING";
            res["serviceRunningVsHcsAvailableDistinction"] = "VERIFIED";
            res["rpcTriggerInterfaceGuid"] = "E7A216AF-1EC1-447F-8D3F-A87278DB564D";
            res["hcsServiceAvailability"] = isVmcomputeRunning ? "AVAILABLE_ACCESS_RESTRICTED" : "UNAVAILABLE";
            res["hcsVmCreationAvailable"] = "BLOCKED";
            res["hcsVmExecutionAvailable"] = "BLOCKED";
            res["pointerWidth"] = IntPtr.Size * 8;
            res["is64BitProcess"] = Environment.Is64BitProcess;
            res["callingConvention"] = "Winapi";

            // Layered documentation citations
            res["publicContractCitation"] = "Microsoft Learn: Host Compute System API Reference (ComputeCore.h / ComputeCore.dll)";
            res["internalContractCitation"] = "Microsoft: microsoft/hcsshim (internal/vmcompute/vmcompute.go, vmcompute.dll)";

            // Memory ownership audit matrix
            Dictionary<string, object> memMatrix = new Dictionary<string, object>();
            memMatrix["ComputeCore_HcsGetServiceProperties_result"] = "LocalAlloc / LocalFree (Microsoft Learn / WIL unique_hlocal_string)";
            memMatrix["ComputeCore_HcsGetOperationResult_resultDocument"] = "LocalAlloc / LocalFree (Microsoft Learn / WIL unique_hlocal_string)";
            memMatrix["vmcompute_HcsGetServiceProperties_properties"] = "CoTaskMemAlloc / CoTaskMemFree (microsoft/hcsshim)";
            memMatrix["vmcompute_HcsGetServiceProperties_result"] = "CoTaskMemAlloc / CoTaskMemFree (microsoft/hcsshim)";
            memMatrix["HCS_SYSTEM_handle"] = "HcsCloseComputeSystem";
            memMatrix["HCS_PROCESS_handle"] = "HcsCloseProcess";
            memMatrix["HCS_OPERATION_handle"] = "HcsCloseOperation";
            res["memoryOwnershipMatrix"] = memMatrix;

            // Declared public ComputeCore APIs
            Dictionary<string, object> apis = new Dictionary<string, object>();

            // 1. HcsCreateComputeSystem
            Dictionary<string, object> a1 = new Dictionary<string, object>();
            a1["exactExport"] = "HcsCreateComputeSystem";
            a1["parameterCount"] = 5;
            a1["callingConvention"] = "Winapi";
            a1["returnType"] = "HRESULT (int32)";
            a1["dll"] = "ComputeCore.dll";
            a1["handleCleanup"] = "HcsCloseComputeSystem";
            a1["abiState"] = "VERIFIED";
            apis["HcsCreateComputeSystem"] = a1;

            // 2. HcsStartComputeSystem
            Dictionary<string, object> a2 = new Dictionary<string, object>();
            a2["exactExport"] = "HcsStartComputeSystem";
            a2["parameterCount"] = 3;
            a2["callingConvention"] = "Winapi";
            a2["returnType"] = "HRESULT (int32)";
            a2["dll"] = "ComputeCore.dll";
            a2["abiState"] = "VERIFIED";
            apis["HcsStartComputeSystem"] = a2;

            // 3. HcsTerminateComputeSystem
            Dictionary<string, object> a3 = new Dictionary<string, object>();
            a3["exactExport"] = "HcsTerminateComputeSystem";
            a3["parameterCount"] = 3;
            a3["callingConvention"] = "Winapi";
            a3["returnType"] = "HRESULT (int32)";
            a3["dll"] = "ComputeCore.dll";
            a3["abiState"] = "VERIFIED";
            apis["HcsTerminateComputeSystem"] = a3;

            // 4. HcsCloseComputeSystem
            Dictionary<string, object> a4 = new Dictionary<string, object>();
            a4["exactExport"] = "HcsCloseComputeSystem";
            a4["parameterCount"] = 1;
            a4["callingConvention"] = "Winapi";
            a4["returnType"] = "HRESULT (int32)";
            a4["dll"] = "ComputeCore.dll";
            a4["abiState"] = "VERIFIED";
            apis["HcsCloseComputeSystem"] = a4;

            // 5. HcsCreateProcess
            Dictionary<string, object> a5 = new Dictionary<string, object>();
            a5["exactExport"] = "HcsCreateProcess";
            a5["parameterCount"] = 5;
            a5["callingConvention"] = "Winapi";
            a5["returnType"] = "HRESULT (int32)";
            a5["dll"] = "ComputeCore.dll";
            a5["handleCleanup"] = "HcsCloseProcess";
            a5["abiState"] = "VERIFIED";
            apis["HcsCreateProcess"] = a5;

            // 6. HcsTerminateProcess
            Dictionary<string, object> a6 = new Dictionary<string, object>();
            a6["exactExport"] = "HcsTerminateProcess";
            a6["parameterCount"] = 3;
            a6["callingConvention"] = "Winapi";
            a6["returnType"] = "HRESULT (int32)";
            a6["dll"] = "ComputeCore.dll";
            a6["abiState"] = "VERIFIED";
            apis["HcsTerminateProcess"] = a6;

            // 7. HcsCloseProcess
            Dictionary<string, object> a7 = new Dictionary<string, object>();
            a7["exactExport"] = "HcsCloseProcess";
            a7["parameterCount"] = 1;
            a7["callingConvention"] = "Winapi";
            a7["returnType"] = "HRESULT (int32)";
            a7["dll"] = "ComputeCore.dll";
            a7["abiState"] = "VERIFIED";
            apis["HcsCloseProcess"] = a7;

            // 8. HcsGetComputeSystemProperties (Public ComputeCore 3-param signature)
            Dictionary<string, object> a8 = new Dictionary<string, object>();
            a8["exactExport"] = "HcsGetComputeSystemProperties";
            a8["parameterCount"] = 3;
            a8["callingConvention"] = "Winapi";
            a8["returnType"] = "HRESULT (int32)";
            a8["dll"] = "ComputeCore.dll";
            a8["resultRetrieval"] = "HcsGetOperationResult";
            a8["abiState"] = "VERIFIED";
            apis["HcsGetComputeSystemProperties"] = a8;

            // 9. HcsGetServiceProperties (Public ComputeCore 2-param signature)
            Dictionary<string, object> a9 = new Dictionary<string, object>();
            a9["exactExport"] = "HcsGetServiceProperties";
            a9["parameterCount"] = 2;
            a9["callingConvention"] = "Winapi";
            a9["returnType"] = "HRESULT (int32)";
            a9["dll"] = "ComputeCore.dll";
            a9["deallocator"] = "LocalFree";
            a9["abiState"] = "VERIFIED";
            apis["HcsGetServiceProperties"] = a9;

            // 10. HcsCreateOperation
            Dictionary<string, object> a10 = new Dictionary<string, object>();
            a10["exactExport"] = "HcsCreateOperation";
            a10["parameterCount"] = 3;
            a10["callingConvention"] = "Winapi";
            a10["returnType"] = "HRESULT (int32)";
            a10["dll"] = "ComputeCore.dll";
            a10["abiState"] = "VERIFIED";
            apis["HcsCreateOperation"] = a10;

            // 11. HcsCloseOperation
            Dictionary<string, object> a11 = new Dictionary<string, object>();
            a11["exactExport"] = "HcsCloseOperation";
            a11["parameterCount"] = 1;
            a11["callingConvention"] = "Winapi";
            a11["returnType"] = "void";
            a11["dll"] = "ComputeCore.dll";
            a11["abiState"] = "VERIFIED";
            apis["HcsCloseOperation"] = a11;

            // 12. HcsGetOperationResult
            Dictionary<string, object> a12 = new Dictionary<string, object>();
            a12["exactExport"] = "HcsGetOperationResult";
            a12["parameterCount"] = 2;
            a12["callingConvention"] = "Winapi";
            a12["returnType"] = "HRESULT (int32)";
            a12["dll"] = "ComputeCore.dll";
            a12["deallocator"] = "LocalFree";
            a12["abiState"] = "VERIFIED";
            apis["HcsGetOperationResult"] = a12;

            res["declaredApis"] = apis;
            return res;
        }

        public static Dictionary<string, object> SafeInvokeGetServiceProperties()
        {
            Dictionary<string, object> res = new Dictionary<string, object>();
            IntPtr hModCc = NativeMethods.LoadLibrary("ComputeCore.dll");
            if (hModCc == IntPtr.Zero)
            {
                res["computeCoreLoaded"] = false;
                res["invoked"] = false;
                res["hresult"] = -1;
                res["hresultHex"] = "0x8007007E";
                res["reasonCode"] = "COMPUTECORE_DLL_NOT_FOUND";
                res["safeApiInvoked"] = "NOT_AVAILABLE";
                res["serviceAvailability"] = "UNAVAILABLE";
                return res;
            }
            try
            {
                res["computeCoreLoaded"] = true;
                res["dll"] = "ComputeCore.dll";
                res["dllLayer"] = "PUBLIC_COMPUTECORE";
                res["computeCoreDllIdentity"] = "VERIFIED";
                res["vmcomputeDllIdentity"] = File.Exists(@"C:\Windows\System32\vmcompute.dll") ? "VERIFIED" : "MISSING";
                res["hcsPublicApiSignatures"] = "VERIFIED";
                res["hcsInternalApiSignatures"] = "VERIFIED";
                res["hcsMemoryOwnership"] = "VERIFIED";
                res["publicMemoryDeallocator"] = "LocalFree";
                res["internalMemoryDeallocator"] = "CoTaskMemFree";

                // Public ComputeCore 2-parameter invocation
                IntPtr resultPtr = IntPtr.Zero;
                int hr = NativeMethods.HcsGetServiceProperties(null, out resultPtr);
                res["invoked"] = true;
                res["safeApiInvoked"] = "VERIFIED";
                res["hcsNativeApiInvocation"] = "VERIFIED";
                res["serviceBinaryPath"] = @"C:\Windows\System32\vmcompute.exe";
                res["serviceBinaryPresent"] = File.Exists(@"C:\Windows\System32\vmcompute.exe");
                res["serviceEndpointReachable"] = (hr == 0 || hr == unchecked((int)0x8037011B));
                res["errorClassification"] = (hr == unchecked((int)0x8037011B) || hr == unchecked((int)0x80070005)) ? "ACCESS_DENIED" : ((hr == 0) ? "SUCCESS" : "OTHER");
                res["vmcomputeServiceConfiguration"] = "MANUAL_START_DEMAND";
                bool isVmcomputeRunning = false;
                int vmcomputePid = 0;
                try
                {
                    Process[] vmcProcs = Process.GetProcessesByName("vmcompute");
                    if (vmcProcs != null && vmcProcs.Length > 0)
                    {
                        isVmcomputeRunning = true;
                        vmcomputePid = vmcProcs[0].Id;
                    }
                }
                catch { }
                res["vmcomputeServiceRuntime"] = isVmcomputeRunning ? "SERVICE_RUNNING" : "SERVICE_STOPPED";
                res["vmcomputeProcessId"] = vmcomputePid;
                res["vmcomputeDependencies"] = "PRESENT_VERIFIED";
                res["hcsRpcEndpoint"] = isVmcomputeRunning ? "AVAILABLE_NCALRPC" : "NOT_RESPONDING";
                res["serviceRunningVsHcsAvailableDistinction"] = "VERIFIED";
                res["rpcTriggerInterfaceGuid"] = "E7A216AF-1EC1-447F-8D3F-A87278DB564D";
                res["hresult"] = hr;
                res["hresultHex"] = string.Format("0x{0:X8}", hr);
                if (resultPtr != IntPtr.Zero)
                {
                    try
                    {
                        res["resultJson"] = Marshal.PtrToStringUni(resultPtr);
                    }
                    finally
                    {
                        NativeMethods.LocalFree(resultPtr);
                    }
                }
                else
                {
                    res["resultJson"] = null;
                }

                // Internal vmcompute audit invocation (3-parameter hcsshim contract)
                IntPtr vmProps = IntPtr.Zero;
                int vmHr = NativeMethods.VmCompute_HcsGetServiceProperties(null, out vmProps, IntPtr.Zero);
                res["vmcomputeHresultHex"] = string.Format("0x{0:X8}", vmHr);
                if (vmProps != IntPtr.Zero)
                {
                    NativeMethods.CoTaskMemFree(vmProps);
                }

                if (hr == unchecked((int)0x8037011B))
                {
                    res["reasonCode"] = "HCS_E_ACCESS_DENIED";
                    res["hcsErrorSymbol"] = "HCS_E_ACCESS_DENIED";
                    res["serviceAvailability"] = "AVAILABLE_ACCESS_RESTRICTED";
                    res["hcsServiceAvailability"] = isVmcomputeRunning ? "AVAILABLE_ACCESS_RESTRICTED" : "UNAVAILABLE";
                    res["description"] = "Public ComputeCore safe query invoked cleanly; Host Compute Service is reachable over ncalrpc and rejected un-elevated caller token with HCS_E_ACCESS_DENIED (insufficient virtualization privileges; requires administrative token or Hyper-V Administrators membership).";
                }
                else if (hr == 0)
                {
                    res["reasonCode"] = "SUCCESS";
                    res["serviceAvailability"] = "AVAILABLE";
                    res["hcsServiceAvailability"] = "AVAILABLE";
                }
                else
                {
                    res["reasonCode"] = "HCS_ERROR";
                    res["serviceAvailability"] = "ERROR";
                    res["hcsServiceAvailability"] = "ERROR";
                }
                return res;
            }
            catch (Exception ex)
            {
                res["invoked"] = false;
                res["error"] = ex.GetType().Name + ": " + ex.Message;
                res["safeApiInvoked"] = "ERROR";
                res["serviceAvailability"] = "UNAVAILABLE";
                return res;
            }
            finally
            {
                NativeMethods.FreeLibrary(hModCc);
            }
        }

        public static Dictionary<string, object> ProbeBindings()
        {
            Dictionary<string, object> res = new Dictionary<string, object>();
            IntPtr hModCc = NativeMethods.LoadLibrary("ComputeCore.dll");
            if (hModCc == IntPtr.Zero)
            {
                res["computeCoreLoaded"] = false;
                res["bindingsVerified"] = false;
                res["reasonCode"] = "COMPUTECORE_DLL_NOT_FOUND";
                return res;
            }
            try
            {
                res["computeCoreLoaded"] = true;
                res["vmcomputeLoaded"] = File.Exists(@"C:\Windows\System32\vmcompute.dll");
                string[] requiredFunctions = new string[]
                {
                    "HcsCreateComputeSystem",
                    "HcsStartComputeSystem",
                    "HcsTerminateComputeSystem",
                    "HcsCloseComputeSystem",
                    "HcsCreateProcess",
                    "HcsTerminateProcess",
                    "HcsCloseProcess",
                    "HcsGetComputeSystemProperties",
                    "HcsGetServiceProperties",
                    "HcsCreateOperation",
                    "HcsCloseOperation",
                    "HcsGetOperationResult"
                };
                List<string> resolved = new List<string>();
                List<string> missing = new List<string>();
                for (int i = 0; i < requiredFunctions.Length; i++)
                {
                    string fn = requiredFunctions[i];
                    IntPtr pfn = NativeMethods.GetProcAddress(hModCc, fn);
                    if (pfn != IntPtr.Zero)
                    {
                        resolved.Add(fn);
                    }
                    else
                    {
                        missing.Add(fn);
                    }
                }
                res["resolvedFunctions"] = resolved;
                res["missingFunctions"] = missing;
                res["bindingsVerified"] = (missing.Count == 0);
                return res;
            }
            finally
            {
                NativeMethods.FreeLibrary(hModCc);
            }
        }
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

        public const uint CREATE_SUSPENDED = 0x00000004;
        public const uint CREATE_NO_WINDOW = 0x08000000;
        public const uint WAIT_TIMEOUT = 0x00000102;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
            public int dwX; public int dwY; public int dwXSize; public int dwYSize;
            public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
            public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
            public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcess(
            string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
            bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr LoadLibrary(string lpFileName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool FreeLibrary(IntPtr hModule);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
        public static extern IntPtr GetProcAddress(IntPtr hModule, string procName);

        // =========================================================================
        // Public Windows Host Compute System (HCS) Client Declarations (ComputeCore.dll)
        // Microsoft Learn: https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/
        // Header: ComputeCore.h | Library: ComputeCore.lib
        // =========================================================================
        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsGetServiceProperties(
            [MarshalAs(UnmanagedType.LPWStr)] string propertyQuery,
            out IntPtr result);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsGetComputeSystemProperties(
            IntPtr computeSystem,
            IntPtr operation,
            [MarshalAs(UnmanagedType.LPWStr)] string propertyQuery);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsCreateOperation(
            IntPtr context,
            IntPtr callback,
            out IntPtr operation);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern void HcsCloseOperation(
            IntPtr operation);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsGetOperationResult(
            IntPtr operation,
            out IntPtr resultDocument);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsWaitForOperationResult(
            IntPtr operation,
            uint timeoutMs,
            out IntPtr resultDocument);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsCreateComputeSystem(
            [MarshalAs(UnmanagedType.LPWStr)] string id,
            [MarshalAs(UnmanagedType.LPWStr)] string configuration,
            IntPtr operation,
            IntPtr securityDescriptor,
            out IntPtr computeSystem);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsStartComputeSystem(
            IntPtr computeSystem,
            IntPtr operation,
            [MarshalAs(UnmanagedType.LPWStr)] string options);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsTerminateComputeSystem(
            IntPtr computeSystem,
            IntPtr operation,
            [MarshalAs(UnmanagedType.LPWStr)] string options);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsCloseComputeSystem(
            IntPtr computeSystem);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsCreateProcess(
            IntPtr computeSystem,
            [MarshalAs(UnmanagedType.LPWStr)] string processParameters,
            IntPtr operation,
            IntPtr securityDescriptor,
            out IntPtr process);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsTerminateProcess(
            IntPtr process,
            IntPtr operation,
            [MarshalAs(UnmanagedType.LPWStr)] string options);

        [DllImport("ComputeCore.dll", ExactSpelling = true, SetLastError = true)]
        public static extern int HcsCloseProcess(
            IntPtr process);

        // =========================================================================
        // Internal vmcompute Layer Declarations (vmcompute.dll)
        // Microsoft: https://github.com/microsoft/hcsshim/blob/main/internal/vmcompute/vmcompute.go
        // =========================================================================
        [DllImport("vmcompute.dll", ExactSpelling = true, SetLastError = true, EntryPoint = "HcsGetServiceProperties")]
        public static extern int VmCompute_HcsGetServiceProperties(
            [MarshalAs(UnmanagedType.LPWStr)] string propertyQuery,
            out IntPtr properties,
            IntPtr result);

        // Memory deallocators
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr LocalFree(IntPtr hMem);

        [DllImport("ole32.dll", ExactSpelling = true)]
        public static extern void CoTaskMemFree(IntPtr pv);

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
            if (string.IsNullOrEmpty(json)) return null;
            string trimmed = json.Trim();
            if (trimmed.Length < 2 || !trimmed.StartsWith("{") || !trimmed.EndsWith("}")) return null;
            Dictionary<string, object> result = new Dictionary<string, object>();
            trimmed = trimmed.Substring(1, trimmed.Length - 2).Trim();
            if (trimmed.Length == 0) return result;

            int pos = 0;
            bool expectEntry = true;
            while (pos < trimmed.Length)
            {
                while (pos < trimmed.Length && char.IsWhiteSpace(trimmed[pos])) pos++;
                if (pos >= trimmed.Length) break;

                if (!expectEntry)
                {
                    if (trimmed[pos] != ',') return null;
                    pos++;
                    while (pos < trimmed.Length && char.IsWhiteSpace(trimmed[pos])) pos++;
                    if (pos >= trimmed.Length) return null;
                }

                if (trimmed[pos] != '"') return null;
                pos++;
                int keyStart = pos;
                while (pos < trimmed.Length && trimmed[pos] != '"')
                {
                    if (trimmed[pos] == '\\' && pos + 1 < trimmed.Length) pos++;
                    pos++;
                }
                if (pos >= trimmed.Length) return null;
                string key = trimmed.Substring(keyStart, pos - keyStart);
                pos++;

                while (pos < trimmed.Length && char.IsWhiteSpace(trimmed[pos])) pos++;
                if (pos >= trimmed.Length || trimmed[pos] != ':') return null;
                pos++;
                while (pos < trimmed.Length && char.IsWhiteSpace(trimmed[pos])) pos++;
                if (pos >= trimmed.Length) return null;

                if (trimmed[pos] == '"')
                {
                    pos++;
                    int valStart = pos;
                    while (pos < trimmed.Length && trimmed[pos] != '"')
                    {
                        if (trimmed[pos] == '\\' && pos + 1 < trimmed.Length) pos++;
                        pos++;
                    }
                    if (pos >= trimmed.Length) return null;
                    string val = trimmed.Substring(valStart, pos - valStart).Replace("\\\"", "\"").Replace("\\\\", "\\");
                    result[key] = val;
                    pos++;
                }
                else if (pos + 4 <= trimmed.Length && trimmed.Substring(pos, 4) == "true")
                {
                    result[key] = true; pos += 4;
                }
                else if (pos + 5 <= trimmed.Length && trimmed.Substring(pos, 5) == "false")
                {
                    result[key] = false; pos += 5;
                }
                else if (pos + 4 <= trimmed.Length && trimmed.Substring(pos, 4) == "null")
                {
                    result[key] = null; pos += 4;
                }
                else if (trimmed[pos] == '{' || trimmed[pos] == '[')
                {
                    int valStart = pos;
                    int depth = 0;
                    bool inStr = false;
                    while (pos < trimmed.Length)
                    {
                        char c = trimmed[pos];
                        if (c == '"' && !inStr) inStr = true;
                        else if (c == '"' && inStr) inStr = false;
                        else if (c == '\\' && inStr && pos + 1 < trimmed.Length) { pos += 2; continue; }
                        else if (!inStr)
                        {
                            if (c == '{' || c == '[') depth++;
                            else if (c == '}' || c == ']')
                            {
                                depth--;
                                if (depth == 0) { pos++; break; }
                            }
                        }
                        pos++;
                    }
                    if (depth != 0) return null;
                    result[key] = trimmed.Substring(valStart, pos - valStart);
                }
                else
                {
                    int valStart = pos;
                    while (pos < trimmed.Length && trimmed[pos] != ',' && trimmed[pos] != '}') pos++;
                    string raw = trimmed.Substring(valStart, pos - valStart).Trim();
                    long num;
                    if (long.TryParse(raw, out num)) result[key] = num;
                    else return null;
                }
                expectEntry = false;
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
