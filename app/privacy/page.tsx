import Link from "next/link";

export default function PrivacyPage() {
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
        <p className="eyebrow">Privacy</p>
        <h1>Privacy Policy</h1>
        <p>
          NordEditor is built to keep PDF editing simple and temporary. Uploaded files are used in
          your current browser/session so you can preview, edit, and download your PDF.
        </p>
        <p>
          If you choose to use AI features, document content may be sent for AI processing so
          NordEditor can summarize, explain, extract key information, or suggest edits. We do not
          intentionally store uploaded PDFs, AI prompts, or document text as product data.
        </p>
        <p>
          NordEditor is currently in beta. Please avoid uploading highly sensitive documents until
          the full production privacy policy and security review are complete.
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
