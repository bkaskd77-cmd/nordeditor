import Link from "next/link";

export default function ContactPage() {
  return (
    <main className="simple-page">
      <Link className="brand-mark simple-page-brand" href="/">
        <span className="brand-icon" aria-hidden="true">
          N
        </span>
        <span>NordEditor</span>
      </Link>

      <section className="simple-card">
        <p className="eyebrow">Contact</p>
        <h1>Contact NordEditor</h1>
        <p>
          Questions, feedback, or launch inquiries can be sent to the NordEditor team when public
          contact details are added.
        </p>
        <p>This placeholder page will be replaced with a real contact method before launch.</p>
        <Link className="simple-link" href="/">
          Back to NordEditor
        </Link>
      </section>
    </main>
  );
}
