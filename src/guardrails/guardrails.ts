/**
 * Guardrails.
 *
 * The tool layer is where safety-critical constraints are *enforced* - a tool
 * that refuses is a guarantee, a prompt rule is a suggestion. This module
 * covers the two things the tool layer cannot see:
 *
 *  - **Input**: caller speech is untrusted. There is no channel separation in
 *    a phone call, so instructions and data arrive on the same wire.
 *  - **Output**: what the agent is about to say. A tool cannot stop the agent
 *    quoting a price or inventing a policy, because no tool was involved.
 *
 * Both run as checks with findings rather than hard blocks, except where a
 * block is clearly correct. A guardrail that silently rewrites what the agent
 * says makes failures invisible to the eval harness, which is the opposite of
 * what this system is for.
 */

export type GuardrailSeverity = "block" | "flag";

export interface GuardrailFinding {
  rule: string;
  severity: GuardrailSeverity;
  detail: string;
  /** The matched text, for the audit record. */
  evidence?: string;
}

export interface GuardrailResult {
  passed: boolean;
  blocked: boolean;
  findings: GuardrailFinding[];
}

interface Rule {
  name: string;
  re: RegExp;
  severity: GuardrailSeverity;
  detail: string;
}

// ---------------------------------------------------------------------------
// Input guardrails
// ---------------------------------------------------------------------------

/**
 * Prompt-injection screening.
 *
 * Worth being honest about what this is: a detector, not a defence. A
 * determined attacker rephrases around any pattern list. It earns its place
 * because a spike in injection-shaped input is a signal worth having, and
 * because it is nearly free.
 *
 * The actual defence is that verification and row-level security live in the
 * tool layer, so "the doctor said to skip verification" is INERT - it cannot
 * do anything regardless of whether the model believes it.
 */
const INPUT_RULES: Rule[] = [
  {
    name: "instruction_override",
    re: /\b(ignore|disregard|forget)\b[^.?!]{0,30}\b(previous|prior|above|earlier|your)\b[^.?!]{0,20}\b(instruction|prompt|rule|direction)/i,
    severity: "flag",
    detail: "Caller attempted to override the agent's instructions",
  },
  {
    name: "role_override",
    re: /\b(you are now|from now on you|act as|pretend to be|developer mode|jailbreak|DAN mode)\b/i,
    severity: "flag",
    detail: "Caller attempted to reassign the agent's role",
  },
  {
    name: "prompt_extraction",
    re: /\b(repeat|print|show|reveal|what (is|are))\b[^.?!]{0,25}\b(system prompt|your instructions|your rules|initial prompt)/i,
    severity: "flag",
    detail: "Caller attempted to extract the system prompt",
  },
  {
    name: "claimed_authority",
    re: /\b(the (doctor|clinician|admin|manager)|staff|IT) (said|told me|authorised|authorized|approved)\b[^.?!]{0,40}\b(skip|bypass|without|no need)/i,
    severity: "flag",
    detail: "Caller claimed authority to bypass a control",
  },
  {
    name: "verification_bypass",
    re: /\b(skip|bypass|without|no need for|don'?t need)\b[^.?!]{0,20}\b(verification|verifying|checking|the check|id|identity)/i,
    severity: "flag",
    detail: "Caller asked to bypass verification",
  },
  {
    name: "fake_tool_result",
    re: /(\[result\]|\[tool\]|"ok"\s*:\s*true|tool_result|functionResponse)/i,
    severity: "block",
    detail:
      "Caller input contains text shaped like a tool result; it must never " +
      "be parsed as one",
  },
];

export function checkInput(text: string): GuardrailResult {
  return evaluate(text, INPUT_RULES);
}

// ---------------------------------------------------------------------------
// Output guardrails
// ---------------------------------------------------------------------------

/**
 * What the agent must not say.
 *
 * These are flags, not blocks, with one exception. The eval harness needs to
 * SEE that the agent quoted a price in order to score it and learn from it;
 * silently rewriting the reply would hide the failure from the only mechanism
 * able to fix it.
 */
const OUTPUT_RULES: Rule[] = [
  {
    name: "financial_figure",
    // No trailing \b: "$120." ends on a period, where \b after a digit
    // fails to match. The currency symbol is enough of an anchor.
    re: /[$£€]\s?\d|\b\d+(?:\.\d{2})?\s*(?:dollars|pounds|euros|usd|gbp|eur)\b/i,
    severity: "flag",
    detail: "Agent quoted a financial figure; it has no pricing source",
  },
  {
    name: "coverage_assertion",
    re: /\b(is|will be|are) (covered|fully covered|in-network|reimbursed)\b/i,
    severity: "flag",
    detail: "Agent asserted insurance coverage without an eligibility check",
  },
  {
    name: "clinical_reassurance",
    re: /\b(probably|likely|i'?m sure|i wouldn'?t) (nothing|fine|okay|ok|worry|be concerned)\b|\bnothing to worry about\b|\bdoesn'?t sound serious\b/i,
    severity: "flag",
    detail:
      "Agent offered reassurance about a clinical concern; escalation must " +
      "carry no opinion",
  },
  {
    name: "medical_advice",
    re: /\byou should (take|stop|start|increase|reduce|skip)\b[^.?!]{0,30}\b(medication|tablet|pill|dose|dosage)/i,
    severity: "block",
    detail: "Agent gave medication advice",
  },
  {
    name: "unavailable_action",
    re: /\bi(?:'ve| have)? (?:just )?(sent|texted|emailed|messaged)\b/i,
    severity: "flag",
    detail: "Agent claimed an action it has no tool to perform",
  },
  {
    name: "invented_confirmation",
    re: /\bconfirmation (number|code|reference)\b[^.?!]{0,15}\b(is|:)\s*[A-Z0-9-]{4,}/i,
    severity: "flag",
    detail: "Agent produced a confirmation identifier no tool returned",
  },
];

export function checkOutput(text: string): GuardrailResult {
  return evaluate(text, OUTPUT_RULES);
}

// ---------------------------------------------------------------------------

function evaluate(text: string, rules: Rule[]): GuardrailResult {
  const findings: GuardrailFinding[] = [];

  for (const rule of rules) {
    const match = text.match(rule.re);
    if (match) {
      findings.push({
        rule: rule.name,
        severity: rule.severity,
        detail: rule.detail,
        evidence: match[0].slice(0, 120),
      });
    }
  }

  return {
    passed: findings.length === 0,
    blocked: findings.some((f) => f.severity === "block"),
    findings,
  };
}

/** Replacement text when an output is blocked outright. */
export const BLOCKED_OUTPUT =
  "That is a question for a clinician rather than me - I only handle " +
  "scheduling. Let me pass it to our clinical team.";
