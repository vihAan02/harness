function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return toHex(bytes.buffer);
}

export function newSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSecret(secret: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
}

export async function secretMatches(secret: string, expectedHash: string): Promise<boolean> {
  const actual = new TextEncoder().encode(await hashSecret(secret));
  const expected = new TextEncoder().encode(expectedHash);
  if (actual.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(actual, expected);
}
