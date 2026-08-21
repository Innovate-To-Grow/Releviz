import Link from "next/link";
import AppHeader from "@/components/ui/AppHeader";
import { Eyebrow } from "@/components/ui/Surface";

export const metadata = {
  title: "Privacy | Releviz",
};

export default function PrivacyPage() {
  return (
    <>
      <AppHeader />
      <main id="main" className="rv-page rv-page--prose">
        <article className="rv-stack rv-stack--xl">
          <header className="rv-page-header">
            <Eyebrow icon="shield">Releviz policies</Eyebrow>
            <h1 className="rv-page-header__title">Privacy notice</h1>
            <p className="rv-page-header__lede">Last updated July 16, 2026</p>
          </header>

          <div className="rv-prose">
            <section>
              <h2>Information Releviz handles</h2>
              <p>
                Releviz stores account and contact information, event settings,
                invitations, availability responses, confirmed meeting details,
                email delivery records, and feedback you choose to submit.
                Security records can include session timestamps, IP addresses,
                and browser identifiers.
              </p>
            </section>

            <section>
              <h2>How information is used</h2>
              <p>
                This information is used to authenticate users, coordinate
                availability, deliver invitations and confirmations, prevent
                abuse, recover accounts, diagnose failures, and improve the
                scheduling workflow. Releviz does not sell personal information
                or use schedule data for advertising.
              </p>
            </section>

            <section>
              <h2>Visibility and sharing</h2>
              <p>
                Event organizers control participant result visibility. Backend
                permission checks enforce those choices. Information is also
                processed by infrastructure and email providers only as needed
                to operate the service.
              </p>
            </section>

            <section>
              <h2>Retention and deletion</h2>
              <p>
                Event and account records remain while needed to provide the
                service or until an authorized deletion. Account deletion
                removes the account and linked participation; invitation and
                audit records belonging to another organizer&apos;s event may
                remain without the account link. Expired authentication security
                state is pruned on a defined schedule. Backups expire according
                to the service backup policy.
              </p>
            </section>

            <section>
              <h2>Privacy choices</h2>
              <p>
                You can update or delete your account from Account settings. For
                access, correction, deletion, or privacy questions, use the{" "}
                <Link href="/support">support page</Link>. Never send passwords,
                verification codes, or private invitation links through
                feedback.
              </p>
            </section>
          </div>
        </article>
      </main>
    </>
  );
}
