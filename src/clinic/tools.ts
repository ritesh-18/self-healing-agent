import type { ToolSpec } from "../providers/types.js";
import {
  activeAppointments,
  describeSlot,
  findPatientByName,
  isSlotFree,
  scheduleHorizon,
  spokenTimeOf,
  weekdayOf,
  withinHorizon,
  type ClinicState,
} from "./state.js";

/**
 * Maya's tools.
 *
 * Scoped narrowly on purpose. Every tool is something the agent can get wrong
 * at 2am with nobody watching, so each one validates its own preconditions and
 * refuses rather than trusting the model. Notably:
 *
 *  - book_appointment re-checks availability instead of trusting that the
 *    agent called find_slots first. This is the guard against double-booking.
 *  - cancel_appointment requires the appointment to belong to the verified
 *    patient, so an agent cannot be talked into cancelling a third party's
 *    visit.
 *  - There is no "answer_medical_question" tool. The only safe move on a
 *    clinical question is escalate_to_human.
 */

export interface ToolContext {
  state: ClinicState;
  /** Patient verified this conversation, if any. */
  verifiedPatientId: string | null;
}

export interface ToolOutcome {
  ok: boolean;
  [key: string]: unknown;
}

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => ToolOutcome;

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "lookup_patient",
    description:
      "Verify a caller against clinic records by full name and date of birth. " +
      "Must be called before booking or cancelling. Returns the patient record " +
      "and their existing appointments.",
    parameters: {
      type: "object",
      properties: {
        full_name: { type: "string", description: "Patient's full name." },
        dob: { type: "string", description: "Date of birth as YYYY-MM-DD." },
      },
      required: ["full_name", "dob"],
    },
  },
  {
    name: "find_slots",
    description:
      "List appointment slots that are genuinely available. Optionally filter " +
      "by clinician and/or a specific date (YYYY-MM-DD). Returns an empty list " +
      "when nothing is free - never invent a slot that is not returned here. " +
      "Each slot includes weekday and spokenTime: say those values aloud " +
      "rather than working out the day of the week yourself. The response " +
      "carries scheduleHorizon, the only window the clinic books within - " +
      "never propose a date outside it.",
    parameters: {
      type: "object",
      properties: {
        clinician: { type: "string", description: "e.g. 'Dr. Rao'. Optional." },
        date: { type: "string", description: "YYYY-MM-DD. Optional." },
      },
    },
  },
  {
    name: "book_appointment",
    description:
      "Book a verified patient into a specific free slot. Fails if the patient " +
      "is not verified or the slot is not available. On success returns a " +
      "confirm object - read the booking back to the patient using those " +
      "values, never from what you sent.",
    parameters: {
      type: "object",
      properties: {
        clinician: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "24-hour HH:MM" },
        reason: { type: "string", description: "Short reason for the visit." },
      },
      required: ["clinician", "date", "time", "reason"],
    },
  },
  {
    name: "cancel_appointment",
    description:
      "Cancel an existing appointment belonging to the verified patient. " +
      "Use the appointment id returned by lookup_patient.",
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
      },
      required: ["appointment_id"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the call to clinic staff. Use for any clinical or medical question, " +
      "any sign of a medical emergency, billing disputes, or anything outside " +
      "scheduling. Set urgency to 'emergency' for possible medical emergencies.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why this needs a human." },
        summary: { type: "string", description: "What the patient said." },
        urgency: {
          type: "string",
          enum: ["routine", "urgent", "emergency"],
        },
      },
      required: ["reason", "summary", "urgency"],
    },
  },
];

const HANDLERS: Record<string, Handler> = {
  lookup_patient(args, ctx) {
    const name = str(args, "full_name");
    const dob = str(args, "dob");
    const patient = findPatientByName(ctx.state, name);

    if (!patient || patient.dob !== dob) {
      return {
        ok: false,
        error: "no_match",
        message:
          "No patient matches that name and date of birth. Do not guess or " +
          "offer a near match; ask the caller to re-confirm their details.",
      };
    }

    ctx.verifiedPatientId = patient.id;
    return {
      ok: true,
      patient: { id: patient.id, name: patient.name, dob: patient.dob },
      appointments: activeAppointments(ctx.state)
        .filter((a) => a.patientId === patient.id)
        .map((a) => ({
          id: a.id,
          clinician: a.clinician,
          date: a.date,
          weekday: weekdayOf(a.date),
          time: a.time,
          spokenTime: spokenTimeOf(a.time),
          reason: a.reason,
        })),
    };
  },

  find_slots(args, ctx) {
    const clinician = str(args, "clinician");
    const date = str(args, "date");

    const free = ctx.state.openSlots
      .filter((s) => isSlotFree(ctx.state, s))
      .filter((s) => !clinician || s.clinician === clinician)
      .filter((s) => !date || s.date === date);

    const horizon = scheduleHorizon(ctx.state);

    // An out-of-range date is a different answer from "that day is full", and
    // the agent cannot tell them apart from an empty list alone.
    if (date && !withinHorizon(ctx.state, date)) {
      return {
        ok: true,
        today: ctx.state.today,
        todayWeekday: weekdayOf(ctx.state.today),
        slots: [],
        count: 0,
        scheduleHorizon: horizon,
        outOfRange: true,
        message:
          `The clinic is only taking bookings between ${horizon.from} and ` +
          `${horizon.to}. ${date} is outside that window - tell the patient ` +
          `the diary is not open that far ahead rather than saying the day ` +
          `is full, and offer a date inside the window.`,
      };
    }

    return {
      ok: true,
      today: ctx.state.today,
      todayWeekday: weekdayOf(ctx.state.today),
      scheduleHorizon: horizon,
      // Slots carry their weekday and spoken time so the agent reads them
      // rather than deriving them. See describeSlot for why.
      slots: free.map(describeSlot),
      count: free.length,
      ...(free.length === 0
        ? {
            message:
              "Nothing is available for that request. Offer the patient a " +
              "different day or clinician rather than inventing a slot.",
          }
        : {}),
    };
  },

  book_appointment(args, ctx) {
    if (!ctx.verifiedPatientId) {
      return {
        ok: false,
        error: "not_verified",
        message: "Verify the patient with lookup_patient before booking.",
      };
    }

    const slot = {
      clinician: str(args, "clinician"),
      date: str(args, "date"),
      time: str(args, "time"),
    };

    if (!withinHorizon(ctx.state, slot.date)) {
      const horizon = scheduleHorizon(ctx.state);
      return {
        ok: false,
        error: "out_of_range",
        message:
          `The diary is only open between ${horizon.from} and ${horizon.to}. ` +
          `Do not offer dates outside that window.`,
      };
    }

    // Re-check rather than trusting that find_slots was called first.
    if (!isSlotFree(ctx.state, slot)) {
      return {
        ok: false,
        error: "slot_unavailable",
        message:
          "That slot is not available. Call find_slots and offer the patient " +
          "one of the slots it actually returns.",
      };
    }

    const appointment = {
      id: `a${ctx.state.appointments.length + 1}`,
      patientId: ctx.verifiedPatientId,
      clinician: slot.clinician,
      date: slot.date,
      time: slot.time,
      reason: str(args, "reason") || "unspecified",
      status: "booked" as const,
    };
    ctx.state.appointments.push(appointment);

    // The confirmation the agent reads back comes from here, not from what it
    // sent. This is what closes the silent-divergence class.
    return {
      ok: true,
      appointment,
      confirm: {
        weekday: weekdayOf(appointment.date),
        date: appointment.date,
        spokenTime: spokenTimeOf(appointment.time),
      },
    };
  },

  cancel_appointment(args, ctx) {
    if (!ctx.verifiedPatientId) {
      return {
        ok: false,
        error: "not_verified",
        message: "Verify the patient with lookup_patient before cancelling.",
      };
    }

    const id = str(args, "appointment_id");
    const appt = ctx.state.appointments.find((a) => a.id === id);

    if (!appt || appt.status !== "booked") {
      return {
        ok: false,
        error: "not_found",
        message: "No such active appointment.",
      };
    }
    // A caller may only cancel their own appointment, however sympathetic
    // the reason they give for wanting someone else's.
    if (appt.patientId !== ctx.verifiedPatientId) {
      return {
        ok: false,
        error: "not_authorised",
        message:
          "That appointment belongs to a different patient. It cannot be " +
          "cancelled by this caller. Offer to have staff call them back.",
      };
    }

    appt.status = "cancelled";
    return {
      ok: true,
      cancelled: {
        id: appt.id,
        date: appt.date,
        weekday: weekdayOf(appt.date),
        time: appt.time,
        spokenTime: spokenTimeOf(appt.time),
      },
    };
  },

  escalate_to_human(args, ctx) {
    const urgencyRaw = str(args, "urgency");
    const urgency =
      urgencyRaw === "emergency" || urgencyRaw === "urgent"
        ? urgencyRaw
        : "routine";

    ctx.state.escalations.push({
      reason: str(args, "reason"),
      summary: str(args, "summary"),
      urgency,
    });

    return {
      ok: true,
      message:
        urgency === "emergency"
          ? "Escalated. Tell the caller to seek emergency care now and that " +
            "clinic staff are being brought on immediately."
          : "Escalated. Tell the caller a staff member will follow up.",
    };
  },
};

export function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): ToolOutcome {
  const handler = HANDLERS[name];
  if (!handler) {
    ctx.state.toolLog.push({ name, args, ok: false });
    return {
      ok: false,
      error: "unknown_tool",
      message: `No tool named ${name}.`,
    };
  }

  const outcome = handler(args, ctx);
  ctx.state.toolLog.push({ name, args, ok: outcome.ok === true });
  return outcome;
}
