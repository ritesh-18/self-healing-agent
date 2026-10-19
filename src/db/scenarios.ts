import type { ClinicState } from "../clinic/state.js";
import { activeAppointments } from "../clinic/state.js";
import type { CallContext, Assertion, Scenario } from "../eval/scenarios.js";
import { SCENARIOS } from "../eval/scenarios.js";
import { one, query } from "./pool.js";

/**
 * Scenarios stored in the database.
 *
 * The built-in suite is written in TypeScript, where an assertion is an
 * arbitrary function. A scenario authored in the dashboard cannot be, because
 * that would mean accepting and executing user-supplied code on the server.
 *
 * So stored assertions are DECLARATIVE: a small, closed vocabulary of checks
 * with parameters, interpreted here. The vocabulary is deliberately narrow -
 * it covers what the catalogued failure classes actually need, and a check
 * that cannot be expressed is a signal the scenario belongs in code, not that
 * the vocabulary should grow arbitrarily.
 */

export type AssertionKind =
  | "appointment_exists"
  | "appointment_absent"
  | "appointment_count"
  | "appointment_cancelled"
  | "escalation_raised"
  | "no_escalation"
  | "event_emitted"
  | "event_absent"
  | "no_event_after"
  | "never_verified";

export interface StoredAssertion {
  id: string;
  describe: string;
  kind: AssertionKind;
  params: Record<string, string | number | boolean>;
}

export interface StoredScenario {
  id: string;
  title: string;
  probes: string;
  patient: string;
  max_turns: number;
  dimension: string;
  assertions: StoredAssertion[];
  rubric: string[];
  source: "builtin" | "user";
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

function matchesAppointment(
  a: { patientId: string; date: string; time: string; clinician: string },
  p: Record<string, unknown>,
): boolean {
  if (p.patientId && a.patientId !== p.patientId) return false;
  if (p.date && a.date !== p.date) return false;
  if (p.clinician && a.clinician !== p.clinician) return false;
  if (p.timeBefore && !(a.time < String(p.timeBefore))) return false;
  if (p.timeAfter && !(a.time >= String(p.timeAfter))) return false;
  return true;
}

/** Turns a declarative descriptor into a runnable check. */
export function compileAssertion(stored: StoredAssertion): Assertion {
  const p = stored.params;

  const check = (state: ClinicState, call: CallContext): boolean => {
    switch (stored.kind) {
      case "appointment_exists":
        return activeAppointments(state).some((a) => matchesAppointment(a, p));

      case "appointment_absent":
        return !activeAppointments(state).some((a) => matchesAppointment(a, p));

      case "appointment_count":
        return (
          activeAppointments(state).filter((a) => matchesAppointment(a, p))
            .length === Number(p.count ?? 0)
        );

      case "appointment_cancelled":
        return !activeAppointments(state).some((a) => a.id === p.appointmentId);

      case "escalation_raised":
        return state.escalations.some(
          (e) => !p.urgency || e.urgency === p.urgency,
        );

      case "no_escalation":
        return state.escalations.length === 0;

      case "event_emitted":
        return call.events.some(
          (e) =>
            e.name === p.event &&
            (!p.field || e.payload[String(p.field)] === p.value),
        );

      case "event_absent":
        return !call.events.some((e) => e.name === p.event);

      // Temporal: nothing of this kind may follow the marker event. This is
      // what distinguishes "no booking was made" from "no booking was made
      // after the emergency was disclosed" - the second is the real
      // requirement, and the first wrongly fails a legitimate earlier booking.
      case "no_event_after": {
        const marker = call.events.find((e) => e.name === p.after);
        if (!marker) return false;
        return !call.events.some(
          (e) => e.name === p.event && e.seq > marker.seq,
        );
      }

      case "never_verified":
        return !call.events.some((e) => e.name === "identity.verified");

      default:
        return false;
    }
  };

  return { id: stored.id, describe: stored.describe, check };
}

export function compileScenario(stored: StoredScenario): Scenario {
  return {
    id: stored.id,
    title: stored.title,
    probes: stored.probes,
    patient: stored.patient,
    maxTurns: stored.max_turns,
    assertions: stored.assertions.map(compileAssertion),
    rubric: stored.rubric,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function listScenarios(): Promise<StoredScenario[]> {
  return query<StoredScenario>(
    `SELECT * FROM scenarios ORDER BY source, id`,
  );
}

export async function enabledScenarios(): Promise<Scenario[]> {
  const rows = await query<StoredScenario>(
    `SELECT * FROM scenarios WHERE enabled ORDER BY id`,
  );
  return rows.map(compileScenario);
}

export async function getScenario(
  id: string,
): Promise<StoredScenario | undefined> {
  return one<StoredScenario>(`SELECT * FROM scenarios WHERE id = $1`, [id]);
}

export async function upsertScenario(s: {
  id: string;
  title: string;
  probes?: string;
  patient: string;
  maxTurns?: number;
  dimension?: string;
  assertions: StoredAssertion[];
  rubric: string[];
  source?: "builtin" | "user";
}): Promise<void> {
  await query(
    `INSERT INTO scenarios
       (id, title, probes, patient, max_turns, dimension, assertions, rubric, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, probes = EXCLUDED.probes,
       patient = EXCLUDED.patient, max_turns = EXCLUDED.max_turns,
       dimension = EXCLUDED.dimension, assertions = EXCLUDED.assertions,
       rubric = EXCLUDED.rubric, updated_at = now()`,
    [
      s.id,
      s.title,
      s.probes ?? "",
      s.patient,
      s.maxTurns ?? 8,
      s.dimension ?? "conversation",
      JSON.stringify(s.assertions),
      JSON.stringify(s.rubric),
      s.source ?? "user",
    ],
  );
}

export async function setScenarioEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await query(`UPDATE scenarios SET enabled = $2 WHERE id = $1`, [id, enabled]);
}

export async function deleteScenario(id: string): Promise<boolean> {
  // Built-in scenarios are the regression corpus; deleting one from the UI
  // would quietly remove a guarantee. They can be disabled, not removed.
  const rows = await query(
    `DELETE FROM scenarios WHERE id = $1 AND source = 'user' RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/**
 * Seeds the code-defined suite into the database.
 *
 * Built-in scenarios keep their TypeScript assertions at runtime - only their
 * metadata is stored, so the dashboard can list and describe them. Their
 * declarative `assertions` field is left empty on purpose: compiling a
 * built-in from the database would silently weaken checks the vocabulary
 * cannot express.
 */
export async function seedBuiltins(): Promise<number> {
  const { dimensionScores } = await import("../eval/kpi.js");
  void dimensionScores;

  for (const s of SCENARIOS) {
    await query(
      `INSERT INTO scenarios
         (id, title, probes, patient, max_turns, dimension, assertions, rubric, source)
       VALUES ($1,$2,$3,$4,$5,$6,'[]'::jsonb,$7,'builtin')
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title, probes = EXCLUDED.probes,
         patient = EXCLUDED.patient, max_turns = EXCLUDED.max_turns,
         rubric = EXCLUDED.rubric, updated_at = now()`,
      [
        s.id,
        s.title,
        s.probes,
        s.patient,
        s.maxTurns,
        "conversation",
        JSON.stringify(s.rubric),
      ],
    );
  }
  return SCENARIOS.length;
}

/**
 * The suite to run: built-ins from code, user scenarios from the database.
 *
 * Built-ins keep their original assertion functions; only user scenarios are
 * compiled from descriptors.
 */
export async function runnableScenarios(): Promise<Scenario[]> {
  const stored = await query<StoredScenario>(
    `SELECT * FROM scenarios WHERE enabled`,
  );

  const enabledIds = new Set(stored.map((s) => s.id));
  const builtins = SCENARIOS.filter((s) => enabledIds.has(s.id));
  const user = stored
    .filter((s) => s.source === "user")
    .map(compileScenario);

  return [...builtins, ...user];
}
