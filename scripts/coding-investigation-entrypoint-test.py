"""Production Coding Agent tool-entrypoint regression using an isolated fixture."""

import asyncio
import sys
import tempfile
import unittest
import errno
import hashlib
import json
from pathlib import Path
import time
import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient

SERVER_SRC = Path(__file__).resolve().parents[1] / "server" / "src"
sys.path.insert(0, str(SERVER_SRC))

import index as index_mod
import coding_websocket as ws_mod


class CodingInvestigationEntrypointTests(unittest.TestCase):
    def test_broker_workflow_entrypoint_forwards_creation_requirements_unchanged(self):
        with tempfile.TemporaryDirectory(prefix="coding-creation-entrypoint-") as temp_root:
            project = Path(temp_root).resolve()
            browser_session_id = str(uuid.uuid4())
            project_id = str(uuid.uuid4())
            broker_session_id = str(uuid.uuid4())
            root_hash = index_mod._canonical_project_root_hash(str(project))
            previous_state = index_mod._trusted_desktop_broker_state
            index_mod._trusted_desktop_broker_state = {
                "endpoint": "http://127.0.0.1:12345",
                "projects": [{"projectId": project_id, "rootHash": root_hash}],
                "browserSessions": {
                    browser_session_id: {"rootHash": root_hash, "projectRoot": str(project)},
                },
                "sessions": {
                    broker_session_id: {
                        "projectId": project_id,
                        "expiresAt": time.time() + 300,
                        "browserSessionId": browser_session_id,
                    },
                },
            }
            forwarded = {}

            class BrokerResponse:
                status_code = 202

                @staticmethod
                def json():
                    return {"outcome": "AWAITING_APPROVAL"}

            class BrokerClient:
                def __init__(self, **_kwargs):
                    pass

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_args):
                    return False

                async def post(self, _url, *, json, headers):
                    forwarded.update(json)
                    return BrokerResponse()

            async def synchronized(_origin):
                return None

            prompt = (
                "Build a complete full-stack feature. Create an entity model and a POST endpoint. "
                "Include validation and proper error handling (try-catch, status codes 201, 400, 500), "
                "and show success or error messages."
            )
            try:
                headers = [
                    (b"origin", next(origin for origin in index_mod.TRUSTED_RENDERER_ORIGINS if origin != "null").encode()),
                    (b"x-coding-browser-session", browser_session_id.encode()),
                    (b"x-coding-auth", index_mod.CODING_AUTH_TOKEN.encode()),
                    (b"content-type", b"application/json"),
                ]
                payload = {
                    "brokerSessionId": broker_session_id,
                    "sessionLeaseToken": "test-lease",
                    "userRequest": prompt,
                    "scope": ".",
                    "executionMode": "inline_review",
                }
                body = json.dumps(payload).encode()

                async def receive():
                    return {"type": "http.request", "body": body, "more_body": False}

                request = index_mod.Request(
                    {
                        "type": "http",
                        "http_version": "1.1",
                        "method": "POST",
                        "scheme": "http",
                        "path": "/api/coding/broker/workflows",
                        "raw_path": b"/api/coding/broker/workflows",
                        "query_string": b"",
                        "headers": headers,
                        "client": ("127.0.0.1", 54321),
                        "server": ("127.0.0.1", 3001),
                    },
                    receive,
                )
                with patch.object(index_mod, "_synchronize_trusted_desktop_broker", synchronized), patch.object(
                    index_mod.httpx,
                    "AsyncClient",
                    return_value=BrokerClient(),
                ):
                    response = asyncio.run(index_mod.proxy_trusted_desktop_broker("workflows", request))
                self.assertEqual(response.status_code, 202)
                self.assertEqual(forwarded["userRequest"], prompt)
                self.assertEqual(json.loads(response.body)["outcome"], "AWAITING_APPROVAL")
            finally:
                index_mod._trusted_desktop_broker_state = previous_state

    def test_tool_request_discovers_and_reads_nonstandard_source_layout(self):
        with tempfile.TemporaryDirectory(prefix="coding-investigation-entrypoint-") as temp_root:
            project = Path(temp_root)
            source = project / "modules" / "candidate" / "personal" / "controller-adapters" / "UpdateProfile.py"
            source.parent.mkdir(parents=True)
            source.write_text(
                "class CandidateProfileEditor:\n"
                "    def update_personal_details(self, candidate, payload):\n"
                "        return save_candidate_profile(candidate, payload)\n",
                encoding="utf-8",
            )
            (project / "web" / "routes").mkdir(parents=True)
            (project / "web" / "routes" / "candidate.py").write_text(
                "from modules.candidate.personal.controller_adapters import UpdateProfile\n"
                "def update_personal_profile(request):\n"
                "    return UpdateProfile.CandidateProfileEditor().update_personal_details(request)\n",
                encoding="utf-8",
            )
            described_source = project / "src" / "ApplicationLifecycle.py"
            described_source.parent.mkdir(parents=True)
            described_source.write_text(
                "def update_application():\n"
                "    return True\n",
                encoding="utf-8",
            )
            formatted_symbol_source = project / "src" / "UpdateApplication.py"
            formatted_symbol_source.write_text(
                "class UpdateApplication:\n"
                "    pass\n",
                encoding="utf-8",
            )
            attached = ws_mod.set_backend_project_state(str(project))
            self.assertEqual(attached["status"], "PROJECT_ATTACHED")
            self.assertEqual(Path(attached["projectRoot"]), project.resolve())
            missing = ws_mod.set_backend_project_state(str(project / "missing"))
            self.assertEqual(missing["status"], "PROJECT_MISSING")
            with patch.object(
                ws_mod.os,
                "stat",
                side_effect=PermissionError(errno.EACCES, "fixture access denied"),
            ):
                inaccessible = ws_mod.set_backend_project_state(str(project))
            self.assertEqual(inaccessible["status"], "PROJECT_INACCESSIBLE")
            self.assertEqual(inaccessible["projectRoot"], str(project))
            for number in range(45):
                noise = project / "fixtures" / f"personal-note-{number}.txt"
                noise.parent.mkdir(parents=True, exist_ok=True)
                noise.write_text("personal data fixture, not an implementation", encoding="utf-8")

            request_id = "investigation-entrypoint-test"
            ws_mod.set_backend_project_state(str(project))
            ws_mod.register_coding_request_context(request_id, "isolated-test-session", str(project))
            try:
                client = TestClient(index_mod.app)
                listed = client.post(
                    "/api/coding/tool",
                    headers={"x-coding-auth": index_mod.CODING_AUTH_TOKEN},
                    json={
                        "name": "list_directory",
                        "arguments": {"relativePath": "."},
                        "requestId": request_id,
                        "scope": ".",
                    },
                )
                self.assertEqual(listed.status_code, 200)
                self.assertTrue(listed.json().get("ok"))
                directory_names = {entry["name"] for entry in listed.json()["data"]}
                self.assertIn("modules", directory_names)
                self.assertIn("web", directory_names)
                self.assertIn("fixtures", directory_names)

                searched = client.post(
                    "/api/coding/tool",
                    headers={"x-coding-auth": index_mod.CODING_AUTH_TOKEN},
                    json={
                        "name": "search_code",
                        "arguments": {"query": "PersonalController"},
                        "requestId": request_id,
                        "scope": ".",
                    },
                )
                self.assertEqual(searched.status_code, 200)
                payload = searched.json()
                self.assertTrue(payload.get("ok"), payload)
                results = payload["data"]["results"]
                relative_source = source.relative_to(project).as_posix()
                self.assertTrue(results, "The production discovery handler returned no candidates.")
                relevant_paths = {
                    relative_source,
                    "web/routes/candidate.py",
                }
                self.assertIn(relative_source, {result["path"] for result in results})
                self.assertIn(results[0]["path"], relevant_paths)
                self.assertNotIn("fixtures", results[0]["path"])
                self.assertLessEqual(len(results), 40)

                described_search = client.post(
                    "/api/coding/tool",
                    headers={"x-coding-auth": index_mod.CODING_AUTH_TOKEN},
                    json={
                        "name": "search_code",
                        "arguments": {"query": "updates applications"},
                        "requestId": request_id,
                        "scope": ".",
                    },
                )
                self.assertEqual(described_search.status_code, 200)
                described_payload = described_search.json()
                self.assertTrue(described_payload.get("ok"), described_payload)
                self.assertIn(
                    described_source.relative_to(project).as_posix(),
                    {result["path"] for result in described_payload["data"]["results"]},
                )

                formatted_symbol_search = client.post(
                    "/api/coding/tool",
                    headers={"x-coding-auth": index_mod.CODING_AUTH_TOKEN},
                    json={
                        "name": "search_code",
                        "arguments": {"query": "update_application"},
                        "requestId": request_id,
                        "scope": ".",
                    },
                )
                self.assertEqual(formatted_symbol_search.status_code, 200)
                formatted_symbol_payload = formatted_symbol_search.json()
                self.assertTrue(formatted_symbol_payload.get("ok"), formatted_symbol_payload)
                self.assertIn(
                    formatted_symbol_source.relative_to(project).as_posix(),
                    {result["path"] for result in formatted_symbol_payload["data"]["results"]},
                )
                read = client.post(
                    "/api/coding/tool",
                    headers={"x-coding-auth": index_mod.CODING_AUTH_TOKEN},
                    json={
                        "name": "read_file",
                        "arguments": {"relativePath": relative_source},
                        "requestId": request_id,
                        "scope": ".",
                    },
                )
                self.assertEqual(read.status_code, 200)
                self.assertTrue(read.json().get("ok"))
                self.assertIn("CandidateProfileEditor", str(read.json()["data"]))
                self.assertIn("update_personal_details", str(read.json()["data"]))
            finally:
                ws_mod.clear_coding_request_context(request_id)
                ws_mod.set_backend_project_state(None)


if __name__ == "__main__":
    unittest.main()
