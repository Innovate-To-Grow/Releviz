import Link from "next/link";

export const metadata = {
  title: "Terms | Releviz",
};

export default function TermsPage() {
  return (
    <main className="page-pad legal-shell">
      <article className="md-card legal-content">
        <header>
          <p className="legal-eyebrow">Releviz policies</p>
          <h1>Terms of service</h1>
          <p>Last updated July 16, 2026</p>
        </header>

        <section>
          <h2>Using the service</h2>
          <p>
            Releviz is provided for coordinating meeting availability. Use the
            service lawfully, provide accurate account information, protect your
            credentials, and access only events you are authorized to use.
          </p>
        </section>

        <section>
          <h2>Organizer responsibilities</h2>
          <p>
            Organizers are responsible for the people they invite, the event
            information they enter, their visibility settings, and the final
            meeting they confirm. Do not upload confidential information that is
            unnecessary for scheduling.
          </p>
        </section>

        <section>
          <h2>Prohibited conduct</h2>
          <p>
            Do not probe or bypass access controls, abuse invitations or email
            delivery, interfere with service operation, impersonate another
            person, or use Releviz to distribute unlawful or harmful content.
          </p>
        </section>

        <section>
          <h2>Service changes and availability</h2>
          <p>
            The service may change as reliability, security, and usability
            improve. Access can be limited to protect users or infrastructure.
            Scheduling and email delivery depend on external systems, so
            uninterrupted availability is not guaranteed.
          </p>
        </section>

        <section>
          <h2>Accounts and data</h2>
          <p>
            You may stop using Releviz or delete your account from Account
            settings. Data handling is described in the{" "}
            <Link href="/privacy">privacy notice</Link>. Questions about these
            terms can be submitted through <Link href="/support">support</Link>.
          </p>
        </section>
      </article>
    </main>
  );
}
