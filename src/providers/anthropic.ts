import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionRequest,
  CompletionResponse,
  LlmProvider,
  Turn,
} from "./types.js";

type Message = Anthropic.Messages.MessageParam;

function toAnthropicMessages(turns: Turn[]): Message[] {
  return turns.map((turn): Message => {
    if (turn.kind === "text") {
      return { role: turn.role, content: turn.text };
    }
    if (turn.kind === "tool_calls") {
      const content: Anthropic.Messages.ContentBlockParam[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const c of turn.calls) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      }
      return { role: "assistant", content };
    }
    return {
      role: "user",
      content: turn.results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: JSON.stringify(r.content),
      })),
    };
  });
}

export function createAnthropicProvider(opts: {
  apiKey: string;
  model: string;
}): LlmProvider {
  const client = new Anthropic({ apiKey: opts.apiKey });

  return {
    name: "anthropic",
    model: opts.model,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const turns = toAnthropicMessages(req.turns);

      // Anthropic has no JSON response mode; prefilling an open brace is the
      // documented way to force a bare JSON object out of the model.
      if (req.json) turns.push({ role: "assistant", content: "{" });

      const res = await client.messages.create({
        model: opts.model,
        max_tokens: 2048,
        temperature: req.temperature ?? 0.3,
        system: req.system,
        messages: turns,
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
              })),
            }
          : {}),
      });

      let text = res.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (req.json) text = `{${text}`;

      const calls = res.content
        .filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          name: b.name,
          args: (b.input ?? {}) as Record<string, unknown>,
        }));

      return { text, calls };
    },
  };
}
