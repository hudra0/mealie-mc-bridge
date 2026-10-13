// Provider settings shared by the configuration and the generators. Kept apart from the
// generators so loading the configuration does not load the SDKs.

export const OPENAI_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type OpenAIReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];

export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

// Defaults; check them against the models your account offers.
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_OPENAI_REASONING_EFFORT: OpenAIReasoningEffort = "medium";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export const DEFAULT_ANTHROPIC_EFFORT: AnthropicEffort = "high";
