import asyncio
import http.server
import hashlib
import json
import socket
import sys
import tempfile
import threading
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "src"))
import index  # noqa: E402


def reserve_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def start_synchronization_server():
    class SynchronizationHandler(http.server.BaseHTTPRequestHandler):
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
        index.set_backend_project_state(str(self.project_root))
        index._trusted_desktop_broker_state = {"endpoint": None, "projects": []}
        self.origin = next(origin for origin in index.TRUSTED_RENDERER_ORIGINS if origin != "null")
        transport = httpx.ASGITransport(app=index.app, client=("127.0.0.1", 54321))
        self.client = httpx.AsyncClient(
            transport=transport,
            base_url=f"http://127.0.0.1:{reserve_port()}",
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        index._trusted_desktop_broker_state = {"endpoint": None, "projects": []}
        index.set_backend_project_state(None)
        self.temp_dir.cleanup()

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

        discovered = await self.client.get(
            "/api/coding/broker",
            headers={"Origin": self.origin},
        )
        self.assertEqual(discovered.status_code, 200, discovered.text)
        self.assertEqual(discovered.json(), {
            "projects": [{"projectId": project_id}],
        })
        self.assertNotIn(endpoint, discovered.text)
        self.assertNotIn(str(self.project_root), discovered.text)
        if index.CODING_MUTATION_HANDSHAKE_SECRET:
            self.assertNotIn(index.CODING_MUTATION_HANDSHAKE_SECRET, discovered.text)

        other_project = self.project_root / "unregistered"
        other_project.mkdir()
        index.set_backend_project_state(str(other_project))
        mismatch = await self.client.get(
            "/api/coding/broker",
            headers={"Origin": self.origin},
        )
        self.assertEqual(mismatch.status_code, 503)
        self.assertEqual(mismatch.json()["detail"]["code"], "BROKER_PROJECT_NOT_REGISTERED")
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

        index._trusted_desktop_broker_state = {"endpoint": None, "projects": [], "sessions": {}}

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
                headers={"Origin": self.origin},
            )
            if discovered.status_code == 200:
                break
            self.assertEqual(discovered.status_code, 503, discovered.text)
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

    async def test_proxy_forwards_only_attached_opaque_project_sessions(self):
        project_id = str(uuid.uuid4())
        normalized_root = str(self.project_root).replace("\\", "/")
        if sys.platform == "win32":
            normalized_root = normalized_root.lower()
        root_hash = hashlib.sha256(normalized_root.encode("utf-8")).hexdigest()
        broker_session_id = str(uuid.uuid4())
        lease_token = uuid.uuid4().hex
        forwarded = []

        class BrokerHandler(http.server.BaseHTTPRequestHandler):
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

            lease_response = await self.client.post(
                "/api/coding/broker/sessions",
                headers={"Origin": self.origin},
                json={"projectId": project_id},
            )
            self.assertEqual(lease_response.status_code, 201, lease_response.text)
            lease = lease_response.json()
            self.assertEqual(lease["brokerSessionId"], broker_session_id)

            forged = await self.client.post(
                "/api/coding/broker/sessions",
                headers={"Origin": self.origin},
                json={"projectId": str(uuid.uuid4())},
            )
            self.assertEqual(forged.status_code, 403)

            workflow = await self.client.post(
                "/api/coding/broker/workflows",
                headers={"Origin": self.origin},
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
                headers={"Origin": self.origin},
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
