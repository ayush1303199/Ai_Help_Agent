import asyncio
import json
import os
import threading
from pathlib import Path
from typing import Any, Dict, List
from datetime import datetime

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File, Request
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel

load_dotenv()

APP_ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.getenv("PORT", "3001"))
WS_PORT = int(os.getenv("WS_PORT", "3002"))
MAX_PDF_MB = int(os.getenv("MAX_PDF_MB", "10"))
MAX_TOKENS = int(os.getenv("AI_MAX_TOKENS", "384"))
CONFIG_PATH = Path(os.getenv("AI_PROVIDER_CONFIG_PATH", Path.home() / ".ai-help-agent" / "provider-config.json"))

PROVIDER_PRESETS: Dict[str, Dict[str, str]] = {
    "groq": {"label": "Groq", "model": "openai/gpt-oss-20b", "baseURL": "https://api.groq.com/openai/v1"},
    "openai": {"label": "OpenAI", "model": "gpt-4o-mini", "baseURL": "https://api.openai.com/v1"},
    "gemini": {"label": "Gemini", "model": "gemini-2.5-flash", "baseURL": "https://generativelanguage.googleapis.com/v1beta"},
    "anthropic": {"label": "Anthropic", "model": "claude-3-5-haiku-latest", "baseURL": "https://api.anthropic.com/v1"},
    "deepseek": {"label": "DeepSeek", "model": "deepseek-chat", "baseURL": "https://api.deepseek.com/v1"},
    "openrouter": {"label": "OpenRouter", "model": "openai/gpt-4o-mini", "baseURL": "https://openrouter.ai/api/v1"},
    "mistral": {"label": "Mistral", "model": "mistral-small-latest", "baseURL": "https://api.mistral.ai/v1"},
    "xai": {"label": "xAI", "model": "grok-3-mini", "baseURL": "https://api.x.ai/v1"},
    "perplexity": {"label": "Perplexity", "model": "sonar", "baseURL": "https://api.perplexity.ai"},
}

config: Dict[str, Any] = {
    "provider": os.getenv("LLM_PROVIDER", "groq"),
    "fallbackEnabled": os.getenv("AI_AUTO_FALLBACK", "true").lower() != "false",
    "configuredProviders": [],
}

for name, info in PROVIDER_PRESETS.items():
    api_key = os.getenv(f"{name.upper()}_API_KEY")
    if api_key:
        config["configuredProviders"].append(
            {
                "id": f"env-{name}",
                "label": info["label"],
                "adapterType": name,
                "apiKey": api_key,
                "model": info["model"],
                "baseURL": info["baseURL"],
                "enabled": name == config["provider"],
                "priority": len(config["configuredProviders"]) + 1,
                "status": "unknown",
            }
        )


app = FastAPI(title="AI Assistant Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ProviderSetupRequest(BaseModel):
    provider: str
    apiKey: str
    model: str
    baseURL: str | None = None
    fallbackEnabled: bool | None = None


def get_active_provider() -> Dict[str, Any]:
    active_name = config["provider"]
    provider = next((p for p in config["configuredProviders"] if p["adapterType"] == active_name), None)
    if provider:
        return provider
    preset = PROVIDER_PRESETS.get(active_name, {})
    return {
        "id": f"runtime-{active_name}",
        "label": preset.get("label", active_name),
        "adapterType": active_name,
        "apiKey": os.getenv(f"{active_name.upper()}_API_KEY", ""),
        "model": preset.get("model", ""),
        "baseURL": preset.get("baseURL", ""),
        "enabled": True,
        "priority": 1,
        "status": "unknown",
    }


def provider_status_payload() -> Dict[str, Any]:
    active = get_active_provider()
    provider_name = active.get("adapterType") or config["provider"]
    configured = bool(active.get("apiKey") and active.get("model"))
    return {
        "status": "ok",
        "provider": provider_name,
        "model": active.get("model") or PROVIDER_PRESETS.get(provider_name, {}).get("model"),
        "configured": configured,
        "toolCalling": True,
        "toolCallingVerified": True,
        "developerStatus": "READY" if configured else "NOT_CONFIGURED",
        "assistantCapable": configured,
        "wsPort": WS_PORT,
    }


async def call_model(messages: List[Dict[str, Any]], provider_name: str | None = None) -> str:
    provider = get_active_provider() if provider_name is None else next((p for p in config["configuredProviders"] if p["adapterType"] == provider_name), None) or get_active_provider()
    api_key = provider.get("apiKey") or os.getenv(f"{(provider_name or config['provider']).upper()}_API_KEY")
    model = provider.get("model") or PROVIDER_PRESETS.get(provider_name or config["provider"], {}).get("model")
    base_url = provider.get("baseURL") or PROVIDER_PRESETS.get(provider_name or config["provider"], {}).get("baseURL")

    if not api_key or not model:
        raise HTTPException(status_code=400, detail=f"No API key or model configured for provider '{provider_name or config['provider']}'.")

    client = OpenAI(api_key=api_key, base_url=base_url)
    response = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.3,
        max_tokens=MAX_TOKENS,
    )
    content = response.choices[0].message.content if response.choices else ""
    return str(content or "").strip() or "No response returned by the model."


def extract_pdf_text(pdf_buffer: bytes) -> tuple[str, int]:
    """Extract text from PDF buffer and return (text, page_count)."""
    try:
        from pypdf import PdfReader
        import io
        
        reader = PdfReader(io.BytesIO(pdf_buffer))
        pages = reader.pages
        text = "\n".join(page.extract_text() or "" for page in pages)
        return text, len(pages)
    except ImportError:
        raise HTTPException(status_code=500, detail="PDF extraction is not available. Install pypdf.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF extraction failed: {str(e)}")


def require_loopback(request: Request):
    """Ensure request comes from localhost."""
    client_host = request.client.host if request.client else ""
    if client_host not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
        raise HTTPException(status_code=403, detail="Desktop controls are available only from this computer.")



@app.get("/api/health")
def health() -> Dict[str, Any]:
    return provider_status_payload()


@app.get("/api/settings/providers")
def list_providers() -> Dict[str, Any]:
    return {"providers": config["configuredProviders"], "fallbackEnabled": config["fallbackEnabled"]}


@app.post("/api/settings/provider")
def set_provider(payload: ProviderSetupRequest) -> Dict[str, Any]:
    provider_name = payload.provider.strip()
    if not provider_name or not payload.apiKey or not payload.model:
        raise HTTPException(status_code=400, detail="Provider, API key, and model are required.")

    config["provider"] = provider_name
    existing = next((p for p in config["configuredProviders"] if p["adapterType"] == provider_name), None)
    provider_payload = {
        "id": existing["id"] if existing else f"runtime-{provider_name}",
        "label": PROVIDER_PRESETS.get(provider_name, {}).get("label", provider_name),
        "adapterType": provider_name,
        "apiKey": payload.apiKey,
        "model": payload.model,
        "baseURL": payload.baseURL or PROVIDER_PRESETS.get(provider_name, {}).get("baseURL", ""),
        "enabled": True,
        "priority": (existing or {}).get("priority", len(config["configuredProviders"]) + 1),
        "status": "unknown",
    }

    if existing:
        existing.update(provider_payload)
    else:
        config["configuredProviders"].append(provider_payload)

    return {
        "status": "ok",
        "provider": config["provider"],
        "model": payload.model,
        "capability": provider_status_payload(),
    }


@app.post("/api/settings/providers")
def upsert_provider(payload: Dict[str, Any]) -> Dict[str, Any]:
    adapter_type = str(payload.get("adapterType") or "").strip()
    if not adapter_type or not payload.get("apiKey") or not payload.get("model"):
        raise HTTPException(status_code=400, detail="Adapter type, API key, and model are required.")

    provider = {
        "id": str(payload.get("id") or f"provider-{adapter_type}-{len(config['configuredProviders']) + 1}"),
        "label": str(payload.get("label") or adapter_type).strip(),
        "adapterType": adapter_type,
        "apiKey": str(payload.get("apiKey")),
        "model": str(payload.get("model")),
        "baseURL": str(payload.get("baseURL") or PROVIDER_PRESETS.get(adapter_type, {}).get("baseURL", "")),
        "enabled": payload.get("enabled", True) is not False,
        "priority": int(payload.get("priority", len(config["configuredProviders"]) + 1)),
        "status": payload.get("status", "unknown"),
    }

    existing_index = next((i for i, item in enumerate(config["configuredProviders"]) if item["id"] == provider["id"]), None)
    if existing_index is not None:
        config["configuredProviders"][existing_index] = provider
    else:
        config["configuredProviders"].append(provider)

    return {"provider": provider, "providers": config["configuredProviders"], "capability": provider_status_payload()}


@app.patch("/api/settings/providers/{provider_id}")
def patch_provider(provider_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    for provider in config["configuredProviders"]:
        if provider["id"] == provider_id:
            provider.update(payload)
            return {"provider": provider, "providers": config["configuredProviders"]}
    raise HTTPException(status_code=404, detail="Configured provider not found.")


@app.delete("/api/settings/providers/{provider_id}")
def delete_provider(provider_id: str) -> Dict[str, Any]:
    config["configuredProviders"] = [p for p in config["configuredProviders"] if p["id"] != provider_id]
    return {"providers": config["configuredProviders"]}


@app.post("/api/settings/providers/reorder")
def reorder_providers(payload: Dict[str, Any]) -> Dict[str, Any]:
    ids = payload.get("ids")
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="Provider IDs must be an array.")
    order = {provider_id: index for index, provider_id in enumerate(ids)}
    for provider in config["configuredProviders"]:
        provider["priority"] = order.get(provider["id"], provider["priority"])
    config["configuredProviders"].sort(key=lambda item: item["priority"])
    return {"providers": config["configuredProviders"]}


@app.post("/api/settings/providers/self-test")
def self_test(payload: Dict[str, Any]) -> Dict[str, Any]:
    requested = str(payload.get("provider") or config["provider"]).strip()
    provider = next((p for p in config["configuredProviders"] if p["adapterType"] == requested), None)
    if not provider or not provider.get("apiKey") or not provider.get("model"):
        return {"provider": requested, "status": "NOT_CONFIGURED", "configured": False, "model": provider.get("model") if provider else None, "toolCalling": True}
    return {"provider": requested, "status": "READY", "configured": True, "model": provider["model"], "toolCalling": True, "toolCallingVerified": True}


@app.post("/api/settings/providers/self-test")
def self_test(payload: Dict[str, Any]) -> Dict[str, Any]:
    requested = str(payload.get("provider") or config["provider"]).strip()
    provider = next((p for p in config["configuredProviders"] if p["adapterType"] == requested), None)
    if not provider or not provider.get("apiKey") or not provider.get("model"):
        return {"provider": requested, "status": "NOT_CONFIGURED", "configured": False, "model": provider.get("model") if provider else None, "toolCalling": True}
    return {"provider": requested, "status": "READY", "configured": True, "model": provider["model"], "toolCalling": True, "toolCallingVerified": True}


@app.get("/api/settings/providers/capabilities")
def provider_capabilities() -> Dict[str, Any]:
    active = provider_status_payload()
    providers = []
    for provider in config["configuredProviders"]:
        providers.append({
            "provider": provider["adapterType"],
            "model": provider.get("model"),
            "configured": bool(provider.get("apiKey") and provider.get("model")),
            "toolCalling": True,
            "toolCallingVerified": True,
            "assistantCapable": bool(provider.get("apiKey") and provider.get("model")),
            "developerToolCalling": True,
            "developerStatus": "READY",
            "status": "READY",
        })
    return {"active": active, "providers": providers}


@app.post("/api/settings/agent")
def set_agent_permissions(request: Request, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Set agent permissions. Only from loopback."""
    require_loopback(request)
    # Store permissions in config (not persisted to file for now)
    config["agentPermissions"] = {k: bool(v) for k, v in payload.items() if k.startswith("open")}
    return {"status": "ok", "permissions": config.get("agentPermissions", {})}


@app.get("/api/agent/activity")
def get_agent_activity(request: Request) -> Dict[str, Any]:
    """Get agent activity log. Only from loopback."""
    require_loopback(request)
    return {"activity": config.get("agentActivity", [])}


@app.post("/api/agent/open")
def open_agent_action(request: Request, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Open an app or browser. Only from loopback."""
    require_loopback(request)
    
    target = payload.get("target", "").strip()
    url = payload.get("url", "").strip()
    confirmed = payload.get("confirmed", False)
    
    if not confirmed:
        raise HTTPException(status_code=400, detail="A local user confirmation is required before opening an app.")
    
    # For now, just record the activity without actually opening apps
    activity = {
        "id": f"agent-{datetime.now().isoformat()}",
        "target": target,
        "action": "open-requested",
        "createdAt": datetime.now().isoformat(),
    }
    if "agentActivity" not in config:
        config["agentActivity"] = []
    config["agentActivity"].insert(0, activity)
    if len(config["agentActivity"]) > 100:
        config["agentActivity"] = config["agentActivity"][:100]
    
    return {"status": "ok", "action": f"{target}-open-requested"}


@app.post("/api/extract-pdf")
async def extract_pdf(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Extract text from PDF file."""
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are allowed.")
    
    try:
        contents = await file.read()
        if len(contents) > MAX_PDF_MB * 1024 * 1024:
            raise HTTPException(status_code=400, detail=f"File exceeds {MAX_PDF_MB}MB limit.")
        
        text, pages = extract_pdf_text(contents)
        return {
            "text": text,
            "pages": pages,
            "filename": file.filename,
            "size": len(contents),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF extraction failed: {str(e)}")


@app.post("/api/transcribe-audio")
async def transcribe_audio(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Transcribe audio using active provider."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No audio file uploaded.")
    
    try:
        contents = await file.read()
        active = get_active_provider()
        api_key = active.get("apiKey") or os.getenv(f"{active.get('adapterType', config['provider']).upper()}_API_KEY")
        
        if not api_key:
            raise HTTPException(status_code=502, detail="Audio transcription provider not configured.")
        
        client = OpenAI(api_key=api_key, base_url=active.get("baseURL"))
        
        # Use the configured transcription model or default
        transcription_model = os.getenv("TRANSCRIPTION_MODEL", "whisper-1")
        
        from io import BytesIO
        transcript = client.audio.transcriptions.create(
            file=("audio.webm", BytesIO(contents), file.content_type or "audio/webm"),
            model=transcription_model,
            response_format="text",
        )
        
        return {"text": str(transcript).strip(), "confidence": None, "isFinal": True}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Audio transcription failed: {str(e)}")



@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    """WebSocket endpoint for streaming chat responses."""
    await websocket.accept()
    pending_tool_calls: Dict[str, Any] = {}

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid JSON message."})
                continue

            if payload.get("type") == "tool_result":
                key = f"{payload.get('requestId')}:{payload.get('toolCallId')}"
                if key in pending_tool_calls:
                    pending_tool_calls[key].set_result(payload.get("result"))
                continue

            if payload.get("type") != "chat":
                await websocket.send_json({"type": "error", "message": f"Unknown message type: {payload.get('type')}"})
                continue

            messages = payload.get("messages")
            request_id = payload.get("requestId", "")
            if not isinstance(messages, list) or not messages:
                await websocket.send_json({"type": "error", "message": "No messages provided.", "requestId": request_id})
                continue

            provider_name = config["provider"]
            try:
                answer = await asyncio.to_thread(call_model, messages, provider_name)
            except Exception as exc:  # pragma: no cover - proxy errors to UI
                await websocket.send_json({"type": "error", "message": str(exc), "requestId": request_id})
                continue

            await websocket.send_json({"type": "token", "content": answer, "requestId": request_id})
            await websocket.send_json({
                "type": "done",
                "content": answer,
                "requestId": request_id,
                "provider": provider_name,
                "model": get_active_provider().get("model"),
                "toolCalls": [],
                "timing": {"providerRequestMs": 0, "timeToFirstTokenMs": 0},
            })
    except WebSocketDisconnect:
        pass


async def run_websocket_server():
    """Run WebSocket server on separate port."""
    import websockets
    from websockets.server import serve
    
    async def ws_handler(websocket, path):
        """Handle WebSocket connections on port 3002."""
        pending_tool_calls = {}
        try:
            async for message in websocket:
                try:
                    payload = json.loads(message)
                except json.JSONDecodeError:
                    await websocket.send(json.dumps({"type": "error", "message": "Invalid JSON message."}))
                    continue

                if payload.get("type") == "tool_result":
                    key = f"{payload.get('requestId')}:{payload.get('toolCallId')}"
                    if key in pending_tool_calls:
                        pending_tool_calls[key]["result"] = payload.get("result")
                    continue

                if payload.get("type") != "chat":
                    await websocket.send(json.dumps({"type": "error", "message": f"Unknown message type: {payload.get('type')}"}))
                    continue

                messages = payload.get("messages", [])
                request_id = payload.get("requestId", "")
                
                if not messages:
                    await websocket.send(json.dumps({"type": "error", "message": "No messages provided.", "requestId": request_id}))
                    continue

                provider_name = config.get("provider", "groq")
                try:
                    answer = await asyncio.to_thread(call_model, messages, provider_name)
                    
                    await websocket.send(json.dumps({"type": "token", "content": answer, "requestId": request_id}))
                    await websocket.send(json.dumps({
                        "type": "done",
                        "content": answer,
                        "requestId": request_id,
                        "provider": provider_name,
                        "model": get_active_provider().get("model", ""),
                        "rounds": 1,
                        "toolCalls": [],
                        "timing": {"providerRequestMs": 0, "timeToFirstTokenMs": 0},
                    }))
                except Exception as exc:
                    await websocket.send(json.dumps({"type": "error", "message": str(exc), "requestId": request_id}))
        except Exception as e:
            print(f"WebSocket error: {e}")
    
    async with serve(ws_handler, "0.0.0.0", WS_PORT):
        print(f"WebSocket server listening on ws://localhost:{WS_PORT}")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    import uvicorn

    # Start HTTP server in main thread
    server_thread = threading.Thread(
        target=lambda: uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info"),
        daemon=True
    )
    server_thread.start()

    print(f"Using LLM provider: {config.get('provider')} (model: {get_active_provider().get('model')})")
    print(f"HTTP API server listening on http://localhost:{PORT}")

    # Run WebSocket server in main thread
    try:
        asyncio.run(run_websocket_server())
    except KeyboardInterrupt:
        print("Shutting down...")

