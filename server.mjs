import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 10000);
const YANDEX_EMAIL = process.env.YANDEX_EMAIL;
const YANDEX_OAUTH_TOKEN = process.env.YANDEX_OAUTH_TOKEN;
const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET;

if (!YANDEX_EMAIL || !YANDEX_OAUTH_TOKEN || !MCP_PATH_SECRET) {
  console.error("Missing YANDEX_EMAIL, YANDEX_OAUTH_TOKEN or MCP_PATH_SECRET");
  process.exit(1);
}

const CALDAV_BASE = "https://caldav.yandex.ru/calendars";
const TELEMOST_BASE = "https://cloud-api.yandex.net/v1/telemost-api";

function authHeaders(extra = {}) {
  return { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}`, ...extra };
}

function escapeIcsText(value = "") {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function toIcsUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid datetime: ${iso}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function readBodySafe(response) {
  const text = await response.text();
  if (!text) return "";
  try { return JSON.parse(text); } catch { return text; }
}

async function yandexFetch(url, options = {}) {
  const response = await fetch(url, options);
  const body = await readBodySafe(response);
  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`Yandex API ${response.status}: ${detail}`);
  }
  return { response, body };
}

function calendarCollectionUrl() {
  return `${CALDAV_BASE}/${encodeURIComponent(YANDEX_EMAIL)}/events-default/`;
}

function eventUrl(uid) {
  return `${calendarCollectionUrl()}${encodeURIComponent(uid)}.ics`;
}

function unfoldIcs(text = "") {
  return String(text).replace(/\r?\n[ \t]/g, "");
}

function icsValue(block, name) {
  const re = new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "mi");
  const match = unfoldIcs(block).match(re);
  return match ? match[1].trim() : null;
}

function parseIcsDate(raw) {
  if (!raw) return null;
  const value = raw.trim();
  let m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0));
  return null;
}

function parseEventsFromIcs(ics) {
  const unfolded = unfoldIcs(ics);
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  return blocks.map((block) => {
    const startRaw = icsValue(block, "DTSTART");
    const endRaw = icsValue(block, "DTEND");
    const start = parseIcsDate(startRaw);
    const end = parseIcsDate(endRaw);
    return {
      uid: icsValue(block, "UID"),
      title: (icsValue(block, "SUMMARY") || "").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/g, "\n"),
      start_raw: startRaw,
      end_raw: endRaw,
      start_iso: start ? start.toISOString() : null,
      end_iso: end ? end.toISOString() : null,
      description: (icsValue(block, "DESCRIPTION") || "").replace(/\\n/g, "\n"),
      telemost_url: icsValue(block, "X-TELEMOST-CONFERENCE"),
    };
  });
}

async function listCalendarEvents(startIso, endIso) {
  const start = toIcsUtc(startIso);
  const end = toIcsUtc(endIso);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<d:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${start}" end="${end}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</d:calendar-query>`;

  const { body } = await yandexFetch(calendarCollectionUrl(), {
    method: "REPORT",
    headers: authHeaders({
      "Content-Type": "application/xml; charset=utf-8",
      Depth: "1",
    }),
    body: xml,
  });

  const text = String(body);
  const chunks = [];
  const re = /<(?:[A-Za-z0-9_-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?calendar-data>/gi;
  let match;
  while ((match = re.exec(text))) chunks.push(decodeXml(match[1]));

  const events = chunks.flatMap(parseEventsFromIcs).filter((event) => event.uid);
  events.sort((a, b) => String(a.start_iso || a.start_raw).localeCompare(String(b.start_iso || b.start_raw)));
  return events;
}

function buildEventIcs({ uid, title, start_iso, end_iso, description, attendees, create_telemost }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ChatGPT Yandex Calendar MCP//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toIcsUtc(new Date().toISOString())}`,
    `DTSTART:${toIcsUtc(start_iso)}`,
    `DTEND:${toIcsUtc(end_iso)}`,
    `SUMMARY:${escapeIcsText(title)}`,
    `DESCRIPTION:${escapeIcsText(description || "")}`,
    `ORGANIZER:mailto:${YANDEX_EMAIL}`,
  ];

  if (create_telemost) lines.push("X-TELEMOST-REQUIRED:TRUE");
  for (const email of attendees || []) lines.push(`ATTENDEE;RSVP=TRUE:mailto:${email}`);
  lines.push("END:VEVENT", "END:VCALENDAR", "");
  return lines.join("\r\n");
}

function parseTelemostFromIcs(ics) {
  const match = String(ics).match(/^X-TELEMOST-CONFERENCE:(.+)$/mi);
  if (!match) return null;
  const join_url = match[1].trim();
  const idMatch = join_url.match(/\/j\/([^/?#]+)/);
  return { join_url, id: idMatch?.[1] || null };
}

async function createCalendarEvent(args) {
  const uid = randomUUID();
  const ics = buildEventIcs({ ...args, uid });
  await yandexFetch(eventUrl(uid), {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "text/ics; charset=utf-8" }),
    body: ics,
  });
  const { body } = await yandexFetch(eventUrl(uid), { method: "GET", headers: authHeaders() });
  return { uid, telemost: parseTelemostFromIcs(body), ics: body };
}

async function updateTelemost(conferenceId, payload) {
  const { body } = await yandexFetch(`${TELEMOST_BASE}/conferences/${encodeURIComponent(conferenceId)}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return body;
}

async function replaceCohosts(conferenceId, emails) {
  const { body } = await yandexFetch(`${TELEMOST_BASE}/conferences/${encodeURIComponent(conferenceId)}/cohosts`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ cohosts: emails.map(email => ({ email })) }),
  });
  return body;
}

function jsonText(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function buildMcpServer() {
  const server = new McpServer({ name: "yandex-calendar-mcp", version: "1.1.0" });

  server.tool(
    "list_yandex_events",
    "List Yandex Calendar events that overlap a time range. Use this before scheduling when you need to inspect the user's calendar or detect conflicts.",
    {
      start_iso: z.string().describe("Range start as ISO-8601 datetime with timezone"),
      end_iso: z.string().describe("Range end as ISO-8601 datetime with timezone"),
      query: z.string().optional().describe("Optional case-insensitive text filter for title or description"),
    },
    async ({ start_iso, end_iso, query }) => {
      try {
        let events = await listCalendarEvents(start_iso, end_iso);
        if (query) {
          const q = query.toLowerCase();
          events = events.filter((e) => `${e.title}\n${e.description}`.toLowerCase().includes(q));
        }
        return jsonText({ ok: true, count: events.length, events });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  server.tool(
    "find_yandex_free_slots",
    "Find free time slots in Yandex Calendar inside a requested window. Use this when the user asks when they are free.",
    {
      window_start_iso: z.string().describe("Search window start as ISO-8601 datetime with timezone"),
      window_end_iso: z.string().describe("Search window end as ISO-8601 datetime with timezone"),
      duration_minutes: z.number().int().min(5).max(720).default(60),
      step_minutes: z.number().int().min(5).max(120).default(30),
      max_results: z.number().int().min(1).max(20).default(10),
    },
    async ({ window_start_iso, window_end_iso, duration_minutes, step_minutes, max_results }) => {
      try {
        const windowStart = new Date(window_start_iso);
        const windowEnd = new Date(window_end_iso);
        if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime()) || windowEnd <= windowStart) {
          throw new Error("Invalid search window");
        }
        const events = await listCalendarEvents(window_start_iso, window_end_iso);
        const busy = events
          .map((e) => ({ start: e.start_iso ? new Date(e.start_iso) : null, end: e.end_iso ? new Date(e.end_iso) : null, title: e.title }))
          .filter((e) => e.start && e.end && e.end > e.start)
          .sort((a, b) => a.start - b.start);

        const durationMs = duration_minutes * 60000;
        const stepMs = step_minutes * 60000;
        const slots = [];
        for (let t = windowStart.getTime(); t + durationMs <= windowEnd.getTime() && slots.length < max_results; t += stepMs) {
          const s = new Date(t);
          const e = new Date(t + durationMs);
          const conflict = busy.some((b) => s < b.end && e > b.start);
          if (!conflict) slots.push({ start_iso: s.toISOString(), end_iso: e.toISOString() });
        }
        return jsonText({ ok: true, slots, busy_events: busy.map((b) => ({ title: b.title, start_iso: b.start.toISOString(), end_iso: b.end.toISOString() })) });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  server.tool(
    "schedule_yandex_meeting",
    "Create a Yandex Calendar event, optionally generate a Yandex Telemost link, invite attendees, assign Telemost cohosts, and set the waiting-room policy for that specific meeting.",
    {
      title: z.string().min(1),
      start_iso: z.string().describe("ISO-8601 datetime with timezone, e.g. 2026-09-09T15:00:00+03:00"),
      end_iso: z.string().describe("ISO-8601 datetime with timezone"),
      description: z.string().optional().default(""),
      attendees: z.array(z.string().email()).optional().default([]),
      create_telemost: z.boolean().optional().default(true),
      cohosts: z.array(z.string().email()).optional().default([]),
      waiting_room_level: z.enum(["PUBLIC", "ORGANIZATION", "ADMINS"]).optional().default("PUBLIC"),
    },
    async (args) => {
      try {
        const created = await createCalendarEvent(args);
        let telemost_configuration = null;
        if (args.create_telemost && created.telemost?.id) {
          if (args.cohosts.length) await replaceCohosts(created.telemost.id, args.cohosts);
          telemost_configuration = await updateTelemost(created.telemost.id, { waiting_room_level: args.waiting_room_level });
        }
        return jsonText({ ok: true, event_uid: created.uid, calendar: "events-default", telemost: created.telemost, invited_attendees: args.attendees, cohosts: args.cohosts, waiting_room_level: args.waiting_room_level, telemost_configuration });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  server.tool(
    "get_yandex_event",
    "Read a Yandex Calendar event by its UID.",
    { event_uid: z.string().min(1) },
    async ({ event_uid }) => {
      try {
        const { body } = await yandexFetch(eventUrl(event_uid), { method: "GET", headers: authHeaders() });
        return { content: [{ type: "text", text: String(body) }] };
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  server.tool(
    "delete_yandex_event",
    "Delete a Yandex Calendar event by UID.",
    { event_uid: z.string().min(1) },
    async ({ event_uid }) => {
      try {
        await yandexFetch(eventUrl(event_uid), { method: "DELETE", headers: authHeaders() });
        return jsonText({ ok: true, deleted_event_uid: event_uid });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  server.tool(
    "configure_telemost_meeting",
    "Change a specific Telemost meeting: waiting-room policy and/or the complete cohost list.",
    {
      conference_id: z.string().min(1),
      waiting_room_level: z.enum(["PUBLIC", "ORGANIZATION", "ADMINS"]).optional(),
      cohosts: z.array(z.string().email()).optional(),
    },
    async ({ conference_id, waiting_room_level, cohosts }) => {
      try {
        if (cohosts) await replaceCohosts(conference_id, cohosts);
        let meeting = null;
        if (waiting_room_level) meeting = await updateTelemost(conference_id, { waiting_room_level });
        return jsonText({ ok: true, conference_id, waiting_room_level, cohosts, meeting });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  server.tool(
    "get_telemost_meeting",
    "Read a Yandex Telemost meeting by conference ID.",
    { conference_id: z.string().min(1) },
    async ({ conference_id }) => {
      try {
        const { body } = await yandexFetch(`${TELEMOST_BASE}/conferences/${encodeURIComponent(conference_id)}`, { method: "GET", headers: authHeaders({ "Content-Type": "application/json" }) });
        return jsonText(body);
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/", (_req, res) => res.status(200).send("Yandex Calendar MCP is running"));
app.get("/health", (_req, res) => res.json({ ok: true }));

const mcpPath = `/mcp/${MCP_PATH_SECRET}`;
const sessions = new Map();

app.all(mcpPath, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;
    if (sessionId && sessions.has(sessionId)) {
      transport = sessions.get(sessionId);
    } else if (req.method === "POST" && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      const server = buildMcpServer();
      await server.connect(transport);
    } else {
      res.status(sessionId ? 404 : 400).json({ jsonrpc: "2.0", error: { code: -32000, message: sessionId ? "Session not found" : "Initialize request required" }, id: null });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: "MCP server error" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Yandex Calendar MCP listening on port ${PORT}`);
  console.log(`MCP endpoint: ${mcpPath}`);
});
