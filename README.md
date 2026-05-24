# NordEditor

NordEditor is a first-version PDF preview app built with Next.js and TypeScript.

## What It Does

- Shows a clean landing page.
- Lets you upload one local PDF.
- Previews the PDF in the browser.
- Lets you clear the selected PDF.

This version does not include AI, editing tools, login, payments, or a database.

## Run Locally

Make sure Node.js and npm are installed first:

```bash
node --version
npm --version
```

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open the app:

```bash
http://localhost:3000
```

## Useful Commands

```bash
npm run dev
npm run build
npm run start
npm run type-check
npm run lint
```

## Important Files

- `app/page.tsx` is the landing page.
- `components/PdfWorkspace.tsx` handles PDF upload, preview, and clearing.
- `app/globals.css` contains the app styling.
- `app/layout.tsx` sets shared page metadata and global styles.
- `package.json` defines app dependencies and commands.
