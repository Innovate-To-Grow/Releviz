import Link from "next/link";
import { ButtonLink } from "@/components/ui/Button";
import AppHeader from "@/components/ui/AppHeader";
import { Eyebrow } from "@/components/ui/Surface";

export const metadata = {
  title: "Support | Releviz",
};

export default function SupportPage() {
  return (
    <>
      <AppHeader />
      <main id="main" className="rv-page rv-page--prose">
        <article className="rv-stack rv-stack--xl">
          <header className="rv-page-header">
            <Eyebrow icon="info">Help and support</Eyebrow>
            <h1 className="rv-page-header__title">How can we help?</h1>
            <p className="rv-page-header__lede">
              Send a problem report or product question through the secure
              feedback form.
            </p>
          </header>

          <div className="rv-prose">
            <section>
              <h2>Report a problem</h2>
              <p>
                Describe what you were trying to do, what happened, and whether
                retrying helped. Do not include a password, verification code,
                private invitation link, or another participant&apos;s schedule.
              </p>
              <div className="rv-btn-row">
                <ButtonLink
                  href="/feedback?from=/support"
                  variant="primary"
                  icon="mail"
                >
                  Open feedback form
                </ButtonLink>
              </div>
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
