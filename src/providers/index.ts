import { getConfig, type ProviderConfig, type Role } from "../config/index.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createBedrockProvider } from "./bedrock.js";
import { createGeminiProvider } from "./gemini.js";
import { createOpenAiProvider } from "./openai.js";
import type { LlmProvider } from "./types.js";

/**
 * Builds providers from resolved config. No environment access happens here -
 * src/config owns that, so a misconfiguration fails once with a useful message
 * rather than surfacing as a confusing auth error mid-run.
 */

export function buildProvider(cfg: ProviderConfig): LlmProvider {
  switch (cfg.provider) {
    case "gemini":
      return createGeminiProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        maxRetries: cfg.maxRetries,
        minGapMs: cfg.minGapMs,
      });
    case "anthropic":
      return createAnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model });
    case "bedrock":
      // apiKey carries the region; credentials come from the AWS chain.
      return createBedrockProvider({
        modelId: cfg.model,
        region: cfg.apiKey,
        maxRetries: cfg.maxRetries,
        timeoutMs: cfg.timeoutMs,
      });
    case "openai":
    case "nvidia":
      // NVIDIA NIM speaks the OpenAI wire format, so it reuses that adapter
      // with a base URL rather than needing its own.
      return createOpenAiProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseURL: cfg.baseURL,
        label: cfg.provider,
        supportsJsonMode: cfg.supportsJsonMode,
        timeoutMs: cfg.timeoutMs,
        maxRetries: cfg.maxRetries,
      });
  }
}

export function providerFor(role: Role): LlmProvider {
  return buildProvider(getConfig().roles[role]);
}

/** The four providers the eval harness needs, built once. */
export function allRoleProviders() {
  return {
    agent: providerFor("agent"),
    patient: providerFor("patient"),
    judge: providerFor("judge"),
    reflect: providerFor("reflect"),
  };
}

export type { LlmProvider } from "./types.js";
