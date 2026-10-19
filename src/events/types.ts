/**
 * The event log.
 *
 * Every stage of a call emits an event rather than calling the next stage
 * directly. That inversion buys four things this system specifically needs:
 *
 *  - **Auditability.** The event log IS the record. There is no separate
 *    logging path that can disagree with what happened, which matters when the
 *    question is "why did this patient get booked on the wrong day".
 *  - **Replay.** A failed call can be re-run from its events, which is what
 *    the investigator does instead of guessing from a transcript.
 *  - **Decoupling.** The summarizer, the metrics collector and the failure
 *    triage all subscribe; none of them is wired into the call path, so none
 *    of them can break a live call.
 *  - **Honest state.** `appointment.booked` is emitted from the tool result,
 *    not from the agent's intent, so the log cannot claim a booking that did
 *    not happen.
 *
 * Events are facts about the past. They are named in the past tense, never
 * mutated, and carry everything a consumer needs so no consumer has to reach
 * back into live state.
 */

export type EventName =
  // Call lifecycle
  | "call.started"
  | "call.ended"
  // Caller input
  | "utterance.received"
  // Safety - always first, always able to short-circuit
  | "safety.screened"
  | "safety.triggered"
  // Identity
  | "identity.attempted"
  | "identity.verified"
  | "identity.failed"
  | "identity.locked"
  | "registration.started"
  | "registration.completed"
  // Orchestration
  | "turn.started"
  | "intent.classified"
  | "clarification.requested"
  | "fallback.exhausted"
  | "turn.completed"
  // Tools
  | "tool.called"
  | "tool.succeeded"
  | "tool.failed"
  // Writes
  | "write.gated"
  | "write.rejected"
  | "appointment.booked"
  | "appointment.cancelled"
  // Escalation
  | "escalation.raised"
  // Close
  | "summary.generated"
  | "record.appended"
  // Failure handling
  | "failure.detected"
  | "investigation.started"
  | "investigation.completed"
  | "remediation.proposed"
  | "review.queued";

export interface BaseEvent {
  /** Monotonic within a call, so ordering never depends on clock precision. */
  seq: number;
  callId: string;
  name: EventName;
  at: string;
  payload: Record<string, unknown>;
}

export type CallEvent = BaseEvent;

/** A consumer. Throwing must never break the call, so the bus isolates them. */
export type EventHandler = (event: CallEvent) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}
