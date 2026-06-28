import { PDFDocument } from "pdf-lib";

export type AiDocumentLimits = {
  maxFileSizeMb: number;
  maxFileSizeBytes: number;
  maxPageCount: number;
  largePdfMessage: string;
};

const DEFAULT_AI_MAX_FILE_SIZE_MB = 3;
const DEFAULT_AI_MAX_PAGE_COUNT = 10;

export const LARGE_PDF_AI_MESSAGE =
  "This PDF is large for beta AI. Manual editing still works. Large-document AI will be available with Pro. You can still use Explain current page.";

export const PDF_PAGE_COUNT_ERROR_MESSAGE =
  "NordEditor AI could not verify this PDF's page count. Manual editing still works. Please try another PDF.";

function getConfiguredPositiveNumber(name: string, fallback: number) {
  const configuredValue = Number(process.env[name]);

  if (Number.isFinite(configuredValue) && configuredValue > 0) {
    return configuredValue;
  }

  return fallback;
}

function getConfiguredPositiveInteger(name: string, fallback: number) {
  return Math.floor(getConfiguredPositiveNumber(name, fallback));
}

export function getAiDocumentLimits(): AiDocumentLimits {
  const maxFileSizeMb = getConfiguredPositiveNumber(
    "AI_MAX_FILE_SIZE_MB",
    DEFAULT_AI_MAX_FILE_SIZE_MB
  );
  const maxPageCount = getConfiguredPositiveInteger(
    "AI_MAX_PAGE_COUNT",
    DEFAULT_AI_MAX_PAGE_COUNT
  );

  return {
    maxFileSizeMb,
    maxFileSizeBytes: Math.floor(maxFileSizeMb * 1024 * 1024),
    maxPageCount,
    largePdfMessage: LARGE_PDF_AI_MESSAGE
  };
}

export function checkWholeDocumentAiLimits({
  fileSizeBytes,
  pageCount
}: {
  fileSizeBytes: number;
  pageCount?: number | null;
}) {
  const limits = getAiDocumentLimits();
  const isTooLarge = fileSizeBytes > limits.maxFileSizeBytes;
  const hasTooManyPages =
    typeof pageCount === "number" && Number.isFinite(pageCount) && pageCount > limits.maxPageCount;

  return {
    allowed: !isTooLarge && !hasTooManyPages,
    limits,
    reason: isTooLarge ? "file_size" : hasTooManyPages ? "page_count" : null,
    message: LARGE_PDF_AI_MESSAGE
  };
}

export async function getPdfPageCountForAiLimit(pdfBytes: Uint8Array) {
  try {
    const pdfDocument = await PDFDocument.load(pdfBytes);

    return pdfDocument.getPageCount();
  } catch {
    // If page counting fails, the normal AI request validation can still return a friendly error.
    return null;
  }
}
