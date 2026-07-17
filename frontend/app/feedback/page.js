"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import AppButton from "@/components/ui/AppButton";
import { submitFeedback } from "@/lib/api/feedback";

export function safeFeedbackPath(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "";
  return value.split(/[?#]/, 1)[0].slice(0, 500);
}

export function FeedbackForm() {
  const searchParams = useSearchParams();
  const [category, setCategory] = useState("problem");
  const [message, setMessage] = useState("");
  const [consentToFollowUp, setConsentToFollowUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setSent(false);
    try {
      await submitFeedback({
        category,
        message,
        pagePath: safeFeedbackPath(searchParams.get("from")),
        consentToFollowUp,
      });
      setMessage("");
      setConsentToFollowUp(false);
      setSent(true);
    } catch (submitError) {
      setError(submitError.message || "Unable to send feedback. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="page-pad legal-shell">
      <div className="md-card feedback-panel">
        <header>
          <p className="legal-eyebrow">Help improve Releviz</p>
          <h1>Send feedback</h1>
          <p>
            Report a problem, confusing workflow, or idea. Feedback is reviewed by service
            operators.
          </p>
        </header>

        {sent && (
          <div className="auth-status" role="status" aria-live="polite">
            Thank you. Your feedback was received.
          </div>
        )}
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}

        <form className="feedback-form" onSubmit={handleSubmit}>
          <label className="field-label">
            Feedback type
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="problem">Problem</option>
              <option value="usability">Something was hard to use</option>
              <option value="idea">Idea</option>
              <option value="other">Other</option>
            </select>
          </label>

          <label className="field-label">
            What happened, or what would you change?
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              minLength={3}
              maxLength={5000}
              rows={8}
              required
            />
          </label>
          <p className="field-help">
            Do not include passwords, verification codes, private invitation links, or detailed
            participant availability. {message.length}/5000 characters
          </p>

          <label className="feedback-consent">
            <input
              type="checkbox"
              checked={consentToFollowUp}
              onChange={(event) => setConsentToFollowUp(event.target.checked)}
            />
            <span>
              If I am signed in, the service team may follow up using my account contact
              information.
            </span>
          </label>

          <AppButton type="submit" disabled={submitting}>
            {submitting ? "Sending…" : "Send feedback"}
          </AppButton>
        </form>
      </div>
    </main>
  );
}

export default function FeedbackPage() {
  return (
    <Suspense
      fallback={
        <main className="page-pad legal-shell">
          <div className="md-card feedback-panel">
            <p role="status">Loading feedback form…</p>
          </div>
        </main>
      }
    >
      <FeedbackForm />
    </Suspense>
  );
}
