const nativeFetch = globalThis.fetch.bind(globalThis);

const YANDEX_EMAIL = process.env.YANDEX_EMAIL;
const YANDEX_CLIENT_ID = process.env.YANDEX_CLIENT_ID;
const STATIC_TOKEN = process.env.YANDEX_OAUTH_TOKEN;

if (!YANDEX_EMAIL || !STATIC_TOKEN) {
  console.error("[AUTH] Missing YANDEX_EMAIL or YANDEX_OAUTH_TOKEN");
  process.exit(1);
}

const AUTH = `OAuth ${STATIC_TOKEN}`;
const HARDCODED_COLLECTION = `https://caldav.yandex.ru/calendars/${encodeURIComponent(YANDEX_EMAIL)}/events-default/`;
let discoveredCollection = null;
let discoveryAttempted = false;

function hostOf(input) {
  try { return new URL(String(input)).hostname; } catch { return ""; }
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function firstHref(xml, propertyName) {
  const re = new RegExp(`<[^>]*${propertyName}[^>]*>[\\s\\S]*?<[^>]*href[^>]*>([^<]+)<\\/[^>]*href>`, "i");
  const m = String(xml).match(re);
  return m ? decodeXml(m[1].trim()) : null;
}

function absolutize(base, href) {
  if (!href) return null;
  try { return new URL(href, base).toString(); } catch { return null; }
}

async function davRequest(url, { method = "PROPFIND", depth = "0", body = "" } = {}) {
  const response = await nativeFetch(url, {
    method,
    headers: {
      Authorization: AUTH,
      Depth: depth,
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: body || undefined,
    redirect: "manual",
  });
  const text = await response.text();
  const location = response.headers.get("location");
  return { status: response.status, text, location };
}

function extractCalendarResponses(xml, baseUrl) {
  const blocks = String(xml).match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi) || [];
  const out = [];
  for (const block of blocks) {
    const hrefMatch = block.match(/<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]+)<\/(?:[A-Za-z0-9_-]+:)?href>/i);
    if (!hrefMatch) continue;
    const isCalendar = /<(?:[A-Za-z0-9_-]+:)?calendar\b/i.test(block);
    if (!isCalendar) continue;
    const displayMatch = block.match(/<(?:[A-Za-z0-9_-]+:)?displayname[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?displayname>/i);
    const componentMatch = block.match(/<(?:[A-Za-z0-9_-]+:)?comp[^>]*name=["']VEVENT["']/i);
    out.push({
      url: absolutize(baseUrl, decodeXml(hrefMatch[1].trim())),
      displayName: displayMatch ? decodeXml(displayMatch[1].trim()) : "",
      supportsEvents: Boolean(componentMatch),
    });
  }
  return out.filter(x => x.url);
}

async function discoverCalendarCollection() {
  if (discoveryAttempted) return discoveredCollection;
  discoveryAttempted = true;

  try {
    const idResp = await nativeFetch("https://login.yandex.ru/info?format=json", {
      headers: { Authorization: AUTH },
    });
    const idText = await idResp.text();
    let idData = {};
    try { idData = JSON.parse(idText); } catch {}
    if (idResp.ok) {
      const clientMatch = !YANDEX_CLIENT_ID || idData.client_id === YANDEX_CLIENT_ID;
      console.log(`[AUTH] User OAuth token valid: login=${idData.login || "unknown"}, client_id_match=${clientMatch}`);
    } else {
      console.error(`[AUTH] User OAuth token invalid at Yandex ID: HTTP ${idResp.status}`);
      return null;
    }

    const principalBody = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
    let root = await davRequest("https://caldav.yandex.ru/", { depth: "0", body: principalBody });
    console.log(`[DAV] root current-user-principal: HTTP ${root.status}`);

    if ([301, 302, 307, 308].includes(root.status) && root.location) {
      const redirected = absolutize("https://caldav.yandex.ru/", root.location);
      console.log(`[DAV] root redirect -> ${redirected}`);
      root = await davRequest(redirected, { depth: "0", body: principalBody });
      console.log(`[DAV] redirected current-user-principal: HTTP ${root.status}`);
    }

    let principalUrl = null;
    if (root.status >= 200 && root.status < 300) {
      principalUrl = absolutize("https://caldav.yandex.ru/", firstHref(root.text, "current-user-principal"));
    }

    if (!principalUrl) {
      const candidates = [
        `https://caldav.yandex.ru/principals/users/${encodeURIComponent(YANDEX_EMAIL)}/`,
        `https://caldav.yandex.ru/principals/${encodeURIComponent(YANDEX_EMAIL)}/`,
        `https://caldav.yandex.ru/calendars/${encodeURIComponent(YANDEX_EMAIL)}/`,
      ];
      for (const candidate of candidates) {
        const probe = await davRequest(candidate, { depth: "0", body: principalBody });
        console.log(`[DAV] candidate ${new URL(candidate).pathname}: HTTP ${probe.status}`);
        if (probe.status >= 200 && probe.status < 300) {
          principalUrl = candidate;
          break;
        }
      }
    }

    if (!principalUrl) {
      console.error("[DAV] Could not discover or probe a usable principal URL");
      return null;
    }
    console.log(`[DAV] principal selected: ${new URL(principalUrl).pathname}`);

    const homeBody = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;
    const homeResp = await davRequest(principalUrl, { depth: "0", body: homeBody });
    console.log(`[DAV] calendar-home-set: HTTP ${homeResp.status}`);
    let homeUrl = homeResp.status >= 200 && homeResp.status < 300
      ? absolutize(principalUrl, firstHref(homeResp.text, "calendar-home-set"))
      : null;

    if (!homeUrl && /\/calendars\//.test(principalUrl)) {
      homeUrl = principalUrl.endsWith("/") ? principalUrl : `${principalUrl}/`;
    }
    if (!homeUrl) {
      console.error("[DAV] No calendar-home-set returned");
      return null;
    }
    console.log(`[DAV] calendar home: ${new URL(homeUrl).pathname}`);

    const listBody = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;
    const listResp = await davRequest(homeUrl, { depth: "1", body: listBody });
    console.log(`[DAV] calendar collection listing: HTTP ${listResp.status}`);
    if (!(listResp.status >= 200 && listResp.status < 300)) return null;

    const calendars = extractCalendarResponses(listResp.text, homeUrl);
    console.log(`[DAV] discovered calendar collections: ${calendars.length}`);
    if (!calendars.length) return null;

    const preferred = calendars.find(c => c.supportsEvents && /default|основ|main|собы/i.test(c.displayName))
      || calendars.find(c => c.supportsEvents)
      || calendars[0];
    discoveredCollection = preferred.url.endsWith("/") ? preferred.url : `${preferred.url}/`;
    console.log(`[DAV] using calendar collection: ${new URL(discoveredCollection).pathname} name=${preferred.displayName || "(no name)"}`);
    return discoveredCollection;
  } catch (error) {
    console.error(`[DAV] discovery failed: ${error.message}`);
    return null;
  }
}

await discoverCalendarCollection();

globalThis.fetch = async (input, init = {}) => {
  let url = String(input);
  const host = hostOf(url);
  if (host !== "caldav.yandex.ru" && host !== "cloud-api.yandex.net" && host !== "api360.yandex.net") {
    return nativeFetch(input, init);
  }

  if (host === "caldav.yandex.ru" && url.startsWith(HARDCODED_COLLECTION)) {
    const collection = discoveredCollection || await discoverCalendarCollection();
    if (collection) {
      const suffix = url.slice(HARDCODED_COLLECTION.length);
      url = new URL(suffix, collection).toString();
    }
  }

  const headers = new Headers(init.headers || {});
  headers.set("Authorization", AUTH);
  return nativeFetch(url, { ...init, headers });
};

await import("./server.mjs");
