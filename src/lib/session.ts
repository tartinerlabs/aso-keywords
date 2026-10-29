import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function sign(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

/**
 * The session cookie value: an HMAC keyed by APP_PASSWORD, so changing the
 * password signs every browser out. Null when no password is set (fail closed).
 */
export function sessionToken(): string | null {
  const password = process.env.APP_PASSWORD;
  return password ? sign("session", password) : null;
}

export function isValidSession(cookie: string | undefined): boolean {
  const token = sessionToken();
  return !!token && !!cookie && equal(cookie, token);
}

export function isPassword(input: string): boolean {
  const password = process.env.APP_PASSWORD;
  // Compare digests so the check doesn't leak the password's length
  return !!password && equal(sign(input, "pw"), sign(password, "pw"));
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
