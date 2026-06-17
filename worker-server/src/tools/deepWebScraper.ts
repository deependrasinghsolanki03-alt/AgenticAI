// ─── Deep Web Scraper Tool ──────────────────────
// PRIMARY: DuckDuckGo Lite (stable, no CAPTCHA)
// FALLBACK: SearxNG public instances (3-4 fallbacks)
// EXTRACT: Jina Reader → Mozilla Readability fallback

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ── Step 1A: PRIMARY — DuckDuckGo Lite ──────────

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  console.log("[WebScraper] PRIMARY: DuckDuckGo Lite...");
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return [];
    const html = await res.text();
    const results: SearchResult[] = [];

    // Parse DDG Lite HTML — extract links and snippets
    const linkRegex = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

    const links: { url: string; title: string }[] = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      links.push({
        url: match[1],
        title: match[2].replace(/<[^>]+>/g, "").trim(),
      });
    }

    const snippets: string[] = [];
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]+>/g, "").trim());
    }

    for (let i = 0; i < Math.min(links.length, 5); i++) {
      results.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snippets[i] || "",
      });
    }

    // Broader fallback parse if class-based regex failed
    if (results.length === 0) {
      const hrefRegex = /<a[^>]+href="(https?:\/\/(?!.*duckduckgo)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const seen = new Set<string>();
      while ((match = hrefRegex.exec(html)) !== null) {
        const href = match[1];
        const text = match[2].replace(/<[^>]+>/g, "").trim();
        if (text.length > 10 && !seen.has(href)) {
          seen.add(href);
          results.push({ title: text, url: href, snippet: "" });
          if (results.length >= 5) break;
        }
      }
    }

    if (results.length > 0) {
      console.log(`[WebScraper] DDG returned ${results.length} results`);
    }
    return results;
  } catch (err: any) {
    console.warn("[WebScraper] DDG failed:", err.message);
    return [];
  }
}

// ── Step 1B: FALLBACK — SearxNG Instances ───────

const SEARXNG_INSTANCES = [
  "https://searx.be",
  "https://search.sapti.me",
  "https://searx.tiekoetter.com",
  "https://searxng.ch",
];

async function searchSearxNG(query: string): Promise<SearchResult[]> {
  for (const instance of SEARXNG_INSTANCES) {
    try {
      console.log(`[WebScraper] FALLBACK: SearxNG (${instance})...`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&engines=google,duckduckgo&categories=general`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "AgenticAI/2.0" },
      });
      clearTimeout(timeout);

      if (!res.ok) continue;

      const data = await res.json();
      const results = (data.results || []).slice(0, 5).map((r: any) => ({
        title: r.title || "",
        url: r.url || "",
        snippet: r.content || "",
      }));

      if (results.length > 0) {
        console.log(`[WebScraper] SearxNG returned ${results.length} results`);
        return results;
      }
    } catch {
      continue;
    }
  }
  return [];
}

// ── Step 2: Extract Content ─────────────────────

async function extractWithJina(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: "text/markdown" },
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!res.ok) throw new Error(`Jina returned ${res.status}`);
  const text = await res.text();
  return text.slice(0, 2000);
}

async function extractWithReadability(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!res.ok) throw new Error(`Fetch returned ${res.status}`);
  const html = await res.text();

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article?.textContent) throw new Error("No content found");
  return article.textContent.replace(/\s+/g, " ").trim().slice(0, 2000);
}

async function extractContent(url: string): Promise<string> {
  try {
    return await extractWithJina(url);
  } catch {
    try {
      return await extractWithReadability(url);
    } catch {
      return "(Could not extract content from this page)";
    }
  }
}

// ── Tool Definition ─────────────────────────────

export function createDeepWebScraper() {
  return new DynamicStructuredTool({
    name: "deep_web_scraper",
    description: `Search the internet and extract detailed content from web pages.
Use for research, news, weather, current events, facts, or any real-time data.
Returns search results with full extracted page content.`,
    schema: z.object({
      query: z.string().describe("Search query"),
    }),
    func: async ({ query }) => {
      console.log(`[Tool: WebScraper] Query: "${query}"`);

      try {
        // PRIMARY: DuckDuckGo Lite
        let results = await searchDuckDuckGo(query);

        // FALLBACK: SearxNG instances
        if (results.length === 0) {
          results = await searchSearxNG(query);
        }

        if (results.length === 0) {
          return `No search results found for "${query}". Try rephrasing.`;
        }

        // Extract content from top 3 results
        const top3 = results.slice(0, 3);
        const extracted = await Promise.all(
          top3.map(async (r) => {
            const content = await extractContent(r.url);
            return `### ${r.title}\n**URL:** ${r.url}\n**Content:**\n${content}`;
          })
        );

        console.log(`[Tool: WebScraper] Extracted ${extracted.length} pages`);
        return `🌐 Web Research for "${query}":\n\n${extracted.join("\n\n---\n\n")}`;
      } catch (err: any) {
        console.error("[Tool: WebScraper] Error:", err.message);
        return `Web scraping failed: ${err.message}. Answer from your own knowledge.`;
      }
    },
  });
}
