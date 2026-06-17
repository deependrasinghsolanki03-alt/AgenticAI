// ─── Worker Delegation Tool (SSE Consumer) ──────
// Makes POST to Worker Server's /api/delegate.
// CONSUMES SSE stream from Worker (prevents timeout).
// Pipes status events to frontend in real-time.

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const WORKER_URL = process.env.WORKER_URL || "http://localhost:5001";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "";

export function createWorkerTool(
  userId: string,
  onStatus?: (detail: string) => void
) {
  return new DynamicStructuredTool({
    name: "ask_worker_server",
    description: `Delegate complex research tasks to the Worker Server for deep reasoning.
Use for internet research, weather, news, current events, or deep analysis.`,
    schema: z.object({
      task_description: z.string().describe("Clear description of what to research"),
      project_context: z.string().describe("Relevant context from the conversation"),
    }),
    func: async ({ task_description, project_context }) => {
      console.log(`[Tool: Worker] Delegating to Worker Server...`);
      onStatus?.("Connecting to Worker Server...");

      try {
        const response = await fetch(`${WORKER_URL}/api/delegate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": INTERNAL_SECRET,
          },
          body: JSON.stringify({
            task: task_description,
            context: project_context,
            user_id: userId,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Worker returned ${response.status}: ${errText}`);
        }

        // Consume SSE stream from Worker
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalResponse = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;

            let eventType = "message";
            let dataStr = "";

            for (const line of trimmed.split("\n")) {
              if (line.startsWith("event:")) eventType = line.slice(6).trim();
              else if (line.startsWith("data:")) dataStr = line.slice(5).trim();
            }

            if (!dataStr) continue;

            try {
              const payload = JSON.parse(dataStr);

              if (eventType === "status") {
                console.log(`[Tool: Worker] Status: ${payload.detail}`);
                onStatus?.(payload.detail);
              } else if (eventType === "done") {
                finalResponse = payload.response;
                console.log(`[Tool: Worker] Got response (${payload.elapsed_ms}ms)`);
              } else if (eventType === "error") {
                throw new Error(payload.message);
              }
            } catch (parseErr: any) {
              if (parseErr.message && !parseErr.message.includes("JSON")) throw parseErr;
            }
          }
        }

        if (!finalResponse) {
          return "Worker completed but returned no response. Try rephrasing.";
        }

        return finalResponse;
      } catch (err: any) {
        console.error("[Tool: Worker] Error:", err.message);
        return `Worker Server error: ${err.message}. Please try again.`;
      }
    },
  });
}
