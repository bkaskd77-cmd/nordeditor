import OpenAI from "openai";
import { NextResponse } from "next/server";
import {
  checkAiRateLimit,
  createAiJsonError,
  createAiJsonResponse,
  createAiLimitReachedResponse,
  type AiRateLimitResult
} from "../../../../lib/aiRateLimit";

export const runtime = "nodejs";

const DEFAULT_EXPLAIN_MODEL = "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = 75_000;
const MAX_PAGE_TEXT_CHARS = 80_000;

type ErrorResponse = {
  error: string;
};

type PageExplanationResponse = {
  explanation: string;
  pageNumber: number;
};

function jsonError(message: string, status: number) {
  return NextResponse.json<ErrorResponse>({ error: message }, { status });
}

function getOpenAIErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return "NordEditor AI took too long to explain this page. Please try again.";
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
      return "This page is too large for the AI request. Please try a shorter page.";
    }

    if (maybeError.message) {
      return `OpenAI returned an error: ${maybeError.message}`;
    }
  }

  return "NordEditor AI could not explain this page. Please try again.";
}

function logOpenAIError(
  error: unknown,
  model: string,
  pageNumber: number,
  pdfName: string,
  pageTextLength: number
) {
  if (error && typeof error === "object") {
    const maybeError = error as {
      status?: number;
      code?: string;
      type?: string;
      message?: string;
      request_id?: string;
    };

    console.error("NordEditor AI page explanation failed", {
      status: maybeError.status,
      code: maybeError.code,
      type: maybeError.type,
      message: maybeError.message,
      requestId: maybeError.request_id,
      model,
      pageNumber,
      pdfName,
      pageTextLength
    });
    return;
  }

  console.error("NordEditor AI page explanation failed", {
    message: "Unknown AI error",
    model,
    pageNumber,
    pdfName,
    pageTextLength
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

  let pageNumber = 0;
  let pdfName = "document.pdf";
  let pageText = "";

  try {
    const formData = await request.formData();
    const requestedPageNumber = Number(formData.get("pageNumber"));
    const requestedPdfName = formData.get("pdfName");
    const requestedPageText = formData.get("pageText");

    if (typeof requestedPdfName === "string" && requestedPdfName.trim()) {
      pdfName = requestedPdfName.trim();
    }

    if (Number.isInteger(requestedPageNumber)) {
      pageNumber = requestedPageNumber;
    }

    if (typeof requestedPageText === "string") {
      pageText = requestedPageText.trim();
    }
  } catch {
    return jsonError("The current page text could not be read. Please try again.", 400);
  }

  if (pageNumber < 1) {
    return jsonError("Choose a valid PDF page before asking AI to explain it.", 400);
  }

  if (!pageText) {
    return jsonError(
      "This page does not have readable text for AI to explain. Try a text-based PDF page.",
      400
    );
  }

  if (pageText.length > MAX_PAGE_TEXT_CHARS) {
    pageText = pageText.slice(0, MAX_PAGE_TEXT_CHARS);
  }

  try {
    const model =
      process.env.OPENAI_EXPLAIN_MODEL ?? process.env.OPENAI_SUMMARY_MODEL ?? DEFAULT_EXPLAIN_MODEL;

    rateLimit = await checkAiRateLimit(request);

    if (!rateLimit.allowed) {
      return createAiLimitReachedResponse(rateLimit);
    }

    const client = new OpenAI({
      apiKey,
      timeout: OPENAI_TIMEOUT_MS
    });
    const pageInstruction = [
      `You are explaining page ${pageNumber} from the PDF "${pdfName}".`,
      "Explain only the page text provided below, not the whole PDF.",
      "Use simple, clear language and return clean markdown with these exact sections:",
      "## Simple explanation",
      "## Key points",
      "## Important details",
      "## Action needed, if any",
      "Define important terms and explain numbers or tables if present.",
      "Make the answer different from a summary by teaching the user how to understand the page.",
      "",
      "Current page text:",
      pageText
    ].join("\n");

    // We only receive temporary extracted page text here. Do not save or log the page contents.
    const response = await client.responses.create({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: pageInstruction
            }
          ]
        }
      ]
    });

    const explanation = response.output_text?.trim();

    if (!explanation) {
      return createAiJsonError(
        "NordEditor AI did not return a page explanation. Please try again.",
        502,
        rateLimit
      );
    }

    return createAiJsonResponse<PageExplanationResponse>(
      { explanation, pageNumber },
      rateLimit
    );
  } catch (error) {
    const model =
      process.env.OPENAI_EXPLAIN_MODEL ?? process.env.OPENAI_SUMMARY_MODEL ?? DEFAULT_EXPLAIN_MODEL;

    logOpenAIError(error, model, pageNumber, pdfName, pageText.length);
    return createAiJsonError(getOpenAIErrorMessage(error), 502, rateLimit);
  }
}
