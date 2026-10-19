import { ConfigError } from "../config/index.js";
import { auditSuite, type ScenarioAudit } from "../eval/audit.js";
import { dimensionScores } from "../eval/kpi.js";
import type { SuiteResult } from "../eval/runner.js";
import type { PipelineOutcome } from "../improve/pipeline.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

/**
 * Shared CLI error exit. A ConfigError is a setup mistake the user can fix, so
 * it prints clean rather than as a stack trace they have to read past.
 */
export function fail(err: unknown): never {
  if (err instanceof ConfigError) {
    console.error(`\n${RED}${BOLD}Configuration problem${OFF}\n${err.message}\n`);
  } else {
    console.error(`\n${RED}${err instanceof Error ? err.stack ?? err.message : String(err)}${OFF}\n`);
  }
  process.exit(1);
}

export function printSuite(title: string, suite: SuiteResult): void {
  console.log(`\n${BOLD}${title}${OFF}`);
  console.log("-".repeat(title.length));

  for (const r of suite.results) {
    const mark = r.pass ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`;
    console.log(`${mark}  ${r.title} ${DIM}(${r.id})${OFF}`);
    if (!r.pass) {
      for (const a of r.assertions.filter((x) => !x.pass)) {
        console.log(`        ${RED}state${OFF}  ${a.describe}`);
      }
      for (const v of r.rubric.filter((x) => !x.pass)) {
        console.log(`        ${YELLOW}rubric${OFF} ${v.item}`);
        console.log(`               ${DIM}${v.why}${OFF}`);
      }
    }
  }

  console.log(`\n${BOLD}Score: ${suite.passed}/${suite.total}${OFF}`);
}

/**
 * The artifact the whole exercise exists to produce: a per-scenario before and
 * after, with regressions called out explicitly. A headline score that went up
 * while quietly breaking a scenario is a failed improvement, not a successful
 * one, so regressions are reported separately rather than netted off.
 */
export function printComparison(before: SuiteResult, after: SuiteResult): void {
  console.log(`\n${BOLD}Before / After${OFF}`);
  console.log("=".repeat(62));

  const width = 34;
  console.log(
    `${"Scenario".padEnd(width)} ${"Before".padEnd(8)} ${"After".padEnd(8)} Change`,
  );
  console.log("-".repeat(62));

  const fixed: string[] = [];
  const regressed: string[] = [];

  for (const b of before.results) {
    const a = after.results.find((x) => x.id === b.id);
    if (!a) continue;

    let change = `${DIM}-${OFF}`;
    if (!b.pass && a.pass) {
      change = `${GREEN}fixed${OFF}`;
      fixed.push(b.title);
    } else if (b.pass && !a.pass) {
      change = `${RED}REGRESSED${OFF}`;
      regressed.push(b.title);
    }

    const fmt = (p: boolean) => (p ? `${GREEN}pass${OFF}` : `${RED}fail${OFF}`);
    console.log(
      `${b.title.slice(0, width).padEnd(width)} ${fmt(b.pass).padEnd(17)} ${fmt(
        a.pass,
      ).padEnd(17)} ${change}`,
    );
  }

  console.log("-".repeat(62));
  console.log(
    `${BOLD}${before.passed}/${before.total}  ->  ${after.passed}/${after.total}${OFF}`,
  );

  if (fixed.length) console.log(`${GREEN}Fixed:${OFF} ${fixed.join(", ")}`);
  if (regressed.length) {
    console.log(`${RED}${BOLD}Regressions:${OFF} ${regressed.join(", ")}`);
    console.log(
      `${RED}The improvement is not safe to keep as-is.${OFF} ` +
        `Lessons that caused regressions are reported above.`,
    );
  } else {
    console.log(`${GREEN}No regressions.${OFF}`);
  }
}

const CYAN = "\x1b[36m";

/**
 * Per-dimension pass rates.
 *
 * The headline score hides what a lesson traded away. Safety and authorisation
 * are printed first because those are the rows that decide whether an
 * improvement is acceptable, regardless of what the total did.
 */
export function printKpis(suite: SuiteResult): void {
  console.log(`\n${BOLD}By dimension${OFF}`);
  for (const d of dimensionScores(suite)) {
    const ok = d.passed === d.total;
    const critical = d.dimension === "safety" || d.dimension === "authorisation";
    const colour = ok ? GREEN : critical ? RED : YELLOW;
    const flag = !ok && critical ? "  <-- critical" : "";
    console.log(
      `  ${d.dimension.padEnd(14)} ${colour}${d.passed}/${d.total}${OFF}${flag}`,
    );
  }
}

/** Closing summary of what the loop filed, and what a human must do next. */
export function printQueueSummary(
  outcomes: PipelineOutcome[],
  auto: boolean,
): void {
  const behavioural = outcomes.filter(
    (o) => o.verdict.classification === "behavioural" && o.verdict.real,
  );
  const structural = outcomes.filter(
    (o) => o.verdict.classification === "structural",
  );
  const harness = outcomes.filter(
    (o) => o.verdict.classification === "harness" || !o.verdict.real,
  );

  console.log(`  ${YELLOW}behavioural${OFF}  ${behavioural.length}  ${DIM}prompt rule proposed${OFF}`);
  console.log(`  ${CYAN}structural${OFF}   ${structural.length}  ${DIM}needs a code change${OFF}`);
  console.log(`  ${DIM}harness      ${harness.length}  test or judge at fault${OFF}`);

  const recommended = behavioural.filter((o) => o.trial?.recommended);
  if (recommended.length) {
    console.log(
      `\n  ${GREEN}${recommended.length} rule(s) improved the suite with no regressions:${OFF}`,
    );
    for (const o of recommended) {
      console.log(`    ${o.entry.id}  ${o.trial?.lesson.rule}`);
    }
  }

  const rejected = behavioural.filter(
    (o) => o.trial && !o.trial.recommended,
  );
  if (rejected.length) {
    console.log(
      `\n  ${RED}${rejected.length} rule(s) did not earn their place${OFF} ` +
        `${DIM}(no improvement, or caused regressions)${OFF}`,
    );
  }

  if (structural.length) {
    console.log(`\n  ${CYAN}${BOLD}Code changes needed${OFF} ${DIM}(the loop cannot fix these)${OFF}`);
    for (const o of structural) {
      console.log(`    ${o.entry.id}  ${o.verdict.proposedCodeChange ?? o.verdict.diagnosis}`);
    }
  }

  console.log(
    auto
      ? `\n${YELLOW}auto mode:${OFF} approve with "npm run review -- approve <id>" is skipped; ` +
          `rules were NOT applied. Auto-apply is intentionally not implemented for ` +
          `clinical instructions.\n`
      : `\n${BOLD}Next:${OFF} npm run review${DIM}   (nothing has changed the agent yet)${OFF}\n`,
  );
}

/**
 * Tool-call audit.
 *
 * A scenario can pass while the agent took a wasteful or unsafe route to get
 * there. This reports the route, not just the destination.
 */
export function printAudit(suite: SuiteResult): void {
  const audits: ScenarioAudit[] = auditSuite(suite);

  console.log(`
${BOLD}Tool-call audit${OFF}`);
  console.log(
    `${"Scenario".padEnd(26)} ${"calls".padStart(5)} ${"fail".padStart(4)} ` +
      `${"time".padStart(7)}  findings`,
  );
  console.log("-".repeat(70));

  for (const a of audits) {
    const result = suite.results.find((r) => r.id === a.scenarioId);
    const seconds = result ? `${(result.durationMs / 1000).toFixed(1)}s` : "-";
    const errors = a.findings.filter((f) => f.severity === "error").length;
    const warnings = a.findings.filter((f) => f.severity === "warning").length;

    const flag =
      errors > 0
        ? `${RED}${errors} error${OFF}`
        : warnings > 0
          ? `${YELLOW}${warnings} warning${OFF}`
          : `${GREEN}clean${OFF}`;

    console.log(
      `${a.scenarioId.slice(0, 26).padEnd(26)} ${String(a.totalCalls).padStart(5)} ` +
        `${String(a.failedCalls).padStart(4)} ${seconds.padStart(7)}  ${flag}`,
    );

    for (const f of a.findings) {
      const colour = f.severity === "error" ? RED : YELLOW;
      console.log(`      ${colour}${f.code}${OFF}  ${DIM}${f.detail}${OFF}`);
    }

    // The call sequence itself, so an unexpected route is visible.
    if (a.calls.length) {
      const seq = a.calls
        .map((c) => (c.ok ? c.name : `${c.name}!`))
        .join(" -> ");
      console.log(`      ${DIM}${seq}${OFF}`);
    }
  }
}
