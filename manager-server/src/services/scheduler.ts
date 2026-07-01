// ═══════════════════════════════════════════════════════════════
//  Task Scheduler — Background Cron Worker
//  Checks every 60 seconds for due tasks and executes them
// ═══════════════════════════════════════════════════════════════

import { supabaseAdmin } from "../config/supabase.js";
import { getGoogleAuthClient } from "../config/googleAuth.js";
import { getEmbeddingModel } from "../services/embedding.js";
import { runPlanner } from "../services/planner.js";

let isRunning = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

// ── Calculate next run time for recurring tasks ──
function getNextRunTime(currentTime: Date, pattern: string): Date | null {
  const next = new Date(currentTime);
  switch (pattern.toLowerCase()) {
    case "daily":
      next.setDate(next.getDate() + 1);
      return next;
    case "weekly":
      next.setDate(next.getDate() + 7);
      return next;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      return next;
    case "hourly":
      next.setHours(next.getHours() + 1);
      return next;
    default: {
      const match = pattern.match(/every\s+(\d+)\s+(minute|hour|day|week)s?/i);
      if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2].toLowerCase();
        if (unit === "minute") next.setMinutes(next.getMinutes() + amount);
        else if (unit === "hour") next.setHours(next.getHours() + amount);
        else if (unit === "day") next.setDate(next.getDate() + amount);
        else if (unit === "week") next.setDate(next.getDate() + amount * 7);
        return next;
      }
      return null;
    }
  }
}

// ── Execute a single scheduled task ──
async function executeTask(task: any): Promise<void> {
  console.log(`\n[Scheduler] ⏰ Executing task ${task.id}: "${task.instruction.substring(0, 60)}..."`);

  await supabaseAdmin
    .from("scheduled_tasks")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", task.id);

  try {
    const googleAuthClient = await getGoogleAuthClient(task.user_id);
    const embeddings = await getEmbeddingModel();

    let userEmail: string | undefined;
    try {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(task.user_id);
      userEmail = userData?.user?.email || undefined;
    } catch {}

    // Run planner with saved instruction — generates FRESH content each time!
    const result = await runPlanner({
      userMessage: task.instruction,
      context: "This is a SCHEDULED TASK being executed automatically. Generate fresh, unique content. Do NOT repeat previous content.",
      userId: task.user_id,
      userEmail,
      googleAuthClient: googleAuthClient as any,
      embeddings,
      onStatus: (s) => console.log(`[Scheduler] Status: ${s}`),
    });

    console.log(`[Scheduler] ✅ Task ${task.id} done: ${result.output.substring(0, 100)}...`);

    // ── AUTO-APPROVE: Scheduled tasks have pre-approval from user ──
    // If the planner created pending_actions (e.g., emails), approve them automatically
    if (result.pendingActions && result.pendingActions.length > 0) {
      console.log(`[Scheduler] 🔑 Auto-approving ${result.pendingActions.length} pending action(s) from scheduled task...`);
      for (const pa of result.pendingActions) {
        try {
          if (pa.tool === "gmail_send") {
            const args = pa.args as { to: string; subject: string; body: string };
            const gmailTool = (await import("../tools/gmailTool.js")).createGmailTool(googleAuthClient as any);
            await gmailTool.invoke({ action: "send", to: args.to, subject: args.subject, body: args.body });
            console.log(`[Scheduler] 📧 Auto-sent email to ${args.to}`);
          }
          // Mark as approved in DB
          await supabaseAdmin
            .from("pending_actions")
            .update({ status: "approved", resolved_at: new Date().toISOString() })
            .eq("id", pa.id);
        } catch (autoErr: any) {
          console.error(`[Scheduler] ❌ Auto-approve failed for ${pa.id}:`, autoErr.message);
        }
      }
    }

    // Handle recurring vs one-time
    if (task.repeat_pattern) {
      const nextTime = getNextRunTime(new Date(task.scheduled_time), task.repeat_pattern);
      const newRunCount = (task.run_count || 0) + 1;
      const hitMaxRuns = task.max_runs && newRunCount >= task.max_runs;
      const pastEnd = task.repeat_until && nextTime && nextTime > new Date(task.repeat_until);

      if (hitMaxRuns || pastEnd || !nextTime) {
        await supabaseAdmin.from("scheduled_tasks")
          .update({ status: "completed", run_count: newRunCount, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", task.id);
        console.log(`[Scheduler] 🏁 Recurring task ${task.id} finished after ${newRunCount} runs.`);
      } else {
        await supabaseAdmin.from("scheduled_tasks")
          .update({ status: "pending", scheduled_time: nextTime.toISOString(), run_count: newRunCount, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", task.id);
        console.log(`[Scheduler] 🔄 Next run: ${nextTime.toISOString()}`);
      }
    } else {
      await supabaseAdmin.from("scheduled_tasks")
        .update({ status: "completed", run_count: 1, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", task.id);
    }
  } catch (err: any) {
    console.error(`[Scheduler] ❌ Task ${task.id} failed:`, err.message);
    await supabaseAdmin.from("scheduled_tasks")
      .update({ status: "failed", error_log: err.message, updated_at: new Date().toISOString() })
      .eq("id", task.id);
  }
}

// ── Main tick — runs every 60 seconds ──
async function tick(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date().toISOString();
    const { data: dueTasks, error } = await supabaseAdmin
      .from("scheduled_tasks")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_time", now)
      .order("scheduled_time", { ascending: true })
      .limit(5);

    if (error) { console.error("[Scheduler] DB error:", error.message); return; }
    if (dueTasks && dueTasks.length > 0) {
      console.log(`[Scheduler] Found ${dueTasks.length} due task(s).`);
      for (const task of dueTasks) await executeTask(task);
    }
  } catch (err: any) {
    console.error("[Scheduler] Tick error:", err.message);
  } finally {
    isRunning = false;
  }
}

// ── External Trigger (called by cron-job.org) ──
export async function runSchedulerTick(): Promise<{ processed: number; errors: number }> {
  if (isRunning) return { processed: 0, errors: 0 };
  isRunning = true;
  let processed = 0;
  let errors = 0;
  try {
    const now = new Date().toISOString();
    const { data: dueTasks, error } = await supabaseAdmin
      .from("scheduled_tasks")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_time", now)
      .order("scheduled_time", { ascending: true })
      .limit(5);

    if (error) { console.error("[Scheduler] DB error:", error.message); return { processed: 0, errors: 1 }; }
    if (dueTasks && dueTasks.length > 0) {
      console.log(`[Scheduler] Found ${dueTasks.length} due task(s).`);
      for (const task of dueTasks) {
        try {
          await executeTask(task);
          processed++;
        } catch { errors++; }
      }
    }
  } catch (err: any) {
    console.error("[Scheduler] Tick error:", err.message);
    errors++;
  } finally {
    isRunning = false;
  }
  return { processed, errors };
}

// Keep startScheduler for backwards compat (does nothing now — external cron handles it)
export function startScheduler(): void {
  console.log("[Scheduler] ⏰ External cron mode — waiting for /api/scheduler/tick calls from cron-job.org");
}
