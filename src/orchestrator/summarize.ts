import type { EventBus } from "../events/bus.js";
import { redact, redactNames } from "./redact.js";

/**
 * Call summarizer.
 *
 * Built from the EVENT LOG, not from the transcript. That distinction is the
 * whole point: the transcript records what the agent said, and the agent can
 * say "you're all booked" when nothing was written. The event log records what
 * actually happened, because `appointment.booked` is emitted from the tool
 * result rather than from the agent's intent.
 *
 * A summary is therefore a statement of fact about the call, and it is
 * redacted before it reaches storage.
 */

export interface CallSummary {
  callId: string;
  startedAt: string;
  endedAt: string;
  turns: number;

  /** Facts, drawn from events rather than from what the agent claimed. */
  verified: boolean;
  outcome: CallOutcome;
  appointmentsBooked: { date: string; time: string; clinician: string }[];
  appointmentsCancelled: string[];
  escalations: { reason: string; urgency: string }[];

  /** Anything a human following up needs to know. */
  unresolved: string[];
  failures: string[];

  /** One-line, redacted, safe to store and to show. */
  narrative: string;
}

export type CallOutcome =
  | "completed"
  | "escalated"
  | "abandoned"
  | "failed"
  | "identity_locked";

function outcomeOf(bus: EventBus): CallOutcome {
  if (bus.has("identity.locked")) return "identity_locked";
  if (bus.has("failure.detected")) return "failed";
  if (bus.has("escalation.raised")) return "escalated";
  if (bus.has("appointment.booked") || bus.has("appointment.cancelled")) {
    return "completed";
  }
  if (bus.has("fallback.exhausted")) return "abandoned";
  return "completed";
}

/** An empty summary, for results that did not come from a real call. */
export function emptySummary(callId = "none"): CallSummary {
  return {
    callId,
    startedAt: "",
    endedAt: "",
    turns: 0,
    verified: false,
    outcome: "failed",
    appointmentsBooked: [],
    appointmentsCancelled: [],
    escalations: [],
    unresolved: [],
    failures: [],
    narrative: "",
  };
}

export function summarize(bus: EventBus, patientNames: string[] = []): CallSummary {
  const started = bus.first("call.started");
  const ended = bus.last("call.ended");

  const booked = bus.find("appointment.booked").map((e) => ({
    date: String(e.payload.date ?? ""),
    time: String(e.payload.time ?? ""),
    clinician: String(e.payload.clinician ?? ""),
  }));

  const cancelled = bus
    .find("appointment.cancelled")
    .map((e) => String(e.payload.appointmentId ?? ""));

  const escalations = bus.find("escalation.raised").map((e) => ({
    reason: String(e.payload.reason ?? ""),
    urgency: String(e.payload.urgency ?? "routine"),
  }));

  const failures = [
    ...bus.find("tool.failed").map((e) => `tool ${e.payload.name}: ${e.payload.error}`),
    ...bus.find("write.rejected").map((e) => `write ${e.payload.kind}: ${e.payload.code}`),
    ...bus.find("failure.detected").map((e) => String(e.payload.reason ?? "unknown")),
  ];

  const unresolved: string[] = [];
  if (bus.has("fallback.exhausted")) {
    unresolved.push("Call closed without resolving the caller's request.");
  }
  if (bus.has("identity.locked")) {
    unresolved.push("Caller could not be verified; needs staff follow-up.");
  }
  for (const e of escalations) {
    unresolved.push(`Escalated (${e.urgency}): ${e.reason}`);
  }

  const outcome = outcomeOf(bus);
  const turns = bus.count("utterance.received");

  const raw = buildNarrative({ outcome, booked, cancelled, escalations, turns });
  const narrative = redactNames(redact(raw).text, patientNames);

  return {
    callId: bus.callId,
    startedAt: started?.at ?? "",
    endedAt: ended?.at ?? new Date().toISOString(),
    turns,
    verified: bus.has("identity.verified"),
    outcome,
    appointmentsBooked: booked,
    appointmentsCancelled: cancelled,
    escalations,
    unresolved,
    failures,
    narrative,
  };
}

function buildNarrative(f: {
  outcome: CallOutcome;
  booked: { date: string; time: string; clinician: string }[];
  cancelled: string[];
  escalations: { reason: string; urgency: string }[];
  turns: number;
}): string {
  const parts: string[] = [];

  if (f.booked.length) {
    parts.push(
      `Booked ${f.booked.length} appointment(s): ` +
        f.booked.map((b) => `${b.clinician} ${b.date} ${b.time}`).join("; "),
    );
  }
  if (f.cancelled.length) {
    parts.push(`Cancelled ${f.cancelled.length} appointment(s).`);
  }
  for (const e of f.escalations) {
    parts.push(`Escalated to staff (${e.urgency}): ${e.reason}.`);
  }

  if (parts.length === 0) {
    parts.push(
      f.outcome === "abandoned"
        ? "Call ended without a resolution."
        : "No changes were made.",
    );
  }

  return `${f.turns}-turn call. ${parts.join(" ")}`;
}
