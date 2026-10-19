import "dotenv/config";

/**
 * Every environment read in the project happens here.
 *
 * Two reasons this is worth a module rather than scattered process.env reads:
 * a missing key fails once, at startup, with a message that says what to do;
 * and the resolved config is printable, so every eval report can record which
 * models produced it. A before/after comparison is meaningless if the two runs
 * silently used different models.
 */

export type ProviderName =
  | "gemini"
  | "openai"
  | "anthropic"
  | "nvidia"
  | "bedrock";

export type Role = "agent" | "patient" | "judge" | "reflect";

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseURL?: string;
  /** NIM rejects response_format on some models. */
  supportsJsonMode: boolean;
  timeoutMs: number;
  maxRetries: number;
  /** Min ms between requests to one provider (free-tier rate limits). */
  minGapMs: number;
}

export interface Config {
  roles: Record<Role, ProviderConfig>;
  loopRounds: number;
  /** Concurrent scenarios. Lower this if a provider rate-limits. */
  concurrency: number;
  resultsDir: string;
  lessonsPath: string;
  /**
   * Run only the deterministic half of the safety screen.
   *
   * The pattern floor catches the catalogued emergency phrasings at zero cost
   * and zero latency. Skipping the LLM half halves the per-turn call count,
   * which matters on a rate-limited tier - but it also means novel phrasings
   * a keyword list cannot anticipate go uncaught, so this is a development
   * convenience, never a production setting.
   */
  deterministicSafetyOnly: boolean;
}

const PROVIDERS: ProviderName[] = [
  "gemini",
  "openai",
  "anthropic",
  "nvidia",
  "bedrock",
];

const DEFAULTS: Record<
  ProviderName,
  { keyVar: string; modelVar: string; model: string; baseURL?: string; json: boolean }
> = {
  gemini: {
    keyVar: "GEMINI_API_KEY",
    modelVar: "GEMINI_MODEL",
    model: "gemini-3.6-flash",
    json: true,
  },
  // gpt-6-luna: cheapest current model with confirmed function calling
  // ($0.10/$0.50 per 1M). Scheduling needs reliable tool use far more than
  // frontier reasoning, so the workhorse tier is the right default here.
  openai: {
    keyVar: "OPENAI_API_KEY",
    modelVar: "OPENAI_MODEL",
    model: "gpt-6-luna",
    json: true,
  },
  anthropic: {
    keyVar: "ANTHROPIC_API_KEY",
    modelVar: "ANTHROPIC_MODEL",
    model: "claude-sonnet-5",
    json: true,
  },
  // "nvidia" = any model served by NVIDIA NIM's OpenAI-compatible endpoint.
  // NIM's /v1/models list is aspirational: it advertises models the key cannot
  // actually reach (404) and some that accept a connection and never respond.
  // gpt-oss-20b is the one verified to serve on this account, so it is the
  // default; override NVIDIA_MODEL once a better one is confirmed working.
  // Bedrock authenticates through the AWS credential chain rather than a key
  // in .env, so keyVar points at the region: it is the one value that must be
  // present, and a missing region fails with the same actionable message as a
  // missing key would.
  bedrock: {
    keyVar: "AWS_REGION",
    modelVar: "BEDROCK_MODEL",
    model: "deepseek.v3.2",
    json: false,
  },
  nvidia: {
    keyVar: "NVIDIA_API_KEY",
    modelVar: "NVIDIA_MODEL",
    model: "openai/gpt-oss-20b",
    baseURL: "https://integrate.api.nvidia.com/v1",
    json: false,
  },
};

const ROLE_ENV_VAR: Record<Role, string> = {
  agent: "AGENT_PROVIDER",
  patient: "PATIENT_PROVIDER",
  judge: "JUDGE_PROVIDER",
  reflect: "REFLECT_PROVIDER",
};

function asProvider(value: string, source: string): ProviderName {
  const name = value.trim().toLowerCase();
  if (!PROVIDERS.includes(name as ProviderName)) {
    throw new ConfigError(
      `${source} is "${value}", which is not a known provider.\n` +
        `Valid values: ${PROVIDERS.join(", ")}`,
    );
  }
  return name as ProviderName;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function resolveRole(role: Role, fallback: ProviderName): ProviderConfig {
  const envVar = ROLE_ENV_VAR[role];
  const raw = process.env[envVar];
  const provider = raw ? asProvider(raw, envVar) : fallback;
  const spec = DEFAULTS[provider];

  const apiKey = process.env[spec.keyVar]?.trim();
  if (!apiKey) {
    throw new ConfigError(
      `The "${role}" role is set to provider "${provider}", but ` +
        `${spec.keyVar} is empty.\n` +
        `Set ${spec.keyVar} in med.ai/.env, or point ${envVar} at a provider ` +
        `you have a key for.`,
    );
  }

  // A per-role model override, e.g. GEMINI_MODEL_JUDGE. Gemini's free tier
  // caps requests per DAY per model, so giving each role its own model both
  // multiplies usable quota and means the judge is not grading output from
  // the same model that produced it.
  const roleModelVar = `${spec.modelVar}_${role.toUpperCase()}`;
  const model =
    process.env[roleModelVar]?.trim() ||
    process.env[spec.modelVar]?.trim() ||
    spec.model;

  return {
    provider,
    model,
    apiKey,
    baseURL:
      provider === "nvidia"
        ? process.env.NVIDIA_BASE_URL?.trim() || spec.baseURL
        : spec.baseURL,
    supportsJsonMode: spec.json,
    timeoutMs: positiveInt("REQUEST_TIMEOUT_MS", 60_000),
    maxRetries: positiveInt("MAX_RETRIES", 8),
    minGapMs: positiveInt("MIN_REQUEST_GAP_MS", provider === "gemini" ? 12_500 : 1),
  };
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}".`);
  }
  return n;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;

  const base = asProvider(process.env.LLM_PROVIDER ?? "gemini", "LLM_PROVIDER");

  cached = {
    roles: {
      agent: resolveRole("agent", base),
      patient: resolveRole("patient", base),
      judge: resolveRole("judge", base),
      reflect: resolveRole("reflect", base),
    },
    loopRounds: positiveInt("LOOP_ROUNDS", 1),
    concurrency: positiveInt("EVAL_CONCURRENCY", 4),
    resultsDir: process.env.RESULTS_DIR?.trim() || "results",
    lessonsPath: process.env.LESSONS_PATH?.trim() || "lessons.json",
    deterministicSafetyOnly:
      (process.env.DETERMINISTIC_SAFETY_ONLY ?? "").toLowerCase() === "true",
  };
  return cached;
}

/** One line per role, for the top of every report. */
export function describeConfig(cfg: Config = getConfig()): string {
  return (Object.keys(cfg.roles) as Role[])
    .map((r) => `${r}=${cfg.roles[r].provider}/${cfg.roles[r].model}`)
    .join("  ");
}
