import type { Lesson } from "../agent/prompt.js";
import type { LlmProvider } from "../providers/types.js";
import type { ScenarioResult, SuiteResult } from "../eval/runner.js";
import { runSuite } from "../eval/runner.js";
import { safetyRegressed } from "../eval/kpi.js";
import { addEntry, type ReviewEntry } from "./queue.js";
import { reflectOnFailure, toLesson } from "./reflect.js";
import { verifyFailure, type Verdict } from "./verify.js";

/**
 * The improvement pipeline.
 *
 *   failure -> verify -> classify -> (reflect) -> trial -> queue for a human
 *
 * Two rules govern the whole thing:
 *
 *  1. Only behavioural failures produce prompt rules. Structural failures are
 *     escalated as code changes, because no wording makes an agent reliably
 *     compute something the environment never gave it. Harness failures change
 *     the test, never the agent.
 *
 *  2. Nothing reaches the agent without a human. The pipeline measures a
 *     candidate rule and files the evidence; approval happens in `npm run
 *     review`. An agent that edits its own instructions unsupervised is not
 *     something to ship into a clinic.
 */

export interface Providers {
  agent: LlmProvider;
  patient: LlmProvider;
  judge: LlmProvider;
  reflect: LlmProvider;
}

export interface TrialResult {
  lesson: Lesson;
  before: SuiteResult;
  after: SuiteResult;
  regressions: string[];
  safetyRegressed: boolean;
  /** Recommended only when it helps, breaks nothing, and safety holds. */
  recommended: boolean;
}

export interface PipelineOutcome {
  scenarioId: string;
  verdict: Verdict;
  trial?: TrialResult;
  entry: ReviewEntry;
}

function failedChecks(result: ScenarioResult): string[] {
  return [
    ...result.assertions
      .filter((a) => !a.pass)
      .map((a) => `state: ${a.describe}`),
    ...result.rubric.filter((r) => !r.pass).map((r) => `rubric: ${r.item}`),
  ];
}

/**
 * Applies a candidate lesson and re-runs the WHOLE suite.
 *
 * Re-running everything is the point. The characteristic failure of a
 * self-improving agent is a fix that trades one broken scenario for another,
 * and a suite that only re-checks what it just fixed cannot see that happen.
 */
export async function trialLesson(
  providers: Providers,
  baseline: SuiteResult,
  currentLessons: Lesson[],
  candidate: Lesson,
  /**
   * Injectable so the gate logic can be tested without a network. ES module
   * bindings are read-only, so a seam here is the only way to exercise the
   * regression and safety checks deterministically.
   */
  run: typeof runSuite = runSuite,
): Promise<TrialResult> {
  const after = await run(providers, [...currentLessons, candidate]);

  const regressions = baseline.results
    .filter(
      (b) => b.pass && after.results.find((a) => a.id === b.id)?.pass === false,
    )
    .map((b) => b.id);

  const safety = safetyRegressed(baseline, after);

  return {
    lesson: candidate,
    before: baseline,
    after,
    regressions,
    safetyRegressed: safety,
    recommended:
      regressions.length === 0 && !safety && after.passed > baseline.passed,
  };
}

/**
 * Handles one failing scenario end to end, returning the queue entry a human
 * will review. `trial` is skipped when the failure is not behavioural, since
 * there is no prompt rule to measure.
 */
export async function processFailure(
  providers: Providers,
  baseline: SuiteResult,
  currentLessons: Lesson[],
  failure: ScenarioResult,
  options: { trial: boolean } = { trial: true },
  run: typeof runSuite = runSuite,
): Promise<PipelineOutcome> {
  const verdict = await verifyFailure(providers.reflect, failure);

  const base = {
    scenarioId: failure.id,
    scenarioTitle: failure.title,
    verdict,
    transcript: failure.transcript,
    failedChecks: failedChecks(failure),
  };

  // Not a real failure, or not the agent's fault: file it for a human and
  // write no rule. Learning from a broken test is how a loop poisons itself.
  if (!verdict.real || verdict.classification !== "behavioural") {
    return {
      scenarioId: failure.id,
      verdict,
      entry: addEntry(base),
    };
  }

  const reflection = await reflectOnFailure(
    providers.reflect,
    failure,
    currentLessons,
  );
  if (!reflection) {
    return {
      scenarioId: failure.id,
      verdict,
      entry: addEntry({
        ...base,
        verdict: {
          ...verdict,
          diagnosis:
            `${verdict.diagnosis} (No usable rule could be generated; ` +
            `needs a human.)`,
        },
      }),
    };
  }

  const lesson = toLesson(failure.id, reflection);

  if (!options.trial) {
    return {
      scenarioId: failure.id,
      verdict,
      entry: addEntry({ ...base, proposedLesson: lesson }),
    };
  }

  const trial = await trialLesson(
    providers,
    baseline,
    currentLessons,
    lesson,
    run,
  );

  return {
    scenarioId: failure.id,
    verdict,
    trial,
    entry: addEntry({
      ...base,
      proposedLesson: lesson,
      effect: {
        before: trial.before.passed,
        after: trial.after.passed,
        total: trial.after.total,
        regressions: trial.regressions,
      },
    }),
  };
}
