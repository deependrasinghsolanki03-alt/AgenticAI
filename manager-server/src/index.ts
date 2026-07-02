// ─── Manager Server — Entry Point ───────────────
import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { verifyAuth } from "./middleware/auth.js";
import { handleChat } from "./controllers/chatController.js";
import { handleEmbed } from "./controllers/embedController.js";
import { loadChats, saveChat, clearChats, listSessions, createSession, updateSession, deleteSession } from "./controllers/chatHistoryController.js";
import { listScheduledTasks, cancelScheduledTask } from "./controllers/taskController.js";
import { listMemories, deleteMemory } from "./controllers/memoryController.js";
import { listPendingActions, approveAction, rejectAction } from "./controllers/pendingActionController.js";
import { listStyleProfiles, saveStyleProfile, deleteStyleProfile } from "./controllers/personalizationController.js";
import { initEmbeddingModel } from "./services/embedding.js";
import { initRuleRegistry } from "./services/ruleRegistry.js";
import { startScheduler } from "./services/scheduler.js";
import { saveGoogleTokens } from "./config/googleAuth.js";
import { initKeyRotator } from "./utils/keyRotator.js";
import { createServer } from "http";
import { initSocketServer } from "./controllers/socketHandler.js";

// Rate Limiters
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15,
  message: { error: "⏳ Too many requests! Please wait a minute before sending more messages." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user_id || req.ip || "unknown",
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "⏳ Rate limit reached. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

const app = express();
const httpServer = createServer(app);
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
// Apply rate limiters
app.use("/api/", apiLimiter);
app.post("/api/chat", verifyAuth, chatLimiter, handleChat);

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

// Scheduled Tasks
app.get("/api/tasks", verifyAuth, listScheduledTasks);
app.delete("/api/tasks/:id", verifyAuth, cancelScheduledTask);

// Memories
app.get("/api/memories", verifyAuth, listMemories);
app.delete("/api/memories/:id", verifyAuth, deleteMemory);

// HITL Confirmation (Pending Actions)
app.get("/api/actions/pending", verifyAuth, listPendingActions);
app.post("/api/actions/:id/approve", verifyAuth, approveAction);
app.post("/api/actions/:id/reject", verifyAuth, rejectAction);

// ── Personalization ──
app.get("/api/personalization", verifyAuth, listStyleProfiles);
app.post("/api/personalization", verifyAuth, saveStyleProfile);
app.delete("/api/personalization/:id", verifyAuth, deleteStyleProfile);

// Scheduler Tick — called by cron-job.org (protected by secret)
// Responds INSTANTLY, processes tasks in background (fits 30s timeout)
app.get("/api/scheduler/tick", async (req, res) => {
  const secret = req.query.secret || req.headers["x-scheduler-secret"];
  const expectedSecret = process.env.INTERNAL_SECRET || "agenticai-internal-secret-2026";
  if (secret !== expectedSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // Respond immediately — don't make cron-job.org wait
  res.json({ status: "ok", message: "Scheduler tick started", timestamp: new Date().toISOString() });
  
  // Process tasks in background (after response sent)
  try {
    const { runSchedulerTick } = await import("./services/scheduler.js");
    const result = await runSchedulerTick();
    console.log(`[Scheduler Tick] Done — Processed: ${result.processed}, Errors: ${result.errors}`);
  } catch (err: any) {
    console.error("[Scheduler Tick] Background error:", err.message);
  }
});

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
    await initRuleRegistry();  // Pre-embed planner rules (depends on embedding model)
    // Initialize Socket.io on the HTTP server
    const io = initSocketServer(httpServer);
    httpServer.listen(PORT, () => {
      console.log(`\n🚀 AgenticAI Manager v3 is live on http://localhost:${PORT}`);
      console.log(`   ├─ Health:     GET  /api/health`);
      console.log(`   ├─ Chat (SSE): POST /api/chat`);
      console.log(`   ├─ Chat (WS):  Socket.io /socket.io/`);
      console.log(`   ├─ Embed:      POST /api/embed (internal)`);
      console.log(`   └─ Tokens:     POST /api/auth/save-tokens`);
      console.log(`\n   🎯 Planner:    llama-3.1-8b-instant`);
      console.log(`   🔬 Worker:     ${process.env.WORKER_URL}`);
      console.log(`   🔤 Embedding:  Xenova/all-MiniLM-L6-v2 (384-dim)`);
      console.log(`   📋 Rules:      Dynamic RAG (In-Memory Semantic Registry)`);
      console.log(`   🔒 Auth:       Supabase JWT + Google refresh_token`);
      console.log(`   🌐 Socket.io:  WebSocket + polling fallback`);
      console.log(`   ⏰ Scheduler:  Background task runner (60s interval)\n`);
      startScheduler();
    });
  } catch (err) { console.error("❌ Boot failed:", err); process.exit(1); }
}

boot();
