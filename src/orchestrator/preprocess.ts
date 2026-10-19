import type { LlmProvider } from "../providers/types.js";

/**
 * Relevance and intent.
 *
 * This runs after the safety screen and before the agent acts. Its job is
 * narrow on purpose: decide whether the utterance is something a scheduling
 * assistant can act on, and if not, whether the right move is to clarify or to
 * close the call.
 *
 * Deciding WHICH tool to call is not this layer's job. The agent does that
 * with the whole conversation in view, and does it better - at turn 6 the
 * caller says "Yes", and only the agent knows what it just asked. What this
 * layer contributes is the thing the agent cannot judge about itself: whether
 * the conversation is going nowhere.
 */

export type Relevance = "actionable" | "ambiguous" | "irrelevant";

export type Intent =
  | "book"
  | "reschedule"
  | "cancel"
  | "enquire"
  | "register"
  | "other";

export interface PreprocessResult {
  relevance: Relevance;
  intent: Intent;
  /** Anything worth carrying forward: dates, clinician names, reasons. */
  entities: Record<string, string>;
  reason: string;
}

const SYSTEM = `You triage one utterance from a caller to a clinic's scheduling
line. You do not answer them and you do not decide which tool to use.

Classify relevance:
- "actionable": the caller has given something a scheduler can act on now.
- "ambiguous": on-topic for scheduling, but a detail is missing or unclear.
  A caller answering a question you asked is actionable, not ambiguous.
- "irrelevant": nothing to do with appointments or this clinic's scheduling.

Classify intent: book, reschedule, cancel, enquire, register, other.

Extract any entities present: date, time, clinician, reason, name, dob, phone.
Only include what the caller actually said. Never infer a date.

Return JSON only:
{"relevance":"actionable|ambiguous|irrelevant",
 "intent":"book|reschedule|cancel|enquire|register|other",
 "entities":{},
 "reason":"<a few words>"}`;

export async function preprocess(
  text: string,
  provider: LlmProvider,
): Promise<PreprocessResult> {
  try {
    const res = await provider.complete({
      system: SYSTEM,
      turns: [{ role: "user", kind: "text", text }],
      temperature: 0,
      json: true,
    });

    const parsed = JSON.parse(res.text) as Partial<PreprocessResult>;
    const relevances: Relevance[] = ["actionable", "ambiguous", "irrelevant"];
    const intents: Intent[] = [
      "book",
      "reschedule",
      "cancel",
      "enquire",
      "register",
      "other",
    ];

    return {
      // A failed or unrecognised classification must not silently become
      // "irrelevant" - that would hang up on a caller for a parser bug.
      relevance: relevances.includes(parsed.relevance as Relevance)
        ? (parsed.relevance as Relevance)
        : "actionable",
      intent: intents.includes(parsed.intent as Intent)
        ? (parsed.intent as Intent)
        : "other",
      entities:
        parsed.entities && typeof parsed.entities === "object"
          ? (parsed.entities as Record<string, string>)
          : {},
      reason: parsed.reason || "classified",
    };
  } catch {
    return {
      relevance: "actionable",
      intent: "other",
      entities: {},
      reason: "preprocess unavailable; passing through",
    };
  }
}

/**
 * Tracks whether a conversation is going anywhere.
 *
 * Two counters, not one. Conflating them hangs up on cooperative callers:
 * "what day suits you?" is normal conversation, and charging it against a
 * three-strike counter ends legitimate calls.
 */
export class FallbackTracker {
  private irrelevant = 0;
  private ambiguous = 0;

  constructor(
    private readonly irrelevantLimit = 3,
    private readonly ambiguousLimit = 4,
  ) {}

  record(relevance: Relevance): void {
    if (relevance === "irrelevant") this.irrelevant++;
    else if (relevance === "ambiguous") this.ambiguous++;
    else {
      // Progress resets the ambiguity budget but not the irrelevance one:
      // a caller repeatedly going off-topic is a different situation from
      // one who needed a couple of details pinned down.
      this.ambiguous = 0;
    }
  }

  get exhausted(): boolean {
    return (
      this.irrelevant >= this.irrelevantLimit ||
      this.ambiguous >= this.ambiguousLimit
    );
  }

  get counts(): { irrelevant: number; ambiguous: number } {
    return { irrelevant: this.irrelevant, ambiguous: this.ambiguous };
  }

  get exhaustionReason(): string {
    if (this.irrelevant >= this.irrelevantLimit) {
      return `${this.irrelevant} off-topic turns without progress`;
    }
    if (this.ambiguous >= this.ambiguousLimit) {
      return `${this.ambiguous} clarifications without progress`;
    }
    return "";
  }
}
