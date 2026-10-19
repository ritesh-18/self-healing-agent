import { randomUUID } from "node:crypto";
import { redactObject } from "../orchestrator/redact.js";

/**
 * Tracing.
 *
 * The event log records WHAT happened in a call; a trace records HOW LONG
 * each step took, what was sent to the model, and what came back. They answer
 * different questions, and conflating them would make the event log huge and
 * the trace imprecise.
 *
 * Spans nest: a call contains turns, a turn contains a safety screen and an
 * agent step, an agent step contains provider calls and tool calls. That tree
 * is what makes "this scenario took 84 seconds" actionable - you can see
 * whether it was one slow provider call or twelve ordinary ones.
 *
 * Payloads are redacted on capture, not on export. A prompt carries the
 * caller's date of birth and health complaint, and a trace is the artifact
 * most likely to end up in a bug report.
 */

export type SpanKind =
  | "call"
  | "turn"
  | "safety"
  | "preprocess"
  | "agent"
  | "provider"
  | "tool"
  | "judge"
  | "verify"
  | "reflect"
  | "scenario"
  | "suite";

export type SpanStatus = "ok" | "error";

export interface Span {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind: SpanKind;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: SpanStatus;
  error?: string;
  /** Small, queryable facts: model, tool name, token counts. */
  attributes: Record<string, unknown>;
  /** Large payloads: prompts, responses. Redacted, kept out of Postgres. */
  payload?: Record<string, unknown>;
}

export interface TraceExporter {
  export(trace: Trace): Promise<void>;
}

/**
 * One trace tree, usually one scenario or one call.
 *
 * Deliberately in-memory and synchronous to record. A tracer that awaits on
 * every span would add latency to a live call, and a tracer that drops spans
 * under load would be worse than none at all - you would trust it and be
 * wrong.
 */
export class Trace {
  readonly id = randomUUID();
  private readonly spans: Span[] = [];
  private readonly stack: string[] = [];

  constructor(
    readonly name: string,
    readonly rootAttributes: Record<string, unknown> = {},
  ) {}

  get all(): readonly Span[] {
    return this.spans;
  }

  /** Opens a span. Returns a handle the caller must end. */
  start(
    name: string,
    kind: SpanKind,
    attributes: Record<string, unknown> = {},
  ): SpanHandle {
    const span: Span = {
      id: randomUUID(),
      traceId: this.id,
      parentId: this.stack[this.stack.length - 1],
      name,
      kind,
      startedAt: Date.now(),
      status: "ok",
      attributes,
    };
    this.spans.push(span);
    this.stack.push(span.id);
    return new SpanHandle(span, () => {
      const i = this.stack.lastIndexOf(span.id);
      if (i >= 0) this.stack.splice(i, 1);
    });
  }

  /** Wraps an async operation in a span, ending it on both paths. */
  async span<T>(
    name: string,
    kind: SpanKind,
    fn: (handle: SpanHandle) => Promise<T>,
    attributes: Record<string, unknown> = {},
  ): Promise<T> {
    const handle = this.start(name, kind, attributes);
    try {
      const result = await fn(handle);
      handle.end();
      return result;
    } catch (err) {
      handle.fail(err);
      throw err;
    }
  }

  /** Totals by span kind, for the dashboard's latency breakdown. */
  summary(): {
    totalMs: number;
    spanCount: number;
    errorCount: number;
    byKind: Record<string, { count: number; totalMs: number }>;
  } {
    const byKind: Record<string, { count: number; totalMs: number }> = {};
    let errorCount = 0;

    for (const s of this.spans) {
      const entry = byKind[s.kind] ?? { count: 0, totalMs: 0 };
      entry.count++;
      entry.totalMs += s.durationMs ?? 0;
      byKind[s.kind] = entry;
      if (s.status === "error") errorCount++;
    }

    const root = this.spans[0];
    return {
      totalMs: root?.durationMs ?? 0,
      spanCount: this.spans.length,
      errorCount,
      byKind,
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      attributes: this.rootAttributes,
      summary: this.summary(),
      spans: this.spans,
    };
  }
}

export class SpanHandle {
  constructor(
    private readonly span: Span,
    private readonly pop: () => void,
  ) {}

  get id(): string {
    return this.span.id;
  }

  attr(key: string, value: unknown): this {
    this.span.attributes[key] = value;
    return this;
  }

  /** Large payloads are redacted here, at capture time. */
  capture(payload: Record<string, unknown>, patientNames: string[] = []): this {
    this.span.payload = redactObject(payload, patientNames);
    return this;
  }

  end(): void {
    if (this.span.endedAt) return;
    this.span.endedAt = Date.now();
    this.span.durationMs = this.span.endedAt - this.span.startedAt;
    this.pop();
  }

  fail(error: unknown): void {
    this.span.status = "error";
    this.span.error = error instanceof Error ? error.message : String(error);
    this.end();
  }
}

/** No-op tracer, so tracing can be switched off without conditionals. */
export const NOOP_TRACE = new Trace("noop");
