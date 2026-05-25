import Link from "next/link";

const CONTACT_EMAIL = "nordEditor@gmail.com";
const CONTACT_PHONE_DISPLAY = "+977 98 43 119897";
const CONTACT_PHONE_LINK = "+9779843119897";
const WHATSAPP_URL =
  "https://wa.me/9779843119897?text=Hello%20NordEditor%2C%20I%20need%20help%20with%20the%20PDF%20editor.";

function ContactIcon({ type }: { type: "email" | "whatsapp" | "phone" }) {
  if (type === "email") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="contact-icon">
        <path d="M4.75 6.75h14.5v10.5H4.75V6.75Z" />
        <path d="m5.25 7.25 6.75 5.5 6.75-5.5" />
      </svg>
    );
  }

  if (type === "whatsapp") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="contact-icon">
        <path d="M7.4 19.25 4.75 20l.72-2.68a7.45 7.45 0 1 1 1.93 1.93Z" />
        <path d="M9.2 8.7c.22-.5.43-.52.72-.52h.5c.16 0 .38.06.58.44.2.38.7 1.72.76 1.84.06.13.1.28.02.44-.08.17-.12.27-.25.42-.13.15-.27.33-.38.44-.13.13-.26.27-.11.52.15.25.66 1.08 1.42 1.74.98.87 1.8 1.14 2.06 1.27.25.12.4.1.55-.07.17-.2.63-.74.8-1 .17-.25.34-.21.58-.13.24.09 1.52.72 1.78.85.26.13.43.19.5.3.06.11.06.64-.15 1.25-.22.6-1.25 1.18-1.72 1.22-.44.04-1 .06-1.62-.1-.37-.1-.86-.28-1.48-.55-2.6-1.12-4.3-3.72-4.43-3.9-.13-.17-1.06-1.41-1.06-2.69 0-1.28.67-1.91.91-2.17Z" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="contact-icon">
      <path d="M7.7 4.75 10 8.9l-1.55 1.6c.68 1.43 1.83 2.57 3.25 3.25L13.3 12l4.15 2.3-.55 3.1c-.14.8-.85 1.38-1.67 1.32-5.3-.4-9.54-4.64-9.94-9.94-.06-.82.52-1.53 1.32-1.67l1.09-.2Z" />
    </svg>
  );
}

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
          NordEditor is in beta, and thoughtful feedback is welcome. Reach out for support,
          bug reports, launch questions, or product feedback.
        </p>
        <p>
          Please avoid sending sensitive PDF content, account numbers, passwords, or private
          documents through contact messages.
        </p>

        <div className="contact-grid" aria-label="NordEditor contact options">
          <a
            className="contact-card"
            href={`mailto:${CONTACT_EMAIL}?subject=NordEditor%20support`}
          >
            <ContactIcon type="email" />
            <span>
              <strong>Email</strong>
              <small>{CONTACT_EMAIL}</small>
            </span>
          </a>

          <a className="contact-card" href={WHATSAPP_URL} target="_blank" rel="noreferrer">
            <ContactIcon type="whatsapp" />
            <span>
              <strong>WhatsApp</strong>
              <small>{CONTACT_PHONE_DISPLAY}</small>
            </span>
          </a>

          <a className="contact-card" href={`tel:${CONTACT_PHONE_LINK}`}>
            <ContactIcon type="phone" />
            <span>
              <strong>Call</strong>
              <small>{CONTACT_PHONE_DISPLAY}</small>
            </span>
          </a>
        </div>

        <p className="contact-note">
          For fastest beta support, WhatsApp is best for short questions. Email is better for
          detailed feedback.
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
