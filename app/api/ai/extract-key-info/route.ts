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

export const runtime = "nodejs";

const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;
const OPENAI_TIMEOUT_MS = 75_000;
const PDF_DATA_URL_PREFIX = "data:application/pdf;base64,";

type ErrorResponse = {
  error: string;
};

type KeyInfoResponse = {
  keyInfo: string;
};

function jsonError(message: string, status: number) {
  return NextResponse.json<ErrorResponse>({ error: message }, { status });
}

function getOpenAIErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return "NordEditor AI took too long to extract key information. Please try again.";
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
      return `OpenAI returned an error: ${maybeError.message}`;
    }
  }

  return "NordEditor AI could not extract key information. Please try again.";
}

function logOpenAIError(error: unknown, pdfFile: File, model: string) {
  if (error && typeof error === "object") {
    const maybeError = error as {
      status?: number;
      code?: string;
      type?: string;
      message?: string;
      request_id?: string;
    };

    console.error("NordEditor AI key info extraction failed", {
      status: maybeError.status,
      code: maybeError.code,
      type: maybeError.type,
      message: maybeError.message,
      requestId: maybeError.request_id,
      model,
      pdfName: pdfFile.name,
      pdfSize: pdfFile.size,
      pdfType: pdfFile.type
    });
    return;
  }

  console.error("NordEditor AI key info extraction failed", {
    message: "Unknown AI error",
    model,
    pdfName: pdfFile.name,
    pdfSize: pdfFile.size,
    pdfType: pdfFile.type
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
    return jsonError("Upload a PDF before asking AI to extract key information.", 400);
  }

  if (pdfFile.type !== "application/pdf" && !pdfFile.name.toLowerCase().endsWith(".pdf")) {
    return jsonError("Please choose a PDF file before extracting key information.", 400);
  }

  if (pdfFile.size > MAX_PDF_SIZE_BYTES) {
    return jsonError(
      "This PDF is too large for NordEditor AI in V1. Please try a PDF under 10 MB.",
      413
    );
  }

  try {
    const pdfBytes = Buffer.from(await pdfFile.arrayBuffer());
    const pdfBase64 = pdfBytes.toString("base64");
    const pdfDataUrl = `${PDF_DATA_URL_PREFIX}${pdfBase64}`;

    if (pdfBytes.byteLength === 0 || pdfBase64.length === 0) {
      return jsonError("The uploaded PDF is empty. Please choose a valid PDF file.", 400);
    }

    if (pdfDataUrl.length <= PDF_DATA_URL_PREFIX.length) {
      return jsonError("The PDF could not be prepared for AI key information extraction.", 400);
    }

    rateLimit = await checkAiRateLimit(request);

    if (!rateLimit.allowed) {
      return createAiLimitReachedResponse(rateLimit);
    }

    const model = getAiModel({ featureModelEnvName: "OPENAI_KEY_INFO_MODEL" });
    const client = new OpenAI({
      apiKey,
      timeout: OPENAI_TIMEOUT_MS
    });
    const keyInfoInstruction = [
      "Extract structured important information from this PDF.",
      "Do not write a normal summary. Only extract concrete useful details.",
      "Return clean markdown with these exact sections:",
      "## Names / people / companies",
      "## Important dates",
      "## Important numbers / amounts / IDs",
      "## Deadlines or actions needed",
      "## Possible risks or things to check",
      "Use bullet lists. If a section has no clear information, write \"Not found\"."
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
              text: keyInfoInstruction
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

    const keyInfo = response.output_text?.trim();

    if (!keyInfo) {
      return createAiJsonError(
        "NordEditor AI did not return key information. Please try again.",
        502,
        rateLimit
      );
    }

    return createAiJsonResponse<KeyInfoResponse>({ keyInfo }, rateLimit);
  } catch (error) {
    const model = getAiModel({ featureModelEnvName: "OPENAI_KEY_INFO_MODEL" });

    logOpenAIError(error, pdfFile, model);
    return createAiJsonError(getOpenAIErrorMessage(error), 502, rateLimit);
  }
}
