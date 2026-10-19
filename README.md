# med.ai

A clinic scheduling agent, an evaluation harness that finds its failures, and
a dashboard where a human decides what it learns from them.

> **The agent is the demo. The loop is the product.**

Anyone can build an agent that calls an API. The hard part is a system that
discovers its own failures, knows which of them it is *allowed* to fix, and
proves the fix cost nothing elsewhere.

---

## Quick start

Needs Docker and an API key for one model provider. Nothing else.

```bash
cp .env.example .env     # fill in one provider — see below
docker compose up -d     # Postgres + S3 + API + dashboard
```

Open **http://localhost:5173**. The database schema and the 13 built-in
scenarios are created on first boot; there is no separate seed step.

### Configuring a provider

Open `.env` and set `LLM_PROVIDER` plus that provider's key. One is enough.

**AWS Bedrock** (the default) reads the normal AWS credential chain, so if
`aws sts get-caller-identity` works on your machine it will work here —
compose mounts `~/.aws` into the container read-only.

```
LLM_PROVIDER=bedrock
AWS_REGION=us-east-1
```

**Gemini, OpenAI, Anthropic or NVIDIA** take a key directly:

```
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
```

One caveat worth knowing: Gemini's free tier allows 20 requests per day per
model, and a single suite run needs roughly 150. Enable billing on the API
project, or use a different provider.

Check it resolved before spending tokens:

```bash
npm run config
```

### What is running

| Service | URL | What it is |
|---|---|---|
| Dashboard | http://localhost:5173 | React UI — runs, failures, review queue |
| API | http://localhost:4000 | REST, also proxied at `/api` |
| Postgres | `localhost:5434` | Runs, events, findings, reviews, lessons |
| S3 (SeaweedFS) | `localhost:8333` | Trace payloads |

### Using the CLI instead

The CLI writes to the same database, so you can mix the two freely. It needs
`npm install` first, and the containers running for anything that persists.

```bash
npm run config      # print resolved config, verify credentials
npm run eval        # score the suite, change nothing
npm run loop        # score, investigate failures, queue proposals
npm run call        # talk to the agent through the full pipeline
npm run review      # approve or reject queued proposals
npm run test        # 131 tests, no API key, no network, no containers
npm run testreport  # regenerate TESTREPORT.md
```

`npm run test` is the one thing that needs no setup at all — it covers the
tool-layer guarantees and the improvement loop against a scripted provider.

### Starting over

```bash
docker compose down -v   # -v also deletes the database and trace volumes
docker compose up -d
```

### If something looks wrong

| Symptom | Cause |
|---|---|
| Dashboard loads but is empty | No runs yet. Go to **Runs** and start one |
| `Could not load credentials` | AWS chain not reaching the container. Check `~/.aws` exists, then `docker compose restart api` |
| `GEMINI_API_KEY is empty` | `.env` missing or not filled in for the selected `LLM_PROVIDER` |
| Port already allocated | Something else holds 5434, 4000, 5173 or 8333. Change the host side of the mapping in `docker-compose.yml` |
| Run stuck on "running scenarios" | Normal for ~3 minutes. Longer: `docker logs medai-api` |

---

## What it does

### 1. The agent

Handles a multi-turn scheduling call through five deliberately narrow tools:
`lookup_patient`, `find_slots`, `book_appointment`, `cancel_appointment`,
`escalate_to_human`.

There is no `answer_medical_question` tool, no refill tool, no coverage tool.
**The strongest guardrail is an action that does not exist** — you cannot
prompt-inject your way to a capability that was never exposed.

### 2. The orchestrator

Every caller utterance runs through a layered pipeline:

```
utterance
  │
  ├─ L0  SAFETY CLASSIFIER     runs first, every turn, can bypass everything
  ├─ L1  INJECTION TELEMETRY   signal only, not the defence
  ├─ L2  ORCHESTRATOR          intent, entities and tool choice live here
  ├─ L3  TOOL LAYER            ◄── the only layer that is a guarantee
  ├─ L4  CLINIC DATA
  └─ L5  READ-BACK             confirm from what the DB returned
```

Only two things run *before* the agent, and the rule is: **pre-gate only what
is unrecoverable, or what is pure signal.**

Safety is the unrecoverable one. A missed escalation cannot be retried, and
an emergency is not a "relevant" scheduling query — a relevance gate running
first would spend a clarification on a cardiac event.

Everything else the agent does better with full conversational context, and
the tool layer validates whatever it produces.

### 3. The evaluation harness

13 scenarios weighted toward failure: an emergency mid-call, a nonexistent
slot, a spouse trying to cancel someone else's appointment, an ambiguous date,
a caller brute-forcing a date of birth, a conversation that goes nowhere.

Each is graded three ways:

| Source | Catches |
|---|---|
| **State assertions** (deterministic) | Wrong booking, phantom appointment |
| **Event log** | Safety never fired, caller never verified, write refused |
| **LLM judge** (transcript only) | Tone, reassurance, invented slots |

The judge is explicitly told it **cannot** see the database and must not rule
on whether a booking landed correctly.

That is not theoretical. On the first live run the agent mislabelled a weekday,
booked the wrong day, and **all three rubric items passed.** Only the state
assertion caught it.

### 4. The improvement loop

```
failure → VERIFY → CLASSIFY ─┬─ behavioural → propose rule → trial → queue
                             ├─ structural  → escalate code change, NO rule
                             └─ harness     → fix the test, agent unchanged
                                                      │
                                              HUMAN APPROVES
                                                      │
                                                  lessons
```

Four rules govern it:

1. **Verify before learning.** A loop that learns from broken tests poisons
   itself — two of our own assertions turned out to be wrong, not the agent.
2. **Classify before proposing.** From the 170-case catalogue, **47% of
   realistic failures are structural** and cannot be fixed by prompting at all.
3. **Re-run everything.** The characteristic failure of self-improvement is a
   fix that trades one broken scenario for another.
4. **A human approves.** Nothing reaches the agent otherwise.

---

## The dashboard

| Page | What it does |
|---|---|
| **Overview** | Latest score, per-dimension KPIs, scenario reliability over time |
| **Runs** | Trigger eval or loop; drill into any run and scenario |
| **Review queue** | The HITL gate — approve, reject or edit a proposed rule |
| **Scenarios** | Browse built-ins, create new ones, enable/disable |
| **Lessons** | What the agent has learned; retire a rule |
| **Guardrails** | Test phrasing against the input/output rules |

Two things it deliberately refuses:

- **Approving a structural finding into a prompt rule.** Escalating a code
  change must not be convertible into a prompt patch by clicking approve.
- **Deleting a built-in scenario.** They are the regression corpus; removing
  one from a UI would quietly drop a guarantee. They can be disabled.

---

## Memory

Three kinds, and only one wants embeddings:

**Conversation** (within a call) — turn history and event log. Bounded by
`maxTurns`, fits in context, needs no retrieval.

**Patient** (across calls) — **relational, deliberately no embeddings.**
"Which appointment do I cancel?" cannot tolerate an approximate match; in a
clinic that is a disclosure, not a degraded answer.

**Learned** (lessons) — has a `pgvector` column, but **retrieval is off by
default.** All active lessons load. A retrieved subset can silently omit a
rule the current turn did not look relevant to, and for a safety rule that is
the worst possible failure mode. A database trigger pins anything tagged
`safety`, `authorisation` or `escalation` to always-load.

The immediate value of the embeddings is **deduplication** — catching the
reflector proposing a rule that already exists, which is the monotonic-growth
problem the design note flags.

---

## Observability

**Event log** — every stage emits a fact rather than calling the next stage
directly. `appointment.booked` is emitted from the *tool result*, so the log
cannot claim a booking that never happened. Replayable, and what the
investigator reads instead of a transcript.

**Tracing** — nested spans (call → turn → agent → provider → tool) with
timings, exported to S3. Payloads are redacted on capture, not on export: a
trace is the artifact most likely to end up in a bug report.

**Tool-call audit** — reports the *route*, not just the destination. A
scenario can pass while the agent took a wasteful or unsafe path there. Flags
unexpected tools, writes before verification, booking without checking
availability, repeated identical calls.

---

## Security

131 tests run with no API key and no network. 24 cover the attack classes
catalogued in `TEST.md`:

| Class | Covered |
|---|---|
| Prompt injection (N55–N57) | Instruction override, role override, prompt extraction, fake tool results |
| Social engineering (N58–N59) | Claimed authority is **inert**, not merely flagged |
| Authorisation (N45–N46) | Third-party cancellation refused at both tool and gate |
| Brute force (N50) | Attempt cap, and it cannot be bypassed via the tool layer |
| Disclosure (N47–N48) | A failed lookup is **byte-identical** for a real patient and a stranger |
| Minimum necessary (N51–N52) | Scheduling fields only; no tool for refills, dosage or coverage |
| Output (N11, N37, N40) | Prices, coverage claims, reassurance, medication advice |
| PHI | Redaction before storage, including nested structures |

The input screen is a **detector, not a defence**. The defence is that
verification and row-level security live in the tool layer, so a persuasive
caller achieves nothing regardless of what the model believes.

---

## Layout

```
src/
  config/        all environment reads, one place
  providers/     bedrock | gemini | openai | anthropic | nvidia | fake
  clinic/        deterministic state + five guarded tools
  agent/         prompt, lessons, conversation loop
  orchestrator/  safety, identity, write gate, redaction, summary
  events/        the event bus and log
  eval/          scenarios, patient simulator, judge, runner, KPIs, audit
  improve/       verify, reflect, pipeline, queue, investigator
  guardrails/    input/output rules + security tests
  tracing/       spans and the S3 exporter
  db/            pool, repositories, scenario store
  cli/           chat, call, eval, loop, review, config, testreport
server/          REST API + background run execution
web/             React dashboard
db/migrations/   schema, applied on first boot
```

**Dependency rule:** `improve/` → `eval/` → `agent/` → `clinic/`, never the
reverse. The runtime plane does not know the evaluation plane exists.

---

## Documents

| File | Contents |
|---|---|
| `DESIGN.md` | The whole system on one page |
| `ARCHITECTURE.md` | Production call path in depth |
| `REQUIREMENTS.md` | Build spec — complete enough to rebuild from |
| `TEST.md` | 170 test cases, research-grounded, each with a fix layer |
| `REPORT.md` | Last full run: results, bugs found, timings |
| `TESTREPORT.md` | Generated; separates what is proven from what is assumed |

---

## Known limits

- **Judge variance.** Rubric grading is an LLM call; borderline items flip
  between runs. Only state assertions are deterministic.
- **Single sample.** Each scenario runs once per suite. No variance bounds.
- **Monotonic lessons.** Nothing prunes rules that become redundant. The
  embedding column exists to address this; the pruning does not yet.
- **The reflector writes the rules that grade it.** The regression gate is the
  only check, and it is blunt.
- **13 of 170 catalogued cases implemented.** Prompt injection is covered by
  unit tests but has no live scenario.
- **No voice layer.** Barge-in, ASR error and latency — 12 catalogued cases,
  untested.
- **Fixture data.** No real EHR, no auth on the dashboard, no BAA. This is a
  demonstration system, not a deployment.
