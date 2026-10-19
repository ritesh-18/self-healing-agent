import { Pool, type PoolClient } from "pg";

/**
 * The Postgres connection.
 *
 * One pool for the process. The dashboard, the API and the CLI all share it,
 * so a run triggered from the UI writes through the same path as one started
 * from a terminal - there is no second code path that could disagree about
 * what was recorded.
 */

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;

  pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://medai:medai@localhost:5434/medai",
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // A pool error with no listener crashes the process. The dashboard should
  // survive a database blip and report it instead.
  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });

  return pool;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(sql, params);
  return res.rows as T[];
}

export async function one<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

/**
 * Runs a function inside a transaction.
 *
 * Used wherever a write spans tables - saving a run writes results, events and
 * findings together, and a half-written run would show in the dashboard as a
 * scenario with no event log.
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function isReachable(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
