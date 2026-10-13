// Errors the converter and the providers throw. Each carries what the caller needs to
// report the failure; none of them carries a key or a prompt.

import type { ValidationIssue } from "../recipe/validate.js";
import type { CorrectionRound, TokenUsage } from "./types.js";

// The correction rounds are used up and the last answer still has errors.
export class ConversionFailedError extends Error {
  readonly errors: ValidationIssue[];
  readonly attempts: number;
  readonly usage: TokenUsage;
  readonly provider: string;
  readonly model: string;
  // The last answer, for the job log.
  readonly lastJson: string;
  // The errors of every answer, the last one included.
  readonly corrections: CorrectionRound[];

  constructor(init: {
    errors: ValidationIssue[];
    attempts: number;
    usage: TokenUsage;
    provider: string;
    model: string;
    lastJson: string;
    corrections?: CorrectionRound[];
  }) {
    const shown = init.errors
      .slice(0, 5)
      .map((error) => `${error.path}: ${error.message}`)
      .join("; ");
    const more = init.errors.length > 5 ? ` and ${init.errors.length - 5} more` : "";
    super(
      `The recipe still has ${init.errors.length} error(s) after ${init.attempts} attempt(s): ${shown}${more}`,
    );
    this.name = "ConversionFailedError";
    this.errors = init.errors;
    this.attempts = init.attempts;
    this.usage = init.usage;
    this.provider = init.provider;
    this.model = init.model;
    this.lastJson = init.lastJson;
    this.corrections = init.corrections ?? [];
  }
}

// The model declined to answer.
export class LlmRefusalError extends Error {
  readonly provider: string;
  readonly category: string | null;

  constructor(provider: string, detail: string | null, category: string | null = null) {
    super(
      `The ${provider} model refused the request${category ? ` (${category})` : ""}${detail ? `: ${detail}` : ""}`,
    );
    this.name = "LlmRefusalError";
    this.provider = provider;
    this.category = category;
  }
}

// The answer hit the output token limit, so the JSON is cut off.
export class LlmOutputTruncatedError extends Error {
  readonly provider: string;
  readonly usage: Omit<TokenUsage, "costUsd">;

  constructor(provider: string, maxOutputTokens: number, usage: Omit<TokenUsage, "costUsd">) {
    super(
      `The ${provider} answer reached the limit of ${maxOutputTokens} output tokens and is incomplete`,
    );
    this.name = "LlmOutputTruncatedError";
    this.provider = provider;
    this.usage = usage;
  }
}

// The selected provider cannot be used with the current configuration.
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}
