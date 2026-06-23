// ─── Chat Controller (SSE Streaming) ────────────
import { Request, Response } from "express";
import { PineconeStore } from "@langchain/pinecone";
import { supabaseAdmin } from "../config/supabase.js";
import { pineconeIndex } from "../config/pinecone.js";
import { getEmbeddingModel } from "../services/embedding.js";
import { getGoogleAuthClient } from "../config/googleAuth.js";
import { runPlanner } from "../services/planner.js";

function sendEvent(res: Response, event: string, data: Record<string, unknown>) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function handleChat(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  const userId = req.user_id!;
  const { message, session_id } = req.body;

  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Field 'message' is required." });
    return;
  }
  const userMessage = message.trim();
  console.log(`\n${"═".repeat(60)}\n[Chat] User: ${userId}\n[Chat] Message: "${userMessage.substring(0, 100)}"\n${"═".repeat(60)}`);

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    sendEvent(res, "status", { stage: "memory", detail: "Retrieving memory..." });
    const embeddings = await getEmbeddingModel();

    // 1. Short-term Memory (Recent Chat History — filtered by session)
    let shortTermContext = "";
    let query = supabaseAdmin
      .from("chat_messages")
      .select("role, content")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(6);

    // Filter by session if provided — keeps sessions isolated
    if (session_id) {
      query = query.eq("session_id", session_id);
    }

    const { data: recentMessages } = await query;

    if (recentMessages && recentMessages.length > 0) {
      shortTermContext = "=== RECENT CONVERSATION HISTORY ===\n" + 
        recentMessages.reverse().map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n") + 
        "\n===================================\n\n";
    }

    // 2. Long-term Memory (Pinecone RAG)
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

    let contextText = shortTermContext + longTermContext;
    if (!contextText.trim()) {
      contextText = "No prior conversation history.";
    }

    // Google Auth
    sendEvent(res, "status", { stage: "planning", detail: "Planning response..." });
    const googleAuthClient = await getGoogleAuthClient(userId);

    // Planner
    const onStatus = (detail: string) => sendEvent(res, "status", { stage: "researching", detail });
    const plannerResult = await runPlanner({ userMessage, context: contextText, userId, googleAuthClient: googleAuthClient as any, embeddings, onStatus });

    if (plannerResult.toolsUsed.length > 0) {
      for (const tool of plannerResult.toolsUsed) sendEvent(res, "tool", { name: tool.tool, input: tool.input });
    }

    // Send response IMMEDIATELY
    sendEvent(res, "done", { response: plannerResult.output, tools_used: plannerResult.toolsUsed, elapsed_ms: Date.now() - startTime });

    // Memory write-back (after response)
    const logText = `User: ${userMessage}\nAssistant: ${plannerResult.output}`;
    try {
      const { data: savedLog, error: saveError } = await supabaseAdmin.from("memory_logs").insert({ user_id: userId, log_text: logText }).select("id").single();
      if (!saveError && savedLog?.id) {
        const store = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex, namespace: userId });
        await store.addDocuments([{ pageContent: logText, metadata: { log_id: savedLog.id, user_id: userId, timestamp: new Date().toISOString() } }], { ids: [savedLog.id] });
        console.log(`[Memory] Saved: ${savedLog.id}`);
      }
    } catch (memErr: any) { console.error("[Memory] Error:", memErr.message); }

    console.log(`[Chat] Done in ${Date.now() - startTime}ms\n`);
    res.end();
  } catch (err: any) {
    console.error("[Chat] Fatal:", err);
    sendEvent(res, "error", { message: process.env.NODE_ENV !== "production" ? err.message : "An error occurred." });
    res.end();
  }
}
