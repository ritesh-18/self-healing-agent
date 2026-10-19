import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Agent } from "../agent/agent.js";
import { loadLessons } from "../agent/prompt.js";
import { createClinic, TODAY } from "../clinic/state.js";
import { providerFor } from "../providers/index.js";
import { fail } from "./report.js";

/**
 * Talk to Maya at a terminal.
 *
 * This drives the exact same Agent class the eval harness uses. If the two
 * diverged, the harness would be grading an agent no patient ever meets.
 */
async function main() {
  const provider = providerFor("agent");
  const lessons = loadLessons();
  const state = createClinic();
  const agent = new Agent(provider, state, lessons);

  console.log(`\nRiverbend Family Clinic - Maya`);
  console.log(
    `provider: ${provider.name} (${provider.model})  |  ` +
      `lessons loaded: ${lessons.length}  |  today: ${TODAY}`,
  );
  console.log(`Try: "Hi, I need to move my appointment on Thursday."`);
  console.log(`Ctrl+C to hang up.\n`);

  const rl = createInterface({ input: stdin, output: stdout });

  // Registered patients, so a human tester knows what will verify.
  console.log("On file: Radhika Nair 1984-06-21, Tom Alvarez 1971-11-02,");
  console.log("         Joan Whitfield 1950-02-14, Derek Whitfield 1948-09-30\n");

  try {
    for (;;) {
      const input = (await rl.question("PATIENT> ")).trim();
      if (!input) continue;
      if (input === "/state") {
        console.log(JSON.stringify(state.appointments, null, 2));
        console.log(JSON.stringify(state.escalations, null, 2));
        continue;
      }
      const reply = await agent.say(input);
      console.log(`\nMAYA> ${reply}\n`);
    }
  } finally {
    rl.close();
  }
}

main().catch(fail);
