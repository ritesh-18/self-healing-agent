import { strict as assert } from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  addEntry,
  classificationCounts,
  editRule,
  loadQueue,
  pending,
  setStatus,
} from "./queue.js";

/**
 * The review queue state machine.
 *
 * This is the human gate, so its guarantees are worth asserting directly:
 * entries start pending, a reviewer can sharpen a rule before approving it,
 * and structural entries carry no rule to approve in the first place.
 */

const QUEUE = "review-queue.queuetest.json";

beforeEach(() => {
  process.env.REVIEW_QUEUE_PATH = QUEUE;
  if (existsSync(QUEUE)) rmSync(QUEUE);
});

afterEach(() => {
  if (existsSync(QUEUE)) rmSync(QUEUE);
  delete process.env.REVIEW_QUEUE_PATH;
});

function behavioural(scenarioId = "happy-booking") {
  return addEntry({
    scenarioId,
    scenarioTitle: "A scenario",
    verdict: {
      real: true,
      classification: "behavioural",
      diagnosis: "agent chose badly",
      confidence: "high",
    },
    proposedLesson: {
      from: scenarioId,
      dimension: "date-confirmation",
      rule: "Confirm the date.",
      addedAt: new Date().toISOString(),
    },
    transcript: "PATIENT: hi",
    failedChecks: ["state: x"],
  });
}

function structural(scenarioId = "ambiguous-date") {
  return addEntry({
    scenarioId,
    scenarioTitle: "Ambiguous date",
    verdict: {
      real: true,
      classification: "structural",
      diagnosis: "tools never returned the weekday",
      proposedCodeChange: "find_slots should return a weekday field",
      confidence: "high",
    },
    transcript: "PATIENT: hi",
    failedChecks: ["state: y"],
  });
}

describe("lifecycle", () => {
  it("starts empty when no file exists", () => {
    assert.deepEqual(loadQueue().entries, []);
  });

  it("files new entries as pending", () => {
    const entry = behavioural();
    assert.equal(entry.status, "pending");
    assert.equal(pending().length, 1);
  });

  it("gives each entry a unique, traceable id", () => {
    const a = behavioural("happy-booking");
    const b = behavioural("reschedule");

    assert.notEqual(a.id, b.id);
    assert.match(a.id, /happy-booking/);
    assert.match(b.id, /reschedule/);
  });

  it("persists across loads", () => {
    behavioural();
    assert.equal(loadQueue().entries.length, 1);
  });
});

describe("review actions", () => {
  it("approving records a timestamp and removes it from pending", () => {
    const entry = behavioural();
    const updated = setStatus(entry.id, "approved", "looks right");

    assert.equal(updated?.status, "approved");
    assert.ok(updated?.reviewedAt);
    assert.equal(updated?.reviewerNote, "looks right");
    assert.equal(pending().length, 0);
  });

  it("rejecting also clears it from pending", () => {
    const entry = behavioural();
    setStatus(entry.id, "rejected", "too vague");

    assert.equal(pending().length, 0);
    assert.equal(loadQueue().entries[0]?.status, "rejected");
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    assert.equal(setStatus("nope", "approved"), undefined);
  });

  it("lets a reviewer sharpen the rule before approving", () => {
    const entry = behavioural();
    const edited = editRule(entry.id, "State the full calendar date aloud.");

    assert.equal(edited?.proposedLesson?.rule, "State the full calendar date aloud.");
    assert.equal(
      loadQueue().entries[0]?.proposedLesson?.rule,
      "State the full calendar date aloud.",
      "the edit must survive a reload",
    );
  });
});

describe("structural entries", () => {
  it("carry no proposed rule", () => {
    const entry = structural();
    assert.equal(
      entry.proposedLesson,
      undefined,
      "a structural failure has no prompt rule to approve",
    );
  });

  it("carry a proposed code change instead", () => {
    const entry = structural();
    assert.match(entry.verdict.proposedCodeChange ?? "", /weekday/);
  });

  it("cannot have a rule edited into existence", () => {
    const entry = structural();
    // editRule must refuse rather than inventing a lesson on a structural
    // entry - that would be exactly the prompt-patching this design avoids.
    assert.equal(editRule(entry.id, "Be careful with dates."), undefined);
    assert.equal(loadQueue().entries[0]?.proposedLesson, undefined);
  });
});

describe("classificationCounts", () => {
  it("counts by classification across all entries", () => {
    behavioural();
    behavioural("reschedule");
    structural();

    const counts = classificationCounts();
    assert.equal(counts.behavioural, 2);
    assert.equal(counts.structural, 1);
    assert.equal(counts.harness, 0);
  });

  it("keeps counting entries after they are reviewed", () => {
    const entry = behavioural();
    setStatus(entry.id, "approved");

    assert.equal(
      classificationCounts().behavioural,
      1,
      "counts are all-time, not just pending",
    );
  });
});
