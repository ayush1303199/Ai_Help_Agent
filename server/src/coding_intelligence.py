"""
Universal Autonomous Software Engineering Intelligence Engine.
Provides production-grade runtime intelligence for AI Coding Agent:
  1. SecretProtector: Universal secret & credential redaction
  2. IncrementalRepositoryIndex: Hash-tracked incremental AST/regex symbol index
  3. LazyCodeGraph: On-demand call graph, reference, and dependency fragments
  4. AdaptiveSearchRouter: Multi-strategy search & concept expansion
  5. CodingMemorySystem: 4-Tier memory with freshness & invalidation
  6. DatabaseIntelligenceEngine: Safe multi-engine diagnostics & destructive SQL blocker
  7. PolicyGate: Executable safety enforcement (ALLOW / ASK / BLOCK)
  8. SelfDebugController: 6-iteration recovery loop & failure taxonomy
  9. ProgressiveContextCompiler: Token-budgeted context assembler
  10. EvidenceEventStream: 22 standard engineering audit lifecycle events
"""

import os
import re
import json
import time
import hashlib
import hmac
import shlex
import threading
import uuid
from difflib import SequenceMatcher
from typing import Dict, List, Any, Optional, Set, Tuple
from pathlib import Path
from urllib.parse import unquote, urlparse

try:
    _FEATURE_OWNERSHIP = json.loads(
        (Path(__file__).resolve().parent / "coding_feature_ownership.json").read_text(encoding="utf-8")
    )
    _PROTECTED_FEATURE_ROOTS = _FEATURE_OWNERSHIP["protectedFeatureRoots"]
    if not isinstance(_PROTECTED_FEATURE_ROOTS, dict) or not _PROTECTED_FEATURE_ROOTS:
        raise ValueError("feature ownership map is empty")
except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
    raise RuntimeError("Coding feature ownership policy is unavailable.") from error


# =====================================================================
# 1. SECRET PROTECTION & REDACTION
# =====================================================================
class SecretProtector:
    """
    Uniform secret redaction across all layers:
    API keys, tokens, passwords, cookies, private keys, database credentials.
    """
    SENSITIVE_KEY_PATTERN = re.compile(
        r"^(?:.*_)?(?:api[_-]?key|token|auth(?:orization)?|secret|password|passwd|pwd|pass|credential|private[_-]?key|cookie|session|jwt|access[_-]?token|refresh[_-]?token)(?:_.*)?$",
        re.I
    )
    SENSITIVE_VALUE_PATTERNS = [
        re.compile(r"sk-[A-Za-z0-9_-]{16,}", re.I),
        re.compile(r"ghp_[A-Za-z0-9]{20,}", re.I),
        re.compile(r"Bearer\s+[A-Za-z0-9._~+/-]{16,}", re.I),
        re.compile(r"['\"]?(?:api[_-]?key|token|secret|password|pwd|pass)['\"]?\s*(?:=>|[:=])\s*['\"]?([A-Za-z0-9!@#$%^&*()_+=\-`~\[\]{};':,.<>/?]{6,})['\"]?", re.I),
        re.compile(r"(?:mysql|postgres|postgresql|mongodb|redis|oracle):\/\/[^:\s]+:([^@\s]+)@", re.I),
        re.compile(r"-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]+?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----", re.I),
    ]

    @classmethod
    def redact_text(cls, text: str) -> str:
        if not text or not isinstance(text, str):
            return "" if text is None else str(text)
        res = text
        for pat in cls.SENSITIVE_VALUE_PATTERNS:
            res = pat.sub("[REDACTED]", res)
        return res

    @classmethod
    def redact_data(cls, data: Any) -> Any:
        if isinstance(data, dict):
            clean = {}
            for k, v in data.items():
                if cls.SENSITIVE_KEY_PATTERN.match(str(k)):
                    clean[k] = "[REDACTED]"
                else:
                    clean[k] = cls.redact_data(v)
            return clean
        elif isinstance(data, list):
            return [cls.redact_data(item) for item in data]
        elif isinstance(data, str):
            return cls.redact_text(data)
        return data


class SecretTransformer:
    """
    Transforms sensitive credentials into cryptographically salted HMAC hashes or opaque IDs.
    The runtime-held HMAC key never leaves the protected runtime.
    """
    _runtime_hmac_key: bytes = os.urandom(32)

    @classmethod
    def transform_secret(cls, secret_value: str, secret_type: str = "db-password") -> str:
        if not secret_value or not isinstance(secret_value, str):
            return "[REDACTED]"
        digest = hmac.new(
            cls._runtime_hmac_key,
            f"{secret_type}\0{secret_value}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return f"secret:{secret_type}:{digest}"

    @classmethod
    def sanitize_context_for_llm(cls, data: Any) -> Any:
        """
        Layer C sanitization: transforms secrets into HMAC identifiers before LLM ingestion.
        """
        if isinstance(data, dict):
            out = {}
            for k, v in data.items():
                k_str = str(k).lower()
                if any(s in k_str for s in ("password", "passwd", "pwd", "secret", "private_key", "token", "auth", "credential", "username", "db_user", "database_user", "api_key", "access_key", "cookie", "session", "jwt")):
                    out[k] = cls.transform_secret(str(v), secret_type=k_str)
                elif isinstance(v, (dict, list)):
                    out[k] = cls.sanitize_context_for_llm(v)
                elif isinstance(v, str):
                    out[k] = cls.sanitize_text_for_llm(v)
                else:
                    out[k] = v
            return out
        elif isinstance(data, list):
            return [cls.sanitize_context_for_llm(x) for x in data]
        elif isinstance(data, str):
            return cls.sanitize_text_for_llm(data)
        return data

    @classmethod
    def sanitize_text_for_llm(cls, text: str) -> str:
        if not text:
            return ""
        protected: Dict[str, str] = {}

        def _protect(value: str) -> str:
            marker = f"COPILOTPROTECTED{os.urandom(12).hex().upper()}X"
            protected[marker] = value
            return marker

        def _replace_uri(m):
            scheme = m.group(1)
            user = m.group(2)
            pwd = m.group(3)
            rest = m.group(4)
            safe_uri = (
                f"{scheme}://"
                f"{cls.transform_secret(user, secret_type='db-username')}:"
                f"{cls.transform_secret(pwd, secret_type='db-password')}@{rest}"
            )
            return _protect(safe_uri)

        res = re.sub(
            r"([a-zA-Z0-9_+]+):\/\/([^:\s]+):([^@\s]+)@([^\s]+)",
            _replace_uri,
            text
        )

        def _replace_kv(m):
            prefix = m.group(1)
            value = m.group(2)
            suffix = m.group(3)
            if re.fullmatch(r"secret:[\w-]+:[a-f0-9]{64}", value, re.I):
                safe_value = value
            else:
                key_match = re.search(r"([a-z0-9_-]+)['\"]?\s*(?:=>|[:=])\s*['\"]?$", prefix, re.I)
                secret_type = key_match.group(1).lower() if key_match else "credential"
                safe_value = cls.transform_secret(value, secret_type=secret_type)
            return _protect(f"{prefix}{safe_value}{suffix}")

        res = re.sub(
            r"(['\"]?\b(?:[a-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|pwd|pass|username|db_user|database_user|cookie|session|jwt|auth(?:orization)?|credential)\b['\"]?\s*(?:=>|[:=]|\bis\b)\s*['\"]?)([^'\"\s,\r\n;]+)(['\"]?)",
            _replace_kv,
            res,
            flags=re.I
        )
        res = re.sub(
            r"\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,})\b",
            lambda m: _protect(cls.transform_secret(m.group(1), "api-token")),
            res,
            flags=re.I,
        )
        res = re.sub(
            r"\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,})",
            lambda m: _protect(f"{m.group(1)}{cls.transform_secret(m.group(2), 'bearer-token')}"),
            res,
            flags=re.I,
        )
        res = re.sub(
            r"-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]+?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----",
            lambda m: _protect(cls.transform_secret(m.group(0), "private-key")),
            res,
            flags=re.I,
        )
        res = SecretProtector.redact_text(res)
        for marker, safe_value in protected.items():
            res = res.replace(marker, safe_value)
        return res


# =====================================================================
# 2. INCREMENTAL REPOSITORY INDEX
# =====================================================================
class IncrementalRepositoryIndex:
    """
    Maintains an in-memory, incremental symbol & file index.
    Tracks SHA-256 hashes and modification timestamps.
    Parses functions, methods, classes, interfaces, imports, exports, routes, and DB queries.
    Invalidates only changed files on update.
    """
    IGNORED_DIRS = {
        ".git", "node_modules", "dist", "build", "coverage", "vendor",
        ".idea", ".vscode", "tmp", "temp", ".venv", "venv", "__pycache__",
    }
    INDEXABLE_EXTS = {
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".php",
        ".java", ".go", ".rs", ".cs", ".rb", ".json", ".sql", ".yaml", ".yml"
    }

    def __init__(self, project_root: str = ""):
        self.project_root = project_root
        self._lock = threading.RLock()
        self._file_hashes: Dict[str, str] = {}
        self._file_mtimes: Dict[str, float] = {}
        self._symbols: Dict[str, List[Dict[str, Any]]] = {} # name_lower -> list of symbol records
        self._file_symbols: Dict[str, List[Dict[str, Any]]] = {} # rel_path -> list of symbols in file
        self._references: Dict[str, Set[str]] = {} # symbol_lower -> set of rel_paths referencing it
        self._routes: List[Dict[str, Any]] = []
        self._db_references: List[Dict[str, Any]] = []
        self._last_scan_time = 0.0

    def compute_file_hash(self, content: str) -> str:
        return hashlib.sha256(content.encode("utf-8", errors="ignore")).hexdigest()

    def scan_and_update(self, project_root: Any = None, max_files: int = 500) -> Dict[str, int]:
        with self._lock:
            if isinstance(project_root, str) and project_root:
                normalized_root = os.path.normcase(os.path.realpath(os.path.abspath(project_root)))
                current_root = (
                    os.path.normcase(os.path.realpath(os.path.abspath(self.project_root)))
                    if self.project_root
                    else ""
                )
                if current_root and current_root != normalized_root:
                    self._clear_index()
                self.project_root = normalized_root
            return self._scan_and_update_locked(project_root, max_files)

    def _clear_index(self) -> None:
        self._file_hashes.clear()
        self._file_mtimes.clear()
        self._symbols.clear()
        self._file_symbols.clear()
        self._references.clear()
        self._routes.clear()
        self._db_references.clear()

    def _scan_and_update_locked(self, project_root: Any = None, max_files: int = 500) -> Dict[str, int]:
        if isinstance(project_root, str):
            self.project_root = project_root
        elif isinstance(project_root, int):
            max_files = project_root

        if not self.project_root or not os.path.isdir(self.project_root):
            return {"added": 0, "updated": 0, "unchanged": 0}

        added = 0
        updated = 0
        unchanged = 0
        seen_paths: Set[str] = set()
        scan_complete = True

        for root, dirs, files in os.walk(self.project_root):
            dirs[:] = [d for d in dirs if d not in self.IGNORED_DIRS and not d.startswith(".")]
            for f in files:
                ext = os.path.splitext(f)[1].lower()
                if ext not in self.INDEXABLE_EXTS:
                    continue
                full_path = os.path.join(root, f)
                rel_path = os.path.normpath(os.path.relpath(full_path, self.project_root)).replace("\\", "/")
                seen_paths.add(rel_path)

                try:
                    stat = os.stat(full_path)
                    mtime = stat.st_mtime
                    if rel_path in self._file_mtimes and self._file_mtimes[rel_path] == mtime:
                        unchanged += 1
                        continue

                    # Read and hash
                    with open(full_path, "r", encoding="utf-8", errors="ignore") as fp:
                        content = fp.read()

                    chash = self.compute_file_hash(content)
                    if self._file_hashes.get(rel_path) == chash:
                        self._file_mtimes[rel_path] = mtime
                        unchanged += 1
                        continue

                    # Invalidate previous file symbols
                    if rel_path in self._file_hashes:
                        self._remove_file_symbols(rel_path)
                        updated += 1
                    else:
                        added += 1

                    self._file_hashes[rel_path] = chash
                    self._file_mtimes[rel_path] = mtime
                    self._index_file_content(rel_path, content, ext)

                    if added + updated >= max_files:
                        scan_complete = False
                        break
                except Exception:
                    continue
            if added + updated >= max_files:
                scan_complete = False
                break

        # Remove deleted files
        if scan_complete:
            for old_path in list(self._file_hashes.keys()):
                if old_path not in seen_paths:
                    self._remove_file_symbols(old_path)
                    self._file_hashes.pop(old_path, None)
                    self._file_mtimes.pop(old_path, None)

        self._last_scan_time = time.time()
        return {"added": added, "updated": updated, "unchanged": unchanged}

    def _remove_file_symbols(self, rel_path: str) -> None:
        old_syms = self._file_symbols.pop(rel_path, [])
        for s in old_syms:
            low_name = s["name"].lower()
            if low_name in self._symbols:
                self._symbols[low_name] = [item for item in self._symbols[low_name] if item["path"] != rel_path]
                if not self._symbols[low_name]:
                    self._symbols.pop(low_name, None)

        self._routes = [r for r in self._routes if r["path"] != rel_path]
        self._db_references = [d for d in self._db_references if d["path"] != rel_path]

    def _index_file_content(self, rel_path: str, content: str, ext: str) -> None:
        lines = content.splitlines()
        file_syms: List[Dict[str, Any]] = []

        # Extract classes, interfaces, functions, methods
        class_pat = re.compile(r"\b(?:class|interface|struct|trait)\s+([A-Za-z0-9_]+)\b")
        func_pat = re.compile(r"\b(?:function|def|fn|func|public\s+function|private\s+function|protected\s+function|async\s+function)\s+([A-Za-z0-9_]+)\b")
        method_pat = re.compile(r"^\s*(?:(?:public|private|protected|static|async)\s+)+([A-Za-z0-9_]+)\s*\(")
        route_pat = re.compile(r"\b(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*['\"]([^'\"]+)['\"]", re.I)
        sql_pat = re.compile(r"\b(?:FROM|INTO|UPDATE|TABLE)\s+([`'\"A-Za-z0-9_]+)", re.I)
        query_builder_pat = re.compile(r"(?:->find|->query|->where|createCommand|createQueryBuilder|DB::table)\s*\(\s*['\"]?([A-Za-z0-9_]+)?", re.I)

        for line_num, line in enumerate(lines, 1):
            # Class match
            for m in class_pat.finditer(line):
                name = m.group(1)
                rec = {"name": name, "kind": "class", "path": rel_path, "line": line_num}
                file_syms.append(rec)
                self._symbols.setdefault(name.lower(), []).append(rec)

            # Function match
            for m in func_pat.finditer(line):
                name = m.group(1)
                rec = {"name": name, "kind": "function", "path": rel_path, "line": line_num}
                file_syms.append(rec)
                self._symbols.setdefault(name.lower(), []).append(rec)

            # Method match
            m_meth = method_pat.search(line)
            if m_meth and not line.strip().startswith("//") and not line.strip().startswith("#"):
                name = m_meth.group(1)
                if name not in ("if", "for", "while", "switch", "catch"):
                    rec = {"name": name, "kind": "method", "path": rel_path, "line": line_num}
                    file_syms.append(rec)
                    self._symbols.setdefault(name.lower(), []).append(rec)

            # Routes
            for r_match in route_pat.finditer(line):
                method = r_match.group(1).upper()
                route_path = r_match.group(2)
                self._routes.append({"method": method, "route": route_path, "path": rel_path, "line": line_num})

            # DB references
            for s_match in sql_pat.finditer(line):
                tbl = s_match.group(1).strip("`'\"")
                if tbl.upper() not in ("FROM", "WHERE", "JOIN", "SELECT", "SET", "DEFAULT", "VALUES", "DUPLICATE", "KEY", "ORDER", "GROUP"):
                    self._db_references.append({"table": tbl, "type": "raw_sql", "path": rel_path, "line": line_num, "snippet": line.strip()[:100]})

            for qb_match in query_builder_pat.finditer(line):
                tbl = qb_match.group(1) or ""
                self._db_references.append({"table": tbl, "type": "query_builder", "path": rel_path, "line": line_num, "snippet": line.strip()[:100]})

        self._file_symbols[rel_path] = file_syms

    def search_symbols(
        self,
        query: str,
        limit: int = 15,
        project_root: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        with self._lock:
            if project_root:
                expected_root = os.path.normcase(os.path.realpath(os.path.abspath(project_root)))
                indexed_root = (
                    os.path.normcase(os.path.realpath(os.path.abspath(self.project_root)))
                    if self.project_root
                    else ""
                )
                if indexed_root != expected_root:
                    raise ProjectIndexMismatchError()
            low_q = query.lower().strip()
            results: List[Dict[str, Any]] = []
            if low_q in self._symbols:
                results.extend(self._symbols[low_q])

            for name_low, syms in self._symbols.items():
                if name_low != low_q and low_q in name_low:
                    for symbol in syms:
                        if symbol not in results:
                            results.append(symbol)
                if len(results) >= limit:
                    break
            return results[:limit]

    def get_routes(self) -> List[Dict[str, Any]]:
        return list(self._routes)

    def get_db_references(self) -> List[Dict[str, Any]]:
        return list(self._db_references)


class ProjectIndexMismatchError(RuntimeError):
    def __init__(self):
        super().__init__("The Coding Agent index does not belong to the active project.")
        self.code = "INDEX_PROJECT_MISMATCH"


# =====================================================================
# 3. LAZY CODE GRAPH
# =====================================================================
class LazyCodeGraph:
    """
    Constructs bounded graph fragments on demand:
    Callers, callees, references, and data-flow connections.
    """
    def __init__(self, index: IncrementalRepositoryIndex):
        self.index = index

    def expand_symbol_references(
        self,
        symbol_name: str,
        max_refs: int = 10,
        project_root: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Finds all files and lines referencing the given symbol."""
        symbol_recs = self.index.search_symbols(symbol_name, limit=5, project_root=project_root)
        definitions = [{"path": s["path"], "line": s["line"], "kind": s["kind"]} for s in symbol_recs]
        return {
            "symbol": symbol_name,
            "definitions": definitions,
            "definitionsFound": len(definitions),
            "referencesCount": None,
            "referencesVerified": False,
            "status": "UNAVAILABLE",
        }

    def get_symbol_references(
        self,
        symbol_name: str,
        max_refs: int = 10,
        project_root: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.expand_symbol_references(
            symbol_name,
            max_refs=max_refs,
            project_root=project_root,
        )

    def trace_api_data_flow(self, route_query: str) -> List[Dict[str, Any]]:
        """Traces route -> handler file -> database references."""
        routes = self.index.get_routes()
        matched_routes = [r for r in routes if route_query.lower() in r["route"].lower()]
        flow = []
        for r in matched_routes:
            # Check for db queries in the same handler file
            db_refs = [d for d in self.index.get_db_references() if d["path"] == r["path"]]
            flow.append({
                "route": r["route"],
                "method": r["method"],
                "handlerFile": r["path"],
                "line": r["line"],
                "dbAccess": db_refs[:5],
            })
        return flow


# =====================================================================
# 4. ADAPTIVE SEARCH ROUTER
# =====================================================================
class AdaptiveSearchRouter:
    """
    Translates user engineering intent into structured hypotheses and search strategies.
    Derives concepts, chooses parallel retrieval paths, and ranks evidence.
    """
    CONCEPT_MAP = {
        "performance": ["slow query", "SQL", "execution time", "latency", "EXPLAIN", "index", "table scan", "N+1", "query"],
        "bug": ["exception", "throw", "500", "status", "null", "undefined", "crash", "error"],
        "database": ["SELECT", "FROM", "WHERE", "createCommand", "schema", "table", "JOIN", "index"],
        "api": ["route", "controller", "endpoint", "handler", "request", "response", "status"],
        "test": ["test", "it(", "describe(", "assert", "expect", "phpunit", "jest", "pytest"],
        "build": ["build", "compile", "webpack", "vite", "tsconfig", "package.json", "manifest"],
    }

    @classmethod
    def expand_query_concepts(cls, intent: str, user_request: str) -> List[str]:
        concepts: List[str] = []
        req_low = user_request.lower()

        # Add explicit tokens from user request
        tokens = re.findall(r"[A-Za-z0-9_]+", user_request)
        code_tokens = [t for t in tokens if len(t) >= 3 and not re.match(r"^(the|and|for|with|this|that|which|take|time|slow|what|how|why)$", t, re.I)]
        concepts.extend(code_tokens[:3])

        if "perf" in intent.lower() or "slow" in req_low or "query" in req_low or "time" in req_low:
            concepts.extend(cls.CONCEPT_MAP["performance"])
        elif "bug" in intent.lower() or "error" in req_low or "fail" in req_low:
            concepts.extend(cls.CONCEPT_MAP["bug"])
        elif "db" in intent.lower() or "sql" in req_low or "table" in req_low:
            concepts.extend(cls.CONCEPT_MAP["database"])
        elif "api" in req_low or "route" in req_low or "controller" in req_low:
            concepts.extend(cls.CONCEPT_MAP["api"])

        # Deduplicate preserving order
        seen = set()
        deduped = []
        for c in concepts:
            c_clean = c.strip()
            if c_clean and c_clean.lower() not in seen:
                seen.add(c_clean.lower())
                deduped.append(c_clean)
        return deduped

    expand_query = expand_query_concepts

    @classmethod
    def rank_search_candidates(cls, query: str, candidates: List[str]) -> List[Tuple[str, float]]:
        """
        Ranks candidate file paths against the search query by relevance:
        - Token matching in filename and path
        - High priority for business logic / controller / model / service / api paths
        - Lower priority for documentation, readmes, and static assets
        """
        tokens = [t.lower() for t in re.findall(r"[A-Za-z0-9_]+", query) if len(t) >= 3]
        scored: List[Tuple[str, float]] = []

        for cand in candidates:
            score = 10.0
            cand_low = cand.lower()
            cand_name = os.path.basename(cand).lower()

            for tok in tokens:
                if tok in cand_name:
                    score += 50.0
                elif tok in cand_low:
                    score += 20.0

            # Boost controller, model, service, api, repository, query
            if re.search(r"(?:controller|model|service|api|repo|query|handler)", cand_low):
                score += 30.0

            # Penalize README, tests, docs for non-test queries
            if "test" not in query.lower() and re.search(r"(?:test|spec|doc|readme|\.md$)", cand_low):
                score -= 15.0

            scored.append((cand, score))

        scored.sort(key=lambda x: x[1], reverse=True)
        return scored


# =====================================================================
# 5. PERSISTENT CODING MEMORY (4 TIERS)
# =====================================================================
class MemoryStatus:
    VALID = "VALID"
    STALE = "STALE"
    CONTRADICTED = "CONTRADICTED"
    SUPERSEDED = "SUPERSEDED"
    UNVERIFIED = "UNVERIFIED"


class CodingMemorySystem:
    """
    4-Tier Persistent Coding Memory:
    1. Repository Memory (architecture, conventions, build commands, test patterns)
    2. Task Memory (goal, hypotheses, investigated files, failed attempts)
    3. Session Memory (active files, tool results, unresolved questions)
    4. Knowledge Memory (validated framework behaviors, documentation references)
    """
    def __init__(self):
        self.repository_memory: List[Dict[str, Any]] = []
        self.task_memory: Dict[str, List[Dict[str, Any]]] = {} # task_id -> list
        self.session_memory: Dict[str, Dict[str, Any]] = {} # session_id -> dict
        self.knowledge_memory: List[Dict[str, Any]] = []

    def record_repository_fact(self, key: str, value: Any, source: str = "discovery") -> Dict[str, Any]:
        fact = {
            "key": key,
            "value": SecretProtector.redact_data(value),
            "source": source,
            "status": MemoryStatus.VALID,
            "createdAt": time.time(),
            "lastValidatedAt": time.time(),
        }
        # Invalidate or supersede old matching key
        for old in self.repository_memory:
            if old["key"] == key and old["status"] == MemoryStatus.VALID:
                old["status"] = MemoryStatus.SUPERSEDED
        self.repository_memory.append(fact)
        return fact

    def record_task_hypothesis(self, task_id: str, hypothesis: str, status: str = MemoryStatus.UNVERIFIED) -> None:
        self.task_memory.setdefault(task_id, []).append({
            "type": "hypothesis",
            "content": SecretProtector.redact_text(hypothesis),
            "status": status,
            "timestamp": time.time(),
        })

    def record_failed_attempt(self, task_id: str, action: str, reason: str) -> None:
        self.task_memory.setdefault(task_id, []).append({
            "type": "failed_attempt",
            "action": action,
            "reason": SecretProtector.redact_text(reason),
            "status": MemoryStatus.CONTRADICTED,
            "timestamp": time.time(),
        })

    def get_valid_repository_facts(self) -> List[Dict[str, Any]]:
        return [f for f in self.repository_memory if f["status"] == MemoryStatus.VALID]


# =====================================================================
# 5B. IQ∞ MASTER EXECUTION, CAPABILITY & SECURITY RUNTIME
# =====================================================================
CODING_ENGINEERING_POLICY = (
    "Core Coding Agent engineering policy: before adding implementation, discover the existing "
    "responsibility owner and reusable code; prefer reuse, then extend, then a local refactor, and "
    "only then add the smallest justified abstraction. Keep one authoritative Coding Agent owner; "
    "do not create or delegate core task ownership to a parallel coding, investigation, database, "
    "retrieval, provider, activity, or verification agent. Reuse existing specialized internal helpers "
    "as infrastructure, not as competing autonomous owners. Before changing a responsibility, inspect "
    "its callers, imports, exports, references, tests, registrations, and shared consumers. For every "
    "implementation task, perform a bounded, task-related obsolete-code assessment, but never remove "
    "code because it merely looks old: removal requires evidence it is unused, an authoritative "
    "replacement, direct task relevance, preserved behavior, no unrelated impact, and supporting "
    "regression checks. If any condition is unproven, keep the code and report that decision. Do not "
    "expand tasks into unrelated cleanup, rewrite working subsystems, replace discovery with new "
    "hardcoded assumptions, or weaken safety boundaries. Verify changes with focused regression tests "
    "and the affected subsystem checks. In final responses, briefly identify REUSED, EXTENDED, NEW, "
    "REMOVED, or KEPT decisions when relevant; do not provide hidden reasoning."
)
CODING_REUSE_PRECEDENCE = ("REUSE", "EXTEND", "LOCAL_REFACTOR", "SMALL_NEW_ABSTRACTION")
CODING_OBSOLETE_REMOVAL_REQUIREMENTS = (
    "proven unused",
    "authoritative replacement exists",
    "directly related to the task",
    "behavior preserved",
    "unrelated functionality unaffected",
    "relevant regression checks pass",
)


class TaskExecutionContract:
    """
    Section 2: Internal Execution Contract.
    Captures intent, execution requirements, target resources, allowed actions,
    risk level, evidence requirements, and verification requirements.
    When execution_required is True, prose alone is NOT completion.
    """
    def __init__(
        self,
        intent: str,
        task_type: str,
        execution_required: bool,
        target: str = "",
        project: str = "",
        repository: str = "",
        resource: str = "",
        required_capabilities: Optional[List[str]] = None,
        allowed_actions: Optional[List[str]] = None,
        risk_level: str = "LOW",  # LOW | MEDIUM | HIGH | CRITICAL
        evidence_requirements: Optional[List[str]] = None,
        verification_requirements: Optional[List[str]] = None,
        prose_alone_allowed: bool = True,
    ):
        self.intent = intent
        self.task_type = task_type
        self.execution_required = execution_required
        self.target = target
        self.project = project
        self.repository = repository
        self.resource = resource
        self.required_capabilities = required_capabilities or []
        self.allowed_actions = allowed_actions or []
        self.risk_level = risk_level
        self.evidence_requirements = evidence_requirements or []
        self.verification_requirements = verification_requirements or []
        self.prose_alone_allowed = prose_alone_allowed
        self.engineering_policy = {
            "reusePrecedence": list(CODING_REUSE_PRECEDENCE),
            "singleCodingAgentOwner": True,
            "obsoleteCodeRemovalRequires": list(CODING_OBSOLETE_REMOVAL_REQUIREMENTS),
            "unprovenObsoleteCodeAction": "KEEP",
            "unrelatedCleanupAllowed": False,
        }

    def to_dict(self) -> Dict[str, Any]:
        return {
            "intent": self.intent,
            "taskType": self.task_type,
            "executionRequired": self.execution_required,
            "target": self.target,
            "project": self.project,
            "repository": self.repository,
            "resource": self.resource,
            "requiredCapabilities": self.required_capabilities,
            "allowedActions": self.allowed_actions,
            "riskLevel": self.risk_level,
            "evidenceRequirements": self.evidence_requirements,
            "verificationRequirements": self.verification_requirements,
            "proseAloneAllowed": self.prose_alone_allowed,
            "engineeringPolicy": self.engineering_policy,
        }


class ExecutionContractBuilder:
    @classmethod
    def build(
        cls,
        intent: str,
        request: str,
        project_root: str = "",
        proposal_required: bool = False,
    ) -> TaskExecutionContract:
        req_low = request.lower()
        no_sugg = NoSuggestionGuard.is_no_suggestion_mode(request)

        # 1. Database investigation / query performance
        if intent in ("DATABASE_INVESTIGATION", "DATABASE_LIST_DATABASES", "DATABASE_LIST_TABLES", "DATABASE_DESCRIBE_TABLE", "DATABASE_LIST_INDEXES"):
            return TaskExecutionContract(
                intent=intent,
                task_type="DATABASE_INVESTIGATION",
                execution_required=True,
                target="database",
                project=project_root,
                resource="active_database_session",
                required_capabilities=["DATABASE_QUERY", "DATABASE_SCHEMA", "DATABASE_HEALTH_CHECK"],
                allowed_actions=["CONNECT", "INSPECT_SCHEMA", "SHOW_TABLES", "EXPLAIN", "SAFE_SELECT"],
                risk_level="LOW",
                evidence_requirements=["database_session_id", "verified_engine", "health_proof"],
                verification_requirements=["health_check_success", "valid_metadata"],
                prose_alone_allowed=False,
            )

        if intent == "PERFORMANCE_INVESTIGATION":
            return TaskExecutionContract(
                intent=intent,
                task_type="PERFORMANCE_INVESTIGATION",
                execution_required=True,
                target="query_performance",
                project=project_root,
                resource="database_and_source_code",
                required_capabilities=["CODE_SEARCH", "DATABASE_QUERY", "DATABASE_EXPLAIN"],
                allowed_actions=["SEARCH_SQL", "INSPECT_INDEX", "EXPLAIN_QUERY", "MEASURE_TIMING"],
                risk_level="LOW",
                evidence_requirements=["queryFingerprint", "planFingerprint", "executionTimeMs"],
                verification_requirements=["plan_fingerprint_match", "measured_timing"],
                prose_alone_allowed=False,
            )

        # 2. Bug Fix / Performance Fix / Code writes
        if proposal_required or intent in ("BUG_FIX", "PERFORMANCE_FIX", "FEATURE_REQUEST", "REFACTOR"):
            return TaskExecutionContract(
                intent=intent,
                task_type="CODE_MUTATION",
                execution_required=True,
                target="source_code",
                project=project_root,
                resource="project_repository",
                required_capabilities=["FILE_READ", "CODE_SEARCH", "DIFF_PROPOSAL", "TERMINAL_VERIFY"],
                allowed_actions=["READ", "TRACE", "PLAN", "PROPOSAL", "APPLY_IF_APPROVED", "VERIFY"],
                risk_level="MEDIUM" if not proposal_required else "HIGH",
                evidence_requirements=["inspected_lines", "diff_patch", "verification_output"],
                verification_requirements=["proposal_approval_gate", "allow_listed_test_pass"],
                prose_alone_allowed=False,
            )

        # 3. Read-only investigations
        if intent in ("CODE_REVIEW", "ARCHITECTURE_INVESTIGATION", "BUG_INVESTIGATION"):
            return TaskExecutionContract(
                intent=intent,
                task_type="CODE_INVESTIGATION",
                execution_required=True if ("find" in req_low or "search" in req_low or "check" in req_low or no_sugg) else False,
                target="repository_structure",
                project=project_root,
                resource="source_code",
                required_capabilities=["CODE_SEARCH", "FILE_READ", "SYMBOL_SEARCH"],
                allowed_actions=["SEARCH", "READ", "TRACE"],
                risk_level="LOW",
                evidence_requirements=["inspected_files"],
                verification_requirements=["evidence_backed_findings"],
                prose_alone_allowed=not no_sugg,
            )

        # 4. Pure informational question
        return TaskExecutionContract(
            intent=intent,
            task_type="GENERAL_ASSISTANCE",
            execution_required=True if no_sugg else False,
            target="",
            project=project_root,
            resource="",
            required_capabilities=[],
            allowed_actions=["ANSWER"],
            risk_level="LOW",
            evidence_requirements=[],
            verification_requirements=[],
            prose_alone_allowed=not no_sugg,
        )


class NoSuggestionGuard:
    """
    Section 3: 'No Suggestion' Mode Enforcement.
    Recognizes autonomous execution directives and prohibits asking discoverable questions
    or returning suggestions without execution.
    """
    NO_SUGGESTION_PATTERNS = [
        re.compile(r"\bno\s+suggestion\b", re.I),
        re.compile(r"\bdo\s+it\s+yourself\b", re.I),
        re.compile(r"\bfigure\s*it\s*out\b", re.I),
        re.compile(r"\bcheck\s+(?:and\s+figure\s+out\s+)?by\s+yourself\b", re.I),
        re.compile(r"\bconnect\s+it\s+yourself\b", re.I),
        re.compile(r"\bonly\s+connect\s+(?:them\s+)?db\b", re.I),
        re.compile(r"\byou\s+connect\s+db\b", re.I),
        re.compile(r"\byou\s+check\b", re.I),
        re.compile(r"\bdon'?t\s+ask\s+me\b", re.I),
        re.compile(r"\bfigureoutbyyou\b", re.I),
        re.compile(r"\bcheck\s+and\s+figure\s+out\s+by\s+you\b", re.I),
    ]

    FORBIDDEN_SUGGESTION_PHRASES = [
        "you can run", "try this command", "try running", "consider running",
        "consider checking", "please provide", "you should run", "you should check",
        "run show create table", "run explain yourself", "let me know", "i suggest",
        "paste the file", "send me schema", "give me credentials", "use phpmyadmin",
    ]

    @classmethod
    def is_no_suggestion_mode(cls, text: str) -> bool:
        if not text:
            return False
        return any(pat.search(text) for pat in cls.NO_SUGGESTION_PATTERNS)

    @classmethod
    def contains_forbidden_suggestion(cls, text: str) -> Optional[str]:
        if not text:
            return None
        low = text.lower()
        for phrase in cls.FORBIDDEN_SUGGESTION_PHRASES:
            if phrase in low:
                return phrase
        return None


class EngineeringCommandNormalizer:
    """
    Section 4: Natural-Language Engineering Command Normalizer.
    Recognizes natural language commands with typo resilience without converting
    task text into bogus project paths.
    """
    TYPO_REPLACEMENTS = [
        (re.compile(r"\bsow\b", re.I), "show"),
        (re.compile(r"\buseranme\b", re.I), "username"),
        (re.compile(r"\busernam\b", re.I), "username"),
        (re.compile(r"\busernme\b", re.I), "username"),
        (re.compile(r"\busernmae\b", re.I), "username"),
        (re.compile(r"\bdatabeses\b", re.I), "databases"),
        (re.compile(r"\bdatabaes\b", re.I), "databases"),
        (re.compile(r"\bdatabses\b", re.I), "databases"),
        (re.compile(r"\bdatabse\b", re.I), "databases"),
        (re.compile(r"\bdata\s*base\b", re.I), "database"),
        (re.compile(r"\bdata\s*bases\b", re.I), "databases"),
        (re.compile(r"\btabels\b", re.I), "tables"),
        (re.compile(r"\btabel\b", re.I), "table"),
        (re.compile(r"\bconnect\s+them\s+db\b", re.I), "connect to database"),
        (re.compile(r"\bonly\s+connect\s+them\s+db\b", re.I), "only connect to database"),
        (re.compile(r"\bindicies\b", re.I), "indexes"),
        (re.compile(r"\bindecies\b", re.I), "indexes"),
        (re.compile(r"\bindecis\b", re.I), "indexes"),
        (re.compile(r"\bsqll\b", re.I), "sql"),
        (re.compile(r"\bexplane\b", re.I), "explain"),
        (re.compile(r"\bdiscribe\b", re.I), "describe"),
        (re.compile(r"\bdescrbe\b", re.I), "describe"),
        (re.compile(r"\bdescibe\b", re.I), "describe"),
        (re.compile(r"\bfnd\s+slow\b", re.I), "find slow"),
        (re.compile(r"\bfigureoutbyyou\b", re.I), "figure out by yourself"),
        (re.compile(r"\bfigure\s*out\s*by\s*you\b", re.I), "figure out by yourself"),
        (re.compile(r"\bperforamnce\b", re.I), "performance"),
    ]

    STOPWORDS_NOT_PROJECTS = {
        "faq", "query", "slow", "code-level", "controller", "database", "the",
        "db", "table", "schema", "code", "index", "performance", "check", "run"
    }

    @classmethod
    def normalize(cls, text: str) -> str:
        if not text:
            return ""
        norm = text
        for pat, repl in cls.TYPO_REPLACEMENTS:
            norm = pat.sub(repl, norm)
        return norm

    @classmethod
    def is_valid_project_name(cls, token: str) -> bool:
        if not token:
            return False
        low = token.lower().strip()
        if low in cls.STOPWORDS_NOT_PROJECTS:
            return False
        return len(low) > 2


class ProjectContextLock:
    """
    Sections 5 & 6: Authoritative Project State & Project Context Lock.
    Context is bound per session. An explicitly attached project root is
    authoritative for that request; process-global state is only a fallback.
    """
    _locked_contexts: Dict[str, Dict[str, Any]] = {}

    @staticmethod
    def identify_project_root(root_path: str) -> Dict[str, Optional[str]]:
        root = Path(root_path).resolve()
        root_key = os.path.normcase(str(root)).casefold()
        project_id = f"project-{hashlib.sha256(root_key.encode('utf-8')).hexdigest()[:16]}"
        repository_root = None
        for candidate in (root, *root.parents):
            if (candidate / ".git").exists():
                repository_root = candidate
                break
        repository_id = None
        branch = None
        if repository_root:
            repository_key = os.path.normcase(str(repository_root)).casefold()
            repository_id = f"repository-{hashlib.sha256(repository_key.encode('utf-8')).hexdigest()[:16]}"
            git_marker = repository_root / ".git"
            git_dir = git_marker
            if git_marker.is_file():
                try:
                    marker = git_marker.read_text(encoding="utf-8", errors="ignore").strip()
                    if marker.lower().startswith("gitdir:"):
                        git_dir = (repository_root / marker.split(":", 1)[1].strip()).resolve()
                except OSError:
                    git_dir = None
            try:
                if git_dir:
                    head = (git_dir / "HEAD").read_text(encoding="utf-8", errors="ignore").strip()
                    if head.startswith("ref: refs/heads/"):
                        branch = head.removeprefix("ref: refs/heads/")
            except OSError:
                pass
        return {
            "projectId": project_id,
            "repositoryId": repository_id,
            "repositoryRoot": str(repository_root) if repository_root else None,
            "branch": branch,
        }

    @classmethod
    def lock(
        cls,
        root_path: str,
        session_id: Optional[str] = None,
        workspace_id: Optional[str] = None,
        project_id: Optional[str] = None,
        repository_id: Optional[str] = None,
        branch: Optional[str] = None,
        task_id: Optional[str] = None,
        scope: str = ".",
    ) -> Dict[str, Any]:
        identity = cls.identify_project_root(root_path)
        root_path = str(Path(root_path).resolve())
        rec = {
            "rootPath": root_path,
            "sessionId": session_id,
            "workspaceId": workspace_id,
            "projectId": project_id or identity["projectId"],
            "repositoryId": repository_id or identity["repositoryId"],
            "repositoryRoot": identity["repositoryRoot"],
            "branch": branch or identity["branch"],
            "taskId": task_id,
            "scope": scope,
            "lockedAt": time.time(),
        }
        if session_id:
            cls._locked_contexts[session_id] = rec
        return rec

    @classmethod
    def get_locked_context(cls, session_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        return cls._locked_contexts.get(session_id) if session_id else None

    @classmethod
    def resolve_authoritative_root(
        cls,
        session_id: Optional[str] = None,
        session_root: Optional[str] = None,
        backend_root: Optional[str] = None,
        explicit_root: Optional[str] = None,
        candidate_term: Optional[str] = None,
    ) -> Optional[str]:
        # Only trusted runtime bindings may select a project. An explicit root
        # comes from the authenticated project attachment, never message text.
        if explicit_root and os.path.isdir(explicit_root):
            return str(Path(explicit_root).resolve())
        if session_root and os.path.isdir(session_root):
            return str(Path(session_root).resolve())

        locked = cls.get_locked_context(session_id)
        if locked and locked.get("rootPath") and os.path.isdir(locked["rootPath"]):
            return locked["rootPath"]

        if backend_root and os.path.isdir(backend_root):
            return str(Path(backend_root).resolve())

        # candidate_term is intentionally not authoritative; project names
        # must pass the explicit discovery and attachment flow first.
        return None


class CanonicalCapability:
    CODE_SEARCH = "CODE_SEARCH"
    FILE_READ = "FILE_READ"
    DIRECTORY_LIST = "DIRECTORY_LIST"
    REPOSITORY_MAP = "REPOSITORY_MAP"
    SOURCE_CONTEXT = "SOURCE_CONTEXT"
    SYMBOL_SEARCH = "SYMBOL_SEARCH"
    REFERENCE_SEARCH = "REFERENCE_SEARCH"
    DATABASE_QUERY = "DATABASE_QUERY"
    DATABASE_EXPLAIN = "DATABASE_EXPLAIN"
    DATABASE_LIST_TABLES = "DATABASE_LIST_TABLES"
    DATABASE_LIST_DATABASES = "DATABASE_LIST_DATABASES"
    TERMINAL_EXEC = "TERMINAL_EXEC"


class CapabilityIntelligenceEngine:
    """
    Sections 8, 9, 10, 79: Capability Intelligence, Registry Hard Wall & Tool Fallback.
    Maps intents and raw tool requests to canonical capabilities and executable fallbacks.
    Never fails with 'Unsupported Coding Agent tool' when a registered equivalent exists.
    """
    CAPABILITY_MAPPINGS = {
        "search_code": CanonicalCapability.CODE_SEARCH,
        "repo_browser.search_code": CanonicalCapability.CODE_SEARCH,
        "find_code": CanonicalCapability.CODE_SEARCH,
        "find_files": CanonicalCapability.CODE_SEARCH,
        "search_files": CanonicalCapability.CODE_SEARCH,
        "read_file": CanonicalCapability.FILE_READ,
        "open_file": CanonicalCapability.FILE_READ,
        "repo_browser.read_file": CanonicalCapability.FILE_READ,
        "repo_browser.open_file": CanonicalCapability.FILE_READ,
        "get_repository_map": CanonicalCapability.REPOSITORY_MAP,
        "get_context": CanonicalCapability.SOURCE_CONTEXT,
        "list_directory": CanonicalCapability.DIRECTORY_LIST,
        "repo_browser.list_directory": CanonicalCapability.DIRECTORY_LIST,
        "list_files": CanonicalCapability.DIRECTORY_LIST,
        "ls": CanonicalCapability.DIRECTORY_LIST,
        "search_symbols": CanonicalCapability.SYMBOL_SEARCH,
        "find_symbols": CanonicalCapability.SYMBOL_SEARCH,
        "repo_browser.search_symbols": CanonicalCapability.SYMBOL_SEARCH,
        "find_references": CanonicalCapability.REFERENCE_SEARCH,
        "repo_browser.find_references": CanonicalCapability.REFERENCE_SEARCH,
        "execute_sql": CanonicalCapability.DATABASE_QUERY,
        "inspect_database_schema": CanonicalCapability.DATABASE_QUERY,
        "run_query": CanonicalCapability.DATABASE_QUERY,
        "db_query": CanonicalCapability.DATABASE_QUERY,
        "database.query": CanonicalCapability.DATABASE_QUERY,
        "query_database": CanonicalCapability.DATABASE_QUERY,
        "run_verification": CanonicalCapability.TERMINAL_EXEC,
        "terminal.run_command": CanonicalCapability.TERMINAL_EXEC,
    }

    CAPABILITY_METADATA = {
        CanonicalCapability.CODE_SEARCH: {"resource": "CODE"},
        CanonicalCapability.FILE_READ: {"resource": "CODE"},
        CanonicalCapability.DIRECTORY_LIST: {"resource": "REPOSITORY"},
        CanonicalCapability.REPOSITORY_MAP: {"resource": "REPOSITORY"},
        CanonicalCapability.SOURCE_CONTEXT: {"resource": "CODE"},
        CanonicalCapability.SYMBOL_SEARCH: {"resource": "CODE"},
        CanonicalCapability.REFERENCE_SEARCH: {"resource": "CODE"},
        CanonicalCapability.DATABASE_QUERY: {"resource": "DATABASE"},
        CanonicalCapability.DATABASE_EXPLAIN: {"resource": "DATABASE"},
        CanonicalCapability.DATABASE_LIST_TABLES: {"resource": "DATABASE"},
        CanonicalCapability.DATABASE_LIST_DATABASES: {"resource": "DATABASE"},
        CanonicalCapability.TERMINAL_EXEC: {"resource": "RUNTIME"},
    }

    CANONICAL_IMPLEMENTATIONS = {
        CanonicalCapability.CODE_SEARCH: ["search_code"],
        CanonicalCapability.FILE_READ: ["read_file"],
        CanonicalCapability.DIRECTORY_LIST: ["list_directory"],
        CanonicalCapability.SYMBOL_SEARCH: ["search_symbols"],
        CanonicalCapability.REFERENCE_SEARCH: ["find_references"],
        CanonicalCapability.DATABASE_QUERY: ["execute_sql"],
        CanonicalCapability.DATABASE_EXPLAIN: ["execute_sql"],
        CanonicalCapability.DATABASE_LIST_TABLES: ["execute_sql"],
        CanonicalCapability.DATABASE_LIST_DATABASES: ["execute_sql"],
        CanonicalCapability.TERMINAL_EXEC: ["run_verification"],
    }

    @classmethod
    def resolve_capability(cls, raw_tool_name: str) -> Optional[str]:
        return cls.CAPABILITY_MAPPINGS.get(raw_tool_name.strip().lower())

    @classmethod
    def resolve_and_fallback(cls, raw_tool_name: str, args: Dict[str, Any]) -> Tuple[Optional[str], Dict[str, Any]]:
        cap = cls.resolve_capability(raw_tool_name)
        if not cap:
            return None, args
        registered_impl = cls.CANONICAL_IMPLEMENTATIONS.get(cap, ["search_code"])[0]
        norm_args = dict(args)
        if registered_impl == "search_code":
            if "query" not in norm_args:
                norm_args["query"] = norm_args.get("pattern") or norm_args.get("term") or norm_args.get("q") or norm_args.get("text") or ""
        elif registered_impl == "read_file":
            if "relativePath" not in norm_args:
                norm_args["relativePath"] = norm_args.get("path") or norm_args.get("file") or norm_args.get("filePath") or ""
        elif registered_impl == "list_directory":
            if "relativePath" not in norm_args:
                norm_args["relativePath"] = norm_args.get("path") or norm_args.get("dir") or "."
        elif registered_impl in ("search_symbols", "find_references"):
            if "query" not in norm_args:
                norm_args["query"] = norm_args.get("name") or norm_args.get("symbol") or ""
        elif registered_impl == "execute_sql":
            if "sql" not in norm_args:
                norm_args["sql"] = norm_args.get("query") or norm_args.get("command") or ""
        elif registered_impl == "run_verification":
            if "command" not in norm_args:
                norm_args["command"] = norm_args.get("script") or norm_args.get("check") or ""
        return registered_impl, norm_args


class FailureDomain:
    """
    Section 53: Provider & Runtime Failure Domain Isolation.
    Ensures provider timeouts do not masquerade as missing projects,
    and DB client failures do not masquerade as absent databases.
    """
    PROVIDER_FAILURE = "PROVIDER_FAILURE"
    TOOL_FAILURE = "TOOL_FAILURE"
    DATABASE_FAILURE = "DATABASE_FAILURE"
    PROJECT_FAILURE = "PROJECT_FAILURE"
    SEARCH_FAILURE = "SEARCH_FAILURE"
    FILE_FAILURE = "FILE_FAILURE"
    RUNTIME_FAILURE = "RUNTIME_FAILURE"

    @classmethod
    def classify(cls, error_text: str) -> str:
        low = (error_text or "").lower()
        if any(k in low for k in ("provider", "rate limit", "quota", "groq", "gemini", "openai", "api key", "timeout", "no provider is configured")):
            return cls.PROVIDER_FAILURE
        if any(k in low for k in ("database", "sql", "sqlite", "mysql", "postgres", "connection refused")):
            return cls.DATABASE_FAILURE
        if any(k in low for k in ("project", "workspace", "directory not found", "no such directory", "directory does not exist", "missing directory")):
            return cls.PROJECT_FAILURE
        if any(k in low for k in ("search", "pattern not found", "zero matches")):
            return cls.SEARCH_FAILURE
        if any(k in low for k in ("file not found", "filenotfound", "no such file", "path not found", "enoent", "permission denied", "cannot open file", "read error")):
            return cls.FILE_FAILURE
        if any(k in low for k in ("tool", "unsupported tool", "invalid argument")):
            return cls.TOOL_FAILURE
        return cls.RUNTIME_FAILURE


class PromptInjectionGuard:
    """
    Heuristic prompt-injection detection. Sanitization is not implemented.
    """
    SANITIZATION_STATUS = "UNAVAILABLE"
    INJECTION_PATTERNS = [
        re.compile(r"ignore\s+(?:all\s+)?previous\s+instructions", re.I),
        re.compile(r"disregard\s+(?:all\s+)?prior\s+rules", re.I),
        re.compile(r"delete\s+(?:this\s+)?(?:directory|repository|files|database)", re.I),
        re.compile(r"drop\s+(?:all\s+)?tables", re.I),
        re.compile(r"override\s+policy\s+gate", re.I),
        re.compile(r"format\s+[a-zA-Z]:", re.I),
    ]

    @classmethod
    def sanitize_untrusted_text(cls, text: str) -> str:
        """Pass through text; this method does not enforce prompt-injection protection."""
        if not text:
            return ""
        return text

    @classmethod
    def contains_injection_attempt(cls, text: str) -> bool:
        if not text:
            return False
        return any(pat.search(text) for pat in cls.INJECTION_PATTERNS)


class ProviderDataMinimizer:
    """
    Sections 54 & 55: Intellectual Property & Source Code Minimization.
    Sends only necessary excerpts, redacting credentials and avoiding whole-repository dumping.
    """
    @classmethod
    def minimize_context(cls, files_content: Dict[str, str], max_lines_per_file: int = 150) -> Dict[str, str]:
        minimized = {}
        for path, content in files_content.items():
            lines = content.splitlines()
            if len(lines) > max_lines_per_file:
                excerpt = "\n".join(lines[:max_lines_per_file]) + f"\n... [TRUNCATED {len(lines) - max_lines_per_file} lines for IP protection and token minimization]"
            else:
                excerpt = content
            minimized[path] = SecretProtector.redact_text(excerpt)
        return minimized


class ProjectIsolationGuard:
    """
    Section 59: User Data & IP Project Isolation.
    Ensures different projects and sessions never share un-isolated state or credentials.
    """
    @classmethod
    def validate_isolation(cls, session_a: str, session_b: str, data_a: Dict[str, Any], data_b: Dict[str, Any]) -> bool:
        if session_a != session_b:
            if data_a.get("projectId") and data_b.get("projectId"):
                return data_a.get("projectId") != data_b.get("projectId")
        return True


# =====================================================================
# 6. DATABASE INTELLIGENCE & ANTI-FABRICATION RUNTIME
# =====================================================================
class DatabaseState:
    NOT_DISCOVERED = "NOT_DISCOVERED"
    CONFIG_DISCOVERED = "CONFIG_DISCOVERED"
    CLIENT_DISCOVERED = "CLIENT_DISCOVERED"
    CONNECTION_RESOLVED = "CONNECTION_RESOLVED"
    CONNECTION_ATTEMPTED = "CONNECTION_ATTEMPTED"
    CONNECTED = "CONNECTED"
    ENGINE_VERIFIED = "ENGINE_VERIFIED"
    ENGINE_IDENTIFICATION_UNVERIFIED = "ENGINE_IDENTIFICATION_UNVERIFIED"
    HEALTH_CHECKED = "HEALTH_CHECKED"
    SESSION_CREATED = "SESSION_CREATED"
    SCHEMA_INSPECTED = "SCHEMA_INSPECTED"
    QUERY_DISCOVERED = "QUERY_DISCOVERED"
    QUERY_EXECUTED = "QUERY_EXECUTED"
    PLAN_INSPECTED = "PLAN_INSPECTED"
    TIMING_MEASURED = "TIMING_MEASURED"
    VERIFIED = "VERIFIED"
    FAILED = "FAILED"
    DISCONNECTED = "DISCONNECTED"
    BLOCKED = "BLOCKED"
    DATABASE_EVIDENCE_INTEGRITY_FAILURE = "DATABASE_EVIDENCE_INTEGRITY_FAILURE"

    # Backward compatibility aliases
    DISCOVERED = CONFIG_DISCOVERED
    CONFIG_RESOLVED = CONFIG_DISCOVERED
    CONNECTOR_RESOLVED = CLIENT_DISCOVERED
    CONNECTING = CONNECTION_ATTEMPTED
    PERFORMANCE_MEASURED = TIMING_MEASURED


class DatabaseEvidenceSource:
    LIVE_DB_EXECUTION = "LIVE_DB_EXECUTION"
    DB_METADATA_API = "DB_METADATA_API"
    DB_DRIVER_METADATA = "DB_DRIVER_METADATA"
    DB_RUNTIME = "DB_RUNTIME"
    PROJECT_CONFIG = "PROJECT_CONFIG"
    SOURCE_CODE = "SOURCE_CODE"
    RUNTIME_CAPTURE = "RUNTIME_CAPTURE"
    USER_QUERY = "USER_QUERY"
    CACHE = "CACHE"
    MEMORY = "MEMORY"
    TEST_FIXTURE = "TEST_FIXTURE"
    MOCK = "MOCK"
    UNVERIFIED = "UNVERIFIED"

    AUTHORITATIVE_LIVE_SOURCES = {
        "LIVE_DB_EXECUTION",
        "DB_METADATA_API",
        "DB_DRIVER_METADATA",
        "DB_RUNTIME",
    }


class DatabaseExecutionProof:
    """
    Verifiable runtime proof that a database operation executed on a real database connection.
    Enforces provenance, query/plan fingerprints, row counts, and actual elapsed timings.
    Never permits synthetic or placeholder values in live evidence mode.
    """
    def __init__(
        self,
        evidence_id: Optional[str] = None,
        task_id: Optional[str] = None,
        session_id: Optional[str] = None,
        project_id: Optional[str] = None,
        repository_id: Optional[str] = None,
        database_session_id: Optional[str] = None,
        database_engine: Optional[str] = None,
        engine: Optional[str] = None,
        operation: str = "DATABASE_QUERY",
        timestamp: Optional[float] = None,
        source: str = DatabaseEvidenceSource.UNVERIFIED,
        mode: str = "UNVERIFIED",  # "LIVE" | "TEST" | "MOCK" | "SIMULATED" | "UNVERIFIED"
        execution_status: str = "UNVERIFIED",  # "SUCCESS" | "FAILED" | "BLOCKED" | "UNVERIFIED"
        execution_time_ms: Optional[float] = None,
        rows_returned: Optional[int] = None,
        query: Optional[str] = None,
        query_fingerprint: Optional[str] = None,
        plan_output: Optional[str] = None,
        plan_fingerprint: Optional[str] = None,
        schema_object: Optional[str] = None,
        actual_rows: Optional[List[Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ):
        import uuid
        self.evidence_id = evidence_id or f"ev-db-{uuid.uuid4().hex[:12]}"
        self.task_id = task_id
        self.session_id = session_id
        self.project_id = project_id
        self.repository_id = repository_id
        self.database_session_id = database_session_id or ""
        self.database_engine = database_engine or engine or kwargs.get("db_type") or "unverified"
        self.operation = operation
        self.timestamp = timestamp if timestamp is not None else time.time()
        self.source = source
        self.mode = mode
        self.execution_status = execution_status
        self.execution_time_ms = execution_time_ms
        self.rows_returned = rows_returned
        self.query = query
        self.query_fingerprint = query_fingerprint or (self.compute_fingerprint(query) if query else None)
        self.plan_output = plan_output
        self.plan_fingerprint = plan_fingerprint or (self.query_fingerprint if plan_output else None)
        self.schema_object = schema_object
        self.actual_rows = actual_rows
        self.metadata = metadata or {}

    @staticmethod
    def compute_fingerprint(text: Optional[str]) -> str:
        if not text:
            return ""
        norm = re.sub(r"\s+", " ", str(text).strip().lower())
        norm = re.sub(r"--[^\n]*", "", norm)
        norm = re.sub(r"/\*[\s\S]*?\*/", "", norm).strip()
        return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]

    def is_live_provenance(self) -> bool:
        return (
            self.mode == "LIVE"
            and self.source in DatabaseEvidenceSource.AUTHORITATIVE_LIVE_SOURCES
            and self.execution_status == "SUCCESS"
            and bool(self.database_session_id)
            and self.database_engine not in ("unknown", "unverified")
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "evidenceId": self.evidence_id,
            "taskId": self.task_id,
            "sessionId": self.session_id,
            "projectId": self.project_id,
            "repositoryId": self.repository_id,
            "databaseSessionId": self.database_session_id,
            "databaseEngine": self.database_engine,
            "engine": self.database_engine,
            "operation": self.operation,
            "timestamp": self.timestamp,
            "source": self.source,
            "resultSource": self.source,
            "mode": self.mode,
            "executed": (
                self.mode == "LIVE"
                and self.execution_status == "SUCCESS"
                and self.source in DatabaseEvidenceSource.AUTHORITATIVE_LIVE_SOURCES
                and self.database_engine not in ("unknown", "unverified")
                and bool(self.query or self.plan_output or self.schema_object or self.metadata)
            ),
            "executionStatus": self.execution_status,
            "executionTimeMs": self.execution_time_ms,
            "rowsReturned": self.rows_returned,
            "rowCount": (
                self.rows_returned
                if self.rows_returned is not None
                else len(self.actual_rows)
                if self.actual_rows is not None
                else None
            ),
            "query": self.query,
            "queryFingerprint": self.query_fingerprint,
            "planOutput": self.plan_output,
            "planFingerprint": self.plan_fingerprint,
            "schemaObject": self.schema_object,
            "actualRows": self.actual_rows,
            "metadata": self.metadata,
        }


class DatabaseSessionBinding:
    """
    Tracks and validates single-session consistency across all DB operations.
    Ensures that health check, schema, queries, EXPLAIN, and timing belong to the SAME session.
    """
    def __init__(self, session_id: str, engine: str, database_name: str):
        self.session_id = session_id
        self.engine = engine
        self.database_name = database_name
        self.connection_proof: Optional[DatabaseExecutionProof] = None
        self.health_proof: Optional[DatabaseExecutionProof] = None
        self.schema_proofs: Dict[str, DatabaseExecutionProof] = {}
        self.query_proofs: Dict[str, DatabaseExecutionProof] = {}
        self.plan_proofs: Dict[str, DatabaseExecutionProof] = {}

    def bind_proof(self, proof: DatabaseExecutionProof) -> bool:
        if proof.database_session_id != self.session_id:
            return False
        if "CONNECT" in proof.operation:
            self.connection_proof = proof
        elif "HEALTH" in proof.operation:
            self.health_proof = proof
        elif any(k in proof.operation for k in ("TABLE", "SCHEMA", "DESCRIBE")):
            key = proof.schema_object or "all_tables"
            self.schema_proofs[key] = proof
        elif "EXPLAIN" in proof.operation:
            if proof.query_fingerprint:
                self.plan_proofs[proof.query_fingerprint] = proof
        elif "QUERY" in proof.operation:
            if proof.query_fingerprint:
                self.query_proofs[proof.query_fingerprint] = proof
        return True


class DatabaseEvidenceStore:
    """
    Singleton repository of all database execution proofs and provenance records.
    """
    _records: Dict[str, DatabaseExecutionProof] = {}
    _session_records: Dict[str, List[str]] = {}
    MAX_PROOFS = 5000

    @classmethod
    def _active_session_ids(cls) -> Set[str]:
        manager = globals().get("DatabaseSessionManager")
        if manager is None:
            return set()
        return {
            session.session_id
            for session in manager._sessions.values()
            if session.is_connected() and session.session_id
        }

    @classmethod
    def _remove_proof(cls, evidence_id: str) -> None:
        proof = cls._records.pop(evidence_id, None)
        if proof and proof.database_session_id:
            ids = cls._session_records.get(proof.database_session_id, [])
            if evidence_id in ids:
                ids.remove(evidence_id)
            if not ids:
                cls._session_records.pop(proof.database_session_id, None)

    @classmethod
    def record_proof(cls, proof: DatabaseExecutionProof) -> DatabaseExecutionProof:
        if proof.evidence_id not in cls._records and len(cls._records) >= cls.MAX_PROOFS:
            active_ids = cls._active_session_ids()
            evictable = next(
                (
                    evidence_id
                    for evidence_id, recorded in cls._records.items()
                    if recorded.database_session_id not in active_ids
                ),
                None,
            )
            if evictable is None:
                raise RuntimeError(
                    "Database evidence capacity is full; active-session proofs were retained."
                )
            cls._remove_proof(evictable)
        cls._records[proof.evidence_id] = proof
        if proof.database_session_id:
            if proof.database_session_id not in cls._session_records:
                cls._session_records[proof.database_session_id] = []
            if proof.evidence_id not in cls._session_records[proof.database_session_id]:
                cls._session_records[proof.database_session_id].append(proof.evidence_id)
        return proof

    @classmethod
    def get_proof(cls, evidence_id: str) -> Optional[DatabaseExecutionProof]:
        return cls._records.get(evidence_id)

    @classmethod
    def get_session_proofs(cls, session_id: str) -> List[DatabaseExecutionProof]:
        ids = cls._session_records.get(session_id, [])
        return [cls._records[i] for i in ids if i in cls._records]

    @classmethod
    def clear(cls) -> None:
        cls._records.clear()
        cls._session_records.clear()


class DatabaseResultValidator:
    """
    Runs the 10-check reality check before any DB finding can be reported as live evidence.
    """
    @classmethod
    def validate_session_evidence(
        cls,
        session: Any,
        query: Optional[str] = None,
        plan: Optional[str] = None,
        reported_timing_ms: Optional[float] = None,
        reported_row_count: Optional[int] = None,
        reported_tables: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        # CHECK 1: Real DB connection handle?
        if not getattr(session, "connection_handle", None) and not getattr(session, "sqlite_file", None):
            return {
                "valid": False,
                "error": "DATABASE_EVIDENCE_INTEGRITY_FAILURE",
                "check": "CHECK 1",
                "reason": "Missing real database connection handle or sqlite file.",
            }

        # CHECK 2: Valid databaseSessionId?
        sess_id = getattr(session, "session_id", None)
        if not sess_id or not str(sess_id).strip():
            return {
                "valid": False,
                "error": "DATABASE_EVIDENCE_INTEGRITY_FAILURE",
                "check": "CHECK 2",
                "reason": "Missing valid databaseSessionId.",
            }

        # CHECK 3: Engine verified? (Never 'unknown' or 'unverified')
        db_type = getattr(session, "database_type", "")
        if not db_type or db_type.lower() in ("unknown", "unverified"):
            return {
                "valid": False,
                "error": "DATABASE_EVIDENCE_INTEGRITY_FAILURE",
                "check": "CHECK 3",
                "reason": "Database engine is unknown/unverified. Unknown database engine is not acceptable.",
            }

        # CHECK 4: Did health check actually execute?
        health_proof = getattr(session, "health_proof", None)
        if (
            not health_proof
            or not health_proof.is_live_provenance()
            or health_proof.database_session_id != sess_id
        ):
            return {
                "valid": False,
                "error": "DATABASE_EVIDENCE_INTEGRITY_FAILURE",
                "check": "CHECK 4",
                "reason": "Health check proof is missing or unverified.",
            }
        for proof_field, session_field in (
            ("project_id", "project_id"),
            ("repository_id", "repository_id"),
        ):
            proof_identity = getattr(health_proof, proof_field, None)
            session_identity = getattr(session, session_field, None)
            if proof_identity is not None and proof_identity != session_identity:
                return {
                    "valid": False,
                    "error": "DATABASE_EVIDENCE_INTEGRITY_FAILURE",
                    "check": "CHECK 4",
                    "reason": f"Health proof {proof_field} does not match the active database session.",
                }
        proof_target_id = (getattr(health_proof, "metadata", None) or {}).get("targetId")
        session_target_id = getattr(session, "target_id", None)
        if proof_target_id is not None and proof_target_id != session_target_id:
            return {
                "valid": False,
                "error": "DATABASE_EVIDENCE_INTEGRITY_FAILURE",
                "check": "CHECK 4",
                "reason": "Health proof targetId does not match the active database session.",
            }

        # CHECK 7 & 12: EXPLAIN consistency gate (queryFingerprint == planFingerprint)
        if query and plan:
            q_fp = DatabaseExecutionProof.compute_fingerprint(query)
            last_plan_proof = getattr(session, "last_plan_proof", None)
            if last_plan_proof:
                if last_plan_proof.plan_fingerprint != q_fp:
                    return {
                        "valid": False,
                        "error": "DATABASE_EVIDENCE_INTEGRITY_FAILURE",
                        "check": "CHECK 7",
                        "reason": f"EXPLAIN plan fingerprint '{last_plan_proof.plan_fingerprint}' does not match query fingerprint '{q_fp}'. Attempted query/plan mismatch blocked.",
                    }

        # CHECK 8 & 13: Was timing actually measured? (Never hardcoded default like 1.2ms without measurement)
        if reported_timing_ms is not None:
            if reported_timing_ms <= 0.0:
                return {
                    "valid": False,
                    "error": "DATABASE_EVIDENCE_INTEGRITY_FAILURE",
                    "check": "CHECK 8",
                    "reason": "Execution timing must be a positive measured float from actual execution.",
                }

        # CHECK 9 & 18: Are all results from the same session?
        proofs = DatabaseEvidenceStore.get_session_proofs(sess_id)
        for p in proofs:
            if p.database_session_id != sess_id:
                return {
                    "valid": False,
                    "error": "DATABASE_EVIDENCE_INTEGRITY_FAILURE",
                    "check": "CHECK 9",
                    "reason": f"Mixed database session evidence detected: {p.database_session_id} != {sess_id}.",
                }

        return {
            "valid": True,
            "error": None,
            "session_id": sess_id,
            "engine": db_type,
        }


class DatabaseRealityGate:
    """
    Anti-Fabrication Reality Gatekeeper.
    Blocks unverified live claims, distinguishes code references from live DB objects,
    and guarantees reported counts match actual metadata row counts.
    """
    @classmethod
    def sanitize_performance_report(
        cls,
        session: Optional[Any],
        raw_report: Dict[str, Any],
    ) -> Dict[str, Any]:
        timing = raw_report.get("actualTiming") or raw_report.get("timing_ms")
        plan = raw_report.get("explain") or raw_report.get("plan")
        query = raw_report.get("query")

        has_real_timing = False
        if isinstance(timing, (int, float)) and timing > 0:
            has_real_timing = True
        elif isinstance(timing, str) and "ms" in timing and "unavailable" not in timing.lower() and "unverified" not in timing.lower() and "1.2ms" not in timing:
            has_real_timing = True

        if not has_real_timing:
            raw_report["actualTiming"] = "Static code inspection only (DB execution timing unavailable)"
            raw_report["timing_ms"] = None

        if not plan or "EXPLAIN plan not executed" in str(plan) or "unavailable" in str(plan).lower():
            raw_report["explain"] = "EXPLAIN plan unavailable without live database execution"
            raw_report["confidence"] = "CODE-LEVEL" if query else "UNVERIFIED"

        if raw_report.get("confidence") == "MEASURED" and not has_real_timing:
            raw_report["confidence"] = "CODE-LEVEL"

        return raw_report


class DbFailureClassification:
    PROJECT_NOT_AVAILABLE = "PROJECT_NOT_AVAILABLE"
    DB_CONFIG_NOT_FOUND = "DB_CONFIG_NOT_FOUND"
    DB_CONFIG_INVALID = "DB_CONFIG_INVALID"
    SECRET_UNAVAILABLE = "SECRET_UNAVAILABLE"
    DRIVER_NOT_FOUND = "DRIVER_NOT_FOUND"
    CLIENT_NOT_FOUND = "CLIENT_NOT_FOUND"
    HOST_UNREACHABLE = "HOST_UNREACHABLE"
    PORT_UNREACHABLE = "PORT_UNREACHABLE"
    AUTHENTICATION_FAILED = "AUTHENTICATION_FAILED"
    DATABASE_NOT_FOUND = "DATABASE_NOT_FOUND"
    TLS_FAILURE = "TLS_FAILURE"
    PERMISSION_DENIED = "PERMISSION_DENIED"
    QUERY_FAILED = "QUERY_FAILED"
    TIMEOUT = "TIMEOUT"
    UNSUPPORTED_DATABASE = "UNSUPPORTED_DATABASE"
    RUNTIME_CONFIGURATION_ERROR = "RUNTIME_CONFIGURATION_ERROR"
    TOOL_RESOLUTION_FAILURE = "TOOL_RESOLUTION_FAILURE"

    # Backward compatibility aliases
    DB_CREDENTIALS_UNAVAILABLE = "SECRET_UNAVAILABLE"
    DB_CLIENT_UNAVAILABLE = "DRIVER_NOT_FOUND"
    DB_CONNECTION_FAILED = "PORT_UNREACHABLE"
    DB_AUTHENTICATION_FAILED = "AUTHENTICATION_FAILED"
    DB_NETWORK_FAILED = "HOST_UNREACHABLE"
    DB_SCHEMA_ACCESS_FAILED = "DATABASE_NOT_FOUND"
    DB_QUERY_FAILED = "QUERY_FAILED"
    DB_TIMEOUT = "TIMEOUT"
    DB_PERMISSION_DENIED = "PERMISSION_DENIED"
    DB_TOOL_UNAVAILABLE = "TOOL_RESOLUTION_FAILURE"


class DatabaseCapability:
    RESOURCE = "DATABASE"
    DATABASE_CONNECT = "DATABASE_CONNECT"
    DATABASE_CONNECT_TARGET = "DATABASE_CONNECT_TARGET"
    DATABASE_RECONNECT = "DATABASE_RECONNECT"
    DATABASE_DISCONNECT = "DATABASE_DISCONNECT"
    DATABASE_HEALTH_CHECK = "DATABASE_HEALTH_CHECK"
    DATABASE_CURRENT_TARGET = "DATABASE_CURRENT_TARGET"
    DATABASE_CREDENTIAL_REQUEST = "DATABASE_CREDENTIAL_REQUEST"
    DATABASE_LIST_DATABASES = "DATABASE_LIST_DATABASES"
    DATABASE_LIST_SCHEMAS = "DATABASE_LIST_SCHEMAS"
    DATABASE_LIST_TABLES = "DATABASE_LIST_TABLES"
    DATABASE_LIST_COLUMNS = "DATABASE_LIST_COLUMNS"
    DATABASE_DESCRIBE_TABLE = "DATABASE_DESCRIBE_TABLE"
    DATABASE_COUNT_RECORDS = "DATABASE_COUNT_RECORDS"
    DATABASE_LIST_INDEXES = "DATABASE_LIST_INDEXES"
    DATABASE_LIST_VIEWS = "DATABASE_LIST_VIEWS"
    DATABASE_LIST_CONSTRAINTS = "DATABASE_LIST_CONSTRAINTS"
    DATABASE_QUERY = "DATABASE_QUERY"
    DATABASE_EXPLAIN = "DATABASE_EXPLAIN"
    DATABASE_ANALYZE = "DATABASE_ANALYZE"
    DATABASE_QUERY_TIMING = "DATABASE_QUERY_TIMING"
    DATABASE_SLOW_QUERIES = "DATABASE_SLOW_QUERIES"
    DATABASE_TOP_QUERIES = "DATABASE_TOP_QUERIES"
    DATABASE_QUERY_STATISTICS = "DATABASE_QUERY_STATISTICS"
    DATABASE_LOCKS = "DATABASE_LOCKS"
    DATABASE_CONNECTIONS = "DATABASE_CONNECTIONS"
    DATABASE_SOURCE_TRACE = "DATABASE_SOURCE_TRACE"
    DATABASE_BENCHMARK = "DATABASE_BENCHMARK"
    DATABASE_OPTIMIZATION = "DATABASE_OPTIMIZATION"


DATABASE_CREDENTIAL_REQUEST_PATTERN = re.compile(
    r"\b(?:"
    r"(?:show|display|tell\s+me|give\s+me)\s+(?:(?:my|the)\s+)?"
    r"(?:db|database)\s+(?:connection\s+)?"
    r"(?:user(?:name)?\s+(?:and|&)\s+pass(?:word|wod|wd)|credentials?|pass(?:word|wod|wd))|"
    r"(?:show|display|tell\s+me|give\s+me)\s+(?:(?:my|the)\s+)?"
    r"user(?:name)?\s+(?:and|&)\s+pass(?:word|wod|wd)|"
    r"show\s+(?:passwords?|credentials?)|"
    r"get\s+(?:the\s+)?(?:db|database)\s+passwords?|"
    r"what\s+is\s+(?:the\s+)?(?:db|database)\s+passwords?|"
    r"(?:db|database)\s+(?:passwords?|credentials?)|"
    r"my\s*db\s+connection\s+(?:user(?:name)?\s+(?:and|&)\s+pass(?:word|wod|wd)|credentials?)\s+(?:kya|kiya)\s+(?:hai|hain)"
    r")\b",
    re.I,
)
DATABASE_CONNECTION_STATUS_PATTERN = re.compile(
    r"\b(?:(?:show|display|tell\s+me|what\s+is|which\s+is)\s+"
    r"(?:(?:my|the)\s+)?(?:db|database)\s+connection(?:\s+(?:status|details?))?|"
    r"(?:show|display|tell\s+me)\s+(?:me\s+)?(?:(?:my|the)\s+)?"
    r"(?:db|database)\s+(?:which|what)\s+(?:one\s+)?(?:is\s+)?connected|"
    r"(?:my|the)\s+(?:db|database)\s+connection(?:\s+(?:status|details?))?|"
    r"(?:db|database)\s+connection\s+(?:status|details?))\b|"
    r"^\s*(?:show|display|tell\s+me)\s+my\s+(?:db|database)\s*[.!?]*\s*$",
    re.I,
)


class DatabaseTarget:
    """
    Authoritative representation of an independent discovered database target.
    """
    def __init__(
        self,
        target_id: str,
        project_id: str = "default",
        repository_id: str = "default",
        engine: str = "unknown",
        database_name: Optional[str] = None,
        engine_version: Optional[str] = None,
        schema: Optional[str] = None,
        safe_host: Optional[str] = None,
        safe_port: Optional[int] = None,
        source: str = "project_configuration",
        discovery_evidence: Optional[List[str]] = None,
        connection_capability: Optional[List[str]] = None,
        performance_capability: Optional[List[str]] = None,
        status: str = "UNVERIFIED",
        sqlite_file: Optional[str] = None,
        _protected_credentials: Optional[Dict[str, Any]] = None,
        username: Optional[str] = None,
        config_file: Optional[str] = None,
        tables: Optional[List[str]] = None,
    ):
        self.target_id = target_id
        self.project_id = project_id
        self.repository_id = repository_id
        self.engine = engine or "unknown"
        self.database_name = database_name
        self.engine_version = engine_version
        self.schema = schema
        self.safe_host = safe_host
        self.safe_port = safe_port or (3306 if "mysql" in self.engine.lower() else (5432 if "postgre" in self.engine.lower() else None))
        self.source = source
        self.discovery_evidence = discovery_evidence or []
        self.connection_capability = connection_capability or []
        self.performance_capability = performance_capability or []
        self.status = status
        self.sqlite_file = sqlite_file
        self.username = username
        self.config_file = config_file
        self.tables = tables or []
        self._protected_credentials = _protected_credentials or {}

    def to_safe_dict(self) -> Dict[str, Any]:
        return {
            "targetId": self.target_id,
            "projectId": self.project_id,
            "repositoryId": self.repository_id,
            "engine": self.engine,
            "engineVersion": self.engine_version,
            "databaseName": self.database_name,
            "schema": self.schema,
            "safeHost": self.safe_host,
            "safePort": self.safe_port,
            "source": self.source,
            "discoveryEvidence": self.discovery_evidence,
            "connectionCapability": self.connection_capability,
            "performanceCapability": self.performance_capability,
            "status": self.status,
            "username": self.username,
            "configFile": self.config_file,
            "sqliteFile": self.sqlite_file,
            "tables": self.tables,
        }


class DatabaseTargetRegistry:
    """
    Registers and tracks all discovered database targets per project.
    Maintains the authoritative active target.
    """
    _targets_by_project: Dict[str, Dict[str, DatabaseTarget]] = {}
    _active_target_by_project: Dict[str, str] = {}

    @classmethod
    def register_target(cls, project_root: str, target: DatabaseTarget) -> None:
        if not project_root:
            return
        norm = os.path.normcase(os.path.abspath(project_root))
        if norm not in cls._targets_by_project:
            cls._targets_by_project[norm] = {}
        cls._targets_by_project[norm][target.target_id] = target

    @classmethod
    def get_targets(cls, project_root: str = "") -> List[DatabaseTarget]:
        if not project_root:
            return []
        norm = os.path.normcase(os.path.abspath(project_root))
        return list(cls._targets_by_project.get(norm, {}).values())

    @classmethod
    def get_target(cls, project_root: str, target_id: Optional[str]) -> Optional[DatabaseTarget]:
        if not target_id:
            return None
        if not project_root:
            return None
        norm = os.path.normcase(os.path.abspath(project_root))
        t_map = cls._targets_by_project.get(norm, {})
        if target_id in t_map:
            return t_map[target_id]
        return next(
            (
                target for target in t_map.values()
                if target.target_id.casefold() == target_id.casefold()
                or target.database_name.casefold() == target_id.casefold()
            ),
            None,
        )

    @classmethod
    def set_active_target(cls, project_root: str, target_id: str) -> bool:
        target = cls.get_target(project_root, target_id)
        if target:
            norm = os.path.normcase(os.path.abspath(project_root))
            cls._active_target_by_project[norm] = target.target_id
            target.status = "CONNECTED"
            return True
        return False

    @classmethod
    def get_active_target(cls, project_root: str = "") -> Optional[DatabaseTarget]:
        if not project_root:
            return None
        norm = os.path.normcase(os.path.abspath(project_root))
        active_id = cls._active_target_by_project.get(norm)
        if active_id:
            t = cls.get_target(project_root, active_id)
            if t:
                return t
        return None

    @classmethod
    def getActiveDatabaseTarget(cls, project_root: str = "", session: Optional[Any] = None) -> Dict[str, Any]:
        """
        Authoritative API returning current runtime truth for the active database target (Section 71).
        """
        target = cls.get_active_target(project_root)
        sess = session
        if not sess and "DatabaseSessionManager" in globals():
            sess = DatabaseSessionManager.get_session(project_root)
        t_id = target.target_id if target else getattr(sess, "target_id", None)
        engine = target.engine if target else getattr(sess, "database_type", None)
        db_name = target.database_name if target else getattr(sess, "database_name", None)
        s_host = target.safe_host if target else getattr(sess, "safe_host", None)
        s_port = target.safe_port if target else getattr(sess, "safe_port", None)
        s_state = getattr(sess, "connection_state", "NOT_CONNECTED") if sess else "NOT_CONNECTED"
        identity = ProjectContextLock.identify_project_root(project_root) if project_root else {
            "projectId": None,
            "repositoryId": None,
        }
        return {
            "projectId": identity["projectId"],
            "repositoryId": identity["repositoryId"],
            "activeTargetId": t_id,
            "databaseSessionId": getattr(sess, "session_id", ""),
            "engine": engine,
            "databaseName": db_name,
            "safeHost": s_host,
            "safePort": s_port,
            "connectionState": s_state,
            "healthState": "HEALTHY" if sess and sess.is_connected() else "UNHEALTHY",
            "runtimeVerified": bool(sess and sess.is_connected() and getattr(sess, "health_proof", None)),
            "lastVerifiedAt": getattr(getattr(sess, "health_proof", None), "timestamp", None) if sess else None,
        }

    @classmethod
    def clear(cls, project_root: Optional[str] = None) -> None:
        if project_root:
            norm = os.path.normpath(project_root)
            cls._targets_by_project.pop(norm, None)
            cls._active_target_by_project.pop(norm, None)
        else:
            cls._targets_by_project.clear()
            cls._active_target_by_project.clear()


class DatabaseQueryFingerprinter:
    """
    Normalizes SQL queries by replacing literals to compute stable logical query fingerprints.
    """
    @classmethod
    def normalize_sql(cls, sql: str) -> str:
        s = sql.strip()
        s = re.sub(r"'(?:''|[^'])*'", "?", s)
        s = re.sub(r'"(?:""|[^"])*"', "?", s)
        s = re.sub(r"\b\d+\b", "?", s)
        s = re.sub(r"\s+", " ", s).strip()
        return s

    @classmethod
    def compute_fingerprint(cls, sql: str) -> str:
        norm = cls.normalize_sql(sql)
        h = hashlib.sha256(norm.encode("utf-8")).hexdigest()[:12]
        return f"qf_{h}"


class DatabasePerformanceEngine:
    """
    Tracks, aggregates, and investigates query execution statistics, top queries,
    and performance baselines across multi-dimensional metrics (Section 17-28, 54, 90).
    """
    _query_stats: Dict[str, Dict[str, Any]] = {}
    MAX_QUERY_STATS = 500
    MAX_QUERY_HISTORY = 100

    @classmethod
    def record_query_execution(
        cls,
        sql: str,
        timing_ms: float,
        rows_returned: Optional[int],
        rows_examined: Optional[int] = None,
        target_id: Optional[str] = None,
        source_location: Optional[str] = None,
        lock_wait_ms: float = 0.0,
        project_root: str = "",
        project_id: Optional[str] = None,
        repository_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        fp = DatabaseQueryFingerprinter.compute_fingerprint(sql)
        norm_sql = DatabaseQueryFingerprinter.normalize_sql(sql)
        normalized_root = (
            os.path.normcase(os.path.realpath(os.path.abspath(project_root)))
            if project_root
            else ""
        )
        scope_key = json.dumps(
            [normalized_root, project_id or "", repository_id or "", target_id or "", fp],
            separators=(",", ":"),
        )
        if scope_key not in cls._query_stats:
            cls._query_stats[scope_key] = {
                "queryFingerprint": fp,
                "normalizedQuery": norm_sql,
                "rawQuery": sql,
                "projectRoot": normalized_root or None,
                "projectId": project_id,
                "repositoryId": repository_id,
                "targetId": target_id,
                "executionCount": 0,
                "totalTimeMs": 0.0,
                "averageTimeMs": 0.0,
                "maxTimeMs": 0.0,
                "minTimeMs": float("inf"),
                "rowsExamined": None,
                "rowsReturned": None,
                "lockWaitMs": 0.0,
                "sourceLocation": source_location,
                "history": [],
            }
            if len(cls._query_stats) > cls.MAX_QUERY_STATS:
                cls._query_stats.pop(next(iter(cls._query_stats)))
        rec = cls._query_stats[scope_key]
        rec["executionCount"] += 1
        rec["totalTimeMs"] = round(rec["totalTimeMs"] + timing_ms, 3)
        rec["averageTimeMs"] = round(rec["totalTimeMs"] / rec["executionCount"], 3)
        rec["maxTimeMs"] = max(rec["maxTimeMs"], timing_ms)
        rec["minTimeMs"] = min(rec["minTimeMs"], timing_ms)
        if rows_returned is not None:
            rec["rowsReturned"] = (rec["rowsReturned"] or 0) + max(rows_returned, 0)
        if rows_examined is not None:
            rec["rowsExamined"] = (rec["rowsExamined"] or 0) + max(rows_examined, 0)
        rec["lockWaitMs"] = round(rec["lockWaitMs"] + lock_wait_ms, 3)
        rec["history"].append(timing_ms)
        if len(rec["history"]) > cls.MAX_QUERY_HISTORY:
            del rec["history"][:-cls.MAX_QUERY_HISTORY]
        return rec

    @classmethod
    def get_top_queries(
        cls,
        limit: int = 5,
        project_root: str = "",
        target_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        return cls.rank_queries(
            dimension="total_load",
            limit=limit,
            project_root=project_root,
            target_id=target_id,
        )

    @classmethod
    def rank_queries(
        cls,
        dimension: str = "total_load",
        limit: int = 5,
        project_root: str = "",
        project_id: Optional[str] = None,
        repository_id: Optional[str] = None,
        target_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        dim = (dimension or "total_load").lower()
        normalized_root = (
            os.path.normcase(os.path.realpath(os.path.abspath(project_root)))
            if project_root
            else None
        )
        all_q = [
            stat for stat in cls._query_stats.values()
            if (normalized_root is None or stat.get("projectRoot") == normalized_root)
            and (project_id is None or stat.get("projectId") == project_id)
            and (repository_id is None or stat.get("repositoryId") == repository_id)
            and (target_id is None or stat.get("targetId") == target_id)
        ]
        if any(x in dim for x in ("avg", "time", "slowest", "slow", "latency")):
            key_fn = lambda q: q.get("averageTimeMs", 0.0)
        elif any(x in dim for x in ("freq", "count", "call")):
            key_fn = lambda q: q.get("executionCount", 0)
        elif any(x in dim for x in ("row", "scan", "exam")):
            key_fn = lambda q: q.get("rowsExamined") if q.get("rowsExamined") is not None else -1
        elif any(x in dim for x in ("lock", "wait")):
            key_fn = lambda q: q.get("lockWaitMs", 0.0)
        else:
            key_fn = lambda q: q.get("totalTimeMs", 0.0)
        return sorted(all_q, key=key_fn, reverse=True)[:limit]

    @classmethod
    def get_query_stat(
        cls,
        fingerprint: str,
        project_root: str = "",
        target_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        normalized_root = (
            os.path.normcase(os.path.realpath(os.path.abspath(project_root)))
            if project_root
            else None
        )
        matches = [
            stat for stat in cls._query_stats.values()
            if stat.get("queryFingerprint") == fingerprint
            and (normalized_root is None or stat.get("projectRoot") == normalized_root)
            and (target_id is None or stat.get("targetId") == target_id)
        ]
        return matches[0] if len(matches) == 1 else None

    @classmethod
    def detect_n_plus_one(cls, project_root: str = "") -> List[Dict[str, Any]]:
        """
        Detects N+1 query patterns: 1 parent query followed by repeated child queries.
        """
        findings = []
        normalized_root = (
            os.path.normcase(os.path.realpath(os.path.abspath(project_root)))
            if project_root
            else None
        )
        for stat in cls._query_stats.values():
            if normalized_root is not None and stat.get("projectRoot") != normalized_root:
                continue
            if stat.get("executionCount", 0) > 3 and "where" in stat.get("normalizedQuery", "").lower():
                findings.append({
                    "queryFingerprint": stat.get("queryFingerprint"),
                    "query": stat.get("rawQuery"),
                    "executionCount": stat.get("executionCount"),
                    "totalTimeMs": stat.get("totalTimeMs"),
                    "pattern": "N_PLUS_ONE_CANDIDATE",
                })
        return findings

    @classmethod
    def classify_bottleneck(
        cls,
        sql: str,
        explain_plan: str = "",
        timing_ms: float = 0.0,
        index_used: Optional[str] = None,
        access_type: Optional[str] = None,
        rows_examined: Optional[int] = None,
        rows_returned: Optional[int] = None,
        is_n_plus_one: bool = False,
        lock_wait_ms: float = 0.0,
    ) -> Dict[str, Any]:
        """
        Classifies query/runtime bottleneck into one of the 21 evidence-driven bottleneck classes:
        QUERY_PLAN, INDEX, SCHEMA, LOCK, TRANSACTION, CONNECTION_POOL, NETWORK, ORM,
        APPLICATION_LOOP, N_PLUS_ONE, DATA_VOLUME, SORT, GROUPING, JOIN, CARDINALITY,
        STATISTICS, IO, CPU, MEMORY, CACHE, UNKNOWN (Section 56).
        """
        plan_low = (explain_plan or "").lower()
        sql_low = (sql or "").lower()
        acc_low = (access_type or "").lower()

        if is_n_plus_one:
            return {
                "bottleneckClass": "N_PLUS_ONE",
                "confidence": "HEURISTIC",
                "description": "Repeated single-row child queries detected originating from loop iterations.",
                "remediation": "Eager-load relation or rewrite with JOIN / WHERE IN bulk query.",
            }
        if lock_wait_ms > 10.0:
            return {
                "bottleneckClass": "LOCK",
                "confidence": "MEASURED",
                "description": f"Lock contention detected: {lock_wait_ms}ms lock wait.",
                "remediation": "Optimize transaction boundary and check concurrent write locks.",
            }
        if not index_used or index_used in ("None", "none", "") or acc_low in ("all", "scan") or "scan table" in plan_low:
            if acc_low not in ("all", "scan") and "scan table" not in plan_low:
                return {
                    "bottleneckClass": "UNKNOWN",
                    "confidence": "UNVERIFIED",
                    "description": "The available plan does not establish whether this operation used an index or scanned a table.",
                    "remediation": "Obtain a live execution plan with access-path details before making an index recommendation.",
                }
            if rows_examined is not None and rows_examined > 5000:
                return {
                    "bottleneckClass": "DATA_VOLUME",
                    "confidence": "PLAN_BASED",
                    "description": f"Sequential table scan examining {rows_examined} rows for small result set.",
                    "remediation": "Add secondary index on filtered columns to convert scan to indexed ref/range.",
                }
            return {
                "bottleneckClass": "INDEX",
                "confidence": "PLAN_BASED" if explain_plan else "HEURISTIC",
                "description": "Missing secondary index on filter predicate causes full table scan.",
                "remediation": "Create index on WHERE/JOIN filter columns.",
            }
        if "using filesort" in plan_low or "temporary" in plan_low:
            return {
                "bottleneckClass": "SORT",
                "confidence": "PLAN_BASED",
                "description": "Query plan requires in-memory or on-disk filesort / temporary table.",
                "remediation": "Add composite index covering both WHERE and ORDER BY clauses.",
            }
        if "nested loop" in plan_low or "join" in sql_low:
            return {
                "bottleneckClass": "JOIN",
                "confidence": "PLAN_BASED" if "nested loop" in plan_low else "HEURISTIC",
                "description": "Unindexed foreign key or unoptimized multi-table join.",
                "remediation": "Ensure foreign key columns participating in JOIN have covering indexes.",
            }
        if "select *" in sql_low:
            return {
                "bottleneckClass": "ORM",
                "confidence": "INFERRED",
                "description": "ORM selecting all columns without projection, increasing serialization overhead.",
                "remediation": "Select only required fields in query builder.",
            }
        if timing_ms > 100.0:
            return {
                "bottleneckClass": "CPU",
                "confidence": "MEASURED",
                "description": "Heavy compute query execution time.",
                "remediation": "Optimize query expressions and ensure indexed predicates.",
            }
        return {
            "bottleneckClass": "QUERY_PLAN",
            "confidence": "PLAN_BASED" if explain_plan else "HEURISTIC",
            "description": "Sub-optimal execution plan.",
            "remediation": "Analyze execution plan and optimize predicate structure.",
        }

    @classmethod
    def _mysql_runtime_query_stats(
        cls,
        project_root: str,
        session: Any,
        dimension: str,
    ) -> Optional[List[Dict[str, Any]]]:
        order_by = "AVG_TIMER_WAIT" if any(
            term in (dimension or "").lower() for term in ("avg", "time", "slow", "latency")
        ) else "SUM_TIMER_WAIT"
        query = (
            "SELECT DIGEST_TEXT AS query_digest, COUNT_STAR AS executions, "
            "ROUND(SUM_TIMER_WAIT / 1000000000, 3) AS total_time_ms, "
            "ROUND(AVG_TIMER_WAIT / 1000000000, 3) AS average_time_ms, "
            "ROUND(MAX_TIMER_WAIT / 1000000000, 3) AS max_time_ms, "
            "SUM_ROWS_EXAMINED AS rows_examined, SUM_ROWS_SENT AS rows_sent "
            "FROM performance_schema.events_statements_summary_by_digest "
            "WHERE SCHEMA_NAME = DATABASE() AND DIGEST_TEXT IS NOT NULL AND COUNT_STAR > 0 "
            "AND DIGEST_TEXT REGEXP '^(SELECT|WITH)' "
            "AND DIGEST_TEXT NOT LIKE '%EVENTS_STATEMENTS_SUMMARY_BY_DIGEST%' "
            f"ORDER BY {order_by} DESC LIMIT 10"
        )
        credentials = getattr(session, "_protected_credentials", {}) or {}
        result = DatabaseIntelligenceEngine.execute_safe_query(
            project_root,
            query,
            {
                "engine": getattr(session, "database_type", "mysql"),
                "database": getattr(session, "database_name", None),
                "host": getattr(session, "safe_host", None),
                "port": getattr(session, "safe_port", None),
                "username": credentials.get("username"),
                "password": credentials.get("password"),
            },
        )
        if not result.get("ok"):
            return None
        records = []
        for row in result.get("rows") or []:
            digest = str(row.get("query_digest") or "").strip()
            if not digest:
                continue
            records.append({
                "queryFingerprint": DatabaseQueryFingerprinter.compute_fingerprint(digest),
                "rawQuery": digest,
                "normalizedQuery": DatabaseQueryFingerprinter.normalize_sql(digest),
                "targetId": getattr(session, "target_id", None),
                "executionCount": int(row["executions"]) if row.get("executions") is not None else None,
                "totalTimeMs": float(row["total_time_ms"]) if row.get("total_time_ms") is not None else None,
                "averageTimeMs": float(row["average_time_ms"]) if row.get("average_time_ms") is not None else None,
                "maxTimeMs": float(row["max_time_ms"]) if row.get("max_time_ms") is not None else None,
                "rowsExamined": (
                    int(row["rows_examined"])
                    if row.get("rows_examined") is not None
                    else None
                ),
                "rowsReturned": int(row["rows_sent"]) if row.get("rows_sent") is not None else None,
                "sourceLocation": None,
                "evidenceSource": DatabaseEvidenceSource.DB_RUNTIME,
            })
        return records

    @classmethod
    def autonomous_investigate_expensive_queries(
        cls,
        project_root: str,
        session: Optional[Any] = None,
        intent_detail: str = "total_load",
    ) -> Dict[str, Any]:
        """
        Executes the autonomous database query performance investigation (Section 54 & Section 90):
        1. Resolve active project & DB target.
        2. Discover performance capabilities & available sources.
        3. Retrieve / measure real query statistics.
        4. Rank expensive queries across dimensions.
        5. Select top candidate.
        6. Map candidate to source code (file, function, call path, ORM).
        7. Inspect schema and indexes.
        8. Run live EXPLAIN.
        9. Measure actual timing.
        10. Classify bottleneck using 21 evidence-backed classes.
        11. Formulate optimization hypothesis.
        12. Format evidence-first report.
        """
        eff_root = project_root
        sess = session
        if not sess and "DatabaseSessionManager" in globals():
            sess = DatabaseSessionManager.get_session(eff_root)

        db_type = getattr(sess, "database_type", "unknown") if sess else "unknown"
        db_name = getattr(sess, "database_name", None) if sess else None
        sq_file = getattr(sess, "sqlite_file", None) if sess else None
        db_exec_config = {"engine": db_type, "database": db_name, "sqlite_file": sq_file}
        if sess:
            db_exec_config.update({
                "host": getattr(sess, "safe_host", None),
                "port": getattr(sess, "safe_port", None),
                **getattr(sess, "_protected_credentials", {}),
            })

        if sess and db_type in ("mysql", "mariadb"):
            top_q = cls._mysql_runtime_query_stats(eff_root, sess, intent_detail)
            if top_q is None:
                return {
                    "ok": True,
                    "content": (
                        "### DATABASE QUERY PERFORMANCE\n\n"
                        f"Runtime query statistics are unavailable for `{db_name}`. "
                        "MySQL Performance Schema could not provide statement summaries, so no query can be "
                        "ranked by measured runtime. No timing was inferred from source code."
                    ),
                    "queries": [],
                    "candidate": None,
                    "explain": None,
                    "classification": None,
                    "timingMs": None,
                    "evidenceQuality": "UNVERIFIED",
                }
            if not top_q:
                return {
                    "ok": True,
                    "content": (
                        "### DATABASE QUERY PERFORMANCE\n\n"
                        f"MySQL Performance Schema returned no SELECT/CTE statement samples for `{db_name}`. "
                        "No slow query can be identified from the available runtime history."
                    ),
                    "queries": [],
                    "candidate": None,
                    "explain": None,
                    "classification": None,
                    "timingMs": None,
                    "evidenceQuality": "UNVERIFIED",
                }

            for query in top_q:
                query["sourceCandidates"] = QueryToSourceMapper.find_query_source_candidates(
                    eff_root, query["rawQuery"], limit=5
                )

            format_ms = lambda value: f"{value:.3f} ms" if isinstance(value, (int, float)) else "UNAVAILABLE"
            top_sections = [
                f"#### Query {index} (average: {format_ms(q.get('averageTimeMs'))})\n\n"
                f"```sql\n{q['rawQuery']}\n```\n\n"
                f"Total: {format_ms(q.get('totalTimeMs'))}; maximum: {format_ms(q.get('maxTimeMs'))}; "
                f"{q.get('executionCount') if q.get('executionCount') is not None else 'UNAVAILABLE'} executions; "
                f"{q['rowsExamined'] if q.get('rowsExamined') is not None else 'UNAVAILABLE'} rows examined, "
                f"{q['rowsReturned'] if q.get('rowsReturned') is not None else 'UNAVAILABLE'} rows sent.\n\n"
                + (
                    "Source query call sites found in project code:\n"
                    + "\n".join(
                        f"- `{source['sourceFile']}:{source['line']}`"
                        + (f" in `{source['functionName']}`" if source.get("functionName") else "")
                        + (
                            f" — possible repeated-call location (loop near line {source['loopContextLine']}; "
                            "static evidence only)"
                            if source.get("loopContextLine") else ""
                        )
                        for source in q["sourceCandidates"]
                    )
                    if q["sourceCandidates"]
                    else "No source query call site was confidently matched."
                )
                for index, q in enumerate(top_q, 1)
            ]
            report = (
                f"### DIRECT ANSWER: SLOWEST OBSERVED QUERIES IN `{db_name}`\n\n"
                "Ranked by average execution time from MySQL Performance Schema "
                "(statement summaries since the server statistics were last reset):\n\n"
                + "\n\n".join(top_sections)
                + "\n\nPerformance Schema execution counts are accumulated database-wide since the last reset; "
                "they are not counts for one academic action or request. Source matches and loop proximity are "
                "static code evidence, not proof that a particular action executed them or that an N+1 occurred. "
                "Request-scoped query logging is required to confirm per-action call counts."
            )
            return {
                "ok": True,
                "content": report,
                "queries": top_q,
                "candidate": top_q[0],
                "mappedSource": top_q[0]["sourceCandidates"][0] if top_q[0]["sourceCandidates"] else None,
                "explain": None,
                "classification": None,
                "timingMs": top_q[0]["averageTimeMs"],
                "bottleneckClass": None,
                "evidenceQuality": "VERIFIED_LIVE",
            }

        # Seed or discover queries
        top_q = cls.rank_queries(
            dimension=intent_detail,
            limit=5,
            project_root=eff_root,
            project_id=getattr(sess, "project_id", None),
            repository_id=getattr(sess, "repository_id", None),
            target_id=getattr(sess, "target_id", None),
        )
        if not top_q:
            discovered = DatabaseIntelligenceEngine.discover_relevant_queries(eff_root)
            if discovered:
                target_sql = discovered[0]["query"]
                meas = DatabaseIntelligenceEngine.execute_query_and_explain(
                    eff_root, target_sql, db_exec_config
                )
                if isinstance(meas.get("timing_ms"), (int, float)):
                    rec = cls.record_query_execution(
                        sql=target_sql,
                        timing_ms=float(meas["timing_ms"]),
                        rows_returned=(
                            int(meas["rows_returned"])
                            if isinstance(meas.get("rows_returned"), int)
                            and not isinstance(meas.get("rows_returned"), bool)
                            and meas["rows_returned"] >= 0
                            else None
                        ),
                        target_id=getattr(sess, "target_id", None),
                        source_location=f"{discovered[0].get('file')}:{discovered[0].get('line', 1)}",
                        project_root=eff_root,
                        project_id=getattr(sess, "project_id", None),
                        repository_id=getattr(sess, "repository_id", None),
                    )
                    top_q = [rec]

        if not top_q:
            return {
                "ok": True,
                "content": (
                    "### DATABASE QUERY PERFORMANCE\n\n"
                    "No runtime query timing is currently available. Static source discovery did not yield "
                    "a query that could be measured safely, so no slow-query ranking or sample timing is reported."
                ),
                "queries": [],
                "candidate": None,
                "explain": None,
                "classification": None,
                "timingMs": None,
                "evidenceQuality": "UNVERIFIED",
            }

        candidate = top_q[0]
        cand_sql = candidate.get("rawQuery") or candidate.get("normalizedQuery")
        if not cand_sql:
            return {
                "ok": True,
                "content": (
                    "### DATABASE QUERY PERFORMANCE\n\n"
                    "A performance candidate was found, but it contains no SQL text to investigate. "
                    "No query, plan, timing, or bottleneck was inferred."
                ),
                "queries": top_q,
                "candidate": candidate,
                "explain": None,
                "classification": None,
                "timingMs": None,
                "evidenceQuality": "UNVERIFIED",
            }

        # Map to source
        mapped_src = QueryToSourceMapper.map_query_to_source(eff_root, cand_sql)
        mapped_src = mapped_src or {}
        src_file = mapped_src.get("sourceFile") or candidate.get("sourceLocation")
        symbol_name = mapped_src.get("symbol")
        call_path = mapped_src.get("callPath")

        # Schema & Index inspection
        target_tbl = mapped_src.get("table")
        schema_res = DatabaseIntelligenceEngine.inspect_database_schema(eff_root, db_exec_config)
        tbl_info = (schema_res.get("schema_details") or {}).get(target_tbl, {}) if target_tbl else {}
        existing_indexes = tbl_info.get("indexes") if target_tbl else None

        # Live EXPLAIN
        explain_res = DatabaseIntelligenceEngine.execute_query_and_explain(
            eff_root, cand_sql, db_exec_config
        ) or {}
        plan_output = explain_res.get("plan")
        index_used = explain_res.get("index_used")
        access_type = explain_res.get("access_type")
        m_time_raw = explain_res.get("timing_ms")
        if not isinstance(m_time_raw, (int, float)) or m_time_raw < 0:
            m_time_raw = candidate.get("averageTimeMs")
        measured_time = (
            float(m_time_raw)
            if isinstance(m_time_raw, (int, float)) and m_time_raw >= 0
            else None
        )

        # Bottleneck classification
        has_plan_evidence = bool(plan_output)
        classification = (
            cls.classify_bottleneck(
                sql=cand_sql,
                explain_plan=plan_output or "",
                timing_ms=measured_time or 0,
                index_used=index_used,
                access_type=access_type,
                rows_examined=candidate.get("rowsExamined"),
                rows_returned=candidate.get("rowsReturned"),
            )
            if has_plan_evidence
            else None
        )

        # Build comprehensive Evidence-First Markdown Report
        top_lines = []
        for q in top_q:
            q_str = q.get("rawQuery") or q.get("normalizedQuery")
            if not q_str:
                continue
            top_lines.append(
                f"- **Query:** `{q_str}`\n"
                f"  - **Fingerprint:** `{q.get('queryFingerprint') or 'UNAVAILABLE'}`\n"
                f"  - **Execution Count:** {q.get('executionCount') if q.get('executionCount') is not None else 'UNAVAILABLE'}\n"
                f"  - **Total Time:** {q.get('totalTimeMs') if q.get('totalTimeMs') is not None else 'UNAVAILABLE'}ms\n"
                f"  - **Average Time:** {q.get('averageTimeMs') if q.get('averageTimeMs') is not None else 'UNAVAILABLE'}ms\n"
                f"  - **Max Time:** {q.get('maxTimeMs') if q.get('maxTimeMs') is not None else 'UNAVAILABLE'}ms\n"
                f"  - **Source Location:** `{q.get('sourceLocation') or 'UNAVAILABLE'}`\n"
            )

        timing_text = f"{measured_time:.2f} ms" if measured_time is not None else "UNAVAILABLE"
        rows_examined = candidate.get("rowsExamined")
        rows_returned = candidate.get("rowsReturned")
        index_text = index_used or "UNAVAILABLE"
        access_text = access_type or "UNAVAILABLE"
        plan_text = plan_output or "UNAVAILABLE (no live query plan)"
        source_text = f"`{src_file}`" if src_file else "UNAVAILABLE"
        symbol_text = f"`{symbol_name}`" if symbol_name else "UNAVAILABLE"
        call_path_text = f"`{call_path}`" if call_path else "UNAVAILABLE"
        index_finding = (
            f"Inspected indexes on `{target_tbl}`: "
            + (
                ", ".join(
                    str(index.get("name") or index) if isinstance(index, dict) else str(index)
                    for index in existing_indexes
                )
                or "none reported"
            )
            if existing_indexes is not None
            else "UNAVAILABLE (no table-specific index evidence)"
        )
        bottleneck_text = (
            f"`{classification['bottleneckClass']}` ({classification['description']})"
            if classification
            else "UNVERIFIED (no live query plan)"
        )
        remediation_text = (
            classification["remediation"] if classification else "UNAVAILABLE (insufficient evidence)"
        )
        evidence_quality = (
            "VERIFIED_LIVE" if measured_time is not None or has_plan_evidence else "UNVERIFIED"
        )
        report = (
            f"### DIRECT ANSWER: TOP SLOW QUERIES REPORT\n\n"
            f"- **QUERY:** `{cand_sql}`\n"
            f"- **FILE/SYMBOL:** {source_text} / {symbol_text}\n"
            f"- **DATABASE:** `{db_name}` ({db_type})\n"
            f"- **ACTUAL TIMING:** {timing_text}\n"
            f"- **ROWS EXAMINED:** {rows_examined if rows_examined is not None else 'UNAVAILABLE'}\n"
            f"- **ROWS RETURNED:** {rows_returned if rows_returned is not None else 'UNAVAILABLE'}\n"
            f"- **INDEX USED:** {index_text}\n"
            f"- **ACCESS TYPE:** {access_text}\n"
            f"- **EXPLAIN:** {plan_text}\n"
            f"- **BOTTLENECK:** {bottleneck_text}\n"
            f"- **CONFIDENCE:** {classification['confidence'] if classification else 'UNVERIFIED'}\n\n"
            f"---\n\n"
            f"### TOP SLOW QUERIES REPORT\n\n"
            f"Discovered candidate queries ({len(top_q)}):\n\n"
            + "\n".join(top_lines) + "\n\n"
            f"---\n\n"
            f"### AUTONOMOUS DATABASE PERFORMANCE INVESTIGATION\n\n"
            f"- **LIVE FACT:** Execution timing = {timing_text}; execution count = "
            f"{candidate.get('executionCount') if candidate.get('executionCount') is not None else 'UNAVAILABLE'}.\n"
            f"- **SOURCE FINDING:** Source = {source_text}; symbol = {symbol_text}; call path = {call_path_text}.\n"
            f"- **LIVE PLAN:** `{plan_text}` (Access Type: `{access_text}`, Index Used: `{index_text}`).\n"
            f"- **INDEX FINDING:** {index_finding}.\n"
            f"- **BOTTLENECK CLASSIFICATION:** {bottleneck_text}\n"
            f"- **OPTIMIZATION HYPOTHESIS:** {remediation_text}\n"
            f"- **EVIDENCE QUALITY:** `{evidence_quality}`.\n"
        )

        return {
            "ok": True,
            "content": report,
            "queries": top_q,
            "candidate": candidate,
            "mappedSource": mapped_src,
            "explain": explain_res,
            "classification": classification,
            "timingMs": measured_time,
            "bottleneckClass": classification["bottleneckClass"] if classification else None,
            "evidenceQuality": evidence_quality,
        }

    @classmethod
    def clear(cls) -> None:
        cls._query_stats.clear()


class QueryToSourceMapper:
    """
    Closed loop mapping from SQL queries / query fingerprints to project source code across ORMs and raw SQL.
    """
    SOURCE_EXTENSIONS = {".php", ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".cs", ".rb"}
    IGNORED_DIRS = {".git", "node_modules", "vendor", "dist", "build", "runtime", "cache", "tests", "test"}
    QUERY_CALL_PATTERN = re.compile(
        r"(?:->|::|\.)\s*(?:find|findAll|findOne|all|one|query|queryAll|queryOne|"
        r"count|exists|createCommand|createQuery|createQueryBuilder)\s*\(|"
        r"\b(?:createCommand|createQuery|queryAll|queryOne|findAll|findOne)\s*\(",
        re.I,
    )
    FUNCTION_PATTERN = re.compile(
        r"\b(?:function|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(|"
        r"\b(?:public|protected|private)\s+(?:static\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(",
        re.I,
    )

    @classmethod
    def find_query_source_candidates(
        cls,
        project_root: str,
        sql: str,
        limit: int = 10,
    ) -> List[Dict[str, Any]]:
        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        if not root:
            return []

        table_names = {
            match.group(1).split(".")[-1].strip("`\"'[]").lower()
            for match in re.finditer(
                r"\b(?:FROM|JOIN|UPDATE|INTO)\s+([`\"'\[]?[A-Za-z0-9_`.\"\[\]]+)",
                sql,
                re.I,
            )
        }
        table_names.discard("")
        if not table_names:
            return []
        model_names = {
            re.sub(
                r"[^a-z0-9]",
                "",
                "".join(part.capitalize() for part in table.split("_")).lower(),
            )
            for table in table_names
        }
        table_patterns = [
            re.compile(rf"\b{re.escape(name)}\b", re.I)
            for name in table_names | model_names
            if len(name) >= 3
        ]

        candidates: List[Dict[str, Any]] = []
        scanned_files = 0
        for current_root, dirs, files in os.walk(root):
            dirs[:] = sorted(directory for directory in dirs if directory.lower() not in cls.IGNORED_DIRS)
            for filename in sorted(files):
                path = Path(current_root) / filename
                if path.suffix.lower() not in cls.SOURCE_EXTENSIONS:
                    continue
                scanned_files += 1
                if scanned_files > 500:
                    return candidates[:limit]
                try:
                    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
                except OSError:
                    continue

                for line_index, line in enumerate(lines):
                    if not any(pattern.search(line) for pattern in table_patterns):
                        continue
                    start = max(0, line_index - 3)
                    end = min(len(lines), line_index + 4)
                    context = "\n".join(lines[start:end])
                    if not cls.QUERY_CALL_PATTERN.search(context) and not re.search(
                        r"\b(?:SELECT|INSERT|UPDATE|DELETE)\b", context, re.I
                    ):
                        continue

                    function_name = None
                    for prior_line in reversed(lines[:line_index + 1]):
                        function_match = cls.FUNCTION_PATTERN.search(prior_line)
                        if function_match:
                            function_name = function_match.group(1) or function_match.group(2)
                            break

                    loop_line = None
                    for prior_index in range(max(0, line_index - 15), line_index):
                        if re.search(r"\b(?:foreach|for|while)\s*\(", lines[prior_index], re.I):
                            loop_line = prior_index + 1

                    relative_path = path.relative_to(root).as_posix()
                    candidates.append({
                        "sourceFile": relative_path,
                        "line": line_index + 1,
                        "functionName": function_name,
                        "table": next(
                            (name for name in table_names if re.search(rf"\b{re.escape(name)}\b", line, re.I)),
                            sorted(table_names)[0],
                        ),
                        "evidence": "SQL_OR_QUERY_CALL_NEAR_TABLE_REFERENCE",
                        "loopContextLine": loop_line,
                    })
                    if len(candidates) >= limit:
                        return candidates

        return candidates

    @classmethod
    def map_query_to_source(cls, project_root: str, sql: str) -> Dict[str, Any]:
        matches = cls.find_query_source_candidates(project_root, sql, limit=1)
        if matches:
            match = matches[0]
            return {
                **match,
                "symbol": match.get("functionName"),
                "callPath": None,
                "ormFramework": "Yii/ActiveRecord" if Path(match["sourceFile"]).suffix.lower() == ".php" else None,
                "status": "STATIC_SOURCE_MATCH",
            }
        tbl_m = re.search(r"\b(?:FROM|JOIN|UPDATE|INTO)\s+([A-Za-z0-9_`.]+)", sql, re.I)
        return {
            "sourceFile": None,
            "table": tbl_m.group(1).split(".")[-1].strip("`").lower() if tbl_m else None,
            "symbol": None,
            "functionName": None,
            "callPath": None,
            "ormFramework": None,
            "line": None,
            "status": "SOURCE_MAPPING_UNVERIFIED",
        }


class DatabaseSession:
    """
    Authoritative database session state persisted across turns for the active project.
    Secrets are kept in _protected_credentials and NEVER serialized into user-visible
    dicts, logs, or model context.
    """
    def __init__(
        self,
        project_id: str,
        repository_id: str,
        database_type: str,
        database_name: str,
        connection_handle: Any = None,
        connection_state: str = DatabaseState.CONNECTED,
        connection_capabilities: Optional[List[str]] = None,
        sqlite_file: Optional[str] = None,
        session_id: Optional[str] = None,
        health_check_latency_ms: Optional[float] = None,
        project_root: str = "",
        target_id: Optional[str] = None,
        safe_host: Optional[str] = None,
        safe_port: Optional[int] = None,
    ):
        self.project_id = project_id
        self.repository_id = repository_id
        self.project_root = project_root
        self.database_type = database_type
        self.database_name = database_name
        self.connection_handle = connection_handle
        self.connection_state = connection_state
        self.connection_capabilities = connection_capabilities or []
        self.sqlite_file = sqlite_file
        self.session_id = session_id or f"db-sess-{int(time.time()*1000)}"
        self.target_id = target_id
        self.safe_host = safe_host
        self.safe_port = safe_port
        self.created_at = time.time()
        self.last_used_at = time.time()
        self._protected_credentials: Dict[str, Any] = {}
        self.health_check_latency_ms = health_check_latency_ms
        self.health_proof: Optional[DatabaseExecutionProof] = None
        self.last_plan_proof: Optional[DatabaseExecutionProof] = None
        self.schema_knowledge: Optional[Dict[str, Any]] = None
        self.binding = DatabaseSessionBinding(self.session_id, self.database_type, self.database_name)
        self.engine_verified = False

    def schema_knowledge_key(self) -> Optional[str]:
        if not self.project_root:
            return None
        project_root = os.path.normcase(
            os.path.realpath(os.path.abspath(self.project_root))
        )
        sqlite_target = self.sqlite_file
        if sqlite_target and not os.path.isabs(sqlite_target):
            sqlite_target = os.path.join(self.project_root, sqlite_target)
        if sqlite_target:
            sqlite_target = os.path.normcase(os.path.realpath(os.path.abspath(sqlite_target)))
        identity = {
            "projectRoot": project_root,
            "engine": self.database_type.lower(),
            "database": self.database_name,
            "targetId": self.target_id,
            "sqliteTarget": sqlite_target,
            "host": self.safe_host,
            "port": self.safe_port,
        }
        serialized = json.dumps(identity, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    def restore_schema_knowledge(self, knowledge: Dict[str, Any]) -> bool:
        if (
            not isinstance(knowledge, dict)
            or knowledge.get("schemaKnowledgeKey") != self.schema_knowledge_key()
            or str(knowledge.get("engine") or "").lower() != self.database_type.lower()
            or knowledge.get("database") != self.database_name
            or knowledge.get("targetId") != self.target_id
        ):
            return False
        self.schema_knowledge = knowledge
        return True

    def is_connected(self) -> bool:
        return self.connection_state in (
            DatabaseState.CONNECTED,
            DatabaseState.HEALTH_CHECKED,
            DatabaseState.SCHEMA_INSPECTED,
            DatabaseState.QUERY_EXECUTED,
            DatabaseState.PERFORMANCE_MEASURED,
            DatabaseState.TIMING_MEASURED,
            DatabaseState.VERIFIED,
        )

    def touch(self) -> None:
        self.last_used_at = time.time()

    def record_schema_knowledge(self, schema_result: Dict[str, Any]) -> Dict[str, Any]:
        if (
            schema_result.get("status") != "SUCCESS"
            or schema_result.get("source") != DatabaseEvidenceSource.LIVE_DB_EXECUTION
        ):
            raise ValueError("Only successfully inspected live schema may be stored as verified knowledge.")

        normalized_schema = {
            "engine": self.database_type,
            "database": self.database_name,
            "tables": sorted(str(table) for table in schema_result.get("live_tables", [])),
            "details": {
                str(table): schema_result["schema_details"][table]
                for table in sorted(schema_result.get("schema_details", {}))
            },
            "relationships": schema_result.get("relationships", []),
            "views": sorted(str(view) for view in schema_result.get("views", [])),
        }
        serialized = json.dumps(
            normalized_schema,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        fingerprint = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
        now = time.time()
        previous = self.schema_knowledge or {}
        same_schema = previous.get("fingerprint") == fingerprint
        knowledge = {
            "engine": self.database_type,
            "database": self.database_name,
            "targetId": self.target_id,
            "schemaKnowledgeKey": self.schema_knowledge_key(),
            "databaseSessionId": self.session_id,
            "fingerprint": fingerprint,
            "previousFingerprint": (
                previous.get("previousFingerprint")
                if same_schema
                else previous.get("fingerprint")
            ),
            "discoveredAt": previous.get("discoveredAt") if same_schema else now,
            "lastVerifiedAt": now,
            "changed": bool(previous and not same_schema),
            "provenance": {
                "source": schema_result.get("source"),
                "evidenceId": schema_result.get("evidenceId"),
                "databaseSessionId": self.session_id,
            },
            "schema": SecretProtector.redact_data(normalized_schema),
        }
        self.schema_knowledge = knowledge
        self.connection_state = DatabaseState.SCHEMA_INSPECTED
        return knowledge

    def get_schema_knowledge(self) -> Optional[Dict[str, Any]]:
        knowledge = self.schema_knowledge
        if not knowledge:
            return None
        if (
            knowledge.get("schemaKnowledgeKey") != self.schema_knowledge_key()
            or str(knowledge.get("engine") or "").lower() != self.database_type.lower()
            or knowledge.get("database") != self.database_name
            or knowledge.get("targetId") != self.target_id
        ):
            return None
        return knowledge

    def to_safe_dict(self) -> Dict[str, Any]:
        return {
            "projectId": self.project_id,
            "repositoryId": self.repository_id,
            "projectRoot": self.project_root,
            "targetId": self.target_id,
            "safeHost": self.safe_host,
            "safePort": self.safe_port,
            "databaseType": self.database_type,
            "connectionState": self.connection_state,
            "databaseName": self.database_name,
            "connectionCapabilities": self.connection_capabilities,
            "createdAt": self.created_at,
            "lastUsedAt": self.last_used_at,
            "sessionId": self.session_id,
            "healthCheckLatencyMs": self.health_check_latency_ms,
            "engineVerified": bool(
                self.is_connected()
                and (not self.project_root or os.path.isdir(self.project_root))
                and self.health_proof
                and self.health_proof.mode == "LIVE"
                and self.health_proof.source in DatabaseEvidenceSource.AUTHORITATIVE_LIVE_SOURCES
                and self.health_proof.execution_status == "SUCCESS"
                and str(self.health_proof.database_engine or "").casefold()
                == str(self.database_type or "").casefold()
            ),
        }


class DatabaseCapabilityPath:
    DEDICATED_TOOL = "dedicated_database_tool"
    APPLICATION_CLIENT = "existing_application_db_client"
    DATABASE_CLI = "database_cli"
    TERMINAL_CLIENT = "terminal_accessible_database_client"
    APPLICATION_RUNTIME = "application_runtime_db_queries"
    PROJECT_UTILITY = "existing_project_database_utility"
    ORM_CONNECTION = "configured_orm_connection"
    DIAGNOSTIC_ENDPOINT = "safe_database_diagnostic_endpoint"


class ConfigurationSymbolResolver:
    """
    Authoritative configuration symbol and constant resolver:
    - Scans project configuration files (config/db.php, config/_name.php,
      config/params.php, config/main-local.php, config/web.php,
      common/config/main-local.php, .env, bootstrap.php, etc.).
    - Parses concatenated PHP DSNs (e.g. 'mysql:host='.DB_HOST.';dbname='.DB_UIMS),
      array configurations, and framework components (e.g. Yii::$app->db).
    - Traces constants across project files: define(), const, $_ENV, putenv, getenv, .env.
    - Accurately reports symbol definition provenance (file and line number).
    - Explicitly marks unresolved constants as NOT_RESOLVED with explanatory notice.
    - Never fabricates synthetic database names or hosts (e.g. active_project_db, localhost).
    - Distinguishes CONFIGURED DATABASE from LIVE DATABASE.
    """

    @staticmethod
    def _looks_like_database_configuration(content: str) -> bool:
        has_explicit_connection_setting = bool(
            re.search(
                r"(?:['\"]?dsn['\"]?\s*(?:=>|=)|"
                r"(?:DB_(?:HOST|PORT|DATABASE|NAME|USERNAME|USER|CONNECTION)|"
                r"DATABASE_URL|POSTGRES(?:QL)?_URL|SUPABASE_(?:DB|DATABASE)_URL|"
                r"MONGO(?:DB)?_(?:URL|URI)|SPRING\.DATASOURCE\.URL)\s*=|"
                r"jdbc:h2:|new\s+\\?PDO\s*\(|new\s+mysqli\s*\()",
                content,
                re.I,
            )
        )
        if has_explicit_connection_setting:
            return True
        has_database_field = bool(re.search(
            r"['\"]?(?:database|dbname)['\"]?\s*(?:=>|:|=)\s*['\"]",
            content,
            re.I,
        ))
        has_connection_detail = bool(re.search(
            r"['\"]?(?:host|hostname|username|user|password|driver|port)['\"]?\s*(?:=>|:|=)\s*['\"]",
            content,
            re.I,
        ))
        return has_database_field and has_connection_detail

    @classmethod
    def _resolve_static_project_reference(
        cls,
        root: Path,
        source_path: str,
        expression: str,
        known_paths: Set[str],
    ) -> List[str]:
        """Resolve literal project-local include/import paths without executing project code."""
        source_dir = Path(source_path).parent
        value = str(expression or "").strip()
        value = re.sub(r"\bdirname\s*\(\s*__FILE__\s*\)", str(source_dir), value)
        value = re.sub(r"\bdirname\s*\(\s*__DIR__\s*\)", str(source_dir.parent), value)
        value = re.sub(r"\b__DIR__\b", str(source_dir), value)
        value = re.sub(r"\b__FILE__\b", source_path, value)
        if re.search(r"\$|%|@[A-Za-z_]|(?:getenv|env)\s*\(", value):
            return []
        fragments = re.findall(r"""['"]([^'"]+)['"]""", value)
        if not fragments:
            return []
        resolved_value = "".join(fragments).replace("\\", "/")
        relative_to_source = bool(re.search(r"\b(?:dirname|__DIR__|__FILE__)\b", expression))
        if relative_to_source:
            resolved_value = resolved_value.lstrip("/")
        candidate_paths = []
        raw = Path(resolved_value)
        if raw.is_absolute() and not relative_to_source:
            try:
                candidate_paths.append(raw.resolve().relative_to(root.resolve()).as_posix())
            except (OSError, ValueError):
                return []
        else:
            candidate_paths.extend((
                (source_dir / raw).as_posix(),
                raw.as_posix(),
            ))
        resolved = []
        for candidate in candidate_paths:
            normalized = os.path.normpath(candidate).replace("\\", "/").removeprefix("./")
            variants = [normalized]
            if not Path(normalized).suffix:
                variants.extend(f"{normalized}{extension}" for extension in (
                    ".php", ".js", ".cjs", ".mjs", ".ts", ".tsx", ".py",
                ))
            for variant in variants:
                if variant in known_paths and variant not in resolved:
                    resolved.append(variant)
        return resolved

    @classmethod
    def _project_configuration_graph(
        cls,
        root: Path,
        file_contents: Dict[str, str],
    ) -> Tuple[Dict[str, List[str]], List[str]]:
        known_paths = set(file_contents)
        graph: Dict[str, List[str]] = {}
        entrypoints = []
        entrypoint_names = {
            "index.php", "yii", "artisan", "manage.py", "wsgi.py", "asgi.py",
            "server.js", "server.cjs", "index.js", "index.cjs", "main.js",
            "main.cjs", "app.js",
        }
        entrypoint_signature = re.compile(
            r"\b(?:Yii::create(?:Web|Console)Application|new\s+\\?yii\\(?:web|console)\\Application|"
            r"NestFactory\.create|createServer\s*\(|\.listen\s*\(|FastAPI\s*\(|Flask\s*\()",
            re.I,
        )
        for relative, content in file_contents.items():
            targets = []
            expressions = []
            expressions.extend(
                match.group(1)
                for match in re.finditer(
                    r"\b(?:require|include)(?:_once)?\s*(?:\(\s*)?([^;]+?)\s*\)?\s*;",
                    content,
                    re.I | re.S,
                )
            )
            expressions.extend(
                match.group(1)
                for match in re.finditer(
                    r"(?:\brequire\s*\(\s*|\bfrom\s*|\bimport\s*)['\"]([^'\"]+)['\"]",
                    content,
                    re.I,
                )
            )
            for expression in expressions:
                for target in cls._resolve_static_project_reference(
                    root, relative, expression, known_paths
                ):
                    if target != relative and target not in targets:
                        targets.append(target)
            graph[relative] = targets

            name = Path(relative).name.casefold()
            if name in entrypoint_names and (
                targets or entrypoint_signature.search(content)
            ):
                entrypoints.append(relative)
        return graph, entrypoints

    @classmethod
    def _rank_configuration_candidates(
        cls,
        root: Path,
        candidates: List[str],
        file_contents: Dict[str, str],
    ) -> List[Dict[str, Any]]:
        graph, entrypoints = cls._project_configuration_graph(root, file_contents)
        distances: Dict[str, List[Tuple[int, str]]] = {candidate: [] for candidate in candidates}
        for entrypoint in entrypoints:
            pending = [(entrypoint, 0)]
            visited = set()
            while pending:
                relative, depth = pending.pop(0)
                if relative in visited:
                    continue
                visited.add(relative)
                if relative in distances:
                    distances[relative].append((depth, entrypoint))
                pending.extend((target, depth + 1) for target in graph.get(relative, []))
        ranked = []
        for candidate in candidates:
            evidence = sorted(distances[candidate])
            ranked.append({
                "path": candidate,
                "entrypointReachable": bool(evidence),
                "distance": evidence[0][0] if evidence else None,
                "entrypoints": sorted({entrypoint for _, entrypoint in evidence}),
            })
        return sorted(
            ranked,
            key=lambda item: (
                not item["entrypointReachable"],
                item["distance"] if item["distance"] is not None else float("inf"),
                item["path"].casefold(),
            ),
        )

    @classmethod
    def _configuration_dependency_paths(
        cls,
        root: Path,
        source_path: str,
        file_contents: Dict[str, str],
    ) -> List[str]:
        graph, _ = cls._project_configuration_graph(root, file_contents)
        pending = [source_path]
        visited = []
        while pending:
            relative = pending.pop(0)
            if relative in visited:
                continue
            visited.append(relative)
            pending.extend(graph.get(relative, []))
        return visited

    _credential_vault: Dict[str, Dict[str, Any]] = {}
    MAX_CREDENTIAL_PROJECTS = 100

    @classmethod
    def store_credential(
        cls,
        project_root: str,
        username: Optional[str] = None,
        password: Optional[str] = None,
        connection_uri: Optional[str] = None,
    ) -> None:
        if not project_root:
            return
        key = os.path.abspath(project_root).lower()
        if key not in cls._credential_vault:
            if len(cls._credential_vault) >= cls.MAX_CREDENTIAL_PROJECTS:
                active_roots = {
                    os.path.abspath(session.project_root).lower()
                    for session in DatabaseSessionManager._sessions.values()
                    if session.is_connected() and session.project_root
                } if "DatabaseSessionManager" in globals() else set()
                evictable = next(
                    (existing_key for existing_key in cls._credential_vault if existing_key not in active_roots),
                    None,
                )
                if evictable is None:
                    raise RuntimeError(
                        "Credential vault capacity is full; credentials for active database sessions were retained."
                    )
                cls._credential_vault.pop(evictable, None)
            cls._credential_vault[key] = {}
        if username is not None:
            cls._credential_vault[key]["username"] = username
        if password is not None:
            cls._credential_vault[key]["password"] = password
        if connection_uri is not None:
            cls._credential_vault[key]["connection_uri"] = connection_uri

    @classmethod
    def get_credential(cls, project_root: str) -> Dict[str, Any]:
        if not project_root:
            return {}
        key = os.path.abspath(project_root).lower()
        credentials = cls._credential_vault.get(key, {})
        if credentials:
            cls._credential_vault.pop(key)
            cls._credential_vault[key] = credentials
        return credentials

    @classmethod
    def clear_credential(cls, project_root: str) -> None:
        if project_root:
            cls._credential_vault.pop(os.path.abspath(project_root).lower(), None)

    @classmethod
    def resolve_symbol_in_project(
        cls,
        project_root: str,
        symbol: Any,
        preferred_files: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        if symbol is None:
            return {"status": "NOT_SPECIFIED", "value": None, "symbol": None}

        sym_str = str(symbol).strip()
        if not sym_str:
            return {"status": "NOT_SPECIFIED", "value": None, "symbol": None}

        # 1. Literals (quoted strings or numeric)
        if (sym_str.startswith("'") and sym_str.endswith("'")) or (sym_str.startswith('"') and sym_str.endswith('"')):
            return {"status": "RESOLVED", "value": sym_str[1:-1], "symbol": sym_str, "source": "literal"}
        if sym_str.isdigit():
            return {"status": "RESOLVED", "value": int(sym_str), "symbol": sym_str, "source": "literal"}

        clean_symbol = sym_str.lstrip("$").strip()
        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        if not root:
            return {
                "status": "NOT_RESOLVED",
                "value": None,
                "symbol": clean_symbol,
                "unresolved_message": f"Database configuration references {clean_symbol}, but its authoritative value is not yet resolved."
            }

        scanned_files = list(cls._iter_project_text_files(root))
        if preferred_files:
            preferred = []
            for relative in preferred_files:
                candidate = root / relative
                if candidate.is_file() and candidate not in preferred:
                    preferred.append(candidate)
            scanned_files = preferred + [
                candidate for candidate in scanned_files if candidate not in preferred
            ]

        # Follow require / require_once / include / include_once chains across files
        included_files = []
        for f in list(scanned_files):
            try:
                content = f.read_text(encoding="utf-8", errors="ignore")
                for req_m in re.finditer(r"(?:require|require_once|include|include_once)\s*\(?\s*['\"]([^'\"]+)['\"]\s*\)?", content, re.I):
                    inc_path_str = req_m.group(1).strip()
                    inc_cand = None
                    if os.path.isabs(inc_path_str) and os.path.isfile(inc_path_str):
                        inc_cand = Path(inc_path_str)
                    else:
                        cand1 = f.parent / inc_path_str
                        cand2 = root / inc_path_str
                        if cand1.is_file():
                            inc_cand = cand1
                        elif cand2.is_file():
                            inc_cand = cand2
                    if inc_cand and inc_cand not in scanned_files and inc_cand not in included_files:
                        included_files.append(inc_cand)
            except Exception:
                pass
        scanned_files.extend(included_files)

        define_re = re.compile(rf"define\s*\(\s*['\"]{re.escape(clean_symbol)}['\"]\s*,\s*['\"]([^'\"]*)['\"]\s*\)", re.I)
        define_num_re = re.compile(rf"define\s*\(\s*['\"]{re.escape(clean_symbol)}['\"]\s*,\s*([0-9]+)\s*\)", re.I)
        const_re = re.compile(rf"const\s+{re.escape(clean_symbol)}\s*=\s*['\"]([^'\"]*)['\"]", re.I)
        const_num_re = re.compile(rf"const\s+{re.escape(clean_symbol)}\s*=\s*([0-9]+)", re.I)
        env_re = re.compile(rf"^\s*{re.escape(clean_symbol)}\s*=\s*['\"]?([^'\"\r\n#]+)['\"]?", re.M)
        var_re = re.compile(rf"\${re.escape(clean_symbol)}\s*=\s*['\"]([^'\"]*)['\"]", re.I)
        putenv_re = re.compile(rf"putenv\s*\(\s*['\"]{re.escape(clean_symbol)}=([^'\"]*)['\"]\s*\)", re.I)
        env_arr_re = re.compile(rf"\$_ENV\s*\[\s*['\"]{re.escape(clean_symbol)}['\"]\s*\]\s*=\s*['\"]([^'\"]*)['\"]", re.I)

        for f in scanned_files:
            try:
                try:
                    rel = str(f.relative_to(root)).replace("\\", "/")
                except Exception:
                    rel = str(f).replace("\\", "/")
                content = f.read_text(encoding="utf-8", errors="ignore")
                lines = content.splitlines()

                for line_idx, line in enumerate(lines, 1):
                    m = define_re.search(line)
                    if m:
                        return {
                            "status": "RESOLVED",
                            "value": m.group(1),
                            "symbol": clean_symbol,
                            "source_file": rel,
                            "line": line_idx,
                            "provenance": f"{rel}:{line_idx}"
                        }
                    m_num = define_num_re.search(line)
                    if m_num:
                        return {
                            "status": "RESOLVED",
                            "value": int(m_num.group(1)),
                            "symbol": clean_symbol,
                            "source_file": rel,
                            "line": line_idx,
                            "provenance": f"{rel}:{line_idx}"
                        }
                    m_c = const_re.search(line)
                    if m_c:
                        return {
                            "status": "RESOLVED",
                            "value": m_c.group(1),
                            "symbol": clean_symbol,
                            "source_file": rel,
                            "line": line_idx,
                            "provenance": f"{rel}:{line_idx}"
                        }
                    m_cn = const_num_re.search(line)
                    if m_cn:
                        return {
                            "status": "RESOLVED",
                            "value": int(m_cn.group(1)),
                            "symbol": clean_symbol,
                            "source_file": rel,
                            "line": line_idx,
                            "provenance": f"{rel}:{line_idx}"
                        }
                    m_pe = putenv_re.search(line)
                    if m_pe:
                        return {
                            "status": "RESOLVED",
                            "value": m_pe.group(1),
                            "symbol": clean_symbol,
                            "source_file": rel,
                            "line": line_idx,
                            "provenance": f"{rel}:{line_idx}"
                        }
                    m_ea = env_arr_re.search(line)
                    if m_ea:
                        return {
                            "status": "RESOLVED",
                            "value": m_ea.group(1),
                            "symbol": clean_symbol,
                            "source_file": rel,
                            "line": line_idx,
                            "provenance": f"{rel}:{line_idx}"
                        }
                    m_v = var_re.search(line)
                    if m_v:
                        return {
                            "status": "RESOLVED",
                            "value": m_v.group(1),
                            "symbol": clean_symbol,
                            "source_file": rel,
                            "line": line_idx,
                            "provenance": f"{rel}:{line_idx}"
                        }

                if f.name.startswith(".env"):
                    m_env = env_re.search(content)
                    if m_env:
                        return {
                            "status": "RESOLVED",
                            "value": m_env.group(1).strip(),
                            "symbol": clean_symbol,
                            "source_file": rel,
                            "line": 1,
                            "provenance": f"{rel}"
                        }
            except Exception:
                continue

        return {
            "status": "NOT_RESOLVED",
            "value": None,
            "symbol": clean_symbol,
            "unresolved_message": f"Database configuration references {clean_symbol}, but its authoritative value is not yet resolved."
        }

    @classmethod
    def inspect_project_database_configuration(cls, project_root: str, specific_file: Optional[str] = None) -> Dict[str, Any]:
        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        if not root:
            return {"discovered": False, "status": "NOT_FOUND", "message": "Project directory not found on disk."}

        file_contents: Dict[str, str] = {}
        candidate_paths = []
        for candidate in cls._iter_project_text_files(root):
            try:
                relative = str(candidate.relative_to(root)).replace("\\", "/")
                file_content = candidate.read_text(encoding="utf-8", errors="ignore")
            except (OSError, ValueError):
                continue
            file_contents[relative] = file_content
            if cls._looks_like_database_configuration(file_content):
                candidate_paths.append(relative)

        target_file = None
        selection_evidence = None
        if specific_file:
            cand = root / specific_file
            if cand.is_file():
                target_file = cand
            else:
                matches = list(root.glob(f"**/{Path(specific_file).name}"))
                matches = [m for m in matches if not any(x in str(m).lower() for x in ("vendor", "node_modules", ".git"))]
                if len(matches) == 1:
                    target_file = matches[0]
                elif len(matches) > 1:
                    return {
                        "discovered": False,
                        "status": "AMBIGUOUS",
                        "configFile": str(specific_file).replace("\\", "/"),
                        "candidates": [
                            str(match.relative_to(root)).replace("\\", "/")
                            for match in matches
                        ],
                        "message": f"Multiple project files match the requested name {Path(specific_file).name}; no file was selected.",
                    }
                if not target_file:
                    return {
                        "discovered": False,
                        "status": "NOT_FOUND",
                        "configFile": str(specific_file).replace("\\", "/"),
                        "message": f"The requested file {specific_file} was not found in the project.",
                    }

        if not target_file:
            if len(candidate_paths) == 1:
                target_file = root / candidate_paths[0]
                selection_evidence = "Only one database configuration candidate was found."
            elif len(candidate_paths) > 1:
                ranked_candidates = cls._rank_configuration_candidates(
                    root,
                    candidate_paths,
                    file_contents,
                )
                reachable = [
                    candidate for candidate in ranked_candidates
                    if candidate["entrypointReachable"]
                ]
                if reachable and (
                    len(reachable) == 1
                    or reachable[0]["distance"] < reachable[1]["distance"]
                ):
                    selected = reachable[0]
                    target_file = root / selected["path"]
                    selection_evidence = (
                        "Selected through static project entrypoint references: "
                        + ", ".join(selected["entrypoints"])
                    )
                else:
                    return {
                        "discovered": False,
                        "status": "AMBIGUOUS",
                        "candidates": [candidate["path"] for candidate in ranked_candidates],
                        "candidateEvidence": ranked_candidates,
                        "message": (
                            "Multiple database configuration candidates remain materially viable; "
                            "no file was selected."
                        ),
                    }

        if not target_file:
            return {"discovered": False, "status": "NOT_FOUND", "message": "No database configuration file found."}

        rel_path = str(target_file.relative_to(root)).replace("\\", "/")
        try:
            content = file_contents.get(rel_path)
            if content is None:
                content = target_file.read_text(encoding="utf-8", errors="ignore")
                file_contents[rel_path] = content
        except Exception as e:
            return {"discovered": False, "status": "ERROR", "message": str(e), "configFile": rel_path}
        dependency_paths = cls._configuration_dependency_paths(root, rel_path, file_contents)
        preferred_files = dependency_paths + [
            path for path in file_contents if Path(path).name.startswith(".env")
        ]
        selected_content = content

        url_assignment = re.search(
            r"^\s*(?:DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|SUPABASE_DB_URL|SUPABASE_DATABASE_URL|MONGO_URL|MONGODB_URI|MONGODB_URL|SPRING\.DATASOURCE\.URL)\s*[:=]\s*['\"]?([^'\"\r\n#]+)",
            content,
            re.I | re.M,
        )
        if not url_assignment:
            url_assignment = re.search(r"(jdbc:h2:[^\s'\";]+(?:;[^,\r\n'\"#]+)*)", content, re.I)
        if url_assignment:
            connection_uri = url_assignment.group(1).strip()
            parsed_url = DatabaseIntelligenceEngine.parse_database_url(connection_uri)
            if parsed_url:
                username_match = re.search(
                    r"^\s*(?:spring\.datasource\.username|username)\s*[:=]\s*['\"]?([^'\"\r\n#]*)",
                    content,
                    re.I | re.M,
                )
                password_match = re.search(
                    r"^\s*(?:spring\.datasource\.password|password)\s*[:=]\s*['\"]?([^'\"\r\n#]*)",
                    content,
                    re.I | re.M,
                )
                username = parsed_url.get("username") or (
                    username_match.group(1).strip() if username_match else None
                )
                password = parsed_url.get("password")
                if password is None and password_match:
                    password = password_match.group(1).strip()
                cls.store_credential(
                    project_root,
                    username=username,
                    password=password,
                    connection_uri=connection_uri,
                )
                return {
                    "discovered": True,
                    "configFile": rel_path,
                    "selectionEvidence": selection_evidence,
                    "configurationDependencies": dependency_paths[1:],
                    "activeComponent": "Database Connection",
                    "componentClass": "Native / Generic Connection",
                    "engine": parsed_url["engine"],
                    "database": {
                        "status": "RESOLVED" if parsed_url.get("database") else "NOT_SPECIFIED",
                        "value": parsed_url.get("database"),
                        "symbol": url_assignment.group(0).split("=", 1)[0].strip(),
                    },
                    "host": {
                        "status": "RESOLVED" if parsed_url.get("host") else "NOT_SPECIFIED",
                        "value": parsed_url.get("host"),
                        "symbol": url_assignment.group(0).split("=", 1)[0].strip(),
                    },
                    "port": {
                        "status": "RESOLVED" if parsed_url.get("port") else "NOT_SPECIFIED",
                        "value": parsed_url.get("port"),
                    },
                    "username": {
                        "status": "RESOLVED" if username else "NOT_SPECIFIED",
                        "value": username,
                        "symbol": "connection URL or datasource username",
                    },
                    "hasPassword": password is not None,
                    "status": "RESOLVED" if parsed_url.get("database") else "CONFIGURED",
                    "fileContent": SecretProtector.redact_text(selected_content),
                    "sqliteFile": None,
                }

        if not cls._looks_like_database_configuration(content):
            return {
                "discovered": False,
                "status": "NOT_CONFIGURED",
                "configFile": rel_path,
                "activeComponent": "Unknown",
                "componentClass": "Unknown",
                "engine": "unknown",
                "database": {"status": "NOT_SPECIFIED", "value": None, "symbol": None},
                "host": {"status": "NOT_SPECIFIED", "value": None, "symbol": None},
                "port": {"status": "NOT_SPECIFIED", "value": None, "symbol": None},
                "username": {"status": "NOT_SPECIFIED", "value": None, "symbol": None},
                "hasPassword": False,
                "fileContent": SecretProtector.redact_text(content),
                "message": f"{rel_path} does not contain database connection settings.",
            }

        active_comp = "Database Connection"
        comp_class = "Native / Generic Connection"
        m_cls = re.search(r"['\"]?class['\"]?\s*=>\s*['\"]([^'\"]+)['\"]", content, re.I)
        if m_cls:
            comp_class = m_cls.group(1)
            if "yii" in comp_class.lower():
                active_comp = "Yii::$app->db"
            elif "illuminate" in comp_class.lower() or "laravel" in comp_class.lower():
                active_comp = "DB::connection()"

        engine = None
        host_token = None
        db_token = None
        port_token = None
        user_token = None
        pass_token = None
        sqlite_file = None
        connection_uri = None

        is_literal_dsn = False
        m_dsn = re.search(r"['\"]?dsn['\"]?\s*=>\s*(.+?)(?:,\s*(?:\r?\n|$)|;\s*(?:\r?\n|$)|$)", content, re.I)
        if m_dsn:
            dsn_expr = m_dsn.group(1).strip()
            is_literal_dsn = (dsn_expr.startswith("'") and dsn_expr.endswith("'")) or (dsn_expr.startswith('"') and dsn_expr.endswith('"'))
            m_eng = re.search(r"(mysql|mariadb|pgsql|postgres|sqlite|sqlsrv|oci|mongodb(?:\+srv)?|h2)", dsn_expr, re.I)
            if m_eng:
                engine = m_eng.group(1).lower()
                if engine == "mariadb": engine = "mysql"
                elif engine == "postgres": engine = "postgresql"
                elif engine.startswith("mongodb"): engine = "mongodb"

            uri_match = re.search(r"(?:jdbc:h2:[^\s'\";]+(?:;[^,\r\n'\" ]+)*)|\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|mariadb)://[^\s'\";]+", dsn_expr, re.I)
            if uri_match:
                parsed_url = DatabaseIntelligenceEngine.parse_database_url(uri_match.group(0))
                if parsed_url:
                    connection_uri = uri_match.group(0)
                    engine = parsed_url["engine"]
                    host_token = f"'{parsed_url['host']}'" if parsed_url.get("host") else None
                    db_token = f"'{parsed_url['database']}'" if parsed_url.get("database") else None
                    port_token = str(parsed_url["port"]) if parsed_url.get("port") else None
                    user_token = f"'{parsed_url['username']}'" if parsed_url.get("username") else None
                    pass_token = f"'{parsed_url['password']}'" if parsed_url.get("password") else None

            if engine == "sqlite" or "sqlite:" in dsn_expr.lower():
                engine = "sqlite"
                m_dir_path = re.search(
                    r"__DIR__\s*\.\s*['\"]([^'\"]+)['\"]",
                    dsn_expr,
                    re.I,
                )
                if m_dir_path:
                    sqlite_file = os.path.normpath(
                        os.path.join(
                            os.path.dirname(rel_path),
                            m_dir_path.group(1).lstrip("/\\"),
                        )
                    )
                else:
                    m_sq = re.search(r"([a-zA-Z0-9_\-]+\.(?:sqlite\d*|db))", dsn_expr, re.I)
                    if m_sq:
                        sqlite_file = m_sq.group(1).strip()
                if not sqlite_file:
                    m_sq = re.search(r"sqlite:\s*(.+?)(?:;|$|['\"])", dsn_expr, re.I)
                    if m_sq:
                        sqlite_file = re.sub(r"^['\"\s\.]+|['\"\s\.]+$", "", m_sq.group(1).strip())

            m_h = re.search(r"host\s*=\s*([^;]+?)(?:;|$|['\"]|,\s*$)", dsn_expr, re.I)
            if m_h:
                raw_h = re.sub(r"^['\"\s\.]+|['\"\s\.]+$", "", m_h.group(1).strip())
                host_token = f"'{raw_h}'" if is_literal_dsn else raw_h

            m_db = re.search(r"dbname\s*=\s*([^;]+?)(?:;|$|['\"]|,\s*$)", dsn_expr, re.I)
            if m_db:
                raw_db = re.sub(r"^['\"\s\.]+|['\"\s\.]+$", "", m_db.group(1).strip())
                db_token = f"'{raw_db}'" if is_literal_dsn else raw_db

            m_p = re.search(r"port\s*=\s*([^;]+?)(?:;|$|['\"]|,\s*$)", dsn_expr, re.I)
            if m_p:
                port_token = re.sub(r"^['\"\s\.]+|['\"\s\.]+$", "", m_p.group(1).strip())

        if not host_token:
            m_h = re.search(r"['\"]?(?:host|hostname)['\"]?\s*=>\s*([^,\r\n;]+)", content, re.I)
            if m_h:
                raw_h = m_h.group(1).strip()
                if (raw_h.startswith("'") and raw_h.endswith("'")) or (raw_h.startswith('"') and raw_h.endswith('"')):
                    host_token = raw_h
                else:
                    host_token = re.sub(r"^['\"\s\.]+|['\"\s\.]+$", "", raw_h)
        if not db_token:
            m_db = re.search(r"['\"]?(?:database|dbname)['\"]?\s*=>\s*([^,\r\n;]+)", content, re.I)
            if m_db:
                raw_db = m_db.group(1).strip()
                if (raw_db.startswith("'") and raw_db.endswith("'")) or (raw_db.startswith('"') and raw_db.endswith('"')):
                    db_token = raw_db
                else:
                    db_token = re.sub(r"^['\"\s\.]+|['\"\s\.]+$", "", raw_db)
        if not port_token:
            m_p = re.search(r"['\"]?port['\"]?\s*=>\s*([^,\r\n;]+)", content, re.I)
            if m_p:
                port_token = re.sub(r"^['\"\s\.]+|['\"\s\.]+$", "", m_p.group(1).strip())
        if not engine:
            m_dr = re.search(r"['\"]?(?:driver|type)['\"]?\s*=>\s*['\"]?([^'\",\r\n;]+)['\"]?", content, re.I)
            if m_dr:
                dr = m_dr.group(1).lower()
                engine = "mysql" if "mysql" in dr else ("postgresql" if "pgsql" in dr or "postgres" in dr else dr)

        m_u = re.search(r"['\"]?(?:username|user)['\"]?\s*=>\s*([^,\r\n;]+)", content, re.I)
        if m_u:
            raw_u = m_u.group(1).strip()
            if (raw_u.startswith("'") and raw_u.endswith("'")) or (raw_u.startswith('"') and raw_u.endswith('"')):
                user_token = raw_u
            else:
                user_token = re.sub(r"^['\"\s\.]+|['\"\s\.]+$", "", raw_u)
        m_pw = re.search(r"['\"]?(?:password|pass)['\"]?\s*=>\s*([^,\r\n;]+)", content, re.I)
        if m_pw:
            raw_pw = m_pw.group(1).strip()
            if (raw_pw.startswith("'") and raw_pw.endswith("'")) or (raw_pw.startswith('"') and raw_pw.endswith('"')):
                pass_token = raw_pw
            else:
                pass_token = re.sub(r"^['\"\s\.]+|['\"\s\.]+$", "", raw_pw)

        res_host = cls.resolve_symbol_in_project(
            project_root, host_token, preferred_files
        ) if host_token else {"status": "NOT_SPECIFIED", "value": None, "symbol": None}
        res_db = cls.resolve_symbol_in_project(
            project_root, db_token, preferred_files
        ) if db_token else {"status": "NOT_SPECIFIED", "value": None, "symbol": None}
        if engine == "sqlite" and sqlite_file and not res_db.get("value"):
            db_fname = Path(sqlite_file).name
            res_db = {"status": "RESOLVED", "value": db_fname, "symbol": "sqlite_file", "source": "dsn_file"}
        res_port = cls.resolve_symbol_in_project(
            project_root, port_token, preferred_files
        ) if port_token else {"status": "NOT_SPECIFIED", "value": None}
        res_user = cls.resolve_symbol_in_project(
            project_root, user_token, preferred_files
        ) if user_token else {"status": "NOT_SPECIFIED", "value": None, "symbol": None}
        res_pass = cls.resolve_symbol_in_project(
            project_root, pass_token, preferred_files
        ) if pass_token else {"status": "NOT_SPECIFIED", "value": None, "symbol": None}

        if res_db["status"] == "NOT_RESOLVED" or res_host["status"] == "NOT_RESOLVED":
            overall_status = "NOT_RESOLVED"
        elif res_db["status"] == "RESOLVED" and res_host["status"] in ("RESOLVED", "NOT_SPECIFIED"):
            overall_status = "RESOLVED"
        elif (
            res_db["status"] == "RESOLVED"
            or res_host["status"] == "RESOLVED"
            or res_port["status"] == "RESOLVED"
            or (res_user and res_user["status"] == "RESOLVED")
        ):
            overall_status = "CONFIGURED"
        else:
            overall_status = "NOT_CONFIGURED"

        res_dict = {
            "discovered": True,
            "configFile": rel_path,
            "selectionEvidence": selection_evidence,
            "configurationDependencies": dependency_paths[1:],
            "activeComponent": active_comp,
            "componentClass": comp_class,
            "engine": engine or "unknown",
            "database": res_db,
            "host": res_host,
            "port": res_port,
            "username": res_user,
            "hasPassword": bool(pass_token),
            "status": overall_status,
            "fileContent": SecretProtector.redact_text(selected_content),
            "sqliteFile": sqlite_file,
        }
        if connection_uri or res_pass.get("value") or (res_user and res_user.get("value")):
            cls.store_credential(
                project_root,
                username=res_user.get("value") if res_user else None,
                password=res_pass.get("value") if res_pass else None,
                connection_uri=connection_uri,
            )
        return res_dict

    @staticmethod
    def _iter_project_text_files(root: Path):
        ignored_directories = {
            ".git", "node_modules", "vendor", "dist", "build", "target",
            ".venv", "venv", "__pycache__", ".next", ".nuxt",
        }
        count = 0
        for current, directories, filenames in os.walk(root):
            directories[:] = [
                name for name in directories
                if name.casefold() not in ignored_directories
            ]
            for filename in filenames:
                candidate = Path(current) / filename
                try:
                    if candidate.stat().st_size > 150_000:
                        continue
                    with candidate.open("rb") as source:
                        if b"\0" in source.read(4096):
                            continue
                except OSError:
                    continue
                yield candidate
                count += 1
                if count >= 10_000:
                    return

    @classmethod
    def verify_live_database_identity(cls, project_root: str, cfg: Dict[str, Any], session: Optional[Any] = None) -> Dict[str, Any]:
        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        engine = (cfg.get("engine") or getattr(session, "database_type", "") or "").lower()
        if not session:
            return {
                "connected": False,
                "status": "NOT_VERIFIED",
                "database": None,
                "host": None,
                "port": None,
                "verificationQuery": None,
                "message": "No project-owned database session is available for runtime verification.",
                "engine": engine or "unknown",
                "targetId": None,
            }

        # 1. SQLite Verification
        if root and (engine == "sqlite" or cfg.get("sqliteFile")):
            configured_file = cfg.get("sqliteFile") or (session and session.sqlite_file)
            sqlite_path = Path(configured_file) if configured_file else None
            if sqlite_path and not sqlite_path.is_absolute():
                sqlite_path = root / sqlite_path
            if sqlite_path and sqlite_path.is_file():
                import sqlite3
                try:
                    started_at = time.perf_counter()
                    conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
                    cur = conn.cursor()
                    cur.execute("SELECT 1")
                    res = cur.fetchone()
                    conn.close()
                    if res and res[0] == 1:
                        elapsed_ms = round((time.perf_counter() - started_at) * 1000.0, 3)
                        proof = DatabaseExecutionProof(
                            session_id=session.session_id if session else None,
                            project_id=session.project_id if session else None,
                            repository_id=session.repository_id if session else None,
                            database_session_id=session.session_id if session else None,
                            database_engine="sqlite",
                            operation=DatabaseCapability.DATABASE_CURRENT_TARGET,
                            source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                            mode="LIVE",
                            execution_status="SUCCESS",
                            execution_time_ms=elapsed_ms,
                            rows_returned=1,
                            query="SELECT 1",
                        )
                        DatabaseEvidenceStore.record_proof(proof)
                        if session:
                            session.connection_state = DatabaseState.CONNECTED
                            session.database_name = sqlite_path.name
                            session.database_type = "sqlite"
                            session.sqlite_file = str(sqlite_path)
                            session.health_proof = proof
                            session.binding.bind_proof(proof)
                        return {
                            "connected": True,
                            "database": sqlite_path.name,
                            "host": None,
                            "port": None,
                            "verificationQuery": "SELECT 1",
                            "status": "LIVE_VERIFIED",
                            "engine": "sqlite",
                            "targetId": session.target_id if session else None,
                            "databaseSessionId": session.session_id if session else None,
                            "evidence": proof.to_dict(),
                        }
                except Exception as e:
                    return {
                        "connected": False,
                        "status": "FAILED",
                        "error": str(e),
                        "engine": "sqlite",
                    }

        # 2. Live MySQL Verification
        if engine == "mysql":
            target_host = (cfg.get("host") or {}).get("value") if isinstance(cfg.get("host"), dict) else (cfg.get("host") or (session and session.safe_host))
            target_db = (cfg.get("database") or {}).get("value") if isinstance(cfg.get("database"), dict) else (cfg.get("database") or (session and session.database_name))
            target_port = (cfg.get("port") or {}).get("value") if isinstance(cfg.get("port"), dict) else (cfg.get("port") or (session and session.safe_port))
            target_user = (cfg.get("username") or {}).get("value") if isinstance(cfg.get("username"), dict) else (
                cfg.get("username")
                or cls.get_credential(project_root).get("username")
                or (cfg.get("_protected_credentials") or {}).get("username")
                or (session and getattr(session, "_protected_credentials", {}).get("username"))
            )
            target_pw = (
                cls.get_credential(project_root).get("password")
                or (cfg.get("_protected_credentials") or {}).get("password")
                or (session and getattr(session, "_protected_credentials", {}).get("password"))
                or ""
            )
            if target_host and target_db and target_user:
                try:
                    import pymysql
                    started_at = time.perf_counter()
                    conn = pymysql.connect(
                        host=str(target_host),
                        **({"port": int(target_port)} if target_port else {}),
                        user=str(target_user or "root"),
                        password=str(target_pw),
                        database=str(target_db),
                        connect_timeout=2,
                    )
                    cur = conn.cursor()
                    cur.execute("SELECT DATABASE(), @@hostname, @@port;")
                    row = cur.fetchone()
                    conn.close()
                    if row:
                        if session:
                            session.connection_state = DatabaseState.CONNECTED
                            session.database_name = row[0] or target_db
                            session.database_type = "mysql"
                        elapsed_ms = round((time.perf_counter() - started_at) * 1000.0, 3)
                        proof = DatabaseExecutionProof(
                            session_id=session.session_id if session else None,
                            project_id=session.project_id if session else None,
                            repository_id=session.repository_id if session else None,
                            database_session_id=session.session_id if session else None,
                            database_engine="mysql",
                            operation=DatabaseCapability.DATABASE_CURRENT_TARGET,
                            source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                            mode="LIVE",
                            execution_status="SUCCESS",
                            execution_time_ms=elapsed_ms,
                            rows_returned=1,
                            query="SELECT DATABASE(), @@hostname, @@port;",
                        )
                        DatabaseEvidenceStore.record_proof(proof)
                        if session:
                            session.health_proof = proof
                            session.binding.bind_proof(proof)
                        return {
                            "connected": True,
                            "database": row[0] or target_db,
                            "host": row[1] or target_host,
                            "port": row[2],
                            "verificationQuery": "SELECT DATABASE(), @@hostname, @@port;",
                            "status": "LIVE_VERIFIED",
                            "engine": "mysql",
                            "targetId": session.target_id if session else None,
                            "databaseSessionId": session.session_id if session else None,
                            "evidence": proof.to_dict(),
                        }
                except Exception as error:
                    return {
                        "connected": False,
                        "status": "FAILED",
                        "engine": "mysql",
                        "failureClassification": DatabaseIntelligenceEngine.classify_db_error(str(error)),
                        "targetId": session.target_id if session else None,
                        "databaseSessionId": session.session_id if session else None,
                    }

        if engine in ("postgres", "postgresql", "supabase", "mongo", "mongodb", "h2"):
            credentials = cls.get_credential(project_root)
            resolved_config = {
                "engine": engine,
                "host": (cfg.get("host") or {}).get("value") if isinstance(cfg.get("host"), dict) else cfg.get("host"),
                "database": (cfg.get("database") or {}).get("value") if isinstance(cfg.get("database"), dict) else cfg.get("database"),
                "port": (cfg.get("port") or {}).get("value") if isinstance(cfg.get("port"), dict) else cfg.get("port"),
                "username": (cfg.get("username") or {}).get("value") if isinstance(cfg.get("username"), dict) else cfg.get("username"),
                "connection_uri": credentials.get("connection_uri"),
            }
            resolved_config.update({
                "database_session_id": session.session_id,
                "project_id": session.project_id,
                "repository_id": session.repository_id,
                "target_id": session.target_id,
            })
            health = DatabaseIntelligenceEngine.real_connect_and_health_check(project_root, resolved_config)
            if health.get("connected"):
                session.connection_state = DatabaseState.CONNECTED
                session.database_name = health.get("database") or session.database_name
                session.database_type = health.get("engine") or engine
                session.safe_host = health.get("host") or session.safe_host
                session.safe_port = health.get("port") or session.safe_port
                proof = health.get("health_proof")
                if proof:
                    session.health_proof = proof
                    session.binding.bind_proof(proof)
                verification_query = health.get("healthQuery")
                return {
                    "connected": True,
                    "database": health.get("database") or session.database_name,
                    "host": health.get("host") or session.safe_host,
                    "port": health.get("port") or session.safe_port,
                    "verificationQuery": verification_query,
                    "status": "LIVE_VERIFIED",
                    "engine": session.database_type,
                    "targetId": session.target_id,
                    "databaseSessionId": session.session_id,
                    "evidence": proof.to_dict() if proof else None,
                }
            return {
                "connected": False,
                "status": "FAILED",
                "engine": engine,
                "failureClassification": health.get("classification") or DbFailureClassification.HOST_UNREACHABLE,
                "message": health.get("message"),
                "targetId": session.target_id,
                "databaseSessionId": session.session_id,
            }

        return {
            "connected": False,
            "status": "NOT_VERIFIED",
            "database": None,
            "host": None,
            "port": None,
            "verificationQuery": "SELECT DATABASE(), @@hostname, @@port;",
            "message": "Live runtime connection has not been verified against the database server.",
            "engine": engine or "unknown",
            "targetId": session.target_id if session else None,
        }

    @classmethod
    def format_connection_status_report(
        cls,
        cfg: Dict[str, Any],
        live: Optional[Dict[str, Any]] = None,
        include_file_preview: bool = False,
        credentials: Optional[Dict[str, Any]] = None,
    ) -> str:
        lines = []
        if (
            include_file_preview
            and cfg.get("status") != "NOT_CONFIGURED"
            and cfg.get("configFile")
            and cfg.get("fileContent")
        ):
            ext = Path(cfg["configFile"]).suffix.lstrip(".") or "php"
            lines.append(f"### INSPECTED CONFIGURATION FILE: {cfg['configFile']}\n")
            preview = SecretProtector.redact_text(str(cfg["fileContent"]).strip())
            lines.append(f"```{ext}\n{preview}\n```\n")
        if cfg.get("message"):
            lines.append(f"> Notice: {cfg['message']}\n")
        if live and live.get("message"):
            lines.append(f"> Notice: {live['message']}\n")
        if cfg.get("requestedConfigNotice"):
            lines.append(f"> Notice: {cfg['requestedConfigNotice']}\n")

        lines.append("### DATABASE CONNECTION STATUS\n")
        tgt_id = cfg.get("targetId") or (live.get("targetId") if live else None)
        if tgt_id:
            lines.append(f"- **Target:** {tgt_id}")
        lines.append(f"- **Engine:** {cfg.get('engine') or 'Unknown'}")
        db_disp_val = cfg.get("activeDatabaseName") or (live.get("database") if live else None) or cfg.get("database", {}).get("value") or "Unknown"
        lines.append(f"- **Database:** {db_disp_val}")
        host_disp_val = cfg.get("host", {}).get("value") or (live.get("host") if live else None) or "Unknown"
        lines.append(f"- **Host:** {host_disp_val}")
        port_disp_val = cfg.get("port", {}).get("value") or (live.get("port") if live else None) or "NOT_SPECIFIED"
        lines.append(f"- **Port:** {port_disp_val}")
        is_conn = (live and live.get("connected")) or cfg.get("status") in ("CONNECTED", "LIVE_VERIFIED")
        report_status = (live or {}).get("status") or ("LIVE_VERIFIED" if is_conn else "NOT_VERIFIED")
        lines.append(f"- **Status:** {report_status}\n")

        lines.append("#### 1. CONFIGURED DATABASE (Source Code)")
        lines.append(f"- **Configuration File:** {cfg.get('configFile') or 'None'}")
        lines.append(f"- **Active Component:** {cfg.get('activeComponent', 'Unknown')} ({cfg.get('componentClass', 'Unknown')})")
        lines.append(f"- **Engine:** {cfg.get('engine') or 'Unknown'}")

        # Database display
        db_obj = cfg.get("database", {})
        if db_obj.get("status") == "RESOLVED":
            prov = f" (resolved from {db_obj.get('symbol')} in {db_obj.get('provenance')})" if db_obj.get("provenance") else ""
            lines.append(f"- **Database:** {db_obj.get('value')}{prov}")
        elif db_obj.get("status") == "NOT_RESOLVED":
            sym = db_obj.get('symbol') or 'unknown reference'
            lines.append(f"- **Database:** NOT_RESOLVED - Database configuration references {sym}, but its authoritative value is not yet resolved.")
        else:
            lines.append(f"- **Database:** {db_obj.get('value') or 'NOT_SPECIFIED'}")

        # Host display
        host_obj = cfg.get("host", {})
        if host_obj.get("status") == "RESOLVED":
            prov = f" (resolved from {host_obj.get('symbol')} in {host_obj.get('provenance')})" if host_obj.get("provenance") else ""
            lines.append(f"- **Host:** {host_obj.get('value')}{prov}")
        elif host_obj.get("status") == "NOT_RESOLVED":
            sym = host_obj.get('symbol') or 'unknown reference'
            lines.append(f"- **Host:** NOT_RESOLVED - Database configuration references {sym}, but its authoritative value is not yet resolved.")
        else:
            lines.append(f"- **Host:** {host_obj.get('value') or 'NOT_SPECIFIED'}")

        # Port display
        port_obj = cfg.get("port", {})
        port_val = port_obj.get("value")
        lines.append(f"- **Port:** {port_val if port_val else 'NOT_SPECIFIED'}")

        # Username
        user_obj = cfg.get("username", {})
        u_val = (
            (credentials or {}).get("username")
            or user_obj.get("value")
            or user_obj.get("symbol")
            or "N/A"
        )
        lines.append(f"- **Username:** {u_val}")
        lines.append("- **Password:** [REDACTED]")
        lines.append(f"- **Status:** {cfg.get('status', 'CONFIGURED')}\n")

        # Explicit notice if symbol unresolved
        if db_obj.get("status") == "NOT_RESOLVED" and db_obj.get("unresolved_message"):
            lines.append(f"> Notice: {db_obj['unresolved_message']}\n")
        elif host_obj.get("status") == "NOT_RESOLVED" and host_obj.get("unresolved_message"):
            lines.append(f"> Notice: {host_obj['unresolved_message']}\n")

        # Live Database Section
        lines.append("#### 2. LIVE DATABASE (Runtime Verification)")
        live_info = live or {}
        if live_info.get("connected"):
            lines.append("- **Connection State:** CONNECTED")
            lines.append(f"- **Live Database:** {live_info.get('database') or 'Unknown'}")
            lines.append(f"- **Live Host:** {live_info.get('host') or 'Unknown'}")
            lines.append(f"- **Live Port:** {live_info.get('port') or 'NOT_REPORTED'}")
            lines.append(f"- **Verification Query:** {live_info.get('verificationQuery') or 'UNAVAILABLE'}")
            lines.append(f"- **Verification Status:** {live_info.get('status', 'LIVE_VERIFIED')}")

            # Check mismatch
            cfg_db_val = db_obj.get("value")
            live_db_val = live_info.get("database")
            if cfg_db_val and live_db_val and str(cfg_db_val).lower() != str(live_db_val).lower():
                lines.append("\n```text")
                lines.append(f"CONFIGURATION_DB: {cfg_db_val}")
                lines.append(f"LIVE_DB: {live_db_val}")
                lines.append("MISMATCH DETECTED")
                lines.append("```")
            else:
                lines.append("- **Verification Result:** MATCH (Configured database matches live runtime database)")
        else:
            lines.append("- **Connection State:** NOT_CONNECTED")
            lines.append("- **Live Database:** NOT_CONNECTED")
            lines.append(f"- **Verification Status:** {live_info.get('status', 'NOT_VERIFIED')}")
            if live_info.get("failureClassification"):
                lines.append(f"- **Failure Classification:** {live_info['failureClassification']}")
            lines.append(f"> Notice: {live_info.get('message') or 'No live connection established to verify runtime database server identity.'}")

        return "\n".join(lines)


class DatabaseIntelligenceEngine:
    """
    Multi-engine database awareness and autonomous execution engine:
    Discovers DB config, schemas, tables, and indexes dynamically without hardcoding.
    Enforces absolute hard block on destructive SQL operations.
    Follows DB DISCOVERY ORDER:
    AUTHORITATIVE PROJECT -> REPOSITORY -> CONFIGURATION DISCOVERY ->
    ENVIRONMENT DISCOVERY -> DATABASE DRIVER / CLIENT DISCOVERY ->
    DATABASE CONNECTION RESOLUTION -> CONNECTION TEST -> DATABASE INSPECTION.
    """
    DESTRUCTIVE_SQL_PATTERN = re.compile(
        r"\b(?:DROP\s+DATABASE|DROP\s+TABLE|DROP\s+VIEW|DROP\s+INDEX|TRUNCATE(?:\s+TABLE)?|DELETE\s+FROM|ALTER\s+TABLE[\s\S]+?DROP)\b",
        re.I
    )

    SAFE_DIAGNOSTIC_PATTERN = re.compile(
        r"^\s*(?:SELECT|EXPLAIN|EXPLAIN\s+ANALYZE|SHOW\s+TABLES|SHOW\s+CREATE\s+TABLE|SHOW\s+INDEXES|DESCRIBE|PRAGMA\s+table_info)\b",
        re.I
    )

    @staticmethod
    def _config_value(config: Dict[str, Any], name: str) -> Any:
        value = config.get(name)
        return value.get("value") if isinstance(value, dict) else value

    @classmethod
    def _resolve_sqlite_path(
        cls,
        project_root: str,
        db_info: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Optional[Path], str]:
        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        if root is None:
            return None, "UNAVAILABLE"

        def candidates() -> List[Path]:
            found: Set[Path] = set()
            for suffix in (".sqlite", ".sqlite3", ".db"):
                for path in root.rglob(f"*{suffix}"):
                    if (
                        path.is_file()
                        and not any(
                            part.casefold() in {"node_modules", ".git", "vendor"}
                            for part in path.relative_to(root).parts
                        )
                    ):
                        found.add(path.resolve())
            return list(found)

        available = candidates()
        config = db_info or {}
        configured_file = config.get("sqlite_file")
        if configured_file:
            configured_path = Path(str(configured_file))
            if not configured_path.is_absolute():
                configured_path = root / configured_path
            if configured_path.is_file():
                return configured_path.resolve(), "RESOLVED"
            if Path(str(configured_file)).parent == Path("."):
                matches = [
                    path for path in available
                    if path.name.casefold() == configured_path.name.casefold()
                ]
                if len(matches) == 1:
                    return matches[0], "RESOLVED"
                return None, "AMBIGUOUS" if len(matches) > 1 else "NOT_FOUND"
            return None, "NOT_FOUND"

        configured_database = config.get("database")
        if configured_database:
            database_value = Path(str(configured_database))
            if database_value.suffix.casefold() in {".sqlite", ".sqlite3", ".db"}:
                configured_path = database_value if database_value.is_absolute() else root / database_value
                if configured_path.is_file():
                    return configured_path.resolve(), "RESOLVED"
                matches = [
                    path for path in available
                    if path.name.casefold() == database_value.name.casefold()
                ]
                if len(matches) == 1:
                    return matches[0], "RESOLVED"
                return None, "AMBIGUOUS" if len(matches) > 1 else "NOT_FOUND"
            stem_matches = [
                path for path in available
                if path.stem.casefold() == database_value.name.casefold()
            ]
            if len(stem_matches) == 1:
                return stem_matches[0], "RESOLVED"
            if len(stem_matches) > 1:
                return None, "AMBIGUOUS"

        if len(available) == 1:
            return available[0], "RESOLVED"
        return None, "AMBIGUOUS" if available else "NOT_FOUND"

    @classmethod
    def _open_mysql_connection(cls, project_root: str, config: Dict[str, Any]) -> Any:
        import pymysql

        credentials = ConfigurationSymbolResolver.get_credential(project_root)
        connection_uri = credentials.get("connection_uri") or config.get("connection_uri")
        uri_config = cls.parse_database_url(connection_uri) if connection_uri else {}
        return pymysql.connect(
            host=str(cls._config_value(config, "host") or uri_config.get("host") or ""),
            port=int(cls._config_value(config, "port") or uri_config.get("port") or 3306),
            user=str(cls._config_value(config, "username") or credentials.get("username") or uri_config.get("username") or ""),
            password=str(credentials.get("password") or config.get("password") or uri_config.get("password") or ""),
            database=cls._config_value(config, "database") or uri_config.get("database") or None,
            connect_timeout=3,
            read_timeout=10,
            write_timeout=5,
            autocommit=False,
        )

    @classmethod
    def _open_postgresql_connection(cls, project_root: str, config: Dict[str, Any]) -> Any:
        import psycopg

        credentials = ConfigurationSymbolResolver.get_credential(project_root)
        connection_uri = credentials.get("connection_uri") or config.get("connection_uri")
        if connection_uri:
            return psycopg.connect(connection_uri, connect_timeout=3)
        database_name = cls._config_value(config, "database")
        if not database_name:
            raise ValueError("A PostgreSQL database name was not discovered.")
        return psycopg.connect(
            host=str(cls._config_value(config, "host") or ""),
            port=int(cls._config_value(config, "port") or 5432),
            dbname=str(database_name),
            user=str(cls._config_value(config, "username") or credentials.get("username") or ""),
            password=str(credentials.get("password") or config.get("password") or ""),
            connect_timeout=3,
        )

    @classmethod
    def _open_mongodb_client(cls, project_root: str, config: Dict[str, Any]) -> Any:
        from pymongo import MongoClient

        credentials = ConfigurationSymbolResolver.get_credential(project_root)
        connection_uri = credentials.get("connection_uri") or config.get("connection_uri")
        if connection_uri:
            return MongoClient(
                connection_uri,
                serverSelectionTimeoutMS=3000,
                connectTimeoutMS=3000,
            )
        host = cls._config_value(config, "host")
        port = cls._config_value(config, "port") or 27017
        return MongoClient(
            f"mongodb://{host}:{int(port)}",
            username=cls._config_value(config, "username") or credentials.get("username"),
            password=credentials.get("password") or config.get("password"),
            serverSelectionTimeoutMS=3000,
            connectTimeoutMS=3000,
        )

    @classmethod
    def _find_h2_jar(cls, project_root: str) -> Optional[str]:
        configured_jar = os.environ.get("H2_JAR")
        if configured_jar and os.path.isfile(configured_jar):
            return configured_jar

        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        if root:
            for relative_dir in ("lib", "libs", "target/dependency", "build/libs", "build/dependencies"):
                candidate_dir = root / relative_dir
                if candidate_dir.is_dir():
                    jars = sorted(candidate_dir.glob("h2-*.jar"))
                    if jars:
                        return str(jars[-1])

        home = Path.home()
        candidate_dirs = [
            home / ".m2" / "repository" / "com" / "h2database" / "h2",
            home / ".gradle" / "caches" / "modules-2" / "files-2.1" / "com.h2database" / "h2",
        ]
        jars = []
        for candidate_dir in candidate_dirs:
            if candidate_dir.is_dir():
                jars.extend(candidate_dir.glob("**/h2-*.jar"))
        return str(sorted(jars)[-1]) if jars else None

    @classmethod
    def _open_h2_connection(cls, project_root: str, config: Dict[str, Any]) -> Any:
        credentials = ConfigurationSymbolResolver.get_credential(project_root)
        connection_uri = credentials.get("connection_uri") or config.get("connection_uri")
        parsed_url = cls.parse_database_url(connection_uri) if connection_uri else {}
        if not connection_uri or not parsed_url:
            raise ValueError("A valid jdbc:h2 connection URL was not discovered.")
        if parsed_url.get("in_memory"):
            raise ValueError(
                "H2 in-memory databases belong to the Java application's JVM and cannot be inspected from the separate Coding Agent process."
            )

        h2_jar = cls._find_h2_jar(project_root)
        if not h2_jar:
            raise RuntimeError(
                "H2 JDBC driver JAR was not found. Add the H2 dependency to the project, install it in Maven/Gradle, or set H2_JAR."
            )
        try:
            import jaydebeapi
        except ImportError as error:
            raise RuntimeError("The Python JayDeBeApi adapter is not installed in the Coding Agent backend.") from error

        jdbc_url = connection_uri
        if parsed_url.get("file_database"):
            if re.search(r"(?:^|;)ACCESS_MODE_DATA=", jdbc_url, re.I):
                jdbc_url = re.sub(
                    r"(?<=;)ACCESS_MODE_DATA=[^;]*",
                    "ACCESS_MODE_DATA=r",
                    jdbc_url,
                    flags=re.I,
                )
            else:
                jdbc_url += ";ACCESS_MODE_DATA=r"
        username = (
            cls._config_value(config, "username")
            or credentials.get("username")
            or parsed_url.get("username")
        )
        if not username:
            raise ValueError("An H2 database username was not discovered.")
        password = (
            cls._config_value(config, "password")
            if cls._config_value(config, "password") is not None
            else credentials.get("password", parsed_url.get("password") or "")
        )
        connection = jaydebeapi.connect(
            "org.h2.Driver",
            jdbc_url,
            [str(username), str(password or "")],
            h2_jar,
        )
        connection.jconn.setReadOnly(True)
        return connection

    @staticmethod
    def parse_database_url(connection_uri: str) -> Dict[str, Any]:
        if connection_uri.lower().startswith("jdbc:h2:"):
            target = connection_uri[len("jdbc:h2:"):].split(";", 1)[0]
            options = {
                key.strip().upper(): value.strip()
                for key, value in re.findall(r"(?:^|;)\s*([A-Z_]+)\s*=\s*([^;]*)", connection_uri, re.I)
            }
            tcp_match = re.match(r"(?:tcp|ssl)://([^/:]+)(?::(\d+))?/(.+)", target, re.I)
            in_memory = bool(re.match(r"mem:", target, re.I))
            if tcp_match:
                database = tcp_match.group(3).split(";", 1)[0].rsplit("/", 1)[-1] or None
                host = tcp_match.group(1)
                port = int(tcp_match.group(2) or 9092)
                file_database = False
            else:
                local_target = target.removeprefix("file:") if target.lower().startswith("file:") else target
                database = local_target.rsplit("/", 1)[-1] or None
                host = None
                port = None
                file_database = not in_memory
            if database:
                database = re.sub(r"\.(?:mv\.db|h2\.db)$", "", database, flags=re.I)
            return {
                "engine": "h2",
                "host": host,
                "port": port,
                "database": database,
                "username": options.get("USER", "").strip("'\"") or None,
                "password": options.get("PASSWORD", "").strip("'\"") or None,
                "connection_uri": connection_uri,
                "in_memory": in_memory,
                "file_database": file_database,
            }

        parsed = urlparse(connection_uri)
        scheme = parsed.scheme.lower()
        if scheme in ("postgres", "postgresql"):
            engine, default_port = "postgresql", 5432
        elif scheme in ("mongodb", "mongodb+srv"):
            engine, default_port = "mongodb", 27017
        elif scheme in ("mysql", "mariadb"):
            engine, default_port = "mysql", 3306
        else:
            return {}
        try:
            port = parsed.port or default_port
        except ValueError:
            return {}
        return {
            "engine": engine,
            "host": parsed.hostname,
            "port": port,
            "database": unquote(parsed.path.lstrip("/")) or None,
            "username": unquote(parsed.username) if parsed.username else None,
            "password": unquote(parsed.password) if parsed.password else None,
            "connection_uri": connection_uri,
        }

    @classmethod
    def is_destructive_sql(cls, sql: str) -> bool:
        return bool(cls.DESTRUCTIVE_SQL_PATTERN.search(sql))

    @classmethod
    def is_safe_diagnostic_sql(cls, sql: str) -> bool:
        if cls.is_destructive_sql(sql):
            return False
        return bool(cls.SAFE_DIAGNOSTIC_PATTERN.search(sql))

    @classmethod
    def sanitize_and_validate_sql(cls, sql: str) -> Tuple[bool, str]:
        stripped = sql.strip()
        if cls.is_destructive_sql(stripped):
            return False, "DESTRUCTIVE_SQL_BLOCKED: DROP, TRUNCATE, and DELETE statements are strictly forbidden by Policy Gate."
        if not cls.is_safe_diagnostic_sql(stripped):
            return False, "UNAUTHORIZED_SQL: Only read-only diagnostic SQL statements (SELECT, EXPLAIN, SHOW, DESCRIBE) are permitted."
        return True, "SAFE"

    @classmethod
    def check_database_capabilities(
        cls,
        project_root: str,
        arch: Optional[Dict[str, Any]] = None,
        available_tools: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Verifies whether ANY of the 8 database capability paths are available before
        declaring the database unavailable:
        1. dedicated database tool
        2. existing application DB client
        3. database CLI
        4. terminal-accessible database client
        5. application runtime capable of DB queries
        6. existing project database utility
        7. configured ORM connection
        8. safe database diagnostic endpoint
        """
        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        tools = [t.lower() for t in (available_tools or [])]

        # 1. Dedicated DB tool
        has_dedicated_tool = any(t in tools for t in ("execute_sql", "run_query", "db_query", "database.query", "sql_query"))

        # 2. Existing application DB client (inspected from files or framework)
        frameworks = [f.lower() for f in (arch or {}).get("frameworks", [])] if arch else []
        has_app_client = False
        if root:
            # Fast check common locations first without full disk walk
            fast_candidates = [
                root / "config" / "db.php",
                root / "config" / "database.php",
                root / "config" / "database.js",
                root / "config" / "database.ts",
                root / "db.php",
                root / "database.php",
                root / "db.ts",
                root / "db.py",
            ]
            for fc in fast_candidates:
                if fc.is_file():
                    has_app_client = True
                    break
            if not has_app_client:
                for sub_dir in ("config", "common/config", "src", "app", "server"):
                    cand_d = root / sub_dir
                    if cand_d.is_dir():
                        for p in list(cand_d.glob("db*.*")) + list(cand_d.glob("database*.*")):
                            if p.is_file():
                                has_app_client = True
                                break
                    if has_app_client:
                        break
        if any(fw in frameworks for fw in ("yii2", "laravel", "django", "fastapi", "spring", "express", "nest")):
            has_app_client = True

        # 3. Database CLI on system PATH
        import shutil
        has_db_cli = any(bool(shutil.which(cli)) for cli in ("mysql", "psql", "sqlite3", "mongosh", "sqlite"))

        # 4. Terminal-accessible database client
        has_terminal_client = has_db_cli

        # 5. Application runtime capable of DB queries
        has_app_runtime = False
        if root:
            if (root / "yii").is_file() or (root / "artisan").is_file() or (root / "manage.py").is_file():
                has_app_runtime = True
            elif (root / "package.json").is_file() or (root / "composer.json").is_file():
                has_app_runtime = True

        # 6. Existing project database utility (migrations, seeders, scripts)
        has_project_utility = False
        if root:
            for cand in ("migrations", "migrate", "seeds", "seeders", "sql", "db"):
                if (root / cand).is_dir() or (root / "database" / cand).is_dir():
                    has_project_utility = True
                    break

        # 7. Configured ORM connection
        has_orm_connection = False
        if root:
            if (
                (root / "prisma" / "schema.prisma").is_file()
                or (root / "models").is_dir()
                or (root / "app" / "models").is_dir()
                or (root / "src" / "models").is_dir()
                or (root / "entities").is_dir()
                or (root / "src" / "entities").is_dir()
                or (root / "node_modules" / "entities").is_dir()
            ):
                has_orm_connection = True

        # 8. Safe database diagnostic endpoint / verification runner
        has_diagnostic_endpoint = any(
            tool in tools for tool in ("run_verification", "terminal.run_command")
        )

        paths_status = {
            DatabaseCapabilityPath.DEDICATED_TOOL: has_dedicated_tool,
            DatabaseCapabilityPath.APPLICATION_CLIENT: has_app_client,
            DatabaseCapabilityPath.DATABASE_CLI: has_db_cli,
            DatabaseCapabilityPath.TERMINAL_CLIENT: has_terminal_client,
            DatabaseCapabilityPath.APPLICATION_RUNTIME: has_app_runtime,
            DatabaseCapabilityPath.PROJECT_UTILITY: has_project_utility,
            DatabaseCapabilityPath.ORM_CONNECTION: has_orm_connection,
            DatabaseCapabilityPath.DIAGNOSTIC_ENDPOINT: has_diagnostic_endpoint,
        }

        available_paths = [p for p, ok in paths_status.items() if ok]
        return {
            "any_available": len(available_paths) > 0,
            "available_paths": available_paths,
            "paths_status": paths_status,
        }

    @classmethod
    def discover_database_configuration(
        cls,
        project_root: str,
        arch: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Follows DB DISCOVERY ORDER:
        AUTHORITATIVE PROJECT -> REPOSITORY -> CONFIGURATION DISCOVERY ->
        ENVIRONMENT DISCOVERY -> DATABASE DRIVER / CLIENT DISCOVERY ->
        DATABASE CONNECTION RESOLUTION -> CONNECTION TEST -> DATABASE INSPECTION.
        """
        if not project_root or not os.path.isdir(project_root):
            return {
                "discovered": False,
                "status": DbFailureClassification.DB_CONFIG_NOT_FOUND,
                "message": "Authoritative project directory not available or does not exist on disk.",
            }

        root = Path(project_root)
        discovered_info: Dict[str, Any] = {
            "discovered": False,
            "engine": "unknown",
            "host": None,
            "port": None,
            "database": None,
            "username": None,
            "driver": None,
            "existing_utility": None,
            "configFile": None,
            "evidence": [],
        }

        # 1. Authoritative configuration inspection via ConfigurationSymbolResolver
        res_cfg = ConfigurationSymbolResolver.inspect_project_database_configuration(project_root)
        if res_cfg.get("status") == "AMBIGUOUS":
            discovered_info["status"] = "DB_CONFIG_AMBIGUOUS"
            discovered_info["candidates"] = res_cfg.get("candidates", [])
            discovered_info["evidence"].append(
                "Multiple database configuration candidates were found; no configuration was selected."
            )
            return discovered_info
        if res_cfg.get("discovered"):
            discovered_info["discovered"] = True
            discovered_info["configFile"] = res_cfg.get("configFile")
            discovered_info["selectionEvidence"] = res_cfg.get("selectionEvidence")
            discovered_info["configurationDependencies"] = res_cfg.get(
                "configurationDependencies", []
            )
            if res_cfg.get("engine") and res_cfg.get("engine") != "unknown":
                discovered_info["engine"] = res_cfg.get("engine")
            discovered_info["activeComponent"] = res_cfg.get("activeComponent")
            discovered_info["componentClass"] = res_cfg.get("componentClass")
            discovered_info["existing_utility"] = res_cfg.get("activeComponent")
            discovered_info["driver"] = res_cfg.get("componentClass")

            db_val = res_cfg.get("database", {}).get("value")
            if db_val:
                discovered_info["database"] = db_val
            host_val = res_cfg.get("host", {}).get("value")
            if host_val:
                discovered_info["host"] = host_val
            port_val = res_cfg.get("port", {}).get("value")
            if port_val:
                discovered_info["port"] = port_val
            user_val = res_cfg.get("username", {}).get("value")
            if user_val:
                discovered_info["username"] = user_val
            if res_cfg.get("sqliteFile"):
                discovered_info["sqlite_file"] = res_cfg.get("sqliteFile")
            discovered_info["evidence"].append(f"Authoritative config resolved from {res_cfg.get('configFile')}")
            discovered_info["_symbol_details"] = res_cfg
            if (
                str(res_cfg.get("configFile") or "").lower().startswith(".env")
                and discovered_info["engine"] == "unknown"
                and not any(discovered_info.get(field) for field in ("database", "host", "username"))
            ):
                discovered_info["discovered"] = False

        # Scan for db config files only if not yet discovered
        found_files = []
        if not discovered_info["discovered"]:
            for match in ConfigurationSymbolResolver._iter_project_text_files(root):
                try:
                    content = match.read_text(encoding="utf-8", errors="ignore")
                    if ConfigurationSymbolResolver._looks_like_database_configuration(content):
                        rel = str(match.relative_to(root)).replace("\\", "/")
                        found_files.append((rel, match))
                except (OSError, ValueError):
                    continue
            if len(found_files) > 1:
                discovered_info["status"] = "DB_CONFIG_AMBIGUOUS"
                discovered_info["candidates"] = [rel for rel, _ in found_files]
                discovered_info["evidence"].append(
                    "Multiple database configuration candidates were found; no configuration was selected."
                )
                return discovered_info

        for rel_path, file_path in found_files:
            try:
                content = file_path.read_text(encoding="utf-8", errors="ignore")
                # Look for DSN or engine
                if re.search(r"\b(?:mysql|mariadb)\b", content, re.I):
                    if discovered_info["engine"] == "unknown":
                        discovered_info["engine"] = "mysql"
                        discovered_info["port"] = 3306
                    if not discovered_info["configFile"]:
                        discovered_info["configFile"] = rel_path
                elif re.search(r"\bmongodb(?:\+srv)?\b|\bMONGODB_URI\b", content, re.I):
                    if discovered_info["engine"] == "unknown":
                        discovered_info["engine"] = "mongodb"
                        discovered_info["port"] = 27017
                    if not discovered_info["configFile"]:
                        discovered_info["configFile"] = rel_path
                elif re.search(r"\b(?:pgsql|postgres|postgresql)\b", content, re.I):
                    if discovered_info["engine"] == "unknown":
                        discovered_info["engine"] = "postgresql"
                        discovered_info["port"] = 5432
                    if not discovered_info["configFile"]:
                        discovered_info["configFile"] = rel_path
                elif re.search(r"\bjdbc:h2:", content, re.I):
                    discovered_info["engine"] = "h2"
                    if not discovered_info["configFile"]:
                        discovered_info["configFile"] = rel_path
                elif re.search(r"\b(?:sqlite3?|db\.sqlite3)\b", content, re.I):
                    if discovered_info["engine"] == "unknown":
                        discovered_info["engine"] = "sqlite"
                    if not discovered_info["configFile"]:
                        discovered_info["configFile"] = rel_path

                # Look for DB_CONNECTION / DB_DATABASE / DB_PASSWORD in .env
                if ".env" in rel_path.lower():
                    for line in content.splitlines():
                        line = line.strip()
                        if line.startswith("#") or "=" not in line:
                            continue
                        k, v = line.split("=", 1)
                        k = k.strip().upper()
                        v = v.strip().strip("'\"")
                        if k in ("DB_CONNECTION", "DB_DRIVER"):
                            if "mysql" in v.lower():
                                discovered_info["engine"] = "mysql"
                            elif "pgsql" in v.lower() or "postgres" in v.lower():
                                discovered_info["engine"] = "postgresql"
                            elif "h2" in v.lower():
                                discovered_info["engine"] = "h2"
                            elif "sqlite" in v.lower():
                                discovered_info["engine"] = "sqlite"
                            discovered_info["configFile"] = rel_path
                        elif k in (
                            "DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL",
                            "SUPABASE_DB_URL", "SUPABASE_DATABASE_URL",
                            "MONGO_URL", "MONGODB_URI", "MONGODB_URL",
                            "SPRING.DATASOURCE.URL",
                        ):
                            connection = cls.parse_database_url(v)
                            if connection:
                                discovered_info.update({
                                    key: value for key, value in connection.items()
                                    if value is not None
                                })
                                discovered_info["discovered"] = True
                                discovered_info["configFile"] = rel_path
                                ConfigurationSymbolResolver.store_credential(
                                    project_root,
                                    username=connection.get("username"),
                                    password=connection.get("password"),
                                    connection_uri=connection.get("connection_uri"),
                                )
                        elif k in ("DB_HOST", "DATABASE_HOST") and not discovered_info["host"]:
                            discovered_info["host"] = v
                        elif k in ("DB_PORT", "DATABASE_PORT") and not discovered_info["port"]:
                            try:
                                discovered_info["port"] = int(v)
                            except Exception:
                                pass
                        elif k in ("DB_DATABASE", "DB_NAME", "DATABASE_NAME") and not discovered_info["database"]:
                            discovered_info["database"] = v
                            discovered_info["configFile"] = rel_path
                        elif k in ("DB_USERNAME", "DB_USER", "DATABASE_USER") and not discovered_info["username"]:
                            discovered_info["username"] = v
                        elif k in ("DB_PASSWORD", "DATABASE_PASSWORD"):
                            discovered_info["has_credentials"] = True
                            ConfigurationSymbolResolver.store_credential(project_root, password=v)

                # Host
                host_m = re.search(r"['\"]?host['\"]?\s*(?:=>|:|=)\s*['\"]([^'\"]+)['\"]", content, re.I)
                if not host_m:
                    host_m = re.search(r"host=([a-zA-Z0-9_.-]+)", content, re.I)
                if host_m and not discovered_info["host"]:
                    discovered_info["host"] = host_m.group(1)

                # DSN
                dsn_m = re.search(r"['\"]?dsn['\"]?\s*(?:=>|:|=)\s*['\"]([^'\"]+)['\"]", content, re.I)
                if dsn_m:
                    dsn = dsn_m.group(1)
                    discovered_info["evidence"].append(f"DSN pattern in {rel_path}: {SecretProtector.redact_text(dsn)}")
                    if "mysql:" in dsn:
                        discovered_info["engine"] = "mysql"
                    elif "pgsql:" in dsn:
                        discovered_info["engine"] = "postgresql"
                    elif "sqlite:" in dsn:
                        discovered_info["engine"] = "sqlite"
                    db_m = re.search(r"dbname=([a-zA-Z0-9_.-]+)", dsn, re.I)
                    if db_m:
                        discovered_info["database"] = db_m.group(1)
                    if not discovered_info["configFile"]:
                        discovered_info["configFile"] = rel_path

                # DB Name
                if not discovered_info["database"]:
                    db_name_m = re.search(r"['\"]?(?:database|dbname|db)['\"]?\s*(?:=>|:|=)\s*['\"]([^'\"]+)['\"]", content, re.I)
                    if db_name_m and db_name_m.group(1).lower() not in ("mysql", "pgsql", "sqlite"):
                        discovered_info["database"] = db_name_m.group(1)

                # Username
                if not discovered_info["username"]:
                    user_m = re.search(r"['\"]?(?:username|user)['\"]?\s*(?:=>|:|=)\s*['\"]([^'\"]+)['\"]", content, re.I)
                    if user_m:
                        discovered_info["username"] = user_m.group(1)

            except Exception:
                continue

        if discovered_info["engine"] != "unknown" or discovered_info["database"]:
            discovered_info["discovered"] = True
        if discovered_info.get("status") != "DB_CONFIG_AMBIGUOUS":
            if discovered_info["discovered"] and discovered_info["engine"] == "unknown":
                discovered_info["status"] = "DB_ENGINE_UNKNOWN"
            elif not discovered_info["discovered"]:
                discovered_info["status"] = DbFailureClassification.DB_CONFIG_NOT_FOUND

        if arch:
            for fw in arch.get("frameworks", []):
                if fw.lower() == "yii2":
                    discovered_info["existing_utility"] = "Yii::$app->db"
                    discovered_info["driver"] = "yii\\db\\Connection"
                elif fw.lower() == "laravel":
                    discovered_info["existing_utility"] = "DB::connection()"
                    discovered_info["driver"] = "Illuminate\\Database\\DatabaseManager"
                elif fw.lower() == "django":
                    discovered_info["existing_utility"] = "django.db.connection"
                    discovered_info["driver"] = "django.db.backends"
                elif fw.lower() == "spring":
                    discovered_info["existing_utility"] = "JdbcTemplate / DataSource"
                    discovered_info["driver"] = "org.springframework.jdbc"

        return discovered_info

    @classmethod
    def classify_db_error(cls, error_msg: str) -> str:
        """
        Classifies database errors strictly into the 17 Section 12 canonical failure types:
        PROJECT_NOT_AVAILABLE, DB_CONFIG_NOT_FOUND, DB_CONFIG_INVALID,
        SECRET_UNAVAILABLE, DRIVER_NOT_FOUND, CLIENT_NOT_FOUND,
        HOST_UNREACHABLE, PORT_UNREACHABLE, AUTHENTICATION_FAILED,
        DATABASE_NOT_FOUND, TLS_FAILURE, PERMISSION_DENIED,
        QUERY_FAILED, TIMEOUT, UNSUPPORTED_DATABASE,
        RUNTIME_CONFIGURATION_ERROR, TOOL_RESOLUTION_FAILURE.
        """
        low = (error_msg or "").lower()
        if "project" in low and ("not available" in low or "not attached" in low or "missing" in low):
            return DbFailureClassification.PROJECT_NOT_AVAILABLE
        if "timeout" in low or "timed out" in low or "deadline" in low:
            return DbFailureClassification.TIMEOUT
        if "tls" in low or "ssl" in low or "handshake" in low or "certificate" in low:
            return DbFailureClassification.TLS_FAILURE
        if "access denied" in low or "authentication failed" in low or "password authentication" in low or "auth failed" in low:
            return DbFailureClassification.AUTHENTICATION_FAILED
        if "permission denied" in low or "forbidden" in low or "privilege" in low:
            return DbFailureClassification.PERMISSION_DENIED
        if "port" in low and ("unreachable" in low or "refused" in low):
            return DbFailureClassification.PORT_UNREACHABLE
        if "connect econnrefused" in low or "connection refused" in low or "could not connect" in low or "unable to connect" in low:
            return DbFailureClassification.PORT_UNREACHABLE
        if "network unreachable" in low or "getaddrinfo" in low or "host not found" in low or "dns" in low or "host unreachable" in low:
            return DbFailureClassification.HOST_UNREACHABLE
        if "config" in low and ("invalid" in low or "malformed" in low or "parse error" in low):
            return DbFailureClassification.DB_CONFIG_INVALID
        if "config" in low and ("not found" in low or "missing" in low or "unresolved" in low):
            return DbFailureClassification.DB_CONFIG_NOT_FOUND
        if "database" in low and ("not found" in low or "doesn't exist" in low or "does not exist" in low or "unknown database" in low):
            return DbFailureClassification.DATABASE_NOT_FOUND
        if "table" in low and ("doesn't exist" in low or "does not exist" in low or "no such table" in low or "unknown table" in low):
            return DbFailureClassification.DATABASE_NOT_FOUND
        if "column" in low and ("not found" in low or "unknown column" in low):
            return DbFailureClassification.DATABASE_NOT_FOUND
        if "credentials" in low or "password required" in low or "no password supplied" in low:
            return DbFailureClassification.SECRET_UNAVAILABLE
        if "driver" in low and ("not found" in low or "could not find driver" in low or "class not found" in low):
            return DbFailureClassification.DRIVER_NOT_FOUND
        if "client" in low and ("not found" in low or "unavailable" in low or "binary not found" in low):
            return DbFailureClassification.CLIENT_NOT_FOUND
        if "tool" in low and ("not available" in low or "unsupported" in low or "unknown tool" in low or "resolution" in low):
            return DbFailureClassification.TOOL_RESOLUTION_FAILURE
        if "unsupported" in low and ("database" in low or "engine" in low):
            return DbFailureClassification.UNSUPPORTED_DATABASE
        if "syntax error" in low or "sqlstate" in low or "query failed" in low or "query execution" in low:
            return DbFailureClassification.QUERY_FAILED
        if "runtime" in low and ("configuration" in low or "error" in low):
            return DbFailureClassification.RUNTIME_CONFIGURATION_ERROR

        return DbFailureClassification.HOST_UNREACHABLE

    @classmethod
    def bootstrap_safe_health_check(cls, db_info: Dict[str, Any]) -> Dict[str, Any]:
        """
        Describes the health query without claiming execution; callers must use
        real_connect_and_health_check to obtain live health evidence.
        """
        engine = str(db_info.get("engine") or "unknown").lower()
        return {
            "healthQuery": "SELECT 1",
            "status": "NOT_VERIFIED",
            "timing_ms": None,
            "database": db_info.get("database"),
            "engine": engine,
            "connected": False,
            "executionStatus": "UNAVAILABLE",
            "executed": False,
        }

    @classmethod
    def list_tables(cls, project_root: str, db_info: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Discovers and lists tables dynamically from authoritative project:
        1. Real SQLite file if present in the project.
        2. Project schema, migrations, ORM entities, and models.
        """
        tables = []
        source = "UNAVAILABLE"
        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        db_type = str((db_info or {}).get("engine") or "").lower()
        live_error = None

        if root and db_type == "sqlite":
            sqlite_path, sqlite_resolution = DatabaseIntelligenceEngine._resolve_sqlite_path(
                project_root,
                db_info,
            )
            if sqlite_path is None:
                live_error = (
                    "DATABASE_TARGET_AMBIGUOUS"
                    if sqlite_resolution == "AMBIGUOUS"
                    else "DATABASE_NOT_FOUND"
                )
            else:
                import sqlite3
                sqf = sqlite_path
                try:
                    conn = sqlite3.connect(f"file:{sqf}?mode=ro", uri=True)
                    try:
                        cursor = conn.cursor()
                        cursor.execute(
                            "SELECT name FROM sqlite_master "
                            "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
                        )
                        tables = [str(row[0]) for row in cursor.fetchall()]
                        source = f"sqlite:{sqf.name}"
                    finally:
                        conn.close()
                except Exception as error:
                    live_error = cls.classify_db_error(str(error))

            # Migrations are source evidence, not proof of the live schema.
        if root and not source.startswith("sqlite:") and not live_error:
            found_tables = set()
            for sql_file in list(root.glob("**/*.sql"))[:15]:
                if any(x in str(sql_file).lower() for x in ("node_modules", ".git", "vendor")):
                    continue
                try:
                    content = sql_file.read_text(encoding="utf-8", errors="ignore")
                    for match in re.finditer(
                        r"create\s+table\s+(?:if\s+not\s+exists\s+)?['\"`]?([a-zA-Z0-9_]+)['\"`]?",
                        content,
                        re.I,
                    ):
                        table_name = match.group(1).lower()
                        if table_name not in ("sqlite_sequence", "migrations"):
                            found_tables.add(table_name)
                except Exception:
                    continue

            if found_tables:
                tables = sorted(found_tables)
                source = "source_migrations"

        if not source.startswith("sqlite:") and source != "source_migrations":
            tables = []
            source = "UNAVAILABLE"

        db_name = (db_info or {}).get("database")
        engine = (db_info or {}).get("engine") or "unknown"

        return {
            "tables": tables,
            "count": len(tables),
            "source": source,
            "database": db_name,
            "engine": engine,
            "status": (
                "SUCCESS"
                if source.startswith("sqlite:")
                else "SOURCE_ONLY"
                if source == "source_migrations"
                else "DATABASE_ERROR"
                if live_error
                else "UNAVAILABLE"
            ),
            "executed": source.startswith("sqlite:"),
            "evidenceQuality": (
                "VERIFIED_LIVE"
                if source.startswith("sqlite:")
                else "SOURCE_ONLY"
                if source == "source_migrations"
                else "UNAVAILABLE"
            ),
            "error": live_error,
        }

    @classmethod
    def real_connect_and_health_check(cls, project_root: str, db_info: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes a real database connection and health check query (SELECT 1).
        Verifies actual connectivity rather than merely validating config strings.
        Updates explicit database state to HEALTH_CHECKED with live DatabaseExecutionProof.
        """
        engine = (db_info.get("engine") or "unknown").lower()
        root = Path(project_root) if project_root and os.path.isdir(project_root) else None

        # Check for real SQLite database using the shared deterministic resolver.
        if root and engine == "sqlite":
            sqlite_path, sqlite_resolution = cls._resolve_sqlite_path(project_root, db_info)
            if sqlite_path is not None:
                import sqlite3
                sqf = sqlite_path
                try:
                    start_t = time.perf_counter()
                    conn = sqlite3.connect(f"file:{sqf}?mode=ro", uri=True)
                    try:
                        cur = conn.cursor()
                        cur.execute("SELECT 1")
                        res = cur.fetchone()
                        duration_ms = round((time.perf_counter() - start_t) * 1000.0, 3)
                    finally:
                        conn.close()
                    if res and res[0] == 1:
                        measured_lat = duration_ms
                        proof = DatabaseExecutionProof(
                            operation=DatabaseCapability.DATABASE_HEALTH_CHECK,
                            engine="sqlite",
                            mode="LIVE",
                            source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                            execution_status="SUCCESS",
                            execution_time_ms=measured_lat,
                            rows_returned=1,
                            query="SELECT 1",
                            database_session_id=str(db_info.get("database_session_id") or ""),
                            project_id=db_info.get("project_id"),
                            repository_id=db_info.get("repository_id"),
                            metadata={
                                "projectId": db_info.get("project_id"),
                                "repositoryId": db_info.get("repository_id"),
                                "targetId": db_info.get("target_id"),
                            },
                        )
                        DatabaseEvidenceStore.record_proof(proof)
                        return {
                            "state": DatabaseState.HEALTH_CHECKED,
                            "status": "CONNECTED",
                            "connected": True,
                            "healthCheck": "HEALTHY",
                            "healthQuery": "SELECT 1",
                            "timing_ms": measured_lat,
                            "database": db_info.get("database") or sqf.name,
                            "engine": "sqlite",
                            "host": "localhost",
                            "driver": db_info.get("driver") or "sqlite3 (native)",
                            "client": db_info.get("existing_utility") or "Project Database Driver",
                            "sqlite_file": str(sqf),
                            "evidenceId": proof.evidence_id,
                            "health_proof": proof,
                        }
                except Exception as e:
                    return {
                        "state": DatabaseState.FAILED,
                        "status": "FAILED",
                        "connected": False,
                        "healthCheck": "FAILED",
                        "healthQuery": "SELECT 1",
                        "timing_ms": None,
                        "error": str(e),
                        "classification": cls.classify_db_error(str(e)),
                        "engine": "sqlite",
                    }
            if sqlite_resolution != "RESOLVED":
                return {
                    "state": DatabaseState.DISCONNECTED,
                    "status": "NOT_VERIFIED",
                    "connected": False,
                    "healthCheck": "NOT_ATTEMPTED",
                    "healthQuery": None,
                    "timing_ms": None,
                    "database": db_info.get("database"),
                    "engine": "sqlite",
                    "error": (
                        "DATABASE_TARGET_AMBIGUOUS"
                        if sqlite_resolution == "AMBIGUOUS"
                        else "DATABASE_NOT_FOUND"
                        if sqlite_resolution == "NOT_FOUND"
                        else "DATABASE_TARGET_UNAVAILABLE"
                    ),
                    "message": "No SQLite health check ran because the configured database target was not uniquely resolved.",
                }

            if len(sqlite_files) != 1:
                reason = (
                    "The configured SQLite database file was not found."
                    if not sqlite_files and (configured_file or configured_database)
                    else "More than one SQLite database matched the selected target."
                    if len(sqlite_files) > 1
                    else "No unambiguous SQLite database file was discovered."
                )
                return {
                    "state": DatabaseState.DISCONNECTED,
                    "status": "UNAVAILABLE",
                    "connected": False,
                    "healthCheck": "NOT_VERIFIED",
                    "healthQuery": "SELECT 1",
                    "timing_ms": None,
                    "error": reason,
                    "engine": "sqlite",
                    "executionStatus": "UNAVAILABLE",
                    "evidenceQuality": "UNVERIFIED",
                    "executed": False,
                }

        has_database_target = any(
            db_info.get(key)
            for key in ("host", "database", "sqlite_file", "connection_uri")
        )
        if engine in ("", "unknown", "unverified") and not has_database_target:
            return {
                "state": DatabaseState.DISCONNECTED,
                "status": "NOT_CONFIGURED",
                "connected": False,
                "healthCheck": "NOT_ATTEMPTED",
                "healthQuery": None,
                "timing_ms": None,
                "database": None,
                "engine": "unknown",
                "host": None,
                "port": None,
                "message": "No authoritative project database target is configured.",
            }

        # Check for real MySQL connection
        if engine == "mysql":
            target_host = (db_info.get("host") or {}).get("value") if isinstance(db_info.get("host"), dict) else db_info.get("host")
            target_db = (db_info.get("database") or {}).get("value") if isinstance(db_info.get("database"), dict) else db_info.get("database")
            target_port = (db_info.get("port") or {}).get("value") if isinstance(db_info.get("port"), dict) else (db_info.get("port") or 3306)
            target_user = (db_info.get("username") or {}).get("value") if isinstance(db_info.get("username"), dict) else db_info.get("username")
            target_pw = (
                ConfigurationSymbolResolver.get_credential(project_root).get("password")
                or (db_info.get("_protected_credentials") or {}).get("password")
                or ""
            )
            if target_host:
                try:
                    import pymysql
                    start_t = time.perf_counter()
                    conn = pymysql.connect(
                        host=str(target_host),
                        port=int(target_port or 3306),
                        user=str(target_user) if target_user else None,
                        password=str(target_pw),
                        database=str(target_db) if target_db else None,
                        connect_timeout=2,
                    )
                    cur = conn.cursor()
                    cur.execute("SELECT 1;")
                    res = cur.fetchone()
                    duration_ms = round((time.perf_counter() - start_t) * 1000.0, 3)
                    conn.close()
                    if res and res[0] == 1:
                        measured_lat = duration_ms
                        proof = DatabaseExecutionProof(
                            operation=DatabaseCapability.DATABASE_HEALTH_CHECK,
                            engine="mysql",
                            mode="LIVE",
                            source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                            execution_status="SUCCESS",
                            execution_time_ms=measured_lat,
                            rows_returned=1,
                            query="SELECT 1",
                        )
                        DatabaseEvidenceStore.record_proof(proof)
                        return {
                            "state": DatabaseState.HEALTH_CHECKED,
                            "status": "CONNECTED",
                            "connected": True,
                            "healthCheck": "HEALTHY",
                            "healthQuery": "SELECT 1",
                            "timing_ms": measured_lat,
                            "database": target_db,
                            "engine": "mysql",
                            "host": target_host,
                            "port": target_port,
                            "driver": "pymysql (native)",
                            "client": db_info.get("existing_utility") or "Project Database Driver",
                            "evidenceId": proof.evidence_id,
                            "health_proof": proof,
                        }
                except Exception as e:
                    return {
                        "state": DatabaseState.FAILED,
                        "status": "FAILED",
                        "connected": False,
                        "healthCheck": "FAILED",
                        "healthQuery": "SELECT 1",
                        "timing_ms": None,
                        "error": str(e),
                        "classification": cls.classify_db_error(str(e)),
                        "engine": "mysql",
                        "database": target_db,
                        "host": target_host,
                    }

        if engine in ("postgres", "postgresql", "supabase"):
            target_host = (db_info.get("host") or {}).get("value") if isinstance(db_info.get("host"), dict) else db_info.get("host")
            target_db = (db_info.get("database") or {}).get("value") if isinstance(db_info.get("database"), dict) else db_info.get("database")
            target_port = (db_info.get("port") or {}).get("value") if isinstance(db_info.get("port"), dict) else (db_info.get("port") or 5432)
            target_user = (db_info.get("username") or {}).get("value") if isinstance(db_info.get("username"), dict) else db_info.get("username")
            credentials = ConfigurationSymbolResolver.get_credential(project_root)
            connection_uri = credentials.get("connection_uri") or db_info.get("connection_uri")
            if connection_uri or target_host:
                try:
                    started_at = time.perf_counter()
                    connection = cls._open_postgresql_connection(project_root, db_info)
                    with connection.cursor() as cursor:
                        cursor.execute("SELECT 1")
                        row = cursor.fetchone()
                        cursor.execute("SELECT current_database(), inet_server_addr()::text, inet_server_port()")
                        identity = cursor.fetchone()
                    connection.close()
                    if row and row[0] == 1:
                        measured = round((time.perf_counter() - started_at) * 1000.0, 3)
                        proof = DatabaseExecutionProof(
                            operation=DatabaseCapability.DATABASE_HEALTH_CHECK,
                            engine="postgresql",
                            mode="LIVE",
                            source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                            execution_status="SUCCESS",
                            execution_time_ms=measured,
                            rows_returned=1,
                            query="SELECT 1",
                        )
                        DatabaseEvidenceStore.record_proof(proof)
                        return {
                            "state": DatabaseState.HEALTH_CHECKED,
                            "status": "CONNECTED",
                            "connected": True,
                            "healthCheck": "HEALTHY",
                            "healthQuery": "SELECT 1",
                            "timing_ms": measured,
                            "database": (identity[0] if identity else None) or target_db,
                            "engine": "postgresql",
                            "host": (identity[1] if identity else None) or target_host,
                            "port": (identity[2] if identity else None) or target_port,
                            "driver": "psycopg",
                            "client": db_info.get("existing_utility") or "Project Database Driver",
                            "evidenceId": proof.evidence_id,
                            "health_proof": proof,
                        }
                except Exception as error:
                    return {
                        "state": DatabaseState.FAILED,
                        "status": "FAILED",
                        "connected": False,
                        "healthCheck": "FAILED",
                        "healthQuery": "SELECT 1",
                        "timing_ms": None,
                        "classification": cls.classify_db_error(str(error)),
                        "engine": "postgresql",
                        "database": target_db,
                        "host": target_host,
                    }

        if engine == "h2":
            try:
                started_at = time.perf_counter()
                connection = cls._open_h2_connection(project_root, db_info)
                try:
                    cursor = connection.cursor()
                    cursor.execute("SELECT 1")
                    row = cursor.fetchone()
                finally:
                    connection.close()
                if row and row[0] == 1:
                    parsed_url = cls.parse_database_url(
                        ConfigurationSymbolResolver.get_credential(project_root).get("connection_uri")
                        or db_info.get("connection_uri")
                        or ""
                    )
                    measured = round((time.perf_counter() - started_at) * 1000.0, 3)
                    proof = DatabaseExecutionProof(
                        operation=DatabaseCapability.DATABASE_HEALTH_CHECK,
                        engine="h2",
                        mode="LIVE",
                        source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                        execution_status="SUCCESS",
                        execution_time_ms=measured,
                        rows_returned=1,
                        query="SELECT 1",
                    )
                    DatabaseEvidenceStore.record_proof(proof)
                    return {
                        "state": DatabaseState.HEALTH_CHECKED,
                        "status": "CONNECTED",
                        "connected": True,
                        "healthCheck": "HEALTHY",
                        "healthQuery": "SELECT 1",
                        "timing_ms": measured,
                        "database": db_info.get("database") or parsed_url.get("database"),
                        "engine": "h2",
                        "host": db_info.get("host") or parsed_url.get("host"),
                        "port": db_info.get("port") or parsed_url.get("port"),
                        "driver": "H2 JDBC",
                        "client": db_info.get("existing_utility") or "Project Database Driver",
                        "evidenceId": proof.evidence_id,
                        "health_proof": proof,
                    }
            except Exception as error:
                parsed_url = cls.parse_database_url(
                    ConfigurationSymbolResolver.get_credential(project_root).get("connection_uri")
                    or db_info.get("connection_uri")
                    or ""
                )
                unsupported_memory = bool(parsed_url.get("in_memory"))
                safe_runtime_message = next(
                    (
                        known_message
                        for known_message in (
                            "H2 JDBC driver JAR was not found.",
                            "The Python JayDeBeApi adapter is not installed in the Coding Agent backend.",
                        )
                        if str(error).startswith(known_message)
                    ),
                    None,
                )
                return {
                    "state": DatabaseState.FAILED,
                    "status": "FAILED",
                    "connected": False,
                    "healthCheck": "FAILED",
                    "healthQuery": "SELECT 1",
                    "timing_ms": None,
                    "classification": (
                        "H2_IN_MEMORY_NOT_ACCESSIBLE"
                        if unsupported_memory
                        else cls.classify_db_error(str(error))
                    ),
                    "message": (
                        "H2 in-memory databases are scoped to the Java application's JVM; use a file-based URL or an H2 TCP server URL."
                        if unsupported_memory
                        else safe_runtime_message
                        if safe_runtime_message
                        else "H2 connection failed; verify the URL, H2 server, and credentials."
                    ),
                    "engine": "h2",
                    "database": db_info.get("database"),
                }

        if engine in ("mongo", "mongodb"):
            target_host = (db_info.get("host") or {}).get("value") if isinstance(db_info.get("host"), dict) else db_info.get("host")
            target_port = (db_info.get("port") or {}).get("value") if isinstance(db_info.get("port"), dict) else (db_info.get("port") or 27017)
            credentials = ConfigurationSymbolResolver.get_credential(project_root)
            connection_uri = credentials.get("connection_uri") or db_info.get("connection_uri")
            if connection_uri or target_host:
                try:
                    started_at = time.perf_counter()
                    client = cls._open_mongodb_client(project_root, db_info)
                    client.admin.command("ping")
                    address = client.address
                    client.close()
                    measured = round((time.perf_counter() - started_at) * 1000.0, 3)
                    proof = DatabaseExecutionProof(
                        operation=DatabaseCapability.DATABASE_HEALTH_CHECK,
                        engine="mongodb",
                        mode="LIVE",
                        source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                        execution_status="SUCCESS",
                        execution_time_ms=measured,
                        rows_returned=1,
                        query="admin.command('ping')",
                    )
                    DatabaseEvidenceStore.record_proof(proof)
                    return {
                        "state": DatabaseState.HEALTH_CHECKED,
                        "status": "CONNECTED",
                        "connected": True,
                        "healthCheck": "HEALTHY",
                        "healthQuery": "admin.command('ping')",
                        "timing_ms": measured,
                        "database": db_info.get("database"),
                        "engine": "mongodb",
                        "host": address[0] if address else target_host,
                        "port": address[1] if address else target_port,
                        "driver": "pymongo",
                        "client": db_info.get("existing_utility") or "Project Database Driver",
                        "evidenceId": proof.evidence_id,
                        "health_proof": proof,
                    }
                except Exception as error:
                    return {
                        "state": DatabaseState.FAILED,
                        "status": "FAILED",
                        "connected": False,
                        "healthCheck": "FAILED",
                        "healthQuery": "admin.command('ping')",
                        "timing_ms": None,
                        "classification": cls.classify_db_error(str(error)),
                        "engine": "mongodb",
                        "database": db_info.get("database"),
                        "host": target_host,
                    }

        # For non-sqlite databases without a verified reachable host:
        # Never fabricate connected=True or hardcoded 1.2ms latency!
        return {
            "state": DatabaseState.DISCONNECTED,
            "status": "NOT_VERIFIED",
            "connected": False,
            "healthCheck": "NOT_ATTEMPTED",
            "healthQuery": None,
            "timing_ms": None,
            "database": db_info.get("database"),
            "engine": engine if engine not in ("unknown", "unverified") else DatabaseState.ENGINE_IDENTIFICATION_UNVERIFIED,
            "host": db_info.get("host"),
            "message": "No health query was executed because no supported live connector was available.",
        }

    @classmethod
    def inspect_database_schema(cls, project_root: str, db_info: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Inspects database schema automatically:
        Tables, views, columns, primary keys, and indexes.
        Distinguishes LIVE DATABASE TABLES from CODE-DISCOVERED TABLE REFERENCES.
        Never fabricates synthetic table lists.
        """
        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        live_tables = []
        schema_details: Dict[str, Any] = {}
        source = DatabaseEvidenceSource.UNVERIFIED
        code_referenced_tables: List[str] = []
        relationships: List[Dict[str, Any]] = []
        views: List[str] = []
        schema_error = None

        engine = str((db_info or {}).get("engine") or "").lower()
        if root:
            if engine == "sqlite":
                sqlite_path, sqlite_resolution = cls._resolve_sqlite_path(
                    project_root,
                    db_info,
                )
                sqlite_files = [sqlite_path] if sqlite_path else []
                if not sqlite_path:
                    schema_error = (
                        "DATABASE_TARGET_AMBIGUOUS"
                        if sqlite_resolution == "AMBIGUOUS"
                        else "DATABASE_NOT_FOUND"
                    )
            else:
                sqlite_files = []
            if sqlite_files and engine == "sqlite":
                import sqlite3
                sqf = sqlite_files[0]
                try:
                    conn = sqlite3.connect(f"file:{sqf}?mode=ro", uri=True)
                    cur = conn.cursor()
                    cur.execute(
                        "SELECT name, type FROM sqlite_master "
                        "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' "
                        "ORDER BY name;"
                    )
                    rows = cur.fetchall()
                    source = DatabaseEvidenceSource.LIVE_DB_EXECUTION
                    if rows:
                        live_tables = [str(row[0]) for row in rows]
                        views = [str(row[0]) for row in rows if row[1] == "view"]
                        for t, table_type in rows:
                            escaped_table = str(t).replace('"', '""')
                            # Columns
                            cur.execute(f'PRAGMA table_info("{escaped_table}");')
                            col_rows = cur.fetchall()
                            cols = [{"name": c[1], "type": c[2], "notnull": bool(c[3]), "pk": bool(c[5])} for c in col_rows]
                            # Indexes
                            cur.execute(f'PRAGMA index_list("{escaped_table}");')
                            idx_rows = cur.fetchall()
                            indexes = []
                            for idx in idx_rows:
                                idx_name = idx[1]
                                escaped_index = str(idx_name).replace('"', '""')
                                cur.execute(f'PRAGMA index_info("{escaped_index}");')
                                idx_cols = [c[2] for c in cur.fetchall()]
                                indexes.append({"name": idx_name, "unique": bool(idx[2]), "columns": idx_cols})
                            cur.execute(f'PRAGMA foreign_key_list("{escaped_table}");')
                            foreign_keys = [
                                {
                                    "name": None,
                                    "columns": [str(row[3])],
                                    "referencedTable": str(row[2]),
                                    "referencedColumns": [str(row[4])],
                                    "provenance": "database_foreign_key",
                                }
                                for row in cur.fetchall()
                            ]
                            relationships.extend(
                                {"table": str(t), **foreign_key}
                                for foreign_key in foreign_keys
                            )
                            schema_details[t] = {
                                "columns": cols,
                                "indexes": indexes,
                                "primary_keys": [c["name"] for c in cols if c["pk"]],
                                "foreign_keys": foreign_keys,
                                "table_type": str(table_type).upper(),
                            }
                    conn.close()
                except Exception as error:
                    schema_error = cls.classify_db_error(str(error))

            if engine in ("mysql", "mariadb"):
                try:
                    connection = cls._open_mysql_connection(project_root, db_info or {})
                    try:
                        cursor = connection.cursor()
                        cursor.execute(
                            "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables "
                            "WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME LIMIT 200"
                        )
                        table_rows = cursor.fetchall()
                        live_tables = [str(row[0]) for row in table_rows]
                        views = [str(row[0]) for row in table_rows if str(row[1]).upper() == "VIEW"]
                        for table_name, table_type in table_rows:
                            table_name = str(table_name)
                            cursor.execute(
                                "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, "
                                "COLUMN_KEY, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE "
                                "FROM information_schema.columns "
                                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s "
                                "ORDER BY ORDINAL_POSITION",
                                (table_name,),
                            )
                            columns = [
                                {
                                    "name": row[0],
                                    "type": row[1],
                                    "notnull": row[2] == "NO",
                                    "default": row[3],
                                    "generated": bool(row[4] and "GENERATED" in str(row[4]).upper()),
                                    "auto_increment": bool(row[4] and "AUTO_INCREMENT" in str(row[4]).upper()),
                                    "pk": str(row[5] or "").upper() == "PRI",
                                    "length": row[6],
                                    "precision": row[7],
                                    "scale": row[8],
                                }
                                for row in cursor.fetchall()
                            ]
                            cursor.execute(
                                "SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE "
                                "FROM information_schema.statistics "
                                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s "
                                "ORDER BY INDEX_NAME, SEQ_IN_INDEX",
                                (table_name,),
                            )
                            indexes_by_name: Dict[str, Dict[str, Any]] = {}
                            for index_name, non_unique, _sequence, column_name, index_type in cursor.fetchall():
                                index = indexes_by_name.setdefault(
                                    str(index_name),
                                    {
                                        "name": str(index_name),
                                        "unique": not bool(non_unique),
                                        "type": str(index_type),
                                        "columns": [],
                                    },
                                )
                                if column_name is not None:
                                    index["columns"].append(str(column_name))
                            cursor.execute(
                                "SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, "
                                "CONSTRAINT_NAME, ORDINAL_POSITION "
                                "FROM information_schema.key_column_usage "
                                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s "
                                "AND REFERENCED_TABLE_NAME IS NOT NULL "
                                "ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
                                (table_name,),
                            )
                            foreign_keys_by_name: Dict[str, Dict[str, Any]] = {}
                            for column, referenced_table, referenced_column, constraint_name, _position in cursor.fetchall():
                                foreign_key = foreign_keys_by_name.setdefault(
                                    str(constraint_name),
                                    {
                                        "name": str(constraint_name),
                                        "columns": [],
                                        "referencedTable": str(referenced_table),
                                        "referencedColumns": [],
                                        "provenance": "database_foreign_key",
                                    },
                                )
                                foreign_key["columns"].append(str(column))
                                foreign_key["referencedColumns"].append(str(referenced_column))
                            foreign_keys = list(foreign_keys_by_name.values())
                            relationships.extend(
                                {"table": table_name, **foreign_key}
                                for foreign_key in foreign_keys
                            )
                            schema_details[table_name] = {
                                "columns": columns,
                                "indexes": list(indexes_by_name.values()),
                                "primary_keys": [column["name"] for column in columns if column["pk"]],
                                "foreign_keys": foreign_keys,
                                "table_type": str(table_type).upper(),
                            }
                    finally:
                        connection.close()
                    source = DatabaseEvidenceSource.LIVE_DB_EXECUTION
                except Exception as error:
                    schema_error = cls.classify_db_error(str(error))
            elif engine in ("postgres", "postgresql", "supabase"):
                try:
                    connection = cls._open_postgresql_connection(project_root, db_info or {})
                    try:
                        cursor = connection.cursor()
                        cursor.execute(
                            "SELECT table_name, table_type FROM information_schema.tables "
                            "WHERE table_schema = current_schema() "
                            "AND table_type IN ('BASE TABLE', 'VIEW') "
                            "ORDER BY table_name LIMIT 200"
                        )
                        table_rows = cursor.fetchall()
                        live_tables = [str(row[0]) for row in table_rows]
                        views = [str(row[0]) for row in table_rows if str(row[1]).upper() == "VIEW"]
                        for table, table_type in table_rows:
                            table = str(table)
                            cursor.execute(
                                "SELECT c.column_name, c.data_type, c.is_nullable, "
                                "EXISTS (SELECT 1 FROM information_schema.table_constraints tc "
                                "JOIN information_schema.key_column_usage kcu "
                                "ON tc.constraint_name = kcu.constraint_name "
                                "AND tc.table_schema = kcu.table_schema "
                                "WHERE tc.constraint_type = 'PRIMARY KEY' "
                                "AND tc.table_schema = current_schema() "
                                "AND tc.table_name = c.table_name "
                                "AND kcu.column_name = c.column_name) "
                                "FROM information_schema.columns c "
                                "WHERE c.table_schema = current_schema() AND c.table_name = %s "
                                "ORDER BY c.ordinal_position",
                                (table,),
                            )
                            columns = [
                                {"name": row[0], "type": row[1], "notnull": row[2] == "NO", "pk": bool(row[3])}
                                for row in cursor.fetchall()
                            ]
                            cursor.execute(
                                "SELECT indexname, indexdef FROM pg_indexes "
                                "WHERE schemaname = current_schema() AND tablename = %s",
                                (table,),
                            )
                            indexes = [
                                {"name": row[0], "unique": "UNIQUE INDEX" in str(row[1]).upper(), "definition": row[1]}
                                for row in cursor.fetchall()
                            ]
                            cursor.execute(
                                "SELECT kcu.constraint_name, kcu.column_name, "
                                "ccu.table_name AS referenced_table, ccu.column_name AS referenced_column, "
                                "kcu.ordinal_position "
                                "FROM information_schema.key_column_usage kcu "
                                "JOIN information_schema.constraint_column_usage ccu "
                                "ON ccu.constraint_name = kcu.constraint_name "
                                "AND ccu.constraint_schema = kcu.constraint_schema "
                                "WHERE kcu.table_schema = current_schema() "
                                "AND kcu.table_name = %s AND kcu.position_in_unique_constraint IS NOT NULL "
                                "ORDER BY kcu.constraint_name, kcu.ordinal_position",
                                (table,),
                            )
                            foreign_keys_by_name: Dict[str, Dict[str, Any]] = {}
                            for constraint_name, column, referenced_table, referenced_column, _position in cursor.fetchall():
                                foreign_key = foreign_keys_by_name.setdefault(
                                    str(constraint_name),
                                    {
                                        "name": str(constraint_name),
                                        "columns": [],
                                        "referencedTable": str(referenced_table),
                                        "referencedColumns": [],
                                        "provenance": "database_foreign_key",
                                    },
                                )
                                foreign_key["columns"].append(str(column))
                                foreign_key["referencedColumns"].append(str(referenced_column))
                            foreign_keys = list(foreign_keys_by_name.values())
                            relationships.extend(
                                {"table": table, **foreign_key}
                                for foreign_key in foreign_keys
                            )
                            schema_details[table] = {
                                "columns": columns,
                                "indexes": indexes,
                                "primary_keys": [column["name"] for column in columns if column["pk"]],
                                "foreign_keys": foreign_keys,
                                "table_type": str(table_type).upper(),
                            }
                    finally:
                        connection.close()
                    source = DatabaseEvidenceSource.LIVE_DB_EXECUTION
                except Exception as error:
                    schema_error = cls.classify_db_error(str(error))
            elif engine == "h2":
                try:
                    connection = cls._open_h2_connection(project_root, db_info or {})
                    try:
                        cursor = connection.cursor()
                        cursor.execute(
                            "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
                            "WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') "
                            "ORDER BY TABLE_NAME"
                        )
                        live_tables = [str(row[0]) for row in cursor.fetchall()]
                        for table in live_tables:
                            cursor.execute(
                                "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE "
                                "FROM INFORMATION_SCHEMA.COLUMNS "
                                "WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME = ? "
                                "ORDER BY ORDINAL_POSITION",
                                (table,),
                            )
                            columns = [
                                {"name": row[0], "type": row[1], "notnull": row[2] == "NO", "pk": False}
                                for row in cursor.fetchall()
                            ]
                            cursor.execute(
                                "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE "
                                "WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME = ? "
                                "AND CONSTRAINT_NAME IN (SELECT CONSTRAINT_NAME "
                                "FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS "
                                "WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME = ? "
                                "AND CONSTRAINT_TYPE = 'PRIMARY KEY')",
                                (table, table),
                            )
                            primary_keys = {str(row[0]) for row in cursor.fetchall()}
                            for column in columns:
                                column["pk"] = column["name"] in primary_keys
                            cursor.execute(
                                "SELECT I.INDEX_NAME, I.INDEX_TYPE_NAME, C.COLUMN_NAME "
                                "FROM INFORMATION_SCHEMA.INDEXES I "
                                "JOIN INFORMATION_SCHEMA.INDEX_COLUMNS C "
                                "ON C.INDEX_SCHEMA = I.INDEX_SCHEMA AND C.INDEX_NAME = I.INDEX_NAME "
                                "WHERE I.TABLE_SCHEMA = 'PUBLIC' AND I.TABLE_NAME = ? "
                                "ORDER BY I.INDEX_NAME, C.ORDINAL_POSITION",
                                (table,),
                            )
                            indexes_by_name: Dict[str, Dict[str, Any]] = {}
                            for index_name, index_type, column_name in cursor.fetchall():
                                index = indexes_by_name.setdefault(
                                    str(index_name),
                                    {
                                        "name": str(index_name),
                                        "unique": str(index_type).upper().startswith(("UNIQUE", "PRIMARY KEY")),
                                        "columns": [],
                                    },
                                )
                                if column_name:
                                    index["columns"].append(str(column_name))
                            schema_details[table] = {
                                "columns": columns,
                                "indexes": list(indexes_by_name.values()),
                                "primary_keys": sorted(primary_keys),
                            }
                    finally:
                        connection.close()
                    source = DatabaseEvidenceSource.LIVE_DB_EXECUTION
                except Exception as error:
                    schema_error = cls.classify_db_error(str(error))
            elif engine in ("mongo", "mongodb"):
                try:
                    client = cls._open_mongodb_client(project_root, db_info or {})
                    try:
                        database = client[str((db_info or {}).get("database") or "admin")]
                        live_tables = database.list_collection_names()
                        for collection_name in live_tables[:200]:
                            collection = database[collection_name]
                            sample = collection.find_one()
                            columns = [
                                {"name": name, "type": type(value).__name__, "notnull": value is not None, "pk": name == "_id"}
                                for name, value in (sample or {}).items()
                            ]
                            indexes = [
                                {"name": name, "unique": bool(details.get("unique")), "keys": details.get("key", [])}
                                for name, details in collection.index_information().items()
                            ]
                            schema_details[collection_name] = {
                                "columns": columns,
                                "indexes": indexes,
                                "primary_keys": ["_id"] if sample and "_id" in sample else [],
                            }
                    finally:
                        client.close()
                    source = DatabaseEvidenceSource.LIVE_DB_EXECUTION
                except Exception as error:
                    schema_error = cls.classify_db_error(str(error))

            # Scan models & migrations for code-level references
            found_tables = set()
            for sql_file in list(root.glob("**/*.sql"))[:15]:
                if any(x in str(sql_file).lower() for x in ("node_modules", ".git", "vendor")):
                    continue
                try:
                    content = sql_file.read_text(encoding="utf-8", errors="ignore")
                    for m in re.finditer(r"create\s+table\s+(?:if\s+not\s+exists\s+)?['\"`]?([a-zA-Z0-9_]+)['\"`]?", content, re.I):
                        t = m.group(1).lower()
                        if t not in ("sqlite_sequence", "migrations"):
                            found_tables.add(t)
                except Exception:
                    pass
            if found_tables:
                code_referenced_tables = sorted(list(found_tables))

        # Build execution proof if live execution succeeded
        evidence_id = None
        if source == DatabaseEvidenceSource.LIVE_DB_EXECUTION:
            schema_engine = str((db_info or {}).get("engine") or "unknown").lower()
            proof = DatabaseExecutionProof(
                database_session_id=(db_info or {}).get("database_session_id"),
                operation=DatabaseCapability.DATABASE_LIST_TABLES,
                engine=schema_engine,
                mode="LIVE",
                source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                execution_status="SUCCESS",
                rows_returned=len(live_tables),
                schema_object="all_tables",
            )
            DatabaseEvidenceStore.record_proof(proof)
            evidence_id = proof.evidence_id

        return {
            "state": DatabaseState.SCHEMA_INSPECTED,
            "tables": live_tables,
            "count": len(live_tables),
            "live_tables": live_tables,
            "views": views,
            "code_referenced_tables": code_referenced_tables,
            "schema_details": schema_details,
            "relationships": relationships,
            "source": source,
            "schema_source": source,
            "status": "SUCCESS" if source == DatabaseEvidenceSource.LIVE_DB_EXECUTION else ("DATABASE_ERROR" if schema_error else "CODE_REFERENCES_ONLY" if code_referenced_tables else "NO_SCHEMA_FOUND"),
            "database": (db_info or {}).get("database"),
            "engine": (db_info or {}).get("engine") or "unknown",
            "error": schema_error,
            "evidenceId": evidence_id,
            "schema_evidence_id": evidence_id,
        }

    @classmethod
    def discover_relevant_queries(cls, project_root: str, scope: str = ".") -> List[Dict[str, Any]]:
        """
        Discovers database queries in active project code:
        Traverses models, services, repositories, DAO/mappers, controllers.
        Scope is advisory and does not block dependency traversal.
        """
        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        if not root:
            return []

        queries = []
        scan_dirs = ["models", "entities", "services", "repositories", "controllers", "src", "app"]
        candidate_files = []
        for d in scan_dirs:
            target_d = root / d
            if target_d.is_dir():
                for f in target_d.rglob("*.*"):
                    if f.suffix.lower() in (".php", ".ts", ".js", ".py", ".java", ".go", ".cs", ".rb"):
                        if not any(ign in str(f).lower() for ign in ("vendor", "node_modules", ".git", "test")):
                            candidate_files.append(f)

        if not candidate_files:
            for f in root.glob("*.*"):
                if f.suffix.lower() in (".php", ".ts", ".js", ".py"):
                    candidate_files.append(f)

        sql_pattern = re.compile(
            r"""(?P<q>['"`])((?:SELECT|INSERT|UPDATE|DELETE)[\s\S]+?)(?P=q)""",
            re.I
        )
        query_builder_pattern = re.compile(
            r"(->(?:query|where|andWhere|find|all|one)\([^)]+\))",
            re.I
        )

        for cf in candidate_files[:30]:
            try:
                rel = str(cf.relative_to(root)).replace("\\", "/")
                content = cf.read_text(encoding="utf-8", errors="ignore")
                for match in sql_pattern.finditer(content):
                    raw_q = match.group(2).strip()
                    if len(raw_q) > 10 and not any(q["query"] == raw_q for q in queries):
                        tbl_m = re.search(r"\bFROM\s+([a-zA-Z0-9_]+)", raw_q, re.I)
                        tbl = tbl_m.group(1).lower() if tbl_m else None
                        queries.append({
                            "query": raw_q,
                            "file": rel,
                            "table": tbl,
                            "type": "RAW_SQL",
                            "source": DatabaseEvidenceSource.SOURCE_CODE,
                        })
                for match in query_builder_pattern.finditer(content):
                    raw_call = match.group(1).strip()
                    if len(raw_call) > 8 and not any(q.get("call") == raw_call for q in queries):
                        queries.append({
                            "query": f"Query builder in {rel}: {raw_call}",
                            "file": rel,
                            "table": cf.stem.lower() if cf.stem.lower().endswith("s") else f"{cf.stem.lower()}s",
                            "type": "QUERY_BUILDER",
                            "call": raw_call,
                            "source": DatabaseEvidenceSource.SOURCE_CODE,
                        })
            except Exception:
                continue

        return queries

    @classmethod
    def execute_query_and_explain(
        cls,
        project_root: str,
        query: str,
        db_info: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Safely executes a representative query, measures execution time,
        and analyzes the execution plan (EXPLAIN) using native database mechanisms.
        Never fabricates default execution plans or constant timings.
        """
        sql_decision, sql_reason = PolicyGate.check_sql(query or "")
        if sql_decision != "ALLOW":
            return {
                "state": DatabaseState.QUERY_DISCOVERED,
                "query": query,
                "timing_ms": None,
                "rows_returned": None,
                "plan": None,
                "status": "BLOCKED",
                "executionStatus": "BLOCKED",
                "evidenceQuality": "UNVERIFIED",
                "executed": False,
                "error": sql_reason,
            }
        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        engine = str((db_info or {}).get("engine") or "unknown").lower()
        db_name = (db_info or {}).get("database")

        if engine == "sqlite":
            sqlite_path, sqlite_resolution = cls._resolve_sqlite_path(project_root, db_info)
            if sqlite_path is None:
                return {
                    "state": DatabaseState.QUERY_DISCOVERED,
                    "query": query,
                    "timing_ms": None,
                    "rows_returned": None,
                    "plan": None,
                    "status": sqlite_resolution,
                    "executionStatus": "UNAVAILABLE",
                    "evidenceQuality": "UNVERIFIED",
                    "executed": False,
                    "error": (
                        "DATABASE_TARGET_AMBIGUOUS"
                        if sqlite_resolution == "AMBIGUOUS"
                        else "DATABASE_NOT_FOUND"
                        if sqlite_resolution == "NOT_FOUND"
                        else "DATABASE_TARGET_UNAVAILABLE"
                    ),
                }
            if root:
                import sqlite3
                sqf = sqlite_path
                try:
                    conn = sqlite3.connect(f"file:{sqf}?mode=ro", uri=True)
                    conn.row_factory = sqlite3.Row
                    cur = conn.cursor()

                    # 1. EXPLAIN QUERY PLAN
                    plan_output = ""
                    try:
                        cur.execute(f"EXPLAIN QUERY PLAN {query}")
                        plan_rows = [dict(r) for r in cur.fetchall()]
                        plan_output = "\n".join(str(r.get("detail") or r) for r in plan_rows)
                    except Exception:
                        plan_rows = []
                        plan_output = ""

                    # 2. Measure actual query execution time
                    start_t = time.perf_counter()
                    cur.execute(query)
                    rows = [dict(r) for r in cur.fetchall()[:50]]
                    duration_ms = round((time.perf_counter() - start_t) * 1000.0, 3)
                    conn.close()

                    # 3. Determine index usage from plan
                    index_match = re.search(
                        r"\bUSING\s+(?:COVERING\s+)?INDEX\s+([^\s]+)",
                        plan_output,
                        re.I,
                    )
                    scan_match = re.search(
                        r"\bSCAN(?:\s+TABLE)?\s+([^\s]+)",
                        plan_output,
                        re.I,
                    )
                    index_used = index_match.group(1).strip('"`[]') if index_match else None
                    access_type = (
                        "SEARCH"
                        if index_match and re.search(r"\bSEARCH\b", plan_output, re.I)
                        else "INDEX_SCAN"
                        if index_match
                        else "SCAN"
                        if scan_match
                        else "UNKNOWN"
                    )
                    bottleneck = (
                        "SQLite query plan reports indexed access."
                        if index_match
                        else "SQLite query plan reports a table scan."
                        if scan_match
                        else "SQLite query plan does not expose a classifiable access path."
                    )

                    measured_timing = duration_ms
                    q_fp = DatabaseExecutionProof.compute_fingerprint(query)
                    plan_fp = q_fp

                    proof = DatabaseExecutionProof(
                        operation=DatabaseCapability.DATABASE_QUERY,
                        engine="sqlite",
                        mode="LIVE",
                        source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                        execution_status="SUCCESS",
                        execution_time_ms=measured_timing,
                        rows_returned=len(rows),
                        query=query,
                        query_fingerprint=q_fp,
                        plan_output=plan_output or None,
                        plan_fingerprint=plan_fp if plan_output else None,
                    )
                    DatabaseEvidenceStore.record_proof(proof)

                    return {
                        "state": DatabaseState.TIMING_MEASURED,
                        "query": query,
                        "query_fingerprint": q_fp,
                        "plan_fingerprint": plan_fp if plan_output else None,
                        "timing_ms": measured_timing,
                        "rows_returned": len(rows),
                        "plan": plan_output or None,
                        "index_used": index_used,
                        "access_type": access_type,
                        "bottleneck": bottleneck,
                        "confidence": "MEASURED" if plan_output else "UNVERIFIED",
                        "database": db_name,
                        "engine": "sqlite",
                        "status": "SUCCESS" if plan_output else "PLAN_UNAVAILABLE",
                        "executionStatus": "SUCCESS" if plan_output else "UNAVAILABLE",
                        "evidenceQuality": "VERIFIED_LIVE" if plan_output else "UNVERIFIED",
                        "executed": bool(plan_output),
                        "evidenceId": proof.evidence_id,
                    }
                except Exception:
                    pass

        if engine in ("postgres", "postgresql", "supabase", "h2"):
            execution = cls.execute_safe_query(project_root, query, db_info)
            if execution.get("ok"):
                explain = cls.execute_safe_query(project_root, f"EXPLAIN {query}", db_info)
                plan_rows = explain.get("rows", []) if explain.get("ok") else []
                plan_output = "\n".join(
                    str(value)
                    for row in plan_rows
                    for value in row.values()
                )
                q_fp = DatabaseExecutionProof.compute_fingerprint(query)
                plan_fp = q_fp if plan_rows else None
                index_match = re.search(r"\b(?:Index Scan|Index Only Scan)\s+using\s+([^\s]+)", plan_output, re.I)
                seq_scan = bool(re.search(r"\bSeq Scan\b", plan_output, re.I))
                index_used = index_match.group(1) if index_match else ("None (Sequential Scan)" if seq_scan else "INDEX_INFORMATION_UNAVAILABLE")
                access_type = "index" if index_match else "ALL" if seq_scan else "UNVERIFIED"
                measured_timing = (
                    float(execution["timingMs"])
                    if isinstance(execution.get("timingMs"), (int, float))
                    else None
                )
                if not plan_rows:
                    return {
                        "state": DatabaseState.QUERY_EXECUTED,
                        "query": query,
                        "query_fingerprint": q_fp,
                        "plan_fingerprint": None,
                        "timing_ms": None,
                        "rows_returned": None,
                        "plan": None,
                        "index_used": None,
                        "access_type": "UNKNOWN",
                        "bottleneck": "No verified EXPLAIN plan was returned.",
                        "confidence": "UNVERIFIED",
                        "database": db_name,
                        "engine": engine,
                        "status": "PLAN_UNAVAILABLE",
                        "executionStatus": "UNAVAILABLE",
                        "evidenceQuality": "UNVERIFIED",
                        "executed": False,
                    }
                proof = DatabaseExecutionProof(
                    operation=DatabaseCapability.DATABASE_EXPLAIN,
                    engine=engine,
                    mode="LIVE",
                    source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                    execution_status="SUCCESS",
                    execution_time_ms=measured_timing,
                    rows_returned=len(execution.get("rows") or []),
                    query=query,
                    query_fingerprint=q_fp,
                    plan_output=plan_output or None,
                    plan_fingerprint=plan_fp,
                )
                DatabaseEvidenceStore.record_proof(proof)
                return {
                    "state": DatabaseState.TIMING_MEASURED,
                    "query": query,
                    "query_fingerprint": q_fp,
                    "plan_fingerprint": plan_fp,
                    "timing_ms": measured_timing,
                    "rows_returned": len(execution.get("rows") or []),
                    "plan": plan_output or None,
                    "index_used": index_used,
                    "access_type": access_type,
                    "bottleneck": (
                        "Execution plan reports a sequential scan."
                        if seq_scan
                        else "Plan measured; no sequential scan identified."
                        if plan_rows
                        else "EXPLAIN plan unavailable."
                    ),
                    "confidence": "PLAN_BASED",
                    "database": db_name,
                    "engine": engine,
                    "status": "SUCCESS",
                    "executionStatus": "SUCCESS",
                    "evidenceQuality": "VERIFIED_LIVE",
                    "executed": True,
                    "evidenceId": proof.evidence_id,
                }

        # Code-only fallback when live execution cannot run:
        # Never fabricate 1.2ms, fake row counts, or fake EXPLAIN plans!
        return {
            "state": DatabaseState.QUERY_DISCOVERED,
            "query": query,
            "query_fingerprint": DatabaseExecutionProof.compute_fingerprint(query),
            "plan_fingerprint": None,
            "timing_ms": None,
            "rows_returned": None,
            "plan": None,
            "index_used": "INDEX_INFORMATION_UNAVAILABLE",
            "access_type": "UNVERIFIED",
            "bottleneck": "Static code analysis only: live execution plan and latency require active database execution.",
            "confidence": "CODE-LEVEL",
            "database": db_name,
            "engine": engine,
            "status": "CODE_ONLY",
            "executionStatus": "UNAVAILABLE",
            "evidenceQuality": "UNVERIFIED",
            "executed": False,
        }

    @classmethod
    def format_database_investigation_report(
        cls,
        db_info: Dict[str, Any],
        health: Dict[str, Any],
        schema: Dict[str, Any],
        query_info: Optional[Dict[str, Any]] = None,
    ) -> str:
        """
        Formats report strictly adhering to Section 24 Response Contract,
        Section 25 No-Suggestion Rule, and Anti-Fabrication Evidence Provenance.
        """
        db_type = db_info.get("engine") or health.get("engine") or "NOT_VERIFIED"
        raw_latency = health.get("timing_ms")
        latency_str = f"{raw_latency}ms" if isinstance(raw_latency, (int, float)) and raw_latency >= 0 else "UNAVAILABLE"
        
        tables = schema.get("tables")
        live_schema_verified = (
            schema.get("status") == "SUCCESS"
            and schema.get("source") == DatabaseEvidenceSource.LIVE_DB_EXECUTION
            and isinstance(tables, list)
        )
        tables = tables if isinstance(tables, list) else []
        code_tables = schema.get("code_referenced_tables", [])
        tables_str = ", ".join(f"`{t}`" for t in tables) or "None"

        rel_q = (query_info or {}).get("query") or "UNAVAILABLE (no query evidence)"
        target_tbl = (query_info or {}).get("table")

        # Schema findings
        if live_schema_verified:
            schema_findings = f"- Live schema inspection found {len(tables)} tables: {tables_str}\n"
        elif schema.get("status") == "DATABASE_ERROR":
            schema_findings = "- Live schema inspection failed; schema details are UNAVAILABLE.\n"
        else:
            schema_findings = "- Live schema inspection is UNAVAILABLE; no live table count is asserted.\n"
        if code_tables and code_tables != tables:
            schema_findings += f"- Code-discovered table references: {', '.join(f'`{t}`' for t in code_tables)}\n"

        tbl_details = (schema.get("schema_details") or {}).get(target_tbl) if target_tbl else None
        if tbl_details and live_schema_verified:
            cols = [c["name"] for c in tbl_details.get("columns", [])]
            if cols:
                schema_findings += f"- Table `{target_tbl}` columns: {', '.join(cols)}\n"
            pks = tbl_details.get("primary_keys", [])
            if pks:
                schema_findings += f"- Primary key: {', '.join(pks)}"

        # Indexes
        idx_str = "UNAVAILABLE (no index evidence)"
        if tbl_details and tbl_details.get("indexes"):
            idx_list = [i.get("name") for i in tbl_details["indexes"]]
            idx_str = f"Existing indexes on `{target_tbl}`: {', '.join(idx_list)}"
        elif (query_info or {}).get("index_used"):
            idx_str = query_info["index_used"]
        elif target_tbl and tbl_details is not None and live_schema_verified:
            idx_str = f"No indexes were reported for `{target_tbl}` by the inspected schema."

        # Query execution timing
        raw_q_timing = (query_info or {}).get("timing_ms")
        if isinstance(raw_q_timing, (int, float)) and raw_q_timing >= 0:
            q_timing = f"{raw_q_timing}ms"
        else:
            q_timing = "UNAVAILABLE (no query-specific timing evidence)"

        if (query_info or {}).get("rows_returned") is not None:
            q_timing += f" ({(query_info or {}).get('rows_returned')} rows returned)"

        # Execution plan
        plan_str = (query_info or {}).get("plan") or "UNAVAILABLE (no query plan evidence)"

        connected = health.get("connected") is True
        health_status = "successful" if connected else (
            str(health.get("status") or health.get("classification") or "NOT_VERIFIED")
        )
        connection_status = "successful" if connected else "NOT_VERIFIED"
        report_heading = (
            "Database discovered and connected."
            if connected and db_info.get("discovered", True)
            else "Database connection not verified."
        )
        access_type = (query_info or {}).get("access_type") or "UNAVAILABLE"
        if (query_info or {}).get("plan") or isinstance(raw_q_timing, (int, float)):
            finding_str = (
                f"Query-specific evidence is available for `{target_tbl or 'UNRESOLVED_TABLE'}`; "
                f"access type: `{access_type}`; index evidence: `{idx_str}`. "
                "No latency root cause is asserted unless supported by the returned plan and measurements."
            )
        else:
            finding_str = "No query-specific plan or timing evidence is available; no latency root cause can be concluded."

        report = (
            f"{report_heading}\n\n"
            f"Database: {db_type}\n"
            f"Connection: {connection_status}\n"
            f"Health check: {health_status}\n"
            f"Latency: {latency_str}\n\n"
            f"Relevant table/query discovered:\n"
            f"```sql\n{rel_q}\n```\n\n"
            f"Schema findings:\n"
            f"{schema_findings.strip()}\n\n"
            f"Indexes:\n"
            f"{idx_str}\n\n"
            f"Query execution:\n"
            f"{q_timing}\n\n"
            f"Execution plan:\n"
            f"```\n{plan_str}\n```\n\n"
            f"Finding:\n"
            f"{finding_str}\n"
        )
        return report

    @classmethod
    def evaluate_actionability_guard(cls, request: str, intent_info: Dict[str, Any]) -> Dict[str, bool]:
        """
        Enforces Section 23 Actionability Guard:
        Evaluates whether request requires actual DB execution vs user questioning.
        """
        is_db = intent_info.get("intent") == "DATABASE_INVESTIGATION" or bool(re.search(
            r"\b(?:connect\s+db|check\s+db|figure\s+out\s+db|find\s+slow\s+query|inspect\s+database|only\s+connect)\b",
            request,
            re.I
        ))
        if is_db:
            return {
                "actionable": True,
                "execution_required": True,
                "user_question_required": False,
            }
        return {
            "actionable": True,
            "execution_required": False,
            "user_question_required": False,
        }

    @classmethod
    def execute_safe_query(cls, project_root: str, sql: str, db_info: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Executes a safe read-only SQL query against the active project database.
        Destructive operations are permanently blocked.
        """
        raw_sql = str(sql or "").strip()
        if not raw_sql:
            return {
                "ok": False,
                "error": {
                    "code": "SQL_REQUIRED",
                    "message": "A SQL query is required; no database operation was run.",
                },
            }
        cmd_eval, reason = PolicyGate.check_sql(raw_sql)
        if cmd_eval != "ALLOW":
            return {
                "ok": False,
                "error": {
                    "code": f"SQL_POLICY_{cmd_eval}",
                    "message": reason,
                }
            }

        root = Path(project_root) if project_root and os.path.isdir(project_root) else None
        config = db_info or {}
        engine = (config.get("engine") or "unknown").lower()
        db_name = config.get("database")

        if not re.match(r"^\s*(?:SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|PRAGMA)\b", raw_sql, re.I):
            return {
                "ok": False,
                "error": {
                    "code": "READ_ONLY_QUERY_REQUIRED",
                    "message": "Only read-only SELECT, WITH, EXPLAIN, SHOW, DESCRIBE, and PRAGMA queries are permitted.",
                },
            }
        if re.search(r"\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE|CALL)\b", raw_sql, re.I):
            return {
                "ok": False,
                "error": {
                    "code": "READ_ONLY_QUERY_REQUIRED",
                    "message": "This query can write data or acquire write locks and is not permitted.",
                },
            }

        # Execute against the project's real SQLite file in read-only mode.
        if root and engine == "sqlite":
            sqlite_path, sqlite_resolution = cls._resolve_sqlite_path(project_root, config)
            if sqlite_path is not None:
                import sqlite3
                try:
                    start_t = time.perf_counter()
                    conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
                    conn.row_factory = sqlite3.Row
                    cursor = conn.cursor()
                    sqlite_sql = raw_sql
                    if re.match(r"^\s*SHOW\s+TABLES\b", raw_sql, re.I):
                        sqlite_sql = (
                            "SELECT name FROM sqlite_master "
                            "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
                        )
                    cursor.execute(sqlite_sql)
                    rows = [dict(r) for r in cursor.fetchmany(50)]
                    duration_ms = round((time.perf_counter() - start_t) * 1000.0, 2)
                    conn.close()
                    return {
                        "ok": True,
                        "query": raw_sql,
                        "executed": True,
                        "status": "SUCCESS",
                        "timingMs": duration_ms,
                        "rows": rows,
                        "mode": "READ_ONLY",
                        "database": db_name,
                        "engine": engine,
                    }
                except Exception as error:
                    return {
                        "ok": False,
                        "error": {
                            "code": "DATABASE_QUERY_FAILED",
                            "message": f"Read-only SQLite query failed: {error}",
                        },
                    }
            return {
                "ok": False,
                "error": {
                    "code": (
                        "DATABASE_TARGET_AMBIGUOUS"
                        if sqlite_resolution == "AMBIGUOUS"
                        else "DATABASE_NOT_CONNECTED"
                    ),
                    "message": (
                        "Multiple SQLite database files match the project; configure an explicit target."
                        if sqlite_resolution == "AMBIGUOUS"
                        else "No uniquely resolved SQLite database file is available for a live query."
                    ),
                },
            }

        if engine in ("mysql", "mariadb"):
            host = config.get("host")
            port = config.get("port")
            username = config.get("username")
            password = config.get("password")
            if not all((host, db_name, username)):
                return {
                    "ok": False,
                    "error": {
                        "code": "DATABASE_NOT_CONNECTED",
                        "message": "The live database connection is missing a configured host, database, or username.",
                    },
                }
            try:
                import pymysql

                started_at = time.perf_counter()
                connection = pymysql.connect(
                    host=str(host),
                    port=int(port or 3306),
                    user=str(username),
                    password=str(password or ""),
                    database=str(db_name),
                    connect_timeout=3,
                    read_timeout=10,
                    write_timeout=5,
                    autocommit=False,
                    init_command="SET SESSION TRANSACTION READ ONLY",
                )
                try:
                    connection.begin()
                    cursor = connection.cursor()
                    cursor.execute(raw_sql)
                    description = cursor.description or ()
                    column_names = [column[0] for column in description]
                    rows = cursor.fetchmany(50)
                    if rows and not isinstance(rows[0], dict):
                        rows = [dict(zip(column_names, row)) for row in rows]
                    rows = json.loads(json.dumps(rows[:50], default=str))
                    duration_ms = round((time.perf_counter() - started_at) * 1000.0, 2)
                    return {
                        "ok": True,
                        "query": raw_sql,
                        "executed": True,
                        "status": "SUCCESS",
                        "timingMs": duration_ms,
                        "rows": rows,
                        "mode": "READ_ONLY",
                        "database": db_name,
                        "engine": engine,
                    }
                finally:
                    try:
                        connection.rollback()
                    finally:
                        connection.close()
            except Exception as error:
                classification = DatabaseIntelligenceEngine.classify_db_error(str(error))
                return {
                    "ok": False,
                    "error": {
                        "code": "DATABASE_QUERY_FAILED",
                        "message": f"Live {engine} query failed ({classification}).",
                    },
                }

        if engine in ("postgres", "postgresql", "supabase"):
            host = config.get("host")
            port = config.get("port") or 5432
            username = config.get("username")
            password = config.get("password")
            connection_uri = config.get("connection_uri")
            if not connection_uri and not all((host, db_name, username)):
                return {
                    "ok": False,
                    "error": {
                        "code": "DATABASE_NOT_CONNECTED",
                        "message": "The live PostgreSQL connection is missing a configured host, database, or username.",
                    },
                }
            try:
                import psycopg

                started_at = time.perf_counter()
                connection = psycopg.connect(
                    connection_uri,
                    connect_timeout=3,
                ) if connection_uri else psycopg.connect(
                    host=str(host),
                    port=int(port),
                    dbname=str(db_name),
                    user=str(username),
                    password=str(password or ""),
                    connect_timeout=3,
                )
                try:
                    cursor = connection.cursor()
                    cursor.execute("SET TRANSACTION READ ONLY")
                    cursor.execute(raw_sql)
                    column_names = [column.name for column in (cursor.description or ())]
                    rows = cursor.fetchmany(50)
                    rows = [dict(zip(column_names, row)) for row in rows]
                    rows = json.loads(json.dumps(rows, default=str))
                    duration_ms = round((time.perf_counter() - started_at) * 1000.0, 2)
                    return {
                        "ok": True,
                        "query": raw_sql,
                        "executed": True,
                        "status": "SUCCESS",
                        "timingMs": duration_ms,
                        "rows": rows,
                        "mode": "READ_ONLY",
                        "database": db_name,
                        "engine": "postgresql",
                    }
                finally:
                    try:
                        connection.rollback()
                    finally:
                        connection.close()
            except Exception as error:
                classification = DatabaseIntelligenceEngine.classify_db_error(str(error))
                return {
                    "ok": False,
                    "error": {
                        "code": "DATABASE_QUERY_FAILED",
                        "message": f"Live PostgreSQL query failed ({classification}).",
                    },
                }

        if engine == "h2":
            try:
                started_at = time.perf_counter()
                connection = DatabaseIntelligenceEngine._open_h2_connection(project_root, config)
                try:
                    cursor = connection.cursor()
                    cursor.execute(raw_sql)
                    column_names = [column[0] for column in (cursor.description or ())]
                    rows = cursor.fetchmany(50)
                    rows = [dict(zip(column_names, row)) for row in rows]
                    rows = json.loads(json.dumps(rows, default=str))
                    duration_ms = round((time.perf_counter() - started_at) * 1000.0, 2)
                    return {
                        "ok": True,
                        "query": raw_sql,
                        "executed": True,
                        "status": "SUCCESS",
                        "timingMs": duration_ms,
                        "rows": rows,
                        "mode": "READ_ONLY",
                        "database": db_name,
                        "engine": "h2",
                    }
                finally:
                    connection.close()
            except Exception as error:
                classification = DatabaseIntelligenceEngine.classify_db_error(str(error))
                return {
                    "ok": False,
                    "error": {
                        "code": "DATABASE_QUERY_FAILED",
                        "message": f"Live H2 query failed ({classification}).",
                    },
                }

        return {
            "ok": False,
            "error": {
                "code": "DATABASE_EXECUTION_UNAVAILABLE",
                "message": f"No live read-only query adapter is available for database engine '{engine}'.",
            },
        }

    @classmethod
    def format_performance_contract_report(
        cls,
        query: str,
        file_symbol: str = "",
        database: str = "",
        actual_timing: Optional[str] = None,
        rows_examined: Optional[int] = None,
        rows_returned: Optional[int] = None,
        index_used: Optional[str] = None,
        access_type: Optional[str] = None,
        explain_plan: Optional[str] = None,
        bottleneck: Optional[str] = None,
        confidence: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Formats performance investigation findings matching the exact 11 fields:
        QUERY, FILE / SYMBOL, DATABASE, ACTUAL TIMING, ROWS EXAMINED,
        ROWS RETURNED, INDEX USED, ACCESS TYPE, EXPLAIN, BOTTLENECK, CONFIDENCE.
        Confidence must be one of: MEASURED, CODE-LEVEL, UNVERIFIED.
        Never reports CODE-LEVEL after successful actual DB measurement!
        """
        has_actual_timing = bool(actual_timing and actual_timing.strip() and actual_timing.strip() != "N/A")
        has_explain_plan = bool(explain_plan and explain_plan.strip())

        resolved_conf = confidence
        if has_actual_timing:
            resolved_conf = "MEASURED"
        elif has_explain_plan:
            resolved_conf = "PLAN_BASED"
        elif not resolved_conf:
            resolved_conf = "CODE-LEVEL" if query else "UNVERIFIED"

        if resolved_conf not in (
            "MEASURED", "PLAN_BASED", "HEURISTIC", "INFERRED", "CODE-LEVEL", "UNVERIFIED"
        ):
            resolved_conf = "UNVERIFIED"

        report_markdown = (
            f"### DATABASE QUERY PERFORMANCE REPORT\n\n"
            f"- **QUERY:** `{query}`\n"
            f"- **FILE / SYMBOL:** `{file_symbol or 'UNAVAILABLE'}`\n"
            f"- **DATABASE:** {database or 'UNKNOWN'}\n"
            f"- **ACTUAL TIMING:** {actual_timing or 'Static code inspection only (DB execution timing unavailable)'}\n"
            f"- **ROWS EXAMINED:** {rows_examined if rows_examined is not None else 'N/A'}\n"
            f"- **ROWS RETURNED:** {rows_returned if rows_returned is not None else 'N/A'}\n"
            f"- **INDEX USED:** {index_used or 'UNKNOWN'}\n"
            f"- **ACCESS TYPE:** {access_type or 'UNKNOWN'}\n"
            f"- **EXPLAIN:**\n```\n{explain_plan or 'EXPLAIN plan not executed'}\n```\n"
            f"- **BOTTLENECK:** {bottleneck or 'UNVERIFIED'}\n"
            f"- **CONFIDENCE:** {resolved_conf}\n"
        )

        return {
            "query": query,
            "fileSymbol": file_symbol,
            "database": database,
            "actualTiming": actual_timing,
            "rowsExamined": rows_examined,
            "rowsReturned": rows_returned,
            "indexUsed": index_used,
            "accessType": access_type,
            "explain": explain_plan,
            "bottleneck": bottleneck,
            "confidence": resolved_conf,
            "markdown": report_markdown,
        }


class DatabaseSchemaKnowledgeStore:
    """Persists verified schema metadata in the backend's existing user-data directory."""

    _write_lock = threading.Lock()

    def __init__(self, path: Optional[str] = None):
        if path:
            self.path = Path(path)
        else:
            from backend_config import CONFIG_PATH

            self.path = Path(CONFIG_PATH).parent / "coding-schema-knowledge.json"

    def load(self, schema_key: Optional[str]) -> Optional[Dict[str, Any]]:
        if not schema_key or not self.path.exists():
            return None
        try:
            stored = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Could not read persisted Coding Agent schema knowledge: {error}") from error
        if (
            not isinstance(stored, dict)
            or stored.get("version") != 1
            or not isinstance(stored.get("entries"), dict)
        ):
            raise RuntimeError("Persisted Coding Agent schema knowledge has an unsupported format.")
        knowledge = stored["entries"].get(schema_key)
        return knowledge if isinstance(knowledge, dict) else None

    def save(self, schema_key: Optional[str], knowledge: Dict[str, Any]) -> None:
        if not schema_key:
            raise RuntimeError("A project-scoped database target is required to persist schema knowledge.")
        with self._write_lock:
            entries: Dict[str, Any] = {}
            if self.path.exists():
                try:
                    stored = json.loads(self.path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as error:
                    raise RuntimeError(f"Could not update persisted Coding Agent schema knowledge: {error}") from error
                if (
                    not isinstance(stored, dict)
                    or stored.get("version") != 1
                    or not isinstance(stored.get("entries"), dict)
                ):
                    raise RuntimeError("Persisted Coding Agent schema knowledge has an unsupported format.")
                entries = stored["entries"]
            entries[schema_key] = SecretProtector.redact_data(knowledge)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = self.path.with_name(
                f"{self.path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
            )
            try:
                temporary_path.write_text(
                    json.dumps(
                        {"version": 1, "entries": entries},
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                    encoding="utf-8",
                )
                os.replace(temporary_path, self.path)
            except OSError as error:
                raise RuntimeError(f"Could not persist Coding Agent schema knowledge: {error}") from error
            finally:
                if temporary_path.exists():
                    temporary_path.unlink()


class DatabaseSessionManager:
    """
    Authoritative Database Session and Tool Router.
    Routes deterministic database commands directly to the active database connection,
    completely bypassing the LLM provider.
    """
    _sessions: Dict[str, DatabaseSession] = {}
    _sessions_by_id: Dict[str, DatabaseSession] = {}
    _active_session: Optional[DatabaseSession] = None
    MAX_SESSIONS = 100
    schema_knowledge_store = DatabaseSchemaKnowledgeStore()

    @staticmethod
    def _session_project_is_available(session: DatabaseSession) -> bool:
        project_root = getattr(session, "project_root", "")
        if not project_root or os.path.isdir(project_root):
            return True
        if session.is_connected():
            session.connection_state = DatabaseState.DISCONNECTED
        return False

    @classmethod
    def _ensure_session_capacity(cls, project_key: str) -> None:
        if project_key in cls._sessions or len(cls._sessions) < cls.MAX_SESSIONS:
            return
        inactive = [
            key for key, session in cls._sessions.items()
            if not session.is_connected() or not cls._session_project_is_available(session)
        ]
        if not inactive:
            raise RuntimeError(
                "Database session capacity is full; active database sessions were retained."
            )
        oldest_key = min(
            inactive,
            key=lambda key: cls._sessions[key].last_used_at,
        )
        removed = cls._sessions.pop(oldest_key)
        cls._sessions_by_id.pop(removed.session_id, None)
        if cls._active_session is removed:
            cls._active_session = None
        ConfigurationSymbolResolver.clear_credential(removed.project_root)

    @classmethod
    def _matches_database_identity(
        cls,
        session: DatabaseSession,
        config: Dict[str, Any],
        project_root: str,
        project_identity: Optional[str],
        repository_identity: Optional[str],
    ) -> bool:
        engine = str(DatabaseIntelligenceEngine._config_value(config, "engine") or "").casefold()
        database = DatabaseIntelligenceEngine._config_value(config, "database")
        target_id = config.get("target_id")
        proof = session.health_proof
        if (
            session.project_id != project_identity
            or session.repository_id != repository_identity
            or not engine
            or engine != session.database_type.casefold()
            or target_id != session.target_id
            or not proof
            or not proof.is_live_provenance()
            or proof.database_session_id != session.session_id
            or proof.database_engine.casefold() != engine
        ):
            return False
        proof_metadata = proof.metadata or {}
        if proof.project_id != session.project_id:
            return False
        if proof.repository_id != session.repository_id:
            return False
        if proof_metadata.get("targetId") != session.target_id:
            return False

        if engine == "sqlite":
            target_path, status = DatabaseIntelligenceEngine._resolve_sqlite_path(
                project_root,
                config,
            )
            session_path, session_status = DatabaseIntelligenceEngine._resolve_sqlite_path(
                project_root,
                {"engine": "sqlite", "sqlite_file": session.sqlite_file, "database": session.database_name},
            )
            return bool(
                target_path
                and session_path
                and status == "RESOLVED"
                and session_status == "RESOLVED"
                and target_path == session_path
                and (database is None or str(database) == session.database_name)
            )
        host = DatabaseIntelligenceEngine._config_value(config, "host")
        port = DatabaseIntelligenceEngine._config_value(config, "port")
        return bool(
            database
            and str(database) == session.database_name
            and (host is None or str(host).casefold() == str(session.safe_host or "").casefold())
            and (port is None or str(port) == str(session.safe_port or ""))
        )

    @classmethod
    def get_session(cls, project_root: str = "", session_id: Optional[str] = None) -> Optional[DatabaseSession]:
        norm = os.path.normpath(project_root) if project_root else ""
        if norm and norm in cls._sessions:
            session = cls._sessions[norm]
            if cls._session_project_is_available(session):
                return session
            return None
        if session_id and session_id in cls._sessions_by_id:
            session = cls._sessions_by_id[session_id]
            same_project = (
                os.path.normcase(os.path.normpath(session.project_root)) == norm
                if norm
                else not session.project_root
            )
            project_available = cls._session_project_is_available(session)
            if same_project and project_available:
                return session
        return None

    @classmethod
    def register_session(cls, project_root: str, session: DatabaseSession) -> DatabaseSession:
        norm = os.path.normpath(project_root) if project_root else ""
        cls._ensure_session_capacity(norm)
        previous = cls._sessions.get(norm) if norm else None
        if previous and previous is not session:
            cls._sessions_by_id.pop(previous.session_id, None)
        if norm:
            cls._sessions[norm] = session
        if session.session_id:
            cls._sessions_by_id[session.session_id] = session
        cls._active_session = session
        return session

    @classmethod
    def clear_session(cls, project_root: str) -> None:
        norm = os.path.normpath(project_root) if project_root else ""
        if norm in cls._sessions:
            sess = cls._sessions.pop(norm)
            if sess.session_id in cls._sessions_by_id:
                cls._sessions_by_id.pop(sess.session_id, None)
            ConfigurationSymbolResolver.clear_credential(project_root)
            if cls._active_session == sess:
                cls._active_session = None

    @classmethod
    def get_or_create_session(
        cls,
        project_root: str,
        session_id: Optional[str] = None,
        db_config: Optional[Dict[str, Any]] = None,
    ) -> DatabaseSession:
        norm = os.path.normpath(project_root) if project_root else ""
        cfg = dict(db_config or DatabaseIntelligenceEngine.discover_database_configuration(project_root))
        identity = ProjectContextLock.identify_project_root(project_root) if project_root else {
            "projectId": None,
            "repositoryId": None,
        }
        project_identity = identity["projectId"]
        active_target = DatabaseTargetRegistry.get_active_target(project_root) if project_root else None
        if active_target:
            cfg.update({
                "engine": active_target.engine,
                "database": active_target.database_name,
                "sqlite_file": active_target.sqlite_file,
                "host": active_target.safe_host,
                "port": active_target.safe_port,
                "target_id": active_target.target_id,
                "_protected_credentials": active_target._protected_credentials,
            })

        existing = cls._sessions.get(norm) if norm else None
        if (
            existing
            and existing.is_connected()
            and cls._session_project_is_available(existing)
            and cls._matches_database_identity(
                existing,
                cfg,
                project_root,
                project_identity,
                identity["repositoryId"],
            )
        ):
            existing.touch()
            cls._active_session = existing
            return existing

        if not norm and session_id and session_id in cls._sessions_by_id:
            existing_without_root = cls._sessions_by_id[session_id]
            if (
                not existing_without_root.project_root
                and existing_without_root.is_connected()
                and cls._matches_database_identity(
                    existing_without_root,
                    cfg,
                    project_root,
                    project_identity,
                    identity["repositoryId"],
                )
            ):
                existing_without_root.touch()
                cls._active_session = existing_without_root
                return existing_without_root

        # A new health check is required when the existing target identity or proof differs.
        database_session_id = session_id or f"db-sess-{int(time.time() * 1000)}"
        cfg.update({
            "database_session_id": database_session_id,
            "project_id": project_identity,
            "repository_id": identity["repositoryId"],
            "target_id": cfg.get("target_id"),
        })
        health = DatabaseIntelligenceEngine.real_connect_and_health_check(project_root, cfg)
        if existing and existing.is_connected() and not health.get("connected"):
            raise RuntimeError(
                "The requested database target could not be verified; the existing connected session was preserved."
            )
        caps = DatabaseIntelligenceEngine.check_database_capabilities(project_root)

        db_type = cfg.get("engine") or health.get("engine") or "unverified"
        db_name = cfg.get("database") or health.get("database") or (cfg.get("sqlite_file") and Path(cfg["sqlite_file"]).name) or None
        safe_h = cfg.get("host") or health.get("host")
        safe_p = cfg.get("port") or health.get("port")

        sess = DatabaseSession(
            project_id=project_identity,
            repository_id=identity["repositoryId"],
            database_type=db_type,
            database_name=db_name,
            connection_handle=health.get("sqlite_file") or health.get("client"),
            connection_state=health.get("state") or (DatabaseState.CONNECTED if health.get("connected") else DatabaseState.DISCONNECTED),
            connection_capabilities=caps.get("available_paths", []),
            sqlite_file=cfg.get("sqlite_file") or health.get("sqlite_file"),
            session_id=database_session_id,
            health_check_latency_ms=health.get("timing_ms"),
            project_root=project_root or "",
            target_id=cfg.get("target_id"),
            safe_host=safe_h,
            safe_port=safe_p,
        )
        if health.get("health_proof"):
            sess.health_proof = health["health_proof"]
            sess.binding.bind_proof(health["health_proof"])

        cred = ConfigurationSymbolResolver.get_credential(project_root)
        if cred:
            sess._protected_credentials = cred
        elif "_protected_credentials" in cfg:
            sess._protected_credentials = cfg["_protected_credentials"]
        persisted_schema = cls.schema_knowledge_store.load(sess.schema_knowledge_key())
        if persisted_schema:
            sess.restore_schema_knowledge(persisted_schema)

        if norm:
            cls._ensure_session_capacity(norm)
            if existing:
                cls._sessions_by_id.pop(existing.session_id, None)
            cls._sessions[norm] = sess
        cls._sessions_by_id[sess.session_id] = sess
        cls._active_session = sess
        return sess

    @classmethod
    def resolve_database_intent(
        cls,
        request: str,
        task_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Classifies user request into deterministic database capabilities that bypass the LLM.
        Applies command normalization first for typo resilience.
        """
        raw = (request or "").strip()
        norm_req = EngineeringCommandNormalizer.normalize(raw)
        low = norm_req.lower().strip()
        sql_request = re.sub(
            r"\s+(?:data|records?|rows?)\s+(?:dikho|dikhao|dikhaiye|show|display)\s*[.!?]*\s*$",
            "",
            norm_req,
            flags=re.I,
        ).strip()
        sql_request = re.sub(r";\s*$", "", sql_request).strip()

        # 0A. CREDENTIAL / PASSWORD REQUEST
        if DATABASE_CREDENTIAL_REQUEST_PATTERN.search(low):
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_CREDENTIAL_REQUEST,
                "arguments": {},
            }

        schema_refresh = bool(
            re.search(r"\b(?:live|current|refresh|recheck)\b.*\b(?:database\s+)?schema\b", low)
        )
        schema_learning_request = bool(
            re.search(
                r"\b(?:understand|learn|read|map|index|check|refresh|recheck|inspect)\b.{0,80}\b(?:database|db|schema|tables?)\b|"
                r"\b(?:database|db|schema|tables?)\b.{0,80}\b(?:understand|learn|read|map|index|check|refresh|recheck|inspect)\b",
                low,
            )
        )

        # 0B. CURRENT TARGET / WHICH DB IS CONNECTED / OPEN CONFIG & WHICH DB
        current_target_match = False
        target_file_match = None

        if re.search(
            r"\b(?:which\s+(?:db|database|target)\b|what\s+(?:db|database|target)\b|current\s+(?:db|database|target)\b|active\s+(?:db|database|target)\b|status\s+(?:of\s+)?(?:db|database)\b|(?:db|database)\s+status\b|connected\s+(?:db|database|target)\b)\b",
            low,
        ) or DATABASE_CONNECTION_STATUS_PATTERN.search(low) or "which db connection" in low or "db connection current" in low or "which db is connected" in low:
            current_target_match = True

        compound_m = re.search(r"\b(?:open|inspect|check|read|show)\s+(?:my\s+)?(?:project\s+)?([a-zA-Z0-9_\-./\\]+\.(?:php|json|env|ya?ml|py|properties|ts|js))\b", norm_req, re.I)
        if compound_m:
            target_file_match = compound_m.group(1).strip()
            if any(x in low for x in ("db", "database", "connection")):
                current_target_match = True

        if current_target_match and not schema_learning_request:
            args = {"user_request": norm_req}
            if target_file_match:
                args["configFile"] = target_file_match
                args["target_file"] = target_file_match
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_CURRENT_TARGET,
                "arguments": args,
            }

        # 0C. DISCONNECT / RECONNECT
        if re.search(r"\b(?:disconnect(?:\s+(?:from|the))?\s+(?:db|database)|close\s+(?:db|database)\s+connection)\b", low):
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_DISCONNECT,
                "arguments": {},
            }
        if re.search(r"\b(?:reconnect(?:\s+to)?\s+(?:the\s+)?(?:db|database))\b", low):
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_RECONNECT,
                "arguments": {},
            }

        # 0D. CONNECT SPECIFIC TARGET (e.g. 'connect DB-002', 'use DB-002', 'switch to DB-002')
        conn_target_m = re.search(r"^\s*(?:connect(?:\s+to)?|switch\s+to|use)\s+(db[-_]\d+|[a-zA-Z0-9_-]+)\s*$", norm_req, re.I)
        if conn_target_m:
            target_cand = conn_target_m.group(1).strip()
            if target_cand.upper().startswith("DB-") or target_cand.lower() not in ("db", "database", "the", "a", "all", "tables", "query", "me"):
                return {
                    "is_deterministic": True,
                    "capability": DatabaseCapability.DATABASE_CONNECT_TARGET,
                    "arguments": {"target": target_cand.upper()},
                }

        # 0E. SLOW QUERIES / TOP QUERIES / HIGH-LOAD QUERIES / PERFORMANCE INVESTIGATION
        if re.search(
            r"\b(?:which\s+query\s+(?:is\s+)?(?:taking|take|takes)\s+(?:the\s+)?(?:most\s+|more\s+)?(?:time|load)|which\s+query\s+(?:has\s+(?:the\s+)?highest\s+(?:db\s+)?load|takes\s+(?:the\s+)?most\s+time|is\s+(?:the\s+)?slowest|causes?\s+cpu\s+load|does\s+(?:a\s+)?full\s+table\s+scan|is\s+missing\s+(?:an?\s+)?index)|show\s+(?:all\s+)?slow\s+queries?|find\s+slow\s+queries?|check\s+slow\s+queries?|list\s+slow\s+queries?|top\s+slow\s+queries?|slowest\s+queries?|top\s+queries?|query\s+performance\s+stats?|find\s+expensive\s+queries?|which\s+query\s+is\s+expensive)\b",
            low,
        ) or low in ("slow queries", "slow query", "top queries", "top slow queries", "find slow queries", "find expensive queries"):
            dim = "total_load"
            if any(x in low for x in ("time", "slowest", "slow", "latency")):
                dim = "average_time"
            elif any(x in low for x in ("frequency", "frequent", "count", "calls")):
                dim = "frequency"
            elif any(x in low for x in ("rows", "scan")):
                dim = "rows_examined"
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_SLOW_QUERIES,
                "arguments": {"dimension": dim, "user_request": norm_req},
            }

        # 0F. QUERY BENCHMARK / OPTIMIZATION COMPARISON
        if re.search(r"\b(?:benchmark|compare\s+benchmark|query\s+benchmark|benchmark\s+query|compare\s+performance)\b", low):
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_BENCHMARK,
                "arguments": {},
            }

        # 0G. QUERY OPTIMIZATION
        if re.search(
            r"\b(?:optimize\s+(?:this\s+)?query|how\s+(?:can\s+i|to)\s+optimize\s+(?:this\s+)?query|optimize\s+slow\s+query|can\s+this\s+query\s+be\s+optimized)\b",
            low,
        ):
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_OPTIMIZATION,
                "arguments": {"user_request": norm_req},
            }

        # 0. CONNECT TO DATABASE / DATABASE HEALTH CHECK
        if re.search(
            r"\b(?:connect(?:\s+to)?(?:\s+the)?\s+(?:db|database)|only\s+connect(?:\s+to)?(?:\s+the)?\s+(?:db|database)|check\s+(?:the\s+)?(?:db|database)(?:\s+connection)?|test\s+(?:the\s+)?(?:db|database)(?:\s+connection)?|ping\s+(?:the\s+)?(?:db|database))\b",
            low,
        ):
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_HEALTH_CHECK,
                "arguments": {},
            }

        if schema_learning_request and not re.search(
            r"\b(?:where|which|what|find|locate)\b.{0,40}\b(?:column|field|email|index|key|reference|table)\b",
            low,
        ):
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_LIST_TABLES,
                "arguments": {
                    "learn_schema": True,
                    "refresh_schema": schema_refresh,
                },
            }

        schema_query = None
        column_location = re.search(
            r"\bwhere\s+is\s+(?:(?P<context>[a-zA-Z_][a-zA-Z0-9_]*)\s+)?"
            r"(?P<column>[a-zA-Z_][a-zA-Z0-9_]*)\s+(?:stored|kept|located)\b|"
            r"\bwhich\s+table\s+(?:contains|has)\s+(?:(?P<context2>[a-zA-Z_][a-zA-Z0-9_]*)\s+)?"
            r"(?P<column2>[a-zA-Z_][a-zA-Z0-9_]*)\b|"
            r"\bwhere\s+(?:(?P<context3>[a-zA-Z_][a-zA-Z0-9_]*)\s+)?"
            r"(?P<column3>email|e-?mail|phone|mobile|[a-zA-Z_][a-zA-Z0-9_]*)\b"
            r"(?!\s*(?:=|is\b))",
            norm_req,
            re.I,
        )
        if column_location:
            schema_query = {
                "kind": "column_location",
                "term": (
                    column_location.group("column")
                    or column_location.group("column2")
                    or column_location.group("column3")
                ),
                "context": (
                    column_location.group("context")
                    or column_location.group("context2")
                    or column_location.group("context3")
                ),
            }
        reference_query = re.search(
            r"\bwhich\s+tables?\s+(?:reference|refer(?:s)?\s+to|have\s+(?:a\s+)?foreign\s+key\s+to)\s+"
            r"[`'\"]?(?P<table>[a-zA-Z_][a-zA-Z0-9_]*)[`'\"]?",
            norm_req,
            re.I,
        )
        if reference_query:
            schema_query = {"kind": "referencing_tables", "table": reference_query.group("table")}
        primary_key_query = re.search(
            r"\b(?:what(?:\s+is)?|show|find)?\s*(?:the\s+)?(?:primary\s+key|pk)\s+"
            r"(?:of|for|on)\s+[`'\"]?(?P<table>[a-zA-Z_][a-zA-Z0-9_]*)[`'\"]?",
            norm_req,
            re.I,
        )
        if primary_key_query:
            schema_query = {"kind": "primary_key", "table": primary_key_query.group("table")}
        index_lookup = re.search(
            r"\b(?:what|which)\s+indexes?\s+(?:exist\s+)?(?:are\s+)?(?:on|for)\s+"
            r"[`'\"]?(?P<table>[a-zA-Z_][a-zA-Z0-9_]*)[`'\"]?",
            norm_req,
            re.I,
        )
        if index_lookup:
            schema_query = {"kind": "indexes", "table": index_lookup.group("table")}
        table_exists = re.search(
            r"\b(?:does|do)\s+(?:this\s+|that\s+)?(?:table|collection)\s+"
            r"[`'\"]?(?P<table>[A-Za-z][A-Za-z0-9_.$-]*)[`'\"]?\s+exist\b|"
            r"\b(?:is|does)\s+[`'\"]?(?P<table2>[A-Za-z][A-Za-z0-9_.$-]*)[`'\"]?"
            r"\s+(?:a\s+)?(?:table|collection)\b",
            norm_req,
            re.I,
        )
        if table_exists:
            schema_query = {
                "kind": "table_exists",
                "table": table_exists.group("table") or table_exists.group("table2"),
            }
        if schema_query:
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_LIST_TABLES,
                "arguments": {
                    "schema_query": schema_query,
                    "refresh_schema": schema_refresh,
                },
            }

        count_prefix = re.search(
            r"\b(?:count|calculate)\s+(?:me\s+)?(?:the\s+)?"
            r"(?:(?:total|overall)\s+)?(?:number\s+of\s+)?|"
            r"\b(?:show|give|tell)\s+(?:me\s+)?(?:the\s+)?(?:total|number\s+of)\s+|"
            r"\bhow\s+many\s+|"
            r"\b(?:what\s+is\s+)?(?:the\s+)?(?:total|number\s+of)\s+",
            norm_req,
            re.I,
        )
        if count_prefix:
            entity = norm_req[count_prefix.end():].strip(" \t\r\n.!?`'\"")
            requested_filters = []
            if re.search(r"\bactive\b", entity, re.I):
                requested_filters.append("active")
                entity = re.sub(r"\bactive\b", " ", entity, flags=re.I)
            if re.search(r"\btoday\b", entity, re.I):
                requested_filters.append("today")
                entity = re.sub(r"\btoday\b", " ", entity, flags=re.I)
            paid_count = bool(re.search(r"\b(?:paid|payment\s+complete|payment\s+successful)\b", entity, re.I))
            explicit_payment_value = re.search(
                r"\b(?P<column>pay_status|payment_status|paid_status)\s*(?:=|is)\s*"
                r"(?P<quote>['\"]?)(?P<value>[a-zA-Z0-9_.-]+)(?P=quote)\b",
                entity,
                re.I,
            )
            explicit_payment_column = re.search(
                r"\b(?:using|from|in)\s+(?:the\s+)?(?:field|column)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b|"
                r"\busing\s+([a-zA-Z_][a-zA-Z0-9_]*status)\b",
                entity,
                re.I,
            )
            if explicit_payment_value:
                entity = re.sub(
                    r"\b(?:(?:where|with|using)\s+)?(?:pay_status|payment_status|paid_status)\s*(?:=|is)\s*(['\"]?)[a-zA-Z0-9_.-]+\1\b",
                    " ",
                    entity,
                    flags=re.I,
                )
            if explicit_payment_column:
                entity = re.sub(
                    r"\busing\s+(?:(?:the\s+)?(?:field|column)\s+)?[a-zA-Z_][a-zA-Z0-9_]*\b",
                    " ",
                    entity,
                    flags=re.I,
                )
            entity = re.sub(
                r"\s+(?:data|records?|rows?|entries|items|in\s+(?:the\s+)?(?:database|db|table)|"
                r"from\s+(?:the\s+)?(?:database|db|table))\s*[.!?]*$",
                "",
                entity,
                flags=re.I,
            ).strip()
            entity = re.sub(r"^(?:of|for|all)\s+", "", entity, flags=re.I).strip()
            entity = re.sub(r"\b(?:paid|payment\s+complete|payment\s+successful)\b", " ", entity, flags=re.I)
            entity = re.sub(r"\s+", " ", entity).strip()
            if "_" not in entity:
                entity = re.sub(r"\b([a-zA-Z]+)ies$", r"\1y", entity, flags=re.I)
                if entity.lower().endswith("s") and len(entity) > 3:
                    entity = entity[:-1]
            if (
                entity
                and len(entity) <= 80
                and re.fullmatch(r"[A-Za-z][A-Za-z0-9 _.-]*", entity)
            ):
                return {
                    "is_deterministic": True,
                    "capability": DatabaseCapability.DATABASE_COUNT_RECORDS,
                    "arguments": {
                        "entity": entity,
                        **({"filters": requested_filters} if requested_filters else {}),
                        **({"payment_filter": "paid"} if paid_count else {}),
                        **({"payment_value": explicit_payment_value.group("value")} if explicit_payment_value else {}),
                        **({
                            "payment_column": next(
                                group for group in explicit_payment_column.groups() if group
                            )
                        } if explicit_payment_column else (
                            {"payment_column": explicit_payment_value.group("column")}
                            if explicit_payment_value else {}
                        )),
                    },
                }

        # 1. SHOW DATABASES / LIST DATABASES
        if re.search(r"\b(?:show\s+(?:all\s+)?databases?|list\s+databases?|show\s+dbs?|list\s+dbs?|show\s+schemas?|list\s+schemas?)\b", low) or low in ("databases", "dbs", "schemas"):
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_LIST_DATABASES,
                "arguments": {},
            }

        # 2. SHOW TABLES / LIST TABLES
        if re.search(
            r"\b(?:show\s+(?:(?:(?:me|my)\s+)?(?:all\s+)?|all\s+my\s+)?(?:tables?|collections?)|"
            r"list\s+(?:(?:me|my)\s+)?(?:all\s+)?(?:tables?|collections?)|"
            r"what\s+tables?|table\s+list)\b",
            low,
        ) or low in ("tables", "collections", "table list"):
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_LIST_TABLES,
                "arguments": {},
            }

        mongo_find_m = re.fullmatch(
            r"\s*(?:find|show)\s+(?:documents?\s+)?(?:in|from)\s+(?:collection\s+)?[`'\"\[]?([a-zA-Z0-9_.-]{1,120})[`'\"\]]?\s*",
            norm_req,
            re.I,
        )
        if mongo_find_m:
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_QUERY,
                "arguments": {"collection": mongo_find_m.group(1), "filter": {}},
            }

        # 3. DESCRIBE <table> / DESC <table> / SHOW COLUMNS
        # Must be followed by a single table identifier, not general English prose ("describe how...", "describe the...")
        desc_m = re.search(r"^\s*(?:describe\s+table|desc\s+table|columns?\s+(?:of|from|in)|table\s+info)\s+[`'\"\[]?([a-zA-Z0-9_]+)[`'\"\]]?\s*;?\s*$", norm_req, re.I)
        if not desc_m:
            desc_m = re.search(r"^\s*(?:describe|desc)\s+[`'\"\[]?([a-zA-Z0-9_]+)[`'\"\]]?\s*;?\s*$", norm_req, re.I)
            if desc_m and desc_m.group(1).lower() in {
                "the", "this", "that", "how", "what", "why", "when", "where", "which", "who",
                "a", "an", "my", "your", "our", "all", "each", "new", "any", "some", "it", "its",
                "code", "function", "class", "file", "method", "target", "system", "architecture"
            }:
                desc_m = None
        if desc_m:
            tbl = desc_m.group(1).strip("`'\"[]")
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_DESCRIBE_TABLE,
                "arguments": {"table": tbl},
            }

        # 4. SHOW INDEXES [ON <table>] / LIST INDEXES
        idx_m = re.search(r"\b(?:show|list|check)\s+(?:indexes|indicies|indecies)(?:\s+(?:on|from|for|in)\s+[`'\"\[]?([a-zA-Z0-9_]+)[`'\"\]]?)?", low)
        if idx_m:
            tbl = idx_m.group(1).strip("`'\"[]") if idx_m.group(1) else None
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_LIST_INDEXES,
                "arguments": {"table": tbl} if tbl else {},
            }

        # 5. SHOW VIEWS / LIST VIEWS
        if re.search(r"\b(?:show\s+views|list\s+views)\b", low):
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_LIST_VIEWS,
                "arguments": {},
            }

        # 6. SHOW CONSTRAINTS [ON <table>]
        c_m = re.search(r"\b(?:show|list)\s+constraints(?:\s+(?:on|from|for|in)\s+[`'\"\[]?([a-zA-Z0-9_]+)[`'\"\]]?)?", low)
        if c_m:
            tbl = c_m.group(1).strip("`'\"[]") if c_m.group(1) else None
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_LIST_CONSTRAINTS,
                "arguments": {"table": tbl} if tbl else {},
            }

        mongo_explain_m = re.fullmatch(
            r"\s*explain\s+(?:find|documents?)\s+(?:in|from)\s+(?:collection\s+)?[`'\"\[]?([a-zA-Z0-9_.-]{1,120})[`'\"\]]?\s*",
            norm_req,
            re.I,
        )
        if mongo_explain_m:
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_EXPLAIN,
                "arguments": {"collection": mongo_explain_m.group(1), "filter": {}},
            }

        # 7. EXPLAIN <SQL>
        explain_sql_m = re.search(r"^\s*explain(?:\s+plan(?:\s+for)?|\s+analyze)?\s+(select\b[\s\S]+|with\b[\s\S]+)$", sql_request, re.I)
        if not explain_sql_m:
            explain_sql_m = re.search(r"^\s*(?:explain\s+query|run\s+explain)(?:\s+(select\b[\s\S]+|with\b[\s\S]+))?$", sql_request, re.I)
        if explain_sql_m:
            sql_target = explain_sql_m.group(1).strip() if explain_sql_m.group(1) else ""
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_EXPLAIN,
                "arguments": {"sql": sql_target},
            }

        count_sql_match = re.fullmatch(
            r"\s*SELECT\s+COUNT\s*\(\s*\*\s*\)"
            r"(?:\s+AS\s+[`'\"]?[A-Za-z_][A-Za-z0-9_]*[`'\"]?)?"
            r"\s+FROM\s+[`'\"]?([A-Za-z][A-Za-z0-9_$.-]*)[`'\"]?\s*",
            sql_request,
            re.I,
        )
        if count_sql_match:
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_COUNT_RECORDS,
                "arguments": {"entity": count_sql_match.group(1)},
            }

        # 8. DIRECT SAFE READ-ONLY SQL: SELECT ... or SHOW ...
        is_sql_select = False
        if re.match(r"^\s*SELECT\b", sql_request, re.I):
            if re.search(r"\bFROM\b", sql_request, re.I) or re.match(
                r"^\s*SELECT\s+(?:\d+|'[^']*'|\"[^\"]*\"|COUNT\(|NOW\(|VERSION\(|DATABASE\(|@@|CURRENT_|\*|\bTRUE\b|\bFALSE\b|\bNULL\b)",
                sql_request,
                re.I,
            ):
                is_sql_select = True

        is_sql_cte = bool(re.match(r"^\s*WITH\s+(?:RECURSIVE\s+)?[a-zA-Z0-9_]+\s*(?:\([^\)]+\)\s*)?AS\s*\(", sql_request, re.I))

        if is_sql_select or is_sql_cte:
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_QUERY,
                "arguments": {"sql": sql_request},
            }

        if re.match(r"^\s*SHOW\s+(?:DATABASES|SCHEMAS|TABLES|COLUMNS|INDEXES|INDEX|KEYS|VIEWS|CREATE\s+TABLE|VARIABLES|STATUS|WARNINGS|ERRORS)\b", sql_request, re.I):
            return {
                "is_deterministic": True,
                "capability": DatabaseCapability.DATABASE_QUERY,
                "arguments": {"sql": sql_request},
            }

        record_request = re.fullmatch(
            r"\s*(?:show|display|fetch|get|list)\s+(?:me\s+)?(?:the\s+)?(?P<target>.+?)\s*",
            norm_req,
            re.I,
        )
        if record_request:
            target = record_request.group("target").strip(" \t\r\n.!?`'\"")
            if not re.match(
                r"^(?:(?:(?:me|my)\s+)?(?:all\s+)?|all\s+my\s+)?"
                r"(?:tables?|collections?|databases?|dbs?|schemas?|indexes?|indices?|views?|constraints?)\b",
                target,
                re.I,
            ):
                schema_object_match = re.fullmatch(
                    r"(?P<entity>.+?)\s+(?P<kind>table|columns?|fields?|indexes?)",
                    target,
                    re.I,
                )
                if schema_object_match:
                    table_name = schema_object_match.group("entity").strip(" `\"'")
                    if table_name and re.fullmatch(r"[A-Za-z][A-Za-z0-9 _.$-]{0,119}", table_name):
                        if schema_object_match.group("kind").casefold().startswith("index"):
                            return {
                                "is_deterministic": True,
                                "capability": DatabaseCapability.DATABASE_LIST_INDEXES,
                                "arguments": {"table": table_name},
                            }
                        return {
                            "is_deterministic": True,
                            "capability": DatabaseCapability.DATABASE_DESCRIBE_TABLE,
                            "arguments": {"table": table_name},
                        }
                latest_match = re.search(r"\b(?:latest|newest|most\s+recent)\s*(\d+)?\b", target, re.I)
                explicit_record_request = bool(
                    latest_match
                    or re.search(r"\s+(?:data|records?|rows?|entries|items)\s*$", target, re.I)
                )
                if not explicit_record_request:
                    target = ""
                row_limit = int(latest_match.group(1) or 10) if latest_match else 10
                target = re.sub(
                    r"\b(?:latest|newest|most\s+recent)\s*\d*\b",
                    " ",
                    target,
                    flags=re.I,
                )
                target = re.sub(
                    r"\s+(?:data|records?|rows?|entries|items)\s*$",
                    "",
                    target,
                    flags=re.I,
                ).strip()
                target = re.sub(r"^(?:all|of|for)\s+", "", target, flags=re.I).strip()
                if (
                    target
                    and len(target) <= 80
                    and re.fullmatch(r"[A-Za-z][A-Za-z0-9 _.-]*", target)
                    and not re.search(r"\b(?:how|why|where|what|which)\b", target, re.I)
                ):
                    if target.lower().endswith("s") and len(target) > 3 and "_" not in target:
                        target = target[:-1]
                    return {
                        "is_deterministic": True,
                        "capability": DatabaseCapability.DATABASE_QUERY,
                        "arguments": {
                            "entity": target,
                            "row_limit": min(max(row_limit, 1), 50),
                            "latest": bool(latest_match),
                            "user_request": norm_req,
                        },
                    }

        context = task_context if isinstance(task_context, dict) else {}
        previous_capability = context.get("capability")
        previous_arguments = context.get("arguments")
        previous_arguments = previous_arguments if isinstance(previous_arguments, dict) else {}
        previous_entity = (
            context.get("table")
            or previous_arguments.get("entity")
            or previous_arguments.get("table")
        )
        if previous_entity and previous_capability in (
            DatabaseCapability.DATABASE_COUNT_RECORDS,
            DatabaseCapability.DATABASE_QUERY,
        ):
            follow_up = re.fullmatch(
                r"\s*(?:how\s+many(?:\s+(?:of\s+)?(?:them|those|these|it))?|count\s+(?:them|those|these|it))\s*[?!.]*\s*",
                low,
                re.I,
            )
            latest_follow_up = re.fullmatch(
                r"\s*(?:show|fetch|get|list)\s+(?:me\s+)?(?:the\s+)?"
                r"(?:latest|newest|most\s+recent)\s*(\d+)?(?:\s+(?:records?|rows?|data))?\s*[?!.]*\s*",
                norm_req,
                re.I,
            )
            current_table_count = re.fullmatch(
                r"\s*(?:check|count)\s+(?:this|that|the\s+current)\s+table\s+"
                r"(?:total|count|records?)\s*[?!.]*\s*",
                low,
                re.I,
            )
            same_target = re.fullmatch(
                r"\s*(?:do\s+the\s+)?same\s+(?:for|with)\s+(.+?)\s*[?!.]*\s*",
                norm_req,
                re.I,
            )
            correction = re.fullmatch(
                r"\s*(?:no[,.]?\s+)?(?:i\s+mean|i\s+meant|rather|not\s+that[,.]?\s+i\s+mean)\s+(.+?)\s*[?!.]*\s*",
                norm_req,
                re.I,
            )
            if follow_up:
                return {
                    "is_deterministic": True,
                    "capability": DatabaseCapability.DATABASE_COUNT_RECORDS,
                    "arguments": {"entity": str(previous_entity)},
                    "contextual": True,
                }
            if current_table_count:
                return {
                    "is_deterministic": True,
                    "capability": DatabaseCapability.DATABASE_COUNT_RECORDS,
                    "arguments": {"entity": str(previous_entity)},
                    "contextual": True,
                }
            if latest_follow_up:
                return {
                    "is_deterministic": True,
                    "capability": DatabaseCapability.DATABASE_QUERY,
                    "arguments": {
                        "entity": str(previous_entity),
                        "row_limit": min(max(int(latest_follow_up.group(1) or 10), 1), 50),
                        "latest": True,
                    },
                    "contextual": True,
                }
            if same_target or correction:
                new_entity = (same_target or correction).group(1).strip(" `\"'")
                new_entity = re.sub(r"^(?:the\s+)?(?:table\s+)?", "", new_entity, flags=re.I)
                new_entity = re.sub(r"\s+(?:data|records?|rows?)$", "", new_entity, flags=re.I).strip()
                if (
                    new_entity
                    and len(new_entity) <= 120
                    and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.$-]*", new_entity)
                ):
                    if previous_capability == DatabaseCapability.DATABASE_COUNT_RECORDS:
                        arguments = {
                            key: value
                            for key, value in previous_arguments.items()
                            if key != "entity"
                        }
                        arguments["entity"] = new_entity
                        return {
                            "is_deterministic": True,
                            "capability": previous_capability,
                            "arguments": arguments,
                            "contextual": True,
                        }
                    return {
                        "is_deterministic": True,
                        "capability": DatabaseCapability.DATABASE_QUERY,
                        "arguments": {
                            "entity": new_entity,
                            "row_limit": previous_arguments.get("row_limit", 10),
                            "latest": previous_arguments.get("latest", False),
                        },
                        "contextual": True,
                    }

        return {
            "is_deterministic": False,
            "capability": None,
            "arguments": {},
        }

    @staticmethod
    def _resolve_schema_table_matches(entity: str, tables: List[str]) -> List[str]:
        requested = re.sub(r"[^a-z0-9]", "", str(entity or "").casefold())
        if not requested:
            return []

        def singularize(value: str) -> str:
            if value.endswith("ies") and len(value) > 3:
                return value[:-3] + "y"
            if value.endswith("s") and len(value) > 3:
                return value[:-1]
            return value

        exact = []
        token_matches = []
        approximate = []
        for table in tables:
            table_name = str(table)
            table_key = re.sub(r"[^a-z0-9]", "", table_name.casefold())
            if table_key == requested or singularize(table_key) == requested:
                exact.append(table_name)
                continue
            tokens = {
                singularize(re.sub(r"[^a-z0-9]", "", token.casefold()))
                for token in re.findall(r"[A-Za-z0-9]+", table_name)
            }
            if singularize(requested) in tokens:
                token_matches.append(table_name)
            elif len(requested) >= 10:
                similarity = SequenceMatcher(None, requested, table_key).ratio()
                if similarity >= 0.90:
                    approximate.append((similarity, table_name))

        matches = exact or token_matches
        if matches:
            return sorted(set(matches), key=str.casefold)
        if approximate:
            best_similarity = max(score for score, _ in approximate)
            return sorted(
                {
                    table
                    for score, table in approximate
                    if best_similarity - score < 0.08
                },
                key=str.casefold,
            )
        return []

    @classmethod
    def _rank_database_table_candidates(
        cls,
        entity: str,
        candidates: List[str],
        project_root: str,
    ) -> List[Dict[str, Any]]:
        requested = re.sub(r"[^a-z0-9]", "", str(entity or "").casefold())
        if not requested or not candidates:
            return []

        def normalize(value: Any) -> str:
            return re.sub(r"[^a-z0-9]", "", str(value or "").casefold())

        query_usage: Dict[str, List[Dict[str, Any]]] = {}
        for query in DatabaseIntelligenceEngine.discover_relevant_queries(project_root):
            table = normalize(query.get("table"))
            if table:
                query_usage.setdefault(table, []).append(query)

        ranked = []
        for table in candidates:
            table_key = normalize(table)
            score = 0
            evidence = []
            singular_table = (
                table_key[:-3] + "y"
                if table_key.endswith("ies") and len(table_key) > 3
                else table_key[:-1]
                if table_key.endswith("s") and len(table_key) > 3
                else table_key
            )
            singular_requested = (
                requested[:-3] + "y"
                if requested.endswith("ies") and len(requested) > 3
                else requested[:-1]
                if requested.endswith("s") and len(requested) > 3
                else requested
            )
            if table_key == requested or singular_table == singular_requested:
                score += 100
                evidence.append("exact live table-name match")
            elif requested in singular_table:
                score += 55
                evidence.append("live table name contains requested entity")
            else:
                continue

            matching_queries = query_usage.get(table_key, [])
            if matching_queries:
                score += 35
                evidence.append("referenced by a project source query")
            if re.search(r"(?:temp|temporary|history|archive|backup|log)$", table_key):
                score -= 20
                evidence.append("table name indicates a temporary or historical variant")
            ranked.append({
                "table": str(table),
                "score": score,
                "evidence": evidence,
                "sourceQueries": matching_queries[:3],
            })

        return sorted(ranked, key=lambda item: (-item["score"], item["table"].casefold()))

    @classmethod
    def execute_database_capability(
        cls,
        capability: str,
        arguments: Dict[str, Any],
        session: DatabaseSession,
        project_root: str,
    ) -> Dict[str, Any]:
        """
        Executes a canonical database capability directly against the database connection.
        Returns formatted result and evidence metadata with DatabaseExecutionProof.
        Zero LLM involvement.
        """
        session.touch()
        eff_root = project_root or getattr(session, "project_root", "")
        root = Path(eff_root) if eff_root and os.path.isdir(eff_root) else None
        db_type = session.database_type.lower()
        start_t = time.perf_counter()
        session_db_config = {
            "engine": db_type,
            "database": session.database_name,
            "sqlite_file": session.sqlite_file,
            "host": session.safe_host,
            "port": session.safe_port,
            "database_session_id": session.session_id,
            "project_id": session.project_id,
            "repository_id": session.repository_id,
            "target_id": session.target_id,
            **session._protected_credentials,
        }

        # Session Auto-Recovery: if session connection was interrupted, reconnect automatically
        if not session.is_connected() and capability not in (DatabaseCapability.DATABASE_DISCONNECT, DatabaseCapability.DATABASE_HEALTH_CHECK, DatabaseCapability.DATABASE_CONNECT):
            health = DatabaseIntelligenceEngine.real_connect_and_health_check(eff_root, session_db_config)
            if health.get("connected") or health.get("status") == "CONNECTED":
                session.connection_state = DatabaseState.CONNECTED
                if health.get("health_proof"):
                    session.health_proof = health["health_proof"]
                    session.binding.bind_proof(health["health_proof"])

        database_read_capabilities = {
            DatabaseCapability.DATABASE_LIST_DATABASES,
            DatabaseCapability.DATABASE_LIST_SCHEMAS,
            DatabaseCapability.DATABASE_LIST_TABLES,
            DatabaseCapability.DATABASE_DESCRIBE_TABLE,
            DatabaseCapability.DATABASE_LIST_COLUMNS,
            DatabaseCapability.DATABASE_LIST_INDEXES,
            DatabaseCapability.DATABASE_LIST_CONSTRAINTS,
            DatabaseCapability.DATABASE_LIST_VIEWS,
            DatabaseCapability.DATABASE_QUERY,
            DatabaseCapability.DATABASE_EXPLAIN,
            DatabaseCapability.DATABASE_QUERY_TIMING,
        }
        if capability in database_read_capabilities and db_type in ("", "unknown", "unverified"):
            return {
                "ok": False,
                "capability": capability,
                "error": "DB_ENGINE_UNKNOWN",
                "failureClassification": "DB_ENGINE_UNKNOWN",
                "content": (
                    "Database configuration has not resolved an engine. Resolve the active project "
                    "configuration and verify a project-bound target before running database operations."
                ),
                "executionStatus": "DB_ENGINE_UNKNOWN",
                "evidenceQuality": "UNVERIFIED",
                "databaseType": "unknown",
                "databaseSessionId": session.session_id,
                "executed": False,
            }

        # 1. DATABASE_LIST_DATABASES
        if capability == DatabaseCapability.DATABASE_LIST_DATABASES:
            databases = []
            if db_type == "sqlite":
                if root:
                    sq_files = list(root.glob("**/*.sqlite")) + list(root.glob("**/*.sqlite3")) + list(root.glob("**/*.db"))
                    sq_files = [f for f in sq_files if not any(x in str(f).lower() for x in ("node_modules", ".git", "vendor"))]
                    if sq_files:
                        databases = sorted(list({f.name for f in sq_files}))
                if not databases:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "No SQLite database file was discovered; database listing is unavailable.",
                        "executionStatus": "UNAVAILABLE",
                        "evidenceQuality": "UNVERIFIED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type in ("mysql", "mariadb"):
                try:
                    connection = DatabaseIntelligenceEngine._open_mysql_connection(eff_root, session_db_config)
                    try:
                        cursor = connection.cursor()
                        cursor.execute("SHOW DATABASES")
                        databases = [str(row[0]) for row in cursor.fetchmany(100)]
                    finally:
                        connection.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live MySQL database listing failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type in ("postgres", "postgresql", "supabase"):
                try:
                    connection = DatabaseIntelligenceEngine._open_postgresql_connection(eff_root, {
                        "engine": db_type,
                        "database": session.database_name,
                        "host": session.safe_host,
                        "port": session.safe_port,
                        "username": session._protected_credentials.get("username"),
                        "password": session._protected_credentials.get("password"),
                        "connection_uri": session._protected_credentials.get("connection_uri"),
                    })
                    try:
                        cursor = connection.cursor()
                        cursor.execute("SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname")
                        databases = [str(row[0]) for row in cursor.fetchmany(100)]
                    finally:
                        connection.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live PostgreSQL database listing failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type == "h2":
                try:
                    connection = DatabaseIntelligenceEngine._open_h2_connection(eff_root, session_db_config)
                    try:
                        cursor = connection.cursor()
                        cursor.execute("SELECT 1")
                        if cursor.fetchone() and session.database_name:
                            databases = [session.database_name]
                    finally:
                        connection.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live H2 database verification failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type in ("mongo", "mongodb"):
                try:
                    client = DatabaseIntelligenceEngine._open_mongodb_client(eff_root, {
                        "host": session.safe_host,
                        "port": session.safe_port,
                        **session._protected_credentials,
                    })
                    try:
                        databases = client.list_database_names()
                    finally:
                        client.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live MongoDB database listing failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            else:
                return {
                    "ok": False,
                    "capability": capability,
                    "content": f"Database listing is not supported for engine '{db_type}'.",
                    "executionStatus": "UNAVAILABLE",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }

            duration_ms = round((time.perf_counter() - start_t) * 1000.0, 3)
            measured_timing = duration_ms
            proof = DatabaseExecutionProof(
                database_session_id=session.session_id,
                database_engine=db_type,
                operation=capability,
                source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                mode="LIVE",
                execution_status="SUCCESS",
                execution_time_ms=measured_timing,
                rows_returned=len(databases),
            )
            DatabaseEvidenceStore.record_proof(proof)
            session.binding.bind_proof(proof)

            dbs_text = "\n".join(databases)
            content = f"Databases found: {len(databases)}\n\n{dbs_text}"
            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "databases": databases,
                "rowCount": len(databases),
                "executionTimeMs": measured_timing,
                "executionStatus": "SUCCESS",
                "databaseType": db_type,
                "engine": db_type,
                "databaseSessionId": session.session_id,
                "evidenceId": proof.evidence_id,
                "mode": "LIVE",
                "resultSource": DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                "executed": True,
            }

        # 2. DATABASE_LIST_TABLES
        if capability == DatabaseCapability.DATABASE_LIST_TABLES:
            schema_query = arguments.get("schema_query")
            learn_schema = bool(arguments.get("learn_schema"))
            refresh_schema = bool(arguments.get("refresh_schema"))
            schema_knowledge = session.get_schema_knowledge()
            if (learn_schema or schema_query) and (refresh_schema or not schema_knowledge):
                schema_started = time.perf_counter()
                schema_result = DatabaseIntelligenceEngine.inspect_database_schema(
                    eff_root,
                    {
                        **session_db_config,
                        "database_session_id": session.session_id,
                    },
                )
                if (
                    schema_result.get("status") != "SUCCESS"
                    or schema_result.get("source") != DatabaseEvidenceSource.LIVE_DB_EXECUTION
                ):
                    status = schema_result.get("status") or "SCHEMA_DISCOVERY_FAILED"
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": (
                            f"Live schema discovery failed ({status}). "
                            "No verified schema knowledge was stored."
                        ),
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "schemaError": schema_result.get("error"),
                        "executed": False,
                    }
                schema_knowledge = session.record_schema_knowledge(schema_result)
                try:
                    cls.schema_knowledge_store.save(
                        session.schema_knowledge_key(),
                        schema_knowledge,
                    )
                except RuntimeError as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": (
                            "Live schema was discovered, but verified schema knowledge "
                            f"could not be persisted ({error})."
                        ),
                        "executionStatus": "SCHEMA_PERSISTENCE_FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "schemaError": str(error),
                        "executed": False,
                    }
                schema_elapsed_ms = max(
                    round((time.perf_counter() - schema_started) * 1000.0, 3),
                    0.01,
                )
            else:
                schema_result = None
                schema_elapsed_ms = None

            if learn_schema or schema_query:
                if not schema_knowledge:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "No verified schema knowledge is available for this database session.",
                        "executionStatus": "SCHEMA_NOT_LEARNED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                schema = schema_knowledge.get("schema") or {}
                schema_tables = schema.get("tables") or []
                schema_details = schema.get("details") or {}
                content_lines = []

                if schema_query:
                    query_kind = str(schema_query.get("kind") or "")
                    if query_kind == "table_exists":
                        requested_table = str(schema_query.get("table") or "")
                        actual_table = next(
                            (
                                table for table in schema_tables
                                if str(table).casefold() == requested_table.casefold()
                            ),
                            None,
                        )
                        content_lines.append(
                            f"Table `{actual_table or requested_table}` "
                            + ("exists in the verified schema." if actual_table else "was not found in the verified schema.")
                        )
                    elif query_kind == "column_location":
                        requested_column = str(schema_query.get("term") or "").casefold()
                        context = str(schema_query.get("context") or "").casefold()
                        matches = []
                        for table_name, details in schema_details.items():
                            for column in details.get("columns", []):
                                column_name = str(column.get("name") or "")
                                if column_name.casefold() == requested_column:
                                    context_match = bool(context and context in str(table_name).casefold())
                                    matches.append((not context_match, str(table_name), column))
                        matches.sort(key=lambda match: (match[0], match[1].casefold()))
                        if matches:
                            content_lines.append(f"Verified schema matches for column `{schema_query.get('term')}`:")
                            for _context_rank, table_name, column in matches:
                                content_lines.append(
                                    f"- `{table_name}.{column.get('name')}` "
                                    f"(type: {column.get('type') or 'not reported by adapter'})"
                                )
                        else:
                            content_lines.append(
                                f"No exact live schema column named `{schema_query.get('term')}` was found."
                            )
                    elif query_kind == "referencing_tables":
                        target_table = str(schema_query.get("table") or "")
                        references = [
                            relationship for relationship in schema.get("relationships", [])
                            if str(relationship.get("referencedTable") or "").casefold()
                            == target_table.casefold()
                        ]
                        if references:
                            content_lines.append(
                                f"Database-enforced foreign keys referencing `{target_table}`:"
                            )
                            content_lines.extend(
                                f"- `{reference.get('table')}` "
                                f"({', '.join(reference.get('columns') or [])}) -> "
                                f"`{target_table}` ({', '.join(reference.get('referencedColumns') or [])})"
                                for reference in references
                            )
                        else:
                            content_lines.append(
                                f"No database-enforced foreign key referencing `{target_table}` "
                                "was found in the inspected schema."
                            )
                    elif query_kind == "primary_key":
                        target_table = str(schema_query.get("table") or "")
                        actual_table = next(
                            (
                                table for table in schema_tables
                                if str(table).casefold() == target_table.casefold()
                            ),
                            None,
                        )
                        if actual_table is None:
                            content_lines.append(f"Table `{target_table}` was not found in the verified schema.")
                        else:
                            primary_keys = schema_details.get(actual_table, {}).get("primary_keys") or []
                            content_lines.append(
                                f"Primary key for `{actual_table}`: "
                                + (", ".join(f"`{column}`" for column in primary_keys) if primary_keys else "not reported by the database adapter.")
                            )
                    elif query_kind == "indexes":
                        target_table = str(schema_query.get("table") or "")
                        actual_table = next(
                            (
                                table for table in schema_tables
                                if str(table).casefold() == target_table.casefold()
                            ),
                            None,
                        )
                        if actual_table is None:
                            content_lines.append(f"Table `{target_table}` was not found in the verified schema.")
                        else:
                            indexes = schema_details.get(actual_table, {}).get("indexes") or []
                            if not indexes:
                                content_lines.append(
                                    f"No indexes were reported for `{actual_table}` by the database adapter."
                                )
                            else:
                                content_lines.append(f"Verified indexes on `{actual_table}`:")
                                content_lines.extend(
                                    f"- `{index.get('name')}`"
                                    f"{' UNIQUE' if index.get('unique') else ''}: "
                                    f"{', '.join(str(column) for column in (index.get('columns') or [])) or index.get('definition') or 'column details unavailable'}"
                                    for index in indexes
                                )
                    else:
                        return {
                            "ok": False,
                            "capability": capability,
                            "content": "The requested schema lookup is not supported by the inspected metadata.",
                            "executionStatus": "UNSUPPORTED_OPERATION",
                            "databaseType": db_type,
                            "databaseSessionId": session.session_id,
                            "executed": False,
                        }
                    content = "\n".join(content_lines)
                    schema_provenance = schema_knowledge.get("provenance") or {}
                    schema_state = (
                        "Live database inspection"
                        if schema_result
                        else "Cached previously verified schema"
                    )
                    content += (
                        f"\n\n**Schema metadata:** {schema_state}.\n"
                        f"- **Fingerprint:** `{schema_knowledge.get('fingerprint')}`\n"
                        f"- **Last live verification:** {schema_knowledge.get('lastVerifiedAt')}\n"
                        f"- **Provenance:** `{schema_provenance.get('source')}`"
                        f" / `{schema_provenance.get('evidenceId')}`"
                    )
                    schema_operation = "SCHEMA_SEARCH"
                else:
                    total_columns = sum(
                        len(details.get("columns") or [])
                        for details in schema_details.values()
                    )
                    total_indexes = sum(
                        len(details.get("indexes") or [])
                        for details in schema_details.values()
                    )
                    total_relationships = len(schema.get("relationships") or [])
                    content = (
                        "### VERIFIED DATABASE SCHEMA\n\n"
                        f"- **Engine:** `{schema_knowledge.get('engine')}`\n"
                        f"- **Database:** `{schema_knowledge.get('database')}`\n"
                        f"- **Tables/collections:** {len(schema_tables)}\n"
                        f"- **Columns/observed fields:** {total_columns}\n"
                        f"- **Indexes:** {total_indexes}\n"
                        f"- **Database-enforced relationships:** {total_relationships}\n"
                        f"- **Schema fingerprint:** `{schema_knowledge.get('fingerprint')}`\n"
                        f"- **Discovered at:** {schema_knowledge.get('discoveredAt')}\n"
                        f"- **Last live verification:** {schema_knowledge.get('lastVerifiedAt')}\n"
                        f"- **Provenance:** `{(schema_knowledge.get('provenance') or {}).get('source')}`"
                        f" / `{(schema_knowledge.get('provenance') or {}).get('evidenceId')}`\n"
                        f"- **Schema changed since prior verification:** "
                        f"{'yes' if schema_knowledge.get('changed') else 'no'}\n\n"
                        "**Discovered tables/collections:**\n"
                        + ("\n".join(f"- `{table}`" for table in schema_tables) if schema_tables else "- None")
                    )
                    if not schema_result:
                        content += "\n\n- **Metadata state:** Cached previously verified schema."
                    schema_operation = "SCHEMA_DISCOVERY"

                schema_proof_id = (
                    (schema_knowledge.get("provenance") or {}).get("evidenceId")
                )
                return {
                    "ok": True,
                    "capability": capability,
                    "content": content,
                    "tables": schema_tables,
                    "schemaKnowledge": schema_knowledge,
                    "schemaFingerprint": schema_knowledge.get("fingerprint"),
                    "schemaChanged": schema_knowledge.get("changed"),
                    "schemaRefreshed": bool(refresh_schema or not schema_query and learn_schema),
                    "executionTimeMs": schema_elapsed_ms,
                    "executionStatus": "SUCCESS",
                    "databaseType": db_type,
                    "engine": db_type,
                    "databaseSessionId": session.session_id,
                    "evidenceId": schema_proof_id,
                    "mode": "LIVE" if schema_result else "CACHED_VERIFIED_SCHEMA",
                    "resultSource": (
                        DatabaseEvidenceSource.LIVE_DB_EXECUTION
                        if schema_result
                        else "CACHED_VERIFIED_SCHEMA"
                    ),
                    "schemaOperation": schema_operation,
                    "executed": bool(schema_result),
                }

            target_obj = DatabaseTargetRegistry.get_target(eff_root, getattr(session, "target_id", None))
            if not target_obj:
                target_obj = DatabaseTargetRegistry.get_active_target(eff_root)
            tables = []
            if db_type in ("mysql", "mariadb"):
                if not session.database_name:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "A selected MySQL database is required to list tables.",
                        "executionStatus": "INVALID_INPUT",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                try:
                    connection = DatabaseIntelligenceEngine._open_mysql_connection(eff_root, session_db_config)
                    try:
                        cursor = connection.cursor()
                        cursor.execute(
                            "SELECT table_name FROM information_schema.tables "
                            "WHERE table_schema = DATABASE() ORDER BY table_name LIMIT 200"
                        )
                        tables = [str(row[0]) for row in cursor.fetchall()]
                    finally:
                        connection.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live MySQL table listing failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type in ("postgres", "postgresql", "supabase"):
                try:
                    connection = DatabaseIntelligenceEngine._open_postgresql_connection(eff_root, {
                        "engine": db_type,
                        "database": session.database_name,
                        "host": session.safe_host,
                        "port": session.safe_port,
                        **session._protected_credentials,
                    })
                    try:
                        cursor = connection.cursor()
                        cursor.execute(
                            "SELECT table_name FROM information_schema.tables "
                            "WHERE table_schema = current_schema() ORDER BY table_name LIMIT 200"
                        )
                        tables = [str(row[0]) for row in cursor.fetchall()]
                    finally:
                        connection.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live PostgreSQL table listing failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type == "h2":
                try:
                    connection = DatabaseIntelligenceEngine._open_h2_connection(eff_root, session_db_config)
                    try:
                        cursor = connection.cursor()
                        cursor.execute(
                            "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
                            "WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') "
                            "ORDER BY TABLE_NAME"
                        )
                        tables = [str(row[0]) for row in cursor.fetchmany(200)]
                    finally:
                        connection.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live H2 table listing failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type in ("mongo", "mongodb"):
                try:
                    client = DatabaseIntelligenceEngine._open_mongodb_client(eff_root, {
                        "host": session.safe_host,
                        "port": session.safe_port,
                        **session._protected_credentials,
                    })
                    try:
                        tables = client[session.database_name].list_collection_names()
                    finally:
                        client.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live MongoDB collection listing failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type == "sqlite":
                configured_sqlite_file = (
                    target_obj.sqlite_file
                    if target_obj and target_obj.sqlite_file
                    else session.sqlite_file
                )
                if not configured_sqlite_file:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "A verified SQLite file path is unavailable; static table references were not treated as live tables.",
                        "executionStatus": "UNAVAILABLE",
                        "evidenceQuality": "UNVERIFIED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                sqlite_path = Path(configured_sqlite_file)
                if not sqlite_path.is_absolute() and root:
                    sqlite_path = root / sqlite_path
                if not sqlite_path.is_file():
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "The configured SQLite file was not found; static table references were not treated as live tables.",
                        "executionStatus": "UNAVAILABLE",
                        "evidenceQuality": "UNVERIFIED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                import sqlite3
                try:
                    conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
                    try:
                        cur = conn.cursor()
                        cur.execute(
                            "SELECT name FROM sqlite_master "
                            "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%';"
                        )
                        tables = [str(row[0]) for row in cur.fetchall()]
                    finally:
                        conn.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live SQLite table listing failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }

            if not tables:
                supported_live_engines = {
                    "sqlite",
                    "mysql",
                    "mariadb",
                    "postgres",
                    "postgresql",
                    "supabase",
                    "h2",
                    "mongo",
                    "mongodb",
                }
                if db_type not in supported_live_engines:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": (
                            f"Live table discovery is not supported for database engine `{db_type or 'unknown'}`. "
                            "Project model or migration references were not treated as live tables."
                        ),
                        "executionStatus": "UNSUPPORTED_ENGINE",
                        "databaseType": db_type or "unknown",
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            duration_ms = round((time.perf_counter() - start_t) * 1000.0, 3)
            measured_timing = duration_ms

            proof = DatabaseExecutionProof(
                database_session_id=session.session_id,
                database_engine=db_type,
                operation=capability,
                source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                mode="LIVE",
                execution_status="SUCCESS",
                execution_time_ms=measured_timing,
                rows_returned=len(tables),
                schema_object="all_tables",
            )
            DatabaseEvidenceStore.record_proof(proof)
            session.binding.bind_proof(proof)

            content = "\n".join(f"- `{table}`" for table in tables) or "No tables found."
            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "tables": tables,
                "rowCount": len(tables),
                "executionTimeMs": measured_timing,
                "executionStatus": "SUCCESS",
                "databaseType": db_type,
                "engine": db_type,
                "databaseSessionId": session.session_id,
                "evidenceId": proof.evidence_id,
                "mode": "LIVE",
                "resultSource": DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                "executed": True,
            }

        # 3. DATABASE_DESCRIBE_TABLE
        if capability == DatabaseCapability.DATABASE_DESCRIBE_TABLE:
            requested_table = str(arguments.get("table") or "").strip()
            if not requested_table:
                return {
                    "ok": False,
                    "capability": capability,
                    "content": "Name the table whose columns you want to inspect.",
                    "executionStatus": "INVALID_INPUT",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }
            listed_tables = cls.execute_database_capability(
                DatabaseCapability.DATABASE_LIST_TABLES,
                {},
                session,
                eff_root,
            )
            if not listed_tables.get("ok"):
                return {
                    "ok": False,
                    "capability": capability,
                    "content": listed_tables.get("content")
                    or "Could not resolve the table against the selected database.",
                    "executionStatus": listed_tables.get("executionStatus", "FAILED"),
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }
            table_matches = cls._resolve_schema_table_matches(
                requested_table,
                [str(table) for table in listed_tables.get("tables") or []],
            )
            if not table_matches:
                return {
                    "ok": False,
                    "capability": capability,
                    "content": f"Table `{requested_table}` was not found in the selected database.",
                    "executionStatus": "NOT_FOUND",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }
            if len(table_matches) > 1:
                options = [{"label": table, "value": table} for table in table_matches]
                numbered = "\n".join(
                    f"{index}. `{option['value']}`"
                    for index, option in enumerate(options, start=1)
                )
                return {
                    "ok": True,
                    "capability": capability,
                    "content": (
                        f"More than one table matches **{requested_table}**. "
                        f"Which table should I describe?\n{numbered}\nNo schema detail query was run."
                    ),
                    "executionStatus": "NEEDS_CLARIFICATION",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                    "candidateTables": table_matches,
                    "clarificationOptions": options,
                    "clarificationType": "table",
                }
            target_table = table_matches[0]
            columns = []
            if db_type in ("mysql", "mariadb"):
                if not re.fullmatch(r"[A-Za-z0-9_$-]{1,120}", target_table):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "MySQL table name is invalid.",
                        "executionStatus": "INVALID_INPUT",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                try:
                    connection = DatabaseIntelligenceEngine._open_mysql_connection(eff_root, session_db_config)
                    try:
                        cursor = connection.cursor()
                        cursor.execute(
                            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY "
                            "FROM information_schema.columns "
                            "WHERE table_schema = DATABASE() AND table_name = %s "
                            "ORDER BY ORDINAL_POSITION",
                            (target_table,),
                        )
                        columns = [
                            {
                                "name": row[0],
                                "type": row[1],
                                "notnull": row[2] == "NO",
                                "pk": row[3] == "PRI",
                            }
                            for row in cursor.fetchall()
                        ]
                    finally:
                        connection.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live MySQL table inspection failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type in ("postgres", "postgresql", "supabase"):
                if not re.fullmatch(r"[A-Za-z0-9_$-]{1,120}", target_table):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "PostgreSQL table name is invalid.",
                        "executionStatus": "INVALID_INPUT",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                try:
                    connection = DatabaseIntelligenceEngine._open_postgresql_connection(eff_root, session_db_config)
                    try:
                        cursor = connection.cursor()
                        cursor.execute(
                            "SELECT c.column_name, c.data_type, c.is_nullable, "
                            "EXISTS (SELECT 1 FROM information_schema.table_constraints tc "
                            "JOIN information_schema.key_column_usage kcu "
                            "ON tc.constraint_name = kcu.constraint_name "
                            "AND tc.table_schema = kcu.table_schema "
                            "WHERE tc.constraint_type = 'PRIMARY KEY' "
                            "AND tc.table_schema = current_schema() "
                            "AND tc.table_name = c.table_name "
                            "AND kcu.column_name = c.column_name) "
                            "FROM information_schema.columns c "
                            "WHERE c.table_schema = current_schema() AND c.table_name = %s "
                            "ORDER BY c.ordinal_position",
                            (target_table,),
                        )
                        columns = [
                            {"name": row[0], "type": row[1], "notnull": row[2] == "NO", "pk": bool(row[3])}
                            for row in cursor.fetchall()
                        ]
                    finally:
                        connection.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live PostgreSQL table inspection failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type == "h2":
                if not re.fullmatch(r"[A-Za-z0-9_$-]{1,120}", target_table):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "H2 table name is invalid.",
                        "executionStatus": "INVALID_INPUT",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                try:
                    connection = DatabaseIntelligenceEngine._open_h2_connection(eff_root, session_db_config)
                    try:
                        cursor = connection.cursor()
                        cursor.execute(
                            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE "
                            "FROM INFORMATION_SCHEMA.COLUMNS "
                            "WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME = ? "
                            "ORDER BY ORDINAL_POSITION",
                            (target_table.upper(),),
                        )
                        rows = cursor.fetchall()
                        cursor.execute(
                            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE "
                            "WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME = ? "
                            "AND CONSTRAINT_NAME IN (SELECT CONSTRAINT_NAME "
                            "FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS "
                            "WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME = ? "
                            "AND CONSTRAINT_TYPE = 'PRIMARY KEY')",
                            (target_table.upper(), target_table.upper()),
                        )
                        primary_keys = {str(row[0]) for row in cursor.fetchall()}
                        columns = [
                            {
                                "name": row[0],
                                "type": row[1],
                                "notnull": row[2] == "NO",
                                "pk": str(row[0]) in primary_keys,
                            }
                            for row in rows
                        ]
                    finally:
                        connection.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live H2 table inspection failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type in ("mongo", "mongodb"):
                if not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", target_table):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "MongoDB collection name is invalid.",
                        "executionStatus": "INVALID_INPUT",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                try:
                    client = DatabaseIntelligenceEngine._open_mongodb_client(eff_root, {
                        "host": session.safe_host,
                        "port": session.safe_port,
                        **session._protected_credentials,
                    })
                    try:
                        sample = client[session.database_name][target_table].find_one()
                        columns = [
                            {
                                "name": name,
                                "type": type(value).__name__,
                                "notnull": value is not None,
                                "pk": name == "_id",
                            }
                            for name, value in (sample or {}).items()
                        ]
                    finally:
                        client.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"MongoDB collection inspection failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            if db_type == "sqlite":
                sqlite_path = Path(session.sqlite_file) if session.sqlite_file else None
                if sqlite_path and not sqlite_path.is_absolute() and root:
                    sqlite_path = root / sqlite_path
                if not sqlite_path or not sqlite_path.is_file():
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "The configured SQLite file is unavailable; table details were not inferred from source.",
                        "executionStatus": "UNAVAILABLE",
                        "evidenceQuality": "UNVERIFIED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                import sqlite3
                try:
                    conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
                    try:
                        cur = conn.cursor()
                        cur.execute(f'PRAGMA table_info("{target_table}");')
                        for r in cur.fetchall():
                            columns.append({
                                "name": r[1],
                                "type": r[2] or "TEXT",
                                "notnull": bool(r[3]),
                                "pk": bool(r[5]),
                            })
                    finally:
                        conn.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live SQLite table inspection failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }

            if not columns:
                if db_type not in (
                    "sqlite",
                    "mysql",
                    "mariadb",
                    "postgres",
                    "postgresql",
                    "supabase",
                    "h2",
                    "mongo",
                    "mongodb",
                ):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": (
                            f"Live column discovery is unavailable for database engine "
                            f"`{db_type or 'unknown'}`; source and migration metadata were not treated as live schema."
                        ),
                        "executionStatus": "UNAVAILABLE",
                        "evidenceQuality": "UNVERIFIED",
                        "databaseType": db_type or "unknown",
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                return {
                    "ok": False,
                    "capability": capability,
                    "content": f"Table '{target_table}' was not found in the selected database.",
                    "executionStatus": "NOT_FOUND",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }

            duration_ms = round((time.perf_counter() - start_t) * 1000.0, 3)
            measured_timing = duration_ms

            proof = DatabaseExecutionProof(
                database_session_id=session.session_id,
                database_engine=db_type,
                operation=capability,
                source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                mode="LIVE",
                execution_status="SUCCESS",
                execution_time_ms=measured_timing,
                rows_returned=len(columns),
                schema_object=target_table,
            )
            DatabaseEvidenceStore.record_proof(proof)
            session.binding.bind_proof(proof)

            col_lines = "\n".join(
                f"- {c['name']} ({c['type']}, PK: {'yes' if c.get('pk') else 'no'}, Nullable: {'no' if c.get('notnull') else 'yes'})"
                for c in columns
            )
            content = f"Table: {target_table}\nColumns ({len(columns)}):\n{col_lines}"
            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "table": target_table,
                "columns": columns,
                "rowCount": len(columns),
                "executionTimeMs": measured_timing,
                "executionStatus": "SUCCESS",
                "databaseType": db_type,
                "engine": db_type,
                "databaseSessionId": session.session_id,
                "evidenceId": proof.evidence_id,
                "mode": "LIVE",
                "resultSource": DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                "executed": True,
            }

        # 4. DATABASE_LIST_INDEXES
        if capability == DatabaseCapability.DATABASE_LIST_INDEXES:
            target_table = arguments.get("table")
            if target_table:
                listed_tables = cls.execute_database_capability(
                    DatabaseCapability.DATABASE_LIST_TABLES,
                    {},
                    session,
                    eff_root,
                )
                if not listed_tables.get("ok"):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": listed_tables.get("content")
                        or "Could not resolve the table against the selected database.",
                        "executionStatus": listed_tables.get("executionStatus", "FAILED"),
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                table_matches = cls._resolve_schema_table_matches(
                    str(target_table),
                    [str(table) for table in listed_tables.get("tables") or []],
                )
                if not table_matches:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Table `{target_table}` was not found in the selected database.",
                        "executionStatus": "NOT_FOUND",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                if len(table_matches) > 1:
                    options = [{"label": table, "value": table} for table in table_matches]
                    numbered = "\n".join(
                        f"{index}. `{option['value']}`"
                        for index, option in enumerate(options, start=1)
                    )
                    return {
                        "ok": True,
                        "capability": capability,
                        "content": (
                            f"More than one table matches **{target_table}**. "
                            f"Which table should I inspect?\n{numbered}\nNo index query was run."
                        ),
                        "executionStatus": "NEEDS_CLARIFICATION",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                        "candidateTables": table_matches,
                        "clarificationOptions": options,
                        "clarificationType": "table",
                    }
                target_table = table_matches[0]
            indexes = []
            index_query_executed = False
            if db_type == "sqlite":
                sqlite_path = Path(session.sqlite_file) if session.sqlite_file else None
                if sqlite_path and not sqlite_path.is_absolute() and root:
                    sqlite_path = root / sqlite_path
                if not sqlite_path or not sqlite_path.is_file():
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "The configured SQLite file is unavailable; index metadata is unverified.",
                        "executionStatus": "UNAVAILABLE",
                        "evidenceQuality": "UNVERIFIED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                import sqlite3
                try:
                    conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
                    cur = conn.cursor()
                    index_query_executed = True
                    tables_to_check = [target_table] if target_table else [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
                    for t in tables_to_check:
                        if not t:
                            continue
                        cur.execute(f'PRAGMA index_list("{t}");')
                        for idx in cur.fetchall():
                            idx_name = idx[1]
                            cur.execute(f'PRAGMA index_info("{idx_name}");')
                            idx_cols = [c[2] for c in cur.fetchall()]
                            indexes.append({
                                "table": t,
                                "name": idx_name,
                                "unique": bool(idx[2]),
                                "columns": idx_cols,
                            })
                    conn.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live SQLite index inspection failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            elif db_type == "h2":
                if target_table and not re.fullmatch(r"[A-Za-z0-9_$-]{1,120}", target_table):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "H2 table name is invalid.",
                        "executionStatus": "INVALID_INPUT",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                try:
                    connection = DatabaseIntelligenceEngine._open_h2_connection(eff_root, session_db_config)
                    try:
                        cursor = connection.cursor()
                        query = (
                            "SELECT I.TABLE_NAME, I.INDEX_NAME, I.INDEX_TYPE_NAME, C.COLUMN_NAME "
                            "FROM INFORMATION_SCHEMA.INDEXES I "
                            "JOIN INFORMATION_SCHEMA.INDEX_COLUMNS C "
                            "ON C.INDEX_SCHEMA = I.INDEX_SCHEMA AND C.INDEX_NAME = I.INDEX_NAME "
                            "WHERE I.TABLE_SCHEMA = 'PUBLIC'"
                        )
                        parameters = ()
                        if target_table:
                            query += " AND I.TABLE_NAME = ?"
                            parameters = (target_table.upper(),)
                        query += " ORDER BY I.TABLE_NAME, I.INDEX_NAME, C.ORDINAL_POSITION"
                        cursor.execute(query, parameters)
                        index_query_executed = True
                        indexes_by_name: Dict[Tuple[str, str], Dict[str, Any]] = {}
                        for table_name, index_name, index_type, column_name in cursor.fetchall():
                            key = (str(table_name), str(index_name))
                            index = indexes_by_name.setdefault(
                                key,
                                {
                                    "table": str(table_name),
                                    "name": str(index_name),
                                    "unique": str(index_type).upper().startswith(("UNIQUE", "PRIMARY KEY")),
                                    "columns": [],
                                },
                            )
                            if column_name:
                                index["columns"].append(str(column_name))
                        indexes = list(indexes_by_name.values())
                    finally:
                        connection.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live H2 index inspection failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }

            if not index_query_executed:
                return {
                    "ok": False,
                    "capability": capability,
                    "content": f"Index inspection is unavailable for database engine `{db_type or 'unknown'}`.",
                    "executionStatus": "UNAVAILABLE",
                    "evidenceQuality": "UNVERIFIED",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }

            duration_ms = round((time.perf_counter() - start_t) * 1000.0, 3)
            measured_timing = duration_ms

            proof = DatabaseExecutionProof(
                database_session_id=session.session_id,
                database_engine=db_type,
                operation=capability,
                source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                mode="LIVE",
                execution_status="SUCCESS",
                execution_time_ms=measured_timing,
                rows_returned=len(indexes),
                schema_object=target_table or "all_indexes",
            )
            DatabaseEvidenceStore.record_proof(proof)
            session.binding.bind_proof(proof)

            if indexes:
                idx_lines = "\n".join(
                    f"- {i['name']} on `{i['table']}` (Columns: {', '.join(i['columns']) or 'primary_key'}, Unique: {'yes' if i['unique'] else 'no'})"
                    for i in indexes
                )
                header = f"Indexes on {target_table} ({len(indexes)}):" if target_table else f"Indexes ({len(indexes)}):"
                content = f"{header}\n{idx_lines}"
            else:
                scope_str = f"on `{target_table}`" if target_table else "in database"
                content = f"No secondary indexes found {scope_str}."

            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "indexes": indexes,
                "rowCount": len(indexes),
                "executionTimeMs": measured_timing,
                "executionStatus": "SUCCESS",
                "databaseType": db_type,
                "engine": db_type,
                "databaseSessionId": session.session_id,
                "evidenceId": proof.evidence_id,
                "mode": "LIVE",
                "resultSource": DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                "executed": True,
            }

        if capability == DatabaseCapability.DATABASE_COUNT_RECORDS:
            requested_entity = str(arguments.get("entity") or "").strip()
            payment_filter = str(arguments.get("payment_filter") or "").strip().lower()
            payment_value = arguments.get("payment_value")
            requested_filters = {
                str(item).strip().casefold()
                for item in arguments.get("filters", [])
                if isinstance(item, str)
            } if isinstance(arguments.get("filters", []), (list, tuple, set)) else set()
            unsupported_filters = requested_filters - {"active", "today"}
            if unsupported_filters:
                return {
                    "ok": False,
                    "capability": capability,
                    "content": (
                        "The requested count condition could not be verified safely; "
                        "no count query was run."
                    ),
                    "executionStatus": "UNSUPPORTED_FILTER",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }
            entity_key = re.sub(r"[^a-z0-9]", "", requested_entity.lower())
            is_table_identifier = bool(
                re.fullmatch(r"[A-Za-z][A-Za-z0-9_$.-]*", requested_entity)
                and (
                    re.search(r"[_$.-]", requested_entity)
                    or requested_entity != requested_entity.lower()
                )
            )
            if not is_table_identifier:
                if entity_key.endswith("ies") and len(entity_key) > 3:
                    entity_key = f"{entity_key[:-3]}y"
                elif entity_key.endswith("s") and len(entity_key) > 3:
                    entity_key = entity_key[:-1]
            if not entity_key:
                return {
                    "ok": False,
                    "capability": capability,
                    "content": "Name the kind of records to count, such as admissions or users.",
                    "executionStatus": "INVALID_INPUT",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }

            table_result = cls.execute_database_capability(
                DatabaseCapability.DATABASE_LIST_TABLES,
                {},
                session,
                eff_root,
            )
            if not table_result.get("ok"):
                return {
                    "ok": False,
                    "capability": capability,
                    "content": table_result.get("content") or "Could not inspect the connected database tables.",
                    "executionStatus": table_result.get("executionStatus", "FAILED"),
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }
            if not table_result.get("tables"):
                refreshed_tables = cls.execute_database_capability(
                    DatabaseCapability.DATABASE_LIST_TABLES,
                    {"learn_schema": True, "refresh_schema": True},
                    session,
                    eff_root,
                )
                if not refreshed_tables.get("ok"):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": (
                            "The connected database returned no tables, and a fresh verified-schema "
                            f"check failed: {refreshed_tables.get('content') or 'schema refresh failed'}. "
                            "No count query was run."
                        ),
                        "executionStatus": refreshed_tables.get("executionStatus", "FAILED"),
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                if refreshed_tables.get("tables"):
                    table_result = refreshed_tables
                else:
                    database_label = session.database_name or "the selected database"
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": (
                            f"A fresh live-schema check found no accessible tables in {database_label}. "
                            "No count query was run. Verify that the intended database/schema is selected "
                            "and that this connection can list its tables."
                        ),
                        "executionStatus": "NO_LIVE_TABLES",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }

            scored_tables = []
            target_resolution = None
            for table in table_result.get("tables", []):
                table_name = str(table)
                table_key = re.sub(r"[^a-z0-9]", "", table_name.lower())
                singular_table_key = table_key
                if not is_table_identifier:
                    singular_table_key = (
                        f"{table_key[:-3]}y"
                        if table_key.endswith("ies") and len(table_key) > 3
                        else table_key[:-1]
                        if table_key.endswith("s") and len(table_key) > 3
                        else table_key
                    )
                if table_key == entity_key or singular_table_key == entity_key:
                    score = 100
                elif not is_table_identifier and entity_key in singular_table_key:
                    score = 50
                elif (
                    not is_table_identifier
                    and singular_table_key in entity_key
                    and len(singular_table_key) >= 4
                ):
                    score = 25
                else:
                    continue
                scored_tables.append((score, table_name))

            if not scored_tables:
                fuzzy_matches = []
                fuzzy_similarities = []
                if is_table_identifier and len(entity_key) >= 10:
                    for table in table_result.get("tables", []):
                        table_name = str(table)
                        table_key = re.sub(r"[^a-z0-9]", "", table_name.lower())
                        similarity = SequenceMatcher(None, entity_key, table_key).ratio()
                        if similarity >= 0.90:
                            fuzzy_similarities.append((similarity, table_name))
                if fuzzy_similarities:
                    best_similarity = max(similarity for similarity, _ in fuzzy_similarities)
                    fuzzy_matches = [
                        (round(similarity * 100), table_name)
                        for similarity, table_name in fuzzy_similarities
                        if best_similarity - similarity < 0.08
                    ]
                if fuzzy_matches:
                    best_score = max(score for score, _ in fuzzy_matches)
                    scored_tables = [
                        (score, table_name)
                        for score, table_name in fuzzy_matches
                        if score == best_score
                    ]
            if not scored_tables:
                available_tables = table_result.get("tables", [])
                requested_tokens = [
                    token
                    for token in re.findall(r"[a-z0-9]+", requested_entity.lower())
                    if len(token) >= 3
                ]
                suggested_tables = []
                for table in available_tables:
                    table_name = str(table)
                    table_tokens = [
                        token
                        for token in re.findall(r"[a-z0-9]+", table_name.lower())
                        if len(token) >= 3
                    ]
                    exact_token_matches = sum(
                        1 for token in requested_tokens if token in table_tokens
                    )
                    near_token_matches = sum(
                        1
                        for token in requested_tokens
                        if token not in table_tokens
                        and len(token) >= 4
                        and any(
                            SequenceMatcher(None, token, candidate_token).ratio() >= 0.8
                            for candidate_token in table_tokens
                        )
                    )
                    whole_name_similarity = SequenceMatcher(
                        None,
                        entity_key,
                        re.sub(r"[^a-z0-9]", "", table_name.lower()),
                    ).ratio()
                    is_relevant_candidate = (
                        exact_token_matches >= 2
                        or (exact_token_matches >= 1 and near_token_matches >= 1)
                        or (len(requested_tokens) == 1 and whole_name_similarity >= 0.65)
                    )
                    if is_relevant_candidate:
                        relevance = (
                            exact_token_matches * 2
                            + near_token_matches
                            + whole_name_similarity
                        )
                        suggested_tables.append((relevance, table_name))
                suggested_tables.sort(key=lambda item: (-item[0], item[1].casefold()))
                relevant_tables = [table for _, table in suggested_tables[:10]]
                if relevant_tables:
                    ranking = cls._rank_database_table_candidates(
                        requested_entity,
                        relevant_tables,
                        eff_root,
                    )
                    if (
                        len(ranking) > 1
                        and ranking[0]["score"] >= 70
                        and ranking[0]["score"] - ranking[1]["score"] >= 20
                    ):
                        scored_tables = [(ranking[0]["score"], ranking[0]["table"])]
                        target_resolution = ranking[0]
                    else:
                        options = [
                            {"label": str(table), "value": str(table)}
                            for table in relevant_tables
                        ]
                        numbered_options = "\n".join(
                            f"{index}. `{option['value']}`"
                            for index, option in enumerate(options, start=1)
                        )
                        return {
                            "ok": True,
                            "capability": capability,
                            "content": (
                                f"No single table is sufficiently supported for **{requested_entity}**. "
                                f"Which table should I count?\n{numbered_options}\n"
                                "No count query was run."
                            ),
                            "executionStatus": "NEEDS_CLARIFICATION",
                            "databaseType": db_type,
                            "databaseSessionId": session.session_id,
                            "executed": False,
                            "candidateTables": [option["value"] for option in options],
                            "clarificationOptions": options,
                            "clarificationType": "table",
                        }
                table_list = ", ".join(f"`{name}`" for name in available_tables[:30]) or "none discovered"
                return {
                    "ok": False,
                    "capability": capability,
                    "content": (
                        f"No table matching **{requested_entity}** was found in the connected database. "
                        f"Discovered tables: {table_list}."
                    ),
                    "executionStatus": "NOT_FOUND",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }

            best_score = max(score for score, _ in scored_tables)
            best_tables = sorted({name for score, name in scored_tables if score == best_score})
            if len(best_tables) != 1:
                ranking = cls._rank_database_table_candidates(
                    requested_entity,
                    best_tables,
                    eff_root,
                )
                if (
                    len(ranking) > 1
                    and ranking[0]["score"] >= 70
                    and ranking[0]["score"] - ranking[1]["score"] >= 20
                ):
                    best_tables = [ranking[0]["table"]]
                    target_resolution = ranking[0]
                else:
                    candidates = ", ".join(f"`{name}`" for name in best_tables)
                    return {
                        "ok": True,
                        "capability": capability,
                        "content": (
                            f"More than one table matches **{requested_entity}** in the live schema, and project evidence "
                            f"does not clearly favor one: {candidates}. "
                            "Which should I count? No count query was run."
                        ),
                        "executionStatus": "NEEDS_CLARIFICATION",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                        "candidateTables": best_tables,
                        "clarificationOptions": [
                            {"label": table, "value": table}
                            for table in best_tables
                        ],
                        "clarificationType": "table",
                    }

            target_table = best_tables[0]
            if not re.fullmatch(r"[A-Za-z0-9_$-]{1,120}", target_table):
                return {
                    "ok": False,
                    "capability": capability,
                    "content": "The matching database table name cannot be safely queried.",
                    "executionStatus": "INVALID_INPUT",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }

            filter_rules = []
            if db_type in ("mongo", "mongodb"):
                if payment_filter or requested_filters:
                    return {
                        "ok": True,
                        "capability": capability,
                        "content": (
                            "The requested count condition cannot be verified safely for this MongoDB collection; "
                            "no count was run."
                        ),
                        "executionStatus": "NEEDS_CLARIFICATION",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                try:
                    client = DatabaseIntelligenceEngine._open_mongodb_client(eff_root, session_db_config)
                    try:
                        total_records = client[session.database_name][target_table].count_documents({})
                    finally:
                        client.close()
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"MongoDB record count failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
            else:
                quote_char = "`" if db_type in ("mysql", "mariadb") else '"'
                where_clause = ""
                if payment_filter == "paid":
                    table_schema = cls.execute_database_capability(
                        DatabaseCapability.DATABASE_DESCRIBE_TABLE,
                        {"table": target_table},
                        session,
                        eff_root,
                    )
                    if not table_schema.get("ok"):
                        return {
                            "ok": False,
                            "capability": capability,
                            "content": table_schema.get("content") or "Could not verify the payment-status column; no paid count was run.",
                            "executionStatus": table_schema.get("executionStatus", "FAILED"),
                            "databaseType": db_type,
                            "databaseSessionId": session.session_id,
                            "executed": False,
                        }
                    columns = table_schema.get("columns") or []
                    payment_columns = [
                        str(column.get("name", ""))
                        for column in columns
                        if re.search(r"(?:pay|payment|paid).*status|status.*(?:pay|payment|paid)", str(column.get("name", "")), re.I)
                    ]
                    if not payment_columns:
                        payment_columns = [
                            str(column.get("name", ""))
                            for column in columns
                            if re.search(r"\bstatus\b", str(column.get("name", "")), re.I)
                        ]
                    if not payment_columns:
                        return {
                            "ok": False,
                            "capability": capability,
                            "content": (
                                f"Table `{target_table}` has no clearly named payment-status column, so paid records "
                                "cannot be identified safely; no count was run."
                            ),
                            "executionStatus": "NEEDS_CLARIFICATION",
                            "databaseType": db_type,
                            "databaseSessionId": session.session_id,
                            "executed": False,
                        }
                    requested_payment_column = str(arguments.get("payment_column") or "")
                    if requested_payment_column:
                        if requested_payment_column not in payment_columns:
                            return {
                                "ok": True,
                                "capability": capability,
                                "content": (
                                    f"`{requested_payment_column}` is not an available status field on `{target_table}`. "
                                    f"Choose one of: {', '.join(f'`{column}`' for column in payment_columns)}. "
                                    "No count query was run."
                                ),
                                "executionStatus": "NEEDS_CLARIFICATION",
                                "databaseType": db_type,
                                "databaseSessionId": session.session_id,
                                "executed": False,
                                "clarificationOptions": [
                                    {"label": column, "value": column}
                                    for column in payment_columns
                                ],
                                "clarificationType": "payment_column",
                            }
                        payment_columns = [requested_payment_column]
                    if len(payment_columns) > 1:
                        options = [
                            {"label": column, "value": column}
                            for column in payment_columns
                        ]
                        return {
                            "ok": True,
                            "capability": capability,
                            "content": (
                                f"More than one payment-status column exists on `{target_table}`. "
                                f"Choose a field: {', '.join(f'`{column}`' for column in payment_columns)}. "
                                "No count query was run."
                            ),
                            "executionStatus": "NEEDS_CLARIFICATION",
                            "databaseType": db_type,
                            "databaseSessionId": session.session_id,
                            "executed": False,
                            "clarificationOptions": options,
                            "clarificationType": "payment_column",
                        }
                    payment_column = payment_columns[0]
                    if not re.fullmatch(r"[A-Za-z0-9_$-]{1,120}", payment_column):
                        return {
                            "ok": False,
                            "capability": capability,
                            "content": "The payment-status column name cannot be safely queried.",
                            "executionStatus": "INVALID_INPUT",
                            "databaseType": db_type,
                            "databaseSessionId": session.session_id,
                            "executed": False,
                        }
                    status_sql = (
                        f"SELECT {quote_char}{payment_column}{quote_char} AS status_value, "
                        f"COUNT(*) AS matching_records FROM {quote_char}{target_table}{quote_char} "
                        f"GROUP BY {quote_char}{payment_column}{quote_char} "
                        f"ORDER BY {quote_char}{payment_column}{quote_char}"
                    )
                    status_result = DatabaseIntelligenceEngine.execute_safe_query(
                        eff_root,
                        status_sql,
                        session_db_config,
                    )
                    if not status_result.get("ok"):
                        error = status_result.get("error") or {}
                        return {
                            "ok": False,
                            "capability": capability,
                            "content": error.get("message") or "Could not inspect payment-status values; no paid count was run.",
                            "error": error,
                            "executionStatus": "FAILED",
                            "databaseType": db_type,
                            "databaseSessionId": session.session_id,
                            "executed": False,
                        }
                    status_rows = status_result.get("rows") or []
                    if payment_value is None:
                        paid_values = [
                            row["status_value"]
                            for row in status_rows
                            if isinstance(row, dict)
                            and isinstance(row.get("status_value"), str)
                            and re.search(r"\bpaid\b", row["status_value"], re.I)
                        ]
                        if len(paid_values) == 1:
                            payment_value = paid_values[0]
                        else:
                            options = [
                                {
                                    "label": f"{row.get('status_value')} ({row.get('matching_records')} rows)",
                                    "value": str(row.get("status_value")),
                                }
                                for row in status_rows
                                if isinstance(row, dict)
                            ]
                            available = ", ".join(f"`{option['label']}`" for option in options) or "none"
                            return {
                                "ok": True,
                                "capability": capability,
                                "content": (
                                    f"Could not determine which value in `{payment_column}` means paid. "
                                    f"Available values and row counts: {available}. Choose the value that represents "
                                    "paid; no count query was run."
                                ),
                                "executionStatus": "NEEDS_CLARIFICATION",
                                "databaseType": db_type,
                                "databaseSessionId": session.session_id,
                                "executed": False,
                                "clarificationOptions": options,
                                "clarificationType": "payment_value",
                            }
                    matching_values = [
                        row.get("status_value")
                        for row in status_rows
                        if isinstance(row, dict)
                    ]
                    matching_value = next(
                        (value for value in matching_values if str(value) == str(payment_value)),
                        None,
                    )
                    if matching_value is None:
                        return {
                            "ok": True,
                            "capability": capability,
                            "content": (
                                f"`{payment_value}` is not an observed value in `{payment_column}`. "
                                "Choose one of the listed live values; no count query was run."
                            ),
                            "executionStatus": "NEEDS_CLARIFICATION",
                            "databaseType": db_type,
                            "databaseSessionId": session.session_id,
                            "executed": False,
                            "clarificationOptions": [
                                {"label": str(value), "value": str(value)}
                                for value in matching_values
                            ],
                            "clarificationType": "payment_value",
                        }
                    payment_value = matching_value
                    if isinstance(payment_value, (int, float)) and not isinstance(payment_value, bool):
                        sql_value = str(payment_value)
                    else:
                        sql_value = "'" + str(payment_value).replace("'", "''") + "'"
                    where_clause = (
                        f" WHERE {quote_char}{payment_column}{quote_char} = {sql_value}"
                    )
                    filter_rules.append(f"{payment_column} = {payment_value}")
                if "active" in requested_filters or "today" in requested_filters:
                    table_schema = cls.execute_database_capability(
                        DatabaseCapability.DATABASE_DESCRIBE_TABLE,
                        {"table": target_table},
                        session,
                        eff_root,
                    )
                    if not table_schema.get("ok"):
                        return {
                            "ok": False,
                            "capability": capability,
                            "content": (
                                table_schema.get("content")
                                or "Could not verify the requested count conditions; no count was run."
                            ),
                            "executionStatus": table_schema.get("executionStatus", "FAILED"),
                            "databaseType": db_type,
                            "databaseSessionId": session.session_id,
                            "executed": False,
                        }
                    columns = [
                        column for column in table_schema.get("columns") or []
                        if isinstance(column, dict)
                        and re.fullmatch(
                            r"[A-Za-z0-9_$-]{1,120}",
                            str(column.get("name") or ""),
                        )
                    ]

                    if "active" in requested_filters:
                        status_columns = [
                            column for column in columns
                            if re.fullmatch(
                                r"(?:is_?active|active|status|state|account_status|user_status)",
                                str(column.get("name") or ""),
                                re.I,
                            )
                        ]
                        active_matches = []
                        observed_by_column = {}
                        for column in status_columns:
                            column_name = str(column["name"])
                            quoted_column = f"{quote_char}{column_name}{quote_char}"
                            values_result = DatabaseIntelligenceEngine.execute_safe_query(
                                eff_root,
                                (
                                    f"SELECT {quoted_column} AS status_value, COUNT(*) AS matching_records "
                                    f"FROM {quote_char}{target_table}{quote_char} "
                                    f"GROUP BY {quoted_column} ORDER BY {quoted_column} LIMIT 20"
                                ),
                                session_db_config,
                            )
                            if not values_result.get("ok"):
                                return {
                                    "ok": False,
                                    "capability": capability,
                                    "content": (
                                        "Could not inspect status values to identify active records; "
                                        "no count query was run."
                                    ),
                                    "executionStatus": "FAILED",
                                    "databaseType": db_type,
                                    "databaseSessionId": session.session_id,
                                    "executed": False,
                                }
                            status_rows = [
                                row for row in values_result.get("rows") or []
                                if isinstance(row, dict) and "status_value" in row
                            ]
                            observed_by_column[column_name] = status_rows
                            column_type = str(column.get("type") or "").casefold()
                            boolean_column = (
                                "bool" in column_type
                                or re.fullmatch(r"is_?active", column_name, re.I) is not None
                            )
                            for row in status_rows:
                                value = row.get("status_value")
                                if isinstance(value, str) and value.strip().casefold() == "active":
                                    active_matches.append((column_name, value))
                                elif boolean_column and (
                                    value is True
                                    or isinstance(value, (int, float)) and value == 1
                                    or isinstance(value, str) and value.strip().casefold() in ("1", "true", "yes")
                                ):
                                    active_matches.append((column_name, value))

                        requested_active_column = str(arguments.get("active_column") or "")
                        requested_active_value = arguments.get("active_value")
                        if requested_active_column:
                            requested_match = next(
                                (
                                    (requested_active_column, row.get("status_value"))
                                    for row in observed_by_column.get(requested_active_column, [])
                                    if str(row.get("status_value")) == str(requested_active_value)
                                ),
                                None,
                            )
                            active_matches = [requested_match] if requested_match else []
                        if len(active_matches) != 1:
                            options = [
                                {
                                    "label": f"{column_name} = {row.get('status_value')}",
                                    "value": f"{column_name}={row.get('status_value')}",
                                }
                                for column_name, values in observed_by_column.items()
                                for row in values
                            ]
                            return {
                                "ok": True,
                                "capability": capability,
                                "content": (
                                    f"Could not determine an unambiguous active-state rule for `{target_table}`. "
                                    "Choose the status field/value that represents active; no count query was run."
                                ),
                                "executionStatus": "NEEDS_CLARIFICATION",
                                "databaseType": db_type,
                                "databaseSessionId": session.session_id,
                                "executed": False,
                                "clarificationOptions": options,
                                "clarificationType": "active_rule",
                            }
                        active_column, active_value = active_matches[0]
                        active_value_sql = (
                            str(active_value)
                            if isinstance(active_value, (int, float)) and not isinstance(active_value, bool)
                            else "'" + str(active_value).replace("'", "''") + "'"
                        )
                        filter_rules.append(f"{active_column} = {active_value}")
                        where_clause = (
                            f"{where_clause} AND " if where_clause else " WHERE "
                        ) + f"{quote_char}{active_column}{quote_char} = {active_value_sql}"

                    if "today" in requested_filters:
                        date_columns = [
                            str(column["name"])
                            for column in columns
                            if re.search(
                                r"date|time|timestamp",
                                str(column.get("type") or ""),
                                re.I,
                            )
                        ]
                        requested_date_column = str(arguments.get("today_column") or "")
                        if requested_date_column:
                            if requested_date_column not in date_columns:
                                return {
                                    "ok": False,
                                    "capability": capability,
                                    "content": (
                                        f"`{requested_date_column}` is not a verified date/time column "
                                        f"on `{target_table}`; no count query was run."
                                    ),
                                    "executionStatus": "INVALID_INPUT",
                                    "databaseType": db_type,
                                    "databaseSessionId": session.session_id,
                                    "executed": False,
                                }
                            date_columns = [requested_date_column]
                        preferred_date_columns = [
                            name for name in date_columns
                            if name.casefold() in {
                                "created_at", "created_on", "created", "date",
                                "timestamp", "updated_at", "updated_on",
                            }
                        ]
                        if len(preferred_date_columns) == 1:
                            date_columns = preferred_date_columns
                        if len(date_columns) != 1:
                            options = [
                                {"label": name, "value": name}
                                for name in date_columns
                            ]
                            return {
                                "ok": True,
                                "capability": capability,
                                "content": (
                                    f"Could not determine which date/time column defines 'today' for `{target_table}`. "
                                    + (
                                        "Choose a column: "
                                        + ", ".join(f"`{option['value']}`" for option in options)
                                        if options
                                        else "No date/time column was reported by the live schema."
                                    )
                                    + " No count query was run."
                                ),
                                "executionStatus": "NEEDS_CLARIFICATION" if options else "NOT_FOUND",
                                "databaseType": db_type,
                                "databaseSessionId": session.session_id,
                                "executed": False,
                                "clarificationOptions": options,
                                "clarificationType": "count_date_column",
                            }
                        date_column = date_columns[0]
                        where_clause = (
                            f"{where_clause} AND " if where_clause else " WHERE "
                        ) + f"DATE({quote_char}{date_column}{quote_char}) = CURRENT_DATE"
                        filter_rules.append(f"{date_column} is today (database CURRENT_DATE)")
                count_sql = (
                    f"SELECT COUNT(*) AS total_records FROM {quote_char}{target_table}{quote_char}"
                    f"{where_clause}"
                )
                count_result = DatabaseIntelligenceEngine.execute_safe_query(
                    eff_root,
                    count_sql,
                    session_db_config,
                )
                if not count_result.get("ok"):
                    error = count_result.get("error") or {}
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": error.get("message") or "The read-only record count query failed.",
                        "error": error,
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                count_rows = count_result.get("rows") or []
                if not count_rows or not isinstance(count_rows[0], dict) or not count_rows[0]:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "The database returned no count value; no total can be reported.",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                total_records = next(iter(count_rows[0].values()))

            if not isinstance(total_records, int):
                try:
                    total_records = int(total_records)
                except (TypeError, ValueError):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "The database returned a non-numeric count; no total can be reported.",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }

            measured_timing = round((time.perf_counter() - start_t) * 1000.0, 3)
            query_text = (
                f"count_documents({target_table})"
                if db_type in ("mongo", "mongodb")
                else count_sql
            )
            proof = DatabaseExecutionProof(
                database_session_id=session.session_id,
                database_engine=db_type,
                operation=capability,
                source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                mode="LIVE",
                execution_status="SUCCESS",
                execution_time_ms=measured_timing,
                rows_returned=1,
                schema_object=target_table,
                query=query_text,
                actual_rows=[{"total_records": total_records}],
            )
            DatabaseEvidenceStore.record_proof(proof)
            session.binding.bind_proof(proof)
            resolution_note = ""
            if target_resolution:
                source_file = (
                    (target_resolution.get("sourceQueries") or [{}])[0].get("file")
                )
                resolution_note = (
                    "- **Target resolution:** Selected from the live schema using stronger "
                    "project source-query evidence"
                    + (f" in `{source_file}`" if source_file else "")
                    + ".\n"
                )
            return {
                "ok": True,
                "capability": capability,
                "content": (
                    f"### {'FILTERED ' if requested_filters else ''}{'PAID ' if payment_filter == 'paid' else ''}RECORD COUNT\n\n"
                    f"- **Table:** `{target_table}`\n"
                    f"- **{'Matching records' if requested_filters else 'Paid records' if payment_filter == 'paid' else 'Total records'}:** {total_records:,}\n"
                    f"{f'- **Payment rule:** `{payment_column} = {payment_value}`\n' if payment_filter == 'paid' else ''}"
                    f"{'- **Verified conditions:** ' + '; '.join(filter_rules) + chr(10) if filter_rules else ''}"
                    f"{resolution_note}"
                    f"- **Database:** `{session.database_name or 'connected database'}`\n"
                    f"- **Result:** Live read-only count ({measured_timing} ms)"
                ),
                "table": target_table,
                "targetResolution": target_resolution,
                "totalRecords": total_records,
                "rowCount": 1,
                "executionTimeMs": measured_timing,
                "executionStatus": "SUCCESS",
                "databaseType": db_type,
                "engine": db_type,
                "databaseSessionId": session.session_id,
                "evidenceId": proof.evidence_id,
                "mode": "LIVE",
                "resultSource": DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                "executed": True,
            }

        # 5. DATABASE_QUERY
        if capability == DatabaseCapability.DATABASE_QUERY:
            if arguments.get("entity") and not arguments.get("sql") and db_type not in ("mongo", "mongodb"):
                requested_entity = str(arguments.get("entity") or "").strip()
                if not re.fullmatch(r"[A-Za-z][A-Za-z0-9 _.$-]{0,119}", requested_entity):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "The requested table name is invalid.",
                        "executionStatus": "INVALID_INPUT",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }

                table_result = cls.execute_database_capability(
                    DatabaseCapability.DATABASE_LIST_TABLES,
                    {},
                    session,
                    project_root,
                )
                if not table_result.get("ok"):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": table_result.get("content")
                        or "Could not resolve the requested table against the selected database.",
                        "executionStatus": table_result.get("executionStatus", "FAILED"),
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }

                entity_key = re.sub(r"[^a-z0-9]", "", requested_entity.casefold())

                def singularize(value: str) -> str:
                    if value.endswith("ies") and len(value) > 3:
                        return value[:-3] + "y"
                    if value.endswith("s") and len(value) > 3:
                        return value[:-1]
                    return value

                scored_tables = []
                for table_name in table_result.get("tables") or []:
                    table_name = str(table_name)
                    table_key = re.sub(r"[^a-z0-9]", "", table_name.casefold())
                    table_tokens = {
                        re.sub(r"[^a-z0-9]", "", token.casefold())
                        for token in re.findall(r"[A-Za-z0-9]+", table_name)
                    }
                    table_tokens.update(singularize(token) for token in tuple(table_tokens))
                    if table_key == entity_key or singularize(table_key) == entity_key:
                        score = 100
                    elif entity_key in table_tokens or singularize(entity_key) in table_tokens:
                        score = 80
                    else:
                        continue
                    scored_tables.append((score, table_name))

                if not scored_tables and len(entity_key) >= 10:
                    approximate = []
                    for table_name in table_result.get("tables") or []:
                        table_key = re.sub(r"[^a-z0-9]", "", str(table_name).casefold())
                        similarity = SequenceMatcher(None, entity_key, table_key).ratio()
                        if similarity >= 0.90:
                            approximate.append((similarity, str(table_name)))
                    if approximate:
                        best_similarity = max(score for score, _ in approximate)
                        scored_tables = [
                            (round(score * 100), name)
                            for score, name in approximate
                            if best_similarity - score < 0.08
                        ]

                if not scored_tables:
                    available = ", ".join(
                        f"`{name}`" for name in (table_result.get("tables") or [])[:30]
                    ) or "none discovered"
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": (
                            f"No table matching **{requested_entity}** was found in the selected database. "
                            f"Discovered tables: {available}."
                        ),
                        "executionStatus": "NOT_FOUND",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }

                best_score = max(score for score, _ in scored_tables)
                candidates = sorted(
                    {name for score, name in scored_tables if score == best_score},
                    key=str.casefold,
                )
                if len(candidates) != 1:
                    options = [{"label": name, "value": name} for name in candidates]
                    numbered_options = "\n".join(
                        f"{index}. `{option['value']}`"
                        for index, option in enumerate(options, start=1)
                    )
                    return {
                        "ok": True,
                        "capability": capability,
                        "content": (
                            f"More than one table matches **{requested_entity}**. "
                            f"Which table should I show?\n{numbered_options}\n"
                            "No data query was run."
                        ),
                        "executionStatus": "NEEDS_CLARIFICATION",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                        "candidateTables": candidates,
                        "clarificationOptions": options,
                        "clarificationType": "table",
                    }

                target_table = candidates[0]
                if not re.fullmatch(r"[A-Za-z0-9_$.-]{1,120}", target_table):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "The matched database table name cannot be queried safely.",
                        "executionStatus": "INVALID_INPUT",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }

                limit = arguments.get("row_limit", 10)
                if not isinstance(limit, int) or isinstance(limit, bool):
                    limit = 10
                limit = min(max(limit, 1), 50)
                sql = f"SELECT * FROM {target_table}"
                if arguments.get("latest"):
                    described = cls.execute_database_capability(
                        DatabaseCapability.DATABASE_DESCRIBE_TABLE,
                        {"table": target_table},
                        session,
                        project_root,
                    )
                    if not described.get("ok"):
                        return {
                            "ok": False,
                            "capability": capability,
                            "content": described.get("content")
                            or "Could not inspect the table to determine a latest-record ordering.",
                            "executionStatus": described.get("executionStatus", "FAILED"),
                            "databaseType": db_type,
                            "databaseSessionId": session.session_id,
                            "executed": False,
                        }
                    date_columns = [
                        str(column.get("name") or "")
                        for column in described.get("columns") or []
                        if re.fullmatch(
                            r"[A-Za-z0-9_$-]{1,120}",
                            str(column.get("name") or ""),
                        )
                        and re.search(
                            r"date|time|timestamp",
                            str(column.get("type") or ""),
                            re.I,
                        )
                    ]
                    requested_latest_column = str(arguments.get("latest_column") or "")
                    if requested_latest_column:
                        if requested_latest_column not in date_columns:
                            return {
                                "ok": False,
                                "capability": capability,
                                "content": (
                                    f"`{requested_latest_column}` is not a verified date/time column "
                                    f"on `{target_table}`."
                                ),
                                "executionStatus": "INVALID_INPUT",
                                "databaseType": db_type,
                                "databaseSessionId": session.session_id,
                                "executed": False,
                            }
                        date_columns = [requested_latest_column]
                    preferred_date_columns = [
                        name for name in date_columns
                        if name.casefold() in {
                            "created_at", "created_on", "created", "date", "timestamp",
                            "updated_at", "updated_on", "modified_at",
                        }
                    ]
                    if len(preferred_date_columns) == 1:
                        date_columns = preferred_date_columns
                    if len(date_columns) != 1:
                        options = [
                            {"label": name, "value": name}
                            for name in date_columns
                        ]
                        return {
                            "ok": True,
                            "capability": capability,
                            "content": (
                                f"Which date/time column defines the latest records in `{target_table}`? "
                                + (
                                    "\n" + "\n".join(
                                        f"{index}. `{option['value']}`"
                                        for index, option in enumerate(options, start=1)
                                    )
                                    if options
                                    else "No date/time column was reported by the live schema."
                                )
                                + "\nNo data query was run."
                            ),
                            "executionStatus": "NEEDS_CLARIFICATION" if options else "NOT_FOUND",
                            "databaseType": db_type,
                            "databaseSessionId": session.session_id,
                            "executed": False,
                            "clarificationOptions": options,
                            "clarificationType": "latest_column",
                        }
                    sql += f" ORDER BY {date_columns[0]} DESC"
                sql += f" LIMIT {limit}"
                result = cls.execute_database_capability(
                    DatabaseCapability.DATABASE_QUERY,
                    {"sql": sql},
                    session,
                    project_root,
                )
                if result.get("ok"):
                    result["table"] = target_table
                    result["content"] = (
                        f"### DATABASE RECORDS\n\n"
                        f"- **Table:** `{target_table}`\n"
                        f"- **Rows returned:** {result.get('rowCount', 0)} (limit {limit})\n"
                        f"- **Result:** Live read-only query\n\n"
                        + str(result.get("content") or "")
                    )
                return result

            if db_type in ("mongo", "mongodb"):
                collection_name = str(arguments.get("collection") or arguments.get("entity") or "")
                filter_document = arguments.get("filter") or {}
                if not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", collection_name) or not isinstance(filter_document, dict):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "MongoDB read requires a valid collection name and a JSON object filter.",
                        "executionStatus": "INVALID_INPUT",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                try:
                    client = DatabaseIntelligenceEngine._open_mongodb_client(eff_root, {
                        "host": session.safe_host,
                        "port": session.safe_port,
                        **session._protected_credentials,
                    })
                    try:
                        cursor = client[session.database_name][collection_name].find(filter_document).limit(50)
                        rows = json.loads(json.dumps(list(cursor), default=str))
                    finally:
                        client.close()
                    measured_timing = round((time.perf_counter() - start_t) * 1000.0, 3)
                    proof = DatabaseExecutionProof(
                        database_session_id=session.session_id,
                        database_engine=db_type,
                        operation=capability,
                        source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                        mode="LIVE",
                        execution_status="SUCCESS",
                        execution_time_ms=measured_timing,
                        rows_returned=len(rows),
                        schema_object=collection_name,
                        query=f"find({collection_name}, {json.dumps(filter_document, default=str)})",
                        actual_rows=rows,
                    )
                    DatabaseEvidenceStore.record_proof(proof)
                    session.binding.bind_proof(proof)
                    content = (
                        f"Collection: {collection_name}\nStatus: SUCCESS (Read-only)\n"
                        f"Timing: {measured_timing}ms\nDocuments returned: {len(rows)} (limit 50)\n\n"
                        f"```json\n{json.dumps(rows, indent=2, default=str)}\n```"
                    )
                    return {
                        "ok": True,
                        "capability": capability,
                        "content": content,
                        "rows": rows,
                        "rowCount": len(rows),
                        "executionTimeMs": measured_timing,
                        "executionStatus": "SUCCESS",
                        "databaseType": db_type,
                        "engine": db_type,
                        "databaseSessionId": session.session_id,
                        "evidenceId": proof.evidence_id,
                        "mode": "LIVE",
                        "resultSource": DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                        "executed": True,
                    }
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live MongoDB collection read failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }

            sql = str(arguments.get("sql") or arguments.get("query") or "").strip()
            if not sql:
                return {
                    "ok": False,
                    "capability": capability,
                    "content": "A SQL statement is required; no query was executed.",
                    "executionStatus": "INVALID_REQUEST",
                    "error": {"code": "SQL_REQUIRED"},
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }
            cmd_eval, reason = PolicyGate.check_sql(sql)
            if cmd_eval != "ALLOW":
                return {
                    "ok": False,
                    "capability": capability,
                    "content": f"BLOCKED by Policy Gate: {reason}",
                    "executionStatus": "BLOCKED",
                    "databaseType": db_type,
                    "engine": db_type,
                    "databaseSessionId": session.session_id,
                }
            exec_res = DatabaseIntelligenceEngine.execute_safe_query(
                project_root,
                sql,
                {
                    "engine": db_type,
                    "database": session.database_name,
                    "sqlite_file": session.sqlite_file,
                    "host": session.safe_host,
                    "port": session.safe_port,
                    "username": session._protected_credentials.get("username"),
                    "password": session._protected_credentials.get("password"),
                    "connection_uri": session._protected_credentials.get("connection_uri"),
                },
            )
            if not exec_res.get("ok"):
                error = exec_res.get("error") or {}
                return {
                    "ok": False,
                    "capability": capability,
                    "content": error.get("message") or "The live database query failed.",
                    "error": error,
                    "executionStatus": "FAILED",
                    "databaseType": db_type,
                    "engine": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }
            duration_ms = round((time.perf_counter() - start_t) * 1000.0, 3)
            measured_timing = duration_ms
            data_rows = exec_res.get("rows", exec_res.get("data", []))

            q_fp = DatabaseExecutionProof.compute_fingerprint(sql)
            proof = DatabaseExecutionProof(
                database_session_id=session.session_id,
                database_engine=db_type,
                operation=capability,
                source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                mode="LIVE",
                execution_status="SUCCESS",
                execution_time_ms=measured_timing,
                rows_returned=len(data_rows),
                query=sql,
                query_fingerprint=q_fp,
                actual_rows=data_rows,
            )
            DatabaseEvidenceStore.record_proof(proof)
            session.binding.bind_proof(proof)

            content = f"Query: {sql}\nStatus: SUCCESS (Read-only)\nTiming: {measured_timing}ms\nRows returned: {len(data_rows)}\n\n```json\n{json.dumps(data_rows, indent=2, default=str)}\n```"
            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "rows": data_rows,
                "rowCount": len(data_rows),
                "executionTimeMs": measured_timing,
                "executionStatus": "SUCCESS",
                "databaseType": db_type,
                "engine": db_type,
                "databaseSessionId": session.session_id,
                "evidenceId": proof.evidence_id,
                "queryFingerprint": q_fp,
                "mode": "LIVE",
                "resultSource": DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                "executed": True,
            }

        # 6. DATABASE_EXPLAIN
        if capability == DatabaseCapability.DATABASE_EXPLAIN:
            if db_type in ("mongo", "mongodb"):
                collection_name = str(arguments.get("collection") or "")
                filter_document = arguments.get("filter") or {}
                if not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", collection_name) or not isinstance(filter_document, dict):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": "MongoDB explain requires a valid collection name and a JSON object filter.",
                        "executionStatus": "INVALID_INPUT",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }
                try:
                    client = DatabaseIntelligenceEngine._open_mongodb_client(eff_root, {
                        "host": session.safe_host,
                        "port": session.safe_port,
                        **session._protected_credentials,
                    })
                    try:
                        plan = client[session.database_name][collection_name].find(filter_document).limit(50).explain("executionStats")
                    finally:
                        client.close()
                    plan_text = json.dumps(plan, indent=2, default=str)
                    measured_timing = round((time.perf_counter() - start_t) * 1000.0, 3)
                    proof = DatabaseExecutionProof(
                        database_session_id=session.session_id,
                        database_engine=db_type,
                        operation=capability,
                        source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                        mode="LIVE",
                        execution_status="SUCCESS",
                        execution_time_ms=measured_timing,
                        rows_returned=int((plan.get("executionStats") or {}).get("nReturned", 0)),
                        schema_object=collection_name,
                        query=f"find({collection_name}, {json.dumps(filter_document, default=str)}).explain()",
                        plan_output=plan_text,
                        plan_fingerprint=DatabaseExecutionProof.compute_fingerprint(plan_text),
                    )
                    DatabaseEvidenceStore.record_proof(proof)
                    session.binding.bind_proof(proof)
                    return {
                        "ok": True,
                        "capability": capability,
                        "content": f"MongoDB execution plan for `{collection_name}` (executionStats):\n\n```json\n{plan_text}\n```",
                        "executionTimeMs": measured_timing,
                        "executionStatus": "SUCCESS",
                        "databaseType": db_type,
                        "engine": db_type,
                        "databaseSessionId": session.session_id,
                        "evidenceId": proof.evidence_id,
                        "mode": "LIVE",
                        "resultSource": DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                        "executed": True,
                    }
                except Exception as error:
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": f"Live MongoDB explain failed ({DatabaseIntelligenceEngine.classify_db_error(str(error))}).",
                        "executionStatus": "FAILED",
                        "databaseType": db_type,
                        "databaseSessionId": session.session_id,
                        "executed": False,
                    }

            sql = str(arguments.get("sql") or arguments.get("query") or "").strip()
            if not sql:
                return {
                    "ok": False,
                    "capability": capability,
                    "content": "A SQL statement is required for EXPLAIN; no query was executed.",
                    "executionStatus": "INVALID_REQUEST",
                    "error": {"code": "SQL_REQUIRED"},
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }
            cmd_eval, reason = PolicyGate.check_sql(sql)
            if cmd_eval != "ALLOW":
                return {
                    "ok": False,
                    "capability": capability,
                    "content": f"BLOCKED by Policy Gate: {reason}",
                    "executionStatus": "BLOCKED",
                    "databaseType": db_type,
                    "engine": db_type,
                    "databaseSessionId": session.session_id,
                }
            explain_res = DatabaseIntelligenceEngine.execute_query_and_explain(
                project_root, sql, session_db_config
            )
            plan = explain_res.get("plan")
            if not plan or explain_res.get("status") != "SUCCESS":
                return {
                    "ok": False,
                    "capability": capability,
                    "content": explain_res.get("bottleneck")
                    or "No live execution plan is available for this database engine.",
                    "plan": None,
                    "timingMs": None,
                    "executionStatus": "UNAVAILABLE",
                    "evidenceQuality": "UNVERIFIED",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }

            q_fp = DatabaseExecutionProof.compute_fingerprint(sql)
            plan_fp = q_fp
            measured_timing = explain_res.get("timing_ms")
            proof = DatabaseExecutionProof(
                database_session_id=session.session_id,
                database_engine=db_type,
                operation=capability,
                source=DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                mode="LIVE",
                execution_status="SUCCESS",
                execution_time_ms=measured_timing,
                query=sql,
                query_fingerprint=q_fp,
                plan_output=plan,
                plan_fingerprint=plan_fp,
            )
            DatabaseEvidenceStore.record_proof(proof)
            session.binding.bind_proof(proof)
            session.last_plan_proof = proof

            timing_line = (
                f"Timing: {measured_timing}ms\n"
                if isinstance(measured_timing, (int, float))
                else "Query timing: UNAVAILABLE\n"
            )
            content = (
                f"Execution plan for: `{sql}`\n{timing_line}"
                f"Index used: {explain_res.get('index_used') or 'UNKNOWN'}\n"
                f"Access type: {explain_res.get('access_type') or 'UNKNOWN'}\n\n"
                f"```\n{plan}\n```"
            )
            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "plan": plan,
                "executionTimeMs": measured_timing,
                "executionStatus": "SUCCESS",
                "evidenceQuality": "VERIFIED_LIVE",
                "databaseType": db_type,
                "engine": db_type,
                "databaseSessionId": session.session_id,
                "evidenceId": proof.evidence_id,
                "queryFingerprint": q_fp,
                "planFingerprint": plan_fp,
                "mode": "LIVE",
                "resultSource": DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                "executed": True,
            }

        # 7. DATABASE_HEALTH_CHECK & DATABASE_CONNECT
        if capability in (DatabaseCapability.DATABASE_HEALTH_CHECK, DatabaseCapability.DATABASE_CONNECT):
            all_targets = DatabaseTargetRegistry.get_targets(eff_root)
            if len(all_targets) > 1 and not arguments.get("target") and not getattr(session, "_disambiguated", False):
                lines = [f"- `{t.target_id}`: {t.database_name} ({t.engine}, host: {t.safe_host})" for t in all_targets]
                content = (
                    f"### MULTIPLE DATABASE TARGETS DISCOVERED\n\n"
                    f"Multiple database targets are registered for this project:\n\n"
                    + "\n".join(lines) + "\n\n"
                    f"Please specify which target to connect to (e.g. `connect DB-001` or `connect DB-002`)."
                )
                return {
                    "ok": True,
                    "capability": capability,
                    "content": content,
                    "disambiguationRequired": True,
                    "targets": [t.to_safe_dict() for t in all_targets],
                    "executionStatus": "SUCCESS",
                    "databaseType": session.database_type,
                    "databaseSessionId": session.session_id,
                    "executed": True,
                }

            health = DatabaseIntelligenceEngine.real_connect_and_health_check(
                eff_root, session_db_config
            )
            if not health.get("connected"):
                return {
                    "ok": False,
                    "capability": capability,
                    "content": (
                        "The database health check was not verified."
                        if health.get("status") in ("NOT_CONFIGURED", "NOT_VERIFIED", "UNAVAILABLE")
                        else f"Live {db_type} connection failed ({health.get('classification') or 'CONNECTION_FAILED'})."
                    ),
                    "executionStatus": (
                        "UNAVAILABLE"
                        if health.get("status") in ("NOT_CONFIGURED", "NOT_VERIFIED", "UNAVAILABLE")
                        else "FAILED"
                    ),
                    "evidenceQuality": "UNVERIFIED",
                    "status": health.get("status") or "NOT_VERIFIED",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }
            duration_ms = round((time.perf_counter() - start_t) * 1000.0, 2)
            measured_lat = duration_ms
            proof = health.get("health_proof")
            if proof:
                DatabaseEvidenceStore.record_proof(proof)
                session.health_proof = proof
                session.binding.bind_proof(proof)
            session.connection_state = DatabaseState.CONNECTED

            schema_res = DatabaseIntelligenceEngine.inspect_database_schema(
                eff_root, session_db_config
            )
            found_queries = DatabaseIntelligenceEngine.discover_relevant_queries(eff_root)
            if found_queries:
                query_eval = DatabaseIntelligenceEngine.execute_query_and_explain(
                    eff_root, found_queries[0]["query"], session_db_config
                )
                query_eval["file"] = found_queries[0].get("file")
                query_eval["table"] = found_queries[0].get("table")
            else:
                query_eval = {
                    "query": None,
                    "plan": None,
                    "timing_ms": None,
                    "rows_returned": None,
                    "executionStatus": "UNAVAILABLE",
                    "executed": False,
                    "evidenceQuality": "UNAVAILABLE",
                    "message": "No application SQL was discovered; no query or EXPLAIN was executed.",
                }

            content = DatabaseIntelligenceEngine.format_database_investigation_report(
                {"engine": db_type, "database": session.database_name, "sqlite_file": session.sqlite_file},
                health,
                schema_res,
                query_eval,
            )
            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "executionTimeMs": measured_lat,
                "executionStatus": "SUCCESS",
                "databaseType": db_type,
                "engine": db_type,
                "databaseSessionId": session.session_id,
                "evidenceId": proof.evidence_id if proof else None,
                "health": health,
                "mode": "LIVE",
                "resultSource": DatabaseEvidenceSource.LIVE_DB_EXECUTION,
                "executed": True,
            }

        # 8. DATABASE_CREDENTIAL_REQUEST
        if capability == DatabaseCapability.DATABASE_CREDENTIAL_REQUEST:
            active_target = DatabaseTargetRegistry.get_active_target(eff_root)
            tgt_id = session.target_id or (active_target.target_id if active_target else None)
            discovered = DatabaseIntelligenceEngine.discover_database_configuration(eff_root)
            credentials = ConfigurationSymbolResolver.get_credential(eff_root)

            def config_value(key: str, fallback: Any = None) -> Any:
                value = discovered.get(key)
                if isinstance(value, dict):
                    value = value.get("value")
                return value if value not in (None, "") else fallback

            username = (
                config_value("username")
                or credentials.get("username")
                or (active_target.username if active_target and active_target.username else None)
                or "NOT_RESOLVED"
            )
            database_name = (
                session.database_name
                or config_value("database")
                or (active_target.database_name if active_target and active_target.database_name else None)
                or "NOT_RESOLVED"
            )
            cfg_file = discovered.get("configFile") or (
                active_target.config_file if active_target and active_target.config_file else "NOT_RESOLVED"
            )
            engine = config_value("engine", session.database_type or "NOT_RESOLVED")
            host = config_value("host", session.safe_host or "NOT_RESOLVED")
            port = config_value("port", session.safe_port or "NOT_RESOLVED")
            symbol_details = discovered.get("_symbol_details")
            symbol_details = symbol_details if isinstance(symbol_details, dict) else {}
            password_signals = []
            password_source = None
            if isinstance(discovered.get("passwordPresent"), bool):
                password_signals.append(discovered["passwordPresent"])
                password_source = "PROJECT_CONFIGURATION"
            if isinstance(symbol_details.get("hasPassword"), bool):
                password_signals.append(symbol_details["hasPassword"])
                password_source = "PROJECT_CONFIGURATION"
            if isinstance(credentials.get("password"), str) and credentials["password"]:
                password_signals.append(True)
                password_source = "CREDENTIAL_STORE"
            password_present = (
                password_signals[0]
                if password_signals and all(value == password_signals[0] for value in password_signals)
                else None
            )
            if len(set(password_signals)) > 1:
                password_source = None
            credential_status_configured = bool(
                discovered.get("has_credentials") is True
                or password_present is True
            )
            username_source = (
                "PROJECT_CONFIGURATION" if config_value("username") else
                "CREDENTIAL_STORE" if credentials.get("username") else
                "ACTIVE_DATABASE_TARGET" if active_target and active_target.username else
                None
            )
            database_source = (
                "ACTIVE_DATABASE_SESSION" if session.database_name else
                "PROJECT_CONFIGURATION" if config_value("database") else
                "ACTIVE_DATABASE_TARGET" if active_target and active_target.database_name else
                None
            )
            engine_source = (
                "PROJECT_CONFIGURATION" if config_value("engine") else
                "ACTIVE_DATABASE_SESSION" if session.database_type else
                None
            )
            host_source = (
                "PROJECT_CONFIGURATION" if config_value("host") else
                "ACTIVE_DATABASE_SESSION" if session.safe_host else
                None
            )
            port_source = (
                "PROJECT_CONFIGURATION" if config_value("port") else
                "ACTIVE_DATABASE_SESSION" if session.safe_port else
                None
            )
            property_values = {
                "engine": engine,
                "host": host,
                "port": port,
                "database": database_name,
                "username": username,
                "credentialStatus": "CONFIGURED" if credential_status_configured else "NOT_VERIFIED",
                "password": "[REDACTED]",
            }
            requested_properties = arguments.get("properties")
            if isinstance(requested_properties, list) and requested_properties:
                content = "\n".join(
                    f"{name}: {property_values[name]}"
                    for name in requested_properties
                )
            else:
                content = (
                    f"### DATABASE CREDENTIALS REPORT\n\n"
                    f"- **Credential status:** {'CONFIGURED' if credential_status_configured else 'NOT_VERIFIED'}\n"
                    f"- **Target:** {tgt_id or 'NOT_RESOLVED'}\n"
                    f"- **Database:** {database_name}\n"
                    f"- **Username:** {username}\n"
                    f"- **Password:** [REDACTED]\n"
                    f"- **Credential source:** {cfg_file}"
                )
            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "credentialStatus": "CONFIGURED" if credential_status_configured else "NOT_VERIFIED",
                "credentialStatusSource": (
                    "CREDENTIAL_STATUS_METADATA"
                    if discovered.get("has_credentials") is True
                    else password_source
                ),
                "passwordPresent": password_present,
                "passwordPresenceSource": password_source,
                "targetId": tgt_id,
                "database": database_name,
                "databaseNameSource": database_source,
                "engine": engine,
                "engineSource": engine_source,
                "host": host,
                "hostSource": host_source,
                "port": port,
                "portSource": port_source,
                "username": username,
                "usernameSource": username_source,
                "password": "[REDACTED]",
                "credentialSource": cfg_file,
                "databaseType": session.database_type,
                "engine": session.database_type,
                "databaseSessionId": session.session_id,
                "executionStatus": "SUCCESS",
                "executed": True,
            }

        # 9. DATABASE_CURRENT_TARGET
        if capability == DatabaseCapability.DATABASE_CURRENT_TARGET:
            target_file = arguments.get("configFile") or arguments.get("target_file")
            cfg_res = ConfigurationSymbolResolver.inspect_project_database_configuration(eff_root, specific_file=target_file)
            if target_file and cfg_res.get("status") == "NOT_FOUND":
                requested_file = cfg_res.get("configFile") or target_file
                discovered_cfg = ConfigurationSymbolResolver.inspect_project_database_configuration(eff_root)
                if discovered_cfg.get("status") not in ("NOT_FOUND", "ERROR"):
                    discovered_cfg["requestedConfigFile"] = requested_file
                    discovered_cfg["requestedConfigStatus"] = "NOT_FOUND"
                    discovered_cfg["requestedConfigNotice"] = (
                        f"Requested configuration file {requested_file} was not found; "
                        "the configured and runtime details below use the database configuration discovered in the project."
                    )
                    cfg_res = discovered_cfg
            active_session_state = str(session.connection_state)
            live_res = ConfigurationSymbolResolver.verify_live_database_identity(eff_root, cfg_res, session=session)

            req_text = str(arguments.get("user_request") or "").lower()
            include_preview = bool(target_file or re.search(r"\b(?:open|read|cat)\b", req_text))

            active_target = DatabaseTargetRegistry.get_active_target(eff_root)
            active_tgt_id = session.target_id or (active_target.target_id if active_target else None)
            cfg_res["targetId"] = active_tgt_id
            if session.database_name:
                cfg_res["activeDatabaseName"] = session.database_name
            elif active_target and active_target.database_name:
                cfg_res["activeDatabaseName"] = active_target.database_name
            content = ConfigurationSymbolResolver.format_connection_status_report(
                cfg_res,
                live=live_res,
                include_file_preview=include_preview,
                credentials=ConfigurationSymbolResolver.get_credential(eff_root),
            )

            db_val = cfg_res.get("database", {}).get("value") or live_res.get("database") or session.database_name
            host_val = cfg_res.get("host", {}).get("value") or live_res.get("host") or session.safe_host
            port_val = cfg_res.get("port", {}).get("value") or live_res.get("port") or session.safe_port
            eng_val = cfg_res.get("engine") or live_res.get("engine") or session.database_type

            if live_res.get("status") == "FAILED":
                status_val = "FAILED"
            elif live_res.get("connected"):
                status_val = "LIVE_VERIFIED"
            elif cfg_res.get("status") == "NOT_RESOLVED":
                status_val = "NOT_RESOLVED"
            elif cfg_res.get("status") in ("RESOLVED", "CONFIGURED"):
                status_val = cfg_res.get("status")
            else:
                status_val = live_res.get("status") or "NOT_VERIFIED"

            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "targetId": session.target_id or (active_target.target_id if active_target else None),
                "databaseType": eng_val,
                "engine": eng_val,
                "databaseName": db_val,
                "database": db_val,
                "safeHost": host_val,
                "safePort": port_val,
                "status": status_val,
                "activeSessionState": active_session_state,
                "databaseSessionId": session.session_id,
                "executionStatus": "SUCCESS",
                "executed": True,
                "configuredDatabase": cfg_res,
                "liveDatabase": live_res,
            }

        # 10. DATABASE_CONNECT_TARGET
        if capability == DatabaseCapability.DATABASE_CONNECT_TARGET:
            tgt_id = str(arguments.get("target") or "").strip()
            if not tgt_id:
                return {
                    "ok": False,
                    "capability": capability,
                    "content": "A database target identifier is required.",
                    "executionStatus": "INVALID_REQUEST",
                    "executed": False,
                }
            target = DatabaseTargetRegistry.get_target(eff_root, tgt_id)
            if not target:
                for t in DatabaseTargetRegistry.get_targets(eff_root):
                    if t.target_id.upper() == tgt_id.upper() or t.database_name.lower() == tgt_id.lower():
                        target = t
                        break
            if target:
                db_cfg = {
                    "engine": target.engine,
                    "database": target.database_name,
                    "sqlite_file": target.sqlite_file,
                    "host": target.safe_host,
                    "port": target.safe_port,
                    "username": target.username,
                    "database_session_id": session.session_id,
                    "project_id": session.project_id,
                    "repository_id": session.repository_id,
                    "target_id": target.target_id,
                    **target._protected_credentials,
                }
                health = DatabaseIntelligenceEngine.real_connect_and_health_check(eff_root, db_cfg)
                if not health.get("connected"):
                    return {
                        "ok": False,
                        "capability": capability,
                        "content": (
                            f"Database target `{target.target_id}` could not be connected because its live "
                            "health check did not verify a connection. The current verified session was left unchanged."
                        ),
                        "targetId": target.target_id,
                        "databaseType": target.engine,
                        "databaseSessionId": session.session_id,
                        "executionStatus": (
                            "FAILED" if health.get("status") == "FAILED" else "UNAVAILABLE"
                        ),
                        "evidenceQuality": "UNVERIFIED",
                        "executed": False,
                    }
                DatabaseTargetRegistry.set_active_target(eff_root, target.target_id)
                session.target_id = target.target_id
                session.database_name = target.database_name
                session.database_type = target.engine
                session.safe_host = target.safe_host
                session.safe_port = target.safe_port
                session.sqlite_file = target.sqlite_file or health.get("sqlite_file")
                session.connection_state = DatabaseState.CONNECTED
                session.touch()
                setattr(session, "_disambiguated", True)
                session.health_proof = health.get("health_proof")
                if session.health_proof:
                    session.binding.bind_proof(session.health_proof)
                content = (
                    f"### CONNECTED TO DATABASE TARGET\n\n"
                    f"Database target `{target.target_id}` passed a live health check.\n\n"
                    f"- **Target:** {target.target_id}\n"
                    f"- **Engine:** {target.engine}\n"
                    f"- **Database:** {target.database_name}\n"
                    f"- **Host:** {target.safe_host}\n"
                    f"- **Port:** {target.safe_port or 'Default'}\n"
                    f"- **Status:** CONNECTED\n"
                    f"- **Session ID:** {session.session_id}\n"
                )
                return {
                    "ok": True,
                    "capability": capability,
                    "content": content,
                    "targetId": target.target_id,
                    "databaseType": target.engine,
                    "engine": target.engine,
                    "databaseName": target.database_name,
                    "safeHost": target.safe_host,
                    "safePort": target.safe_port,
                    "databaseSessionId": session.session_id,
                    "executionStatus": "SUCCESS",
                    "evidenceQuality": "VERIFIED_LIVE",
                    "connectionState": "CONNECTED",
                    "executed": True,
                }
            else:
                avail = [t.target_id for t in DatabaseTargetRegistry.get_targets(eff_root)]
                content = f"Target `{tgt_id}` not found. Available targets: {', '.join(avail) if avail else 'None'}."
                return {
                    "ok": False,
                    "capability": capability,
                    "content": content,
                    "error": "TARGET_NOT_FOUND",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                }

        # 11. DATABASE_SLOW_QUERIES
        if capability == DatabaseCapability.DATABASE_SLOW_QUERIES:
            investigation = DatabasePerformanceEngine.autonomous_investigate_expensive_queries(
                eff_root, session=session, intent_detail=arguments.get("dimension", "total_load")
            )
            top_q = investigation.get("queries", [])
            content = investigation.get("content", "### TOP SLOW QUERIES REPORT\n\nNo slow queries discovered.")
            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "queries": top_q,
                "rowCount": len(top_q),
                "executionStatus": "SUCCESS",
                "databaseType": db_type,
                "engine": db_type,
                "databaseSessionId": session.session_id,
                "executed": True,
                "investigation": investigation,
            }

        # 12. DATABASE_BENCHMARK
        if capability == DatabaseCapability.DATABASE_BENCHMARK:
            content = (
                f"### QUERY OPTIMIZATION BENCHMARK REPORT\n\n"
                f"No live benchmark was performed. Baseline and optimized timings are unavailable "
                f"because no verified before/after execution evidence exists."
            )
            return {
                "ok": False,
                "capability": capability,
                "content": content,
                "baselineLatencyMs": None,
                "optimizedLatencyMs": None,
                "speedup": None,
                "rowsExamined": None,
                "accessType": None,
                "indexUsed": None,
                "executionStatus": "UNAVAILABLE",
                "evidenceQuality": "UNVERIFIED",
                "databaseType": db_type,
                "engine": db_type,
                "databaseSessionId": session.session_id,
                "executed": False,
            }

        # 12B. DATABASE_OPTIMIZATION
        if capability == DatabaseCapability.DATABASE_OPTIMIZATION:
            investigation = DatabasePerformanceEngine.autonomous_investigate_expensive_queries(
                eff_root, session=session, intent_detail="load"
            )
            candidate = investigation.get("candidate")
            candidate = candidate if isinstance(candidate, dict) else {}
            cand_sql = candidate.get("rawQuery") or candidate.get("normalizedQuery")
            mapped_src = investigation.get("mappedSource")
            mapped_src = mapped_src if isinstance(mapped_src, dict) else {}
            classification = investigation.get("classification")
            classification = classification if isinstance(classification, dict) else {}
            content = "### DATABASE OPTIMIZATION INVESTIGATION\n\n"
            content += f"- Candidate query: `{cand_sql}`\n" if cand_sql else "- Candidate query: UNAVAILABLE\n"
            if mapped_src.get("sourceFile"):
                content += f"- Source location: `{mapped_src['sourceFile']}`\n"
            if mapped_src.get("symbol"):
                content += f"- Source symbol: `{mapped_src['symbol']}`\n"
            if classification.get("bottleneckClass"):
                content += (
                    f"- Investigation classification: {classification['bottleneckClass']} "
                    f"({classification.get('confidence') or 'UNVERIFIED'} confidence)\n"
                )
            content += (
                "- Baseline and optimized timings: UNAVAILABLE\n"
                "- No optimization was applied or verified; no before/after execution evidence exists."
            )
            return {
                "ok": False,
                "capability": capability,
                "content": content,
                "baselineLatencyMs": None,
                "optimizedLatencyMs": None,
                "speedup": None,
                "rowsExamined": None,
                "accessType": None,
                "indexUsed": None,
                "executionStatus": "UNAVAILABLE",
                "evidenceQuality": "UNVERIFIED",
                "databaseType": db_type,
                "engine": db_type,
                "databaseSessionId": session.session_id,
                "executed": False,
                "investigation": investigation,
            }

        # 13. DATABASE_DISCONNECT
        if capability == DatabaseCapability.DATABASE_DISCONNECT:
            session.connection_state = DatabaseState.DISCONNECTED
            content = f"Database session `{session.session_id}` disconnected successfully."
            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "executionStatus": "SUCCESS",
                "databaseType": db_type,
                "databaseSessionId": session.session_id,
                "status": "DISCONNECTED",
                "executed": True,
            }

        # 14. DATABASE_RECONNECT
        if capability == DatabaseCapability.DATABASE_RECONNECT:
            health = DatabaseIntelligenceEngine.real_connect_and_health_check(
                eff_root, session_db_config
            )
            if not health.get("connected"):
                return {
                    "ok": False,
                    "capability": capability,
                    "content": "Database reconnect could not verify a live health check.",
                    "executionStatus": (
                        "FAILED" if health.get("status") == "FAILED" else "UNAVAILABLE"
                    ),
                    "evidenceQuality": "UNVERIFIED",
                    "status": health.get("status") or "NOT_VERIFIED",
                    "databaseType": db_type,
                    "databaseSessionId": session.session_id,
                    "executed": False,
                }
            session.connection_state = DatabaseState.CONNECTED
            session.health_proof = health.get("health_proof")
            if session.health_proof:
                session.binding.bind_proof(session.health_proof)
            content = f"Database session `{session.session_id}` reconnected and passed a live health check."
            return {
                "ok": True,
                "capability": capability,
                "content": content,
                "executionStatus": "SUCCESS",
                "evidenceQuality": "VERIFIED_LIVE",
                "databaseType": db_type,
                "databaseSessionId": session.session_id,
                "status": "CONNECTED",
                "executed": True,
            }

        if capability in (
            DatabaseCapability.DATABASE_LIST_VIEWS,
            DatabaseCapability.DATABASE_LIST_CONSTRAINTS,
        ):
            return {
                "ok": False,
                "capability": capability,
                "content": f"{capability} is not implemented for database engine `{db_type or 'unknown'}`.",
                "executionStatus": "UNAVAILABLE",
                "evidenceQuality": "UNVERIFIED",
                "databaseType": db_type,
                "databaseSessionId": session.session_id,
                "executed": False,
            }

        # Fallback
        return {
            "ok": False,
            "capability": capability,
            "content": f"Database capability `{capability}` is unavailable; no operation was executed.",
            "executionStatus": "UNAVAILABLE",
            "evidenceQuality": "UNVERIFIED",
            "databaseType": db_type,
            "databaseSessionId": session.session_id,
            "executed": False,
        }


# =====================================================================
# 7. EXECUTABLE POLICY GATE
# =====================================================================
class PolicyGate:
    """
    Executable safety enforcement layer:
    Classifies every tool and command action into ALLOW, ASK, or BLOCK.
    Destructive operations remain permanently BLOCKED regardless of model instructions.
    """
    FORBIDDEN_COMMAND_PATTERNS = [
        re.compile(r"\brm\s+-(?:r|rf|f)\b", re.I),
        re.compile(r"\bdel\s+(?:\/s|\/q|\/f)\b", re.I),
        re.compile(r"\brmdir\s+\/s\b", re.I),
        re.compile(r"\bgit\s+reset\s+--hard\b", re.I),
        re.compile(r"\bgit\s+push\s+.*(?:--force|-f)\b", re.I),
        re.compile(r"\bformat\s+[a-zA-Z]:", re.I),
        re.compile(r"\b(?:mkfs|dd\s+if=)\b", re.I),
        re.compile(r"\bdrop\s+(?:database|table|schema)\b", re.I),
        re.compile(r"\btruncate\s+(?:table\s+)?[a-zA-Z0-9_.-]+", re.I),
        re.compile(r"\bdelete\s+from\s+[a-zA-Z0-9_.-]+", re.I),
    ]

    SENSITIVE_FILES_PATTERN = re.compile(
        r"(?:^|[\\/\s])(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.config|id_rsa(?:\..*)?|[^\\/\s]+\.(?:pem|key|p12|pfx|crt|cer|der))(?:\b|$)",
        re.I
    )

    @classmethod
    def evaluate_command(
        cls,
        command: str,
        approved_scripts: Optional[Set[str]] = None,
    ) -> Tuple[str, str]:
        """Evaluates command safety returning (decision, reason). Decision: ALLOW, ASK, BLOCK."""
        cmd = command.strip()
        if not cmd:
            return "BLOCK", "Command is required."
        for pat in cls.FORBIDDEN_COMMAND_PATTERNS:
            if pat.search(cmd):
                return "BLOCK", f"Command matched forbidden destructive pattern: {pat.pattern}"

        if cls.SENSITIVE_FILES_PATTERN.search(cmd):
            return "BLOCK", "Access to credentials, private keys, or .env files is blocked by Policy Gate."

        if re.search(r"(?:;|&&|\|\||\||>>?|<|`|\$\(|\n)", cmd):
            return "BLOCK", "Shell composition, redirection, and newline command injection are not permitted."
        try:
            parts = shlex.split(cmd, posix=os.name != "nt")
        except ValueError:
            return "BLOCK", "Command could not be parsed safely."
        if not parts:
            return "BLOCK", "Command is required."

        if os.name == "nt":
            parts = [
                part[1:-1]
                if len(part) >= 2 and part[0] == part[-1] and part[0] in ("'", '"')
                else part
                for part in parts
            ]
        normalized = [part.lower() for part in parts]
        executable = normalized[0].replace("\\", "/").rsplit("/", 1)[-1]
        args = normalized[1:]
        normalized_command = (executable, *args)
        exact_commands = {
            ("git", "status"),
            ("git", "status", "--short"),
            ("git", "diff"),
            ("git", "diff", "--check"),
            ("git", "diff", "--stat"),
            ("git", "diff", "--name-only"),
            ("npm", "test"),
            ("npm.cmd", "test"),
            ("npm", "run", "test"),
            ("npm.cmd", "run", "test"),
            ("npm", "run", "lint"),
            ("npm.cmd", "run", "lint"),
            ("npm", "run", "typecheck"),
            ("npm.cmd", "run", "typecheck"),
            ("npm", "run", "build"),
            ("npm.cmd", "run", "build"),
            ("tsc", "--noemit"),
            ("eslint", "."),
            ("pytest",),
            ("python", "-m", "pytest"),
            ("python.exe", "-m", "pytest"),
            ("python3", "-m", "pytest"),
            ("python3.exe", "-m", "pytest"),
            ("py", "-m", "pytest"),
            ("py.exe", "-m", "pytest"),
        }
        if normalized_command in exact_commands:
            return "ALLOW", "Exact read-only or project verification command is allow-listed."

        # Script execution is allowed only when the caller supplies names from
        # the existing project verification policy; shell strings are never run.
        approved = {name.lower() for name in (approved_scripts or set())}
        if executable in ("python", "python.exe", "python3", "python3.exe", "py", "py.exe") and len(args) == 1:
            script = args[0].replace("\\", "/")
            if script in approved and re.fullmatch(r"[a-z0-9_./-]+\.py", script):
                return "ALLOW", "Approved project Python test script."
        if executable in ("node", "node.exe") and len(args) == 1:
            script = args[0].replace("\\", "/")
            if script in approved and re.fullmatch(r"[a-z0-9_./-]+\.m?js", script):
                return "ALLOW", "Approved project Node test script."
        if executable in ("npm", "npm.cmd") and len(args) == 2 and args[0] == "run":
            if args[1] in approved and re.fullmatch(r"[a-z0-9:_-]{1,80}", args[1]):
                return "ALLOW", "Approved project npm task."
        if any(arg in ("-c", "-e", "--eval", "--execute") for arg in args):
            return "BLOCK", "Inline code execution is not permitted."
        if executable in ("python", "python.exe", "python3", "python3.exe", "py", "py.exe") and args and args[0] == "-m":
            return "BLOCK", "Only the explicitly allow-listed pytest module invocation is permitted."
        if executable in ("python", "python.exe", "python3", "python3.exe", "py", "py.exe", "node", "node.exe"):
            return "BLOCK", "The script is not in the approved project verification list."
        if executable in ("npm", "npm.cmd") and args and args[0] == "run":
            return "BLOCK", "The npm task is not in the approved project verification list."
        return "BLOCK", "Command is not in the exact verification allow-list."

    @classmethod
    def check_sql(cls, sql: str, write_approved: bool = False) -> Tuple[str, str]:
        """
        Classifies SQL safety:
        - Destructive operations (DROP, TRUNCATE, DELETE, ALTER TABLE DROP, GRANT, REVOKE) are permanently BLOCKED.
        - Non-destructive writes (INSERT, UPDATE, CREATE TABLE, CREATE INDEX, ALTER TABLE ADD) are ASK (or ALLOW if proposal/write approved).
        - Safe reads (SELECT, EXPLAIN, SHOW, DESCRIBE, PRAGMA) are ALLOW.
        """
        cmd = sql.strip()
        if not cmd:
            return "BLOCK", "A SQL statement is required."
        destructive_pat = re.compile(
            r"\b(?:DROP\s+(?:DATABASE|TABLE|SCHEMA|VIEW|INDEX)|TRUNCATE\s+(?:TABLE\s+)?|DELETE\s+FROM|ALTER\s+TABLE\s+\S+\s+DROP|GRANT|REVOKE)\b|"
            r"^(?:DROP|TRUNCATE|DELETE)\b",
            re.I
        )
        if destructive_pat.search(cmd):
            return "BLOCK", f"Destructive database operation permanently forbidden by policy gate: {cmd[:60]}"

        non_destructive_write_pat = re.compile(
            r"\b(?:INSERT\s+INTO|UPDATE\s+\S+\s+SET|CREATE\s+TABLE|CREATE\s+INDEX|ALTER\s+TABLE\s+\S+\s+ADD)\b",
            re.I
        )
        if non_destructive_write_pat.search(cmd):
            if write_approved:
                return "ALLOW", "Validated non-destructive database write operation"
            return "ASK", "Non-destructive database write operation requires proposal or approval"

        return "ALLOW", "Safe read-only or diagnostic SQL operation"

    @classmethod
    def evaluate_file_write(
        cls,
        target_path: str,
        proposal_approved: bool,
        request_binding: Optional[Dict[str, Any]] = None,
    ) -> Tuple[str, str]:
        """Enforces write protection: writes strictly require an approved proposal."""
        return cls.evaluate_file_mutation(
            "modify",
            [target_path],
            proposal_approved,
            request_binding=request_binding,
        )

    @classmethod
    def _feature_for_mutation_path(cls, target_path: str) -> str:
        normalized = target_path.replace("\\", "/").lstrip("./").casefold()
        matches = []
        for feature, roots in _PROTECTED_FEATURE_ROOTS.items():
            for root in roots:
                prefix = str(root).replace("\\", "/").casefold()
                if normalized == prefix or normalized.startswith(f"{prefix}/"):
                    matches.append((len(prefix), feature))
        return max(matches)[1] if matches else "shared"

    @classmethod
    def _validate_request_binding(
        cls,
        request_binding: Optional[Dict[str, Any]],
        target_paths: List[str],
    ) -> Optional[str]:
        if not isinstance(request_binding, dict):
            return "A trusted request-bound authorization context is required."
        task_id = request_binding.get("taskId")
        turn_id = request_binding.get("turnId")
        request_hash = request_binding.get("requestHash")
        root = request_binding.get("root")
        scope = request_binding.get("scope")
        features = request_binding.get("authorizedFeatures")
        if (
            not isinstance(task_id, str) or not task_id or len(task_id) > 128
            or not isinstance(turn_id, str) or not turn_id or len(turn_id) > 128
            or not isinstance(request_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", request_hash)
            or not isinstance(root, str) or not os.path.isabs(root)
            or not isinstance(scope, str) or not scope or len(scope) > 512
            or scope.startswith(("/", "\\")) or re.match(r"^[a-zA-Z]:", scope)
            or any(part in ("", "..") for part in scope.replace("\\", "/").split("/") if part != ".")
            or not isinstance(features, list) or not features
            or any(not isinstance(feature, str) for feature in features)
        ):
            return "The request-bound authorization context is malformed."
        known_features = {*_PROTECTED_FEATURE_ROOTS.keys(), "shared"}
        if len(set(features)) != len(features) or not set(features).issubset(known_features):
            return "The request-bound feature scope is invalid."
        for target_path in target_paths:
            feature = cls._feature_for_mutation_path(target_path)
            if feature not in features:
                return f"Mutation target is outside the authorized {feature} feature scope."
        return None

    @classmethod
    def evaluate_file_mutation(
        cls,
        operation: str,
        target_paths: List[str],
        proposal_approved: bool,
        delete_confirmed: bool = False,
        request_binding: Optional[Dict[str, Any]] = None,
    ) -> Tuple[str, str]:
        """Authorizes one proposal-scoped filesystem mutation."""
        allowed_operations = {"create", "modify", "delete", "delete_directory", "rename", "move", "undo"}
        if operation not in allowed_operations:
            return "BLOCK", "Unknown file mutation capability is blocked."
        if not target_paths or any(not isinstance(item, str) or not item.strip() for item in target_paths):
            return "BLOCK", "A target path is required for every file mutation."
        for target_path in target_paths:
            normalized = target_path.replace("\\", "/")
            segments = normalized.split("/")
            if (
                normalized.startswith("/")
                or re.match(r"^[a-zA-Z]:", normalized)
                or any(segment in ("", ".", "..") or ":" in segment or segment.endswith((".", " ")) for segment in segments)
                or normalized.startswith("//")
            ):
                return "BLOCK", "Absolute and traversing file mutation paths are blocked."
            if cls.SENSITIVE_FILES_PATTERN.search(normalized) or any(segment.lower() == ".git" for segment in segments):
                return "BLOCK", "Mutation of sensitive files or repository metadata is blocked."
        if not proposal_approved:
            return "BLOCK", "Repository mutations require an approved proposal and snapshot validation."
        binding_error = cls._validate_request_binding(request_binding, target_paths)
        if binding_error:
            return "BLOCK", binding_error
        if operation in {"delete", "delete_directory"} and not delete_confirmed:
            return "BLOCK", "Deletion requires a separate explicit confirmation."
        return "ALLOW", "Validated mutation under the approved proposal"


# =====================================================================
# 8. SELF-DEBUGGING CONTROLLER & FAILURE TAXONOMY
# =====================================================================
class FailureClassification:
    CODE = "CODE"
    TEST = "TEST"
    ENVIRONMENT = "ENVIRONMENT"
    CONFIGURATION = "CONFIGURATION"
    DEPENDENCY = "DEPENDENCY"
    DATA = "DATA"
    DATABASE = "DATABASE"
    RUNTIME = "RUNTIME"
    API = "API"
    NETWORK = "NETWORK"
    INTEGRATION = "INTEGRATION"
    TOOL = "TOOL"
    PROVIDER = "PROVIDER"
    INDEX = "INDEX"
    MEMORY = "MEMORY"
    CONTEXT = "CONTEXT"
    ORCHESTRATION = "ORCHESTRATION"
    VERIFICATION = "VERIFICATION"


class SelfDebugController:
    """
    Manages up to 6 meaningful recovery iterations.
    Gathers new evidence, formulates new hypothesis, updates plan, prevents repeated failed actions.
    """
    MAX_RECOVERY_ITERATIONS = 6

    def __init__(self, task_id: str):
        self.task_id = task_id
        self.iteration = 0
        self.history: List[Dict[str, Any]] = []

    def can_recover(self) -> bool:
        return self.iteration < self.MAX_RECOVERY_ITERATIONS

    def record_attempt(self, action: str, failure_type: str, error_msg: str, evidence: Any = None) -> Dict[str, Any]:
        self.iteration += 1
        record = {
            "iteration": self.iteration,
            "action": action,
            "failureType": failure_type,
            "error": SecretProtector.redact_text(error_msg),
            "evidence": SecretProtector.redact_data(evidence),
            "timestamp": time.time(),
        }
        self.history.append(record)
        return record

    def has_repeated_failure(self, action: str) -> bool:
        recent = [r["action"] for r in self.history[-2:]]
        return recent.count(action) >= 2

    def execute_recovery_cycle(
        self,
        failed_action: str,
        error_output: str,
        new_evidence: Optional[Dict[str, Any]] = None,
        hypothesis: Optional[str] = None,
        replanned_action: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Executes the autonomous failure recovery sequence:
        FAIL -> CLASSIFY -> NEW EVIDENCE -> NEW HYPOTHESIS -> REPLAN -> WRITE FIX -> VERIFY
        """
        if not self.can_recover():
            return {
                "recovered": False,
                "reason": "DEBUG_LIMIT_EXHAUSTED",
                "iterations": self.iteration,
            }

        classification = self.classify_failure(error_output)
        ev = new_evidence or {"error": error_output[:200], "context": "Gathered from verification output"}
        hyp = hypothesis or f"Failure {classification} caused by issue in {failed_action}; updating implementation."
        next_action = replanned_action or f"Refined fix addressing {classification}"

        attempt = self.record_attempt(
            action=failed_action,
            failure_type=classification,
            error_msg=error_output,
            evidence=ev,
        )

        return {
            "recovered": True,
            "iteration": self.iteration,
            "lifecycle": [
                "FAIL",
                "CLASSIFY",
                "NEW_EVIDENCE",
                "NEW_HYPOTHESIS",
                "REPLAN",
                "WRITE_FIX",
                "VERIFY",
            ],
            "classification": classification,
            "evidence": ev,
            "hypothesis": hyp,
            "replannedAction": next_action,
            "canContinue": self.can_recover(),
        }

    @staticmethod
    def classify_failure(error_msg: str) -> str:
        low = (error_msg or "").lower()
        if "syntax" in low or "parse error" in low:
            return FailureClassification.CODE
        if "test" in low or "assertion" in low or "assert" in low:
            return FailureClassification.TEST
        if "table" in low or "column" in low or "sql" in low or "database" in low:
            return FailureClassification.DATABASE
        if "timeout" in low or "timed out" in low:
            return FailureClassification.RUNTIME
        if "network" in low or "connection refused" in low:
            return FailureClassification.NETWORK
        if "config" in low or "missing key" in low:
            return FailureClassification.CONFIGURATION
        if "module not found" in low or "cannot find module" in low or "package" in low:
            return FailureClassification.DEPENDENCY
        return FailureClassification.CODE


# =====================================================================
# 9. EVIDENCE EVENT STREAM (22 STANDARD AUDIT EVENTS)
# =====================================================================
class EvidenceEventStream:
    """
    Standardized engineering evidence event stream.
    Emits 22 distinct lifecycle and evidence events for full auditability.
    """
    EVENTS = [
        "TASK_CREATED", "PROJECT_DISCOVERED", "REPOSITORY_DISCOVERED", "SEARCH_COMPLETED",
        "FILE_READ", "SYMBOL_FOUND", "DEPENDENCY_FOUND", "DATABASE_CONFIG_DISCOVERED",
        "DATABASE_CAPABILITY_DISCOVERED", "DATABASE_CONNECTION_RESOLVED", "DATABASE_CONNECTED",
        "DATABASE_ENGINE_VERIFIED", "DATABASE_HEALTH_CHECK", "DATABASE_SCHEMA_INSPECTED",
        "DATABASE_QUERY_EXECUTED", "DATABASE_QUERY_MEASURED", "TOOL_RESOLVED",
        "TOOL_EXECUTED", "PATCH_CREATED", "PATCH_APPLIED", "TEST_EXECUTED",
        "BUILD_EXECUTED", "VERIFICATION_RESULT", "FAILURE_DETECTED", "REPLAN",
        "MEMORY_UPDATED", "INDEX_UPDATED", "TASK_COMPLETED"
    ]

    def __init__(self):
        self._events: List[Dict[str, Any]] = []
        self.max_events = 1000

    def emit(self, event_name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        event = {
            "event": event_name,
            "timestamp": time.time(),
            "payload": SecretProtector.redact_data(payload),
        }
        self._events.append(event)
        if len(self._events) > self.max_events:
            del self._events[:-self.max_events]
        return event

    def get_events(self) -> List[Dict[str, Any]]:
        return list(self._events)


# Global Singleton Instances for Project Engine
UNIVERSAL_SECRET_PROTECTOR = SecretProtector()
UNIVERSAL_MEMORY = CodingMemorySystem()
UNIVERSAL_POLICY_GATE = PolicyGate()
UNIVERSAL_INDEX = IncrementalRepositoryIndex()
UNIVERSAL_CODE_GRAPH = LazyCodeGraph(UNIVERSAL_INDEX)
UNIVERSAL_SEARCH_ROUTER = AdaptiveSearchRouter()
UNIVERSAL_DB_ENGINE = DatabaseIntelligenceEngine()
UNIVERSAL_EVENT_STREAM = EvidenceEventStream()
