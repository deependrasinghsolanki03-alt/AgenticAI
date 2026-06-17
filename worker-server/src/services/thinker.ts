// ─── Thinker Service (Worker Server) ────────────
// Research agent using 8B model with key rotation.
// Tools: deep_web_scraper, deep_memory_search.
// Called by the Manager's ask_worker_server tool.

import { ChatGroq } from "@langchain/groq";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import {
  createToolCallingAgent,
  AgentExecutor,
} from "@langchain/classic/agents";
import { createDeepWebScraper } from "../tools/deepWebScraper.js";
import { createDeepMemoryTool } from "../tools/deepMemoryTool.js";
import { getNextKey } from "../utils/keyRotator.js";

// Create fresh 8B LLM with rotated key each call
function createThinkerLLM(): ChatGroq {
  return new ChatGroq({
    model: "llama-3.1-8b-instant",
    apiKey: getNextKey(),
    temperature: 0.3,
    maxTokens: 2048,
  });
}

function getThinkerPrompt() {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  return `You are the Thinking Model — a deep research and reasoning specialist.
Today's date is: ${today}

AVAILABLE TOOLS:
• deep_web_scraper — Search the internet and extract detailed content from web pages.
• deep_memory_search — Search the user's project documents and conversation history.

INSTRUCTIONS:
1. Analyze the task and use your tools strategically.
2. Use deep_web_scraper for external facts, news, weather, current events.
3. Use deep_memory_search for user's project context and past conversations.
4. Synthesize findings into a clear answer.
5. When dates are mentioned (e.g. "15 days"), calculate exact date ranges from today.
6. **LANGUAGE RULE**: Reply in the SAME language/style the user used. Hinglish → Hinglish.
7. ⚠️ **BE CONCISE — SAVE TOKENS**:
   - Use bullet points, NOT long paragraphs.
   - Max 300 words output. No fluff, no repetition.
   - If asked for "3 topics", give exactly 3 with a 1-line description each.
   - Skip greetings like "Sure! Here are..." — go straight to the answer.

── Task ───────────────────────────────────────────
{task_description}

── Project Context ────────────────────────────────
{project_context}
────────────────────────────────────────────────────`;
}

export interface ThinkerResult {
  output: string;
  toolsUsed: { tool: string; input: string }[];
}

export async function runThinker(
  task: string,
  context: string,
  userId: string,
  onStatus?: (detail: string) => void
): Promise<ThinkerResult> {
  console.log(`[Thinker] Activated for user: ${userId}`);
  console.log(`[Thinker] Task: "${task.substring(0, 80)}..."`);

  onStatus?.("Worker is researching your query...");

  const tools = [createDeepWebScraper(), createDeepMemoryTool(userId)];

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", getThinkerPrompt()],
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad"),
  ]);

  const agent = createToolCallingAgent({ llm: createThinkerLLM(), tools, prompt });

  const executor = new AgentExecutor({
    agent,
    tools,
    verbose: process.env.NODE_ENV !== "production",
    maxIterations: 3,
    earlyStoppingMethod: "force",
    returnIntermediateSteps: true,
    handleParsingErrors: (err) => {
      console.warn("[Thinker] Parsing error:", err);
      return "Tool call failed. Answering from knowledge.";
    },
  });

  const result = await executor.invoke({
    input: task,
    task_description: task,
    project_context: context || "No project context provided.",
  });

  const toolsUsed = (result.intermediateSteps || []).map((step: any) => ({
    tool: step.action.tool,
    input: typeof step.action.toolInput === "string"
      ? step.action.toolInput
      : JSON.stringify(step.action.toolInput),
  }));

  console.log(`[Thinker] Done. Tools: ${toolsUsed.map(t => t.tool).join(", ") || "none"}`);

  return { output: result.output as string, toolsUsed };
}
