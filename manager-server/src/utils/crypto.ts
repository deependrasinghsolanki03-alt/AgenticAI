// ─── Token Encryption Utility ─────────────────────
// AES-256-GCM encryption for sensitive tokens (Google refresh tokens)
// Key from env: TOKEN_ENCRYPTION_KEY (32-byte hex = 64 hex chars)

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits auth tag

function getKey(): Buffer {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    console.warn("[Crypto] TOKEN_ENCRYPTION_KEY not set or invalid (need 64 hex chars). Tokens will be stored in plain text.");
    return Buffer.alloc(0);
  }
  return Buffer.from(keyHex, "hex");
}

/**
 * Encrypt a plaintext string → base64 encoded "iv:encrypted:tag"
 * Returns original string if encryption key not configured
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  if (key.length === 0) return plaintext; // no encryption key

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();

  // Format: iv:encrypted:tag (all hex)
  return `enc:${iv.toString("hex")}:${encrypted}:${tag.toString("hex")}`;
}

/**
 * Decrypt an encrypted string → original plaintext
 * Handles backward compatibility: if string doesn't start with "enc:", assume plain text
 */
export function decrypt(ciphertext: string): string {
  // Backward compatible: plain text tokens (before encryption was added)
  if (!ciphertext.startsWith("enc:")) {
    return ciphertext;
  }

  const key = getKey();
  if (key.length === 0) {
    console.warn("[Crypto] Cannot decrypt — TOKEN_ENCRYPTION_KEY not set.");
    return ciphertext; // return as-is
  }

  try {
    const parts = ciphertext.slice(4).split(":"); // remove "enc:" prefix
    if (parts.length !== 3) throw new Error("Invalid encrypted format");

    const iv = Buffer.from(parts[0], "hex");
    const encrypted = parts[1];
    const tag = Buffer.from(parts[2], "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err: any) {
    console.error("[Crypto] Decryption failed:", err.message);
    // Return as-is if decryption fails (might be old plain text)
    return ciphertext;
  }
}
