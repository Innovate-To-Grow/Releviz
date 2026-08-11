"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MdAdd, MdArrowForward, MdCheckCircle, MdGroups, MdLink, MdSearch } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import { useAuth } from "@/components/auth/AuthContext";

function HomePage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [eventCode, setEventCode] = useState("");

  const handleOrganize = () => {
    if (loading) return;
    router.push(user ? "/create" : "/signup?next=%2Fcreate");
  };

  const handleJoin = (submitEvent) => {
    submitEvent?.preventDefault();
    if (loading) return;
    const code = eventCode.trim();
    if (!code) return;
    const eventPath = `/event?code=${encodeURIComponent(code)}`;
    router.push(user ? eventPath : `/login?next=${encodeURIComponent(eventPath)}`);
  };

  return (
    <>
      <AppHeader />
      <main className="home-page">
        <section className="home-hero" aria-labelledby="home-heading">
          <div className="home-hero-copy">
            <p className="home-eyebrow">Group scheduling without the back-and-forth</p>
            <h1 id="home-heading">Find a time that works for everyone.</h1>
            <p className="home-lede">
              Create a scheduling poll, share one link, and watch the best meeting times appear as
              your group responds.
            </p>

            <div className="home-hero-actions">
              <AppButton
                onClick={handleOrganize}
                icon={<MdAdd />}
                disabled={loading}
                className="home-create-button"
              >
                Create a scheduling poll
              </AppButton>
              {user ? (
                <Link className="home-secondary-link" href="/dashboard">
                  Go to my dashboard <MdArrowForward aria-hidden="true" />
                </Link>
              ) : (
                <p className="home-action-note">
                  New here? Creating a poll starts with a free account.
                </p>
              )}
            </div>
          </div>

          <aside className="home-preview" aria-label="Example group availability">
            <div className="home-preview-heading">
              <div>
                <p>Project kickoff</p>
                <span>5 people responded</span>
              </div>
              <span className="home-preview-status">
                <MdCheckCircle aria-hidden="true" /> Live
              </span>
            </div>
            <div className="home-preview-grid" aria-hidden="true">
              <span></span>
              <strong>Mon</strong>
              <strong>Tue</strong>
              <strong>Wed</strong>
              <span>10 AM</span>
              <i className="overlap-2"></i>
              <i className="overlap-4"></i>
              <i className="overlap-3"></i>
              <span>11 AM</span>
              <i className="overlap-3"></i>
              <i className="overlap-5"></i>
              <i className="overlap-4"></i>
              <span>12 PM</span>
              <i className="overlap-2"></i>
              <i className="overlap-3"></i>
              <i className="overlap-2"></i>
            </div>
            <p className="home-preview-result">
              <strong>Best overlap:</strong> Tuesday at 11:00 AM
            </p>
          </aside>
        </section>

        <section className="home-join-section" aria-labelledby="join-heading">
          <div className="home-role-intro">
            <span className="home-role-icon">
              <MdGroups aria-hidden="true" />
            </span>
            <div>
              <p className="home-role-label">I&apos;ve been invited</p>
              <h2 id="join-heading">Open an existing poll</h2>
              <p>Use the event code from your organizer to add or update your availability.</p>
            </div>
          </div>
          <form className="home-code-form" onSubmit={handleJoin}>
            <label htmlFor="event-code">Event code</label>
            <div className="home-code-row">
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
              <AppButton type="submit" icon={<MdSearch />} disabled={loading || !eventCode.trim()}>
                Open event
              </AppButton>
            </div>
            {!user && (
              <p className="home-code-help">
                We&apos;ll ask you to log in or create an account, then bring you straight to the
                event.
              </p>
            )}
          </form>
        </section>

        <section className="home-steps" aria-labelledby="steps-heading">
          <p className="home-eyebrow">One shared view, one clear answer</p>
          <h2 id="steps-heading">How Releviz works</h2>
          <ol>
            <li>
              <span>1</span>
              <div>
                <h3>Suggest the options</h3>
                <p>Pick the dates, time range, location, and response deadline.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <h3>Share one link</h3>
                <p>Invite your group with a secure link or event code—no spreadsheet required.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <h3>Choose the best time</h3>
                <p>Compare everyone&apos;s availability and finalize the strongest overlap.</p>
              </div>
            </li>
          </ol>
          <div className="home-trust-note">
            <MdLink aria-hidden="true" />
            Each poll keeps its own shareable code, participants, and live result.
          </div>
        </section>
      </main>
    </>
  );
}

export default HomePage;
