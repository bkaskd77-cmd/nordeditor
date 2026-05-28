"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

const FEEDBACK_EMAIL = process.env.NEXT_PUBLIC_FEEDBACK_EMAIL ?? "feedback@nordeditor.app";

const FEEDBACK_CATEGORIES = [
  "Bug",
  "Feature request",
  "Pro access request",
  "Confusing UX",
  "AI answer issue",
  "Other"
] as const;

type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

type OpenFeedbackEventDetail = {
  category?: FeedbackCategory;
  feedback?: string;
};

export default function FeedbackModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [contact, setContact] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("Bug");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    function openFromApp(event: Event) {
      const detail = (event as CustomEvent<OpenFeedbackEventDetail>).detail;

      if (detail?.category) {
        setCategory(detail.category);
      }

      if (typeof detail?.feedback === "string") {
        setFeedback(detail.feedback);
      }

      setError("");
      setIsOpen(true);
    }

    window.addEventListener("nordeditor:open-feedback", openFromApp);

    return () => window.removeEventListener("nordeditor:open-feedback", openFromApp);
  }, []);

  const mailtoHref = useMemo(() => {
    const subject = `NordEditor beta feedback: ${category}`;
    const body = [
      "NordEditor beta feedback",
      "",
      `Category: ${category}`,
      `Name/email: ${contact.trim() || "Not provided"}`,
      "",
      "Feedback:",
      feedback.trim(),
      "",
      "Privacy reminder: Please do not include sensitive document content in feedback."
    ].join("\n");

    return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(body)}`;
  }, [category, contact, feedback]);

  function closeModal() {
    setIsOpen(false);
    setError("");
  }

  function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!feedback.trim()) {
      setError("Please add a short note before sending feedback.");
      return;
    }

    setError("");
    window.location.href = mailtoHref;
  }

  return (
    <>
      <button className="feedback-floating-button" type="button" onClick={() => setIsOpen(true)}>
        Feedback
      </button>

      {isOpen ? (
        <div className="feedback-modal-backdrop" role="presentation" onMouseDown={closeModal}>
          <section
            className="feedback-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="feedback-modal-header">
              <div>
                <p className="eyebrow">Beta feedback</p>
                <h2 id="feedback-title">Tell us what to improve</h2>
              </div>
              <button
                className="feedback-close-button"
                type="button"
                aria-label="Close feedback form"
                onClick={closeModal}
              >
                x
              </button>
            </div>

            <form className="feedback-form" onSubmit={submitFeedback}>
              <label>
                <span>Name/email optional</span>
                <input
                  type="text"
                  value={contact}
                  onChange={(event) => setContact(event.target.value)}
                  placeholder="Your name or email"
                />
              </label>

              <label>
                <span>Category</span>
                <select
                  value={category}
                  onChange={(event) =>
                    setCategory(event.target.value as FeedbackCategory)
                  }
                >
                  {FEEDBACK_CATEGORIES.map((feedbackCategory) => (
                    <option key={feedbackCategory} value={feedbackCategory}>
                      {feedbackCategory}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Feedback required</span>
                <textarea
                  required
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                  placeholder="What happened, what felt confusing, or what would help?"
                  rows={6}
                />
              </label>

              <p className="feedback-privacy-note">
                Please do not include sensitive document content in feedback.
              </p>

              {error ? <p className="feedback-error">{error}</p> : null}

              <div className="feedback-actions">
                <button className="feedback-secondary-button" type="button" onClick={closeModal}>
                  Cancel
                </button>
                <button className="feedback-primary-button" type="submit">
                  Send feedback
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}
