"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import AppHeader from "@/components/ui/AppHeader";
import Button from "@/components/ui/Button";
import { Callout, LoadingState } from "@/components/ui/Feedback";
import { Checkbox, Field, Select, TextArea } from "@/components/ui/Form";
import { Card, PageHeader } from "@/components/ui/Surface";
import { submitFeedback } from "@/lib/api/feedback";

export function safeFeedbackPath(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "";
  return value.split(/[?#]/, 1)[0].slice(0, 500);
}

const MESSAGE_LIMIT = 5000;

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
    <main id="main" className="rv-page rv-page--form">
      <div className="rv-stack rv-stack--lg">
        <PageHeader
          eyebrow="Help improve Releviz"
          eyebrowIcon="sparkle"
          title="Send feedback"
          description="Report a problem, confusing workflow, or idea. Feedback is reviewed by service operators."
        />

        {sent && (
          <Callout tone="success" role="status" aria-live="polite">
            Thank you. Your feedback was received.
          </Callout>
        )}
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}

        <Card>
          <form onSubmit={handleSubmit} className="rv-stack rv-stack--lg">
            <Field label="Feedback type">
              <Select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="problem">Problem</option>
                <option value="usability">Something was hard to use</option>
                <option value="idea">Idea</option>
                <option value="other">Other</option>
              </Select>
            </Field>

            <Field
              label="What happened, or what would you change?"
              hint={`Do not include passwords, verification codes, private invitation links, or detailed participant availability. ${message.length}/${MESSAGE_LIMIT} characters`}
            >
              <TextArea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                minLength={3}
                maxLength={MESSAGE_LIMIT}
                rows={8}
                required
              />
            </Field>

            <Checkbox
              label="If I am signed in, the service team may follow up using my account contact information."
              checked={consentToFollowUp}
              onChange={(event) => setConsentToFollowUp(event.target.checked)}
            />

            <div className="rv-btn-row rv-btn-row--stack rv-btn-row--end">
              <Button
                type="submit"
                variant="primary"
                busy={submitting}
                disabled={submitting}
              >
                {submitting ? "Sending…" : "Send feedback"}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </main>
  );
}

export default function FeedbackPage() {
  return (
    <>
      <AppHeader pageTitle="Feedback" />
      <Suspense
        fallback={
          <main id="main" className="rv-page rv-page--form">
            <LoadingState message="Loading feedback form…" />
          </main>
        }
      >
        <FeedbackForm />
      </Suspense>
    </>
  );
}
