const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { expect, test: base } = require("@playwright/test");

const execFileAsync = promisify(execFile);
const test = base.extend({
  mailDirectory: async ({}, use) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "releviz-mail-"));
    try {
      await use(directory);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
});

async function readVerificationCode(mailDirectory, email, afterMs, purpose) {
  // The helper reads its sink from the environment at module load. A fresh
  // process keeps both the mail files and module state private to this test.
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "-e",
      `const [helper, input] = process.argv.slice(1);
       const { email, afterMs, purpose } = JSON.parse(input);
       require(helper).latestVerificationCode(email, afterMs, purpose)
         .then(code => process.stdout.write(code))
         .catch(error => { console.error(error.message); process.exitCode = 1; });`,
      path.join(__dirname, "helpers/releviz.js"),
      JSON.stringify({ email, afterMs, purpose }),
    ],
    { env: { ...process.env, EMAIL_FILE_PATH: mailDirectory } },
  );
  return stdout;
}

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
    test(`reads the newest ${purpose} code for the requested recipient`, async ({
      mailDirectory,
    }) => {
      const fixtureId = randomUUID();
      const email = `email-helper-${fixtureId}@example.com`;
      const otherEmail = `other-${fixtureId}@example.com`;
      const wrongSubject =
        purpose === "login"
          ? PURPOSE_SUBJECTS.register
          : PURPOSE_SUBJECTS.login;
      const timestamp = Date.now() - 5_000;
      async function writeEmailFile(label, body, offset) {
        const file = path.join(
          mailDirectory,
          `email-helper-${fixtureId}-${label}.log`,
        );
        await fs.writeFile(file, body);
        const modifiedAt = new Date(timestamp + offset);
        await fs.utimes(file, modifiedAt, modifiedAt);
      }

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
        readVerificationCode(mailDirectory, email, timestamp - 1_000, purpose),
      ).resolves.toBe("222222");
    });
  }

  test("rejects a missing or unknown verification purpose", async ({
    mailDirectory,
  }) => {
    const email = `email-helper-${randomUUID()}@example.com`;
    await expect(
      readVerificationCode(mailDirectory, email, Date.now()),
    ).rejects.toThrow(/Unknown verification email purpose: undefined/);
    await expect(
      readVerificationCode(
        mailDirectory,
        email,
        Date.now(),
        "unsupported-purpose",
      ),
    ).rejects.toThrow(
      /Unknown verification email purpose: unsupported-purpose/,
    );
  });
});
