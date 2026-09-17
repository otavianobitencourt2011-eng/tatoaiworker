async function importKey(base64Key) {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function fromBase64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export async function encryptToken(plaintext, base64Key) {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  return `${toBase64(iv)}.${toBase64(cipherBuf)}`;
}

export async function decryptToken(stored, base64Key) {
  const key = await importKey(base64Key);
  const [ivB64, cipherB64] = stored.split(".");
  const iv = fromBase64(ivB64);
  const cipherBuf = fromBase64(cipherB64);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBuf);
  return new TextDecoder().decode(plainBuf);
}
