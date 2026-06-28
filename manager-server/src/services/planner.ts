// ═══════════════════════════════════════════════════════════════════
//  DAG-Based Parallel Micro-Agent Orchestrator v5
//  
//  Architecture:
//    PLANNER (8B) → creates dependency graph (JSON)
//    EXECUTOR (Node.js) → validates graph, runs agents in parallel
//    PARAM EXTRACTORS (8B) → extract tool params from dependency data
//    RESPONDER (8B) → combines all results for user
// ═══════════════════════════════════════════════════════════════════

import { ChatGroq } from "@langchain/groq";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { OAuth2Client } from "google-auth-library";
import type { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import { createCalendarTool } from "../tools/calendarTool.js";
import { createGmailTool } from "../tools/gmailTool.js";
import { createMemoryTool } from "../tools/memoryTool.js";
import { createWorkerTool } from "../tools/workerTool.js";
import { createScraperTool } from "../tools/scraperTool.js";
import { getNextKey } from "../utils/keyRotator.js";
import { supabaseAdmin } from "../config/supabase.js";

// ── Constants ───────────────────────────────────
const LLM_MODEL = process.env.LLM_MODEL || "llama-3.1-8b-instant";
const MAX_RETRIES = 2;
const WAVE_DELAY_MS = 1500;
const RATE_LIMIT_WAIT_MS = 15000;
const RETRY_WAIT_MS = 2000;

// ── Helpers ─────────────────────────────────────
function create8B(maxTokens = 1024): ChatGroq {
  return new ChatGroq({ model: LLM_MODEL, apiKey: getNextKey(), temperature: 0.2, maxTokens });
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function getToday(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
function getDateStr(offset = 0): string {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.toISOString().split("T")[0];
}

// ── Types ───────────────────────────────────────
export interface PlannerResult { output: string; toolsUsed: { tool: string; input: string }[]; pendingActions?: { id: string; tool: string; args: Record<string, unknown> }[]; }
export interface PlannerParams {
  userMessage: string; context: string; userId: string;
  userEmail?: string;
  googleAuthClient: OAuth2Client | null;
  embeddings: HuggingFaceTransformersEmbeddings;
  onStatus?: (s: string) => void;
}

interface TaskNode {
  id: string;
  agent: "researcher" | "scheduler" | "emailer" | "memory" | "direct" | "task_scheduler" | "scraper";
  instruction: string;
  depends_on: string[];
}

interface TaskResult {
  id: string;
  agent: string;
  output: string;
  toolsUsed: { tool: string; input: string }[];
  pendingActions?: { id: string; tool: string; args: Record<string, unknown> }[];
}


// ═════════════════════════════════════════════════
//  PART 1: DAG PLANNER (8B LLM — thinks only)
// ═════════════════════════════════════════════════

const PLANNER_PROMPT = ChatPromptTemplate.fromMessages([
  ["system", `You are AgenticAI Planner. Today: {today}. Tomorrow: {tomorrow}.
Your ONLY job: Convert the user's request into a JSON task graph.

═══ CONVERSATION CONTEXT ═══
{context}

═══ AGENTS ═══
1. "direct"          → Simple replies: greetings, acknowledging info, answering from context, math, chitchat
2. "researcher"      → Internet search: topics, news, weather, coding info, study material
3. "scheduler"       → Google Calendar: create/list/delete events (IMMEDIATE calendar actions only)
4. "emailer"         → Gmail: send or search email (IMMEDIATE email actions only — no future time)
5. "memory"          → Search past conversations/memories (ONLY when user asks "do you remember", "pehle kya bola tha")
6. "task_scheduler"  → FUTURE or RECURRING tasks: schedule something for later, list scheduled tasks, cancel tasks
7. "scraper"         → Read/extract content from a specific URL. Use when user shares a link and wants to know what's on the page

═══ OUTPUT FORMAT ═══
{{"tasks":[{{"id":"t1","agent":"AGENT_NAME","instruction":"Clear instruction for this agent","depends_on":[]}}]}}

═══ DECISION RULES (check in this ORDER) ═══

RULE 1 — TASK MANAGEMENT (highest priority):
  "tasks cancel/hatao/rok/band/stop karo" → task_scheduler, instruction: "Cancel all pending scheduled tasks"
  "scheduled tasks dikhao/list/show" → task_scheduler, instruction: "List all pending scheduled tasks"

RULE 2 — FUTURE TIME or REPEAT detected:
  Keywords: "kal", "parso", "tomorrow", "next week", "agle", "9 AM", "9 baje", "subah", "shaam", "raat"
  Repeat: "roz", "daily", "har din", "har X min", "weekly", "monthly", "har ghante", "hourly"
  Duration: "X din tak", "X hr tak", "X ghante tak", "hamesha", "forever"
  → ALWAYS use "task_scheduler"
  → instruction mein INCLUDE karo: time + repeat + actual task
  Example: "kal 9 baje GF ko good morning email karo" → task_scheduler: "Schedule for tomorrow 9 AM: Send a sweet good morning email to girlfriend"
  Example: "har 2 min mai 1 hr tak email karo" → task_scheduler: "Schedule every 2 minutes for 1 hour: Send email to the recipient from context"

RULE 3 — IMMEDIATE EMAIL (no future time):
  Keywords: "email bhejo/send/karo", "mail bhejo", "likh", "compose", "draft"
  → emailer
  → instruction mein recipient + content include karo from context

RULE 4 — CALENDAR (immediate):
  Keywords: "events dikhao/list/show", "events delete/hatao/remove", "calendar mein add"
  → scheduler

RULE 5 — RESEARCH:
  Keywords: "topics/concepts/course/padhai nikalo", "search karo", "kya hai", "news", "weather"
  → researcher

RULE 6 — MEMORY RECALL:
  Keywords: "yaad hai", "pehle kya bola", "do you remember", "memory mein search"
  → memory (ONLY for searching past info NOT in current context)

RULE 7 — INFORMATION SHARING:
  User TELLS you info: "my email is X", "meri GF ka naam Y hai", "remember this", "yaad rakh"
  → direct (just acknowledge — memory is auto-saved)

RULE 8 — EVERYTHING ELSE:
  Greetings, questions, chat, math, opinions
  → direct

═══ IMPORTANT NOTES ═══
• Check CONTEXT first — if user says "girlfriend" and context has her email, USE that email in instruction
• NEVER invent/guess email addresses — only use emails found in context or user message
• NEVER assume relationships — if user gives an email, don't assume it's girlfriend/boyfriend/wife/husband
• Only use words like "girlfriend", "love", "babe", "sweet" in instruction IF user EXPLICITLY said "GF", "girlfriend", "bf", "boyfriend"
• If user just says "X@gmail.com ko email karo" → instruction = "Send email to X@gmail.com" (NO romantic words)
• Keep instructions EXACTLY matching what user asked — don't add extra tone/style unless requested
• When chaining tasks (research → calendar), use depends_on
• Match user's language in instructions (Hindi → Hindi, English → English)

═══ EXAMPLES ═══

"hello" / "hi" / "kya haal hai"
{{"tasks":[{{"id":"t1","agent":"direct","instruction":"Greet the user warmly","depends_on":[]}}]}}

"meri girlfriend ka email abc@gmail.com hai"
{{"tasks":[{{"id":"t1","agent":"direct","instruction":"Acknowledge girlfriend's email is abc@gmail.com, noted","depends_on":[]}}]}}

"GF ko email bhejo" (context has gf email)
{{"tasks":[{{"id":"t1","agent":"emailer","instruction":"Send a loving email to girlfriend at abc@gmail.com","depends_on":[]}}]}}

"abc@gmail.com ko good morning email karo" (user did NOT say GF)
{{"tasks":[{{"id":"t1","agent":"emailer","instruction":"Send a good morning email to abc@gmail.com","depends_on":[]}}]}}

"har 2 min mai 1 hr tak abc@gmail.com ko email karo" (user did NOT say GF)
{{"tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"Schedule every 2 minutes for 1 hour: Send a good morning email to abc@gmail.com","depends_on":[]}}]}}

"kal subah 9 baje GF ko good morning email karo" (user SAID GF)
{{"tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"Schedule for tomorrow 9 AM: Send a sweet good morning email to girlfriend","depends_on":[]}}]}}

"roz subah 8 baje study reminder email karo, 5 din tak"
{{"tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"Schedule daily at 8 AM for 5 days: Send a study reminder email with motivational message","depends_on":[]}}]}}

"tasks cancel karo" / "scheduled tasks band karo"
{{"tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"Cancel all pending scheduled tasks","depends_on":[]}}]}}

"mere scheduled tasks dikhao"
{{"tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"List all pending scheduled tasks","depends_on":[]}}]}}

"kal ke events dikhao"
{{"tasks":[{{"id":"t1","agent":"scheduler","instruction":"List tomorrow's calendar events","depends_on":[]}}]}}

"React topics nikalo aur calendar mein add karo 3-4 PM"
{{"tasks":[{{"id":"t1","agent":"researcher","instruction":"Find 3 advanced React topics for study","depends_on":[]}},{{"id":"t2","agent":"scheduler","instruction":"Create calendar events for each topic, 3-4 PM daily starting tomorrow","depends_on":["t1"]}}]}}

Output ONLY valid JSON. No explanation.`],
  ["human", "{input}"],
]);

async function makePlan(userMessage: string, context?: string): Promise<TaskNode[]> {
  console.log(`\n[Planner] 🧠 Thinking: "${userMessage.substring(0, 80)}..."`);
  try {
    const llm = create8B(512);
    const result = await PLANNER_PROMPT.pipe(llm).invoke({
      input: userMessage,
      today: getToday(),
      tomorrow: getDateStr(1),
      context: context?.substring(0, 1500) || "No prior context.",
    });
    const raw = typeof result.content === "string" ? result.content : "";
    console.log("[Planner] Raw:", raw.substring(0, 400));

    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const tasks = (parsed.tasks || []) as TaskNode[];
      console.log(`[Planner] ✅ Graph: ${tasks.map(t => `${t.id}(${t.agent})`).join(" → ")}`);
      return tasks.length > 0 ? tasks : [{ id: "t1", agent: "direct", instruction: "Answer the user", depends_on: [] }];
    }
  } catch (err: any) { console.error("[Planner] ❌ Error:", err.message); }
  return [{ id: "t1", agent: "direct", instruction: "Answer the user", depends_on: [] }];
}


// ═════════════════════════════════════════════════
//  PART 2: GRAPH SAFETY CHECKS (Node.js — no LLM)
// ═════════════════════════════════════════════════

function validateGraph(tasks: TaskNode[]): TaskNode[] {
  const taskIds = new Set(tasks.map(t => t.id));

  // 1. Remove missing dependencies (hallucination fix)
  for (const task of tasks) {
    const validDeps = task.depends_on.filter(dep => taskIds.has(dep));
    if (validDeps.length !== task.depends_on.length) {
      console.log(`[Safety] ⚠️ Removed invalid deps from ${task.id}: ${task.depends_on.filter(d => !taskIds.has(d))}`);
      task.depends_on = validDeps;
    }
  }

  // 2. Remove self-dependencies
  for (const task of tasks) {
    task.depends_on = task.depends_on.filter(d => d !== task.id);
  }

  // 3. Detect circular dependencies (DFS)
  const visited = new Set<string>();
  const inStack = new Set<string>();
  let hasCycle = false;

  function dfs(id: string): void {
    if (inStack.has(id)) { hasCycle = true; return; }
    if (visited.has(id)) return;
    visited.add(id);
    inStack.add(id);
    const task = tasks.find(t => t.id === id);
    if (task) for (const dep of task.depends_on) dfs(dep);
    inStack.delete(id);
  }

  for (const task of tasks) dfs(task.id);

  if (hasCycle) {
    console.log("[Safety] 🔴 Circular dependency detected! Removing all dependencies.");
    for (const task of tasks) task.depends_on = [];
  }

  console.log(`[Safety] ✅ Graph validated: ${tasks.length} tasks, ${hasCycle ? "cycle fixed" : "no cycles"}`);
  return tasks;
}


// ═════════════════════════════════════════════════
//  PART 3: GRAPH EXECUTOR (Node.js — runs tools)
// ═════════════════════════════════════════════════

async function executeGraph(tasks: TaskNode[], params: PlannerParams): Promise<TaskResult[]> {
  const completed = new Map<string, TaskResult>();
  const allResults: TaskResult[] = [];
  let iteration = 0;
  const MAX_ITERATIONS = 10;

  while (completed.size < tasks.length && iteration < MAX_ITERATIONS) {
    iteration++;

    // Find tasks whose ALL dependencies are completed
    const ready = tasks.filter(t =>
      !completed.has(t.id) &&
      t.depends_on.every(dep => completed.has(dep))
    );

    if (ready.length === 0) {
      console.log("[Executor] ⚠️ Deadlock! No ready tasks. Breaking.");
      break;
    }

    // Log parallel execution
    if (ready.length > 1) {
      console.log(`[Executor] ⚡ PARALLEL: Running ${ready.map(t => t.id + "(" + t.agent + ")").join(" + ")}`);
    } else {
      console.log(`[Executor] ▶️ Running: ${ready[0].id}(${ready[0].agent})`);
    }

    // Gather dependency outputs for each ready task
    const executions = ready.map(async (task) => {
      const depOutputs: Record<string, string> = {};
      for (const depId of task.depends_on) {
        const dep = completed.get(depId);
        if (dep) depOutputs[depId] = dep.output;
      }
      return await executeTask(task, depOutputs, params);
    });

    // Run all ready tasks in PARALLEL
    const results = await Promise.all(executions);

    for (const result of results) {
      completed.set(result.id, result);
      allResults.push(result);
    }

    // Small delay between waves to avoid rate limits
    if (completed.size < tasks.length) await sleep(WAVE_DELAY_MS);
  }

  return allResults;
}

// ── Execute a single task ──
async function executeTask(task: TaskNode, depOutputs: Record<string, string>, params: PlannerParams): Promise<TaskResult> {
  const toolsUsed: { tool: string; input: string }[] = [];
  let pendingActions: { id: string; tool: string; args: Record<string, unknown> }[] | undefined;
  let output = "";

  const MAX_TASK_RETRIES = MAX_RETRIES;
  for (let attempt = 1; attempt <= MAX_TASK_RETRIES; attempt++) {
    try {
      switch (task.agent) {
      // ── RESEARCHER: Calls Worker Server (with 8B fallback) ──
      case "researcher": {
        params.onStatus?.(`Researching: ${task.instruction.substring(0, 50)}...`);
        
        let researchOutput = "";
        try {
          const worker = createWorkerTool(params.userId, params.onStatus);
          researchOutput = await worker.invoke({
            task_description: `${task.instruction}\n\nBe CONCISE. Bullet points. Max 300 words. Specific names only.`,
            project_context: params.context,
          });
          toolsUsed.push({ tool: "ask_worker_server", input: task.instruction });
        } catch (workerErr: any) {
          console.error(`[Executor] Worker failed: ${workerErr.message}. Using 8B fallback.`);
        }

        // Check if worker output is garbage/error
        const isGarbage = !researchOutput || 
          researchOutput.includes("Agent stopped due to max iterations") ||
          researchOutput.includes("Error:") ||
          researchOutput.includes("ECONNREFUSED") ||
          researchOutput.length < 20;

        if (isGarbage) {
          console.log("[Executor] ⚠️ Worker output invalid. Falling back to 8B direct research.");
          params.onStatus?.("Worker unavailable. Using direct research...");
          const fallbackPrompt = ChatPromptTemplate.fromMessages([
            ["system", `You are a knowledgeable AI assistant. Today: ${getToday()}. Provide SPECIFIC, ACCURATE information. Use bullet points. Be concise. Max 300 words. Give EXACT names, not generic placeholders.`],
            ["human", "{input}"],
          ]);
          const fallbackLLM = create8B(1024);
          const fallbackRes = await fallbackPrompt.pipe(fallbackLLM).invoke({ input: task.instruction });
          researchOutput = typeof fallbackRes.content === "string" ? fallbackRes.content : JSON.stringify(fallbackRes.content);
          toolsUsed.push({ tool: "direct_research_fallback", input: task.instruction });
        }

        output = researchOutput;
        break;
      }

      // ── SCHEDULER: 8B extracts params → Node.js calls Calendar API ──
      case "scheduler": {
        params.onStatus?.(`Calendar: ${task.instruction.substring(0, 50)}...`);
        const calTool = createCalendarTool(params.googleAuthClient);

        const instrLower = task.instruction.toLowerCase();
        const isCreate = instrLower.includes("create") || instrLower.includes("add") || instrLower.includes("schedule") || instrLower.includes("banao");
        const isDelete = instrLower.includes("delete") || instrLower.includes("remove") || instrLower.includes("hatao");

        if (isCreate) {
          const events = await extractCalendarParams(task.instruction, depOutputs, params.userMessage);
          const results: string[] = [];
          const createdTitles = new Set<string>();
          
          for (const evt of events) {
            if (!evt.summary || !evt.startDateTime || !evt.endDateTime) continue;
            
            // Skip events with error/garbage titles
            const badTitles = ["agent stopped", "error", "max iterations", "econnrefused", "failed", "undefined", "null"];
            if (badTitles.some(bad => evt.summary.toLowerCase().includes(bad))) {
              console.log(`[Executor] 🚫 Skipping bad event title: "${evt.summary}"`);
              continue;
            }
            
            // Skip duplicates
            if (createdTitles.has(evt.summary.toLowerCase())) {
              console.log(`[Executor] 🔄 Skipping duplicate: "${evt.summary}"`);
              continue;
            }
            createdTitles.add(evt.summary.toLowerCase());
            
            console.log(`[Executor] 📅 Creating: "${evt.summary}" @ ${evt.startDateTime}`);
            const r = await calTool.invoke({ action: "create", summary: evt.summary, startDateTime: evt.startDateTime, endDateTime: evt.endDateTime });
            results.push(r);
            toolsUsed.push({ tool: "google_calendar", input: `create: ${evt.summary}` });
            await sleep(500);
          }
          output = results.length > 0 ? results.join("\n") : "No valid events to create. Research may have failed.";
        } else if (isDelete) {
          const query = extractSearchQuery(task.instruction);
          output = await calTool.invoke({ action: "delete", query });
          toolsUsed.push({ tool: "google_calendar", input: `delete: ${query}` });
        } else {
          const dateRange = detectDateRange(task.instruction, params.userMessage);
          const query = extractSearchQuery(task.instruction);
          output = await calTool.invoke({
            action: "list",
            query: query || undefined,
            timeMin: dateRange.timeMin,
            timeMax: dateRange.timeMax,
          });
          toolsUsed.push({ tool: "google_calendar", input: `list: ${dateRange.label}` });
        }
        break;
      }

      // ── EMAILER: 8B extracts params → saves to pending_actions for HITL confirmation ──
      case "emailer": {
        params.onStatus?.(`Email: ${task.instruction.substring(0, 50)}...`);
        const gmailTool = createGmailTool(params.googleAuthClient);
        const instrLower = task.instruction.toLowerCase();
        const isSend = instrLower.includes("send") || instrLower.includes("bhejo") || instrLower.includes("write") || instrLower.includes("compose") || instrLower.includes("likh") || instrLower.includes("draft");

        // Fetch user's personalization style profiles from DB (encrypted)
        let personalizedProfiles: Array<{relationship: string; contact_name: string; contact_email: string; style_text: string}> = [];
        try {
          const { decrypt } = await import("../utils/crypto.js");
          const { data: styleProfiles } = await supabaseAdmin
            .from("email_style_profiles")
            .select("relationship, contact_name, contact_email, style_text")
            .eq("user_id", params.userId);
          if (styleProfiles && styleProfiles.length > 0) {
            personalizedProfiles = styleProfiles.map(p => ({
              relationship: p.relationship,
              contact_name: p.contact_name,
              contact_email: p.contact_email ? decrypt(p.contact_email) : "",
              style_text: decrypt(p.style_text),
            }));
            console.log(`[Emailer] Found ${personalizedProfiles.length} encrypted style profile(s)`);
          }
        } catch (e: any) { console.error("[Emailer] Style fetch error:", e.message); }

        if (isSend) {
          const emailParams = await extractEmailParams(task.instruction, depOutputs, params.userMessage, params.context, params.userEmail, personalizedProfiles);
          if (!emailParams.to) {
            output = "Email address nahi mila. Kisko bhejun? Please provide email address.";
          } else {
            // HITL: Save to pending_actions instead of sending directly
            const { data: pendingRow, error: pendingErr } = await supabaseAdmin
              .from("pending_actions")
              .insert({
                user_id: params.userId,
                tool_name: "gmail_send",
                arguments: { to: emailParams.to, subject: emailParams.subject, body: emailParams.body },
                status: "pending",
              })
              .select("id")
              .single();

            if (pendingErr || !pendingRow) {
              output = "Error: Could not save email for confirmation. Please try again.";
            } else {
              const bodyPreview = emailParams.body.length > 300 ? emailParams.body.substring(0, 300) + "..." : emailParams.body;
              output = `⚠️ **Email Ready — Awaiting Your Approval**\n\n📧 **To:** ${emailParams.to}\n📌 **Subject:** ${emailParams.subject}\n\n**Message Preview:**\n${bodyPreview}\n\n*Click ✅ Approve or ❌ Reject below.*`;
              toolsUsed.push({ tool: "gmail", input: `pending confirmation: ${emailParams.to}` });
              // Store pending action info for SSE event
              if (!pendingActions) pendingActions = [];
              pendingActions.push({ id: pendingRow.id, tool: "gmail_send", args: { to: emailParams.to, subject: emailParams.subject, body: emailParams.body } });
            }
          }
        } else {
          const query = extractSearchQuery(task.instruction);
          output = await gmailTool.invoke({ action: "search", query: query || "is:unread" });
          toolsUsed.push({ tool: "gmail", input: `search: ${query}` });
        }
        break;
      }

      // ── SCRAPER: Extract content from a specific URL ──
      case "scraper": {
        params.onStatus?.(`Reading URL: ${task.instruction.substring(0, 50)}...`);
        const urlMatch = task.instruction.match(/https?:\/\/[^\s"'<>]+/i);
        if (urlMatch) {
          const scraperTool = createScraperTool(params.onStatus);
          output = await scraperTool.invoke({ url: urlMatch[0] });
          toolsUsed.push({ tool: "url_scraper", input: urlMatch[0] });
        } else {
          output = "No URL found in the instruction. Please provide a valid URL.";
        }
        break;
      }

      // ── TASK_SCHEDULER: Schedule future/recurring tasks ──
      case "task_scheduler": {
        params.onStatus?.("Scheduling task...");
        const instrLower = task.instruction.toLowerCase();
        
        // Check CANCEL first (before list, to avoid "scheduled" keyword conflict)
        if (instrLower.includes("cancel") || instrLower.includes("hatao") || instrLower.includes("delete") || instrLower.includes("band karo") || instrLower.includes("stop") || instrLower.includes("cancel karo") || instrLower.includes("rok")) {
          const { data: tasks } = await supabaseAdmin
            .from("scheduled_tasks")
            .select("id, instruction")
            .eq("user_id", params.userId)
            .eq("status", "pending");

          if (!tasks || tasks.length === 0) {
            output = "Koi pending task nahi hai cancel karne ke liye.";
          } else {
            for (const t of tasks) {
              await supabaseAdmin.from("scheduled_tasks").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", t.id);
            }
            output = `✅ ${tasks.length} scheduled task(s) cancel kar diye.`;
          }
          toolsUsed.push({ tool: "task_scheduler", input: "cancel tasks" });
          break;
        }

        // Check if user wants to LIST tasks
        if (instrLower.includes("list") || instrLower.includes("dikhao") || instrLower.includes("show") || instrLower.includes("pending") || instrLower.includes("scheduled") || instrLower.includes("tasks")) {
          const { data: tasks } = await supabaseAdmin
            .from("scheduled_tasks")
            .select("id, instruction, scheduled_time, repeat_pattern, status, run_count")
            .eq("user_id", params.userId)
            .in("status", ["pending", "running"])
            .order("scheduled_time", { ascending: true });

          if (!tasks || tasks.length === 0) {
            output = "Koi scheduled task nahi hai abhi. 📭";
          } else {
            output = `📋 **Scheduled Tasks (${tasks.length}):**\n\n` + tasks.map((t, i) => {
              const time = new Date(t.scheduled_time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
              const repeat = t.repeat_pattern ? ` (🔄 ${t.repeat_pattern})` : " (one-time)";
              return `${i + 1}. **${t.instruction.substring(0, 60)}**\n   ⏰ ${time}${repeat} | Status: ${t.status}\n   ID: \`${t.id.substring(0, 8)}...\``;
            }).join("\n\n");
          }
          toolsUsed.push({ tool: "task_scheduler", input: "list tasks" });
          break;
        }

        // SCHEDULE a new task — extract time + repeat pattern using 8B
        const timePrompt = ChatPromptTemplate.fromMessages([
          ["system", `Today is {today}. Current time in IST: {current_time}.
Extract scheduling details from the instruction. Output JSON:
{{"scheduled_time":"YYYY-MM-DDTHH:mm:ss+05:30","repeat_pattern":null,"max_runs":null,"instruction":"the actual task to execute with REAL email addresses"}}

Rules:
- "kal" = tomorrow, "parso" = day after tomorrow
- "subah 9 baje" = 09:00, "shaam 5 baje" = 17:00, "raat 10 baje" = 22:00
- "har X min" / "every X minutes" → repeat_pattern = "every X minutes"
- "har X ghante" / "every X hours" → repeat_pattern = "every X hours"
- "roz" / "daily" / "har din" → repeat_pattern = "daily"
- "weekly" / "har hafte" → repeat_pattern = "weekly"
- "monthly" / "har mahine" → repeat_pattern = "monthly"
- "hourly" / "har ghante" → repeat_pattern = "hourly"
- "5 din tak" / "for 5 days" → max_runs = 5
- "1 hr tak" / "1 ghante tak" with "har 2 min" → max_runs = 60/2 = 30
- "30 min tak" with "har 5 min" → max_runs = 30/5 = 6
- Calculate max_runs from duration and interval when both are given
- "hamesha" / "forever" → max_runs = null

SCHEDULED TIME RULES (VERY IMPORTANT):
- If user says "kal" → scheduled_time = tomorrow at the specified time (or 09:00 if no time given)
- If user says "roz subah 8 baje" → scheduled_time = NEXT occurrence of 8 AM (today if not passed, tomorrow if passed)
- If user says "har X min" / "har X ghante" WITHOUT "kal"/"tomorrow" → scheduled_time = CURRENT TIME ({current_time}). This means START NOW.
- NEVER default to 09:00 AM when user wants something to start immediately (no "kal"/"tomorrow" mentioned)
- If "har 2 min mai 1 hr tak" → scheduled_time = NOW (current time), repeat = every 2 minutes, max_runs = 30

CRITICAL — "at X time for Y days" pattern:
- "9 am for 2 days" → scheduled_time = NEXT 9 AM (if today's 9 AM passed, use TOMORROW's 9 AM), repeat_pattern = "daily", max_runs = 2
- "at 8 pm for 3 days" → scheduled_time = NEXT 8 PM, repeat_pattern = "daily", max_runs = 3
- "for X days" / "X din tak" ALWAYS means repeat_pattern = "daily" and max_runs = X
- scheduled_time should be the FIRST run time (NEXT occurrence of that time, NOT X days from now)
- Today is {today}, current time is {current_time}. If the specified time has ALREADY PASSED today, start from TOMORROW.

CRITICAL — RESOLVE REFERENCES FROM CONTEXT:
- If user says "girlfriend", "GF", "bf", "mom", "boss" etc. → LOOK at the CONTEXT below to find their actual email address
- The "instruction" MUST contain the REAL email address, NOT just "girlfriend" or "GF"
- Example: If context says "girlfriend's email is abc@gmail.com" and user says "GF ko email karo" → instruction = "Send email to abc@gmail.com"
- NEVER write "Send email to girlfriend" without including the actual email address
- If you cannot find the email in context, write: "Send email to [unknown - ask user for email]"

- The "instruction" should be the ACTUAL TASK with REAL details (emails, names) from context
- Use IST timezone (+05:30)
- For current time, use: {current_time}
Output ONLY valid JSON.`],
          ["human", `Instruction: {instruction}\nUser message: {user_msg}\nContext (memory + recent chat): {context}\n\nJSON:`],
        ]);

        try {
          const llm = create8B(512);
          const currentTime = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
          const result = await timePrompt.pipe(llm).invoke({
            today: getToday(),
            current_time: currentTime,
            instruction: task.instruction,
            user_msg: params.userMessage,
            context: (params.context || "").substring(0, 1500),
          });
          const raw = typeof result.content === "string" ? result.content : "";
          console.log("[TaskScheduler] Raw:", raw.substring(0, 300));
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            
            // CODE-LEVEL max_runs calculation (don't trust LLM math)
            let maxRuns = parsed.max_runs;
            const userMsg = params.userMessage.toLowerCase();
            const repeatPat = (parsed.repeat_pattern || "").toLowerCase();
            
            // Extract interval in minutes from repeat_pattern
            let intervalMinutes = 0;
            const intervalMatch = repeatPat.match(/every\s+(\d+)\s+minute/);
            const intervalHrMatch = repeatPat.match(/every\s+(\d+)\s+hour/);
            if (intervalMatch) intervalMinutes = parseInt(intervalMatch[1]);
            else if (intervalHrMatch) intervalMinutes = parseInt(intervalHrMatch[1]) * 60;
            
            // Extract duration from user message (X min tak, X hr tak, X ghante tak)
            const durMinMatch = userMsg.match(/(\d+)\s*(?:min|minute)/);
            const durHrMatch = userMsg.match(/(\d+)\s*(?:hr|hour|ghant)/);
            const durDinMatch = userMsg.match(/(\d+)\s*(?:din|day)/);
            
            let durationMinutes = 0;
            if (durHrMatch) durationMinutes = parseInt(durHrMatch[1]) * 60;
            if (durMinMatch) {
              const durVal = parseInt(durMinMatch[1]);
              // If "har 5 min 15 min tak" — first number is interval, second is duration
              // Check if this minute value is the duration (comes with "tak"/"for")
              const durTakMatch = userMsg.match(/(\d+)\s*(?:min|minute)\s*(?:tak|for|ke liye)/);
              if (durTakMatch) durationMinutes = parseInt(durTakMatch[1]);
              else if (!intervalMatch && durVal > intervalMinutes) durationMinutes = durVal;
            }
            if (durDinMatch && intervalMinutes > 0) durationMinutes = parseInt(durDinMatch[1]) * 24 * 60;
            
            // Calculate max_runs from duration and interval
            if (intervalMinutes > 0 && durationMinutes > 0) {
              maxRuns = Math.floor(durationMinutes / intervalMinutes);
              console.log(`[TaskScheduler] Calculated max_runs: ${durationMinutes}min / ${intervalMinutes}min = ${maxRuns}`);
            }
            
            // Save to database
            const { data: saved, error: saveErr } = await supabaseAdmin
              .from("scheduled_tasks")
              .insert({
                user_id: params.userId,
                instruction: parsed.instruction || task.instruction,
                scheduled_time: parsed.scheduled_time,
                repeat_pattern: parsed.repeat_pattern || null,
                max_runs: maxRuns || null,
              })
              .select("id, scheduled_time, repeat_pattern")
              .single();

            if (saveErr) throw saveErr;

            const schedTime = new Date(saved.scheduled_time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
            const repeatText = saved.repeat_pattern ? ` (🔄 ${saved.repeat_pattern})` : "";
            output = `✅ Task scheduled!\n\n⏰ **Time:** ${schedTime}${repeatText}\n📝 **Task:** ${parsed.instruction}\n${maxRuns ? `🔢 **Runs:** ${maxRuns} times` : ""}`;
          } else {
            output = "Time samajh nahi aaya. Please specify time clearly (e.g., 'kal subah 9 baje').";
          }
        } catch (err: any) {
          console.error("[TaskScheduler] Error:", err.message);
          output = `Scheduling error: ${err.message}`;
        }
        toolsUsed.push({ tool: "task_scheduler", input: task.instruction.substring(0, 50) });
        break;
      }

      // ── MEMORY: Direct tool call ──
      case "memory": {
        params.onStatus?.("Checking memory...");
        const memTool = createMemoryTool(params.userId, params.embeddings);
        output = await memTool.invoke({ query: task.instruction });
        toolsUsed.push({ tool: "memory", input: task.instruction });
        break;
      }

      // ── DIRECT: Simple 8B chat ──
      case "direct": {
        const prompt = ChatPromptTemplate.fromMessages([
          ["system", `You are AgenticAI. Today: ${getToday()}. Be concise, friendly. Match user's language.\nContext: ${params.context}`],
          ["human", "{input}"],
        ]);
        const llm = create8B(1024);
        const res = await prompt.pipe(llm).invoke({ input: params.userMessage });
        output = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
        break;
      }
      } // close switch
      break; // success — exit retry loop
    } catch (err: any) {
      const isAuthError = err.message?.includes("401") || err.message?.includes("invalid_grant") || err.message?.includes("Token has been expired");
      const isRateLimit = err.message?.includes("429");

      if (isAuthError || attempt === MAX_TASK_RETRIES) {
        // Don't retry auth errors or last attempt
        console.error(`[Executor] ❌ ${task.id}(${task.agent}) failed (attempt ${attempt}/${MAX_TASK_RETRIES}):`, err.message);
        output = isAuthError
          ? "⚠️ Authentication error — please re-login with Google to refresh permissions."
          : `Error after ${MAX_TASK_RETRIES} attempts: ${err.message}`;
        break;
      }

      // Retry
      console.warn(`[Executor] ⚠️ ${task.id}(${task.agent}) failed (attempt ${attempt}/${MAX_TASK_RETRIES}): ${err.message}. Retrying...`);
      params.onStatus?.(`⚠️ Error, retrying... (${attempt}/${MAX_TASK_RETRIES})`);
      if (isRateLimit) {
        params.onStatus?.("Rate limited, waiting...");
        await sleep(RATE_LIMIT_WAIT_MS);
      } else {
        await sleep(RETRY_WAIT_MS);
      }
    }
  }

  console.log(`[Executor] ✅ ${task.id}(${task.agent}) done (${output.length} chars)`);
  return { id: task.id, agent: task.agent, output, toolsUsed, pendingActions };
}


// ═════════════════════════════════════════════════
//  PART 4: PARAM EXTRACTORS (8B — extracts tool params)
// ═════════════════════════════════════════════════

// ── Calendar Param Extractor ──
async function extractCalendarParams(instruction: string, depOutputs: Record<string, string>, userMessage: string): Promise<any[]> {
  console.log("[ParamExtractor:Calendar] Extracting event params...");
  const depData = Object.entries(depOutputs).map(([id, out]) => `[${id} output]:\n${out}`).join("\n\n");

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", `Today: {today}. Tomorrow: {tomorrow}.
You have data from previous tasks. Create calendar events from it.

Output a JSON array. Each item:
{{"summary":"EXACT name from data","startDateTime":"YYYY-MM-DDTHH:mm:ss","endDateTime":"YYYY-MM-DDTHH:mm:ss"}}

CRITICAL RULES:
1. Use EXACT topic/event names from the data below. NEVER use generic names like "Topic 1".
2. First event = tomorrow ({tomorrow}).
3. One event per day, consecutive days.
4. Default time 10:00-11:00 unless user said otherwise ("3-4 PM" = 15:00-16:00).
5. Output ONLY a JSON array.`],
    ["human", `Previous task data:\n{dep_data}\n\nInstruction: {instruction}\nUser message: {user_msg}\n\nJSON array:`],
  ]);

  try {
    const llm = create8B(1024);
    const result = await prompt.pipe(llm).invoke({
      today: getToday(),
      tomorrow: getDateStr(1),
      dep_data: depData.substring(0, 2000),
      instruction,
      user_msg: userMessage,
    });
    const raw = typeof result.content === "string" ? result.content : "";
    console.log("[ParamExtractor:Calendar] Output:", raw.substring(0, 500));
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch (err: any) { console.error("[ParamExtractor:Calendar] Error:", err.message); }
  return [];
}

// ── Email Param Extractor (Humanized & Context-Aware) ──
type StyleProfile = { relationship: string; contact_name: string; contact_email: string; style_text: string };
async function extractEmailParams(instruction: string, depOutputs: Record<string, string>, userMessage: string, context?: string, senderEmail?: string, personalizedProfiles?: StyleProfile[]): Promise<{ to: string; subject: string; body: string }> {
  console.log("[ParamExtractor:Email] Extracting email params...");
  const depData = Object.entries(depOutputs).map(([id, out]) => `[${id} output]:\n${out}`).join("\n\n");

  // Extract sender name from email
  let senderName = "Me";
  if (senderEmail) {
    const namePart = senderEmail.split("@")[0].replace(/[0-9._-]+$/g, "").replace(/[._-]/g, " ");
    senderName = namePart.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ") || "Me";
  }

  // Extract recipient email from context
  const allText = `${instruction} ${userMessage} ${context || ""} ${depData}`;
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const foundEmails: string[] = allText.match(emailRegex) || [];
  const realEmails = foundEmails.filter((e: string) => 
    !e.includes("example.com") && !e.includes("placeholder") && !e.includes("test.com") &&
    e !== senderEmail
  );
  let contextEmail = realEmails.length > 0 ? realEmails[0] : "";
  console.log(`[ParamExtractor:Email] Recipient: ${contextEmail} | Sender: ${senderName}`);

  // ── Style matching: EMAIL-FIRST → relationship → context fallback ──
  let styleGuide = "";
  const instrLower = instruction.toLowerCase();
  
  if (personalizedProfiles && personalizedProfiles.length > 0) {
    // 1. PRIMARY: Match by exact email address
    if (contextEmail) {
      const emailMatch = personalizedProfiles.find(p => 
        p.contact_email && p.contact_email.toLowerCase().trim() === contextEmail.toLowerCase().trim()
      );
      if (emailMatch) {
        styleGuide = `STYLE FOR ${emailMatch.relationship} (${emailMatch.contact_name}, ${emailMatch.contact_email}):\n${emailMatch.style_text}`;
        console.log(`[ParamExtractor:Email] ✅ MATCHED by email: "${contextEmail}" → ${emailMatch.contact_name} (${emailMatch.relationship})`);
      }
    }
    
    // 2. Match by contact NAME in instruction (e.g. "Berry ko email karo")
    if (!styleGuide) {
      const nameMatch = personalizedProfiles.find(p => 
        instrLower.includes(p.contact_name.toLowerCase()) || 
        (userMessage && userMessage.toLowerCase().includes(p.contact_name.toLowerCase()))
      );
      if (nameMatch) {
        styleGuide = `STYLE FOR ${nameMatch.relationship} (${nameMatch.contact_name}, ${nameMatch.contact_email}):\n${nameMatch.style_text}`;
        // Auto-fill email from profile if no real email found
        if (!contextEmail && nameMatch.contact_email) {
          contextEmail = nameMatch.contact_email;
          console.log(`[ParamExtractor:Email] ✅ MATCHED by name: "${nameMatch.contact_name}" → auto-filled email: ${contextEmail}`);
        } else {
          console.log(`[ParamExtractor:Email] ✅ MATCHED by name: "${nameMatch.contact_name}"`);
        }
      }
    }

    // 3. FALLBACK: Match by relationship keyword in instruction
    if (!styleGuide) {
      const relationshipKeywords = ["girlfriend", "gf", "boyfriend", "bf", "wife", "biwi", "husband", "love", "babe", "jaanu", "friend", "dost", "boss", "mom", "maa", "dad", "papa"];
      for (const keyword of relationshipKeywords) {
        if (instrLower.includes(keyword)) {
          const match = personalizedProfiles.find(p => p.relationship.toLowerCase().includes(keyword));
          if (match) {
            styleGuide = `STYLE FOR ${match.relationship} (${match.contact_name}, ${match.contact_email}):\n${match.style_text}`;
            if (!contextEmail && match.contact_email) {
              contextEmail = match.contact_email;
              console.log(`[ParamExtractor:Email] ✅ MATCHED by relationship: "${keyword}" → auto-filled email: ${contextEmail}`);
            } else {
              console.log(`[ParamExtractor:Email] ✅ MATCHED by relationship: "${keyword}" → ${match.contact_name}`);
            }
            break;
          }
        }
      }
    }
    
    if (!styleGuide) {
      console.log(`[ParamExtractor:Email] ℹ️ ${personalizedProfiles.length} profile(s) exist but no match. Default style.`);
    }
  }
  
  // 3. CONTEXT-BASED — from memory/Pinecone (last resort)
  if (!styleGuide) {
    const contextStyleMatch = (context || "").match(/COMMUNICATION STYLE PROFILE[\s\S]*?(?:ONLY use this style when writing to:[\s\S]*?)(?=\n===|$)/);
    if (contextStyleMatch) {
      const isForStyledContact = instrLower.includes("girlfriend") || instrLower.includes("gf") || 
        instrLower.includes("boyfriend") || instrLower.includes("bf") ||
        instrLower.includes("wife") || instrLower.includes("husband") ||
        instrLower.includes("babe") || instrLower.includes("jaanu");
      if (isForStyledContact) {
        styleGuide = contextStyleMatch[0];
        console.log(`[ParamExtractor:Email] ✅ Context style matched (memory fallback)`);
      }
    }
  }

  // Random topic/mood picker — forces different content each email
  const morningTopics = [
    "Tell her about a dream you had about her",
    "Talk about how peaceful the morning feels and you wish she was here",
    "Tell her you're excited about something happening today",
    "Ask about her plans for today and share yours",
    "Compliment something specific about her personality",
    "Tell her something funny that happened yesterday",
    "Share how you feel right now in this moment",
    "Tell her what you love most about mornings because of her",
    "Talk about a future plan or date you want to do together",
    "Tell her about a song or movie that reminded you of her"
  ];
  const eveningTopics = [
    "Tell her about your day and ask about hers",
    "Share something interesting that happened today",
    "Tell her you're looking forward to talking tonight",
    "Express how the day felt long without her",
    "Talk about something you want to do together this weekend",
    "Tell her about something that made you smile today",
    "Ask how her day went and if anything bothered her",
    "Share a random thought you had about her during the day",
    "Tell her about something you learned today",
    "Talk about how you're unwinding and wish she was there"
  ];
  const genericTopics = [
    "Write about how she makes your life better",
    "Share a random sweet memory you have of her",
    "Tell her something you appreciate about her",
    "Express a feeling you haven't shared before",
    "Talk about something you both enjoy doing together",
    "Tell her about something you're grateful for today",
    "Share an inside joke or reference something personal",
    "Tell her how proud you are of her"
  ];

  const hour = now.getHours();
  const topicPool = hour < 12 ? morningTopics : hour < 18 ? eveningTopics : genericTopics;
  const randomTopic = topicPool[Math.floor(Math.random() * topicPool.length)];

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", `You are writing an email AS the user (sender: "{sender_name}"). 
Current time: ${timeContext} | Variation: ${randomSeed}

Output JSON: {{"to":"real@email.com","subject":"Short creative subject","body":"Human-written email"}}

${styleGuide ? `
PERSONALITY PROFILE (follow the tone and pet names, but write ORIGINAL content):
${styleGuide}

🎯 TODAY'S EMAIL THEME: ${randomTopic}
Use this theme as inspiration for the email content. Be creative and natural.

RULES:
1. Use pet names and sign-off style from the profile
2. Write about the THEME above — make it the main topic of the email
3. Every email MUST be completely DIFFERENT from any previous email
4. Match time of day: ${timeContext}
5. Write 4-8 natural sentences
6. Be genuine and heartfelt — like a real person who truly cares
` : `
Write like a REAL HUMAN — casual, warm, natural. NOT like a bot or corporate template.

RULES:
1. Write like a real person texting/emailing
2. Keep it SHORT and natural. No corporate jargon
3. Sign off with the sender's name: "{sender_name}"
4. TONE: Match the instruction — romantic if for partner, professional if for work
5. Include ALL actual data from previous tasks
`}

Known recipient email: {context_email}

Output ONLY valid JSON.`],
    ["human", `Context:\n{context}\n\nTask data:\n{dep_data}\n\nInstruction: {instruction}\nUser said: {user_msg}\n\nJSON:`],
  ]);

  try {
    // Higher temperature for personalized emails = max variety
    const llm = new ChatGroq({ model: LLM_MODEL, apiKey: getNextKey(), temperature: styleGuide ? 0.85 : 0.3, maxTokens: 1024 });
    
    // Strip previous email outputs from context to prevent copy-paste patterns
    let cleanContext = (context || "").substring(0, 1000);
    cleanContext = cleanContext.replace(/Email Ready.*?Awaiting.*?\n/gi, "")
      .replace(/Good morning baby.*?\n/gi, "")
      .replace(/Message Preview:.*?\n/gi, "")
      .replace(/📧.*?Subject:.*?\n/gi, "")
      .replace(/Email sent to.*?\n/gi, "")
      .replace(/Action Rejected.*?\n/gi, "")
      .replace(/Action Approved.*?\n/gi, "")
      .trim();
    
    const result = await prompt.pipe(llm).invoke({
      dep_data: depData.substring(0, 2000),
      instruction,
      user_msg: userMessage,
      context: cleanContext,
      context_email: contextEmail,
      sender_name: senderName,
    });
    const raw = typeof result.content === "string" ? result.content : "";
    console.log("[ParamExtractor:Email] Raw:", raw.substring(0, 300));
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      
      // Reject placeholder emails
      if (parsed.to && (parsed.to.includes("example.com") || parsed.to.includes("placeholder") || parsed.to.includes("test.com"))) {
        parsed.to = contextEmail;
      }
      
      // Fallback to regex email
      if (!parsed.to && contextEmail) {
        parsed.to = contextEmail;
      }
      
      // Reject placeholder body
      if (parsed.body && (parsed.body.includes("[previous task") || parsed.body.includes("[topic"))) {
        parsed.body = `Hey!\n\nHere's what I have for you:\n\n${depData.substring(0, 1500)}\n\n— ${senderName}`;
      }
      
      // Ensure sign-off has sender name
      if (parsed.body && !parsed.body.includes(senderName)) {
        parsed.body += `\n\n— ${senderName}`;
      }
      
      return parsed;
    }
  } catch (err: any) { console.error("[ParamExtractor:Email] Error:", err.message); }
  
  // Fallback
  return { to: contextEmail, subject: "Hey!", body: `Hey!\n\n${depData.substring(0, 1500) || "Just checking in!"}\n\n— ${senderName}` };
}

// ── Date Range Detector (no LLM needed) ──
function detectDateRange(instruction: string, userMessage: string): { timeMin: string; timeMax?: string; label: string } {
  const text = (instruction + " " + userMessage).toLowerCase();
  const now = new Date();

  // Today / aaj
  if (text.includes("today") || text.includes("aaj")) {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(now); end.setHours(23, 59, 59, 999);
    return { timeMin: start.toISOString(), timeMax: end.toISOString(), label: "today" };
  }

  // Tomorrow / kal
  if (text.includes("tomorrow") || text.includes("kal")) {
    const start = new Date(now); start.setDate(start.getDate() + 1); start.setHours(0, 0, 0, 0);
    const end = new Date(now); end.setDate(end.getDate() + 1); end.setHours(23, 59, 59, 999);
    return { timeMin: start.toISOString(), timeMax: end.toISOString(), label: "tomorrow" };
  }

  // This week / is hafte
  if (text.includes("week") || text.includes("hafte") || text.includes("hafta")) {
    const start = new Date(now);
    const end = new Date(now); end.setDate(end.getDate() + 7);
    return { timeMin: start.toISOString(), timeMax: end.toISOString(), label: "this week" };
  }

  // This month / is mahine
  if (text.includes("month") || text.includes("mahine") || text.includes("mahina")) {
    const start = new Date(now);
    const end = new Date(now); end.setDate(end.getDate() + 30);
    return { timeMin: start.toISOString(), timeMax: end.toISOString(), label: "this month" };
  }

  // Default: show upcoming from now
  return { timeMin: now.toISOString(), label: "upcoming" };
}

// ── Simple Query Extractor (no LLM needed) ──
function extractSearchQuery(instruction: string): string {
  // Word list to strip — using word boundaries to avoid partial matches (e.g. "me" inside "MERN")
  const stopWords = [
    "list", "show", "dikhao", "delete", "remove", "hatao", "upcoming",
    "calendar", "events?", "event", "search", "find", "get", "fetch",
    "today'?s?", "tomorrow'?s?", "aaj", "kal", "parso",
    "this", "next", "is", "us", "that",
    "week'?s?", "month'?s?", "hafte?", "mahine?", "mahina",
    "ke", "ki", "ka", "ko", "se", "mein", "mai",
    "all", "my", "me", "mera", "mere", "meri",
    "the", "in", "with", "from", "for", "of", "a", "an",
    "karo", "karna", "kar", "do", "de",
    "sabhi", "sab", "sara", "saare",
    "wale", "wali", "wala",
    "title", "named", "called",
  ];
  const pattern = new RegExp(`\\b(${stopWords.join("|")})\\b`, "gi");
  const cleaned = instruction.replace(pattern, "").replace(/\s+/g, " ").trim();
  return cleaned || "";
}


// ═════════════════════════════════════════════════
//  PART 5: RESPONDER (8B — final answer)
// ═════════════════════════════════════════════════

async function createResponse(results: TaskResult[], userMessage: string, params: PlannerParams): Promise<string> {
  // Single task? Return directly.
  if (results.length === 1) return results[0].output;

  params.onStatus?.("Preparing response...");
  const allOutputs = results.map(r => `[${r.agent}]: ${r.output}`).join("\n\n");

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", `Combine these task results into ONE clean response. Include all links, event names, data. Match user's language (Hinglish→Hinglish). Max 250 words. Don't mention "agents" or "tasks".`],
    ["human", `User: "{input}"\n\nResults:\n{outputs}`],
  ]);

  const llm = create8B(1024);
  const res = await prompt.pipe(llm).invoke({ input: userMessage, outputs: allOutputs.substring(0, 3000) });
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}


// ═════════════════════════════════════════════════
//  MAIN ENTRY POINT
//  Planner → Validate → Execute (parallel) → Respond
// ═════════════════════════════════════════════════

export async function runPlanner(params: PlannerParams): Promise<PlannerResult> {
  const startTime = Date.now();
  params.onStatus?.("Planning...");

  // 1. PLANNER creates task graph
  const rawTasks = await makePlan(params.userMessage, params.context);

  // 2. SAFETY validates graph
  const tasks = validateGraph(rawTasks);

  // 3. EXECUTOR runs tasks (parallel where possible)
  const results = await executeGraph(tasks, params);

  // 4. RESPONDER creates final answer
  const output = await createResponse(results, params.userMessage, params);

  // Collect all tools used
  const toolsUsed = results.flatMap(r => r.toolsUsed);

  // Collect all pending actions (HITL)
  const pendingActions = results.flatMap(r => r.pendingActions || []);

  const elapsed = Date.now() - startTime;
  console.log(`\n[Pipeline] ✅ Done in ${(elapsed / 1000).toFixed(1)}s | Tasks: ${tasks.map(t => t.id + "(" + t.agent + ")").join(", ")} | Tools: ${toolsUsed.map(t => t.tool).join(", ")}${pendingActions.length ? ` | Pending: ${pendingActions.length}` : ""}\n`);

  return { output, toolsUsed, pendingActions: pendingActions.length > 0 ? pendingActions : undefined };
}
