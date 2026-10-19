import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadLessons } from "../agent/prompt.js";
import { describeConfig, getConfig } from "../config/index.js";
import { dimensionScores } from "../eval/kpi.js";
import type { SuiteResult } from "../eval/runner.js";
import { SCENARIOS } from "../eval/scenarios.js";
import { classificationCounts, loadQueue } from "../improve/queue.js";
import { fail } from "./report.js";

/**
 * Generates TESTREPORT.md from the unit tests and the most recent eval run.
 *
 * Written for a reviewer who has not run the code: it states what is verified
 * deterministically (the tool-layer invariants, which need no API key) versus
 * what depends on a live model, and it reports the last measured suite result
 * rather than claiming anything the repository cannot evidence.
 */

interface UnitTestSummary {
  total: number;
  pass: number;
  fail: number;
  durationMs: number;
  raw: string;
}

function runUnitTests(): UnitTestSummary {
  let raw: string;
  try {
    // execSync (not execFileSync + shell) avoids the unescaped-args warning.
    raw = execSync("npx tsx --test src/**/*.test.ts", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // A non-zero exit still carries the useful output.
    raw = String((err as { stdout?: string }).stdout ?? err);
  }

  const num = (label: string) =>
    Number(raw.match(new RegExp(`^# ${label} (\\d+)`, "m"))?.[1] ?? 0) ||
    Number(raw.match(new RegExp(`${label} (\\d+)`))?.[1] ?? 0);

  return {
    total: num("tests"),
    pass: num("pass"),
    fail: num("fail"),
    durationMs: Number(raw.match(/duration_ms ([\d.]+)/)?.[1] ?? 0),
    raw,
  };
}

function latestEval(dir: string): { file: string; suite: SuiteResult } | null {
  if (!existsSync(dir)) return null;

  const files = readdirSync(dir)
    .filter((f) => f.startsWith("eval-") && f.endsWith(".json"))
    .sort();
  const newest = files.at(-1);
  if (!newest) return null;

  try {
    const parsed = JSON.parse(readFileSync(join(dir, newest), "utf8"));
    const suite: SuiteResult = parsed.suite ?? parsed;
    return suite?.results ? { file: newest, suite } : null;
  } catch {
    return null;
  }
}

function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const header = rows[0]!;
  const sep = header.map(() => "---");
  return [header, sep, ...rows.slice(1)]
    .map((r) => `| ${r.join(" | ")} |`)
    .join("\n");
}

function main() {
  const cfg = getConfig();
  const unit = runUnitTests();
  const evalRun = latestEval(cfg.resultsDir);
  const queue = loadQueue();
  const counts = classificationCounts(queue);
  const lessons = loadLessons();

  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l, "");

  push(`# Test Report`);
  push(
    `Generated ${new Date().toISOString()}`,
    ``,
    `This report is produced by \`npm run testreport\`. It separates what is`,
    `verified **deterministically** from what depends on a **live model**,`,
    `because only the first kind is a guarantee.`,
  );

  // --- Deterministic ---
  const unitOk = unit.fail === 0 && unit.total > 0;
  push(`## 1. Deterministic tests (no API key required)`);
  push(
    `These assert the tool-layer invariants directly, with no model in the`,
    `loop. A guardrail that exists only in the prompt is a suggestion; these`,
    `are what make it a rule.`,
  );
  push(
    table([
      ["Metric", "Value"],
      ["Tests", String(unit.total)],
      ["Passed", String(unit.pass)],
      ["Failed", String(unit.fail)],
      ["Duration", `${unit.durationMs.toFixed(0)} ms`],
      ["Status", unitOk ? "**PASS**" : "**FAIL**"],
    ]),
  );

  push(`### What these cover`);
  push(
    [
      "**Tool guardrails**",
      "",
      "- Booking is refused for an unverified caller",
      "- A slot the clinic never offered cannot be booked",
      "- Double-booking is impossible even if `find_slots` was never called",
      "- A caller cannot cancel another patient's appointment",
      "- `find_slots` never returns an already-booked slot",
      "- An empty result is returned rather than a substitute slot",
      "- An unrecognised escalation urgency degrades to `routine`, never dropped",
      "- Unknown tools fail closed and are logged",
      "- Every scenario starts from an identical clinic, with no leakage",
    ].join("\n"),
  );

  // --- Live model ---
  push(`## 2. Scenario suite (requires a live model)`);
  push(`Configuration used: \`${describeConfig(cfg)}\``);
  push(`Lessons applied at time of run: **${lessons.length}**`);

  if (!evalRun) {
    push(
      `> **No eval run recorded yet.** Run \`npm run eval\` to populate this`,
      `> section. The suite defines ${SCENARIOS.length} scenarios.`,
    );
  } else {
    const { suite, file } = evalRun;
    push(`Source: \`${cfg.resultsDir}/${file}\``);
    push(
      table([
        ["Metric", "Value"],
        ["Scenarios", String(suite.total)],
        ["Passed", String(suite.passed)],
        ["Failed", String(suite.total - suite.passed)],
        ["Run at", suite.at ?? "unknown"],
      ]),
    );

    push(`### By scenario`);
    push(
      table([
        ["Scenario", "Result", "Failed checks"],
        ...suite.results.map((r) => [
          `\`${r.id}\``,
          r.pass ? "PASS" : "**FAIL**",
          r.pass ? "—" : r.failures.map((f) => `\`${f}\``).join("<br>"),
        ]),
      ]),
    );

    push(`### By dimension`);
    push(
      `Safety and authorisation are listed first: those are the rows that`,
      `decide whether an improvement is acceptable, whatever the total did.`,
    );
    push(
      table([
        ["Dimension", "Passed", "Critical"],
        ...dimensionScores(suite).map((d) => [
          d.dimension,
          `${d.passed}/${d.total}`,
          d.dimension === "safety" || d.dimension === "authorisation"
            ? "yes"
            : "no",
        ]),
      ]),
    );
  }

  // --- Improvement loop ---
  push(`## 3. Improvement loop`);
  push(
    table([
      ["Classification", "Count", "Handling"],
      ["behavioural", String(counts.behavioural), "Prompt rule proposed, trialled, queued"],
      ["structural", String(counts.structural), "Escalated as a code change; no rule written"],
      ["harness", String(counts.harness), "Test or judge at fault; agent unchanged"],
    ]),
  );
  push(
    `Review queue: **${queue.entries.length}** entries, ` +
      `**${queue.entries.filter((e) => e.status === "pending").length}** pending.`,
  );
  push(
    `No proposed rule reaches the agent without \`npm run review -- approve <id>\`.`,
  );

  // --- Honest limits ---
  push(`## 4. What this report does not prove`);
  push(
    [
      "- **Judge variance.** Rubric grading is an LLM call; borderline items can",
      "  flip between runs. Only the state assertions are deterministic.",
      "- **Single sample.** Each scenario runs once. No variance bounds.",
      "- **Simulated patients.** Personas improvise, so wording differs run to run.",
      "  Scenarios therefore assert on outcomes, not transcripts.",
      "- **No voice layer.** Barge-in, mishearing and latency are out of scope.",
      "- **Free-tier quota.** Gemini's free tier caps requests per day per model,",
      "  so a full suite may need roles spread across models or a paid key.",
    ].join("\n"),
  );

  writeFileSync("TESTREPORT.md", lines.join("\n"));

  console.log(`\nWrote TESTREPORT.md`);
  console.log(
    `  unit tests   ${unit.pass}/${unit.total} passing` +
      (unit.fail ? `  (${unit.fail} FAILING)` : ""),
  );
  console.log(
    evalRun
      ? `  scenarios    ${evalRun.suite.passed}/${evalRun.suite.total} from ${evalRun.file}`
      : `  scenarios    no eval run recorded yet`,
  );
  console.log(`  queue        ${queue.entries.length} entries\n`);
}

try {
  main();
} catch (err) {
  fail(err);
}
