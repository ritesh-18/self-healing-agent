import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Lesson } from "../agent/prompt.js";
import type { FailureClass, Verdict } from "./verify.js";

/**
 * The human-in-the-loop review queue.
 *
 * Nothing the system learns reaches the agent without passing through here.
 * That is the point: an agent that rewrites its own instructions in a clinic
 * needs a person between "I think I should change" and "I changed".
 *
 * Each entry carries everything a reviewer needs to judge it without digging
 * through logs - the failing transcript, the verifier's diagnosis, the exact
 * proposed change, and what the change did to the scores. A reviewer can
 * approve, reject, or edit the rule before it lands.
 */

export type EntryStatus = "pending" | "approved" | "rejected";

export interface ReviewEntry {
  id: string;
  createdAt: string;
  scenarioId: string;
  scenarioTitle: string;

  /** What the verifier concluded. */
  verdict: Verdict;

  /**
   * The proposed lesson, for behavioural failures the loop can act on.
   * Absent for structural and harness entries, which need a human or a code
   * change rather than a prompt rule.
   */
  proposedLesson?: Lesson;

  /** Measured effect of applying the lesson, when the loop tried it. */
  effect?: {
    before: number;
    after: number;
    total: number;
    regressions: string[];
  };

  transcript: string;
  failedChecks: string[];

  status: EntryStatus;
  /** Filled in when a human acts on the entry. */
  reviewedAt?: string;
  reviewerNote?: string;
}

export interface Queue {
  entries: ReviewEntry[];
}

function queuePath(): string {
  return resolve(
    process.cwd(),
    process.env.REVIEW_QUEUE_PATH?.trim() || "review-queue.json",
  );
}

export function loadQueue(): Queue {
  const path = queuePath();
  if (!existsSync(path)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Queue>;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

export function saveQueue(queue: Queue): void {
  writeFileSync(queuePath(), JSON.stringify(queue, null, 2));
}

export function addEntry(
  entry: Omit<ReviewEntry, "id" | "createdAt" | "status">,
): ReviewEntry {
  const queue = loadQueue();
  const full: ReviewEntry = {
    ...entry,
    id: `r${queue.entries.length + 1}-${entry.scenarioId}`,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  queue.entries.push(full);
  saveQueue(queue);
  return full;
}

export function pending(queue: Queue = loadQueue()): ReviewEntry[] {
  return queue.entries.filter((e) => e.status === "pending");
}

/** Counts by classification, for the KPI line in reports. */
export function classificationCounts(
  queue: Queue = loadQueue(),
): Record<FailureClass, number> {
  const counts: Record<FailureClass, number> = {
    behavioural: 0,
    structural: 0,
    harness: 0,
  };
  for (const e of queue.entries) counts[e.verdict.classification]++;
  return counts;
}

export function setStatus(
  id: string,
  status: EntryStatus,
  note?: string,
): ReviewEntry | undefined {
  const queue = loadQueue();
  const entry = queue.entries.find((e) => e.id === id);
  if (!entry) return undefined;

  entry.status = status;
  entry.reviewedAt = new Date().toISOString();
  if (note) entry.reviewerNote = note;
  saveQueue(queue);
  return entry;
}

/** Replaces a proposed rule before approval, so a reviewer can sharpen it. */
export function editRule(id: string, rule: string): ReviewEntry | undefined {
  const queue = loadQueue();
  const entry = queue.entries.find((e) => e.id === id);
  if (!entry?.proposedLesson) return undefined;

  entry.proposedLesson.rule = rule;
  saveQueue(queue);
  return entry;
}
