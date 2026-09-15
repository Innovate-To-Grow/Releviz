import Link from "next/link";
import AppHeader from "@/components/ui/AppHeader";
import PageHeader from "@/components/ui/PageHeader";
import { SendIcon } from "@/components/ui/icons";

export const metadata = {
  title: "Support | Releviz",
};

export default function SupportPage() {
  return (
    <>
      <AppHeader pageTitle="Support" />
      <main className="page-shell page-shell--reading">
        <article className="card">
          <div className="card-body reading-content">
            <PageHeader
              eyebrow="Help and support"
              title="How can we help?"
              lede="Send a problem report or product question through the secure feedback form."
            />

            <section>
              <h2>Report a problem</h2>
              <p>
                Describe what you were trying to do, what happened, and whether
                retrying helped. Do not include a password, verification code,
                private invitation link, or another participant&apos;s schedule.
              </p>
              <Link
                className="btn btn-primary app-btn support-action"
                href="/feedback?from=/support"
              >
                <span className="app-btn-icon" aria-hidden="true">
                  <SendIcon />
                </span>
                <span className="app-btn-label">Open feedback form</span>
              </Link>
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
                  The visible error message, without personal or schedule
                  details.
                </li>
                <li>Whether the issue happens again after a retry.</li>
              </ul>
            </section>
          </div>
        </article>
      </main>
    </>
  );
}
