# 🤖 AgenticAI — AI Digital Soul

A **multi-agent AI assistant** powered by a DAG-based parallel micro-agent orchestrator. Built with an 8B Planner model that creates dependency graphs, a 70B Thinker model for deep research, and Node.js for parallel tool execution.

![AgenticAI](https://img.shields.io/badge/AgenticAI-v2.0-6366f1?style=for-the-badge&logo=robot&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22.x-339933?style=for-the-badge&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-19.x-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)

---

## 🏗️ Architecture

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   Frontend   │────▶│   Manager Server     │────▶│  Worker Server  │
│  React/Vite  │◀────│   (Port 5000)        │◀────│  (Port 5001)    │
│  Port 5173   │ SSE │   8B Planner         │     │  70B Thinker    │
└─────────────┘     │   Calendar/Gmail API  │     │  Web Scraper    │
                    │   Memory (Pinecone)   │     │  Deep Memory    │
                    └──────────────────────┘     └─────────────────┘
```

### How It Works

1. **Planner (8B)** — Receives user message, creates a **DAG task graph** (JSON) with dependencies
2. **Safety Layer (Node.js)** — Validates graph: checks for cycles, missing dependencies, unknown agents
3. **Parallel Executor (Node.js)** — Runs independent tasks simultaneously using `Promise.all()` in waves
4. **Parameter Extractors (8B)** — Convert raw text into exact API parameters for Calendar/Gmail
5. **Responder (8B)** — Combines all tool outputs into a clean, natural language reply

---

## ✨ Features

- 🧠 **DAG-based Parallel Execution** — Independent tasks run simultaneously
- 📅 **Google Calendar** — List, create, delete events with date-range filtering
- ✉️ **Gmail** — Search and send emails
- 🔍 **Deep Web Research** — SearxNG + DuckDuckGo fallback + Jina Reader
- 💾 **Memory** — Pinecone vector store for conversation history
- 🤖 **Animated Minion Character** — Cute robot that changes animation based on agent state
- 🔑 **3-Key API Rotation** — Round-robin Groq API key rotation with rate limit handling
- 🌊 **SSE Streaming** — Real-time status updates from backend to frontend

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 20+
- **npm** 10+
- Groq API Key(s)
- Google Cloud OAuth Credentials (Calendar + Gmail scopes)
- Supabase Project (Auth + DB)
- Pinecone Index (`agent-memory`)

### 1. Clone & Install

```bash
git clone https://github.com/deependrasinghsolanki03-alt/AgenticAI.git
cd AgenticAI

# Install all 3 servers
cd frontend && npm install && cd ..
cd manager-server && npm install && cd ..
cd worker-server && npm install && cd ..
```

### 2. Environment Variables

Create `.env` files in each server directory:

**`manager-server/.env`**
```env
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
PINECONE_API_KEY=your_pinecone_key
PINECONE_INDEX_NAME=agent-memory
GROQ_API_KEY=your_groq_key
GROQ_API_KEY_2=your_groq_key_2
GROQ_API_KEY_3=your_groq_key_3
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
WORKER_URL=http://localhost:5001
INTERNAL_SECRET=your_internal_secret
PORT=5000
```

**`worker-server/.env`**
```env
GROQ_API_KEY=your_groq_key
GROQ_API_KEY_2=your_groq_key_2
GROQ_API_KEY_3=your_groq_key_3
PINECONE_API_KEY=your_pinecone_key
PINECONE_INDEX_NAME=agent-memory
MANAGER_URL=http://localhost:5000
INTERNAL_SECRET=your_internal_secret
PORT=5001
```

**`frontend/.env`**
```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### 3. Run All 3 Servers

Open 3 terminals and run:

```bash
# Terminal 1 — Manager Server (Port 5000)
cd manager-server && npm run dev

# Terminal 2 — Worker Server (Port 5001)
cd worker-server && npm run dev

# Terminal 3 — Frontend (Port 5173)
cd frontend && npm run dev
```

Open `http://localhost:5173` in your browser.

---

## 📁 Project Structure

```
AgenticAI/
├── frontend/                  # React + Vite frontend
│   ├── src/
│   │   ├── pages/Chat.jsx     # Main chat UI with SSE streaming
│   │   ├── pages/Login.jsx    # Google OAuth login
│   │   ├── components/
│   │   │   └── MinionCharacter.jsx  # Animated robot character
│   │   ├── context/AuthContext.jsx   # Supabase auth context
│   │   └── index.css          # Deep navy dark theme
│   └── public/minion/         # Transparent .webm robot animations
│
├── manager-server/            # Gateway + Planner (Port 5000)
│   └── src/
│       ├── services/planner.ts      # DAG orchestrator + parallel executor
│       ├── tools/calendarTool.ts    # Google Calendar API
│       ├── tools/gmailTool.ts       # Gmail API
│       ├── tools/memoryTool.ts      # Pinecone memory
│       ├── tools/workerTool.ts      # Worker server delegation
│       └── utils/keyRotator.ts      # 3-key API rotation
│
└── worker-server/             # Deep Thinker (Port 5001)
    └── src/
        ├── services/thinker.ts      # 70B LLM agent with tools
        ├── tools/deepWebScraper.ts  # Web search + content extraction
        ├── tools/deepMemoryTool.ts  # Deep memory search
        └── utils/keyRotator.ts      # 3-key API rotation
```

---

## 🤖 Minion Character States

| Agent State | Animation |
|---|---|
| Idle | 😊 Happy face, standing |
| Planning / Thinking | 🤔 Finger on chin, processing |
| Checking Memory | 🧠 Brain hologram rotating |
| Searching Web | 🔍 Magnifying glass searching |
| Calendar Action | 📅 Touching calendar UI |
| Sending Email | ✉️ Typing on keyboard |
| Rate Limited | ⏳ Sitting with hourglass |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8, Vanilla CSS |
| Manager Server | Express, TypeScript, LangChain, Groq |
| Worker Server | Express, TypeScript, LangChain, Groq |
| LLM (Planner) | Llama 3.1 8B Instant |
| LLM (Thinker) | Llama 3.3 70B Versatile |
| Auth | Supabase + Google OAuth |
| Memory | Pinecone Vector DB |
| Streaming | Server-Sent Events (SSE) |

---

## 📄 License

MIT License — Built with ❤️ by [Deependra Singh Solanki](https://github.com/deependrasinghsolanki03-alt)
