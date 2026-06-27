// ─── Fact Extractor Service ─────────────────────
// Extracts important facts from conversations using 8B LLM
// Instead of saving raw "User: ... Assistant: ..." text,
// we save only meaningful facts for better Pinecone retrieval.

import { ChatGroq } from "@langchain/groq";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { getNextKey } from "../utils/keyRotator.js";

const FACT_EXTRACTION_PROMPT = `You are a fact extraction engine. Given a conversation between a User and an Assistant, extract ONLY important, reusable facts.

RULES:
- Extract personal facts (name, email, preferences, allergies, relationships)
- Extract task-related facts (scheduled events, email sent to whom, etc.)
- Extract preferences and knowledge (favorite language, coding style, etc.)
- IGNORE greetings, filler words, thank you, small talk
- IGNORE information that is temporary or won't be useful later
- Each fact should be a single concise bullet point
- If NO meaningful facts exist, respond with exactly: NO_FACTS
- Write facts in the language the user used (Hinglish/Hindi/English)
- Maximum 5 facts per conversation

EXAMPLES:
User: "meri girlfriend ka email abc@gmail.com hai"
Assistant: "Noted! I'll remember that."
→ - User's girlfriend's email is abc@gmail.com

User: "good morning"
Assistant: "Good morning! How can I help?"
→ NO_FACTS

User: "kal 3 baje meeting hai office mein"
Assistant: "Calendar event created for tomorrow at 3 PM - Office Meeting"
→ - User has office meeting tomorrow at 3 PM (calendar event created)

Now extract facts from this conversation:`;

export async function extractFacts(userMessage: string, assistantResponse: string): Promise<string | null> {
  try {
    const llm = new ChatGroq({
      model: "llama-3.1-8b-instant",
      apiKey: getNextKey(),
      temperature: 0.1,
      maxTokens: 256,
    });

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", FACT_EXTRACTION_PROMPT],
      ["human", `User: {userMessage}\nAssistant: {assistantResponse}`],
    ]);

    const result = await prompt.pipe(llm).invoke({ userMessage, assistantResponse });
    const content = typeof result.content === "string" ? result.content.trim() : "";

    // If no facts worth saving
    if (!content || content === "NO_FACTS" || content.includes("NO_FACTS") || content.length < 5) {
      console.log("[FactExtractor] No meaningful facts found — skipping memory save.");
      return null;
    }

    console.log(`[FactExtractor] Extracted facts (${content.length} chars):\n${content}`);
    return content;
  } catch (err: any) {
    console.error("[FactExtractor] Error:", err.message);
    // Fallback: save raw text if extraction fails
    return `User: ${userMessage}\nAssistant: ${assistantResponse}`;
  }
}
