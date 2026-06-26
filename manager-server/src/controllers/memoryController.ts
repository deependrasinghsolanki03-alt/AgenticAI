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

    // Format: extract a short preview from each log
    const memories = (data || []).map(m => {
      let previewText = m.log_text.replace(/\n/g, " ").trim();
      if (previewText.length > 50) {
        previewText = previewText.substring(0, 50) + "...";
      }
      return {
        id: m.id,
        preview: previewText,
        full_text: m.log_text,
        created_at: m.created_at,
        session_id: m.session_id,
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
