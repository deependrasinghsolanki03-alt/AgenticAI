// ─── Planner Service (Manager Server) ───────────
// Hybrid Strategy: 8B for simple tasks, 70B only for complex chaining
// Saves ~80% of 70B tokens on daily usage

import { ChatGroq } from "@langchain/groq";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { createToolCallingAgent, AgentExecutor } from "@langchain/classic/agents";
import type { OAuth2Client } from "google-auth-library";
import type { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import { createCalendarTool } from "../tools/calendarTool.js";
import { createGmailTool } from "../tools/gmailTool.js";
import { createMemoryTool } from "../tools/memoryTool.js";
import { createWorkerTool } from "../tools/workerTool.js";

// ── Smart Token Strategy ────────────────────────
// Router   (8B,  50 tok)  → Intent classification (1 word)
// Direct   (8B, 1024 tok) → Simple chat, greetings (CHEAP)
// Simple   (8B, 2048 tok) → Single-tool tasks: calendar, email, memory (CHEAP)
// Complex  (70B, 4096 tok)→ Multi-tool chaining: worker→calendar (EXPENSIVE, rare)
const routerLLM  = new ChatGroq({ model: "llama-3.1-8b-instant", apiKey: process.env.GROQ_API_KEY, temperature: 0, maxTokens: 50 });
const directLLM  = new ChatGroq({ model: "llama-3.1-8b-instant", apiKey: process.env.GROQ_API_KEY, temperature: 0.4, maxTokens: 1024 });
const simpleLLM  = new ChatGroq({ model: "llama-3.1-8b-instant", apiKey: process.env.GROQ_API_KEY, temperature: 0.2, maxTokens: 2048 });
const complexLLM = new ChatGroq({ model: "llama-3.3-70b-versatile", apiKey: process.env.GROQ_API_KEY, temperature: 0.2, maxTokens: 4096 });

function getToday(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

// ── Router Prompt (Smart 6-way classifier) ──────
const ROUTER_PROMPT = ChatPromptTemplate.fromMessages([
  ["system", `Classify the user's message into exactly ONE category. Reply with ONLY the category word.
Categories:
- calendar → schedule, events, meetings, timetable add/delete/update, "calendar mein add karo"
- email → send email, inbox, "mail karo", "email bhejo"
- memory → recall past conversations, "yaad hai", "remember", "what did I say"
- research → needs internet, weather, news, latest info, deep analysis (but NO calendar/email action needed)
- complex → multi-step tasks that need BOTH research AND action (e.g. "topics nikalo aur calendar mein add karo", "timetable banao aur schedule karo")
- direct → greetings, simple chat, math, coding, general knowledge
Reply ONLY one word: calendar, email, memory, research, complex, or direct`],
  ["human", "{input}"],
]);

// ── Simple Tool Prompt (for 8B single-tool agent) ──
function getSimpleToolPrompt(): string {
  return `You are AgenticAI assistant. Today's date is: ${getToday()}
Use the available tool to help the user. Be concise.

RULES:
1. Use the tool to complete the task.
2. If critical info is missing (date, time, email address), ASK the user. Do NOT guess.
3. LANGUAGE: Reply in the SAME language the user used. Hinglish → Hinglish.
4. For dates: "aaj" = today, "kal" = tomorrow. Use ISO format for tools.
5. DO ONLY what was asked. Do NOT perform extra actions.
6. For calendar delete: use query-based search to find and delete matching events.

── Context ──
{context}
─────────────`;
}

// ── Complex Chain Prompt (for 70B multi-tool agent) ──
function getComplexPrompt(): string {
  return `You are the Master Planner of "Project AgenticAI". Today's date is: ${getToday()}

You have multiple tools. Use them in SEQUENCE to achieve complex goals.

⚠️ CRITICAL RULES:

1. NEVER GUESS: If details are missing (time, email), ASK the user.

2. ALWAYS USE ask_worker_server FOR RESEARCH:
   You are a PLANNER, NOT a knowledge base. For topics, timetables, study plans, current events, weather — ALWAYS call ask_worker_server FIRST.
   DO NOT invent topic names from your own brain.

3. SEQUENTIAL CHAINING:
   - Call ask_worker_server FIRST → WAIT for response → READ the actual topics/data
   - THEN call google_calendar/gmail with the REAL data from the response
   - NEVER use placeholders like "Topic 1", "Link 1"

4. BATCH PROCESSING:
   If Worker returns a list (e.g., 3 topics), call calendar tool 3 times with REAL topic names.

5. DO ONLY WHAT WAS ASKED:
   - "calendar mein add karo" → ONLY calendar. No email.
   - "email karo" → ONLY email. No calendar.

6. CAPTURE TOOL OUTPUTS:
   When calendar returns a link, include the REAL link in summaries/emails. Never write "Link 1".

7. LANGUAGE: Match user's language. Hinglish → Hinglish.

── Context ──
{context}
─────────────`;
}

// ── Direct Answer Prompt ────────────────────────
function getDirectPrompt(): string {
  return `You are AgenticAI. Today: ${getToday()}
Answer directly, concisely. LANGUAGE: Mirror user's language (Hinglish → Hinglish).
── Context ──
{context}
─────────────`;
}

// ── Types ───────────────────────────────────────
export interface PlannerResult { output: string; toolsUsed: { tool: string; input: string }[]; }
export interface PlannerParams {
  userMessage: string; context: string; userId: string;
  googleAuthClient: OAuth2Client | null;
  embeddings: HuggingFaceTransformersEmbeddings;
  onStatus?: (s: string) => void;
}

// ── Main Router ─────────────────────────────────
export async function runPlanner(params: PlannerParams): Promise<PlannerResult> {
  const { userMessage } = params;

  console.log(`[Planner] Classifying: "${userMessage.substring(0, 60)}..."`);
  let intent = "direct";
  try {
    const result = await ROUTER_PROMPT.pipe(routerLLM).invoke({ input: userMessage });
    const raw = (typeof result.content === "string" ? result.content : "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (["calendar", "email", "memory", "research", "complex", "direct"].includes(raw)) intent = raw;
  } catch { /* default to direct */ }
  console.log(`[Planner] Intent: "${intent}" → ${intent === "complex" ? "70B" : "8B"}`);

  switch (intent) {
    case "calendar": return handleSimpleTool(params, "calendar");
    case "email":    return handleSimpleTool(params, "email");
    case "memory":   return handleSimpleTool(params, "memory");
    case "research": return handleResearch(params);
    case "complex":  return handleComplex(params);
    default:         return handleDirect(params);
  }
}

// ── Handler: Simple Tool (8B — CHEAP) ───────────
// Handles single-tool tasks: calendar CRUD, email, memory
async function handleSimpleTool(p: PlannerParams, type: string): Promise<PlannerResult> {
  console.log(`[Planner] → 8B Simple Agent (${type})`);

  const tools = type === "calendar"
    ? [createCalendarTool(p.googleAuthClient), createMemoryTool(p.userId, p.embeddings)]
    : type === "email"
    ? [createGmailTool(p.googleAuthClient), createMemoryTool(p.userId, p.embeddings)]
    : [createMemoryTool(p.userId, p.embeddings)];

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", getSimpleToolPrompt()],
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad"),
  ]);

  const agent = createToolCallingAgent({ llm: simpleLLM, tools, prompt });
  const executor = new AgentExecutor({
    agent, tools,
    maxIterations: 5,
    earlyStoppingMethod: "force",
    returnIntermediateSteps: true,
    handleParsingErrors: () => "Tool call failed. Let me try again.",
  });

  const result = await executor.invoke({ input: p.userMessage, context: p.context });
  const toolsUsed = (result.intermediateSteps || []).map((s: any) => ({
    tool: s.action.tool,
    input: typeof s.action.toolInput === "string" ? s.action.toolInput : JSON.stringify(s.action.toolInput),
  }));
  return { output: result.output as string, toolsUsed };
}

// ── Handler: Research Only (Worker direct — FREE on Manager) ──
// No LLM needed on Manager side! Just forwards to Worker.
async function handleResearch(p: PlannerParams): Promise<PlannerResult> {
  console.log("[Planner] → Worker Direct (research, no Manager LLM cost)");
  p.onStatus?.("Delegating to Thinking Model...");
  const tool = createWorkerTool(p.userId, p.onStatus);
  const result = await tool.invoke({ task_description: p.userMessage, project_context: p.context });
  return { output: result, toolsUsed: [{ tool: "ask_worker_server", input: p.userMessage }] };
}

// ── Handler: Complex Chain (70B — EXPENSIVE, rare) ──
// Multi-tool: Worker → Calendar, Research → Email, etc.
async function handleComplex(p: PlannerParams): Promise<PlannerResult> {
  console.log("[Planner] → 70B Complex Agent (multi-tool chain)");

  const tools = [
    createWorkerTool(p.userId, p.onStatus),
    createCalendarTool(p.googleAuthClient),
    createGmailTool(p.googleAuthClient),
    createMemoryTool(p.userId, p.embeddings),
  ];

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", getComplexPrompt()],
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad"),
  ]);

  const agent = createToolCallingAgent({ llm: complexLLM, tools, prompt });
  const executor = new AgentExecutor({
    agent, tools,
    maxIterations: 8,
    earlyStoppingMethod: "force",
    returnIntermediateSteps: true,
    handleParsingErrors: (err) => {
      console.warn("[Planner] Parse error:", err);
      return "Tool call had an issue. Let me try another approach.";
    },
  });

  const result = await executor.invoke({ input: p.userMessage, context: p.context });
  const toolsUsed = (result.intermediateSteps || []).map((s: any) => ({
    tool: s.action.tool,
    input: typeof s.action.toolInput === "string" ? s.action.toolInput : JSON.stringify(s.action.toolInput),
  }));
  return { output: result.output as string, toolsUsed };
}

// ── Handler: Direct Answer (8B — CHEAPEST) ──────
async function handleDirect(p: PlannerParams): Promise<PlannerResult> {
  console.log("[Planner] → 8B Direct (no tools)");
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", getDirectPrompt()],
    ["human", "{input}"],
  ]);
  const result = await prompt.pipe(directLLM).invoke({ input: p.userMessage, context: p.context });
  return { output: typeof result.content === "string" ? result.content : JSON.stringify(result.content), toolsUsed: [] };
}
