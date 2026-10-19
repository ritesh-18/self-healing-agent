/**
 * PII redaction.
 *
 * Applied before anything is stored, never after. Transcripts carry dates of
 * birth, phone numbers, addresses and health complaints; the eval corpus is
 * the copy most likely to be handled casually, shared in a bug report, or
 * pasted into a model provider's logs.
 *
 * Redaction is lossy on purpose. It keeps the SHAPE of the data so a reviewer
 * can still follow the call - "[DOB]" where a date of birth was - without
 * carrying the value itself.
 */

export interface RedactionRule {
  name: string;
  re: RegExp;
  replacement: string;
}

/**
 * Order matters. More specific patterns run first, so an email address is not
 * partly consumed by the phone-number rule.
 */
export const DEFAULT_RULES: RedactionRule[] = [
  {
    name: "email",
    re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    replacement: "[EMAIL]",
  },
  {
    // ISO dates are how DOB is carried internally.
    name: "dob_iso",
    re: /\b(19|20)\d{2}-\d{2}-\d{2}\b/g,
    replacement: "[DOB]",
  },
  {
    name: "dob_spoken",
    re: /\b\d{1,2}[/-]\d{1,2}[/-](19|20)\d{2}\b/g,
    replacement: "[DOB]",
  },
  {
    name: "phone",
    re: /\b(\+?\d{1,3}[\s.-]?)?(\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}\b/g,
    replacement: "[PHONE]",
  },
  {
    name: "nhs_or_mrn",
    re: /\b(?:MRN|NHS)[\s:#-]*\d[\d\s-]{5,}\b/gi,
    replacement: "[MRN]",
  },
  {
    name: "postcode_uk",
    re: /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi,
    replacement: "[POSTCODE]",
  },
  {
    name: "street_address",
    re: /\b\d+[\w\s]{0,30}\b(street|st|road|rd|avenue|ave|lane|ln|drive|dr|close|way)\b/gi,
    replacement: "[ADDRESS]",
  },
];

export interface RedactionResult {
  text: string;
  /** What was removed, by rule name, for an audit trail. */
  counts: Record<string, number>;
}

export function redact(
  text: string,
  rules: RedactionRule[] = DEFAULT_RULES,
): RedactionResult {
  const counts: Record<string, number> = {};
  let out = text;

  for (const rule of rules) {
    // A fresh regex per call: /g patterns carry lastIndex between uses.
    const re = new RegExp(rule.re.source, rule.re.flags);
    const matches = out.match(re);
    if (matches?.length) {
      counts[rule.name] = (counts[rule.name] ?? 0) + matches.length;
      out = out.replace(re, rule.replacement);
    }
  }

  return { text: out, counts };
}

/**
 * Redacts names that are known to the call.
 *
 * Generic name detection is unreliable, so this takes the names the system
 * already knows about rather than guessing. Longest first, so "Derek
 * Whitfield" is replaced before "Derek".
 */
export function redactNames(text: string, names: string[]): string {
  let out = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (!name.trim()) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "[NAME]");
  }
  return out;
}

/** Deep-redacts a structure, for event payloads before persistence. */
export function redactObject<T>(value: T, names: string[] = []): T {
  if (typeof value === "string") {
    return redactNames(redact(value).text, names) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactObject(v, names)) as unknown as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        redactObject(v, names),
      ]),
    ) as unknown as T;
  }
  return value;
}
