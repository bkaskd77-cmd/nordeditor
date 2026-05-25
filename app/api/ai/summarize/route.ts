import OpenAI from "openai";
import { NextResponse } from "next/server";
import {
  checkAiRateLimit,
  createAiJsonError,
  createAiJsonResponse,
  createAiLimitReachedResponse,
  recordAiResponseUsage,
  type AiRateLimitResult
} from "../../../../lib/aiRateLimit";
import { getAiModel } from "../../../../lib/aiModels";
import { logSafeServerError } from "../../../../lib/safeErrorLog";

export const runtime = "nodejs";

const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;
const OPENAI_TIMEOUT_MS = 75_000;
const PDF_DATA_URL_PREFIX = "data:application/pdf;base64,";

type ErrorResponse = {
  error: string;
};

type SummaryResponse = {
  summary: string;
};

function jsonError(message: string, status: number) {
  return NextResponse.json<ErrorResponse>({ error: message }, { status });
}

function getOpenAIErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return "NordEditor AI took too long to summarize this PDF. Please try again with a shorter PDF.";
  }

  if (error && typeof error === "object") {
    const maybeError = error as {
      status?: number;
      code?: string;
      type?: string;
      message?: string;
    };

    if (maybeError.status === 401) {
      return "OpenAI rejected the API key. Please check OPENAI_API_KEY in .env.local.";
    }

    const errorText = `${maybeError.code ?? ""} ${maybeError.type ?? ""} ${
      maybeError.message ?? ""
    }`.toLowerCase();

    if (
      maybeError.status === 402 ||
      maybeError.status === 403 ||
      errorText.includes("insufficient_quota") ||
      errorText.includes("billing")
    ) {
      return "NordEditor AI cannot run because OpenAI quota or billing is unavailable. Please check the OpenAI account billing/quota and try again.";
    }

    if (maybeError.status === 429) {
      return "OpenAI is limiting requests right now. Please wait a moment and try again.";
    }

    if (maybeError.status === 413) {
      return "This PDF is too large for NordEditor AI in V1. Please try a PDF under 10 MB.";
    }

    if (maybeError.message) {
      return "NordEditor AI could not summarize this PDF. Please try again.";
    }
  }

  return "NordEditor AI could not summarize this PDF. Please try again.";
}

function logOpenAIError(error: unknown) {
  logSafeServerError({
    route: "/api/ai/summarize",
    featureArea: "ai-summary",
    error
  });
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  let rateLimit: AiRateLimitResult | null = null;

  if (!apiKey) {
    return jsonError(
      "OpenAI API key is missing. Add OPENAI_API_KEY to .env.local and restart the server.",
      500
    );
  }

  let pdfFile: File | null = null;

  try {
    const formData = await request.formData();
    const uploadedFile = formData.get("pdf");

    if (uploadedFile instanceof File) {
      pdfFile = uploadedFile;
    }
  } catch {
    return jsonError("The PDF could not be read. Please upload it again.", 400);
  }

  if (!pdfFile) {
    return jsonError("Upload a PDF before asking AI to summarize it.", 400);
  }

  if (pdfFile.type !== "application/pdf" && !pdfFile.name.toLowerCase().endsWith(".pdf")) {
    return jsonError("Please choose a PDF file before summarizing.", 400);
  }

  if (pdfFile.size > MAX_PDF_SIZE_BYTES) {
    return jsonError("This PDF is too large for NordEditor AI in V1. Please try a PDF under 10 MB.", 413);
  }

  try {
    const pdfBytes = Buffer.from(await pdfFile.arrayBuffer());
    const pdfBase64 = pdfBytes.toString("base64");
    const pdfDataUrl = `${PDF_DATA_URL_PREFIX}${pdfBase64}`;

    if (pdfBytes.byteLength === 0 || pdfBase64.length === 0) {
      return jsonError("The uploaded PDF is empty. Please choose a valid PDF file.", 400);
    }

    if (pdfDataUrl.length <= PDF_DATA_URL_PREFIX.length) {
      return jsonError("The PDF could not be prepared for AI summarizing.", 400);
    }

    rateLimit = await checkAiRateLimit(request);

    if (!rateLimit.allowed) {
      return createAiLimitReachedResponse(rateLimit);
    }

    const model = getAiModel({ featureModelEnvName: "OPENAI_SUMMARY_MODEL" });
    const client = new OpenAI({
      apiKey,
      timeout: OPENAI_TIMEOUT_MS
    });
    const summaryInstruction = [
      "Summarize this PDF clearly and concisely.",
      "Return the answer in clean markdown with these exact sections:",
      "## Short summary",
      "## Key information",
      "## Important dates/names/numbers",
      "## Things to check, if any",
      "Use short paragraphs and bullet lists where helpful."
    ].join("\n");

    // The PDF only lives in this request. We do not save it or log its contents.
    const response = await client.responses.create({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: summaryInstruction
            },
            {
              type: "input_file",
              filename: pdfFile.name || "document.pdf",
              file_data: pdfDataUrl
            }
          ]
        }
      ]
    });

    await recordAiResponseUsage(rateLimit, model, response.usage);

    const summary = response.output_text?.trim();

    if (!summary) {
      return createAiJsonError(
        "NordEditor AI did not return a summary. Please try again.",
        502,
        rateLimit
      );
    }

    return createAiJsonResponse<SummaryResponse>({ summary }, rateLimit);
  } catch (error) {
    logOpenAIError(error);
    return createAiJsonError(getOpenAIErrorMessage(error), 502, rateLimit);
  }
}
