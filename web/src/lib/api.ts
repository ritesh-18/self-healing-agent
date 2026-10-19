/** Thin fetch wrapper. Every call goes through here so errors read alike. */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ ok: boolean; db: boolean; config: string }>("/health"),
  stats: () => req<Stats>("/stats"),
  history: () => req<ScenarioHistory[]>("/history"),

  runs: () => req<Run[]>("/runs"),
  run: (id: string) => req<{ run: Run; results: RunResult[] }>(`/runs/${id}`),
  result: (id: string) => req<ResultDetail>(`/results/${id}`),
  startRun: (kind: "eval" | "loop", only?: string[]) =>
    req<{ runId: string }>("/runs", {
      method: "POST",
      body: JSON.stringify({ kind, only }),
    }),
  runStatus: () => req<RunState>("/runs/active/status"),

  scenarios: () => req<Scenario[]>("/scenarios"),
  createScenario: (s: unknown) =>
    req<Scenario>("/scenarios", { method: "POST", body: JSON.stringify(s) }),
  setEnabled: (id: string, enabled: boolean) =>
    req<Scenario>(`/scenarios/${id}/enabled`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  deleteScenario: (id: string) =>
    req<{ deleted: boolean }>(`/scenarios/${id}`, { method: "DELETE" }),

  reviews: (status?: string) =>
    req<Review[]>(`/reviews${status ? `?status=${status}` : ""}`),
  review: (id: string) => req<Review>(`/reviews/${id}`),
  editRule: (id: string, rule: string) =>
    req<Review>(`/reviews/${id}/rule`, {
      method: "PATCH",
      body: JSON.stringify({ rule }),
    }),
  approve: (id: string, note?: string) =>
    req<{ ok: boolean }>(`/reviews/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),
  reject: (id: string, note?: string) =>
    req<{ rejected: boolean }>(`/reviews/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),

  lessons: () => req<Lesson[]>("/lessons"),
  retireLesson: (id: string) =>
    req<{ retired: boolean }>(`/lessons/${id}/retire`, { method: "POST" }),

  checkGuardrails: (text: string) =>
    req<{ input: GuardrailResult; output: GuardrailResult }>(
      "/guardrails/check",
      { method: "POST", body: JSON.stringify({ text }) },
    ),
};

export interface Run {
  id: string;
  kind: "eval" | "loop";
  status: string;
  config: string;
  lessons_count: number;
  passed: number;
  total: number;
  duration_ms: number | null;
  error: string | null;
  started_at: string;
}

export interface RunResult {
  id: string;
  scenario_id: string;
  title: string;
  passed: boolean;
  dimension: string;
  turns: number;
  duration_ms: number;
  failures: string[];
  audit: Audit | null;
}

export interface Audit {
  totalCalls: number;
  failedCalls: number;
  findings: { severity: string; code: string; detail: string }[];
  calls: { seq: number; name: string; ok: boolean; error?: string }[];
}

export interface ResultDetail extends RunResult {
  transcript: string;
  assertions: { id: string; describe: string; pass: boolean }[];
  rubric: { item: string; pass: boolean; why: string }[];
  summary: { narrative: string; outcome: string } | null;
  events: { seq: number; name: string; payload: Record<string, unknown> }[];
}

export interface Stats {
  latestRun: Run | null;
  pendingReviews: number;
  activeLessons: number;
  totalRuns: number;
  byDimension: { dimension: string; total: number; passed: number }[];
  classifications: { classification: string; n: number }[];
}

export interface ScenarioHistory {
  scenario_id: string;
  runs: number;
  passes: number;
  avg_ms: number;
  flaky: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  probes: string;
  patient: string;
  max_turns: number;
  dimension: string;
  rubric: string[];
  assertions: unknown[];
  source: "builtin" | "user";
  enabled: boolean;
}

export interface Review {
  id: string;
  status: "pending" | "approved" | "rejected";
  proposed_rule: string | null;
  dimension: string | null;
  effect_before: number | null;
  effect_after: number | null;
  effect_total: number | null;
  regressions: string[];
  safety_regressed: boolean;
  reviewer_note: string | null;
  scenario_id: string;
  classification: "behavioural" | "structural" | "harness";
  diagnosis: string;
  confidence: string;
  is_real: boolean;
  proposed_code_change: string | null;
  failed_checks: string[];
  result_id: string | null;
  created_at: string;
}

export interface Lesson {
  id: string;
  from_scenario: string;
  dimension: string;
  rule: string;
  active: boolean;
  always_load: boolean;
  created_at: string;
}

export interface GuardrailResult {
  passed: boolean;
  blocked: boolean;
  findings: {
    rule: string;
    severity: string;
    detail: string;
    evidence?: string;
  }[];
}

export interface RunState {
  active: boolean;
  runId: string | null;
  kind: string | null;
  phase: string;
  error: string | null;
}
