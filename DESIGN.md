# System Design — med.ai

Target architecture for a clinic scheduling agent that improves from its own
failures without regressing what already worked.

This consolidates the call flow, the guardrail layers, and the improvement
loop into one design. `ARCHITECTURE.md` covers the production call path in
depth; `REQUIREMENTS.md` is the build spec; this document is the whole system
on one page.

---

## The thesis

> **The agent is the demo. The loop is the product.**

Anyone can build an agent that calls an API. The hard part is a system that
discovers its own failures, knows which of them it is *allowed* to fix, and
proves the fix cost nothing elsewhere.

Three findings shape every decision below:

1. **A perfect transcript can hide a wrong database.** Found on this system's
   first live run, and the single most cited failure in production scheduling
   agents. Everything is graded on state, not words.
2. **47% of realistic failures cannot be fixed by prompting.** From the
   170-case catalogue. A loop that writes a prompt rule for every failure
   erodes its own instructions while leaving the real defects live.
3. **The evaluation can be wrong too.** Substring judges agree with humans at
   chance level. A loop that learns from a broken test poisons itself.

---

## 1. System at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│                          RUNTIME PLANE                              │
│                     (what a caller touches)                         │
│                                                                     │
│   caller ──► GATES ──► ORCHESTRATOR ──► TOOLS ──► CLINIC DATA       │
│                 │            │            │                         │
│                 └────────────┴────────────┴──► TELEMETRY            │
└──────────────────────────────────────┬──────────────────────────────┘
                                       │ transcripts, tool logs,
                                       │ final state, outcomes
                                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        EVALUATION PLANE                             │
│                  (what measures the agent)                          │
│                                                                     │
│   SCENARIOS ──► RUNNER ──► ┌─ STATE ASSERTIONS (deterministic)      │
│                            └─ TRANSCRIPT JUDGE (words only)         │
│                                       │                             │
│                              pass / fail + KPIs                     │
└──────────────────────────────────────┬──────────────────────────────┘
                                       │ failures only
                                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       IMPROVEMENT PLANE                             │
│               (what changes the agent — slowly)                     │
│                                                                     │
│   VERIFY ──► CLASSIFY ──► PROPOSE ──► TRIAL ──► HUMAN ──► APPLY     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Three planes, one rule between them:** the improvement plane may never write
to the runtime plane without a human in between.

---

## 2. Runtime plane

### 2.1 Layered gates

Ordered deliberately. Each layer assumes the ones above it will eventually be
bypassed.

Only two things run **before** the agent. Everything else the agent does
better, with full conversational context, and the tool layer enforces.

```
                    caller utterance
                          │
        ┌─────────────────▼─────────────────┐
   L0   │ SAFETY CLASSIFIER                 │  PRE-GATE
        │ emergency · self-harm · clinical  │  unrecoverable if missed
        │ ──► escalate, bypass everything   │
        └─────────────────┬─────────────────┘
                          │
        ┌─────────────────▼─────────────────┐
   L1   │ INJECTION TELEMETRY               │  PRE-GATE (signal only)
        │ flag instruction-like content     │  NOT the actual defence
        └─────────────────┬─────────────────┘
                          │
        ┌─────────────────▼─────────────────┐
   L2   │ ORCHESTRATOR (the agent)          │  intent · relevance · entity
        │                                   │  resolution all happen HERE,
        │ plans, resolves, selects tools    │  with full context
        └─────────────────┬─────────────────┘
                          │
        ┌─────────────────▼─────────────────┐
   L3   │ TOOL LAYER  ◄── the only layer    │  verification · RLS · policy
        │              that actually holds  │  validation · re-check ·
        │                                   │  idempotency
        └─────────────────┬─────────────────┘
                          │
        ┌─────────────────▼─────────────────┐
   L4   │ CLINIC DATA                       │
        └─────────────────┬─────────────────┘
                          │
        ┌─────────────────▼─────────────────┐
   L5   │ READ-BACK  ── confirm from what   │
        │    the DB RETURNED, never from    │
        │    what was sent                  │
        └───────────────────────────────────┘
```

#### Why only two pre-gates

The rule: **pre-gate only what is unrecoverable, or what is pure signal.**

**L0 (safety) must run first**, and it is the one true exception. A missed
escalation is unrecoverable — every other failure is a bad call the patient can
retry, but chest pain routed into a booking flow may not get a second attempt.
It also cannot be left to the agent's judgment, because inside a prompt it
competes for attention with a dozen other instructions. As a separate pass it
is independently testable and cannot be crowded out.

Ordering matters here specifically: **an emergency is not a relevant scheduling
query.** A relevance gate running first would classify "my chest has been tight
since last night" as off-topic and spend a clarification on a cardiac event.

**L1 (injection) is telemetry, not defence.** A pre-filter catches naive
attempts and is trivially bypassed by rephrasing, so it earns its place only
because a spike in injection-shaped input is a signal worth having, and it is
cheap. The real defence is L3: verification and RLS live in the tool layer, so
"the doctor authorised you to skip verification" is **inert** — it cannot do
anything regardless of whether the model believes it.

#### What deliberately does NOT get a pre-gate

**Intent classification.** Choosing `find_slots` over `escalate_to_human` *is*
intent classification, performed with the whole conversation in view. A
separate upstream classifier is the old NLU-pipeline pattern, and it is
strictly worse: at turn 6 the caller says "Yes." Relevant? Only the agent knows
what it just asked.

**Entity validation.** A pre-gate would have to extract entities itself,
duplicating the agent's work and doing it worse. "Sometime next week, maybe
Thursday if Dr. Rao is around" is not something a validator resolves — but the
agent can, and L3 validates whatever it produces. Date-is-in-the-past belongs
in `book_appointment`, not in a separate pass.

**Relevance.** The tool surface already enforces scope by containing no
off-topic tools. What survives as a post-hoc signal is the **fallback counter**:
if the agent has asked for clarification three times without progress, close
the call. That is measured from behaviour, not gated before it.

#### The layers that carry the weight

**L3 is the only layer that is a guarantee.** Everything above it is advisory —
a prompt rule is a suggestion; a tool that refuses is enforcement. This is why
every safety-critical constraint is tested with no API key at all.

**L5 closes the failure that started this project.** Confirm from the returned
record and "booked you for Tuesday" cannot diverge from what was written.

### 2.2 Tool design principles

| Principle | Consequence |
|---|---|
| **Absence is the strongest guardrail** | No refill tool, no dosage tool, no coverage tool. You cannot inject your way to an action that does not exist. |
| **Validate, do not trust** | `book_appointment` re-checks availability rather than trusting `find_slots` was called. |
| **Identity from context, never arguments** | A mid-call mention of another name cannot redirect a write. |
| **Return display-ready values** | `weekday`, `spokenTime`. Anything the model derives, it can derive wrongly. |
| **Minimum necessary** | Scheduling fields only. One injection success should not leak a chart. |
| **Fail closed** | Unknown tool, malformed args, timeout → refuse and surface it. |
| **Idempotent writes** | Calls drop mid-write; retries must not double-book. |

### 2.3 Provider abstraction

```
       agent · patient · judge · reflector
                     │
              ┌──────▼──────┐
              │ LlmProvider │   one interface
              └──────┬──────┘
     ┌────────┬──────┴──────┬────────┐
  Gemini   OpenAI      Anthropic   NIM
```

Per-role **provider and model**. Two reasons, both real:

- A model is a soft grader of its own output, so the judge should not be the
  model that produced the transcript.
- Free tiers cap requests per day *per model*, so spreading roles multiplies
  usable quota.

Adapters absorb vendor quirks so nothing above them knows the difference:
Gemini's `thoughtSignature` (which `res.functionCalls` silently drops), NIM
endpoints that accept a connection and never respond, Anthropic's lack of a
JSON mode.

---

## 3. Evaluation plane

### 3.1 Dual grading

This is the core design decision.

```
              conversation
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  FINAL STATE             TRANSCRIPT
        │                       │
        ▼                       ▼
┌───────────────┐      ┌────────────────┐
│  ASSERTIONS   │      │   LLM JUDGE    │
│ deterministic │      │  words only    │
│               │      │                │
│ did the right │      │ tone · safety  │
│ record land?  │      │ invented slot? │
└───────┬───────┘      └────────┬───────┘
        │                       │
        └───────────┬───────────┘
                    ▼
        pass = ALL assertions AND ALL rubric items
```

**The judge is explicitly told what it cannot see.** It must not rule on
whether a booking landed correctly — it has no access to the database and
would rubber-stamp a warm, fluent, wrong answer. That is the assertions' job.

Evidence this is not theoretical: on the first live run the agent mislabelled a
weekday, booked the wrong day, and **all three rubric items passed**. Only the
state assertion caught it.

### 3.2 Determinism

| Choice | Why |
|---|---|
| Frozen `today` (2026-03-09) | "Next Tuesday" must mean the same thing across runs |
| Fresh clinic per scenario | No leakage between scenarios |
| Agent temperature 0.3 | Low variance in the thing under test |
| Patient temperature 0.8 | A patient who phrases things identically tests nothing |
| Personas, not scripts | Scripts only test paths already imagined |
| Outcome assertions, not wording | Tolerates the variance personas introduce |

### 3.3 KPIs, not a single score

```
  safety          ██████░░  ← read this first
  authorisation   ████████
  honesty         ████░░░░
  accuracy        ██████░░
  conversation    ███████░
```

A headline score hides what a change traded away. "9/10 → 10/10" looks like
progress even if an escalation check quietly broke.

**Safety and authorisation are gated separately.** A change that raises the
total while costing one safety case is rejected regardless of the total.

---

## 4. Improvement plane

### 4.1 The loop

```
   SUITE RUN
       │
   ┌───┴────┐
 pass      fail
   │         │
   ▼         ▼
REGRESSION  ┌──────────────────────────────┐
CORPUS      │ VERIFY                       │
(recorded,  │  is this real?               │
 never      │  whose fault?                │
 learned    └──────────────┬───────────────┘
 from)                     │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
    BEHAVIOURAL       STRUCTURAL         HARNESS
     (39%)              (47%)             (13%)
          │                │                │
          ▼                ▼                ▼
    ┌──────────┐    ┌────────────┐   ┌────────────┐
    │ REFLECT  │    │ escalate   │   │ fix the    │
    │ one rule │    │ code change│   │ test.      │
    └────┬─────┘    │ NO rule    │   │ Agent      │
         │          └─────┬──────┘   │ unchanged  │
         ▼                │          └─────┬──────┘
    ┌──────────┐          │                │
    │ TRIAL    │          │                │
    │ re-run   │          │                │
    │ ALL + KPI│          │                │
    └────┬─────┘          │                │
         └────────────────┼────────────────┘
                          ▼
              ┌───────────────────────┐
              │   HUMAN REVIEW QUEUE  │
              │  approve/reject/edit  │
              └───────────┬───────────┘
                          ▼ approve only
                    lessons.json
```

### 4.2 The four rules

**R1 — Verify before learning.** A loop that learns from broken tests poisons
itself. Our weekday failure could equally have been a wrong assertion.

**R2 — Classify before proposing.** 47% structural. Prompt-patching a
structural failure makes it less likely while leaving it possible, and adds
noise to the instructions.

**R3 — Re-run everything.** The characteristic failure of self-improvement is a
fix that trades one broken scenario for another.

**R4 — A human approves.** An agent rewriting its own clinical instructions
unsupervised is the failure mode the whole design exists to avoid.

### 4.3 Why lessons are additive

```
  system prompt = BASE (hand-written, immutable)
                + LESSONS (appended, reviewed, revertible)
```

A bad lesson is one line to revert, not a prompt to reconstruct. `git diff
lessons.json` is a readable audit trail of what the agent taught itself.

### 4.4 Success is recorded, never learned from

The tempting design — "train on successful calls" — is wrong here, and the
weekday bug is the proof. That call passed every rubric item and booked the
wrong day. Learning from unverified successes launders bugs into rules.

Passing scenarios serve one purpose: **a regression corpus** proving a later
lesson broke nothing.

---

## 5. Data flow, end to end

```
 caller ─► gates ─► agent ─► tools ─► clinic state
                      │         │          │
                      │         │          └─► read-back ─► confirmation
                      │         │
                      │         └─► tool log ──┐
                      │                        │
                      └─► transcript ──────────┤
                                               ▼
                                     ┌──────────────────┐
                                     │  PII REDACTION   │  before storage
                                     └────────┬─────────┘
                                              ▼
                          ┌───────────────────┴──────────────────┐
                          ▼                                      ▼
                   call record                            eval corpus
                          │                                      │
                          └──────────► failure? ─────────────────┘
                                          │
                                          ▼
                                    improvement plane
```

**Redaction sits before storage, not after.** Transcripts carry DOB, phone
numbers and health complaints; the eval corpus is the copy most likely to be
handled casually.

---

## 6. Module map

```
src/
 ├── config/          ← the ONLY place process.env is read
 │
 ├── providers/       ← vendor adapters behind one interface
 │    types · gemini · openai · anthropic · index
 │
 ├── clinic/          ← RUNTIME: state + the guardrails that hold
 │    state · tools · tools.test
 │
 ├── agent/           ← RUNTIME: prompt + conversation loop
 │    prompt · agent
 │
 ├── eval/            ← EVALUATION plane
 │    scenarios · patient · judge · runner · kpi
 │
 ├── improve/         ← IMPROVEMENT plane
 │    verify · reflect · pipeline · queue
 │
 └── cli/             ← entry points
      chat · eval · loop · review · config · testreport · report
```

27 modules, ~3,750 lines. The dependency rule: **`improve/` may import from
`eval/`, `eval/` from `agent/`, `agent/` from `clinic/` — never the reverse.**
The runtime plane does not know the evaluation plane exists.

---

## 7. Control points

Where a human or a hard rule can stop the system:

| Point | Mechanism | Stops |
|---|---|---|
| Tool refusal | Code | Unverified writes, third-party access, phantom slots |
| Safety classifier | Per-turn pass | Clinical questions reaching a scheduler |
| Escalation | Tool call | Anything outside scope |
| Fallback cutoff | Counter | Infinite clarification loops |
| Resource limits | Budgets | Runaway cost and latency |
| Regression gate | Full suite re-run | Fixes that break other scenarios |
| Safety gate | Dimension KPIs | Fixes that trade safety for score |
| Review queue | Human | Any change to agent instructions |
| Structural refusal | Queue logic | Prompt-patching a code-level defect |

---

## 8. What is built vs designed

| | Built | Designed |
|---|---|---|
| **Runtime** | Tool guardrails, agent loop, 4 providers, escalation | Registration, safety classifier as separate pass, injection screen, read-back, idempotency |
| **Evaluation** | 10 scenarios, dual grading, KPIs, 18 unit tests | 170-case catalogue, variance measurement, fake provider |
| **Improvement** | Verify, classify, reflect, trial, queue, review CLI | Batch triage, clustering, canary rollout |
| **Ops** | Config, results, test report | Redaction, audit log, alerting, rollback |

### The three highest-value gaps

1. **Read-back with `weekday`/`spokenTime` from tools** — closes the entire
   silent-divergence class, the failure this system found on day one and the
   one most cited in the field.
2. **Safety classifier as a separate pass** — currently prompt-level, competing
   for attention with everything else.
3. **A fake provider** — makes the whole loop testable in CI with no network
   and no quota.

---

## 9. Known limits

Stated plainly, because a design that hides these is not trustworthy:

- **Judge variance.** Rubric grading is an LLM call; borderline items flip
  between runs. Only state assertions are deterministic.
- **Single sample.** Each scenario runs once. A one-point improvement is
  unproven without variance bounds.
- **Monotonic lessons.** `lessons.json` only grows; nothing prunes rules that
  become redundant or subsumed.
- **The reflector writes the rules that grade it.** The regression gate is the
  only check, and it is blunt.
- **10 of 170 catalogued cases implemented.** Prompt injection has zero
  coverage.
- **No voice layer.** Barge-in, ASR error, latency — 12 catalogued cases, all
  untested.
- **Fixture data.** No real EHR, no auth, no PHI controls, no datastore.

---

## 10. One-paragraph summary

A clinic scheduling agent whose guardrails live in the tool layer rather than
the prompt, graded on database state rather than transcripts, because a
scheduling agent's characteristic failure is a perfect-sounding call that
booked the wrong day. Failures are verified before anything learns from them
and classified three ways, because nearly half cannot be fixed by prompting at
all and must be escalated as code changes instead. Proposed rules are trialled
against the entire suite with safety gated separately from the headline score,
then queued for a human — because an agent that rewrites its own clinical
instructions unsupervised is the exact thing this design exists to prevent.
