// ─── Chat Controller (SSE Streaming) ────────────
import { Request, Response } from "express";
import { PineconeStore } from "@langchain/pinecone";
import { supabaseAdmin } from "../config/supabase.js";
import { pineconeIndex } from "../config/pinecone.js";
import { getEmbeddingModel } from "../services/embedding.js";
import { getGoogleAuthClient } from "../config/googleAuth.js";
import { runPlanner } from "../services/planner.js";
import { extractFacts } from "../services/factExtractor.js";
import { parseFile } from "../services/fileParser.js";

function sendEvent(res: Response, event: string, data: Record<string, unknown>) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function handleChat(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  const userId = req.user_id!;
  const { message, session_id, file } = req.body;

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

    // Parse file attachment if present
    let fileContext = "";
    if (file && file.name && file.data) {
      sendEvent(res, "status", { stage: "file", detail: `Reading: ${file.name}...` });
      try {
        const parsed = await parseFile(file.name, file.type || "", file.data);
        
        fileContext = `\n=== ATTACHED FILE: ${file.name} ===\nSummary: ${parsed.summary}\nContent:\n${parsed.text}\n=============================\n\n`;
        contextText = fileContext + contextText;
      } catch (fileErr: any) {
        console.error("[Chat] File parse error:", fileErr.message);
      }
    }

    // Google Auth
    sendEvent(res, "status", { stage: "planning", detail: "Planning response..." });
    const googleAuthClient = await getGoogleAuthClient(userId);

    // Get user's email for personalized emails
    let userEmail: string | undefined;
    try {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
      userEmail = userData?.user?.email || undefined;
    } catch {} // silently fail

    // Planner
    const onStatus = (detail: string) => sendEvent(res, "status", { stage: "researching", detail });
    const plannerResult = await runPlanner({ userMessage, context: contextText, userId, userEmail, googleAuthClient: googleAuthClient as any, embeddings, onStatus });

    if (plannerResult.toolsUsed.length > 0) {
      for (const tool of plannerResult.toolsUsed) sendEvent(res, "tool", { name: tool.tool, input: tool.input });
    }

    // Emit confirmation events for HITL pending actions
    if (plannerResult.pendingActions && plannerResult.pendingActions.length > 0) {
      for (const action of plannerResult.pendingActions) {
        sendEvent(res, "confirm", { action_id: action.id, tool: action.tool, args: action.args });
      }
    }

    // Send response IMMEDIATELY
    sendEvent(res, "done", { response: plannerResult.output, tools_used: plannerResult.toolsUsed, elapsed_ms: Date.now() - startTime });

    // Fact-Based Memory write-back (after response)
    try {
      const facts = await extractFacts(userMessage, plannerResult.output);
      if (facts) {
        // Save extracted facts (not raw chat)
        const { data: savedLog, error: saveError } = await supabaseAdmin.from("memory_logs").insert({ user_id: userId, log_text: facts, session_id: session_id || null }).select("id").single();
        if (!saveError && savedLog?.id) {
          const store = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex, namespace: userId });
          await store.addDocuments([{ pageContent: facts, metadata: { log_id: savedLog.id, user_id: userId, session_id: session_id || "", timestamp: new Date().toISOString() } }], { ids: [savedLog.id] });
          console.log(`[Memory] Saved facts: ${savedLog.id} (${facts.length} chars)`);
        }
      } else {
        console.log("[Memory] No facts to save — skipped.");
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
