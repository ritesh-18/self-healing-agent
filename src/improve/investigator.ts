import type { CallEvent } from "../events/types.js";
import { EventBus } from "../events/bus.js";
import type { LlmProvider } from "../providers/types.js";
import { emptySummary, type CallSummary } from "../orchestrator/summarize.js";
import { verifyFailure, type Verdict } from "./verify.js";

/**
 * The investigator.
 *
 * Runs OFFLINE, on batches of failed calls. Two deliberate departures from
 * the obvious design:
 *
 *  - **Not in-call.** By the time a failure is detected the caller is on the
 *    line waiting, and you cannot repair a live call. In-call behaviour is
 *    narrow and boring: fail honestly, escalate with context, preserve state.
 *    The investigator's job is to stop the NEXT caller hitting it.
 *
 *  - **Batched, not per-call.** Three similar failures tell you far more than
 *    one. Clustering by signature turns "this call went wrong" into "the
 *    date-confirmation path is broken", which is a diagnosis rather than an
 *    anecdote.
 *
 * It replays the event log rather than reading the transcript, because the
 * transcript records what the agent SAID and the log records what actually
 * happened.
 */

export interface FailedCall {
  callId: string;
  events: CallEvent[];
  summary: CallSummary;
}

export interface FailureSignature {
  /** Stable key identifying this class of failure. */
  key: string;
  description: string;
  callIds: string[];
  /** Representative call, used for the detailed diagnosis. */
  exemplar: FailedCall;
}

/**
 * Derives a signature from the event log.
 *
 * Deliberately coarse: it groups by WHAT went wrong and WHERE, not by the
 * specifics of one caller. Two callers hitting the same broken tool should
 * land in the same cluster even though everything else about their calls
 * differs.
 */
export function signatureOf(call: FailedCall): { key: string; description: string } {
  const bus = EventBus.fromJSON(call.callId, call.events);

  const toolFailure = bus.first("tool.failed");
  if (toolFailure) {
    const name = String(toolFailure.payload.name ?? "unknown");
    const error = String(toolFailure.payload.error ?? "unknown");
    return {
      key: `tool:${name}:${error}`,
      description: `${name} failed with ${error}`,
    };
  }

  const writeRejected = bus.first("write.rejected");
  if (writeRejected) {
    const code = String(writeRejected.payload.code ?? "unknown");
    return {
      key: `write:${code}`,
      description: `write gate rejected: ${code}`,
    };
  }

  if (bus.has("identity.locked")) {
    return {
      key: "identity:locked",
      description: "caller could not be verified within the attempt limit",
    };
  }

  if (bus.has("fallback.exhausted")) {
    return {
      key: "fallback:exhausted",
      description: "conversation could not progress",
    };
  }

  // A call that produced no booking and no escalation achieved nothing, even
  // though nothing visibly errored. That silence is itself the signature.
  if (
    !bus.has("appointment.booked") &&
    !bus.has("appointment.cancelled") &&
    !bus.has("escalation.raised")
  ) {
    return {
      key: "outcome:none",
      description: "call ended with no booking, cancellation or escalation",
    };
  }

  return { key: "unknown", description: "no recognised failure signature" };
}

/** Groups failed calls by signature, most frequent first. */
export function cluster(calls: FailedCall[]): FailureSignature[] {
  const groups = new Map<string, FailureSignature>();

  for (const call of calls) {
    const sig = signatureOf(call);
    const existing = groups.get(sig.key);
    if (existing) {
      existing.callIds.push(call.callId);
    } else {
      groups.set(sig.key, {
        key: sig.key,
        description: sig.description,
        callIds: [call.callId],
        exemplar: call,
      });
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.callIds.length - a.callIds.length,
  );
}

export interface Investigation {
  signature: FailureSignature;
  /** How many calls share this signature - frequency is severity. */
  occurrences: number;
  verdict: Verdict;
  /** The event sequence that led to the failure, for a human reviewer. */
  trail: string[];
}

/** Human-readable event trail, trimmed to what matters. */
export function trailOf(call: FailedCall): string[] {
  const interesting = new Set([
    "safety.triggered",
    "identity.failed",
    "identity.locked",
    "intent.classified",
    "tool.called",
    "tool.failed",
    "write.rejected",
    "appointment.booked",
    "appointment.cancelled",
    "escalation.raised",
    "fallback.exhausted",
  ]);

  return call.events
    .filter((e) => interesting.has(e.name))
    .map((e) => {
      const detail = Object.entries(e.payload)
        .filter(([k]) => k !== "args")
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(" ");
      return `${e.seq}. ${e.name}${detail ? `  ${detail}` : ""}`;
    });
}

/**
 * Investigates one cluster.
 *
 * Reuses the same verifier the eval loop uses, so a failure found in
 * production and a failure found in the suite are classified by identical
 * rules. That matters: a system that reasons differently about the two ends up
 * with two inconsistent notions of what counts as the agent's fault.
 */
export async function investigate(
  provider: LlmProvider,
  signature: FailureSignature,
): Promise<Investigation> {
  const call = signature.exemplar;
  const trail = trailOf(call);

  // Presented to the verifier in the shape it already understands.
  const asScenarioResult = {
    id: signature.key,
    title: signature.description,
    pass: false,
    assertions: [
      {
        id: signature.key,
        describe: signature.description,
        pass: false,
      },
    ],
    rubric: [],
    failures: [`event:${signature.key}`],
    transcript:
      `EVENT TRAIL (${signature.callIds.length} similar call(s))\n` +
      trail.join("\n") +
      `\n\nSUMMARY: ${call.summary.narrative}` +
      (call.summary.failures.length
        ? `\nFAILURES: ${call.summary.failures.join("; ")}`
        : ""),
    turns: call.summary.turns,
    events: call.events,
    summary: call.summary,
    durationMs: 0,
  };

  const verdict = await verifyFailure(provider, asScenarioResult);

  return {
    signature,
    occurrences: signature.callIds.length,
    verdict,
    trail,
  };
}
