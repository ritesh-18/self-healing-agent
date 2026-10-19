import cors from "cors";
import express from "express";
import { describeConfig, getConfig } from "../src/config/index.js";
import { isReachable } from "../src/db/pool.js";
import * as repo from "../src/db/repo.js";
import * as scenarios from "../src/db/scenarios.js";
import { checkInput, checkOutput } from "../src/guardrails/guardrails.js";
import { seedBuiltins } from "../src/db/scenarios.js";
import { startRun, runState } from "./runner.js";

/**
 * Dashboard API.
 *
 * Thin by design: every route maps to one repository call. The interesting
 * logic lives in the domain modules, and duplicating any of it here would
 * create a second path that could disagree with the CLI about what happened.
 *
 * One rule is enforced at this layer rather than below it: approving a review
 * that carries no proposed rule is refused. That is the structural escalation
 * guarantee, and it must hold whether the approval arrives from a terminal or
 * from a button.
 */

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const wrap =
  (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// --- health ----------------------------------------------------------------

app.get(
  "/api/health",
  wrap(async (_req, res) => {
    const db = await isReachable();
    let config = "";
    try {
      config = describeConfig(getConfig());
    } catch (err) {
      config = err instanceof Error ? err.message : "config error";
    }
    res.json({ ok: db, db, config });
  }),
);

// --- dashboard -------------------------------------------------------------

app.get(
  "/api/stats",
  wrap(async (_req, res) => res.json(await repo.dashboardStats())),
);

app.get(
  "/api/history",
  wrap(async (_req, res) => res.json(await repo.scenarioHistory())),
);

// --- runs ------------------------------------------------------------------

app.get(
  "/api/runs",
  wrap(async (req, res) =>
    res.json(await repo.listRuns(Number(req.query.limit ?? 50))),
  ),
);

app.get(
  "/api/runs/:id",
  wrap(async (req, res) => {
    const run = await repo.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    res.json({ run, results: await repo.getRunResults(req.params.id) });
  }),
);

app.get(
  "/api/results/:id",
  wrap(async (req, res) => {
    const result = await repo.getResult(req.params.id);
    if (!result) return res.status(404).json({ error: "not found" });
    res.json(result);
  }),
);

/**
 * Triggers a run.
 *
 * Returns immediately with a run id; the suite executes in the background and
 * the dashboard polls. A synchronous response would hold an HTTP connection
 * open for minutes and time out at every proxy in between.
 */
app.post(
  "/api/runs",
  wrap(async (req, res) => {
    const kind = req.body?.kind === "loop" ? "loop" : "eval";
    const only = Array.isArray(req.body?.only) ? req.body.only : undefined;

    if (runState.active) {
      return res.status(409).json({
        error: "a run is already in progress",
        runId: runState.runId,
      });
    }

    const runId = await startRun(kind, only);
    res.status(202).json({ runId, kind });
  }),
);

app.get("/api/runs/active/status", (_req, res) => res.json(runState));

// --- scenarios -------------------------------------------------------------

app.get(
  "/api/scenarios",
  wrap(async (_req, res) => res.json(await scenarios.listScenarios())),
);

app.post(
  "/api/scenarios",
  wrap(async (req, res) => {
    const b = req.body ?? {};
    if (!b.id || !b.title || !b.patient) {
      return res
        .status(400)
        .json({ error: "id, title and patient are required" });
    }
    if (!/^[a-z0-9-]+$/.test(b.id)) {
      return res
        .status(400)
        .json({ error: "id must be lowercase letters, digits and hyphens" });
    }

    await scenarios.upsertScenario({
      id: b.id,
      title: b.title,
      probes: b.probes,
      patient: b.patient,
      maxTurns: b.maxTurns,
      dimension: b.dimension,
      assertions: Array.isArray(b.assertions) ? b.assertions : [],
      rubric: Array.isArray(b.rubric) ? b.rubric : [],
      source: "user",
    });
    res.status(201).json(await scenarios.getScenario(b.id));
  }),
);

app.patch(
  "/api/scenarios/:id/enabled",
  wrap(async (req, res) => {
    await scenarios.setScenarioEnabled(req.params.id, Boolean(req.body?.enabled));
    res.json(await scenarios.getScenario(req.params.id));
  }),
);

app.delete(
  "/api/scenarios/:id",
  wrap(async (req, res) => {
    const deleted = await scenarios.deleteScenario(req.params.id);
    if (!deleted) {
      // Built-ins are the regression corpus; removing one from the UI would
      // quietly drop a guarantee.
      return res.status(403).json({
        error: "built-in scenarios can be disabled but not deleted",
      });
    }
    res.json({ deleted: true });
  }),
);

// --- reviews (HITL) --------------------------------------------------------

app.get(
  "/api/reviews",
  wrap(async (req, res) =>
    res.json(await repo.listReviews(req.query.status as string | undefined)),
  ),
);

app.get(
  "/api/reviews/:id",
  wrap(async (req, res) => {
    const review = await repo.getReview(req.params.id);
    if (!review) return res.status(404).json({ error: "not found" });
    res.json(review);
  }),
);

app.patch(
  "/api/reviews/:id/rule",
  wrap(async (req, res) => {
    const rule = String(req.body?.rule ?? "").trim();
    if (!rule) return res.status(400).json({ error: "rule is required" });
    await repo.updateReviewRule(req.params.id, rule);
    res.json(await repo.getReview(req.params.id));
  }),
);

app.post(
  "/api/reviews/:id/approve",
  wrap(async (req, res) => {
    const result = await repo.approveReview(req.params.id, req.body?.note);
    if (!result.ok) return res.status(409).json({ error: result.reason });
    res.json(result);
  }),
);

app.post(
  "/api/reviews/:id/reject",
  wrap(async (req, res) => {
    const ok = await repo.rejectReview(req.params.id, req.body?.note);
    if (!ok) return res.status(409).json({ error: "not pending" });
    res.json({ rejected: true });
  }),
);

// --- lessons ---------------------------------------------------------------

app.get(
  "/api/lessons",
  wrap(async (_req, res) => res.json(await repo.listLessons())),
);

app.post(
  "/api/lessons/:id/retire",
  wrap(async (req, res) => {
    const ok = await repo.retireLesson(req.params.id);
    if (!ok) return res.status(409).json({ error: "already retired" });
    res.json({ retired: true });
  }),
);

// --- calls -----------------------------------------------------------------

app.get(
  "/api/calls",
  wrap(async (_req, res) => res.json(await repo.listCalls())),
);

// --- guardrails ------------------------------------------------------------

/** Lets a reviewer test phrasing against the guardrails without a full run. */
app.post("/api/guardrails/check", (req, res) => {
  const text = String(req.body?.text ?? "");
  res.json({ input: checkInput(text), output: checkOutput(text) });
});

// --- errors ----------------------------------------------------------------

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[api]", err.message);
    res.status(500).json({ error: err.message });
  },
);

/**
 * Seeds the built-in scenario suite on boot.
 *
 * Idempotent, so it runs on every start rather than needing a separate
 * command. Without it a fresh database has no scenarios and the dashboard
 * looks broken rather than empty - which is a worse first impression than
 * it deserves. A seeding failure must not stop the API: the database may
 * simply still be starting, and the next restart will pick it up.
 */
async function bootstrap(): Promise<void> {
  try {
    const n = await seedBuiltins();
    console.log(`[api] ${n} built-in scenarios ready`);
  } catch (err) {
    console.error(
      "[api] scenario seeding skipped:",
      err instanceof Error ? err.message : err,
    );
  }
}

const port = Number(process.env.PORT ?? 4000);
app.listen(port, async () => {
  console.log(`[api] listening on :${port}`);
  await bootstrap();
});
