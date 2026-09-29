import { useCallback, useEffect, useRef, useState } from "react";
import { GsapEngine, type GsapPlayback, type GsapPlaybackState, type GsapSceneSpec } from "@waves/motion";
import "./gsap-lab.css";

interface GsapLiveState {
  name: string;
  updatedAt: string;
  spec: GsapSceneSpec;
}

const POLL_MS = 1000;

/**
 * GSAP workspace — plays the live GSAP scene (public/gsap-state.json)
 * through GsapEngine. Transport controls + state, same visual language as
 * the rest of Motion Lab. Engine owns cleanup; remounts never leak.
 */
export default function GsapLab() {
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GsapEngine | null>(null);
  const playbackRef = useRef<GsapPlayback | null>(null);
  const liveRef = useRef<string | null>(null);
  const [live, setLive] = useState<GsapLiveState | null>(null);
  const [state, setState] = useState<GsapPlaybackState>("IDLE");
  const [totalMs, setTotalMs] = useState(0);
  const totalMsRef = useRef(0);
  const [positionMs, setPositionMs] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [reduced, setReduced] = useState(false);

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
        totalMsRef.current = playback.totalMs;
        setTotalMs(playback.totalMs);
        setPositionMs(0);
        setReduced(report.reducedMotionApplied);
        setState(playback.state());
        playback.onStateChange((next) => {
          setState(next);
          setPositionMs(Math.min(Math.round(playback.time() * 1000), totalMsRef.current));
        });
        if (report.skipped.length > 0) {
          setNotice(`${report.skipped.length} op(s) skipped (${report.skipped[0].slice(0, 90)})`);
        } else if (report.warnings.length > 0) {
          setNotice(`${report.warnings.length} validation warning(s)`);
        } else {
          setNotice(null);
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [teardown]
  );

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const response = await fetch("gsap-state.json", { cache: "no-store" });
        if (!response.ok) return;
        const state = (await response.json()) as GsapLiveState;
        if (!state?.spec || !Array.isArray(state.spec.ops)) return;
        if (state.updatedAt === liveRef.current) return;
        liveRef.current = state.updatedAt;
        setLive(state);
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
        setPositionMs(Math.min(Math.round(playback.time() * 1000), totalMsRef.current));
      }
    }, 150);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearInterval(position);
    };
  }, []);

  useEffect(() => {
    if (live) build(live);
  }, [live, build]);

  useEffect(() => teardown, [teardown]);

  const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  return (
    <div className="gsap-root">
      <header className="gsap-head">
        <div>
          <span className="gsap-eyebrow">MOTION LAB / GSAP</span>
          <h1>{live ? live.name : "No scene"}</h1>
        </div>
        <div className="gsap-transport" role="toolbar" aria-label="Playback controls">
          <span className={`gsap-state gsap-state-${state.toLowerCase()}`} role="status">{state}</span>
          <button type="button" className="gsap-btn" onClick={() => playbackRef.current?.play()} aria-label="Play">▶</button>
          <button type="button" className="gsap-btn" onClick={() => { playbackRef.current?.pause(); setState(playbackRef.current?.state() ?? "IDLE"); }} aria-label="Pause">❚❚</button>
          <button type="button" className="gsap-btn" onClick={() => playbackRef.current?.restart()} aria-label="Restart">⟲</button>
          <button type="button" className="gsap-btn" onClick={() => playbackRef.current?.reverse()} aria-label="Reverse">↩</button>
          <span className="gsap-time">{fmt(positionMs)} / {fmt(totalMs)}</span>
        </div>
      </header>

      {reduced ? <div className="gsap-note" role="note">Reduced motion active — final state shown, ambient/scroll motion off.</div> : null}
      {notice ? <div className="gsap-note" role="note">{notice}</div> : null}

      <div className="gsap-stage" ref={stageRef} aria-label="GSAP stage">
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

      {!live ? (
        <p className="gsap-empty">No GSAP scene published. Create one with <code>create_gsap_animation</code>, then <code>preview_gsap_animation</code>.</p>
      ) : null}
    </div>
  );
}
