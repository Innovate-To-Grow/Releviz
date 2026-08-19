"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import { useAuth } from "@/components/auth/AuthContext";

function HomePage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [eventCode, setEventCode] = useState("");

  const handleOrganize = () => {
    if (loading) return;
    router.push(user ? "/create" : "/login?next=%2Fcreate");
  };

  const handleJoin = (submitEvent) => {
    submitEvent?.preventDefault();
    if (loading) return;
    const code = eventCode.trim();
    if (!code) return;
    const eventPath = `/event?code=${encodeURIComponent(code)}`;
    router.push(
      user ? eventPath : `/login?next=${encodeURIComponent(eventPath)}`,
    );
  };

  return (
    <>
      <AppHeader />
      <main>
        <section aria-labelledby="home-heading">
          <p>Group scheduling without the back-and-forth</p>
          <h1 id="home-heading">Find a time that works for everyone.</h1>
          <p>
            Create a scheduling poll, share one link, and watch the best meeting
            times appear as your group responds.
          </p>

          <AppButton onClick={handleOrganize} disabled={loading}>
            Create a scheduling poll
          </AppButton>
          {user ? (
            <Link href="/dashboard">Go to my dashboard</Link>
          ) : (
            <p>Continue with your email to create a free account.</p>
          )}

          <aside aria-label="Example group availability">
            <p>Project kickoff</p>
            <p>5 people responded</p>
            <p>Live</p>
            <p>
              <strong>Best overlap:</strong> Tuesday at 11:00 AM
            </p>
          </aside>
        </section>

        <section aria-labelledby="join-heading">
          <p>I&apos;ve been invited</p>
          <h2 id="join-heading">Open an existing poll</h2>
          <p>
            Use the event code from your organizer to add or update your
            availability.
          </p>
          <form onSubmit={handleJoin}>
            <label htmlFor="event-code">Event code</label>
            <input
              id="event-code"
              name="eventCode"
              value={eventCode}
              onChange={(event) => setEventCode(event.target.value)}
              placeholder="e.g. ABC123"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck="false"
            />
            <AppButton type="submit" disabled={loading || !eventCode.trim()}>
              Open event
            </AppButton>
            {!user && (
              <p>
                We&apos;ll verify your email, then bring you straight to the
                event.
              </p>
            )}
          </form>
        </section>

        <section aria-labelledby="steps-heading">
          <p>One shared view, one clear answer</p>
          <h2 id="steps-heading">How Releviz works</h2>
          <ol>
            <li>
              <h3>Suggest the options</h3>
              <p>
                Pick the dates, time range, location, and response deadline.
              </p>
            </li>
            <li>
              <h3>Share one link</h3>
              <p>
                Invite your group with a secure link or event code—no
                spreadsheet required.
              </p>
            </li>
            <li>
              <h3>Choose the best time</h3>
              <p>
                Compare everyone&apos;s availability and finalize the strongest
                overlap.
              </p>
            </li>
          </ol>
          <p>
            Each poll keeps its own shareable code, participants, and live
            result.
          </p>
        </section>
      </main>
    </>
  );
}

export default HomePage;
