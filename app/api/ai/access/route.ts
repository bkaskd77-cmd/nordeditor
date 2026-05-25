import { NextResponse } from "next/server";
import {
  createAiAccessClearCookieHeader,
  createAiAccessCookieHeader,
  getAiRateLimitStatus,
  validateAiAccessCode
} from "../../../../lib/aiRateLimit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { code?: string } | null;
  const code = body?.code?.trim() ?? "";

  if (!code) {
    return NextResponse.json(
      { error: "Enter your private beta/testing access code." },
      { status: 400 }
    );
  }

  const role = validateAiAccessCode(code);

  if (!role || role === "public") {
    return NextResponse.json(
      { error: "That access code was not recognized." },
      { status: 401 }
    );
  }

  const accessCookie = createAiAccessCookieHeader(role);

  if (!accessCookie) {
    return NextResponse.json(
      { error: "Private access is not configured on this deployment yet." },
      { status: 503 }
    );
  }

  const rateLimit = await getAiRateLimitStatus(
    new Request(request.url, {
      headers: {
        cookie: `${request.headers.get("cookie") ?? ""}; ${accessCookie.split(";")[0]}`
      }
    })
  );
  const response = NextResponse.json(
    {
      message:
        role === "admin"
          ? "Owner/testing AI limit is active for this browser session."
          : "Private beta AI limit is active for this browser session.",
      aiUsage: rateLimit.usage
    },
    {
      headers: rateLimit.headers
    }
  );

  response.headers.append("Set-Cookie", accessCookie);

  return response;
}

export async function DELETE(request: Request) {
  const clearCookie = createAiAccessClearCookieHeader();
  const publicCookieHeader = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => !cookie.startsWith("nordeditor_ai_access="))
    .join("; ");
  const rateLimit = await getAiRateLimitStatus(
    new Request(request.url, {
      headers: {
        cookie: publicCookieHeader
      }
    })
  );
  const response = NextResponse.json(
    {
      message: "Private beta/testing access was turned off for this browser session.",
      aiUsage: rateLimit.usage
    },
    {
      headers: rateLimit.headers
    }
  );

  response.headers.append("Set-Cookie", clearCookie);

  return response;
}
