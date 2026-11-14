const crypto = require("node:crypto");
const { expect, test } = require("@playwright/test");
const {
  BACKEND_URL,
  FRONTEND_URL,
  codeFromEmailBody,
  createEvent,
  differentCode,
  encryptPasswordFields,
  expectDashboard,
  expireResendCooldown,
  importRosterApi,
  latestAuthLink,
  latestEmailFor,
  latestVerificationCode,
  newRunId,
  passwordLoginViaApi,
  registerAccountViaApi,
  runDjangoJson,
  setAccountPassword,
} = require("./helpers/releviz");
const { rosterByEmail, tsv } = require("./helpers/participants");

// Backend routes no frontend screen calls, exercised through the real HTTP
// API (Django, Postgres and the email sink) so their contracts stay covered:
// the read-only weights endpoint, contact-email management, setting a
// password with an emailed code, the profile's middle name and image upload,
// the legacy login-code, password registration and registration-resend
// routes, newsletter subscribe and the unsubscribe link, the Origin check on
// every cookie-bearing auth endpoint, and what happens when a verification
// email cannot be sent. Where a route has a screen (the one-click login link,
// the sign-in form) the browser drives it too.

const VERIFICATION_INVALID = "Verification code is invalid or has expired.";
const VERIFICATION_THROTTLED =
  "Too many verification attempts. Please try again later.";
const ORIGIN_REFUSED = { detail: "Request origin is not allowed." };
const FOREIGN_ORIGIN = "https://evil.example";
const DELIVERY_FAILED = "Failed to send verification email.";
const CONTACT_EMAIL_SUBJECT = "Verify your contact email - Releviz";
const PASSWORD_CHANGE_SUBJECT = "Password change code - Releviz";
const SECURITY_NOTICE_SUBJECT = "Security notice - Releviz";
const LOGIN_CODE_SENT =
  "If an eligible account exists, a verification code has been sent.";
// A 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
// The synchronous Django helpers block Node's event loop, so an idle
// keep-alive socket the server closed meanwhile can still look reusable and
// fail with ECONNRESET on the next call. Direct API calls retry that one
// network error; the server never saw the failed attempt.
const STALE_SOCKET_RETRIES = 2;

function subjectOf(message) {
  return message.match(/^Subject:\s*(.+)$/im)?.[1]?.trim();
}

// One API call. `token` adds a bearer token, `body` is sent as JSON and
// `multipart` as a form; the payload is parsed JSON, raw text or null.
async function api(
  request,
  method,
  url,
  { token, body, multipart, headers = {} } = {},
) {
  const response = await request.fetch(`${BACKEND_URL}${url}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(multipart ? { multipart } : body === undefined ? {} : { data: body }),
    maxRetries: STALE_SOCKET_RETRIES,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status(), payload, response };
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

function maskedEmail(email) {
  const [local, domain] = email.split("@");
  return `${local[0]}${"•".repeat(local.length - 1)}@${domain}`;
}

// Encrypted `new_password`/`new_password_confirm` fields the way the web app
// sends them; the E2E settings refuse plaintext passwords.
function encryptedPair(request, password, confirmation = password) {
  return encryptPasswordFields(
    request,
    { new_password: password, new_password_confirm: confirmation },
    ["new_password", "new_password_confirm"],
  );
}

// Plain-HTTP contract checks are browser-neutral, so they run once per run.
function chromiumOnly() {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "Browser-neutral API contract checks; run them once per suite run",
  );
}

// The same, for a test in a describe whose other tests drive a browser on
// every engine.
function chromiumOnlyInBody(browserName) {
  test.skip(
    browserName !== "chromium",
    "Browser-neutral API contract checks; run them once per suite run",
  );
}

test.describe("Participant weights", () => {
  chromiumOnly();

  test("weights are listed to the organizer only, reflect roster edits, and cannot be replaced in bulk", async ({
    request,
  }) => {
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
      const weights = await api(
        request,
        "GET",
        `/events/weights?code=${event.code}`,
        { token: organizer.access },
      );
      expect(weights.status).toBe(200);
      expect(weights.response.headers()["cache-control"]).toContain("no-store");
      return new Map(
        weights.payload.weights.map((entry) => [entry.participant_name, entry]),
      );
    };
    const roster = await rosterByEmail(request, event.code, organizer.access);
    let weights = await readWeights();
    expect([...weights.keys()].sort()).toEqual(["Ana Weighted", "Ben Benched"]);
    expect(weights.get("Ana Weighted")).toEqual({
      participant_id: roster.get(anaEmail).memberId,
      participant_name: "Ana Weighted",
      weight: 0.75,
      included: 1,
    });
    expect(weights.get("Ben Benched")).toMatchObject({
      participant_id: roster.get(benEmail).memberId,
      weight: 0.25,
      included: 0,
    });

    // Weights change through the roster; this endpoint only reflects them.
    const ben = roster.get(benEmail);
    const patched = await api(
      request,
      "PATCH",
      `/events/roster/${ben.id}?code=${event.code}`,
      {
        token: organizer.access,
        body: { weight: 0.5, included: true, expectedVersion: ben.version },
      },
    );
    expect(patched.status, JSON.stringify(patched.payload)).toBe(200);
    weights = await readWeights();
    expect(weights.get("Ben Benched")).toMatchObject({
      weight: 0.5,
      included: 1,
    });

    const bulk = await api(
      request,
      "PUT",
      `/events/weights?code=${event.code}`,
      {
        token: organizer.access,
        body: {
          weights: [
            {
              participantId: weights.get("Ana Weighted").participant_id,
              weight: 0,
            },
          ],
        },
      },
    );
    expect(bulk.status).toBe(405);
    expect(bulk.payload).toEqual({
      error:
        "Bulk weight replacement was removed. Use PATCH /events/roster/{id} or PATCH /events/roster/bulk.",
    });
    expect((await readWeights()).get("Ana Weighted").weight).toBe(0.75);

    const forbidden = await api(
      request,
      "GET",
      `/events/weights?code=${event.code}`,
      { token: outsider.access },
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.payload).toEqual({
      error: "Only the organizer can view weights",
    });
    const anonymous = await api(
      request,
      "GET",
      `/events/weights?code=${event.code}`,
    );
    expect(anonymous.status).toBe(401);
    const noCode = await api(request, "GET", "/events/weights", {
      token: organizer.access,
    });
    expect(noCode.status).toBe(400);
    expect(noCode.payload).toEqual({ error: "code is required" });
    const unknownEvent = await api(
      request,
      "GET",
      `/events/weights?code=NOPE${runId.replace(/\D/g, "").slice(-8)}`,
      { token: organizer.access },
    );
    expect(unknownEvent.status).toBe(404);
    expect(unknownEvent.payload).toEqual({ error: "Event not found" });
  });
});

test.describe("Contact emails", () => {
  chromiumOnly();

  test("a contact email is added, verified by emailed code, made primary so it signs in, and removed, and nobody else can touch it", async ({
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
    const asOwner = (method, url, body) =>
      api(request, method, url, { token: owner.access, body });
    const accountEmails = async () => {
      const listed = await asOwner("GET", "/authn/account-emails/");
      expect(listed.status).toBe(200);
      return [...listed.payload.emails].sort();
    };

    for (const url of ["/authn/contact-emails/", "/authn/account-emails/"]) {
      expect((await api(request, "GET", url)).status, url).toBe(401);
    }

    // The primary address is the profile's, so the contact list starts
    // empty while the verified sign-in addresses list the primary.
    let listed = await asOwner("GET", "/authn/contact-emails/");
    expect(listed.status).toBe(200);
    expect(listed.payload).toEqual([]);
    expect(await accountEmails()).toEqual([ownerEmail]);

    const invalid = await asOwner("POST", "/authn/contact-emails/", {
      email_address: "not-an-email",
      email_type: "secondary",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.payload).toHaveProperty("email_address");
    const asPrimary = await asOwner("POST", "/authn/contact-emails/", {
      email_address: altEmail,
      email_type: "primary",
    });
    expect(asPrimary.status).toBe(400);
    expect(asPrimary.payload).toHaveProperty("email_type");

    const addedAt = Date.now() - 1000;
    const added = await asOwner("POST", "/authn/contact-emails/", {
      email_address: altEmail.toUpperCase(),
      email_type: "secondary",
      subscribe: false,
    });
    expect(added.status, JSON.stringify(added.payload)).toBe(201);
    expect(added.payload).toMatchObject({
      email_address: altEmail,
      email_type: "secondary",
      subscribe: false,
      verified: false,
    });
    const contactId = added.payload.id;
    const firstCode = await emailedCode(
      altEmail,
      addedAt,
      CONTACT_EMAIL_SUBJECT,
    );

    // Unverified addresses are listed as contacts but are not sign-in
    // addresses, and cannot become primary.
    listed = await asOwner("GET", "/authn/contact-emails/");
    expect(listed.payload.map((entry) => entry.id)).toEqual([contactId]);
    expect(await accountEmails()).toEqual([ownerEmail]);
    const earlyPrimary = await asOwner(
      "POST",
      `/authn/contact-emails/${contactId}/make-primary/`,
    );
    expect(earlyPrimary.status).toBe(400);
    expect(earlyPrimary.payload).toEqual({
      detail: "Unable to update primary email.",
    });

    // A second secondary address is refused; "other" is the place for it,
    // and it cannot be switched to secondary later either. An unverified
    // address can simply be removed.
    const secondEmail = `contacts-second-${runId}@example.com`;
    const secondSecondary = await asOwner("POST", "/authn/contact-emails/", {
      email_address: secondEmail,
      email_type: "secondary",
    });
    expect(secondSecondary.status).toBe(400);
    expect(secondSecondary.payload).toEqual({
      detail: "Unable to add this email address.",
    });
    const otherAddedAt = Date.now() - 1000;
    const otherContact = await asOwner("POST", "/authn/contact-emails/", {
      email_address: secondEmail,
      email_type: "other",
    });
    expect(otherContact.status, JSON.stringify(otherContact.payload)).toBe(201);
    expect(otherContact.payload).toMatchObject({
      email_address: secondEmail,
      email_type: "other",
      subscribe: true,
      verified: false,
    });
    await emailedCode(secondEmail, otherAddedAt, CONTACT_EMAIL_SUBJECT);
    const otherToSecondary = await asOwner(
      "PATCH",
      `/authn/contact-emails/${otherContact.payload.id}/`,
      { email_type: "secondary" },
    );
    expect(otherToSecondary.status).toBe(400);
    expect(otherToSecondary.payload).toEqual({
      email_type: ["You already have a secondary email."],
    });
    expect(
      (
        await asOwner(
          "DELETE",
          `/authn/contact-emails/${otherContact.payload.id}/`,
        )
      ).status,
    ).toBe(204);
    listed = await asOwner("GET", "/authn/contact-emails/");
    expect(listed.payload.map((entry) => entry.id)).toEqual([contactId]);

    // A second code inside the 60 s cooldown is refused; once it lapses a
    // new code supersedes the first.
    const tooSoon = await asOwner(
      "POST",
      `/authn/contact-emails/${contactId}/request-verification/`,
    );
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.payload).toEqual({
      detail: VERIFICATION_THROTTLED,
      retry_after: expect.any(Number),
    });
    // The wait is what is left of the cooldown, in the header too.
    expect(tooSoon.payload.retry_after).toBeGreaterThan(0);
    expect(tooSoon.payload.retry_after).toBeLessThanOrEqual(60);
    expect(tooSoon.response.headers()["retry-after"]).toBe(
      String(tooSoon.payload.retry_after),
    );
    expect(expireResendCooldown(altEmail)).toBe(1);
    const resentAt = Date.now() - 1000;
    const resent = await asOwner(
      "POST",
      `/authn/contact-emails/${contactId}/request-verification/`,
    );
    expect(resent.status).toBe(202);
    expect(resent.payload).toEqual({ message: "Verification code sent." });
    const secondCode = await emailedCode(
      altEmail,
      resentAt,
      CONTACT_EMAIL_SUBJECT,
      { notCode: firstCode },
    );

    const malformed = await asOwner(
      "POST",
      `/authn/contact-emails/${contactId}/verify-code/`,
      { code: "12ab56" },
    );
    expect(malformed.status).toBe(400);
    expect(malformed.payload).toEqual({
      code: ["Code must be exactly 6 digits."],
    });
    const superseded = await asOwner(
      "POST",
      `/authn/contact-emails/${contactId}/verify-code/`,
      { code: firstCode },
    );
    expect(superseded.status).toBe(400);
    expect(superseded.payload).toEqual({ detail: VERIFICATION_INVALID });

    // Another member can neither see nor act on this contact email.
    for (const [method, url, body] of [
      ["PATCH", `/authn/contact-emails/${contactId}/`, { email_type: "other" }],
      ["DELETE", `/authn/contact-emails/${contactId}/`],
      ["POST", `/authn/contact-emails/${contactId}/request-verification/`],
      [
        "POST",
        `/authn/contact-emails/${contactId}/verify-code/`,
        { code: secondCode },
      ],
      ["POST", `/authn/contact-emails/${contactId}/make-primary/`],
    ]) {
      const foreign = await api(request, method, url, {
        token: other.access,
        body,
      });
      expect(foreign.status, `${method} ${url}`).toBe(404);
      expect(foreign.payload, `${method} ${url}`).toEqual({
        detail: "Not found.",
      });
    }
    expect(
      (
        await api(request, "GET", "/authn/contact-emails/", {
          token: other.access,
        })
      ).payload,
    ).toEqual([]);

    // Claiming an address someone already holds fails without saying whose
    // it is, and the holder is warned.
    const claimedAt = Date.now() - 1000;
    const claim = await api(request, "POST", "/authn/contact-emails/", {
      token: other.access,
      body: { email_address: altEmail, email_type: "other" },
    });
    expect(claim.status).toBe(400);
    expect(claim.payload).toEqual({
      detail: "Unable to add this email address.",
    });
    await latestEmailFor(
      altEmail,
      claimedAt,
      (message) => subjectOf(message) === SECURITY_NOTICE_SUBJECT,
    );

    const verified = await asOwner(
      "POST",
      `/authn/contact-emails/${contactId}/verify-code/`,
      { code: secondCode },
    );
    expect(verified.status).toBe(200);
    expect(verified.payload).toMatchObject({ id: contactId, verified: true });
    const alreadyVerified = await asOwner(
      "POST",
      `/authn/contact-emails/${contactId}/request-verification/`,
    );
    expect(alreadyVerified.status).toBe(400);
    expect(alreadyVerified.payload).toEqual({
      detail: "This email is already verified.",
    });
    expect(await accountEmails()).toEqual([ownerEmail, altEmail].sort());

    // Making it primary moves the profile's address and demotes the old one.
    const promoted = await asOwner(
      "POST",
      `/authn/contact-emails/${contactId}/make-primary/`,
    );
    expect(promoted.status).toBe(200);
    expect(promoted.payload).toMatchObject({
      id: contactId,
      email_type: "primary",
      verified: true,
    });
    const profile = await asOwner("GET", "/authn/profile/");
    expect(profile.payload).toMatchObject({
      email: altEmail,
      email_verified: true,
      primary_email_id: contactId,
      email_subscribe: false,
    });
    listed = await asOwner("GET", "/authn/contact-emails/");
    expect(listed.payload).toHaveLength(1);
    expect(listed.payload[0]).toMatchObject({
      email_address: ownerEmail,
      email_type: "secondary",
      verified: true,
    });
    const formerPrimaryId = listed.payload[0].id;

    // The new primary is the account's sign-in identity: a login code for it
    // signs this member in.
    const loginAt = Date.now() - 1000;
    const loginRequested = await api(
      request,
      "POST",
      "/authn/email-auth/request-code/",
      { body: { email: altEmail, source: "login" } },
    );
    expect(loginRequested.status).toBe(202);
    const loginCode = await latestVerificationCode(altEmail, loginAt, "login");
    const signedIn = await api(
      request,
      "POST",
      "/authn/email-auth/verify-code/",
      { body: { email: altEmail, code: loginCode } },
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.payload.user).toMatchObject({
      member_uuid: owner.user.id,
      email: altEmail,
    });

    const demotePrimary = await asOwner(
      "PATCH",
      `/authn/contact-emails/${contactId}/`,
      { email_type: "secondary" },
    );
    expect(demotePrimary.status).toBe(400);
    expect(demotePrimary.payload).toEqual({
      email_type: [
        "The primary email cannot be demoted directly. Make another verified email primary first.",
      ],
    });
    const patched = await asOwner(
      "PATCH",
      `/authn/contact-emails/${formerPrimaryId}/`,
      { email_type: "other", subscribe: false },
    );
    expect(patched.status).toBe(200);
    expect(patched.payload).toMatchObject({
      id: formerPrimaryId,
      email_type: "other",
      subscribe: false,
    });

    const removed = await asOwner(
      "DELETE",
      `/authn/contact-emails/${formerPrimaryId}/`,
    );
    expect(removed.status).toBe(204);
    expect((await asOwner("GET", "/authn/contact-emails/")).payload).toEqual(
      [],
    );
    expect(await accountEmails()).toEqual([altEmail]);
    const removedAgain = await asOwner(
      "DELETE",
      `/authn/contact-emails/${formerPrimaryId}/`,
    );
    expect(removedAgain.status).toBe(404);

    // The last verified address is the only way back in, so it stays.
    const lastOne = await asOwner(
      "DELETE",
      `/authn/contact-emails/${contactId}/`,
    );
    expect(lastOne.status).toBe(409);
    expect(lastOne.payload).toEqual({
      detail:
        "You can't remove your only verified recovery method. Add and verify another email first.",
    });
    expect(await accountEmails()).toEqual([altEmail]);
  });
});

test.describe("Password by emailed code", () => {
  chromiumOnly();

  test("a passwordless account sets a password with an emailed code, old tokens stop working, and the password then signs in", async ({
    request,
  }) => {
    const runId = newRunId();
    const email = `password-change-${runId}@example.com`;
    const newPassword = `Releviz-Change-${runId}!`;
    const member = await registerAccountViaApi(request, email, "Pat", "Change");
    const asMember = (method, url, body, token = member.access) =>
      api(request, method, url, { token, body });

    expect(
      (await api(request, "POST", "/authn/change-password/request-code/"))
        .status,
    ).toBe(401);
    const notMine = await asMember(
      "POST",
      "/authn/change-password/request-code/",
      { email: `password-stranger-${runId}@example.com` },
    );
    expect(notMine.status).toBe(400);
    expect(notMine.payload).toEqual({
      email: ["This email is not eligible for password change verification."],
    });

    const requestedAt = Date.now() - 1000;
    const requested = await asMember(
      "POST",
      "/authn/change-password/request-code/",
      {},
    );
    expect(requested.status).toBe(202);
    expect(requested.payload).toEqual({
      message: "Verification code sent.",
      destination: maskedEmail(email),
    });
    const code = await emailedCode(email, requestedAt, PASSWORD_CHANGE_SUBJECT);

    const wrong = await asMember(
      "POST",
      "/authn/change-password/verify-code/",
      { code: differentCode(code) },
    );
    expect(wrong.status).toBe(400);
    expect(wrong.payload).toEqual({ detail: [VERIFICATION_INVALID] });
    const accepted = await asMember(
      "POST",
      "/authn/change-password/verify-code/",
      { code },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.payload.message).toBe("Verification code accepted.");
    const verificationToken = accepted.payload.verification_token;
    expect(verificationToken).toBeTruthy();

    // Plaintext, mismatched and too-short passwords are refused without
    // spending the token.
    const plaintext = await asMember(
      "POST",
      "/authn/change-password/confirm/",
      {
        verification_token: verificationToken,
        new_password: newPassword,
        new_password_confirm: newPassword,
      },
    );
    expect(plaintext.status).toBe(400);
    expect(plaintext.payload).toEqual({
      new_password: ["Encrypted password required."],
    });
    const mismatched = await asMember(
      "POST",
      "/authn/change-password/confirm/",
      {
        verification_token: verificationToken,
        ...(await encryptedPair(request, newPassword, `${newPassword}x`)),
      },
    );
    expect(mismatched.status).toBe(400);
    expect(mismatched.payload).toEqual({
      new_password_confirm: ["Passwords do not match."],
    });
    const tooShort = await asMember("POST", "/authn/change-password/confirm/", {
      verification_token: verificationToken,
      ...(await encryptedPair(request, "Sh0rt!")),
    });
    expect(tooShort.status).toBe(400);
    expect(tooShort.payload).toEqual({
      new_password: ["Password must be at least 8 characters."],
    });

    // Registration by emailed code left no usable password.
    const before = await passwordLoginViaApi(request, email, newPassword);
    expect(before.response.status()).toBe(400);

    const confirmed = await asMember(
      "POST",
      "/authn/change-password/confirm/",
      {
        verification_token: verificationToken,
        ...(await encryptedPair(request, newPassword)),
      },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.payload).toEqual({
      message: "Password changed successfully.",
    });

    // Access tokens carry the password they were issued under.
    expect((await asMember("GET", "/authn/profile/")).status).toBe(401);

    const signedIn = await passwordLoginViaApi(request, email, newPassword);
    expect(signedIn.response.status()).toBe(200);
    expect(signedIn.payload.user.member_uuid).toBe(member.user.id);
    const profile = await asMember(
      "GET",
      "/authn/profile/",
      undefined,
      signedIn.payload.access,
    );
    expect(profile.status).toBe(200);
    expect(profile.payload.email).toBe(email);
    const wrongPassword = await passwordLoginViaApi(
      request,
      email,
      `${newPassword}x`,
    );
    expect(wrongPassword.response.status()).toBe(400);

    // The verification token is single-use.
    const replayed = await asMember(
      "POST",
      "/authn/change-password/confirm/",
      {
        verification_token: verificationToken,
        ...(await encryptedPair(request, `${newPassword}-2`)),
      },
      signedIn.payload.access,
    );
    expect(replayed.status).toBe(400);
    expect(replayed.payload).toEqual({
      detail: "Verification link is invalid or has expired.",
    });
    expect(
      (
        await passwordLoginViaApi(request, email, newPassword)
      ).response.status(),
    ).toBe(200);
  });
});

test.describe("Profile fields without a screen", () => {
  chromiumOnly();

  test("the middle name is saved and the profile image upload checks size, type and content", async ({
    request,
  }) => {
    const runId = newRunId();
    const member = await registerAccountViaApi(
      request,
      `profile-image-${runId}@example.com`,
      "Ima",
      "Upload",
    );
    const profile = async () => {
      const read = await api(request, "GET", "/authn/profile/", {
        token: member.access,
      });
      expect(read.status).toBe(200);
      return read.payload;
    };
    const patch = (options) =>
      api(request, "PATCH", "/authn/profile/", {
        token: member.access,
        ...options,
      });
    const upload = (name, mimeType, buffer) =>
      patch({ multipart: { profile_image: { name, mimeType, buffer } } });

    expect(
      (await api(request, "PATCH", "/authn/profile/", { body: {} })).status,
    ).toBe(401);
    expect(await profile()).toMatchObject({
      first_name: "Ima",
      middle_name: "",
      last_name: "Upload",
      profile_image: null,
    });

    const named = await patch({ body: { middle_name: "Quinn" } });
    expect(named.status).toBe(200);
    expect(named.payload).toMatchObject({
      first_name: "Ima",
      middle_name: "Quinn",
      last_name: "Upload",
    });
    const tooLong = await patch({ body: { middle_name: "M".repeat(256) } });
    expect(tooLong.status).toBe(400);
    expect(tooLong.payload).toHaveProperty("middle_name");
    const blankFirst = await patch({ body: { first_name: "" } });
    expect(blankFirst.status).toBe(400);
    expect(blankFirst.payload).toHaveProperty("first_name");
    expect((await profile()).middle_name).toBe("Quinn");

    const uploaded = await upload("avatar.png", "image/png", PNG_BYTES);
    expect(uploaded.status).toBe(200);
    const dataUri = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
    expect(uploaded.payload.profile_image).toBe(dataUri);
    expect(await profile()).toMatchObject({
      middle_name: "Quinn",
      profile_image: dataUri,
    });

    const refusals = [
      [
        "a file over 5 MB",
        [
          "huge.png",
          "image/png",
          Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]),
        ],
        "Profile image must be 5 MB or smaller.",
      ],
      [
        "a type that is not an image",
        ["notes.txt", "text/plain", Buffer.from("plain text")],
        "Profile image must be a JPEG, PNG, GIF, or WebP file.",
      ],
      [
        "an SVG",
        [
          "vector.svg",
          "image/svg+xml",
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        ],
        "Profile image must be a JPEG, PNG, GIF, or WebP file.",
      ],
      [
        "an image type whose bytes are not an image",
        ["fake.png", "image/png", Buffer.from("<script>alert(1)</script>")],
        "File content does not match an allowed image type (JPEG, PNG, GIF, WebP).",
      ],
    ];
    for (const [what, file, detail] of refusals) {
      const refused = await upload(...file);
      expect(refused.status, what).toBe(400);
      expect(refused.payload, what).toEqual({ detail });
    }
    // Nothing refused replaced the saved image.
    expect((await profile()).profile_image).toBe(dataUri);

    const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
    const gifUpload = await upload("avatar.gif", "image/gif", gif);
    expect(gifUpload.status).toBe(200);
    expect(gifUpload.payload.profile_image).toBe(
      `data:image/gif;base64,${gif.toString("base64")}`,
    );
  });

  test("a RIFF file that is not WebP is refused as a WebP profile image", async ({
    request,
  }) => {
    const member = await registerAccountViaApi(
      request,
      `profile-riff-${newRunId()}@example.com`,
      "Rif",
      "Wave",
    );
    // A WAV header: a RIFF container whose form type is WAVE, not WEBP.
    const wave = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.from([36, 0, 0, 0]),
      Buffer.from("WAVEfmt ", "latin1"),
      Buffer.alloc(24),
    ]);
    const refused = await api(request, "PATCH", "/authn/profile/", {
      token: member.access,
      multipart: {
        profile_image: {
          name: "sound.webp",
          mimeType: "image/webp",
          buffer: wave,
        },
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.payload).toEqual({
      detail:
        "File content does not match an allowed image type (JPEG, PNG, GIF, WebP).",
    });
  });
});

test.describe("Legacy email-code routes", () => {
  test("the legacy login-code request answers unknown addresses alike and its code signs in once", async ({
    browserName,
    request,
  }) => {
    chromiumOnlyInBody(browserName);
    const runId = newRunId();
    const email = `legacy-login-${runId}@example.com`;
    const unknown = `legacy-login-nobody-${runId}@example.com`;
    const member = await registerAccountViaApi(request, email, "Lee", "Legacy");

    const invalid = await api(request, "POST", "/authn/login/request-code/", {
      body: { email: "not-an-email" },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.payload).toHaveProperty("email");

    // An unknown address gets the same answer and no code is issued.
    const nobody = await api(request, "POST", "/authn/login/request-code/", {
      body: { email: unknown },
    });
    expect(nobody.status).toBe(202);
    expect(nobody.payload).toEqual({
      message: LOGIN_CODE_SENT,
      resend_after: 60,
    });
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
    const requested = await api(request, "POST", "/authn/login/request-code/", {
      body: { email: email.toUpperCase() },
    });
    expect(requested.status).toBe(202);
    expect(requested.payload).toEqual({
      message: LOGIN_CODE_SENT,
      resend_after: 60,
    });
    const code = await latestVerificationCode(email, requestedAt, "login");

    const verify = (body) =>
      api(request, "POST", "/authn/login/verify-code/", { body });
    const malformed = await verify({ email, code: "12a456" });
    expect(malformed.status).toBe(400);
    expect(malformed.payload).toEqual({
      code: ["Code must be a 6-digit number."],
    });
    const wrong = await verify({ email, code: differentCode(code) });
    expect(wrong.status).toBe(400);
    expect(wrong.payload).toEqual({ detail: [VERIFICATION_INVALID] });
    const signedIn = await verify({ email, code });
    expect(signedIn.status).toBe(200);
    expect(signedIn.payload.message).toBe("Login successful.");
    expect(signedIn.payload.user).toMatchObject({
      member_uuid: member.user.id,
      email,
      first_name: "Lee",
      last_name: "Legacy",
    });
    expect(signedIn.response.headers()["set-cookie"]).toContain(
      "releviz_refresh=",
    );
    const replayed = await verify({ email, code });
    expect(replayed.status).toBe(400);
    expect(replayed.payload).toEqual({ detail: [VERIFICATION_INVALID] });
  });

  test("the legacy login-code email's one-click link signs in through the link page, once", async ({
    page,
    request,
  }) => {
    const email = `legacy-link-${newRunId()}@example.com`;
    await registerAccountViaApi(request, email, "Lina", "Legacy");

    // The email's one-click link carries flow=login, which the link page
    // verifies through the legacy login endpoint.
    const requestedAt = Date.now() - 1000;
    const requested = await api(request, "POST", "/authn/login/request-code/", {
      body: { email },
    });
    expect(requested.status).toBe(202);
    const link = await latestAuthLink(email, requestedAt, "login");
    expect(link.params.get("flow")).toBe("login");
    expect(link.params.get("source")).toBe("login");
    expect(link.url.startsWith(`${FRONTEND_URL}/email-auth-link#`)).toBe(true);

    const verified = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/authn/login/verify-code/" &&
        response.request().method() === "POST",
    );
    await page.goto(link.url);
    expect((await verified).status()).toBe(200);
    await expectDashboard(page);
    await expect(
      page.getByRole("button", { name: "Lina Legacy", exact: true }),
    ).toBeVisible();

    // The link is spent: opening it again fails on the link page.
    const spent = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/authn/login/verify-code/" &&
        response.request().method() === "POST",
    );
    await page.goto(link.url);
    expect((await spent).status()).toBe(400);
    await expect(
      page.getByRole("heading", { level: 1, name: "Link verification failed" }),
    ).toBeVisible();
    await expect(page.getByText(VERIFICATION_INVALID)).toBeVisible();
  });

  test("password registration and the registration resend activate an account that signs in with that password", async ({
    browserName,
    request,
  }) => {
    chromiumOnlyInBody(browserName);
    const runId = newRunId();
    const email = `legacy-register-${runId}@example.com`;
    const password = `Releviz-Register-${runId}!`;
    const register = async (
      fields,
      encrypt = ["password", "password_confirm"],
    ) =>
      api(request, "POST", "/authn/register/", {
        body: encrypt.length
          ? await encryptPasswordFields(request, fields, encrypt)
          : fields,
      });
    const base = {
      email,
      password,
      password_confirm: password,
      first_name: "Rae",
      last_name: "Register",
    };

    const unknown = await api(request, "POST", "/authn/register/resend-code/", {
      body: { email },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.payload).toEqual({
      email: "No pending registration was found for this email.",
    });

    const plaintext = await register(base, []);
    expect(plaintext.status).toBe(400);
    expect(plaintext.payload).toEqual({
      password: ["Encrypted password required."],
    });
    const mismatched = await register({
      ...base,
      password_confirm: `${password}x`,
    });
    expect(mismatched.status).toBe(400);
    expect(mismatched.payload).toEqual({
      password_confirm: ["Passwords do not match."],
    });
    const tagged = await register({ ...base, first_name: "<b>Rae</b>" });
    expect(tagged.status).toBe(400);
    expect(tagged.payload).toEqual({
      first_name: ["First name must not contain HTML tags."],
    });

    const startedAt = Date.now() - 1000;
    const started = await register(base);
    expect(started.status, JSON.stringify(started.payload)).toBe(202);
    expect(started.payload).toEqual({
      message:
        "Registration started. Check your email for a verification code.",
      next_step: "verify_code",
    });
    const firstLink = await latestAuthLink(email, startedAt, "register");
    expect(firstLink.params.get("flow")).toBe("register");
    expect(firstLink.params.get("source")).toBe("register");

    // Until the address is verified the password does not sign in.
    const early = await passwordLoginViaApi(request, email, password);
    expect(early.response.status()).toBe(400);

    const tooSoon = await api(request, "POST", "/authn/register/resend-code/", {
      body: { email },
    });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.payload).toEqual({
      detail: VERIFICATION_THROTTLED,
      retry_after: expect.any(Number),
    });
    // The wait is what is left of the cooldown, in the header too.
    expect(tooSoon.payload.retry_after).toBeGreaterThan(0);
    expect(tooSoon.payload.retry_after).toBeLessThanOrEqual(60);
    expect(tooSoon.response.headers()["retry-after"]).toBe(
      String(tooSoon.payload.retry_after),
    );
    expect(expireResendCooldown(email)).toBe(1);
    const resentAt = Date.now() - 1000;
    const resent = await api(request, "POST", "/authn/register/resend-code/", {
      body: { email: email.toUpperCase() },
    });
    expect(resent.status).toBe(202);
    expect(resent.payload).toEqual({
      message: "Verification code sent.",
      resend_after: 60,
    });
    const secondCode = await latestVerificationCode(
      email,
      resentAt,
      "register",
      { notCode: firstLink.code },
    );

    const superseded = await api(
      request,
      "POST",
      "/authn/register/verify-code/",
      { body: { email, code: firstLink.code } },
    );
    expect(superseded.status).toBe(400);
    expect(superseded.payload).toEqual({ detail: [VERIFICATION_INVALID] });
    const registered = await api(
      request,
      "POST",
      "/authn/register/verify-code/",
      { body: { email, code: secondCode } },
    );
    expect(registered.status).toBe(200);
    expect(registered.payload.message).toBe(
      "Email verified. Registration successful.",
    );
    expect(registered.payload.user).toMatchObject({
      email,
      email_verified: true,
      is_active: true,
      first_name: "Rae",
      last_name: "Register",
    });

    const signedIn = await passwordLoginViaApi(request, email, password);
    expect(signedIn.response.status()).toBe(200);
    expect(signedIn.payload.user.member_uuid).toBe(
      registered.payload.user.member_uuid,
    );

    // Once the account is active there is nothing left to resend, and the
    // address cannot start another registration.
    const afterwards = await api(
      request,
      "POST",
      "/authn/register/resend-code/",
      { body: { email } },
    );
    expect(afterwards.status).toBe(400);
    expect(afterwards.payload).toEqual({
      email: "No pending registration was found for this email.",
    });
    const again = await register(base);
    expect(again.status).toBe(400);
    expect(again.payload).toEqual({
      email: ["Unable to register with this email address."],
    });
  });
});

test.describe("Newsletter subscription", () => {
  chromiumOnly();

  test("a newsletter subscription carries into the account and the unsubscribe link ends it once", async ({
    request,
  }) => {
    const runId = newRunId();
    const email = `subscriber-${runId}@example.com`;

    const invalid = await api(request, "POST", "/authn/subscribe/", {
      body: { email: "not-an-email" },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.payload).toHaveProperty("email");

    const subscribed = await api(request, "POST", "/authn/subscribe/", {
      body: { email: email.toUpperCase() },
    });
    expect(subscribed.status).toBe(201);
    expect(subscribed.payload).toEqual({
      message: "You have been subscribed successfully.",
    });
    const subscriberRows = () =>
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
    const subscribedRows = subscriberRows();
    expect(subscribedRows).toHaveLength(1);
    const [anonymousRow] = subscribedRows;
    expect(anonymousRow).toMatchObject({
      email,
      member: null,
      type: "other",
      subscribe: true,
    });
    const again = await api(request, "POST", "/authn/subscribe/", {
      body: { email },
    });
    expect(again.status).toBe(200);
    expect(subscriberRows()).toHaveLength(1);

    // Signing up with that address claims the subscription row.
    const member = await registerAccountViaApi(request, email, "Sue", "Scribe");
    const claimedRows = subscriberRows();
    // Claimed, not duplicated.
    expect(claimedRows).toHaveLength(1);
    const [claimedRow] = claimedRows;
    expect(claimedRow).toMatchObject({
      id: anonymousRow.id,
      member: member.user.id,
      type: "primary",
      subscribe: true,
    });
    const readProfile = async () => {
      const profile = await api(request, "GET", "/authn/profile/", {
        token: member.access,
      });
      expect(profile.status).toBe(200);
      return profile.payload;
    };
    expect(await readProfile()).toMatchObject({
      email,
      email_subscribe: true,
      primary_email_id: anonymousRow.id,
    });

    // No email carries the signed unsubscribe link yet, so the token is
    // minted with the backend helper the link builder uses.
    const token = runDjangoJson(
      `
from apps.authn.models import Member
from apps.authn.services.account.unsubscribe import build_unsubscribe_login_token

print(json.dumps(build_unsubscribe_login_token(Member.objects.get(pk=data["member"]))))
`,
      { member: member.user.id },
    );

    const unsubscribe = (value) =>
      api(request, "POST", "/authn/unsubscribe-login/", {
        body: { token: value },
      });
    const missing = await unsubscribe("  ");
    expect(missing.status).toBe(400);
    expect(missing.payload).toEqual({ detail: "Token is required." });
    const tampered = await unsubscribe(`${token.slice(0, -2)}xx`);
    expect(tampered.status).toBe(400);
    expect(tampered.payload).toEqual({
      detail: "Invalid or expired unsubscribe link.",
    });

    const unsubscribed = await unsubscribe(token);
    expect(unsubscribed.status).toBe(200);
    // The link unsubscribes without signing anyone in.
    expect(unsubscribed.payload).toEqual({
      message: "You have been unsubscribed.",
      unsubscribed: true,
    });
    expect(unsubscribed.response.headers()["set-cookie"]).toBeUndefined();
    expect((await readProfile()).email_subscribe).toBe(false);

    const replayed = await unsubscribe(token);
    expect(replayed.status).toBe(400);
    expect(replayed.payload).toEqual({
      detail: "This unsubscribe link has already been used.",
    });

    // Subscribing again re-enables the account's address.
    const resubscribed = await api(request, "POST", "/authn/subscribe/", {
      body: { email },
    });
    expect(resubscribed.status).toBe(200);
    expect((await readProfile()).email_subscribe).toBe(true);
  });
});

test.describe("Origin check on cookie-bearing auth endpoints", () => {
  chromiumOnly();

  test("refresh, login, logout, code verification, session revocation and impersonation refuse a foreign Origin without spending anything", async ({
    request,
  }) => {
    const runId = newRunId();
    const email = `origin-check-${runId}@example.com`;
    const password = `Releviz-Origin-${runId}!`;
    const member = await registerAccountViaApi(request, email, "Ora", "Gin");
    const foreign = { Origin: FOREIGN_ORIGIN };
    const refresh = (headers = {}) =>
      api(request, "POST", "/authn/refresh/", { headers, body: {} });

    // The refresh cookie from registration is live, and a refused refresh
    // neither rotates nor clears it.
    const refused = await refresh(foreign);
    expect(refused.status).toBe(403);
    expect(refused.payload).toEqual(ORIGIN_REFUSED);
    expect(refused.response.headers()["set-cookie"]).toBeUndefined();
    const refreshed = await refresh({ Origin: new URL(FRONTEND_URL).origin });
    expect(refreshed.status).toBe(200);
    expect(refreshed.payload.user.member_uuid).toBe(member.user.id);
    // The API's own origin is trusted too.
    expect(
      (await refresh({ Origin: new URL(BACKEND_URL).origin })).status,
    ).toBe(200);

    const logout = await api(request, "POST", "/authn/logout/", {
      headers: foreign,
    });
    expect(logout.status).toBe(403);
    expect(logout.payload).toEqual(ORIGIN_REFUSED);
    const sessions = await api(request, "DELETE", "/authn/sessions/", {
      token: refreshed.payload.access,
      headers: foreign,
      body: { all: true },
    });
    expect(sessions.status).toBe(403);
    expect(sessions.payload).toEqual(ORIGIN_REFUSED);
    // Neither refused call ended the session.
    const stillSignedIn = await refresh();
    expect(stillSignedIn.status).toBe(200);

    setAccountPassword(email, password);
    const passwordLogin = await api(request, "POST", "/authn/login/", {
      headers: foreign,
      body: await encryptPasswordFields(request, { email, password }, [
        "password",
      ]),
    });
    expect(passwordLogin.status).toBe(403);
    expect(passwordLogin.payload).toEqual(ORIGIN_REFUSED);

    // A refused verification does not consume the code.
    const codeAt = Date.now() - 1000;
    expect(
      (
        await api(request, "POST", "/authn/email-auth/request-code/", {
          body: { email, source: "login" },
        })
      ).status,
    ).toBe(202);
    const code = await latestVerificationCode(email, codeAt, "login");
    for (const path of [
      "/authn/email-auth/verify-code/",
      "/authn/login/verify-code/",
      "/authn/register/verify-code/",
    ]) {
      const verify = await api(request, "POST", path, {
        headers: foreign,
        body: { email, code },
      });
      expect(verify.status, path).toBe(403);
      expect(verify.payload, path).toEqual(ORIGIN_REFUSED);
    }
    const impersonate = await api(
      request,
      "POST",
      "/authn/impersonate-login/",
      {
        headers: foreign,
        body: { token: crypto.randomUUID() },
      },
    );
    expect(impersonate.status).toBe(403);
    expect(impersonate.payload).toEqual(ORIGIN_REFUSED);

    const verified = await api(
      request,
      "POST",
      "/authn/email-auth/verify-code/",
      {
        headers: { Origin: new URL(FRONTEND_URL).origin },
        body: { email, code },
      },
    );
    expect(verified.status).toBe(200);
    expect(verified.payload.user.member_uuid).toBe(member.user.id);

    // A trusted Origin passes the check and reaches the real work.
    const loggedOut = await api(request, "POST", "/authn/logout/", {
      headers: { Origin: new URL(FRONTEND_URL).origin },
    });
    expect(loggedOut.status).toBe(204);
    expect((await refresh()).status).toBe(401);
  });
});

test.describe("Verification email delivery failure", () => {
  // The API validates this address, but its domain (with U+FFFD in it) has
  // no IDNA encoding, so Django's mailer raises while building the message.
  // That is a real delivery failure that touches only this test's address.
  const undeliverable = (runId) =>
    `undeliverable-${runId}@releviz\uFFFD.example`;

  test("a failed send answers 503 and restores the code it would have replaced", async ({
    browserName,
    request,
  }) => {
    chromiumOnlyInBody(browserName);
    const runId = newRunId();
    const email = undeliverable(runId);
    const challenges = () =>
      runDjangoJson(
        `
from apps.authn.models import EmailAuthChallenge

rows = EmailAuthChallenge.objects.filter(target_email__iexact=data["email"]).order_by("created_at")
print(json.dumps([{"id": str(row.pk), "status": row.status} for row in rows]))
`,
        { email },
      );

    const failed = await api(
      request,
      "POST",
      "/authn/email-auth/request-code/",
      {
        body: { email, source: "login" },
      },
    );
    expect(failed.status).toBe(503);
    expect(failed.payload).toEqual({ detail: DELIVERY_FAILED });
    // The code that could not be sent was withdrawn.
    expect(challenges()).toEqual([]);

    // A pending code from before (issued by the product's own challenge
    // service, outside its cooldown) survives a failed resend.
    const earlier = runDjangoJson(
      `
from datetime import timedelta

from django.utils import timezone

from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.services.email.challenges.issue import create_challenge_record

member = ContactEmail.objects.get(email_address__iexact=data["email"]).member
challenge, code, _ = create_challenge_record(
    member=member,
    purpose=EmailAuthChallenge.Purpose.REGISTER,
    target_email=data["email"],
)
EmailAuthChallenge.objects.filter(pk=challenge.pk).update(
    last_sent_at=timezone.now() - timedelta(seconds=61)
)
print(json.dumps({"id": str(challenge.pk), "code": code}))
`,
      { email },
    );
    const resend = await api(
      request,
      "POST",
      "/authn/email-auth/request-code/",
      {
        body: { email, source: "login" },
      },
    );
    expect(resend.status).toBe(503);
    expect(resend.payload).toEqual({ detail: DELIVERY_FAILED });
    expect(challenges()).toEqual([{ id: earlier.id, status: "pending" }]);

    const verified = await api(
      request,
      "POST",
      "/authn/email-auth/verify-code/",
      {
        body: { email, code: earlier.code },
      },
    );
    expect(verified.status).toBe(200);
    expect(verified.payload.message).toBe(
      "Email verified. Registration successful.",
    );
  });

  test("the sign-in form shows the delivery failure and stays on the email step", async ({
    page,
  }) => {
    const email = undeliverable(newRunId());
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { level: 1, name: "Welcome to Releviz" }),
    ).toBeVisible();
    await page.getByLabel("Email").fill(email);
    const requested = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/authn/email-auth/request-code/" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    expect((await requested).status()).toBe(503);
    await expect(
      page
        .getByRole("main")
        .getByRole("alert")
        .filter({ hasText: DELIVERY_FAILED }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Verify Your Identity" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Email")).toHaveValue(email);
  });
});
