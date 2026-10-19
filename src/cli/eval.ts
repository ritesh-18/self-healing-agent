import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLessons } from "../agent/prompt.js";
import { describeConfig, getConfig } from "../config/index.js";
import { runSuite } from "../eval/runner.js";
import { allRoleProviders } from "../providers/index.js";
import { fail, printAudit, printSuite } from "./report.js";

/**
 * Runs the scenario suite once against the agent as it currently stands.
 * No reflection, no mutation - this is the measurement on its own.
 */
async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const cfg = getConfig();
  const providers = allRoleProviders();
  const lessons = loadLessons();

  console.log(describeConfig(cfg));
  console.log(`lessons: ${lessons.length}  |  concurrency: ${cfg.concurrency}`);
  if (only.length) console.log(`running only: ${only.join(", ")}`);
  console.log("running scenarios...");

  const suite = await runSuite(providers, lessons, only);
  printSuite("Evaluation", suite);
  printAudit(suite);

  mkdirSync(cfg.resultsDir, { recursive: true });
  const path = join(cfg.resultsDir, `eval-${Date.now()}.json`);
  writeFileSync(
    path,
    JSON.stringify({ config: describeConfig(cfg), lessons, suite }, null, 2),
  );
  console.log(`\nfull results: ${path}`);

  process.exit(suite.passed === suite.total ? 0 : 1);
}

main().catch(fail);
