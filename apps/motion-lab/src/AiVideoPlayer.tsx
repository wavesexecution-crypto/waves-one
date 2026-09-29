import { useCallback, useEffect, useRef, useState } from "react";
import { formatClock } from "./lib/ai-motion/constants";

interface AiVideoPlayerProps {
  src: string | null;
  poster?: string | null;
  phase: "idle" | "generating" | "ready" | "failed";
  phaseLabel?: string | null;
  elapsedMs?: number;
  error?: string | null;
  providerLabel?: string;
  emptyHint?: string;
}

/**
 * Motion Lab video viewer — browser-native playback (controls, seeking,
 * volume, speed, fullscreen) with Lab states around it: empty, generating
 * (honest elapsed time, never fake progress), error, and ready.
 */
export default function AiVideoPlayer({ src, poster, phase, phaseLabel, elapsedMs, error, providerLabel, emptyHint }: AiVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [compare, setCompare] = useState(false);

  useEffect(() => {
    setPlaying(false);
    setPosition(0);
    setDuration(null);
    setCompare(false);
  }, [src]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, [src]);

  const toggleFullscreen = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void wrap.requestFullscreen?.().catch(() => {});
  }, []);

  const cycleRate = useCallback(() => {
    const steps = [1, 1.5, 2, 0.5];
    const next = steps[(steps.indexOf(rate) + 1) % steps.length];
    setRate(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  }, [rate]);

  if (phase === "generating") {
    return (
      <div className="aim-player aim-player-state" role="status" aria-live="polite">
        <div className="aim-pulse" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="aim-state-title">{phaseLabel ?? "GENERATING"}</div>
        <div className="aim-state-sub">
          {providerLabel ? `${providerLabel} · ` : ""}
          {elapsedMs !== undefined ? `${(elapsedMs / 1000).toFixed(0)}s elapsed` : "working"}
          {" · trial generations typically take 1–4 min"}
        </div>
        <div className="aim-state-note">No progress events from the API — the player appears the moment the video lands.</div>
      </div>
    );
  }

  if (phase === "failed") {
    return (
      <div className="aim-player aim-player-state" role="alert">
        <div className="aim-state-title">GENERATION FAILED</div>
        <div className="aim-state-sub">{error ?? "Unknown error."}</div>
        <div className="aim-state-note">Adjust the prompt or settings and regenerate. Detail was logged server-side.</div>
      </div>
    );
  }

  if (!src) {
    return (
      <div className="aim-player aim-player-state">
        <div className="aim-state-title">NO RESULT YET</div>
        <div className="aim-state-sub">{emptyHint ?? "Upload a source, write a prompt, generate."}</div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="aim-player">
      <video
        ref={videoRef}
        className="aim-video"
        src={src}
        poster={poster ?? undefined}
        preload="metadata"
        playsInline
        loop
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration * 1000)}
        onClick={togglePlay}
      />
      {poster && compare ? (
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- overlay keeps source framed identically
        <img className="aim-compare-overlay" src={poster} alt="Source frame" />
      ) : null}
      <div className="aim-controls" role="toolbar" aria-label="Video controls">
        <button type="button" className="aim-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          type="range"
          className="aim-seek"
          aria-label="Seek"
          min={0}
          max={Math.max(1, duration ?? 1)}
          step={100}
          value={Math.min(position, duration ?? position)}
          onChange={(event) => {
            const video = videoRef.current;
            const next = Number(event.target.value);
            setPosition(next);
            if (video && Number.isFinite(video.duration)) video.currentTime = next / 1000;
          }}
        />
        <span className="aim-time">
          {formatClock(position)} / {formatClock(duration)}
        </span>
        <button type="button" className="aim-btn" onClick={cycleRate} title="Playback speed" aria-label="Playback speed">
          {rate}×
        </button>
        <button
          type="button"
          className="aim-btn"
          onClick={() => {
            const video = videoRef.current;
            const next = !muted;
            setMuted(next);
            if (video) video.muted = next;
          }}
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted ? "MUTE" : "VOL"}
        </button>
        {poster ? (
          <button
            type="button"
            className={`aim-btn${compare ? " aim-btn-active" : ""}`}
            onClick={() => setCompare((value) => !value)}
            title="Hold the source frame over the result"
            aria-pressed={compare}
          >
            A/B
          </button>
        ) : null}
        <button type="button" className="aim-btn" onClick={toggleFullscreen} aria-label="Fullscreen">
          ⛶
        </button>
      </div>
    </div>
  );
}
