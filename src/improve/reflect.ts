import type { Lesson } from "../agent/prompt.js";
import type { LlmProvider } from "../providers/types.js";
import type { ScenarioResult } from "../eval/runner.js";
import { SCENARIOS } from "../eval/scenarios.js";

/**
 * The reflector: failure in, behavioural rule out.
 *
 * Constraints that matter, and why:
 *
 *  - It may only emit rules, never rewrite the base prompt. The hand-authored
 *    guardrails are not the system's to edit; keeping lessons additive means a
 *    bad lesson is one line to revert rather than a prompt to reconstruct.
 *  - Rules must be general. "Book Radhika on Wednesday" would pass the failing
 *    scenario and teach nothing; it is overfitting dressed as learning.
 *  - Rules must not contradict existing lessons. Left unchecked this is how a
 *    self-improving loop oscillates: fix A breaks B, fix B breaks A.
 */

const SYSTEM = `You improve a clinic scheduling agent called Maya by writing
behavioural rules derived from her failures.

You are given: the scenario, what the check expected, and the transcript of the
failing run. You output ONE rule that would prevent this class of failure.

Hard constraints:
- The rule must be GENERAL. It must describe a behaviour, not a specific
  patient, date, or clinician from this transcript. A rule that only fixes this
  exact call is worthless.
- The rule must be ACTIONABLE and testable. "Be more careful" is useless.
  "Before calling book_appointment, state the full calendar date and wait for
  the patient to confirm" is useful.
- The rule must not contradict any existing rule you are shown.
- The rule must not weaken safety. Never write a rule that makes Maya more
  willing to discuss clinical matters or skip verification.
- Keep it to one or two sentences, phrased as an instruction to Maya.

Return JSON only:
{"dimension":"<short label e.g. date-confirmation, escalation, authorisation>",
 "rule":"<the rule>",
 "rationale":"<one sentence on the failure it addresses>"}`;

export interface Reflection {
  dimension: string;
  rule: string;
  rationale: string;
}

export async function reflectOnFailure(
  provider: LlmProvider,
  result: ScenarioResult,
  existing: Lesson[],
): Promise<Reflection | null> {
  const scenario = SCENARIOS.find((s) => s.id === result.id);
  if (!scenario) return null;

  const expected = [
    ...result.assertions
      .filter((a) => !a.pass)
      .map((a) => `- STATE CHECK FAILED: ${a.describe}`),
    ...result.rubric
      .filter((r) => !r.pass)
      .map((r) => `- RUBRIC FAILED: ${r.item} (judge: ${r.why})`),
  ].join("\n");

  const existingRules = existing.length
    ? existing.map((l, i) => `${i + 1}. ${l.rule}`).join("\n")
    : "(none yet)";

  const res = await provider.complete({
    system: SYSTEM,
    turns: [
      {
        role: "user",
        kind: "text",
        text:
          `SCENARIO: ${scenario.title}\n` +
          `WHAT IT PROBES: ${scenario.probes}\n\n` +
          `WHAT FAILED\n${expected}\n\n` +
          `EXISTING RULES (do not contradict)\n${existingRules}\n\n` +
          `TRANSCRIPT\n${result.transcript}`,
      },
    ],
    temperature: 0.2,
    json: true,
  });

  try {
    const parsed = JSON.parse(res.text) as Partial<Reflection>;
    if (!parsed.rule?.trim()) return null;
    return {
      dimension: parsed.dimension?.trim() || "general",
      rule: parsed.rule.trim(),
      rationale: parsed.rationale?.trim() || "",
    };
  } catch {
    return null;
  }
}

/** Wraps a reflection as a stored lesson. */
export function toLesson(
  scenarioId: string,
  reflection: Reflection,
): Lesson {
  return {
    from: scenarioId,
    dimension: reflection.dimension,
    rule: reflection.rule,
    addedAt: new Date().toISOString(),
  };
}
