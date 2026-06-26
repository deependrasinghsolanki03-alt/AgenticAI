// ─── Pending Actions Controller (HITL Confirmation) ─────────
// Handles user approval/rejection of high-stakes actions like email sends
import { Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { getGoogleAuthClient } from "../config/googleAuth.js";
import { createGmailTool } from "../tools/gmailTool.js";

// GET /api/actions/pending — List user's pending actions
export async function listPendingActions(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const { data, error } = await supabaseAdmin
      .from("pending_actions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json({ actions: data || [] });
  } catch (err: any) {
    console.error("[HITL] List error:", err.message);
    res.status(500).json({ error: "Failed to load pending actions." });
  }
}

// POST /api/actions/:id/approve — Execute the pending action
export async function approveAction(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const actionId = req.params.id;

    // 1. Fetch the pending action
    const { data: action, error: fetchErr } = await supabaseAdmin
      .from("pending_actions")
      .select("*")
      .eq("id", actionId)
      .eq("user_id", userId)
      .eq("status", "pending")
      .single();

    if (fetchErr || !action) {
      res.status(404).json({ error: "Action not found or already resolved." });
      return;
    }

    // 2. Execute the action based on tool_name
    let result = "";
    try {
      if (action.tool_name === "gmail_send") {
        const args = action.arguments as { to: string; subject: string; body: string };
        const googleAuth = await getGoogleAuthClient(userId);
        const gmailTool = createGmailTool(googleAuth as any);
        result = await gmailTool.invoke({ action: "send", to: args.to, subject: args.subject, body: args.body });
        console.log(`[HITL] Email sent to ${args.to} (approved by user)`);
      } else {
        result = `Unknown tool: ${action.tool_name}`;
      }
    } catch (execErr: any) {
      result = `Execution failed: ${execErr.message}`;
    }

    // 3. Mark as approved
    await supabaseAdmin
      .from("pending_actions")
      .update({ status: "approved", resolved_at: new Date().toISOString() })
      .eq("id", actionId);

    res.json({ success: true, result, message: "Action approved and executed." });
  } catch (err: any) {
    console.error("[HITL] Approve error:", err.message);
    res.status(500).json({ error: "Failed to approve action." });
  }
}

// POST /api/actions/:id/reject — Cancel the pending action
export async function rejectAction(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user_id!;
    const actionId = req.params.id;

    const { error } = await supabaseAdmin
      .from("pending_actions")
      .update({ status: "rejected", resolved_at: new Date().toISOString() })
      .eq("id", actionId)
      .eq("user_id", userId);

    if (error) throw error;
    console.log(`[HITL] Action ${actionId} rejected by user`);
    res.json({ success: true, message: "Action rejected." });
  } catch (err: any) {
    console.error("[HITL] Reject error:", err.message);
    res.status(500).json({ error: "Failed to reject action." });
  }
}
