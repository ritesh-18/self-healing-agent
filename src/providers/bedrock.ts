import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import type {
  CompletionRequest,
  CompletionResponse,
  LlmProvider,
  Turn,
} from "./types.js";

/**
 * AWS Bedrock, via the Converse API.
 *
 * Converse normalises tool use across every model Bedrock hosts, so one
 * adapter serves Claude, Nova, DeepSeek, Mistral and the rest. That is worth
 * more here than a per-vendor adapter would be: the eval harness wants to run
 * the agent on one model and the judge on another, and this makes that a
 * config change rather than new code.
 *
 * Two model-specific quirks are handled centrally rather than leaking upward:
 * reasoning preambles and DeepSeek's internal token markers. Both would
 * otherwise reach the transcript and the judge would grade formatting noise
 * instead of behaviour.
 */

/**
 * Strips reasoning scaffolding from a model's visible text.
 *
 * Nova emits <thinking> blocks; DeepSeek emits full-width pipe markers around
 * internal tokens. Neither is addressed to the caller, and a transcript
 * containing them is both wrong to read aloud and misleading to grade.
 */
export function cleanText(text: string): string {
  return (
    text
      // Reasoning blocks, closed or truncated by a token limit.
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
      .replace(/<thinking>[\s\S]*$/gi, "")
      // DeepSeek control markers, e.g. <｜tool▁calls▁begin｜>.
      .replace(/<[｜|][^>]*[｜|]>/g, "")
      // DeepSeek also leaks a bare, often truncated, DSML preamble alongside
      // a correctly-structured toolUse block. Observed live as
      // "<DSMLfunction_calls" with no closing bracket, so this cuts from the
      // marker to the end rather than matching a complete tag.
      .replace(/<\s*\/?\s*DSML[\s\S]*$/gi, "")
      .replace(/[｜▁]/g, "")
      .trim()
  );
}

function toBedrockMessages(turns: Turn[]): Message[] {
  const messages: Message[] = [];

  for (const turn of turns) {
    if (turn.kind === "text") {
      messages.push({
        role: turn.role === "assistant" ? "assistant" : "user",
        content: [{ text: turn.text }],
      });
      continue;
    }

    if (turn.kind === "tool_calls") {
      const content: ContentBlock[] = [];
      if (turn.text) content.push({ text: turn.text });
      for (const c of turn.calls) {
        content.push({
          toolUse: {
            toolUseId: c.id,
            name: c.name,
            // DocumentType models arbitrary JSON; our args already are that.
            input: c.args as DocumentType,
          },
        } as ContentBlock);
      }
      messages.push({ role: "assistant", content });
      continue;
    }

    messages.push({
      role: "user",
      content: turn.results.map(
        (r) =>
          ({
            toolResult: {
              toolUseId: r.id,
              content: [{ json: asJsonObject(r.content) as DocumentType }],
            },
          }) as ContentBlock,
      ),
    });
  }

  return messages;
}

/** Converse requires a JSON object in a toolResult; primitives get boxed. */
function asJsonObject(content: unknown): Record<string, unknown> {
  return typeof content === "object" && content !== null
    ? (content as Record<string, unknown>)
    : { result: content };
}

/** Transient conditions worth retrying. */
function isRetryable(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  if (
    /Throttling|TooManyRequests|ServiceUnavailable|ModelTimeout|Internal/i.test(
      name,
    )
  ) {
    return true;
  }
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  return status === 429 || (status !== undefined && status >= 500);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createBedrockProvider(opts: {
  modelId: string;
  region: string;
  maxRetries?: number;
  timeoutMs?: number;
}): LlmProvider {
  const client = new BedrockRuntimeClient({
    region: opts.region,
    requestHandler: { requestTimeout: opts.timeoutMs ?? 60_000 },
  });
  const maxRetries = opts.maxRetries ?? 4;

  return {
    name: "bedrock",
    model: opts.modelId,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const tools: Tool[] | undefined = req.tools?.length
        ? req.tools.map(
            (t) =>
              ({
                toolSpec: {
                  name: t.name,
                  description: t.description,
                  inputSchema: { json: t.parameters as DocumentType },
                },
              }) as Tool,
          )
        : undefined;

      // Converse has no JSON mode, so the instruction goes in the system
      // prompt and extraction happens on the way out.
      const system = req.json
        ? `${req.system}\n\nRespond with a single raw JSON object and nothing else. No prose, no markdown fences.`
        : req.system;

      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await client.send(
            new ConverseCommand({
              modelId: opts.modelId,
              messages: toBedrockMessages(req.turns),
              system: [{ text: system }],
              ...(tools ? { toolConfig: { tools } } : {}),
              inferenceConfig: {
                maxTokens: 2048,
                temperature: req.temperature ?? 0.3,
              },
            }),
          );
          break;
        } catch (err) {
          if (attempt >= maxRetries || !isRetryable(err)) throw err;
          await sleep(2 ** attempt * 1000 + Math.random() * 500);
        }
      }

      const blocks = res.output?.message?.content ?? [];

      const rawText = blocks
        .filter((b): b is ContentBlock.TextMember => "text" in b)
        .map((b) => b.text)
        .join("");

      const text = req.json
        ? extractJson(cleanText(rawText))
        : cleanText(rawText);

      const calls = blocks
        .filter((b): b is ContentBlock.ToolUseMember => "toolUse" in b)
        .map((b, i) => ({
          id: b.toolUse?.toolUseId ?? `tool_${i}`,
          name: b.toolUse?.name ?? "",
          args: (b.toolUse?.input ?? {}) as Record<string, unknown>,
        }));

      return { text, calls };
    },
  };
}

/** Pulls the first balanced JSON object out of a reply. */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;

  const start = trimmed.indexOf("{");
  if (start === -1) return trimmed;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return trimmed.slice(start, i + 1);
  }
  return trimmed.slice(start);
}
