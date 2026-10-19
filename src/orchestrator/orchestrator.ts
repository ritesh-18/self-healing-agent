import { Agent } from "../agent/agent.js";
import type { Lesson } from "../agent/prompt.js";
import type { ClinicState } from "../clinic/state.js";
import { EventBus } from "../events/bus.js";
import type { LlmProvider } from "../providers/types.js";
import { IdentityService } from "./identity.js";
import { FallbackTracker, preprocess } from "./preprocess.js";
import {
  safetyResponse,
  screenUtterance,
  urgencyFor,
  type SafetyVerdict,
} from "./safety.js";
import { summarize, type CallSummary } from "./summarize.js";
import { WriteGate, type Policy } from "./writegate.js";

/**
 * The orchestrator.
 *
 * Owns one call. Every stage emits an event rather than calling the next
 * stage directly, so the log is the record of what happened and observers
 * (summarizer, metrics, failure triage) can subscribe without sitting in the
 * call path.
 *
 * Per-turn order, and the reasoning for it:
 *
 *   1. SAFETY      first and unconditional. A missed escalation is
 *                  unrecoverable, and an emergency is not a "relevant"
 *                  scheduling query, so a relevance gate running first would
 *                  spend a clarification on a cardiac event.
 *   2. RELEVANCE   only to decide whether the conversation is going anywhere.
 *   3. AGENT       intent and tool selection happen here, with the whole
 *                  conversation in view.
 *   4. WRITE GATE  enforced inside the tool layer via the injected gate.
 *
 * What this does NOT do is pre-classify intent or pre-validate entities. The
 * agent does both better with full context, and the tool layer validates
 * whatever it produces.
 */

export interface OrchestratorProviders {
  agent: LlmProvider;
  /** Used for the safety screen and relevance. Can be a cheaper model. */
  classifier: LlmProvider;
}

export interface OrchestratorOptions {
  callId: string;
  state: ClinicState;
  providers: OrchestratorProviders;
  lessons?: Lesson[];
  policy?: Policy;
  maxTurns?: number;
  /** Skip the LLM half of the safety screen; the pattern floor still runs. */
  deterministicSafetyOnly?: boolean;
}

export interface TurnResult {
  reply: string;
  ended: boolean;
  safety: SafetyVerdict;
}

export class Orchestrator {
  readonly bus: EventBus;
  readonly identity: IdentityService;
  readonly writeGate: WriteGate;

  private readonly agent: Agent;
  private readonly fallback = new FallbackTracker();
  private readonly opts: OrchestratorOptions;
  private turns = 0;
  private closed = false;

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
    this.bus = new EventBus(opts.callId);
    this.identity = new IdentityService(opts.state, this.bus);
    this.writeGate = new WriteGate(opts.state, this.bus, opts.policy);
    this.agent = new Agent(
      opts.providers.agent,
      opts.state,
      opts.lessons ?? [],
      { bus: this.bus, identity: this.identity, writeGate: this.writeGate },
    );

    this.bus.emit("call.started", { callId: opts.callId });
  }

  get transcript() {
    return this.agent.transcript;
  }

  get ended(): boolean {
    return this.closed;
  }

  /** Handles one caller utterance through the full pipeline. */
  async handle(utterance: string): Promise<TurnResult> {
    if (this.closed) {
      return {
        reply: "This call has ended.",
        ended: true,
        safety: { classification: "none", reason: "call closed" },
      };
    }

    this.turns++;
    this.bus.emit("utterance.received", { turn: this.turns });
    this.bus.emit("turn.started", { turn: this.turns });

    // --- 1. Safety, before anything else ---------------------------------
    const safety = await screenUtterance(
      utterance,
      this.opts.deterministicSafetyOnly
        ? undefined
        : this.opts.providers.classifier,
    );
    this.bus.emit("safety.screened", {
      classification: safety.classification,
      reason: safety.reason,
    });

    if (safety.classification !== "none") {
      return this.handleSafety(utterance, safety);
    }

    // --- 2. Relevance, only to detect a stalled conversation --------------
    const pre = await preprocess(utterance, this.opts.providers.classifier);
    this.bus.emit("intent.classified", {
      relevance: pre.relevance,
      intent: pre.intent,
      entities: pre.entities,
    });

    this.fallback.record(pre.relevance);
    if (pre.relevance !== "actionable") {
      this.bus.emit("clarification.requested", {
        relevance: pre.relevance,
        counts: this.fallback.counts,
      });
    }

    if (this.fallback.exhausted) {
      return this.closeExhausted();
    }

    // --- 3. The agent: intent, tools, everything with full context --------
    const reply = await this.agent.say(utterance);
    this.bus.emit("turn.completed", { turn: this.turns });

    if (this.opts.maxTurns && this.turns >= this.opts.maxTurns) {
      this.end();
      return { reply, ended: true, safety };
    }

    return { reply, ended: false, safety };
  }

  /**
   * Safety short-circuit.
   *
   * Escalates and answers with no reassurance. "Probably nothing, but let me
   * put you through" is a failure, not a partial success, so the response text
   * is fixed rather than generated.
   */
  private handleSafety(utterance: string, safety: SafetyVerdict): TurnResult {
    const urgency = urgencyFor(safety);

    this.bus.emit("safety.triggered", {
      classification: safety.classification,
      trigger: safety.trigger,
      urgency,
    });
    this.bus.emit("escalation.raised", {
      reason: safety.reason,
      urgency,
      source: "safety_classifier",
    });

    this.opts.state.escalations.push({
      reason: safety.reason,
      summary: utterance,
      urgency,
    });

    const reply = safetyResponse(safety);
    // An emergency or self-harm disclosure ends the scheduling conversation.
    // A clinical question does not - the caller may still want their booking.
    const ended =
      safety.classification === "emergency" ||
      safety.classification === "self_harm";

    if (ended) this.end();
    return { reply, ended, safety };
  }

  private closeExhausted(): TurnResult {
    this.bus.emit("fallback.exhausted", {
      counts: this.fallback.counts,
      reason: this.fallback.exhaustionReason,
    });
    this.bus.emit("escalation.raised", {
      reason: "conversation could not progress",
      urgency: "routine",
      source: "fallback",
    });

    this.opts.state.escalations.push({
      reason: "conversation could not progress",
      summary: this.fallback.exhaustionReason,
      urgency: "routine",
    });

    this.end();
    return {
      reply:
        "I am having trouble helping with this one. Let me pass you to a " +
        "staff member who can.",
      ended: true,
      safety: { classification: "none", reason: "fallback exhausted" },
    };
  }

  /** Ends the call and emits the summary. Idempotent. */
  end(): CallSummary {
    if (this.closed) return this.summary();

    this.closed = true;
    this.bus.emit("call.ended", { turns: this.turns });

    const summary = this.summary();
    this.bus.emit("summary.generated", {
      outcome: summary.outcome,
      narrative: summary.narrative,
    });
    this.bus.emit("record.appended", { callId: this.opts.callId });

    return summary;
  }

  summary(): CallSummary {
    return summarize(
      this.bus,
      this.opts.state.patients.map((p) => p.name),
    );
  }
}
