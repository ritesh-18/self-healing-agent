import type {
  CompletionRequest,
  CompletionResponse,
  LlmProvider,
  ToolCall,
} from "./types.js";

/**
 * A scripted provider for testing the system without a network or a quota.
 *
 * Because every role sits behind the same LlmProvider interface, this lets the
 * runner, judge, verifier, reflector, trial and queue all execute end to end
 * with no API key. That matters for two reasons: the improvement loop becomes
 * testable in CI, and a free-tier daily cap stops being the thing that decides
 * whether the loop can be demonstrated at all.
 *
 * What it proves: the plumbing. Classification routing, the regression gate,
 * the queue state machine, positional judge alignment.
 *
 * What it cannot prove: that a real model behaves well. Scripted responses are
 * chosen by the test author, so a green run here says the machinery works, not
 * that the agent is good. Both kinds of evidence are needed, and the design
 * note should say which is which.
 */

/** One scripted reply. Either plain text or a set of tool calls. */
export interface FakeReply {
  text?: string;
  calls?: { name: string; args: Record<string, unknown> }[];
}

/**
 * Decides what to reply given the request. Returning undefined falls through
 * to the next rule, so specific rules can be layered over a default.
 */
export type FakeRule = (req: CompletionRequest) => FakeReply | undefined;

export interface FakeProviderOptions {
  name?: string;
  model?: string;
  /** Evaluated in order; the first match wins. */
  rules?: FakeRule[];
  /** Used when no rule matches. */
  fallback?: FakeReply;
  /** Records every request, for assertions about what was asked. */
  log?: CompletionRequest[];
}

let callCounter = 0;

export function createFakeProvider(
  opts: FakeProviderOptions = {},
): LlmProvider {
  const rules = opts.rules ?? [];
  const fallback = opts.fallback ?? { text: "OK." };

  return {
    name: opts.name ?? "fake",
    model: opts.model ?? "fake-1",
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      opts.log?.push(req);

      let reply: FakeReply | undefined;
      for (const rule of rules) {
        reply = rule(req);
        if (reply) break;
      }
      reply ??= fallback;

      const calls: ToolCall[] = (reply.calls ?? []).map((c) => ({
        id: `fake_${c.name}_${callCounter++}`,
        name: c.name,
        args: c.args,
      }));

      return { text: reply.text ?? "", calls };
    },
  };
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

/** Matches when the last user message contains `needle` (case-insensitive). */
export function whenUserSays(needle: string, reply: FakeReply): FakeRule {
  return (req) => {
    const lastText = [...req.turns]
      .reverse()
      .find((t) => t.kind === "text" && t.role === "user");
    if (lastText?.kind !== "text") return undefined;
    return lastText.text.toLowerCase().includes(needle.toLowerCase())
      ? reply
      : undefined;
  };
}

/** Matches when the system prompt contains `needle` — useful to pick a role. */
export function whenSystemHas(needle: string, reply: FakeReply): FakeRule {
  return (req) =>
    req.system.toLowerCase().includes(needle.toLowerCase()) ? reply : undefined;
}

/** Matches once the named tool has already returned a result. */
export function afterToolResult(name: string, reply: FakeReply): FakeRule {
  return (req) =>
    req.turns.some(
      (t) => t.kind === "tool_results" && t.results.some((r) => r.name === name),
    )
      ? reply
      : undefined;
}

/** Replies with successive scripted turns, one per call. */
export function sequence(replies: FakeReply[]): FakeRule {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)];
}

// ---------------------------------------------------------------------------
// Ready-made role providers
// ---------------------------------------------------------------------------

/** A judge that passes or fails every rubric item, with aligned verdicts. */
export function fakeJudge(allPass: boolean, why = "scripted"): LlmProvider {
  return createFakeProvider({
    name: "fake-judge",
    rules: [
      (req) => {
        const text = req.turns
          .map((t) => (t.kind === "text" ? t.text : ""))
          .join("\n");
        // Count rubric items so the verdict array aligns positionally.
        const items = text.match(/^\d+\.\s+.+$/gm) ?? [];
        return {
          text: JSON.stringify({
            verdicts: items.map((line) => ({
              item: line.replace(/^\d+\.\s+/, ""),
              pass: allPass,
              why,
            })),
          }),
        };
      },
    ],
  });
}

/** A verifier returning a fixed classification. */
export function fakeVerifier(verdict: {
  real?: boolean;
  classification: "behavioural" | "structural" | "harness";
  diagnosis?: string;
  proposedCodeChange?: string;
  confidence?: "low" | "medium" | "high";
}): LlmProvider {
  return createFakeProvider({
    name: "fake-verifier",
    fallback: {
      text: JSON.stringify({
        real: verdict.real ?? true,
        classification: verdict.classification,
        diagnosis: verdict.diagnosis ?? "scripted diagnosis",
        ...(verdict.proposedCodeChange
          ? { proposedCodeChange: verdict.proposedCodeChange }
          : {}),
        confidence: verdict.confidence ?? "high",
      }),
    },
  });
}

/** A reflector returning a fixed rule. */
export function fakeReflector(rule: string, dimension = "scripted"): LlmProvider {
  return createFakeProvider({
    name: "fake-reflector",
    fallback: {
      text: JSON.stringify({ dimension, rule, rationale: "scripted" }),
    },
  });
}

/** A patient that speaks each line in turn, then ends the call. */
export function fakePatient(lines: string[]): LlmProvider {
  let i = 0;
  return createFakeProvider({
    name: "fake-patient",
    rules: [
      () => {
        const line = lines[i++];
        return line === undefined
          ? { text: "Thanks, bye. [END_CALL]" }
          : { text: line };
      },
    ],
  });
}
