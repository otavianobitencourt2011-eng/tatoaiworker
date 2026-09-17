let jwksCache = { keys: null, expiresAt: 0 };
let jwksFetchPromise = null;
const firebaseCryptoKeyCache = new Map();

const b64urlToBytes = (b64url) => {
  const b64 = (b64url + "=".repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const b64urlToJson = (b64url) => JSON.parse(new TextDecoder().decode(b64urlToBytes(b64url)));

async function getFirebaseJwks() {
  const now = Date.now();
  if (jwksCache.keys && now < jwksCache.expiresAt) return jwksCache.keys;
  if (jwksFetchPromise) return jwksFetchPromise;

  jwksFetchPromise = (async () => {
    const requestStartedAt = Date.now();
    const res = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
    if (!res.ok) throw new Error("Falha ao obter chaves públicas do Firebase.");
    const data = await res.json();
    const maxAgeMatch = (res.headers.get("cache-control") || "").match(/max-age=(\d+)/);
    const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 3600000;
    jwksCache = { keys: data.keys, expiresAt: requestStartedAt + maxAgeMs };
    firebaseCryptoKeyCache.clear();
    return data.keys;
  })();

  try {
    return await jwksFetchPromise;
  } finally {
    jwksFetchPromise = null;
  }
}

export async function verifyFirebaseIdToken(idToken, projectId) {
  if (!idToken) throw new Error("Token ausente.");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Token mal formado.");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = b64urlToJson(headerB64);
  const payload = b64urlToJson(payloadB64);
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp && now >= payload.exp) throw new Error("Token expirado.");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Issuer inválido.");
  if (payload.aud !== projectId) throw new Error("Audience inválido.");
  if (!payload.sub) throw new Error("Token sem uid.");
  if (header.alg !== "RS256") throw new Error("Algoritmo inválido.");

  const keys = await getFirebaseJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Chave pública não encontrada para este token.");

  const cached = firebaseCryptoKeyCache.get(header.kid);
  let key = cached?.key;
  if (!key || Date.now() >= (cached?.expiresAt || 0)) {
    key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    firebaseCryptoKeyCache.set(header.kid, { key, expiresAt: jwksCache.expiresAt });
  }

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key,
    b64urlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error("Assinatura inválida.");

  return payload;
}
