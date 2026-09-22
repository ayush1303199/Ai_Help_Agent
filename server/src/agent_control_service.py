import os
import uuid
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from fastapi import HTTPException


class AgentControlService:
    """Owns loopback-controlled desktop permissions and activity history."""

    MAX_ACTIVITY = 100

    def __init__(self) -> None:
        self.permissions: Dict[str, bool] = {
            "openTeams": False,
            "openBrowser": False,
            "openCamera": False,
            "openChrome": False,
            "openVSCode": False,
            "openDesktop": False,
            "openSourceTree": False,
            "openSqlServer": False,
            "openNotepad": False,
            "openSublime": False,
        }
        self.activity: List[Dict[str, Any]] = []

    def update_permissions(self, payload: Dict[str, Any]) -> Dict[str, bool]:
        for key in self.permissions:
            if key in payload:
                self.permissions[key] = bool(payload[key])
        return dict(self.permissions)

    def record_activity(self, target: str) -> None:
        self.activity.insert(0, {
            "id": str(uuid.uuid4()),
            "target": target,
            "action": "open-requested",
            "createdAt": datetime.now().isoformat(),
        })
        del self.activity[self.MAX_ACTIVITY:]

    def open_target(self, target: str, url: str = "") -> None:
        """Open one of the explicitly allow-listed local targets."""
        commands = {
            "teams": ("openTeams", "msteams:"),
            "camera": ("openCamera", "microsoft.windows.camera:"),
            "chrome": ("openChrome", "chrome:"),
            "vscode": ("openVSCode", "code:"),
            "desktop": ("openDesktop", str(Path.home() / "Desktop")),
            "sourcetree": ("openSourceTree", "sourcetree:"),
            "sqlserver": ("openSqlServer", "ssms:"),
            "notepad": ("openNotepad", "notepad.exe"),
            "sublime": ("openSublime", "sublime_text:"),
        }
        if target == "browser":
            if not self.permissions["openBrowser"]:
                raise HTTPException(status_code=403, detail="Open browser permission is disabled.")
            if not isinstance(url, str) or not url or not url.lower().startswith(("http://", "https://")):
                raise HTTPException(status_code=400, detail="Only http and https URLs are allowed.")
            webbrowser.open(url, new=0, autoraise=False)
            self.record_activity(target)
            return

        if target not in commands:
            raise HTTPException(status_code=400, detail="Unsupported safe action.")
        permission, command = commands[target]
        if not self.permissions[permission]:
            raise HTTPException(status_code=403, detail=f"Permission to open {target} is disabled.")

        if command.endswith(".exe") and os.name == "nt":
            os.startfile(command)
        else:
            os.startfile(command) if hasattr(os, "startfile") else webbrowser.open(command, new=0, autoraise=False)
        self.record_activity(target)
