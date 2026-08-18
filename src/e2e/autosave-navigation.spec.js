const { test, expect } = require("@playwright/test");

const tempAccessSession = {
  event: {
    code: "ABC123",
    name: "Autosave navigation check",
    mode: "inperson",
    status: "active",
    timezone: "UTC",
    responseDeadline: "2099-01-01T00:00:00Z",
    slotCount: 2,
    slotGroups: [
      {
        key: "monday",
        label: "Monday",
        slots: [
          {
            index: 0,
            startsAt: "2098-12-01T09:00:00Z",
            endsAt: "2098-12-01T09:30:00Z",
          },
          {
            index: 1,
            startsAt: "2098-12-01T09:30:00Z",
            endsAt: "2098-12-01T10:00:00Z",
          },
        ],
      },
    ],
  },
  participant: {
    id: "temporary-participant",
    name: "Temporary Participant",
    availabilityInperson: [0, 0],
    availabilityVirtual: [0, 0],
    submitted: false,
    version: 1,
  },
  email: "temporary@example.com",
  results: null,
  canViewResults: false,
};

test("Back waits for a held autosave across a document-history boundary", async ({
  page,
}) => {
  let observeSave;
  let releaseSave;
  let savedPayload;
  const saveStarted = new Promise((resolve) => {
    observeSave = resolve;
  });
  const saveRelease = new Promise((resolve) => {
    releaseSave = resolve;
  });

  await page.route("**/events/temp-access/**", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") {
      await route.fulfill({ json: tempAccessSession });
      return;
    }

    savedPayload = request.postDataJSON();
    observeSave();
    await saveRelease;
    await route.fulfill({
      json: {
        participant: {
          ...tempAccessSession.participant,
          availabilityInperson: savedPayload.availabilityInperson,
          availabilityVirtual: savedPayload.availabilityVirtual,
          version: 2,
        },
      },
    });
  });

  await page.goto("/");
  await page.goto("/temp-access?code=ABC123");
  await expect(
    page.getByRole("heading", { name: "Autosave navigation check" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Apply to all" }).click();
  await expect(page.getByText("Saving draft…")).toBeVisible();
  const backNavigation = page.goBack();

  await saveStarted;
  await expect(page).toHaveURL(/\/temp-access\?code=ABC123$/);
  expect(savedPayload).toEqual(
    expect.objectContaining({
      availabilityInperson: [1, 1],
      submitted: 0,
      expectedVersion: 1,
    }),
  );

  releaseSave();
  await backNavigation;
  await expect(page).toHaveURL(/\/$/);
});
