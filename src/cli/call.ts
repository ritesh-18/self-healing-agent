import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLessons } from "../agent/prompt.js";
import { createClinic, TODAY } from "../clinic/state.js";
import { describeConfig, getConfig } from "../config/index.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { providerFor } from "../providers/index.js";
import { fail } from "./report.js";

/**
 * A full orchestrated call at the terminal.
 *
 * Unlike `npm run agent`, this runs the whole production pipeline: safety
 * screen, relevance, identity, write gate, event log, summary. It is the
 * closest thing to what a caller would experience.
 */
async function main() {
  const cfg = getConfig();
  const state = createClinic();

  const orchestrator = new Orchestrator({
    callId: `call-${Date.now()}`,
    state,
    providers: {
      agent: providerFor("agent"),
      classifier: providerFor("judge"),
    },
    lessons: loadLessons(),
    maxTurns: 20,
  });

  console.log(`\nRiverbend Family Clinic — orchestrated call`);
  console.log(describeConfig(cfg));
  console.log(`today: ${TODAY}   call: ${orchestrator.bus.callId}\n`);
  console.log("On file: Radhika Nair 1984-06-21, Tom Alvarez 1971-11-02,");
  console.log("         Joan Whitfield 1950-02-14, Derek Whitfield 1948-09-30\n");
  console.log("/events  show the event log     /summary  end and summarise");
  console.log("Ctrl+C to hang up.\n");

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    while (!orchestrator.ended) {
      const input = (await rl.question("CALLER> ")).trim();
      if (!input) continue;

      if (input === "/events") {
        for (const e of orchestrator.bus.log) {
          console.log(`  ${e.seq}. ${e.name}`, e.payload);
        }
        continue;
      }
      if (input === "/summary") break;

      const { reply, ended, safety } = await orchestrator.handle(input);

      if (safety.classification !== "none") {
        console.log(`\n  [SAFETY: ${safety.classification} — ${safety.reason}]`);
      }
      console.log(`\nMAYA> ${reply}\n`);
      if (ended) break;
    }
  } finally {
    rl.close();
  }

  const summary = orchestrator.end();

  console.log(`\n--- Call summary ---`);
  console.log(`outcome:    ${summary.outcome}`);
  console.log(`verified:   ${summary.verified}`);
  console.log(`turns:      ${summary.turns}`);
  console.log(`narrative:  ${summary.narrative}`);
  if (summary.unresolved.length) {
    console.log(`unresolved:`);
    for (const u of summary.unresolved) console.log(`  - ${u}`);
  }

  mkdirSync(cfg.resultsDir, { recursive: true });
  const path = join(cfg.resultsDir, `${orchestrator.bus.callId}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      { summary, events: orchestrator.bus.toJSON() },
      null,
      2,
    ),
  );
  console.log(`\nevent log: ${path}\n`);
}

main().catch(fail);
