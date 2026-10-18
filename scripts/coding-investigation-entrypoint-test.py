"""Production Coding Agent tool-entrypoint regression using an isolated fixture."""

import sys
import tempfile
import unittest
import errno
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

SERVER_SRC = Path(__file__).resolve().parents[1] / "server" / "src"
sys.path.insert(0, str(SERVER_SRC))

import index as index_mod
import coding_websocket as ws_mod


class CodingInvestigationEntrypointTests(unittest.TestCase):
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
