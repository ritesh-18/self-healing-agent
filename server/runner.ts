import { describeConfig, getConfig } from "../src/config/index.js";
import { activeLessons } from "../src/db/repo.js";
import * as repo from "../src/db/repo.js";
import { runnableScenarios } from "../src/db/scenarios.js";
import { runSuite } from "../src/eval/runner.js";
import { processFailure } from "../src/improve/pipeline.js";
import { allRoleProviders } from "../src/providers/index.js";
import type { Lesson } from "../src/agent/prompt.js";

/**
 * Background run execution.
 *
 * A suite takes minutes, so the API returns a run id immediately and the
 * dashboard polls this state. One run at a time on purpose: concurrent suites
 * would interleave provider calls, and the latency figures the audit reports
 * would stop meaning anything.
 */

export interface RunState {
  active: boolean;
  runId: string | null;
  kind: "eval" | "loop" | null;
  phase: string;
  startedAt: string | null;
  error: string | null;
}

export const runState: RunState = {
  active: false,
  runId: null,
  kind: null,
  phase: "idle",
  startedAt: null,
  error: null,
};

/** Lessons from the database, in the shape the agent expects. */
async function lessonsForRun(): Promise<Lesson[]> {
  const rows = await activeLessons();
  return rows.map((r) => ({
    from: r.from_scenario,
    dimension: r.dimension,
    rule: r.rule,
    addedAt: r.created_at,
  }));
}

export async function startRun(
  kind: "eval" | "loop",
  only?: string[],
): Promise<string> {
  const cfg = getConfig();
  const lessons = await lessonsForRun();
  const runId = await repo.createRun(kind, describeConfig(cfg), lessons.length);

  Object.assign(runState, {
    active: true,
    runId,
    kind,
    phase: "starting",
    startedAt: new Date().toISOString(),
    error: null,
  });

  // Deliberately not awaited: the caller gets the id and polls.
  void execute(runId, kind, lessons, only).catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    runState.error = message;
    await repo.failRun(runId, message).catch(() => {});
  });

  return runId;
}

async function execute(
  runId: string,
  kind: "eval" | "loop",
  lessons: Lesson[],
  only?: string[],
): Promise<void> {
  const providers = allRoleProviders();
  const startedAt = Date.now();

  try {
    runState.phase = "running scenarios";

    // Scenarios come from the database so dashboard-authored ones are
    // included; built-ins keep their TypeScript assertions.
    const suite = await runSuite(providers, lessons, only, await runnableScenarios());

    await repo.saveSuite(runId, suite, Date.now() - startedAt);

    if (kind === "eval") {
      runState.phase = "completed";
      return;
    }

    // Loop mode: verify, classify and propose for each failure, then queue
    // for review. Nothing is applied - approval happens in the dashboard.
    const failing = suite.results.filter((r) => !r.pass);
    for (const [i, failure] of failing.entries()) {
      runState.phase = `investigating ${i + 1}/${failing.length}: ${failure.id}`;
      const outcome = await processFailure(
        providers,
        suite,
        lessons,
        failure,
      );
      await repo.saveOutcome(runId, outcome);
    }

    runState.phase = "completed";
  } finally {
    runState.active = false;
  }
}
