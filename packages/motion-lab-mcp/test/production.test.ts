/**
 * QUARANTINED — not executed by any runner (vitest include covers only
 * packages/motion/test/**; MCP `test` script runs flow.mjs + backend.mjs).
 * It imports modules that do not exist (visual-states, artifact-store,
 * concurrency, security, audit, orb-morph) and APIs that do not match
 * current sources. Do not cite it as coverage. Either rewrite it against
 * the real backend barrel or delete it.
 *
 * Comprehensive production tests for Motion Lab infrastructure.
 *
 * Tests all major systems:
 * - Project creation and management
 * - Export generation and tracking
 * - AI router provider routing
 * - Visual state transitions
 * - Artifact storage
 * - Concurrency control and supersession
 * - Security validation
 * - Observability and audit
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { seedDefaults, closeDb, db } from "../src/db.js";
import { createProject, getProject, listProjects, updateProject, deleteProject } from "../src/projects.js";
import { createExport, getExport, listExports, getRevisionExports } from "../src/export-system.js";
import { createAIRouter, getProviderForTask, setTaskRouting } from "../src/ai-router.js";
import { mapIntentToState, getValidTransitions, validateTransition } from "../src/visual-states.js";
import { ArtifactStore, write, list } from "../src/artifact-store.js";
import { startGeneration, isSuperseded } from "../src/concurrency.js";
import { validateUpload, validateDuration, sanitizeFilename, SecurityError } from "../src/security.js";
import { logger } from "../src/observability.js";
import { recordAudit, queryAudits } from "../src/audit.js";
import { createMorphSequence, calculateMorphPath, OrbState } from "../src/orb-morph.js";
import { registerVoiceover, listVoiceovers } from "../src/voiceover.js";
import { buildStory, validateStory, withModelInterpretation } from "../src/story.js";
import { planStory } from "../src/planner.js";
import { publishRevision, getRevision, currentRev, RevisionConflict } from "../src/revisions.js";
import { enqueue, getJob, claimNext, complete, fail, recoverStale } from "../src/jobs.js";
import { createWorker } from "../src/worker.js";
import { defaultHandlers } from "../src/orchestrator.js";
import { renderRevision, createRenderHandler, failFast } from "../src/render.js";
import { openDb, closeDb } from "../src/db.js";
import { createFromVoiceover } from "../src/pipeline.js";

describe("Production Infrastructure Tests", () => {
  let dbInstance: DatabaseSync;
  let artifactsDir: string;

  beforeEach(() => {
    const dbPath = `test-${randomUUID()}.db`;
    dbInstance = new DatabaseSync(dbPath);
    seedDefaults(dbInstance);
    artifactsDir = `test-artifacts-${randomUUID()}`;
  });

  afterEach(() => {
    closeDb({ raw: dbInstance, path: "" });
  });

  it("creates and manages projects", () => {
    const project = createProject(dbInstance, {
      name: "Motion Lab Production",
      description: "Production system test"
    });

    expect(project.id).toMatch(/^proj-/);
    expect(project.name).toBe("Motion Lab Production");
    expect(project.current_revision).toBe(0);

    const fetched = getProject(dbInstance, project.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.description).toBe("Production system test");

    const updated = updateProject(dbInstance, project.id, {
      name: "Updated Motion Lab Production",
      currentRevision: 3
    });
    expect(updated.name).toBe("Updated Motion Lab Production");
    expect(updated.current_revision).toBe(3);
  });

  it("generates and tracks exports", () => {
    const exportRecord = createExport(dbInstance, {
      projectId: "project_default",
      revision: 5,
      format: "mp4",
      orientation: "vertical",
      artifactPath: "exports/final.mp4",
      bytes: 25 * 1024 * 1024,
      durationMs: 45000
    });

    expect(exportRecord.id).toMatch(/^export-/);
    expect(exportRecord.width).toBe(1080);
    expect(exportRecord.height).toBe(1920);
    expect(exportRecord.revision).toBe(5);
    expect(exportRecord.format).toBe("mp4");

    const fetched = getExport(dbInstance, exportRecord.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.bytes).toBe(25 * 1024 * 1024);
  });

  it("handles AI provider routing", () => {
    const configs = [
      { provider: "openai", apiKey: "sk-test", model: "gpt-4-turbo" },
      { provider: "anthropic", apiKey: "sk-test", model: "claude-3-sonnet" },
      { provider: "gemini", apiKey: "sk-test", model: "gemini-1.5-pro" }
    ];

    const router = createAIRouter(configs, "openai");
    router.setTaskRouting("transcription", "openai", "whisper-1");
    router.setTaskRouting("story-analysis", "anthropic", "claude-3-opus");
    router.setTaskRouting("visual-planning", "gemini", "gemini-1.5-flash");
    router.setTaskRouting("copy-generation", "openai", "gpt-4-turbo");
    router.setTaskRouting("motion-parameters", "gemini", "gemini-1.5-flash");

    const transcriptionConfig = router.getProviderForTask("transcription");
    expect(transcriptionConfig.provider).toBe("openai");
    expect(transcriptionConfig.model).toBe("whisper-1");

    const visualConfig = router.getProviderForTask("visual-planning");
    expect(visualConfig.provider).toBe("gemini");
  });

  it("manages visual state transitions", () => {
    // Test intent mapping
    expect(mapIntentToState("discover")).toBe("search");
    expect(mapIntentToState("connect")).toBe("network");
    expect(mapIntentToState("customer")).toBe("crm");
    expect(mapIntentToState("automate")).toBe("workflow");
    expect(mapIntentToState("execute")).toBe("pipeline");
    expect(mapIntentToState("data")).toBe("data");
    expect(mapIntentToState("system")).toBe("orb");
    expect(mapIntentToState("scale")).toBe("network");
    expect(mapIntentToState("result")).toBe("milestones");
    expect(mapIntentToState("finale")).toBe("title");
    expect(mapIntentToState("unknown-intent")).toBe("orb");

    // Test valid transitions
    const orbTransitions = getValidTransitions("orb");
    expect(orbTransitions).toContain("search");
    expect(orbTransitions).toContain("crm");
    expect(orbTransitions).toContain("notebook");
    expect(orbTransitions).toContain("workflow");

    const searchTransitions = getValidTransitions("search");
    expect(searchTransitions).toContain("orb");

    // Test transition validation
    expect(validateTransition("orb", "search")).toBe(true);
    expect(validateTransition("orb", "crm")).toBe(true);
    expect(validateTransition("crm", "notebook")).toBe(true);
    expect(validateTransition("unknown", "search")).toBe(false);
  });

  it("handles artifact storage", () => {
    const store = new ArtifactStore({ basePath: artifactsDir });
    const projectId = "project_default";

    // Write render artifact
    const renderArtifact = write(dbInstance, {
      projectId,
      kind: "render",
      data: JSON.stringify({ test: true }),
      extension: "json"
    });

    expect(renderArtifact.id).toMatch(/^artifact-/);
    expect(renderArtifact.projectId).toBe(projectId);
    expect(renderArtifact.kind).toBe("render");

    // Write export artifact
    const exportArtifact = write(dbInstance, {
      projectId,
      kind: "export",
      data: Buffer.from("video bytes"),
      extension: "mp4"
    });

    expect(exportArtifact.kind).toBe("export");

    // List artifacts
    const artifacts = list(dbInstance, projectId);
    expect(artifacts.length).toBe(2);
  });

  it("manages generation concurrency", () => {
    const projectId = "project_default";

    const genA = startGeneration(dbInstance, projectId);
    expect(genA.generationId).toMatch(/^gen-/);
    expect(genA.projectId).toBe(projectId);
    expect(genA.startRevision).toBe(0);

    // Generation is not superseded initially
    expect(isSuperseded(dbInstance, genA)).toBe(false);
  });

  it("validates security constraints", () => {
    // Upload validation
    expect(() => validateUpload("audio.mp3", 1024, "audio/mpeg")).not.toThrow();
    expect(() => validateUpload("audio.mp3", 60_000_000, "audio/mpeg")).toThrow(SecurityError);

    // Duration validation
    expect(() => validateDuration(30000)).not.toThrow();
    expect(() => validateDuration(360_000)).toThrow(SecurityError);

    // Filename sanitization
    expect(sanitizeFilename("../../evil.txt")).not.toContain("..");
    expect(sanitizeFilename("test file.mp3")).toBe("test_file.mp3");
  });

  it("produces observability logs", () => {
    const logs: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((data: string) => {
      logs.push(data.toString());
      return true;
    }) as any;

    const log = logger.child({ requestId: "req-123", projectId: "proj-1" });
    log.info("Test operation", { status: "success" });

    process.stderr.write = originalWrite;

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain("req-123");
    expect(logs[0]).toContain("proj-1");
  });

  it("records and queries audits", () => {
    const audit = recordAudit(dbInstance, {
      actor: "system",
      projectId: "project_default",
      action: "publish_revision",
      status: "success",
      revision: 1,
      metadata: { ops_count: 15 }
    });

    expect(audit.id).toMatch(/^audit-/);
    expect(audit.action).toBe("publish_revision");

    const audits = queryAudits(dbInstance, {
      projectId: "project_default",
      action: "publish_revision"
    });

    expect(audits.length).toBe(1);
    expect(audits[0].revision).toBe(1);
  });

  it("generates orb morph animations", () => {
    const fromState: OrbState = { kind: "orb" };
    const toState: OrbState = { kind: "search" };

    const morphPath = calculateMorphPath(fromState, toState);
    expect(morphPath.length).toBeGreaterThan(0);

    const morphAnimations = createMorphSequence(fromState, toState, 0, 800);
    expect(morphAnimations.length).toBeGreaterThan(0);
  });

  it("completes full golden path: voiceover → story → plan → publish → render", async () => {
    // This test exercises the complete pipeline using backend functions directly
    // It verifies all systems work together without needing the dev server
    
    const dbInstance = new DatabaseSync(`golden-path-${randomUUID()}.db`);
    seedDefaults(dbInstance);
    
    try {
      const projectId = "project_default";
      const labDir = `test-lab-${randomUUID()}`;
      const artifactsDir = `test-artifacts-${randomUUID()}`;
      
      // 1. Register a voiceover (simulated audio)
      const voiceoverId = `vo-test-${Date.now().toString(36)}`;
      const mockAudio = Buffer.from("mock-audio-data");
      const voiceover = registerVoiceover(labDir, "test.mp3", mockAudio, 20000);
      expect(voiceover.id).toBeDefined();
      expect(voiceover.durationMs).toBe(20000);
      
      // 2. Build story from transcript (deterministic, no API key needed)
      const transcript = "WAVES Motion Lab solves the problem of manual animation. CRM connects to your leads. Notebook understands context. Workflow automates outreach. Orb transforms into intelligence.";
      const story = buildStory(transcript, 20000);
      
      expect(story.beats.length).toBeGreaterThan(0);
      expect(story.durationMs).toBe(20000);
      expect(story.interpretation).toBe("deterministic");
      
      // Verify story validation passes
      const storyValidation = validateStory(story);
      expect(storyValidation.ok).toBe(true);
      
      // 3. Plan animation from story beats
      const planned = planStory(story.beats, "vertical");
      expect(planned.ops.length).toBeGreaterThan(0);
      expect(planned.validation.ok).toBe(true);
      expect(planned.overlaps.length).toBe(0);
      
      // 4. Publish as immutable revision
      const revision = publishRevision(dbInstance, projectId, planned.ops, {
        message: "from voiceover test",
        actor: "test"
      });
      expect(revision.rev).toBe(1);
      expect(revision.id).toMatch(/^rev-/);
      
      // 5. Verify revision is stored and retrievable
      const fetchedRevision = getRevision(dbInstance, projectId, 1);
      expect(fetchedRevision).not.toBeNull();
      expect(fetchedRevision?.ops.length).toBe(planned.ops.length);
      
      // 6. Enqueue render job
      const { job } = enqueue(dbInstance, {
        projectId,
        type: "render",
        payload: { projectId, rev: revision.rev, format: "mp4" },
        maxAttempts: 3,
        idempotencyKey: `render:${projectId}:${revision.rev}:mp4`
      });
      expect(job.status).toBe("QUEUED");
      
      // 7. Run worker to process render job
      const worker = createWorker(dbInstance, { 
        ...defaultHandlers(), 
        render: createRenderHandler(artifactsDir) 
      });
      
      let currentJob = getJob(dbInstance, job.id) ?? job;
      for (let guard = 0; guard < 50; guard++) {
        if (currentJob.status !== "QUEUED" && currentJob.status !== "RUNNING") break;
        await worker.tick();
        currentJob = getJob(dbInstance, job.id) ?? currentJob;
      }
      
      // 8. Verify render completed successfully
      expect(currentJob.status).toBe("COMPLETED");
      expect(currentJob.result).toBeDefined();
      
      const result = currentJob.result as { artifactId?: string; artifact?: string };
      expect(result.artifactId).toBeDefined();
      expect(result.artifact).toBeDefined();
      
      // 9. Verify render manifest artifact exists
      const manifestPath = result.artifact;
      expect(manifestPath).toContain("render-rev-1.json");
      
      // 10. Verify revision immutability (newer generation never overwritten by older)
      // Try to publish with stale expected revision - should throw conflict
      await expect(
        publishRevision(dbInstance, projectId, planned.ops, {
          expectedRev: 0, // stale - current is 1
          message: "stale attempt",
          actor: "test"
        })
      ).rejects.toThrow(RevisionConflict);
      
      // Verify current revision is still 1
      const current = currentRev(dbInstance, projectId);
      expect(current).toBe(1);
      
      console.log("✓ Golden path test passed: voiceover → story → plan → publish → render");
      
    } finally {
      closeDb({ raw: dbInstance, path: "" });
    }
  });

  it("handles concurrent generation supersession correctly", async () => {
    const dbInstance = new DatabaseSync(`concurrent-${randomUUID()}.db`);
    seedDefaults(dbInstance);
    
    try {
      const projectId = "project_default";
      
      // Start generation A
      const genA = await import("../src/concurrency.js").then(m => m.startGeneration(dbInstance, projectId));
      expect(genA.generationId).toMatch(/^gen-/);
      
      // Start generation B (newer)
      const genB = await import("../src/concurrency.js").then(m => m.startGeneration(dbInstance, projectId));
      expect(genB.generationId).toMatch(/^gen-/);
      expect(genB.generationId).not.toBe(genA.generationId);
      
      // Generation A should now be superseded
      const { isSuperseded } = await import("../src/concurrency.js");
      expect(isSuperseded(dbInstance, genA)).toBe(true);
      expect(isSuperseded(dbInstance, genB)).toBe(false);
      
      // Complete B's work - publish a revision
      const ops = [{ id: "op-1", kind: "animate", target: "#test", properties: { opacity: [0, 1] } }];
      const revision = publishRevision(dbInstance, projectId, ops as any, { message: "gen B", actor: "test" });
      expect(revision.rev).toBe(1);
      
      // Now A tries to publish with expectedRev: 0 (stale) - should fail
      await expect(
        publishRevision(dbInstance, projectId, ops as any, {
          expectedRev: 0,
          message: "gen A stale",
          actor: "test"
        })
      ).rejects.toThrow(RevisionConflict);
      
      console.log("✓ Concurrent generation supersession test passed");
      
    } finally {
      closeDb({ raw: dbInstance, path: "" });
    }
  });

  it("recovers stalled render jobs after worker crash", async () => {
    const dbInstance = new DatabaseSync(`recovery-${randomUUID()}.db`);
    seedDefaults(dbInstance);
    
    try {
      const projectId = "project_default";
      const artifactsDir = `test-artifacts-${randomUUID()}`;
      
      // Publish a revision
      const ops = [{ id: "op-1", kind: "animate", target: "#test", properties: { opacity: [0, 1] } }];
      const revision = publishRevision(dbInstance, projectId, ops as any, { message: "test", actor: "test" });
      
      // Enqueue render job
      const { job } = enqueue(dbInstance, {
        projectId,
        type: "render",
        payload: { projectId, rev: revision.rev, format: "mp4" },
        maxAttempts: 3,
        idempotencyKey: `render:${projectId}:${revision.rev}:mp4`
      });
      
      // Simulate worker crash: claim job but don't complete
      const workerId = "crashed-worker";
      const claimed = claimNext(dbInstance, workerId, ["render"]);
      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe("RUNNING");
      expect(claimed?.worker_id).toBe(workerId);
      
      // Now simulate recovery after lease expires
      const recovered = recoverStale(dbInstance, 0); // leaseMs = 0 means immediate recovery
      expect(recovered.length).toBe(1);
      expect(recovered[0]).toBe(job.id);
      
      // Job should be back in QUEUED state
      const recoveredJob = getJob(dbInstance, job.id);
      expect(recoveredJob?.status).toBe("QUEUED");
      expect(recoveredJob?.worker_id).toBeNull();
      
      // Now run a new worker to complete it
      const worker = createWorker(dbInstance, { 
        ...defaultHandlers(), 
        render: createRenderHandler(artifactsDir) 
      });
      
      let currentJob = getJob(dbInstance, job.id) ?? recoveredJob;
      for (let guard = 0; guard < 50; guard++) {
        if (currentJob.status !== "QUEUED" && currentJob.status !== "RUNNING") break;
        await worker.tick();
        currentJob = getJob(dbInstance, job.id) ?? currentJob;
      }
      
      // Should complete successfully
      expect(currentJob.status).toBe("COMPLETED");
      
      console.log("✓ Job recovery test passed");
      
    } finally {
      closeDb({ raw: dbInstance, path: "" });
    }
  });

  it("validates 9:16 vertical export orientation", () => {
    const dbInstance = new DatabaseSync(`export-${randomUUID()}.db`);
    seedDefaults(dbInstance);
    
    try {
      // Test vertical (9:16) export
      const verticalExport = createExport(dbInstance, {
        projectId: "project_default",
        revision: 1,
        format: "mp4",
        orientation: "vertical",
        artifactPath: "exports/vertical.mp4",
        bytes: 1024 * 1024,
        durationMs: 30000
      });
      
      expect(verticalExport.width).toBe(1080);
      expect(verticalExport.height).toBe(1920);
      expect(verticalExport.orientation).toBe("vertical");
      expect(verticalExport.fps).toBe(60);
      
      // Test landscape (16:9) export
      const landscapeExport = createExport(dbInstance, {
        projectId: "project_default",
        revision: 1,
        format: "webm",
        orientation: "landscape",
        artifactPath: "exports/landscape.webm",
        bytes: 2048 * 1024,
        durationMs: 30000
      });
      
      expect(landscapeExport.width).toBe(1920);
      expect(landscapeExport.height).toBe(1080);
      expect(landscapeExport.orientation).toBe("landscape");
      expect(landscapeExport.fps).toBe(60);
      
      console.log("✓ 9:16 and 16:9 export orientation test passed");
      
    } finally {
      closeDb({ raw: dbInstance, path: "" });
    }
  });

  it("validates AI provider configuration without credentials", async () => {
    // Test that providers report not-configured when no API keys
    const configs = [
      { provider: "openai", apiKey: "", model: "gpt-4o" },
      { provider: "anthropic", apiKey: "", model: "claude-sonnet-4-6" },
      { provider: "gemini", apiKey: "", model: "gemini-2.0-flash" }
    ];
    
    // Should not throw when creating router with empty keys
    const router = createAIRouter(configs, "openai");
    expect(router).toBeDefined();
    
    // Health check should report not configured
    const health = await router.healthCheck();
    expect(health.get("openai")).toBe(false);
    expect(health.get("anthropic")).toBe(false);
    expect(health.get("gemini")).toBe(false);
    
    // Provider status should show not configured
    const status = getProviderStatus({});
    expect(status.get("openai")?.configured).toBe(false);
    expect(status.get("anthropic")?.configured).toBe(false);
    expect(status.get("gemini")?.configured).toBe(false);
    
    console.log("✓ AI provider configuration test passed");
  });
});
