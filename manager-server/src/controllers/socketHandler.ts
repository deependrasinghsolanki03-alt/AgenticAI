// ─── Socket.io Chat Handler ─────────────────────
// WebSocket fallback for clients that can't use SSE.
// Reuses the same planner, memory, and auth logic.

import { Server as SocketServer, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { PineconeStore } from "@langchain/pinecone";
import { supabaseAdmin } from "../config/supabase.js";
import { pineconeIndex } from "../config/pinecone.js";
import { getEmbeddingModel } from "../services/embedding.js";
import { getGoogleAuthClient } from "../config/googleAuth.js";
import { runPlanner } from "../services/planner.js";
import { extractFacts } from "../services/factExtractor.js";
import { parseFile } from "../services/fileParser.js";

export function initSocketServer(httpServer: HttpServer): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // Auth middleware: verify Supabase JWT
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication required"));

    try {
      const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !user) return next(new Error("Invalid token"));
      (socket as any).user_id = user.id;
      (socket as any).user_email = user.email;
      next();
    } catch {
      next(new Error("Auth verification failed"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId = (socket as any).user_id;
    console.log(`[Socket.io] Connected: ${userId}`);

    socket.on("chat", async (data: { message: string; session_id?: string; file?: any }) => {
      const startTime = Date.now();
      const { message, session_id, file } = data;

      if (!message?.trim()) {
        socket.emit("error", { message: "Message is required." });
        return;
      }

      const userMessage = message.trim();
      console.log(`[Socket.io] Chat from ${userId}: "${userMessage.substring(0, 80)}"`);

      try {
        socket.emit("status", { stage: "memory", detail: "Retrieving memory..." });
        const embeddings = await getEmbeddingModel();

        // Short-term memory
        let shortTermContext = "";
        let query = supabaseAdmin
          .from("chat_messages")
          .select("role, content")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(6);
        if (session_id) query = query.eq("session_id", session_id);
        const { data: recentMessages } = await query;

        if (recentMessages?.length) {
          shortTermContext = "=== RECENT CONVERSATION HISTORY ===\n" +
            recentMessages.reverse().map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n") +
            "\n===================================\n\n";
        }

        // Long-term memory
        const vectorStore = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex, namespace: userId });
        const retrievedDocs = await vectorStore.similaritySearch(userMessage, 3);
        let longTermContext = "";
        if (retrievedDocs.length > 0) {
          const logIds = retrievedDocs.map(d => d.metadata?.log_id).filter(Boolean);
          if (logIds.length > 0) {
            const { data: logs } = await supabaseAdmin.from("memory_logs").select("log_text").in("id", logIds).eq("user_id", userId);
            if (logs?.length) longTermContext = logs.map(l => l.log_text).join("\n\n---\n\n");
          }
          if (!longTermContext) longTermContext = retrievedDocs.map(d => d.pageContent).join("\n\n---\n\n");
          longTermContext = "=== RELEVANT PAST MEMORIES ===\n" + longTermContext + "\n==============================\n\n";
        }

        let contextText = shortTermContext + longTermContext || "No prior conversation history.";

        // Parse file if present
        if (file?.name && file?.data) {
          socket.emit("status", { stage: "file", detail: `Reading: ${file.name}...` });
          try {
            const parsed = await parseFile(file.name, file.type || "", file.data);
            contextText = `\n=== ATTACHED FILE: ${file.name} ===\nSummary: ${parsed.summary}\nContent:\n${parsed.text}\n=============================\n\n` + contextText;
          } catch {}
        }

        // Google Auth + Planner
        socket.emit("status", { stage: "planning", detail: "Planning response..." });
        const googleAuthClient = await getGoogleAuthClient(userId);

        let userEmail: string | undefined;
        try {
          const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
          userEmail = userData?.user?.email || undefined;
        } catch {}

        const onStatus = (detail: string) => socket.emit("status", { stage: "researching", detail });
        const plannerResult = await runPlanner({
          userMessage, context: contextText, userId, userEmail,
          googleAuthClient: googleAuthClient as any, embeddings, onStatus,
        });

        // Emit tool events
        for (const tool of plannerResult.toolsUsed) {
          socket.emit("tool", { name: tool.tool, input: tool.input });
        }

        // Emit HITL confirmations
        if (plannerResult.pendingActions?.length) {
          for (const action of plannerResult.pendingActions) {
            socket.emit("confirm", { action_id: action.id, tool: action.tool, args: action.args });
          }
        }

        // Done!
        socket.emit("done", {
          response: plannerResult.output,
          tools_used: plannerResult.toolsUsed,
          elapsed_ms: Date.now() - startTime,
        });

        // Fact-based memory write-back
        try {
          const facts = await extractFacts(userMessage, plannerResult.output);
          if (facts) {
            const { data: savedLog, error: saveError } = await supabaseAdmin
              .from("memory_logs").insert({ user_id: userId, log_text: facts, session_id: session_id || null }).select("id").single();
            if (!saveError && savedLog?.id) {
              const store = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex, namespace: userId });
              await store.addDocuments(
                [{ pageContent: facts, metadata: { log_id: savedLog.id, user_id: userId, session_id: session_id || "", timestamp: new Date().toISOString() } }],
                { ids: [savedLog.id] }
              );
            }
          }
        } catch {}

        console.log(`[Socket.io] Done in ${Date.now() - startTime}ms`);
      } catch (err: any) {
        console.error("[Socket.io] Error:", err.message);
        socket.emit("error", { message: err.message });
      }
    });

    socket.on("disconnect", () => {
      console.log(`[Socket.io] Disconnected: ${userId}`);
    });
  });

  console.log("[Socket.io] Server initialized");
  return io;
}
