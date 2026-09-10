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
let lastDiagnostics = null;
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

function responseBlocks(xml) {
  return String(xml).match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi) || [];
}

function extractAddressbookCollections(xml, baseUrl) {
  const books = [];
  for (const block of responseBlocks(xml)) {
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

function parseVCard(card, href = null, bookName = "", etag = null) {
  const fn = vcardValues(card, "FN")[0] || "";
  const n = vcardValues(card, "N")[0] || "";
  const org = vcardValues(card, "ORG")[0] || "";
  const title = vcardValues(card, "TITLE")[0] || "";
  const emails = vcardValues(card, "EMAIL").map(v => v.replace(/^mailto:/i, ""));
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
    etag,
  };
}

function extractBookResources(xml, bookUrl) {
  const normalizedBook = bookUrl.endsWith("/") ? bookUrl : `${bookUrl}/`;
  const resources = [];
  for (const block of responseBlocks(xml)) {
    const hrefRaw = block.match(/<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]+)<\/(?:[A-Za-z0-9_-]+:)?href>/i)?.[1];
    const url = absoluteUrl(bookUrl, hrefRaw);
    if (!url) continue;
    const normalized = url.endsWith("/") ? url : url;
    if (normalized === normalizedBook || normalized === normalizedBook.slice(0, -1)) continue;
    if (/<(?:[A-Za-z0-9_-]+:)?collection\b/i.test(block)) continue;
    const etagRaw = block.match(/<(?:[A-Za-z0-9_-]+:)?getetag[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?getetag>/i)?.[1] || null;
    const contentType = block.match(/<(?:[A-Za-z0-9_-]+:)?getcontenttype[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?getcontenttype>/i)?.[1] || "";
    const etag = etagRaw ? decodeXml(etagRaw.trim()) : null;
    const likelyCard = /text\/vcard/i.test(contentType) || /\.vcf(?:$|[?#])/i.test(url) || Boolean(etag);
    if (likelyCard) resources.push({ url, etag });
  }
  const seen = new Set();
  return resources.filter(item => !seen.has(item.url) && seen.add(item.url));
}

async function listBookResources(book) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:getetag/><d:getcontenttype/><d:resourcetype/></d:prop>
</d:propfind>`;
  const response = await cardRequest(book.url, { method: "PROPFIND", depth: "1", body });
  const resources = response.status >= 200 && response.status < 300
    ? extractBookResources(response.text, book.url)
    : [];
  console.log(`[CONTACTS] PROPFIND book=${book.name} HTTP ${response.status} resources=${resources.length}`);
  return { status: response.status, resources };
}

function extractMultigetCards(xml, book) {
  const out = [];
  for (const block of responseBlocks(xml)) {
    const hrefRaw = block.match(/<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]+)<\/(?:[A-Za-z0-9_-]+:)?href>/i)?.[1];
    const cardRaw = block.match(/<(?:[A-Za-z0-9_-]+:)?address-data[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?address-data>/i)?.[1];
    if (!cardRaw) continue;
    const etagRaw = block.match(/<(?:[A-Za-z0-9_-]+:)?getetag[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?getetag>/i)?.[1] || null;
    const href = absoluteUrl(book.url, hrefRaw);
    out.push(parseVCard(decodeXml(cardRaw), href, book.name, etagRaw ? decodeXml(etagRaw.trim()) : null));
  }
  return out;
}

async function multigetBook(book, resources) {
  const contacts = [];
  const batchSize = 50;
  let lastStatus = null;
  for (let i = 0; i < resources.length; i += batchSize) {
    const batch = resources.slice(i, i + batchSize);
    const hrefs = batch.map(item => {
      const u = new URL(item.url);
      return `<d:href>${escapeXml(`${u.pathname}${u.search}`)}</d:href>`;
    }).join("\n");
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><card:address-data/></d:prop>
  ${hrefs}
</card:addressbook-multiget>`;
    const response = await cardRequest(book.url, { method: "REPORT", depth: "0", body });
    lastStatus = response.status;
    if (response.status < 200 || response.status >= 300) {
      console.warn(`[CONTACTS] MULTIGET book=${book.name} HTTP ${response.status}`);
      return { status: response.status, contacts: [] };
    }
    contacts.push(...extractMultigetCards(response.text, book));
  }
  console.log(`[CONTACTS] MULTIGET book=${book.name} HTTP ${lastStatus ?? 0} cards=${contacts.length}`);
  return { status: lastStatus, contacts };
}

async function getBookResources(book, resources) {
  const contacts = [];
  let forbidden = 0;
  let failed = 0;
  const batchSize = 10;
  for (let i = 0; i < resources.length; i += batchSize) {
    const batch = resources.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async resource => {
      try {
        const response = await fetch(resource.url, { headers: { Authorization: AUTH }, redirect: "follow" });
        if (response.status === 403) forbidden += 1;
        if (!response.ok) {
          failed += 1;
          return null;
        }
        return parseVCard(await response.text(), resource.url, book.name, resource.etag);
      } catch {
        failed += 1;
        return null;
      }
    }));
    for (const contact of results) if (contact) contacts.push(contact);
  }
  console.log(`[CONTACTS] GET book=${book.name} cards=${contacts.length} forbidden=${forbidden} failed=${failed}`);
  return { contacts, forbidden, failed };
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

async function loadBook(book) {
  const listed = await listBookResources(book);
  const diagnostic = {
    book: book.name,
    propfind_status: listed.status,
    resources: listed.resources.length,
    multiget_status: null,
    multiget_cards: 0,
    get_cards: 0,
    get_forbidden: 0,
    get_failed: 0,
  };
  if (listed.status < 200 || listed.status >= 300) return { contacts: [], diagnostic };
  if (!listed.resources.length) return { contacts: [], diagnostic };

  try {
    const multi = await multigetBook(book, listed.resources);
    diagnostic.multiget_status = multi.status;
    diagnostic.multiget_cards = multi.contacts.length;
    if (multi.contacts.length) return { contacts: multi.contacts, diagnostic };
  } catch (error) {
    diagnostic.multiget_error = error.message;
  }

  const got = await getBookResources(book, listed.resources);
  diagnostic.get_cards = got.contacts.length;
  diagnostic.get_forbidden = got.forbidden;
  diagnostic.get_failed = got.failed;
  return { contacts: got.contacts, diagnostic };
}

async function loadAllContacts({ force = false } = {}) {
  if (!force && contactCache && Date.now() - contactCacheAt < CACHE_TTL_MS) {
    return { contacts: contactCache, diagnostics: lastDiagnostics, cached: true };
  }

  const books = await discoverAddressBooks();
  if (!books.length) throw new Error("Contacts are not configured");

  const contacts = [];
  const bookDiagnostics = [];
  for (const book of books) {
    try {
      const loaded = await loadBook(book);
      contacts.push(...loaded.contacts);
      bookDiagnostics.push(loaded.diagnostic);
    } catch (error) {
      bookDiagnostics.push({ book: book.name, error: error.message });
    }
  }

  contactCache = dedupeContacts(contacts);
  contactCacheAt = Date.now();
  lastDiagnostics = {
    books: bookDiagnostics,
    total_contacts: contactCache.length,
    built_at: new Date(contactCacheAt).toISOString(),
  };
  console.log(`[CONTACTS] cached ${contactCache.length} contacts across ${books.length} address book(s)`);
  return { contacts: contactCache, diagnostics: lastDiagnostics, cached: false };
}

function normalize(value = "") {
  return String(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}@._+-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RU_TO_LAT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
  ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ы: "y", э: "e", ю: "yu", я: "ya",
  ь: "", ъ: "",
};

function translit(value = "") {
  return normalize(value).split("").map(ch => RU_TO_LAT[ch] ?? ch).join("");
}

function variants(value = "") {
  const n = normalize(value);
  const t = translit(value);
  return [...new Set([n, t].filter(Boolean))];
}

function tokenMatch(hayVariants, tokenVariants) {
  return tokenVariants.some(token => hayVariants.some(hay => hay.includes(token)));
}

function scoreContact(contact, query) {
  const queryTokens = normalize(query).split(" ").filter(Boolean);
  if (!queryTokens.length) return -1;

  const nameVariants = variants(contact.name);
  const emailVariants = variants(contact.emails.join(" "));
  const orgVariants = variants(contact.organization);
  const allVariants = [...nameVariants, ...emailVariants, ...orgVariants];
  const queryTokenVariants = queryTokens.map(token => variants(token));

  if (!queryTokenVariants.every(tv => tokenMatch(allVariants, tv))) return -1;

  const qVariants = variants(query);
  if (qVariants.some(q => nameVariants.includes(q))) return 100;
  if (qVariants.some(q => nameVariants.some(name => name.startsWith(q)))) return 95;

  const nameWords = nameVariants.flatMap(name => name.split(" ").filter(Boolean));
  if (queryTokenVariants.every(tv => tv.some(token => nameWords.some(word => word.startsWith(token))))) return 90;
  if (queryTokenVariants.every(tv => tokenMatch(nameVariants, tv))) return 85;
  if (queryTokenVariants.every(tv => tokenMatch(emailVariants, tv))) return 75;
  return 60;
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
  let loaded = await loadAllContacts();
  let contacts = rankContacts(loaded.contacts, query, maxResults);

  if (!contacts.length && loaded.cached) {
    loaded = await loadAllContacts({ force: true });
    contacts = rankContacts(loaded.contacts, query, maxResults);
  }

  return {
    contacts,
    diagnostics: {
      ...loaded.diagnostics,
      cache_used: loaded.cached,
      search_mode: "local_carddav_index",
      mail_history_included: false,
    },
  };
}

const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function patchedConnect(...args) {
  if (!this.__yandexContactsToolAdded) {
    this.__yandexContactsToolAdded = true;
    this.tool(
      "find_yandex_contact",
      "Search Yandex Contacts by partial or full name, email, or organization. Uses a local index built from accessible Personal and Shared CardDAV address books and supports Cyrillic/Latin transliteration.",
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
