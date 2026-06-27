// ─── Memory Management Controller ─────────────────
// API endpoints for listing and deleting user memories
import { Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { pineconeIndex } from "../config/pinecone.js";

// GET /api/memories — List user's memories
export async function listMemories(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const limit = parseInt(req.query.limit as string) || 20;

    const { data, error } = await supabaseAdmin
      .from("memory_logs")
      .select("id, log_text, created_at, session_id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    // Format: extract a clean short preview from each log
    const memories = (data || []).map(m => {
      // Extract just the user's part, strip "User:" / "Assistant:" prefixes
      let preview = m.log_text.replace(/\n/g, " ").trim();
      const userMatch = preview.match(/^User:\s*(.+?)(?:\s*Assistant:|$)/i);
      if (userMatch) preview = userMatch[1].trim();
      if (preview.length > 60) preview = preview.substring(0, 57) + "...";
      return {
        id: m.id,
        preview,
        created_at: m.created_at,
      };
    });

    res.json({ memories });
  } catch (err: any) {
    console.error("[Memories] List error:", err.message);
    res.status(500).json({ error: "Failed to load memories." });
  }
}

// DELETE /api/memories/:id — Delete a specific memory
export async function deleteMemory(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const memoryId = req.params.id;

    // 1. Delete from Pinecone
    try {
      const ns = pineconeIndex.namespace(userId);
      await ns.deleteMany([memoryId]);
      console.log(`[Memories] Deleted Pinecone vector: ${memoryId}`);
    } catch (pineconeErr: any) {
      console.warn(`[Memories] Pinecone delete failed (may not exist): ${pineconeErr.message}`);
    }

    // 2. Delete from Supabase
    const { error } = await supabaseAdmin
      .from("memory_logs")
      .delete()
      .eq("id", memoryId)
      .eq("user_id", userId);

    if (error) throw error;
    console.log(`[Memories] Deleted memory: ${memoryId}`);
    res.json({ success: true, message: "Memory deleted." });
  } catch (err: any) {
    console.error("[Memories] Delete error:", err.message);
    res.status(500).json({ error: "Failed to delete memory." });
  }
}
