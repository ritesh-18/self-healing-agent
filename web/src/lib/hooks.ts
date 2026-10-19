import { useCallback, useEffect, useState } from "react";

/**
 * Loads data and re-loads on demand.
 *
 * `poll` exists because a run takes minutes and the dashboard has to show
 * progress without the user refreshing. Polling rather than websockets keeps
 * the server stateless, which matters more here than the latency does.
 */
export function useFetch<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
  pollMs?: number,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await fn());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void load();
    if (!pollMs) return;
    const t = setInterval(() => void load(), pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);

  return { data, error, loading, reload: load };
}

export const ms = (n: number | null | undefined) =>
  n == null ? "—" : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;

export const when = (iso: string) => new Date(iso).toLocaleString();
