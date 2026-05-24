import { createHash, randomUUID } from "crypto";
import { NextResponse } from "next/server";

export type AiUsageInfo = {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
  isLimited: boolean;
};

export type AiRateLimitResult = {
  allowed: boolean;
  usage: AiUsageInfo;
  headers: Headers;
};

const DEFAULT_AI_DAILY_LIMIT = 5;
const AI_SESSION_COOKIE_NAME = "nordeditor_ai_session";
const AI_LIMIT_MESSAGE = "Daily free AI limit reached. More AI access coming with Pro.";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type MemoryRateLimitRecord = {
  count: number;
  resetAtMs: number;
};

type GlobalMemoryStore = typeof globalThis & {
  __nordeditorAiRateLimitStore?: Map<string, MemoryRateLimitRecord>;
};

function getMemoryStore() {
  const globalStore = globalThis as GlobalMemoryStore;

  if (!globalStore.__nordeditorAiRateLimitStore) {
    globalStore.__nordeditorAiRateLimitStore = new Map();
  }

  return globalStore.__nordeditorAiRateLimitStore;
}

function getDailyLimit() {
  const configuredLimit = Number(process.env.AI_DAILY_LIMIT);

  if (Number.isFinite(configuredLimit) && configuredLimit > 0) {
    return Math.floor(configuredLimit);
  }

  return DEFAULT_AI_DAILY_LIMIT;
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
  let sessionId = getCookieValue(request, AI_SESSION_COOKIE_NAME);

  if (!sessionId) {
    sessionId = randomUUID();
    const isProduction = process.env.NODE_ENV === "production";
    const secureFlag = isProduction ? "; Secure" : "";

    headers.set(
      "Set-Cookie",
      `${AI_SESSION_COOKIE_NAME}=${encodeURIComponent(
        sessionId
      )}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secureFlag}`
    );
  }

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

async function runRedisCommand<T>(command: Array<string | number>) {
  const config = getDurableStoreConfig();

  if (!config) {
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
    throw new Error("AI rate limit store is unavailable.");
  }

  const data = (await response.json()) as { result?: T };
  return data.result ?? null;
}

function buildUsage(count: number, limit: number, resetAt: string): AiUsageInfo {
  const used = Math.min(Math.max(0, count), limit);
  const remaining = Math.max(0, limit - used);

  return {
    limit,
    used,
    remaining,
    resetAt,
    isLimited: remaining <= 0
  };
}

function applyUsageHeaders(headers: Headers, usage: AiUsageInfo) {
  headers.set("X-NordEditor-AI-Limit", String(usage.limit));
  headers.set("X-NordEditor-AI-Used", String(usage.used));
  headers.set("X-NordEditor-AI-Remaining", String(usage.remaining));
  headers.set("X-NordEditor-AI-Reset", usage.resetAt);
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

export async function getAiRateLimitStatus(request: Request): Promise<AiRateLimitResult> {
  const limit = getDailyLimit();
  const { dateKey, resetAt } = getTodayWindow();
  const { headers, identityHash } = getIdentity(request);
  const key = `nordeditor:ai:${dateKey}:${identityHash}`;
  const durableCount = await getCount(key);
  const count = durableCount ?? getMemoryCount(key);
  const usage = buildUsage(count, limit, resetAt);

  applyUsageHeaders(headers, usage);

  return {
    allowed: !usage.isLimited,
    usage,
    headers
  };
}

export async function checkAiRateLimit(request: Request): Promise<AiRateLimitResult> {
  const limit = getDailyLimit();
  const { dateKey, resetAtMs, resetAt, secondsUntilReset } = getTodayWindow();
  const { headers, identityHash } = getIdentity(request);
  const key = `nordeditor:ai:${dateKey}:${identityHash}`;
  const currentCount = (await getCount(key)) ?? getMemoryCount(key);

  if (currentCount >= limit) {
    const usage = buildUsage(currentCount, limit, resetAt);
    applyUsageHeaders(headers, usage);

    return {
      allowed: false,
      usage,
      headers
    };
  }

  const nextCount = (await incrementCount(key, secondsUntilReset)) ?? incrementMemoryCount(key, resetAtMs);
  const usage = buildUsage(nextCount, limit, resetAt);
  applyUsageHeaders(headers, usage);

  return {
    allowed: nextCount <= limit,
    usage,
    headers
  };
}

export function createAiJsonResponse<T extends object>(body: T, rateLimit: AiRateLimitResult) {
  return NextResponse.json<T & { aiUsage: AiUsageInfo }>(
    {
      ...body,
      aiUsage: rateLimit.usage
    },
    {
      headers: rateLimit.headers
    }
  );
}

export function createAiJsonError(
  message: string,
  status: number,
  rateLimit?: AiRateLimitResult | null
) {
  return NextResponse.json<{ error: string; aiUsage?: AiUsageInfo }>(
    {
      error: message,
      ...(rateLimit ? { aiUsage: rateLimit.usage } : {})
    },
    {
      status,
      headers: rateLimit?.headers
    }
  );
}

export function createAiLimitReachedResponse(rateLimit: AiRateLimitResult) {
  return createAiJsonError(AI_LIMIT_MESSAGE, 429, rateLimit);
}
