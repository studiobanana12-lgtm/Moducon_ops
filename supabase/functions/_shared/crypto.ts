// AES-256-GCM encryption/decryption using Web Crypto API (zero external dependencies)
// Secret key is read from TOKEN_ENCRYPTION_KEY (any high-entropy string; SHA-256 derived to 256-bit key).

async function deriveKey(secret: string): Promise<CryptoKey> {
  const encoded = new TextEncoder().encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function encryptToken(plaintext: string): Promise<string> {
  const secret = Deno.env.get("TOKEN_ENCRYPTION_KEY");
  if (!secret || secret.length < 16) {
    throw new Error("TOKEN_ENCRYPTION_KEY secret is not configured (min 16 chars).");
  }
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return `v1:${toBase64(iv)}:${toBase64(cipher)}`;
}

export async function decryptToken(stored: string): Promise<string> {
  const secret = Deno.env.get("TOKEN_ENCRYPTION_KEY");
  if (!secret || secret.length < 16) {
    throw new Error("TOKEN_ENCRYPTION_KEY secret is not configured.");
  }
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted token format.");
  }
  const key = await deriveKey(secret);
  const iv = fromBase64(parts[1]);
  const cipher = fromBase64(parts[2]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}
