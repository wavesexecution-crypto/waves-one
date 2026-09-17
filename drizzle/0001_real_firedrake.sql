CREATE TABLE "browser_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text,
	"job_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"page" text,
	"actions" integer DEFAULT 0 NOT NULL,
	"screenshots" integer DEFAULT 0 NOT NULL,
	"downloads" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "control_state" (
	"id" text PRIMARY KEY NOT NULL,
	"stopped" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planning' NOT NULL,
	"deadline" text,
	"owner" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"project" text,
	"impact" text,
	"status" text DEFAULT 'investigating' NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"detected" text,
	"agent" text,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'not-connected' NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_ref" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"target" text,
	"goal_id" text,
	"status" text DEFAULT 'unread' NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" text NOT NULL,
	"depends_on" text NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_pk" PRIMARY KEY("task_id","depends_on")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text,
	"project_id" text,
	"title" text NOT NULL,
	"owner" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" text DEFAULT 'Medium' NOT NULL,
	"deadline" text,
	"approval_required" boolean DEFAULT false NOT NULL,
	"output" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_tasks_id_fk" FOREIGN KEY ("depends_on") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_sessions_device_idx" ON "browser_sessions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "goals_status_idx" ON "goals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "goals_project_idx" ON "goals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "integrations_kind_status_idx" ON "integration_connections" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "notifications_status_created_idx" ON "notifications" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_goal_status_idx" ON "tasks" USING btree ("goal_id","status");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "approvals_goal_idx" ON "approvals" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "audit_approval_idx" ON "audit_events" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "devices_current_job_idx" ON "devices" USING btree ("current_job_id");--> statement-breakpoint
CREATE INDEX "jobs_device_idx" ON "jobs" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "jobs_goal_idx" ON "jobs" USING btree ("goal_id");