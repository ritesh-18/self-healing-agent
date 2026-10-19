-- Memory layer
--
-- Three kinds of memory exist in this system and only one of them wants
-- embeddings:
--
--   1. Conversation memory (within a call) - the agent's turn history and the
--      event log. Bounded by maxTurns, fits in context, needs no retrieval.
--
--   2. Patient memory (across calls) - records. "Which appointment does this
--      patient have" is a foreign key, not a similarity search. An
--      approximate match on which appointment to cancel is not acceptable.
--
--   3. Learned memory (lessons) - the only candidate, and even here
--      retrieval is off by default. See below.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Lesson embeddings
-- ---------------------------------------------------------------------------

-- Why this column exists before it is needed for retrieval:
--
-- The immediate value is DEDUPLICATION, not recall. The reflector proposes a
-- rule per failure, and nothing currently stops it proposing "confirm the
-- date before booking" when a near-identical rule already exists. That is the
-- monotonic-growth problem: lessons.json only ever gets longer, and
-- contradictory or redundant rules accumulate until they dilute the prompt.
-- A similarity check at proposal time catches that.
--
-- Retrieval is the second-order use and is deliberately NOT the default. The
-- agent loads every active lesson, because a semantically-retrieved subset can
-- silently omit a rule the current turn did not look relevant to - and for a
-- safety or authorisation rule, silent omission is the worst possible failure
-- mode. Retrieval only becomes worthwhile past roughly 50-100 lessons, and
-- then only as a hybrid: safety and authorisation rules always loaded,
-- situational rules retrieved.
ALTER TABLE lessons
  ADD COLUMN embedding vector(1024),
  -- Rules in these dimensions are NEVER subject to retrieval. They load on
  -- every turn regardless of similarity.
  ADD COLUMN always_load BOOLEAN NOT NULL DEFAULT FALSE;

-- Safety and authorisation rules pin themselves to always_load on insert.
CREATE OR REPLACE FUNCTION lessons_pin_critical() RETURNS trigger AS $$
BEGIN
  IF NEW.dimension IN ('safety', 'authorisation', 'escalation') THEN
    NEW.always_load := TRUE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lessons_pin_critical_trg
  BEFORE INSERT OR UPDATE ON lessons
  FOR EACH ROW EXECUTE FUNCTION lessons_pin_critical();

-- IVFFlat over cosine distance. Small list count because the table is small;
-- this is for dedup checks over tens of rows, not a recall benchmark.
CREATE INDEX lessons_embedding_idx
  ON lessons USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);

-- ---------------------------------------------------------------------------
-- Failure memory
-- ---------------------------------------------------------------------------

-- Findings get embeddings for a different reason: clustering.
--
-- The investigator groups failed calls by a structural signature (which tool
-- failed, which gate rejected). That catches identical failures but misses
-- ones that are the same problem described differently. Similarity over the
-- diagnosis text catches those, which is what turns "this call went wrong"
-- into "the date-confirmation path is broken" - a diagnosis rather than an
-- anecdote.
ALTER TABLE findings
  ADD COLUMN embedding vector(1024),
  -- Set when this finding is judged the same underlying problem as an earlier
  -- one, so frequency can be counted without double-reviewing.
  ADD COLUMN duplicate_of UUID REFERENCES findings(id) ON DELETE SET NULL;

CREATE INDEX findings_embedding_idx
  ON findings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);

CREATE INDEX findings_duplicate_idx ON findings (duplicate_of)
  WHERE duplicate_of IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Patient memory across calls
-- ---------------------------------------------------------------------------

-- Deliberately relational, with no embedding column.
--
-- This is the layer people most often reach for a vector store to solve, and
-- it is the one where it is most clearly wrong. Every question asked of it -
-- which appointments does this patient have, were they verified, what did
-- they ask for last time - is exact lookup by patient id. A similarity search
-- would be slower, fuzzier, and occasionally return another patient's record,
-- which in a clinic is not a degraded answer but a disclosure.
CREATE TABLE patient_memory (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    TEXT NOT NULL,
  call_id       TEXT REFERENCES calls(id) ON DELETE CASCADE,
  -- Redacted before storage, like everything else derived from a transcript.
  note          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'preference'
                  CHECK (kind IN ('preference', 'constraint', 'history')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patient_memory_patient_idx ON patient_memory (patient_id, created_at DESC);
