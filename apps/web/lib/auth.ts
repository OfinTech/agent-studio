import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { cookies } from "next/headers";
export const SESSION_COOKIE = "platform_session";
const lifetime = 60 * 60 * 12;
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32)
    throw new Error("SESSION_SECRET is not configured");
  return value;
}
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function checkPassword(password: string) {
  const [salt, hash] = (process.env.ADMIN_PASSWORD_HASH ?? "").split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function createSession() {
  const value = Buffer.from(
    JSON.stringify({
      email: process.env.ADMIN_EMAIL,
      exp: Math.floor(Date.now() / 1000) + lifetime,
      nonce: randomBytes(16).toString("hex"),
    }),
  ).toString("base64url");
  return (
    value +
    "." +
    createHmac("sha256", secret()).update(value).digest("base64url")
  );
}
export function validSession(token: string | undefined) {
  if (!token) return false;
  try {
    const [value, signature, ...extra] = token.split(".");
    if (extra.length) return false;
    const expected = createHmac("sha256", secret()).update(value).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return false;
    const data = JSON.parse(Buffer.from(value, "base64url").toString());
    return (
      data.email === process.env.ADMIN_EMAIL &&
      typeof data.exp === "number" &&
      data.exp > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}
export async function authenticated() {
  return validSession((await cookies()).get(SESSION_COOKIE)?.value);
}
export const cookieOptions = () => ({
  httpOnly: true,
  secure:
    new URL(process.env.APP_URL ?? "http://localhost:3000").protocol ===
    "https:",
  sameSite: "strict" as const,
  path: "/",
  maxAge: lifetime,
});
