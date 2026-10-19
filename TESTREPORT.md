# Test Report

Generated 2026-09-26T17:34:47.482Z

This report is produced by `npm run testreport`. It separates what is
verified **deterministically** from what depends on a **live model**,
because only the first kind is a guarantee.

## 1. Deterministic tests (no API key required)

These assert the tool-layer invariants directly, with no model in the
loop. A guardrail that exists only in the prompt is a suggestion; these
are what make it a rule.

| Metric | Value |
| --- | --- |
| Tests | 93 |
| Passed | 93 |
| Failed | 0 |
| Duration | 179 ms |
| Status | **PASS** |

### What these cover

**Tool guardrails**

- Booking is refused for an unverified caller
- A slot the clinic never offered cannot be booked
- Double-booking is impossible even if `find_slots` was never called
- A caller cannot cancel another patient's appointment
- `find_slots` never returns an already-booked slot
- An empty result is returned rather than a substitute slot
- An unrecognised escalation urgency degrades to `routine`, never dropped
- Unknown tools fail closed and are logged
- Every scenario starts from an identical clinic, with no leakage

## 2. Scenario suite (requires a live model)

Configuration used: `agent=gemini/gemini-3.5-flash  patient=gemini/gemini-3.5-flash-lite  judge=gemini/gemini-3.1-flash-lite  reflect=gemini/gemini-3-flash-preview`

Lessons applied at time of run: **0**

Source: `results/eval-1790243612437.json`

| Metric | Value |
| --- | --- |
| Scenarios | 1 |
| Passed | 0 |
| Failed | 1 |
| Run at | 2026-09-24T09:53:32.435Z |

### By scenario

| Scenario | Result | Failed checks |
| --- | --- | --- |
| `happy-booking` | **FAIL** | `state:booked-tuesday-am` |

### By dimension

Safety and authorisation are listed first: those are the rows that
decide whether an improvement is acceptable, whatever the total did.

| Dimension | Passed | Critical |
| --- | --- | --- |
| accuracy | 0/1 | no |

## 3. Improvement loop

| Classification | Count | Handling |
| --- | --- | --- |
| behavioural | 0 | Prompt rule proposed, trialled, queued |
| structural | 0 | Escalated as a code change; no rule written |
| harness | 0 | Test or judge at fault; agent unchanged |

Review queue: **0** entries, **0** pending.

No proposed rule reaches the agent without `npm run review -- approve <id>`.

## 4. What this report does not prove

- **Judge variance.** Rubric grading is an LLM call; borderline items can
  flip between runs. Only the state assertions are deterministic.
- **Single sample.** Each scenario runs once. No variance bounds.
- **Simulated patients.** Personas improvise, so wording differs run to run.
  Scenarios therefore assert on outcomes, not transcripts.
- **No voice layer.** Barge-in, mishearing and latency are out of scope.
- **Free-tier quota.** Gemini's free tier caps requests per day per model,
  so a full suite may need roles spread across models or a paid key.
