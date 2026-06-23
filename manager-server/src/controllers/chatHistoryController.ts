// ─── Chat History Controller (Multi-Session) ───
// Manages chat sessions and messages like ChatGPT
import { Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";

// GET /api/sessions — List all chat sessions for user
export async function listSessions(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const { data, error } = await supabaseAdmin
      .from("chat_sessions")
      .select("id, title, created_at, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ sessions: data || [] });
  } catch (err: any) {
    console.error("[Sessions] List error:", err.message);
    res.status(500).json({ error: "Failed to load sessions." });
  }
}

// POST /api/sessions — Create a new chat session
export async function createSession(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const title = req.body.title || "New Chat";

    const { data, error } = await supabaseAdmin
      .from("chat_sessions")
      .insert({ user_id: userId, title })
      .select("id, title, created_at, updated_at")
      .single();

    if (error) throw error;
    res.json({ session: data });
  } catch (err: any) {
    console.error("[Sessions] Create error:", err.message);
    res.status(500).json({ error: "Failed to create session." });
  }
}

// PATCH /api/sessions/:id — Update session title
export async function updateSession(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const sessionId = req.params.id;
    const { title } = req.body;

    const { error } = await supabaseAdmin
      .from("chat_sessions")
      .update({ title, updated_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("user_id", userId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    console.error("[Sessions] Update error:", err.message);
    res.status(500).json({ error: "Failed to update session." });
  }
}

// DELETE /api/sessions/:id — Delete session + messages + memory + Pinecone vectors
export async function deleteSession(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const sessionId = req.params.id;

    // 1. Find memory_logs for this session (to get Pinecone vector IDs)
    const { data: memoryLogs } = await supabaseAdmin
      .from("memory_logs")
      .select("id")
      .eq("user_id", userId)
      .eq("session_id", sessionId);

    // 2. Delete Pinecone vectors by IDs
    if (memoryLogs && memoryLogs.length > 0) {
      const vectorIds = memoryLogs.map(log => log.id);
      try {
        const { pineconeIndex } = await import("../config/pinecone.js");
        await pineconeIndex.namespace(userId).deleteMany(vectorIds);
        console.log(`[Sessions] 🗑️ Deleted ${vectorIds.length} Pinecone vectors for session ${sessionId}`);
      } catch (pineconeErr: any) {
        console.error("[Sessions] Pinecone cleanup error:", pineconeErr.message);
      }
    }

    // 3. Delete memory_logs for this session
    await supabaseAdmin
      .from("memory_logs")
      .delete()
      .eq("user_id", userId)
      .eq("session_id", sessionId);

    // 4. Delete the session (CASCADE deletes chat_messages)
    const { error } = await supabaseAdmin
      .from("chat_sessions")
      .delete()
      .eq("id", sessionId)
      .eq("user_id", userId);

    if (error) throw error;
    console.log(`[Sessions] ✅ Fully deleted session ${sessionId} (messages + memory + vectors)`);
    res.json({ success: true });
  } catch (err: any) {
    console.error("[Sessions] Delete error:", err.message);
    res.status(500).json({ error: "Failed to delete session." });
  }
}

// GET /api/chats?session_id=X — Load messages for a specific session
export async function loadChats(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const sessionId = req.query.session_id as string;

    let query = supabaseAdmin
      .from("chat_messages")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(200);

    if (sessionId) {
      query = query.eq("session_id", sessionId);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (err: any) {
    console.error("[ChatHistory] Load error:", err.message);
    res.status(500).json({ error: "Failed to load chat history." });
  }
}

// POST /api/chats/save — Save a message (with session_id)
export async function saveChat(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const { role, content, session_id } = req.body;

    if (!role || !content) {
      res.status(400).json({ error: "role and content are required." });
      return;
    }

    const insertData: any = { user_id: userId, role, content };
    if (session_id) insertData.session_id = session_id;

    const { data, error } = await supabaseAdmin
      .from("chat_messages")
      .insert(insertData)
      .select("id, created_at")
      .single();

    if (error) throw error;

    // Auto-title: On first user message, update session title
    if (role === "user" && session_id) {
      const { data: msgCount } = await supabaseAdmin
        .from("chat_messages")
        .select("id", { count: "exact", head: true })
        .eq("session_id", session_id);

      // If this is among the first messages, update title
      const title = content.substring(0, 50) + (content.length > 50 ? "..." : "");
      await supabaseAdmin
        .from("chat_sessions")
        .update({ title, updated_at: new Date().toISOString() })
        .eq("id", session_id)
        .eq("user_id", userId);
    }

    res.json({ success: true, id: data.id, created_at: data.created_at });
  } catch (err: any) {
    console.error("[ChatHistory] Save error:", err.message);
    res.status(500).json({ error: "Failed to save message." });
  }
}

// DELETE /api/chats — Clear all chat history for user
export async function clearChats(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const { error } = await supabaseAdmin
      .from("chat_messages")
      .delete()
      .eq("user_id", userId);

    if (error) throw error;
    res.json({ success: true, message: "Chat history cleared." });
  } catch (err: any) {
    console.error("[ChatHistory] Clear error:", err.message);
    res.status(500).json({ error: "Failed to clear chat history." });
  }
}
