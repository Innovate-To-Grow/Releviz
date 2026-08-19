import Link from "next/link";
import AppHeader from "@/components/ui/AppHeader";

export const metadata = {
  title: "Support | Releviz",
};

export default function SupportPage() {
  return (
    <>
      <AppHeader />
      <main>
        <article>
          <header>
            <p>Help and support</p>
            <h1>How can we help?</h1>
            <p>
              Send a problem report or product question through the secure
              feedback form.
            </p>
          </header>

          <section>
            <h2>Report a problem</h2>
            <p>
              Describe what you were trying to do, what happened, and whether
              retrying helped. Do not include a password, verification code,
              private invitation link, or another participant&apos;s schedule.
            </p>
            <Link href="/feedback?from=/support">Open feedback form</Link>
          </section>

          <section>
            <h2>Account help</h2>
            <p>
              Use <Link href="/recover">account recovery</Link> if you cannot
              sign in. Signed-in users can change passwords, review sessions,
              sign out other devices, or delete an account from{" "}
              <Link href="/settings">Account settings</Link>.
            </p>
          </section>

          <section>
            <h2>Include useful context</h2>
            <ul>
              <li>The page or workflow where the issue happened.</li>
              <li>The action you expected to complete.</li>
              <li>
                The visible error message, without personal or schedule details.
              </li>
              <li>Whether the issue happens again after a retry.</li>
            </ul>
          </section>
        </article>
      </main>
    </>
  );
}
