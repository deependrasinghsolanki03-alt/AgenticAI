// ─── Groq API Key Rotator (Round-Robin) ─────────
let keys: string[] = [];
let currentIndex = 0;

export function initKeyRotator(): void {
  const raw = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "";
  keys = raw.split(",").map(k => k.trim()).filter(k => k.length > 0);
  if (keys.length === 0) {
    throw new Error("No Groq API keys found! Set GROQ_API_KEYS=key1,key2,key3 in .env");
  }
  console.log(`[KeyRotator] Loaded ${keys.length} API key(s) for round-robin rotation.`);
}

export function getNextKey(): string {
  if (keys.length === 0) initKeyRotator();
  const key = keys[currentIndex % keys.length];
  const keyIndex = currentIndex % keys.length;
  currentIndex++;
  console.log(`[KeyRotator] Using key #${keyIndex + 1}/${keys.length}`);
  return key;
}

export function getKeyCount(): number {
  return keys.length;
}
