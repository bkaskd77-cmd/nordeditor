import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

export type AiAccessRole = "public" | "beta" | "admin";

export type AiUsageInfo = {
  role: AiAccessRole;
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

export type AiRateLimitResult = {
  allowed: boolean;
  usage: AiUsageInfo;
  headers: Headers;
  monthlyCostKey: string;
  monthlyResetAtMs: number;
  monthlyBudgetMicroUsd: number;
};

const DEFAULT_AI_DAILY_LIMIT = 5;
const DEFAULT_AI_ADMIN_DAILY_LIMIT = 50;
const DEFAULT_AI_BETA_DAILY_LIMIT = 20;
const DEFAULT_AI_GLOBAL_DAILY_REQUEST_LIMIT = 100;
const DEFAULT_AI_MONTHLY_BUDGET_USD = 10;
const MICRO_USD_PER_USD = 1_000_000;
const AI_SESSION_COOKIE_NAME = "nordeditor_ai_session";
const AI_ACCESS_COOKIE_NAME = "nordeditor_ai_access";
const AI_LIMIT_MESSAGE = "Daily free AI limit reached. More AI access coming with Pro.";
const AI_ADMIN_LIMIT_MESSAGE =
  "Daily owner/testing AI limit reached. Manual PDF editing is still available.";
const AI_BETA_LIMIT_MESSAGE =
  "Daily beta AI limit reached. Manual PDF editing is still available.";
const AI_GLOBAL_DAILY_LIMIT_MESSAGE =
  "Daily beta AI request limit reached. Manual PDF editing is still available.";
const AI_MONTHLY_BUDGET_LIMIT_MESSAGE =
  "Monthly beta AI limit reached. Manual PDF editing is still available.";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const AI_ACCESS_MAX_AGE_SECONDS = 60 * 60 * 12;

const MODEL_COST_USD_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 }
};

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

function getConfiguredPositiveInteger(name: string, fallback: number) {
  const configuredLimit = Number(process.env[name]);

  if (Number.isFinite(configuredLimit) && configuredLimit > 0) {
    return Math.floor(configuredLimit);
  }

  return fallback;
}

export function getDailyLimitForRole(role: AiAccessRole) {
  if (role === "admin") {
    return getConfiguredPositiveInteger("AI_ADMIN_DAILY_LIMIT", DEFAULT_AI_ADMIN_DAILY_LIMIT);
  }

  if (role === "beta") {
    return getConfiguredPositiveInteger("AI_BETA_DAILY_LIMIT", DEFAULT_AI_BETA_DAILY_LIMIT);
  }

  return getConfiguredPositiveInteger("AI_DAILY_LIMIT", DEFAULT_AI_DAILY_LIMIT);
}

function getGlobalDailyRequestLimit() {
  return getConfiguredPositiveInteger(
    "AI_GLOBAL_DAILY_REQUEST_LIMIT",
    DEFAULT_AI_GLOBAL_DAILY_REQUEST_LIMIT
  );
}

function getMonthlyBudgetMicroUsd() {
  const configuredBudget = Number(process.env.AI_MONTHLY_BUDGET_USD);
  const budgetUsd =
    Number.isFinite(configuredBudget) && configuredBudget > 0
      ? configuredBudget
      : DEFAULT_AI_MONTHLY_BUDGET_USD;

  return Math.round(budgetUsd * MICRO_USD_PER_USD);
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

function getMonthWindow() {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 7);
  const resetAtMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);

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

function getRoleLabel(role: AiAccessRole) {
  if (role === "admin") {
    return "Owner/testing";
  }

  if (role === "beta") {
    return "Private beta";
  }

  return "Public";
}

function getAccessSigningSecret() {
  return (
    process.env.AI_ADMIN_ACCESS_CODE ??
    process.env.AI_BETA_ACCESS_CODE ??
    process.env.OPENAI_API_KEY ??
    ""
  );
}

function signAccessPayload(payload: string) {
  const secret = getAccessSigningSecret();

  if (!secret) {
    return "";
  }

  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeTextEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createAccessCookieValue(role: Exclude<AiAccessRole, "public">) {
  const expiresAtMs = Date.now() + AI_ACCESS_MAX_AGE_SECONDS * 1000;
  const payload = Buffer.from(JSON.stringify({ role, expiresAtMs })).toString("base64url");
  const signature = signAccessPayload(payload);

  if (!signature) {
    return null;
  }

  return `${payload}.${signature}`;
}

export function validateAiAccessCode(code: string): AiAccessRole | null {
  const trimmedCode = code.trim();
  const adminCode = process.env.AI_ADMIN_ACCESS_CODE?.trim();
  const betaCode = process.env.AI_BETA_ACCESS_CODE?.trim();

  if (adminCode && safeTextEquals(trimmedCode, adminCode)) {
    return "admin";
  }

  if (betaCode && safeTextEquals(trimmedCode, betaCode)) {
    return "beta";
  }

  return null;
}

export function createAiAccessCookieHeader(role: Exclude<AiAccessRole, "public">) {
  const cookieValue = createAccessCookieValue(role);

  if (!cookieValue) {
    return null;
  }

  const isProduction = process.env.NODE_ENV === "production";
  const secureFlag = isProduction ? "; Secure" : "";

  return `${AI_ACCESS_COOKIE_NAME}=${encodeURIComponent(
    cookieValue
  )}; Path=/; Max-Age=${AI_ACCESS_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secureFlag}`;
}

export function createAiAccessClearCookieHeader() {
  const isProduction = process.env.NODE_ENV === "production";
  const secureFlag = isProduction ? "; Secure" : "";

  return `${AI_ACCESS_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag}`;
}

export function getAiAccessRole(request: Request): AiAccessRole {
  const cookieValue = getCookieValue(request, AI_ACCESS_COOKIE_NAME);

  if (!cookieValue) {
    return "public";
  }

  const [payload, signature] = cookieValue.split(".");
  const expectedSignature = signAccessPayload(payload ?? "");

  if (!payload || !signature || !expectedSignature || !safeTextEquals(signature, expectedSignature)) {
    return "public";
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      role?: AiAccessRole;
      expiresAtMs?: number;
    };

    if (
      (parsed.role === "admin" || parsed.role === "beta") &&
      typeof parsed.expiresAtMs === "number" &&
      parsed.expiresAtMs > Date.now()
    ) {
      return parsed.role;
    }
  } catch {
    return "public";
  }

  return "public";
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

function applyUsageHeaders(headers: Headers, usage: AiUsageInfo) {
  headers.set("X-NordEditor-AI-Limit", String(usage.limit));
  headers.set("X-NordEditor-AI-Used", String(usage.used));
  headers.set("X-NordEditor-AI-Remaining", String(usage.remaining));
  headers.set("X-NordEditor-AI-Reset", usage.resetAt);
  headers.set("X-NordEditor-AI-Global-Daily-Limit", String(usage.globalDailyLimit));
  headers.set("X-NordEditor-AI-Global-Daily-Used", String(usage.globalDailyUsed));
  headers.set("X-NordEditor-AI-Monthly-Budget-USD", String(usage.monthlyBudgetUsd));
  headers.set(
    "X-NordEditor-AI-Monthly-Estimated-Spend-USD",
    String(usage.monthlyEstimatedSpendUsd)
  );
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

async function incrementCountBy(key: string, amount: number, secondsUntilReset: number) {
  const nextCount = await runRedisCommand<number>(["INCRBY", key, amount]);

  if (nextCount !== null) {
    if (nextCount === amount) {
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

function incrementMemoryCountBy(key: string, amount: number, resetAtMs: number) {
  const memoryStore = getMemoryStore();
  const currentCount = getMemoryCount(key);
  const nextCount = currentCount + amount;

  memoryStore.set(key, {
    count: nextCount,
    resetAtMs
  });

  return nextCount;
}

function microUsdToUsd(microUsd: number) {
  return Number((microUsd / MICRO_USD_PER_USD).toFixed(6));
}

function getUserDailyLimitMessage(role: AiAccessRole) {
  if (role === "admin") {
    return AI_ADMIN_LIMIT_MESSAGE;
  }

  if (role === "beta") {
    return AI_BETA_LIMIT_MESSAGE;
  }

  return AI_LIMIT_MESSAGE;
}

function getLimitMessage(limitReason: AiUsageInfo["limitReason"] | undefined, role: AiAccessRole) {
  if (limitReason === "monthly_budget") {
    return AI_MONTHLY_BUDGET_LIMIT_MESSAGE;
  }

  if (limitReason === "global_daily") {
    return AI_GLOBAL_DAILY_LIMIT_MESSAGE;
  }

  if (limitReason === "user_daily") {
    return getUserDailyLimitMessage(role);
  }

  return undefined;
}

function buildUsage({
  userCount,
  userLimit,
  userResetAt,
  globalDailyCount,
  globalDailyLimit,
  globalDailyResetAt,
  monthlySpendMicroUsd,
  monthlyBudgetMicroUsd,
  monthlyResetAt,
  limitReason,
  role
}: {
  userCount: number;
  userLimit: number;
  userResetAt: string;
  globalDailyCount: number;
  globalDailyLimit: number;
  globalDailyResetAt: string;
  monthlySpendMicroUsd: number;
  monthlyBudgetMicroUsd: number;
  monthlyResetAt: string;
  limitReason?: AiUsageInfo["limitReason"];
  role: AiAccessRole;
}): AiUsageInfo {
  const used = Math.min(Math.max(0, userCount), userLimit);
  const remaining = Math.max(0, userLimit - used);
  const globalDailyUsed = Math.min(Math.max(0, globalDailyCount), globalDailyLimit);
  const globalDailyRemaining = Math.max(0, globalDailyLimit - globalDailyUsed);
  const monthlyBudgetRemainingMicroUsd = Math.max(
    0,
    monthlyBudgetMicroUsd - monthlySpendMicroUsd
  );
  const resolvedLimitReason =
    limitReason ??
    (monthlySpendMicroUsd >= monthlyBudgetMicroUsd
      ? "monthly_budget"
      : globalDailyRemaining <= 0
        ? "global_daily"
        : remaining <= 0
          ? "user_daily"
          : undefined);

  return {
    role,
    roleLabel: getRoleLabel(role),
    limit: userLimit,
    used,
    remaining,
    resetAt: userResetAt,
    globalDailyLimit,
    globalDailyUsed,
    globalDailyRemaining,
    globalDailyResetAt,
    monthlyBudgetUsd: microUsdToUsd(monthlyBudgetMicroUsd),
    monthlyEstimatedSpendUsd: microUsdToUsd(monthlySpendMicroUsd),
    monthlyBudgetRemainingUsd: microUsdToUsd(monthlyBudgetRemainingMicroUsd),
    monthlyResetAt,
    limitReason: resolvedLimitReason,
    message: getLimitMessage(resolvedLimitReason, role),
    isLimited: Boolean(resolvedLimitReason)
  };
}

function getModelCost(model: string) {
  const inputOverride = Number(process.env.AI_COST_INPUT_USD_PER_1M_TOKENS);
  const outputOverride = Number(process.env.AI_COST_OUTPUT_USD_PER_1M_TOKENS);

  if (
    Number.isFinite(inputOverride) &&
    inputOverride >= 0 &&
    Number.isFinite(outputOverride) &&
    outputOverride >= 0
  ) {
    return {
      input: inputOverride,
      output: outputOverride
    };
  }

  return MODEL_COST_USD_PER_1M_TOKENS[model] ?? MODEL_COST_USD_PER_1M_TOKENS["gpt-4o-mini"];
}

function getFallbackRequestCostMicroUsd() {
  const configuredCost = Number(process.env.AI_FALLBACK_REQUEST_COST_USD);
  const fallbackCostUsd =
    Number.isFinite(configuredCost) && configuredCost >= 0 ? configuredCost : 0.002;

  return Math.max(1, Math.ceil(fallbackCostUsd * MICRO_USD_PER_USD));
}

function getUsageNumber(usage: unknown, key: string) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }

  const value = (usage as Record<string, unknown>)[key];

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimateAiCostMicroUsd(model: string, usage: unknown) {
  const inputTokens =
    getUsageNumber(usage, "input_tokens") || getUsageNumber(usage, "prompt_tokens");
  const outputTokens =
    getUsageNumber(usage, "output_tokens") || getUsageNumber(usage, "completion_tokens");

  if (inputTokens <= 0 && outputTokens <= 0) {
    return getFallbackRequestCostMicroUsd();
  }

  const modelCost = getModelCost(model);

  // OpenAI usage is token-only metadata. We store estimated cost, never PDF text or prompts.
  return Math.max(
    1,
    Math.ceil(inputTokens * modelCost.input + outputTokens * modelCost.output)
  );
}

export async function getAiRateLimitStatus(request: Request): Promise<AiRateLimitResult> {
  const accessRole = getAiAccessRole(request);
  const userLimit = getDailyLimitForRole(accessRole);
  const globalDailyLimit = getGlobalDailyRequestLimit();
  const monthlyBudgetMicroUsd = getMonthlyBudgetMicroUsd();
  const todayWindow = getTodayWindow();
  const monthWindow = getMonthWindow();
  const { headers, identityHash } = getIdentity(request);
  const userDailyKey = `nordeditor:ai:user:${todayWindow.dateKey}:${identityHash}`;
  const globalDailyKey = `nordeditor:ai:global:${todayWindow.dateKey}`;
  const monthlyCostKey = `nordeditor:ai:cost:${monthWindow.dateKey}`;
  const userDailyCount = (await getCount(userDailyKey)) ?? getMemoryCount(userDailyKey);
  const globalDailyCount = (await getCount(globalDailyKey)) ?? getMemoryCount(globalDailyKey);
  const monthlySpendMicroUsd = (await getCount(monthlyCostKey)) ?? getMemoryCount(monthlyCostKey);
  const usage = buildUsage({
    userCount: userDailyCount,
    userLimit,
    userResetAt: todayWindow.resetAt,
    globalDailyCount,
    globalDailyLimit,
    globalDailyResetAt: todayWindow.resetAt,
    monthlySpendMicroUsd,
    monthlyBudgetMicroUsd,
    monthlyResetAt: monthWindow.resetAt,
    role: accessRole
  });

  applyUsageHeaders(headers, usage);

  return {
    allowed: !usage.isLimited,
    usage,
    headers,
    monthlyCostKey,
    monthlyResetAtMs: monthWindow.resetAtMs,
    monthlyBudgetMicroUsd
  };
}

export async function checkAiRateLimit(request: Request): Promise<AiRateLimitResult> {
  const accessRole = getAiAccessRole(request);
  const userLimit = getDailyLimitForRole(accessRole);
  const globalDailyLimit = getGlobalDailyRequestLimit();
  const monthlyBudgetMicroUsd = getMonthlyBudgetMicroUsd();
  const todayWindow = getTodayWindow();
  const monthWindow = getMonthWindow();
  const { headers, identityHash } = getIdentity(request);
  const userDailyKey = `nordeditor:ai:user:${todayWindow.dateKey}:${identityHash}`;
  const globalDailyKey = `nordeditor:ai:global:${todayWindow.dateKey}`;
  const monthlyCostKey = `nordeditor:ai:cost:${monthWindow.dateKey}`;
  const currentUserCount = (await getCount(userDailyKey)) ?? getMemoryCount(userDailyKey);
  const currentGlobalDailyCount =
    (await getCount(globalDailyKey)) ?? getMemoryCount(globalDailyKey);
  const currentMonthlySpendMicroUsd =
    (await getCount(monthlyCostKey)) ?? getMemoryCount(monthlyCostKey);

  if (currentUserCount >= userLimit) {
    const usage = buildUsage({
      userCount: currentUserCount,
      userLimit,
      userResetAt: todayWindow.resetAt,
      globalDailyCount: currentGlobalDailyCount,
      globalDailyLimit,
      globalDailyResetAt: todayWindow.resetAt,
      monthlySpendMicroUsd: currentMonthlySpendMicroUsd,
      monthlyBudgetMicroUsd,
      monthlyResetAt: monthWindow.resetAt,
      limitReason: "user_daily",
      role: accessRole
    });
    applyUsageHeaders(headers, usage);

    return {
      allowed: false,
      usage,
      headers,
      monthlyCostKey,
      monthlyResetAtMs: monthWindow.resetAtMs,
      monthlyBudgetMicroUsd
    };
  }

  if (currentGlobalDailyCount >= globalDailyLimit) {
    const usage = buildUsage({
      userCount: currentUserCount,
      userLimit,
      userResetAt: todayWindow.resetAt,
      globalDailyCount: currentGlobalDailyCount,
      globalDailyLimit,
      globalDailyResetAt: todayWindow.resetAt,
      monthlySpendMicroUsd: currentMonthlySpendMicroUsd,
      monthlyBudgetMicroUsd,
      monthlyResetAt: monthWindow.resetAt,
      limitReason: "global_daily",
      role: accessRole
    });
    applyUsageHeaders(headers, usage);

    return {
      allowed: false,
      usage,
      headers,
      monthlyCostKey,
      monthlyResetAtMs: monthWindow.resetAtMs,
      monthlyBudgetMicroUsd
    };
  }

  if (currentMonthlySpendMicroUsd >= monthlyBudgetMicroUsd) {
    const usage = buildUsage({
      userCount: currentUserCount,
      userLimit,
      userResetAt: todayWindow.resetAt,
      globalDailyCount: currentGlobalDailyCount,
      globalDailyLimit,
      globalDailyResetAt: todayWindow.resetAt,
      monthlySpendMicroUsd: currentMonthlySpendMicroUsd,
      monthlyBudgetMicroUsd,
      monthlyResetAt: monthWindow.resetAt,
      limitReason: "monthly_budget",
      role: accessRole
    });
    applyUsageHeaders(headers, usage);

    return {
      allowed: false,
      usage,
      headers,
      monthlyCostKey,
      monthlyResetAtMs: monthWindow.resetAtMs,
      monthlyBudgetMicroUsd
    };
  }

  const nextUserCount =
    (await incrementCount(userDailyKey, todayWindow.secondsUntilReset)) ??
    incrementMemoryCount(userDailyKey, todayWindow.resetAtMs);
  const nextGlobalDailyCount =
    (await incrementCount(globalDailyKey, todayWindow.secondsUntilReset)) ??
    incrementMemoryCount(globalDailyKey, todayWindow.resetAtMs);
  const usage = buildUsage({
    userCount: nextUserCount,
    userLimit,
    userResetAt: todayWindow.resetAt,
    globalDailyCount: nextGlobalDailyCount,
    globalDailyLimit,
    globalDailyResetAt: todayWindow.resetAt,
    monthlySpendMicroUsd: currentMonthlySpendMicroUsd,
    monthlyBudgetMicroUsd,
    monthlyResetAt: monthWindow.resetAt,
    role: accessRole
  });
  applyUsageHeaders(headers, usage);

  return {
    allowed: nextUserCount <= userLimit && nextGlobalDailyCount <= globalDailyLimit,
    usage,
    headers,
    monthlyCostKey,
    monthlyResetAtMs: monthWindow.resetAtMs,
    monthlyBudgetMicroUsd
  };
}

export async function recordAiResponseUsage(
  rateLimit: AiRateLimitResult,
  model: string,
  usage: unknown
) {
  const estimatedCostMicroUsd = estimateAiCostMicroUsd(model, usage);
  const monthWindow = getMonthWindow();
  const nextMonthlySpendMicroUsd =
    (await incrementCountBy(
      rateLimit.monthlyCostKey,
      estimatedCostMicroUsd,
      monthWindow.secondsUntilReset
    )) ?? incrementMemoryCountBy(rateLimit.monthlyCostKey, estimatedCostMicroUsd, monthWindow.resetAtMs);

  rateLimit.usage = {
    ...rateLimit.usage,
    monthlyEstimatedSpendUsd: microUsdToUsd(nextMonthlySpendMicroUsd),
    monthlyBudgetRemainingUsd: microUsdToUsd(
      Math.max(0, rateLimit.monthlyBudgetMicroUsd - nextMonthlySpendMicroUsd)
    ),
    limitReason:
      nextMonthlySpendMicroUsd >= rateLimit.monthlyBudgetMicroUsd
        ? "monthly_budget"
        : rateLimit.usage.limitReason,
    message:
      nextMonthlySpendMicroUsd >= rateLimit.monthlyBudgetMicroUsd
        ? AI_MONTHLY_BUDGET_LIMIT_MESSAGE
        : rateLimit.usage.message,
    isLimited:
      nextMonthlySpendMicroUsd >= rateLimit.monthlyBudgetMicroUsd || rateLimit.usage.isLimited
  };

  applyUsageHeaders(rateLimit.headers, rateLimit.usage);
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
  return createAiJsonError(rateLimit.usage.message ?? AI_LIMIT_MESSAGE, 429, rateLimit);
}
