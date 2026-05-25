"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type PointerEvent,
  type ReactNode
} from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage
} from "pdf-lib";

type SelectedPdf = {
  name: string;
  size: number;
  data: Uint8Array;
};

type PendingTextPlacement = {
  pageNumber: number;
  x: number;
  y: number;
  editingId?: string;
};

type PendingImagePlacement = {
  pageNumber: number;
  x: number;
  y: number;
};

type PendingSignaturePlacement = {
  pageNumber: number;
  x: number;
  y: number;
};

type PendingCommentPlacement = {
  pageNumber: number;
  x: number;
  y: number;
  editingId?: string;
};

type TextFontFamily = "Sans" | "Serif" | "Monospace";

type TextStyle = {
  fontSize: number;
  color: string;
  isBold: boolean;
  fontFamily: TextFontFamily;
};

// All annotations use normalized PDF page coordinates.
// x/y/width/height are 0 to 1, pageNumber is the PDF page, and y starts at the bottom.
type TextAnnotation = TextStyle & {
  id: string;
  pageNumber: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

// Image positions and sizes use the same normalized page coordinates.
type ImageAnnotation = {
  id: string;
  pageNumber: number;
  name: string;
  objectUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type SignatureAnnotation = ImageAnnotation;

// V1 erase is only a visual white cover in the editor, not secure redaction of PDF contents.
type EraseAnnotation = {
  id: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type HighlightColorName = "Yellow" | "Green" | "Blue" | "Pink";

// Highlight positions and sizes use normalized page coordinates, so they survive zoom changes.
type HighlightAnnotation = {
  id: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  colorName: HighlightColorName;
};

// Comment markers use normalized page rectangles, so they stay in place while scrolling and zooming.
type CommentAnnotation = {
  id: string;
  pageNumber: number;
  comment: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type CornerResizeHandle = "nw" | "ne" | "sw" | "se";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.1;
const FONT_SIZE_OPTIONS = [10, 12, 14, 16, 18, 20, 24, 28, 32];
const FONT_FAMILY_OPTIONS: TextFontFamily[] = ["Sans", "Serif", "Monospace"];
const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: 14,
  color: "#111111",
  isBold: false,
  fontFamily: "Sans"
};
const DEFAULT_HIGHLIGHT_COLOR: HighlightColorName = "Yellow";
// Keep the comment marker size in PDF units so preview and export agree across zoom levels.
const COMMENT_MARKER_PDF_SIZE = 24;
const MAX_IMAGE_ASSET_SIDE = 1800;
const MAX_IMAGE_ASSET_BYTES = 1_500_000;
const MAX_PDF_UPLOAD_BYTES = 10 * 1024 * 1024;
const JPEG_EXPORT_QUALITY = 0.86;
const AI_SUMMARY_TIMEOUT_MS = 90_000;
const AI_PAGE_EXPLANATION_TIMEOUT_MS = 90_000;
const AI_KEY_INFO_TIMEOUT_MS = 90_000;
const AI_SUGGESTED_EDITS_TIMEOUT_MS = 90_000;
const AI_CUSTOM_QUESTION_TIMEOUT_MS = 90_000;
const AI_LIMIT_REACHED_FALLBACK_MESSAGE =
  "Daily free AI limit reached. More AI access coming with Pro.";
const HIGHLIGHT_COLOR_VALUES: Record<
  HighlightColorName,
  { red: number; green: number; blue: number; opacity: number }
> = {
  Yellow: { red: 255, green: 221, blue: 87, opacity: 0.45 },
  Green: { red: 89, green: 210, blue: 132, opacity: 0.38 },
  Blue: { red: 82, green: 169, blue: 255, opacity: 0.34 },
  Pink: { red: 255, green: 117, blue: 172, opacity: 0.36 }
};
const HIGHLIGHT_COLORS: Record<HighlightColorName, string> = {
  Yellow: getCssRgbaColor(HIGHLIGHT_COLOR_VALUES.Yellow),
  Green: getCssRgbaColor(HIGHLIGHT_COLOR_VALUES.Green),
  Blue: getCssRgbaColor(HIGHLIGHT_COLOR_VALUES.Blue),
  Pink: getCssRgbaColor(HIGHLIGHT_COLOR_VALUES.Pink)
};
const EDITING_TOOLS = [
  "Select",
  "Text",
  "Image",
  "Signature",
  "Erase",
  "Highlight",
  "Comment",
  "Download"
] as const;

type EditingTool = (typeof EDITING_TOOLS)[number];
type AiResponseView =
  | "summary"
  | "pageExplanation"
  | "keyInfo"
  | "suggestedEdits"
  | "customAnswer";

type AiUsageInfo = {
  role: "public" | "beta" | "admin";
  roleLabel: string;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
  globalDailyLimit: number;
  globalDailyUsed: number;
  globalDailyRemaining: number;
  globalDailyResetAt: string;
  monthlyBudgetUsd: number;
  monthlyEstimatedSpendUsd: number;
  monthlyBudgetRemainingUsd: number;
  monthlyResetAt: string;
  limitReason?: "user_daily" | "global_daily" | "monthly_budget";
  message?: string;
  isLimited: boolean;
};

function renderAiInlineMarkdown(text: string) {
  const parts: ReactNode[] = [];
  const boldPattern = /\*\*(.+?)\*\*/g;
  let previousIndex = 0;
  let match = boldPattern.exec(text);

  while (match) {
    if (match.index > previousIndex) {
      parts.push(text.slice(previousIndex, match.index));
    }

    parts.push(<strong key={`bold-${match.index}`}>{match[1]}</strong>);
    previousIndex = match.index + match[0].length;
    match = boldPattern.exec(text);
  }

  if (previousIndex < text.length) {
    parts.push(text.slice(previousIndex));
  }

  return parts.length > 0 ? parts : text;
}

function renderAiMarkdown(text: string) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let listItems: string[] = [];
  let listKind: "ordered" | "unordered" | null = null;

  function flushList() {
    if (!listKind || listItems.length === 0) {
      return;
    }

    const listKey = `list-${blocks.length}`;
    const listContent = listItems.map((item, index) => (
      <li key={`${listKey}-${index}`}>{renderAiInlineMarkdown(item)}</li>
    ));

    blocks.push(
      listKind === "ordered" ? (
        <ol className="ai-markdown-list" key={listKey}>
          {listContent}
        </ol>
      ) : (
        <ul className="ai-markdown-list" key={listKey}>
          {listContent}
        </ul>
      )
    );

    listItems = [];
    listKind = null;
  }

  lines.forEach((line, index) => {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      flushList();
      return;
    }

    const headingMatch = trimmedLine.match(/^(#{1,4})\s+(.+)$/);

    if (headingMatch) {
      flushList();
      const HeadingTag = headingMatch[1].length <= 2 ? "h4" : "h5";

      blocks.push(
        <HeadingTag className="ai-markdown-heading" key={`heading-${index}`}>
          {renderAiInlineMarkdown(headingMatch[2])}
        </HeadingTag>
      );
      return;
    }

    const unorderedMatch = trimmedLine.match(/^[-*]\s+(.+)$/);
    const orderedMatch = trimmedLine.match(/^\d+[.)]\s+(.+)$/);

    if (unorderedMatch || orderedMatch) {
      const nextListKind = orderedMatch ? "ordered" : "unordered";

      if (listKind && listKind !== nextListKind) {
        flushList();
      }

      listKind = nextListKind;
      listItems.push((orderedMatch?.[1] ?? unorderedMatch?.[1] ?? "").trim());
      return;
    }

    flushList();
    blocks.push(
      <p key={`paragraph-${index}`}>{renderAiInlineMarkdown(trimmedLine)}</p>
    );
  });

  flushList();

  return blocks.length > 0 ? blocks : <p>{text}</p>;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function clampValue(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function isRenderCancelled(error: unknown) {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

function getFontFamilyValue(fontFamily: TextFontFamily) {
  if (fontFamily === "Serif") {
    return "Georgia, 'Times New Roman', serif";
  }

  if (fontFamily === "Monospace") {
    return "'Courier New', ui-monospace, monospace";
  }

  return "Inter, Arial, sans-serif";
}

function getPdfFontName(fontFamily: TextFontFamily, isBold: boolean) {
  if (fontFamily === "Serif") {
    return isBold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman;
  }

  if (fontFamily === "Monospace") {
    return isBold ? StandardFonts.CourierBold : StandardFonts.Courier;
  }

  return isBold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
}

function getRgbFromHex(hexColor: string) {
  const fallback = { red: 17, green: 17, blue: 17 };
  const cleanColor = hexColor.trim().replace("#", "");
  const expandedColor =
    cleanColor.length === 3
      ? cleanColor
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : cleanColor;

  if (expandedColor.length !== 6) {
    return fallback;
  }

  const colorNumber = Number.parseInt(expandedColor, 16);

  if (Number.isNaN(colorNumber)) {
    return fallback;
  }

  return {
    red: (colorNumber >> 16) & 255,
    green: (colorNumber >> 8) & 255,
    blue: colorNumber & 255
  };
}

function getPdfColor(color: { red: number; green: number; blue: number }) {
  return rgb(color.red / 255, color.green / 255, color.blue / 255);
}

function getCssRgbaColor(color: { red: number; green: number; blue: number; opacity: number }) {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.opacity})`;
}

function getEditedFileName(fileName: string) {
  const baseName = fileName.replace(/\.pdf$/i, "").trim() || "document";

  return `edited-${baseName}.pdf`;
}

type NormalizedPagePoint = {
  x: number;
  y: number;
};

type NormalizedPageRect = NormalizedPagePoint & {
  width: number;
  height: number;
};

type StoredImageAsset = {
  objectUrl: string;
  exportBytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
};

type AnnotationDraft =
  | ({ kind: "text"; id: string } & Pick<TextAnnotation, "x" | "y" | "width" | "height">)
  | ({ kind: "comment"; id: string } & NormalizedPageRect)
  | ({
      kind: "image" | "signature" | "erase" | "highlight";
      id: string;
    } & NormalizedPageRect);

function normalizedToPdfRect(annotation: NormalizedPageRect, pageWidth: number, pageHeight: number) {
  // Export helper: converts normalized page rectangles into real PDF page units.
  const width = annotation.width * pageWidth;
  const height = annotation.height * pageHeight;

  return {
    x: annotation.x * pageWidth,
    y: annotation.y * pageHeight,
    width,
    height
  };
}

function normalizedToPdfPoint(
  annotation: NormalizedPagePoint,
  pageWidth: number,
  pageHeight: number
) {
  // Export helper: converts normalized page points into real PDF page units.
  return {
    x: annotation.x * pageWidth,
    y: annotation.y * pageHeight
  };
}

function normalizedToScreenPoint(annotation: NormalizedPagePoint): CSSProperties {
  // Shared coordinate helper: state stores normalized PDF bottom-origin page coordinates.
  // CSS uses top-left coordinates, so the editor preview flips y only at render time.
  return {
    left: `${annotation.x * 100}%`,
    top: `${(1 - annotation.y) * 100}%`
  };
}

function normalizedToScreenRect(annotation: NormalizedPageRect): CSSProperties {
  // Shared coordinate helper: rectangles store y at the PDF bottom edge.
  // CSS needs the visual top edge, so it subtracts the rectangle height while flipping y.
  return {
    left: `${annotation.x * 100}%`,
    top: `${(1 - annotation.y - annotation.height) * 100}%`,
    width: `${annotation.width * 100}%`,
    height: `${annotation.height * 100}%`
  };
}

function getTextBaselineOffset(font: PDFFont, fontSize: number, lineHeight: number) {
  const fontBoxHeight = font.heightAtSize(fontSize);
  const ascent = font.heightAtSize(fontSize, { descender: false });
  const extraLineSpace = Math.max(0, lineHeight - fontBoxHeight);

  // CSS places text from the top of a line box. pdf-lib draws text from its baseline.
  // This converts the editor's top edge into a PDF baseline position.
  return extraLineSpace / 2 + ascent;
}

function getTextAnnotationStyle(annotation: TextAnnotation): CSSProperties {
  return {
    ...normalizedToScreenPoint(annotation),
    width: `${annotation.width * 100}%`
  };
}

function getCommentAnnotationStyle(annotation: NormalizedPageRect, zoomScale: number): CSSProperties {
  const markerSize = COMMENT_MARKER_PDF_SIZE * zoomScale;

  return {
    ...normalizedToScreenRect(annotation),
    "--comment-marker-font-size": `${Math.max(8, markerSize * 0.42)}px`
  } as CSSProperties;
}

function getHighlightFillStyle(colorName: HighlightColorName): CSSProperties {
  return {
    background: HIGHLIGHT_COLORS[colorName]
  };
}

function getDraftHighlightStyle(annotation: NormalizedPageRect): CSSProperties {
  return {
    ...normalizedToScreenRect(annotation),
    ...getHighlightFillStyle(DEFAULT_HIGHLIGHT_COLOR)
  };
}

function getPdfSafeText(text: string) {
  // The built-in PDF fonts support common Latin text. Unsupported characters become ? for V1.
  return text.replace(/[^\t\n\r -~]/g, "?");
}

function wrapTextForPdf(text: string, font: PDFFont, fontSize: number, maxWidth: number) {
  const wrappedLines: string[] = [];
  const sourceLines = getPdfSafeText(text).split(/\r?\n/);

  sourceLines.forEach((sourceLine) => {
    if (!sourceLine) {
      wrappedLines.push("");
      return;
    }

    let currentLine = "";

    sourceLine.split(/\s+/).forEach((word) => {
      const nextLine = currentLine ? `${currentLine} ${word}` : word;

      if (font.widthOfTextAtSize(nextLine, fontSize) <= maxWidth) {
        currentLine = nextLine;
        return;
      }

      if (currentLine) {
        wrappedLines.push(currentLine);
      }

      if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
        currentLine = word;
        return;
      }

      let wordPiece = "";

      word.split("").forEach((character) => {
        const nextPiece = `${wordPiece}${character}`;

        if (font.widthOfTextAtSize(nextPiece, fontSize) <= maxWidth) {
          wordPiece = nextPiece;
          return;
        }

        if (wordPiece) {
          wrappedLines.push(wordPiece);
        }

        wordPiece = character;
      });

      currentLine = wordPiece;
    });

    wrappedLines.push(currentLine);
  });

  return wrappedLines;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  link.click();

  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getUploadImageMimeType(file: File): "image/jpeg" | "image/png" {
  if (file.type === "image/png" || /\.png$/i.test(file.name)) {
    return "image/png";
  }

  return "image/jpeg";
}

function loadBrowserImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();

    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image dimensions could not be read."));
    image.src = src;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: "image/jpeg" | "image/png",
  quality?: number
) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("Image could not be resized."));
      },
      mimeType,
      quality
    );
  });
}

async function createStoredImageAsset(file: File): Promise<StoredImageAsset> {
  const sourceObjectUrl = URL.createObjectURL(file);

  try {
    const image = await loadBrowserImage(sourceObjectUrl);
    const sourceWidth = image.naturalWidth || 1;
    const sourceHeight = image.naturalHeight || 1;
    const sourceLongestSide = Math.max(sourceWidth, sourceHeight);
    const scale = Math.min(1, MAX_IMAGE_ASSET_SIDE / sourceLongestSide);
    const mimeType = getUploadImageMimeType(file);
    const shouldResizeOrCompress = scale < 1 || file.size > MAX_IMAGE_ASSET_BYTES;

    if (!shouldResizeOrCompress) {
      return {
        objectUrl: sourceObjectUrl,
        exportBytes: new Uint8Array(await file.arrayBuffer()),
        mimeType,
        width: sourceWidth,
        height: sourceHeight
      };
    }

    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Image could not be prepared.");
    }

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const resizedBlob = await canvasToBlob(
      canvas,
      mimeType,
      mimeType === "image/jpeg" ? JPEG_EXPORT_QUALITY : undefined
    );
    const objectUrl = URL.createObjectURL(resizedBlob);

    URL.revokeObjectURL(sourceObjectUrl);

    return {
      objectUrl,
      exportBytes: new Uint8Array(await resizedBlob.arrayBuffer()),
      mimeType,
      width: targetWidth,
      height: targetHeight
    };
  } catch (error) {
    URL.revokeObjectURL(sourceObjectUrl);
    throw error;
  }
}

const AnnotationImage = memo(function AnnotationImage({
  alt,
  objectUrl
}: {
  alt: string;
  objectUrl: string;
}) {
  return (
    // Object URLs are already local browser assets, so the editor uses a plain image element.
    // eslint-disable-next-line @next/next/no-img-element
    <img className="added-image" src={objectUrl} alt={alt} draggable={false} />
  );
});

export default function PdfWorkspace() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageShellRef = useRef<HTMLDivElement>(null);
  const viewerStageRef = useRef<HTMLDivElement>(null);
  const draggingTextRef = useRef<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);
  const resizingTextRef = useRef<{
    id: string;
    pointerId: number;
    handle: CornerResizeHandle;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const draggingImageRef = useRef<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);
  const resizingImageRef = useRef<{
    id: string;
    pointerId: number;
    handle: CornerResizeHandle;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const draggingSignatureRef = useRef<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);
  const resizingSignatureRef = useRef<{
    id: string;
    pointerId: number;
    handle: CornerResizeHandle;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const drawingEraseRef = useRef<{
    pointerId: number;
    pageNumber: number;
    startX: number;
    startY: number;
  } | null>(null);
  const draggingEraseRef = useRef<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);
  const resizingEraseRef = useRef<{
    id: string;
    pointerId: number;
    handle: CornerResizeHandle;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const drawingHighlightRef = useRef<{
    pointerId: number;
    pageNumber: number;
    startX: number;
    startY: number;
  } | null>(null);
  const draggingHighlightRef = useRef<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);
  const resizingHighlightRef = useRef<{
    id: string;
    pointerId: number;
    handle: CornerResizeHandle;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const draggingCommentRef = useRef<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);
  const annotationFrameRef = useRef<number | null>(null);
  const pendingAnnotationUpdateRef = useRef<(() => void) | null>(null);
  const annotationDraftRef = useRef<AnnotationDraft | null>(null);
  const imageAssetsRef = useRef<Map<string, StoredImageAsset>>(new Map());
  // This state stores the PDF the user picked from their computer.
  const [pdf, setPdf] = useState<SelectedPdf | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [renderedZoom, setRenderedZoom] = useState(1);
  const [isFitWidth, setIsFitWidth] = useState(true);
  const [stageWidth, setStageWidth] = useState(0);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);
  const [isRenderingPage, setIsRenderingPage] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [activeTool, setActiveTool] = useState<EditingTool>("Select");
  const [textAnnotations, setTextAnnotations] = useState<TextAnnotation[]>([]);
  const [imageAnnotations, setImageAnnotations] = useState<ImageAnnotation[]>([]);
  const [signatureAnnotations, setSignatureAnnotations] = useState<SignatureAnnotation[]>([]);
  const [eraseAnnotations, setEraseAnnotations] = useState<EraseAnnotation[]>([]);
  const [highlightAnnotations, setHighlightAnnotations] = useState<HighlightAnnotation[]>([]);
  const [commentAnnotations, setCommentAnnotations] = useState<CommentAnnotation[]>([]);
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null);
  const [pendingTextPlacement, setPendingTextPlacement] = useState<PendingTextPlacement | null>(
    null
  );
  const [pendingImagePlacement, setPendingImagePlacement] = useState<PendingImagePlacement | null>(
    null
  );
  const [pendingSignaturePlacement, setPendingSignaturePlacement] =
    useState<PendingSignaturePlacement | null>(null);
  const [pendingCommentPlacement, setPendingCommentPlacement] =
    useState<PendingCommentPlacement | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftTextStyle, setDraftTextStyle] = useState<TextStyle>(DEFAULT_TEXT_STYLE);
  const [draftComment, setDraftComment] = useState("");
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [draggingTextId, setDraggingTextId] = useState<string | null>(null);
  const [resizingTextId, setResizingTextId] = useState<string | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [draggingImageId, setDraggingImageId] = useState<string | null>(null);
  const [resizingImageId, setResizingImageId] = useState<string | null>(null);
  const [imageUploadError, setImageUploadError] = useState("");
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);
  const [draggingSignatureId, setDraggingSignatureId] = useState<string | null>(null);
  const [resizingSignatureId, setResizingSignatureId] = useState<string | null>(null);
  const [signatureUploadError, setSignatureUploadError] = useState("");
  const [selectedEraseId, setSelectedEraseId] = useState<string | null>(null);
  const [draggingEraseId, setDraggingEraseId] = useState<string | null>(null);
  const [resizingEraseId, setResizingEraseId] = useState<string | null>(null);
  const [draftEraseRect, setDraftEraseRect] = useState<Omit<EraseAnnotation, "id"> | null>(null);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);
  const [draggingHighlightId, setDraggingHighlightId] = useState<string | null>(null);
  const [resizingHighlightId, setResizingHighlightId] = useState<string | null>(null);
  const [draftHighlightRect, setDraftHighlightRect] =
    useState<Omit<HighlightAnnotation, "id" | "colorName"> | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [draggingCommentId, setDraggingCommentId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
  const [isAiPanelFocused, setIsAiPanelFocused] = useState(false);
  const [isSummarizingPdf, setIsSummarizingPdf] = useState(false);
  const [isExplainingPage, setIsExplainingPage] = useState(false);
  const [isExtractingKeyInfo, setIsExtractingKeyInfo] = useState(false);
  const [isFindingSuggestedEdits, setIsFindingSuggestedEdits] = useState(false);
  const [isAskingAiQuestion, setIsAskingAiQuestion] = useState(false);
  const [isLoadingAiUsage, setIsLoadingAiUsage] = useState(false);
  const [aiUsage, setAiUsage] = useState<AiUsageInfo | null>(null);
  const [aiResponseView, setAiResponseView] = useState<AiResponseView>("summary");
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiSummary, setAiSummary] = useState("");
  const [aiPageExplanation, setAiPageExplanation] = useState("");
  const [aiPageExplanationPageNumber, setAiPageExplanationPageNumber] = useState<number | null>(
    null
  );
  const [aiKeyInfo, setAiKeyInfo] = useState("");
  const [aiSuggestedEdits, setAiSuggestedEdits] = useState("");
  const [aiCustomAnswer, setAiCustomAnswer] = useState("");
  const [aiError, setAiError] = useState("");
  const [didCopyAiSummary, setDidCopyAiSummary] = useState(false);
  const [didCopyAiPageExplanation, setDidCopyAiPageExplanation] = useState(false);
  const [didCopyAiKeyInfo, setDidCopyAiKeyInfo] = useState(false);
  const [didCopyAiSuggestedEdits, setDidCopyAiSuggestedEdits] = useState(false);
  const [didCopyAiCustomAnswer, setDidCopyAiCustomAnswer] = useState(false);
  const [aiAccessCode, setAiAccessCode] = useState("");
  const [aiAccessMessage, setAiAccessMessage] = useState("");
  const [isApplyingAiAccess, setIsApplyingAiAccess] = useState(false);
  const [canShowAiAccessInput, setCanShowAiAccessInput] = useState(false);

  const updateAiUsage = useCallback((nextUsage?: AiUsageInfo) => {
    if (nextUsage) {
      setAiUsage(nextUsage);
    }
  }, []);

  const refreshAiUsage = useCallback(async () => {
    setIsLoadingAiUsage(true);

    try {
      const response = await fetch("/api/ai/usage", {
        method: "GET",
        cache: "no-store"
      });
      const result = (await response.json()) as { aiUsage?: AiUsageInfo };

      updateAiUsage(result.aiUsage);
    } catch {
      // The usage label is helpful, but AI buttons can still show request errors normally.
    } finally {
      setIsLoadingAiUsage(false);
    }
  }, [updateAiUsage]);

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);

      setCanShowAiAccessInput(params.get("nord_admin") === "1");
    }, 0);

    return () => window.clearTimeout(timerId);
  }, []);

  async function applyAiAccessCode() {
    const code = aiAccessCode.trim();

    if (!code) {
      setAiAccessMessage("Enter your private beta/testing access code first.");
      return;
    }

    setIsApplyingAiAccess(true);
    setAiAccessMessage("");

    try {
      const response = await fetch("/api/ai/access", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ code })
      });
      const result = (await response.json()) as {
        message?: string;
        error?: string;
        aiUsage?: AiUsageInfo;
      };

      updateAiUsage(result.aiUsage);

      if (!response.ok) {
        throw new Error(result.error ?? "Private beta/testing access could not be enabled.");
      }

      setAiAccessCode("");
      setAiAccessMessage(result.message ?? "Private beta/testing access is active.");

      if (result.aiUsage?.role) {
        sessionStorage.setItem("nordeditor_ai_access_role", result.aiUsage.role);
      }
    } catch (accessError) {
      setAiAccessMessage(
        accessError instanceof Error
          ? accessError.message
          : "Private beta/testing access could not be enabled."
      );
    } finally {
      setIsApplyingAiAccess(false);
    }
  }

  async function clearAiAccessCode() {
    setIsApplyingAiAccess(true);
    setAiAccessMessage("");

    try {
      const response = await fetch("/api/ai/access", {
        method: "DELETE"
      });
      const result = (await response.json()) as {
        message?: string;
        error?: string;
        aiUsage?: AiUsageInfo;
      };

      updateAiUsage(result.aiUsage);

      if (!response.ok) {
        throw new Error(result.error ?? "Private beta/testing access could not be turned off.");
      }

      sessionStorage.removeItem("nordeditor_ai_access_role");
      setAiAccessCode("");
      setAiAccessMessage(result.message ?? "Private beta/testing access is off.");
    } catch (accessError) {
      setAiAccessMessage(
        accessError instanceof Error
          ? accessError.message
          : "Private beta/testing access could not be turned off."
      );
    } finally {
      setIsApplyingAiAccess(false);
    }
  }

  useEffect(() => {
    const stage = viewerStageRef.current;

    if (!stage) {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? 0;
      setStageWidth(nextWidth);
    });

    resizeObserver.observe(stage);

    return () => resizeObserver.disconnect();
  }, [pdf]);

  useEffect(() => {
    if (!pdf) {
      return;
    }

    const selectedPdf = pdf;
    let isCancelled = false;
    let didFinishLoading = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    async function loadPdf() {
      const pdfjs = await import("pdfjs-dist");

      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();

      if (isCancelled) {
        return;
      }

      loadingTask = pdfjs.getDocument({ data: selectedPdf.data.slice() });

      try {
        const loadedPdf = await loadingTask.promise;
        didFinishLoading = true;

        if (isCancelled) {
          void loadedPdf.destroy();
          return;
        }

        setPdfDocument(loadedPdf);
        setTotalPages(loadedPdf.numPages);
        setError("");
      } catch {
        if (!isCancelled) {
          setPdfDocument(null);
          setError("The PDF could not be opened.");
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingPdf(false);
        }
      }
    }

    void loadPdf();

    return () => {
      isCancelled = true;

      if (!didFinishLoading && loadingTask) {
        void loadingTask.destroy();
      }
    };
  }, [pdf]);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current) {
      return;
    }

    let isCancelled = false;
    let renderTask: RenderTask | null = null;

    async function renderPage() {
      if (!pdfDocument || !canvasRef.current) {
        return;
      }

      setIsRenderingPage(true);

      try {
        const page = await pdfDocument.getPage(currentPage);
        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(stageWidth - 48, 320);
        const nextScale = isFitWidth
          ? clampZoom(availableWidth / baseViewport.width)
          : clampZoom(zoom);
        const viewport = page.getViewport({ scale: nextScale });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        const outputScale = window.devicePixelRatio || 1;

        if (!context || isCancelled) {
          return;
        }

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);

        renderTask = page.render({
          canvas,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
        });

        await renderTask.promise;

        if (!isCancelled) {
          setRenderedZoom(nextScale);
        }
      } catch (renderError) {
        if (!isCancelled && !isRenderCancelled(renderError)) {
          setError("This page could not be rendered.");
        }
      } finally {
        if (!isCancelled) {
          setIsRenderingPage(false);
        }
      }
    }

    void renderPage();

    return () => {
      isCancelled = true;
      renderTask?.cancel();
    };
  }, [currentPage, isFitWidth, pdfDocument, stageWidth, zoom]);

  useEffect(() => {
    return () => {
      if (pdfDocument) {
        void pdfDocument.destroy();
      }
    };
  }, [pdfDocument]);

  useEffect(() => {
    return () => {
      if (annotationFrameRef.current !== null) {
        window.cancelAnimationFrame(annotationFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const imageAssets = imageAssetsRef.current;

    return () => {
      imageAssets.forEach((asset) => {
        URL.revokeObjectURL(asset.objectUrl);
      });
      imageAssets.clear();
    };
  }, []);

  function scheduleAnnotationUpdate(update: () => void) {
    pendingAnnotationUpdateRef.current = update;

    if (annotationFrameRef.current !== null) {
      return;
    }

    annotationFrameRef.current = window.requestAnimationFrame(() => {
      annotationFrameRef.current = null;

      const pendingUpdate = pendingAnnotationUpdateRef.current;
      pendingAnnotationUpdateRef.current = null;
      pendingUpdate?.();
    });
  }

  function scheduleAnnotationDraft(nextDraft: AnnotationDraft) {
    annotationDraftRef.current = nextDraft;
    scheduleAnnotationUpdate(() => setAnnotationDraft(nextDraft));
  }

  function flushAnnotationUpdate() {
    if (annotationFrameRef.current !== null) {
      window.cancelAnimationFrame(annotationFrameRef.current);
      annotationFrameRef.current = null;
    }

    const pendingUpdate = pendingAnnotationUpdateRef.current;
    pendingAnnotationUpdateRef.current = null;
    pendingUpdate?.();
  }

  function cancelAnnotationUpdate() {
    if (annotationFrameRef.current !== null) {
      window.cancelAnimationFrame(annotationFrameRef.current);
      annotationFrameRef.current = null;
    }

    pendingAnnotationUpdateRef.current = null;
  }

  function clearAnnotationDraft() {
    annotationDraftRef.current = null;
    setAnnotationDraft(null);
  }

  function revokeStoredImageAsset(id: string) {
    const asset = imageAssetsRef.current.get(id);

    if (!asset) {
      return;
    }

    URL.revokeObjectURL(asset.objectUrl);
    imageAssetsRef.current.delete(id);
  }

  function clearStoredImageAssets() {
    imageAssetsRef.current.forEach((asset) => {
      URL.revokeObjectURL(asset.objectUrl);
    });
    imageAssetsRef.current.clear();
  }

  function commitAnnotationDraft() {
    const draft = annotationDraftRef.current;

    if (!draft) {
      return;
    }

    if (draft.kind === "text") {
      setTextAnnotations((currentAnnotations) =>
        currentAnnotations.map((annotation) =>
          annotation.id === draft.id
            ? {
                ...annotation,
                x: draft.x,
                y: draft.y,
                width: draft.width,
                height: draft.height
              }
            : annotation
        )
      );
    }

    if (draft.kind === "comment") {
      setCommentAnnotations((currentAnnotations) =>
        currentAnnotations.map((annotation) =>
          annotation.id === draft.id
            ? {
                ...annotation,
                x: draft.x,
                y: draft.y,
                width: draft.width,
                height: draft.height
              }
            : annotation
        )
      );
    }

    if (draft.kind === "image") {
      setImageAnnotations((currentAnnotations) =>
        currentAnnotations.map((annotation) =>
          annotation.id === draft.id
            ? {
                ...annotation,
                x: draft.x,
                y: draft.y,
                width: draft.width,
                height: draft.height
              }
            : annotation
        )
      );
    }

    if (draft.kind === "signature") {
      setSignatureAnnotations((currentAnnotations) =>
        currentAnnotations.map((annotation) =>
          annotation.id === draft.id
            ? {
                ...annotation,
                x: draft.x,
                y: draft.y,
                width: draft.width,
                height: draft.height
              }
            : annotation
        )
      );
    }

    if (draft.kind === "erase") {
      setEraseAnnotations((currentAnnotations) =>
        currentAnnotations.map((annotation) =>
          annotation.id === draft.id
            ? {
                ...annotation,
                x: draft.x,
                y: draft.y,
                width: draft.width,
                height: draft.height
              }
            : annotation
        )
      );
    }

    if (draft.kind === "highlight") {
      setHighlightAnnotations((currentAnnotations) =>
        currentAnnotations.map((annotation) =>
          annotation.id === draft.id
            ? {
                ...annotation,
                x: draft.x,
                y: draft.y,
                width: draft.width,
                height: draft.height
              }
            : annotation
        )
      );
    }

    clearAnnotationDraft();
  }

  function clearHighlightInteraction() {
    setSelectedHighlightId(null);
    setDraggingHighlightId(null);
    setResizingHighlightId(null);
    setDraftHighlightRect(null);
    drawingHighlightRef.current = null;
    draggingHighlightRef.current = null;
    resizingHighlightRef.current = null;
  }

  function clearCommentInteraction() {
    setSelectedCommentId(null);
    setDraggingCommentId(null);
    setPendingCommentPlacement(null);
    setDraftComment("");
    draggingCommentRef.current = null;
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      setError("NordEditor V1 supports PDF files only. Please choose a .pdf file.");
      event.target.value = "";
      return;
    }

    if (file.size > MAX_PDF_UPLOAD_BYTES) {
      setError(
        `This PDF is ${formatFileSize(file.size)}. For V1, please choose a PDF under ${formatFileSize(MAX_PDF_UPLOAD_BYTES)}.`
      );
      event.target.value = "";
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const nextPdf = {
        name: file.name,
        size: file.size,
        data: new Uint8Array(buffer)
      };

      cancelAnnotationUpdate();
      clearAnnotationDraft();
      clearStoredImageAssets();
      setPdfDocument(null);
      setCurrentPage(1);
      setTotalPages(0);
      setZoom(1);
      setRenderedZoom(1);
      setIsFitWidth(true);
      setIsLoadingPdf(true);
      setIsRenderingPage(false);
      setIsExportingPdf(false);
      setActiveTool("Select");
      setTextAnnotations([]);
      setImageAnnotations([]);
      setSignatureAnnotations([]);
      setEraseAnnotations([]);
      setHighlightAnnotations([]);
      setCommentAnnotations([]);
      setPendingTextPlacement(null);
      setPendingImagePlacement(null);
      setPendingSignaturePlacement(null);
      setPendingCommentPlacement(null);
      setDraftText("");
      setDraftTextStyle(DEFAULT_TEXT_STYLE);
      setDraftComment("");
      setSelectedTextId(null);
      setDraggingTextId(null);
      setResizingTextId(null);
      setSelectedImageId(null);
      setDraggingImageId(null);
      setResizingImageId(null);
      setImageUploadError("");
      setSelectedSignatureId(null);
      setDraggingSignatureId(null);
      setResizingSignatureId(null);
      setSignatureUploadError("");
      setSelectedEraseId(null);
      setDraggingEraseId(null);
      setResizingEraseId(null);
      setDraftEraseRect(null);
      clearHighlightInteraction();
      clearCommentInteraction();
      setIsAiPanelOpen(false);
      setIsAiPanelFocused(false);
      setIsSummarizingPdf(false);
      setIsExplainingPage(false);
      setIsExtractingKeyInfo(false);
      setIsFindingSuggestedEdits(false);
      setIsAskingAiQuestion(false);
      setAiResponseView("summary");
      setAiQuestion("");
      setAiSummary("");
      setAiPageExplanation("");
      setAiPageExplanationPageNumber(null);
      setAiKeyInfo("");
      setAiSuggestedEdits("");
      setAiCustomAnswer("");
      setAiError("");
      setDidCopyAiSummary(false);
      setDidCopyAiPageExplanation(false);
      setDidCopyAiKeyInfo(false);
      setDidCopyAiSuggestedEdits(false);
      setDidCopyAiCustomAnswer(false);
      setPdf(nextPdf);
      setError("");
      event.target.value = "";
    } catch {
      setError("The PDF could not be read.");
      event.target.value = "";
    }
  }

  function handleClearPdf() {
    cancelAnnotationUpdate();
    clearAnnotationDraft();
    clearStoredImageAssets();
    setPdfDocument(null);
    setCurrentPage(1);
    setTotalPages(0);
    setZoom(1);
    setRenderedZoom(1);
    setIsFitWidth(true);
    setIsLoadingPdf(false);
    setIsRenderingPage(false);
    setIsExportingPdf(false);
    setActiveTool("Select");
    setTextAnnotations([]);
    setImageAnnotations([]);
    setSignatureAnnotations([]);
    setEraseAnnotations([]);
    setHighlightAnnotations([]);
    setCommentAnnotations([]);
    setPendingTextPlacement(null);
    setPendingImagePlacement(null);
    setPendingSignaturePlacement(null);
    setPendingCommentPlacement(null);
    setDraftText("");
    setDraftTextStyle(DEFAULT_TEXT_STYLE);
    setDraftComment("");
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setImageUploadError("");
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSignatureUploadError("");
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    setDraftEraseRect(null);
    clearHighlightInteraction();
    clearCommentInteraction();
    setIsAiPanelOpen(false);
    setIsAiPanelFocused(false);
    setIsSummarizingPdf(false);
    setIsExplainingPage(false);
    setIsExtractingKeyInfo(false);
    setIsFindingSuggestedEdits(false);
    setIsAskingAiQuestion(false);
    setAiResponseView("summary");
    setAiQuestion("");
    setAiSummary("");
    setAiPageExplanation("");
    setAiPageExplanationPageNumber(null);
    setAiKeyInfo("");
    setAiSuggestedEdits("");
    setAiCustomAnswer("");
    setAiError("");
    setDidCopyAiSummary(false);
    setDidCopyAiPageExplanation(false);
    setDidCopyAiKeyInfo(false);
    setDidCopyAiSuggestedEdits(false);
    setDidCopyAiCustomAnswer(false);
    setPdf(null);
    setError("");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function goToPreviousPage() {
    setPendingTextPlacement(null);
    setPendingImagePlacement(null);
    setPendingSignaturePlacement(null);
    setPendingCommentPlacement(null);
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    setDraftEraseRect(null);
    clearHighlightInteraction();
    clearCommentInteraction();
    setCurrentPage((page) => Math.max(1, page - 1));
  }

  function goToNextPage() {
    setPendingTextPlacement(null);
    setPendingImagePlacement(null);
    setPendingSignaturePlacement(null);
    setPendingCommentPlacement(null);
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    setDraftEraseRect(null);
    clearHighlightInteraction();
    clearCommentInteraction();
    setCurrentPage((page) => Math.min(totalPages, page + 1));
  }

  function zoomOut() {
    setIsFitWidth(false);
    setZoom((currentZoom) => clampZoom(currentZoom - ZOOM_STEP));
  }

  function zoomIn() {
    setIsFitWidth(false);
    setZoom((currentZoom) => clampZoom(currentZoom + ZOOM_STEP));
  }

  function fitWidth() {
    setIsFitWidth(true);
  }

  function selectTool(tool: EditingTool) {
    cancelAnnotationUpdate();
    clearAnnotationDraft();
    setActiveTool(tool === "Download" ? "Select" : tool);
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    setDraftEraseRect(null);
    clearHighlightInteraction();
    clearCommentInteraction();
    drawingEraseRef.current = null;

    if (tool !== "Text") {
      setPendingTextPlacement(null);
      setDraftText("");
      setDraftTextStyle(DEFAULT_TEXT_STYLE);
    }

    if (tool !== "Image") {
      setPendingImagePlacement(null);
      setImageUploadError("");
    }

    if (tool !== "Signature") {
      setPendingSignaturePlacement(null);
      setSignatureUploadError("");
    }

    if (tool !== "Comment") {
      setPendingCommentPlacement(null);
      setDraftComment("");
    }

    if (tool === "Download") {
      void downloadEditedPdf();
    }
  }

  function getPageRect() {
    const canvas = canvasRef.current;

    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    return rect;
  }

  function screenToNormalizedPagePoint(clientX: number, clientY: number) {
    // Input helper: converts a browser pointer position into normalized PDF page coordinates.
    const rect = getPageRect();

    if (!rect) {
      return null;
    }

    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const yFromTopRatio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const y = 1 - yFromTopRatio;

    return { x, y };
  }

  function getNormalizedRectFromPoints(
    pageNumber: number,
    startPoint: { x: number; y: number },
    endPoint: { x: number; y: number }
  ) {
    return {
      pageNumber,
      x: Math.min(startPoint.x, endPoint.x),
      y: Math.min(startPoint.y, endPoint.y),
      width: Math.abs(endPoint.x - startPoint.x),
      height: Math.abs(endPoint.y - startPoint.y)
    };
  }

  function getDefaultImageSize(naturalWidth: number, naturalHeight: number) {
    const pageRect = getPageRect();
    const pageAspect = pageRect ? pageRect.width / pageRect.height : 0.75;
    const imageAspect = naturalWidth > 0 ? naturalHeight / naturalWidth : 0.65;
    let width = pageRect ? clampValue(220 / pageRect.width, 0.14, 0.32) : 0.28;
    let height = width * imageAspect * pageAspect;

    if (height > 0.42) {
      const shrinkRatio = 0.42 / height;
      width *= shrinkRatio;
      height = 0.42;
    }

    return {
      width: clampValue(width, 0.08, 0.5),
      height: clampValue(height, 0.06, 0.5)
    };
  }

  function getDefaultTextWidth() {
    const pageRect = getPageRect();

    if (!pageRect) {
      return 0.32;
    }

    return clampValue(260 / pageRect.width, 0.22, 0.48);
  }

  function getCommentMarkerRect(point: NormalizedPagePoint): NormalizedPageRect {
    const pageRect = getPageRect();
    const markerScreenSize = COMMENT_MARKER_PDF_SIZE * renderedZoom;
    const width = pageRect ? clampValue(markerScreenSize / pageRect.width, 0.012, 0.18) : 0.04;
    const height = pageRect ? clampValue(markerScreenSize / pageRect.height, 0.012, 0.18) : 0.04;

    // Comments are stored as the same normalized rectangle used by every box-like tool.
    return {
      x: clampValue(point.x - width / 2, 0, 1 - width),
      y: clampValue(point.y - height / 2, 0, 1 - height),
      width,
      height
    };
  }

  function handlePdfPageClick(event: PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const isEraseTarget = Boolean(target.closest("[data-erase-annotation]"));
    const isHighlightTarget = Boolean(target.closest("[data-highlight-annotation]"));
    const isCommentTarget = Boolean(target.closest("[data-comment-annotation]"));
    const canPlaceOverErase =
      activeTool === "Text" ||
      activeTool === "Image" ||
      activeTool === "Signature" ||
      activeTool === "Highlight" ||
      activeTool === "Comment";
    const canPlaceOverHighlight =
      activeTool === "Text" ||
      activeTool === "Image" ||
      activeTool === "Signature" ||
      activeTool === "Erase" ||
      activeTool === "Comment";

    if (
      target.closest("[data-text-annotation]") ||
      target.closest("[data-image-annotation]") ||
      target.closest("[data-signature-annotation]") ||
      isCommentTarget ||
      (isEraseTarget && !canPlaceOverErase) ||
      (isHighlightTarget && !canPlaceOverHighlight) ||
      target.closest(".text-popover") ||
      target.closest(".image-popover") ||
      target.closest(".signature-popover") ||
      target.closest(".comment-popover")
    ) {
      return;
    }

    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    setDraftEraseRect(null);
    clearHighlightInteraction();
    clearCommentInteraction();

    if (
      (activeTool !== "Text" &&
        activeTool !== "Image" &&
        activeTool !== "Signature" &&
        activeTool !== "Erase" &&
        activeTool !== "Highlight" &&
        activeTool !== "Comment") ||
      !canUseControls
    ) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    if (activeTool === "Text") {
      setPendingTextPlacement({
        pageNumber: currentPage,
        x: pagePoint.x,
        y: pagePoint.y
      });
      setPendingImagePlacement(null);
      setPendingSignaturePlacement(null);
      setPendingCommentPlacement(null);
      setDraftText("");
      setDraftTextStyle(DEFAULT_TEXT_STYLE);
      setDraftComment("");
      setImageUploadError("");
      setSignatureUploadError("");
      return;
    }

    if (activeTool === "Image") {
      setPendingImagePlacement({
        pageNumber: currentPage,
        x: pagePoint.x,
        y: pagePoint.y
      });
      setPendingTextPlacement(null);
      setPendingSignaturePlacement(null);
      setPendingCommentPlacement(null);
      setDraftComment("");
      setImageUploadError("");
      setSignatureUploadError("");
      return;
    }

    if (activeTool === "Highlight") {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setPendingTextPlacement(null);
      setPendingImagePlacement(null);
      setPendingSignaturePlacement(null);
      setPendingCommentPlacement(null);
      setDraftComment("");
      setImageUploadError("");
      setSignatureUploadError("");

      drawingHighlightRef.current = {
        pointerId: event.pointerId,
        pageNumber: currentPage,
        startX: pagePoint.x,
        startY: pagePoint.y
      };
      setDraftHighlightRect({
        pageNumber: currentPage,
        x: pagePoint.x,
        y: pagePoint.y,
        width: 0,
        height: 0
      });
      return;
    }

    if (activeTool === "Comment") {
      setPendingCommentPlacement({
        pageNumber: currentPage,
        x: pagePoint.x,
        y: pagePoint.y
      });
      setPendingTextPlacement(null);
      setPendingImagePlacement(null);
      setPendingSignaturePlacement(null);
      setDraftComment("");
      setImageUploadError("");
      setSignatureUploadError("");
      return;
    }

    if (activeTool === "Erase") {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setPendingTextPlacement(null);
      setPendingImagePlacement(null);
      setPendingSignaturePlacement(null);
      setPendingCommentPlacement(null);
      setDraftComment("");
      setImageUploadError("");
      setSignatureUploadError("");

      drawingEraseRef.current = {
        pointerId: event.pointerId,
        pageNumber: currentPage,
        startX: pagePoint.x,
        startY: pagePoint.y
      };
      setDraftEraseRect({
        pageNumber: currentPage,
        x: pagePoint.x,
        y: pagePoint.y,
        width: 0,
        height: 0
      });
      return;
    }

    setPendingSignaturePlacement({
      pageNumber: currentPage,
      x: pagePoint.x,
      y: pagePoint.y
    });
    setPendingTextPlacement(null);
    setPendingImagePlacement(null);
    setPendingCommentPlacement(null);
    setDraftComment("");
    setImageUploadError("");
    setSignatureUploadError("");
  }

  function updateEraseDrawing(event: PointerEvent<HTMLDivElement>) {
    const drawingErase = drawingEraseRef.current;

    if (!drawingErase || drawingErase.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    scheduleAnnotationUpdate(() =>
      setDraftEraseRect(
        getNormalizedRectFromPoints(
          drawingErase.pageNumber,
          {
            x: drawingErase.startX,
            y: drawingErase.startY
          },
          pagePoint
        )
      )
    );
  }

  function finishEraseDrawing(event: PointerEvent<HTMLDivElement>) {
    const drawingErase = drawingEraseRef.current;

    if (!drawingErase || drawingErase.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);
    flushAnnotationUpdate();
    drawingEraseRef.current = null;
    setDraftEraseRect(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!pagePoint) {
      return;
    }

    const nextEraseRect = getNormalizedRectFromPoints(
      drawingErase.pageNumber,
      {
        x: drawingErase.startX,
        y: drawingErase.startY
      },
      pagePoint
    );

    if (nextEraseRect.width < 0.005 || nextEraseRect.height < 0.005) {
      return;
    }

    const nextEraseId = crypto.randomUUID();

    setEraseAnnotations((currentAnnotations) => [
      ...currentAnnotations,
      {
        id: nextEraseId,
        ...nextEraseRect
      }
    ]);
    setSelectedEraseId(nextEraseId);
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    clearHighlightInteraction();
    clearCommentInteraction();
    setActiveTool("Select");
  }

  function cancelEraseDrawing(event: PointerEvent<HTMLDivElement>) {
    const drawingErase = drawingEraseRef.current;

    if (!drawingErase || drawingErase.pointerId !== event.pointerId) {
      return;
    }

    drawingEraseRef.current = null;
    cancelAnnotationUpdate();
    setDraftEraseRect(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function updateHighlightDrawing(event: PointerEvent<HTMLDivElement>) {
    const drawingHighlight = drawingHighlightRef.current;

    if (!drawingHighlight || drawingHighlight.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    scheduleAnnotationUpdate(() =>
      setDraftHighlightRect(
        getNormalizedRectFromPoints(
          drawingHighlight.pageNumber,
          {
            x: drawingHighlight.startX,
            y: drawingHighlight.startY
          },
          pagePoint
        )
      )
    );
  }

  function finishHighlightDrawing(event: PointerEvent<HTMLDivElement>) {
    const drawingHighlight = drawingHighlightRef.current;

    if (!drawingHighlight || drawingHighlight.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);
    flushAnnotationUpdate();
    drawingHighlightRef.current = null;
    setDraftHighlightRect(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!pagePoint) {
      return;
    }

    const nextHighlightRect = getNormalizedRectFromPoints(
      drawingHighlight.pageNumber,
      {
        x: drawingHighlight.startX,
        y: drawingHighlight.startY
      },
      pagePoint
    );

    if (nextHighlightRect.width < 0.005 || nextHighlightRect.height < 0.005) {
      return;
    }

    const nextHighlightId = crypto.randomUUID();

    setHighlightAnnotations((currentAnnotations) => [
      ...currentAnnotations,
      {
        id: nextHighlightId,
        colorName: DEFAULT_HIGHLIGHT_COLOR,
        ...nextHighlightRect
      }
    ]);
    setSelectedHighlightId(nextHighlightId);
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    setDraggingHighlightId(null);
    setResizingHighlightId(null);
    clearCommentInteraction();
    setActiveTool("Select");
  }

  function cancelHighlightDrawing(event: PointerEvent<HTMLDivElement>) {
    const drawingHighlight = drawingHighlightRef.current;

    if (!drawingHighlight || drawingHighlight.pointerId !== event.pointerId) {
      return;
    }

    drawingHighlightRef.current = null;
    cancelAnnotationUpdate();
    setDraftHighlightRect(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function saveCommentAnnotation() {
    const nextComment = draftComment.trim();
    const placement = pendingCommentPlacement;

    if (!nextComment || !placement) {
      return;
    }

    const nextCommentId = placement.editingId ?? crypto.randomUUID();

    if (placement.editingId) {
      setCommentAnnotations((currentAnnotations) =>
        currentAnnotations.map((annotation) =>
          annotation.id === placement.editingId
            ? {
                ...annotation,
                comment: nextComment
              }
            : annotation
        )
      );
    } else {
      const markerRect = getCommentMarkerRect(placement);

      setCommentAnnotations((currentAnnotations) => [
        ...currentAnnotations,
        {
          id: nextCommentId,
          pageNumber: placement.pageNumber,
          comment: nextComment,
          ...markerRect
        }
      ]);
    }

    setSelectedCommentId(nextCommentId);
    setDraggingCommentId(null);
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    setDraftEraseRect(null);
    clearHighlightInteraction();
    setPendingCommentPlacement(null);
    setDraftComment("");
    draggingCommentRef.current = null;
    setActiveTool("Select");
  }

  function cancelCommentAnnotation() {
    setPendingCommentPlacement(null);
    setDraftComment("");
  }

  function selectCommentAnnotation(id: string) {
    setSelectedCommentId(id);
    setDraggingCommentId(null);
    setPendingCommentPlacement(null);
    setDraftComment("");
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    setPendingTextPlacement(null);
    setPendingImagePlacement(null);
    setPendingSignaturePlacement(null);
    setDraftText("");
    setDraftTextStyle(DEFAULT_TEXT_STYLE);
    setImageUploadError("");
    setSignatureUploadError("");
    clearHighlightInteraction();
  }

  function finishEditingSelectedComment() {
    clearCommentInteraction();
  }

  function editSelectedComment() {
    const selectedComment = commentAnnotations.find(
      (annotation) => annotation.id === selectedCommentId
    );

    if (!selectedComment) {
      return;
    }

    setPendingCommentPlacement({
      pageNumber: selectedComment.pageNumber,
      x: selectedComment.x + selectedComment.width / 2,
      y: selectedComment.y + selectedComment.height / 2,
      editingId: selectedComment.id
    });
    setDraftComment(selectedComment.comment);
  }

  function startMovingComment(
    event: PointerEvent<HTMLButtonElement>,
    annotation: CommentAnnotation
  ) {
    if (event.button !== 0) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectCommentAnnotation(annotation.id);
    setDraggingCommentId(annotation.id);

    draggingCommentRef.current = {
      id: annotation.id,
      pointerId: event.pointerId,
      offsetX: pagePoint.x - annotation.x,
      offsetY: pagePoint.y - annotation.y,
      width: annotation.width,
      height: annotation.height
    };
  }

  function moveComment(event: PointerEvent<HTMLButtonElement>) {
    const draggingComment = draggingCommentRef.current;

    if (!draggingComment || draggingComment.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    scheduleAnnotationDraft({
      kind: "comment",
      id: draggingComment.id,
      x: clampValue(pagePoint.x - draggingComment.offsetX, 0, 1 - draggingComment.width),
      y: clampValue(pagePoint.y - draggingComment.offsetY, 0, 1 - draggingComment.height),
      width: draggingComment.width,
      height: draggingComment.height
    });
  }

  function stopMovingComment(event: PointerEvent<HTMLButtonElement>) {
    const draggingComment = draggingCommentRef.current;

    if (!draggingComment || draggingComment.pointerId !== event.pointerId) {
      return;
    }

    flushAnnotationUpdate();
    commitAnnotationDraft();
    draggingCommentRef.current = null;
    setDraggingCommentId(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function deleteSelectedComment() {
    if (!selectedCommentId) {
      return;
    }

    setCommentAnnotations((currentAnnotations) =>
      currentAnnotations.filter((annotation) => annotation.id !== selectedCommentId)
    );
    clearCommentInteraction();
  }

  function addTextAnnotation() {
    const nextText = draftText.trim();

    if (!nextText || !pendingTextPlacement) {
      return;
    }

    if (pendingTextPlacement.editingId) {
      const editingTextId = pendingTextPlacement.editingId;

      // Editing reuses the same modal, but only changes the text and style.
      setTextAnnotations((currentAnnotations) =>
        currentAnnotations.map((annotation) =>
          annotation.id === editingTextId
            ? {
                ...annotation,
                text: nextText,
                ...draftTextStyle
              }
            : annotation
        )
      );
      setSelectedTextId(editingTextId);
      setDraggingTextId(null);
      setResizingTextId(null);
      setPendingTextPlacement(null);
      setDraftText("");
      setDraftTextStyle(DEFAULT_TEXT_STYLE);
      setActiveTool("Select");
      return;
    }

    const nextTextId = crypto.randomUUID();

    setTextAnnotations((currentAnnotations) => [
      ...currentAnnotations,
      {
        id: nextTextId,
        pageNumber: pendingTextPlacement.pageNumber,
        text: nextText,
        x: pendingTextPlacement.x,
        y: pendingTextPlacement.y,
        width: clampValue(getDefaultTextWidth(), 0.12, 1 - pendingTextPlacement.x),
        height: 0,
        ...draftTextStyle
      }
    ]);
    setSelectedTextId(nextTextId);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    clearHighlightInteraction();
    clearCommentInteraction();
    setPendingTextPlacement(null);
    setDraftText("");
    setDraftTextStyle(DEFAULT_TEXT_STYLE);
    setActiveTool("Select");
  }

  function cancelTextAnnotation() {
    setPendingTextPlacement(null);
    setDraftText("");
    setDraftTextStyle(DEFAULT_TEXT_STYLE);
  }

  function editSelectedText(annotation: TextAnnotation) {
    cancelAnnotationUpdate();
    clearAnnotationDraft();
    draggingTextRef.current = null;
    resizingTextRef.current = null;
    setSelectedTextId(annotation.id);
    setDraggingTextId(null);
    setResizingTextId(null);
    setPendingImagePlacement(null);
    setPendingSignaturePlacement(null);
    setPendingCommentPlacement(null);
    setImageUploadError("");
    setSignatureUploadError("");
    setDraftComment("");
    setPendingTextPlacement({
      pageNumber: annotation.pageNumber,
      x: annotation.x,
      y: annotation.y,
      editingId: annotation.id
    });
    setDraftText(annotation.text);
    setDraftTextStyle({
      fontSize: annotation.fontSize,
      color: annotation.color,
      isBold: annotation.isBold,
      fontFamily: annotation.fontFamily
    });
  }

  function selectTextAnnotation(id: string) {
    setSelectedTextId(id);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    clearHighlightInteraction();
    clearCommentInteraction();
    setPendingImagePlacement(null);
    setPendingSignaturePlacement(null);
    setImageUploadError("");
    setSignatureUploadError("");
    clearCommentInteraction();
  }

  function finishEditingSelectedText() {
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    draggingTextRef.current = null;
    resizingTextRef.current = null;
  }

  function startMovingText(event: PointerEvent<HTMLButtonElement>, annotation: TextAnnotation) {
    if (event.button !== 0) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setPendingTextPlacement(null);
    setDraftText("");
    setDraftTextStyle(DEFAULT_TEXT_STYLE);
    setSelectedTextId(annotation.id);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    clearHighlightInteraction();
    clearCommentInteraction();
    setDraggingTextId(annotation.id);

    draggingTextRef.current = {
      id: annotation.id,
      pointerId: event.pointerId,
      offsetX: pagePoint.x - annotation.x,
      offsetY: pagePoint.y - annotation.y,
      width: annotation.width,
      height: annotation.height
    };
  }

  function moveText(event: PointerEvent<HTMLButtonElement>) {
    const draggingText = draggingTextRef.current;

    if (!draggingText || draggingText.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    scheduleAnnotationDraft({
      kind: "text",
      id: draggingText.id,
      x: clampValue(
        pagePoint.x - draggingText.offsetX,
        0,
        1 - draggingText.width
      ),
      y: clampValue(pagePoint.y - draggingText.offsetY, 0, 1),
      width: draggingText.width,
      height: draggingText.height
    });
  }

  function stopMovingText(event: PointerEvent<HTMLButtonElement>) {
    const draggingText = draggingTextRef.current;

    if (!draggingText || draggingText.pointerId !== event.pointerId) {
      return;
    }

    flushAnnotationUpdate();
    commitAnnotationDraft();
    draggingTextRef.current = null;
    setDraggingTextId(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function deleteSelectedText() {
    if (!selectedTextId) {
      return;
    }

    setTextAnnotations((currentAnnotations) =>
      currentAnnotations.filter((annotation) => annotation.id !== selectedTextId)
    );
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    draggingTextRef.current = null;
    resizingTextRef.current = null;
  }

  function updateTextAnnotationStyle(id: string, styleUpdate: Partial<TextStyle>) {
    setTextAnnotations((currentAnnotations) =>
      currentAnnotations.map((annotation) =>
        annotation.id === id ? { ...annotation, ...styleUpdate } : annotation
      )
    );
  }

  function startResizingText(
    event: PointerEvent<HTMLButtonElement>,
    annotation: TextAnnotation,
    handle: CornerResizeHandle
  ) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectTextAnnotation(annotation.id);
    setDraggingTextId(null);
    setResizingTextId(annotation.id);

    resizingTextRef.current = {
      id: annotation.id,
      pointerId: event.pointerId,
      handle,
      startX: annotation.x,
      startY: annotation.y,
      startWidth: annotation.width,
      startHeight: annotation.height
    };
  }

  function resizeText(event: PointerEvent<HTMLButtonElement>) {
    const resizingText = resizingTextRef.current;

    if (!resizingText || resizingText.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    const minimumWidth = 0.08;
    const startRightRatio = resizingText.startX + resizingText.startWidth;

    if (resizingText.handle.includes("w")) {
      const nextX = clampValue(pagePoint.x, 0, startRightRatio - minimumWidth);

      scheduleAnnotationDraft({
        kind: "text",
        id: resizingText.id,
        x: nextX,
        y: resizingText.startY,
        width: startRightRatio - nextX,
        height: resizingText.startHeight
      });
      return;
    }

    scheduleAnnotationDraft({
      kind: "text",
      id: resizingText.id,
      x: resizingText.startX,
      y: resizingText.startY,
      width: clampValue(
        pagePoint.x - resizingText.startX,
        minimumWidth,
        1 - resizingText.startX
      ),
      height: resizingText.startHeight
    });
  }

  function stopResizingText(event: PointerEvent<HTMLButtonElement>) {
    const resizingText = resizingTextRef.current;

    if (!resizingText || resizingText.pointerId !== event.pointerId) {
      return;
    }

    flushAnnotationUpdate();
    commitAnnotationDraft();
    resizingTextRef.current = null;
    setResizingTextId(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function handleImageUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const placement = pendingImagePlacement;

    if (!file || !placement) {
      return;
    }

    const isSupportedImage =
      file.type === "image/png" ||
      file.type === "image/jpeg" ||
      /\.(png|jpe?g)$/i.test(file.name);

    if (!isSupportedImage) {
      setImageUploadError("Please choose a PNG or JPG image.");
      event.target.value = "";
      return;
    }

    try {
      const imageAsset = await createStoredImageAsset(file);
      const imageSize = getDefaultImageSize(imageAsset.width, imageAsset.height);
      const nextImageId = crypto.randomUUID();

      imageAssetsRef.current.set(nextImageId, imageAsset);
      setImageAnnotations((currentAnnotations) => [
        ...currentAnnotations,
        {
          id: nextImageId,
          pageNumber: placement.pageNumber,
          name: file.name,
          objectUrl: imageAsset.objectUrl,
          x: clampValue(placement.x, 0, 1 - imageSize.width),
          y: clampValue(
            placement.y - imageSize.height,
            0,
            1 - imageSize.height
          ),
          width: imageSize.width,
          height: imageSize.height
        }
      ]);
      setSelectedImageId(nextImageId);
      setSelectedTextId(null);
      setDraggingTextId(null);
      setResizingTextId(null);
      setDraggingImageId(null);
      setResizingImageId(null);
      setSelectedSignatureId(null);
      setDraggingSignatureId(null);
      setResizingSignatureId(null);
      setSelectedEraseId(null);
      setDraggingEraseId(null);
      setResizingEraseId(null);
      clearHighlightInteraction();
      clearCommentInteraction();
      setPendingImagePlacement(null);
      setImageUploadError("");
      setActiveTool("Select");
      event.target.value = "";
    } catch {
      setImageUploadError("The image could not be loaded.");
      event.target.value = "";
    }
  }

  function cancelImageAnnotation() {
    setPendingImagePlacement(null);
    setImageUploadError("");
  }

  function selectImageAnnotation(id: string) {
    setSelectedImageId(id);
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    clearHighlightInteraction();
    clearCommentInteraction();
    setPendingTextPlacement(null);
    setPendingImagePlacement(null);
    setPendingSignaturePlacement(null);
    setDraftText("");
    setDraftTextStyle(DEFAULT_TEXT_STYLE);
    setImageUploadError("");
  }

  function finishEditingSelectedImage() {
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
  }

  function startMovingImage(event: PointerEvent<HTMLButtonElement>, annotation: ImageAnnotation) {
    if (event.button !== 0) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectImageAnnotation(annotation.id);
    setDraggingImageId(annotation.id);
    setResizingImageId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);

    draggingImageRef.current = {
      id: annotation.id,
      pointerId: event.pointerId,
      offsetX: pagePoint.x - annotation.x,
      offsetY: pagePoint.y - annotation.y,
      width: annotation.width,
      height: annotation.height
    };
  }

  function moveImage(event: PointerEvent<HTMLButtonElement>) {
    const draggingImage = draggingImageRef.current;

    if (!draggingImage || draggingImage.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    scheduleAnnotationDraft({
      kind: "image",
      id: draggingImage.id,
      x: clampValue(
        pagePoint.x - draggingImage.offsetX,
        0,
        1 - draggingImage.width
      ),
      y: clampValue(
        pagePoint.y - draggingImage.offsetY,
        0,
        1 - draggingImage.height
      ),
      width: draggingImage.width,
      height: draggingImage.height
    });
  }

  function stopMovingImage(event: PointerEvent<HTMLButtonElement>) {
    const draggingImage = draggingImageRef.current;

    if (!draggingImage || draggingImage.pointerId !== event.pointerId) {
      return;
    }

    flushAnnotationUpdate();
    commitAnnotationDraft();
    draggingImageRef.current = null;
    setDraggingImageId(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function startResizingImage(
    event: PointerEvent<HTMLButtonElement>,
    annotation: ImageAnnotation,
    handle: CornerResizeHandle
  ) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectImageAnnotation(annotation.id);
    setDraggingImageId(null);
    setResizingImageId(annotation.id);

    resizingImageRef.current = {
      id: annotation.id,
      pointerId: event.pointerId,
      handle,
      startX: annotation.x,
      startY: annotation.y,
      startWidth: annotation.width,
      startHeight: annotation.height
    };
  }

  function resizeImage(event: PointerEvent<HTMLButtonElement>) {
    const resizingImage = resizingImageRef.current;

    if (!resizingImage || resizingImage.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    const minimumWidth = 0.05;
    const minimumHeight = 0.04;
    const startRightRatio = resizingImage.startX + resizingImage.startWidth;
    const startTopRatio = resizingImage.startY + resizingImage.startHeight;

    let nextX = resizingImage.startX;
    let nextY = resizingImage.startY;
    let nextWidth = resizingImage.startWidth;
    let nextHeight = resizingImage.startHeight;

    if (resizingImage.handle.includes("e")) {
      nextWidth = clampValue(
        pagePoint.x - resizingImage.startX,
        minimumWidth,
        1 - resizingImage.startX
      );
    }

    if (resizingImage.handle.includes("n")) {
      nextHeight = clampValue(
        pagePoint.y - resizingImage.startY,
        minimumHeight,
        1 - resizingImage.startY
      );
    }

    if (resizingImage.handle.includes("w")) {
      nextX = clampValue(pagePoint.x, 0, startRightRatio - minimumWidth);
      nextWidth = startRightRatio - nextX;
    }

    if (resizingImage.handle.includes("s")) {
      nextY = clampValue(pagePoint.y, 0, startTopRatio - minimumHeight);
      nextHeight = startTopRatio - nextY;
    }

    scheduleAnnotationDraft({
      kind: "image",
      id: resizingImage.id,
      x: nextX,
      y: nextY,
      width: nextWidth,
      height: nextHeight
    });
  }

  function stopResizingImage(event: PointerEvent<HTMLButtonElement>) {
    const resizingImage = resizingImageRef.current;

    if (!resizingImage || resizingImage.pointerId !== event.pointerId) {
      return;
    }

    flushAnnotationUpdate();
    commitAnnotationDraft();
    resizingImageRef.current = null;
    setResizingImageId(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function deleteSelectedImage() {
    if (!selectedImageId) {
      return;
    }

    const deletedImageId = selectedImageId;

    setImageAnnotations((currentAnnotations) =>
      currentAnnotations.filter((annotation) => annotation.id !== deletedImageId)
    );
    revokeStoredImageAsset(deletedImageId);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
  }

  async function handleSignatureUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const placement = pendingSignaturePlacement;

    if (!file || !placement) {
      return;
    }

    const isSupportedImage =
      file.type === "image/png" ||
      file.type === "image/jpeg" ||
      /\.(png|jpe?g)$/i.test(file.name);

    if (!isSupportedImage) {
      setSignatureUploadError("Please choose a PNG or JPG signature image.");
      event.target.value = "";
      return;
    }

    try {
      const signatureAsset = await createStoredImageAsset(file);
      const signatureSize = getDefaultImageSize(signatureAsset.width, signatureAsset.height);
      const nextSignatureId = crypto.randomUUID();

      imageAssetsRef.current.set(nextSignatureId, signatureAsset);
      setSignatureAnnotations((currentAnnotations) => [
        ...currentAnnotations,
        {
          id: nextSignatureId,
          pageNumber: placement.pageNumber,
          name: file.name,
          objectUrl: signatureAsset.objectUrl,
          x: clampValue(placement.x, 0, 1 - signatureSize.width),
          y: clampValue(
            placement.y - signatureSize.height,
            0,
            1 - signatureSize.height
          ),
          width: signatureSize.width,
          height: signatureSize.height
        }
      ]);
      setSelectedSignatureId(nextSignatureId);
      setSelectedTextId(null);
      setDraggingTextId(null);
      setResizingTextId(null);
      setSelectedImageId(null);
      setDraggingImageId(null);
      setResizingImageId(null);
      setDraggingSignatureId(null);
      setResizingSignatureId(null);
      setSelectedEraseId(null);
      setDraggingEraseId(null);
      setResizingEraseId(null);
      clearHighlightInteraction();
      clearCommentInteraction();
      setPendingSignaturePlacement(null);
      setSignatureUploadError("");
      setActiveTool("Select");
      event.target.value = "";
    } catch {
      setSignatureUploadError("The signature image could not be loaded.");
      event.target.value = "";
    }
  }

  function cancelSignatureAnnotation() {
    setPendingSignaturePlacement(null);
    setSignatureUploadError("");
  }

  function selectSignatureAnnotation(id: string) {
    setSelectedSignatureId(id);
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    clearHighlightInteraction();
    clearCommentInteraction();
    setPendingTextPlacement(null);
    setPendingImagePlacement(null);
    setPendingSignaturePlacement(null);
    setDraftText("");
    setDraftTextStyle(DEFAULT_TEXT_STYLE);
    setSignatureUploadError("");
  }

  function finishEditingSelectedSignature() {
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
  }

  function startMovingSignature(
    event: PointerEvent<HTMLButtonElement>,
    annotation: SignatureAnnotation
  ) {
    if (event.button !== 0) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectSignatureAnnotation(annotation.id);
    setDraggingSignatureId(annotation.id);
    setResizingSignatureId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);

    draggingSignatureRef.current = {
      id: annotation.id,
      pointerId: event.pointerId,
      offsetX: pagePoint.x - annotation.x,
      offsetY: pagePoint.y - annotation.y,
      width: annotation.width,
      height: annotation.height
    };
  }

  function moveSignature(event: PointerEvent<HTMLButtonElement>) {
    const draggingSignature = draggingSignatureRef.current;

    if (!draggingSignature || draggingSignature.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    scheduleAnnotationDraft({
      kind: "signature",
      id: draggingSignature.id,
      x: clampValue(
        pagePoint.x - draggingSignature.offsetX,
        0,
        1 - draggingSignature.width
      ),
      y: clampValue(
        pagePoint.y - draggingSignature.offsetY,
        0,
        1 - draggingSignature.height
      ),
      width: draggingSignature.width,
      height: draggingSignature.height
    });
  }

  function stopMovingSignature(event: PointerEvent<HTMLButtonElement>) {
    const draggingSignature = draggingSignatureRef.current;

    if (!draggingSignature || draggingSignature.pointerId !== event.pointerId) {
      return;
    }

    flushAnnotationUpdate();
    commitAnnotationDraft();
    draggingSignatureRef.current = null;
    setDraggingSignatureId(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function startResizingSignature(
    event: PointerEvent<HTMLButtonElement>,
    annotation: SignatureAnnotation,
    handle: CornerResizeHandle
  ) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectSignatureAnnotation(annotation.id);
    setDraggingSignatureId(null);
    setResizingSignatureId(annotation.id);

    resizingSignatureRef.current = {
      id: annotation.id,
      pointerId: event.pointerId,
      handle,
      startX: annotation.x,
      startY: annotation.y,
      startWidth: annotation.width,
      startHeight: annotation.height
    };
  }

  function resizeSignature(event: PointerEvent<HTMLButtonElement>) {
    const resizingSignature = resizingSignatureRef.current;

    if (!resizingSignature || resizingSignature.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    const minimumWidth = 0.05;
    const minimumHeight = 0.04;
    const startRightRatio = resizingSignature.startX + resizingSignature.startWidth;
    const startTopRatio = resizingSignature.startY + resizingSignature.startHeight;

    let nextX = resizingSignature.startX;
    let nextY = resizingSignature.startY;
    let nextWidth = resizingSignature.startWidth;
    let nextHeight = resizingSignature.startHeight;

    if (resizingSignature.handle.includes("e")) {
      nextWidth = clampValue(
        pagePoint.x - resizingSignature.startX,
        minimumWidth,
        1 - resizingSignature.startX
      );
    }

    if (resizingSignature.handle.includes("n")) {
      nextHeight = clampValue(
        pagePoint.y - resizingSignature.startY,
        minimumHeight,
        1 - resizingSignature.startY
      );
    }

    if (resizingSignature.handle.includes("w")) {
      nextX = clampValue(pagePoint.x, 0, startRightRatio - minimumWidth);
      nextWidth = startRightRatio - nextX;
    }

    if (resizingSignature.handle.includes("s")) {
      nextY = clampValue(pagePoint.y, 0, startTopRatio - minimumHeight);
      nextHeight = startTopRatio - nextY;
    }

    scheduleAnnotationDraft({
      kind: "signature",
      id: resizingSignature.id,
      x: nextX,
      y: nextY,
      width: nextWidth,
      height: nextHeight
    });
  }

  function stopResizingSignature(event: PointerEvent<HTMLButtonElement>) {
    const resizingSignature = resizingSignatureRef.current;

    if (!resizingSignature || resizingSignature.pointerId !== event.pointerId) {
      return;
    }

    flushAnnotationUpdate();
    commitAnnotationDraft();
    resizingSignatureRef.current = null;
    setResizingSignatureId(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function deleteSelectedSignature() {
    if (!selectedSignatureId) {
      return;
    }

    const deletedSignatureId = selectedSignatureId;

    setSignatureAnnotations((currentAnnotations) =>
      currentAnnotations.filter((annotation) => annotation.id !== deletedSignatureId)
    );
    revokeStoredImageAsset(deletedSignatureId);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
  }

  function selectEraseAnnotation(id: string) {
    setSelectedEraseId(id);
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setPendingTextPlacement(null);
    setPendingImagePlacement(null);
    setPendingSignaturePlacement(null);
    setDraftText("");
    setDraftTextStyle(DEFAULT_TEXT_STYLE);
    setImageUploadError("");
    setSignatureUploadError("");
    clearHighlightInteraction();
    clearCommentInteraction();
  }

  function finishEditingSelectedErase() {
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    setDraftEraseRect(null);
    draggingEraseRef.current = null;
    resizingEraseRef.current = null;
    drawingEraseRef.current = null;
  }

  function startMovingErase(event: PointerEvent<HTMLButtonElement>, annotation: EraseAnnotation) {
    const isPlacementOverEraseTool =
      activeTool === "Text" ||
      activeTool === "Image" ||
      activeTool === "Signature" ||
      activeTool === "Highlight" ||
      activeTool === "Comment";

    if (isPlacementOverEraseTool) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectEraseAnnotation(annotation.id);
    setDraggingEraseId(annotation.id);
    setResizingEraseId(null);

    draggingEraseRef.current = {
      id: annotation.id,
      pointerId: event.pointerId,
      offsetX: pagePoint.x - annotation.x,
      offsetY: pagePoint.y - annotation.y,
      width: annotation.width,
      height: annotation.height
    };
  }

  function moveErase(event: PointerEvent<HTMLButtonElement>) {
    const draggingErase = draggingEraseRef.current;

    if (!draggingErase || draggingErase.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    scheduleAnnotationDraft({
      kind: "erase",
      id: draggingErase.id,
      x: clampValue(
        pagePoint.x - draggingErase.offsetX,
        0,
        1 - draggingErase.width
      ),
      y: clampValue(
        pagePoint.y - draggingErase.offsetY,
        0,
        1 - draggingErase.height
      ),
      width: draggingErase.width,
      height: draggingErase.height
    });
  }

  function stopMovingErase(event: PointerEvent<HTMLButtonElement>) {
    const draggingErase = draggingEraseRef.current;

    if (!draggingErase || draggingErase.pointerId !== event.pointerId) {
      return;
    }

    flushAnnotationUpdate();
    commitAnnotationDraft();
    draggingEraseRef.current = null;
    setDraggingEraseId(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function startResizingErase(
    event: PointerEvent<HTMLButtonElement>,
    annotation: EraseAnnotation,
    handle: CornerResizeHandle
  ) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectEraseAnnotation(annotation.id);
    setDraggingEraseId(null);
    setResizingEraseId(annotation.id);

    resizingEraseRef.current = {
      id: annotation.id,
      pointerId: event.pointerId,
      handle,
      startX: annotation.x,
      startY: annotation.y,
      startWidth: annotation.width,
      startHeight: annotation.height
    };
  }

  function resizeErase(event: PointerEvent<HTMLButtonElement>) {
    const resizingErase = resizingEraseRef.current;

    if (!resizingErase || resizingErase.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    const minimumWidth = 0.01;
    const minimumHeight = 0.01;
    const startRightRatio = resizingErase.startX + resizingErase.startWidth;
    const startTopRatio = resizingErase.startY + resizingErase.startHeight;

    let nextX = resizingErase.startX;
    let nextY = resizingErase.startY;
    let nextWidth = resizingErase.startWidth;
    let nextHeight = resizingErase.startHeight;

    if (resizingErase.handle.includes("e")) {
      nextWidth = clampValue(
        pagePoint.x - resizingErase.startX,
        minimumWidth,
        1 - resizingErase.startX
      );
    }

    if (resizingErase.handle.includes("n")) {
      nextHeight = clampValue(
        pagePoint.y - resizingErase.startY,
        minimumHeight,
        1 - resizingErase.startY
      );
    }

    if (resizingErase.handle.includes("w")) {
      nextX = clampValue(pagePoint.x, 0, startRightRatio - minimumWidth);
      nextWidth = startRightRatio - nextX;
    }

    if (resizingErase.handle.includes("s")) {
      nextY = clampValue(pagePoint.y, 0, startTopRatio - minimumHeight);
      nextHeight = startTopRatio - nextY;
    }

    scheduleAnnotationDraft({
      kind: "erase",
      id: resizingErase.id,
      x: nextX,
      y: nextY,
      width: nextWidth,
      height: nextHeight
    });
  }

  function stopResizingErase(event: PointerEvent<HTMLButtonElement>) {
    const resizingErase = resizingEraseRef.current;

    if (!resizingErase || resizingErase.pointerId !== event.pointerId) {
      return;
    }

    flushAnnotationUpdate();
    commitAnnotationDraft();
    resizingEraseRef.current = null;
    setResizingEraseId(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function deleteSelectedErase() {
    if (!selectedEraseId) {
      return;
    }

    setEraseAnnotations((currentAnnotations) =>
      currentAnnotations.filter((annotation) => annotation.id !== selectedEraseId)
    );
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    setDraftEraseRect(null);
    draggingEraseRef.current = null;
    resizingEraseRef.current = null;
    drawingEraseRef.current = null;
  }

  function selectHighlightAnnotation(id: string) {
    setSelectedHighlightId(id);
    setDraggingHighlightId(null);
    setResizingHighlightId(null);
    setDraftHighlightRect(null);
    setSelectedTextId(null);
    setDraggingTextId(null);
    setResizingTextId(null);
    setSelectedImageId(null);
    setDraggingImageId(null);
    setResizingImageId(null);
    setSelectedSignatureId(null);
    setDraggingSignatureId(null);
    setResizingSignatureId(null);
    setSelectedEraseId(null);
    setDraggingEraseId(null);
    setResizingEraseId(null);
    setPendingTextPlacement(null);
    setPendingImagePlacement(null);
    setPendingSignaturePlacement(null);
    setDraftText("");
    setDraftTextStyle(DEFAULT_TEXT_STYLE);
    setImageUploadError("");
    setSignatureUploadError("");
    clearCommentInteraction();
  }

  function finishEditingSelectedHighlight() {
    clearHighlightInteraction();
  }

  function startMovingHighlight(
    event: PointerEvent<HTMLButtonElement>,
    annotation: HighlightAnnotation
  ) {
    const isPlacementOverHighlightTool =
      activeTool === "Text" ||
      activeTool === "Image" ||
      activeTool === "Signature" ||
      activeTool === "Erase" ||
      activeTool === "Comment";

    if (isPlacementOverHighlightTool) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectHighlightAnnotation(annotation.id);
    setDraggingHighlightId(annotation.id);
    setResizingHighlightId(null);

    draggingHighlightRef.current = {
      id: annotation.id,
      pointerId: event.pointerId,
      offsetX: pagePoint.x - annotation.x,
      offsetY: pagePoint.y - annotation.y,
      width: annotation.width,
      height: annotation.height
    };
  }

  function moveHighlight(event: PointerEvent<HTMLButtonElement>) {
    const draggingHighlight = draggingHighlightRef.current;

    if (!draggingHighlight || draggingHighlight.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    scheduleAnnotationDraft({
      kind: "highlight",
      id: draggingHighlight.id,
      x: clampValue(
        pagePoint.x - draggingHighlight.offsetX,
        0,
        1 - draggingHighlight.width
      ),
      y: clampValue(
        pagePoint.y - draggingHighlight.offsetY,
        0,
        1 - draggingHighlight.height
      ),
      width: draggingHighlight.width,
      height: draggingHighlight.height
    });
  }

  function stopMovingHighlight(event: PointerEvent<HTMLButtonElement>) {
    const draggingHighlight = draggingHighlightRef.current;

    if (!draggingHighlight || draggingHighlight.pointerId !== event.pointerId) {
      return;
    }

    flushAnnotationUpdate();
    commitAnnotationDraft();
    draggingHighlightRef.current = null;
    setDraggingHighlightId(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function startResizingHighlight(
    event: PointerEvent<HTMLButtonElement>,
    annotation: HighlightAnnotation,
    handle: CornerResizeHandle
  ) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectHighlightAnnotation(annotation.id);
    setDraggingHighlightId(null);
    setResizingHighlightId(annotation.id);

    resizingHighlightRef.current = {
      id: annotation.id,
      pointerId: event.pointerId,
      handle,
      startX: annotation.x,
      startY: annotation.y,
      startWidth: annotation.width,
      startHeight: annotation.height
    };
  }

  function resizeHighlight(event: PointerEvent<HTMLButtonElement>) {
    const resizingHighlight = resizingHighlightRef.current;

    if (!resizingHighlight || resizingHighlight.pointerId !== event.pointerId) {
      return;
    }

    const pagePoint = screenToNormalizedPagePoint(event.clientX, event.clientY);

    if (!pagePoint) {
      return;
    }

    const minimumWidth = 0.01;
    const minimumHeight = 0.01;
    const startRightRatio = resizingHighlight.startX + resizingHighlight.startWidth;
    const startTopRatio = resizingHighlight.startY + resizingHighlight.startHeight;

    let nextX = resizingHighlight.startX;
    let nextY = resizingHighlight.startY;
    let nextWidth = resizingHighlight.startWidth;
    let nextHeight = resizingHighlight.startHeight;

    if (resizingHighlight.handle.includes("e")) {
      nextWidth = clampValue(
        pagePoint.x - resizingHighlight.startX,
        minimumWidth,
        1 - resizingHighlight.startX
      );
    }

    if (resizingHighlight.handle.includes("n")) {
      nextHeight = clampValue(
        pagePoint.y - resizingHighlight.startY,
        minimumHeight,
        1 - resizingHighlight.startY
      );
    }

    if (resizingHighlight.handle.includes("w")) {
      nextX = clampValue(pagePoint.x, 0, startRightRatio - minimumWidth);
      nextWidth = startRightRatio - nextX;
    }

    if (resizingHighlight.handle.includes("s")) {
      nextY = clampValue(pagePoint.y, 0, startTopRatio - minimumHeight);
      nextHeight = startTopRatio - nextY;
    }

    scheduleAnnotationDraft({
      kind: "highlight",
      id: resizingHighlight.id,
      x: nextX,
      y: nextY,
      width: nextWidth,
      height: nextHeight
    });
  }

  function stopResizingHighlight(event: PointerEvent<HTMLButtonElement>) {
    const resizingHighlight = resizingHighlightRef.current;

    if (!resizingHighlight || resizingHighlight.pointerId !== event.pointerId) {
      return;
    }

    flushAnnotationUpdate();
    commitAnnotationDraft();
    resizingHighlightRef.current = null;
    setResizingHighlightId(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function updateSelectedHighlightColor(colorName: HighlightColorName) {
    if (!selectedHighlightId) {
      return;
    }

    setHighlightAnnotations((currentAnnotations) =>
      currentAnnotations.map((annotation) =>
        annotation.id === selectedHighlightId ? { ...annotation, colorName } : annotation
      )
    );
  }

  function deleteSelectedHighlight() {
    if (!selectedHighlightId) {
      return;
    }

    setHighlightAnnotations((currentAnnotations) =>
      currentAnnotations.filter((annotation) => annotation.id !== selectedHighlightId)
    );
    clearHighlightInteraction();
  }

  async function summarizePdfWithAi() {
    setAiResponseView("summary");

    if (!pdf) {
      setAiError("Upload a PDF before asking AI to summarize it.");
      setIsAiPanelOpen(true);
      return;
    }

    if (aiUsage?.isLimited) {
      setAiError(aiUsage.message ?? AI_LIMIT_REACHED_FALLBACK_MESSAGE);
      setIsAiPanelOpen(true);
      void refreshAiUsage();
      return;
    }

    if (
      isSummarizingPdf ||
      isExplainingPage ||
      isExtractingKeyInfo ||
      isFindingSuggestedEdits ||
      isAskingAiQuestion
    ) {
      return;
    }

    setIsAiPanelOpen(true);
    setIsSummarizingPdf(true);
    setAiError("");
    setAiSummary("");
    setAiPageExplanation("");
    setAiPageExplanationPageNumber(null);
    setAiKeyInfo("");
    setAiSuggestedEdits("");
    setAiCustomAnswer("");
    setDidCopyAiSummary(false);
    setDidCopyAiPageExplanation(false);
    setDidCopyAiKeyInfo(false);
    setDidCopyAiSuggestedEdits(false);
    setDidCopyAiCustomAnswer(false);

    let timeoutId: number | null = null;

    try {
      const pdfBuffer = new ArrayBuffer(pdf.data.byteLength);
      new Uint8Array(pdfBuffer).set(pdf.data);

      const formData = new FormData();
      formData.append("pdf", new Blob([pdfBuffer], { type: "application/pdf" }), pdf.name);

      const controller = new AbortController();
      timeoutId = window.setTimeout(() => controller.abort(), AI_SUMMARY_TIMEOUT_MS);

      const response = await fetch("/api/ai/summarize", {
        method: "POST",
        body: formData,
        signal: controller.signal
      });
      const contentType = response.headers.get("content-type") ?? "";
      const result = contentType.includes("application/json")
        ? ((await response.json()) as {
            summary?: string;
            error?: string;
            aiUsage?: AiUsageInfo;
          })
        : {
            error: await response.text()
          };
      updateAiUsage(result.aiUsage);

      if (!response.ok) {
        throw new Error(result.error ?? "NordEditor AI could not summarize this PDF.");
      }

      setAiSummary(result.summary?.trim() || "NordEditor AI did not return a summary.");
    } catch (summaryError) {
      if (summaryError instanceof DOMException && summaryError.name === "AbortError") {
        setAiError(
          "NordEditor AI took too long to summarize this PDF. Please try again with a shorter PDF."
        );
        return;
      }

      setAiError(
        summaryError instanceof Error
          ? summaryError.message
          : "NordEditor AI could not summarize this PDF. Please try again."
      );
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

      setIsSummarizingPdf(false);
      void refreshAiUsage();
    }
  }

  async function extractCurrentPageTextForAi(pageNumberToExplain: number) {
    if (!pdfDocument) {
      throw new Error("The current PDF page is still loading. Please try again in a moment.");
    }

    const page = await pdfDocument.getPage(pageNumberToExplain);
    const textContent = await page.getTextContent();
    const readableItems = textContent.items
      .map((item) => {
        const maybeTextItem = item as { str?: unknown; transform?: unknown };
        const text = typeof maybeTextItem.str === "string" ? maybeTextItem.str.trim() : "";
        const transform = Array.isArray(maybeTextItem.transform) ? maybeTextItem.transform : [];
        const yPosition = typeof transform[5] === "number" ? transform[5] : null;

        return { text, yPosition };
      })
      .filter((item) => item.text.length > 0);

    let previousYPosition: number | null = null;
    const pageTextParts: string[] = [];

    readableItems.forEach((item) => {
      const isNewLine =
        previousYPosition !== null &&
        item.yPosition !== null &&
        Math.abs(item.yPosition - previousYPosition) > 5;

      if (isNewLine) {
        pageTextParts.push("\n");
      } else if (pageTextParts.length > 0 && pageTextParts[pageTextParts.length - 1] !== "\n") {
        pageTextParts.push(" ");
      }

      pageTextParts.push(item.text);
      previousYPosition = item.yPosition;
    });

    return pageTextParts
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async function explainCurrentPageWithAi() {
    setAiResponseView("pageExplanation");

    if (!pdf) {
      setAiError("Upload a PDF before asking AI to explain the current page.");
      setIsAiPanelOpen(true);
      return;
    }

    if (aiUsage?.isLimited) {
      setAiError(aiUsage.message ?? AI_LIMIT_REACHED_FALLBACK_MESSAGE);
      setIsAiPanelOpen(true);
      void refreshAiUsage();
      return;
    }

    if (
      isSummarizingPdf ||
      isExplainingPage ||
      isExtractingKeyInfo ||
      isFindingSuggestedEdits ||
      isAskingAiQuestion
    ) {
      return;
    }

    setIsAiPanelOpen(true);
    setIsExplainingPage(true);
    setAiError("");
    setAiSummary("");
    setAiPageExplanation("");
    setAiPageExplanationPageNumber(currentPage);
    setAiKeyInfo("");
    setAiSuggestedEdits("");
    setAiCustomAnswer("");
    setDidCopyAiSummary(false);
    setDidCopyAiPageExplanation(false);
    setDidCopyAiKeyInfo(false);
    setDidCopyAiSuggestedEdits(false);
    setDidCopyAiCustomAnswer(false);

    let timeoutId: number | null = null;

    try {
      const pageNumberToExplain = currentPage;
      const pageText = await extractCurrentPageTextForAi(pageNumberToExplain);

      if (!pageText) {
        throw new Error(
          "This page does not have readable text for AI to explain. Try a text-based PDF page."
        );
      }

      const formData = new FormData();
      formData.append("pageNumber", String(pageNumberToExplain));
      formData.append("pdfName", pdf.name);
      formData.append("pageText", pageText);

      const controller = new AbortController();
      timeoutId = window.setTimeout(() => controller.abort(), AI_PAGE_EXPLANATION_TIMEOUT_MS);

      const response = await fetch("/api/ai/explain-page", {
        method: "POST",
        body: formData,
        signal: controller.signal
      });
      const contentType = response.headers.get("content-type") ?? "";
      const result = contentType.includes("application/json")
        ? ((await response.json()) as {
            explanation?: string;
            error?: string;
            aiUsage?: AiUsageInfo;
          })
        : {
            error: await response.text()
          };
      updateAiUsage(result.aiUsage);

      if (!response.ok) {
        throw new Error(result.error ?? "NordEditor AI could not explain this page.");
      }

      setAiPageExplanation(
        result.explanation?.trim() || "NordEditor AI did not return a page explanation."
      );
      setAiPageExplanationPageNumber(pageNumberToExplain);
    } catch (explanationError) {
      if (explanationError instanceof DOMException && explanationError.name === "AbortError") {
        setAiError("NordEditor AI took too long to explain this page. Please try again.");
        return;
      }

      setAiError(
        explanationError instanceof Error
          ? explanationError.message
          : "NordEditor AI could not explain this page. Please try again."
      );
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

      setIsExplainingPage(false);
      void refreshAiUsage();
    }
  }

  async function extractKeyInfoWithAi() {
    setAiResponseView("keyInfo");

    if (!pdf) {
      setAiError("Upload a PDF before asking AI to extract key information.");
      setIsAiPanelOpen(true);
      return;
    }

    if (aiUsage?.isLimited) {
      setAiError(aiUsage.message ?? AI_LIMIT_REACHED_FALLBACK_MESSAGE);
      setIsAiPanelOpen(true);
      void refreshAiUsage();
      return;
    }

    if (
      isSummarizingPdf ||
      isExplainingPage ||
      isExtractingKeyInfo ||
      isFindingSuggestedEdits ||
      isAskingAiQuestion
    ) {
      return;
    }

    setIsAiPanelOpen(true);
    setIsExtractingKeyInfo(true);
    setAiError("");
    setAiSummary("");
    setAiPageExplanation("");
    setAiPageExplanationPageNumber(null);
    setAiKeyInfo("");
    setAiSuggestedEdits("");
    setAiCustomAnswer("");
    setDidCopyAiSummary(false);
    setDidCopyAiPageExplanation(false);
    setDidCopyAiKeyInfo(false);
    setDidCopyAiSuggestedEdits(false);
    setDidCopyAiCustomAnswer(false);

    let timeoutId: number | null = null;

    try {
      const pdfBuffer = new ArrayBuffer(pdf.data.byteLength);
      new Uint8Array(pdfBuffer).set(pdf.data);

      const formData = new FormData();
      formData.append("pdf", new Blob([pdfBuffer], { type: "application/pdf" }), pdf.name);

      const controller = new AbortController();
      timeoutId = window.setTimeout(() => controller.abort(), AI_KEY_INFO_TIMEOUT_MS);

      const response = await fetch("/api/ai/extract-key-info", {
        method: "POST",
        body: formData,
        signal: controller.signal
      });
      const contentType = response.headers.get("content-type") ?? "";
      const result = contentType.includes("application/json")
        ? ((await response.json()) as {
            keyInfo?: string;
            error?: string;
            aiUsage?: AiUsageInfo;
          })
        : {
            error: await response.text()
          };
      updateAiUsage(result.aiUsage);

      if (!response.ok) {
        throw new Error(result.error ?? "NordEditor AI could not extract key information.");
      }

      setAiKeyInfo(result.keyInfo?.trim() || "NordEditor AI did not return key information.");
    } catch (keyInfoError) {
      if (keyInfoError instanceof DOMException && keyInfoError.name === "AbortError") {
        setAiError("NordEditor AI took too long to extract key information. Please try again.");
        return;
      }

      setAiError(
        keyInfoError instanceof Error
          ? keyInfoError.message
          : "NordEditor AI could not extract key information. Please try again."
      );
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

      setIsExtractingKeyInfo(false);
      void refreshAiUsage();
    }
  }

  async function suggestEditsWithAi() {
    setAiResponseView("suggestedEdits");

    if (!pdf) {
      setAiError("Upload a PDF before asking AI to suggest edits.");
      setIsAiPanelOpen(true);
      return;
    }

    if (aiUsage?.isLimited) {
      setAiError(aiUsage.message ?? AI_LIMIT_REACHED_FALLBACK_MESSAGE);
      setIsAiPanelOpen(true);
      void refreshAiUsage();
      return;
    }

    if (
      isSummarizingPdf ||
      isExplainingPage ||
      isExtractingKeyInfo ||
      isFindingSuggestedEdits ||
      isAskingAiQuestion
    ) {
      return;
    }

    setIsAiPanelOpen(true);
    setIsFindingSuggestedEdits(true);
    setAiError("");
    setAiSummary("");
    setAiPageExplanation("");
    setAiPageExplanationPageNumber(null);
    setAiKeyInfo("");
    setAiSuggestedEdits("");
    setAiCustomAnswer("");
    setDidCopyAiSummary(false);
    setDidCopyAiPageExplanation(false);
    setDidCopyAiKeyInfo(false);
    setDidCopyAiSuggestedEdits(false);
    setDidCopyAiCustomAnswer(false);

    let timeoutId: number | null = null;

    try {
      const pdfBuffer = new ArrayBuffer(pdf.data.byteLength);
      new Uint8Array(pdfBuffer).set(pdf.data);

      const formData = new FormData();
      formData.append("pdf", new Blob([pdfBuffer], { type: "application/pdf" }), pdf.name);

      const controller = new AbortController();
      timeoutId = window.setTimeout(() => controller.abort(), AI_SUGGESTED_EDITS_TIMEOUT_MS);

      const response = await fetch("/api/ai/suggest-edits", {
        method: "POST",
        body: formData,
        signal: controller.signal
      });
      const contentType = response.headers.get("content-type") ?? "";
      const result = contentType.includes("application/json")
        ? ((await response.json()) as {
            suggestedEdits?: string;
            error?: string;
            aiUsage?: AiUsageInfo;
          })
        : {
            error: await response.text()
          };
      updateAiUsage(result.aiUsage);

      if (!response.ok) {
        throw new Error(result.error ?? "NordEditor AI could not find suggested edits.");
      }

      setAiSuggestedEdits(
        result.suggestedEdits?.trim() || "NordEditor AI did not return suggested edits."
      );
    } catch (suggestedEditsError) {
      if (
        suggestedEditsError instanceof DOMException &&
        suggestedEditsError.name === "AbortError"
      ) {
        setAiError("NordEditor AI took too long to find suggested edits. Please try again.");
        return;
      }

      setAiError(
        suggestedEditsError instanceof Error
          ? suggestedEditsError.message
          : "NordEditor AI could not find suggested edits. Please try again."
      );
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

      setIsFindingSuggestedEdits(false);
      void refreshAiUsage();
    }
  }

  async function askCustomQuestionWithAi() {
    setAiResponseView("customAnswer");

    const question = aiQuestion.trim();

    if (!question) {
      setAiError("Type a question before clicking Send.");
      setIsAiPanelOpen(true);
      return;
    }

    if (!pdf) {
      setAiError("Upload a PDF before asking NordEditor AI a question.");
      setIsAiPanelOpen(true);
      return;
    }

    if (aiUsage?.isLimited) {
      setAiError(aiUsage.message ?? AI_LIMIT_REACHED_FALLBACK_MESSAGE);
      setIsAiPanelOpen(true);
      void refreshAiUsage();
      return;
    }

    if (
      isSummarizingPdf ||
      isExplainingPage ||
      isExtractingKeyInfo ||
      isFindingSuggestedEdits ||
      isAskingAiQuestion
    ) {
      return;
    }

    setIsAiPanelOpen(true);
    setIsAskingAiQuestion(true);
    setAiError("");
    setAiSummary("");
    setAiPageExplanation("");
    setAiPageExplanationPageNumber(null);
    setAiKeyInfo("");
    setAiSuggestedEdits("");
    setAiCustomAnswer("");
    setDidCopyAiSummary(false);
    setDidCopyAiPageExplanation(false);
    setDidCopyAiKeyInfo(false);
    setDidCopyAiSuggestedEdits(false);
    setDidCopyAiCustomAnswer(false);

    let timeoutId: number | null = null;

    try {
      const pdfBuffer = new ArrayBuffer(pdf.data.byteLength);
      new Uint8Array(pdfBuffer).set(pdf.data);

      const formData = new FormData();
      formData.append("pdf", new Blob([pdfBuffer], { type: "application/pdf" }), pdf.name);
      formData.append("question", question);

      const controller = new AbortController();
      timeoutId = window.setTimeout(() => controller.abort(), AI_CUSTOM_QUESTION_TIMEOUT_MS);

      const response = await fetch("/api/ai/ask", {
        method: "POST",
        body: formData,
        signal: controller.signal
      });
      const contentType = response.headers.get("content-type") ?? "";
      const result = contentType.includes("application/json")
        ? ((await response.json()) as {
            answer?: string;
            error?: string;
            aiUsage?: AiUsageInfo;
          })
        : {
            error: await response.text()
          };
      updateAiUsage(result.aiUsage);

      if (!response.ok) {
        throw new Error(result.error ?? "NordEditor AI could not answer this question.");
      }

      setAiCustomAnswer(result.answer?.trim() || "NordEditor AI did not return an answer.");
      setAiQuestion("");
    } catch (questionError) {
      if (questionError instanceof DOMException && questionError.name === "AbortError") {
        setAiError("NordEditor AI took too long to answer. Please try again.");
        return;
      }

      setAiError(
        questionError instanceof Error
          ? questionError.message
          : "NordEditor AI could not answer this question. Please try again."
      );
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

      setIsAskingAiQuestion(false);
      void refreshAiUsage();
    }
  }

  async function copyAiSummary() {
    if (!aiSummary) {
      return;
    }

    try {
      await navigator.clipboard.writeText(aiSummary);
      setDidCopyAiSummary(true);
      window.setTimeout(() => setDidCopyAiSummary(false), 1800);
    } catch {
      setAiError("The summary could not be copied. Please select and copy it manually.");
    }
  }

  async function copyAiPageExplanation() {
    if (!aiPageExplanation) {
      return;
    }

    try {
      await navigator.clipboard.writeText(aiPageExplanation);
      setDidCopyAiPageExplanation(true);
      window.setTimeout(() => setDidCopyAiPageExplanation(false), 1800);
    } catch {
      setAiError("The page explanation could not be copied. Please select and copy it manually.");
    }
  }

  async function copyAiKeyInfo() {
    if (!aiKeyInfo) {
      return;
    }

    try {
      await navigator.clipboard.writeText(aiKeyInfo);
      setDidCopyAiKeyInfo(true);
      window.setTimeout(() => setDidCopyAiKeyInfo(false), 1800);
    } catch {
      setAiError("The key information could not be copied. Please select and copy it manually.");
    }
  }

  async function copyAiSuggestedEdits() {
    if (!aiSuggestedEdits) {
      return;
    }

    try {
      await navigator.clipboard.writeText(aiSuggestedEdits);
      setDidCopyAiSuggestedEdits(true);
      window.setTimeout(() => setDidCopyAiSuggestedEdits(false), 1800);
    } catch {
      setAiError("The suggested edits could not be copied. Please select and copy them manually.");
    }
  }

  async function copyAiCustomAnswer() {
    if (!aiCustomAnswer) {
      return;
    }

    try {
      await navigator.clipboard.writeText(aiCustomAnswer);
      setDidCopyAiCustomAnswer(true);
      window.setTimeout(() => setDidCopyAiCustomAnswer(false), 1800);
    } catch {
      setAiError("The AI answer could not be copied. Please select and copy it manually.");
    }
  }

  async function downloadEditedPdf() {
    if (!pdf) {
      setError("Upload a PDF before downloading an edited copy.");
      return;
    }

    if (isExportingPdf) {
      return;
    }

    setIsExportingPdf(true);
    setError("");

    try {
      const editedPdf = await PDFDocument.load(pdf.data.slice());
      const pages = editedPdf.getPages();
      const fontCache = new Map<string, PDFFont>();
      const imageCache = new Map<string, PDFImage>();

      async function getExportFont(fontFamily: TextFontFamily, isBold: boolean) {
        const fontName = getPdfFontName(fontFamily, isBold);
        const cachedFont = fontCache.get(fontName);

        if (cachedFont) {
          return cachedFont;
        }

        const embeddedFont = await editedPdf.embedFont(fontName);
        fontCache.set(fontName, embeddedFont);

        return embeddedFont;
      }

      async function getExportImage(annotation: ImageAnnotation) {
        const cachedImage = imageCache.get(annotation.id);

        if (cachedImage) {
          return cachedImage;
        }

        const imageAsset = imageAssetsRef.current.get(annotation.id);

        if (!imageAsset) {
          throw new Error("Image data is missing for export.");
        }

        const embeddedImage =
          imageAsset.mimeType === "image/jpeg"
            ? await editedPdf.embedJpg(imageAsset.exportBytes)
            : await editedPdf.embedPng(imageAsset.exportBytes);

        imageCache.set(annotation.id, embeddedImage);

        return embeddedImage;
      }

      async function drawTextAnnotation(
        page: PDFPage,
        annotation: TextAnnotation,
        pageWidth: number,
        pageHeight: number
      ) {
        const font = await getExportFont(annotation.fontFamily, annotation.isBold);
        const fontColor = getPdfColor(getRgbFromHex(annotation.color));
        const fontSize = annotation.fontSize;
        const lineHeight = fontSize * 1.25;
        const textWidth = Math.max(annotation.width * pageWidth, fontSize * 2);
        const point = normalizedToPdfPoint(annotation, pageWidth, pageHeight);
        const x = clampValue(point.x, 0, Math.max(0, pageWidth - textWidth));
        const topY = point.y;
        const baselineOffset = getTextBaselineOffset(font, fontSize, lineHeight);
        const lines = wrapTextForPdf(annotation.text, font, fontSize, textWidth);

        // Each line uses the same top-origin line box math as the editor preview.
        lines.forEach((line, lineIndex) => {
          const y = topY - baselineOffset - lineIndex * lineHeight;

          if (y < -lineHeight || y > pageHeight) {
            return;
          }

          if (!line) {
            return;
          }

          page.drawText(line, {
            x,
            y,
            size: fontSize,
            font,
            color: fontColor
          });
        });
      }

      async function drawImageAnnotation(
        page: PDFPage,
        annotation: ImageAnnotation,
        pageWidth: number,
        pageHeight: number
      ) {
        const image = await getExportImage(annotation);
        const rect = normalizedToPdfRect(annotation, pageWidth, pageHeight);

        page.drawImage(image, rect);
      }

      async function drawCommentAnnotation(
        page: PDFPage,
        annotation: CommentAnnotation,
        pageWidth: number,
        pageHeight: number
      ) {
        const markerFont = await getExportFont("Sans", true);
        const noteFont = await getExportFont("Sans", false);
        const markerRect = normalizedToPdfRect(annotation, pageWidth, pageHeight);
        const markerCenterY = markerRect.y + markerRect.height / 2;
        const markerSize = Math.min(markerRect.width, markerRect.height);
        const markerText = "C";
        const markerTextSize = markerSize * 0.46;
        const markerTextWidth = markerFont.widthOfTextAtSize(markerText, markerTextSize);
        const markerTextHeight = markerFont.heightAtSize(markerTextSize, { descender: false });
        const noteGap = 4;
        const pageMargin = 6;
        const preferredNoteWidth = Math.min(110, Math.max(64, pageWidth * 0.2));
        const noteFontSize = 8;
        const noteLineHeight = 9.5;
        const rightSpace = pageWidth - (markerRect.x + markerRect.width) - noteGap - pageMargin;
        const leftSpace = markerRect.x - noteGap - pageMargin;

        function getCommentNotePlacement(side: "left" | "right") {
          const availableWidth = side === "right" ? rightSpace : leftSpace;

          if (availableWidth < 28) {
            return null;
          }

          const wrapWidth = Math.min(preferredNoteWidth, availableWidth);
          const wrappedCommentLines = wrapTextForPdf(
            annotation.comment,
            noteFont,
            noteFontSize,
            wrapWidth
          );
          const noteLines =
            wrappedCommentLines.length > 2
              ? [...wrappedCommentLines.slice(0, 1), "..."]
              : wrappedCommentLines;
          const lineWidths = noteLines.map((line) => noteFont.widthOfTextAtSize(line, noteFontSize));
          const maxLineWidth = Math.max(0, ...lineWidths);

          if (noteLines.length === 0 || maxLineWidth <= 0 || maxLineWidth > availableWidth) {
            return null;
          }

          return {
            side,
            lines: noteLines,
            lineWidths
          };
        }

        const shouldPlaceNoteOnLeft = rightSpace < Math.min(64, preferredNoteWidth);
        const notePlacement = shouldPlaceNoteOnLeft
          ? getCommentNotePlacement("left") ?? getCommentNotePlacement("right")
          : getCommentNotePlacement("right") ?? getCommentNotePlacement("left");

        page.drawRectangle({
          ...markerRect,
          color: rgb(1, 0.94, 0.43),
          borderColor: rgb(0.42, 0.33, 0),
          borderWidth: 0.7
        });
        page.drawText(markerText, {
          x: markerRect.x + (markerRect.width - markerTextWidth) / 2,
          y: markerRect.y + (markerRect.height - markerTextHeight) / 2 + markerSize * 0.08,
          size: markerTextSize,
          font: markerFont,
          color: rgb(0.32, 0.25, 0)
        });

        // Comments export as subtle visible notes for V1, not real clickable PDF comments yet.
        if (!notePlacement) {
          return;
        }

        const noteHeight = Math.max(1, notePlacement.lines.length) * noteLineHeight;
        const noteY = clampValue(markerCenterY - noteHeight / 2, noteHeight, pageHeight);

        notePlacement.lines.forEach((line, lineIndex) => {
          if (!line) {
            return;
          }

          // Anchor exported note text directly to the saved comment marker rectangle.
          const noteX =
            notePlacement.side === "right"
              ? markerRect.x + markerRect.width + noteGap
              : markerRect.x - noteGap - notePlacement.lineWidths[lineIndex];

          page.drawText(line, {
            x: noteX,
            y: noteY - lineIndex * noteLineHeight,
            size: noteFontSize,
            font: noteFont,
            color: rgb(0.24, 0.24, 0.22),
            opacity: 0.86
          });
        });
      }

      for (const [pageIndex, page] of pages.entries()) {
        const pageNumber = pageIndex + 1;
        const { width: pageWidth, height: pageHeight } = page.getSize();

        highlightAnnotations
          .filter((annotation) => annotation.pageNumber === pageNumber)
          .forEach((annotation) => {
            const rect = normalizedToPdfRect(annotation, pageWidth, pageHeight);
            const highlightColor = HIGHLIGHT_COLOR_VALUES[annotation.colorName];

            // Highlight exports as the exact rectangle the user drew in the editor.
            page.drawRectangle({
              ...rect,
              color: getPdfColor(highlightColor),
              opacity: highlightColor.opacity
            });
          });

        eraseAnnotations
          .filter((annotation) => annotation.pageNumber === pageNumber)
          .forEach((annotation) => {
            const rect = normalizedToPdfRect(annotation, pageWidth, pageHeight);

            // V1 erase is a visible white box only. It is not secure redaction.
            page.drawRectangle({
              ...rect,
              color: rgb(1, 1, 1),
              opacity: 1,
              borderWidth: 0,
              borderOpacity: 0
            });
          });

        for (const annotation of imageAnnotations.filter(
          (currentAnnotation) => currentAnnotation.pageNumber === pageNumber
        )) {
          await drawImageAnnotation(page, annotation, pageWidth, pageHeight);
        }

        for (const annotation of signatureAnnotations.filter(
          (currentAnnotation) => currentAnnotation.pageNumber === pageNumber
        )) {
          await drawImageAnnotation(page, annotation, pageWidth, pageHeight);
        }

        for (const annotation of textAnnotations.filter(
          (currentAnnotation) => currentAnnotation.pageNumber === pageNumber
        )) {
          await drawTextAnnotation(page, annotation, pageWidth, pageHeight);
        }

        for (const annotation of commentAnnotations.filter(
          (currentAnnotation) => currentAnnotation.pageNumber === pageNumber
        )) {
          await drawCommentAnnotation(page, annotation, pageWidth, pageHeight);
        }
      }

      const editedPdfBytes = await editedPdf.save();
      const editedPdfBuffer = new ArrayBuffer(editedPdfBytes.byteLength);

      new Uint8Array(editedPdfBuffer).set(editedPdfBytes);

      const editedPdfBlob = new Blob([editedPdfBuffer], { type: "application/pdf" });

      downloadBlob(editedPdfBlob, getEditedFileName(pdf.name));
    } catch (exportError) {
      console.error(exportError);
      setError("The edited PDF could not be downloaded. Please try again.");
    } finally {
      setIsExportingPdf(false);
    }
  }

  const hasPdf = Boolean(pdf);
  const canUseControls = Boolean(pdfDocument && totalPages > 0);
  const zoomLabel = `${Math.round(renderedZoom * 100)}%`;
  const visibleTextAnnotations = useMemo(
    () => textAnnotations.filter((annotation) => annotation.pageNumber === currentPage),
    [currentPage, textAnnotations]
  );
  const visibleImageAnnotations = useMemo(
    () => imageAnnotations.filter((annotation) => annotation.pageNumber === currentPage),
    [currentPage, imageAnnotations]
  );
  const visibleSignatureAnnotations = useMemo(
    () => signatureAnnotations.filter((annotation) => annotation.pageNumber === currentPage),
    [currentPage, signatureAnnotations]
  );
  const visibleEraseAnnotations = useMemo(
    () => eraseAnnotations.filter((annotation) => annotation.pageNumber === currentPage),
    [currentPage, eraseAnnotations]
  );
  const visibleHighlightAnnotations = useMemo(
    () => highlightAnnotations.filter((annotation) => annotation.pageNumber === currentPage),
    [currentPage, highlightAnnotations]
  );
  const visibleCommentAnnotations = useMemo(
    () => commentAnnotations.filter((annotation) => annotation.pageNumber === currentPage),
    [commentAnnotations, currentPage]
  );
  const textAnnotationDraft = annotationDraft?.kind === "text" ? annotationDraft : null;
  const imageAnnotationDraft = annotationDraft?.kind === "image" ? annotationDraft : null;
  const signatureAnnotationDraft = annotationDraft?.kind === "signature" ? annotationDraft : null;
  const eraseAnnotationDraft = annotationDraft?.kind === "erase" ? annotationDraft : null;
  const highlightAnnotationDraft = annotationDraft?.kind === "highlight" ? annotationDraft : null;
  const commentAnnotationDraft = annotationDraft?.kind === "comment" ? annotationDraft : null;
  const renderedTextAnnotations = useMemo(
    () =>
      visibleTextAnnotations.map((annotation) =>
        textAnnotationDraft?.id === annotation.id
          ? { ...annotation, ...textAnnotationDraft }
          : annotation
      ),
    [textAnnotationDraft, visibleTextAnnotations]
  );
  const renderedImageAnnotations = useMemo(
    () =>
      visibleImageAnnotations.map((annotation) =>
        imageAnnotationDraft?.id === annotation.id
          ? { ...annotation, ...imageAnnotationDraft }
          : annotation
      ),
    [imageAnnotationDraft, visibleImageAnnotations]
  );
  const renderedSignatureAnnotations = useMemo(
    () =>
      visibleSignatureAnnotations.map((annotation) =>
        signatureAnnotationDraft?.id === annotation.id
          ? { ...annotation, ...signatureAnnotationDraft }
          : annotation
      ),
    [signatureAnnotationDraft, visibleSignatureAnnotations]
  );
  const renderedEraseAnnotations = useMemo(
    () =>
      visibleEraseAnnotations.map((annotation) =>
        eraseAnnotationDraft?.id === annotation.id
          ? { ...annotation, ...eraseAnnotationDraft }
          : annotation
      ),
    [eraseAnnotationDraft, visibleEraseAnnotations]
  );
  const renderedHighlightAnnotations = useMemo(
    () =>
      visibleHighlightAnnotations.map((annotation) =>
        highlightAnnotationDraft?.id === annotation.id
          ? { ...annotation, ...highlightAnnotationDraft }
          : annotation
      ),
    [highlightAnnotationDraft, visibleHighlightAnnotations]
  );
  const renderedCommentAnnotations = useMemo(
    () =>
      visibleCommentAnnotations.map((annotation) =>
        commentAnnotationDraft?.id === annotation.id
          ? { ...annotation, ...commentAnnotationDraft }
          : annotation
      ),
    [commentAnnotationDraft, visibleCommentAnnotations]
  );
  const isPlacementToolActive =
    activeTool === "Text" ||
    activeTool === "Image" ||
    activeTool === "Signature" ||
    activeTool === "Erase" ||
    activeTool === "Highlight" ||
    activeTool === "Comment";
  const isShowingPageExplanation = aiResponseView === "pageExplanation";
  const isShowingKeyInfo = aiResponseView === "keyInfo";
  const isShowingSuggestedEdits = aiResponseView === "suggestedEdits";
  const isShowingCustomAnswer = aiResponseView === "customAnswer";
  const isAiBusy =
    isSummarizingPdf ||
    isExplainingPage ||
    isExtractingKeyInfo ||
    isFindingSuggestedEdits ||
    isAskingAiQuestion;
  const isAiLimitReached = aiUsage?.isLimited ?? false;
  const isPrivateAiAccessActive = aiUsage?.role === "admin" || aiUsage?.role === "beta";
  const shouldShowAiAccessInput = canShowAiAccessInput && !isPrivateAiAccessActive;
  const shouldShowAiAccessStatus = isPrivateAiAccessActive;
  const aiRoleLabel = aiUsage?.roleLabel ?? "Public";
  const aiUsageLabel = aiUsage
    ? `${aiRoleLabel} AI actions left today: ${aiUsage.remaining}/${aiUsage.limit}`
    : isLoadingAiUsage
      ? "Checking AI actions left..."
      : "AI actions left today: 5/5";
  const aiLimitMessage = aiUsage?.message ?? AI_LIMIT_REACHED_FALLBACK_MESSAGE;
  const isAiResponseLoading = isShowingCustomAnswer
    ? isAskingAiQuestion
    : isShowingSuggestedEdits
      ? isFindingSuggestedEdits
      : isShowingKeyInfo
        ? isExtractingKeyInfo
        : isShowingPageExplanation
          ? isExplainingPage
          : isSummarizingPdf;
  const aiExplanationPageNumber = aiPageExplanationPageNumber ?? currentPage;
  const activeAiResponseText = isShowingCustomAnswer
    ? aiCustomAnswer
    : isShowingSuggestedEdits
      ? aiSuggestedEdits
      : isShowingKeyInfo
        ? aiKeyInfo
        : isShowingPageExplanation
          ? aiPageExplanation
          : aiSummary;
  const activeAiCopyLabel = isShowingCustomAnswer
    ? didCopyAiCustomAnswer
      ? "Copied"
      : "Copy"
    : isShowingSuggestedEdits
      ? didCopyAiSuggestedEdits
        ? "Copied"
        : "Copy"
      : isShowingKeyInfo
        ? didCopyAiKeyInfo
          ? "Copied"
          : "Copy"
        : isShowingPageExplanation
          ? didCopyAiPageExplanation
            ? "Copied"
            : "Copy"
          : didCopyAiSummary
            ? "Copied"
            : "Copy";
  const activeAiLoadingText = isShowingCustomAnswer
    ? "Thinking..."
    : isShowingSuggestedEdits
      ? "Finding suggested edits..."
      : isShowingKeyInfo
        ? "Extracting key info..."
        : isShowingPageExplanation
          ? "Explaining page..."
          : "Summarizing...";
  const activeAiPlaceholderText = isShowingCustomAnswer
    ? "Ask a question about the uploaded PDF, then click Send."
    : isShowingSuggestedEdits
      ? "Use Suggest edits to review the PDF for practical improvements."
      : isShowingKeyInfo
        ? "Use Extract key info to pull names, dates, numbers, deadlines, and risks."
        : isShowingPageExplanation
          ? "Use Explain current page to understand the current PDF page."
          : "Use Summarize PDF to create a short summary of the uploaded file.";
  const activeAiCardTitle = isShowingCustomAnswer
    ? "AI Answer"
    : isShowingSuggestedEdits
      ? "Suggested Edits"
      : isShowingKeyInfo
        ? "Key Information"
        : isShowingPageExplanation
          ? `Page ${aiExplanationPageNumber} Explanation`
          : "Summary";
  const activeAiCopyHandler = isShowingCustomAnswer
    ? copyAiCustomAnswer
    : isShowingSuggestedEdits
      ? copyAiSuggestedEdits
      : isShowingKeyInfo
        ? copyAiKeyInfo
        : isShowingPageExplanation
          ? copyAiPageExplanation
          : copyAiSummary;
  const activeAiPanelNote = isAiLimitReached
    ? aiLimitMessage
    : "Suggestions are not applied automatically.";

  return (
    <section
      className={hasPdf ? "workspace workspace-active" : "workspace"}
      aria-label="PDF preview workspace"
    >
      <div className="workspace-toolbar">
        <div className="file-summary">
          <p className="workspace-label">Current file</p>
          <h2>{pdf ? pdf.name : "No PDF selected"}</h2>
          <p className="workspace-meta">
            {pdf ? formatFileSize(pdf.size) : "Choose a local PDF to preview."}
          </p>
        </div>

        {hasPdf ? (
          <div className="pdf-controls" aria-label="PDF controls">
            <button
              className="control-button"
              type="button"
              onClick={goToPreviousPage}
              disabled={!canUseControls || currentPage <= 1}
              aria-label="Previous page"
            >
              &lt;
            </button>
            <button
              className="control-button"
              type="button"
              onClick={goToNextPage}
              disabled={!canUseControls || currentPage >= totalPages}
              aria-label="Next page"
            >
              &gt;
            </button>
            <span className="page-counter" aria-label="Current page">
              {canUseControls ? `${currentPage} / ${totalPages}` : "- / -"}
            </span>
            <button
              className="control-button"
              type="button"
              onClick={zoomOut}
              disabled={!canUseControls || renderedZoom <= MIN_ZOOM}
              aria-label="Zoom out"
            >
              -
            </button>
            <span className="zoom-counter">{zoomLabel}</span>
            <button
              className="control-button"
              type="button"
              onClick={zoomIn}
              disabled={!canUseControls || renderedZoom >= MAX_ZOOM}
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              className="control-button control-button-wide"
              type="button"
              onClick={fitWidth}
              disabled={!canUseControls || isFitWidth}
            >
              Fit width
            </button>
          </div>
        ) : null}

        <div className="toolbar-actions">
          <input
            ref={fileInputRef}
            className="file-input"
            id="pdf-upload"
            type="file"
            accept="application/pdf"
            onChange={handleUpload}
          />
          {/* The label opens the hidden file input, so the button can be styled. */}
          <label className="button button-primary" htmlFor="pdf-upload">
            Upload PDF
          </label>
          <button
            className="button button-secondary"
            type="button"
            onClick={handleClearPdf}
            disabled={!pdf}
          >
            Clear PDF
          </button>
        </div>
      </div>

      <p className="privacy-note">
        Files are processed temporarily in your browser/session. AI features may send document
        content for processing.
      </p>

      {hasPdf ? (
        <div className="editing-toolbar" aria-label="Manual editing tools">
          {EDITING_TOOLS.map((tool) => (
            <button
              className={tool === activeTool ? "tool-button tool-button-active" : "tool-button"}
              type="button"
              key={tool}
              aria-pressed={tool === activeTool}
              disabled={tool === "Download" && isExportingPdf}
              onClick={() => selectTool(tool)}
            >
              {tool === "Download" && isExportingPdf ? "Exporting..." : tool}
            </button>
          ))}
          {activeTool === "Text" ? (
            <p className="tool-instruction">Click on the PDF where you want to add text</p>
          ) : null}
          {activeTool === "Image" ? (
            <p className="tool-instruction">Click on the PDF where you want to add an image</p>
          ) : null}
          {activeTool === "Signature" ? (
            <p className="tool-instruction">Click on the PDF where you want to place a signature</p>
          ) : null}
          {activeTool === "Erase" ? (
            <p className="tool-instruction">Drag over the area you want to erase</p>
          ) : null}
          {activeTool === "Highlight" ? (
            <p className="tool-instruction">Drag over the area you want to highlight</p>
          ) : null}
          {activeTool === "Comment" ? (
            <p className="tool-instruction">Click on the PDF where you want to add a comment</p>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="error-message">{error}</p> : null}

      {hasPdf ? (
        <>
          <button
            className="ai-panel-toggle"
            type="button"
            aria-expanded={isAiPanelOpen}
            aria-controls="nordeditor-ai-panel"
            onClick={() => {
              if (isAiPanelOpen) {
                setIsAiPanelFocused(false);
              } else {
                void refreshAiUsage();
              }

              setIsAiPanelOpen(!isAiPanelOpen);
            }}
          >
            AI Assistant
          </button>

          {isAiPanelOpen ? (
            <aside
              className={isAiPanelFocused ? "ai-panel ai-panel-focus" : "ai-panel"}
              id="nordeditor-ai-panel"
              aria-label="NordEditor AI assistant"
              aria-busy={isAiBusy}
            >
              <div className="ai-panel-header">
                <h2>Ask NordEditor AI</h2>
                <div className="ai-panel-header-actions">
                  <button
                    className="ai-panel-focus-button"
                    type="button"
                    aria-pressed={isAiPanelFocused}
                    onClick={() => setIsAiPanelFocused((isFocused) => !isFocused)}
                  >
                    {isAiPanelFocused ? "Collapse" : "Focus Mode"}
                  </button>
                  <button
                    className="ai-panel-close"
                    type="button"
                    aria-label="Close AI assistant"
                    onClick={() => {
                      setIsAiPanelOpen(false);
                      setIsAiPanelFocused(false);
                    }}
                  >
                    x
                  </button>
                </div>
              </div>

              <textarea
                className="ai-panel-input"
                placeholder="Ask about this PDF or request an edit..."
                rows={5}
                value={aiQuestion}
                onChange={(event) => setAiQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void askCustomQuestionWithAi();
                  }
                }}
              />

              <div
                className={
                  isAiLimitReached
                    ? "ai-usage-status ai-usage-status-limited"
                    : "ai-usage-status"
                }
              >
                <span>{aiUsageLabel}</span>
                {isAiLimitReached ? <span>{aiLimitMessage}</span> : null}
              </div>

              {shouldShowAiAccessStatus ? (
                <div className="ai-access-status">
                  <span>Owner/testing mode active</span>
                  <button
                    className="ai-access-exit"
                    type="button"
                    onClick={clearAiAccessCode}
                    disabled={isApplyingAiAccess}
                  >
                    Exit
                  </button>
                </div>
              ) : null}

              {shouldShowAiAccessInput ? (
                <div className="ai-access-card">
                  <div className="ai-access-copy">
                    <strong>Have beta access?</strong>
                    <span>Enter your private testing code.</span>
                  </div>
                  <div className="ai-access-controls">
                    <input
                      className="ai-access-input"
                      type="password"
                      placeholder="Access code"
                      value={aiAccessCode}
                      onChange={(event) => setAiAccessCode(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void applyAiAccessCode();
                        }
                      }}
                    />
                    <button
                      className="ai-access-button"
                      type="button"
                      onClick={applyAiAccessCode}
                      disabled={isApplyingAiAccess}
                    >
                      {isApplyingAiAccess ? "Checking..." : "Apply"}
                    </button>
                  </div>
                  {aiAccessMessage ? <p>{aiAccessMessage}</p> : null}
                </div>
              ) : null}

              <div className="ai-quick-actions" aria-label="AI example prompts">
                <button
                  type="button"
                  onClick={summarizePdfWithAi}
                  disabled={isAiBusy || isAiLimitReached}
                >
                  {isSummarizingPdf ? "Summarizing..." : "Summarize PDF"}
                </button>
                <button
                  type="button"
                  onClick={explainCurrentPageWithAi}
                  disabled={isAiBusy || isAiLimitReached}
                >
                  {isExplainingPage ? "Explaining page..." : "Explain current page"}
                </button>
                <button
                  type="button"
                  onClick={extractKeyInfoWithAi}
                  disabled={isAiBusy || isAiLimitReached}
                >
                  {isExtractingKeyInfo ? "Extracting key info..." : "Extract key info"}
                </button>
                <button
                  type="button"
                  onClick={suggestEditsWithAi}
                  disabled={isAiBusy || isAiLimitReached}
                >
                  {isFindingSuggestedEdits ? "Finding suggested edits..." : "Suggest edits"}
                </button>
              </div>

              <div className="ai-response-card" aria-live="polite">
                <div className="ai-response-header">
                  <h3>{activeAiCardTitle}</h3>
                  {activeAiResponseText ? (
                    <button
                      className="ai-copy-button"
                      type="button"
                      onClick={activeAiCopyHandler}
                    >
                      {activeAiCopyLabel}
                    </button>
                  ) : null}
                </div>
                <div className="ai-response-scroll">
                  {isAiResponseLoading ? (
                    <p>{activeAiLoadingText}</p>
                  ) : aiError ? (
                    <p className="ai-response-error">{aiError}</p>
                  ) : activeAiResponseText ? (
                    <div className="ai-response-markdown">
                      {renderAiMarkdown(activeAiResponseText)}
                    </div>
                  ) : (
                    <p>{activeAiPlaceholderText}</p>
                  )}
                </div>
              </div>

              <div className="ai-panel-footer">
                <button
                  className="ai-send-button"
                  type="button"
                  onClick={askCustomQuestionWithAi}
                  disabled={isAiBusy || isAiLimitReached}
                >
                  {isAskingAiQuestion ? "Thinking..." : "Send"}
                </button>

                <p className="ai-panel-note">{activeAiPanelNote}</p>
              </div>
            </aside>
          ) : null}
        </>
      ) : null}

      <div className="viewer-panel">
        {pdf ? (
          <div className="pdf-viewer" ref={viewerStageRef}>
            {isLoadingPdf ? <p className="viewer-status">Loading PDF...</p> : null}
            {isRenderingPage ? <p className="viewer-status">Rendering page...</p> : null}
            <div
              className={
                isPlacementToolActive ? "pdf-page-shell pdf-page-shell-placement" : "pdf-page-shell"
              }
              ref={pageShellRef}
              onPointerDown={handlePdfPageClick}
              onPointerMove={(event) => {
                updateEraseDrawing(event);
                updateHighlightDrawing(event);
              }}
              onPointerUp={(event) => {
                finishEraseDrawing(event);
                finishHighlightDrawing(event);
              }}
              onPointerCancel={(event) => {
                cancelEraseDrawing(event);
                cancelHighlightDrawing(event);
              }}
            >
              <canvas className="pdf-canvas" ref={canvasRef} aria-label={`${pdf.name} page preview`} />
              <div className="annotation-layer" aria-label="Added PDF annotations">
                {renderedImageAnnotations.map((annotation) => (
                  <div
                    className={
                      [
                        "image-annotation",
                        annotation.id === selectedImageId ? "image-annotation-selected" : "",
                        annotation.id === draggingImageId ? "image-annotation-moving" : "",
                        annotation.id === resizingImageId ? "image-annotation-resizing" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")
                    }
                    data-image-annotation="true"
                    key={annotation.id}
                    style={normalizedToScreenRect(annotation)}
                  >
                    <button
                      className="added-image-frame"
                      type="button"
                      onClick={() => selectImageAnnotation(annotation.id)}
                      onPointerDown={(event) => startMovingImage(event, annotation)}
                      onPointerMove={moveImage}
                      onPointerUp={stopMovingImage}
                      onPointerCancel={stopMovingImage}
                      onLostPointerCapture={stopMovingImage}
                      title="Drag to move image"
                    >
                      <AnnotationImage
                        objectUrl={annotation.objectUrl}
                        alt={`${annotation.name} annotation`}
                      />
                    </button>
                    {annotation.id === selectedImageId &&
                    !pendingImagePlacement &&
                    !pendingSignaturePlacement &&
                    !pendingCommentPlacement &&
                    !draftEraseRect &&
                    !draftHighlightRect ? (
                      <>
                        {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                          <button
                            aria-label={`Resize image from ${handle}`}
                            className={`image-resize-handle image-resize-handle-${handle}`}
                            key={handle}
                            type="button"
                            onPointerDown={(event) => startResizingImage(event, annotation, handle)}
                            onPointerMove={resizeImage}
                            onPointerUp={stopResizingImage}
                            onPointerCancel={stopResizingImage}
                            onLostPointerCapture={stopResizingImage}
                          />
                        ))}
                        <div className="image-mini-toolbar" aria-label="Selected image controls">
                          <button
                            className="done-text-button"
                            type="button"
                            onClick={finishEditingSelectedImage}
                          >
                            Done
                          </button>
                          <button
                            className="delete-text-button"
                            type="button"
                            onClick={deleteSelectedImage}
                            aria-label="Delete selected image"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                ))}

                {renderedSignatureAnnotations.map((annotation) => (
                  <div
                    className={
                      [
                        "signature-annotation",
                        annotation.id === selectedSignatureId ? "signature-annotation-selected" : "",
                        annotation.id === draggingSignatureId ? "signature-annotation-moving" : "",
                        annotation.id === resizingSignatureId ? "signature-annotation-resizing" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")
                    }
                    data-signature-annotation="true"
                    key={annotation.id}
                    style={normalizedToScreenRect(annotation)}
                  >
                    <button
                      className="added-image-frame"
                      type="button"
                      onClick={() => selectSignatureAnnotation(annotation.id)}
                      onPointerDown={(event) => startMovingSignature(event, annotation)}
                      onPointerMove={moveSignature}
                      onPointerUp={stopMovingSignature}
                      onPointerCancel={stopMovingSignature}
                      onLostPointerCapture={stopMovingSignature}
                      title="Drag to move signature"
                    >
                      <AnnotationImage
                        objectUrl={annotation.objectUrl}
                        alt={`${annotation.name} signature`}
                      />
                    </button>
                    {annotation.id === selectedSignatureId &&
                    !pendingSignaturePlacement &&
                    !pendingCommentPlacement &&
                    !draftEraseRect &&
                    !draftHighlightRect ? (
                      <>
                        {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                          <button
                            aria-label={`Resize signature from ${handle}`}
                            className={`image-resize-handle image-resize-handle-${handle}`}
                            key={handle}
                            type="button"
                            onPointerDown={(event) =>
                              startResizingSignature(event, annotation, handle)
                            }
                            onPointerMove={resizeSignature}
                            onPointerUp={stopResizingSignature}
                            onPointerCancel={stopResizingSignature}
                            onLostPointerCapture={stopResizingSignature}
                          />
                        ))}
                        <div className="signature-mini-toolbar" aria-label="Selected signature controls">
                          <button
                            className="done-text-button"
                            type="button"
                            onClick={finishEditingSelectedSignature}
                          >
                            Done
                          </button>
                          <button
                            className="delete-text-button"
                            type="button"
                            onClick={deleteSelectedSignature}
                            aria-label="Delete selected signature"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                ))}

                {renderedEraseAnnotations.map((annotation) => (
                  <div
                    className={
                      [
                        "erase-annotation",
                        annotation.id === selectedEraseId ? "erase-annotation-selected" : "",
                        annotation.id === draggingEraseId ? "erase-annotation-moving" : "",
                        annotation.id === resizingEraseId ? "erase-annotation-resizing" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")
                    }
                    data-erase-annotation="true"
                    key={annotation.id}
                    style={normalizedToScreenRect(annotation)}
                  >
                    <button
                      className="erase-rectangle"
                      type="button"
                      onClick={() => {
                        if (
                          activeTool === "Text" ||
                          activeTool === "Image" ||
                          activeTool === "Signature" ||
                          activeTool === "Highlight" ||
                          activeTool === "Comment"
                        ) {
                          return;
                        }

                        selectEraseAnnotation(annotation.id);
                      }}
                      onPointerDown={(event) => startMovingErase(event, annotation)}
                      onPointerMove={moveErase}
                      onPointerUp={stopMovingErase}
                      onPointerCancel={stopMovingErase}
                      onLostPointerCapture={stopMovingErase}
                      title="Drag to move erase area"
                    />
                    {annotation.id === selectedEraseId &&
                    !pendingCommentPlacement &&
                    !draftEraseRect &&
                    !draftHighlightRect ? (
                      <>
                        {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                          <button
                            aria-label={`Resize erase area from ${handle}`}
                            className={`image-resize-handle image-resize-handle-${handle}`}
                            key={handle}
                            type="button"
                            onPointerDown={(event) => startResizingErase(event, annotation, handle)}
                            onPointerMove={resizeErase}
                            onPointerUp={stopResizingErase}
                            onPointerCancel={stopResizingErase}
                            onLostPointerCapture={stopResizingErase}
                          />
                        ))}
                        <div className="erase-mini-toolbar" aria-label="Selected erase controls">
                          <button
                            className="done-text-button"
                            type="button"
                            onClick={finishEditingSelectedErase}
                          >
                            Done
                          </button>
                          <button
                            className="delete-text-button"
                            type="button"
                            onClick={deleteSelectedErase}
                            aria-label="Undo selected erase area"
                          >
                            Undo Erase
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                ))}

                {draftEraseRect?.pageNumber === currentPage ? (
                  <div
                    className="erase-annotation erase-annotation-draft"
                    style={normalizedToScreenRect(draftEraseRect)}
                  />
                ) : null}

                {renderedHighlightAnnotations.map((annotation) => (
                  <div
                    className={
                      [
                        "highlight-annotation",
                        annotation.id === selectedHighlightId
                          ? "highlight-annotation-selected"
                          : "",
                        annotation.id === draggingHighlightId
                          ? "highlight-annotation-moving"
                          : "",
                        annotation.id === resizingHighlightId
                          ? "highlight-annotation-resizing"
                          : ""
                      ]
                        .filter(Boolean)
                        .join(" ")
                    }
                    data-highlight-annotation="true"
                    key={annotation.id}
                    style={normalizedToScreenRect(annotation)}
                  >
                    <button
                      className="highlight-rectangle"
                      type="button"
                      style={getHighlightFillStyle(annotation.colorName)}
                      onClick={() => {
                        if (
                          activeTool === "Text" ||
                          activeTool === "Image" ||
                          activeTool === "Signature" ||
                          activeTool === "Erase" ||
                          activeTool === "Comment"
                        ) {
                          return;
                        }

                        selectHighlightAnnotation(annotation.id);
                      }}
                      onPointerDown={(event) => startMovingHighlight(event, annotation)}
                      onPointerMove={moveHighlight}
                      onPointerUp={stopMovingHighlight}
                      onPointerCancel={stopMovingHighlight}
                      onLostPointerCapture={stopMovingHighlight}
                      title="Drag to move highlight"
                    />
                    {annotation.id === selectedHighlightId &&
                    !pendingTextPlacement &&
                    !pendingImagePlacement &&
                    !pendingSignaturePlacement &&
                    !pendingCommentPlacement &&
                    !draftEraseRect &&
                    !draftHighlightRect ? (
                      <>
                        {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                          <button
                            aria-label={`Resize highlight from ${handle}`}
                            className={`image-resize-handle image-resize-handle-${handle}`}
                            key={handle}
                            type="button"
                            onPointerDown={(event) =>
                              startResizingHighlight(event, annotation, handle)
                            }
                            onPointerMove={resizeHighlight}
                            onPointerUp={stopResizingHighlight}
                            onPointerCancel={stopResizingHighlight}
                            onLostPointerCapture={stopResizingHighlight}
                          />
                        ))}
                        <div className="highlight-mini-toolbar" aria-label="Selected highlight controls">
                          <button
                            className="done-text-button"
                            type="button"
                            onClick={finishEditingSelectedHighlight}
                          >
                            Done
                          </button>
                          <button
                            className="delete-text-button"
                            type="button"
                            onClick={deleteSelectedHighlight}
                            aria-label="Delete selected highlight"
                          >
                            Delete
                          </button>
                          <div className="highlight-color-options" aria-label="Highlight colors">
                            {(Object.keys(HIGHLIGHT_COLORS) as HighlightColorName[]).map(
                              (colorName) => (
                                <button
                                  aria-label={`${colorName} highlight`}
                                  aria-pressed={annotation.colorName === colorName}
                                  className={
                                    annotation.colorName === colorName
                                      ? "highlight-color-button highlight-color-button-active"
                                      : "highlight-color-button"
                                  }
                                  key={colorName}
                                  type="button"
                                  onClick={() => updateSelectedHighlightColor(colorName)}
                                  style={{ background: HIGHLIGHT_COLORS[colorName] }}
                                />
                              )
                            )}
                          </div>
                        </div>
                      </>
                    ) : null}
                  </div>
                ))}

                {draftHighlightRect?.pageNumber === currentPage ? (
                  <div
                    className="highlight-annotation highlight-annotation-draft"
                    style={getDraftHighlightStyle(draftHighlightRect)}
                  />
                ) : null}

                {renderedTextAnnotations.map((annotation) => (
                  <div
                    className={
                      [
                        "text-annotation",
                        annotation.id === selectedTextId ? "text-annotation-selected" : "",
                        annotation.id === draggingTextId ? "text-annotation-moving" : "",
                        annotation.id === resizingTextId ? "text-annotation-resizing" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")
                    }
                    data-text-annotation="true"
                    key={annotation.id}
                    style={getTextAnnotationStyle(annotation)}
                  >
                    <button
                      className="added-text"
                      style={{
                        color: annotation.color,
                        fontFamily: getFontFamilyValue(annotation.fontFamily),
                        fontSize: `${annotation.fontSize * renderedZoom}px`,
                        fontWeight: annotation.isBold ? 700 : 400
                      }}
                      type="button"
                      onClick={() => selectTextAnnotation(annotation.id)}
                      onPointerDown={(event) => startMovingText(event, annotation)}
                      onPointerMove={moveText}
                      onPointerUp={stopMovingText}
                      onPointerCancel={stopMovingText}
                      onLostPointerCapture={stopMovingText}
                      title="Drag to move text"
                    >
                      {annotation.text}
                    </button>
                    {annotation.id === selectedTextId &&
                    !pendingTextPlacement &&
                    !pendingImagePlacement &&
                    !pendingSignaturePlacement &&
                    !pendingCommentPlacement &&
                    !draftEraseRect &&
                    !draftHighlightRect ? (
                      <>
                        {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                          <button
                            aria-label={`Resize text box from ${handle}`}
                            className={`image-resize-handle image-resize-handle-${handle}`}
                            key={handle}
                            type="button"
                            onPointerDown={(event) => startResizingText(event, annotation, handle)}
                            onPointerMove={resizeText}
                            onPointerUp={stopResizingText}
                            onPointerCancel={stopResizingText}
                            onLostPointerCapture={stopResizingText}
                          />
                        ))}
                        <div className="text-mini-toolbar" aria-label="Selected text controls">
                          <select
                            aria-label="Selected text size"
                            value={annotation.fontSize}
                            onChange={(event) =>
                              updateTextAnnotationStyle(annotation.id, {
                                fontSize: Number(event.target.value)
                              })
                            }
                          >
                            {FONT_SIZE_OPTIONS.map((fontSize) => (
                              <option value={fontSize} key={fontSize}>
                                {fontSize}px
                              </option>
                            ))}
                          </select>
                          <input
                            aria-label="Selected text color"
                            type="color"
                            value={annotation.color}
                            onChange={(event) =>
                              updateTextAnnotationStyle(annotation.id, {
                                color: event.target.value
                              })
                            }
                          />
                          <button
                            className={
                              annotation.isBold ? "mini-toggle mini-toggle-active" : "mini-toggle"
                            }
                            type="button"
                            aria-pressed={annotation.isBold}
                            onClick={() =>
                              updateTextAnnotationStyle(annotation.id, {
                                isBold: !annotation.isBold
                              })
                            }
                          >
                            Bold
                          </button>
                          <select
                            aria-label="Selected text font family"
                            value={annotation.fontFamily}
                            onChange={(event) =>
                              updateTextAnnotationStyle(annotation.id, {
                                fontFamily: event.target.value as TextFontFamily
                              })
                            }
                          >
                            {FONT_FAMILY_OPTIONS.map((fontFamily) => (
                              <option value={fontFamily} key={fontFamily}>
                                {fontFamily}
                              </option>
                            ))}
                          </select>
                          <button
                            className="done-text-button"
                            type="button"
                            onClick={finishEditingSelectedText}
                          >
                            Done
                          </button>
                          <button
                            className="done-text-button"
                            type="button"
                            onClick={() => editSelectedText(annotation)}
                          >
                            Edit
                          </button>
                          <button
                            className="delete-text-button"
                            type="button"
                            onClick={deleteSelectedText}
                            aria-label="Delete selected text"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                ))}

                {renderedCommentAnnotations.map((annotation) => (
                  <div
                    className={
                      [
                        "comment-annotation",
                        annotation.id === selectedCommentId ? "comment-annotation-selected" : "",
                        annotation.id === draggingCommentId ? "comment-annotation-moving" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")
                    }
                    data-comment-annotation="true"
                    key={annotation.id}
                    style={getCommentAnnotationStyle(annotation, renderedZoom)}
                  >
                    <button
                      className="comment-marker"
                      type="button"
                      onClick={() => selectCommentAnnotation(annotation.id)}
                      onPointerDown={(event) => startMovingComment(event, annotation)}
                      onPointerMove={moveComment}
                      onPointerUp={stopMovingComment}
                      onPointerCancel={stopMovingComment}
                      onLostPointerCapture={stopMovingComment}
                      title="Drag to move comment"
                      aria-label="Open comment"
                    >
                      C
                    </button>
                    {annotation.id === selectedCommentId &&
                    !pendingTextPlacement &&
                    !pendingImagePlacement &&
                    !pendingSignaturePlacement &&
                    !pendingCommentPlacement &&
                    !draftEraseRect &&
                    !draftHighlightRect ? (
                      <div className="comment-card" aria-label="Selected comment">
                        <p>{annotation.comment}</p>
                        <div className="comment-mini-toolbar" aria-label="Selected comment controls">
                          <button
                            className="done-text-button"
                            type="button"
                            onClick={finishEditingSelectedComment}
                          >
                            Done
                          </button>
                          <button
                            className="done-text-button"
                            type="button"
                            onClick={editSelectedComment}
                          >
                            Edit
                          </button>
                          <button
                            className="delete-text-button"
                            type="button"
                            onClick={deleteSelectedComment}
                            aria-label="Delete selected comment"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}

                {pendingCommentPlacement?.pageNumber === currentPage ? (
                  <form
                    className="comment-popover"
                    style={normalizedToScreenPoint(pendingCommentPlacement)}
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveCommentAnnotation();
                    }}
                  >
                    <label className="text-popover-label" htmlFor="comment-annotation-input">
                      {pendingCommentPlacement.editingId ? "Edit comment" : "Comment"}
                    </label>
                    <textarea
                      autoFocus
                      id="comment-annotation-input"
                      value={draftComment}
                      onChange={(event) => setDraftComment(event.target.value)}
                      placeholder="Type a note"
                      rows={4}
                    />
                    <div className="text-popover-actions">
                      <button className="text-popover-add" type="submit">
                        {pendingCommentPlacement.editingId ? "Save" : "Add"}
                      </button>
                      <button
                        className="text-popover-cancel"
                        type="button"
                        onClick={cancelCommentAnnotation}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}

                {pendingTextPlacement?.pageNumber === currentPage ? (
                  <form
                    className="text-popover"
                    style={normalizedToScreenPoint(pendingTextPlacement)}
                    onSubmit={(event) => {
                      event.preventDefault();
                      addTextAnnotation();
                    }}
                  >
                    <label className="text-popover-label" htmlFor="text-annotation-input">
                      {pendingTextPlacement.editingId ? "Edit text" : "Text"}
                    </label>
                    <textarea
                      autoFocus
                      id="text-annotation-input"
                      value={draftText}
                      onChange={(event) => setDraftText(event.target.value)}
                      placeholder="Type text"
                      rows={5}
                    />
                    <div className="text-style-controls" aria-label="Text style controls">
                      <label>
                        Size
                        <select
                          value={draftTextStyle.fontSize}
                          onChange={(event) =>
                            setDraftTextStyle((currentStyle) => ({
                              ...currentStyle,
                              fontSize: Number(event.target.value)
                            }))
                          }
                        >
                          {FONT_SIZE_OPTIONS.map((fontSize) => (
                            <option value={fontSize} key={fontSize}>
                              {fontSize}px
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Color
                        <input
                          type="color"
                          value={draftTextStyle.color}
                          onChange={(event) =>
                            setDraftTextStyle((currentStyle) => ({
                              ...currentStyle,
                              color: event.target.value
                            }))
                          }
                        />
                      </label>
                      <button
                        className={draftTextStyle.isBold ? "mini-toggle mini-toggle-active" : "mini-toggle"}
                        type="button"
                        aria-pressed={draftTextStyle.isBold}
                        onClick={() =>
                          setDraftTextStyle((currentStyle) => ({
                            ...currentStyle,
                            isBold: !currentStyle.isBold
                          }))
                        }
                      >
                        Bold
                      </button>
                      <label>
                        Font
                        <select
                          value={draftTextStyle.fontFamily}
                          onChange={(event) =>
                            setDraftTextStyle((currentStyle) => ({
                              ...currentStyle,
                              fontFamily: event.target.value as TextFontFamily
                            }))
                          }
                        >
                          {FONT_FAMILY_OPTIONS.map((fontFamily) => (
                            <option value={fontFamily} key={fontFamily}>
                              {fontFamily}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="text-popover-actions">
                      <button className="text-popover-add" type="submit">
                        {pendingTextPlacement.editingId ? "Save" : "Add"}
                      </button>
                      <button className="text-popover-cancel" type="button" onClick={cancelTextAnnotation}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}

                {pendingImagePlacement?.pageNumber === currentPage ? (
                  <form
                    className="image-popover"
                    style={normalizedToScreenPoint(pendingImagePlacement)}
                    onSubmit={(event) => event.preventDefault()}
                  >
                    <label className="text-popover-label" htmlFor="image-annotation-input">
                      Image
                    </label>
                    <input
                      autoFocus
                      id="image-annotation-input"
                      type="file"
                      accept="image/png,image/jpeg"
                      onChange={handleImageUpload}
                    />
                    {imageUploadError ? <p className="image-upload-error">{imageUploadError}</p> : null}
                    <div className="text-popover-actions">
                      <button
                        className="text-popover-cancel"
                        type="button"
                        onClick={cancelImageAnnotation}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}

                {pendingSignaturePlacement?.pageNumber === currentPage ? (
                  <form
                    className="signature-popover"
                    style={normalizedToScreenPoint(pendingSignaturePlacement)}
                    onSubmit={(event) => event.preventDefault()}
                  >
                    <label className="text-popover-label" htmlFor="signature-annotation-input">
                      Signature
                    </label>
                    <input
                      autoFocus
                      id="signature-annotation-input"
                      type="file"
                      accept="image/png,image/jpeg"
                      onChange={handleSignatureUpload}
                    />
                    {signatureUploadError ? (
                      <p className="image-upload-error">{signatureUploadError}</p>
                    ) : null}
                    <div className="text-popover-actions">
                      <button
                        className="text-popover-cancel"
                        type="button"
                        onClick={cancelSignatureAnnotation}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state" aria-live="polite">
            <div className="empty-document" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p>PDF preview will appear here.</p>
          </div>
        )}
      </div>

      {hasPdf ? (
        <button
          className="floating-download-button"
          type="button"
          onClick={downloadEditedPdf}
          disabled={isExportingPdf}
        >
          {isExportingPdf ? "Preparing PDF..." : "Download PDF"}
        </button>
      ) : null}
    </section>
  );
}
