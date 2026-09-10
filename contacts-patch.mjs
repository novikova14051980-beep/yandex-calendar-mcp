import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const EMAIL = process.env.YANDEX_EMAIL;
const PASSWORD = process.env.YANDEX_CARDDAV_APP_PASSWORD;
const CARD_BASE = "https://carddav.yandex.ru/";
const AUTH = EMAIL && PASSWORD
  ? `Basic ${Buffer.from(`${EMAIL}:${PASSWORD}`, "utf8").toString("base64")}`
  : null;

let addressBooks = null;
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

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absoluteUrl(base, href) {
  try { return new URL(decodeXml(String(href || "").trim()), base).toString(); }
  catch { return null; }
}

async function cardRequest(url, { method = "PROPFIND", depth = "0", body = "" } = {}) {
  if (!AUTH) throw new Error("YANDEX_CARDDAV_APP_PASSWORD is not configured");
  const headers = { Authorization: AUTH };
  if (depth != null) headers.Depth = depth;
  if (body) headers["Content-Type"] = "application/xml; charset=utf-8";
  const response = await fetch(url, {
    method,
    headers,
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
    if (url) books.push({ url: url.endsWith("/") ? url : `${url}/`, name: decodeXml(name.trim()) || "(no name)" });
  }
  const seen = new Set();
  return books.filter(book => !seen.has(book.url) && seen.add(book.url));
}

async function discoverAddressBooks() {
  if (addressBooks) return addressBooks;
  if (!AUTH) {
    console.log("[READY] Contacts: not_configured");
    return [];
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

  addressBooks = extractAddressbookCollections(list.text, homeUrl);
  if (!addressBooks.length) throw new Error("No CardDAV address books found");
  console.log(`[READY] Contacts: connected books=${addressBooks.length} names=${addressBooks.map(b => b.name).join(" | ")}`);
  return addressBooks;
}

function unfoldVCard(text = "") {
  return String(text).replace(/\r?\n[ \t]/g, "");
}

function decodeQuotedPrintableUtf8(value = "") {
  try {
    const softJoined = String(value).replace(/=\r?\n/g, "");
    const bytes = [];
    for (let i = 0; i < softJoined.length; i++) {
      if (softJoined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(softJoined.slice(i + 1, i + 3))) {
        bytes.push(parseInt(softJoined.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(...Buffer.from(softJoined[i], "utf8"));
      }
    }
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return String(value);
  }
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
    const match = line.match(new RegExp(`^${property}((?:;[^:]*)?):(.*)$`, "i"));
    if (!match) continue;
    const params = match[1] || "";
    let value = match[2] || "";
    if (/ENCODING=QUOTED-PRINTABLE/i.test(params)) value = decodeQuotedPrintableUtf8(value);
    out.push(unescapeVCard(value.trim()));
  }
  return out.filter(Boolean);
}

function parseVCard(card, href = null, bookName = "") {
  const fn = vcardValues(card, "FN")[0] || "";
  const n = vcardValues(card, "N")[0] || "";
  const org = vcardValues(card, "ORG")[0] || "";
  const title = vcardValues(card, "TITLE")[0] || "";
  const emails = vcardValues(card, "EMAIL");
  const phones = vcardValues(card, "TEL");
  const structured = n.split(";").filter(Boolean).reverse().join(" ");
  const displayName = fn || structured || emails[0] || "Без имени";
  return {
    name: displayName,
    emails: [...new Set(emails)],
    phones: [...new Set(phones)],
    organization: org,
    title,
    address_book: bookName,
    href,
  };
}

function extractCardData(xml) {
  const cards = [];
  const re = /<(?:[A-Za-z0-9_-]+:)?address-data[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?address-data>/gi;
  let match;
  while ((match = re.exec(String(xml)))) cards.push(decodeXml(match[1]));
  return cards;
}

function extractVcardResources(xml, baseUrl) {
  const responses = String(xml).match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi) || [];
  const resources = [];
  for (const block of responses) {
    const href = block.match(/<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]+)<\/(?:[A-Za-z0-9_-]+:)?href>/i)?.[1];
    const url = absoluteUrl(baseUrl, href);
    if (!url) continue;
    const isCollection = /<(?:[A-Za-z0-9_-]+:)?collection\b/i.test(block);
    const isVcard = /text\/vcard/i.test(block) || /\.vcf(?:$|[?#])/i.test(url);
    if (!isCollection && isVcard) resources.push(url);
  }
  return [...new Set(resources)];
}

function normalize(value = "") {
  return String(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}@._+-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contactKey(contact) {
  return (contact.emails[0] || contact.href || `${contact.name}|${contact.phones[0] || ""}`).toLocaleLowerCase("ru-RU");
}

function dedupeContacts(contacts) {
  const seen = new Set();
  const out = [];
  for (const contact of contacts) {
    const key = contactKey(contact);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(contact);
  }
  return out;
}

function scoreContact(contact, query) {
  const q = normalize(query);
  if (!q) return -1;
  const name = normalize(contact.name);
  const email = normalize(contact.emails.join(" "));
  const org = normalize(contact.organization);
  const hay = `${name} ${email} ${org}`.trim();
  const tokens = q.split(" ").filter(Boolean);
  if (!tokens.every(token => hay.includes(token))) return -1;
  if (name === q) return 100;
  if (name.startsWith(q)) return 95;
  if (tokens.every(token => name.split(" ").some(part => part.startsWith(token)))) return 90;
  if (tokens.every(token => name.includes(token))) return 85;
  if (email.includes(q)) return 70;
  return 60;
}

async function searchBookToken(book, token) {
  const term = escapeXml(token);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><card:address-data/></d:prop>
  <card:filter test="anyof">
    <card:prop-filter name="FN"><card:text-match collation="i;unicode-casemap" match-type="contains">${term}</card:text-match></card:prop-filter>
    <card:prop-filter name="N"><card:text-match collation="i;unicode-casemap" match-type="contains">${term}</card:text-match></card:prop-filter>
    <card:prop-filter name="EMAIL"><card:text-match collation="i;unicode-casemap" match-type="contains">${term}</card:text-match></card:prop-filter>
    <card:prop-filter name="ORG"><card:text-match collation="i;unicode-casemap" match-type="contains">${term}</card:text-match></card:prop-filter>
  </card:filter>
</card:addressbook-query>`;
  const response = await cardRequest(book.url, { method: "REPORT", depth: "1", body });
  const cards = response.status >= 200 && response.status < 300 ? extractCardData(response.text) : [];
  console.log(`[CONTACTS] SEARCH book=${book.name} token=${JSON.stringify(token)} HTTP ${response.status} cards=${cards.length}`);
  return {
    status: response.status,
    contacts: cards.map(card => parseVCard(card, null, book.name)),
  };
}

async function searchContactsViaCardDav(query) {
  const books = await discoverAddressBooks();
  const tokens = normalize(query).split(" ").filter(Boolean);
  const candidates = [];
  const diagnostics = [];

  for (const book of books) {
    const bookContacts = [];
    const tokenStatuses = [];
    for (const token of tokens) {
      try {
        const result = await searchBookToken(book, token);
        tokenStatuses.push({ token, status: result.status, cards: result.contacts.length });
        bookContacts.push(...result.contacts);
      } catch (error) {
        tokenStatuses.push({ token, error: error.message });
      }
    }
    const deduped = dedupeContacts(bookContacts);
    diagnostics.push({ book: book.name, token_searches: tokenStatuses, unique_candidates: deduped.length });
    candidates.push(...deduped);
  }

  return { candidates: dedupeContacts(candidates), diagnostics };
}

async function loadBookViaReport(book) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><card:address-data/></d:prop>
  <card:filter test="anyof"><card:prop-filter name="FN"/></card:filter>
</card:addressbook-query>`;
  const response = await cardRequest(book.url, { method: "REPORT", depth: "1", body });
  const cards = response.status >= 200 && response.status < 300 ? extractCardData(response.text) : [];
  console.log(`[CONTACTS] REPORT book=${book.name} HTTP ${response.status} cards=${cards.length}`);
  return cards.map(card => parseVCard(card, null, book.name));
}

async function loadBookViaPropfind(book) {
  const propfind = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getcontenttype/><d:resourcetype/></d:prop></d:propfind>`;
  const listing = await cardRequest(book.url, { depth: "1", body: propfind });
  if (listing.status < 200 || listing.status >= 300) throw new Error(`CardDAV contact listing failed for ${book.name}: HTTP ${listing.status}`);
  const hrefs = extractVcardResources(listing.text, book.url);
  console.log(`[CONTACTS] PROPFIND book=${book.name} resources=${hrefs.length}`);

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
    for (const item of cards) if (item?.card) contacts.push(parseVCard(item.card, item.href, book.name));
  }
  return contacts;
}

async function loadAllContacts() {
  if (contactCache && Date.now() - contactCacheAt < CACHE_TTL_MS) return contactCache;
  const books = await discoverAddressBooks();
  if (!books.length) throw new Error("Contacts are not configured");

  const contacts = [];
  for (const book of books) {
    let loaded = [];
    try { loaded = await loadBookViaReport(book); } catch (error) {
      console.warn(`[CONTACTS] REPORT failed for ${book.name}: ${error.message}`);
    }
    if (!loaded.length) {
      try { loaded = await loadBookViaPropfind(book); } catch (error) {
        console.warn(`[CONTACTS] PROPFIND failed for ${book.name}: ${error.message}`);
      }
    }
    contacts.push(...loaded);
  }

  contactCache = dedupeContacts(contacts);
  contactCacheAt = Date.now();
  console.log(`[CONTACTS] cached ${contactCache.length} contacts across ${books.length} address book(s)`);
  return contactCache;
}

function rankContacts(contacts, query, maxResults) {
  return contacts
    .map(contact => ({ contact, score: scoreContact(contact, query) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.contact.name.localeCompare(b.contact.name, "ru"))
    .slice(0, maxResults)
    .map(({ contact }) => contact);
}

async function findContacts(query, maxResults = 10) {
  const direct = await searchContactsViaCardDav(query);
  let contacts = rankContacts(direct.candidates, query, maxResults);
  let fallbackUsed = false;

  if (!contacts.length) {
    fallbackUsed = true;
    const all = await loadAllContacts();
    contacts = rankContacts(all, query, maxResults);
  }

  return {
    contacts,
    diagnostics: {
      books: (await discoverAddressBooks()).map(book => book.name),
      direct_search: direct.diagnostics,
      fallback_used: fallbackUsed,
      cache_size: contactCache?.length ?? null,
    },
  };
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function patchedConnect(...args) {
  if (!this.__yandexContactsToolAdded) {
    this.__yandexContactsToolAdded = true;
    this.tool(
      "find_yandex_contact",
      "Search the user's Yandex Contacts by partial or full name, email, or organization. Search both personal and shared/common CardDAV address books and return likely matches for autocomplete-style selection.",
      {
        query: z.string().min(1).describe("Partial or full contact name, email, or organization"),
        max_results: z.number().int().min(1).max(20).optional().default(10),
      },
      async ({ query, max_results }) => {
        try {
          const result = await findContacts(query, max_results);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                query,
                count: result.contacts.length,
                contacts: result.contacts,
                diagnostics: result.diagnostics,
              }, null, 2),
            }],
          };
        } catch (error) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: error.message }, null, 2) }] };
        }
      }
    );
  }
  return originalConnect.apply(this, args);
};

if (AUTH) {
  discoverAddressBooks().catch(error => console.error(`[READY] Contacts: error ${error.message}`));
} else {
  console.log("[READY] Contacts: not_configured");
}
