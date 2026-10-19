-- med.ai schema
--
-- The shape follows the system's own causality: a run produces scenario
-- results, each result is one call with an event log, a failing result
-- produces a finding, and a finding may produce a review a human acts on.
-- Keeping those as real foreign keys rather than embedded documents is what
-- lets the dashboard answer "which lesson fixed which scenario, and who
-- approved it" in one query.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Scenarios
-- ---------------------------------------------------------------------------

-- Scenarios live in the database so they can be created from the dashboard.
-- The code-defined suite is seeded in on first run; `source` records which is
-- which, because a user-authored scenario that turns out to be wrong is a
-- harness failure, not an agent failure.
CREATE TABLE scenarios (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  probes        TEXT NOT NULL DEFAULT '',
  patient       TEXT NOT NULL,
  max_turns     INT  NOT NULL DEFAULT 8,
  dimension     TEXT NOT NULL DEFAULT 'conversation',
  -- Assertions are stored as declarative descriptors rather than functions;
  -- see src/db/assertions.ts for the interpreter.
  assertions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  rubric        JSONB NOT NULL DEFAULT '[]'::jsonb,
  source        TEXT NOT NULL DEFAULT 'builtin'
                  CHECK (source IN ('builtin', 'user')),
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

CREATE TABLE runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL CHECK (kind IN ('eval', 'loop')),
  status        TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed')),
  -- Which models produced this. A before/after comparison across different
  -- models is meaningless, so it is recorded rather than assumed.
  config        TEXT NOT NULL DEFAULT '',
  -- Lessons in force when the run started, so a score can be attributed.
  lessons_count INT  NOT NULL DEFAULT 0,
  passed        INT  NOT NULL DEFAULT 0,
  total         INT  NOT NULL DEFAULT 0,
  duration_ms   INT,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX runs_started_idx ON runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Scenario results (one call each)
-- ---------------------------------------------------------------------------

CREATE TABLE scenario_results (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  scenario_id   TEXT NOT NULL,
  title         TEXT NOT NULL,
  passed        BOOLEAN NOT NULL,
  dimension     TEXT NOT NULL DEFAULT 'conversation',
  turns         INT  NOT NULL DEFAULT 0,
  duration_ms   INT  NOT NULL DEFAULT 0,
  transcript    TEXT NOT NULL DEFAULT '',
  -- Graded twice, on purpose: state assertions are deterministic, the rubric
  -- is an LLM judging words it can verify and nothing else.
  assertions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  rubric        JSONB NOT NULL DEFAULT '[]'::jsonb,
  failures      JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary       JSONB,
  -- Route quality: unexpected tools, writes before verification, repeats.
  audit         JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX scenario_results_run_idx ON scenario_results (run_id);
CREATE INDEX scenario_results_scenario_idx ON scenario_results (scenario_id);
CREATE INDEX scenario_results_failed_idx ON scenario_results (passed)
  WHERE passed = FALSE;

-- ---------------------------------------------------------------------------
-- Call events
-- ---------------------------------------------------------------------------

-- The event log is the record of what actually happened. `appointment.booked`
-- is emitted from the tool result, not from the agent's intent, so this table
-- cannot claim a booking that never occurred.
CREATE TABLE call_events (
  id            BIGSERIAL PRIMARY KEY,
  result_id     UUID NOT NULL REFERENCES scenario_results(id) ON DELETE CASCADE,
  seq           INT  NOT NULL,
  call_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  at            TIMESTAMPTZ NOT NULL,
  UNIQUE (result_id, seq)
);

CREATE INDEX call_events_result_idx ON call_events (result_id, seq);
CREATE INDEX call_events_name_idx ON call_events (name);

-- ---------------------------------------------------------------------------
-- Findings and the human review queue
-- ---------------------------------------------------------------------------

-- A verified, classified failure. The classification decides what CAN be
-- done: behavioural failures get a prompt rule, structural ones get escalated
-- as code changes, harness ones mean the test was wrong.
CREATE TABLE findings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  result_id       UUID REFERENCES scenario_results(id) ON DELETE SET NULL,
  scenario_id     TEXT NOT NULL,
  classification  TEXT NOT NULL
                    CHECK (classification IN ('behavioural', 'structural', 'harness')),
  is_real         BOOLEAN NOT NULL DEFAULT TRUE,
  confidence      TEXT NOT NULL DEFAULT 'medium'
                    CHECK (confidence IN ('low', 'medium', 'high')),
  diagnosis       TEXT NOT NULL DEFAULT '',
  proposed_code_change TEXT,
  failed_checks   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX findings_run_idx ON findings (run_id);

-- Nothing reaches the agent without passing through here. A structural
-- finding has no proposed_rule, and the API refuses to approve one into
-- existence - that would be exactly the prompt-patching this design avoids.
CREATE TABLE reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id      UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  proposed_rule   TEXT,
  dimension       TEXT,
  -- Measured effect of trialling the rule against the FULL suite.
  effect_before   INT,
  effect_after    INT,
  effect_total    INT,
  regressions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_regressed BOOLEAN NOT NULL DEFAULT FALSE,
  reviewer_note   TEXT,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reviews_status_idx ON reviews (status);

-- ---------------------------------------------------------------------------
-- Lessons
-- ---------------------------------------------------------------------------

-- Learned rules, appended to the agent's prompt. Additive and revertible by
-- design: a bad lesson is one row to deactivate rather than a prompt to
-- reconstruct, and the review that approved it is recorded alongside.
CREATE TABLE lessons (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id     UUID REFERENCES reviews(id) ON DELETE SET NULL,
  from_scenario TEXT NOT NULL,
  dimension     TEXT NOT NULL DEFAULT 'general',
  rule          TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at    TIMESTAMPTZ
);

CREATE INDEX lessons_active_idx ON lessons (active) WHERE active = TRUE;

-- ---------------------------------------------------------------------------
-- Live calls from the orchestrator (not from the eval harness)
-- ---------------------------------------------------------------------------

CREATE TABLE calls (
  id            TEXT PRIMARY KEY,
  outcome       TEXT NOT NULL DEFAULT 'completed',
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  turns         INT NOT NULL DEFAULT 0,
  -- Redacted before storage. Transcripts carry DOB, phone numbers and health
  -- complaints, and this is the copy most likely to be handled casually.
  narrative     TEXT NOT NULL DEFAULT '',
  escalations   JSONB NOT NULL DEFAULT '[]'::jsonb,
  unresolved    JSONB NOT NULL DEFAULT '[]'::jsonb,
  failures      JSONB NOT NULL DEFAULT '[]'::jsonb,
  events        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX calls_created_idx ON calls (created_at DESC);
