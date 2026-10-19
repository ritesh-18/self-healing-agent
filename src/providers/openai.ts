import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResponse,
  LlmProvider,
  Turn,
} from "./types.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Pulls the first balanced JSON object out of a reply. Handles fenced blocks
 * and leading commentary, both common from reasoning models.
 */
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

function toOpenAiMessages(system: string, turns: Turn[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: system }];

  for (const turn of turns) {
    if (turn.kind === "text") {
      messages.push({ role: turn.role, content: turn.text });
    } else if (turn.kind === "tool_calls") {
      messages.push({
        role: "assistant",
        content: turn.text ?? null,
        tool_calls: turn.calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
    } else {
      // Each tool result is its own message, keyed back to the call id.
      for (const r of turn.results) {
        messages.push({
          role: "tool",
          tool_call_id: r.id,
          content: JSON.stringify(r.content),
        });
      }
    }
  }
  return messages;
}

/**
 * Also serves any OpenAI-compatible endpoint. NVIDIA NIM (which is how we
 * reach DeepSeek) speaks the same wire format, so it needs a base URL and a
 * label rather than a whole separate adapter.
 */
export function createOpenAiProvider(opts: {
  apiKey: string;
  model: string;
  baseURL?: string;
  label?: string;
  /** NIM rejects response_format on some models; extractJson covers us. */
  supportsJsonMode?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
}): LlmProvider {
  // Free NIM endpoints stall outright rather than erroring, so a request
  // timeout is mandatory here: without one a single hung call blocks the whole
  // suite forever. Retries cover the intermittent hangs we measured (~1 in 3).
  const client = new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    timeout: opts.timeoutMs ?? 60_000,
    maxRetries: opts.maxRetries ?? 4,
  });

  return {
    name: opts.label ?? "openai",
    model: opts.model,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      // Without native JSON mode the instruction has to live in the prompt.
      const system =
        req.json && opts.supportsJsonMode === false
          ? `${req.system}\n\nRespond with a single raw JSON object and nothing else. No prose, no markdown fences.`
          : req.system;

      const res = await client.chat.completions.create({
        model: opts.model,
        messages: toOpenAiMessages(system, req.turns),
        temperature: req.temperature ?? 0.3,
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function" as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
            }
          : {}),
        ...(req.json && opts.supportsJsonMode !== false
          ? { response_format: { type: "json_object" as const } }
          : {}),
      });

      const choice = res.choices[0]?.message;
      // Reasoning models on NIM often wrap JSON in prose or a fenced block
      // even when asked not to. Recover the object rather than failing the
      // judge, which would silently turn every rubric item into a failure.
      let text = choice?.content ?? "";
      if (req.json) text = extractJson(text);
      const calls = (choice?.tool_calls ?? []).flatMap((c) => {
        if (c.type !== "function") return [];
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.function.arguments || "{}");
        } catch {
          // A malformed argument blob is a real agent failure; surface it as
          // empty args and let the tool layer reject it rather than throwing.
        }
        return [{ id: c.id, name: c.function.name, args }];
      });

      return { text, calls };
    },
  };
}
