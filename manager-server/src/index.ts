// ─── Manager Server — Entry Point ───────────────
import "dotenv/config";
import express from "express";
import cors from "cors";
import { verifyAuth } from "./middleware/auth.js";
import { handleChat } from "./controllers/chatController.js";
import { handleEmbed } from "./controllers/embedController.js";
import { loadChats, saveChat, clearChats, listSessions, createSession, updateSession, deleteSession } from "./controllers/chatHistoryController.js";
import { initEmbeddingModel } from "./services/embedding.js";
import { saveGoogleTokens } from "./config/googleAuth.js";
import { initKeyRotator } from "./utils/keyRotator.js";

const app = express();
const PORT = parseInt(process.env.PORT || "5000", 10);

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`));
  next();
});

// Health
app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "AgenticAI Manager v2", timestamp: new Date().toISOString() }));

// Save Google refresh_token
app.post("/api/auth/save-tokens", verifyAuth, async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) { res.status(400).json({ error: "refresh_token required." }); return; }
    await saveGoogleTokens(req.user_id!, refresh_token);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: "Failed to save credentials." }); }
});

// Chat (SSE)
app.post("/api/chat", verifyAuth, handleChat);

// Internal Embed API (for Worker Server)
app.post("/api/embed", handleEmbed);

// Sessions
app.get("/api/sessions", verifyAuth, listSessions);
app.post("/api/sessions", verifyAuth, createSession);
app.patch("/api/sessions/:id", verifyAuth, updateSession);
app.delete("/api/sessions/:id", verifyAuth, deleteSession);

// Chat History
app.get("/api/chats", verifyAuth, loadChats);
app.post("/api/chats/save", verifyAuth, saveChat);
app.delete("/api/chats", verifyAuth, clearChats);

// Info
app.get("/", (_req, res) => res.json({
  name: "AgenticAI Manager v2", version: "2.0.0",
  architecture: "2-Server Microservices (Manager + Worker)",
  planner: "llama-3.1-8b-instant", worker: `${process.env.WORKER_URL}`,
  endpoints: { chat: "POST /api/chat (SSE)", embed: "POST /api/embed (internal)", health: "GET /api/health" },
}));

app.use((req, res) => res.status(404).json({ error: `${req.method} ${req.originalUrl} not found.` }));

async function boot() {
  try {
    initKeyRotator();
    await initEmbeddingModel();
    app.listen(PORT, () => {
      console.log(`\n🚀 AgenticAI Manager v2 is live on http://localhost:${PORT}`);
      console.log(`   ├─ Health:     GET  /api/health`);
      console.log(`   ├─ Chat (SSE): POST /api/chat`);
      console.log(`   ├─ Embed:      POST /api/embed (internal)`);
      console.log(`   └─ Tokens:     POST /api/auth/save-tokens`);
      console.log(`\n   🎯 Planner:    llama-3.1-8b-instant`);
      console.log(`   🔬 Worker:     ${process.env.WORKER_URL}`);
      console.log(`   🔤 Embedding:  Xenova/all-MiniLM-L6-v2 (384-dim)`);
      console.log(`   🔒 Auth:       Supabase JWT + Google refresh_token\n`);
    });
  } catch (err) { console.error("❌ Boot failed:", err); process.exit(1); }
}

boot();
