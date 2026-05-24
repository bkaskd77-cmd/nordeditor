import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="simple-page">
      <Link className="brand-mark simple-page-brand" href="/">
        <span className="brand-icon" aria-hidden="true">
          N
        </span>
        <span>NordEditor</span>
      </Link>

      <section className="simple-card">
        <p className="eyebrow">Privacy</p>
        <h1>Privacy Policy</h1>
        <p>
          NordEditor V1 processes files temporarily in your browser/session. AI features may send
          document content to AI services for processing when you choose to use them.
        </p>
        <p>
          This placeholder page will be replaced with a full privacy policy before public launch.
        </p>
        <Link className="simple-link" href="/">
          Back to NordEditor
        </Link>
      </section>
    </main>
  );
}
