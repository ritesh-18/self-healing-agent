import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLessons } from "../agent/prompt.js";
import { describeConfig, getConfig } from "../config/index.js";
import { runSuite } from "../eval/runner.js";
import { processFailure, type PipelineOutcome } from "../improve/pipeline.js";
import { allRoleProviders } from "../providers/index.js";
import {
  fail,
  printComparison,
  printKpis,
  printQueueSummary,
  printSuite,
} from "./report.js";

/**
 * The improvement loop.
 *
 *   baseline -> verify each failure -> classify -> propose -> trial -> queue
 *
 * What this command does NOT do is change the agent. Every proposed rule is
 * measured against the full suite and then filed for human review. Approval
 * happens in `npm run review`, which is the only path by which a learned rule
 * reaches lessons.json.
 *
 * Pass --auto to approve non-regressing behavioural rules automatically. That
 * exists for CI and for the unattended demo; it is not the default, because an
 * agent rewriting its own clinical instructions unsupervised is the failure
 * mode this whole design is built to avoid.
 */
async function main() {
  const auto = process.argv.includes("--auto");
  const cfg = getConfig();
  const providers = allRoleProviders();
  const lessons = loadLessons();

  console.log(describeConfig(cfg));
  console.log(
    `lessons: ${lessons.length}  |  concurrency: ${cfg.concurrency}` +
      (auto ? "  |  MODE: auto-approve" : "  |  mode: human review"),
  );

  console.log("\n[1/3] Baseline run...");
  const baseline = await runSuite(providers, lessons);
  printSuite("Baseline", baseline);
  printKpis(baseline);

  const failing = baseline.results.filter((r) => !r.pass);
  if (failing.length === 0) {
    console.log(
      "\nEverything passes. Delete lessons.json to see the loop work from " +
        "scratch, or add a harder scenario.",
    );
    return;
  }

  console.log(
    `\n[2/3] Verifying and processing ${failing.length} failure(s)...\n`,
  );

  const outcomes: PipelineOutcome[] = [];
  for (const failure of failing) {
    console.log(`  ${failure.id}: verifying...`);
    const outcome = await processFailure(
      providers,
      baseline,
      lessons,
      failure,
    );
    outcomes.push(outcome);

    const v = outcome.verdict;
    console.log(
      `    ${v.classification}${v.real ? "" : " (not a real failure)"} ` +
        `[${v.confidence} confidence]`,
    );
    console.log(`    ${v.diagnosis}`);

    if (v.proposedCodeChange) {
      console.log(`    CODE CHANGE NEEDED: ${v.proposedCodeChange}`);
    }
    if (outcome.trial) {
      const t = outcome.trial;
      console.log(`    rule: ${t.lesson.rule}`);
      console.log(
        `    trial: ${t.before.passed} -> ${t.after.passed}/${t.after.total}` +
          (t.regressions.length
            ? `  REGRESSED: ${t.regressions.join(", ")}`
            : "  no regressions") +
          (t.safetyRegressed ? "  SAFETY REGRESSED" : ""),
      );
      printComparison(t.before, t.after);
    }
    console.log();
  }

  console.log(`[3/3] Filed for review\n`);
  printQueueSummary(outcomes, auto);

  mkdirSync(cfg.resultsDir, { recursive: true });
  const path = join(cfg.resultsDir, `loop-${Date.now()}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      { config: describeConfig(cfg), baseline, outcomes },
      null,
      2,
    ),
  );
  console.log(`full loop record: ${path}`);
}

main().catch(fail);
