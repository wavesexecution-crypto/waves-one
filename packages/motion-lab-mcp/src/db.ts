/**
 * Motion Lab database — durable structured state.
 *
 * `node:sqlite` (built into Node 22+, zero dependencies) is the store:
 * single file at `<lab>/.motion/motion.db`, WAL-capable, file-locked so a
 * future second process can open the same database. Binary artifacts stay
 * in `.motion/` files behind the ArtifactStore abstraction (later phase);
 * this module owns structured state only.
 *
 * Phase 1 tables: organizations, users, projects (schema boundary; a single
 * default org/user/project is seeded, no auth system), jobs, job_events.
 * Later phases add voiceovers, stories, revisions, assets, techniques,
 * exports, validation/provider runs, and audit tables via migrations.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

type SqliteModule = typeof import("node:sqlite");

let cached: SqliteModule | null = null;

/**
 * Load the SQLite driver at runtime. The specifier is constructed (not a
 * string literal) so bundlers cannot rewrite `node:sqlite` into something
 * Node cannot resolve; the type import above is erased at compile time.
 */
async function loadSqlite(): Promise<SqliteModule> {
  if (!cached) {
    const specifier = "node:" + "sqlite";
    cached = (await import(specifier)) as SqliteModule;
  }
  return cached;
}

export const SCHEMA_VERSION = 4;

export interface Db {
  raw: DatabaseSync;
  path: string;
}

const MIGRATIONS: string[][] = [
  [
  `CREATE TABLE IF NOT EXISTS schema_version (
     version INTEGER PRIMARY KEY,
     applied_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS organizations (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL REFERENCES organizations(id),
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS projects (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL REFERENCES organizations(id),
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS jobs (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id),
     type TEXT NOT NULL,
     status TEXT NOT NULL,
     priority INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL DEFAULT '{}',
     result TEXT,
     error TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     max_attempts INTEGER NOT NULL DEFAULT 1,
     idempotency_key TEXT UNIQUE,
     parent_job_id TEXT REFERENCES jobs(id),
     worker_id TEXT,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     completed_at INTEGER,
     updated_at INTEGER NOT NULL,
     heartbeat_at INTEGER,
     run_after INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_after, priority DESC, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS job_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL REFERENCES jobs(id),
     event TEXT NOT NULL,
     detail TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, id)`
  ],
  [
    `CREATE TABLE IF NOT EXISTS voiceovers (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL REFERENCES projects(id),
       file TEXT NOT NULL,
       mime TEXT NOT NULL,
       bytes INTEGER NOT NULL,
       duration_ms INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS transcripts (
       id TEXT PRIMARY KEY,
       voiceover_id TEXT NOT NULL REFERENCES voiceovers(id),
       text TEXT NOT NULL DEFAULT '',
       segments TEXT NOT NULL DEFAULT '[]',
       provider TEXT NOT NULL DEFAULT 'none',
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS stories (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL REFERENCES projects(id),
       voiceover_id TEXT REFERENCES voiceovers(id),
       brief TEXT NOT NULL DEFAULT '',
       beats TEXT NOT NULL DEFAULT '[]',
       interpretation TEXT NOT NULL DEFAULT 'deterministic',
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS provider_runs (
       id TEXT PRIMARY KEY,
       provider TEXT NOT NULL,
       model TEXT NOT NULL,
       task TEXT NOT NULL,
       request_id TEXT,
       duration_ms INTEGER NOT NULL DEFAULT 0,
       status TEXT NOT NULL,
       error TEXT,
       tokens_json TEXT,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_provider_runs_provider ON provider_runs(provider, created_at)`
  ],
  [
    `CREATE TABLE IF NOT EXISTS revisions (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL REFERENCES projects(id),
       rev INTEGER NOT NULL,
       ops TEXT NOT NULL DEFAULT '[]',
       parent_rev INTEGER,
       message TEXT NOT NULL DEFAULT '',
       actor TEXT NOT NULL DEFAULT 'mcp',
       created_at INTEGER NOT NULL,
       UNIQUE(project_id, rev)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_revisions_project ON revisions(project_id, rev)`
  ],
  [
    `CREATE TABLE IF NOT EXISTS assets (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL REFERENCES projects(id),
       kind TEXT NOT NULL,
       label TEXT NOT NULL,
       path TEXT,
       bytes INTEGER NOT NULL DEFAULT 0,
       meta TEXT NOT NULL DEFAULT '{}',
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS artifacts (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL REFERENCES projects(id),
       job_id TEXT REFERENCES jobs(id),
       rev INTEGER,
       kind TEXT NOT NULL,
       path TEXT NOT NULL,
       meta TEXT NOT NULL DEFAULT '{}',
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id)`,
    `CREATE TABLE IF NOT EXISTS techniques (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL REFERENCES projects(id),
       source_kind TEXT NOT NULL,
       source_ref TEXT NOT NULL,
       license TEXT NOT NULL,
       what TEXT NOT NULL,
       adapted_to TEXT NOT NULL,
       compatibility TEXT NOT NULL,
       ledger_id TEXT,
       created_at INTEGER NOT NULL,
       UNIQUE(project_id, source_ref, adapted_to)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_techniques_project ON techniques(project_id, created_at)`
  ]
];

/** Open (creating) the lab database and run pending migrations. */
export async function openDb(labDir: string): Promise<Db> {
  const { DatabaseSync: Ctor } = await loadSqlite();
  mkdirSync(join(labDir, ".motion"), { recursive: true });
  const path = join(labDir, ".motion", "motion.db");
  const raw = new Ctor(path);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("PRAGMA foreign_keys = ON");
  const applied = (() => {
    try {
      return raw.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>;
    } catch {
      return [];
    }
  })();
  const have = new Set(applied.map((row) => row.version));
  for (let version = 1; version <= SCHEMA_VERSION; version++) {
    if (have.has(version)) continue;
    raw.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of MIGRATIONS[version - 1]) raw.exec(statement);
      raw.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(version, Date.now());
      raw.exec("COMMIT");
    } catch (error) {
      try {
        raw.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  }
  seedDefaults(raw);
  return { raw, path };
}

/** Schema boundary seeds: one org, one local user, one default project. No auth. */
export function seedDefaults(raw: DatabaseSync): void {
  const now = Date.now();
  raw.prepare("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES ('org_default', 'Default organization', ?)").run(now);
  raw.prepare("INSERT OR IGNORE INTO users (id, org_id, name, created_at) VALUES ('user_local', 'org_default', 'Local operator', ?)").run(now);
  raw.prepare(
    "INSERT OR IGNORE INTO projects (id, org_id, name, created_at, updated_at) VALUES ('project_default', 'org_default', 'Default project', ?, ?)"
  ).run(now, now);
}

export function closeDb(db: Db): void {
  db.raw.close();
}

/** Resolve the database path without opening (for tooling/tests). */
export function dbPathForLabDir(labDir: string): string {
  return join(labDir, ".motion", "motion.db");
}
