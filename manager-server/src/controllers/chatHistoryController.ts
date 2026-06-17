// ─── Chat History Controller ────────────────────
// Save and load chat messages from Supabase
import { Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";

// GET /api/chats — Load chat history for the logged-in user
export async function loadChats(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const { data, error } = await supabaseAdmin
      .from("chat_messages")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (err: any) {
    console.error("[ChatHistory] Load error:", err.message);
    res.status(500).json({ error: "Failed to load chat history." });
  }
}

// POST /api/chats/save — Save a single message (user or assistant)
export async function saveChat(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const { role, content } = req.body;

    if (!role || !content) {
      res.status(400).json({ error: "role and content are required." });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from("chat_messages")
      .insert({ user_id: userId, role, content })
      .select("id, created_at")
      .single();

    if (error) throw error;
    res.json({ success: true, id: data.id, created_at: data.created_at });
  } catch (err: any) {
    console.error("[ChatHistory] Save error:", err.message);
    res.status(500).json({ error: "Failed to save message." });
  }
}

// DELETE /api/chats — Clear all chat history for the user
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
