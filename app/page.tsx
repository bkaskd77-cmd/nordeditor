import Link from "next/link";
import PdfWorkspace from "../components/PdfWorkspace";

export default function Home() {
  return (
    <main className="page-shell">
      <header className="topbar" aria-label="NordEditor header">
        <Link className="brand-mark" href="/" aria-label="NordEditor home">
          <span className="brand-icon" aria-hidden="true">
            N
          </span>
          <span>NordEditor</span>
        </Link>
      </header>

      <section className="hero-section" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">PDF workspace</p>
          <h1 id="hero-title">NordEditor</h1>
          <p className="hero-subtitle">Edit PDFs your way &mdash; manually or with AI.</p>
          <p className="hero-lede">
            Upload a PDF, add text, images, signatures, highlights, comments, cover unwanted
            areas, and ask AI to summarize, explain, extract key information, or suggest edits.
          </p>
          <div className="feature-pills" aria-label="NordEditor features">
            <span>Manual PDF editing</span>
            <span>AI-powered PDF assistant</span>
            <span>Download edited PDF</span>
            <span>No account needed</span>
          </div>
          <p className="product-promise">
            Click to edit. Ask AI to understand. Download when done.
          </p>
        </div>

        <PdfWorkspace />
      </section>

      <footer className="site-footer" aria-label="NordEditor footer">
        <Link href="/privacy">Privacy</Link>
        <span aria-hidden="true">&bull;</span>
        <Link href="/terms">Terms</Link>
        <span aria-hidden="true">&bull;</span>
        <Link href="/contact">Contact</Link>
        <span aria-hidden="true">&bull;</span>
        <span>&copy; NordEditor</span>
      </footer>
    </main>
  );
}
