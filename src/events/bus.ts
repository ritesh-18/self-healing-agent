import type {
  CallEvent,
  EventHandler,
  EventName,
  Subscription,
} from "./types.js";

/**
 * The event bus.
 *
 * Deliberately simple and in-process. Two properties matter more than
 * throughput here:
 *
 *  1. **A subscriber can never break a call.** Handlers are isolated; a
 *     throwing summarizer or metrics collector is recorded and swallowed. The
 *     alternative - a crash in an observer taking down a live patient call -
 *     is not acceptable.
 *  2. **The log is ordered and complete.** `seq` is assigned by the bus, so
 *     ordering never depends on clock resolution or on handlers behaving.
 *
 * Handlers are invoked synchronously in subscription order so that a consumer
 * which needs to see an event before the next one is emitted (the safety
 * short-circuit, for instance) can rely on it.
 */
export class EventBus {
  private readonly events: CallEvent[] = [];
  private readonly handlers = new Map<EventName | "*", Set<EventHandler>>();
  private readonly errors: { event: CallEvent; error: unknown }[] = [];
  private seq = 0;

  constructor(readonly callId: string) {}

  /** Records a fact and notifies subscribers. Never throws. */
  emit(name: EventName, payload: Record<string, unknown> = {}): CallEvent {
    const event: CallEvent = {
      seq: this.seq++,
      callId: this.callId,
      name,
      at: new Date().toISOString(),
      payload,
    };
    this.events.push(event);

    for (const handler of [
      ...(this.handlers.get(name) ?? []),
      ...(this.handlers.get("*") ?? []),
    ]) {
      try {
        const out = handler(event);
        // A rejected promise from an async handler must not surface as an
        // unhandled rejection and take the process down.
        if (out instanceof Promise) {
          out.catch((error) => this.errors.push({ event, error }));
        }
      } catch (error) {
        this.errors.push({ event, error });
      }
    }

    return event;
  }

  /** Subscribe to one event name, or "*" for everything. */
  on(name: EventName | "*", handler: EventHandler): Subscription {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler);
    this.handlers.set(name, set);
    return {
      unsubscribe: () => {
        set.delete(handler);
      },
    };
  }

  /** The full ordered log. This is the call's record of truth. */
  get log(): readonly CallEvent[] {
    return this.events;
  }

  /** Handler failures, surfaced rather than hidden. */
  get handlerErrors(): readonly { event: CallEvent; error: unknown }[] {
    return this.errors;
  }

  find(name: EventName): CallEvent[] {
    return this.events.filter((e) => e.name === name);
  }

  first(name: EventName): CallEvent | undefined {
    return this.events.find((e) => e.name === name);
  }

  last(name: EventName): CallEvent | undefined {
    return [...this.events].reverse().find((e) => e.name === name);
  }

  has(name: EventName): boolean {
    return this.events.some((e) => e.name === name);
  }

  count(name: EventName): number {
    return this.find(name).length;
  }

  /** Serialisable form, for persistence and for replay. */
  toJSON(): CallEvent[] {
    return [...this.events];
  }

  /** Rebuilds a bus from a stored log, for replay during investigation. */
  static fromJSON(callId: string, events: CallEvent[]): EventBus {
    const bus = new EventBus(callId);
    for (const e of events) bus.events.push(e);
    bus.seq = events.length;
    return bus;
  }
}
