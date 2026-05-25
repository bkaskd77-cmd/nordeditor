const CURRENT_MINI_MODEL = "gpt-4o-mini";
const DEFAULT_STRONG_MODEL = "gpt-4o";

type AiModelOptions = {
  featureModelEnvName?: string;
  useStrongModel?: boolean;
};

function getEnvValue(name: string) {
  const value = process.env[name]?.trim();

  return value || undefined;
}

export function getDefaultAiModel() {
  return getEnvValue("AI_DEFAULT_MODEL") ?? getEnvValue("OPENAI_SUMMARY_MODEL") ?? CURRENT_MINI_MODEL;
}

export function getStrongAiModel() {
  return getEnvValue("AI_STRONG_MODEL") ?? DEFAULT_STRONG_MODEL;
}

export function getAiModel(options: AiModelOptions = {}) {
  const featureModel = options.featureModelEnvName
    ? getEnvValue(options.featureModelEnvName)
    : undefined;

  // Strong model routing stays off by default. Later, premium actions or an
  // "Improve answer" button can pass useStrongModel after checking the user's access.
  if (options.useStrongModel && getEnvValue("AI_ENABLE_STRONG_MODEL") === "true") {
    return getStrongAiModel();
  }

  return featureModel ?? getDefaultAiModel();
}
