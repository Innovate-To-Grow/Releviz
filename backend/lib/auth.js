import jwt from "jsonwebtoken";

const JWT_SECRET =
  process.env.JWT_SECRET || (process.env.NODE_ENV === "test" ? "test-secret" : undefined);

if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET environment variable is not set");
  process.exit(1);
}

const JWT_EXPIRY = "7d";

export function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}
