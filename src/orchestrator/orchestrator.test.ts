import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { activeAppointments, createClinic } from "../clinic/state.js";
import { EventBus } from "../events/bus.js";
import { createFakeProvider, whenUserSays } from "../providers/fake.js";
import { IdentityService, MAX_VERIFICATION_ATTEMPTS } from "./identity.js";
import { Orchestrator } from "./orchestrator.js";
import { FallbackTracker } from "./preprocess.js";
import { redact, redactNames } from "./redact.js";
import { screenDeterministic, screenUtterance } from "./safety.js";
import { summarize } from "./summarize.js";
import { idempotencyKey, WriteGate } from "./writegate.js";

/**
 * The orchestrated call path, tested without a network.
 *
 * These assert the properties that make the pipeline safe rather than merely
 * present: that safety short-circuits before anything else, that identity
 * cannot be brute-forced, that a write cannot be repeated, and that the
 * summary reports what happened rather than what the agent claimed.
 */

function inertProviders() {
  const p = createFakeProvider({ fallback: { text: "How can I help?" } });
  return { agent: p, classifier: p };
}

function orchestrator(overrides: Partial<Parameters<typeof makeOpts>[0]> = {}) {
  return new Orchestrator(makeOpts(overrides));
}

function makeOpts(o: { agentReply?: string; state?: ReturnType<typeof createClinic> } = {}) {
  return {
    callId: "test-call",
    state: o.state ?? createClinic(),
    providers: inertProviders(),
    // Keeps the LLM half of the screen out of the way; the pattern floor
    // is what these tests are about.
    deterministicSafetyOnly: true,
  };
}

describe("safety screen", () => {
  it("catches chest pain deterministically, with no model call", () => {
    const v = screenDeterministic("my chest has been tight since last night");
    assert.equal(v.classification, "emergency");
    assert.match(v.reason, /cardiac/);
  });

  it("catches the symptom-before-body-part phrasing missed in a live run", () => {
    // "a tight feeling in my chest" was classified `none` by the pattern
    // floor, and the model then under-classified it as a clinical question,
    // so the emergency escalation never fired.
    for (const phrasing of [
      "a tight feeling in my chest",
      "some discomfort in my chest",
      "pressure in my chest",
    ]) {
      assert.equal(
        screenDeterministic(phrasing).classification,
        "emergency",
        phrasing,
      );
    }
  });

  it("still ignores a benign mention of the chest", () => {
    assert.equal(
      screenDeterministic("I'd like a chest x-ray appointment").classification,
      "none",
    );
  });

  it("catches breathing difficulty", () => {
    assert.equal(
      screenDeterministic("I can't breathe properly").classification,
      "emergency",
    );
  });

  it("catches suicidal ideation, and ranks it above other classes", () => {
    const v = screenDeterministic("I want to kill myself");
    assert.equal(v.classification, "self_harm");
  });

  it("catches a medication question as clinical, not as an emergency", () => {
    const v = screenDeterministic("should I stop my blood pressure tablets?");
    assert.equal(v.classification, "clinical_question");
  });

  it("passes an ordinary booking request through", () => {
    assert.equal(
      screenDeterministic("I'd like to book with Dr. Rao on Tuesday")
        .classification,
      "none",
    );
  });
});

describe("safety short-circuits the pipeline", () => {
  it("escalates an emergency and ends the call without booking", async () => {
    const state = createClinic();
    const o = orchestrator({ state });

    const { reply, ended, safety } = await o.handle(
      "my chest feels tight and I can't breathe",
    );

    assert.equal(safety.classification, "emergency");
    assert.equal(ended, true);
    assert.match(reply, /emergency care now/i);
    assert.equal(state.escalations[0]?.urgency, "emergency");
    assert.equal(
      activeAppointments(state).length,
      2,
      "no booking may be made on an emergency turn",
    );
  });

  it("never offers reassurance before escalating", async () => {
    const o = orchestrator();
    const { reply } = await o.handle("my chest is tight, is that serious?");

    assert.doesNotMatch(reply, /probably|likely fine|don't worry|nothing to/i);
  });

  it("runs before relevance, so an emergency is never treated as off-topic", async () => {
    const o = orchestrator();
    await o.handle("my chest is tight");

    const safetyEvent = o.bus.first("safety.triggered");
    const intentEvent = o.bus.first("intent.classified");

    assert.ok(safetyEvent, "safety fired");
    assert.equal(
      intentEvent,
      undefined,
      "relevance must not even run once safety has fired",
    );
  });

  it("does not end the call for a clinical question", async () => {
    const o = orchestrator();
    const { ended, safety } = await o.handle(
      "should I stop taking my tablets before the visit?",
    );

    assert.equal(safety.classification, "clinical_question");
    assert.equal(ended, false, "the caller may still want their booking");
  });
});

describe("identity", () => {
  function service() {
    const state = createClinic();
    return {
      state,
      id: new IdentityService(state, new EventBus("c")),
    };
  }

  it("verifies on an exact name and DOB match", () => {
    const { id } = service();
    const r = id.verify("Radhika Nair", "1984-06-21");

    assert.equal(r.status, "verified");
    assert.equal(id.verifiedPatientId, "p1");
  });

  it("refuses a right name with a wrong DOB", () => {
    const { id } = service();
    const r = id.verify("Radhika Nair", "1990-01-01");

    assert.equal(r.status, "unidentified");
    assert.equal(id.verifiedPatientId, null);
  });

  it("never reveals whether the name exists on file", () => {
    const { id } = service();
    const known = id.verify("Radhika Nair", "1990-01-01").message;
    const unknown = id.verify("Nobody At All", "1990-01-01").message;

    assert.equal(
      known,
      unknown,
      "a failed attempt must not distinguish a real patient from a stranger",
    );
  });

  it("locks after the attempt cap, so the line is not a DOB oracle", () => {
    const { id } = service();
    for (let i = 0; i < MAX_VERIFICATION_ATTEMPTS; i++) {
      id.verify("Radhika Nair", "1900-01-01");
    }

    assert.equal(id.currentStatus, "locked");
    assert.equal(id.verify("Radhika Nair", "1984-06-21").status, "locked");
    assert.equal(
      id.verifiedPatientId,
      null,
      "a locked caller must not be verifiable even with correct details",
    );
  });

  it("registers a new caller once required fields are collected", () => {
    const { id, state } = service();
    id.startRegistration();

    const partial = id.collect({ name: "Sarah Kim" });
    assert.equal(partial.complete, false);
    assert.ok(partial.missing.includes("dob"));

    id.collect({ dob: "1990-04-04", mobile: "555-0199" });
    const done = id.completeRegistration();

    assert.equal(done.status, "verified");
    assert.equal(state.patients.length, 5);
  });
});

describe("write gate", () => {
  function gate() {
    const state = createClinic();
    return { state, gate: new WriteGate(state, new EventBus("c")) };
  }

  const base = {
    kind: "book" as const,
    idempotencyKey: "k1",
    confirmed: true,
    details: {},
  };

  it("refuses a write for an unverified caller", () => {
    const { gate: g } = gate();
    const d = g.check({ ...base, verifiedPatientId: null });

    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.code, "not_verified");
  });

  it("refuses a write against another patient's record", () => {
    const { gate: g } = gate();
    const d = g.check({
      ...base,
      kind: "cancel",
      verifiedPatientId: "p3",
      appointmentId: "a2", // belongs to p4
    });

    assert.equal(d.allowed === false && d.code, "not_authorised");
  });

  it("refuses an unconfirmed destructive write", () => {
    const { gate: g } = gate();
    const d = g.check({
      ...base,
      kind: "cancel",
      verifiedPatientId: "p1",
      appointmentId: "a1",
      confirmed: false,
    });

    assert.equal(d.allowed === false && d.code, "not_confirmed");
  });

  it("collapses a repeated write rather than double-booking", () => {
    const { gate: g } = gate();
    const req = { ...base, verifiedPatientId: "p1", idempotencyKey: "same" };

    assert.equal(g.check(req).allowed, true);
    const second = g.check(req);

    assert.equal(second.allowed, false);
    assert.equal(second.allowed === false && second.code, "duplicate");
  });

  it("derives a stable key from the same logical request", () => {
    const a = idempotencyKey("c1", "book", { date: "2026-03-10", time: "09:00" });
    const b = idempotencyKey("c1", "book", { time: "09:00", date: "2026-03-10" });

    assert.equal(a, b, "argument order must not change the key");
  });

  it("enforces the maximum active appointments policy", () => {
    const { state, gate: g } = gate();
    // p1 starts with one; add two more to reach the cap of three.
    state.appointments.push(
      { ...state.appointments[0]!, id: "x1" },
      { ...state.appointments[0]!, id: "x2" },
    );

    const d = g.check({ ...base, verifiedPatientId: "p1", idempotencyKey: "new" });
    assert.equal(d.allowed === false && d.code, "policy_violation");
  });
});

describe("fallback tracker", () => {
  it("counts irrelevant turns toward the cutoff", () => {
    const t = new FallbackTracker();
    t.record("irrelevant");
    t.record("irrelevant");
    assert.equal(t.exhausted, false);

    t.record("irrelevant");
    assert.equal(t.exhausted, true);
  });

  it("does not hang up on a caller who needs a couple of details pinned down", () => {
    const t = new FallbackTracker();
    t.record("ambiguous");
    t.record("ambiguous");
    t.record("ambiguous");

    assert.equal(
      t.exhausted,
      false,
      "clarification is normal conversation, not failure",
    );
  });

  it("resets the ambiguity budget once the caller makes progress", () => {
    const t = new FallbackTracker();
    t.record("ambiguous");
    t.record("ambiguous");
    t.record("actionable");

    assert.equal(t.counts.ambiguous, 0);
  });
});

describe("redaction", () => {
  it("removes dates of birth, phones and emails before storage", () => {
    const { text } = redact(
      "Radhika, DOB 1984-06-21, on 555-0101 or rad@example.com",
    );

    assert.doesNotMatch(text, /1984-06-21/);
    assert.doesNotMatch(text, /555-0101/);
    assert.doesNotMatch(text, /rad@example\.com/);
    assert.match(text, /\[DOB\]/);
  });

  it("keeps the shape of the data so a reviewer can still follow the call", () => {
    const { text } = redact("DOB 1984-06-21");
    assert.equal(text, "DOB [DOB]");
  });

  it("redacts longer names before shorter ones that they contain", () => {
    const out = redactNames("Derek Whitfield and Derek", [
      "Derek",
      "Derek Whitfield",
    ]);
    assert.equal(out, "[NAME] and [NAME]");
  });

  it("reports what it removed, for an audit trail", () => {
    const { counts } = redact("call 555-0101 or 555-0102");
    assert.equal(counts.phone, 2);
  });
});

describe("summary is built from events, not from claims", () => {
  it("reports a booking only when the tool actually succeeded", () => {
    const bus = new EventBus("c1");
    bus.emit("call.started", {});
    bus.emit("utterance.received", {});
    // The agent claimed success, but no appointment.booked event exists.
    bus.emit("tool.called", { name: "book_appointment" });
    bus.emit("tool.failed", { name: "book_appointment", error: "slot_unavailable" });
    bus.emit("call.ended", {});

    const s = summarize(bus);
    assert.equal(s.appointmentsBooked.length, 0);
    assert.equal(s.outcome, "completed");
    assert.ok(s.failures.some((f) => f.includes("slot_unavailable")));
  });

  it("records an escalation as unresolved work for a human", () => {
    const bus = new EventBus("c2");
    bus.emit("call.started", {});
    bus.emit("escalation.raised", { reason: "chest pain", urgency: "emergency" });
    bus.emit("call.ended", {});

    const s = summarize(bus);
    assert.equal(s.outcome, "escalated");
    assert.ok(s.unresolved.some((u) => u.includes("chest pain")));
  });

  it("redacts the narrative before it can be stored", () => {
    const bus = new EventBus("c3");
    bus.emit("call.started", {});
    bus.emit("appointment.booked", {
      date: "2026-03-10",
      time: "09:00",
      clinician: "Dr. Rao",
    });
    bus.emit("call.ended", {});

    const s = summarize(bus, ["Radhika Nair"]);
    // The booking date is a real date and gets caught by the DOB pattern -
    // lossy, but erring toward removing too much rather than too little.
    assert.doesNotMatch(s.narrative, /Radhika/);
  });
});

describe("event log", () => {
  it("orders events by sequence, not by clock", async () => {
    const o = orchestrator();
    await o.handle("hello");

    const seqs = o.bus.log.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });

  it("records the call lifecycle", async () => {
    const o = orchestrator();
    await o.handle("hello");
    o.end();

    assert.ok(o.bus.has("call.started"));
    assert.ok(o.bus.has("utterance.received"));
    assert.ok(o.bus.has("call.ended"));
    assert.ok(o.bus.has("summary.generated"));
  });

  it("isolates a throwing subscriber from the call", async () => {
    const o = orchestrator();
    o.bus.on("*", () => {
      throw new Error("observer blew up");
    });

    // The call must still complete.
    const { reply } = await o.handle("hello");
    assert.ok(reply.length > 0);
    assert.ok(o.bus.handlerErrors.length > 0, "the failure is recorded, not hidden");
  });

  it("can be rebuilt from its serialised form for replay", async () => {
    const o = orchestrator();
    await o.handle("hello");
    const json = o.bus.toJSON();

    const replayed = EventBus.fromJSON("test-call", json);
    assert.equal(replayed.log.length, json.length);
    assert.equal(replayed.first("call.started")?.name, "call.started");
  });
});

describe("identity sync between tool layer and orchestrator", () => {
  it("adopts a verification performed by lookup_patient", () => {
    const state = createClinic();
    const id = new IdentityService(state, new EventBus("c"));

    assert.equal(id.verifiedPatientId, null);
    assert.equal(id.adoptVerified("p1"), true);
    assert.equal(
      id.verifiedPatientId,
      "p1",
      "the write gate reads this; a stale null refuses every booking",
    );
  });

  it("refuses to adopt a verification for a locked caller", () => {
    const state = createClinic();
    const id = new IdentityService(state, new EventBus("c"));
    for (let i = 0; i < MAX_VERIFICATION_ATTEMPTS; i++) {
      id.verify("Radhika Nair", "1900-01-01");
    }

    assert.equal(
      id.adoptVerified("p1"),
      false,
      "the attempt cap must not be bypassable by routing through the tool",
    );
    assert.equal(id.verifiedPatientId, null);
  });
});

describe("the classifier cannot invent a trigger", () => {
  /** A model that claims a clinical question, quoting words never spoken. */
  function hallucinatingClassifier(trigger: string) {
    return createFakeProvider({
      fallback: {
        text: JSON.stringify({
          classification: "clinical_question",
          trigger,
          reason: "medication advice",
        }),
      },
    });
  }

  it("rejects a clinical classification whose quote is not in the utterance", async () => {
    // Observed live: "I'd like to book any available slot with Dr. Rao this
    // week" was classified as a medication question, citing a phrase the
    // caller had never said.
    const utterance = "I'd like to book any available slot with Dr. Rao this week, please.";
    const v = await screenUtterance(
      utterance,
      hallucinatingClassifier("I was curious if it's worth asking Dr. Rao about"),
    );

    assert.equal(v.classification, "none");
    assert.match(v.reason, /did not say/);
  });

  it("accepts a clinical classification that quotes the caller accurately", async () => {
    const utterance = "Should I stop taking my blood pressure tablets before the visit?";
    const v = await screenUtterance(
      utterance,
      hallucinatingClassifier("stop taking my blood pressure tablets"),
    );

    assert.equal(v.classification, "clinical_question");
  });

  it("tolerates punctuation and casing differences in the quote", async () => {
    const utterance = "Are these two medications safe to take together?";
    const v = await screenUtterance(
      utterance,
      hallucinatingClassifier("safe to take together"),
    );

    assert.equal(v.classification, "clinical_question");
  });

  it("never second-guesses an emergency over a quoting slip", async () => {
    // A false escalation costs one transferred call; a missed one costs much
    // more, so the quote check is deliberately limited to clinical questions.
    const emergency = createFakeProvider({
      fallback: {
        text: JSON.stringify({
          classification: "emergency",
          trigger: "a phrase nobody said",
          reason: "possible cardiac event",
        }),
      },
    });

    const v = await screenUtterance("I feel unwell", emergency);
    assert.equal(v.classification, "emergency");
  });
});

describe("everyday off-topic questions carry no safety content", () => {
  it("treats parking, directions and hours as none", () => {
    for (const q of [
      "what is the parking situation like there?",
      "is the clinic easy to find?",
      "what are your opening hours?",
      "what did you think of that news story?",
    ]) {
      assert.equal(screenDeterministic(q).classification, "none", q);
    }
  });
});

describe("an unevidenced clinical classification is rejected", () => {
  it("rejects one with no trigger at all", async () => {
    // Without a quote there is nothing to check, and an unevidenced clinical
    // escalation on an ordinary booking request is the false positive the
    // guard exists to stop.
    const noEvidence = createFakeProvider({
      fallback: {
        text: JSON.stringify({
          classification: "clinical_question",
          reason: "vaccination advice",
        }),
      },
    });

    const v = await screenUtterance(
      "I was hoping to book any slot with Dr. Rao this week.",
      noEvidence,
    );

    assert.equal(v.classification, "none");
    assert.match(v.reason, /no quotable evidence/);
  });

  it("rejects one quoting words from a different conversation", async () => {
    // Observed live: trigger "What's your take on that?" on a turn where the
    // caller asked only about availability.
    const wrongQuote = createFakeProvider({
      fallback: {
        text: JSON.stringify({
          classification: "clinical_question",
          trigger: "What's your take on that?",
          reason: "vaccination advice",
        }),
      },
    });

    const v = await screenUtterance(
      "So for scheduling, I was hoping to book any slot with Dr. Rao this week.",
      wrongQuote,
    );

    assert.equal(v.classification, "none");
  });
});
