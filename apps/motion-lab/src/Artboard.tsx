/**
 * Scaled artboard — the single place a fixed-pixel stage becomes viewport
 * relative. Extracted from `WavesBrandFilm` so a 9:16 reel and a 16:9 film are
 * guaranteed to scale by the same rule instead of two hand-rolled ResizeObservers
 * drifting apart.
 *
 * The frame is sized to the FITTED RECT, not to a CSS aspect-ratio. CSS cannot
 * express "fit a fixed-ratio box inside both axes" on one element: an
 * `aspect-ratio` plus `height:100%` collapses to zero when the parent is
 * content-sized, and plus `width:100%` it overflows a short viewport. Measuring
 * here instead means one rule serves both orientations:
 *
 *   scale = min(availableWidth / W, availableHeight / H)
 *
 * The frame is then exactly `W*scale × H*scale` and the artboard fills it via a
 * single transform on a wrapper the Motion Spec's selectors never target — so
 * the reel's and the film's pixel choreography stay exact at any viewport size.
 *
 * Availability is read from the parent layer, which is stretched to the stage's
 * definite height by the stylesheet. If the parent has not been laid out yet
 * there is nothing to fit into, so we wait for the ResizeObserver instead of
 * guessing a size.
 */

import { useEffect, useRef, type ReactNode } from "react";

interface ArtboardProps {
  /** Authoring width in px. */
  width: number;
  /** Authoring height in px. */
  height: number;
  frameClassName: string;
  artboardClassName: string;
  /** Custom property the stylesheet reads, e.g. `--bf-scale`. */
  scaleProperty: string;
  /** Stamped onto the frame so the Lab can detect a stale bundle. */
  stageVersion?: number;
  children: ReactNode;
}

export default function Artboard({
  width,
  height,
  frameClassName,
  artboardClassName,
  scaleProperty,
  stageVersion,
  children
}: ArtboardProps) {
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const apply = () => {
      const host = frame.parentElement;
      if (!host) return;
      const availW = host.clientWidth;
      const availH = host.clientHeight;
      // No measured box yet: leave the stylesheet's conservative default in
      // place rather than committing a wrong size that would need undoing.
      if (!availW || !availH) return;
      const scale = Math.min(availW / width, availH / height);
      frame.style.width = `${Math.round(width * scale)}px`;
      frame.style.height = `${Math.round(height * scale)}px`;
      frame.style.setProperty(scaleProperty, String(scale));
    };

    apply();
    const host = frame.parentElement;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", apply);
      return () => window.removeEventListener("resize", apply);
    }
    const observer = new ResizeObserver(apply);
    observer.observe(frame);
    // The host is what changes size (stage grows/shrinks); the frame is our own
    // output, so observing both would feed our own writes back into apply().
    if (host) observer.observe(host);

    /**
     * A stage that is hidden on first render (`display: none`, so the Lab has no
     * box to measure) never gets a ResizeObserver callback when it later becomes
     * visible: the observer was attached while the element had no box at all.
     * That left the film stuck at its CSS fallback size even though its host was
     * 1182x638. Watching the layer's `data-active` re-measures on exactly the
     * transition that changes whether a box exists.
     */
    const visibility = host
      ? new MutationObserver(() => {
          if (frame.offsetParent !== null) apply();
        })
      : null;
    if (host) visibility?.observe(host, { attributes: true, attributeFilter: ["data-active"] });

    return () => {
      observer.disconnect();
      visibility?.disconnect();
    };
  }, [scaleProperty, width, height]);

  return (
    <div className={frameClassName} ref={frameRef} data-stage-version={stageVersion}>
      <div className={artboardClassName} style={{ width, height }}>
        {children}
      </div>
    </div>
  );
}
