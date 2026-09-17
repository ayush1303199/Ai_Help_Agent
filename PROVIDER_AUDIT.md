# Provider Configuration Audit & Hardening Plan

## CRITICAL FINDINGS

### 1. Multiple Sources of Truth (Root Cause #1)

**Python Backend:**
- `config["configuredProviders"]` - in-memory list
- Environment variables - loaded at startup, but not merged with saved config
- No persistence: never loads from or saves to `provider-config.json`

**Frontend:**
- React state `configuredProviders` - local state
- Attempts to persist to `~/.ai-help-agent/provider-config.json`
- Backend doesn't read what frontend persists

**Health Endpoint:**
- Independently calculates provider status
- Does NOT use the same `config["configuredProviders"]`
- Can return contradictory state

**Impact:** UI shows "Configured" but backend says "Not configured" because they read different sources.

---

### 2. No Provider ID Stability (Root Cause #2)

**Current behavior:**
- IDs generated as `env-{name}`, `runtime-{name}`, or `provider-{type}-{index}`
- Index-based IDs change when list order changes
- Every POST without explicit ID creates a new provider
- No deduplication

**Problem:** Restart causes duplicate "Groq" entries because:
1. Env-var Groq loaded as `env-groq`
2. User adds Groq via UI → creates `provider-groq-1`
3. Appears as two separate provider instances

---

### 3. Status Collapse (Root Cause #3)

**Conflation of distinct concepts:**
- `configured=true` used for:
  - "API key exists"
  - "API key is valid" 
  - "Model is available"
  - "Provider is enabled"
  - "Provider is healthy"
  - "Provider is not rate-limited"

**Result:** Cannot distinguish:
- `RATE_LIMITED` vs `NOT_CONFIGURED`
- `AUTH_FAILED` vs `NOT_CONFIGURED`
- `NETWORK_ERROR` vs `NOT_CONFIGURED`

---

### 4. No Persistence Implementation (Root Cause #4)

**Frontend expects:**
```
POST /api/settings/providers → save to disk
GET /api/settings/providers → load from disk
```

**Backend actually does:**
- Only maintains in-memory `config` dict
- Never reads `provider-config.json`
- Never writes `provider-config.json`
- Loses all user configuration on restart

---

### 5. No Startup Rehydration (Root Cause #5)

**On backend start:**
1. Loads env vars only
2. Does not load from `provider-config.json`
3. Frontend fetches `/api/settings/providers`
4. Returns empty list (or only env vars)
5. Frontend thinks no providers configured
6. Shows "No runtime providers configured yet"

**But:**
7. Frontend has locally cached `provider-config.json`
8. Frontend tries to restore it
9. Backend still doesn't know about it

---

### 6. Duplicate Provider Test Results

**Scenario:** User adds Groq twice
- First add: `{id: "provider-groq-1", adapterType: "groq", ...}`
- Second add with same details: `{id: "provider-groq-2", adapterType: "groq", ...}`
- Both appear in UI
- No deduplication on refresh/restart

---

### 7. WebSocket Provider State Isolation (Root Cause #6)

**WebSocket uses:**
```python
provider_name = config.get("provider", "groq")
```

**But:**
- `config["provider"]` is a string name
- Actual provider might be in `config["configuredProviders"]` with different status
- WS doesn't check if provider is enabled
- WS doesn't fallback if provider rate-limited

---

## SOLUTION ARCHITECTURE

### Single Source of Truth (Persistent Config)

```
~/.ai-help-agent/provider-config.json
    ↓
[Backend Startup] → Load & Normalize & Deduplicate
    ↓
[Canonical Registry] (in-memory, validated)
    ↓
[API Responses] (always use registry)
    ↓
[Health] (always use registry)
    ↓
[WebSocket] (always use registry)
    ↓
[UI] (always display registry)
```

### Provider Identity Strategy

**Canonical ID:** `{providerType}:{apiKeyHash}:{userCustomId?}`

But simpler for MVP: use deterministic UUID based on provider type + base URL, regenerate on restart if user doesn't provide one.

**Stable across restarts:**
- Load from file → same IDs
- Unless user modifies config file

---

### Status Model

Define distinct states:

```
UNCONFIGURED     - No API key
CONFIGURED       - API key exists
ENABLED          - Configured AND enabled=true
READY            - Configured + Enabled + Last self-test passed
RATE_LIMITED     - Temporarily unavailable (quota)
AUTH_FAILED      - Invalid API key
NETWORK_ERROR    - Connection issue
CAPACITY_ERROR   - Provider capacity exceeded
MODEL_UNAVAILABLE - Requested model not available
SELF_TEST_FAILED - Self-test failed
```

---

### Persistence Contract

**File format:** `~/.ai-help-agent/provider-config.json`

```json
{
  "version": 1,
  "providers": [
    {
      "id": "stable-id-groq-1",
      "type": "groq",
      "model": "openai/gpt-oss-20b",
      "baseURL": "https://api.groq.com/openai/v1",
      "enabled": true,
      "priority": 1,
      "hasApiKey": true,
      "status": "READY",
      "lastCheckedAt": "2026-09-17T16:00:00Z"
    }
  ],
  "activeProvider": "stable-id-groq-1",
  "fallbackEnabled": true,
  "lastModifiedAt": "2026-09-17T16:00:00Z"
}
```

**Secret values (apiKey) NEVER stored in file.**

---

### API Contract Updates

**GET /api/settings/providers**
```json
{
  "providers": [
    {
      "id": "...",
      "type": "groq",
      "model": "...",
      "enabled": true,
      "status": "READY",
      "priority": 1,
      "hasApiKey": true,
      "assistantCapable": true,
      "developerStatus": "READY"
    }
  ],
  "activeProvider": "...",
  "fallbackEnabled": true,
  "registryState": "READY"  // or "LOADING", "ERROR"
}
```

**GET /api/health**
```json
{
  "status": "ok",
  "provider": "groq",
  "model": "...",
  "configured": true,
  "ready": true,
  "status": "READY",
  "registryState": "READY",
  "wsPort": 3002
}
```

---

## IMPLEMENTATION PHASES

### Phase 1: Add Persistence Layer
- [ ] Create `ProviderRegistry` class in Python
- [ ] Load provider-config.json on startup
- [ ] Save provider-config.json on mutation
- [ ] Deduplicate on load
- [ ] Generate stable IDs

### Phase 2: Add Status Model
- [ ] Define `ProviderStatus` enum
- [ ] Update all responses to use new status
- [ ] Add `registryState` to distinguish LOADING from EMPTY
- [ ] Remove old boolean flags

### Phase 3: Update REST API
- [ ] Update GET /api/settings/providers
- [ ] Update POST /api/settings/providers
- [ ] Update PATCH /api/settings/providers/{id}
- [ ] Add proper deduplication
- [ ] Update /api/health

### Phase 4: Update WebSocket
- [ ] Use registry for provider lookup
- [ ] Check enabled status
- [ ] Implement fallback logic
- [ ] Maintain mode isolation

### Phase 5: Frontend Integration
- [ ] Parse new status model
- [ ] Display distinct status strings
- [ ] Wait for registryState=READY before showing UI
- [ ] No contradictory states

### Phase 6: Testing & Validation
- [ ] No providers scenario
- [ ] One provider scenario
- [ ] Multiple providers scenario
- [ ] Duplicate provider detection
- [ ] Restart consistency
- [ ] Concurrent request isolation
- [ ] Rate limit handling
- [ ] Auth failure handling
- [ ] Network failure handling
- [ ] Recovery scenarios

---

## Root Causes Summary

| # | Root Cause | Impact | Fix |
|---|-----------|--------|-----|
| 1 | Multiple config sources (env vars, mem, file, health) | Inconsistent state across components | Single canonical registry |
| 2 | No provider ID stability | Duplicates on restart | Deterministic stable IDs |
| 3 | Status collapse (all use `configured=bool`) | Can't distinguish failures from unconfigured | Proper status enum |
| 4 | No persistence implementation | Config lost on restart | Load/save provider-config.json |
| 5 | No startup rehydration | Empty provider list after restart | Load from file during startup |
| 6 | WebSocket uses string name, not registry | Can't check enabled/status | Use registry lookup |
| 7 | Health calculates independently | Contradicts /api/settings/providers | Use same registry source |

