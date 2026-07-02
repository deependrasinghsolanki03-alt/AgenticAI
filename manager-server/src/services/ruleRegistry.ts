// ─── In-Memory Semantic Rule Registry ───────────
// Dynamic RAG Planning: Pre-embeds planner rules at boot,
// then at runtime injects only the top-K relevant rules
// into the planner prompt via cosine similarity + keyword boosting.
// RAM cost: ~12 KB (8 rules × 384-dim float vectors)

import { getEmbeddingModel } from "./embedding.js";

// ── Types ───────────────────────────────────────
export interface PlannerRule {
  id: string;
  agent: string;
  description: string;       // Rich sentence for semantic search
  keywords: string[];        // Exact-match keywords (Hinglish + English) for boosting
  prompt_snippet: string;    // The actual rule text injected into planner prompt
  examples: string[];        // 1-2 JSON examples for this rule
}

interface EmbeddedRule {
  rule: PlannerRule;
  vector: number[];
}

// ── Rule Definitions ────────────────────────────
const PLANNER_RULES: PlannerRule[] = [
  // RULE 1 — Task Management (highest priority)
  {
    id: "task_management",
    agent: "task_scheduler",
    description: "User wants to manage scheduled tasks — cancel tasks, stop tasks, list pending tasks, show scheduled tasks, delete tasks, hatao, rok, band karo, dikhao",
    keywords: ["cancel", "hatao", "rok", "band", "stop", "scheduled", "tasks dikhao", "tasks list", "tasks show", "pending"],
    prompt_snippet: `RULE — TASK MANAGEMENT (highest priority):
  "tasks cancel/hatao/rok/band/stop karo" → task_scheduler, instruction: "Cancel all pending scheduled tasks"
  "scheduled tasks dikhao/list/show" → task_scheduler, instruction: "List all pending scheduled tasks"`,
    examples: [
      `"tasks cancel karo" / "scheduled tasks band karo"\n{{"reasoning":"User wants to cancel scheduled tasks","tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"Cancel all pending scheduled tasks","depends_on":[]}}]}}`,
      `"mere scheduled tasks dikhao"\n{{"reasoning":"User wants to see scheduled tasks","tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"List all pending scheduled tasks","depends_on":[]}}]}}`,
    ],
  },

  // RULE 2 — Future/Scheduled Tasks
  {
    id: "future_scheduled",
    agent: "task_scheduler",
    description: "User wants to schedule or delay a task for the future — send email after some time, kal, parso, baad, later, tomorrow, next week, daily repeat, roz subah, har din, weekly, monthly, hourly, har ghante, X min baad, X minute baad, thodi der baad, in X minutes, after X minutes, shaam ko, raat ko, subah",
    keywords: ["kal", "parso", "tomorrow", "next week", "agle", "baje", "subah", "shaam", "raat", "baad", "later", "minute", "ghante", "roz", "daily", "har din", "weekly", "monthly", "hourly", "har ghante", "din tak", "hr tak", "hamesha", "forever", "schedule", "thodi der"],
    prompt_snippet: `RULE — FUTURE TIME or REPEAT detected:
  Time keywords: "kal", "parso", "tomorrow", "next week", "agle", "9 AM", "9 baje", "subah", "shaam", "raat", "baad", "later", "X min baad", "X ghante baad", "thodi der baad", "after X min", "in X minutes"
  Repeat: "roz", "daily", "har din", "har X min", "weekly", "monthly", "har ghante", "hourly"
  Duration: "X din tak", "X hr tak", "X ghante tak", "hamesha", "forever"
  → ALWAYS use "task_scheduler"
  → Include in instruction: time + repeat pattern + actual task to perform
  ⚠️ If ANY future/delay time word is found, this rule OVERRIDES immediate email/calendar rules.`,
    examples: [
      `"5 min baad Berry ko good evening email karna" (FUTURE TIME — "baad" detected)\n{{"reasoning":"User wants to send email AFTER 5 minutes. 'baad' = future time, so task_scheduler is needed.","tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"Schedule after 5 minutes: Send a good evening email to Berry at the email from context","depends_on":[]}}]}}`,
      `"kal subah 9 baje GF ko good morning email karo"\n{{"reasoning":"'kal' and '9 baje' = future time. Using task_scheduler.","tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"Schedule for tomorrow 9 AM: Send a sweet good morning email to girlfriend","depends_on":[]}}]}}`,
      `"roz subah 8 baje study reminder email karo, 5 din tak"\n{{"reasoning":"'roz' = daily repeat, '5 din tak' = duration. Using task_scheduler.","tasks":[{{"id":"t1","agent":"task_scheduler","instruction":"Schedule daily at 8 AM for 5 days: Send a study reminder email with motivational message","depends_on":[]}}]}}`,
    ],
  },

  // RULE 3 — Immediate Email
  {
    id: "immediate_email",
    agent: "emailer",
    description: "User wants to send an email right now immediately — email bhejo, mail karo, send email, compose, draft, likh, email send karo, mail bhejo",
    keywords: ["email", "mail", "bhejo", "send", "compose", "draft", "likh", "gmail"],
    prompt_snippet: `RULE — IMMEDIATE EMAIL (no future time):
  Keywords: "email bhejo/send/karo", "mail bhejo", "likh", "compose", "draft"
  → emailer
  → Include recipient + content from context in instruction
  ⚠️ ONLY use this if there is NO future/delay time keyword. If user says "5 min baad email karo", use task_scheduler instead.`,
    examples: [
      `"Berry ko email bhejo" (NO future time — immediate)\n{{"reasoning":"User wants to send email NOW. No future time keyword. Using emailer.","tasks":[{{"id":"t1","agent":"emailer","instruction":"Send email to Berry at the email from context","depends_on":[]}}]}}`,
      `"abc@gmail.com ko good morning email karo" (user did NOT say GF)\n{{"reasoning":"Immediate email to specific address.","tasks":[{{"id":"t1","agent":"emailer","instruction":"Send a good morning email to abc@gmail.com","depends_on":[]}}]}}`,
    ],
  },

  // RULE 4 — Calendar
  {
    id: "calendar",
    agent: "scheduler",
    description: "User wants to manage Google Calendar events — add event, create event, list events, delete events, show events, calendar mein daal, events dikhao, events hatao, event banao",
    keywords: ["calendar", "event", "events", "daal", "dikhao", "hatao", "banao", "create event", "delete event", "list event"],
    prompt_snippet: `RULE — CALENDAR (immediate — ONLY when user EXPLICITLY asks):
  Keywords: "calendar mein add/daal", "events dikhao/list/show", "events delete/hatao/remove", "event banao/create"
  → scheduler
  ⚠️ ONLY use scheduler if user's message contains calendar/event related words. NEVER auto-add calendar events unless explicitly asked.`,
    examples: [
      `"kal ke events dikhao"\n{{"reasoning":"User wants to see calendar events.","tasks":[{{"id":"t1","agent":"scheduler","instruction":"List tomorrow's calendar events","depends_on":[]}}]}}`,
    ],
  },

  // RULE 5 — Research
  {
    id: "research",
    agent: "researcher",
    description: "User wants to search, learn, find information — topics nikalo, concepts batao, search karo, kya hai, news, weather, sikhna hai, padhai, explain, course, coding help, programming question",
    keywords: ["topics", "concepts", "course", "padhai", "search", "kya hai", "news", "weather", "sikhna", "batao", "explain", "sikha", "how to", "what is", "tutorial"],
    prompt_snippet: `RULE — RESEARCH (information only — do NOT chain with calendar):
  Keywords: "topics/concepts/course/padhai nikalo", "search karo", "kya hai", "news", "weather", "sikhna hai", "batao", "explain"
  → researcher (ONLY researcher — do NOT add scheduler/calendar unless user explicitly asks)
  ⚠️ If user says "React sikhna hai" or "topics batao" → ONLY use researcher. Do NOT create calendar events automatically.`,
    examples: [
      `"React sikhna hai mujhe topics batao"\n{{"reasoning":"User wants to learn React. Research only, no calendar.","tasks":[{{"id":"t1","agent":"researcher","instruction":"Find beginner-friendly React topics and learning roadmap","depends_on":[]}}]}}`,
    ],
  },

  // RULE 6 — Memory Recall
  {
    id: "memory_recall",
    agent: "memory",
    description: "User wants to recall past conversations or memories — yaad hai, pehle kya bola, do you remember, memory mein search, remember when",
    keywords: ["yaad", "remember", "pehle", "memory", "recall", "bola tha", "bataya tha"],
    prompt_snippet: `RULE — MEMORY RECALL:
  Keywords: "yaad hai", "pehle kya bola", "do you remember", "memory mein search"
  → memory (ONLY for searching past info NOT in current context)`,
    examples: [
      `"yaad hai maine kal kya bola tha?"\n{{"reasoning":"User wants to recall past conversation.","tasks":[{{"id":"t1","agent":"memory","instruction":"Search memory for what user said yesterday","depends_on":[]}}]}}`,
    ],
  },

  // RULE 7 — Information Sharing
  {
    id: "info_sharing",
    agent: "direct",
    description: "User tells you personal information to remember — my email is, meri GF ka naam, remember this, yaad rakh, note kar, save kar",
    keywords: ["mera email", "meri gf", "mera naam", "remember this", "yaad rakh", "note kar", "save kar", "my email", "my name"],
    prompt_snippet: `RULE — INFORMATION SHARING:
  User TELLS you info: "my email is X", "meri GF ka naam Y hai", "remember this", "yaad rakh"
  → direct (just acknowledge — memory is auto-saved)`,
    examples: [
      `"meri girlfriend ka email abc@gmail.com hai"\n{{"reasoning":"User is sharing personal info. Just acknowledge.","tasks":[{{"id":"t1","agent":"direct","instruction":"Acknowledge girlfriend's email is abc@gmail.com, noted","depends_on":[]}}]}}`,
    ],
  },

  // RULE 8 — Chat Default (always included as fallback)
  {
    id: "chat_default",
    agent: "direct",
    description: "General chat, greetings, questions, chitchat, math, opinions, hi, hello, kya haal hai, how are you, thanks, shukriya, good morning, good night",
    keywords: ["hi", "hello", "hey", "kya haal", "how are", "thanks", "shukriya", "good morning", "good night", "kaise ho"],
    prompt_snippet: `RULE — EVERYTHING ELSE (fallback):
  Greetings, questions, chat, math, opinions
  → direct
  ⚠️ CRITICAL: "direct" agent can ONLY chat/respond. It CANNOT send emails, create events, or perform any actions.
  If user asks to SEND/DO something → use the correct tool agent (emailer/scheduler/task_scheduler). NEVER route action requests to "direct".`,
    examples: [
      `"hello" / "hi" / "kya haal hai"\n{{"reasoning":"Simple greeting.","tasks":[{{"id":"t1","agent":"direct","instruction":"Greet the user warmly","depends_on":[]}}]}}`,
    ],
  },
];

// ── In-Memory Store ─────────────────────────────
let embeddedRules: EmbeddedRule[] = [];
let isInitialized = false;

// ── Cosine Similarity ───────────────────────────
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Keyword Boost ───────────────────────────────
// Adds a bonus score when user message contains exact keywords
function keywordBoost(userMessage: string, keywords: string[]): number {
  const msgLower = userMessage.toLowerCase();
  let matchCount = 0;
  for (const kw of keywords) {
    if (msgLower.includes(kw.toLowerCase())) {
      matchCount++;
    }
  }
  // Each keyword match adds 0.15 boost, max 0.45
  return Math.min(matchCount * 0.15, 0.45);
}

// ── Public API ──────────────────────────────────

/**
 * Initialize the rule registry by pre-computing embeddings for all rules.
 * Must be called AFTER initEmbeddingModel() in the boot sequence.
 */
export async function initRuleRegistry(): Promise<void> {
  if (isInitialized) return;

  console.log("[RuleRegistry] Embedding planner rules into memory...");
  const start = Date.now();
  const embedModel = await getEmbeddingModel();

  // Create searchable text for each rule: description + keywords
  const searchTexts = PLANNER_RULES.map(r =>
    `${r.description} ${r.keywords.join(" ")}`
  );

  // Batch embed all rules at once (efficient)
  const vectors = await embedModel.embedDocuments(searchTexts);

  embeddedRules = PLANNER_RULES.map((rule, i) => ({
    rule,
    vector: vectors[i],
  }));

  isInitialized = true;
  const ramKB = (embeddedRules.length * 384 * 4 / 1024).toFixed(1);
  console.log(`[RuleRegistry] ✅ ${embeddedRules.length} rules embedded (${ramKB} KB, ${Date.now() - start}ms)`);
}

/**
 * Find the top-K most relevant planner rules for a user message.
 * Uses cosine similarity + keyword boosting.
 * Always includes "chat_default" as a safety fallback.
 */
export async function getRelevantRules(userMessage: string, topK: number = 2): Promise<PlannerRule[]> {
  if (!isInitialized || embeddedRules.length === 0) {
    console.warn("[RuleRegistry] Not initialized! Returning all rules.");
    return PLANNER_RULES;
  }

  const embedModel = await getEmbeddingModel();
  const msgVector = await embedModel.embedQuery(userMessage);

  // Score each rule: cosine similarity + keyword boost
  const scored = embeddedRules.map(({ rule, vector }) => {
    const similarity = cosineSimilarity(msgVector, vector);
    const boost = keywordBoost(userMessage, rule.keywords);
    const totalScore = similarity + boost;
    return { rule, similarity, boost, totalScore };
  });

  // Sort by total score (descending)
  scored.sort((a, b) => b.totalScore - a.totalScore);

  // Log scores for debugging
  console.log(`[RuleRegistry] 📋 Scores for "${userMessage.substring(0, 60)}...":`);
  scored.forEach((s, i) => {
    const marker = i < topK ? "✅" : "  ";
    console.log(`  ${marker} ${s.rule.id}: ${s.totalScore.toFixed(3)} (sim=${s.similarity.toFixed(3)}, boost=${s.boost.toFixed(3)})`);
  });

  // Take top-K rules
  const topRules = scored.slice(0, topK).map(s => s.rule);

  // Always include chat_default as fallback if not already present
  const hasDefault = topRules.some(r => r.id === "chat_default");
  if (!hasDefault) {
    const defaultRule = PLANNER_RULES.find(r => r.id === "chat_default");
    if (defaultRule) topRules.push(defaultRule);
  }

  console.log(`[RuleRegistry] 🎯 Selected: ${topRules.map(r => r.id).join(", ")}`);
  return topRules;
}

/**
 * Format selected rules into a prompt-injectable string.
 */
export function formatRulesForPrompt(rules: PlannerRule[]): string {
  return rules.map((rule, i) => {
    const examplesStr = rule.examples.map(ex => `  ${ex}`).join("\n\n");
    return `── RULE ${i + 1} ──\n${rule.prompt_snippet}\n\nExamples:\n${examplesStr}`;
  }).join("\n\n");
}
