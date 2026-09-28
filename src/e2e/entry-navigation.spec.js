const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const {
  FRONTEND_URL,
  apiJson,
  continueWithEmail,
  createEvent,
  importRoster,
  invitationLinkFromEmail,
  latestAuthLink,
  latestEmailFor,
  latestVerificationCode,
  loginWithEmailCode,
  newRunId,
  openAccountMenu,
  readSession,
  registerAccount,
  registerAccountViaApi,
  requestEmailCode,
  setLifecycleViaApi,
  submitResponse,
} = require("./helpers/releviz");

// Entry points and account navigation: the home page's calls to action
// signed out and signed in, onboarding a new person by event code, claiming a
// temporary identity, the dashboard's open-by-code form and its empty,
// archived and failure states, the event page's access states and invitation
// telemetry, the account menu, the settings sessions and navigation, and the
// footer links.

// A stubbed backend answer. The request is a credentialed cross-origin call
// from the frontend, so the stub carries the CORS headers the real API sends.
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

async function waitForHomeReady(page) {
  // The create button stays disabled while the session loads; once it is
  // enabled the page is hydrated and knows who is signed in.
  await expect(
    page.getByRole("button", { name: "Create a scheduling poll" }),
  ).toBeEnabled();
}

async function openCodeFromHome(page, code) {
  await page.goto("/");
  await waitForHomeReady(page);
  await page.getByLabel("Event code").fill(code);
  await page.getByRole("button", { name: "Open event" }).click();
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

test.describe("Entry points and account navigation", () => {
  test("a new person opens an event code from home, verifies from the emailed link on another device, and lands in the event", async ({
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

    await page.goto("/");
    await waitForHomeReady(page);
    const openEvent = page.getByRole("button", { name: "Open event" });
    await expect(openEvent).toBeDisabled();
    await expect(
      page.getByText(
        "We'll verify your email, then bring you straight to the event.",
      ),
    ).toBeVisible();
    await page.getByLabel("Event code").fill(event.code);
    await openEvent.click();
    await expect(page).toHaveURL(loginForEventUrl(event.code));

    // A new address asking from an event's sign-in gets an event
    // registration link rather than a plain registration.
    const requestedAt = Date.now() - 1000;
    await requestEmailCode(page, newEmail);
    const link = await latestAuthLink(newEmail, requestedAt, "register");
    expect(link.params.get("flow")).toBe("auth");
    expect(link.params.get("source")).toBe("event_registration");
    expect(link.params.get("event")).toBe(event.code);
    expect(link.params.get("next")).toBe(`/event?code=${event.code}`);
    expect(link.body).toContain("Continue to Event Registration");

    // The link opens on another device, which has never seen the address.
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
      await expect(linkPage.getByText("One last step")).toBeVisible();
      const emailField = linkPage.getByLabel("Email address");
      await expect(emailField).toHaveValue(newEmail);
      await expect(emailField).toHaveAttribute("readonly", "");
      await expectAccessible(linkPage, "complete profile");

      // The link consumed the code, so typing it on the first device fails.
      await page.getByLabel("Verification code").fill(link.code);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(
        alertWith(page, "Verification code is invalid or has expired."),
      ).toBeVisible();

      // Completing the profile joins the event straight away.
      await linkPage.getByRole("textbox", { name: "First name" }).fill("Nia");
      await linkPage
        .getByRole("textbox", { name: "Last name" })
        .fill("Newcomer");
      await linkPage.getByRole("button", { name: "Continue to event" }).click();
      await expect(linkPage).toHaveURL(eventUrl(event.code));
      await expect(linkPage.getByText(/Welcome, Nia Newcomer/)).toBeVisible();
      await expect(
        linkPage.getByRole("heading", { name: "Join Event" }),
      ).toHaveCount(0);

      await linkPage.goto("/dashboard");
      await expect(
        linkPage.getByRole("heading", { name: "Events I Participate In (1)" }),
      ).toBeVisible();
      await expect(
        linkPage.getByRole("heading", { name: "My Events (0)" }),
      ).toBeVisible();
      await expect(
        linkPage.getByRole("heading", { name: "No events organized yet." }),
      ).toBeVisible();
      await expect(
        linkPage.getByText("Create an event to start collecting availability."),
      ).toBeVisible();
      await expect(
        linkPage.getByRole("link", { name: "Create your first event" }),
      ).toHaveAttribute("href", "/create");
      const eventLink = linkPage.getByRole("link", { name: event.name });
      const card = linkPage.locator("article").filter({ has: eventLink });
      await expect(card).toContainText(`Code: ${event.code}`);
      await expect(card).toContainText("Status:");
      await expect(
        linkPage.getByRole("group", { name: `Actions for ${event.name}` }),
      ).toHaveCount(0);

      await eventLink.click();
      await expect(linkPage).toHaveURL(eventUrl(event.code));
      await expect(linkPage.getByText(/Welcome, Nia Newcomer/)).toBeVisible();
    } finally {
      await linkContext.close();
    }

    const roster = await apiJson(
      request,
      "GET",
      `/events/roster?code=${event.code}&pageSize=100`,
      organizer.access,
    );
    expect(roster.response.status()).toBe(200);
    expect(roster.payload.participants.map((entry) => entry.email)).toContain(
      newEmail,
    );
  });

  test("the home page sends a signed-out organizer through sign-in and profile completion, then opens everything directly once signed in", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `home-org-${runId}@example.com`;
    const createButton = page.getByRole("button", {
      name: "Create a scheduling poll",
    });
    const accountNav = page.getByRole("navigation", { name: "Account" });
    const signedOutNote = page.getByText(
      "Continue with your email to create a free account.",
    );
    const codeHelp = page.getByText(
      "We'll verify your email, then bring you straight to the event.",
    );

    await page.goto("/");
    await expect(
      accountNav.getByRole("link", { name: "Sign in" }),
    ).toHaveAttribute("href", "/login");
    await expect(signedOutNote).toBeVisible();
    await expect(createButton).toBeEnabled();
    await createButton.click();
    await expect(page).toHaveURL(/\/login\?next=%2Fcreate$/);

    const startedAt = Date.now() - 1000;
    await continueWithEmail(page, email, startedAt, "register");
    await expect(page).toHaveURL(
      /\/settings\?complete_profile=1&next=%2Fcreate$/,
    );
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue to event" }),
    ).toHaveCount(0);

    // An incomplete profile cannot open an event yet; the event page sends
    // it to profile completion with the event kept as the destination.
    await page.goto("/event?code=ABCD1234");
    await expect(page).toHaveURL(completeProfileForEventUrl("ABCD1234"));
    await expect(
      page.getByRole("button", { name: "Continue to event" }),
    ).toBeVisible();

    await page.goto("/settings?complete_profile=1&next=%2Fcreate");
    await page.getByRole("textbox", { name: "First name" }).fill("Hana");
    await page.getByRole("textbox", { name: "Last name" }).fill("Home");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(/\/create$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Create event" }),
    ).toBeVisible();

    const token = (await readSession(page)).access;
    const event = await createEvent(request, token, {
      name: `Home direct ${runId}`,
    });

    await page.goto("/");
    await expect(
      page.getByRole("link", { name: "Go to my dashboard" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Hana Home", exact: true }),
    ).toBeVisible();
    await expect(signedOutNote).toHaveCount(0);
    await expect(accountNav).toHaveCount(0);
    await expect(codeHelp).toHaveCount(0);
    await expectAccessible(page, "signed-in home");

    await createButton.click();
    await expect(page).toHaveURL(/\/create$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Create event" }),
    ).toBeVisible();

    await openCodeFromHome(page, event.code);
    await expect(page).toHaveURL(eventUrl(event.code));
    await expect(
      page.getByRole("heading", { level: 1, name: event.name }),
    ).toBeVisible();
    await expect(page.locator(".event-role-badge")).toHaveText("Organizer");

    await page.goto("/");
    await page.getByRole("link", { name: "Go to my dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "My Dashboard" }),
    ).toBeVisible();
  });

  test("the dashboard opens events by code, explains unknown codes, and shows empty, archived and load-failure states", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(page, `dash-${runId}@example.com`, "Dana", "Dash");

    await expect(
      page.getByRole("heading", { name: "Open an event" }),
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

    const token = (await readSession(page)).access;
    const event = await createEvent(request, token, {
      name: `Dash open ${runId}`,
    });

    // Enter in the field opens the event like the Go button.
    await page.reload();
    const field = page.getByLabel("Enter Event Code");
    await field.fill(event.code);
    await field.press("Enter");
    await expect(page).toHaveURL(eventUrl(event.code));
    await expect(
      page.getByRole("heading", { level: 1, name: event.name }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Copy share link" }),
    ).toBeVisible();

    await page.goto("/dashboard");
    await page.getByLabel("Enter Event Code").fill("ZZZZ9999");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page).toHaveURL(/\/event\?code=ZZZZ9999$/);
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
    await expectAccessible(page, "event not found");

    // A malformed code is upper-cased and encoded, never rejected client-side.
    await page.goto("/dashboard");
    await page.getByLabel("Enter Event Code").fill("bad code/!");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page).toHaveURL(/code=BAD%20CODE%2F!$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Event Not Found" }),
    ).toBeVisible();

    await page.route("**/dashboard/events", (route) =>
      fulfillJson(route, 500, {}),
    );
    await page.goto("/dashboard");
    await expect(
      alertWith(
        page,
        "Failed to load your events. Please refresh and try again.",
      ),
    ).toBeVisible();
    await page.unroute("**/dashboard/events");

    await setLifecycleViaApi(request, token, event.code, "archived");
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
      page.getByRole("heading", { name: "Archived (1)" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: event.name })).toBeVisible();
  });

  test("event codes typed in lowercase still open the event", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(page, `lower-${runId}@example.com`, "Lou", "Lower");
    const event = await createEvent(request, (await readSession(page)).access, {
      name: `Lowercase ${runId}`,
    });
    const lowercase = event.code.toLowerCase();
    const eventHeading = page.getByRole("heading", {
      level: 1,
      name: event.name,
    });
    const notFound = page.getByRole("heading", { name: "Event Not Found" });

    await page.goto("/dashboard");
    await page.getByLabel("Enter Event Code").fill(lowercase);
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page).toHaveURL(eventUrl(event.code));
    await expect(eventHeading).toBeVisible();
    await expect(notFound).toHaveCount(0);

    await openCodeFromHome(page, lowercase);
    await expect(page).toHaveURL(eventUrl(event.code));
    await expect(eventHeading).toBeVisible();
    await expect(notFound).toHaveCount(0);
  });

  test("an invite-only event is hidden from others, and its invitation link survives sign-in and records the open", async ({
    browser,
    page,
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
      name: `Invite only ${runId}`,
    });
    const inviteeEmail = `invitee-${runId}@example.com`;
    await registerAccount(page, inviteeEmail, "Ivan", "Invitee");

    // Someone who is not invited learns nothing about the event.
    await page.goto(`/event?code=${event.code}`);
    await expect(
      page.getByText("Event unavailable", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Event Not Found" }),
    ).toBeVisible();
    await expect(
      page.getByText("Event not found", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(event.name)).toHaveCount(0);

    await page.goto("/event");
    await expect(
      page.getByRole("heading", { level: 1, name: "Event Not Found" }),
    ).toBeVisible();
    await expect(page.getByText("No event code in URL")).toBeVisible();

    const invitedAt = Date.now() - 1000;
    const imported = await importRoster(
      request,
      event.code,
      organizer.access,
      `name,email,group,weight,included\nIvan Invitee,${inviteeEmail},Invitees,1,true`,
    );
    expect(imported.autoInvitedCount).toBe(1);
    const body = await latestEmailFor(
      inviteeEmail,
      invitedAt,
      (message) =>
        message.includes(`event?code=${event.code}`) &&
        /^Link: /m.test(message),
    );
    const link = invitationLinkFromEmail(body);
    expect(link).toMatch(
      new RegExp(`/event\\?code=${event.code}&invitation=[0-9a-f-]+$`, "i"),
    );

    const signedOut = await browser.newContext();
    try {
      const signedOutPage = await signedOut.newPage();
      await signedOutPage.goto(link);
      // The invitation token is dropped before the sign-in detour.
      await expect(signedOutPage).toHaveURL(loginForEventUrl(event.code));
      await expect(
        signedOutPage.getByRole("heading", { name: "Welcome to Releviz" }),
      ).toBeVisible();

      // The open is recorded before the invitee signs in; later views can
      // move the status further along.
      await expect
        .poll(
          async () => {
            const invitations = await apiJson(
              request,
              "GET",
              `/events/invitations?code=${event.code}`,
              organizer.access,
            );
            return invitations.payload?.invitations?.find(
              (invitation) => invitation.email === inviteeEmail,
            )?.status;
          },
          { timeout: 15_000 },
        )
        .toBe("opened");

      const loginStartedAt = Date.now() - 1000;
      await continueWithEmail(
        signedOutPage,
        inviteeEmail,
        loginStartedAt,
        "login",
      );
      await expect(signedOutPage).toHaveURL(eventUrl(event.code));
      await expect(
        signedOutPage.getByText(/Welcome, Ivan Invitee/),
      ).toBeVisible();
    } finally {
      await signedOut.close();
    }
  });

  test("an invited person without an account claims their temporary identity by entering the event code", async ({
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
    const claimEmail = `claimant-${runId}@example.com`;
    // The organizer enters this person's response, which creates their
    // temporary identity, participant row and invitation.
    await submitResponse(request, organizer.access, event, {
      name: "Casey Claimant",
      email: claimEmail,
      inperson: [0, 1, 2, 3],
    });

    await openCodeFromHome(page, event.code);
    await expect(page).toHaveURL(loginForEventUrl(event.code));
    const requestedAt = Date.now() - 1000;
    await requestEmailCode(page, claimEmail);
    await page
      .getByLabel("Verification code")
      .fill(await latestVerificationCode(claimEmail, requestedAt, "register"));
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // The temporary identity holds the roster name as its first name.
    await expect(page).toHaveURL(completeProfileForEventUrl(event.code));
    const firstName = page.getByRole("textbox", { name: "First name" });
    const lastName = page.getByRole("textbox", { name: "Last name" });
    await expect(firstName).toHaveValue("Casey Claimant");
    await expect(lastName).toHaveValue("");
    await firstName.fill("Casey");
    await lastName.fill("Claimant");
    await page.getByRole("button", { name: "Continue to event" }).click();

    await expect(page).toHaveURL(eventUrl(event.code));
    await expect(
      page.getByRole("heading", { level: 2, name: /Welcome, Casey Claimant/ }),
    ).toContainText("Submitted");
    await expect(page.getByRole("heading", { name: "Join Event" })).toHaveCount(
      0,
    );

    const roster = await apiJson(
      request,
      "GET",
      `/events/roster?code=${event.code}&pageSize=100`,
      organizer.access,
    );
    expect(roster.response.status()).toBe(200);
    const claimed = roster.payload.participants.filter(
      (entry) => entry.email === claimEmail,
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toEqual(
      expect.objectContaining({
        accountAccess: "full",
        canOrganizerEditAvailability: false,
        submitted: true,
      }),
    );

    const own = await apiJson(
      request,
      "GET",
      `/events/participants?code=${event.code}`,
      (await readSession(page)).access,
    );
    expect(own.response.status()).toBe(200);
    expect(own.payload.participants).toHaveLength(1);
    expect(
      own.payload.participants[0].availabilityInperson.slice(0, 4),
    ).toEqual([1, 1, 1, 1]);
  });

  test("account menu: keyboard, Settings and Dashboard entries, a dismissible failed log out, and single-device log out", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `menu-${runId}@example.com`;
    await registerAccount(page, email, "Mona", "Menu");
    const other = await browser.newContext();
    try {
      const otherPage = await other.newPage();
      await loginWithEmailCode(otherPage, email);

      const trigger = page.getByRole("button", {
        name: "Mona Menu",
        exact: true,
      });
      await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");

      let { menu } = await openAccountMenu(page, "Mona Menu");
      await expect(menu).toContainText("Mona Menu");
      await expect(menu).toContainText(email);
      await expectAccessible(page, "open account menu");
      await menu.getByRole("menuitem", { name: "Settings" }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(
        page.getByRole("heading", { level: 1, name: "Account settings" }),
      ).toBeVisible();
      await expect(page.getByRole("menu")).toHaveCount(0);

      // Arrow keys open the menu from its trigger and cycle through items.
      const dashboardItem = page.getByRole("menuitem", {
        name: "My Dashboard",
      });
      const logoutItem = page.getByRole("menuitem", { name: "Log out" });
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await expect(dashboardItem).toBeFocused();
      await page.keyboard.press("End");
      await expect(logoutItem).toBeFocused();
      await page.keyboard.press("Home");
      await expect(dashboardItem).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(logoutItem).toBeFocused();
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

      ({ menu } = await openAccountMenu(page, "Mona Menu"));
      await menu.getByRole("menuitem", { name: "My Dashboard" }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(
        page.getByRole("heading", { level: 1, name: "My Dashboard" }),
      ).toBeVisible();

      const accessA = (await readSession(page)).access;
      const accessB = (await readSession(otherPage)).access;

      // A failed log out explains itself and keeps the person signed in.
      await page.route("**/authn/logout/", (route) =>
        route.request().method() === "POST"
          ? fulfillJson(route, 500, { detail: "Logout failed" })
          : route.fallback(),
      );
      ({ menu } = await openAccountMenu(page, "Mona Menu"));
      await menu.getByRole("menuitem", { name: "Log out" }).click();
      const failure = alertWith(page, "Logout failed");
      await expect(failure).toBeVisible();
      await expect(trigger).toBeVisible();
      await failure.getByRole("button", { name: "Dismiss" }).click();
      await expect(failure).toHaveCount(0);
      await page.unroute("**/authn/logout/");

      // The real log out runs from the dashboard, a signed-in-only page: the
      // log out signs the page out before it navigates home, and the page's
      // own signed-out redirect to the login page must not replace that
      // navigation.
      await expect(page).toHaveURL(/\/dashboard$/);
      ({ menu } = await openAccountMenu(page, "Mona Menu"));
      await menu.getByRole("menuitem", { name: "Log out" }).click();
      await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
      await expect(
        page
          .getByRole("navigation", { name: "Account" })
          .getByRole("link", { name: "Sign in" }),
      ).toBeVisible();

      // Only this device was signed out.
      const signedOut = await apiJson(
        request,
        "GET",
        "/authn/profile/",
        accessA,
      );
      expect(signedOut.response.status()).toBe(401);
      expect(signedOut.payload.detail).toBe(
        "This session has been signed out.",
      );
      const stillSignedIn = await apiJson(
        request,
        "GET",
        "/authn/profile/",
        accessB,
      );
      expect(stillSignedIn.response.status()).toBe(200);
      await otherPage.reload();
      await expect(
        otherPage.getByRole("heading", { level: 1, name: "My Dashboard" }),
      ).toBeVisible();
    } finally {
      await other.close();
    }
  });

  test("settings: signed-out guard, section navigation, current-device labelling, and Sign out this device", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const email = `settings-${runId}@example.com`;
    // This API session shows up later as another device.
    const api = await registerAccountViaApi(request, email, "Sol", "Settings");

    await page.goto("/settings?complete_profile=1&next=%2Fcreate");
    await expect(page).toHaveURL(
      /\/login\?next=%2Fsettings%3Fcomplete_profile%3D1%26next%3D%252Fcreate$/,
    );

    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?next=\/settings$/);
    const startedAt = Date.now() - 1000;
    await continueWithEmail(page, email, startedAt, "login");
    await expect(page).toHaveURL(/\/settings$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Account settings" }),
    ).toBeVisible();

    const userId = (await readSession(page)).user.id;
    // The sidebar names the account; the header menu trigger repeats the
    // name, so the checks stay inside the sidebar.
    const sidebar = page.getByRole("complementary");
    await expect(sidebar.getByText("Signed in as")).toBeVisible();
    await expect(sidebar.getByText("Sol Settings")).toBeVisible();
    await expect(sidebar.getByText(email)).toBeVisible();
    await expect(sidebar.getByText("Account ID")).toBeVisible();
    await expect(sidebar.getByText(userId, { exact: true })).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Settings sections" });
    const profileLink = nav.getByRole("link", { name: "Profile" });
    const sessionsLink = nav.getByRole("link", { name: "Active sessions" });
    await expect(profileLink).toHaveAttribute("aria-current", "location");
    await sessionsLink.click();
    await expect(page).toHaveURL(/#sessions$/);
    await expect(sessionsLink).toHaveAttribute("aria-current", "location");
    await expect(profileLink).not.toHaveAttribute("aria-current");

    const current = page
      .getByRole("listitem")
      .filter({ hasText: "This device" });
    const others = page
      .getByRole("listitem")
      .filter({ hasText: "Other device" });
    await expect(current).toHaveCount(1);
    await expect(current).toContainText("Current");
    await expect(current).toContainText(
      /(Chrome|Firefox|Safari) on (Windows|macOS)/,
    );
    await expect(others.first()).toBeVisible();
    await expect(
      others.first().getByRole("button", { name: "Revoke" }),
    ).toBeVisible();

    await page.locator("form#password summary").click();
    await page.locator("form#danger-zone summary").click();
    await expect(page.locator("form#password details")).toHaveAttribute(
      "open",
      "",
    );
    await expect(page.locator("form#danger-zone details")).toHaveAttribute(
      "open",
      "",
    );
    await expectAccessible(page, "settings with every section open");

    const browserAccess = (await readSession(page)).access;
    await current.getByRole("button", { name: "Sign out this device" }).click();
    await expect(page).toHaveURL(/\/login\?next=\/settings$/);
    await expect(
      page.getByRole("heading", { name: "Welcome to Releviz" }),
    ).toBeVisible();

    const browserProfile = await apiJson(
      request,
      "GET",
      "/authn/profile/",
      browserAccess,
    );
    expect(browserProfile.response.status()).toBe(401);
    const apiProfile = await apiJson(
      request,
      "GET",
      "/authn/profile/",
      api.access,
    );
    expect(apiProfile.response.status()).toBe(200);
  });

  test("footer links reach the legal pages and home", async ({ page }) => {
    await page.goto("/");
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
    await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Find a time that works for everyone.",
      }),
    ).toBeVisible();

    // The release line only appears when the build carries a release SHA.
    if (!process.env.NEXT_PUBLIC_RELEASE_SHA) {
      await expect(footer.locator("[data-release]")).toHaveCount(0);
    }
  });
});
