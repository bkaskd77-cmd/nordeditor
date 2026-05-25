"use client";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="simple-page">
      <section className="simple-card app-error-card">
        <p className="eyebrow">Something went wrong</p>
        <h1>NordEditor hit a temporary issue.</h1>
        <p>
          Please try again. Manual PDF editing may still work after refreshing the page.
        </p>
        <button className="simple-link app-error-button" type="button" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
