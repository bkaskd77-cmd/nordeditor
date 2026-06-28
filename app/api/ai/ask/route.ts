import OpenAI from "openai";
import { NextResponse } from "next/server";
import {
  checkAiRateLimit,
  createAiJsonError,
  createAiJsonResponse,
  createAiLimitReachedResponse,
  getAiRateLimitStatus,
  recordAiResponseUsage,
  type AiRateLimitResult
} from "../../../../lib/aiRateLimit";
import {
  LARGE_PDF_AI_MESSAGE,
  PDF_PAGE_COUNT_ERROR_MESSAGE,
  checkWholeDocumentAiLimits,
  getPdfPageCountForAiLimit
} from "../../../../lib/aiDocumentLimits";
import { getAiModel } from "../../../../lib/aiModels";
import { logSafeServerError } from "../../../../lib/safeErrorLog";

export const runtime = "nodejs";

const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_QUESTION_CHARS = 4_000;
const OPENAI_TIMEOUT_MS = 75_000;
const PDF_DATA_URL_PREFIX = "data:application/pdf;base64,";

type ErrorResponse = {
  error: string;
};

type AskResponse = {
  answer: string;
};

function jsonError(message: string, status: number) {
  return NextResponse.json<ErrorResponse>({ error: message }, { status });
}

function getOpenAIErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return "NordEditor AI took too long to answer. Please try again.";
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
      return LARGE_PDF_AI_MESSAGE;
    }

    if (maybeError.message) {
      return "NordEditor AI could not answer this question. Please try again.";
    }
  }

  return "NordEditor AI could not answer this question. Please try again.";
}

function logOpenAIError(error: unknown) {
  logSafeServerError({
    route: "/api/ai/ask",
    featureArea: "ai-custom-question",
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

  const preflightRateLimit = await getAiRateLimitStatus(request);

  if (!preflightRateLimit.allowed) {
    return createAiLimitReachedResponse(preflightRateLimit);
  }

  let pdfFile: File | null = null;
  let question = "";

  try {
    const formData = await request.formData();
    const uploadedFile = formData.get("pdf");
    const userQuestion = formData.get("question");

    if (uploadedFile instanceof File) {
      pdfFile = uploadedFile;
    }

    if (typeof userQuestion === "string") {
      question = userQuestion.trim();
    }
  } catch {
    return jsonError("The PDF or question could not be read. Please try again.", 400);
  }

  if (!pdfFile) {
    return jsonError("Upload a PDF before asking NordEditor AI a question.", 400);
  }

  if (!question) {
    return jsonError("Type a question before clicking Send.", 400);
  }

  if (question.length > MAX_QUESTION_CHARS) {
    return jsonError("Please shorten your question before sending it.", 400);
  }

  if (pdfFile.type !== "application/pdf" && !pdfFile.name.toLowerCase().endsWith(".pdf")) {
    return jsonError("Please choose a PDF file before asking a question.", 400);
  }

  if (pdfFile.size > MAX_PDF_SIZE_BYTES) {
    return jsonError("This PDF is too large for NordEditor AI in V1. Please try a PDF under 10 MB.", 413);
  }

  const documentLimit = checkWholeDocumentAiLimits({
    fileSizeBytes: pdfFile.size
  });

  if (!documentLimit.allowed) {
    return jsonError(documentLimit.message, 413);
  }

  try {
    const pdfBytes = Buffer.from(await pdfFile.arrayBuffer());

    if (pdfBytes.byteLength === 0) {
      return jsonError("The uploaded PDF is empty. Please choose a valid PDF file.", 400);
    }

    const resolvedPageCount = await getPdfPageCountForAiLimit(pdfBytes);

    if (resolvedPageCount === null) {
      return jsonError(PDF_PAGE_COUNT_ERROR_MESSAGE, 400);
    }
    const resolvedDocumentLimit = checkWholeDocumentAiLimits({
      fileSizeBytes: pdfBytes.byteLength,
      pageCount: resolvedPageCount
    });

    if (!resolvedDocumentLimit.allowed) {
      return jsonError(resolvedDocumentLimit.message, 413);
    }

    const pdfBase64 = pdfBytes.toString("base64");
    const pdfDataUrl = `${PDF_DATA_URL_PREFIX}${pdfBase64}`;

    if (pdfDataUrl.length <= PDF_DATA_URL_PREFIX.length) {
      return jsonError("The PDF could not be prepared for AI questions.", 400);
    }

    rateLimit = await checkAiRateLimit(request);

    if (!rateLimit.allowed) {
      return createAiLimitReachedResponse(rateLimit);
    }

    const model = getAiModel({ featureModelEnvName: "OPENAI_ASK_MODEL" });
    const client = new OpenAI({
      apiKey,
      timeout: OPENAI_TIMEOUT_MS
    });
    const askInstruction = [
      "You are NordEditor AI, a precise PDF assistant.",
      "Answer the user's exact question directly using the uploaded PDF.",
      "Do not summarize the document unless the user asks for a summary.",
      "Do not extract key points unless the user asks for key points.",
      "If the user asks about a term or acronym, define it first in simple language, then explain how it appears in this PDF.",
      "For financial or account documents, use only information visible or extractable from the uploaded PDF.",
      "If information is unclear, redacted, unreadable, or uncertain, say so instead of inventing details.",
      "If you need to infer a meaning, say \"Based on this document, it appears to mean...\".",
      "Keep answers concise by default, and use structured sections only when helpful.",
      "Do not claim that you edited the PDF and do not provide automatic edit commands.",
      "Return clean markdown only when it improves readability.",
      "",
      "User question:",
      question
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
              text: askInstruction
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

    const answer = response.output_text?.trim();

    if (!answer) {
      return createAiJsonError(
        "NordEditor AI did not return an answer. Please try again.",
        502,
        rateLimit
      );
    }

    return createAiJsonResponse<AskResponse>({ answer }, rateLimit);
  } catch (error) {
    logOpenAIError(error);
    return createAiJsonError(getOpenAIErrorMessage(error), 502, rateLimit);
  }
}
