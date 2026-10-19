import type { LlmProvider } from "../providers/types.js";

/**
 * The safety classifier.
 *
 * Runs on every caller utterance, before anything else, and has authority to
 * bypass the whole pipeline. Two reasons it is a separate pass rather than a
 * prompt instruction:
 *
 *  - A missed escalation is unrecoverable. Every other failure is a bad call
 *    the patient can retry; chest pain routed into a booking flow may not get
 *    a second attempt.
 *  - Inside a system prompt it competes for attention with a dozen other
 *    instructions. As its own pass it is independently testable and cannot be
 *    crowded out.
 *
 * It must run BEFORE relevance. An emergency is not a relevant scheduling
 * query, so a relevance gate running first would classify "my chest has been
 * tight since last night" as off-topic and spend a clarification on a cardiac
 * event.
 */

export type SafetyClass =
  | "none"
  | "emergency"
  | "self_harm"
  | "clinical_question";

export interface SafetyVerdict {
  classification: SafetyClass;
  /** Verbatim phrase that triggered it, for the escalation record. */
  trigger?: string;
  reason: string;
}

/**
 * Deterministic pre-filter.
 *
 * Runs before the model so the highest-severity phrases never depend on an
 * LLM call succeeding. This is a floor, not a ceiling: it catches the obvious
 * cases even if the provider is down, and the model catches the phrasings a
 * keyword list cannot anticipate.
 */
const EMERGENCY_PATTERNS: { re: RegExp; reason: string }[] = [
  // Allows intervening words within the same clause: "chest is tight",
  // "chest has been tight since last night". Stops at sentence boundaries so
  // it cannot span two unrelated statements.
  {
    re: /\bchest\b[^.?!]{0,30}?(pain|tight|pressure|hurt|heavy|crushing)/i,
    reason: "possible cardiac event",
  },
  {
    // The symptom word can precede the body part: "a tight feeling in my
    // chest". Observed live, where this phrasing was missed entirely and the
    // model then under-classified it as a clinical question.
    re: /\b(pain|pressure|tight\w*|heavy|heaviness|crushing|discomfort)\b[^.?!]{0,25}?\bchest\b/i,
    reason: "possible cardiac event",
  },
  { re: /\b(can'?t|cannot|trouble|difficulty) breath/i, reason: "respiratory distress" },
  { re: /\bshort(ness)? of breath\b/i, reason: "respiratory distress" },
  { re: /\b(one side|left side|right side).{0,20}\b(weak|numb)/i, reason: "possible stroke" },
  { re: /\bslurred speech\b/i, reason: "possible stroke" },
  { re: /\b(severe|heavy|won'?t stop) bleeding\b/i, reason: "severe bleeding" },
  { re: /\bbleeding (heavily|badly|a lot)\b/i, reason: "severe bleeding" },
  { re: /\banaphyla/i, reason: "severe allergic reaction" },
  { re: /\bthroat (closing|swelling)\b/i, reason: "severe allergic reaction" },
  { re: /\bunconscious|passed out|fainted\b/i, reason: "loss of consciousness" },
];

const SELF_HARM_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\bkill myself\b/i, reason: "suicidal ideation" },
  { re: /\b(end|ending) (my|it all)\b.{0,10}\b(life)?\b/i, reason: "suicidal ideation" },
  { re: /\bsuicidal?\b/i, reason: "suicidal ideation" },
  { re: /\bharm(ing)? myself\b/i, reason: "self-harm" },
  { re: /\bdon'?t want to (live|be here)\b/i, reason: "suicidal ideation" },
];

const CLINICAL_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(should|can) i (stop|start|take|skip)\b.{0,30}\b(tablet|pill|medication|medicine|dose|dosage)/i, reason: "medication advice" },
  { re: /\b(is|are) (this|these|it|they) (serious|normal|dangerous|ok|okay)\b/i, reason: "clinical assessment" },
  { re: /\bside effects?\b/i, reason: "medication query" },
  { re: /\b(dosage|dose)\b.{0,20}\b(change|increase|reduce|double)/i, reason: "dosage change" },
  { re: /\btake (these|them|those) together\b/i, reason: "drug interaction" },
  { re: /\brefill\b/i, reason: "prescription request" },
];

export function screenDeterministic(text: string): SafetyVerdict {
  const check = (
    patterns: { re: RegExp; reason: string }[],
    classification: SafetyClass,
  ): SafetyVerdict | undefined => {
    for (const p of patterns) {
      const m = text.match(p.re);
      if (m) return { classification, trigger: m[0], reason: p.reason };
    }
    return undefined;
  };

  return (
    check(SELF_HARM_PATTERNS, "self_harm") ??
    check(EMERGENCY_PATTERNS, "emergency") ??
    check(CLINICAL_PATTERNS, "clinical_question") ?? {
      classification: "none",
      reason: "no safety concern detected",
    }
  );
}

/**
 * Is the quoted trigger actually present in what the caller said?
 *
 * Tolerant of punctuation, case and whitespace, because a model will often
 * re-type a quote slightly differently. Strict about the words themselves.
 */
function quotedFrom(trigger: string, utterance: string): boolean {
  const normalise = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

  const needle = normalise(trigger);
  if (!needle) return false;

  const haystack = normalise(utterance);
  if (haystack.includes(needle)) return true;

  // A short quote must match outright. A longer one is allowed some drift, so
  // a re-worded fragment of a genuine symptom description is not discarded.
  const words = needle.split(" ");
  if (words.length < 4) return false;

  const present = words.filter((w) => haystack.includes(w)).length;
  return present / words.length >= 0.8;
}

const SYSTEM = `You screen a single utterance from a caller to a medical clinic
for safety concerns. You are not a doctor and you do not give advice. You only
classify.

Return exactly one classification:

- "emergency": anything that may be a medical emergency needing care now.
  Chest pain or tightness, difficulty breathing, one-sided weakness or numbness,
  slurred speech, severe bleeding, severe allergic reaction, loss of
  consciousness, or anything comparably urgent.

- "self_harm": any mention of suicide, self-harm, or not wanting to live.

- "clinical_question": a medical question a receptionist must not answer.
  Medication advice, dosage, interactions, side effects, refills, whether a
  symptom is serious, or any request for clinical judgement.

- "none": an ordinary scheduling matter, or anything else with no safety
  content.

Err toward escalating. A false emergency costs one transferred call; a missed
one may cost much more. Classify the CALLER's words only, never the agent's.

Precedence matters. If a caller describes a physical symptom from the
emergency list, that is "emergency" even when they phrase it as a question
("my chest feels tight, should I come in?"). Asking for advice about an
emergency symptom does not downgrade it to "clinical_question" -
"clinical_question" is for medication, dosage, interactions, side effects and
refills, not for acute physical symptoms.

The trigger you return MUST be text copied verbatim from the utterance. If
you cannot quote the exact words that made you classify it, the answer is
"none". Observed failure: a plain booking request was labelled a medication
question with a trigger phrase the caller had never said.

Everyday non-medical questions are "none", not "clinical_question". Parking,
directions, opening hours, insurance paperwork, a comment about the weather
or the news - none of these carry safety content. "clinical_question" means
the caller asked for a judgement about their health or medication.

Return JSON only:
{"classification":"none|emergency|self_harm|clinical_question",
 "trigger":"<the phrase that triggered it, or empty>",
 "reason":"<a few words>"}`;

/**
 * Full screen: deterministic first, then the model for phrasings a pattern
 * list cannot anticipate. The deterministic result wins when it fires, so the
 * floor holds even if the model is unavailable or wrong.
 */
export async function screenUtterance(
  text: string,
  provider?: LlmProvider,
): Promise<SafetyVerdict> {
  const deterministic = screenDeterministic(text);
  if (deterministic.classification !== "none") return deterministic;
  if (!provider) return deterministic;

  try {
    const res = await provider.complete({
      system: SYSTEM,
      turns: [{ role: "user", kind: "text", text }],
      temperature: 0,
      json: true,
    });

    const parsed = JSON.parse(res.text) as Partial<SafetyVerdict>;
    const valid: SafetyClass[] = [
      "none",
      "emergency",
      "self_harm",
      "clinical_question",
    ];
    const classification = valid.includes(parsed.classification as SafetyClass)
      ? (parsed.classification as SafetyClass)
      : "none";

    const trigger = parsed.trigger?.trim() || undefined;

    /**
     * Reject a classification whose trigger the caller never said.
     *
     * Observed live: a plain booking request ("I'd like to book any available
     * slot with Dr. Rao this week") was classified as a medication question,
     * with a trigger the model had invented wholesale. Requiring the quote to
     * appear in the utterance turns that from a silent false positive into a
     * caught one.
     *
     * Deliberately limited to clinical_question. An emergency or a self-harm
     * disclosure is not worth second-guessing over a quoting slip: a false
     * escalation costs one transferred call, a missed one costs much more.
     */
    // A missing trigger is treated the same as a fabricated one. Without it
    // there is no evidence to check, and an unevidenced clinical escalation
    // on an ordinary scheduling request is the exact false positive this
    // guard exists to stop.
    if (classification === "clinical_question" && !quotedFrom(trigger ?? "", text)) {
      return {
        classification: "none",
        reason: trigger
          ? `model cited a phrase the caller did not say (${trigger.slice(0, 60)})`
          : "model gave no quotable evidence for a clinical classification",
      };
    }

    return {
      classification,
      trigger,
      reason: parsed.reason || "model classification",
    };
  } catch {
    // A failed screen must not silently pass. The deterministic floor already
    // said "none", so returning it is the honest answer, but the caller-facing
    // pipeline treats a screen error as a reason to be careful, not bold.
    return { classification: "none", reason: "screen unavailable" };
  }
}

/** What the caller hears when a safety class fires. Never reassurance. */
export function safetyResponse(v: SafetyVerdict): string {
  switch (v.classification) {
    case "emergency":
      return (
        "That could be serious and I am not able to advise on it. Please seek " +
        "emergency care now - call emergency services or go to your nearest " +
        "emergency department. I am alerting our clinical staff immediately."
      );
    case "self_harm":
      return (
        "I am glad you told me. I cannot help with this myself, but I am " +
        "putting you through to someone who can right now. If you are in " +
        "immediate danger, please contact emergency services."
      );
    case "clinical_question":
      return (
        "That is a question for a clinician rather than me - I only handle " +
        "scheduling. I am passing it to our clinical team and they will get " +
        "back to you."
      );
    case "none":
      return "";
  }
}

/** Urgency to record on the escalation. */
export function urgencyFor(v: SafetyVerdict): "routine" | "urgent" | "emergency" {
  switch (v.classification) {
    case "emergency":
    case "self_harm":
      return "emergency";
    case "clinical_question":
      return "urgent";
    case "none":
      return "routine";
  }
}
