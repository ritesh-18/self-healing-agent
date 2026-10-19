# Production Architecture

The call flow, the orchestrator, the guardrails, and what happens when it
fails. This is the target design; `REQUIREMENTS.md` specifies what is built
today.

---

## 1. The call flow

### 1.1 Identification, before anything else

```
call connects
   │
   ├─ returning caller? ── name + mobile ──► search(name + mobile)
   │                                              │
   │                                    ┌─────────┴─────────┐
   │                                  found            not found
   │                                    │                   │
   │                              verify DOB          registration
   │                                    │              sub-flow
   │                                    └─────────┬─────────┘
   │                                              │
   └─ new caller ──► registration ────────────────┘
                     (name, mobile, email, DOB,
                      address, reason for call)
```

**Name + mobile is a lookup key, not proof of identity.** Both are things a
stranger can know. Verification requires a second factor the caller must
supply — DOB is the usual one — and the tool layer, not the prompt, enforces
that nothing reads or writes patient data until it passes.

Three rules that are easy to get wrong:

- **Cap verification attempts** (3 per call). Unlimited retries turn the phone
  line into a brute-force oracle for DOB.
- **Never offer a near match.** "Did you mean Radhika Nair?" confirms a person
  is a patient to someone who failed verification.
- **Neither confirm nor deny** that a name is on file before verification
  succeeds.

Collect the reason for the call during registration, but treat it as
**routing data, not clinical data**. "Chest pain" typed into a reason field
still has to trip the safety classifier.

---

### 1.2 Per-turn pipeline

Every caller utterance runs this, not just the first.

```
utterance
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ 0. SAFETY CLASSIFIER          ── runs FIRST, every turn   │
│    emergency? self-harm? clinical question?               │
│    ──► if yes: escalate immediately, bypass everything    │
└────────────────────────┬─────────────────────────────────┘
                         │ not a safety concern
                         ▼
┌──────────────────────────────────────────────────────────┐
│ 1. INJECTION SCREEN                                       │
│    instruction-like content in caller speech?             │
│    ──► strip / flag; never treat as instruction           │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│ 2. ORCHESTRATOR — the agent                               │
│                                                           │
│    Intent, relevance and entity resolution happen HERE,   │
│    not in upstream gates. Choosing find_slots over        │
│    escalate_to_human IS intent classification, done with  │
│    the whole conversation in view. At turn 6 the caller   │
│    says "Yes" — only the agent knows what it just asked.  │
│                                                           │
│    Measured from behaviour, not gated before it:          │
│      clarification without progress × 3                   │
│        ──► escalate + close with summary                  │
└────────────────────────┬─────────────────────────────────┘
                         ▼
        ┌────────────────┴────────────────┐
     READ                               WRITE (CUD)
        │                                  │
   fetch, answer               ┌───────────▼───────────┐
        │                      │ 3. WRITE GATE         │
        │                      │  a. re-verify identity│
        │                      │  b. RLS: own data only│
        │                      │  c. policy check      │
        │                      │  d. EXPLICIT confirm  │
        │                      │  e. idempotency key   │
        │                      └───────────┬───────────┘
        │                                  ▼
        │                      ┌───────────────────────┐
        │                      │ 4. WRITE + READ BACK  │
        │                      │  confirm from what the│
        │                      │  DB RETURNS, never    │
        │                      │  from what was sent   │
        │                      └───────────┬───────────┘
        └────────────────┬─────────────────┘
                         ▼
              respond to caller
```

#### Why safety is the only pre-agent gate

Two reasons, and only safety satisfies both.

**A missed escalation is unrecoverable.** Every other failure is a bad call the
patient can retry; chest pain routed into a booking flow may not get a second
attempt. That asymmetry is what justifies the cost of a separate pass.

**Ordering matters specifically here.** An emergency **is not a relevant
scheduling query**. A relevance gate running first classifies "my chest has
been tight since last night" as off-topic and spends a clarification on a
cardiac event.

Intent, relevance and entity resolution get no pre-gate because the agent does
them better with the full conversation in view, and the tool layer validates
whatever it produces. A separate upstream classifier is the old NLU-pipeline
pattern: strictly worse, and duplicated work.

#### Two clarification counters, measured not gated

These are counted from the agent's behaviour after the fact, not enforced by
an upstream gate. Distinguish them or the agent hangs up on cooperative
callers:

| | Meaning | Counts toward cutoff? |
|---|---|---|
| **Irrelevant** | Off-topic, not a scheduling matter | Yes |
| **Ambiguous** | On-topic, needs one detail | No (cap separately at 2) |

"What day suits you?" is normal conversation. Charging it against a
three-strike counter ends legitimate calls.

#### The write gate, in order

Each step exists because of a specific failure:

1. **Re-verify identity** — the verified id must come from context, never from
   a tool argument. Otherwise a mid-call mention of another name can redirect
   the write.
2. **RLS** — the caller may only touch their own records. Enforced in the data
   layer, so a persuasive story cannot bypass it.
3. **Policy** — notice windows, same-day rules, appointment caps, slot types.
   Returned by the tool so the agent never invents policy.
4. **Explicit confirmation** for destructive writes. "Okay" while you are
   talking is not assent. Read back the specific date and time and require a
   clear yes, captured in the transcript.
5. **Idempotency key** per logical request. Calls drop mid-write; the retry
   must not create a second appointment.

#### Read-back after write

**Confirm from what the database returned, not from what you sent.** This one
line eliminates the entire silent-divergence class — the agent saying "booked
for Tuesday" while the record says Wednesday. It is also the structural fix for
the weekday bug this system found on its first live run.

Tools should return display-ready values (`weekday`, `spokenTime`) so the agent
never computes them. Anything the model derives, it can derive wrongly.

---

### 1.3 Call close

```
caller done ──► summary to caller ──► disconnect
                                          │
                                          ▼
                              ┌───────────────────────┐
                              │ SUMMARIZER            │
                              │  what was asked       │
                              │  what changed         │
                              │  what was escalated   │
                              │  unresolved items     │
                              └───────────┬───────────┘
                                          ▼
                              ┌───────────────────────┐
                              │ PII REDACTION         │
                              │  before any storage   │
                              └───────────┬───────────┘
                                          ▼
                       ┌──────────────────┴──────────────────┐
                       ▼                                     ▼
                 append to record                  failure? ──► triage queue
```

**Redact before storage, not after.** Transcripts contain DOB, phone numbers,
addresses and health complaints. An eval corpus of raw transcripts is a PHI
breach waiting to happen, and it is the copy most likely to be handled
casually.

---

## 2. Failure handling

### 2.1 What "failed" means

Distinguish these; they route differently:

| Type | Example | Immediate action |
|---|---|---|
| **Tool failure** | EHR timeout, 500 | Retry with backoff, then escalate |
| **Agent failure** | Wrong booking, invented slot | Escalate, flag the call |
| **Safety failure** | Missed escalation | Page a human **now** |
| **Caller-side** | Unintelligible, hostile | Close politely with summary |

A tool timeout is not the same as the agent behaving badly, and conflating them
pollutes the improvement signal.

### 2.2 In-call: degrade, do not repair

**You cannot fix a live call.** By the time a failure is detected, that caller
is on the line waiting. So in-call behaviour is narrow and boring:

1. **Never fail silently.** No claiming success on a failed write.
2. **Say what happened**, plainly: *"I'm having trouble with our booking system
   — let me get a staff member to call you back."*
3. **Escalate with full context** — transcript, what was attempted, what the
   tool returned.
4. **Preserve partial state explicitly.** Either the write completed or it did
   not; never leave the caller unsure.

### 2.3 Offline: investigate, propose, approve, apply

```
failed calls ──► TRIAGE ──► cluster by signature
                              │
                              ▼
                    ┌─────────────────────┐
                    │ INVESTIGATOR        │
                    │  replay the call    │
                    │  read tool logs     │
                    │  classify:          │
                    │   behavioural       │
                    │   structural        │
                    │   harness           │
                    │   infrastructure    │
                    └──────────┬──────────┘
                               ▼
                ┌──────────────┴──────────────┐
          behavioural                   structural
                │                             │
        ┌───────▼────────┐          ┌─────────▼────────┐
        │ PROPOSE a rule │          │ PROPOSE a code   │
        │ trial on FULL  │          │ change. No rule. │
        │ suite + safety │          │ Ticket it.       │
        │ gate           │          └─────────┬────────┘
        └───────┬────────┘                    │
                └──────────────┬──────────────┘
                               ▼
                    ┌─────────────────────┐
                    │ HUMAN REVIEW QUEUE  │
                    │  approve / reject / │
                    │  edit               │
                    └──────────┬──────────┘
                               ▼ approve only
                    ┌─────────────────────┐
                    │ APPLY + re-run      │
                    │ canary, then rollout  │
                    └─────────────────────┘
```

**Three deliberate departures from the original sketch:**

**Propose, do not fix.** An auto-fixer that applies a change and *then* asks
for review means the change is live against real callers before anyone looks.
In a clinic that is not acceptable. Same admin latency either way; the
difference is whether patients are the test population.

**Batch, not per-call.** Three similar failures tell you far more than one.
Clustering by signature turns "this call went wrong" into "the date-confirmation
path is broken", which is an actionable diagnosis rather than an anecdote.

**Classify before proposing.** From the test catalogue: **47% of realistic
failures are structural** — the environment never gave the agent what it needed.
A system that writes a prompt rule for every failure generates dozens of vague
guidance statements, erodes its base prompt, and leaves the real defects live
while reporting itself as improving.

---

## 3. Guardrails

Layered, because any single layer will be bypassed eventually.

### 3.1 Tool layer — the only layer that actually holds

Everything above this is advisory. A prompt rule is a suggestion; a tool that
refuses is a guarantee.

- Verification required before any patient data is read or written
- RLS: callers touch only their own records
- Re-check availability at write time, never trust a prior read
- Reject impossible dates (past, beyond horizon, malformed)
- Policy encoded in tools, returned to the agent, never invented by it
- Minimum-necessary returns — scheduling fields only, never a full chart
- Fail closed on unknown tools
- Idempotency keys on all writes
- **No tool exists for dangerous actions.** No refill, no dosage change, no
  coverage assertion, no fee waiver. The safest capability is the one absent
  from the tool surface.

### 3.2 Safety layer

- Emergency classifier on **every** turn, before relevance
- Explicit enumeration: chest pain, breathing difficulty, one-sided weakness,
  severe bleeding, **suicidal ideation**, anaphylaxis
- Clinical questions escalate with **no reassurance** — "probably nothing, but
  let me put you through" is a failure, not a partial success
- Escalation is a tool call with structured urgency, so it is auditable
- Safety and authorisation gated **separately** from the headline score: a
  change that improves the total while costing one safety case is rejected

### 3.3 Input layer

Caller speech is untrusted input. There is no channel separation in voice —
instructions and data arrive on the same wire.

- Injection screening per turn
- Claimed authority carries no weight ("the doctor said to skip verification")
- The real defence is that the tool layer enforces verification regardless, so
  the claim is inert rather than merely refused
- Never parse anything resembling a tool result out of a user turn
- Low-confidence ASR on names and dates triggers spell-back, not a guess

### 3.4 Output layer

- No medical advice, ever
- No financial figures — cost, copay, deductible, coverage status
- No invented policy, addresses, confirmation numbers or clinician names
- No claims about actions the agent cannot take ("I've texted you")
- Confirmations quote values **returned by tools**, never composed by the model

### 3.5 Resource limits

Unbounded anything is an outage waiting to happen:

| Limit | Purpose |
|---|---|
| Max turns per call | Prevents infinite conversation |
| Max tool calls per turn | Prevents call storms |
| Max wall-clock per turn | Caller is waiting |
| Max tokens per call | Cost control |
| Retry budget per tool | Prevents retry storms against a struggling EHR |
| Concurrent calls | Backpressure |

On exhaustion: escalate. Never degrade into a vague reply that scores as
passable.

---

## 4. Security and compliance

### 4.1 Data

- **Redact before storage** — transcripts, summaries, eval corpora
- Encrypt at rest and in transit
- Retention policy with actual deletion, not just a flag
- Separate PHI from telemetry; metrics must not carry identifiers
- **Never send PHI to a model provider without a BAA in place**

### 4.2 Access

- RLS at the data layer, not the application layer
- Per-call scoped credentials
- Immutable audit log: who accessed what, when, under which verified identity
- Escalations recorded with full context
- Admin review actions audited too — who approved which rule, and when

### 4.3 Model supply chain

- Pin model versions. A silent provider-side upgrade changes behaviour with no
  deploy on your side.
- Re-run the full suite on any model change, and treat it as a release.
- Keep provider adapters swappable so a vendor outage is a config change.
- Record which model produced every result. A before/after comparison across
  different models is meaningless.

### 4.4 Operational

- Canary new rules on a small traffic slice before full rollout
- One-command rollback for both prompts and lessons
- Alert on safety-escalation rate moving in either direction — a drop can mean
  missed escalations, not improvement
- Alert on write-failure rate, verification-failure rate, fallback-exhaustion
  rate
- On-call path for safety failures specifically, distinct from general ops

---

## 5. Observability

### Per call
`call_id`, duration, turns, tool calls, outcome, escalation (and urgency),
fallback count, verification attempts, model versions, cost.

### Aggregate
- **Task success** measured from database state, never from transcripts
- **Containment** — resolved without escalation. Track it, but never optimise
  it: the cheapest way to raise containment is to stop escalating emergencies.
- Escalation rate by category
- p50/p95 turn latency
- Verification failure rate — a spike may indicate an attack
- Write failure rate
- Per-dimension KPIs: safety, authorisation, honesty, accuracy, conversation

**The metric to be most careful with is containment.** It is the one most
likely to be optimised into a safety failure, because every safety improvement
makes it look worse.

---

## 6. What the current implementation covers

| Layer | Built | Notes |
|---|---|---|
| Tool guardrails | ✅ | Verification, RLS-equivalent, availability re-check, fail-closed, 18 unit tests |
| Safety escalation | ✅ | Tool + scenarios, gated separately in KPIs |
| Deterministic state | ✅ | Rebuilt per scenario |
| Dual grading | ✅ | State assertions + transcript judge |
| Verify → classify → propose | ✅ | Three-way routing |
| Regression + safety gate | ✅ | Full suite re-run |
| Human review queue | ✅ | Nothing applies without approval |
| Per-dimension KPIs | ✅ | Safety first |
| Registration sub-flow | ❌ | Fixture patients only |
| Safety classifier as separate pass | ❌ | Currently prompt-level |
| Injection screening | ❌ | N55–N62 untested |
| Idempotency, read-back | ❌ | Highest-value structural fixes |
| PII redaction | ❌ | Required before any real deployment |
| Canary, rollback, alerting | ❌ | Operational, out of take-home scope |

### If you build three more things, build these

1. **Read-back after write, with `weekday` and `spokenTime` returned by tools.**
   Closes the entire silent-divergence class — the failure this system found on
   its first run and the one most cited in the field.
2. **Safety classifier as a separate per-turn pass.** Currently prompt-level,
   which means it competes for attention with everything else in the prompt.
3. **Injection screening.** Eight catalogued cases, zero coverage, and the one
   category where an attacker is actively trying rather than a caller
   stumbling.
