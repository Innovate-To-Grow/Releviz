const { expect, test } = require("@playwright/test");
const {
  apiJson,
  createEvent,
  eventState,
  newAccountContext,
  newRunId,
  readSession,
  recomputeEventResults,
  refreshWorkspace,
  registerAccount,
  selectOption,
  slotIndex,
  submitResponse,
  updateEventViaApi,
} = require("./helpers/releviz");
const {
  attendanceTile,
  chooseRankedWindow,
  overviewTile,
  reviewAttendance,
} = require("./helpers/workspace");

// Who may open an event. An invite-only event is "not found" for a stranger
// (event page, /edit and the API alike) until the organizer switches it to
// "Anyone with the event code" in the inline editor. A stranger who joins
// sees only their own calendar: results and activity stay organizer-only
// whatever participantViewPermission says. Joined people keep access after
// the event goes back to invite-only, lose it while hidden, and get it back
// when unhidden. The /edit error cards cover a missing code, a
// non-organizer, and a signed-out visitor.

// Opens the workspace's inline editor. A click that lands while the
// workspace re-renders after loading can be dropped by slower engines, so it
// is retried until the editor shows; the button is disabled while the editor
// is open, so a retry never closes it again.
async function openInlineEditor(page) {
  const region = page.getByRole("region", { name: "Edit event" });
  const editButton = page.getByRole("button", { name: "Edit event" });
  await expect
    .poll(
      async () => {
        if (!(await region.isVisible())) await editButton.click();
        return region.isVisible();
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return region;
}

async function expectEditError(page, message) {
  await expect(
    page.getByRole("heading", { name: "Unable to edit event" }),
  ).toBeVisible();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
}

async function expectEventNotFound(page) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Event Not Found" }),
  ).toBeVisible();
  await expect(page.getByText("Event unavailable")).toBeVisible();
  await expect(
    page.getByText("Event not found", { exact: true }),
  ).toBeVisible();
}

test.describe("Event access", () => {
  test("keeps invite-only events hidden from strangers, opens them by code, keeps results organizer-only, and hides participants on demand", async ({
    browser,
    page,
    request,
  }) => {
    // Two accounts register through the passwordless flow.
    test.setTimeout(180_000);
    const runId = newRunId();
    await registerAccount(
      page,
      `access-org-${runId}@example.com`,
      "Orla",
      "Owner",
    );
    const token = (await readSession(page)).access;
    const {
      context: strangerContext,
      page: spage,
      token: stoken,
      session: ssession,
    } = await newAccountContext(
      browser,
      `access-stella-${runId}@example.com`,
      "Stella",
      "Stranger",
    );
    const strangerId = ssession.user.id;
    const event = await createEvent(request, token, {
      name: `Access ${runId}`,
      accessMode: "invite_only",
    });
    // The helper opens results to participants as widely as the setting
    // allows; it must not matter.
    expect(event.participantViewPermission).toBe("realtime");
    const { code } = event;
    const adaEmail = `ada-${runId}@example.com`;
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    await submitResponse(request, token, event, {
      name: "Ada",
      email: adaEmail,
      inperson: [mon10, mon10 + 1],
    });

    // 1) An invite-only event does not exist for a stranger.
    await spage.goto(`/event?code=${code}`);
    await expectEventNotFound(spage);
    await expect(
      spage.getByRole("link", { name: "Create New Event" }),
    ).toHaveAttribute("href", "/create");

    // 2) Nor can they edit it; the error card leads back to the dashboard.
    await spage.goto(`/edit?code=${code}`);
    await expectEditError(spage, "Event not found");
    await spage.getByRole("link", { name: "Return to dashboard" }).click();
    await expect(spage).toHaveURL(/\/dashboard$/);
    await expect(
      spage.getByRole("heading", { name: "My Dashboard" }),
    ).toBeVisible();

    // 3) The API refuses to let them join or list participants.
    const refusedJoin = await apiJson(
      request,
      "POST",
      `/events/participants?code=${code}`,
      stoken,
    );
    expect(refusedJoin.response.status()).toBe(403);
    expect(refusedJoin.payload).toEqual({
      error: "This event is limited to invited participants",
    });
    const refusedList = await apiJson(
      request,
      "GET",
      `/events/participants?code=${code}`,
      stoken,
    );
    expect(refusedList.response.status()).toBe(403);
    expect(refusedList.payload).toEqual({
      error: "You must join this event before viewing participants",
    });

    // 4) A signed-out visitor is sent to sign in, then back to the editor.
    const anonymous = await browser.newContext();
    try {
      const anonPage = await anonymous.newPage();
      await anonPage.goto(`/edit?code=${code}`);
      await expect(anonPage).toHaveURL(
        new RegExp(`/login\\?next=%2Fedit%3Fcode%3D${code}$`),
      );
    } finally {
      await anonymous.close();
    }

    // 5) /edit without a code.
    await page.goto("/edit");
    await expectEditError(page, "No event code was provided for editing.");

    // 6) The organizer opens the event by code in the inline editor. Access
    // is not part of the schedule, so Ada's response survives the save.
    await page.goto(`/event?code=${code}`);
    await expect(page.locator(".event-role-badge")).toHaveText("Organizer");
    await expect(overviewTile(page, "Responses")).toContainText("Invite only");
    const region = await openInlineEditor(page);
    await selectOption(
      page,
      "Event Access",
      "Anyone with the event code",
      "open_link",
    );
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === "/events" &&
        response.url().includes(`code=${code}`),
    );
    await region.getByRole("button", { name: "Save changes" }).click();
    expect((await saved).status()).toBe(200);
    await expect(
      page.getByRole("status").filter({ hasText: "Event changes saved." }),
    ).toBeVisible();
    await expect(
      page.getByText("Schedule changes require a response reset"),
    ).toHaveCount(0);
    await expect(overviewTile(page, "Responses")).toContainText(
      "Anyone with code",
    );
    expect((await eventState(request, token, code)).accessMode).toBe(
      "open_link",
    );
    const roster = await apiJson(
      request,
      "GET",
      `/events/participants?code=${code}`,
      token,
    );
    expect(roster.response.status()).toBe(200);
    const ada = roster.payload.participants.find(
      (participant) => participant.email === adaEmail,
    );
    expect(ada.submitted).toBeTruthy();

    // 7) Anyone with the code can join, but only the organizer can edit.
    await spage.goto(`/edit?code=${code}`);
    await expectEditError(spage, "Only the organizer can edit this event.");

    // 8) The stranger joins and sees only their own calendar.
    await spage.goto(`/event?code=${code}`);
    await expect(
      spage.getByRole("heading", { level: 2, name: "Join Event" }),
    ).toBeVisible();
    await expect(spage.getByText("Your invitation")).toBeVisible();
    await spage
      .getByRole("button", { name: "Join as Stella Stranger" })
      .click();
    await expect(spage.getByText(/Welcome, Stella Stranger/)).toBeVisible();
    await expect(spage.locator(".event-role-badge")).toHaveText("Participant");
    await expect(
      spage.getByRole("heading", { name: "Mark times as" }),
    ).toBeVisible();
    await expect(
      spage.getByRole("heading", { name: "Results", exact: true }),
    ).toHaveCount(0);
    await expect(
      spage.getByRole("complementary", { name: "Ranked windows" }),
    ).toHaveCount(0);

    // 9) Results and activity stay organizer-only; the participant list holds
    // only their own row.
    const results = await apiJson(
      request,
      "GET",
      `/events/results?code=${code}`,
      stoken,
    );
    expect(results.response.status()).toBe(403);
    expect(results.payload).toEqual({
      error: "You do not have permission to view event results",
    });
    const activity = await apiJson(
      request,
      "GET",
      `/events/activity?code=${code}`,
      stoken,
    );
    expect(activity.response.status()).toBe(403);
    expect(activity.payload).toEqual({
      error: "You do not have permission to view event activity",
    });
    const own = await apiJson(
      request,
      "GET",
      `/events/participants?code=${code}`,
      stoken,
    );
    expect(own.response.status()).toBe(200);
    expect(own.payload.participants).toHaveLength(1);
    expect(own.payload.participants[0].id).toBe(strangerId);

    // 10) Back to invite-only: people who already joined keep access.
    await updateEventViaApi(request, token, code, {
      accessMode: "invite_only",
    });
    await spage.reload();
    await expect(spage.getByText(/Welcome, Stella Stranger/)).toBeVisible();

    // 11) Hiding a participant removes them from the default list and takes
    // their access away.
    const hidden = await apiJson(
      request,
      "DELETE",
      `/events/participants/update?code=${code}&participantId=${strangerId}`,
      token,
    );
    expect(hidden.response.status()).toBe(200);
    expect(hidden.payload).toEqual({ success: true });
    const visibleList = await apiJson(
      request,
      "GET",
      `/events/participants?code=${code}`,
      token,
    );
    expect(
      visibleList.payload.participants.map(
        (participant) => participant.memberId,
      ),
    ).not.toContain(strangerId);
    const fullList = await apiJson(
      request,
      "GET",
      `/events/participants?code=${code}&includeHidden=true`,
      token,
    );
    expect(
      fullList.payload.participants.map((participant) => participant.memberId),
    ).toContain(strangerId);
    await spage.reload();
    await expectEventNotFound(spage);

    // 12) The organizer's attendance review lists them as excluded.
    recomputeEventResults(code);
    await refreshWorkspace(page);
    await chooseRankedWindow(page, 0);
    await reviewAttendance(page);
    await expect(attendanceTile(page, "Excluded")).toHaveText("1");
    await expect(attendanceTile(page, "Available")).toHaveText("1");
    const stellaRow = page
      .getByRole("table", { name: "Attendance by person" })
      .getByRole("row", { name: /Stella Stranger/ });
    await expect(stellaRow).toContainText("Not included");
    await expect(stellaRow).toContainText("Hidden from results");

    // 13) Unhiding restores their access.
    const unhidden = await apiJson(
      request,
      "PUT",
      `/events/participants/update/unhide?code=${code}&participantId=${strangerId}`,
      token,
    );
    expect(unhidden.response.status()).toBe(200);
    expect(unhidden.payload.participant.hidden).toBe(0);
    await spage.reload();
    await expect(spage.getByText(/Welcome, Stella Stranger/)).toBeVisible();
    await strangerContext.close();
  });
});
