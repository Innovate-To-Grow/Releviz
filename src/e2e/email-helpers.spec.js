const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  EMAIL_FILE_PATH,
  latestVerificationCode,
} = require("./helpers/releviz");

const PURPOSE_SUBJECTS = {
  register: "Verify your email - Releviz",
  login: "Your login code - Releviz",
  password_reset: "Password reset code - Releviz",
  account_delete: "Delete account code - Releviz",
  temp_event_access: "Your verification code - Releviz",
};

function emailMessage(recipient, subject, code) {
  return [
    `To: ${recipient}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    code,
    "-".repeat(79),
    "",
  ].join("\n");
}

test.describe("Verification email selection", () => {
  for (const [purpose, subject] of Object.entries(PURPOSE_SUBJECTS)) {
    test(`reads the newest ${purpose} code for the requested recipient`, async () => {
      const fixtureId = randomUUID();
      const email = `email-helper-${fixtureId}@example.com`;
      const otherEmail = `other-${fixtureId}@example.com`;
      const wrongSubject =
        purpose === "login"
          ? PURPOSE_SUBJECTS.register
          : PURPOSE_SUBJECTS.login;
      const timestamp = Date.now() - 5_000;
      const fixtureFiles = [];

      async function writeEmailFile(label, body, offset) {
        const file = path.join(
          EMAIL_FILE_PATH,
          `email-helper-${fixtureId}-${label}.log`,
        );
        fixtureFiles.push(file);
        await fs.writeFile(file, body);
        const modifiedAt = new Date(timestamp + offset);
        await fs.utimes(file, modifiedAt, modifiedAt);
      }

      await fs.mkdir(EMAIL_FILE_PATH, { recursive: true });
      try {
        // Django can append multiple messages to one file. All of them have
        // the same file mtime, so the last matching message must win.
        await writeEmailFile(
          "matching",
          emailMessage(email, subject, "111111") +
            emailMessage(email, subject, "222222"),
          0,
        );
        await writeEmailFile(
          "wrong-purpose",
          emailMessage(email, wrongSubject, "333333"),
          1_000,
        );
        await writeEmailFile(
          "wrong-recipient",
          emailMessage(otherEmail, subject, "444444"),
          2_000,
        );

        await expect(
          latestVerificationCode(email, timestamp - 1_000, purpose),
        ).resolves.toBe("222222");
      } finally {
        await Promise.all(
          fixtureFiles.map((file) => fs.rm(file, { force: true })),
        );
      }
    });
  }

  test("rejects a missing or unknown verification purpose", async () => {
    const email = `email-helper-${randomUUID()}@example.com`;
    await expect(latestVerificationCode(email, Date.now())).rejects.toThrow(
      /purpose/i,
    );
    await expect(
      latestVerificationCode(email, Date.now(), "unsupported-purpose"),
    ).rejects.toThrow(/purpose/i);
  });
});
