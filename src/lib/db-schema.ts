import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { isNotNull } from 'drizzle-orm';

// WAVES ONE control-plane schema (protocol v2 domain model, unchanged).
// Append-only tables (audit_events, job_attempts, artifacts_meta) have no
// UPDATE/DELETE code paths by convention. Concurrency-critical transitions
// use status-checked single statements; single-use approvals additionally
// carry a partial unique index so replays fail at the database level.

export const devices = pgTable(
  'devices',
  {
    deviceId: text('device_id').primaryKey(),
    secretHash: text('secret_hash').notNull(),
    machine: text('machine').notNull(),
    agentVersion: text('agent_version').notNull().default('unknown'),
    paired: boolean('paired').notNull().default(false),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    credentialRotatedAt: timestamp('credential_rotated_at', { withTimezone: true }),
    lastHeartbeat: timestamp('last_heartbeat', { withTimezone: true }),
    currentJobId: text('current_job_id'),
    status: text('status').notNull().default('idle'),
    lastTelemetry: jsonb('last_telemetry'),
  },
  table => [index('devices_current_job_idx').on(table.currentJobId)],
);

export const pairingCodes = pgTable('pairing_codes', {
  code: text('code').primaryKey(),
  deviceId: text('device_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    params: jsonb('params').notNull(),
    capability: text('capability').notNull(),
    risk: text('risk').notNull(),
    approvalId: text('approval_id'),
    goalId: text('goal_id'),
    idempotencyKey: text('idempotency_key'),
    requestedBy: text('requested_by').notNull().default('Amey'),
    deviceId: text('device_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    attempts: jsonb('attempts').notNull().default([]),
    result: jsonb('result'),
  },
  table => [
    index('jobs_status_created_idx').on(table.status, table.createdAt),
    index('jobs_expires_idx').on(table.expiresAt),
    index('jobs_approval_idx').on(table.approvalId),
    index('jobs_device_idx').on(table.deviceId),
    index('jobs_goal_idx').on(table.goalId),
    // Single-use approvals, enforced by the database itself: an approval id
    // can appear on at most one job row, so replays fail even under races.
    uniqueIndex('jobs_approval_single_use_idx').on(table.approvalId).where(isNotNull(table.approvalId)),
    uniqueIndex('jobs_idempotency_idx').on(table.idempotencyKey).where(isNotNull(table.idempotencyKey)),
  ],
);

export const jobAttempts = pgTable(
  'job_attempts',
  {
    id: serial('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    outcome: text('outcome'),
  },
  table => [index('job_attempts_job_idx').on(table.jobId)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    kind: text('kind').notNull(),
    params: jsonb('params').notNull(),
    reason: text('reason').notNull(),
    goalId: text('goal_id'),
    idempotencyKey: text('idempotency_key'),
    status: text('status').notNull(),
    createdBy: text('created_by').notNull().default('Amey'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    note: text('note'),
    jobIds: jsonb('job_ids').notNull().default([]),
  },
  table => [
    index('approvals_status_idx').on(table.status),
    index('approvals_goal_idx').on(table.goalId),
    uniqueIndex('approvals_idempotency_idx').on(table.idempotencyKey).where(isNotNull(table.idempotencyKey)),
  ],
);

// Single-row policy document (id = 'default'). Versioned for future
// multi-policy use; updates replace the row.
export const policies = pgTable('policies', {
  id: text('id').primaryKey(),
  version: integer('version').notNull(),
  capabilities: jsonb('capabilities').notNull(),
  roots: jsonb('roots').notNull(),
  domains: jsonb('domains').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  jobId: text('job_id'),
  approvalId: text('approval_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Append-only audit log. No UPDATE or DELETE statements target this table
// anywhere in the codebase.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    agent: text('agent').notNull(),
    machine: text('machine').notNull(),
    userAuth: text('user_auth').notNull(),
    application: text('application'),
    action: text('action').notNull(),
    target: text('target').notNull(),
    command: text('command'),
    permission: text('permission').notNull(),
    approvalId: text('approval_id'),
    result: text('result').notNull(),
    error: text('error'),
    before: jsonb('before'),
    after: jsonb('after'),
  },
  table => [
    index('audit_ts_idx').on(table.ts.desc()),
    index('audit_action_idx').on(table.action),
    index('audit_target_idx').on(table.target),
    index('audit_approval_idx').on(table.approvalId),
  ],
);

export const artifactsMeta = pgTable(
  'artifacts_meta',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id'),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index('artifacts_created_idx').on(table.createdAt.desc())],
);

// Artifact binary payloads. Metadata lives in artifacts_meta; bytes live
// here (Neon, same transaction as the metadata insert) so production has no
// dependency on ephemeral Vercel disk. Size-capped by the control plane.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const artifactBlobs = pgTable('artifact_blobs', {
  id: text('id').primaryKey(),
  data: bytea('data').notNull(),
});

// Fixed-window rate counters (server-side, shared across instances).
export const rateWindows = pgTable(
  'rate_windows',
  {
    key: text('key').notNull(),
    windowStart: bigint('window_start', { mode: 'number' }).notNull(),
    count: integer('count').notNull().default(1),
  },
  table => [primaryKey({ columns: [table.key, table.windowStart] })],
);

// Global control-plane flags (single row, id = 'default'). Replaces
// control.json in database mode so emergency stop/resume is consistent
// across Vercel instances. Updated with conditional writes only.
export const controlState = pgTable('control_state', {
  id: text('id').primaryKey(),
  stopped: boolean('stopped').notNull().default(false),
  paused: boolean('paused').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Users and authentication sessions (foundation). Enforcement today remains
// the owner token (WAVES_OWNER_TOKEN) plus per-device credentials; these
// tables give durable relational identity for the CEO console without
// redesigning auth. Session tokens are stored as hashes only — never raw.
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  role: text('role').notNull().default('owner'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked: boolean('revoked').notNull().default(false),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  table => [index('sessions_user_idx').on(table.userId)],
);

// Projects, goals, tasks, and dependencies (CEO operating state). The
// interactive demo in src/lib/model.ts stays client-side; these tables are
// the durable server-side foundation so goals/projects/tasks can move off
// localStorage without a redesign.
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const goals = pgTable(
  'goals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('planning'),
    deadline: text('deadline'),
    owner: text('owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('goals_status_idx').on(table.status),
    index('goals_project_idx').on(table.projectId),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id').references(() => goals.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    owner: text('owner'),
    status: text('status').notNull().default('queued'),
    priority: text('priority').notNull().default('Medium'),
    deadline: text('deadline'),
    approvalRequired: boolean('approval_required').notNull().default(false),
    output: text('output'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('tasks_goal_status_idx').on(table.goalId, table.status),
    index('tasks_status_idx').on(table.status),
  ],
);

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOn: text('depends_on')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
  },
  table => [primaryKey({ columns: [table.taskId, table.dependsOn] })],
);

// Incidents and notifications (durable CEO-visible operations state).
export const incidents = pgTable(
  'incidents',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    project: text('project'),
    impact: text('impact'),
    status: text('status').notNull().default('investigating'),
    severity: text('severity').notNull().default('warning'),
    detected: text('detected'),
    agent: text('agent'),
    timeline: jsonb('timeline').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index('incidents_status_idx').on(table.status)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    target: text('target'),
    goalId: text('goal_id'),
    status: text('status').notNull().default('unread'),
    severity: text('severity').notNull().default('info'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index('notifications_status_created_idx').on(table.status, table.createdAt.desc())],
);

// Browser session metadata (supervised browsing evidence; page snapshots stay
// in artifact storage, only metadata here).
export const browserSessions = pgTable(
  'browser_sessions',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id'),
    jobId: text('job_id'),
    active: boolean('active').notNull().default(true),
    page: text('page'),
    actions: integer('actions').notNull().default(0),
    screenshots: integer('screenshots').notNull().default(0),
    downloads: integer('downloads').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  table => [index('browser_sessions_device_idx').on(table.deviceId)],
);

// Integration connection metadata (GitHub, Google, Vercel, etc.). Tokens and
// secrets are never stored here — references to the secret manager only.
export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('not-connected'),
    capabilities: jsonb('capabilities').notNull().default([]),
    secretRef: text('secret_ref'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index('integrations_kind_status_idx').on(table.kind, table.status)],
);
