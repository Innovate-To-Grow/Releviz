import { createClerkClient, verifyToken } from "@clerk/backend";

function parseAuthorizedParties() {
  const value = process.env.CLERK_AUTHORIZED_PARTIES || "";
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : undefined;
}

function buildVerifyOptions() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const jwtKey = process.env.CLERK_JWT_KEY;

  if (!secretKey && !jwtKey) {
    throw new Error("Clerk auth is not configured");
  }

  return {
    ...(secretKey ? { secretKey } : {}),
    ...(jwtKey ? { jwtKey } : {}),
    ...(parseAuthorizedParties() ? { authorizedParties: parseAuthorizedParties() } : {}),
  };
}

let clerkClient;

function getClerkClient() {
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error("Clerk secret key is not configured");
  }

  if (!clerkClient) {
    clerkClient = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
      ...(process.env.CLERK_PUBLISHABLE_KEY
        ? { publishableKey: process.env.CLERK_PUBLISHABLE_KEY }
        : {}),
    });
  }

  return clerkClient;
}

export function getRequestAuthToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }

  return req.cookies?.__session || null;
}

export async function verifyClerkSessionToken(token) {
  return verifyToken(token, buildVerifyOptions());
}

export async function fetchClerkUser(userId) {
  return getClerkClient().users.getUser(userId);
}

export function normalizeClerkUser(user) {
  const primaryEmail =
    user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)?.emailAddress ||
    user.emailAddresses[0]?.emailAddress ||
    "";
  const displayName = user.fullName || user.username || primaryEmail.split("@")[0] || "User";

  return {
    userId: user.id,
    email: primaryEmail,
    displayName,
    imageUrl: user.imageUrl || null,
    createdAt: new Date(user.createdAt).toISOString(),
    updatedAt: new Date(user.updatedAt).toISOString(),
  };
}
