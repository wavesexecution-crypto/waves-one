import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './db-schema';

// Neon PostgreSQL connection for the WAVES ONE control plane.
//
// - Application traffic uses the POOLED connection (DATABASE_URL /
//   POSTGRES_URL, hostname contains `-pooler`, PgBouncer transaction mode).
//   This is the correct choice for the Vercel serverless runtime where many
//   concurrent invocations share the pool.
// - Schema migrations (drizzle-kit) use the DIRECT connection
//   (DATABASE_URL_UNPOOLED). See drizzle.config.ts. Never migrate over the
//   pooled URL.
//
// Never import this module (or anything that imports it) from a client
// component: DATABASE_URL must never reach the browser. The browser talks
// only to the WAVES ONE /api routes, which run server-side.

type Db = NodePgDatabase<typeof schema>;

declare global {
  var __wavesPgPool: Pool | undefined;
  var __wavesDb: Db | undefined;
}

function assertServer(): void {
  if (typeof window !== 'undefined') {
    throw new Error('Database access is server-only. DATABASE_URL must never reach the browser.');
  }
}

export function pooledConnectionString(): string {
  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Configure the Neon connection via Vercel environment variables (Development / Preview / Production).',
    );
  }
  return url;
}

function pool(): Pool {
  assertServer();
  if (!globalThis.__wavesPgPool) {
    globalThis.__wavesPgPool = new Pool({
      connectionString: pooledConnectionString(),
      // Serverless-friendly: small per-instance pool; Neon PgBouncer
      // multiplexes across Vercel invocations.
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    globalThis.__wavesPgPool.on('error', () => {
      // A broken idle client must not crash the server; the next query
      // opens a fresh connection.
    });
  }
  return globalThis.__wavesPgPool;
}

export function db(): Db {
  assertServer();
  if (!globalThis.__wavesDb) {
    globalThis.__wavesDb = drizzle(pool(), { schema });
  }
  return globalThis.__wavesDb;
}

// Modules that bind the db handle (e.g. store-db) register here so a reset
// also drops their cached bindings — otherwise they would keep querying a
// closed pool.
const resetListeners = new Set<() => void>();

export function onDbReset(fn: () => void): void {
  resetListeners.add(fn);
}

// Test/maintenance hook: drop cached clients (e.g. persistence-across-
// restart tests that must prove state survives fresh connections).
export function resetDbClients(): void {
  const p = globalThis.__wavesPgPool;
  globalThis.__wavesPgPool = undefined;
  globalThis.__wavesDb = undefined;
  for (const fn of resetListeners) {
    try {
      fn();
    } catch {
      // Reset hooks must never fail the reset itself.
    }
  }
  if (p) void p.end().catch(() => undefined);
}
