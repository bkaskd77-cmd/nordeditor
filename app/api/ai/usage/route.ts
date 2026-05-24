import { NextResponse } from "next/server";
import { getAiRateLimitStatus } from "../../../../lib/aiRateLimit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rateLimit = await getAiRateLimitStatus(request);

  return NextResponse.json(
    {
      aiUsage: rateLimit.usage
    },
    {
      headers: rateLimit.headers
    }
  );
}
