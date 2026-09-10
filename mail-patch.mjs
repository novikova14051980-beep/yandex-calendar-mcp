import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const EMAIL = process.env.YANDEX_EMAIL;
const PASSWORD = process.env.YANDEX_MAIL_APP_PASSWORD;

const IMAP_HOST = "imap.yandex.ru";
const IMAP_PORT = 993;
const SMTP_HOST = "smtp.yandex.ru";
const SMTP_PORT = 465;
const MAX_LOCAL_ENVELOPE_SCAN = 2000;

function assertConfigured() {
  if (!EMAIL || !PASSWORD) throw new Error("YANDEX_MAIL_APP_PASSWORD is not configured");
}

function jsonText(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function makeImapClient() {
  assertConfigured();
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: EMAIL, pass: PASSWORD },
    logger: false,
    socketTimeout: 30000,
  });
}

function makeTransport() {
  assertConfigured();
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user: EMAIL, pass: PASSWORD },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
  });
}

function makeMimeBuilder() {
  return nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
  });
}

async function withImap(fn) {
  const client = makeImapClient();
  await client.connect();
  try { return await fn(client); }
  finally { try { await client.logout(); } catch {} }
}

function addressListToStrings(list) {
  if (!list?.value) return [];
  return list.value
    .map(item => item.name ? `${item.name} <${item.address}>` : item.address)
    .filter(Boolean);
}

function imapAddressArrayToStrings(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(item => item?.name ? `${item.name} <${item.address}>` : item?.address)
    .filter(Boolean);
}

function extractEmail(value = "") {
  const text = String(value || "");
  const bracketed = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (bracketed) return bracketed[1].toLowerCase();
  const plain = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return plain ? plain[0].toLowerCase() : "";
}

function uniqueAddresses(values, excludedEmails = new Set()) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const email = extractEmail(value);
    const key = email || String(value).trim().toLowerCase();
    if (!key || excludedEmails.has(email) || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizePersonText(value = "") {
  return String(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}@._+-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

function fuzzyWordMatch(queryWord, valueWord) {
  if (!queryWord || !valueWord) return false;
  if (queryWord === valueWord || queryWord.includes(valueWord) || valueWord.includes(queryWord)) return true;
  const minLen = Math.min(queryWord.length, valueWord.length);
  if (minLen < 5) return false;
  return commonPrefixLength(queryWord, valueWord) >= Math.max(4, minLen - 2);
}

function senderMatchesName(fromList, query) {
  const queryWords = normalizePersonText(query).split(" ").filter(Boolean);
  if (!queryWords.length) return true;
  const senderWords = normalizePersonText((fromList || []).join(" ")).split(" ").filter(Boolean);
  return queryWords.every(q => senderWords.some(word => fuzzyWordMatch(q, word)));
}

function stripHtml(value = "") {
  return String(value)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeQuotedHtml(value = "") {
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "");
}

function messageSummary(parsed, uid, mailbox, { includeHtml = false } = {}) {
  const rawHtml = typeof parsed.html === "string" ? parsed.html : "";
  const fallbackText = parsed.text || stripHtml(rawHtml) || "";
  const result = {
    mailbox,
    uid,
    message_id: parsed.messageId || null,
    subject: parsed.subject || "",
    from: addressListToStrings(parsed.from),
    reply_to: addressListToStrings(parsed.replyTo),
    to: addressListToStrings(parsed.to),
    cc: addressListToStrings(parsed.cc),
    date: parsed.date ? parsed.date.toISOString() : null,
    text: fallbackText,
    html_present: Boolean(rawHtml),
    in_reply_to: parsed.inReplyTo || null,
    references: Array.isArray(parsed.references)
      ? parsed.references
      : (parsed.references ? [parsed.references] : []),
  };
  if (includeHtml && rawHtml) result.html = rawHtml;
  return result;
}

function envelopeSummary(message, uid, mailbox) {
  const envelope = message?.envelope || {};
  let date = null;
  let receivedAt = null;
  try { if (envelope.date) date = new Date(envelope.date).toISOString(); } catch {}
  try { if (message?.internalDate) receivedAt = new Date(message.internalDate).toISOString(); } catch {}
  return {
    mailbox,
    uid,
    message_id: envelope.messageId || null,
    subject: envelope.subject || "",
    from: imapAddressArrayToStrings(envelope.from),
    to: imapAddressArrayToStrings(envelope.to),
    cc: imapAddressArrayToStrings(envelope.cc),
    date,
    received_at: receivedAt,
    in_reply_to: envelope.inReplyTo || null,
  };
}

function messageSortTime(message) {
  const value = message?.received_at || message?.date;
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : 0;
}

async function resolveMailbox(client, preferred = "INBOX") {
  const list = await client.list();
  const wanted = String(preferred || "INBOX").toLowerCase();
  const exact = list.find(item => item.path.toLowerCase() === wanted);
  if (exact) return exact.path;

  if (["drafts", "draft", "черновики", "черновик"].includes(wanted)) {
    return list.find(item => item.specialUse === "\\Drafts")?.path
      || list.find(item => /draft|чернов/i.test(item.path))?.path
      || preferred;
  }
  if (["sent", "sent items", "отправленные"].includes(wanted)) {
    return list.find(item => item.specialUse === "\\Sent")?.path
      || list.find(item => /sent|отправ/i.test(item.path))?.path
      || preferred;
  }
  if (["trash", "deleted", "удаленные", "удалённые"].includes(wanted)) {
    return list.find(item => item.specialUse === "\\Trash")?.path
      || list.find(item => /trash|deleted|удален|удалён/i.test(item.path))?.path
      || preferred;
  }

  return preferred;
}

function findDraftsMailbox(list) {
  return list.find(item => item.specialUse === "\\Drafts")?.path
    || list.find(item => /draft|чернов/i.test(item.path))?.path
    || "Drafts";
}

async function fetchEnvelopeSummariesByUid(client, uids, box) {
  const results = [];
  for (const uid of uids) {
    const msg = await client.fetchOne(
      uid,
      { envelope: true, internalDate: true },
      { uid: true },
    );
    if (msg) results.push(envelopeSummary(msg, uid, box));
  }
  return results;
}

async function scanRecentEnvelopeSummaries(client, box, senderName) {
  const exists = Number(client.mailbox?.exists || 0);
  if (!exists) return [];
  const start = Math.max(1, exists - MAX_LOCAL_ENVELOPE_SCAN + 1);
  const results = [];

  for await (const msg of client.fetch(
    `${start}:*`,
    { uid: true, envelope: true, internalDate: true },
  )) {
    const summary = envelopeSummary(msg, msg.uid, box);
    if (senderMatchesName(summary.from, senderName)) results.push(summary);
  }
  return results;
}

async function searchMail({
  query,
  from,
  to,
  subject,
  body_query,
  mailbox = "INBOX",
  since_iso,
  before_iso,
  max_results = 10,
}) {
  const hasFilter = Boolean(query || from || to || subject || body_query || since_iso || before_iso);
  if (!hasFilter) {
    throw new Error("Mail search needs a sender, recipient, subject, query, body_query, or date range");
  }

  return withImap(async client => {
    const box = await resolveMailbox(client, mailbox);
    const lock = await client.getMailboxLock(box);
    try {
      const startedAt = Date.now();
      const fromIsName = Boolean(from && !String(from).includes("@"));
      let results = [];
      let mode = "imap_search";

      if (fromIsName && !query && !to && !subject && !body_query && !since_iso && !before_iso) {
        // Yandex IMAP may not reliably match Cyrillic display names because they can
        // be MIME-encoded in the From header. Scan only lightweight envelopes from
        // the most recent messages and match the visible sender name locally.
        mode = "recent_envelope_name_scan";
        results = await scanRecentEnvelopeSummaries(client, box, from);
      } else {
        const criteria = {};

        // General query searches headers only. BODY search is opt-in because it can
        // be expensive on a large mailbox.
        if (query) criteria.or = [
          { subject: query },
          { from: query },
          { to: query },
        ];
        if (from && !fromIsName) criteria.from = from;
        if (to) criteria.to = to;
        if (subject) criteria.subject = subject;
        if (body_query) criteria.body = body_query;
        if (since_iso) criteria.since = new Date(since_iso);
        if (before_iso) criteria.before = new Date(before_iso);

        const uids = await client.search(
          Object.keys(criteria).length ? criteria : { all: true },
          { uid: true },
        );

        // Fetch lightweight metadata, then sort by actual received date. Do not
        // assume UID order equals chronological order.
        const candidateUids = uids.length > MAX_LOCAL_ENVELOPE_SCAN
          ? uids.slice(-MAX_LOCAL_ENVELOPE_SCAN)
          : uids;
        results = await fetchEnvelopeSummariesByUid(client, candidateUids, box);
        if (fromIsName) results = results.filter(item => senderMatchesName(item.from, from));
      }

      if (since_iso) {
        const since = new Date(since_iso).getTime();
        results = results.filter(item => messageSortTime(item) >= since);
      }
      if (before_iso) {
        const before = new Date(before_iso).getTime();
        results = results.filter(item => messageSortTime(item) < before);
      }

      results.sort((a, b) => messageSortTime(b) - messageSortTime(a) || b.uid - a.uid);
      const returned = results.slice(0, max_results);

      console.log(`[MAIL] search mailbox=${box} mode=${mode} matches=${results.length} returned=${returned.length} ms=${Date.now() - startedAt} body=${Boolean(body_query)}`);
      return returned;
    } finally {
      lock.release();
    }
  });
}

async function readMail({ uid, mailbox = "INBOX" }) {
  return withImap(async client => {
    const box = await resolveMailbox(client, mailbox);
    const lock = await client.getMailboxLock(box);
    try {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!msg?.source) throw new Error(`Message not found: uid=${uid} mailbox=${box}`);
      const parsed = await simpleParser(msg.source);
      return messageSummary(parsed, uid, box, { includeHtml: true });
    } finally {
      lock.release();
    }
  });
}

function quotePlainText(value = "") {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "> (текст предыдущего письма не удалось извлечь)";
  return text.split("\n").map(line => `> ${line}`).join("\n");
}

function formatReplyDate(value) {
  if (!value) return "дата не указана";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Moscow",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function buildReplyBodies(original, { text = "", html } = {}) {
  const sender = original.from?.[0] || "неизвестный отправитель";
  const date = formatReplyDate(original.date);
  const originalHtml = typeof original.html === "string" ? original.html : "";
  const originalText = original.text || stripHtml(originalHtml) || "";
  const replyText = String(text || stripHtml(html || "")).trim();

  const quotedHeader = [
    "",
    "",
    `В ${date} ${sender} написал(а):`,
    "",
  ].join("\n");

  const combinedText = `${replyText}${quotedHeader}${quotePlainText(originalText)}`;

  const replyHtml = html
    ? html
    : `<div style="white-space:pre-wrap">${escapeHtml(replyText)}</div>`;

  const quotedBodyHtml = originalHtml
    ? sanitizeQuotedHtml(originalHtml)
    : `<div style="white-space:pre-wrap">${escapeHtml(originalText || "(текст предыдущего письма не удалось извлечь)")}</div>`;

  const combinedHtml = `${replyHtml}<br><br><div class="yandex-assistant-reply-quote"><div>В ${escapeHtml(date)} ${escapeHtml(sender)} написал(а):</div><blockquote style="margin:10px 0 0 0;padding-left:12px;border-left:2px solid #ccc">${quotedBodyHtml}</blockquote></div>`;

  return { text: combinedText, html: combinedHtml };
}

async function createDraft({ to, cc = [], bcc = [], subject, text, html, in_reply_to, references = [] }) {
  assertConfigured();

  const builder = makeMimeBuilder();
  const info = await builder.sendMail({
    from: EMAIL,
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    inReplyTo: in_reply_to || undefined,
    references: references.length ? references : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  const raw = Buffer.isBuffer(info.message)
    ? info.message
    : (info.message ? Buffer.from(String(info.message), "utf8") : null);
  if (!raw?.length) throw new Error("Could not build draft MIME message");

  return withImap(async client => {
    const boxes = await client.list();
    const drafts = findDraftsMailbox(boxes);
    const appended = await client.append(drafts, raw, ["\\Draft"], new Date());
    console.log(`[MAIL] draft appended mailbox=${drafts} uid=${appended?.uid || "unknown"} reply=${Boolean(in_reply_to)}`);
    return {
      ok: true,
      mailbox: drafts,
      uid: appended?.uid || null,
      message_id: info.messageId || null,
      sent: false,
      threaded_reply: Boolean(in_reply_to),
    };
  });
}

async function sendMailNow({ to, cc = [], bcc = [], subject, text, html, in_reply_to, references = [] }) {
  const transport = makeTransport();
  const info = await transport.sendMail({
    from: EMAIL,
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    inReplyTo: in_reply_to || undefined,
    references: references.length ? references : undefined,
  });
  return {
    ok: true,
    message_id: info.messageId || null,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
  };
}

async function replyToMessage({ uid, mailbox = "INBOX", text, html, send = false, reply_all = false }) {
  const original = await readMail({ uid, mailbox });
  const primaryReply = original.reply_to?.[0] || original.from?.[0];
  if (!primaryReply) throw new Error("Original message has no sender or Reply-To address");

  const subject = /^re:/i.test(original.subject)
    ? original.subject
    : `Re: ${original.subject}`;

  const refs = [...(original.references || [])];
  if (original.message_id) refs.push(original.message_id);

  const ownEmail = String(EMAIL || "").toLowerCase();
  const excluded = new Set([ownEmail]);
  const toRecipients = [primaryReply];
  excluded.add(extractEmail(primaryReply));

  let ccRecipients = [];
  if (reply_all) {
    const additionalTo = uniqueAddresses(original.to || [], excluded);
    toRecipients.push(...additionalTo);
    for (const value of additionalTo) excluded.add(extractEmail(value));
    ccRecipients = uniqueAddresses(original.cc || [], excluded);
  }

  const bodies = buildReplyBodies(original, { text, html });
  const payload = {
    to: uniqueAddresses(toRecipients, new Set([ownEmail])),
    cc: ccRecipients,
    subject,
    text: bodies.text,
    html: bodies.html,
    in_reply_to: original.message_id,
    references: [...new Set(refs.filter(Boolean))],
  };

  const result = send ? await sendMailNow(payload) : await createDraft(payload);
  return {
    ...result,
    reply_to_uid: uid,
    reply_to_message_id: original.message_id,
    original_body_found: Boolean(original.text || original.html),
    reply_all,
    recipients: { to: payload.to, cc: payload.cc },
  };
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function patchedMailConnect(...args) {
  if (!this.__yandexMailToolsAdded) {
    this.__yandexMailToolsAdded = true;

    this.tool(
      "search_yandex_mail",
      "Fast targeted Yandex Mail search. For requests like 'latest email from [person]', put the person's name or email in from. Sender-name searches use lightweight recent-envelope matching so MIME-encoded Cyrillic names are handled. Results are sorted by actual received date, newest first. The general query searches only From, To, and Subject; use body_query only when body-text search is explicitly needed.",
      {
        query: z.string().optional().describe("General header search across From, To, and Subject only"),
        from: z.string().optional().describe("Sender name or email. Use this for requests like 'latest email from Maria'"),
        to: z.string().optional().describe("Recipient name or email"),
        subject: z.string().optional().describe("Subject text"),
        body_query: z.string().optional().describe("Explicit body-text search; slower, use only when necessary"),
        mailbox: z.string().optional().default("INBOX"),
        since_iso: z.string().optional(),
        before_iso: z.string().optional(),
        max_results: z.number().int().min(1).max(20).optional().default(10),
      },
      async args => {
        try {
          const messages = await searchMail(args);
          return jsonText({ ok: true, count: messages.length, messages });
        } catch (error) {
          return jsonText({ ok: false, error: error.message });
        }
      }
    );

    this.tool(
      "read_yandex_mail",
      "Read one selected Yandex Mail message by IMAP UID and mailbox, including the full message body. Use only after search_yandex_mail identifies the specific message needed.",
      {
        uid: z.number().int().positive(),
        mailbox: z.string().optional().default("INBOX"),
      },
      async args => {
        try {
          return jsonText({ ok: true, message: await readMail(args) });
        } catch (error) {
          return jsonText({ ok: false, error: error.message });
        }
      }
    );

    this.tool(
      "create_yandex_mail_draft",
      "Create a new standalone draft email in Yandex Mail without sending it. Do not use this tool when the user asks to reply to an existing message; use reply_to_yandex_mail instead.",
      {
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).optional().default([]),
        bcc: z.array(z.string().email()).optional().default([]),
        subject: z.string(),
        text: z.string().optional().default(""),
        html: z.string().optional(),
        in_reply_to: z.string().optional(),
        references: z.array(z.string()).optional().default([]),
      },
      async args => {
        try {
          return jsonText(await createDraft(args));
        } catch (error) {
          return jsonText({ ok: false, error: error.message });
        }
      }
    );

    this.tool(
      "send_yandex_mail",
      "Send an email immediately from the connected Yandex mailbox. Use only when the user explicitly asks to send the email.",
      {
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).optional().default([]),
        bcc: z.array(z.string().email()).optional().default([]),
        subject: z.string(),
        text: z.string().optional().default(""),
        html: z.string().optional(),
        in_reply_to: z.string().optional(),
        references: z.array(z.string()).optional().default([]),
      },
      async args => {
        try {
          return jsonText(await sendMailNow(args));
        } catch (error) {
          return jsonText({ ok: false, error: error.message });
        }
      }
    );

    this.tool(
      "reply_to_yandex_mail",
      "Reply to an existing Yandex Mail message by UID. It preserves In-Reply-To/References and the visible previous correspondence. By default it saves a draft and does not send. Set reply_all=true when the user says 'reply all' so original To/Cc recipients are preserved except the connected user's own address. Set send=true only when the user explicitly asks to send.",
      {
        uid: z.number().int().positive(),
        mailbox: z.string().optional().default("INBOX"),
        text: z.string().optional().default(""),
        html: z.string().optional(),
        reply_all: z.boolean().optional().default(false),
        send: z.boolean().optional().default(false),
      },
      async args => {
        try {
          return jsonText(await replyToMessage(args));
        } catch (error) {
          return jsonText({ ok: false, error: error.message });
        }
      }
    );
  }

  return originalConnect.apply(this, args);
};

if (EMAIL && PASSWORD) {
  withImap(async client => {
    const inbox = await resolveMailbox(client, "INBOX");
    console.log(`[READY] Mail: connected mailbox=${inbox}`);
  }).catch(error => console.error(`[READY] Mail: authentication_failed ${error.message}`));
} else {
  console.log("[READY] Mail: not_configured");
}
