import { describeConfig, getConfig } from "../config/index.js";
import { loadLessons } from "../agent/prompt.js";
import { SCENARIOS } from "../eval/scenarios.js";
import { fail } from "./report.js";

/** Verifies the environment resolves before spending tokens on a full run. */
function main() {
  const cfg = getConfig();
  console.log("\nResolved configuration");
  console.log("----------------------");
  for (const [role, r] of Object.entries(cfg.roles)) {
    console.log(
      `  ${role.padEnd(8)} ${r.provider}/${r.model}` +
        (r.baseURL ? `  via ${r.baseURL}` : ""),
    );
  }
  console.log(`\n  loopRounds   ${cfg.loopRounds}`);
  console.log(`  concurrency  ${cfg.concurrency}`);
  console.log(`  lessonsPath  ${cfg.lessonsPath} (${loadLessons().length} loaded)`);
  console.log(`  resultsDir   ${cfg.resultsDir}`);
  console.log(
    `  safety       ${cfg.deterministicSafetyOnly ? "patterns only (dev)" : "patterns + model"}`,
  );
  console.log(`\n  scenarios    ${SCENARIOS.length}`);
  console.log(`    ${SCENARIOS.map((s) => s.id).join("\n    ")}`);
  console.log(`\nAll API keys present. ${describeConfig(cfg)}\n`);
}

try {
  main();
} catch (err) {
  fail(err);
}
