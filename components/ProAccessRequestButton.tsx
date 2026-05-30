"use client";

type ProAccessRequestButtonProps = {
  className?: string;
};

export default function ProAccessRequestButton({ className }: ProAccessRequestButtonProps) {
  function openProAccessRequest() {
    window.dispatchEvent(
      new CustomEvent("nordeditor:open-feedback", {
        detail: {
          category: "Pro access request",
          feedback: "I would like early Pro access for NordEditor."
        }
      })
    );
  }

  return (
    <button className={className ?? "simple-link"} type="button" onClick={openProAccessRequest}>
      Request Pro access
    </button>
  );
}
