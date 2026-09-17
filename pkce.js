function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return base64url(bytes);
}

export async function pkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(verifierBytes);
  const challengeBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(challengeBuf);
  return { verifier, challenge };
}
