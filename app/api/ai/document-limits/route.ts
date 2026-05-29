import { NextResponse } from "next/server";
import { getAiDocumentLimits } from "../../../../lib/aiDocumentLimits";

export const runtime = "nodejs";

export async function GET() {
  // These are safe public beta settings, not secrets.
  return NextResponse.json(getAiDocumentLimits(), {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
