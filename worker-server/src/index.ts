// ─── Worker Server — Entry Point ────────────────
// Port 5001 — Heavy Thinker with Web Scraping.
// NO embedding model loaded (saves ~100MB RAM).

import "dotenv/config";
import express from "express";
import cors from "cors";
import { internalAuth } from "./middleware/internalAuth.js";
import { handleDelegate } from "./controllers/delegateController.js";

const app = express();
const PORT = parseInt(process.env.PORT || "5001", 10);

// Middleware
app.use(cors({ origin: ["http://localhost:5000"], credentials: true }));
app.use(express.json({ limit: "10mb" }));

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// Routes
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "AgenticAI Worker v2",
    model: "llama-3.3-70b-versatile",
    tools: ["deep_web_scraper", "deep_memory_search"],
    embedding: "None (uses Manager's /api/embed)",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/delegate", internalAuth, handleDelegate);

app.get("/", (_req, res) => {
  res.json({
    name: "AgenticAI Worker Server",
    version: "2.0.0",
    role: "Heavy Thinker + Web Scraper",
    model: "llama-3.3-70b-versatile",
    endpoint: "POST /api/delegate (SSE stream, internal only)",
  });
});

app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found.` });
});

// Boot
app.listen(PORT, () => {
  console.log(`\n🔬 AgenticAI Worker v2 is live on http://localhost:${PORT}`);
  console.log(`   ├─ Health:     GET  http://localhost:${PORT}/api/health`);
  console.log(`   └─ Delegate:   POST http://localhost:${PORT}/api/delegate (SSE)`);
  console.log(`\n   🧠 Model:      llama-3.3-70b-versatile (deep reasoning)`);
  console.log(`   🌐 Scraper:    SearxNG + Jina Reader (free)`);
  console.log(`   📚 Memory:     Pinecone via Manager's /api/embed`);
  console.log(`   🔒 Auth:       Internal shared secret\n`);
});
