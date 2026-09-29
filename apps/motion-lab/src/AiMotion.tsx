import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AiVideoPlayer from "./AiVideoPlayer";
import {
  deleteGeneration,
  enhancePrompt,
  fetchProviderStatus,
  generateMotion,
  getGeneration,
  listGenerations,
  saveGeneration,
  uploadSource,
  useGeneration,
  AiMotionError
} from "./lib/ai-motion/api";
import {
  COSMOS_MODEL_LABEL,
  DEFAULT_SETTINGS,
  EXAMPLE_PROMPTS,
  PROMPT_MAX,
  RESOLUTIONS,
  capForResolution,
  estimateTokens,
  estimatedDurationMs,
  formatBytes,
  formatClock,
  formatTime,
  isValidFrames,
  clampFrames
} from "./lib/ai-motion/constants";
import type {
  CosmosSettingsInput,
  EnhanceInfo,
  GenerationPhase,
  GenerationRecord,
  MotionMode,
  PromptHistoryEntry,
  ProviderInfo,
  SourceAsset
} from "./lib/ai-motion/types";
import "./ai-motion.css";

const HISTORY_KEY = "waves.ai-motion.prompts";
const PROMPT_HISTORY_MAX = 30;
const SOURCE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "mp4"];
const SOURCE_BYTES_MAX = 25_000_000;

function loadPromptHistory(): PromptHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is PromptHistoryEntry => entry !== null && typeof entry === "object" && typeof (entry as { prompt?: unknown }).prompt === "string")
      .slice(0, PROMPT_HISTORY_MAX);
  } catch {
    return [];
  }
}

function settingsFromRecord(record: GenerationRecord): CosmosSettingsInput {
  const raw = record.settings ?? {};
  const num = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    resolution: typeof raw.resolution === "string" ? raw.resolution : DEFAULT_SETTINGS.resolution,
    numFrames: num(raw.numFrames ?? raw.numOutputFrames, DEFAULT_SETTINGS.numFrames),
    fps: num(raw.fps, DEFAULT_SETTINGS.fps),
    numInferenceSteps: num(raw.numInferenceSteps ?? raw.steps, DEFAULT_SETTINGS.numInferenceSteps),
    guidanceScale: num(raw.guidanceScale, DEFAULT_SETTINGS.guidanceScale),
    flowShift: raw.flowShift === undefined || raw.flowShift === null ? "" : String(raw.flowShift),
    seed: raw.seed === undefined || raw.seed === null ? "" : String(raw.seed)
  };
}

export default function AiMotion() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerId, setProviderId] = useState("cosmos");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [enhanceInfo, setEnhanceInfo] = useState<EnhanceInfo | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [enhancePending, setEnhancePending] = useState<string | null>(null);

  const [mode, setMode] = useState<MotionMode>("image2video");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [settings, setSettings] = useState<CosmosSettingsInput>(DEFAULT_SETTINGS);

  const [source, setSource] = useState<SourceAsset | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const [phase, setPhase] = useState<GenerationPhase>("idle");
  const [phaseLabel, setPhaseLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<GenerationRecord | null>(null);
  const [compare, setCompare] = useState<"result" | "source" | "split">("result");

  const [history, setHistory] = useState<GenerationRecord[]>([]);
  const [promptHistory, setPromptHistory] = useState<PromptHistoryEntry[]>(() => loadPromptHistory());
  const [examplePending, setExamplePending] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const generating = phase === "preparing" || phase === "uploading" || phase === "generating" || phase === "processing";
  const activeProvider = useMemo(() => providers.find((entry) => entry.provider === (providerId === "mock" ? "mock" : "nvidia")) ?? null, [providers, providerId]);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await fetchProviderStatus();
      setProviders(status.providers);
      setEnhanceInfo(status.promptEnhancement ?? null);
      setStatusDetail(null);
      if (!status.providers.some((entry) => entry.provider === "nvidia" && entry.configured)) {
        setStatusDetail("NVIDIA_API_KEY not configured — mock provider available for UI testing.");
      }
    } catch {
      setStatusDetail("Status endpoint unreachable (dev server?).");
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await listGenerations(50));
    } catch {
      /* history panel stays as-is on failure */
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshHistory();
  }, [refreshStatus, refreshHistory]);

  useEffect(() => {
    if (!generating || startedAt === null) return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => window.clearInterval(timer);
  }, [generating, startedAt]);

  useEffect(() => () => {
    if (pendingPreview) URL.revokeObjectURL(pendingPreview);
  }, [pendingPreview]);

  const flashMessage = useCallback((message: string) => {
    setFlash(message);
    window.setTimeout(() => setFlash((current) => (current === message ? null : current)), 6000);
  }, []);

  const persistPromptHistory = useCallback((entry: PromptHistoryEntry) => {
    setPromptHistory((current) => {
      const next = [entry, ...current.filter((item) => item.prompt !== entry.prompt)].slice(0, PROMPT_HISTORY_MAX);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* private mode — history just doesn't persist */
      }
      return next;
    });
  }, []);

  const pickFile = useCallback((file: File | undefined | null) => {
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const isMedia = SOURCE_EXTENSIONS.includes(ext) || file.type.startsWith("image/") || file.type.startsWith("video/");
    if (!isMedia) {
      flashMessage("Source must be an image (PNG, JPEG, WebP, GIF) or an MP4 video.");
      return;
    }
    if (file.size > SOURCE_BYTES_MAX) {
      flashMessage("Source exceeds the 25 MB transport guardrail — use a smaller file.");
      return;
    }
    if (pendingPreview) URL.revokeObjectURL(pendingPreview);
    setPendingFile(file);
    setPendingPreview(URL.createObjectURL(file));
    setSource(null);
  }, [pendingPreview, flashMessage]);

  const removeSource = useCallback(() => {
    if (pendingPreview) URL.revokeObjectURL(pendingPreview);
    setPendingFile(null);
    setPendingPreview(null);
    setSource(null);
  }, [pendingPreview]);

  const setSetting = useCallback(<K extends keyof CosmosSettingsInput>(key: K, value: CosmosSettingsInput[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  const resolutionMeta = useMemo(() => RESOLUTIONS.find((entry) => entry.key === settings.resolution) ?? RESOLUTIONS[0], [settings.resolution]);
  const frameCap = useMemo(() => capForResolution(settings.resolution), [settings.resolution]);
  const framesValid = useMemo(() => isValidFrames(settings.numFrames, frameCap), [settings.numFrames, frameCap]);
  const durationEstimate = useMemo(() => estimatedDurationMs(settings.numFrames, settings.fps), [settings.numFrames, settings.fps]);

  const validationError = useMemo(() => {
    if ((mode === "image2video" || mode === "video2video") && !source && !pendingFile) {
      return mode === "image2video" ? "Upload a source image for Image → Video." : "Upload a source MP4 for Video → Video.";
    }
    if (mode === "text2video" && !prompt.trim()) return "Write a nonempty prompt for Text → Video.";
    if (prompt.length > PROMPT_MAX) return `Prompt exceeds ${PROMPT_MAX} characters.`;
    if (negativePrompt.length > PROMPT_MAX) return `Negative prompt exceeds ${PROMPT_MAX} characters.`;
    if (!framesValid) return `Frame count (num_frames) must be an integer within [25, ${frameCap}] for this tier.`;
    if (!(settings.fps >= 1 && settings.fps <= 60)) return "FPS must be within [1, 60].";
    if (!(settings.numInferenceSteps >= 1 && settings.numInferenceSteps <= 100)) return "Inference steps (num_inference_steps) must be within [1, 100].";
    if (!(settings.guidanceScale >= 1 && settings.guidanceScale <= 7)) return "Guidance scale must be within [1, 7].";
    if (settings.flowShift.trim() && !(Number(settings.flowShift) > 0)) return "Flow shift must be a positive number (or empty for the server default).";
    return null;
  }, [mode, source, pendingFile, prompt, negativePrompt, framesValid, settings, frameCap]);

  const runGenerate = useCallback(async (overrides?: { prompt?: string; negativePrompt?: string; settings?: CosmosSettingsInput; mode?: MotionMode; sourceId?: string }) => {
    const effectivePrompt = overrides?.prompt ?? prompt;
    const effectiveNegative = overrides?.negativePrompt ?? negativePrompt;
    const effectiveSettings = overrides?.settings ?? settings;
    const effectiveMode = overrides?.mode ?? mode;
    if (generating || busy) return;
    setError(null);
    setPhase("preparing");
    setPhaseLabel("PREPARING");
    setStartedAt(Date.now());
    setElapsedMs(0);
    try {
      // Upload first when a fresh file is staged — the uploading phase is real.
      let sourceId = overrides?.sourceId ?? source?.sourceId;
      const staged = pendingFile;
      if ((effectiveMode === "image2video" || effectiveMode === "video2video") && !sourceId && staged) {
        setPhase("uploading");
        setPhaseLabel("UPLOADING SOURCE");
        const uploaded = await uploadSource(staged);
        setSource(uploaded);
        setPendingFile(null);
        if (pendingPreview) URL.revokeObjectURL(pendingPreview);
        setPendingPreview(null);
        sourceId = uploaded.sourceId;
      }
      if (effectiveMode === "image2video" && !sourceId) throw new AiMotionError("invalid_input", "Upload a source image for Image → Video.");
      if (effectiveMode === "video2video" && !sourceId) throw new AiMotionError("invalid_input", "Upload a source MP4 for Video → Video.");
      const trimmedSeed = effectiveSettings.seed.trim();
      const trimmedFlow = effectiveSettings.flowShift.trim();
      const body = await generateMotion({
        mode: effectiveMode,
        prompt: effectivePrompt.trim(),
        ...(effectiveNegative.trim() ? { negativePrompt: effectiveNegative.trim() } : {}),
        settings: {
          resolution: effectiveSettings.resolution,
          numFrames: Math.round(effectiveSettings.numFrames),
          fps: effectiveSettings.fps,
          numInferenceSteps: Math.round(effectiveSettings.numInferenceSteps),
          guidanceScale: effectiveSettings.guidanceScale,
          ...(trimmedFlow ? { flowShift: Number(trimmedFlow) } : {}),
          ...(trimmedSeed ? { seed: Number(trimmedSeed) } : {})
        },
        ...(sourceId ? { sourceId } : {}),
        provider: providerId
      });
      setPhase("processing");
      setPhaseLabel("PROCESSING RESULT");
      if (body.videoUrl) {
        const record = await getGeneration(body.generationId).catch(() => null);
        if (record) setResult(record);
        else {
          setResult({
            id: body.generationId, projectId: "project_default", provider: body.provider, model: body.model,
            mode: effectiveMode, prompt: effectivePrompt, negativePrompt: effectiveNegative || null,
            settings: {}, sourceAssetId: sourceId ?? null, outputPath: null, videoUrl: body.videoUrl,
            status: body.status, errorCode: body.errorCode, error: body.error, seed: body.seed,
            width: body.width, height: body.height, fps: body.fps, frames: body.frames,
            durationMs: body.durationMs, bytes: body.bytes, artifactId: null, selected: false,
            mock: body.mock, createdAt: body.createdAt, completedAt: body.completedAt
          });
        }
        setCompare("result");
      }
      persistPromptHistory({ prompt: effectivePrompt, negativePrompt: effectiveNegative, mode: effectiveMode, usedAt: Date.now() });
      setPhase("complete");
      setPhaseLabel(null);
      flashMessage(body.mock ? `Mock render complete · ${body.generationId}` : `Generated with ${COSMOS_MODEL_LABEL} · ${body.generationId}`);
      void refreshHistory();
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      setPhase("failed");
      setPhaseLabel(null);
    }
  }, [generating, busy, prompt, negativePrompt, settings, mode, source, pendingFile, pendingPreview, providerId, persistPromptHistory, flashMessage, refreshHistory]);

  const openRecord = useCallback((record: GenerationRecord) => {
    setResult(record);
    setPrompt(record.prompt);
    setNegativePrompt(record.negativePrompt ?? "");
    setSettings(settingsFromRecord(record));
    setMode(record.mode);
    setError(null);
    setPhase(record.status === "COMPLETED" ? "complete" : record.status === "FAILED" ? "failed" : "idle");
    if (record.status === "FAILED") setError(record.error ?? "Generation failed.");
    setCompare("result");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const duplicateRecord = useCallback((record: GenerationRecord) => {
    setPrompt(record.prompt);
    setNegativePrompt(record.negativePrompt ?? "");
    setSettings(settingsFromRecord(record));
    setMode(record.mode);
    setResult(null);
    setPhase("idle");
    setError(null);
    flashMessage("Prompt + settings loaded — generate when ready.");
    promptRef.current?.focus();
  }, [flashMessage]);

  const removeRecord = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await deleteGeneration(id);
      if (result?.id === id) {
        setResult(null);
        setPhase("idle");
      }
      void refreshHistory();
    } catch (requestError) {
      flashMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }, [result, refreshHistory, flashMessage]);

  const useThis = useCallback(async () => {
    if (!result || busy) return;
    setBusy(true);
    try {
      const updated = await useGeneration(result.id);
      setResult(updated);
      flashMessage("Marked for use in Motion Lab.");
      void refreshHistory();
    } catch (requestError) {
      flashMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }, [result, busy, flashMessage, refreshHistory]);

  const saveToLab = useCallback(async () => {
    if (!result || busy) return;
    setBusy(true);
    try {
      const updated = await saveGeneration(result.id);
      setResult(updated);
      flashMessage(`Saved to Motion Lab exports · artifact ${updated.artifactId ?? "recorded"}.`);
      void refreshHistory();
    } catch (requestError) {
      flashMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }, [result, busy, flashMessage, refreshHistory]);

  const providerReady = activeProvider?.configured ?? false;
  const sourcePreview = pendingPreview ?? source?.url ?? null;

  const runEnhance = useCallback(async () => {
    if (enhancing || generating || busy || !prompt.trim()) return;
    setEnhancing(true);
    setEnhancePending(null);
    try {
      const result = await enhancePrompt({ prompt: prompt.trim(), mode, ...(source?.sourceId ? { sourceId: source.sourceId } : {}) });
      setEnhancePending(result.enhanced);
    } catch (requestError) {
      flashMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setEnhancing(false);
    }
  }, [enhancing, generating, busy, prompt, mode, source, flashMessage]);

  const playerPhase = generating ? "generating" : phase === "failed" ? "failed" : result?.videoUrl ? "ready" : "idle";

  return (
    <div className="aim-root">
      <header className="aim-head">
        <div className="aim-title">
          <span className="aim-eyebrow">MOTION LAB / AI MOTION</span>
          <h1>Generate motion with {COSMOS_MODEL_LABEL}</h1>
        </div>
        <div className="aim-modelbox" aria-label="Model status">
          <label className="aim-label" htmlFor="aim-model">MODEL</label>
          <select
            id="aim-model"
            className="aim-select"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
          >
            <option value="cosmos">{COSMOS_MODEL_LABEL}</option>
            <option value="mock">Mock · local synthesis (no NVIDIA calls)</option>
          </select>
          <div className={`aim-statusdot${providerReady ? " aim-statusdot-ready" : ""}`} role="status">
            <span aria-hidden="true">{providerReady ? "●" : "○"}</span>
            <span>{activeProvider ? `${activeProvider.displayName} — ${activeProvider.detail}` : statusDetail ?? "Checking…"}</span>
          </div>
          <div className={`aim-statusdot${enhanceInfo?.configured ? " aim-statusdot-ready" : ""}`} role="status" title="Prompt enhancement via the live NVIDIA vision model">
            <span aria-hidden="true">{enhanceInfo?.configured ? "●" : "○"}</span>
            <span>Enhance · {enhanceInfo ? enhanceInfo.detail : "Checking…"}</span>
          </div>
        </div>
      </header>

      <div className="aim-grid">
        <section className="aim-panel" aria-label="Source input">
          <div className="aim-panel-title">SOURCE</div>
          {sourcePreview ? (
            <div className="aim-source-preview">
              {source?.mime.startsWith("video/") || pendingFile?.type.startsWith("video/") ? (
                <video src={sourcePreview} muted playsInline preload="metadata" controls className="aim-source-video" />
              ) : (
                <img src={sourcePreview} alt="Generation source" />
              )}
              <div className="aim-source-meta">
                <span>{source?.fileName ?? pendingFile?.name ?? "staged file"}</span>
                <span>
                  {source && (source.width || source.height) ? `${source.width ?? "—"} × ${source.height ?? "—"} · ` : ""}
                  {source ? `${source.mime} · ${formatBytes(source.bytes)}` : pendingFile ? formatBytes(pendingFile.size) : ""}
                  {pendingFile ? " · staged (uploads on generate)" : ""}
                </span>
              </div>
              <div className="aim-row">
                <button type="button" className="aim-micro" onClick={() => fileInputRef.current?.click()}>Replace</button>
                <button type="button" className="aim-micro" onClick={removeSource}>Remove</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={`aim-dropzone${dragOver ? " aim-dropzone-over" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => { event.preventDefault(); setDragOver(false); pickFile(event.dataTransfer.files?.[0]); }}
            >
              <span className="aim-dropzone-title">SOURCE</span>
              <span className="aim-dropzone-sub">Drop an image or MP4 here</span>
              <span className="aim-dropzone-or">or</span>
              <span className="aim-dropzone-choose">Choose source file</span>
              <span className="aim-dropzone-formats">PNG · JPEG · WEBP · GIF · MP4 — max 25 MB</span>
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,image/*,video/mp4"
            hidden
            onChange={(event) => { pickFile(event.target.files?.[0]); event.target.value = ""; }}
          />
          <div className="aim-hint">Image → Video conditions on this frame. Video → Video conditions on this clip. Text → Video ignores it.</div>
        </section>

        <section className="aim-panel" aria-label="Generation controls">
          <div className="aim-panel-title">GENERATION</div>

          <label className="aim-label" htmlFor="aim-mode">MODE · model_mode</label>
          <div className="aim-modes" role="radiogroup" aria-label="Generation mode">
            {(["image2video", "text2video", "video2video"] as MotionMode[]).map((entry) => (
              <button
                key={entry}
                type="button"
                role="radio"
                aria-checked={mode === entry}
                className={`aim-mode${mode === entry ? " aim-mode-active" : ""}`}
                onClick={() => setMode(entry)}
              >
                {entry === "image2video" ? "Image → Video" : entry === "text2video" ? "Text → Video" : "Video → Video"}
              </button>
            ))}
          </div>
          <div className="aim-hint">Sent as model_mode with input_reference for conditioned modes.</div>

          <div className="aim-label-row">
            <label className="aim-label" htmlFor="aim-prompt">PROMPT</label>
            <span className="aim-row" style={{ alignItems: "center" }}>
              <span className="aim-count">{prompt.length}/{PROMPT_MAX} · ~{estimateTokens(prompt.length)} tok</span>
              <button
                type="button"
                className="aim-micro"
                disabled={enhancing || generating || busy || !prompt.trim()}
                onClick={() => void runEnhance()}
                title={enhanceInfo?.configured ? `Enhance with ${enhanceInfo.model} (applies only on your approval)` : "Needs NVIDIA_API_KEY"}
              >
                {enhancing ? "ENHANCING…" : "✦ ENHANCE PROMPT"}
              </button>
            </span>
          </div>
          {enhancePending ? (
            <div className="aim-example-pending" role="dialog" aria-label="Apply enhanced prompt">
              <div className="aim-label">NVIDIA SUGGESTION — NOTHING OVERWRITTEN</div>
              <p>{enhancePending}</p>
              <div className="aim-row">
                <button type="button" className="aim-micro" onClick={() => { setPrompt(enhancePending); setEnhancePending(null); promptRef.current?.focus(); }}>Apply (replaces prompt)</button>
                <button type="button" className="aim-micro" onClick={() => setEnhancePending(null)}>Dismiss</button>
              </div>
            </div>
          ) : null}
          <textarea
            id="aim-prompt"
            ref={promptRef}
            className="aim-textarea"
            rows={6}
            maxLength={PROMPT_MAX}
            value={prompt}
            placeholder="Describe the motion — camera, light, material response, what must not change…"
            onChange={(event) => setPrompt(event.target.value)}
          />

          <details className="aim-details">
            <summary>EXAMPLE PROMPTS</summary>
            <ul className="aim-examples">
              {EXAMPLE_PROMPTS.map((example) => (
                <li key={example.slice(0, 48)}>
                  <span>{example}</span>
                  <button type="button" className="aim-micro" onClick={() => setExamplePending(example)}>Use</button>
                </li>
              ))}
            </ul>
            {examplePending ? (
              <div className="aim-example-pending" role="dialog" aria-label="Apply example prompt">
                <p>{examplePending}</p>
                <div className="aim-row">
                  <button type="button" className="aim-micro" onClick={() => { setPrompt(examplePending); setExamplePending(null); promptRef.current?.focus(); }}>Apply (replaces prompt)</button>
                  <button type="button" className="aim-micro" onClick={() => setExamplePending(null)}>Dismiss</button>
                </div>
              </div>
            ) : null}
          </details>

          <details className="aim-details">
            <summary>PROMPT HISTORY ({promptHistory.length})</summary>
            {promptHistory.length === 0 ? <p className="aim-hint">Prompts you generate with are kept here for reuse.</p> : (
              <ul className="aim-examples">
                {promptHistory.map((entry) => (
                  <li key={`${entry.usedAt}-${entry.prompt.slice(0, 24)}`}>
                    <span>[{entry.mode === "image2video" ? "I→V" : entry.mode === "video2video" ? "V→V" : "T→V"}] {entry.prompt.slice(0, 140)}{entry.prompt.length > 140 ? "…" : ""}</span>
                    <span className="aim-row">
                      <button type="button" className="aim-micro" onClick={() => { setPrompt(entry.prompt); setNegativePrompt(entry.negativePrompt); setMode(entry.mode); promptRef.current?.focus(); }}>Reuse</button>
                      <button type="button" className="aim-micro" onClick={() => { setPromptHistory((current) => current.filter((item) => item !== entry)); try { localStorage.setItem(HISTORY_KEY, JSON.stringify(promptHistory.filter((item) => item !== entry))); } catch { /* ignore */ } }}>Forget</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </details>

          <label className="aim-label" htmlFor="aim-negative">NEGATIVE PROMPT · OPTIONAL</label>
          <textarea
            id="aim-negative"
            className="aim-textarea aim-textarea-small"
            rows={2}
            maxLength={PROMPT_MAX}
            value={negativePrompt}
            placeholder="Transmitted as negative_prompt (empty string = server default)."
            onChange={(event) => setNegativePrompt(event.target.value)}
          />

          <div className="aim-panel-title aim-panel-title-gap">SETTINGS · DOCUMENTED HOSTED FIELDS</div>
          <div className="aim-settings">
            <label className="aim-field">
              <span>Resolution</span>
              <select
                className="aim-select"
                value={settings.resolution}
                onChange={(event) => setSetting("resolution", event.target.value)}
              >
                {RESOLUTIONS.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
              </select>
            </label>
            <label className="aim-field">
              <span>Frames · num_frames [25, {frameCap}]</span>
              <input
                type="number"
                className="aim-input"
                min={25}
                max={frameCap}
                step={1}
                value={settings.numFrames}
                onChange={(event) => setSetting("numFrames", clampFrames(Number(event.target.value), frameCap))}
              />
              {!framesValid ? <em className="aim-invalid">Enter an integer within [25, {frameCap}].</em> : null}
            </label>
            <label className="aim-field">
              <span>FPS · [1, 60]</span>
              <input type="number" className="aim-input" min={1} max={60} step={0.5} value={settings.fps} onChange={(event) => setSetting("fps", Number(event.target.value))} />
            </label>
            <label className="aim-field">
              <span>Inference steps · num_inference_steps [1, 100]</span>
              <input type="number" className="aim-input" min={1} max={100} step={1} value={settings.numInferenceSteps} onChange={(event) => setSetting("numInferenceSteps", Math.round(Number(event.target.value) || 0))} />
            </label>
            <label className="aim-field">
              <span>Guidance scale · [1, 7]</span>
              <input type="number" className="aim-input" min={1} max={7} step={0.1} value={settings.guidanceScale} onChange={(event) => setSetting("guidanceScale", Number(event.target.value))} />
            </label>
            <label className="aim-field">
              <span>Flow shift · empty = server default (10)</span>
              <input
                type="text"
                inputMode="decimal"
                className="aim-input"
                placeholder="10"
                value={settings.flowShift}
                onChange={(event) => setSetting("flowShift", event.target.value.replace(/[^0-9.]/g, "").slice(0, 8))}
              />
            </label>
            <label className="aim-field">
              <span>Seed · empty = server random</span>
              <span className="aim-field-row">
                <input
                  type="text"
                  inputMode="numeric"
                  className="aim-input"
                  placeholder="random"
                  value={settings.seed}
                  onChange={(event) => setSetting("seed", event.target.value.replace(/[^0-9]/g, "").slice(0, 10))}
                />
                <button type="button" className="aim-micro" onClick={() => setSetting("seed", String(Math.floor(Math.random() * 4294967296)))}>Dice</button>
              </span>
            </label>
          </div>
          <div className="aim-hint">
            Output {resolutionMeta.width} × {resolutionMeta.height} · ≈{formatClock(durationEstimate)} at {settings.fps} FPS · {settings.numFrames} frames
          </div>

          {validationError ? <div className="aim-invalid aim-invalid-block" role="alert">{validationError}</div> : null}

          <button
            type="button"
            className="aim-generate"
            disabled={generating || busy || Boolean(validationError)}
            onClick={() => void runGenerate()}
          >
            {generating ? `${phaseLabel ?? "WORKING"}…` : "GENERATE MOTION"}
          </button>
          <div className="aim-hint">Calls the server route → NVIDIA Cosmos3-Nano. Key never touches the browser.</div>
        </section>
      </div>

      <section className="aim-panel aim-result" aria-label="Generated result">
        <div className="aim-panel-title">GENERATED RESULT</div>
        {source && result?.videoUrl ? (
          <div className="aim-modes aim-compare" role="radiogroup" aria-label="Compare source and result">
            {(["result", "source", "split"] as const).map((entry) => (
              <button key={entry} type="button" role="radio" aria-checked={compare === entry} className={`aim-mode${compare === entry ? " aim-mode-active" : ""}`} onClick={() => setCompare(entry)}>
                {entry === "result" ? "RESULT" : entry === "source" ? "SOURCE" : "SPLIT"}
              </button>
            ))}
          </div>
        ) : null}
        {compare === "source" && source ? (
          <div className="aim-player">
            {source.mime.startsWith("video/") ? (
              <video className="aim-video aim-source-full" src={source.url} controls muted playsInline preload="metadata" />
            ) : (
              <img className="aim-video aim-source-full" src={source.url} alt="Source" />
            )}
          </div>
        ) : compare === "split" && source && result?.videoUrl ? (
          <div className="aim-split">
            {source.mime.startsWith("video/") ? (
              <video src={source.url} controls muted playsInline preload="metadata" />
            ) : (
              <img src={source.url} alt="Source" />
            )}
            <AiVideoPlayer src={result.videoUrl} phase="ready" providerLabel={COSMOS_MODEL_LABEL} />
          </div>
        ) : (
          <AiVideoPlayer
            src={result?.videoUrl ?? null}
            poster={source?.url ?? null}
            phase={playerPhase}
            phaseLabel={phaseLabel}
            elapsedMs={elapsedMs}
            error={error ?? result?.error}
            providerLabel={result ? `${result.provider === "mock" ? "Mock" : COSMOS_MODEL_LABEL} · ${result.model}` : providerId === "mock" ? "Mock" : COSMOS_MODEL_LABEL}
            emptyHint="Upload a source, write a prompt, generate — the video lands here."
          />
        )}
        {result ? (
          <div className="aim-result-meta">
            <span>{result.width ?? "—"} × {result.height ?? "—"}</span>
            <span>{formatClock(result.durationMs)}</span>
            <span>{formatBytes(result.bytes)}</span>
            <span>seed {result.seed ?? "—"}</span>
            <span>{result.model}</span>
            <span>{result.mock ? "mock" : "nvidia"}</span>
            <span>{formatTime(result.createdAt)}</span>
          </div>
        ) : null}
        {error && phase === "failed" ? <div className="aim-invalid aim-invalid-block" role="alert">{error}</div> : null}
        <div className="aim-actions">
          <button type="button" className="aim-btn" disabled={!result || generating || busy} onClick={() => void runGenerate()} title="Run again with identical inputs">Regenerate</button>
          <button type="button" className="aim-btn" onClick={() => promptRef.current?.focus()}>Edit Prompt</button>
          <button type="button" className="aim-btn" disabled={!result || result.status !== "COMPLETED" || busy} onClick={() => void useThis()} title="Mark this generation for use in Motion Lab">Use This</button>
          <a
            className={`aim-btn aim-link${!result?.videoUrl ? " aim-btn-disabled" : ""}`}
            href={result?.videoUrl ?? undefined}
            download={result ? `${result.id}.mp4` : undefined}
            aria-disabled={!result?.videoUrl}
            onClick={(event) => { if (!result?.videoUrl) event.preventDefault(); }}
          >
            Download
          </a>
          <button type="button" className="aim-btn" disabled={!result || result.status !== "COMPLETED" || busy} onClick={() => void saveToLab()} title="Copy into public/exports + record artifact">Save to Motion Lab</button>
        </div>
      </section>

      <section className="aim-panel" aria-label="Generation history">
        <div className="aim-panel-title">GENERATION HISTORY ({history.length})</div>
        {history.length === 0 ? (
          <p className="aim-hint">No generations yet. Each run records provider, model, prompt, settings, and status here.</p>
        ) : (
          <ul className="aim-history">
            {history.map((record) => (
              <li key={record.id} className={`aim-hist${record.selected ? " aim-hist-selected" : ""}`}>
                <button type="button" className="aim-hist-thumb" onClick={() => openRecord(record)} title="Reopen in workspace">
                  {record.videoUrl && record.status === "COMPLETED" ? (
                    <video src={record.videoUrl} preload="metadata" muted playsInline />
                  ) : (
                    <span className={`aim-hist-badge aim-hist-${record.status.toLowerCase()}`}>{record.status}</span>
                  )}
                </button>
                <div className="aim-hist-body">
                  <div className="aim-hist-id">{record.mock ? "mock" : record.model} · {record.mode === "image2video" ? "I→V" : record.mode === "video2video" ? "V→V" : "T→V"} · {record.id}</div>
                  <div className="aim-hist-prompt">{record.prompt.slice(0, 160)}{record.prompt.length > 160 ? "…" : ""}</div>
                  <div className="aim-hist-meta">
                    <span>{record.width ?? "—"}×{record.height ?? "—"}</span>
                    <span>{formatClock(record.durationMs)}</span>
                    <span>{record.status}</span>
                    <span>{formatTime(record.createdAt)}</span>
                  </div>
                  <div className="aim-row">
                    <button type="button" className="aim-micro" onClick={() => openRecord(record)}>Reopen</button>
                    <button type="button" className="aim-micro" onClick={() => duplicateRecord(record)}>Duplicate</button>
                    <button
                      type="button"
                      className="aim-micro"
                      disabled={generating || busy}
                      onClick={() => { duplicateRecord(record); window.setTimeout(() => void runGenerate({ prompt: record.prompt, negativePrompt: record.negativePrompt ?? "", settings: settingsFromRecord(record), mode: record.mode }), 50); }}
                    >
                      Regenerate
                    </button>
                    <button type="button" className="aim-micro aim-micro-danger" onClick={() => void removeRecord(record.id)}>Delete</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {flash ? <div className="aim-flash" role="status">{flash}</div> : null}
    </div>
  );
}
