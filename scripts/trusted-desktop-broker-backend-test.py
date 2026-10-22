import asyncio
import http.server
import hashlib
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "src"))
import index  # noqa: E402
import coding_websocket  # noqa: E402


def reserve_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def start_synchronization_server():
    class SynchronizationHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            encoded = json.dumps({"ready": True}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            encoded = json.dumps({"synchronized": True, "projects": []}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, *_args):
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SynchronizationHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


class TrustedDesktopBrokerBackendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="trusted-broker-backend-")
        self.project_root = Path(self.temp_dir.name).resolve()
        self.original_project_state_path = coding_websocket._backend_project_state_path
        coding_websocket._backend_project_state_path = self.project_root / "backend-project-state.json"
        index.set_backend_project_state(str(self.project_root))
        index._trusted_desktop_broker_state = {"endpoint": None, "projects": []}
        self.origin = next(origin for origin in index.TRUSTED_RENDERER_ORIGINS if origin != "null")
        self.browser_session_id = str(uuid.uuid4())
        transport = httpx.ASGITransport(app=index.app, client=("127.0.0.1", 54321))
        self.client = httpx.AsyncClient(
            transport=transport,
            base_url=f"http://127.0.0.1:{reserve_port()}",
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        index._trusted_desktop_broker_state = {"endpoint": None, "projects": []}
        index.set_backend_project_state(None)
        coding_websocket._backend_project_state_path = self.original_project_state_path
        self.temp_dir.cleanup()

    async def test_attached_project_state_survives_backend_restart(self):
        index.set_backend_project_state(str(self.project_root))
        self.assertTrue(coding_websocket._backend_project_state_path.is_file())
        coding_websocket._backend_project_state_path.write_text(
            json.dumps({"projectRoot": str(self.project_root), "updatedAt": 0}),
            encoding="utf-8",
        )
        coding_websocket._active_backend_project.update({
            "projectRoot": None,
            "status": "PROJECT_NOT_ATTACHED",
            "updatedAt": 0,
        })
        coding_websocket._restore_backend_project_state()
        self.assertIsNone(
            coding_websocket._active_backend_project["projectRoot"],
            "Legacy persisted paths without trusted-app provenance must not restore as authorization.",
        )
        index.set_backend_project_state(str(self.project_root))
        coding_websocket._active_backend_project.update({
            "projectRoot": None,
            "status": "PROJECT_NOT_ATTACHED",
            "updatedAt": 0,
        })
        coding_websocket._restore_backend_project_state()
        restored = index.get_backend_project_state()
        self.assertEqual(restored["status"], "PROJECT_ATTACHED")
        self.assertEqual(restored["projectRoot"], str(self.project_root))

    async def test_registry_is_authenticated_and_discovery_is_root_scoped(self):
        project_id = str(uuid.uuid4())
        normalized_root = str(self.project_root).replace("\\", "/")
        if sys.platform == "win32":
            normalized_root = normalized_root.lower()
        root_hash = hashlib.sha256(normalized_root.encode("utf-8")).hexdigest()
        synchronization_server, synchronization_thread = start_synchronization_server()
        endpoint = f"http://127.0.0.1:{synchronization_server.server_address[1]}"
        registration = {
            "endpoint": endpoint,
            "projects": [{"projectId": project_id, "rootHash": root_hash}],
        }

        unauthorized = await self.client.post(
            "/api/coding/broker/register",
            json=registration,
        )
        self.assertEqual(unauthorized.status_code, 401)

        raw_path_registry = await self.client.post(
            "/api/coding/broker/register",
            headers={"X-Coding-Auth": index.CODING_AUTH_TOKEN},
            json={
                "endpoint": endpoint,
                "projects": [{"projectId": project_id, "root": str(self.project_root)}],
            },
        )
        self.assertEqual(raw_path_registry.status_code, 400)

        registered = await self.client.post(
            "/api/coding/broker/register",
            headers={"X-Coding-Auth": index.CODING_AUTH_TOKEN},
            json=registration,
        )
        self.assertEqual(registered.status_code, 200, registered.text)
        self.assertEqual(registered.json()["projectCount"], 1)

        browser_headers = {
            "Origin": self.origin,
            "X-Coding-Browser-Session": self.browser_session_id,
        }
        preflight = await self.client.options(
            "/api/coding/project-attach",
            headers={
                "Origin": self.origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-coding-browser-session",
            },
        )
        self.assertEqual(preflight.status_code, 200, preflight.text)
        self.assertIn(
            "x-coding-browser-session",
            preflight.headers.get("access-control-allow-headers", "").lower(),
        )
        unbound_headers = {
            "Origin": self.origin,
            "X-Coding-Browser-Session": str(uuid.uuid4()),
        }
        displayed_only = await self.client.get("/api/coding/project-state", headers=unbound_headers)
        self.assertEqual(displayed_only.json()["status"], "PROJECT_NOT_ATTACHED")
        self.assertIsNone(displayed_only.json()["projectRoot"])
        unattached_preflight = await self.client.get(
            "/api/coding/acceptance-preflight",
            headers=unbound_headers,
        )
        self.assertFalse(unattached_preflight.json()["projectAttached"])
        attached = await self.client.post(
            "/api/coding/project-attach",
            headers=browser_headers,
            json={"projectRoot": str(self.project_root)},
        )
        self.assertEqual(attached.status_code, 200, attached.text)
        discovered = await self.client.get(
            "/api/coding/broker",
            headers=browser_headers,
        )
        self.assertEqual(discovered.status_code, 200, discovered.text)
        self.assertEqual(discovered.json(), {
            "projects": [{"projectId": project_id}],
        })
        readiness = await self.client.get(
            "/api/coding/acceptance-preflight",
            headers=browser_headers,
        )
        self.assertTrue(readiness.json()["projectAttached"])
        self.assertEqual(readiness.json()["projectStatus"], "PROJECT_ATTACHED")
        self.assertEqual(readiness.json()["projectRoot"], str(self.project_root))
        self.assertEqual(readiness.json()["projectIdentity"], "BROKER_VERIFIED")
        visible_file = self.project_root / "explorer-visible.txt"
        visible_file.write_text("authorized preview\n", encoding="utf-8")
        listing = await self.client.get("/api/coding/list-directory", headers=browser_headers)
        visible_entry = next(entry for entry in listing.json() if entry["name"] == visible_file.name)
        self.assertEqual(visible_entry["size"], visible_file.stat().st_size)
        preview = await self.client.get(
            "/api/coding/read-file",
            params={"path": visible_file.name},
            headers=browser_headers,
        )
        self.assertEqual(preview.json()["content"], "authorized preview\n")
        self.assertNotIn(endpoint, discovered.text)
        self.assertNotIn(str(self.project_root), discovered.text)
        if index.CODING_MUTATION_HANDSHAKE_SECRET:
            self.assertNotIn(index.CODING_MUTATION_HANDSHAKE_SECRET, discovered.text)

        other_project = self.project_root / "unregistered"
        other_project.mkdir()
        index.set_backend_project_state(str(other_project))
        still_authorized = await self.client.get(
            "/api/coding/broker",
            headers=browser_headers,
        )
        self.assertEqual(still_authorized.status_code, 200, still_authorized.text)
        self.assertEqual(still_authorized.json(), {"projects": [{"projectId": project_id}]})
        unauthorized_attach = await self.client.post(
            "/api/coding/project-attach",
            headers=browser_headers,
            json={"projectRoot": str(other_project)},
        )
        self.assertEqual(unauthorized_attach.status_code, 403)
        self.assertEqual(unauthorized_attach.json()["detail"]["code"], "BROKER_PROJECT_UNAUTHORIZED")
        self.assertEqual(index.get_backend_project_state()["projectRoot"], str(other_project))
        state = await self.client.get("/api/coding/project-state", headers=browser_headers)
        self.assertEqual(state.json()["projectRoot"], str(self.project_root))
        synchronization_server.shutdown()
        synchronization_server.server_close()
        synchronization_thread.join(timeout=2)

    async def test_discovery_recovers_after_backend_registry_reset(self):
        project_id = str(uuid.uuid4())
        normalized_root = str(self.project_root).replace("\\", "/")
        if sys.platform == "win32":
            normalized_root = normalized_root.lower()
        root_hash = hashlib.sha256(normalized_root.encode("utf-8")).hexdigest()
        synchronization_server, synchronization_thread = start_synchronization_server()
        registration = {
            "endpoint": f"http://127.0.0.1:{synchronization_server.server_address[1]}",
            "projects": [{"projectId": project_id, "rootHash": root_hash}],
        }
        registered = await self.client.post(
            "/api/coding/broker/register",
            headers={"X-Coding-Auth": index.CODING_AUTH_TOKEN},
            json=registration,
        )
        self.assertEqual(registered.status_code, 200, registered.text)
        browser_headers = {
            "Origin": self.origin,
            "X-Coding-Browser-Session": self.browser_session_id,
        }
        attached = await self.client.post(
            "/api/coding/project-attach",
            headers=browser_headers,
            json={"projectRoot": str(self.project_root)},
        )
        self.assertEqual(attached.status_code, 200, attached.text)

        current_broker_state = index._trusted_desktop_broker_state
        index._trusted_desktop_broker_state = {
            "endpoint": None,
            "projects": [],
            "sessions": {},
            "browserSessions": current_broker_state.get("browserSessions", {}),
        }

        async def simulate_desktop_reconciliation():
            await asyncio.sleep(0.05)
            return await self.client.post(
                "/api/coding/broker/register",
                headers={"X-Coding-Auth": index.CODING_AUTH_TOKEN},
                json=registration,
            )

        reconciliation = asyncio.create_task(simulate_desktop_reconciliation())
        discovered = None
        for _ in range(20):
            discovered = await self.client.get(
                "/api/coding/broker",
                headers=browser_headers,
            )
            if discovered.status_code == 200:
                break
            self.assertIn(discovered.status_code, {403, 503}, discovered.text)
            await asyncio.sleep(0.01)
        sync_result = await reconciliation
        self.assertEqual(sync_result.status_code, 200, sync_result.text)
        self.assertIsNotNone(discovered)
        self.assertEqual(discovered.status_code, 200, discovered.text)
        self.assertEqual(discovered.json(), {"projects": [{"projectId": project_id}]})
        synchronization_server.shutdown()
        synchronization_server.server_close()
        synchronization_thread.join(timeout=2)

    async def test_discovery_rejects_untrusted_renderer_and_non_loopback_endpoint(self):
        project_id = str(uuid.uuid4())
        normalized_root = str(self.project_root).replace("\\", "/")
        if sys.platform == "win32":
            normalized_root = normalized_root.lower()
        root_hash = hashlib.sha256(normalized_root.encode("utf-8")).hexdigest()
        synchronization_server, synchronization_thread = start_synchronization_server()
        registered = await self.client.post(
            "/api/coding/broker/register",
            headers={"X-Coding-Auth": index.CODING_AUTH_TOKEN},
            json={
                "endpoint": f"http://127.0.0.1:{synchronization_server.server_address[1]}",
                "projects": [{"projectId": project_id, "rootHash": root_hash}],
            },
        )
        self.assertEqual(registered.status_code, 200, registered.text)
        preflight = await self.client.options(
            "/api/coding/project-attach",
            headers={
                "Origin": self.origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-coding-browser-session,x-coding-mutation-proof",
            },
        )
        self.assertEqual(preflight.status_code, 200, preflight.text)
        self.assertIn(
            "x-coding-browser-session",
            preflight.headers.get("access-control-allow-headers", "").lower(),
        )
        self.assertIn(
            "x-coding-mutation-proof",
            preflight.headers.get("access-control-allow-headers", "").lower(),
        )
        attached = await self.client.post(
            "/api/coding/project-attach",
            headers={
                "Origin": self.origin,
                "X-Coding-Browser-Session": self.browser_session_id,
            },
            json={"projectRoot": str(self.project_root)},
        )
        self.assertEqual(attached.status_code, 200, attached.text)
        invalid_endpoint = await self.client.post(
            "/api/coding/broker/register",
            headers={"X-Coding-Auth": index.CODING_AUTH_TOKEN},
            json={
                "endpoint": f"http://example.invalid:{reserve_port()}",
                "projects": [],
            },
        )
        self.assertEqual(invalid_endpoint.status_code, 400)

        denied = await self.client.get(
            "/api/coding/broker",
            headers={"Origin": "http://untrusted.invalid"},
        )
        self.assertEqual(denied.status_code, 401)
        synchronization_server.shutdown()
        synchronization_server.server_close()
        synchronization_thread.join(timeout=2)

    async def test_browser_sessions_keep_distinct_roots_and_reject_stale_leases(self):
        project_a = self.project_root / "project-a"
        project_b = self.project_root / "project-b"
        project_a.mkdir()
        project_b.mkdir()
        project_a_id = str(uuid.uuid4())
        project_b_id = str(uuid.uuid4())
        project_hashes = []
        for root in (project_a, project_b):
            normalized = str(root.resolve()).replace("\\", "/")
            if sys.platform == "win32":
                normalized = normalized.lower()
            project_hashes.append(hashlib.sha256(normalized.encode("utf-8")).hexdigest())
        lease_id = str(uuid.uuid4())
        lease_token = uuid.uuid4().hex

        class BrokerHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self._respond(200, {"ready": True})

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                if self.path == "/v1/sessions":
                    self._respond(201, {
                        "brokerSessionId": lease_id,
                        "sessionLeaseToken": lease_token,
                        "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
                    })
                elif self.path == "/v1/workflows":
                    self._respond(200, {"outcome": "SUCCESS", "filesModified": []})
                else:
                    self._respond(200, {"synchronized": True, "projects": []})

            def _respond(self, status, payload):
                encoded = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_args):
                return

        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), BrokerHandler)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        try:
            registered = await self.client.post(
                "/api/coding/broker/register",
                headers={"X-Coding-Auth": index.CODING_AUTH_TOKEN},
                json={
                    "endpoint": f"http://127.0.0.1:{upstream.server_address[1]}",
                    "projects": [
                        {"projectId": project_a_id, "rootHash": project_hashes[0]},
                        {"projectId": project_b_id, "rootHash": project_hashes[1]},
                    ],
                },
            )
            self.assertEqual(registered.status_code, 200, registered.text)
            session_a = {"Origin": self.origin, "X-Coding-Browser-Session": self.browser_session_id}
            session_b = {"Origin": self.origin, "X-Coding-Browser-Session": str(uuid.uuid4())}
            attach_a = await self.client.post(
                "/api/coding/project-attach",
                headers=session_a,
                json={"projectRoot": str(project_a)},
            )
            attach_b = await self.client.post(
                "/api/coding/project-attach",
                headers=session_b,
                json={"projectRoot": str(project_b)},
            )
            self.assertEqual(attach_a.status_code, 200, attach_a.text)
            self.assertEqual(attach_b.status_code, 200, attach_b.text)

            state_a = await self.client.get("/api/coding/project-state", headers=session_a)
            state_b = await self.client.get("/api/coding/project-state", headers=session_b)
            self.assertEqual(state_a.json()["projectRoot"], str(project_a))
            self.assertEqual(state_b.json()["projectRoot"], str(project_b))
            discovery_a = await self.client.get("/api/coding/broker", headers=session_a)
            discovery_b = await self.client.get("/api/coding/broker", headers=session_b)
            self.assertEqual(discovery_a.json(), {"projects": [{"projectId": project_a_id}]})
            self.assertEqual(discovery_b.json(), {"projects": [{"projectId": project_b_id}]})
            missing_session = await self.client.get(
                "/api/coding/broker",
                headers={"Origin": self.origin},
            )
            self.assertEqual(missing_session.status_code, 403, missing_session.text)

            lease = await self.client.post(
                "/api/coding/broker/sessions",
                headers=session_a,
                json={"projectId": project_a_id},
            )
            self.assertEqual(lease.status_code, 201, lease.text)
            switched = await self.client.post(
                "/api/coding/project-attach",
                headers=session_a,
                json={"projectRoot": str(project_b)},
            )
            self.assertEqual(switched.status_code, 200, switched.text)
            stale_workflow = await self.client.post(
                "/api/coding/broker/workflows",
                headers=session_a,
                json={
                    "brokerSessionId": lease_id,
                    "sessionLeaseToken": lease_token,
                    "userRequest": "stale lease test",
                    "scope": ".",
                    "executionMode": "inline_review",
                },
            )
            self.assertEqual(stale_workflow.status_code, 409, stale_workflow.text)
            self.assertEqual(stale_workflow.json()["detail"]["code"], "BROKER_PROJECT_UNAUTHORIZED")
            state_b_after_switch = await self.client.get("/api/coding/project-state", headers=session_b)
            self.assertEqual(state_b_after_switch.json()["projectRoot"], str(project_b))
            upstream.shutdown()
            unavailable = await self.client.get("/api/coding/broker", headers=session_b)
            self.assertEqual(unavailable.status_code, 503, unavailable.text)
            self.assertEqual(unavailable.json()["detail"]["code"], "BROKER_UNAVAILABLE")
        finally:
            upstream.shutdown()
            upstream.server_close()
            thread.join(timeout=2)

    async def test_proxy_forwards_only_attached_opaque_project_sessions(self):
        project_id = str(uuid.uuid4())
        normalized_root = str(self.project_root).replace("\\", "/")
        if sys.platform == "win32":
            normalized_root = normalized_root.lower()
        root_hash = hashlib.sha256(normalized_root.encode("utf-8")).hexdigest()
        broker_session_id = str(uuid.uuid4())
        lease_token = uuid.uuid4().hex
        second_browser_session_id = str(uuid.uuid4())
        forwarded = []

        class BrokerHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                encoded = json.dumps({"ready": True}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                forwarded.append((self.path, payload, self.headers.get("Origin")))
                if self.path == "/v1/sessions":
                    status = 201
                    response = {
                        "brokerSessionId": broker_session_id,
                        "sessionLeaseToken": lease_token,
                        "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
                    }
                elif self.path == "/v1/workflows":
                    status = 200
                    response = {"outcome": "SUCCESS", "filesModified": []}
                else:
                    status = 200
                    response = {"released": True, "cancellationAccepted": True}
                encoded = json.dumps(response).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_args):
                return

        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), BrokerHandler)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        endpoint = f"http://127.0.0.1:{upstream.server_address[1]}"
        try:
            registered = await self.client.post(
                "/api/coding/broker/register",
                headers={"X-Coding-Auth": index.CODING_AUTH_TOKEN},
                json={
                    "endpoint": endpoint,
                    "projects": [{"projectId": project_id, "rootHash": root_hash}],
                },
            )
            self.assertEqual(registered.status_code, 200, registered.text)

            restored_session_headers = {
                "Origin": self.origin,
                "X-Coding-Browser-Session": self.browser_session_id,
            }
            attached = await self.client.post(
                "/api/coding/project-attach",
                headers=restored_session_headers,
                json={"projectRoot": str(self.project_root)},
            )
            self.assertEqual(attached.status_code, 200, attached.text)
            second_attached = await self.client.post(
                "/api/coding/project-attach",
                headers={
                    "Origin": self.origin,
                    "X-Coding-Browser-Session": second_browser_session_id,
                },
                json={"projectRoot": str(self.project_root)},
            )
            self.assertEqual(second_attached.status_code, 200, second_attached.text)
            state = await self.client.get(
                "/api/coding/project-state",
                headers=restored_session_headers,
            )
            self.assertEqual(state.status_code, 200, state.text)
            self.assertEqual(state.json()["status"], "PROJECT_ATTACHED")
            self.assertEqual(
                index._trusted_desktop_broker_state["browserSessions"][self.browser_session_id]["rootHash"],
                root_hash,
                "The browser session should be bound only after the trusted broker authorizes its workspace.",
            )
            attached_again = await self.client.post(
                "/api/coding/project-attach",
                headers=restored_session_headers,
                json={"projectRoot": str(self.project_root)},
            )
            self.assertEqual(attached_again.status_code, 200, attached_again.text)
            self.assertEqual(attached_again.json()["status"], "PROJECT_ATTACHED")
            self.assertEqual(
                index._trusted_desktop_broker_state["browserSessions"][self.browser_session_id]["rootHash"],
                root_hash,
                "Project attach and restored project-state must bind the same browser identity.",
            )

            lease_response = await self.client.post(
                "/api/coding/broker/sessions",
                headers=restored_session_headers,
                json={"projectId": project_id},
            )
            self.assertEqual(lease_response.status_code, 201, lease_response.text)
            lease = lease_response.json()
            self.assertEqual(lease["brokerSessionId"], broker_session_id)
            unknown_session = await self.client.post(
                "/api/coding/broker/workflows",
                headers=restored_session_headers,
                json={
                    "brokerSessionId": str(uuid.uuid4()),
                    "sessionLeaseToken": lease_token,
                    "userRequest": "unknown lease",
                    "scope": ".",
                    "executionMode": "inline_review",
                },
            )
            self.assertEqual(unknown_session.status_code, 403)
            self.assertEqual(unknown_session.json()["detail"]["code"], "BROKER_SESSION_UNAUTHORIZED")
            expired_session_id = str(uuid.uuid4())
            index._trusted_desktop_broker_state["sessions"][expired_session_id] = {
                "projectId": project_id,
                "expiresAt": time.time() - 1,
                "browserSessionId": self.browser_session_id,
            }
            expired = await self.client.post(
                "/api/coding/broker/workflows",
                headers=restored_session_headers,
                json={
                    "brokerSessionId": expired_session_id,
                    "sessionLeaseToken": lease_token,
                    "userRequest": "expired lease",
                    "scope": ".",
                    "executionMode": "inline_review",
                },
            )
            self.assertEqual(expired.status_code, 403)
            self.assertEqual(expired.json()["detail"]["code"], "BROKER_SESSION_UNAUTHORIZED")

            forged = await self.client.post(
                "/api/coding/broker/sessions",
                headers=restored_session_headers,
                json={"projectId": str(uuid.uuid4())},
            )
            self.assertEqual(forged.status_code, 403)

            wrong_session = await self.client.post(
                "/api/coding/broker/workflows",
                headers={
                    "Origin": self.origin,
                    "X-Coding-Browser-Session": second_browser_session_id,
                },
                json={
                    "brokerSessionId": broker_session_id,
                    "sessionLeaseToken": lease_token,
                    "userRequest": "Create a synthetic modular project.",
                    "scope": ".",
                    "executionMode": "inline_review",
                },
            )
            self.assertEqual(wrong_session.status_code, 403, wrong_session.text)
            self.assertEqual(
                wrong_session.json()["detail"]["code"],
                "BROKER_BROWSER_SESSION_MISMATCH",
            )

            workflow = await self.client.post(
                "/api/coding/broker/workflows",
                headers=restored_session_headers,
                json={
                    "brokerSessionId": broker_session_id,
                    "sessionLeaseToken": lease_token,
                    "userRequest": "Create a synthetic modular project.",
                    "scope": ".",
                    "executionMode": "inline_review",
                },
            )
            self.assertEqual(workflow.status_code, 200, workflow.text)
            self.assertEqual(workflow.json()["outcome"], "SUCCESS")
            self.assertTrue(any(item[0] == "/v1/synchronize" for item in forwarded))
            session_forward = next(item for item in forwarded if item[0] == "/v1/sessions")
            workflow_forward = next(item for item in forwarded if item[0] == "/v1/workflows")
            self.assertEqual(session_forward[1], {"projectId": project_id})
            self.assertEqual(workflow_forward[1]["executionMode"], "inline_review")
            self.assertEqual(workflow_forward[2], self.origin)

            release = await self.client.post(
                "/api/coding/broker/sessions/release",
                headers=restored_session_headers,
                json={"brokerSessionId": broker_session_id, "sessionLeaseToken": lease_token},
            )
            self.assertEqual(release.status_code, 200)
            self.assertNotIn(str(self.project_root), release.text)
        finally:
            upstream.shutdown()
            upstream.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
