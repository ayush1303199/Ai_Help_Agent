"""Current-user OS encryption for provider secrets persisted by the backend."""

import base64
import ctypes
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Dict

MAX_SECRET_BYTES = 16 * 1024
SECRET_ID = re.compile(r"^(?:provider-instance:[A-Za-z0-9._:-]{1,160}|[a-z0-9._:-]{1,80})$", re.IGNORECASE)


class ProviderSecretVaultError(RuntimeError):
    pass


def _crypt(data: bytes, *, decrypt: bool) -> bytes:
    if sys.platform != "win32":
        raise ProviderSecretVaultError("Persistent provider secrets require Windows current-user encryption.")

    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    input_buffer = ctypes.create_string_buffer(data, len(data))
    input_blob = DataBlob(len(data), ctypes.cast(input_buffer, ctypes.POINTER(ctypes.c_byte)))
    output_blob = DataBlob()
    if decrypt:
        description = wintypes.LPWSTR()
        operation = crypt32.CryptUnprotectData
        operation.argtypes = [
            ctypes.POINTER(DataBlob), ctypes.POINTER(wintypes.LPWSTR),
            ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p,
            wintypes.DWORD, ctypes.POINTER(DataBlob),
        ]
        operation.restype = wintypes.BOOL
        succeeded = operation(
            ctypes.byref(input_blob), ctypes.byref(description), None, None, None,
            0x1, ctypes.byref(output_blob),
        )
    else:
        operation = crypt32.CryptProtectData
        operation.argtypes = [
            ctypes.POINTER(DataBlob), wintypes.LPCWSTR, ctypes.POINTER(DataBlob),
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob),
        ]
        operation.restype = wintypes.BOOL
        succeeded = operation(
            ctypes.byref(input_blob), "AI Help Agent provider credentials",
            None, None, None, 0x1, ctypes.byref(output_blob),
        )
    if not succeeded:
        raise ProviderSecretVaultError("Windows could not protect or decrypt provider credentials.")
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        kernel32.LocalFree(output_blob.pbData)
        if decrypt and description:
            kernel32.LocalFree(description)


def _normalize(secrets: Dict[str, str]) -> Dict[str, str]:
    if not isinstance(secrets, dict):
        raise ProviderSecretVaultError("Provider secret data is invalid.")
    normalized = {}
    for key, value in secrets.items():
        if (
            not isinstance(key, str)
            or not SECRET_ID.fullmatch(key)
            or not isinstance(value, str)
            or len(value.encode("utf-8")) > MAX_SECRET_BYTES
        ):
            raise ProviderSecretVaultError("Provider secret data is invalid.")
        if value:
            normalized[key] = value
    return normalized


class ProviderSecretVault:
    def __init__(self, path: Path):
        self.path = Path(path)

    def assert_available(self) -> None:
        self.protect(b"provider-secret-vault-check")

    @staticmethod
    def is_supported() -> bool:
        return sys.platform == "win32"

    @staticmethod
    def protect(data: bytes) -> bytes:
        return _crypt(data, decrypt=False)

    @staticmethod
    def unprotect(data: bytes) -> bytes:
        return _crypt(data, decrypt=True)

    def load(self) -> Dict[str, str]:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except OSError as error:
            raise ProviderSecretVaultError("Could not read the encrypted provider vault.") from error
        try:
            envelope = json.loads(raw)
            if envelope.get("version") != 1 or not isinstance(envelope.get("payload"), str):
                raise ValueError("Unsupported vault envelope.")
            encrypted = base64.b64decode(envelope["payload"], validate=True)
            decoded = self.unprotect(encrypted)
            return _normalize(json.loads(decoded.decode("utf-8")))
        except Exception as error:
            if isinstance(error, ProviderSecretVaultError):
                raise
            raise ProviderSecretVaultError("Could not decrypt the provider vault.") from error

    def save(self, secrets: Dict[str, str]) -> None:
        normalized = _normalize(secrets)
        if not normalized:
            try:
                self.path.unlink(missing_ok=True)
            except OSError as error:
                raise ProviderSecretVaultError("Could not remove the encrypted provider vault.") from error
            return

        encrypted = self.protect(json.dumps(normalized, separators=(",", ":")).encode("utf-8"))
        content = json.dumps({"version": 1, "payload": base64.b64encode(encrypted).decode("ascii")})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.",
            suffix=".tmp",
            dir=self.path.parent,
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary_name, 0o600)
            os.replace(temporary_name, self.path)
        except OSError as error:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
            raise ProviderSecretVaultError("Could not save the encrypted provider vault.") from error
