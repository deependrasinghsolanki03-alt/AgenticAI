// ─── File Parser Service ────────────────────────
// Parses uploaded files (PDF, CSV, TXT, JSON, MD) and extracts text
// No vision model needed — text-only parsing with 8B summarization

import { ChatGroq } from "@langchain/groq";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { getNextKey } from "../utils/keyRotator.js";

interface ParsedFile {
  text: string;
  summary: string;
}

export async function parseFile(name: string, type: string, base64Data: string): Promise<ParsedFile> {
  const buffer = Buffer.from(base64Data, "base64");
  let text = "";

  console.log(`[FileParser] Parsing: ${name} (${type}, ${buffer.length} bytes)`);

  // ── Extract text based on file type ──
  if (type === "text/plain" || type === "text/markdown" || name.endsWith(".txt") || name.endsWith(".md")) {
    text = buffer.toString("utf-8");
  } else if (type === "text/csv" || name.endsWith(".csv")) {
    text = buffer.toString("utf-8");
    // Format CSV as readable table
    const lines = text.split("\n").filter(l => l.trim());
    if (lines.length > 50) {
      text = lines.slice(0, 50).join("\n") + `\n... (${lines.length - 50} more rows)`;
    }
  } else if (type === "application/json" || name.endsWith(".json")) {
    try {
      const parsed = JSON.parse(buffer.toString("utf-8"));
      text = JSON.stringify(parsed, null, 2).slice(0, 3000);
    } catch {
      text = buffer.toString("utf-8").slice(0, 3000);
    }
  } else if (type === "application/pdf" || name.endsWith(".pdf")) {
    // Simple PDF text extraction (no heavy dependencies)
    // Extract readable text from PDF buffer
    const pdfText = buffer.toString("utf-8");
    // Filter out binary content, keep readable text
    text = pdfText.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s+/g, " ").trim();
    if (text.length < 50) {
      text = "(PDF content could not be extracted as plain text. Try converting to TXT first.)";
    } else {
      text = text.slice(0, 3000);
    }
  } else if (type.startsWith("image/")) {
    text = `(Image file: ${name}. Image analysis not available — using 8B text model. Please describe what you'd like to know about this image.)`;
  } else {
    text = `(Unsupported file type: ${type}. Supported: .txt, .md, .csv, .json, .pdf)`;
  }

  // Truncate if too long
  if (text.length > 3000) {
    text = text.slice(0, 3000) + "\n...(truncated)";
  }

  // Generate a brief summary using 8B
  let summary = "";
  try {
    const llm = new ChatGroq({
      model: "llama-3.1-8b-instant",
      apiKey: getNextKey(),
      temperature: 0.1,
      maxTokens: 200,
    });
    const prompt = ChatPromptTemplate.fromMessages([
      ["system", "Summarize this file content in 2-3 sentences. Be concise."],
      ["human", `File: ${name}\nContent:\n${text.slice(0, 1500)}`],
    ]);
    const result = await prompt.pipe(llm).invoke({});
    summary = typeof result.content === "string" ? result.content : "";
  } catch (err: any) {
    console.warn("[FileParser] Summary generation failed:", err.message);
    summary = `File: ${name} (${Math.round(buffer.length / 1024)}KB)`;
  }

  console.log(`[FileParser] Extracted ${text.length} chars, summary: ${summary.length} chars`);
  return { text, summary };
}
