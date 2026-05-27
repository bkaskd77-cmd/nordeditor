import { createHash, randomUUID } from "crypto";
import { NextResponse } from "next/server";

export type PdfUploadUsageInfo = {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
  isLimited: boolean;
  message?: string;
};

export type PdfUploadRateLimitResult = {
  allowed: boolean;
  usage: PdfUploadUsageInfo;
  headers: Headers;
};

const DEFAULT_PDF_DAILY_UPLOAD_LIMIT = 10;
const PDF_UPLOAD_SESSION_COOKIE_NAME = "nordeditor_pdf_upload_session";
const PDF_UPLOAD_LIMIT_MESSAGE =
  "Daily free PDF upload limit reached. You can still edit/download your current PDF.";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type MemoryRateLimitRecord = {
  count: number;
  resetAtMs: number;
};

type GlobalMemoryStore = typeof globalThis & {
  __nordeditorPdfUploadLimitStore?: Map<string, MemoryRateLimitRecord>;
  __nordeditorPdfUploadMemoryLimitWarningShown?: boolean;
};

function getMemoryStore() {
  const globalStore = globalThis as GlobalMemoryStore;

  if (!globalStore.__nordeditorPdfUploadLimitStore) {
    globalStore.__nordeditorPdfUploadLimitStore = new Map();
  }

  return globalStore.__nordeditorPdfUploadLimitStore;
}

function getConfiguredPositiveInteger(name: string, fallback: number) {
  const configuredLimit = Number(process.env[name]);

  if (Number.isFinite(configuredLimit) && configuredLimit > 0) {
    return Math.floor(configuredLimit);
  }

  return fallback;
}

function getDailyUploadLimit() {
  return getConfiguredPositiveInteger("PDF_DAILY_UPLOAD_LIMIT", DEFAULT_PDF_DAILY_UPLOAD_LIMIT);
}

function getTodayWindow() {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const resetAtMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);

  return {
    dateKey,
    resetAtMs,
    resetAt: new Date(resetAtMs).toISOString(),
    secondsUntilReset: Math.max(60, Math.ceil((resetAtMs - now.getTime()) / 1000))
  };
}

function getCookieValue(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie");

  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const [rawName, ...rawValueParts] = cookie.trim().split("=");

    if (rawName === name) {
      return decodeURIComponent(rawValueParts.join("="));
    }
  }

  return null;
}

function getClientIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");

  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown-ip";
  }

  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-vercel-forwarded-for") ??
    "local-development"
  );
}

function getIdentity(request: Request) {
  const headers = new Headers();
  let sessionId = getCookieValue(request, PDF_UPLOAD_SESSION_COOKIE_NAME);

  if (!sessionId) {
    sessionId = randomUUID();
    const isProduction = process.env.NODE_ENV === "production";
    const secureFlag = isProduction ? "; Secure" : "";

    headers.set(
      "Set-Cookie",
      `${PDF_UPLOAD_SESSION_COOKIE_NAME}=${encodeURIComponent(
        sessionId
      )}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secureFlag}`
    );
  }

  // We hash IP + session so Redis stores only anonymous technical limit keys.
  const rawIdentity = `${getClientIp(request)}:${sessionId}`;
  const identityHash = createHash("sha256").update(rawIdentity).digest("hex");

  return {
    headers,
    identityHash
  };
}

function getDurableStoreConfig() {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    return {
      url: upstashUrl,
      token: upstashToken
    };
  }

  const vercelKvUrl = process.env.KV_REST_API_URL;
  const vercelKvToken = process.env.KV_REST_API_TOKEN;

  if (vercelKvUrl && vercelKvToken) {
    return {
      url: vercelKvUrl,
      token: vercelKvToken
    };
  }

  return null;
}

function warnIfUsingMemoryStore() {
  const globalStore = globalThis as GlobalMemoryStore;

  if (globalStore.__nordeditorPdfUploadMemoryLimitWarningShown) {
    return;
  }

  globalStore.__nordeditorPdfUploadMemoryLimitWarningShown = true;
  console.warn("Using in-memory PDF upload limits. Not safe for public production.");
}

async function runRedisCommand<T>(command: Array<string | number>) {
  const config = getDurableStoreConfig();

  if (!config) {
    warnIfUsingMemoryStore();
    return null;
  }

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error("PDF upload limit store is unavailable.");
  }

  const data = (await response.json()) as { result?: T };
  return data.result ?? null;
}

async function getCount(key: string) {
  const durableCount = await runRedisCommand<string | number>(["GET", key]);

  if (durableCount !== null) {
    return Number(durableCount) || 0;
  }

  return null;
}

async function incrementCount(key: string, secondsUntilReset: number) {
  const nextCount = await runRedisCommand<number>(["INCR", key]);

  if (nextCount !== null) {
    if (nextCount === 1) {
      await runRedisCommand(["EXPIRE", key, secondsUntilReset]);
    }

    return Number(nextCount) || 0;
  }

  return null;
}

function getMemoryCount(key: string) {
  const memoryStore = getMemoryStore();
  const record = memoryStore.get(key);

  if (!record || record.resetAtMs <= Date.now()) {
    return 0;
  }

  return record.count;
}

function incrementMemoryCount(key: string, resetAtMs: number) {
  const memoryStore = getMemoryStore();
  const currentCount = getMemoryCount(key);
  const nextCount = currentCount + 1;

  memoryStore.set(key, {
    count: nextCount,
    resetAtMs
  });

  return nextCount;
}

function buildUploadUsage({
  count,
  limit,
  resetAt,
  isLimited
}: {
  count: number;
  limit: number;
  resetAt: string;
  isLimited: boolean;
}): PdfUploadUsageInfo {
  const used = Math.min(Math.max(0, count), limit);
  const remaining = Math.max(0, limit - used);

  return {
    limit,
    used,
    remaining,
    resetAt,
    isLimited,
    message: isLimited ? PDF_UPLOAD_LIMIT_MESSAGE : undefined
  };
}

function applyUploadHeaders(headers: Headers, usage: PdfUploadUsageInfo) {
  headers.set("X-NordEditor-PDF-Upload-Limit", String(usage.limit));
  headers.set("X-NordEditor-PDF-Upload-Used", String(usage.used));
  headers.set("X-NordEditor-PDF-Upload-Remaining", String(usage.remaining));
  headers.set("X-NordEditor-PDF-Upload-Reset", usage.resetAt);
}

export async function checkPdfUploadRateLimit(request: Request): Promise<PdfUploadRateLimitResult> {
  const dailyLimit = getDailyUploadLimit();
  const todayWindow = getTodayWindow();
  const { headers, identityHash } = getIdentity(request);
  const uploadKey = `nordeditor:pdf-upload:user:${todayWindow.dateKey}:${identityHash}`;
  const currentCount = (await getCount(uploadKey)) ?? getMemoryCount(uploadKey);

  if (currentCount >= dailyLimit) {
    const usage = buildUploadUsage({
      count: currentCount,
      limit: dailyLimit,
      resetAt: todayWindow.resetAt,
      isLimited: true
    });
    applyUploadHeaders(headers, usage);

    return {
      allowed: false,
      usage,
      headers
    };
  }

  const nextCount =
    (await incrementCount(uploadKey, todayWindow.secondsUntilReset)) ??
    incrementMemoryCount(uploadKey, todayWindow.resetAtMs);
  const usage = buildUploadUsage({
    count: nextCount,
    limit: dailyLimit,
    resetAt: todayWindow.resetAt,
    isLimited: nextCount > dailyLimit
  });
  applyUploadHeaders(headers, usage);

  return {
    allowed: !usage.isLimited,
    usage,
    headers
  };
}

export function createPdfUploadLimitResponse(rateLimit: PdfUploadRateLimitResult) {
  return NextResponse.json<{ error: string; pdfUploadUsage: PdfUploadUsageInfo }>(
    {
      error: rateLimit.usage.message ?? PDF_UPLOAD_LIMIT_MESSAGE,
      pdfUploadUsage: rateLimit.usage
    },
    {
      status: 429,
      headers: rateLimit.headers
    }
  );
}
