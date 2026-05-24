import Link from "next/link";

export default function TermsPage() {
  return (
    <main className="simple-page">
      <Link className="brand-mark simple-page-brand" href="/">
        <span className="brand-icon" aria-hidden="true">
          N
        </span>
        <span>NordEditor</span>
      </Link>

      <section className="simple-card">
        <p className="eyebrow">Terms</p>
        <h1>Terms of Use</h1>
        <p>
          NordEditor V1 is an early PDF editing workspace for manual edits, visual export, and AI
          assistance. Review exported documents before relying on them.
        </p>
        <p>
          This placeholder page will be replaced with full terms of use before public launch.
        </p>
        <Link className="simple-link" href="/">
          Back to NordEditor
        </Link>
      </section>
    </main>
  );
}
