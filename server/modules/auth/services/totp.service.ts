import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30-second steps, 6 digits) and one-time backup
 * codes, on `node:crypto` only. These are the parameters every authenticator
 * app (Google Authenticator, 1Password, Aegis…) uses by default.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Codes from one step before or after are accepted to absorb clock drift. */
const DRIFT_STEPS = 1;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// No 0/O, 1/I/L: backup codes get typed from paper.
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error('Invalid base32 secret');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** A fresh 160-bit secret in base32, as authenticator apps expect. Used by the auth security service. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * `otpauth://` URI for the QR code. The label reads «Mirage · alice» in the
 * app, like the DarkLogin mock-up. Used by the auth security service.
 */
export function buildOtpauthUri(secret: string, accountName: string, issuer = 'Mirage'): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Checks a 6-digit code against the secret at `nowMs`. Returns the matched
 * time step (for replay protection: the caller stores it and refuses steps not
 * newer than the last one) or null. Every candidate step is compared in
 * constant time and none short-circuits. Used by the auth security service.
 */
export function verifyTotpCode(secret: string, code: string, nowMs: number): number | null {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) {
    return null;
  }
  const key = base32Decode(secret);
  const currentStep = Math.floor(nowMs / 1000 / STEP_SECONDS);
  let matched: number | null = null;
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift += 1) {
    const step = currentStep + drift;
    if (constantTimeEquals(hotp(key, step), normalized) && matched === null) {
      matched = step;
    }
  }
  return matched;
}

/** Code for a step; exported for tests that need a valid code. */
export function generateTotpCode(secret: string, nowMs: number): string {
  return hotp(base32Decode(secret), Math.floor(nowMs / 1000 / STEP_SECONDS));
}

/** Ten one-time codes shaped `7F3K-Q9PD` (≈40 bits each). Used by the auth security service. */
export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(8);
    const chars = Array.from(bytes, (byte) => BACKUP_ALPHABET[byte % BACKUP_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}

/**
 * SHA-256 of a backup code after normalising case, spaces and dashes. Codes
 * are random, so a fast hash is enough; only hashes are stored. Used by the
 * auth security service.
 */
export function hashBackupCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().replace(/[\s-]/g, '')).digest('hex');
}

/** Index of the matching stored hash (constant time over the list) or -1. Used by the auth security service. */
export function findBackupCodeIndex(storedHashes: string[], code: string): number {
  const candidate = hashBackupCode(code);
  let found = -1;
  storedHashes.forEach((hash, index) => {
    if (constantTimeEquals(hash, candidate) && found < 0) {
      found = index;
    }
  });
  return found;
}
