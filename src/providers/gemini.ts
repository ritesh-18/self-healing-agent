import { GoogleGenAI, Type } from "@google/genai";
import type {
  CompletionRequest,
  CompletionResponse,
  LlmProvider,
  ToolSpec,
  Turn,
} from "./types.js";

/**
 * Gemini's schema dialect uses its own Type enum rather than raw JSON Schema
 * strings, so tool parameters are translated on the way in.
 */
function toGeminiSchema(node: unknown): Record<string, unknown> {
  if (typeof node !== "object" || node === null) return {};
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const typeMap: Record<string, unknown> = {
    object: Type.OBJECT,
    string: Type.STRING,
    number: Type.NUMBER,
    integer: Type.INTEGER,
    boolean: Type.BOOLEAN,
    array: Type.ARRAY,
  };
  if (typeof src.type === "string" && src.type in typeMap) {
    out.type = typeMap[src.type];
  }
  if (typeof src.description === "string") out.description = src.description;
  if (Array.isArray(src.enum)) out.enum = src.enum;
  if (Array.isArray(src.required)) out.required = src.required;
  if (src.items) out.items = toGeminiSchema(src.items);
  if (src.properties && typeof src.properties === "object") {
    out.properties = Object.fromEntries(
      Object.entries(src.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        toGeminiSchema(v),
      ]),
    );
  }
  return out;
}

function toGeminiContents(turns: Turn[]) {
  return turns.map((turn) => {
    if (turn.kind === "text") {
      return {
        role: turn.role === "assistant" ? "model" : "user",
        parts: [{ text: turn.text }],
      };
    }
    if (turn.kind === "tool_calls") {
      const parts: Record<string, unknown>[] = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const call of turn.calls) {
        // The thoughtSignature must be replayed on the SAME part it arrived
        // on, or Gemini 3.x rejects the request outright.
        const signature = call.providerMeta?.thoughtSignature;
        parts.push({
          functionCall: { name: call.name, args: call.args },
          ...(typeof signature === "string" ? { thoughtSignature: signature } : {}),
        });
      }
      return { role: "model", parts };
    }
    return {
      role: "user",
      parts: turn.results.map((r) => ({
        functionResponse: {
          name: r.name,
          // Gemini requires an object here; primitives get boxed.
          response:
            typeof r.content === "object" && r.content !== null
              ? (r.content as Record<string, unknown>)
              : { result: r.content },
        },
      })),
    };
  });
}

/** Transient server-side conditions that are worth retrying. */
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 503 || (status && status >= 500)) return true;

  const message = err instanceof Error ? err.message : String(err);
  return /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|\b(429|503|500)\b/i.test(
    message,
  );
}

/**
 * Gemini reports exactly how long to wait on a quota error, as a RetryInfo
 * detail and in the message text. Honouring it beats guessing: the free tier
 * allows 5 requests per minute, so a blind exponential backoff either gives up
 * far too early or waits much longer than required.
 */
function serverRetryDelayMs(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);

  const retryInfo = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (retryInfo?.[1]) return Math.ceil(Number(retryInfo[1]) * 1000);

  const prose = message.match(/retry in (\d+(?:\.\d+)?)s/i);
  if (prose?.[1]) return Math.ceil(Number(prose[1]) * 1000);

  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A process-wide request gate.
 *
 * The free tier's limit is per project, not per model or per connection, so
 * concurrency has to be throttled globally rather than per provider instance.
 * Requests are serialised and spaced; without this, parallel scenarios simply
 * burn the whole quota on retries.
 */
let gate: Promise<void> = Promise.resolve();

function schedule<T>(fn: () => Promise<T>, minGapMs: number): Promise<T> {
  const run = gate.then(fn);
  // The next caller waits for this one to finish, plus the spacing interval.
  // Both branches wait, so a failed request still holds the line open.
  gate = run.then(
    async () => void (await sleep(minGapMs)),
    async () => void (await sleep(minGapMs)),
  );
  return run;
}

export function createGeminiProvider(opts: {
  apiKey: string;
  model: string;
  maxRetries?: number;
  /** Minimum spacing between requests. Free tier allows 5 per minute. */
  minGapMs?: number;
}): LlmProvider {
  const client = new GoogleGenAI({ apiKey: opts.apiKey });
  const maxRetries = opts.maxRetries ?? 8;
  const minGapMs = opts.minGapMs ?? 12_500;

  return {
    name: "gemini",
    model: opts.model,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const config: Record<string, unknown> = {
        systemInstruction: req.system,
        temperature: req.temperature ?? 0.3,
      };
      if (req.tools?.length) {
        config.tools = [
          {
            functionDeclarations: req.tools.map((t: ToolSpec) => ({
              name: t.name,
              description: t.description,
              parameters: toGeminiSchema(t.parameters),
            })),
          },
        ];
      }
      if (req.json) config.responseMimeType = "application/json";

      // The free tier returns 429/503 under load often enough that a suite
      // run will not finish without this. Exponential backoff with jitter so
      // concurrent scenarios do not retry in lockstep.
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await schedule(
            () =>
              client.models.generateContent({
                model: opts.model,
                contents: toGeminiContents(req.turns),
                config,
              }),
            minGapMs,
          );
          break;
        } catch (err) {
          if (attempt >= maxRetries || !isRetryable(err)) throw err;
          // Prefer the server's own figure; fall back to exponential backoff
          // with jitter so retries do not synchronise.
          const wait =
            serverRetryDelayMs(err) ?? 2 ** attempt * 1000 + Math.random() * 500;
          await sleep(wait);
        }
      }

      // res.functionCalls drops thoughtSignature, so the raw parts are read
      // directly: the signature lives beside the functionCall, not inside it.
      const parts = (res.candidates?.[0]?.content?.parts ?? []) as {
        functionCall?: { name?: string; args?: Record<string, unknown> };
        thoughtSignature?: string;
      }[];

      const calls = parts.flatMap((part, i) => {
        if (!part.functionCall) return [];
        return [
          {
            id: `${part.functionCall.name ?? "tool"}_${i}`,
            name: part.functionCall.name ?? "",
            args: part.functionCall.args ?? {},
            ...(part.thoughtSignature
              ? { providerMeta: { thoughtSignature: part.thoughtSignature } }
              : {}),
          },
        ];
      });

      return { text: res.text ?? "", calls };
    },
  };
}
