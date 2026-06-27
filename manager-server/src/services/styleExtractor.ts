// ─── WhatsApp Style Extractor ───────────────────
// Parses WhatsApp chat exports and creates a "communication style profile"
// for personalized email generation

import { ChatGroq } from "@langchain/groq";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { getNextKey } from "../utils/keyRotator.js";

const LLM_MODEL = process.env.LLM_MODEL || "llama-3.1-8b-instant";

export interface StyleProfile {
  relationship: string;       // "girlfriend", "boyfriend", "friend", etc.
  contactName: string;        // The other person's name from chat
  petNames: string[];         // Pet names used by user
  commonPhrases: string[];    // Frequently used phrases
  emojiStyle: string;         // Emoji usage description
  language: string;           // "Hindi", "English", "Hinglish", etc.
  tone: string;               // "romantic", "funny", "caring", etc.
  rawSummary: string;         // Style summary (NO raw messages)
}

// WhatsApp chat line pattern: "27/06/2026, 9:15 am - Name: message"
const WA_LINE_REGEX = /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?\s*-\s*(.+?):\s*(.+)$/;

export function parseWhatsAppChat(rawText: string): { userName: string; contactName: string; userMessages: string[]; contactMessages: string[] } {
  const lines = rawText.split("\n");
  const senders = new Map<string, string[]>();

  for (const line of lines) {
    const match = line.match(WA_LINE_REGEX);
    if (!match) continue;
    const [, sender, message] = match;
    const trimmedSender = sender.trim();
    const trimmedMsg = message.trim();

    // Skip system messages and media
    if (trimmedMsg === "<Media omitted>" || trimmedMsg === "This message was deleted") continue;
    if (!senders.has(trimmedSender)) senders.set(trimmedSender, []);
    senders.get(trimmedSender)!.push(trimmedMsg);
  }

  // The person with MORE messages is likely the user (or pick the first two)
  const sorted = [...senders.entries()].sort((a, b) => b[1].length - a[1].length);
  if (sorted.length < 2) {
    // Single sender or no valid messages
    const first = sorted[0] || ["Unknown", []];
    return { userName: first[0], contactName: "Contact", userMessages: first[1], contactMessages: [] };
  }

  // Assume user is the one with more messages (usually true in WhatsApp)
  return {
    userName: sorted[0][0],
    contactName: sorted[1][0],
    userMessages: sorted[0][1],
    contactMessages: sorted[1][1],
  };
}

export async function extractStyle(rawChat: string, relationship: string = "girlfriend"): Promise<StyleProfile> {
  console.log(`[StyleExtractor] Parsing WhatsApp chat (${rawChat.length} chars)...`);

  const { userName, contactName, userMessages } = parseWhatsAppChat(rawChat);
  console.log(`[StyleExtractor] Found: ${userName} (${userMessages.length} msgs) talking to ${contactName}`);

  if (userMessages.length < 5) {
    throw new Error("Not enough messages to analyze style. Need at least 5 user messages.");
  }

  // Take a representative sample (first 30 + last 30 messages for variety)
  const sample = [
    ...userMessages.slice(0, 30),
    ...userMessages.slice(-30),
  ].slice(0, 60);

  const sampleText = sample.map((m, i) => `${i + 1}. ${m}`).join("\n");

  const llm = new ChatGroq({
    model: LLM_MODEL,
    apiKey: getNextKey(),
    temperature: 0.3,
    maxTokens: 1024,
  });

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", `You are analyzing a person's WhatsApp messages to understand their COMMUNICATION STYLE.
These are messages sent by "{user_name}" to their {relationship} "{contact_name}".

Analyze the messages and output a JSON style profile:
{{"pet_names": ["list of pet names/nicknames they use for the other person"],
"common_phrases": ["5-10 phrases they frequently use"],
"emoji_style": "description of how they use emojis (lots of ❤️? or minimal? which ones?)",
"language": "Hindi/English/Hinglish/Punjabi etc.",
"tone": "romantic/funny/caring/casual/dramatic/sweet etc. (can be multiple)",
"greeting_style": "how they typically start conversations",
"sign_off_style": "how they typically end conversations or say bye",
"message_length": "short and quick / medium / long paragraphs",
"style_summary": "2-3 sentence summary of their overall communication style, write in first person as if advising an AI to mimic this style"}}

Output ONLY valid JSON.`],
    ["human", `Messages from {user_name} to {contact_name}:\n\n{messages}\n\nJSON:`],
  ]);

  const result = await prompt.pipe(llm).invoke({
    user_name: userName,
    contact_name: contactName,
    relationship,
    messages: sampleText,
  });

  const raw = typeof result.content === "string" ? result.content : "";
  console.log("[StyleExtractor] Raw:", raw.substring(0, 400));

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Failed to extract style profile from chat.");
  }

  const parsed = JSON.parse(match[0]);

  const profile: StyleProfile = {
    relationship,
    contactName,
    petNames: parsed.pet_names || [],
    commonPhrases: parsed.common_phrases || [],
    emojiStyle: parsed.emoji_style || "moderate",
    language: parsed.language || "Hinglish",
    tone: parsed.tone || "casual",
    rawSummary: `COMMUNICATION STYLE PROFILE for ${relationship} (${contactName}):
- Pet names: ${(parsed.pet_names || []).join(", ")}
- Language: ${parsed.language || "Hinglish"}
- Tone: ${parsed.tone || "casual"}
- Greeting: ${parsed.greeting_style || "casual"}
- Sign-off: ${parsed.sign_off_style || "casual"}
- Message length: ${parsed.message_length || "short"}
- Emoji style: ${parsed.emoji_style || "moderate"}
- Common phrases: ${(parsed.common_phrases || []).join(", ")}
- Style guide: ${parsed.style_summary || "Write casually and warmly."}
- ONLY use this style when writing to: ${contactName} (${relationship})`,
  };

  console.log(`[StyleExtractor] ✅ Profile created: ${profile.language} / ${profile.tone} / ${profile.petNames.length} pet names`);
  return profile;
}
