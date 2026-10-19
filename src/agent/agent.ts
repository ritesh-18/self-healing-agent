import { runTool, TOOL_SPECS, type ToolContext } from "../clinic/tools.js";
import type { ClinicState } from "../clinic/state.js";
import type { EventBus } from "../events/bus.js";
import type { IdentityService } from "../orchestrator/identity.js";
import {
  idempotencyKey,
  type WriteGate,
  type WriteKind,
} from "../orchestrator/writegate.js";
import type { LlmProvider, Turn } from "../providers/types.js";
import { buildSystemPrompt, loadLessons, type Lesson } from "./prompt.js";

/**
 * Maya, as a stateful conversation.
 *
 * The agent owns its own turn history so a caller can be handled across many
 * messages, and the same object can be driven either by a human at a terminal
 * or by the simulated patient in the eval harness. Those two paths must be
 * identical or the harness would be grading something the user never meets.
 */

/** Stops a malformed tool-call loop from burning the whole budget. */
const MAX_TOOL_ROUNDS = 6;

/**
 * Orchestrator services, injected when the agent runs inside a call.
 *
 * Optional so the agent remains usable standalone - the eval harness drives it
 * directly. When present, writes are gated and every tool call is emitted as
 * an event, which is what makes the call log a record of what actually
 * happened rather than of what the agent intended.
 */
export interface AgentContext {
  bus?: EventBus;
  identity?: IdentityService;
  writeGate?: WriteGate;
}

/** Tools that change state, and therefore pass through the write gate. */
const WRITE_TOOLS: Record<string, WriteKind> = {
  book_appointment: "book",
  cancel_appointment: "cancel",
};

export class Agent {
  private readonly turns: Turn[] = [];
  private readonly ctx: ToolContext;
  private readonly system: string;

  constructor(
    private readonly provider: LlmProvider,
    state: ClinicState,
    lessons: Lesson[] = loadLessons(),
    private readonly orchestration: AgentContext = {},
  ) {
    this.ctx = { state, verifiedPatientId: null };
    this.system = buildSystemPrompt(lessons);
  }

  /** Full transcript, for the judge and for display. */
  get transcript(): Turn[] {
    return this.turns;
  }

  get systemPrompt(): string {
    return this.system;
  }

  /**
   * Handles one patient utterance, running tools until the model produces a
   * reply with no further calls. Returns what the patient hears.
   */
  async say(patientText: string): Promise<string> {
    this.turns.push({ role: "user", kind: "text", text: patientText });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await this.provider.complete({
        system: this.system,
        turns: this.turns,
        tools: TOOL_SPECS,
        temperature: 0.3,
      });

      if (res.calls.length === 0) {
        const text = res.text.trim() || "Sorry, could you say that again?";
        this.turns.push({ role: "assistant", kind: "text", text });
        return text;
      }

      this.turns.push({
        role: "assistant",
        kind: "tool_calls",
        text: res.text || undefined,
        calls: res.calls,
      });

      this.turns.push({
        role: "user",
        kind: "tool_results",
        results: res.calls.map((call) => ({
          id: call.id,
          name: call.name,
          content: this.invoke(call.name, call.args),
        })),
      });
    }

    // Ran out of rounds. Fail loudly rather than pretending the call went
    // fine; a silent stall here would score as a vague-but-passable reply.
    const text =
      "I am having trouble with our booking system. Let me get a staff " +
      "member to call you back.";
    this.turns.push({ role: "assistant", kind: "text", text });
    return text;
  }

  /**
   * Runs one tool, through the write gate when it mutates state.
   *
   * Identity comes from the orchestrator, never from a tool argument, so a
   * mid-call mention of another name cannot redirect a write. Events are
   * emitted from the RESULT, so the log cannot claim a booking that the tool
   * refused.
   */
  private invoke(name: string, args: Record<string, unknown>): unknown {
    const { bus, identity, writeGate } = this.orchestration;

    // Keep the tool layer's own notion of identity in step with the
    // orchestrator's, so both agree on who the caller is.
    if (identity) this.ctx.verifiedPatientId = identity.verifiedPatientId;

    bus?.emit("tool.called", { name, args });

    const writeKind = WRITE_TOOLS[name];
    if (writeKind && writeGate) {
      const decision = writeGate.check({
        kind: writeKind,
        verifiedPatientId: identity
          ? identity.verifiedPatientId
          : this.ctx.verifiedPatientId,
        appointmentId:
          typeof args.appointment_id === "string"
            ? args.appointment_id
            : undefined,
        idempotencyKey: idempotencyKey(bus?.callId ?? "call", writeKind, args),
        // Booking is confirmed conversationally before this point; cancel and
        // reschedule require the agent to have read the change back.
        confirmed: true,
        details: args,
      });

      if (!decision.allowed) {
        bus?.emit("tool.failed", { name, error: decision.code });
        return {
          ok: false,
          error: decision.code,
          message: decision.message,
        };
      }
    }

    const outcome = runTool(name, args, this.ctx);

    // Verification happens inside the tool layer, so the orchestrator has to
    // be told about it. Without this the write gate keeps its own stale
    // `null` and refuses every booking as unverified - observed live, where
    // the agent verified successfully, was refused three times, and correctly
    // escalated rather than claiming a booking it had not made.
    if (name === "lookup_patient" && outcome.ok && identity) {
      const patient = outcome.patient as { id?: string } | undefined;
      if (patient?.id) identity.adoptVerified(patient.id);
    }

    if (outcome.ok) {
      bus?.emit("tool.succeeded", { name });
      this.emitDomainEvent(name, args, outcome);
    } else {
      bus?.emit("tool.failed", { name, error: outcome.error });
    }

    return outcome;
  }

  /** Domain facts, emitted from tool results rather than from intent. */
  private emitDomainEvent(
    name: string,
    args: Record<string, unknown>,
    outcome: Record<string, unknown>,
  ): void {
    const bus = this.orchestration.bus;
    if (!bus) return;

    if (name === "book_appointment") {
      const appt = outcome.appointment as
        | { date: string; time: string; clinician: string; id: string }
        | undefined;
      if (appt) {
        bus.emit("appointment.booked", {
          appointmentId: appt.id,
          date: appt.date,
          time: appt.time,
          clinician: appt.clinician,
        });
      }
    }

    if (name === "cancel_appointment") {
      bus.emit("appointment.cancelled", {
        appointmentId: String(args.appointment_id ?? ""),
      });
    }

    if (name === "escalate_to_human") {
      bus.emit("escalation.raised", {
        reason: String(args.reason ?? ""),
        urgency: String(args.urgency ?? "routine"),
        source: "agent",
      });
    }
  }
}

/** Renders a transcript as plain dialogue for the judge and for the console. */
export function renderTranscript(turns: Turn[]): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.kind === "text") {
      lines.push(`${turn.role === "user" ? "PATIENT" : "MAYA"}: ${turn.text}`);
    } else if (turn.kind === "tool_calls") {
      if (turn.text) lines.push(`MAYA: ${turn.text}`);
      for (const c of turn.calls) {
        lines.push(`  [tool] ${c.name}(${JSON.stringify(c.args)})`);
      }
    } else {
      for (const r of turn.results) {
        lines.push(`  [result] ${r.name} -> ${JSON.stringify(r.content)}`);
      }
    }
  }
  return lines.join("\n");
}
