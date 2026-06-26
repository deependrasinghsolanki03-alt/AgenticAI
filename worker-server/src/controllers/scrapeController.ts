// ─── Scrape Controller ─────────────────────────
// GET /api/scrape?url=... — Direct URL content extraction
// Uses Jina Reader (primary) + Mozilla Readability (fallback)

import { Request, Response } from "express";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

async function extractWithJina(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: "text/markdown" },
    signal: controller.signal,
  });
  clearTimeout(timeout);
  if (!res.ok) throw new Error(`Jina returned ${res.status}`);
  return (await res.text()).slice(0, 5000);
}

async function extractWithReadability(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: controller.signal,
  });
  clearTimeout(timeout);
  if (!res.ok) throw new Error(`Fetch returned ${res.status}`);
  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article?.textContent) throw new Error("No content found");
  return article.textContent.replace(/\s+/g, " ").trim().slice(0, 5000);
}

export async function handleScrape(req: Request, res: Response): Promise<void> {
  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: "url query parameter is required." });
    return;
  }

  console.log(`[Scrape] URL: ${url}`);
  try {
    let content: string;
    try {
      content = await extractWithJina(url);
      console.log(`[Scrape] Jina extracted ${content.length} chars`);
    } catch {
      content = await extractWithReadability(url);
      console.log(`[Scrape] Readability extracted ${content.length} chars`);
    }
    res.json({ url, content, chars: content.length });
  } catch (err: any) {
    console.error("[Scrape] Error:", err.message);
    res.status(500).json({ error: `Failed to scrape: ${err.message}` });
  }
}
