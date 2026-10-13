// Picks and builds the generator of the configured provider.

import { resolveLlmConfig, type Config, type LlmProvider } from "../config.js";
import { AnthropicGenerator, type AnthropicMessagesClient } from "./providers/anthropic.js";
import { OpenAIGenerator, type OpenAIResponsesClient } from "./providers/openai.js";
import type { RecipeGenerator } from "./types.js";

export interface GeneratorClients {
  openai?: OpenAIResponsesClient;
  anthropic?: AnthropicMessagesClient;
}

// The generator of the configured provider (or the one passed in). Throws
// MissingApiKeyError when that provider's key is not set.
export function createGenerator(
  config: Config,
  options: { provider?: LlmProvider; clients?: GeneratorClients } = {},
): RecipeGenerator {
  const llm = resolveLlmConfig(config, options.provider);
  if (llm.provider === "openai") {
    return new OpenAIGenerator({
      apiKey: llm.apiKey,
      model: llm.model,
      reasoningEffort: llm.reasoningEffort,
      ...(options.clients?.openai ? { client: options.clients.openai } : {}),
    });
  }
  return new AnthropicGenerator({
    apiKey: llm.apiKey,
    model: llm.model,
    ...(options.clients?.anthropic ? { client: options.clients.anthropic } : {}),
  });
}
