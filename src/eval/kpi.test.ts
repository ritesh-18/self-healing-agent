import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { emptySummary } from "../orchestrator/summarize.js";
import { dimensionScores, safetyRegressed } from "./kpi.js";
import type { ScenarioResult, SuiteResult } from "./runner.js";

/**
 * Dimension scoring and the safety gate.
 *
 * These are pure functions, so they are tested directly. The safety gate in
 * particular is load-bearing: it is the check that stops a lesson buying a
 * higher headline score with a safety regression, and it must hold regardless
 * of what the total did.
 */

function result(id: string, pass: boolean): ScenarioResult {
  return {
    id,
    title: id,
    pass,
    assertions: [],
    rubric: [],
    failures: pass ? [] : ["state:x"],
    transcript: "",
    turns: 1,
    events: [],
    summary: emptySummary(),
    durationMs: 0,
  };
}

function suite(results: ScenarioResult[]): SuiteResult {
  return {
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    results,
    at: new Date().toISOString(),
  };
}

describe("dimensionScores", () => {
  it("groups scenarios by the dimension they defend", () => {
    const s = suite([
      result("emergency-escalation", true),
      result("medication-question", false),
      result("happy-booking", true),
    ]);

    const scores = dimensionScores(s);
    const safety = scores.find((d) => d.dimension === "safety");

    assert.equal(safety?.passed, 1);
    assert.equal(safety?.total, 2);
  });

  it("lists safety first, before the headline number can reassure anyone", () => {
    const s = suite([
      result("happy-booking", true),
      result("emergency-escalation", true),
      result("third-party-cancel", true),
    ]);

    const order = dimensionScores(s).map((d) => d.dimension);
    assert.equal(order[0], "safety");
    assert.equal(order[1], "authorisation");
  });

  it("omits dimensions with no scenarios in the run", () => {
    const s = suite([result("happy-booking", true)]);
    const dims = dimensionScores(s).map((d) => d.dimension);

    assert.deepEqual(dims, ["accuracy"]);
  });

  it("defaults an unknown scenario id to conversation rather than dropping it", () => {
    const s = suite([result("some-new-scenario", false)]);
    const scores = dimensionScores(s);

    assert.equal(scores.length, 1);
    assert.equal(scores[0]?.dimension, "conversation");
    assert.equal(scores[0]?.total, 1);
  });
});

describe("safetyRegressed", () => {
  it("is false when nothing changed", () => {
    const s = suite([result("emergency-escalation", true)]);
    assert.equal(safetyRegressed(s, s), false);
  });

  it("is true when a safety scenario stops passing", () => {
    const before = suite([result("emergency-escalation", true)]);
    const after = suite([result("emergency-escalation", false)]);

    assert.equal(safetyRegressed(before, after), true);
  });

  it("is true when an authorisation scenario stops passing", () => {
    const before = suite([result("third-party-cancel", true)]);
    const after = suite([result("third-party-cancel", false)]);

    assert.equal(safetyRegressed(before, after), true);
  });

  it("fires even when the overall score improves", () => {
    // The case the gate exists for: two accuracy fixes buying one safety loss.
    const before = suite([
      result("emergency-escalation", true),
      result("happy-booking", false),
      result("reschedule", false),
    ]);
    const after = suite([
      result("emergency-escalation", false),
      result("happy-booking", true),
      result("reschedule", true),
    ]);

    assert.ok(after.passed > before.passed, "total did rise");
    assert.equal(
      safetyRegressed(before, after),
      true,
      "a higher total must not hide a safety regression",
    );
  });

  it("ignores regressions in non-critical dimensions", () => {
    const before = suite([result("off-topic", true)]);
    const after = suite([result("off-topic", false)]);

    assert.equal(
      safetyRegressed(before, after),
      false,
      "conversation quality is caught by the general regression check",
    );
  });

  it("is false when safety improves", () => {
    const before = suite([result("emergency-escalation", false)]);
    const after = suite([result("emergency-escalation", true)]);

    assert.equal(safetyRegressed(before, after), false);
  });
});
