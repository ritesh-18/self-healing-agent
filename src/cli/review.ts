import { loadLessons, saveLessons } from "../agent/prompt.js";
import {
  classificationCounts,
  editRule,
  loadQueue,
  pending,
  setStatus,
  type ReviewEntry,
} from "../improve/queue.js";
import { fail } from "./report.js";

/**
 * The human review gate.
 *
 *   npm run review                 list pending entries
 *   npm run review -- show <id>    full detail incl. transcript
 *   npm run review -- approve <id> [note]
 *   npm run review -- reject  <id> [note]
 *   npm run review -- edit <id> "<replacement rule>"
 *
 * Approving a behavioural entry is the ONLY path by which a learned rule
 * reaches the agent. Structural and harness entries cannot be approved into
 * lessons at all - they are decisions for a person, not a prompt patch.
 */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

const CLASS_COLOUR = {
  behavioural: YELLOW,
  structural: CYAN,
  harness: DIM,
} as const;

function list() {
  const queue = loadQueue();
  const open = pending(queue);
  const counts = classificationCounts(queue);

  console.log(`\n${BOLD}Review queue${OFF}`);
  console.log(
    `${DIM}all time:${OFF} behavioural ${counts.behavioural}  ` +
      `structural ${counts.structural}  harness ${counts.harness}`,
  );

  if (open.length === 0) {
    console.log(`\n${GREEN}Nothing pending.${OFF}\n`);
    return;
  }

  console.log(`\n${open.length} pending:\n`);
  for (const e of open) {
    const c = CLASS_COLOUR[e.verdict.classification];
    console.log(
      `  ${BOLD}${e.id}${OFF}  ${c}${e.verdict.classification}${OFF}` +
        `${DIM} (${e.verdict.confidence} confidence)${OFF}`,
    );
    console.log(`    ${e.scenarioTitle}`);
    console.log(`    ${DIM}${e.verdict.diagnosis}${OFF}`);

    if (e.proposedLesson) {
      console.log(`    ${GREEN}proposed:${OFF} ${e.proposedLesson.rule}`);
    }
    if (e.verdict.proposedCodeChange) {
      console.log(
        `    ${CYAN}code change needed:${OFF} ${e.verdict.proposedCodeChange}`,
      );
    }
    if (e.effect) {
      const delta = `${e.effect.before} -> ${e.effect.after} / ${e.effect.total}`;
      const reg = e.effect.regressions.length
        ? `${RED} regressions: ${e.effect.regressions.join(", ")}${OFF}`
        : `${GREEN} no regressions${OFF}`;
      console.log(`    ${DIM}effect:${OFF} ${delta}${reg}`);
    }
    console.log();
  }

  console.log(
    `${DIM}npm run review -- show|approve|reject <id>   ` +
      `npm run review -- edit <id> "<rule>"${OFF}\n`,
  );
}

function show(id: string) {
  const entry = loadQueue().entries.find((e) => e.id === id);
  if (!entry) return console.error(`No entry ${id}.`);

  console.log(`\n${BOLD}${entry.id}${OFF}  ${entry.scenarioTitle}`);
  console.log(`status:        ${entry.status}`);
  console.log(`classification ${entry.verdict.classification}`);
  console.log(`real failure   ${entry.verdict.real}`);
  console.log(`confidence     ${entry.verdict.confidence}`);
  console.log(`\n${BOLD}Diagnosis${OFF}\n${entry.verdict.diagnosis}`);

  if (entry.verdict.proposedCodeChange) {
    console.log(
      `\n${CYAN}${BOLD}Proposed code change${OFF}\n${entry.verdict.proposedCodeChange}`,
    );
  }
  if (entry.proposedLesson) {
    console.log(
      `\n${GREEN}${BOLD}Proposed rule${OFF}\n${entry.proposedLesson.rule}`,
    );
  }

  console.log(`\n${BOLD}Failed checks${OFF}`);
  for (const f of entry.failedChecks) console.log(`  - ${f}`);

  console.log(`\n${BOLD}Transcript${OFF}\n${entry.transcript}\n`);
}

function approve(id: string, note?: string) {
  const queue = loadQueue();
  const entry = queue.entries.find((e) => e.id === id);
  if (!entry) return console.error(`No entry ${id}.`);

  if (!entry.proposedLesson) {
    console.error(
      `\n${RED}${entry.id} has no proposed rule to approve.${OFF}\n` +
        `It is classified "${entry.verdict.classification}", which needs a ` +
        `code change or a test fix rather than a prompt lesson.\n` +
        (entry.verdict.proposedCodeChange
          ? `\nSuggested: ${entry.verdict.proposedCodeChange}\n`
          : "") +
        `\nUse "reject" once you have handled it, with a note saying how.\n`,
    );
    return;
  }

  const lessons = loadLessons();
  lessons.push(entry.proposedLesson);
  saveLessons(lessons);
  setStatus(id, "approved", note);

  console.log(
    `\n${GREEN}Approved.${OFF} Rule added to lessons.json ` +
      `(${lessons.length} total).\n  ${entry.proposedLesson.rule}\n`,
  );
  console.log(`${DIM}Re-run "npm run eval" to confirm the effect.${OFF}\n`);
}

function reject(id: string, note?: string) {
  const entry = setStatus(id, "rejected", note);
  if (!entry) return console.error(`No entry ${id}.`);
  console.log(`\n${YELLOW}Rejected${OFF} ${entry.id}. Nothing was changed.\n`);
}

function edit(id: string, rule: string) {
  const entry = editRule(id, rule);
  if (!entry) {
    return console.error(`No entry ${id}, or it has no rule to edit.`);
  }
  console.log(`\n${GREEN}Rule updated${OFF} for ${entry.id}:\n  ${rule}\n`);
  console.log(`${DIM}Approve it when you are happy with the wording.${OFF}\n`);
}

function main() {
  const [cmd, id, ...rest] = process.argv.slice(2);
  const arg = rest.join(" ").trim() || undefined;

  if (!cmd) return list();
  if (!id) {
    console.error(`Usage: npm run review -- ${cmd} <id>`);
    process.exit(1);
  }

  switch (cmd) {
    case "show":
      return show(id);
    case "approve":
      return approve(id, arg);
    case "reject":
      return reject(id, arg);
    case "edit":
      if (!arg) {
        console.error(`Usage: npm run review -- edit <id> "<new rule>"`);
        process.exit(1);
      }
      return edit(id, arg);
    default:
      console.error(`Unknown command "${cmd}". Use list, show, approve, reject, edit.`);
      process.exit(1);
  }
}

try {
  main();
} catch (err) {
  fail(err);
}
