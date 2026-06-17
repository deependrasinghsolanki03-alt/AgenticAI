// ─── Deep Memory Search Tool (Worker Server) ────
// Searches Pinecone WITHOUT loading the embedding model.
// Gets vector from Manager Server's /api/embed endpoint.
// Saves ~100MB RAM on the Worker.

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { pineconeIndex } from "../config/pinecone.js";

const MANAGER_URL = process.env.MANAGER_URL || "http://localhost:5000";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "";

/**
 * Factory: creates deep memory search scoped to a user.
 * Gets embedding from Manager → queries Pinecone directly.
 */
export function createDeepMemoryTool(userId: string) {
  return new DynamicStructuredTool({
    name: "deep_memory_search",
    description: `Search the user's project documents and past conversation history.
Use this when you need context about the user's projects, past decisions,
or detailed information from earlier conversations.`,
    schema: z.object({
      query: z.string().describe("What to search for in the user's memory"),
    }),
    func: async ({ query }) => {
      console.log(`[Tool: DeepMemory] Searching user ${userId} for: "${query}"`);

      try {
        // Step 1: Get vector from Manager's /api/embed
        const embedRes = await fetch(`${MANAGER_URL}/api/embed`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": INTERNAL_SECRET,
          },
          body: JSON.stringify({ text: query }),
        });

        if (!embedRes.ok) {
          throw new Error(`Embed API returned ${embedRes.status}`);
        }

        const { vector } = (await embedRes.json()) as { vector: number[] };
        console.log(`[Tool: DeepMemory] Got ${vector.length}-dim vector from Manager`);

        // Step 2: Query Pinecone directly with the vector
        const namespace = pineconeIndex.namespace(userId);
        const results = await namespace.query({
          vector,
          topK: 5,
          includeMetadata: true,
        });

        const matches = results.matches || [];
        if (matches.length === 0) {
          return "No relevant project documents or memories found.";
        }

        const memories = matches
          .map((m, i) => {
            const text =
              (m.metadata as any)?.pageContent ||
              (m.metadata as any)?.text ||
              (m.metadata as any)?.log_text ||
              "No content";
            return `[Document ${i + 1}] (score: ${m.score?.toFixed(3)}):\n${text}`;
          })
          .join("\n\n---\n\n");

        console.log(`[Tool: DeepMemory] Found ${matches.length} results`);
        return `📚 Deep search found ${matches.length} relevant documents:\n\n${memories}`;
      } catch (err: any) {
        console.error("[Tool: DeepMemory] Error:", err.message);
        return `Memory search failed: ${err.message}`;
      }
    },
  });
}
