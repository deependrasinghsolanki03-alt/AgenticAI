import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export const createCalendarTool = (authClient?: OAuth2Client | null) =>
  new DynamicStructuredTool({
    name: "google_calendar",
    description: `Manage the user's Google Calendar. You can:
- "list": View events (filter by query text and/or date range with timeMin/timeMax).
- "create": Schedule a new event (needs summary, startDateTime, endDateTime).
- "delete": Delete events matching a search query.
- "update": Update an existing event's title or time.`,
    schema: z.object({
      action: z.enum(["list", "create", "delete", "update"]).describe("The action to perform"),
      summary: z.string().optional().describe("Event title (for create/update)"),
      startDateTime: z.string().optional().describe("ISO start datetime (for create/update)"),
      endDateTime: z.string().optional().describe("ISO end datetime (for create/update)"),
      query: z.string().optional().describe("Search query (for list/delete — matches event titles)"),
      eventId: z.string().optional().describe("Specific event ID (for delete/update a single event)"),
      timeMin: z.string().optional().describe("ISO datetime — show events starting from this time (for list)"),
      timeMax: z.string().optional().describe("ISO datetime — show events up to this time (for list)"),
    }),
    func: async ({ action, summary, startDateTime, endDateTime, query, eventId, timeMin, timeMax }) => {
      if (!authClient) return "Error: Google Calendar not connected. Please sign in with Google first.";
      const calendar = google.calendar({ version: "v3", auth: authClient as any });

      try {
        // ── LIST ─────────────────────────────────
        if (action === "list") {
          const listParams: any = {
            calendarId: "primary",
            timeMin: timeMin || new Date().toISOString(),
            maxResults: 15,
            singleEvents: true,
            orderBy: "startTime",
          };
          if (timeMax) listParams.timeMax = timeMax;
          if (query) listParams.q = query;

          const res = await calendar.events.list(listParams);
          const events = res.data.items || [];
          if (!events.length) {
            if (query) return `No events found matching "${query}".`;
            if (timeMax) return `No events found in this date range.`;
            return "No upcoming events found.";
          }
          return `📅 ${events.length} event(s):\n${events.map(e => {
            const dt = new Date(e.start?.dateTime || e.start?.date || "");
            const dateStr = dt.toLocaleDateString("en-IN", { weekday: "short", month: "short", day: "numeric" });
            const timeStr = e.start?.dateTime ? dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true }) : "All day";
            return `  • ${dateStr}, ${timeStr} — ${e.summary}`;
          }).join("\n")}`;
        }

        // ── CREATE ───────────────────────────────
        if (action === "create") {
          if (!summary || !startDateTime || !endDateTime) return "Error: summary, startDateTime, and endDateTime are all required to create an event.";
          const res = await calendar.events.insert({
            calendarId: "primary",
            requestBody: {
              summary,
              start: { dateTime: startDateTime, timeZone: "Asia/Kolkata" },
              end: { dateTime: endDateTime, timeZone: "Asia/Kolkata" },
            },
          });
          return `✅ Event scheduled: "${summary}". Link: ${res.data.htmlLink}`;
        }

        // ── DELETE ───────────────────────────────
        if (action === "delete") {
          if (eventId) {
            await calendar.events.delete({ calendarId: "primary", eventId });
            return `🗑️ Event deleted (ID: ${eventId}).`;
          }

          if (query) {
            const res = await calendar.events.list({
              calendarId: "primary",
              timeMin: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
              maxResults: 50,
              singleEvents: true,
              q: query,
            });
            const events = res.data.items || [];
            if (!events.length) return `No events found matching "${query}" to delete.`;

            const deleted: string[] = [];
            for (const event of events) {
              try {
                await calendar.events.delete({ calendarId: "primary", eventId: event.id! });
                deleted.push(event.summary || "Untitled");
              } catch (e: any) {
                console.warn(`[Calendar] Failed to delete "${event.summary}": ${e.message}`);
              }
            }
            return `🗑️ Deleted ${deleted.length} event(s):\n${deleted.map(d => `  • ${d}`).join("\n")}`;
          }

          return "Error: Provide either an eventId or a query to find events to delete.";
        }

        // ── UPDATE ───────────────────────────────
        if (action === "update") {
          if (!eventId) return "Error: eventId is required to update an event. Use 'list' first to find the event ID.";
          const patch: any = {};
          if (summary) patch.summary = summary;
          if (startDateTime) patch.start = { dateTime: startDateTime, timeZone: "Asia/Kolkata" };
          if (endDateTime) patch.end = { dateTime: endDateTime, timeZone: "Asia/Kolkata" };

          if (Object.keys(patch).length === 0) return "Error: Provide at least one field to update (summary, startDateTime, or endDateTime).";

          const res = await calendar.events.patch({
            calendarId: "primary",
            eventId,
            requestBody: patch,
          });
          return `✏️ Event updated: "${res.data.summary}". Link: ${res.data.htmlLink}`;
        }

        return "Error: Unknown action. Use list, create, delete, or update.";
      } catch (err: any) {
        console.error(`[Calendar] ${action} error:`, err.message);
        return `Calendar error: ${err.message}`;
      }
    },
  });
