import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export const createCalendarTool = (authClient?: OAuth2Client | null) =>
  new DynamicStructuredTool({
    name: "google_calendar",
    description: `Manage the user's Google Calendar. You can:
- "list": View upcoming events (optionally filter by query).
- "create": Schedule a new event (needs summary, startDateTime, endDateTime).
- "delete": Delete events matching a search query (e.g., delete all "MERN" events).
- "update": Update an existing event's title or time.`,
    schema: z.object({
      action: z.enum(["list", "create", "delete", "update"]).describe("The action to perform"),
      summary: z.string().optional().describe("Event title (for create/update)"),
      startDateTime: z.string().optional().describe("ISO start datetime (for create/update)"),
      endDateTime: z.string().optional().describe("ISO end datetime (for create/update)"),
      query: z.string().optional().describe("Search query (for list/delete — matches event titles)"),
      eventId: z.string().optional().describe("Specific event ID (for delete/update a single event)"),
    }),
    func: async ({ action, summary, startDateTime, endDateTime, query, eventId }) => {
      if (!authClient) return "Error: Google Calendar not connected. Please sign in with Google first.";
      const calendar = google.calendar({ version: "v3", auth: authClient });

      try {
        // ── LIST ─────────────────────────────────
        if (action === "list") {
          const res = await calendar.events.list({
            calendarId: "primary",
            timeMin: new Date().toISOString(),
            maxResults: 15,
            singleEvents: true,
            orderBy: "startTime",
            q: query,
          });
          const events = res.data.items || [];
          if (!events.length) return query ? `No events found matching "${query}".` : "No upcoming events found.";
          return `📅 ${events.length} upcoming events:\n${events.map(e =>
            `  • [${e.id}] ${new Date(e.start?.dateTime || e.start?.date || "").toLocaleString()} — ${e.summary}`
          ).join("\n")}`;
        }

        // ── CREATE ───────────────────────────────
        if (action === "create") {
          if (!summary || !startDateTime || !endDateTime) return "Error: summary, startDateTime, and endDateTime are all required to create an event.";
          const res = await calendar.events.insert({
            calendarId: "primary",
            requestBody: {
              summary,
              start: { dateTime: startDateTime },
              end: { dateTime: endDateTime },
            },
          });
          return `✅ Event scheduled: "${summary}". Link: ${res.data.htmlLink}`;
        }

        // ── DELETE ───────────────────────────────
        if (action === "delete") {
          // Delete by specific event ID
          if (eventId) {
            await calendar.events.delete({ calendarId: "primary", eventId });
            return `🗑️ Event deleted (ID: ${eventId}).`;
          }

          // Delete by search query (find matching events, delete all)
          if (query) {
            const res = await calendar.events.list({
              calendarId: "primary",
              timeMin: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // include today & yesterday
              maxResults: 20,
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
          if (startDateTime) patch.start = { dateTime: startDateTime };
          if (endDateTime) patch.end = { dateTime: endDateTime };

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
