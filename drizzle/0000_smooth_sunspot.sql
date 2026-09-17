CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"reason" text NOT NULL,
	"goal_id" text,
	"idempotency_key" text,
	"status" text NOT NULL,
	"created_by" text DEFAULT 'Amey' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"note" text,
	"job_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts_meta" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"agent" text NOT NULL,
	"machine" text NOT NULL,
	"user_auth" text NOT NULL,
	"application" text,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"command" text,
	"permission" text NOT NULL,
	"approval_id" text,
	"result" text NOT NULL,
	"error" text,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"machine" text NOT NULL,
	"agent_version" text DEFAULT 'unknown' NOT NULL,
	"paired" boolean DEFAULT false NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credential_rotated_at" timestamp with time zone,
	"last_heartbeat" timestamp with time zone,
	"current_job_id" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_telemetry" jsonb
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"job_id" text,
	"approval_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"device_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"capability" text NOT NULL,
	"risk" text NOT NULL,
	"approval_id" text,
	"goal_id" text,
	"idempotency_key" text,
	"requested_by" text DEFAULT 'Amey' NOT NULL,
	"device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"authorized_at" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"capabilities" jsonb NOT NULL,
	"roots" jsonb NOT NULL,
	"domains" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_windows" (
	"key" text NOT NULL,
	"window_start" bigint NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_windows_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_idempotency_idx" ON "approvals" USING btree ("idempotency_key") WHERE "approvals"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "artifacts_created_idx" ON "artifacts_meta" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_ts_idx" ON "audit_events" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_events" USING btree ("target");--> statement-breakpoint
CREATE INDEX "job_attempts_job_idx" ON "job_attempts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_status_created_idx" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "jobs_expires_idx" ON "jobs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "jobs_approval_idx" ON "jobs" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_approval_single_use_idx" ON "jobs" USING btree ("approval_id") WHERE "jobs"."approval_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_idx" ON "jobs" USING btree ("idempotency_key") WHERE "jobs"."idempotency_key" is not null;