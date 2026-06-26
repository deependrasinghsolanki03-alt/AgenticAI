// ─── URL Scraper Tool (calls Worker /api/scrape) ────
// For when the planner detects a URL in user's message

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const WORKER_URL = process.env.WORKER_URL || "http://localhost:5001";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "";

export function createScraperTool(onStatus?: (s: string) => void) {
  return new DynamicStructuredTool({
    name: "url_scraper",
    description: `Extract and read content from a specific URL/webpage. Use when user shares a link and wants to know what's on the page.`,
    schema: z.object({
      url: z.string().describe("The URL to scrape and extract content from"),
    }),
    func: async ({ url }) => {
      console.log(`[Tool: Scraper] Scraping: ${url}`);
      onStatus?.(`Reading: ${url.substring(0, 50)}...`);

      try {
        const res = await fetch(`${WORKER_URL}/api/scrape?url=${encodeURIComponent(url)}`, {
          headers: { "X-Internal-Key": INTERNAL_SECRET },
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as any).error || `Worker returned ${res.status}`);
        }

        const data = await res.json() as { url: string; content: string; chars: number };
        console.log(`[Tool: Scraper] Got ${data.chars} chars from ${url}`);
        return `📄 **Content from ${url}:**\n\n${data.content}`;
      } catch (err: any) {
        console.error("[Tool: Scraper] Error:", err.message);
        return `Could not read this URL: ${err.message}`;
      }
    },
  });
}
