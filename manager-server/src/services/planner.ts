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
import { getNextKey } from "../utils/keyRotator.js";
import { supabaseAdmin } from "../config/supabase.js";

// ── Helpers ─────────────────────────────────────
function create8B(maxTokens = 1024): ChatGroq {
  return new ChatGroq({ model: "llama-3.1-8b-instant", apiKey: getNextKey(), temperature: 0.2, maxTokens });
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
export interface PlannerResult { output: string; toolsUsed: { tool: string; input: string }[]; }
export interface PlannerParams {
  userMessage: string; context: string; userId: string;
  userEmail?: string;
  googleAuthClient: OAuth2Client | null;
  embeddings: HuggingFaceTransformersEmbeddings;
  onStatus?: (s: string) => void;
}

interface TaskNode {
  id: string;
  agent: "researcher" | "scheduler" | "emailer" | "memory" | "direct" | "task_scheduler";
  instruction: string;
  depends_on: string[];
}

interface TaskResult {
  id: string;
  agent: string;
  output: string;
  toolsUsed: { tool: string; input: string }[];
}


// ═════════════════════════════════════════════════
//  PART 1: DAG PLANNER (8B LLM — thinks only)
// ═════════════════════════════════════════════════

const PLANNER_PROMPT = ChatPromptTemplate.fromMessages([
  ["system", `You are AgenticAI Planner. Today: {today}. Tomorrow: {tomorrow}.
Your ONLY job: Create a task graph (JSON) for the user's request.

RECENT CONVERSATION CONTEXT:
{context}

Available agents:
- "researcher" — Search internet for topics, news, weather, coding info
- "scheduler" — Google Calendar (create/list/delete events)
- "emailer" — Send or search Gmail (ONLY when user EXPLICITLY asks to send/search email)
- "memory" — Recall past conversations from memory (ONLY for searching/querying old memories)
- "direct" — Simple chat, greetings, math, acknowledging info, answering questions using context
- "task_scheduler" — Schedule tasks for FUTURE execution (kal, next week, roz subah, daily, weekly, monthly)

Output a JSON object with "tasks" array. Each task:
{{
  "id": "t1",
  "agent": "researcher",
  "instruction": "What this agent should do (in user's language)",
  "depends_on": []
}}

🚨 CRITICAL RULES — READ CAREFULLY:

1. INFORMATION SHARING vs ACTION:
   - When user TELLS you something ("my gf email is X", "mera naam Y hai", "remember this"), use "direct" — just acknowledge and confirm.
   - "my email is X" / "meri gf ka email X hai" = user is SHARING info → use "direct" to acknowledge
   - "email bhejo X ko" / "send email to X" = user wants ACTION → use "emailer"
   - "save this" / "yaad rakh" / "remember this" = user wants you to note it → use "direct" (memory is auto-saved)

2. FUTURE vs NOW — VERY IMPORTANT:
   - If user says "kal", "tomorrow", "next Monday", "9 AM", "roz subah", "daily", "weekly", "har din" → use "task_scheduler"
   - If user says "abhi email karo", "send now", "bhej do" (no future time) → use "emailer" / "scheduler" directly
   - "kal 9 baje GF ko good morning bhejo" = task_scheduler (FUTURE time)
   - "GF ko email bhejo" (no time mentioned, means now) = emailer
   - "roz subah 8 baje reminder do" = task_scheduler (RECURRING)
   - "mere scheduled tasks dikhao" / "pending tasks" = task_scheduler (with instruction to list tasks)
   - "task cancel karo" = task_scheduler (with instruction to cancel)

3. CONTEXT IS KING:
   - ALWAYS check the RECENT CONVERSATION CONTEXT above.
   - If user says "send this to my girlfriend" and context shows her email was mentioned earlier, use that email.
   - If user refers to "this", "that", "isko", "yeh" — look at context to understand what they mean.

4. KEYWORD RULES:
   - "events delete/hatao/remove karo" = ALWAYS scheduler (Google Calendar)
   - "events dikhao/list/show" = ALWAYS scheduler
   - "calendar mein add karo" = ALWAYS scheduler
   - "email bhejo/send/write/likh/compose karo" (no future time) = ALWAYS emailer
   - "topics/concepts/course/padhai" + "nikalo/batao" = researcher
   - "what is my X" / "mera X kya hai" = check memory first, then direct

4. MEMORY vs DIRECT:
   - Use "memory" ONLY when user asks to recall/find old info ("what did I say before", "do you remember")
   - Use "direct" for greetings, acknowledging info, simple questions answerable from context
   - Memory is AUTO-SAVED after every chat — user doesn't need to "save" manually

EXAMPLES:

User: "hello"
{{"tasks":[{{"id":"t1","agent":"direct","instruction":"Greet the user","depends_on":[]}}]}}

User: "my girlfriend email is abc@gmail.com"
{{"tasks":[{{"id":"t1","agent":"direct","instruction":"Acknowledge that the user's girlfriend's email is abc@gmail.com and confirm it's noted","depends_on":[]}}]}}

User: "save this in memory" / "yaad rakh"
{{"tasks":[{{"id":"t1","agent":"direct","instruction":"Confirm to user that the information from our conversation has been saved to memory","depends_on":[]}}]}}

User: "what is my girlfriend's email?" (with context showing it was shared before)
{{"tasks":[{{"id":"t1","agent":"direct","instruction":"Tell user their girlfriend's email from the conversation context","depends_on":[]}}]}}

User: "what is my girlfriend's email?" (WITHOUT context)
{{"tasks":[{{"id":"t1","agent":"memory","instruction":"Search memory for girlfriend's email address","depends_on":[]}}]}}

User: "send email to my gf" (context has gf email from earlier)
{{"tasks":[{{"id":"t1","agent":"emailer","instruction":"Send email to girlfriend's email address from context","depends_on":[]}}]}}

User: "kal ke events dikhao"
{{"tasks":[{{"id":"t1","agent":"scheduler","instruction":"List tomorrow's calendar events","depends_on":[]}}]}}

User: "MERN wale events delete karo"
{{"tasks":[{{"id":"t1","agent":"scheduler","instruction":"Delete all calendar events with MERN in the title","depends_on":[]}}]}}

User: "MERN topics nikalo aur calendar mein add karo 3-4 PM"
{{"tasks":[{{"id":"t1","agent":"researcher","instruction":"Find 3 advanced MERN stack topics for study","depends_on":[]}},{{"id":"t2","agent":"scheduler","instruction":"Create calendar events for each topic found, 3-4 PM daily starting tomorrow","depends_on":["t1"]}}]}}

User: "kal subah 9 baje GF ko good morning email karo"
{{"tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"Schedule for tomorrow 9 AM: Send a sweet good morning email to girlfriend","depends_on":[]}}]}}

User: "roz subah 8 baje mujhe study reminder email karo, 5 din tak"
{{"tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"Schedule daily at 8 AM for 5 days: Send a study reminder email to me with motivational message","depends_on":[]}}]}}

User: "mere scheduled tasks dikhao"
{{"tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"List all pending scheduled tasks","depends_on":[]}}]}}

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
    if (completed.size < tasks.length) await sleep(1500);
  }

  return allResults;
}

// ── Execute a single task ──
async function executeTask(task: TaskNode, depOutputs: Record<string, string>, params: PlannerParams): Promise<TaskResult> {
  const toolsUsed: { tool: string; input: string }[] = [];
  let output = "";

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

      // ── EMAILER: 8B extracts params → Node.js calls Gmail API ──
      case "emailer": {
        params.onStatus?.(`Email: ${task.instruction.substring(0, 50)}...`);
        const gmailTool = createGmailTool(params.googleAuthClient);
        const instrLower = task.instruction.toLowerCase();
        const isSend = instrLower.includes("send") || instrLower.includes("bhejo") || instrLower.includes("write") || instrLower.includes("compose") || instrLower.includes("likh") || instrLower.includes("draft");

        if (isSend) {
          const emailParams = await extractEmailParams(task.instruction, depOutputs, params.userMessage, params.context, params.userEmail);
          if (!emailParams.to) {
            output = "Email address nahi mila. Kisko bhejun? Please provide email address.";
          } else {
            const sendResult = await gmailTool.invoke({ action: "send", to: emailParams.to, subject: emailParams.subject, body: emailParams.body });
            // Show what was actually sent
            const bodyPreview = emailParams.body.length > 300 ? emailParams.body.substring(0, 300) + "..." : emailParams.body;
            output = `${sendResult}\n\n📧 **To:** ${emailParams.to}\n📌 **Subject:** ${emailParams.subject}\n\n**Message:**\n${bodyPreview}`;
            toolsUsed.push({ tool: "gmail", input: `send to: ${emailParams.to}` });
          }
        } else {
          const query = extractSearchQuery(task.instruction);
          output = await gmailTool.invoke({ action: "search", query: query || "is:unread" });
          toolsUsed.push({ tool: "gmail", input: `search: ${query}` });
        }
        break;
      }

      // ── TASK_SCHEDULER: Schedule future/recurring tasks ──
      case "task_scheduler": {
        params.onStatus?.("Scheduling task...");
        const instrLower = task.instruction.toLowerCase();
        
        // Check if user wants to LIST tasks
        if (instrLower.includes("list") || instrLower.includes("dikhao") || instrLower.includes("show") || instrLower.includes("pending") || instrLower.includes("scheduled")) {
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
        
        // Check if user wants to CANCEL a task
        if (instrLower.includes("cancel") || instrLower.includes("hatao") || instrLower.includes("delete") || instrLower.includes("band karo")) {
          const { data: tasks } = await supabaseAdmin
            .from("scheduled_tasks")
            .select("id, instruction")
            .eq("user_id", params.userId)
            .eq("status", "pending");

          if (!tasks || tasks.length === 0) {
            output = "Koi pending task nahi hai cancel karne ke liye.";
          } else {
            // Cancel all pending or let LLM figure out which one
            for (const t of tasks) {
              await supabaseAdmin.from("scheduled_tasks").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", t.id);
            }
            output = `✅ ${tasks.length} scheduled task(s) cancel kar diye.`;
          }
          toolsUsed.push({ tool: "task_scheduler", input: "cancel tasks" });
          break;
        }

        // SCHEDULE a new task — extract time + repeat pattern using 8B
        const timePrompt = ChatPromptTemplate.fromMessages([
          ["system", `Today is {today}. Current time in IST: {current_time}.
Extract scheduling details from the instruction. Output JSON:
{{"scheduled_time":"YYYY-MM-DDTHH:mm:ss+05:30","repeat_pattern":null,"max_runs":null,"instruction":"the actual task to execute"}}

Rules:
- "kal" = tomorrow, "parso" = day after tomorrow
- "subah 9 baje" = 09:00, "shaam 5 baje" = 17:00, "raat 10 baje" = 22:00
- "har X min" / "every X minutes" → repeat_pattern = "every X minutes", scheduled_time = NOW + X minutes
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
- If no specific time mentioned and task is for NOW, use current time + interval
- If no time mentioned and task is for future, default to 09:00 AM
- The "instruction" should be the ACTUAL TASK to do (e.g., "Send good morning email to girlfriend"), NOT the scheduling part
- Use IST timezone (+05:30)
Output ONLY valid JSON.`],
          ["human", `Instruction: {instruction}\nUser message: {user_msg}\n\nJSON:`],
        ]);

        try {
          const llm = create8B(512);
          const currentTime = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
          const result = await timePrompt.pipe(llm).invoke({
            today: getToday(),
            current_time: currentTime,
            instruction: task.instruction,
            user_msg: params.userMessage,
          });
          const raw = typeof result.content === "string" ? result.content : "";
          console.log("[TaskScheduler] Raw:", raw.substring(0, 300));
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            
            // Save to database
            const { data: saved, error: saveErr } = await supabaseAdmin
              .from("scheduled_tasks")
              .insert({
                user_id: params.userId,
                instruction: parsed.instruction || task.instruction,
                scheduled_time: parsed.scheduled_time,
                repeat_pattern: parsed.repeat_pattern || null,
                max_runs: parsed.max_runs || null,
              })
              .select("id, scheduled_time, repeat_pattern")
              .single();

            if (saveErr) throw saveErr;

            const schedTime = new Date(saved.scheduled_time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
            const repeatText = saved.repeat_pattern ? ` (🔄 ${saved.repeat_pattern})` : "";
            output = `✅ Task scheduled!\n\n⏰ **Time:** ${schedTime}${repeatText}\n📝 **Task:** ${parsed.instruction}\n${parsed.max_runs ? `🔢 **Runs:** ${parsed.max_runs} times` : ""}`;
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
    }
  } catch (err: any) {
    console.error(`[Executor] ❌ ${task.id}(${task.agent}) failed:`, err.message);
    output = `Error: ${err.message}`;
    if (err.message?.includes("429")) {
      params.onStatus?.("Rate limited, waiting 15s...");
      await sleep(15000);
    }
  }

  console.log(`[Executor] ✅ ${task.id}(${task.agent}) done (${output.length} chars)`);
  return { id: task.id, agent: task.agent, output, toolsUsed };
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
async function extractEmailParams(instruction: string, depOutputs: Record<string, string>, userMessage: string, context?: string, senderEmail?: string): Promise<{ to: string; subject: string; body: string }> {
  console.log("[ParamExtractor:Email] Extracting email params...");
  const depData = Object.entries(depOutputs).map(([id, out]) => `[${id} output]:\n${out}`).join("\n\n");

  // Extract sender name from email (e.g., "deependrasingh" → "Deependra")
  let senderName = "Me";
  if (senderEmail) {
    const namePart = senderEmail.split("@")[0].replace(/[0-9._-]+$/g, "").replace(/[._-]/g, " ");
    senderName = namePart.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ") || "Me";
  }
  console.log(`[ParamExtractor:Email] Sender name: ${senderName}`);

  // Extract recipient email from context using regex
  const allText = `${instruction} ${userMessage} ${context || ""} ${depData}`;
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const foundEmails: string[] = allText.match(emailRegex) || [];
  const realEmails = foundEmails.filter((e: string) => 
    !e.includes("example.com") && !e.includes("placeholder") && !e.includes("test.com") &&
    e !== senderEmail // Don't send to yourself
  );
  const contextEmail = realEmails.length > 0 ? realEmails[0] : "";
  console.log(`[ParamExtractor:Email] Recipient: ${contextEmail} | Sender: ${senderName}`);

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", `You are writing an email AS the user (sender: "{sender_name}"). 
Write it like a REAL HUMAN — casual, warm, natural. NOT like a bot or corporate template.

Output JSON: {{"to":"real@email.com","subject":"Short natural subject","body":"Human-written email"}}

✍️ WRITING STYLE RULES:
1. Write like a real person texting/emailing a friend or colleague
2. Use the SAME LANGUAGE the user chats in. If user speaks Hinglish → write Hinglish email. If English → English.
3. Keep it SHORT and natural. No corporate jargon like "I hope this email finds you well"
4. Sign off with the sender's name: "{sender_name}"
5. If sending to girlfriend/friend → be casual and sweet
6. If sending study plan/work → be clear but still friendly
7. Include ALL actual data from previous tasks — topic names, event details, links etc.

🚨 NEVER:
- Use placeholder emails like girlfriend@example.com
- Use placeholder text like [previous task 1], [topic name]
- Write robotic AI-sounding text
- Write overly formal corporate emails

Known recipient email: {context_email}

Output ONLY valid JSON.`],
    ["human", `Context:\n{context}\n\nTask data:\n{dep_data}\n\nInstruction: {instruction}\nUser said: {user_msg}\n\nJSON:`],
  ]);

  try {
    const llm = create8B(1024);
    const result = await prompt.pipe(llm).invoke({
      dep_data: depData.substring(0, 2000),
      instruction,
      user_msg: userMessage,
      context: (context || "").substring(0, 1000),
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

  const elapsed = Date.now() - startTime;
  console.log(`\n[Pipeline] ✅ Done in ${(elapsed / 1000).toFixed(1)}s | Tasks: ${tasks.map(t => t.id + "(" + t.agent + ")").join(", ")} | Tools: ${toolsUsed.map(t => t.tool).join(", ")}\n`);

  return { output, toolsUsed };
}
