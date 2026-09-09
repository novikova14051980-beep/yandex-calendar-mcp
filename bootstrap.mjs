const nativeFetch = globalThis.fetch.bind(globalThis);

const YANDEX_EMAIL = process.env.YANDEX_EMAIL;
const YANDEX_CLIENT_ID = process.env.YANDEX_CLIENT_ID;
const STATIC_TOKEN = process.env.YANDEX_OAUTH_TOKEN;

if (!YANDEX_EMAIL || !STATIC_TOKEN) {
  console.error("[AUTH] Missing YANDEX_EMAIL or YANDEX_OAUTH_TOKEN");
  process.exit(1);
}

function hostOf(input) {
  try { return new URL(String(input)).hostname; } catch { return ""; }
}

function basicCalDavAuth() {
  const encoded = Buffer.from(`${YANDEX_EMAIL}:${STATIC_TOKEN}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

async function diagnoseUserToken() {
  try {
    const response = await nativeFetch("https://login.yandex.ru/info?format=json", {
      headers: { Authorization: `OAuth ${STATIC_TOKEN}` },
    });
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (response.ok) {
      const clientMatch = !YANDEX_CLIENT_ID || data.client_id === YANDEX_CLIENT_ID;
      console.log(`[AUTH] User OAuth token valid: login=${data.login || "unknown"}, client_id_match=${clientMatch}`);
    } else {
      console.error(`[AUTH] User OAuth token invalid at Yandex ID: HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`[AUTH] Yandex ID token diagnostic failed: ${error.message}`);
  }

  try {
    const url = `https://caldav.yandex.ru/calendars/${encodeURIComponent(YANDEX_EMAIL)}/events-default/`;
    const response = await nativeFetch(url, {
      method: "PROPFIND",
      headers: {
        Authorization: basicCalDavAuth(),
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
    });
    console.log(`[AUTH] CalDAV user-token check: HTTP ${response.status}`);
  } catch (error) {
    console.error(`[AUTH] CalDAV diagnostic failed: ${error.message}`);
  }
}

await diagnoseUserToken();

// This connector is for the signed-in user's own Yandex account. It does NOT
// use Yandex 360 service-application token exchange, which requires an
// organization owner/admin. CalDAV authenticates like a normal CalDAV client:
// username = corporate Yandex email, password = the user's OAuth token.
// Telemost and other HTTP APIs continue to use the OAuth Authorization header.
globalThis.fetch = async (input, init = {}) => {
  const host = hostOf(input);
  if (host !== "caldav.yandex.ru" && host !== "cloud-api.yandex.net" && host !== "api360.yandex.net") {
    return nativeFetch(input, init);
  }

  const headers = new Headers(init.headers || {});
  if (host === "caldav.yandex.ru") {
    headers.set("Authorization", basicCalDavAuth());
  } else {
    headers.set("Authorization", `OAuth ${STATIC_TOKEN}`);
  }
  return nativeFetch(input, { ...init, headers });
};

await import("./server.mjs");
