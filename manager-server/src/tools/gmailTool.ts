import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export const createGmailTool = (authClient?: OAuth2Client | null) =>
  new DynamicStructuredTool({
    name: "gmail",
    description: `Search the user's Gmail inbox or send emails.`,
    schema: z.object({
      action: z.enum(["search", "send"]),
      query: z.string().optional().describe("Search query"),
      to: z.string().optional(), subject: z.string().optional(), body: z.string().optional(),
    }),
    func: async ({ action, query, to, subject, body }) => {
      if (!authClient) return "Error: Gmail not connected. Please sign in with Google.";
      const gmail = google.gmail({ version: "v1", auth: authClient });
      try {
        if (action === "search") {
          const res = await gmail.users.messages.list({ userId: "me", q: query || "is:unread", maxResults: 5 });
          const messages = res.data.messages || [];
          if (!messages.length) return "No emails found.";
          const details = await Promise.all(messages.map(async (msg) => {
            const d = await gmail.users.messages.get({ userId: "me", id: msg.id!, format: "metadata", metadataHeaders: ["Subject", "From"] });
            const h = d.data.payload?.headers || [];
            return `  • From: ${h.find(x => x.name === "From")?.value}\n    Subject: ${h.find(x => x.name === "Subject")?.value}\n    ${d.data.snippet}`;
          }));
          return `📧 ${details.length} emails:\n${details.join("\n\n")}`;
        } else {
          if (!to || !subject || !body) return "Error: to, subject, body required.";
          const raw = Buffer.from(`To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\nMIME-Version: 1.0\n\n${body}`)
            .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
          return `✅ Email sent to ${to}. ID: ${res.data.id}`;
        }
      } catch (err: any) { return `Gmail error: ${err.message}`; }
    },
  });
