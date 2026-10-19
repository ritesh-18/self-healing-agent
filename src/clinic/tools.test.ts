import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  activeAppointments,
  createClinic,
  spokenTimeOf,
  weekdayOf,
} from "./state.js";
import { runTool, type ToolContext } from "./tools.js";

/**
 * Tool-layer guarantees.
 *
 * These are the invariants that must hold no matter what the model does, so
 * they are tested without an LLM in the loop. If a guardrail only exists in the
 * prompt, it is a suggestion; these tests are what make it a rule.
 */

function ctx(): ToolContext {
  return { state: createClinic(), verifiedPatientId: null };
}

function verify(c: ToolContext, name: string, dob: string) {
  return runTool("lookup_patient", { full_name: name, dob }, c);
}

describe("lookup_patient", () => {
  it("verifies a patient whose name and DOB both match", () => {
    const c = ctx();
    const out = verify(c, "Radhika Nair", "1984-06-21");
    assert.equal(out.ok, true);
    assert.equal(c.verifiedPatientId, "p1");
  });

  it("refuses when the DOB does not match the name", () => {
    const c = ctx();
    const out = verify(c, "Radhika Nair", "1990-01-01");
    assert.equal(out.ok, false);
    assert.equal(out.error, "no_match");
    assert.equal(c.verifiedPatientId, null);
  });

  it("refuses an unknown patient rather than offering a near match", () => {
    const c = ctx();
    const out = verify(c, "Sarah Kim", "1990-04-04");
    assert.equal(out.ok, false);
    assert.equal(c.verifiedPatientId, null);
  });
});

describe("book_appointment", () => {
  it("refuses to book for an unverified caller", () => {
    const c = ctx();
    const out = runTool(
      "book_appointment",
      { clinician: "Dr. Rao", date: "2026-03-10", time: "09:00", reason: "x" },
      c,
    );
    assert.equal(out.ok, false);
    assert.equal(out.error, "not_verified");
    assert.equal(activeAppointments(c.state).length, 2);
  });

  it("books a verified patient into a free slot", () => {
    const c = ctx();
    verify(c, "Radhika Nair", "1984-06-21");
    const out = runTool(
      "book_appointment",
      { clinician: "Dr. Rao", date: "2026-03-10", time: "09:00", reason: "knee" },
      c,
    );
    assert.equal(out.ok, true);
    assert.equal(activeAppointments(c.state).length, 3);
  });

  it("rejects a slot the clinic never offered, even after verification", () => {
    const c = ctx();
    verify(c, "Radhika Nair", "1984-06-21");
    const out = runTool(
      "book_appointment",
      { clinician: "Dr. Rao", date: "2026-03-10", time: "23:00", reason: "x" },
      c,
    );
    assert.equal(out.ok, false);
    assert.equal(out.error, "slot_unavailable");
  });

  it("prevents double-booking without relying on find_slots being called", () => {
    const c = ctx();
    verify(c, "Radhika Nair", "1984-06-21");
    const slot = {
      clinician: "Dr. Rao",
      date: "2026-03-10",
      time: "09:00",
      reason: "first",
    };
    assert.equal(runTool("book_appointment", slot, c).ok, true);

    // Second booking into the same slot must fail even though the agent may
    // believe it is free.
    const second = runTool("book_appointment", { ...slot, reason: "second" }, c);
    assert.equal(second.ok, false);
    assert.equal(second.error, "slot_unavailable");
  });
});

describe("cancel_appointment", () => {
  it("cancels the caller's own appointment", () => {
    const c = ctx();
    verify(c, "Radhika Nair", "1984-06-21");
    const out = runTool("cancel_appointment", { appointment_id: "a1" }, c);
    assert.equal(out.ok, true);
    assert.ok(!activeAppointments(c.state).some((a) => a.id === "a1"));
  });

  it("refuses to cancel an appointment belonging to someone else", () => {
    const c = ctx();
    // Joan is verified, but a2 belongs to Derek.
    verify(c, "Joan Whitfield", "1950-02-14");
    const out = runTool("cancel_appointment", { appointment_id: "a2" }, c);
    assert.equal(out.ok, false);
    assert.equal(out.error, "not_authorised");
    assert.ok(activeAppointments(c.state).some((a) => a.id === "a2"));
  });

  it("refuses to cancel before verification", () => {
    const c = ctx();
    const out = runTool("cancel_appointment", { appointment_id: "a1" }, c);
    assert.equal(out.ok, false);
    assert.equal(out.error, "not_verified");
  });
});

describe("find_slots", () => {
  it("never returns a slot that is already booked", () => {
    const c = ctx();
    const out = runTool("find_slots", { clinician: "Dr. Rao" }, c) as unknown as {
      slots: { date: string; time: string }[];
    };
    // a2 occupies Dr. Rao on 2026-03-11 at 09:00.
    assert.ok(
      !out.slots.some((s) => s.date === "2026-03-11" && s.time === "09:00"),
    );
  });

  it("returns an empty list rather than a substitute when nothing matches", () => {
    const c = ctx();
    const out = runTool("find_slots", { date: "2026-03-09" }, c) as unknown as {
      count: number;
    };
    assert.equal(out.count, 0);
  });
});

describe("escalate_to_human", () => {
  it("records an emergency escalation", () => {
    const c = ctx();
    const out = runTool(
      "escalate_to_human",
      { reason: "chest pain", summary: "tight chest", urgency: "emergency" },
      c,
    );
    assert.equal(out.ok, true);
    assert.equal(c.state.escalations[0]?.urgency, "emergency");
  });

  it("defaults an unrecognised urgency to routine rather than dropping it", () => {
    const c = ctx();
    runTool(
      "escalate_to_human",
      { reason: "x", summary: "y", urgency: "banana" },
      c,
    );
    assert.equal(c.state.escalations[0]?.urgency, "routine");
  });
});

describe("tool log", () => {
  it("records every call with its outcome, for state-aware grading", () => {
    const c = ctx();
    verify(c, "Radhika Nair", "1984-06-21");
    runTool("book_appointment", { clinician: "Dr. Rao", date: "x", time: "y", reason: "z" }, c);

    assert.equal(c.state.toolLog.length, 2);
    assert.equal(c.state.toolLog[0]?.ok, true);
    assert.equal(c.state.toolLog[1]?.ok, false);
  });

  it("logs unknown tools as failures instead of throwing", () => {
    const c = ctx();
    const out = runTool("prescribe_medication", {}, c);
    assert.equal(out.ok, false);
    assert.equal(out.error, "unknown_tool");
    assert.equal(c.state.toolLog[0]?.ok, false);
  });
});

describe("determinism", () => {
  it("gives every scenario an identical starting clinic", () => {
    assert.deepEqual(createClinic(), createClinic());
  });

  it("does not leak state between clinics", () => {
    const a = ctx();
    verify(a, "Radhika Nair", "1984-06-21");
    runTool(
      "book_appointment",
      { clinician: "Dr. Rao", date: "2026-03-10", time: "09:00", reason: "x" },
      a,
    );
    assert.equal(activeAppointments(createClinic()).length, 2);
  });
});

describe("display helpers", () => {
  it("derives the correct weekday, which the model got wrong", () => {
    // The literal failure that motivated this: the agent called 2026-03-10
    // "Monday" when it is a Tuesday, and booked the patient onto Wednesday.
    assert.equal(weekdayOf("2026-03-09"), "Monday");
    assert.equal(weekdayOf("2026-03-10"), "Tuesday");
    assert.equal(weekdayOf("2026-03-11"), "Wednesday");
    assert.equal(weekdayOf("2026-03-12"), "Thursday");
    assert.equal(weekdayOf("2026-03-13"), "Friday");
  });

  it("returns empty for a malformed date rather than guessing", () => {
    assert.equal(weekdayOf("not-a-date"), "");
  });

  it("renders times the way a receptionist would say them", () => {
    assert.equal(spokenTimeOf("09:00"), "9 AM");
    assert.equal(spokenTimeOf("10:30"), "10:30 AM");
    assert.equal(spokenTimeOf("14:00"), "2 PM");
    assert.equal(spokenTimeOf("15:30"), "3:30 PM");
    assert.equal(spokenTimeOf("00:00"), "12 AM");
    assert.equal(spokenTimeOf("12:00"), "12 PM");
  });
});

describe("tools return display-ready values", () => {
  it("find_slots annotates every slot with weekday and spokenTime", () => {
    const c = ctx();
    const out = runTool("find_slots", { clinician: "Dr. Rao" }, c) as unknown as {
      slots: { date: string; weekday: string; spokenTime: string }[];
    };

    const tuesday = out.slots.find((s) => s.date === "2026-03-10");
    assert.equal(tuesday?.weekday, "Tuesday");
    assert.ok(tuesday?.spokenTime);
  });

  it("book_appointment returns a confirm object to read back from", () => {
    const c = ctx();
    verify(c, "Radhika Nair", "1984-06-21");
    const out = runTool(
      "book_appointment",
      { clinician: "Dr. Rao", date: "2026-03-10", time: "09:00", reason: "knee" },
      c,
    ) as unknown as { confirm: { weekday: string; date: string; spokenTime: string } };

    assert.equal(out.confirm.weekday, "Tuesday");
    assert.equal(out.confirm.date, "2026-03-10");
    assert.equal(out.confirm.spokenTime, "9 AM");
  });

  it("lookup_patient annotates existing appointments too", () => {
    const c = ctx();
    const out = verify(c, "Radhika Nair", "1984-06-21") as unknown as {
      appointments: { date: string; weekday: string }[];
    };

    assert.equal(out.appointments[0]?.date, "2026-03-12");
    assert.equal(out.appointments[0]?.weekday, "Thursday");
  });
});

describe("schedule horizon", () => {
  it("reports the window the clinic actually books within", () => {
    const c = ctx();
    const out = runTool("find_slots", {}, c) as unknown as {
      scheduleHorizon: { from: string; to: string };
    };

    assert.equal(out.scheduleHorizon.from, "2026-03-10");
    assert.equal(out.scheduleHorizon.to, "2026-03-13");
  });

  it("distinguishes out-of-range from a fully booked day", () => {
    const c = ctx();
    // Observed live: the agent proposed 2026-03-17, got an empty list, and
    // told the patient the clinician had no availability - when in fact the
    // diary was not open that far ahead at all.
    const out = runTool("find_slots", { date: "2026-03-17" }, c) as unknown as {
      count: number;
      outOfRange?: boolean;
      message?: string;
    };

    assert.equal(out.count, 0);
    assert.equal(out.outOfRange, true);
    assert.match(out.message ?? "", /not open that far ahead/);
  });

  it("does not flag an in-range day that merely has no free slots", () => {
    const c = ctx();
    const out = runTool("find_slots", { date: "2026-03-10", clinician: "Dr. Feld" }, c) as unknown as {
      count: number;
      outOfRange?: boolean;
    };

    assert.equal(out.count, 0);
    assert.equal(out.outOfRange, undefined);
  });

  it("refuses a booking outside the window", () => {
    const c = ctx();
    verify(c, "Radhika Nair", "1984-06-21");
    const out = runTool(
      "book_appointment",
      { clinician: "Dr. Rao", date: "2026-03-17", time: "09:00", reason: "x" },
      c,
    );

    assert.equal(out.ok, false);
    assert.equal(out.error, "out_of_range");
  });
});
