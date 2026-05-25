import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://nordeditor.vercel.app"),
  title: "NordEditor – AI-powered PDF editor",
  description:
    "Edit PDFs manually, ask AI to summarize, explain, extract key info, and suggest edits.",
  applicationName: "NordEditor",
  icons: {
    icon: "/icon.svg",
    apple: "/apple-icon.svg"
  },
  openGraph: {
    title: "NordEditor – AI-powered PDF editor",
    description:
      "Edit PDFs manually, ask AI to summarize, explain, extract key info, and suggest edits.",
    url: "https://nordeditor.vercel.app",
    siteName: "NordEditor",
    type: "website"
  },
  twitter: {
    card: "summary",
    title: "NordEditor – AI-powered PDF editor",
    description:
      "Edit PDFs manually, ask AI to summarize, explain, extract key info, and suggest edits."
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
