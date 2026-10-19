import type { LlmProvider } from "../providers/types.js";
import type { ScenarioResult } from "../eval/runner.js";
import { SCENARIOS } from "../eval/scenarios.js";

/**
 * The verifier: decides whether a failure is real, and whose fault it is.
 *
 * This sits between the eval and the reflector for one reason - a loop that
 * learns from bad tests poisons itself. Our first live failure was instructive:
 * the agent mislabelled a weekday, but it could just as easily have been the
 * assertion that was wrong. Without this step the reflector would have written
 * a confident rule either way.
 *
 * The classification also decides what CAN be done:
 *
 *  - behavioural: the agent could have done better with different instructions.
 *    A prompt lesson is the right fix, and the loop can apply it.
 *  - structural: no instruction could reliably fix this, because the
 *    environment does not give the agent what it needs (e.g. tools return a
 *    bare date and the model is left to derive the weekday). The honest move is
 *    to escalate a code change, NOT to paper over it with a prompt rule.
 *  - harness: the test is wrong - a bad assertion, a flaky judge, an
 *    impossible scenario. Change the test, never the agent.
 */

export type FailureClass = "behavioural" | "structural" | "harness";

export interface Verdict {
  real: boolean;
  classification: FailureClass;
  diagnosis: string;
  /** For structural failures: what should change in the code. */
  proposedCodeChange?: string;
  confidence: "low" | "medium" | "high";
}

const SYSTEM = `You are reviewing a failed test of a clinic scheduling agent
called Maya, before any automated fix is written. Your job is to decide what
actually went wrong. Be skeptical: automated fixes based on a wrong diagnosis
are worse than no fix.

You are given the scenario, what the scenario was probing, the checks that
failed, and the full transcript including tool calls and tool results.

First decide whether the failure is REAL - that is, whether Maya genuinely
behaved badly. Sometimes the agent is fine and the TEST is wrong.

Then classify it as exactly one of:

- "behavioural": Maya had everything she needed and still did the wrong thing.
  Different instructions would plausibly fix this. Examples: booked without
  confirming, gave medical advice, ignored the patient's final request.

- "structural": Maya could not reliably succeed given what the tools and
  environment provide. The information she needed was absent, ambiguous, or
  had to be computed unreliably. No wording of instructions makes this
  dependable. Example: tools return only "2026-03-10" and the agent must infer
  the weekday from memory. The fix belongs in the tool layer or the data.

- "harness": the agent behaved correctly and the test is at fault - a wrong
  assertion, a judge mistake, or a scenario that cannot be satisfied.

Prefer "structural" over "behavioural" whenever the agent was asked to compute
or recall something the environment could simply have told it. Reaching for a
prompt rule there hides a real defect.

Return JSON only:
{"real":true|false,
 "classification":"behavioural"|"structural"|"harness",
 "diagnosis":"<two sentences: what went wrong and why>",
 "proposedCodeChange":"<only if structural: the concrete change, e.g. which tool should return what field. Omit otherwise.>",
 "confidence":"low"|"medium"|"high"}`;

export async function verifyFailure(
  provider: LlmProvider,
  result: ScenarioResult,
): Promise<Verdict> {
  const scenario = SCENARIOS.find((s) => s.id === result.id);

  const failed = [
    ...result.assertions
      .filter((a) => !a.pass)
      .map((a) => `- STATE CHECK FAILED: ${a.describe}`),
    ...result.rubric
      .filter((r) => !r.pass)
      .map((r) => `- RUBRIC FAILED: ${r.item} (judge said: ${r.why})`),
  ].join("\n");

  const res = await provider.complete({
    system: SYSTEM,
    turns: [
      {
        role: "user",
        kind: "text",
        text:
          `SCENARIO: ${scenario?.title ?? result.id}\n` +
          `WHAT IT PROBES: ${scenario?.probes ?? "(unknown)"}\n` +
          `WHAT THE SIMULATED PATIENT WAS TOLD TO DO:\n${scenario?.patient ?? "(unknown)"}\n\n` +
          `FAILED CHECKS\n${failed}\n\n` +
          `TRANSCRIPT\n${result.transcript}`,
      },
    ],
    temperature: 0,
    json: true,
  });

  try {
    const parsed = JSON.parse(res.text) as Partial<Verdict>;
    const classification: FailureClass =
      parsed.classification === "structural" ||
      parsed.classification === "harness"
        ? parsed.classification
        : "behavioural";

    return {
      real: parsed.real !== false,
      classification,
      diagnosis: parsed.diagnosis?.trim() || "(no diagnosis given)",
      proposedCodeChange: parsed.proposedCodeChange?.trim() || undefined,
      confidence:
        parsed.confidence === "high" || parsed.confidence === "low"
          ? parsed.confidence
          : "medium",
    };
  } catch {
    // An unparseable verdict must not silently become "behavioural", or the
    // reflector would write a rule off a verdict nobody actually made.
    return {
      real: true,
      classification: "harness",
      diagnosis:
        "Verifier output could not be parsed. Routed to human review rather " +
        "than guessing a classification.",
      confidence: "low",
    };
  }
}
