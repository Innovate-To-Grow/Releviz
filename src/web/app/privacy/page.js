import Link from "next/link";
import AppHeader from "@/components/ui/AppHeader";
import PageHeader from "@/components/ui/PageHeader";

export const metadata = {
  title: "Privacy | Releviz",
};

export default function PrivacyPage() {
  return (
    <>
      <AppHeader pageTitle="Privacy" />
      <main className="page-shell page-shell--reading">
        <article className="card">
          <div className="card-body reading-content">
            <PageHeader
              eyebrow="Releviz policies"
              title="Privacy notice"
              lede="Last updated July 16, 2026"
            />

            <section>
              <h2>Information Releviz handles</h2>
              <p>
                Releviz stores account and contact information, event settings,
                invitations, availability responses, confirmed meeting details,
                and email delivery records. Security records can include session
                timestamps, IP addresses, and browser identifiers.
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
                You can update or delete your account at any time from{" "}
                <Link href="/settings">Account settings</Link>. Account deletion
                removes the account and its linked participation as described
                above.
              </p>
            </section>
          </div>
        </article>
      </main>
    </>
  );
}
