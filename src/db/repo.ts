import type { SuiteResult } from "../eval/runner.js";
import { auditScenario } from "../eval/audit.js";
import { dimensionScores } from "../eval/kpi.js";
import type { PipelineOutcome } from "../improve/pipeline.js";
import type { CallSummary } from "../orchestrator/summarize.js";
import type { CallEvent } from "../events/types.js";
import { one, query, transaction } from "./pool.js";

/**
 * Persistence.
 *
 * Everything the system produces lands here, so the dashboard can query
 * across runs and a review decision has a durable home. The CLI and the API
 * both write through this module - there is deliberately no second path that
 * could disagree about what was recorded.
 */

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunRow {
  id: string;
  kind: "eval" | "loop";
  status: "running" | "completed" | "failed";
  config: string;
  lessons_count: number;
  passed: number;
  total: number;
  duration_ms: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export async function createRun(
  kind: "eval" | "loop",
  config: string,
  lessonsCount: number,
): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO runs (kind, config, lessons_count) VALUES ($1, $2, $3)
     RETURNING id`,
    [kind, config, lessonsCount],
  );
  return row!.id;
}

export async function failRun(runId: string, error: string): Promise<void> {
  await query(
    `UPDATE runs SET status = 'failed', error = $2, finished_at = now()
     WHERE id = $1`,
    [runId, error.slice(0, 2000)],
  );
}

/**
 * Saves a completed suite: the run, every scenario result, and every event.
 *
 * One transaction, because a half-written run shows in the dashboard as a
 * scenario with no event log - which looks like a bug in the agent rather
 * than an interrupted write.
 */
export async function saveSuite(
  runId: string,
  suite: SuiteResult,
  durationMs: number,
): Promise<void> {
  const dims = new Map(
    dimensionScores(suite).flatMap((d) =>
      d.scenarioIds.map((id) => [id, d.dimension] as const),
    ),
  );

  await transaction(async (client) => {
    await client.query(
      `UPDATE runs SET status = 'completed', passed = $2, total = $3,
       duration_ms = $4, finished_at = now() WHERE id = $1`,
      [runId, suite.passed, suite.total, durationMs],
    );

    for (const r of suite.results) {
      const audit = auditScenario(r);

      const res = await client.query<{ id: string }>(
        `INSERT INTO scenario_results
           (run_id, scenario_id, title, passed, dimension, turns, duration_ms,
            transcript, assertions, rubric, failures, summary, audit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          runId,
          r.id,
          r.title,
          r.pass,
          dims.get(r.id) ?? "conversation",
          r.turns,
          r.durationMs,
          r.transcript,
          JSON.stringify(r.assertions),
          JSON.stringify(r.rubric),
          JSON.stringify(r.failures),
          JSON.stringify(r.summary),
          JSON.stringify({
            totalCalls: audit.totalCalls,
            failedCalls: audit.failedCalls,
            findings: audit.findings,
            calls: audit.calls,
          }),
        ],
      );

      const resultId = res.rows[0]!.id;

      for (const e of r.events) {
        await client.query(
          `INSERT INTO call_events (result_id, seq, call_id, name, payload, at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [resultId, e.seq, e.callId, e.name, JSON.stringify(e.payload), e.at],
        );
      }
    }
  });
}

export async function listRuns(limit = 50): Promise<RunRow[]> {
  return query<RunRow>(
    `SELECT * FROM runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
}

export async function getRun(runId: string): Promise<RunRow | undefined> {
  return one<RunRow>(`SELECT * FROM runs WHERE id = $1`, [runId]);
}

export async function getRunResults(runId: string) {
  return query(
    `SELECT id, scenario_id, title, passed, dimension, turns, duration_ms,
            failures, audit
     FROM scenario_results WHERE run_id = $1 ORDER BY scenario_id`,
    [runId],
  );
}

export async function getResult(resultId: string) {
  const result = await one(
    `SELECT * FROM scenario_results WHERE id = $1`,
    [resultId],
  );
  if (!result) return undefined;

  const events = await query(
    `SELECT seq, name, payload, at FROM call_events
     WHERE result_id = $1 ORDER BY seq`,
    [resultId],
  );
  return { ...result, events };
}

/**
 * Pass rate per scenario over time.
 *
 * This is what turns a single run into evidence. One failing run is an
 * anecdote; a scenario that passes four times out of five is a flake, and the
 * dashboard should show the difference rather than hide it behind a latest-run
 * number.
 */
export async function scenarioHistory(limit = 20) {
  return query(
    `SELECT scenario_id,
            count(*)::int                                        AS runs,
            sum(CASE WHEN passed THEN 1 ELSE 0 END)::int         AS passes,
            round(avg(duration_ms))::int                         AS avg_ms,
            bool_or(passed) AND NOT bool_and(passed)             AS flaky
     FROM (
       SELECT sr.* FROM scenario_results sr
       JOIN runs r ON r.id = sr.run_id
       WHERE r.status = 'completed'
       ORDER BY r.started_at DESC
       LIMIT $1 * 20
     ) recent
     GROUP BY scenario_id ORDER BY scenario_id`,
    [limit],
  );
}

// ---------------------------------------------------------------------------
// Findings and reviews
// ---------------------------------------------------------------------------

/**
 * Records what the improvement pipeline produced.
 *
 * A behavioural finding carries a proposed rule and its measured effect; a
 * structural one carries a code change and deliberately no rule. The review
 * row is created either way, because a human still decides what happens next.
 */
export async function saveOutcome(
  runId: string,
  outcome: PipelineOutcome,
): Promise<{ findingId: string; reviewId: string }> {
  return transaction(async (client) => {
    const resultId = await client.query<{ id: string }>(
      `SELECT id FROM scenario_results
       WHERE run_id = $1 AND scenario_id = $2 LIMIT 1`,
      [runId, outcome.scenarioId],
    );

    const finding = await client.query<{ id: string }>(
      `INSERT INTO findings
         (run_id, result_id, scenario_id, classification, is_real, confidence,
          diagnosis, proposed_code_change, failed_checks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        runId,
        resultId.rows[0]?.id ?? null,
        outcome.scenarioId,
        outcome.verdict.classification,
        outcome.verdict.real,
        outcome.verdict.confidence,
        outcome.verdict.diagnosis,
        outcome.verdict.proposedCodeChange ?? null,
        JSON.stringify(outcome.entry.failedChecks),
      ],
    );

    const findingId = finding.rows[0]!.id;
    const trial = outcome.trial;

    const review = await client.query<{ id: string }>(
      `INSERT INTO reviews
         (finding_id, proposed_rule, dimension, effect_before, effect_after,
          effect_total, regressions, safety_regressed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        findingId,
        outcome.entry.proposedLesson?.rule ?? null,
        outcome.entry.proposedLesson?.dimension ?? null,
        trial?.before.passed ?? null,
        trial?.after.passed ?? null,
        trial?.after.total ?? null,
        JSON.stringify(trial?.regressions ?? []),
        trial?.safetyRegressed ?? false,
      ],
    );

    return { findingId, reviewId: review.rows[0]!.id };
  });
}

export async function listReviews(status?: string) {
  return query(
    `SELECT rv.*, f.scenario_id, f.classification, f.diagnosis, f.confidence,
            f.is_real, f.proposed_code_change, f.failed_checks, f.result_id
     FROM reviews rv
     JOIN findings f ON f.id = rv.finding_id
     ${status ? "WHERE rv.status = $1" : ""}
     ORDER BY rv.created_at DESC`,
    status ? [status] : [],
  );
}

export async function getReview(reviewId: string) {
  return one(
    `SELECT rv.*, f.scenario_id, f.classification, f.diagnosis, f.confidence,
            f.is_real, f.proposed_code_change, f.failed_checks, f.result_id
     FROM reviews rv
     JOIN findings f ON f.id = rv.finding_id
     WHERE rv.id = $1`,
    [reviewId],
  );
}

export async function updateReviewRule(
  reviewId: string,
  rule: string,
): Promise<void> {
  await query(
    `UPDATE reviews SET proposed_rule = $2 WHERE id = $1 AND status = 'pending'`,
    [reviewId, rule],
  );
}

/**
 * Approves a review, creating the lesson it carries.
 *
 * A review with no proposed rule cannot be approved. That is the structural
 * refusal: escalating a code change must not be convertible into a prompt
 * patch by clicking approve, because prompt-patching a structural defect
 * makes it less likely while leaving it possible.
 */
export async function approveReview(
  reviewId: string,
  note?: string,
): Promise<{ ok: boolean; reason?: string; lessonId?: string }> {
  return transaction(async (client) => {
    const rv = await client.query<{
      id: string;
      status: string;
      proposed_rule: string | null;
      dimension: string | null;
      classification: string;
      scenario_id: string;
    }>(
      `SELECT rv.id, rv.status, rv.proposed_rule, rv.dimension,
              f.classification, f.scenario_id
       FROM reviews rv JOIN findings f ON f.id = rv.finding_id
       WHERE rv.id = $1 FOR UPDATE`,
      [reviewId],
    );

    const row = rv.rows[0];
    if (!row) return { ok: false, reason: "not_found" };
    if (row.status !== "pending") return { ok: false, reason: "already_reviewed" };

    if (!row.proposed_rule) {
      return {
        ok: false,
        reason:
          `This finding is classified "${row.classification}", which needs a ` +
          `code change or a test fix rather than a prompt rule. Reject it ` +
          `once handled, with a note saying how.`,
      };
    }

    const lesson = await client.query<{ id: string }>(
      `INSERT INTO lessons (review_id, from_scenario, dimension, rule)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [reviewId, row.scenario_id, row.dimension ?? "general", row.proposed_rule],
    );

    await client.query(
      `UPDATE reviews SET status = 'approved', reviewer_note = $2,
       reviewed_at = now() WHERE id = $1`,
      [reviewId, note ?? null],
    );

    return { ok: true, lessonId: lesson.rows[0]!.id };
  });
}

export async function rejectReview(
  reviewId: string,
  note?: string,
): Promise<boolean> {
  const rows = await query(
    `UPDATE reviews SET status = 'rejected', reviewer_note = $2,
     reviewed_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`,
    [reviewId, note ?? null],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

export interface LessonRow {
  id: string;
  from_scenario: string;
  dimension: string;
  rule: string;
  active: boolean;
  always_load: boolean;
  created_at: string;
}

export async function activeLessons(): Promise<LessonRow[]> {
  return query<LessonRow>(
    `SELECT * FROM lessons WHERE active ORDER BY created_at`,
  );
}

export async function listLessons(): Promise<LessonRow[]> {
  return query<LessonRow>(`SELECT * FROM lessons ORDER BY created_at DESC`);
}

/** Retires a lesson rather than deleting it, so the audit trail survives. */
export async function retireLesson(lessonId: string): Promise<boolean> {
  const rows = await query(
    `UPDATE lessons SET active = FALSE, retired_at = now()
     WHERE id = $1 AND active RETURNING id`,
    [lessonId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Calls from the orchestrator
// ---------------------------------------------------------------------------

export async function saveCall(
  summary: CallSummary,
  events: CallEvent[],
): Promise<void> {
  await query(
    `INSERT INTO calls (id, outcome, verified, turns, narrative, escalations,
       unresolved, failures, events)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       outcome = EXCLUDED.outcome, verified = EXCLUDED.verified,
       turns = EXCLUDED.turns, narrative = EXCLUDED.narrative,
       escalations = EXCLUDED.escalations, unresolved = EXCLUDED.unresolved,
       failures = EXCLUDED.failures, events = EXCLUDED.events`,
    [
      summary.callId,
      summary.outcome,
      summary.verified,
      summary.turns,
      summary.narrative,
      JSON.stringify(summary.escalations),
      JSON.stringify(summary.unresolved),
      JSON.stringify(summary.failures),
      JSON.stringify(events),
    ],
  );
}

export async function listCalls(limit = 50) {
  return query(
    `SELECT id, outcome, verified, turns, narrative, created_at
     FROM calls ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

export async function dashboardStats() {
  const latest = await one<RunRow>(
    `SELECT * FROM runs WHERE status = 'completed' AND kind = 'eval'
     ORDER BY started_at DESC LIMIT 1`,
  );

  const [pending] = await query<{ n: string }>(
    `SELECT count(*) AS n FROM reviews WHERE status = 'pending'`,
  );
  const [lessons] = await query<{ n: string }>(
    `SELECT count(*) AS n FROM lessons WHERE active`,
  );
  const [runs] = await query<{ n: string }>(`SELECT count(*) AS n FROM runs`);

  const byDimension = latest
    ? await query(
        `SELECT dimension,
                count(*)::int AS total,
                sum(CASE WHEN passed THEN 1 ELSE 0 END)::int AS passed
         FROM scenario_results WHERE run_id = $1
         GROUP BY dimension ORDER BY dimension`,
        [latest.id],
      )
    : [];

  const classifications = await query(
    `SELECT classification, count(*)::int AS n
     FROM findings GROUP BY classification`,
  );

  return {
    latestRun: latest ?? null,
    pendingReviews: Number(pending?.n ?? 0),
    activeLessons: Number(lessons?.n ?? 0),
    totalRuns: Number(runs?.n ?? 0),
    byDimension,
    classifications,
  };
}
