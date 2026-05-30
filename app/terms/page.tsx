import Link from "next/link";

export default function TermsPage() {
  return (
    <main className="simple-page">
      <Link className="brand-mark simple-page-brand" href="/">
        <span className="brand-icon" aria-hidden="true">
          N
        </span>
        <span>NordEditor</span>
        <span className="beta-badge">Beta</span>
      </Link>

      <section className="simple-card">
        <p className="eyebrow">Terms</p>
        <h1>Terms of Use</h1>
        <p>
          NordEditor is a beta PDF editing workspace for manual edits, visual export, and AI
          assistance. You are responsible for reviewing any edited or downloaded document before
          relying on it.
        </p>
        <p>
          AI responses can be helpful, but they may be incomplete or incorrect. Use NordEditor AI as
          an assistant, not as legal, financial, medical, or professional advice.
        </p>
        <p>
          The beta may change, pause, or limit AI features while we improve reliability, safety, and
          cost controls.
        </p>
        <Link className="simple-link" href="/">
          Back to NordEditor
        </Link>
      </section>

      <footer className="simple-page-footer" aria-label="NordEditor legal links">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/contact">Contact</Link>
        <Link href="/beta-limits">Beta limits</Link>
      </footer>
    </main>
  );
}
