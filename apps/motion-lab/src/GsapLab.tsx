import { useCallback, useEffect, useRef, useState } from "react";
import { GsapEngine, type GsapPlayback, type GsapPlaybackState, type GsapSceneSpec } from "@waves/motion";
import WavesBrandFilm, { BRAND_FILM_STAGE_VERSION } from "./WavesBrandFilm";
import "./gsap-lab.css";

interface GsapLiveState {
  name: string;
  updatedAt: string;
  spec: GsapSceneSpec;
  stageVersion?: number;
}

const POLL_MS = 1000;
const BRAND_FILM = "waves-brand-film-19s";
const RELOAD_GUARD = "waves-gsap-stage-reload";

/** Scene markup is always mounted; only its visibility is switched. A spec can
 *  therefore never outrun the bundle that is supposed to host its targets. */
const SCENE_LAYERS = [
  { name: "obsidian-hero", label: "OBSIDIAN HERO" },
  { name: BRAND_FILM, label: "WAVES BRAND FILM" }
] as const;

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
        const response = await fetch("gsap-state.json", { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as GsapLiveState;
        if (!next?.spec || !Array.isArray(next.spec.ops)) return;

        // Stage/spec version handshake. A tab left open across a deploy holds
        // the old bundle while gsap-state.json is always fresh, which used to
        // strand the viewer on unresolved selectors. Reload once for this
        // version; if it still disagrees the server is serving something we do
        // not recognise, so say so instead of looping.
        if (typeof next.stageVersion === "number" && next.stageVersion !== BRAND_FILM_STAGE_VERSION) {
          const guardKey = `${RELOAD_GUARD}:${next.stageVersion}`;
          if (sessionStorage.getItem(guardKey)) {
            setNotice({
              tone: "error",
              text: `Published scene expects stage v${next.stageVersion}, this build is v${BRAND_FILM_STAGE_VERSION}. Hard-reload to update.`
            });
            return;
          }
          sessionStorage.setItem(guardKey, "1");
          location.reload();
          return;
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
    const position = window.setInterval(() => {
      const playback = playbackRef.current;
      if (playback && (playback.state() === "PLAYING")) {
        // Ambient loops run forever by design; the clock caps at the plan total.
        writeClock(Math.min(Math.round(playback.time() * 1000), totalMsRef.current));
      }
    }, 100);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearInterval(position);
    };
  }, [writeClock]);

  useEffect(() => {
    if (live) build(live);
  }, [live, build]);

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

  const onPlay = useCallback(() => {
    if (!reduced) {
      setSceneLabel(null);
      playbackRef.current?.play();
      return;
    }
    stepTo(stepRef.current + 1);
  }, [reduced, stepTo]);

  const onPause = useCallback(() => {
    if (!reduced) {
      playbackRef.current?.pause();
      setState(playbackRef.current?.state() ?? "IDLE");
      return;
    }
    setState("PAUSED");
  }, [reduced]);

  const onRestart = useCallback(() => {
    if (reduced) {
      stepTo(0);
      return;
    }
    setSceneLabel(null);
    playbackRef.current?.restart();
  }, [reduced, stepTo]);

  const onReverse = useCallback(() => {
    if (reduced) {
      stepTo(stepRef.current - 1);
      return;
    }
    playbackRef.current?.reverse();
  }, [reduced, stepTo]);

  const activeName = live?.spec.name ?? null;
  const isBrandFilm = activeName === BRAND_FILM;
  const knownScene = SCENE_LAYERS.some((layer) => layer.name === activeName);

  return (
    <div className="gsap-root">
      <header className="gsap-head">
        <div>
          <span className="gsap-eyebrow">MOTION LAB / GSAP</span>
          <h1>{live ? live.name : "No scene"}</h1>
        </div>
        <div className="gsap-transport" role="toolbar" aria-label="Playback controls">
          <span className={`gsap-state gsap-state-${state.toLowerCase()}`} role="status">{state}</span>
          <button type="button" className="gsap-btn" onClick={onPlay} aria-label={reduced ? "Next scene" : "Play"}>▶</button>
          <button type="button" className="gsap-btn" onClick={onPause} aria-label={reduced ? "Hold" : "Pause"}>❚❚</button>
          <button type="button" className="gsap-btn" onClick={onRestart} aria-label={reduced ? "First scene" : "Restart"}>⟲</button>
          <button type="button" className="gsap-btn" onClick={onReverse} aria-label={reduced ? "Previous scene" : "Reverse"}>↩</button>
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
      <div className={`gsap-stage${isBrandFilm ? " gsap-stage-film" : ""}`} ref={stageRef} aria-label="GSAP stage">
        <div className="gsap-layer" data-scene="obsidian-hero" data-active={!isBrandFilm}>
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
      </div>

      {!live ? (
        <p className="gsap-empty">No GSAP scene published. Create one with <code>create_gsap_animation</code>, then <code>preview_gsap_animation</code>.</p>
      ) : null}
    </div>
  );
}
