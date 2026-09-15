"use client";

import { Suspense, useState } from "react";
import AppHeader from "@/components/ui/AppHeader";
import { useSearchParams } from "next/navigation";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import FormField from "@/components/ui/FormField";
import LoadingState from "@/components/ui/LoadingState";
import PageHeader from "@/components/ui/PageHeader";
import Panel from "@/components/ui/Panel";
import { SendIcon } from "@/components/ui/icons";
import { submitFeedback } from "@/lib/api/feedback";

const MESSAGE_MAX_LENGTH = 5000;

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
      setError(
        submitError.message || "Unable to send feedback. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="page-shell page-shell--narrow">
      <Panel className="feedback-panel">
        <PageHeader
          eyebrow="Help improve Releviz"
          title="Send feedback"
          lede="Report a problem, confusing workflow, or idea. Feedback is reviewed by service operators."
        />

        {sent && (
          <Alert variant="success" className="mb-3">
            Thank you. Your feedback was received.
          </Alert>
        )}
        {error && (
          <Alert variant="danger" className="mb-3">
            {error}
          </Alert>
        )}

        <form
          className="feedback-form d-flex flex-column gap-3"
          onSubmit={handleSubmit}
        >
          <FormField id="feedback-category" label="Feedback type">
            <select
              className="form-select"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="problem">Problem</option>
              <option value="usability">Something was hard to use</option>
              <option value="idea">Idea</option>
              <option value="other">Other</option>
            </select>
          </FormField>

          <FormField
            id="feedback-message"
            label="What happened, or what would you change?"
            help={
              <>
                Do not include passwords, verification codes, private invitation
                links, or detailed participant availability.{" "}
                <span className="tabular-nums">
                  {message.length}/{MESSAGE_MAX_LENGTH}
                </span>{" "}
                characters
              </>
            }
          >
            <textarea
              className="form-control"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              minLength={3}
              maxLength={MESSAGE_MAX_LENGTH}
              rows={8}
              required
            />
          </FormField>

          <div className="form-check feedback-consent">
            <input
              className="form-check-input"
              type="checkbox"
              id="feedback-consent"
              checked={consentToFollowUp}
              onChange={(event) => setConsentToFollowUp(event.target.checked)}
            />
            <label className="form-check-label" htmlFor="feedback-consent">
              If I am signed in, the service team may follow up using my account
              contact information.
            </label>
          </div>

          <div className="d-flex flex-wrap gap-2">
            <AppButton
              type="submit"
              icon={<SendIcon />}
              busy={submitting}
              disabled={submitting}
            >
              {submitting ? "Sending…" : "Send feedback"}
            </AppButton>
          </div>
        </form>
      </Panel>
    </main>
  );
}

export default function FeedbackPage() {
  return (
    <>
      <AppHeader pageTitle="Feedback" />
      <Suspense
        fallback={
          <main className="page-shell page-shell--narrow">
            <Panel className="feedback-panel">
              <LoadingState label="Loading feedback form…" />
            </Panel>
          </main>
        }
      >
        <FeedbackForm />
      </Suspense>
    </>
  );
}
