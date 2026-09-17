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

from provider_registry import ProviderRegistry, ProviderStatus, RegistryState

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

# Initialize provider registry
registry = ProviderRegistry(config_path=str(CONFIG_PATH))
registry.initialize(os.environ, PROVIDER_PRESETS)


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


def get_api_key(provider_id: str) -> str:
    """Retrieve API key from environment variables for a provider."""
    provider = registry.get_provider(provider_id)
    if not provider:
        return ""
    
    # Try to get from environment variable
    env_key = f"{provider.type.upper()}_API_KEY"
    return os.getenv(env_key, "")


def get_active_provider_with_api_key() -> tuple[Optional[Any], str]:
    """Get active provider and its API key."""
    provider = registry.get_active_provider()
    if not provider:
        return None, ""
    
    api_key = get_api_key(provider.id)
    return provider, api_key


async def call_model(messages: List[Dict[str, Any]], provider_id: Optional[str] = None) -> str:
    """Call LLM using specified or active provider."""
    if provider_id:
        provider = registry.get_provider(provider_id)
    else:
        provider = registry.get_active_provider()
    
    if not provider:
        raise HTTPException(status_code=502, detail="No provider configured.")
    
    api_key = get_api_key(provider.id)
    if not api_key or not provider.model:
        raise HTTPException(status_code=502, detail=f"Provider '{provider.type}' is not fully configured.")

    try:
        client = OpenAI(api_key=api_key, base_url=provider.base_url or None)
        response = client.chat.completions.create(
            model=provider.model,
            messages=messages,
            temperature=0.3,
            max_tokens=MAX_TOKENS,
        )
        content = response.choices[0].message.content if response.choices else ""
        
        # Update provider status on success
        registry.update_provider_status(provider.id, ProviderStatus.READY)
        registry.save_to_file()
        
        return str(content or "").strip() or "No response returned by the model."
    except Exception as e:
        # Update provider status on failure
        error_msg = str(e)
        if "401" in error_msg or "Unauthorized" in error_msg:
            registry.update_provider_status(provider.id, ProviderStatus.AUTH_FAILED)
        elif "429" in error_msg or "rate" in error_msg.lower():
            registry.update_provider_status(provider.id, ProviderStatus.RATE_LIMITED)
        elif "model" in error_msg.lower():
            registry.update_provider_status(provider.id, ProviderStatus.MODEL_UNAVAILABLE)
        elif "connection" in error_msg.lower() or "timeout" in error_msg.lower():
            registry.update_provider_status(provider.id, ProviderStatus.NETWORK_ERROR)
        else:
            registry.update_provider_status(provider.id, ProviderStatus.SELF_TEST_FAILED, failure_category="unknown")
        
        registry.save_to_file()
        raise HTTPException(status_code=502, detail=f"Provider error: {error_msg}")


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
    """Health check endpoint."""
    provider = registry.get_active_provider()
    api_key = get_api_key(provider.id) if provider else None
    
    return {
        "status": "ok",
        "provider": provider.type if provider else None,
        "model": provider.model if provider else None,
        "configured": bool(provider and provider.has_api_key and api_key),
        "ready": provider.status == ProviderStatus.READY if provider else False,
        "status": provider.status.value if provider else ProviderStatus.UNCONFIGURED.value,
        "registryState": registry.state.value,
        "toolCalling": True,
        "wsPort": WS_PORT,
    }


@app.get("/api/settings/providers")
def list_providers() -> Dict[str, Any]:
    """List all configured providers."""
    return {
        "providers": [p.to_dict() for p in registry.get_all_providers()],
        "activeProvider": registry.active_provider_id,
        "fallbackEnabled": registry.fallback_enabled,
        "registryState": registry.state.value,
    }


@app.get("/api/settings/providers/capabilities")
def provider_capabilities() -> Dict[str, Any]:
    """Get provider capabilities."""
    active = registry.get_active_provider()
    active_data = active.to_dict() if active else {}
    
    return {
        "active": active_data,
        "providers": [p.to_dict() for p in registry.get_all_providers()],
        "registryState": registry.state.value,
    }


@app.post("/api/settings/providers")
def add_or_update_provider(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Add or update a provider."""
    provider_type = str(payload.get("type") or "").strip()
    model = str(payload.get("model") or "").strip()
    base_url = str(payload.get("baseURL") or "").strip()
    api_key = str(payload.get("apiKey") or "").strip()
    label = str(payload.get("label") or "").strip()
    priority = payload.get("priority")
    
    if not provider_type or not model or not api_key:
        raise HTTPException(status_code=400, detail="Provider type, model, and API key are required.")
    
    # Add or update provider
    provider = registry.add_provider(
        provider_type=provider_type,
        model=model,
        base_url=base_url,
        api_key=api_key,
        label=label or None,
        priority=int(priority) if priority else None,
    )
    
    # Save to persistent storage
    registry.save_to_file()
    
    return {
        "provider": provider.to_dict(),
        "providers": [p.to_dict() for p in registry.get_all_providers()],
        "registryState": registry.state.value,
    }


@app.patch("/api/settings/providers/{provider_id}")
def update_provider(provider_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Update a specific provider."""
    provider = registry.get_provider(provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found.")
    
    # Update fields
    if "enabled" in payload:
        registry.set_provider_enabled(provider_id, bool(payload["enabled"]))
    
    if "priority" in payload:
        provider.priority = int(payload["priority"])
    
    if "status" in payload:
        try:
            status = ProviderStatus(payload["status"])
            registry.update_provider_status(provider_id, status)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid status: {payload['status']}")
    
    # Note: Never update model, baseURL, or type via PATCH
    # Those require deletion and re-add
    
    registry.save_to_file()
    return {
        "provider": provider.to_dict(),
        "providers": [p.to_dict() for p in registry.get_all_providers()],
    }


@app.delete("/api/settings/providers/{provider_id}")
def delete_provider(provider_id: str) -> Dict[str, Any]:
    """Delete a provider."""
    if not registry.delete_provider(provider_id):
        raise HTTPException(status_code=404, detail="Provider not found.")
    
    registry.save_to_file()
    return {
        "providers": [p.to_dict() for p in registry.get_all_providers()],
        "activeProvider": registry.active_provider_id,
    }


@app.post("/api/settings/providers/reorder")
def reorder_providers(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Reorder providers by priority."""
    provider_ids = payload.get("ids")
    if not isinstance(provider_ids, list):
        raise HTTPException(status_code=400, detail="Provider IDs must be an array.")
    
    if not registry.reorder_providers(provider_ids):
        raise HTTPException(status_code=400, detail="Invalid provider IDs.")
    
    registry.save_to_file()
    return {
        "providers": [p.to_dict() for p in registry.get_all_providers()],
    }


@app.post("/api/settings/providers/self-test")
def self_test(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Test provider connectivity and configuration."""
    provider_id = payload.get("provider_id")
    
    if provider_id:
        provider = registry.get_provider(provider_id)
    else:
        provider = registry.get_active_provider()
    
    if not provider:
        return {
            "provider": None,
            "status": ProviderStatus.UNCONFIGURED.value,
            "configured": False,
            "registryState": registry.state.value,
        }
    
    api_key = get_api_key(provider.id)
    
    if not api_key or not provider.model:
        registry.update_provider_status(provider.id, ProviderStatus.UNCONFIGURED)
        registry.save_to_file()
        return {
            "provider": provider.id,
            "status": ProviderStatus.UNCONFIGURED.value,
            "configured": False,
            "model": provider.model,
            "registryState": registry.state.value,
        }
    
    # Try to use the provider
    try:
        registry.update_provider_status(provider.id, ProviderStatus.CHECKING)
        
        test_messages = [{"role": "user", "content": "Respond with exactly: ok"}]
        client = OpenAI(api_key=api_key, base_url=provider.base_url or None)
        response = client.chat.completions.create(
            model=provider.model,
            messages=test_messages,
            temperature=0.3,
            max_tokens=10,
        )
        
        registry.update_provider_status(provider.id, ProviderStatus.READY)
        registry.save_to_file()
        
        return {
            "provider": provider.id,
            "status": ProviderStatus.READY.value,
            "configured": True,
            "model": provider.model,
            "toolCalling": True,
            "registryState": registry.state.value,
        }
    except Exception as e:
        error_msg = str(e)
        
        if "401" in error_msg or "Unauthorized" in error_msg:
            status = ProviderStatus.AUTH_FAILED
        elif "429" in error_msg or "rate" in error_msg.lower():
            status = ProviderStatus.RATE_LIMITED
        elif "model" in error_msg.lower():
            status = ProviderStatus.MODEL_UNAVAILABLE
        elif "connection" in error_msg.lower() or "timeout" in error_msg.lower():
            status = ProviderStatus.NETWORK_ERROR
        else:
            status = ProviderStatus.SELF_TEST_FAILED
        
        registry.update_provider_status(provider.id, status, failure_category=error_msg[:100])
        registry.save_to_file()
        
        return {
            "provider": provider.id,
            "status": status.value,
            "configured": True,
            "model": provider.model,
            "error": error_msg,
            "registryState": registry.state.value,
        }


@app.post("/api/settings/agent")
def set_agent_permissions(request: Request, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Set agent permissions. Only from loopback."""
    require_loopback(request)
    # Agent permissions would be persisted separately in production
    # For now, just acknowledge
    return {"status": "ok", "permissions": payload}


@app.get("/api/agent/activity")
def get_agent_activity(request: Request) -> Dict[str, Any]:
    """Get agent activity log. Only from loopback."""
    require_loopback(request)
    return {"activity": []}  # Would be persisted separately


@app.post("/api/agent/open")
def open_agent_action(request: Request, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Open an app or browser. Only from loopback."""
    require_loopback(request)
    
    target = payload.get("target", "").strip()
    url = payload.get("url", "").strip()
    confirmed = payload.get("confirmed", False)
    
    if not confirmed:
        raise HTTPException(status_code=400, detail="A local user confirmation is required before opening an app.")
    
    # For now, just record the request (actual opening would happen here)
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

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid JSON message."})
                continue

            if payload.get("type") == "tool_result":
                # Ignore tool results for now (not implemented)
                continue

            if payload.get("type") != "chat":
                await websocket.send_json({"type": "error", "message": f"Unknown message type: {payload.get('type')}"})
                continue

            messages = payload.get("messages")
            request_id = payload.get("requestId", "")
            if not isinstance(messages, list) or not messages:
                await websocket.send_json({"type": "error", "message": "No messages provided.", "requestId": request_id})
                continue

            try:
                provider = registry.get_active_provider()
                if not provider:
                    await websocket.send_json({"type": "error", "message": "No provider configured.", "requestId": request_id})
                    continue
                
                answer = await asyncio.to_thread(call_model, messages, provider.id)
                
                await websocket.send_json({"type": "token", "content": answer, "requestId": request_id})
                await websocket.send_json({
                    "type": "done",
                    "content": answer,
                    "requestId": request_id,
                    "provider": provider.type,
                    "model": provider.model,
                    "toolCalls": [],
                    "timing": {"providerRequestMs": 0, "timeToFirstTokenMs": 0},
                })
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": str(exc), "requestId": request_id})
    except WebSocketDisconnect:
        pass


async def run_websocket_server():
    """Run WebSocket server on separate port."""
    import websockets
    from websockets.server import serve
    
    async def ws_handler(websocket, path):
        """Handle WebSocket connections on port 3002."""
        try:
            async for message in websocket:
                try:
                    payload = json.loads(message)
                except json.JSONDecodeError:
                    await websocket.send(json.dumps({"type": "error", "message": "Invalid JSON message."}))
                    continue

                if payload.get("type") == "tool_result":
                    # Ignore tool results for now
                    continue

                if payload.get("type") != "chat":
                    await websocket.send(json.dumps({"type": "error", "message": f"Unknown message type: {payload.get('type')}"}))
                    continue

                messages = payload.get("messages", [])
                request_id = payload.get("requestId", "")
                
                if not messages:
                    await websocket.send(json.dumps({"type": "error", "message": "No messages provided.", "requestId": request_id}))
                    continue

                try:
                    provider = registry.get_active_provider()
                    if not provider:
                        await websocket.send(json.dumps({"type": "error", "message": "No provider configured.", "requestId": request_id}))
                        continue
                    
                    answer = await asyncio.to_thread(call_model, messages, provider.id)
                    
                    await websocket.send(json.dumps({"type": "token", "content": answer, "requestId": request_id}))
                    await websocket.send(json.dumps({
                        "type": "done",
                        "content": answer,
                        "requestId": request_id,
                        "provider": provider.type,
                        "model": provider.model,
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

    active = registry.get_active_provider()
    print(f"Provider registry initialized with {len(registry.providers)} providers (state: {registry.state.value})")
    if active:
        print(f"Active provider: {active.type} (model: {active.model}, status: {active.status.value})")
    else:
        print("No active provider configured")
    
    print(f"HTTP API server listening on http://localhost:{PORT}")

    # Run WebSocket server in main thread
    try:
        asyncio.run(run_websocket_server())
    except KeyboardInterrupt:
        print("Shutting down...")

