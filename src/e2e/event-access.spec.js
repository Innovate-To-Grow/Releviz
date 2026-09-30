const { expect, test } = require("@playwright/test");
const { expectAccessible } = require("./helpers/accessibility");
const {
  BACKEND_URL,
  apiJson,
  continueWithEmail,
  createEvent,
  finalizeViaApi,
  freshResults,
  invitationLinkFromEmail,
  latestEmailFor,
  newAccountContext,
  newRunId,
  readSession,
  registerAccount,
  registerAccountViaApi,
  runDjangoJson,
  slotIndex,
  submitResponse,
  tempAccessSessionState,
  temporaryAccessPathFromEmail,
  updateEventViaApi,
} = require("./helpers/releviz");
const {
  addPersonApi,
  invitationEmail,
  requestRecorder,
} = require("./helpers/participants");
const { joinEventInBrowser } = require("./helpers/workspace");

// Who may open an event and what they see. An invite-only event does not
// exist for a signed-in stranger: the page and the API answer exactly as for
// an unknown code, and joining is refused. Invitation links record their
// open (signed in or out) and never keep the private token in the address
// bar, while the "preview" stand-in token that email previews carry records
// nothing and opens nothing. Results, the activity digest and the event
// stream are the organizer's alone, and a participant's page holds only their
// own calendar. Hiding a participant (an API-only action) takes away the
// access they had through the roster, but not access an invitation or an
// open link grants; unhiding gives it back.

function eventUrl(code) {
  return new RegExp(`/event\\?code=${code}$`);
}

function loginForEventUrl(code) {
  return new RegExp(`/login\\?next=%2Fevent%3Fcode%3D${code}$`);
}

// The event page's own read of the event (GET /events?code=).
function eventRead(page, code) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === "/events" &&
      url.searchParams.get("code") === code
    );
  });
}

function apiCall(page, method, pathname) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      new URL(response.url()).pathname === pathname,
  );
}

async function expectEventNotFound(page, message) {
  await expect(
    page.getByText("Event unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Event Not Found" }),
  ).toBeVisible();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Create New Event" }),
  ).toHaveAttribute("href", "/create");
}

function welcomeHeading(page, name) {
  return page.getByRole("heading", {
    level: 2,
    name: new RegExp(`Welcome, ${name}`),
  });
}

async function invitationFor(request, token, code, email) {
  const { response, payload } = await apiJson(
    request,
    "GET",
    `/events/invitations?code=${code}`,
    token,
  );
  expect(response.status()).toBe(200);
  return payload.invitations.find((invitation) => invitation.email === email);
}

// Member ids on the organizer's participant list (hidden people only with
// `includeHidden`).
async function listedMemberIds(
  request,
  token,
  code,
  { includeHidden = false } = {},
) {
  const { response, payload } = await apiJson(
    request,
    "GET",
    `/events/participants?code=${code}${includeHidden ? "&includeHidden=true" : ""}`,
    token,
  );
  expect(response.status()).toBe(200);
  return payload.participants.map((participant) => participant.memberId);
}

const ORGANIZER_ONLY_READS = [
  {
    path: "/events/results",
    accept: "application/json",
    error: "You do not have permission to view event results",
  },
  {
    path: "/events/activity",
    accept: "application/json",
    error: "You do not have permission to view event activity",
  },
  // The workspace asks for an event stream; a refusal is JSON either way.
  {
    path: "/events/stream",
    accept: "text/event-stream",
    error: "You do not have permission to view event activity",
  },
];

// One organizer-only read, with the caller's bearer token (none when
// `token` is empty). A stream that opened by mistake would hold the call
// open, so it gives up well before the test does.
async function organizerOnlyRead(request, { path, accept }, code, token) {
  const response = await request.fetch(`${BACKEND_URL}${path}?code=${code}`, {
    headers: {
      Accept: accept,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    timeout: 10_000,
  });
  return { response, payload: await response.json() };
}

function hideParticipant(request, token, code, memberId) {
  return apiJson(
    request,
    "DELETE",
    `/events/participants/update?code=${code}&participantId=${memberId}`,
    token,
  );
}

function unhideParticipant(request, token, code, memberId) {
  return apiJson(
    request,
    "PUT",
    `/events/participants/update/unhide?code=${code}&participantId=${memberId}`,
    token,
  );
}

function finalCalendar(request, token, code) {
  return request.fetch(
    `${BACKEND_URL}/events/finalization/calendar?code=${code}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

async function expectCalendarAnswer(request, token, code, status, error) {
  const response = await finalCalendar(request, token, code);
  expect(response.status()).toBe(status);
  expect(await response.json()).toEqual({ error });
}

test.describe("Invite-only events", () => {
  test("a stranger can neither open, list nor join an invite-only event, and sees the same not-found page as for an unknown or missing code", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `access-org-${runId}@example.com`,
      "Orla",
      "Owner",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Private plans ${runId}`,
      accessMode: "invite_only",
    });
    const { code } = event;
    const unknownCode = `NOPE-${runId}`;
    await registerAccount(
      page,
      `access-stranger-${runId}@example.com`,
      "Stella",
      "Stranger",
    );
    const strangerToken = (await readSession(page)).access;

    // The API answers the stranger exactly as it answers an unknown code, so
    // nothing about the event leaks; its organizer still reads it.
    const hidden = await apiJson(
      request,
      "GET",
      `/events?code=${code}`,
      strangerToken,
    );
    const unknown = await apiJson(
      request,
      "GET",
      `/events?code=${unknownCode}`,
      strangerToken,
    );
    expect(hidden.response.status()).toBe(404);
    expect(hidden.payload).toEqual({ error: "Event not found" });
    expect(unknown.response.status()).toBe(404);
    expect(unknown.payload).toEqual(hidden.payload);
    const own = await apiJson(
      request,
      "GET",
      `/events?code=${code}`,
      organizer.access,
    );
    expect(own.response.status()).toBe(200);
    expect(own.payload.event.name).toBe(event.name);

    // Joining and listing are refused, and the refused join added nobody.
    const join = await apiJson(
      request,
      "POST",
      `/events/participants?code=${code}`,
      strangerToken,
      {},
    );
    expect(join.response.status()).toBe(403);
    expect(join.payload).toEqual({
      error: "This event is limited to invited participants",
    });
    const list = await apiJson(
      request,
      "GET",
      `/events/participants?code=${code}`,
      strangerToken,
    );
    expect(list.response.status()).toBe(403);
    expect(list.payload).toEqual({
      error: "You must join this event before viewing participants",
    });
    expect(
      await listedMemberIds(request, organizer.access, code, {
        includeHidden: true,
      }),
    ).toEqual([]);

    // The event page shows the API's answer and nothing of the event.
    const strangerRead = eventRead(page, code);
    await page.goto(`/event?code=${code}`);
    expect((await strangerRead).status()).toBe(404);
    await expectEventNotFound(page, "Event not found");
    await expect(page.getByText(event.name)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Join Event" })).toHaveCount(
      0,
    );
    await expectAccessible(page, "event not found");

    const unknownRead = eventRead(page, unknownCode);
    await page.goto(`/event?code=${unknownCode}`);
    expect((await unknownRead).status()).toBe(404);
    await expectEventNotFound(page, "Event not found");

    // Without a code the page does not ask the API at all, and its link
    // leads to the create form.
    const eventReads = requestRecorder(
      page,
      (browserRequest) => new URL(browserRequest.url()).pathname === "/events",
    );
    await page.goto("/event");
    await expectEventNotFound(page, "No event code in URL");
    expect(eventReads.entries).toEqual([]);
    await page.getByRole("link", { name: "Create New Event" }).click();
    await expect(page).toHaveURL(/\/create$/);
    await expect(
      page.getByRole("heading", { name: "Create event" }),
    ).toBeVisible();
  });
});

test.describe("Invitation links", () => {
  test("an invitation link records its open before sign-in and leaves no token in the address bar, signed out or in, while the preview stand-in link records nothing", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `link-org-${runId}@example.com`,
      "Lena",
      "Linker",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Invite link ${runId}`,
      accessMode: "invite_only",
    });
    const { code } = event;
    const inviteeEmail = `link-invitee-${runId}@example.com`;
    // A full account, so the invitation links to /event rather than to
    // temporary access.
    const invitee = await newAccountContext(
      browser,
      inviteeEmail,
      "Ivan",
      "Invitee",
    );
    try {
      const invitedAt = Date.now() - 1000;
      await addPersonApi(request, code, organizer.access, {
        name: "Ivan Invitee",
        email: inviteeEmail,
        sendInvitation: true,
      });
      const body = await latestEmailFor(inviteeEmail, invitedAt, (message) =>
        message.includes(`/event?code=${code}&invitation=`),
      );
      const link = invitationLinkFromEmail(body);
      expect(link).toMatch(
        new RegExp(`/event\\?code=${code}&invitation=[0-9a-f-]{36}$`, "i"),
      );
      const accessToken = new URL(link).searchParams.get("invitation");
      const unopened = await invitationFor(
        request,
        organizer.access,
        code,
        inviteeEmail,
      );
      expect(unopened).toEqual(
        expect.objectContaining({ status: "invited", openedAt: null }),
      );

      // Someone opens the stand-in link a plain-text preview shows. The page
      // still reports it (the endpoint is public and answers 204 whatever
      // the token), drops it from the address bar and opens the event, but
      // no invitation matches "preview", so nothing is recorded.
      const previewOpen = apiCall(
        invitee.page,
        "POST",
        "/events/invitations/open",
      );
      await invitee.page.goto(`/event?code=${code}&invitation=preview`);
      const previewAnswer = await previewOpen;
      expect(previewAnswer.status()).toBe(204);
      expect(previewAnswer.request().postDataJSON()).toEqual({
        code,
        token: "preview",
      });
      await expect(invitee.page).toHaveURL(eventUrl(code));
      await expect(welcomeHeading(invitee.page, "Ivan Invitee")).toBeVisible();
      expect(
        await invitationFor(request, organizer.access, code, inviteeEmail),
      ).toEqual(expect.objectContaining({ status: "invited", openedAt: null }));

      // Signed out, the real link records the open before the sign-in
      // detour, and the detour's destination carries no token.
      await page.goto(link);
      await expect(page).toHaveURL(loginForEventUrl(code));
      await expect(
        page.getByRole("heading", { name: "Welcome to Releviz" }),
      ).toBeVisible();
      await expect
        .poll(
          async () =>
            (await invitationFor(request, organizer.access, code, inviteeEmail))
              .status,
          { timeout: 15_000 },
        )
        .toBe("opened");
      const { openedAt } = await invitationFor(
        request,
        organizer.access,
        code,
        inviteeEmail,
      );
      expect(openedAt).not.toBeNull();
      await continueWithEmail(page, inviteeEmail, Date.now() - 1000, "login");
      await expect(page).toHaveURL(eventUrl(code));
      await expect(welcomeHeading(page, "Ivan Invitee")).toBeVisible();
      expect(page.url()).not.toContain(accessToken);

      // Signed in, the token is reported and then dropped from the address
      // bar; the first open stays the recorded one.
      const signedInOpen = apiCall(
        invitee.page,
        "POST",
        "/events/invitations/open",
      );
      await invitee.page.goto(link);
      const signedInAnswer = await signedInOpen;
      expect(signedInAnswer.status()).toBe(204);
      expect(signedInAnswer.request().postDataJSON()).toEqual({
        code,
        token: accessToken,
      });
      await expect(invitee.page).toHaveURL(eventUrl(code));
      await expect(welcomeHeading(invitee.page, "Ivan Invitee")).toBeVisible();
      expect(
        await invitationFor(request, organizer.access, code, inviteeEmail),
      ).toEqual(expect.objectContaining({ status: "opened", openedAt }));
    } finally {
      await invitee.context.close();
    }
  });

  test("the preview stand-in link on the temporary-access page opens nothing, while the real link opens the schedule without a code", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `preview-org-${runId}@example.com`,
      "Pia",
      "Preview",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Preview link ${runId}`,
      accessMode: "invite_only",
    });
    const { code } = event;
    // No account, so the invitation opens temporary access.
    const guestEmail = `preview-guest-${runId}@example.com`;
    const invitedAt = Date.now() - 1000;
    await addPersonApi(request, code, organizer.access, {
      name: "Tara Temp",
      email: guestEmail,
      sendInvitation: true,
    });
    const realPath = temporaryAccessPathFromEmail(
      await latestEmailFor(guestEmail, invitedAt, invitationEmail(code)),
    );
    const realToken = new URL(realPath, BACKEND_URL).searchParams.get(
      "invitation",
    );
    expect(realToken).toMatch(/^[0-9a-f-]{36}$/i);
    const tempChallenges = () =>
      runDjangoJson(
        `
from apps.authn.models import EmailAuthChallenge

print(json.dumps(EmailAuthChallenge.objects.filter(
    purpose=EmailAuthChallenge.Purpose.TEMP_EVENT_ACCESS,
    target_email__iexact=data["email"],
).count()))
`,
        { email: guestEmail },
      );

    // The page opens the link with the stand-in token. It matches no live
    // invitation, so the answer is the one 404 every such link gets, the
    // page says the link isn't active, no challenge is issued and the
    // invitation is not marked opened.
    const previewRequest = apiCall(page, "POST", "/events/temp-access/open");
    await page.goto(`/temp-access?code=${code}&invitation=preview`);
    const previewAnswer = await previewRequest;
    expect(previewAnswer.status()).toBe(404);
    expect(previewAnswer.request().postDataJSON()).toEqual({
      code,
      invitationToken: "preview",
    });
    expect(await previewAnswer.json()).toEqual({
      error: "This invitation link is not active.",
      errorCode: "temp_invitation_inactive",
    });
    await expect(page).toHaveURL(new RegExp(`/temp-access\\?code=${code}$`));
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "This invitation link isn't active",
      }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: event.name })).toHaveCount(
      0,
    );
    expect(tempChallenges()).toBe(0);
    expect(
      await invitationFor(request, organizer.access, code, guestEmail),
    ).toEqual(expect.objectContaining({ status: "invited", openedAt: null }));
    const session = await tempAccessSessionState(page, code);
    expect(session.status).toBe(401);
    expect(session.payload.errorCode).toBe("temp_session_inactive");

    // The real link opens Tara's schedule, still without any emailed code.
    const opened = await request.post(
      `${BACKEND_URL}/events/temp-access/open`,
      { data: { code, invitationToken: realToken } },
    );
    expect(opened.status()).toBe(200);
    expect((await opened.json()).participant.name).toBe("Tara Temp");
    expect(tempChallenges()).toBe(0);
    expect(
      await invitationFor(request, organizer.access, code, guestEmail),
    ).toEqual(
      expect.objectContaining({
        status: "opened",
        openedAt: expect.any(String),
        acceptedAt: null,
      }),
    );
  });
});

test.describe("Organizer-only data", () => {
  test("results, the activity digest and the event stream answer 401 signed out and 403 to a stranger or a participant, whose page holds only their own calendar", async ({
    page,
    playwright,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `only-org-${runId}@example.com`,
      "Otto",
      "Organizer",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Organizer only ${runId}`,
      accessMode: "open_link",
    });
    const { code } = event;
    const stranger = await registerAccountViaApi(
      request,
      `only-stranger-${runId}@example.com`,
      "Sam",
      "Stranger",
    );
    // Someone else has already answered, so there is another person's
    // calendar for the participant's views to leave out.
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    const other = await submitResponse(request, organizer.access, event, {
      name: "Olga Other",
      email: `only-other-${runId}@example.com`,
      inperson: [mon10, mon10 + 1],
    });

    // A participant joins by code. Their page never asks for results,
    // activity or the stream, and shows only their own calendar: no Time
    // Table, meeting calendar, participant list, event controls or anyone
    // else's name.
    await registerAccount(
      page,
      `only-participant-${runId}@example.com`,
      "Pat",
      "Participant",
    );
    const participantSession = await readSession(page);
    const participantToken = participantSession.access;
    const organizerReads = requestRecorder(page, (browserRequest) =>
      /^\/events\/(results|activity|stream)$/.test(
        new URL(browserRequest.url()).pathname,
      ),
    );
    await joinEventInBrowser(page, code, "Pat Participant");
    await page.reload();
    await expect(welcomeHeading(page, "Pat Participant")).toBeVisible();
    await expect(page.locator(".event-role-badge")).toHaveText("Participant");
    await expect(
      page.getByRole("grid", { name: "Availability" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Workspace sections" }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Time Table" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("grid", { name: /^Meeting time calendar, / }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Participants", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Event controls" }),
    ).toHaveCount(0);
    await expect(page.getByText("Olga Other")).toHaveCount(0);
    expect(organizerReads.entries).toEqual([]);

    // The participant list answers them with their own row alone, while the
    // organizer's holds both people.
    const ownList = await apiJson(
      request,
      "GET",
      `/events/participants?code=${code}`,
      participantToken,
    );
    expect(ownList.response.status()).toBe(200);
    expect(ownList.payload.participants.map(({ id }) => id)).toEqual([
      participantSession.user.id,
    ]);
    expect(
      (await listedMemberIds(request, organizer.access, code)).sort(),
    ).toEqual([other.id, participantSession.user.id].sort());

    // Signed out: 401 with the bearer challenge.
    const anonymous = await playwright.request.newContext();
    try {
      for (const read of ORGANIZER_ONLY_READS) {
        const { response, payload } = await organizerOnlyRead(
          anonymous,
          read,
          code,
          "",
        );
        expect(response.status(), read.path).toBe(401);
        expect(response.headers()["www-authenticate"], read.path).toBe(
          'Bearer realm="api"',
        );
        expect(payload, read.path).toEqual({
          detail: "Authentication credentials were not provided.",
        });
      }
    } finally {
      await anonymous.dispose();
    }

    // Signed in but not the organizer, joined or not: 403.
    for (const [who, token] of [
      ["stranger", stranger.access],
      ["participant", participantToken],
    ]) {
      for (const read of ORGANIZER_ONLY_READS) {
        const { response, payload } = await organizerOnlyRead(
          request,
          read,
          code,
          token,
        );
        expect(response.status(), `${who} ${read.path}`).toBe(403);
        expect(payload, `${who} ${read.path}`).toEqual({ error: read.error });
      }
    }

    // The organizer reads results and activity (the stream is left to the
    // workspace, since it stays open).
    for (const read of ORGANIZER_ONLY_READS.slice(0, 2)) {
      const { response } = await organizerOnlyRead(
        request,
        read,
        code,
        organizer.access,
      );
      expect(response.status(), `organizer ${read.path}`).toBe(200);
    }
  });
});

test.describe("Hidden participants", () => {
  test("hiding someone who joined by code drops them from the default list and takes away the event and its calendar until they are unhidden, while an invited person keeps access", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `hide-org-${runId}@example.com`,
      "Hana",
      "Host",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Hidden people ${runId}`,
      accessMode: "open_link",
    });
    const { code } = event;

    // Ivy has a full account and was added (so invited, though never
    // emailed) by the organizer, who also entered her response.
    const ivyEmail = `hide-ivy-${runId}@example.com`;
    const ivy = await registerAccountViaApi(
      request,
      ivyEmail,
      "Ivy",
      "Invited",
    );
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    await submitResponse(request, organizer.access, event, {
      name: "Ivy Invited",
      email: ivyEmail,
      inperson: [mon10, mon10 + 1],
    });

    // Stella joins by code, which records no invitation: once the event is
    // invite-only again, her roster row is her only way in, while Ivy's
    // address holds one.
    await registerAccount(
      page,
      `hide-stella-${runId}@example.com`,
      "Stella",
      "Stranger",
    );
    const stella = await readSession(page);
    await joinEventInBrowser(page, code, "Stella Stranger");
    expect(
      await invitationFor(request, organizer.access, code, ivyEmail),
    ).toEqual(expect.objectContaining({ email: ivyEmail }));
    expect(
      await invitationFor(
        request,
        organizer.access,
        code,
        `hide-stella-${runId}@example.com`,
      ),
    ).toBeUndefined();
    await updateEventViaApi(request, organizer.access, code, {
      accessMode: "invite_only",
    });
    await page.reload();
    await expect(welcomeHeading(page, "Stella Stranger")).toBeVisible();
    await expectCalendarAnswer(
      request,
      stella.access,
      code,
      404,
      "No active final meeting has been confirmed",
    );

    // Only the organizer hides and unhides.
    const selfHide = await hideParticipant(
      request,
      stella.access,
      code,
      stella.user.id,
    );
    expect(selfHide.response.status()).toBe(403);
    expect(selfHide.payload).toEqual({
      error: "Only the organizer can hide participants",
    });
    const selfUnhide = await unhideParticipant(
      request,
      stella.access,
      code,
      stella.user.id,
    );
    expect(selfUnhide.response.status()).toBe(403);
    expect(selfUnhide.payload).toEqual({
      error: "Only the organizer can unhide participants",
    });

    for (const memberId of [stella.user.id, ivy.user.id]) {
      const hidden = await hideParticipant(
        request,
        organizer.access,
        code,
        memberId,
      );
      expect(hidden.response.status()).toBe(200);
      expect(hidden.payload).toEqual({ success: true });
    }
    expect(await listedMemberIds(request, organizer.access, code)).toEqual([]);
    expect(
      (
        await listedMemberIds(request, organizer.access, code, {
          includeHidden: true,
        })
      ).sort(),
    ).toEqual([stella.user.id, ivy.user.id].sort());
    expect(
      (await freshResults(request, organizer.access, code)).exclusionReasons,
    ).toEqual(expect.objectContaining({ hidden: 2 }));

    // Stella loses the event and its calendar. She cannot answer while
    // hidden, and joining again does not unhide her.
    const refused = await apiJson(
      request,
      "GET",
      `/events?code=${code}`,
      stella.access,
    );
    expect(refused.response.status()).toBe(404);
    expect(refused.payload).toEqual({ error: "Event not found" });
    const hiddenRead = eventRead(page, code);
    await page.reload();
    expect((await hiddenRead).status()).toBe(404);
    await expectEventNotFound(page, "Event not found");
    await expect(page.getByText(event.name)).toHaveCount(0);
    await expectCalendarAnswer(
      request,
      stella.access,
      code,
      403,
      "You do not have access to this calendar invitation",
    );
    const ownRow = await apiJson(
      request,
      "GET",
      `/events/participants?code=${code}`,
      stella.access,
    );
    expect(ownRow.response.status()).toBe(200);
    const [stellaRow] = ownRow.payload.participants;
    expect(stellaRow).toEqual(
      expect.objectContaining({ id: stella.user.id, hidden: 1 }),
    );
    const answer = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${code}&participantId=${stella.user.id}`,
      stella.access,
      {
        availabilityInperson: stellaRow.availabilityInperson,
        submitted: 1,
        expectedVersion: stellaRow.version,
      },
    );
    expect(answer.response.status()).toBe(403);
    expect(answer.payload).toEqual({
      error: "Excluded participants cannot change availability",
      errorCode: "participant_excluded",
    });
    const rejoin = await apiJson(
      request,
      "POST",
      `/events/participants?code=${code}`,
      stella.access,
      {},
    );
    expect(rejoin.response.status()).toBe(200);
    expect(rejoin.payload.participant.hidden).toBe(1);
    const stellaEventStatus = async () =>
      (
        await apiJson(request, "GET", `/events?code=${code}`, stella.access)
      ).response.status();
    expect(await stellaEventStatus()).toBe(404);

    // Hiding only removes the roster's grant: on an open-link event the code
    // alone lets her read it again.
    await updateEventViaApi(request, organizer.access, code, {
      accessMode: "open_link",
    });
    expect(await stellaEventStatus()).toBe(200);
    await updateEventViaApi(request, organizer.access, code, {
      accessMode: "invite_only",
    });
    expect(await stellaEventStatus()).toBe(404);

    // Ivy's invitation still lets her in, calendar included.
    const ivyRead = await apiJson(
      request,
      "GET",
      `/events?code=${code}`,
      ivy.access,
    );
    expect(ivyRead.response.status()).toBe(200);
    expect(ivyRead.payload.event.name).toBe(event.name);
    await expectCalendarAnswer(
      request,
      ivy.access,
      code,
      404,
      "No active final meeting has been confirmed",
    );

    // Unhiding restores both; an unknown member is not found.
    for (const memberId of [stella.user.id, ivy.user.id]) {
      const unhidden = await unhideParticipant(
        request,
        organizer.access,
        code,
        memberId,
      );
      expect(unhidden.response.status()).toBe(200);
      expect(unhidden.payload.participant).toEqual(
        expect.objectContaining({ id: memberId, hidden: 0 }),
      );
    }
    const missing = await unhideParticipant(
      request,
      organizer.access,
      code,
      crypto.randomUUID(),
    );
    expect(missing.response.status()).toBe(404);
    expect(missing.payload).toEqual({ error: "Participant not found" });
    expect(
      (await listedMemberIds(request, organizer.access, code)).sort(),
    ).toEqual([stella.user.id, ivy.user.id].sort());
    expect(await stellaEventStatus()).toBe(200);
    await page.reload();
    await expect(welcomeHeading(page, "Stella Stranger")).toBeVisible();

    // Once the meeting is confirmed, Stella downloads its calendar file.
    const [best] = (await freshResults(request, organizer.access, code))
      .recommendations;
    await finalizeViaApi(request, organizer.access, code, best);
    const calendar = await finalCalendar(request, stella.access, code);
    expect(calendar.status()).toBe(200);
    expect(calendar.headers()["content-type"]).toContain("text/calendar");
    expect(await calendar.text()).toContain("BEGIN:VCALENDAR");
  });
});
