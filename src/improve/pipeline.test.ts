import { strict as assert } from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Lesson } from "../agent/prompt.js";
import type { ScenarioResult, SuiteResult } from "../eval/runner.js";
import { emptySummary } from "../orchestrator/summarize.js";
import {
  fakeReflector,
  fakeVerifier,
  createFakeProvider,
} from "../providers/fake.js";
import { loadQueue, pending } from "./queue.js";
import { processFailure, trialLesson, type Providers } from "./pipeline.js";

/**
 * The improvement loop, tested without a network.
 *
 * These assert the properties that make the loop trustworthy rather than
 * merely active: that structural failures never become prompt rules, that a
 * regression blocks a fix however good the headline score looks, and that
 * nothing reaches the agent without passing through review.
 *
 * A scripted provider proves the plumbing, not the intelligence. Whether a
 * real model writes a *good* rule is a separate question, answered by a live
 * run.
 */

const QUEUE = "review-queue.test.json";

beforeEach(() => {
  process.env.REVIEW_QUEUE_PATH = QUEUE;
  if (existsSync(QUEUE)) rmSync(QUEUE);
});

afterEach(() => {
  if (existsSync(QUEUE)) rmSync(QUEUE);
  delete process.env.REVIEW_QUEUE_PATH;
});

function scenarioResult(
  over: Partial<ScenarioResult> = {},
): ScenarioResult {
  // Spread last but typed so an explicit `undefined` cannot widen a required
  // field back to optional.
  return {
    id: "happy-booking",
    title: "Straightforward new booking",
    pass: false,
    assertions: [
      { id: "booked-tuesday-am", describe: "Booking exists Tuesday am", pass: false },
    ],
    rubric: [{ item: "Maya verified the patient.", pass: true, why: "she did" }],
    failures: ["state:booked-tuesday-am"],
    transcript: "PATIENT: book me Tuesday\nMAYA: booked for Monday 10 March",
    turns: 3,
    ...over,
    // After the spread, so an explicit undefined in `over` cannot widen a
    // required field back to optional.
    events: over.events ?? [],
    summary: over.summary ?? emptySummary(),
    durationMs: over.durationMs ?? 0,
  };
}

function suite(passed: number, results: ScenarioResult[]): SuiteResult {
  return { passed, total: results.length, results, at: new Date().toISOString() };
}

/** Providers where only the reflect role matters; the rest are inert. */
function providers(reflect: Providers["reflect"]): Providers {
  const inert = createFakeProvider();
  return { agent: inert, patient: inert, judge: inert, reflect };
}

describe("classification routing", () => {
  it("proposes a rule for a behavioural failure", async () => {
    const failure = scenarioResult();
    const p = providers(fakeVerifier({ classification: "behavioural" }));
    // Reflection and trial are separate concerns; skip the trial here.
    const out = await processFailure(
      { ...p, reflect: fakeVerifier({ classification: "behavioural" }) },
      suite(0, [failure]),
      [],
      failure,
      { trial: false },
    );
    assert.equal(out.verdict.classification, "behavioural");
  });

  it("does NOT write a rule for a structural failure", async () => {
    const failure = scenarioResult();
    const out = await processFailure(
      providers(
        fakeVerifier({
          classification: "structural",
          proposedCodeChange: "find_slots should return a weekday field",
        }),
      ),
      suite(0, [failure]),
      [],
      failure,
      { trial: false },
    );

    assert.equal(out.verdict.classification, "structural");
    assert.equal(
      out.entry.proposedLesson,
      undefined,
      "a structural failure must never produce a prompt rule",
    );
    assert.match(out.verdict.proposedCodeChange ?? "", /weekday/);
  });

  it("does NOT write a rule for a harness failure", async () => {
    const failure = scenarioResult();
    const out = await processFailure(
      providers(fakeVerifier({ classification: "harness" })),
      suite(0, [failure]),
      [],
      failure,
      { trial: false },
    );
    assert.equal(out.entry.proposedLesson, undefined);
  });

  it("does NOT write a rule when the failure is not real", async () => {
    const failure = scenarioResult();
    const out = await processFailure(
      providers(
        fakeVerifier({ real: false, classification: "behavioural" }),
      ),
      suite(0, [failure]),
      [],
      failure,
      { trial: false },
    );
    assert.equal(out.entry.proposedLesson, undefined);
  });
});

describe("trial and regression gate", () => {
  const lesson: Lesson = {
    from: "happy-booking",
    dimension: "date-confirmation",
    rule: "Confirm the calendar date before booking.",
    addedAt: new Date().toISOString(),
  };

  /** Injects a runSuite double so the gate logic is tested deterministically. */
  function trialWith(before: SuiteResult, after: SuiteResult) {
    return trialLesson(
      providers(createFakeProvider()),
      before,
      [],
      lesson,
      async () => after,
    );
  }

  it("recommends a lesson that improves with no regressions", async () => {
    const a = scenarioResult({ id: "a", pass: false });
    const b = scenarioResult({ id: "b", pass: true });
    const before = suite(1, [a, b]);
    const after = suite(2, [{ ...a, pass: true }, b]);

    const trial = await trialWith(before, after);
    assert.equal(trial.regressions.length, 0);
    assert.equal(trial.recommended, true);
  });

  it("rejects a lesson that fixes one scenario but breaks another", async () => {
    const a = scenarioResult({ id: "a", pass: false });
    const b = scenarioResult({ id: "b", pass: true });
    const before = suite(1, [a, b]);
    // Net score unchanged, but b regressed - this must not be recommended.
    const after = suite(1, [{ ...a, pass: true }, { ...b, pass: false }]);

    const trial = await trialWith(before, after);
    assert.deepEqual(trial.regressions, ["b"]);
    assert.equal(trial.recommended, false);
  });

  it("rejects a lesson that raises the score but costs a safety case", async () => {
    // Two accuracy scenarios fixed, one safety scenario broken: total rises.
    const safety = scenarioResult({ id: "emergency-escalation", pass: true });
    const acc1 = scenarioResult({ id: "happy-booking", pass: false });
    const acc2 = scenarioResult({ id: "reschedule", pass: false });

    const before = suite(1, [safety, acc1, acc2]);
    const after = suite(2, [
      { ...safety, pass: false },
      { ...acc1, pass: true },
      { ...acc2, pass: true },
    ]);

    const trial = await trialWith(before, after);
    assert.equal(trial.safetyRegressed, true);
    assert.equal(
      trial.recommended,
      false,
      "a higher total must not buy a safety regression",
    );
  });

  it("rejects a lesson that changes nothing", async () => {
    const a = scenarioResult({ id: "a", pass: false });
    const before = suite(0, [a]);
    const after = suite(0, [a]);

    const trial = await trialWith(before, after);
    assert.equal(trial.recommended, false);
  });
});

describe("review queue", () => {
  it("files every processed failure as pending", async () => {
    const failure = scenarioResult();
    await processFailure(
      providers(fakeVerifier({ classification: "structural" })),
      suite(0, [failure]),
      [],
      failure,
      { trial: false },
    );

    const open = pending(loadQueue());
    assert.equal(open.length, 1);
    assert.equal(open[0]?.status, "pending");
    assert.equal(open[0]?.scenarioId, "happy-booking");
  });

  it("carries the transcript and failed checks for the reviewer", async () => {
    const failure = scenarioResult();
    const out = await processFailure(
      providers(fakeVerifier({ classification: "behavioural" })),
      suite(0, [failure]),
      [],
      failure,
      { trial: false },
    );

    assert.match(out.entry.transcript, /Monday 10 March/);
    assert.deepEqual(out.entry.failedChecks, [
      "state: Booking exists Tuesday am",
    ]);
  });

  it("queues a note when no usable rule can be generated", async () => {
    const failure = scenarioResult();
    // A reflector returning unparseable output must not silently produce a rule.
    const broken = createFakeProvider({ fallback: { text: "not json" } });

    const out = await processFailure(
      { ...providers(broken), reflect: broken },
      suite(0, [failure]),
      [],
      failure,
      { trial: false },
    );

    assert.equal(out.entry.proposedLesson, undefined);
  });
});

describe("reflector output", () => {
  it("wraps a generated rule as a lesson tied to its scenario", async () => {
    const failure = scenarioResult();
    const reflect = fakeReflector("Always confirm the calendar date.");
    // The verifier and reflector share the reflect provider in the pipeline,
    // so a behavioural verdict has to come from the same scripted source.
    const verifyThenReflect = createFakeProvider({
      rules: [
        (req) =>
          req.system.includes("improve a clinic scheduling agent")
            ? { text: JSON.stringify({
                dimension: "date-confirmation",
                rule: "Always confirm the calendar date.",
                rationale: "scripted",
              }) }
            : undefined,
        () => ({
          text: JSON.stringify({
            real: true,
            classification: "behavioural",
            diagnosis: "scripted",
            confidence: "high",
          }),
        }),
      ],
    });
    void reflect;

    const out = await processFailure(
      providers(verifyThenReflect),
      suite(0, [failure]),
      [],
      failure,
      { trial: false },
    );

    assert.equal(out.entry.proposedLesson?.from, "happy-booking");
    assert.match(
      out.entry.proposedLesson?.rule ?? "",
      /confirm the calendar date/i,
    );
  });
});
