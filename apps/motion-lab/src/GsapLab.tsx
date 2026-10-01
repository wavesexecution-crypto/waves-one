import { useCallback, useEffect, useRef, useState } from "react";
import { GsapEngine, type GsapPlayback, type GsapPlaybackState, type GsapSceneSpec } from "@waves/motion";
import WavesBrandFilm, { BRAND_FILM_STAGE_VERSION } from "./WavesBrandFilm";
import SeaiLaunchReel, { SEAI_REEL_STAGE_VERSION } from "./SeaiLaunchReel";
import "./gsap-lab.css";

interface GsapLiveState {
  name: string;
  updatedAt: string;
  spec: GsapSceneSpec;
  stageVersion?: number;
}

interface FilmVideo {
  ok?: boolean;
  file: string;
  filename?: string;
  width: number;
  height: number;
  fps: number;
  codec: string;
  container: string;
  durationMs: number;
  size: number;
}

const POLL_MS = 1000;
const BRAND_FILM = "waves-brand-film-19s";
const SEAI_REEL = "seai-launch-reel";
const RELOAD_GUARD = "waves-gsap-stage-reload";

/** Scene markup is always mounted; only its visibility is switched. A spec can
 *  therefore never outrun the bundle that is supposed to host its targets. */
const SCENE_LAYERS = [
  { name: "obsidian-hero", label: "OBSIDIAN HERO", stageVersion: undefined },
  { name: BRAND_FILM, label: "WAVES BRAND FILM", stageVersion: BRAND_FILM_STAGE_VERSION },
  { name: SEAI_REEL, label: "SEAI LAUNCH REEL", stageVersion: SEAI_REEL_STAGE_VERSION }
] as const;

/**
 * The stage version to check a published spec against. This MUST be looked up
 * per scene: the two stages ship independent markup and independent versions, so
 * a single build-level constant would report a false mismatch the moment a
 * second stage with a different version exists (a 9:16 reel at v1 would be
 * rejected by the 16:9 film's v2).
 */
const stageVersionFor = (name: string): number | undefined =>
  SCENE_LAYERS.find((layer) => layer.name === name)?.stageVersion;

/** Turn a raw engine failure into something a human can act on. */
function explain(error: unknown, sceneName: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const missing = raw.match(/GSAP_TARGET_MISSING/g)?.length ?? 0;
  if (missing === 0) return raw.slice(0, 400);
  const sample = [...new Set(raw.match(/[a-z0-9-]+:GSAP_TARGET_MISSING/gi) ?? [])].slice(0, 3).join(", ");
  return (
    `"${sceneName}" targets markup this build does not render — ${missing} selector(s) unresolved (e.g. ${sample}). ` +
    `If you just published or deployed, reload the page to pick up the current bundle.`
  );
}

/**
 * GSAP workspace — plays the live GSAP scene (public/gsap-state.json)
 * through GsapEngine. Transport controls + state, same visual language as
 * the rest of Motion Lab. Engine owns cleanup; remounts never leak.
 */
export default function GsapLab() {
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GsapEngine | null>(null);
  const playbackRef = useRef<GsapPlayback | null>(null);
const unsubscribeRef = useRef<(() => void) | null>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const liveRef = useRef<string | null>(null);
  const scenesRef = useRef<Array<{ label: string; at: number }>>([]);
  /** Reduced-motion transport is a stepper, not a player. */
  const stepRef = useRef(0);
  const totalMsRef = useRef(0);
  const [live, setLive] = useState<GsapLiveState | null>(null);
  const [state, setState] = useState<GsapPlaybackState>("IDLE");
  const [totalMs, setTotalMs] = useState(0);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [reduced, setReduced] = useState(false);
  const [sceneLabel, setSceneLabel] = useState<string | null>(null);
  const [video, setVideo] = useState<FilmVideo | null>(null);
  const [rendering, setRendering] = useState(false);

  /**
   * The rendered MP4 is a static file next to the spec, so the Download button
   * works on the deployed site too — the render worker itself is dev-only
   * middleware and has no server to run on in production.
   */
  const refreshVideo = useCallback(async (sceneName: string | null) => {
    if (!sceneName) {
      setVideo(null);
      return;
    }
    try {
      // Manifest is per scene, so a 16:9 film and a 9:16 reel can each ship their
      // own file and neither claims the other's.
      const response = await fetch(`exports/${sceneName}.json`, { cache: "no-store" });
      if (!response.ok) {
        setVideo(null);
        return;
      }
      const parsed = (await response.json()) as Partial<FilmVideo>;
      // A manifest counts when it names a file and a size; don't depend on an
      // `ok` flag the renderer may or may not have written.
      setVideo(parsed && typeof parsed.file === "string" && typeof parsed.size === "number" ? (parsed as FilmVideo) : null);
    } catch {
      setVideo(null);
    }
  }, []);

  const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  /**
   * The clock is written straight to the DOM. Driving it through React state
   * re-rendered the whole 266-node film tree ~7x a second during playback for
   * a string that changes once per frame.
   */
  const writeClock = useCallback((ms: number) => {
    const node = clockRef.current;
    if (node) node.textContent = `${fmt(ms)} / ${fmt(totalMsRef.current)}`;
  }, []);

  const teardown = useCallback(() => {
    playbackRef.current = null;
    // Drop the tick subscription before the engine disposes, or a disposed
    // timeline keeps a listener alive across a rebuild.
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    if (engineRef.current) {
      engineRef.current.dispose();
      engineRef.current = null;
    }
  }, []);

  const build = useCallback(
    (scene: GsapLiveState) => {
      if (!stageRef.current) return;
      teardown();
      const engine = new GsapEngine({ scope: stageRef.current });
      engineRef.current = engine;
      try {
        const { playback, report } = engine.build(scene.spec, { autoplay: true });
        playbackRef.current = playback;
        // Labelled beats come from the spec, not a hardcoded scene: stepping
        // under reduced motion must land on real scene starts.
        scenesRef.current = scene.spec.ops
          .filter((op) => typeof (op as { label?: unknown }).label === "string")
          .map((op) => ({ label: (op as { label: string }).label, at: typeof op.position === "number" ? op.position : 0 }))
          .sort((a, b) => a.at - b.at);
        totalMsRef.current = playback.totalMs;
        setTotalMs(playback.totalMs);
        setSceneLabel(null);
        setReduced(report.reducedMotionApplied);
        setState(playback.state());
        writeClock(0);
        playback.onStateChange((next) => {
          setState(next);
          writeClock(Math.min(Math.round(playback.time() * 1000), totalMsRef.current));
        });
        // Clock comes from GSAP's own onUpdate, not a setInterval reading
        // time() out of step with the ticker. The stage and the readout now
        // cannot disagree: if this does not fire, the frame did not move.
        unsubscribeRef.current = playback.onUpdate((seconds) => {
          writeClock(Math.min(Math.round(seconds * 1000), totalMsRef.current));
        });
        if (report.skipped.length > 0) {
          setNotice({ tone: "info", text: `${report.skipped.length} op(s) skipped (${report.skipped[0].slice(0, 90)})` });
        } else if (report.warnings.length > 0) {
          setNotice({ tone: "info", text: `${report.warnings.length} validation warning(s)` });
        } else {
          setNotice(null);
        }
      } catch (error) {
        scenesRef.current = [];
        totalMsRef.current = 0;
        setTotalMs(0);
        setState("IDLE");
        writeClock(0);
        setNotice({ tone: "error", text: explain(error, scene.name) });
      }
    },
    [teardown, writeClock]
  );

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const response = await fetch(`gsap-state.json?v=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as GsapLiveState;
        if (!next?.spec || !Array.isArray(next.spec.ops)) return;

        // Stage/spec version handshake. A tab left open across a deploy holds
        // the old bundle while gsap-state.json is always fresh, which used to
        // strand the viewer on unresolved selectors.
        //
        // This must NOT be allowed to block loading. Returning early here left
        // `live` null, so the Lab fell back to the static OBSIDIAN HERO layer
        // and PLAY was a dead control — a version number could take down
        // playback entirely. Load and play regardless, and report the skew.
        const expected = stageVersionFor(next.name);
        const skewed =
          typeof next.stageVersion === "number" && typeof expected === "number" && next.stageVersion !== expected;
        if (skewed) {
          setNotice({
            tone: "info",
            text: `Scene "${next.name}" was published against stage v${next.stageVersion}; this build is v${expected}. Playing anyway — reload for the exact build.`
          });
          // Only a genuine retry loop warrants a reload, and the guard is
          // cleared on every successful load below so a version can never
          // permanently brick a session.
          const guardKey = `${RELOAD_GUARD}:${next.name}:${next.stageVersion}`;
          if (!sessionStorage.getItem(guardKey)) {
            sessionStorage.setItem(guardKey, "1");
            sessionStorage.removeItem(`${RELOAD_GUARD}:loaded`);
          }
        } else {
          sessionStorage.removeItem(`${RELOAD_GUARD}:${next.name}:${next.stageVersion}`);
          sessionStorage.setItem(`${RELOAD_GUARD}:loaded`, next.updatedAt);
        }

        if (next.updatedAt === liveRef.current) return;
        liveRef.current = next.updatedAt;
        setLive(next);
      } catch {
        /* dev hiccup — next tick retries */
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [writeClock]);

  useEffect(() => {
    if (live) build(live);
  }, [live, build]);

  useEffect(() => {
    void refreshVideo(live?.name ?? null);
  }, [refreshVideo, live?.updatedAt, live?.name]);

  useEffect(() => teardown, [teardown]);

  /**
   * Under reduced motion the engine parks the scene on its final frame and will
   * not animate on its own — so a plain play/pause pair is two dead buttons.
   * Reduced motion still means the viewer can *inspect* the film, so the
   * transport steps deterministically between the spec's own labelled beats.
   */
  const stepTo = useCallback((index: number) => {
    const playback = playbackRef.current;
    const scenes = scenesRef.current;
    if (!playback) return;
    if (scenes.length === 0) {
      playback.progress(index > 0 ? 1 : 0);
      return;
    }
    const clamped = Math.max(0, Math.min(scenes.length - 1, index));
    stepRef.current = clamped;
    // Land just inside the scene, not on its first frame: a scene's own
    // entrance is still running at its label, which would show a black stage.
    // The last scene is already the film's held final frame, so use the end.
    const start = scenes[clamped].at;
    const next = scenes[clamped + 1]?.at;
    const totalSeconds = totalMsRef.current / 1000;
    const target = next === undefined ? totalSeconds : Math.min(start + 0.5, Math.max(start, next - 0.05));
    playback.progress(totalSeconds > 0 ? Math.min(1, target / totalSeconds) : 0);
    writeClock(Math.round(playback.time() * 1000));
    setSceneLabel(scenes[clamped].label);
    setState(clamped >= scenes.length - 1 ? "COMPLETED" : "PAUSED");
  }, [writeClock]);

  /**
   * Transport handlers must never be a control that silently does nothing.
   * Every one of these used to optional-chain a null playback ref, so with no
   * scene loaded the four buttons stayed enabled, PLAY did nothing, and the Lab
   * looked frozen on its first frame. The buttons are now disabled in that
   * state; this guard is the belt to those braces.
   */
  const requirePlayback = useCallback((): GsapPlayback | null => {
    const playback = playbackRef.current;
    if (!playback) {
      setNotice({
        tone: "error",
        text: "Nothing to play — no GSAP scene is loaded. Publish one (pnpm seai-reel:publish) or reload the page."
      });
      return null;
    }
    return playback;
  }, []);

  const onPlay = useCallback(() => {
    if (!reduced) {
      const playback = requirePlayback();
      if (!playback) return;
      setSceneLabel(null);
      // Replaying after COMPLETED must restart from 0, not sit at the end.
      // The engine's play() deliberately holds at progress >= 1, so the UI owns
      // that intent explicitly.
      if (playback.progress() >= 1) playback.restart();
      else playback.play();
      return;
    }
    stepTo(stepRef.current + 1);
  }, [reduced, stepTo, requirePlayback]);

  const onPause = useCallback(() => {
    if (!reduced) {
      const playback = requirePlayback();
      if (!playback) return;
      playback.pause();
      setState(playback.state());
      return;
    }
    setState("PAUSED");
  }, [reduced, requirePlayback]);

  const onRestart = useCallback(() => {
    if (reduced) {
      stepTo(0);
      return;
    }
    const playback = requirePlayback();
    if (!playback) return;
    setSceneLabel(null);
    playback.restart();
  }, [reduced, stepTo, requirePlayback]);

  const onReverse = useCallback(() => {
    if (reduced) {
      stepTo(stepRef.current - 1);
      return;
    }
    const playback = requirePlayback();
    if (!playback) return;
    // reverse() from time 0 is a no-op that leaves the stage on frame 0 with
    // PLAYING reported, which is indistinguishable from the bug above.
    if (playback.progress() <= 0) {
      playback.pause();
      setState("IDLE");
      return;
    }
    playback.reverse();
  }, [reduced, stepTo, requirePlayback]);

  /** Render on demand — only the local Lab can, since the worker is dev-only. */
  const renderNow = useCallback(async () => {
    if (rendering) return;
    setRendering(true);
    setNotice({ tone: "info", text: "Rendering the film through the local Lab — this takes a minute." });
    try {
      const response = await fetch("/__lab/export-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "mp4",
          orientation: activeName === SEAI_REEL ? "vertical" : "landscape"
        })
      });
      const body = (await response.json()) as { ok?: boolean; file?: string; error?: string };
      if (!response.ok || !body.ok || !body.file) throw new Error(body.error ?? "Render failed.");
      const meta = (await (await fetch(body.file, { method: "HEAD" })).ok)
        ? (await (await fetch(`${body.file}.json`, { cache: "no-store" }).catch(() => null))?.json() as FilmVideo | null)
        : null;
      setVideo(meta);
      setNotice({ tone: "info", text: "Video ready." });
    } catch (error) {
      setNotice({
        tone: "error",
        text: `${error instanceof Error ? error.message : String(error)} — rendering needs the local Lab (pnpm dev:lab).`
      });
    } finally {
      setRendering(false);
    }
  }, [rendering]);

  const activeName = live?.spec.name ?? null;
  const isBrandFilm = activeName === BRAND_FILM;
  const isSeaiReel = activeName === SEAI_REEL;
  const knownScene = SCENE_LAYERS.some((layer) => layer.name === activeName);
  /** No loaded playback means no transport. These buttons used to stay enabled
   *  and no-op, which is exactly how a frozen first frame reads as a bug. */
  const transportReady = playbackRef.current !== null && totalMs > 0;
  const videoHref = video?.ok !== false && video?.file ? video.file : null;
  const videoLabel = video
    ? `${video.width}×${video.height} · ${video.fps}fps ${video.codec} · ${video.container} · ${(video.size / 1_000_000).toFixed(2)} MB`
    : null;

  return (
    <div className="gsap-root">
      <header className="gsap-head">
        <div>
          <span className="gsap-eyebrow">MOTION LAB / GSAP</span>
          <h1>{live ? live.name : "No scene"}</h1>
        </div>
        <div className="gsap-transport" role="toolbar" aria-label="Playback controls">
          <span className={`gsap-state gsap-state-${state.toLowerCase()}`} role="status">{state}</span>
          <button type="button" className="gsap-btn" onClick={onPlay} disabled={!transportReady} aria-label={reduced ? "Next scene" : "Play"}>▶</button>
          <button type="button" className="gsap-btn" onClick={onPause} disabled={!transportReady} aria-label={reduced ? "Hold" : "Pause"}>❚❚</button>
          <button type="button" className="gsap-btn" onClick={onRestart} disabled={!transportReady} aria-label={reduced ? "First scene" : "Restart"}>⟲</button>
          <button type="button" className="gsap-btn" onClick={onReverse} disabled={!transportReady} aria-label={reduced ? "Previous scene" : "Reverse"}>↩</button>
          <span className="gsap-time" ref={clockRef}>{fmt(0)} / {fmt(totalMs)}</span>
        </div>
      </header>

      {reduced ? (
        <div className="gsap-note" role="note">
          Reduced motion active — the film will not animate on its own. ▶ steps scene by scene
          {sceneLabel ? <> · on <strong>{sceneLabel}</strong></> : null}, ↩ steps back, ⟲ returns to the opening frame.
        </div>
      ) : null}
      {notice ? <div className={`gsap-note gsap-note-${notice.tone}`} role="alert">{notice.text}</div> : null}
      {live && !knownScene ? (
        <div className="gsap-note" role="note">
          No built-in stage for <code>{live.name}</code> — the scene is playing against the default stage, so its selectors may not resolve.
        </div>
      ) : null}

      {/* Every scene layer stays mounted; only the active one is visible. */}
      <div
        className={`gsap-stage${isBrandFilm ? " gsap-stage-film" : ""}${isSeaiReel ? " gsap-stage-reel" : ""}`}
        ref={stageRef}
        aria-label="GSAP stage"
      >
        <div className="gsap-layer" data-scene="obsidian-hero" data-active={!isBrandFilm && !isSeaiReel}>
          <div className="ob-bg" aria-hidden="true" />
          <div className="ob-frame">
            <div className="ob-eyebrow">WAVES — MOTION LAB</div>
            <h2 className="ob-title">WAVES</h2>
            <p className="ob-sub">Motion, engineered.</p>
            <div className="ob-visual" aria-hidden="true">
              <span className="ob-ring ob-ring-1" />
              <span className="ob-ring ob-ring-2" />
              <span className="ob-orb" />
            </div>
            <div className="ob-meta">
              <span>ENGINE · GSAP</span>
              <span>TRACK · DETERMINISTIC</span>
              <span>SPEC · SERIALIZABLE</span>
            </div>
          </div>
        </div>
        <div className="gsap-layer" data-scene={BRAND_FILM} data-active={isBrandFilm}>
          <WavesBrandFilm />
        </div>
        <div className="gsap-layer" data-scene={SEAI_REEL} data-active={isSeaiReel}>
          <SeaiLaunchReel />
        </div>
      </div>

      {/* One screen: the film, the transport, and the two things you can do
          with it — take the video, or direct the next one. */}
      <div className="gsap-actions">
        <div className="gsap-actions-row">
          {videoHref ? (
            <a className="gsap-btn gsap-btn-primary" href={videoHref} download={video?.filename ?? "film.mp4"}>
              ↓ Download video
            </a>
          ) : (
            <button type="button" className="gsap-btn" onClick={renderNow} disabled={rendering}>
              {rendering ? "Rendering…" : "↓ Render video"}
            </button>
          )}
          {videoHref && video && videoLabel ? <span className="gsap-meta">{videoLabel}</span> : (
            <span className="gsap-meta">
              No rendered file yet. <code>pnpm export:brand-film</code> / <code>pnpm export:seai-reel</code> produce one;
              rendering here needs the local Lab (the render worker is dev-only middleware).
            </span>
          )}
        </div>
        <div className="gsap-actions-row">
          <button type="button" className="gsap-btn" onClick={() => void refreshVideo(activeName)} aria-label="Refresh video availability">
            ⟳
          </button>
          <span className="gsap-meta">Rendered from this exact spec — deterministic, {(totalMs / 1000).toFixed(3)}s.</span>
        </div>
      </div>

      {!live ? (
        <p className="gsap-empty">No GSAP scene published. Create one with <code>create_gsap_animation</code>, then <code>preview_gsap_animation</code>.</p>
      ) : null}
    </div>
  );
}
