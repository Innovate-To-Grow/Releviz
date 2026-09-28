const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const {
  BACKEND_URL,
  FRONTEND_URL,
  apiJson,
  continueWithEmail,
  createEvent,
  invitationLinkFromEmail,
  latestAuthLink,
  latestEmailFor,
  latestVerificationCode,
  loginWithEmailCode,
  newRunId,
  openAccountMenu,
  ownResponse,
  readSession,
  registerAccount,
  registerAccountViaApi,
  requestEmailCode,
  runDjangoJson,
  setLifecycleViaApi,
  submitResponse,
  tempAccessSessionState,
  temporaryAccessPathFromEmail,
} = require("./helpers/releviz");
const {
  addPersonApi,
  invitationEmail,
  rosterByEmail,
  rosterEntries,
  sendInvitationsApi,
} = require("./helpers/participants");
const { DAY_MS } = require("./helpers/time");

// How people get in and find their way around: the home page's calls to
// action signed out and signed in, the event code forms on home and on the
// dashboard, the sign-in and profile-completion detours an event link takes
// (and the respond intent that joins the person on arrival), a temporary
// identity claiming itself through the event's email sign-in, the dashboard's
// cards and empty, archived and failure states, the header and footer links,
// the account menu and log out, and the settings sidebar and current-device
// sign-out. Every test works on its own accounts and events.

const HOME_HEADING = "Find a time that works for everyone.";
const CODE_HELP =
  "We'll verify your email, then bring you straight to the event.";
const SIGNED_OUT_NOTE = "Continue with your email to create a free account.";

// A stubbed backend answer. The web app calls the API cross-origin with
// credentials, so the stub carries the CORS headers the real API sends.
function fulfillJson(route, status, body) {
  const origin =
    route.request().headers().origin || new URL(FRONTEND_URL).origin;
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
    },
    body: JSON.stringify(body),
  });
}

// Next.js renders its own route announcer with role=alert, so alerts are
// always picked out by their text.
function alertWith(page, text) {
  return page.getByRole("alert").filter({ hasText: text });
}

// A route matcher for one API endpoint, whatever its query string (no web
// page shares these paths).
function isApiPath(pathname) {
  return (url) => url.pathname === pathname;
}

function homeUrl() {
  return /^https?:\/\/[^/]+\/$/;
}

function eventUrl(code) {
  return new RegExp(`/event\\?code=${code}$`);
}

function loginForEventUrl(code) {
  return new RegExp(`/login\\?next=%2Fevent%3Fcode%3D${code}$`);
}

function completeProfileForEventUrl(code) {
  return new RegExp(
    `/settings\\?complete_profile=1&next=%2Fevent%3Fcode%3D${code}$`,
  );
}

// The create button stays disabled while the session loads; once it is
// enabled the page is hydrated and knows who is signed in.
async function gotoHome(page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: HOME_HEADING }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create a scheduling poll" }),
  ).toBeEnabled();
}

async function openCodeFromHome(page, typed) {
  await gotoHome(page);
  await page.getByRole("textbox", { name: "Event code" }).fill(typed);
  await page.getByRole("button", { name: "Open event" }).click();
}

// "Continue to event" reloads the event with respond=1, and the event page
// drops that parameter once it has acted on it.
async function continueToEvent(page, code) {
  const arrival = page.waitForURL(
    new RegExp(`/event\\?code=${code}&respond=1$`),
    { waitUntil: "commit" },
  );
  await page.getByRole("button", { name: "Continue to event" }).click();
  await arrival;
  await expect(page).toHaveURL(eventUrl(code));
}

async function completeProfile(page, firstName, lastName) {
  await page.getByRole("textbox", { name: "First name" }).fill(firstName);
  await page.getByRole("textbox", { name: "Last name" }).fill(lastName);
}

function welcomeHeading(page, displayName) {
  return page.getByRole("heading", {
    level: 2,
    name: new RegExp(`^Welcome, ${displayName}`),
  });
}

async function joinViaApi(request, token, code) {
  const joined = await apiJson(
    request,
    "POST",
    `/events/participants?code=${code}`,
    token,
    {},
  );
  expect(joined.response.status(), JSON.stringify(joined.payload)).toBe(201);
  return joined.payload.participant;
}

async function invitationFor(request, token, code, email) {
  const listed = await apiJson(
    request,
    "GET",
    `/events/invitations?code=${code}`,
    token,
  );
  expect(listed.response.status()).toBe(200);
  return listed.payload.invitations.find(
    (invitation) => invitation.email === email,
  );
}

async function profileStatus(request, token) {
  const profile = await apiJson(request, "GET", "/authn/profile/", token);
  return { status: profile.response.status(), payload: profile.payload };
}

// The refresh cookie is scoped to /authn/, so the lookup names a URL there.
async function hasRefreshCookie(context) {
  return (await context.cookies(`${BACKEND_URL}/authn/refresh/`)).some(
    (cookie) => cookie.name === "releviz_refresh",
  );
}

test.describe("Home page", () => {
  test("signed out, the calls to action go through sign-in and profile completion; signed in, they open the dashboard, the create page and events directly", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `home-${runId}@example.com`;
    const createButton = page.getByRole("button", {
      name: "Create a scheduling poll",
    });
    const accountNav = page.getByRole("navigation", { name: "Account" });
    const codeField = page.getByRole("textbox", { name: "Event code" });
    const openEvent = page.getByRole("button", { name: "Open event" });

    await gotoHome(page);
    await expect(page.getByText(SIGNED_OUT_NOTE)).toBeVisible();
    await expect(codeField).toHaveAccessibleDescription(CODE_HELP);
    await expect(codeField).toHaveAttribute("placeholder", "e.g. ABC123");
    await expect(openEvent).toBeDisabled();
    await codeField.fill("   ");
    await expect(openEvent).toBeDisabled();
    await expect(
      page.getByRole("link", { name: "Go to my dashboard" }),
    ).toHaveCount(0);

    const signIn = accountNav.getByRole("link", { name: "Sign in" });
    await expect(signIn).toHaveAttribute("href", "/login");
    await signIn.click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("heading", { name: "Welcome to Releviz" }),
    ).toBeVisible();

    await gotoHome(page);
    await createButton.click();
    await expect(page).toHaveURL(/\/login\?next=%2Fcreate$/);

    const startedAt = Date.now() - 1000;
    await continueWithEmail(page, email, startedAt, "register");
    await expect(page).toHaveURL(
      /\/settings\?complete_profile=1&next=%2Fcreate$/,
    );
    // Only an event destination gets the event wording.
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue to event" }),
    ).toHaveCount(0);
    await completeProfile(page, "Hana", "Home");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(/\/create$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Create event" }),
    ).toBeVisible();

    const token = (await readSession(page)).access;
    const event = await createEvent(request, token, {
      name: `Home direct ${runId}`,
    });

    await gotoHome(page);
    await expect(
      page.getByRole("button", { name: "Hana Home", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Go to my dashboard" }),
    ).toHaveAttribute("href", "/dashboard");
    await expect(page.getByText(SIGNED_OUT_NOTE)).toHaveCount(0);
    await expect(accountNav).toHaveCount(0);
    await expect(page.getByText(CODE_HELP)).toHaveCount(0);
    await expect(codeField).not.toHaveAttribute("aria-describedby");

    await createButton.click();
    await expect(page).toHaveURL(/\/create$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Create event" }),
    ).toBeVisible();

    // Signed in, a code (typed loosely) opens the event without a detour.
    await openCodeFromHome(page, `  ${event.code.toLowerCase()} `);
    await expect(page).toHaveURL(eventUrl(event.code));
    await expect(
      page.getByRole("heading", { level: 1, name: event.name }),
    ).toBeVisible();
    await expect(page.locator(".event-role-badge")).toHaveText("Organizer");

    await gotoHome(page);
    await page.getByRole("link", { name: "Go to my dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "My Dashboard" }),
    ).toBeVisible();
  });

  test("a new person opens a code from home, registers toward the event from the emailed link, and is joined on arrival", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `onboard-org-${runId}@example.com`,
      "Olga",
      "Owner",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Open onboarding ${runId}`,
      accessMode: "open_link",
    });
    const newEmail = `newcomer-${runId}@example.com`;

    // The code is trimmed and upper-cased, and a signed-out visitor signs in
    // first with the event as the destination.
    await openCodeFromHome(page, ` ${event.code.toLowerCase()}  `);
    await expect(page).toHaveURL(loginForEventUrl(event.code));

    const requestedAt = Date.now() - 1000;
    const codeRequest = page.waitForRequest(
      (candidate) =>
        candidate.method() === "POST" &&
        new URL(candidate.url()).pathname === "/authn/email-auth/request-code/",
    );
    await requestEmailCode(page, newEmail);
    expect((await codeRequest).postDataJSON()).toEqual({
      email: newEmail,
      next: `/event?code=${event.code}`,
      source: "event_registration",
      event: event.code,
    });

    // A new address gets an event-registration link that carries the event.
    const link = await latestAuthLink(newEmail, requestedAt, "register");
    expect(link.params.get("flow")).toBe("auth");
    expect(link.params.get("source")).toBe("event_registration");
    expect(link.params.get("event")).toBe(event.code);
    expect(link.params.get("next")).toBe(`/event?code=${event.code}`);
    expect(link.body).toContain("Continue to Event Registration");

    // The link opens on another device and still leads to the event.
    const linkContext = await browser.newContext();
    try {
      const linkPage = await linkContext.newPage();
      await linkPage.goto(link.url);
      await expect(linkPage).toHaveURL(completeProfileForEventUrl(event.code));
      await expect(
        linkPage.getByRole("heading", {
          level: 1,
          name: "Complete your profile",
        }),
      ).toBeVisible();
      await completeProfile(linkPage, "Nia", "Newcomer");
      await continueToEvent(linkPage, event.code);
      await expect(welcomeHeading(linkPage, "Nia Newcomer")).toContainText(
        "Draft",
      );
      await expect(
        linkPage.getByRole("heading", { name: "Join Event" }),
      ).toHaveCount(0);
    } finally {
      await linkContext.close();
    }

    const entry = (
      await rosterByEmail(request, event.code, organizer.access)
    ).get(newEmail);
    expect(entry).toEqual(
      expect.objectContaining({
        name: "Nia Newcomer",
        accountAccess: "full",
        submitted: false,
      }),
    );
  });
});

test.describe("Event page entry", () => {
  test("a signed-out invitation link records the open, drops its token, and returns to the event after sign-in", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `access-org-${runId}@example.com`,
      "Ada",
      "Access",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Invite link ${runId}`,
    });
    const inviteeEmail = `invitee-${runId}@example.com`;
    await registerAccountViaApi(request, inviteeEmail, "Ivan", "Invitee");

    const invitedAt = Date.now() - 1000;
    await addPersonApi(request, event.code, organizer.access, {
      name: "Ivan Invitee",
      email: inviteeEmail,
      sendInvitation: true,
    });
    const body = await latestEmailFor(inviteeEmail, invitedAt, (message) =>
      message.includes(`/event?code=${event.code}&invitation=`),
    );
    const link = invitationLinkFromEmail(body);
    expect(link).toMatch(
      new RegExp(`/event\\?code=${event.code}&invitation=[0-9a-f-]+$`, "i"),
    );
    expect(
      (await invitationFor(request, organizer.access, event.code, inviteeEmail))
        .openedAt,
    ).toBeNull();

    const signedOut = await browser.newContext();
    try {
      const signedOutPage = await signedOut.newPage();
      await signedOutPage.goto("/event");
      await expect(signedOutPage).toHaveURL(/\/login\?next=%2Fevent$/);

      await signedOutPage.goto(link);
      // The invitation token is dropped before the sign-in detour.
      await expect(signedOutPage).toHaveURL(loginForEventUrl(event.code));
      await expect(
        signedOutPage.getByRole("heading", { name: "Welcome to Releviz" }),
      ).toBeVisible();

      // The open is recorded before the invitee signs in.
      await expect
        .poll(
          async () =>
            (
              await invitationFor(
                request,
                organizer.access,
                event.code,
                inviteeEmail,
              )
            )?.status,
          { timeout: 15_000 },
        )
        .toBe("opened");
      expect(
        (
          await invitationFor(
            request,
            organizer.access,
            event.code,
            inviteeEmail,
          )
        ).openedAt,
      ).not.toBeNull();

      await continueWithEmail(
        signedOutPage,
        inviteeEmail,
        Date.now() - 1000,
        "login",
      );
      await expect(signedOutPage).toHaveURL(eventUrl(event.code));
      await expect(welcomeHeading(signedOutPage, "Ivan Invitee")).toBeVisible();
    } finally {
      await signedOut.close();
    }
  });

  test("an incomplete profile finishes before the event opens, keeps the event as its destination through sign-in, and then joins it", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `gate-org-${runId}@example.com`,
      "Gina",
      "Gate",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Profile gate ${runId}`,
      accessMode: "open_link",
    });
    const email = `gate-${runId}@example.com`;
    const completionUrl = completeProfileForEventUrl(event.code);

    // A signed-out completion link nests its own destination in next=.
    await page.goto(
      `/settings?complete_profile=1&next=${encodeURIComponent(`/event?code=${event.code}`)}`,
    );
    await expect(page).toHaveURL(
      new RegExp(
        `/login\\?next=%2Fsettings%3Fcomplete_profile%3D1%26next%3D%252Fevent%253Fcode%253D${event.code}$`,
      ),
    );
    await continueWithEmail(page, email, Date.now() - 1000, "register");
    await expect(page).toHaveURL(completionUrl);

    // The event page itself sends an incomplete profile to completion.
    await page.goto(`/event?code=${event.code}`);
    await expect(page).toHaveURL(completionUrl);
    await expect(
      page.getByRole("heading", { level: 1, name: "Complete your profile" }),
    ).toBeVisible();
    await expect(page.getByText("One last step")).toBeVisible();
    const emailField = page.getByRole("textbox", { name: "Email address" });
    await expect(emailField).toHaveValue(email);
    await expect(emailField).not.toBeEditable();
    await expectAccessible(page, "complete profile toward an event");

    // A rejected save explains itself and stays on the step.
    await completeProfile(page, "P".repeat(151), "Profile");
    await page.getByRole("button", { name: "Continue to event" }).click();
    await expect(
      alertWith(page, "Ensure this field has no more than 150 characters."),
    ).toBeVisible();
    await expect(page).toHaveURL(completionUrl);

    await completeProfile(page, "Pat", "Profile");
    await continueToEvent(page, event.code);
    await expect(welcomeHeading(page, "Pat Profile")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Join Event" })).toHaveCount(
      0,
    );
    expect(
      (await rosterByEmail(request, event.code, organizer.access)).get(email)
        ?.name,
    ).toBe("Pat Profile");
  });

  test("a respond intent explains a closed event and a failed join, and the organizer's own intent is simply consumed", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `intent-org-${runId}@example.com`,
      "Ivy",
      "Intent",
    );
    const closed = await createEvent(request, organizer.access, {
      name: `Closed intent ${runId}`,
      accessMode: "open_link",
    });
    await setLifecycleViaApi(request, organizer.access, closed.code, "closed");
    const racing = await createEvent(request, organizer.access, {
      name: `Racing intent ${runId}`,
      accessMode: "open_link",
    });
    await registerAccount(
      page,
      `intent-${runId}@example.com`,
      "Rory",
      "Respond",
    );
    const joinRequests = [];
    page.on("request", (candidate) => {
      const url = new URL(candidate.url());
      if (
        candidate.method() === "POST" &&
        url.pathname === "/events/participants"
      ) {
        joinRequests.push(url.searchParams.get("code"));
      }
    });
    const joinPanel = page.getByRole("heading", { name: "Join Event" });

    // A closed event is not joined at all.
    await page.goto(`/event?code=${closed.code}&respond=1`);
    await expect(
      alertWith(page, "This event is no longer accepting responses."),
    ).toBeVisible();
    await expect(page).toHaveURL(eventUrl(closed.code));
    await expect(joinPanel).toBeVisible();
    expect(joinRequests).toEqual([]);

    // The event closes while the join is on its way: the API's refusal is
    // shown and the intent is still consumed.
    const racingJoin = isApiPath("/events/participants");
    await page.route(
      (url) => racingJoin(url) && url.searchParams.get("code") === racing.code,
      async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        await setLifecycleViaApi(
          request,
          organizer.access,
          racing.code,
          "closed",
        );
        return route.continue();
      },
    );
    await page.goto(`/event?code=${racing.code}&respond=1`);
    await expect(
      alertWith(
        page,
        "We couldn't start your response: Responses cannot change while the event is closed.",
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(eventUrl(racing.code));
    await expect(joinPanel).toBeVisible();
    expect(joinRequests).toEqual([racing.code]);

    // An organizer arriving with the intent opens the workspace and is not
    // added as a participant.
    const own = await createEvent(request, (await readSession(page)).access, {
      name: `Own intent ${runId}`,
    });
    await page.goto(`/event?code=${own.code}&respond=1`);
    await expect(page).toHaveURL(eventUrl(own.code));
    await expect(page.locator(".event-role-badge")).toHaveText("Organizer");
    await expect(
      page.getByRole("heading", { level: 1, name: own.name }),
    ).toBeVisible();
    const ownRoster = await rosterEntries(
      request,
      own.code,
      (await readSession(page)).access,
    );
    expect(ownRoster.organizerOnRoster).toBe(false);
    expect(ownRoster.participants).toEqual([]);
    expect(joinRequests).toEqual([racing.code]);
  });
});

test.describe("Temporary identity claim", () => {
  test("an invited temporary identity claims itself through the event's email sign-in and lands on its existing response", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `claim-org-${runId}@example.com`,
      "Cleo",
      "Organizer",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Claim ${runId}`,
    });
    const otherEvent = await createEvent(request, organizer.access, {
      name: `Unrelated ${runId}`,
    });
    const claimEmail = `claimant-${runId}@example.com`;
    // The organizer enters this person's response, which creates their
    // temporary identity, participant row and invitation.
    await submitResponse(request, organizer.access, event, {
      name: "Casey Claimant",
      email: claimEmail,
      inperson: [0, 1, 2, 3],
    });
    // The same identity is on a second event's list, with no response yet.
    const secondEvent = await createEvent(request, organizer.access, {
      name: `Second ${runId}`,
    });
    await addPersonApi(request, secondEvent.code, organizer.access, {
      name: "Casey Claimant",
      email: claimEmail,
    });
    const secondEntry = async () =>
      (await rosterByEmail(request, secondEvent.code, organizer.access)).get(
        claimEmail,
      );
    expect(await secondEntry()).toEqual(
      expect.objectContaining({
        accountAccess: "temporary",
        canOrganizerEditAvailability: true,
      }),
    );
    const invitedAt = Date.now() - 1000;
    const entry = (
      await rosterByEmail(request, event.code, organizer.access)
    ).get(claimEmail);
    expect(entry.accountAccess).toBe("temporary");
    await sendInvitationsApi(request, event.code, organizer.access, [entry.id]);
    const invitation = await latestEmailFor(
      claimEmail,
      invitedAt,
      invitationEmail(event.code),
    );

    // Every emailed challenge for this address, counted by purpose.
    const challengesByPurpose = () =>
      runDjangoJson(
        `
from collections import Counter
from apps.authn.models import EmailAuthChallenge
print(json.dumps(Counter(EmailAuthChallenge.objects.filter(
    target_email__iexact=data["email"]
).values_list("purpose", flat=True))))
`,
        { email: claimEmail },
      );

    const tempSessions = () =>
      runDjangoJson(
        `
from apps.authn.models import ContactEmail
from apps.scheduling.models import TemporaryEventSession
member_id = ContactEmail.objects.get(email_address__iexact=data["email"]).member_id
sessions = TemporaryEventSession.objects.filter(member_id=member_id)
print(json.dumps({
    "total": sessions.count(),
    "active": sessions.filter(revoked_at__isnull=True).count(),
}))
`,
        { email: claimEmail },
      );

    // Asking to register toward an event it was not invited to gets the same
    // generic reply as everyone else, and no challenge of any kind (register
    // or login) is issued for the address.
    const blocked = await request.post(
      `${BACKEND_URL}/authn/email-auth/request-code/`,
      {
        data: {
          email: claimEmail,
          source: "event_registration",
          event: otherEvent.code,
          next: `/event?code=${otherEvent.code}`,
        },
      },
    );
    expect(blocked.status()).toBe(202);
    expect(await blocked.json()).toEqual({
      message: "Check your email for a verification code.",
    });
    expect(challengesByPurpose()).toEqual({});

    const tempContext = await browser.newContext();
    try {
      // The temporary link opens a session scoped to this event, which does
      // not count as being signed in on the event page.
      const tempPage = await tempContext.newPage();
      const codeSentAt = Date.now() - 1000;
      await tempPage.goto(temporaryAccessPathFromEmail(invitation));
      await tempPage
        .getByLabel("Verification code")
        .fill(
          await latestVerificationCode(
            claimEmail,
            codeSentAt,
            "temp_event_access",
          ),
        );
      await tempPage
        .getByRole("button", { name: "Verify and open schedule" })
        .click();
      await expect(
        tempPage.getByText("You are responding as Casey Claimant"),
      ).toBeVisible();
      await tempPage.goto(`/event?code=${event.code}`);
      await expect(tempPage).toHaveURL(loginForEventUrl(event.code));
      expect((await tempAccessSessionState(tempPage, event.code)).status).toBe(
        200,
      );
      expect(tempSessions()).toEqual({ total: 1, active: 1 });

      // The event's own sign-in registers the temporary identity.
      await openCodeFromHome(page, event.code);
      await expect(page).toHaveURL(loginForEventUrl(event.code));
      const requestedAt = Date.now() - 1000;
      await requestEmailCode(page, claimEmail);
      await page
        .getByLabel("Verification code")
        .fill(
          await latestVerificationCode(claimEmail, requestedAt, "register"),
        );
      await page.getByRole("button", { name: "Continue", exact: true }).click();

      // The temporary identity holds the roster name as its first name.
      await expect(page).toHaveURL(completeProfileForEventUrl(event.code));
      await expect(
        page.getByRole("textbox", { name: "First name" }),
      ).toHaveValue("Casey Claimant");
      await expect(
        page.getByRole("textbox", { name: "Last name" }),
      ).toHaveValue("");
      await completeProfile(page, "Casey", "Claimant");
      await continueToEvent(page, event.code);
      await expect(welcomeHeading(page, "Casey Claimant")).toContainText(
        "Submitted",
      );
      await expect(
        page.getByRole("heading", { name: "Join Event" }),
      ).toHaveCount(0);

      const own = await ownResponse(
        request,
        (await readSession(page)).access,
        event.code,
      );
      expect(own.availabilityInperson.slice(0, 5)).toEqual([1, 1, 1, 1, 0]);
      const claimed = (
        await rosterEntries(request, event.code, organizer.access)
      ).participants.filter((candidate) => candidate.email === claimEmail);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toEqual(
        expect.objectContaining({
          name: "Casey Claimant",
          accountAccess: "full",
          canOrganizerEditAvailability: false,
          submitted: true,
        }),
      );

      // Every participation became the person's own.
      expect(await secondEntry()).toEqual(
        expect.objectContaining({
          accountAccess: "full",
          canOrganizerEditAvailability: false,
          submitted: false,
        }),
      );

      // Registering revoked the temporary session, and its cookie now asks
      // for a full sign-in.
      expect(tempSessions()).toEqual({ total: 1, active: 0 });
      const tempSession = await tempAccessSessionState(tempPage, event.code);
      expect(tempSession.status).toBe(403);
      expect(tempSession.payload.errorCode).toBe("temp_account_upgraded");
    } finally {
      await tempContext.close();
    }
  });
});

test.describe("Dashboard", () => {
  // The viewer is in New York; the organizer's event keeps Tokyo time.
  test.use({ timezoneId: "America/New_York" });

  test("signed out, the dashboard asks for sign-in first; a new account sees every empty state and can start its first event", async ({
    page,
  }) => {
    const runId = newRunId();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=\/dashboard$/);
    await continueWithEmail(
      page,
      `dash-empty-${runId}@example.com`,
      Date.now() - 1000,
      "register",
    );
    await expect(page).toHaveURL(
      /\/settings\?complete_profile=1&next=%2Fdashboard$/,
    );
    await completeProfile(page, "Dana", "Dash");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await expect(
      page.getByRole("heading", { level: 2, name: "Open an event" }),
    ).toBeVisible();
    await expect(
      page.getByText("Jump straight to any event when you have its code."),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "My Events (0)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No events organized yet." }),
    ).toBeVisible();
    await expect(
      page.getByText("Create an event to start collecting availability."),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Events I Participate In (0)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Not participating in any events yet.",
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Events you join with an invitation or event code appear here.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Archived/ })).toHaveCount(
      0,
    );

    await page.getByRole("link", { name: "Create your first event" }).click();
    await expect(page).toHaveURL(/\/create$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Create event" }),
    ).toBeVisible();
  });

  test("cards show mode, status, code, the deadline in the event's zone and the location, and open the event; an archived-only list says so", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `dash-cards-${runId}@example.com`,
      "Cora",
      "Cards",
    );
    const token = (await readSession(page)).access;
    const deadline = new Date(Date.now() + 4 * DAY_MS);
    deadline.setUTCHours(3, 0, 0, 0);
    const location = `Room 4B ${runId}`;
    const own = await createEvent(request, token, {
      name: `Card own ${runId}`,
      mode: "inperson",
      location,
      timezone: "Asia/Tokyo",
      responseDeadline: deadline.toISOString(),
    });
    const host = await registerAccountViaApi(
      request,
      `dash-host-${runId}@example.com`,
      "Hugo",
      "Host",
    );
    const joined = await createEvent(request, host.access, {
      name: `Card joined ${runId}`,
      mode: "virtual",
      accessMode: "open_link",
    });
    await joinViaApi(request, token, joined.code);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: "My Events (1)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Events I Participate In (1)" }),
    ).toBeVisible();

    const zoned = await page.evaluate(
      (value) => ({
        event: new Date(value).toLocaleString([], {
          timeZone: "Asia/Tokyo",
          timeZoneName: "short",
        }),
        viewer: new Date(value).toLocaleString([], { timeZoneName: "short" }),
      }),
      own.responseDeadline,
    );
    expect(zoned.event).not.toBe(zoned.viewer);
    const ownTitle = page.getByRole("link", { name: own.name, exact: true });
    const ownCard = page.locator("article").filter({ has: ownTitle });
    await expect(ownCard).toContainText("In-Person");
    await expect(ownCard).toContainText(/Status:\s*active/);
    await expect(ownCard).toContainText(`Code: ${own.code}`);
    await expect(ownCard).toContainText(`Deadline: ${zoned.event}`);
    await expect(ownCard).not.toContainText(zoned.viewer);
    await expect(ownCard).toContainText(location);

    const joinedTitle = page.getByRole("link", {
      name: joined.name,
      exact: true,
    });
    const joinedCard = page.locator("article").filter({ has: joinedTitle });
    await expect(joinedCard).toContainText("Virtual");
    await expect(joinedCard).toContainText(`Code: ${joined.code}`);
    await expect(
      page.getByRole("group", { name: `Actions for ${joined.name}` }),
    ).toHaveCount(0);

    await ownTitle.click();
    await expect(page).toHaveURL(eventUrl(own.code));
    await expect(page.locator(".event-role-badge")).toHaveText("Organizer");

    await page.goto("/dashboard");
    await page
      .getByRole("group", { name: `Actions for ${own.name}` })
      .getByRole("link", { name: "View" })
      .click();
    await expect(page).toHaveURL(eventUrl(own.code));
    await expect(
      page.getByRole("heading", { level: 1, name: own.name }),
    ).toBeVisible();

    await page.goto("/dashboard");
    await joinedTitle.click();
    await expect(page).toHaveURL(eventUrl(joined.code));
    await expect(page.locator(".event-role-badge")).toHaveText("Participant");
    await expect(welcomeHeading(page, "Cora Cards")).toBeVisible();

    await setLifecycleViaApi(request, token, own.code, "archived");
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "My Events (0)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No active events." }),
    ).toBeVisible();
    await expect(
      page.getByText("Your archived events are listed below."),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Create your first event" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Archived (1)" }),
    ).toBeVisible();
    await expect(
      page.locator("article").filter({ has: ownTitle }),
    ).toContainText(/Status:\s*archived/);
  });

  test("the Open an event panel opens trimmed, upper-cased codes with Enter or Go and explains unknown ones; a failed load says so", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `dash-code-${runId}@example.com`,
      "Cody",
      "Code",
    );
    const event = await createEvent(request, (await readSession(page)).access, {
      name: `Dash code ${runId}`,
    });
    const codeField = page.getByRole("textbox", { name: "Enter Event Code" });

    await page.reload();
    await codeField.fill(`  ${event.code.toLowerCase()} `);
    await codeField.press("Enter");
    await expect(page).toHaveURL(eventUrl(event.code));
    await expect(
      page.getByRole("heading", { level: 1, name: event.name }),
    ).toBeVisible();

    // Anything typed is upper-cased and encoded, never rejected in the
    // browser; an unknown code is explained on the event page.
    await page.goto("/dashboard");
    await codeField.fill("bad code/!");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page).toHaveURL(/\/event\?code=BAD%20CODE%2F!$/);
    await expect(
      page.getByText("Event unavailable", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Event Not Found" }),
    ).toBeVisible();
    await expect(
      page.getByText("Event not found", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Create New Event" }),
    ).toHaveAttribute("href", "/create");

    await page.route(isApiPath("/dashboard/events"), (route) =>
      fulfillJson(route, 500, { detail: "Server error." }),
    );
    await page.goto("/dashboard");
    await expect(
      alertWith(
        page,
        "Failed to load your events. Please refresh and try again.",
      ),
    ).toBeVisible();
  });
});

test.describe("Header, footer and account menu", () => {
  test("footer links reach the legal pages and home, and the release line shows only in release builds", async ({
    page,
  }) => {
    await gotoHome(page);
    const footer = page.getByRole("contentinfo");
    const footerNav = footer.getByRole("navigation", { name: "Footer" });

    await footerNav.getByRole("link", { name: "Privacy" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Privacy notice" }),
    ).toBeVisible();

    await footerNav.getByRole("link", { name: "Terms" }).click();
    await expect(page).toHaveURL(/\/terms$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Terms of service" }),
    ).toBeVisible();

    await footer.getByRole("link", { name: "Releviz home" }).click();
    await expect(page).toHaveURL(homeUrl());
    await expect(
      page.getByRole("heading", { level: 1, name: HOME_HEADING }),
    ).toBeVisible();

    // The release line is baked in at build time; E2E builds carry no SHA.
    const release = footer.locator("[data-release]");
    const releaseSha = (process.env.NEXT_PUBLIC_RELEASE_SHA || "").trim();
    if (releaseSha) {
      await expect(release).toHaveText(`Release ${releaseSha.slice(0, 7)}`);
      await expect(release).toHaveAttribute("data-release", releaseSha);
    } else {
      await expect(release).toHaveCount(0);
      await expect(footer).not.toContainText("Release");
    }
  });

  test("the account menu names the account, works from the keyboard, closes on Escape or an outside click, and reaches Settings and the dashboard; the header logos go home", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `menu-${runId}@example.com`;
    await registerAccount(page, email, "Mona", "Menu");

    const trigger = page.getByRole("button", {
      name: "Mona Menu",
      exact: true,
    });
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    let { menu } = await openAccountMenu(page, "Mona Menu");
    await expect(menu).toContainText("Mona Menu");
    await expect(menu).toContainText(email);
    await expect(menu.getByRole("menuitem")).toHaveText([
      "My Dashboard",
      "Settings",
      "Log out",
    ]);
    await expectAccessible(page, "open account menu");
    await menu.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Account settings" }),
    ).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);

    // The settings sidebar names the account (the header trigger repeats the
    // name, so the checks stay inside the sidebar).
    const userId = (await readSession(page)).user.id;
    const sidebar = page.getByRole("complementary");
    await expect(sidebar.getByText("Signed in as")).toBeVisible();
    await expect(sidebar.getByText("Mona Menu", { exact: true })).toBeVisible();
    await expect(sidebar.getByText(email)).toBeVisible();
    await expect(sidebar.getByText("Account ID")).toBeVisible();
    await expect(sidebar.getByText(userId, { exact: true })).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect(nav.getByRole("link")).toHaveText([
      "Profile",
      "Active sessions",
      "Password",
      "Danger zone",
    ]);
    const profileLink = nav.getByRole("link", { name: "Profile" });
    const sessionsLink = nav.getByRole("link", { name: "Active sessions" });
    const dangerLink = nav.getByRole("link", { name: "Danger zone" });
    await expect(profileLink).toHaveAttribute("aria-current", "location");
    await sessionsLink.click();
    await expect(page).toHaveURL(/\/settings#sessions$/);
    await expect(sessionsLink).toHaveAttribute("aria-current", "location");
    await expect(profileLink).not.toHaveAttribute("aria-current");
    await dangerLink.click();
    await expect(page).toHaveURL(/\/settings#danger-zone$/);
    await expect(dangerLink).toHaveAttribute("aria-current", "location");
    await expect(sessionsLink).not.toHaveAttribute("aria-current");

    // Arrow keys open the menu from its trigger and cycle through the items.
    const dashboardItem = page.getByRole("menuitem", { name: "My Dashboard" });
    const settingsItem = page.getByRole("menuitem", { name: "Settings" });
    const logoutItem = page.getByRole("menuitem", { name: "Log out" });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(dashboardItem).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(settingsItem).toBeFocused();
    await page.keyboard.press("End");
    await expect(logoutItem).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(dashboardItem).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(logoutItem).toBeFocused();
    await page.keyboard.press("Home");
    await expect(dashboardItem).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    // A pointer press outside the menu closes it.
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page
      .getByRole("heading", { level: 1, name: "Account settings" })
      .click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    ({ menu } = await openAccountMenu(page, "Mona Menu"));
    await menu.getByRole("menuitem", { name: "My Dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "My Dashboard" }),
    ).toBeVisible();

    // The app header's logo goes home.
    await page
      .getByRole("banner")
      .getByRole("link", { name: "Releviz home" })
      .click();
    await expect(page).toHaveURL(homeUrl());
    await expect(
      page.getByRole("heading", { level: 1, name: HOME_HEADING }),
    ).toBeVisible();

    // So does the event header's.
    const event = await createEvent(request, (await readSession(page)).access, {
      name: `Menu logo ${runId}`,
    });
    await page.goto(`/event?code=${event.code}`);
    await expect(
      page.getByRole("heading", { level: 1, name: event.name }),
    ).toBeVisible();
    await page
      .getByRole("banner")
      .getByRole("link", { name: "Releviz", exact: true })
      .click();
    await expect(page).toHaveURL(homeUrl());
    await expect(
      page.getByRole("heading", { level: 1, name: HOME_HEADING }),
    ).toBeVisible();
  });

  test("log out keeps the session when it fails or when the schedule cannot be saved, saves pending changes first, and signs out only this device", async ({
    context,
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `logout-${runId}@example.com`;
    // This API session is the person's other device.
    const other = await registerAccountViaApi(request, email, "Lena", "Logout");
    const organizer = await registerAccountViaApi(
      request,
      `logout-org-${runId}@example.com`,
      "Otto",
      "Organizer",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Log out ${runId}`,
      accessMode: "open_link",
    });
    await joinViaApi(request, other.access, event.code);
    await loginWithEmailCode(page, email);
    const trigger = page.getByRole("button", {
      name: "Lena Logout",
      exact: true,
    });

    // A failed log out explains itself and keeps the person signed in.
    const logoutRoute = isApiPath("/authn/logout/");
    await page.route(logoutRoute, (route) =>
      route.request().method() === "POST"
        ? fulfillJson(route, 503, {
            detail: "Sign-out is temporarily unavailable.",
          })
        : route.fallback(),
    );
    let { menu } = await openAccountMenu(page, "Lena Logout");
    await menu.getByRole("menuitem", { name: "Log out" }).click();
    let failure = alertWith(page, "Sign-out is temporarily unavailable.");
    await expect(failure).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(trigger).toBeVisible();
    await failure.getByRole("button", { name: "Dismiss" }).click();
    await expect(failure).toHaveCount(0);
    await page.unroute(logoutRoute);

    // An availability change that cannot be saved blocks log out.
    await page.goto(`/event?code=${event.code}`);
    await expect(welcomeHeading(page, "Lena Logout")).toBeVisible();
    const saveRoute = isApiPath("/events/participants/update");
    await page.route(saveRoute, (route) =>
      route.request().method() === "PUT"
        ? fulfillJson(route, 503, { error: "Saving is paused for a moment." })
        : route.fallback(),
    );
    await page.getByRole("button", { name: "Apply Busy to all" }).click();
    await expect(
      alertWith(page, "Saving is paused for a moment."),
    ).toBeVisible();
    ({ menu } = await openAccountMenu(page, "Lena Logout"));
    await menu.getByRole("menuitem", { name: "Log out" }).click();
    failure = alertWith(
      page,
      "Your latest schedule changes could not be saved. Resolve the save error before logging out.",
    );
    await expect(failure).toBeVisible();
    await expect(page).toHaveURL(eventUrl(event.code));
    await failure.getByRole("button", { name: "Dismiss" }).click();
    await expect(failure).toHaveCount(0);
    await expect(trigger).toBeVisible();
    await page.unroute(saveRoute);

    // Log out saves the pending change first, then signs this device out
    // and goes home, not to the event page's sign-in redirect.
    const browserAccess = (await readSession(page)).access;
    expect(await hasRefreshCookie(context)).toBe(true);
    const isSave = (candidate) =>
      candidate.method() === "PUT" &&
      new URL(candidate.url()).pathname === "/events/participants/update";
    const isLogout = (candidate) =>
      candidate.method() === "POST" &&
      new URL(candidate.url()).pathname === "/authn/logout/";
    // The log out request only starts once the save has answered.
    const order = [];
    page.on("response", (response) => {
      if (isSave(response.request())) order.push("saved");
    });
    page.on("request", (candidate) => {
      if (isLogout(candidate)) order.push("logout requested");
    });
    const saveResponse = page.waitForResponse((response) =>
      isSave(response.request()),
    );
    const logoutResponse = page.waitForResponse((response) =>
      isLogout(response.request()),
    );
    // The trip home is held so the moment between signing out and leaving
    // can be seen: the event page shows its signed-out header and nothing
    // sends it to the sign-in page.
    const documents = [];
    page.on("request", (candidate) => {
      if (candidate.resourceType() === "document") {
        documents.push(new URL(candidate.url()).pathname);
      }
    });
    let releaseHome;
    const homeHeld = new Promise((resolve) => {
      releaseHome = resolve;
    });
    const homeHref = new URL("/", FRONTEND_URL).href;
    await page.route(
      (url) => url.href === homeHref,
      async (route) => {
        if (route.request().resourceType() !== "document") {
          return route.fallback();
        }
        await homeHeld;
        return route.continue();
      },
    );
    const signedOutHeader = [];
    await page.exposeFunction("reportSignedOutHeader", (entry) =>
      signedOutHeader.push(entry),
    );
    await page.evaluate(() => {
      new MutationObserver(() => {
        const link = document.querySelector(
          'header.event-header nav[aria-label="Account"] a',
        );
        if (link) {
          window.reportSignedOutHeader([
            link.textContent.trim(),
            link.getAttribute("href"),
            `${location.pathname}${location.search}`,
          ]);
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    ({ menu } = await openAccountMenu(page, "Lena Logout"));
    await menu.getByRole("menuitem", { name: "Log out" }).click();
    expect((await saveResponse).status()).toBe(200);
    expect((await logoutResponse).status()).toBe(204);
    await expect.poll(() => documents).toEqual(["/"]);
    // Playwright waits for a pending navigation before it reads the page,
    // so the page reports its own header as it changes.
    await expect
      .poll(() => signedOutHeader[0])
      .toEqual(["Log in", "/login", `/event?code=${event.code}`]);
    releaseHome();
    await expect(page).toHaveURL(homeUrl());
    await expect(
      page
        .getByRole("navigation", { name: "Account" })
        .getByRole("link", { name: "Sign in" }),
    ).toBeVisible();
    expect(order).toEqual(["saved", "logout requested"]);
    expect(documents).toEqual(["/"]);
    expect(await hasRefreshCookie(context)).toBe(false);

    const saved = await ownResponse(request, other.access, event.code);
    expect(saved.availabilityInperson.every((value) => value === 0)).toBe(true);
    expect(saved.submitted).toBe(0);

    // Only this device was signed out.
    const signedOut = await profileStatus(request, browserAccess);
    expect(signedOut.status).toBe(401);
    expect(signedOut.payload.detail).toBe("This session has been signed out.");
    expect((await profileStatus(request, other.access)).status).toBe(200);
  });

  test("log out from the dashboard lands on home, not on the dashboard's sign-in redirect", async ({
    page,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `logout-dash-${runId}@example.com`,
      "Dex",
      "Dash",
    );
    const { menu } = await openAccountMenu(page, "Dex Dash");
    await menu.getByRole("menuitem", { name: "Log out" }).click();
    await expect(page).toHaveURL(homeUrl());
    await expect(
      page
        .getByRole("navigation", { name: "Account" })
        .getByRole("link", { name: "Sign in" }),
    ).toBeVisible();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=\/dashboard$/);
  });

  test("log out from Settings lands on home, not on the settings sign-in redirect", async ({
    context,
    page,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `logout-settings-${runId}@example.com`,
      "Seth",
      "Settings",
    );
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { level: 1, name: "Account settings" }),
    ).toBeVisible();
    const logoutResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/authn/logout/",
    );
    const { menu } = await openAccountMenu(page, "Seth Settings");
    await menu.getByRole("menuitem", { name: "Log out" }).click();
    // The sign-out succeeds, and the settings page's own signed-out redirect
    // does not replace the navigation home.
    expect((await logoutResponse).status()).toBe(204);
    await page.waitForURL((url) => url.pathname !== "/settings");
    expect(await hasRefreshCookie(context)).toBe(false);
    const landed = new URL(page.url());
    expect(`${landed.pathname}${landed.search}`).toBe("/");
    await expect(
      page
        .getByRole("navigation", { name: "Account" })
        .getByRole("link", { name: "Sign in" }),
    ).toBeVisible();
  });

  test("settings labels the current device, and Sign out this device returns to sign-in while the other session stays live", async ({
    context,
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `sessions-${runId}@example.com`;
    // This API session shows up as another device.
    const api = await registerAccountViaApi(request, email, "Sol", "Settings");

    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?next=\/settings$/);
    await continueWithEmail(page, email, Date.now() - 1000, "login");
    await expect(page).toHaveURL(/\/settings$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Account settings" }),
    ).toBeVisible();

    const sessions = page.locator("#sessions");
    const current = sessions
      .getByRole("listitem")
      .filter({ hasText: "This device" });
    const others = sessions
      .getByRole("listitem")
      .filter({ hasText: "Other device" });
    await expect(current).toHaveCount(1);
    await expect(current).toContainText("Current");
    await expect(current).toContainText(
      /(Chrome|Edge|Firefox|Safari) on (Linux|macOS|Windows)/,
    );
    await expect(current).toContainText("Last active");
    await expect(others.first()).toBeVisible();
    await expect(others.first()).not.toContainText("Current");
    await expect(
      others.first().getByRole("button", { name: "Revoke" }),
    ).toBeVisible();
    await expect(current.getByRole("button", { name: "Revoke" })).toHaveCount(
      0,
    );

    const browserAccess = (await readSession(page)).access;
    expect(await hasRefreshCookie(context)).toBe(true);
    await current.getByRole("button", { name: "Sign out this device" }).click();
    await expect(page).toHaveURL(/\/login\?next=\/settings$/);
    await expect(
      page.getByRole("heading", { name: "Welcome to Releviz" }),
    ).toBeVisible();
    expect(await hasRefreshCookie(context)).toBe(false);

    expect((await profileStatus(request, browserAccess)).status).toBe(401);
    expect((await profileStatus(request, api.access)).status).toBe(200);
  });
});
