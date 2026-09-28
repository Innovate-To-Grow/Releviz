const crypto = require("node:crypto");
const { expect, test } = require("@playwright/test");
const {
  BACKEND_URL,
  apiJson,
  codeFromEmailBody,
  createEvent,
  differentCode,
  expireResendCooldown,
  importRosterApi,
  latestEmailFor,
  latestVerificationCode,
  newRunId,
  registerAccountViaApi,
  runDjangoJson,
} = require("./helpers/releviz");
const { rosterByEmail, tsv } = require("./helpers/roster");

// Backend routes no frontend screen calls, exercised through the real HTTP
// API (Django, Postgres and the email sink) so their contracts stay covered:
// contact-email management, the emailed-code password change, the legacy
// login-code request, the registration resend, newsletter subscribe and
// the unsubscribe link, and the read-only weights endpoint.

// Plain HTTP against the API is browser-neutral, so it runs once per suite.
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Browser-neutral API contract checks; run them once per suite run",
);

const VERIFICATION_INVALID = "Verification code is invalid or has expired.";
const VERIFICATION_THROTTLED =
  "Too many verification attempts. Please try again later.";
const CONTACT_EMAIL_SUBJECT = "Verify your contact email - Releviz";
const PASSWORD_CHANGE_SUBJECT = "Password change code - Releviz";

function subjectOf(message) {
  return message.match(/^Subject:\s*(.+)$/im)?.[1]?.trim();
}

// The newest six-digit code emailed to `email` under `subject`, skipping a
// code the caller already holds.
async function emailedCode(email, afterMs, subject, { notCode } = {}) {
  const body = await latestEmailFor(email, afterMs, (message) => {
    const code = codeFromEmailBody(message);
    return subjectOf(message) === subject && Boolean(code) && code !== notCode;
  });
  return codeFromEmailBody(body);
}

// An unauthenticated call (no Authorization header).
async function anonymousJson(request, method, url, body) {
  const response = await request.fetch(`${BACKEND_URL}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    data: body,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

// Encrypts a password the way the frontend does (RSA-OAEP, SHA-256) with the
// key /authn/public-key/ publishes; the E2E settings reject plaintext.
async function encryptPasswords(request, ...passwords) {
  const published = await anonymousJson(request, "GET", "/authn/public-key/");
  expect(published.response.status()).toBe(200);
  expect(published.payload.password_encryption_required).toBe(true);
  const encrypted = passwords.map((password) =>
    crypto
      .publicEncrypt(
        {
          key: published.payload.public_key,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(password, "utf8"),
      )
      .toString("base64"),
  );
  return { keyId: published.payload.key_id, encrypted };
}

async function passwordLogin(request, email, password) {
  const {
    keyId,
    encrypted: [ciphertext],
  } = await encryptPasswords(request, password);
  return anonymousJson(request, "POST", "/authn/login/", {
    email,
    password: ciphertext,
    key_id: keyId,
  });
}

function maskedEmail(email) {
  const [local, domain] = email.split("@");
  return `${local[0]}${"•".repeat(local.length - 1)}@${domain}`;
}

test("contact emails are added, verified by emailed code, made primary and removed", async ({
  request,
}) => {
  const runId = newRunId();
  const ownerEmail = `contacts-owner-${runId}@example.com`;
  const altEmail = `contacts-alt-${runId}@example.com`;
  const owner = await registerAccountViaApi(
    request,
    ownerEmail,
    "Cora",
    "Contacts",
  );
  const other = await registerAccountViaApi(
    request,
    `contacts-other-${runId}@example.com`,
    "Otto",
    "Other",
  );

  for (const url of ["/authn/contact-emails/", "/authn/account-emails/"]) {
    const anonymous = await anonymousJson(request, "GET", url);
    expect(anonymous.response.status(), url).toBe(401);
  }

  // The primary address is the profile's, so the contact list starts empty
  // while the verified sign-in addresses list the primary.
  let listed = await apiJson(
    request,
    "GET",
    "/authn/contact-emails/",
    owner.access,
  );
  expect(listed.response.status()).toBe(200);
  expect(listed.payload).toEqual([]);
  let accountEmails = await apiJson(
    request,
    "GET",
    "/authn/account-emails/",
    owner.access,
  );
  expect(accountEmails.response.status()).toBe(200);
  expect(accountEmails.payload).toEqual({ emails: [ownerEmail] });

  const invalid = await apiJson(
    request,
    "POST",
    "/authn/contact-emails/",
    owner.access,
    { email_address: "not-an-email", email_type: "secondary" },
  );
  expect(invalid.response.status()).toBe(400);
  expect(invalid.payload).toHaveProperty("email_address");

  const addedAt = Date.now() - 1000;
  const added = await apiJson(
    request,
    "POST",
    "/authn/contact-emails/",
    owner.access,
    {
      email_address: altEmail.toUpperCase(),
      email_type: "secondary",
      subscribe: false,
    },
  );
  expect(added.response.status(), JSON.stringify(added.payload)).toBe(201);
  expect(added.payload).toMatchObject({
    email_address: altEmail,
    email_type: "secondary",
    subscribe: false,
    verified: false,
  });
  const contactId = added.payload.id;
  const firstCode = await emailedCode(altEmail, addedAt, CONTACT_EMAIL_SUBJECT);

  // Unverified addresses are listed as contacts but are not sign-in
  // addresses, and cannot become primary.
  listed = await apiJson(request, "GET", "/authn/contact-emails/", owner.access);
  expect(listed.payload.map((entry) => entry.id)).toEqual([contactId]);
  accountEmails = await apiJson(
    request,
    "GET",
    "/authn/account-emails/",
    owner.access,
  );
  expect(accountEmails.payload.emails).toEqual([ownerEmail]);
  const earlyPrimary = await apiJson(
    request,
    "POST",
    `/authn/contact-emails/${contactId}/make-primary/`,
    owner.access,
  );
  expect(earlyPrimary.response.status()).toBe(400);
  expect(earlyPrimary.payload.detail).toBe("Unable to update primary email.");

  // A second code inside the 60 s cooldown is refused; once it lapses a new
  // code supersedes the first.
  const tooSoon = await apiJson(
    request,
    "POST",
    `/authn/contact-emails/${contactId}/request-verification/`,
    owner.access,
  );
  expect(tooSoon.response.status()).toBe(429);
  expect(tooSoon.payload.detail).toBe(VERIFICATION_THROTTLED);
  expect(expireResendCooldown(altEmail)).toBe(1);
  const resentAt = Date.now() - 1000;
  const resent = await apiJson(
    request,
    "POST",
    `/authn/contact-emails/${contactId}/request-verification/`,
    owner.access,
  );
  expect(resent.response.status()).toBe(202);
  expect(resent.payload).toEqual({ message: "Verification code sent." });
  const secondCode = await emailedCode(
    altEmail,
    resentAt,
    CONTACT_EMAIL_SUBJECT,
    { notCode: firstCode },
  );

  const malformed = await apiJson(
    request,
    "POST",
    `/authn/contact-emails/${contactId}/verify-code/`,
    owner.access,
    { code: "12ab56" },
  );
  expect(malformed.response.status()).toBe(400);
  expect(malformed.payload.code).toEqual(["Code must be exactly 6 digits."]);
  const superseded = await apiJson(
    request,
    "POST",
    `/authn/contact-emails/${contactId}/verify-code/`,
    owner.access,
    { code: firstCode },
  );
  expect(superseded.response.status()).toBe(400);
  expect(superseded.payload.detail).toBe(VERIFICATION_INVALID);

  // Another member can neither see nor act on this contact email.
  const foreignCalls = [
    ["PATCH", `/authn/contact-emails/${contactId}/`, { email_type: "other" }],
    ["DELETE", `/authn/contact-emails/${contactId}/`],
    ["POST", `/authn/contact-emails/${contactId}/request-verification/`],
    [
      "POST",
      `/authn/contact-emails/${contactId}/verify-code/`,
      { code: secondCode },
    ],
    ["POST", `/authn/contact-emails/${contactId}/make-primary/`],
  ];
  for (const [method, url, body] of foreignCalls) {
    const foreign = await apiJson(request, method, url, other.access, body);
    expect(foreign.response.status(), `${method} ${url}`).toBe(404);
  }
  const otherList = await apiJson(
    request,
    "GET",
    "/authn/contact-emails/",
    other.access,
  );
  expect(otherList.payload).toEqual([]);

  // Claiming an address someone already holds fails without saying whose it
  // is, and the holder is warned.
  const claimedAt = Date.now() - 1000;
  const claim = await apiJson(
    request,
    "POST",
    "/authn/contact-emails/",
    other.access,
    { email_address: altEmail, email_type: "other" },
  );
  expect(claim.response.status()).toBe(400);
  expect(claim.payload.detail).toBe("Unable to add this email address.");
  await latestEmailFor(
    altEmail,
    claimedAt,
    (message) => subjectOf(message) === "Security notice - Releviz",
  );

  const verified = await apiJson(
    request,
    "POST",
    `/authn/contact-emails/${contactId}/verify-code/`,
    owner.access,
    { code: secondCode },
  );
  expect(verified.response.status()).toBe(200);
  expect(verified.payload).toMatchObject({ id: contactId, verified: true });
  const alreadyVerified = await apiJson(
    request,
    "POST",
    `/authn/contact-emails/${contactId}/request-verification/`,
    owner.access,
  );
  expect(alreadyVerified.response.status()).toBe(400);
  expect(alreadyVerified.payload.detail).toBe(
    "This email is already verified.",
  );
  accountEmails = await apiJson(
    request,
    "GET",
    "/authn/account-emails/",
    owner.access,
  );
  expect([...accountEmails.payload.emails].sort()).toEqual(
    [ownerEmail, altEmail].sort(),
  );

  // Making it primary moves the profile's address and demotes the old one.
  const promoted = await apiJson(
    request,
    "POST",
    `/authn/contact-emails/${contactId}/make-primary/`,
    owner.access,
  );
  expect(promoted.response.status()).toBe(200);
  expect(promoted.payload).toMatchObject({
    id: contactId,
    email_type: "primary",
    verified: true,
  });
  const profile = await apiJson(
    request,
    "GET",
    "/authn/profile/",
    owner.access,
  );
  expect(profile.payload).toMatchObject({
    email: altEmail,
    email_verified: true,
    primary_email_id: contactId,
    email_subscribe: false,
  });
  listed = await apiJson(request, "GET", "/authn/contact-emails/", owner.access);
  expect(listed.payload).toHaveLength(1);
  expect(listed.payload[0]).toMatchObject({
    email_address: ownerEmail,
    email_type: "secondary",
    verified: true,
  });
  const formerPrimaryId = listed.payload[0].id;

  const demotePrimary = await apiJson(
    request,
    "PATCH",
    `/authn/contact-emails/${contactId}/`,
    owner.access,
    { email_type: "secondary" },
  );
  expect(demotePrimary.response.status()).toBe(400);
  expect(demotePrimary.payload.email_type[0]).toContain(
    "The primary email cannot be demoted directly.",
  );
  const patched = await apiJson(
    request,
    "PATCH",
    `/authn/contact-emails/${formerPrimaryId}/`,
    owner.access,
    { email_type: "other", subscribe: false },
  );
  expect(patched.response.status()).toBe(200);
  expect(patched.payload).toMatchObject({
    id: formerPrimaryId,
    email_type: "other",
    subscribe: false,
  });

  const removed = await apiJson(
    request,
    "DELETE",
    `/authn/contact-emails/${formerPrimaryId}/`,
    owner.access,
  );
  expect(removed.response.status()).toBe(204);
  listed = await apiJson(request, "GET", "/authn/contact-emails/", owner.access);
  expect(listed.payload).toEqual([]);
  accountEmails = await apiJson(
    request,
    "GET",
    "/authn/account-emails/",
    owner.access,
  );
  expect(accountEmails.payload).toEqual({ emails: [altEmail] });
  const removedAgain = await apiJson(
    request,
    "DELETE",
    `/authn/contact-emails/${formerPrimaryId}/`,
    owner.access,
  );
  expect(removedAgain.response.status()).toBe(404);

  // The last verified address is the only way back in, so it stays.
  const lastOne = await apiJson(
    request,
    "DELETE",
    `/authn/contact-emails/${contactId}/`,
    owner.access,
  );
  expect(lastOne.response.status()).toBe(409);
  expect(lastOne.payload.detail).toContain(
    "You can't remove your only verified recovery method.",
  );
});

test("a password is set by emailed code and then signs in", async ({
  request,
}) => {
  const runId = newRunId();
  const email = `password-change-${runId}@example.com`;
  const newPassword = `Releviz-Change-${runId}!`;
  const member = await registerAccountViaApi(request, email, "Pat", "Change");

  const anonymous = await anonymousJson(
    request,
    "POST",
    "/authn/change-password/request-code/",
    {},
  );
  expect(anonymous.response.status()).toBe(401);
  const notMine = await apiJson(
    request,
    "POST",
    "/authn/change-password/request-code/",
    member.access,
    { email: `password-stranger-${runId}@example.com` },
  );
  expect(notMine.response.status()).toBe(400);
  expect(notMine.payload).toHaveProperty("email");

  const requestedAt = Date.now() - 1000;
  const requested = await apiJson(
    request,
    "POST",
    "/authn/change-password/request-code/",
    member.access,
    {},
  );
  expect(requested.response.status()).toBe(202);
  expect(requested.payload).toEqual({
    message: "Verification code sent.",
    destination: maskedEmail(email),
  });
  const code = await emailedCode(email, requestedAt, PASSWORD_CHANGE_SUBJECT);

  const wrong = await apiJson(
    request,
    "POST",
    "/authn/change-password/verify-code/",
    member.access,
    { code: differentCode(code) },
  );
  expect(wrong.response.status()).toBe(400);
  expect(wrong.payload.detail).toBe(VERIFICATION_INVALID);
  const accepted = await apiJson(
    request,
    "POST",
    "/authn/change-password/verify-code/",
    member.access,
    { code },
  );
  expect(accepted.response.status()).toBe(200);
  expect(accepted.payload.message).toBe("Verification code accepted.");
  const verificationToken = accepted.payload.verification_token;
  expect(verificationToken).toBeTruthy();

  // Plaintext and mismatched pairs are refused without spending the token.
  const plaintext = await apiJson(
    request,
    "POST",
    "/authn/change-password/confirm/",
    member.access,
    {
      verification_token: verificationToken,
      new_password: newPassword,
      new_password_confirm: newPassword,
    },
  );
  expect(plaintext.response.status()).toBe(400);
  expect(plaintext.payload.new_password).toEqual([
    "Encrypted password required.",
  ]);
  const mismatch = await encryptPasswords(
    request,
    newPassword,
    `${newPassword}x`,
  );
  const mismatched = await apiJson(
    request,
    "POST",
    "/authn/change-password/confirm/",
    member.access,
    {
      verification_token: verificationToken,
      new_password: mismatch.encrypted[0],
      new_password_confirm: mismatch.encrypted[1],
      key_id: mismatch.keyId,
    },
  );
  expect(mismatched.response.status()).toBe(400);
  expect(mismatched.payload.new_password_confirm).toEqual([
    "Passwords do not match.",
  ]);

  // Registration left no usable password, so password sign-in fails first.
  const before = await passwordLogin(request, email, newPassword);
  expect(before.response.status()).toBe(400);

  const pair = await encryptPasswords(request, newPassword, newPassword);
  const confirmed = await apiJson(
    request,
    "POST",
    "/authn/change-password/confirm/",
    member.access,
    {
      verification_token: verificationToken,
      new_password: pair.encrypted[0],
      new_password_confirm: pair.encrypted[1],
      key_id: pair.keyId,
    },
  );
  expect(confirmed.response.status()).toBe(200);
  expect(confirmed.payload).toEqual({
    message: "Password changed successfully.",
  });

  const oldAccess = await apiJson(
    request,
    "GET",
    "/authn/profile/",
    member.access,
  );
  const refreshed = await request.post(`${BACKEND_URL}/authn/refresh/`, {
    data: {},
  });
  console.log(
    "old access",
    oldAccess.response.status(),
    "refresh",
    refreshed.status(),
    await refreshed.text(),
  );

  const signedIn = await passwordLogin(request, email, newPassword);
  expect(signedIn.response.status()).toBe(200);
  expect(signedIn.payload.user.member_uuid).toBe(member.user.id);
  const profile = await apiJson(
    request,
    "GET",
    "/authn/profile/",
    signedIn.payload.access,
  );
  expect(profile.response.status()).toBe(200);
  expect(profile.payload.email).toBe(email);

  const wrongPassword = await passwordLogin(request, email, `${newPassword}x`);
  expect(wrongPassword.response.status()).toBe(400);

  // The verification token is single-use.
  const replay = await encryptPasswords(request, newPassword, newPassword);
  const replayed = await apiJson(
    request,
    "POST",
    "/authn/change-password/confirm/",
    signedIn.payload.access,
    {
      verification_token: verificationToken,
      new_password: replay.encrypted[0],
      new_password_confirm: replay.encrypted[1],
      key_id: replay.keyId,
    },
  );
  expect(replayed.response.status()).toBe(400);
  expect(replayed.payload.detail).toBe(
    "Verification link is invalid or has expired.",
  );
});

test("the legacy login-code request emails a code that signs in", async ({
  request,
}) => {
  const runId = newRunId();
  const email = `legacy-login-${runId}@example.com`;
  const unknown = `legacy-login-nobody-${runId}@example.com`;
  const member = await registerAccountViaApi(request, email, "Lee", "Legacy");
  const generic =
    "If an eligible account exists, a verification code has been sent.";

  const invalid = await anonymousJson(
    request,
    "POST",
    "/authn/login/request-code/",
    { email: "not-an-email" },
  );
  expect(invalid.response.status()).toBe(400);
  expect(invalid.payload).toHaveProperty("email");

  // An unknown address gets the same answer and no code is issued.
  const nobody = await anonymousJson(
    request,
    "POST",
    "/authn/login/request-code/",
    { email: unknown },
  );
  expect(nobody.response.status()).toBe(202);
  expect(nobody.payload).toEqual({ message: generic });
  expect(
    runDjangoJson(
      `
from apps.authn.models import EmailAuthChallenge

print(json.dumps(EmailAuthChallenge.objects.filter(target_email__iexact=data["email"]).count()))
`,
      { email: unknown },
    ),
  ).toBe(0);

  const requestedAt = Date.now() - 1000;
  const requested = await anonymousJson(
    request,
    "POST",
    "/authn/login/request-code/",
    { email: email.toUpperCase() },
  );
  expect(requested.response.status()).toBe(202);
  expect(requested.payload).toEqual({ message: generic });
  const code = await latestVerificationCode(email, requestedAt, "login");

  const wrong = await anonymousJson(
    request,
    "POST",
    "/authn/login/verify-code/",
    { email, code: differentCode(code) },
  );
  expect(wrong.response.status()).toBe(400);
  const signedIn = await anonymousJson(
    request,
    "POST",
    "/authn/login/verify-code/",
    { email, code },
  );
  expect(signedIn.response.status()).toBe(200);
  expect(signedIn.payload.user.member_uuid).toBe(member.user.id);
  const profile = await apiJson(
    request,
    "GET",
    "/authn/profile/",
    signedIn.payload.access,
  );
  expect(profile.response.status()).toBe(200);
  expect(profile.payload).toMatchObject({
    email,
    first_name: "Lee",
    last_name: "Legacy",
  });
});

test("the registration resend replaces a pending sign-up's code", async ({
  request,
}) => {
  const runId = newRunId();
  const email = `resend-${runId}@example.com`;

  const unknown = await anonymousJson(
    request,
    "POST",
    "/authn/register/resend-code/",
    { email: `resend-nobody-${runId}@example.com` },
  );
  expect(unknown.response.status()).toBe(400);
  expect(unknown.payload.email).toEqual([
    "No pending registration was found for this email.",
  ]);

  const startedAt = Date.now() - 1000;
  const started = await anonymousJson(
    request,
    "POST",
    "/authn/email-auth/request-code/",
    { email, source: "login" },
  );
  expect(started.response.status()).toBe(202);
  const firstCode = await latestVerificationCode(email, startedAt, "register");

  const tooSoon = await anonymousJson(
    request,
    "POST",
    "/authn/register/resend-code/",
    { email },
  );
  expect(tooSoon.response.status()).toBe(429);
  expect(tooSoon.payload.detail).toBe(VERIFICATION_THROTTLED);

  expect(expireResendCooldown(email)).toBe(1);
  const resentAt = Date.now() - 1000;
  const resent = await anonymousJson(
    request,
    "POST",
    "/authn/register/resend-code/",
    { email },
  );
  expect(resent.response.status()).toBe(202);
  expect(resent.payload).toEqual({ message: "Verification code sent." });
  const secondCode = await latestVerificationCode(email, resentAt, "register", {
    notCode: firstCode,
  });

  const superseded = await anonymousJson(
    request,
    "POST",
    "/authn/register/verify-code/",
    { email, code: firstCode },
  );
  expect(superseded.response.status()).toBe(400);
  const registered = await anonymousJson(
    request,
    "POST",
    "/authn/register/verify-code/",
    { email, code: secondCode },
  );
  expect(registered.response.status()).toBe(200);
  expect(registered.payload.message).toBe(
    "Email verified. Registration successful.",
  );
  const profile = await apiJson(
    request,
    "GET",
    "/authn/profile/",
    registered.payload.access,
  );
  expect(profile.payload).toMatchObject({
    email,
    email_verified: true,
    is_active: true,
  });

  // Once the account is active there is nothing left to resend.
  const afterwards = await anonymousJson(
    request,
    "POST",
    "/authn/register/resend-code/",
    { email },
  );
  expect(afterwards.response.status()).toBe(400);
  expect(afterwards.payload.email).toEqual([
    "No pending registration was found for this email.",
  ]);
});

test("a newsletter subscription carries into the account and the unsubscribe link ends it", async ({
  request,
}) => {
  const runId = newRunId();
  const email = `subscriber-${runId}@example.com`;

  const invalid = await anonymousJson(request, "POST", "/authn/subscribe/", {
    email: "not-an-email",
  });
  expect(invalid.response.status()).toBe(400);
  expect(invalid.payload).toHaveProperty("email");

  const subscribed = await anonymousJson(request, "POST", "/authn/subscribe/", {
    email: email.toUpperCase(),
  });
  expect(subscribed.response.status()).toBe(201);
  expect(subscribed.payload).toEqual({
    message: "You have been subscribed successfully.",
  });
  const subscriberRow = () =>
    runDjangoJson(
      `
from apps.authn.models import ContactEmail

rows = ContactEmail.objects.filter(email_address__iexact=data["email"])
print(json.dumps([
    {
        "id": str(row.pk),
        "email": row.email_address,
        "member": str(row.member_id) if row.member_id else None,
        "type": row.email_type,
        "subscribe": row.subscribe,
    }
    for row in rows
]))
`,
      { email },
    );
  const [anonymousRow] = subscriberRow();
  expect(anonymousRow).toMatchObject({
    email,
    member: null,
    type: "other",
    subscribe: true,
  });
  const again = await anonymousJson(request, "POST", "/authn/subscribe/", {
    email,
  });
  expect(again.response.status()).toBe(200);
  expect(subscriberRow()).toHaveLength(1);

  // Signing up with that address claims the subscription row.
  const member = await registerAccountViaApi(request, email, "Sue", "Scribe");
  const [claimedRow] = subscriberRow();
  expect(claimedRow).toMatchObject({
    id: anonymousRow.id,
    member: member.user.id,
    type: "primary",
    subscribe: true,
  });
  const readProfile = async () => {
    const profile = await apiJson(
      request,
      "GET",
      "/authn/profile/",
      member.access,
    );
    expect(profile.response.status()).toBe(200);
    return profile.payload;
  };
  expect(await readProfile()).toMatchObject({
    email,
    email_subscribe: true,
    primary_email_id: anonymousRow.id,
  });

  // No email carries the signed unsubscribe link yet, so the token is minted
  // with the same backend helper the link builder uses.
  const token = runDjangoJson(
    `
from apps.authn.models import Member
from apps.authn.services.account.unsubscribe import build_unsubscribe_login_token

print(json.dumps(build_unsubscribe_login_token(Member.objects.get(pk=data["member"]))))
`,
    { member: member.user.id },
  );

  const missing = await anonymousJson(
    request,
    "POST",
    "/authn/unsubscribe-login/",
    { token: "  " },
  );
  expect(missing.response.status()).toBe(400);
  expect(missing.payload.detail).toBe("Token is required.");
  const tampered = await anonymousJson(
    request,
    "POST",
    "/authn/unsubscribe-login/",
    { token: `${token.slice(0, -2)}xx` },
  );
  expect(tampered.response.status()).toBe(400);
  expect(tampered.payload.detail).toBe("Invalid or expired unsubscribe link.");

  const unsubscribed = await anonymousJson(
    request,
    "POST",
    "/authn/unsubscribe-login/",
    { token },
  );
  expect(unsubscribed.response.status()).toBe(200);
  // The link unsubscribes without signing anyone in.
  expect(unsubscribed.payload).toEqual({
    message: "You have been unsubscribed.",
    unsubscribed: true,
  });
  expect(unsubscribed.response.headers()["set-cookie"]).toBeUndefined();
  expect((await readProfile()).email_subscribe).toBe(false);

  const replayed = await anonymousJson(
    request,
    "POST",
    "/authn/unsubscribe-login/",
    { token },
  );
  expect(replayed.response.status()).toBe(400);
  expect(replayed.payload.detail).toBe(
    "This unsubscribe link has already been used.",
  );

  // Subscribing again re-enables the account's address.
  const resubscribed = await anonymousJson(
    request,
    "POST",
    "/authn/subscribe/",
    { email },
  );
  expect(resubscribed.response.status()).toBe(200);
  expect((await readProfile()).email_subscribe).toBe(true);
});

test("weights are read-only and organizer-only", async ({ request }) => {
  const runId = newRunId();
  const organizer = await registerAccountViaApi(
    request,
    `weights-organizer-${runId}@example.com`,
    "Wren",
    "Weights",
  );
  const outsider = await registerAccountViaApi(
    request,
    `weights-outsider-${runId}@example.com`,
    "Olly",
    "Outsider",
  );
  const event = await createEvent(request, organizer.access, {
    name: `Weights ${runId}`,
  });
  const anaEmail = `weights-ana-${runId}@example.com`;
  const benEmail = `weights-ben-${runId}@example.com`;
  await importRosterApi(
    request,
    event.code,
    organizer.access,
    tsv([
      ["name", "email", "weight", "included"],
      ["Ana Weighted", anaEmail, "0.75", "true"],
      ["Ben Benched", benEmail, "0.25", "false"],
    ]),
  );

  const readWeights = async () => {
    const weights = await apiJson(
      request,
      "GET",
      `/events/weights?code=${event.code}`,
      organizer.access,
    );
    expect(weights.response.status()).toBe(200);
    expect(weights.response.headers()["cache-control"]).toContain("no-store");
    return new Map(
      weights.payload.weights.map((entry) => [entry.participant_name, entry]),
    );
  };
  let weights = await readWeights();
  expect(weights.size).toBe(2);
  expect(weights.get("Ana Weighted")).toMatchObject({
    weight: 0.75,
    included: 1,
  });
  expect(weights.get("Ben Benched")).toMatchObject({
    weight: 0.25,
    included: 0,
  });

  // Weights change through the roster; this endpoint only reflects them.
  const roster = await rosterByEmail(request, event.code, organizer.access);
  const ben = roster.get(benEmail);
  const patched = await apiJson(
    request,
    "PATCH",
    `/events/roster/${ben.id}?code=${event.code}`,
    organizer.access,
    { weight: 0.5, included: true, expectedVersion: ben.version },
  );
  expect(patched.response.status(), JSON.stringify(patched.payload)).toBe(200);
  weights = await readWeights();
  expect(weights.get("Ben Benched")).toMatchObject({
    weight: 0.5,
    included: 1,
  });

  const bulk = await apiJson(
    request,
    "PUT",
    `/events/weights?code=${event.code}`,
    organizer.access,
    {
      weights: [
        { participantId: weights.get("Ana Weighted").participant_id, weight: 0 },
      ],
    },
  );
  expect(bulk.response.status()).toBe(405);
  expect(bulk.payload.error).toContain("Bulk weight replacement was removed.");
  weights = await readWeights();
  expect(weights.get("Ana Weighted").weight).toBe(0.75);

  const forbidden = await apiJson(
    request,
    "GET",
    `/events/weights?code=${event.code}`,
    outsider.access,
  );
  expect(forbidden.response.status()).toBe(403);
  expect(forbidden.payload.error).toBe("Only the organizer can view weights");
  const anonymous = await anonymousJson(
    request,
    "GET",
    `/events/weights?code=${event.code}`,
  );
  expect(anonymous.response.status()).toBe(401);
  const noCode = await apiJson(
    request,
    "GET",
    "/events/weights",
    organizer.access,
  );
  expect(noCode.response.status()).toBe(400);
  expect(noCode.payload.error).toBe("code is required");
  const unknownEvent = await apiJson(
    request,
    "GET",
    `/events/weights?code=NOPE${runId.replace(/\D/g, "")}`,
    organizer.access,
  );
  expect(unknownEvent.response.status()).toBe(404);
});
