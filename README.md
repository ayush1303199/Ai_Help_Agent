# AI Assistant — Node.js + LangChain + WebSocket + React + PHP/Yii2

A beginner-friendly AI assistant that demonstrates:

1. **Direct LLM API calls** (Groq or OpenAI) using the official SDK
2. **LangChain-based LLM calls** using `@langchain/openai`
3. **PDF text extraction** passed as context to the AI
4. **Real-time WebSocket streaming** so responses appear token-by-token

---

## Folder Structure

```
ai-assistant/
├── server/                         # Node.js AI + WebSocket service
│   ├── package.json
│   ├── .env.example
│   ├── .env                        # (you create this — never commit it)
│   └── src/
│       ├── index.js                # Express HTTP server entry point
│       ├── config.js                # Loads & validates .env variables
│       ├── llm/
│       │   ├── provider.js         # Returns OpenAI SDK client for active provider
│       │   ├── directLlm.js        # Direct LLM streaming (no framework)
│       │   └── langchainLlm.js     # LangChain streaming implementation
│       ├── pdf/
│       │   └── pdfExtractor.js     # PDF text extraction + context trimming
│       └── ws/
│           └── websocketServer.js  # WebSocket server for real-time streaming
│
├── src/                            # React frontend (Vite + TypeScript)
│   ├── App.tsx                     # Chat UI, PDF upload, WebSocket client
│   ├── main.tsx
│   └── index.css
│
├── php-backend/                    # PHP/Yii2 backend API example
│   ├── composer.json
│   ├── .env.example
│   └── controllers/
│       └── AiController.php        # Yii2 API gateway to Node.js service
│
├── package.json                    # Frontend dependencies
├── README.md                       # This file
└── .env.example                    # Frontend env (optional)
```

---

## Prerequisites

- **Node.js** v18 or higher
- **npm** (comes with Node.js)
- **PHP** 8.1+ with **Composer** (only if you want the Yii2 backend)
- A **Groq API key** (free at https://console.groq.com) or an **OpenAI API key**

---

## Installation

### 1. Clone / enter the project

```bash
cd ai-assistant
```

### 2. Install frontend dependencies

```bash
npm install
```

### 3. Install Node.js server dependencies

```bash
cd server
npm install
cd ..
```

### 4. Configure server environment

```bash
cp server/.env.example server/.env
```

Edit `server/.env` and set your API key:

```env
LLM_PROVIDER=groq
GROQ_API_KEY=your_real_groq_api_key_here
GROQ_MODEL=llama-3.3-70b-versatile
```

### 5. (Optional) Install PHP/Yii2 backend

```bash
cd php-backend
composer install
cd ..
```

---

## How to Run the Complete Project

You need **two terminals** running simultaneously:

### Terminal 1 — Start the Node.js AI + WebSocket server

```bash
cd server
npm start
```

You should see:
```
HTTP API server listening on http://localhost:3001
WebSocket server listening on ws://localhost:3002
```

### Terminal 2 — Start the React frontend

```bash
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

### (Optional) Terminal 3 — Start the PHP/Yii2 backend

```bash
cd php-backend
php yii serve
```

This serves the Yii2 API on `http://localhost:8080`.

---

## How to Use

1. **Upload a PDF** (optional): Click "Upload PDF for context" and select a PDF file. The server extracts its text and sends it as context to the AI.
2. **Choose a mode**: Toggle between **Direct** (raw SDK call) and **LangChain** (framework-based).
3. **Type a message** and press Enter. The AI response streams in token-by-token via WebSocket.
4. **Ask about the PDF**: If you uploaded a document, ask questions like "Summarize this document" or "What are the key points?"

---

## Complete Request Flow

```
┌──────────┐     ┌──────────────┐     ┌─────────────────┐     ┌───────────┐     ┌──────────┐     ┌──────────┐
│  User    │────▶│  React UI    │────▶│  WebSocket      │────▶│  Node.js  │────▶│  PDF     │────▶│  LLM     │
│  Input   │     │  (App.tsx)   │     │  Server         │     │  Service  │     │  Extract │     │  (Groq/  │
│          │     │              │     │  (ws://:3002)   │     │  (Express)│     │  (if PDF)│     │  OpenAI) │
└──────────┘     └──────────────┘     └─────────────────┘     └───────────┘     └──────────┘     └────┬─────┘
                      ▲                                                │                    │
                      │                                                ▼                    │
                      │                                           ┌──────────┐               │
                      │                                           │ LangChain │◀──────────────┘
                      │                                           │ (optional)│
                      │                                           └─────┬────┘
                      │                                                 │
                      │           tokens stream back via WebSocket       │
                      └─────────────────────────────────────────────────┘
```

### Step-by-step:

1. **User Input** — The user types a question in the React chat UI and presses Enter.

2. **React → WebSocket** — `App.tsx` opens a WebSocket connection to `ws://localhost:3002` and sends a JSON message:
   ```json
   {
     "type": "chat",
     "mode": "direct",
     "messages": [{ "role": "user", "content": "What is this document about?" }],
     "pdfContext": "extracted PDF text..."
   }
   ```

3. **WebSocket Server** — `websocketServer.js` receives the message, parses the JSON, and prepares the final message list. If `pdfContext` is present, it injects a system message containing the extracted PDF text.

4. **PDF / Context Processing** — If a PDF was uploaded earlier, the React frontend already called `POST /api/extract-pdf` on the Express server. The server used `pdf-parse` to extract text and returned it. That text is now sent as `pdfContext` in the WebSocket message. The server trims it to fit the LLM context window.

5. **LLM Selection (Direct vs LangChain)** — Based on the `mode` field:
   - **`direct`**: `directLlm.js` calls the Groq/OpenAI API directly using the `openai` SDK's streaming method.
   - **`langchain`**: `langchainLlm.js` uses `@langchain/openai`'s `ChatOpenAI.stream()` method.

6. **LLM Call** — The active provider (Groq or OpenAI) processes the messages and returns a streaming response — individual tokens arrive one at a time.

7. **WebSocket → React** — For every token chunk, the WebSocket server sends `{ "type": "token", "content": "..." }` to the React frontend. The UI appends each token to the current assistant message, creating the typewriter effect.

8. **Stream Complete** — When the LLM finishes, the server sends `{ "type": "done", "content": "full text" }` and the message is finalized.

---

## Key Files Explained

### `server/src/config.js`
Loads all configuration from `.env` using `dotenv`. Centralizes provider settings (Groq, OpenAI) and server ports. The `validateConfig()` function ensures an API key is set before the server starts.

### `server/src/llm/provider.js`
Returns an OpenAI SDK client configured for the active provider. Because Groq implements the OpenAI API specification, the same SDK works for both — only the `baseURL` and `apiKey` differ. **To switch providers, only `.env` changes.**

### `server/src/llm/directLlm.js`
The simplest implementation. Uses `client.chat.completions.create({ stream: true })` and iterates over chunks with `for await`. No framework, no abstraction — just the raw API.

### `server/src/llm/langchainLlm.js`
Uses `@langchain/openai`'s `ChatOpenAI` class. The `stream()` method yields `AIMessageChunk` objects. This is where LangChain adds value: you can compose this model into chains, RAG pipelines, or agents without changing the interface.

### `server/src/pdf/pdfExtractor.js`
Uses `pdf-parse` to extract plain text from a PDF buffer. The `trimContext()` function limits the text to 12,000 characters to avoid exceeding the LLM's context window.

### `server/src/ws/websocketServer.js`
The WebSocket server that ties everything together. It receives chat requests, injects PDF context, calls the appropriate LLM function (direct or LangChain), and streams tokens back to the client in real time.

### `server/src/index.js`
The Express HTTP server. Handles two endpoints:
- `GET /api/health` — returns provider info and server status
- `POST /api/extract-pdf` — accepts a PDF upload, extracts text, returns it

Also starts the WebSocket server on a separate port.

### `src/App.tsx`
The React frontend. A single-file chat application that:
- Connects to the WebSocket server for real-time streaming
- Uploads PDFs to the Express server for text extraction
- Toggles between Direct and LangChain modes
- Renders messages with a typewriter streaming effect

### `php-backend/controllers/AiController.php`
A Yii2 controller that demonstrates how a PHP backend can act as an API gateway in front of the Node.js service. It proxies health checks and PDF extraction requests. For streaming, the frontend connects to the WebSocket server directly (PHP is not ideal for long-lived WebSocket connections).

---

## Switching LLM Providers

To switch from Groq to OpenAI (or vice versa), edit `server/.env`:

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4o-mini
```

No code changes required. The `provider.js` module reads the active provider and configures the SDK client accordingly. Both `directLlm.js` and `langchainLlm.js` use the same client interface.

To add a new provider (e.g., a local LLM server):
1. Add its config block to `server/src/config.js`
2. Handle it in `server/src/llm/provider.js` (if it's OpenAI-compatible, just add a new `baseURL`)

---

## Error Handling

- **Missing API key**: `validateConfig()` throws on server start with a clear message.
- **Invalid WebSocket message**: Server returns an error JSON instead of crashing.
- **LLM API errors**: Caught and sent to the client as `{ type: "error", message: "..." }`.
- **PDF extraction failures**: Caught and returned as HTTP 500 with the error message.
- **File type validation**: Multer rejects non-PDF uploads before processing.
- **File size limit**: Configurable via `MAX_PDF_MB` in `.env`.
- **Frontend connection errors**: Displayed in a red banner; the chat message shows the error inline.

---

## Security Notes

- All API keys are stored in `.env` files — never hard-coded in source.
- `.env` files should be in `.gitignore` (never committed).
- The server validates that an API key exists before starting.
- PDF uploads are validated by MIME type and size-limited.
- The WebSocket server handles malformed JSON gracefully.

---

## Use Cases

This project is designed for legitimate, educational purposes:

- **Document Q&A**: Upload a PDF and ask questions about its content
- **Meeting notes**: Paste meeting transcripts and ask for summaries
- **Coding assistant**: Ask questions about code concepts or get explanations
- **Learning resource**: Understand how LLM APIs, LangChain, and WebSocket streaming work together
