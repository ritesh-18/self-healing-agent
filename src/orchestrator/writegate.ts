import { activeAppointments, type ClinicState } from "../clinic/state.js";
import type { EventBus } from "../events/bus.js";

/**
 * The write gate.
 *
 * Every create, update or delete passes through here before the tool runs.
 * The tool layer already refuses unverified callers and third-party records;
 * this adds the checks that need call-level context the tool cannot see -
 * whether the caller actually confirmed, and whether this exact write has
 * already happened.
 *
 * Ordered deliberately, cheapest and most absolute first.
 */

export type WriteKind = "book" | "cancel" | "reschedule";

export interface WriteRequest {
  kind: WriteKind;
  /** Identity as the ORCHESTRATOR knows it, never as the model supplied it. */
  verifiedPatientId: string | null;
  /** The record being changed, for cancel and reschedule. */
  appointmentId?: string;
  /** Stable per logical request, so a retry cannot double-write. */
  idempotencyKey: string;
  /** Whether the caller gave explicit assent this turn. */
  confirmed: boolean;
  details: Record<string, unknown>;
}

export type WriteDecision =
  | { allowed: true; idempotencyKey: string }
  | { allowed: false; code: WriteRejection; message: string };

export type WriteRejection =
  | "not_verified"
  | "not_authorised"
  | "not_confirmed"
  | "policy_violation"
  | "duplicate";

/** Policy the clinic enforces. Returned to the agent, never invented by it. */
export interface Policy {
  /** Hours of notice required to cancel. */
  cancellationNoticeHours: number;
  /** Maximum concurrent active appointments per patient. */
  maxActiveAppointments: number;
  /** Whether same-day rescheduling is permitted. */
  allowSameDayReschedule: boolean;
}

export const DEFAULT_POLICY: Policy = {
  cancellationNoticeHours: 24,
  maxActiveAppointments: 3,
  allowSameDayReschedule: false,
};

export class WriteGate {
  /** Keys already written, so a retry is a no-op rather than a duplicate. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly state: ClinicState,
    private readonly bus: EventBus,
    private readonly policy: Policy = DEFAULT_POLICY,
  ) {}

  check(req: WriteRequest): WriteDecision {
    this.bus.emit("write.gated", {
      kind: req.kind,
      appointmentId: req.appointmentId,
      idempotencyKey: req.idempotencyKey,
    });

    const reject = (code: WriteRejection, message: string): WriteDecision => {
      this.bus.emit("write.rejected", { kind: req.kind, code, message });
      return { allowed: false, code, message };
    };

    // 1. Identity. Taken from orchestrator context, never from a tool
    //    argument, so a mid-call mention of another name cannot redirect it.
    if (!req.verifiedPatientId) {
      return reject(
        "not_verified",
        "The caller has not been verified. Verify before changing any record.",
      );
    }

    // 2. Row-level security. The caller may only touch their own records,
    //    however sympathetic the reason they give for wanting someone else's.
    if (req.appointmentId) {
      const appt = this.state.appointments.find(
        (a) => a.id === req.appointmentId,
      );
      if (!appt) {
        return reject("not_authorised", "No such appointment.");
      }
      if (appt.patientId !== req.verifiedPatientId) {
        return reject(
          "not_authorised",
          "That appointment belongs to a different patient and cannot be " +
            "changed by this caller. Offer to have staff call them back.",
        );
      }
    }

    // 3. Explicit confirmation before anything destructive. "Okay" while the
    //    agent is still talking is not assent.
    if (!req.confirmed && req.kind !== "book") {
      return reject(
        "not_confirmed",
        "Read the change back to the caller and get a clear yes first.",
      );
    }

    // 4. Policy. Encoded here and surfaced to the agent so it never invents a
    //    rule it half-remembers.
    const policyError = this.checkPolicy(req);
    if (policyError) return reject("policy_violation", policyError);

    // 5. Idempotency. Calls drop mid-write; the retry must not create a
    //    second appointment.
    if (this.seen.has(req.idempotencyKey)) {
      return reject(
        "duplicate",
        "This change has already been applied. Do not repeat it.",
      );
    }
    this.seen.add(req.idempotencyKey);

    return { allowed: true, idempotencyKey: req.idempotencyKey };
  }

  private checkPolicy(req: WriteRequest): string | undefined {
    if (req.kind === "book") {
      const active = activeAppointments(this.state).filter(
        (a) => a.patientId === req.verifiedPatientId,
      );
      if (active.length >= this.policy.maxActiveAppointments) {
        return (
          `This patient already has ${active.length} appointments booked, ` +
          `which is the maximum. Staff can add more if needed.`
        );
      }
    }

    if (req.kind === "reschedule" && !this.policy.allowSameDayReschedule) {
      const appt = this.state.appointments.find(
        (a) => a.id === req.appointmentId,
      );
      if (appt?.date === this.state.today) {
        return (
          "Same-day rescheduling is not permitted. Offer to have staff call " +
          "them back."
        );
      }
    }

    return undefined;
  }

  /** So the agent can state policy rather than guess at it. */
  describePolicy(): Policy {
    return { ...this.policy };
  }
}

/** Stable key for a logical write, so retries collapse. */
export function idempotencyKey(
  callId: string,
  kind: WriteKind,
  details: Record<string, unknown>,
): string {
  const parts = Object.keys(details)
    .sort()
    .map((k) => `${k}=${String(details[k])}`)
    .join("&");
  return `${callId}:${kind}:${parts}`;
}
