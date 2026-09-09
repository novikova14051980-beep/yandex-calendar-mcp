const nativeFetch = globalThis.fetch.bind(globalThis);

const YANDEX_EMAIL = process.env.YANDEX_EMAIL;
const YANDEX_CLIENT_ID = process.env.YANDEX_CLIENT_ID;
const YANDEX_CLIENT_SECRET = process.env.YANDEX_CLIENT_SECRET;
const STATIC_TOKEN = process.env.YANDEX_OAUTH_TOKEN;

let currentToken = STATIC_TOKEN || null;
let tokenExpiresAt = 0;
let refreshTimer = null;
let serviceModeReady = false;

function isYandexApi(url) {
  try {
    const host = new URL(String(url)).hostname;
    return host === "caldav.yandex.ru" || host === "cloud-api.yandex.net" || host === "api360.yandex.net";
  } catch {
    return false;
  }
}

async function exchangeServiceToken() {
  if (!YANDEX_EMAIL || !YANDEX_CLIENT_ID || !YANDEX_CLIENT_SECRET) {
    throw new Error("YANDEX_EMAIL, YANDEX_CLIENT_ID and YANDEX_CLIENT_SECRET are required for automatic token exchange");
  }

  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: YANDEX_CLIENT_ID,
    client_secret: YANDEX_CLIENT_SECRET,
    subject_token: YANDEX_EMAIL,
    subject_token_type: "urn:yandex:params:oauth:token-type:email",
  });

  const response = await nativeFetch("https://oauth.yandex.ru/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!response.ok || !data.access_token) {
    const reason = data.error_description || data.error || data.raw || `HTTP ${response.status}`;
    throw new Error(`Yandex service-token exchange failed: ${reason}`);
  }

  currentToken = data.access_token;
  const expiresIn = Number(data.expires_in || 3600);
  tokenExpiresAt = Date.now() + expiresIn * 1000;
  serviceModeReady = true;

  const refreshInMs = Math.max(60_000, (expiresIn - 300) * 1000);
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      await exchangeServiceToken();
      console.log("[AUTH] Yandex service token refreshed automatically");
    } catch (error) {
      console.error("[AUTH] Automatic token refresh failed:", error.message);
      refreshTimer = setTimeout(() => exchangeServiceToken().catch(err => console.error("[AUTH] Retry failed:", err.message)), 60_000);
    }
  }, refreshInMs);

  console.log(`[AUTH] Yandex service token obtained; expires in ${expiresIn}s`);
  return currentToken;
}

async function ensureToken() {
  if (serviceModeReady && currentToken && Date.now() < tokenExpiresAt - 60_000) return currentToken;

  if (YANDEX_CLIENT_ID && YANDEX_CLIENT_SECRET && YANDEX_EMAIL) {
    try {
      return await exchangeServiceToken();
    } catch (error) {
      console.error("[AUTH] Service-token mode is not ready:", error.message);
      console.error("[AUTH] This usually means the OAuth app has not been registered as a Yandex 360 service application by the organization owner/admin.");
    }
  }

  if (STATIC_TOKEN) {
    console.warn("[AUTH] Falling back to static YANDEX_OAUTH_TOKEN. Restricted Yandex OAuth tokens can expire; this mode is not reliable for an always-on connector.");
    currentToken = STATIC_TOKEN;
    return currentToken;
  }

  throw new Error("No usable Yandex token is configured");
}

await ensureToken();

globalThis.fetch = async (input, init = {}) => {
  if (!isYandexApi(input)) return nativeFetch(input, init);

  const token = await ensureToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `OAuth ${token}`);
  return nativeFetch(input, { ...init, headers });
};

await import("./server.mjs");
