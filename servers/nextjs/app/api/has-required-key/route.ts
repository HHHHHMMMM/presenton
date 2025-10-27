import { NextResponse } from "next/server";
import fs from "fs";

export const dynamic = "force-dynamic";

export async function GET() {
  const userConfigPath = process.env.USER_CONFIG_PATH;

  let openaiKeyFromFile = "";
  let googleKeyFromFile = "";
  let anthropicKeyFromFile = "";

  if (userConfigPath && fs.existsSync(userConfigPath)) {
    try {
      const raw = fs.readFileSync(userConfigPath, "utf-8");
      const cfg = JSON.parse(raw || "{}");
      openaiKeyFromFile = cfg?.OPENAI_API_KEY || "";
      googleKeyFromFile = cfg?.GOOGLE_API_KEY || "";
      anthropicKeyFromFile = cfg?.ANTHROPIC_API_KEY || "";
    } catch {}
  }

  const openaiKeyFromEnv = process.env.OPENAI_API_KEY || "";
  const googleKeyFromEnv = process.env.GOOGLE_API_KEY || "";
  const anthropicKeyFromEnv = process.env.ANTHROPIC_API_KEY || "";

  // Check if any vision-capable LLM provider key is available
  const hasOpenAIKey = Boolean((openaiKeyFromFile || openaiKeyFromEnv).trim());
  const hasGoogleKey = Boolean((googleKeyFromFile || googleKeyFromEnv).trim());
  const hasAnthropicKey = Boolean((anthropicKeyFromFile || anthropicKeyFromEnv).trim());

  // At least one vision-capable provider is needed
  const hasKey = hasOpenAIKey || hasGoogleKey || hasAnthropicKey;

  return NextResponse.json({ hasKey });
} 