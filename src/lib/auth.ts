import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "wtl_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function sessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV !== "production") return "local-development-only-session-secret-change-me";
  return null;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isPasswordConfigured(): boolean {
  return Boolean(process.env.APP_ACCESS_PASSWORD);
}

export function verifyAppPassword(candidate: string): boolean {
  const configured = process.env.APP_ACCESS_PASSWORD;
  if (!configured) return process.env.NODE_ENV !== "production";
  return safeEqual(candidate, configured);
}

export function createSessionToken(now = Math.floor(Date.now() / 1000)): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("SESSION_SECRET must contain at least 32 characters in production.");
  const timestamp = String(now);
  const signature = createHmac("sha256", secret).update(timestamp).digest("base64url");
  return `${timestamp}.${signature}`;
}

export function verifySessionToken(token?: string, now = Math.floor(Date.now() / 1000)): boolean {
  if (!token) return false;
  const secret = sessionSecret();
  if (!secret) return false;
  const [timestamp, signature, extra] = token.split(".");
  if (!timestamp || !signature || extra) return false;
  const issuedAt = Number(timestamp);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60 || now - issuedAt > SESSION_TTL_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(timestamp).digest("base64url");
  return safeEqual(signature, expected);
}

export function isAuthenticatedToken(token?: string): boolean {
  if (process.env.NODE_ENV !== "production" && !isPasswordConfigured()) return true;
  return verifySessionToken(token);
}
