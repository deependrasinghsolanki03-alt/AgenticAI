// ─── Scheduled Tasks Controller ─────────────────
// API endpoints for listing and cancelling scheduled tasks
import { Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";

// GET /api/tasks — List user's scheduled tasks
export async function listScheduledTasks(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const status = req.query.status as string || undefined;

    let query = supabaseAdmin
      .from("scheduled_tasks")
      .select("id, instruction, scheduled_time, repeat_pattern, repeat_until, max_runs, run_count, status, last_run_at, created_at")
      .eq("user_id", userId)
      .order("scheduled_time", { ascending: true })
      .limit(50);

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ tasks: data || [] });
  } catch (err: any) {
    console.error("[Tasks] List error:", err.message);
    res.status(500).json({ error: "Failed to load tasks." });
  }
}

// DELETE /api/tasks/:id — Cancel a scheduled task
export async function cancelScheduledTask(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const taskId = req.params.id;

    const { error } = await supabaseAdmin
      .from("scheduled_tasks")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", taskId)
      .eq("user_id", userId)
      .eq("status", "pending");

    if (error) throw error;
    console.log(`[Tasks] Cancelled task ${taskId}`);
    res.json({ success: true, message: "Task cancelled." });
  } catch (err: any) {
    console.error("[Tasks] Cancel error:", err.message);
    res.status(500).json({ error: "Failed to cancel task." });
  }
}
