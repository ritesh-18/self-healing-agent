/**
 * The clinic's world state.
 *
 * Everything here is deterministic and rebuilt from a seed before every run.
 * That is not a convenience — it is what makes the before/after table in the
 * improvement loop mean anything. If "next Tuesday" drifted between runs, or
 * bookings leaked across scenarios, a score change could not be attributed to
 * the agent's behaviour.
 */

export const TODAY = "2026-03-09"; // A Monday. Frozen on purpose.

export interface Patient {
  id: string;
  name: string;
  dob: string;
  phone: string;
}

export interface Appointment {
  id: string;
  patientId: string;
  clinician: string;
  /** ISO date, e.g. 2026-03-12 */
  date: string;
  /** 24h HH:MM */
  time: string;
  reason: string;
  status: "booked" | "cancelled";
}

export interface Slot {
  clinician: string;
  date: string;
  time: string;
}

export interface Escalation {
  reason: string;
  summary: string;
  urgency: "routine" | "urgent" | "emergency";
}

export interface ClinicState {
  today: string;
  patients: Patient[];
  appointments: Appointment[];
  /** Slots the clinic offers, before subtracting what is booked. */
  openSlots: Slot[];
  escalations: Escalation[];
  /** Ordered log of every tool the agent invoked, for state-aware grading. */
  toolLog: { name: string; args: Record<string, unknown>; ok: boolean }[];
}

const PATIENTS: Patient[] = [
  { id: "p1", name: "Radhika Nair", dob: "1984-06-21", phone: "555-0101" },
  { id: "p2", name: "Tom Alvarez", dob: "1971-11-02", phone: "555-0102" },
  { id: "p3", name: "Joan Whitfield", dob: "1950-02-14", phone: "555-0103" },
  { id: "p4", name: "Derek Whitfield", dob: "1948-09-30", phone: "555-0104" },
];

/** Weekday slots for the week of Mon 2026-03-09. */
function seedSlots(): Slot[] {
  const slots: Slot[] = [];
  const days = ["2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13"];
  const times = ["09:00", "10:30", "14:00", "15:30"];
  for (const date of days) {
    for (const time of times) {
      slots.push({ clinician: "Dr. Rao", date, time });
    }
  }
  // Dr. Feld works a short week: Thursday only. Used by the "no slots" case.
  slots.push({ clinician: "Dr. Feld", date: "2026-03-12", time: "11:00" });
  return slots;
}

export function createClinic(): ClinicState {
  return {
    today: TODAY,
    patients: structuredClone(PATIENTS),
    appointments: [
      {
        id: "a1",
        patientId: "p1",
        clinician: "Dr. Rao",
        date: "2026-03-12",
        time: "15:00",
        reason: "follow-up",
        status: "booked",
      },
      {
        id: "a2",
        patientId: "p4",
        clinician: "Dr. Rao",
        date: "2026-03-11",
        time: "09:00",
        reason: "blood pressure check",
        status: "booked",
      },
    ],
    openSlots: seedSlots(),
    escalations: [],
    toolLog: [],
  };
}

/** A slot is available if the clinic offers it and nothing is booked into it. */
export function isSlotFree(state: ClinicState, slot: Slot): boolean {
  const offered = state.openSlots.some(
    (s) =>
      s.clinician === slot.clinician &&
      s.date === slot.date &&
      s.time === slot.time,
  );
  if (!offered) return false;
  return !state.appointments.some(
    (a) =>
      a.status === "booked" &&
      a.clinician === slot.clinician &&
      a.date === slot.date &&
      a.time === slot.time,
  );
}

/**
 * The window the clinic is actually taking bookings for.
 *
 * Without this the agent has no way to know a date is out of range: it asks
 * for one, gets an empty list, and reports "nothing available" as though the
 * day were full. Observed live - the agent proposed 2026-03-17, which was
 * never bookable, then apologised for Dr. Rao having no slots.
 */
export function scheduleHorizon(state: ClinicState): {
  from: string;
  to: string;
} {
  const dates = state.openSlots.map((s) => s.date).sort();
  return {
    from: dates[0] ?? state.today,
    to: dates[dates.length - 1] ?? state.today,
  };
}

/** Is this date one the clinic can book at all? */
export function withinHorizon(state: ClinicState, date: string): boolean {
  const { from, to } = scheduleHorizon(state);
  return date >= from && date <= to;
}

export function activeAppointments(state: ClinicState): Appointment[] {
  return state.appointments.filter((a) => a.status === "booked");
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * Display helpers, returned by tools so the agent never computes them.
 *
 * This exists because of a real failure. On the first live run the agent was
 * given a bare "2026-03-10", inferred the weekday itself, called it "Monday"
 * when it is a Tuesday, and booked a patient who asked for Tuesday onto
 * Wednesday. Every rubric item passed; only the state assertion caught it.
 *
 * The lesson generalises: anything the model derives, it can derive wrongly.
 * If the environment can simply state a fact, it should.
 */
export function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return "";
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
}

/** "15:30" -> "3:30 PM". What the agent should say aloud. */
export function spokenTimeOf(time: string): string {
  const [h, min] = time.split(":").map(Number);
  if (h === undefined || min === undefined) return time;
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return min === 0
    ? `${hour12} ${period}`
    : `${hour12}:${String(min).padStart(2, "0")} ${period}`;
}

/** A slot annotated with everything needed to describe it out loud. */
export function describeSlot(slot: Slot) {
  return {
    ...slot,
    weekday: weekdayOf(slot.date),
    spokenTime: spokenTimeOf(slot.time),
  };
}

export function findPatientByName(
  state: ClinicState,
  name: string,
): Patient | undefined {
  const needle = name.trim().toLowerCase();
  return state.patients.find((p) => p.name.toLowerCase() === needle);
}
