import crypto from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(crypto.scrypt);

export function generateEventCode(length = 8) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const limit = 256 - (256 % chars.length);
  let code = "";
  while (code.length < length) {
    const bytes = crypto.randomBytes(length - code.length);
    for (let i = 0; i < bytes.length && code.length < length; i++) {
      if (bytes[i] < limit) {
        code += chars[bytes[i] % chars.length];
      }
    }
  }
  return code;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64)).toString("hex");
  return `${salt}:${hash}`;
}

export async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== "string") return false;
  const parts = storedHash.split(":");
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  const candidate = (await scryptAsync(password, salt, 64)).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}
