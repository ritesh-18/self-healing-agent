import { renderTranscript } from "../agent/agent.js";
import type { Lesson } from "../agent/prompt.js";
import { createClinic } from "../clinic/state.js";
import { getConfig } from "../config/index.js";
import type { CallEvent } from "../events/types.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import type { CallSummary } from "../orchestrator/summarize.js";
import type { LlmProvider } from "../providers/types.js";
import { judgeTranscript, type RubricVerdict } from "./judge.js";
import { SimulatedPatient } from "./patient.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";

export interface AssertionResult {
  id: string;
  describe: string;
  pass: boolean;
}

export interface ScenarioResult {
  id: string;
  title: string;
  pass: boolean;
  assertions: AssertionResult[];
  rubric: RubricVerdict[];
  /** Shorthand of what went wrong, used to route the improvement step. */
  failures: string[];
  transcript: string;
  turns: number;
  /** The full event log, so a failure can be replayed and investigated. */
  events: CallEvent[];
  /** Built from events, not from what the agent claimed. */
  summary: CallSummary;
  /** Wall-clock for the whole scenario, to catch timeouts and stalls. */
  durationMs: number;
}

export interface SuiteResult {
  passed: number;
  total: number;
  results: ScenarioResult[];
  at: string;
}

/**
 * Runs one scenario end to end against a fresh clinic.
 *
 * The scenario drives the ORCHESTRATOR, not the bare agent. That is the point:
 * a harness that graded the agent alone would be measuring something no caller
 * ever meets, and every guarantee the orchestrator adds - the safety screen,
 * the attempt cap, the write gate, idempotency - would be untested exactly
 * where it matters most.
 *
 * The clinic is rebuilt per scenario so nothing leaks between runs: a booking
 * made in `mind-change` must never be visible to `happy-booking`, or the
 * before/after comparison becomes noise.
 */
export async function runScenario(
  scenario: Scenario,
  providers: { agent: LlmProvider; patient: LlmProvider; judge: LlmProvider },
  lessons: Lesson[],
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const state = createClinic();
  const call = new Orchestrator({
    callId: `eval-${scenario.id}-${Date.now()}`,
    state,
    providers: { agent: providers.agent, classifier: providers.judge },
    lessons,
    maxTurns: scenario.maxTurns,
    deterministicSafetyOnly: getConfig().deterministicSafetyOnly,
  });
  const patient = new SimulatedPatient(providers.patient, scenario.patient);

  let turns = 0;
  let mayaSaid: string | undefined;

  for (; turns < scenario.maxTurns; turns++) {
    const { text, ended: patientDone } = await patient.next(mayaSaid);
    const { reply, ended: callDone } = await call.handle(text);
    mayaSaid = reply;
    // Either side can end the call: the patient hanging up, or the
    // orchestrator closing it after an emergency or an exhausted fallback.
    if (patientDone || callDone) break;
  }

  const summary = call.end();
  const transcript = renderTranscript(call.transcript);

  const assertions: AssertionResult[] = scenario.assertions.map((a) => ({
    id: a.id,
    describe: a.describe,
    pass: a.check(state, { events: call.bus.toJSON(), summary }),
  }));

  const rubric = await judgeTranscript(
    providers.judge,
    transcript,
    scenario.rubric,
  );

  const failures = [
    ...assertions.filter((a) => !a.pass).map((a) => `state:${a.id}`),
    ...rubric.filter((r) => !r.pass).map((r) => `rubric:${r.item}`),
  ];

  return {
    id: scenario.id,
    title: scenario.title,
    pass: failures.length === 0,
    assertions,
    rubric,
    failures,
    transcript,
    turns: turns + 1,
    events: call.bus.toJSON(),
    summary,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Runs the whole suite. Scenarios are independent (each gets its own clinic),
 * so they run concurrently, bounded by EVAL_CONCURRENCY - unbounded fan-out
 * trips provider rate limits, and a 429 would read as an agent failure.
 */
export async function runSuite(
  providers: { agent: LlmProvider; patient: LlmProvider; judge: LlmProvider },
  lessons: Lesson[],
  only?: string[],
  /**
   * The suite to run. Defaults to the code-defined scenarios; the API passes
   * the database set so dashboard-authored scenarios are included alongside
   * the built-ins.
   */
  suite: Scenario[] = SCENARIOS,
): Promise<SuiteResult> {
  const chosen = only?.length
    ? suite.filter((s) => only.includes(s.id))
    : suite;

  if (only?.length) {
    const unknown = only.filter((id) => !suite.some((s) => s.id === id));
    if (unknown.length) {
      throw new Error(
        `Unknown scenario id(s): ${unknown.join(", ")}\n` +
          `Available: ${suite.map((s) => s.id).join(", ")}`,
      );
    }
  }

  const limit = getConfig().concurrency;
  const results: ScenarioResult[] = new Array(chosen.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, chosen.length) }, async () => {
      for (;;) {
        const i = next++;
        const scenario = chosen[i];
        if (!scenario) return;
        results[i] = await runScenario(scenario, providers, lessons);
      }
    }),
  );

  return {
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    results,
    at: new Date().toISOString(),
  };
}
