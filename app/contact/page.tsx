import Link from "next/link";

export default function ContactPage() {
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
        <p className="eyebrow">Contact</p>
        <h1>Contact NordEditor</h1>
        <p>
          NordEditor is in beta, and thoughtful feedback is welcome. Use this page as the public
          contact placeholder while the final support inbox is being prepared.
        </p>
        <p>
          For now, keep using your existing project or GitHub communication channel for bug reports,
          launch questions, and product feedback.
        </p>
        <p>
          A dedicated NordEditor contact email will be added before wider public promotion.
        </p>
        <Link className="simple-link" href="/">
          Back to NordEditor
        </Link>
      </section>

      <footer className="simple-page-footer" aria-label="NordEditor legal links">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/contact">Contact</Link>
      </footer>
    </main>
  );
}
