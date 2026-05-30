import Link from "next/link";
import FeedbackModal from "../../components/FeedbackModal";
import ProAccessRequestButton from "../../components/ProAccessRequestButton";

const BETA_LIMITS = [
  {
    title: "Manual PDF editing",
    description: "Free during beta, including text, images, signatures, cover/erase, highlights, and comments."
  },
  {
    title: "Download edited PDF",
    description: "Free during beta so you can finish and save your edited PDF."
  },
  {
    title: "PDF uploads",
    description: "10 PDF uploads per day, with manual editing still available for your current PDF."
  },
  {
    title: "File size",
    description: "PDF upload size is limited to 10MB for V1 stability."
  },
  {
    title: "Whole-document AI",
    description: "Available for smaller PDFs, currently up to 3MB or 10 pages."
  },
  {
    title: "AI actions",
    description: "5 AI actions per day during public beta."
  }
];

export default function BetaLimitsPage() {
  return (
    <main className="simple-page">
      <Link className="brand-mark simple-page-brand" href="/">
        <span className="brand-icon" aria-hidden="true">
          N
        </span>
        <span>NordEditor</span>
        <span className="beta-badge">Beta</span>
      </Link>

      <section className="simple-card beta-limits-card">
        <p className="eyebrow">Beta limits</p>
        <h1>Free beta limits and Pro access</h1>
        <p>
          NordEditor is open for beta testing with generous free manual editing and careful AI
          limits. We keep free limits generous while protecting beta infrastructure costs.
        </p>
        <p>
          Large-document AI, higher daily limits, and more advanced workflows are planned for Pro.
          Manual editing and PDF download remain available within the current V1 limits.
        </p>

        <div className="beta-limits-grid" aria-label="Current NordEditor beta limits">
          {BETA_LIMITS.map((limit) => (
            <article className="beta-limit-item" key={limit.title}>
              <h2>{limit.title}</h2>
              <p>{limit.description}</p>
            </article>
          ))}
        </div>

        <div className="beta-pro-card">
          <div>
            <h2>Need more capacity?</h2>
            <p>
              Tell us what you need. Please do not include sensitive document content in your
              request.
            </p>
          </div>
          <ProAccessRequestButton />
        </div>

        <Link className="simple-secondary-link" href="/">
          Back to NordEditor
        </Link>
      </section>

      <footer className="simple-page-footer" aria-label="NordEditor legal links">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/contact">Contact</Link>
        <Link href="/beta-limits">Beta limits</Link>
      </footer>

      <FeedbackModal />
    </main>
  );
}
