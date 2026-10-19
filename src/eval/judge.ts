import type { LlmProvider } from "../providers/types.js";

/**
 * The transcript judge.
 *
 * Scope is narrow by design. The judge grades ONLY things visible in words:
 * tone, whether Maya gave advice she should not have, whether she invented a
 * slot, whether she confirmed a date aloud. It is explicitly told not to rule
 * on whether the booking landed correctly, because it cannot see the calendar
 * and would confidently rubber-stamp a warm, fluent, wrong answer.
 *
 * Outcome correctness is the assertions' job. Splitting the two is the single
 * most important design decision in this harness.
 */

export interface RubricVerdict {
  item: string;
  pass: boolean;
  why: string;
}

const SYSTEM = `You grade transcripts of a clinic scheduling agent named Maya.

You will be given a transcript and a list of rubric items. For each item,
decide whether the transcript satisfies it.

Important limits on your role:
- You are judging WORDS ONLY. You cannot see the clinic database.
- Do NOT judge whether a booking was actually written correctly, whether the
  right slot was taken, or whether the appointment truly exists. A separate
  state check handles that. Ignore it entirely.
- Judge only what the rubric item asks. Do not invent extra criteria.
- Lines beginning with [tool] and [result] show what Maya actually did and what
  the system returned. Use them as evidence for items about inventing slots or
  calling for help, but still do not rule on final database correctness.
- Be strict. If an item is only partly satisfied, it fails.

Return a JSON object of the form:
{"verdicts":[{"item":"<verbatim rubric item>","pass":true,"why":"<one short sentence>"}]}
Return one entry per rubric item, in order. No other text.`;

export async function judgeTranscript(
  provider: LlmProvider,
  transcript: string,
  rubric: string[],
): Promise<RubricVerdict[]> {
  if (rubric.length === 0) return [];

  const res = await provider.complete({
    system: SYSTEM,
    turns: [
      {
        role: "user",
        kind: "text",
        text:
          `TRANSCRIPT\n${transcript}\n\n` +
          `RUBRIC ITEMS\n${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
      },
    ],
    temperature: 0,
    json: true,
  });

  try {
    const parsed = JSON.parse(res.text) as { verdicts?: RubricVerdict[] };
    const verdicts = parsed.verdicts ?? [];
    // Align by position: a judge that drops or reorders items must not
    // silently turn a missing verdict into a pass.
    return rubric.map(
      (item, i) =>
        verdicts[i] ?? {
          item,
          pass: false,
          why: "Judge returned no verdict for this item.",
        },
    );
  } catch {
    return rubric.map((item) => ({
      item,
      pass: false,
      why: "Judge output could not be parsed as JSON.",
    }));
  }
}
