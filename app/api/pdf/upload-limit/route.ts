import { NextResponse } from "next/server";
import {
  checkPdfUploadRateLimit,
  createPdfUploadLimitResponse
} from "../../../../lib/pdfUploadRateLimit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    // This route counts upload attempts only. It never receives or stores PDF files.
    const rateLimit = await checkPdfUploadRateLimit(request);

    if (!rateLimit.allowed) {
      return createPdfUploadLimitResponse(rateLimit);
    }

    return NextResponse.json(
      {
        ok: true,
        pdfUploadUsage: rateLimit.usage
      },
      {
        headers: rateLimit.headers
      }
    );
  } catch (error) {
    console.error("NordEditor PDF upload limit check failed", {
      route: "/api/pdf/upload-limit",
      feature: "pdf_upload_limit",
      errorType: error instanceof Error ? error.name : "UnknownError",
      statusCode: 500,
      timestamp: new Date().toISOString()
    });

    return NextResponse.json(
      {
        error: "PDF upload protection is temporarily unavailable. Please try again."
      },
      {
        status: 503
      }
    );
  }
}
