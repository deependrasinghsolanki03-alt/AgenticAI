// ─── Delegate Controller (Worker Server) ────────
// POST /api/delegate — SSE streaming endpoint.
// Receives task from Manager, runs Thinker, streams results back.

import { Request, Response } from "express";
import { runThinker } from "../services/thinker.js";

function sendEvent(res: Response, event: string, data: Record<string, unknown>) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function handleDelegate(req: Request, res: Response): Promise<void> {
  const { task, context, user_id } = req.body;
  const startTime = Date.now();

  // Validate
  if (!task || !user_id) {
    res.status(400).json({ error: "task and user_id are required." });
    return;
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`[Delegate] User: ${user_id}`);
  console.log(`[Delegate] Task: "${task.substring(0, 80)}..."`);
  console.log(`${"═".repeat(50)}`);

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  sendEvent(res, "status", { stage: "started", detail: "Worker started research..." });

  try {
    const onStatus = (detail: string) => {
      sendEvent(res, "status", { stage: "researching", detail });
    };

    const result = await runThinker(task, context || "", user_id, onStatus);

    const elapsedMs = Date.now() - startTime;
    console.log(`[Delegate] Completed in ${elapsedMs}ms`);

    sendEvent(res, "done", {
      response: result.output,
      tools_used: result.toolsUsed,
      elapsed_ms: elapsedMs,
    });
  } catch (err: any) {
    console.error("[Delegate] Fatal error:", err);
    sendEvent(res, "error", { message: err.message });
  }

  res.end();
}
