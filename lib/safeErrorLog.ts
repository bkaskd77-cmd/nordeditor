type SafeErrorLogInput = {
  route: string;
  featureArea: string;
  error: unknown;
  statusCode?: number;
};

function getErrorType(error: unknown) {
  if (error instanceof Error) {
    return error.name || error.constructor.name || "Error";
  }

  if (error && typeof error === "object") {
    const maybeError = error as { type?: unknown; code?: unknown; name?: unknown };

    if (typeof maybeError.type === "string" && maybeError.type.trim()) {
      return maybeError.type;
    }

    if (typeof maybeError.code === "string" && maybeError.code.trim()) {
      return maybeError.code;
    }

    if (typeof maybeError.name === "string" && maybeError.name.trim()) {
      return maybeError.name;
    }
  }

  return "UnknownError";
}

function getStatusCode(error: unknown, fallbackStatusCode?: number) {
  if (typeof fallbackStatusCode === "number") {
    return fallbackStatusCode;
  }

  if (error && typeof error === "object") {
    const maybeError = error as { status?: unknown; statusCode?: unknown };

    if (typeof maybeError.status === "number") {
      return maybeError.status;
    }

    if (typeof maybeError.statusCode === "number") {
      return maybeError.statusCode;
    }
  }

  return undefined;
}

export function logSafeServerError({
  route,
  featureArea,
  error,
  statusCode
}: SafeErrorLogInput) {
  // Keep production logs useful but private. Do not add PDF names, PDF bytes,
  // base64 strings, AI prompts, document text, or user-entered feedback here.
  const payload = {
    route,
    featureArea,
    errorType: getErrorType(error),
    statusCode: getStatusCode(error, statusCode),
    timestamp: new Date().toISOString()
  };

  // This is the future handoff point for Sentry or another monitor:
  // captureException(error, { tags: payload })
  console.error("NordEditor safe error", payload);
}
