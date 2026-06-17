import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { PineconeStore } from "@langchain/pinecone";
import { pineconeIndex } from "../config/pinecone.js";
import type { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";

export function createMemoryTool(userId: string, embeddings: HuggingFaceTransformersEmbeddings) {
  return new DynamicStructuredTool({
    name: "read_personal_memory",
    description: `Search the user's past conversation history and personal memory.`,
    schema: z.object({ query: z.string().describe("What to search for in memory") }),
    func: async ({ query }) => {
      console.log(`[Tool: Memory] Searching user ${userId} for: "${query}"`);
      try {
        const store = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex, namespace: userId });
        const docs = await store.similaritySearch(query, 3);
        if (!docs.length) return "No relevant memories found.";
        return `🧠 ${docs.length} memories:\n\n${docs.map((d, i) => `[${i + 1}]:\n${d.pageContent}`).join("\n\n---\n\n")}`;
      } catch (err: any) { return `Memory search failed: ${err.message}`; }
    },
  });
}
