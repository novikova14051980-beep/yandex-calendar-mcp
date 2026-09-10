import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const EMAIL = process.env.YANDEX_EMAIL;
const PASSWORD = process.env.YANDEX_CARDDAV_APP_PASSWORD;
const CARD_BASE = "https://carddav.yandex.ru/";
const AUTH = EMAIL && PASSWORD
  ? `Basic ${Buffer.from(`${EMAIL}:${PASSWORD}`, "utf8").toString("base64")}`
  : null;

let addressBookUrl = null;
let contactCache = null;
let contactCacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function decodeXml(value = "") {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function absoluteUrl(base, href) {
  try { return new URL(decodeXml(String(href || "").trim()), base).toString(); }
  catch { return null; }
}

async function cardRequest(url, { method = "PROPFIND", depth = "0", body = "" } = {}) {
  if (!AUTH) throw new Error("YANDEX_CARDDAV_APP_PASSWORD is not configured");
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: AUTH,
      Depth: depth,
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: body || undefined,
    redirect: "follow",
  });
  const text = await response.text();
  return { status: response.status, text, url: response.url || url };
}

function firstHrefForProperty(xml, property) {
  const re = new RegExp(`<[^>]*${property}[^>]*>[\\s\\S]*?<[^>]*href[^>]*>([^<]+)<\\/[^>]*href>`, "i");
  const match = String(xml).match(re);
  return match ? decodeXml(match[1].trim()) : null;
}

function extractAddressbookCollections(xml, baseUrl) {
  const responses = String(xml).match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi) || [];
  const books = [];
  for (const block of responses) {
    if (!/<(?:[A-Za-z0-9_-]+:)?addressbook\b/i.test(block)) continue;
    const href = block.match(/<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]+)<\/(?:[A-Za-z0-9_-]+:)?href>/i)?.[1];
    const name = block.match(/<(?:[A-Za-z0-9_-]+:)?displayname[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?displayname>/i)?.[1] || "";
    const url = absoluteUrl(baseUrl, href);
    if (url) books.push({ url, name: decodeXml(name.trim()) });
  }
  return books;
}

async function discoverAddressBook() {
  if (addressBookUrl) return addressBookUrl;
  if (!AUTH) {
    console.log("[READY] Contacts: not_configured");
    return null;
  }

  const principalBody = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
  const root = await cardRequest(CARD_BASE, { body: principalBody });
  console.log(`[CARDDAV] root current-user-principal: HTTP ${root.status}`);
  if (root.status < 200 || root.status >= 300) throw new Error(`CardDAV principal discovery failed: HTTP ${root.status}`);

  const principalHref = firstHrefForProperty(root.text, "current-user-principal");
  const principalUrl = absoluteUrl(root.url, principalHref);
  if (!principalUrl) throw new Error("CardDAV current-user-principal not found");

  const homeBody = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><card:addressbook-home-set/></d:prop>
</d:propfind>`;
  const home = await cardRequest(principalUrl, { body: homeBody });
  console.log(`[CARDDAV] addressbook-home-set: HTTP ${home.status}`);
  if (home.status < 200 || home.status >= 300) throw new Error(`CardDAV home discovery failed: HTTP ${home.status}`);

  const homeHref = firstHrefForProperty(home.text, "addressbook-home-set");
  const homeUrl = absoluteUrl(principalUrl, homeHref);
  if (!homeUrl) throw new Error("CardDAV addressbook-home-set not found");

  const listBody = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:displayname/><d:resourcetype/></d:prop>
</d:propfind>`;
  const list = await cardRequest(homeUrl, { depth: "1", body: listBody });
  console.log(`[CARDDAV] addressbook listing: HTTP ${list.status}`);
  if (list.status < 200 || list.status >= 300) throw new Error(`CardDAV addressbook listing failed: HTTP ${list.status}`);

  const books = extractAddressbookCollections(list.text, homeUrl);
  if (!books.length) throw new Error("No CardDAV address books found");
  const preferred = books.find(b => /contact|контакт|address|основ/i.test(b.name)) || books[0];
  addressBookUrl = preferred.url.endsWith("/") ? preferred.url : `${preferred.url}/`;
  console.log(`[READY] Contacts: connected path=${new URL(addressBookUrl).pathname} name=${preferred.name || "(no name)"}`);
  return addressBookUrl;
}

function unfoldVCard(text = "") {
  return String(text).replace(/\r?\n[ \t]/g, "");
}

function unescapeVCard(value = "") {
  return String(value)
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function vcardValues(card, property) {
  const lines = unfoldVCard(card).split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!new RegExp(`^${property}(?:;[^:]*)?:`, "i").test(line)) continue;
    const idx = line.indexOf(":");
    if (idx >= 0) out.push(unescapeVCard(line.slice(idx + 1).trim()));
  }
  return out.filter(Boolean);
}

function parseVCard(card, href = null) {
  const fn = vcardValues(card, "FN")[0] || "";
  const n = vcardValues(card, "N")[0] || "";
  const org = vcardValues(card, "ORG")[0] || "";
  const title = vcardValues(card, "TITLE")[0] || "";
  const emails = vcardValues(card, "EMAIL");
  const phones = vcardValues(card, "TEL");
  const displayName = fn || n.split(";").filter(Boolean).reverse().join(" ") || emails[0] || "Без имени";
  return { name: displayName, emails: [...new Set(emails)], phones: [...new Set(phones)], organization: org, title, href };
}

function extractCardData(xml) {
  const cards = [];
  const re = /<(?:[A-Za-z0-9_-]+:)?address-data[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?address-data>/gi;
  let match;
  while ((match = re.exec(String(xml)))) cards.push(decodeXml(match[1]));
  return cards;
}

function extractVcardHrefs(xml, baseUrl) {
  const responses = String(xml).match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi) || [];
  const hrefs = [];
  for (const block of responses) {
    const href = block.match(/<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]+)<\/(?:[A-Za-z0-9_-]+:)?href>/i)?.[1];
    const url = absoluteUrl(baseUrl, href);
    if (url && /\.vcf(?:$|[?#])/i.test(url)) hrefs.push(url);
  }
  return [...new Set(hrefs)];
}

async function loadAllContacts() {
  if (contactCache && Date.now() - contactCacheAt < CACHE_TTL_MS) return contactCache;
  const book = await discoverAddressBook();
  if (!book) throw new Error("Contacts are not configured");

  const propfind = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getcontenttype/></d:prop></d:propfind>`;
  const listing = await cardRequest(book, { depth: "1", body: propfind });
  if (listing.status < 200 || listing.status >= 300) throw new Error(`CardDAV contact listing failed: HTTP ${listing.status}`);
  const hrefs = extractVcardHrefs(listing.text, book);

  const contacts = [];
  const batchSize = 10;
  for (let i = 0; i < hrefs.length; i += batchSize) {
    const batch = hrefs.slice(i, i + batchSize);
    const cards = await Promise.all(batch.map(async url => {
      try {
        const response = await fetch(url, { headers: { Authorization: AUTH } });
        if (!response.ok) return null;
        return { card: await response.text(), href: url };
      } catch { return null; }
    }));
    for (const item of cards) if (item?.card) contacts.push(parseVCard(item.card, item.href));
  }

  contactCache = contacts;
  contactCacheAt = Date.now();
  console.log(`[CONTACTS] cached ${contacts.length} contacts`);
  return contacts;
}

function normalize(value = "") {
  return String(value).toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function scoreContact(contact, query) {
  const q = normalize(query);
  const name = normalize(contact.name);
  const email = normalize(contact.emails.join(" "));
  const org = normalize(contact.organization);
  const hay = `${name} ${email} ${org}`;
  if (!q || !hay.includes(q)) return -1;
  if (name === q) return 100;
  if (name.startsWith(q)) return 90;
  if (name.split(" ").some(part => part.startsWith(q))) return 80;
  if (name.includes(q)) return 70;
  if (email.includes(q)) return 60;
  return 50;
}

async function findContacts(query, maxResults = 10) {
  const contacts = await loadAllContacts();
  return contacts
    .map(contact => ({ contact, score: scoreContact(contact, query) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.contact.name.localeCompare(b.contact.name, "ru"))
    .slice(0, maxResults)
    .map(({ contact }) => contact);
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function patchedConnect(...args) {
  if (!this.__yandexContactsToolAdded) {
    this.__yandexContactsToolAdded = true;
    this.tool(
      "find_yandex_contact",
      "Search the user's Yandex Contacts by partial or full name, email, or organization. Use it before inviting someone when only a person's name is known. Returns likely matches for autocomplete-style selection.",
      {
        query: z.string().min(1).describe("Partial or full contact name, email, or organization"),
        max_results: z.number().int().min(1).max(20).optional().default(10),
      },
      async ({ query, max_results }) => {
        try {
          const contacts = await findContacts(query, max_results);
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, query, count: contacts.length, contacts }, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: error.message }, null, 2) }] };
        }
      }
    );
  }
  return originalConnect.apply(this, args);
};

if (AUTH) {
  discoverAddressBook().catch(error => console.error(`[READY] Contacts: error ${error.message}`));
} else {
  console.log("[READY] Contacts: not_configured");
}
