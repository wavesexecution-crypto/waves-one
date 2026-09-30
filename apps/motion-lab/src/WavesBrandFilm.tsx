/**
 * WAVES brand film — the stage. Pure presentation: fixed 1600×900 artboard,
 * every node a plain target for the Motion Spec's selectors. No CSS animation
 * and no keyframes here — GSAP owns all motion; CSS only owns layout and type.
 *
 * Sizing is delegated to the shared `Artboard`, so this film and the 9:16 SEAI
 * reel are scaled by one rule instead of two hand-rolled ResizeObservers.
 */

import Artboard from "./Artboard";
import "./brand-film.css";

const ARTBOARD_W = 1600;
const ARTBOARD_H = 900;

/**
 * Bump whenever the markup below changes shape. The publisher stamps the spec
 * with this value; the Lab compares it against its own bundle and reloads
 * once when they disagree, so a tab left open across a deploy self-heals
 * instead of dying on GSAP_TARGET_MISSING.
 */
export const BRAND_FILM_STAGE_VERSION = 2;

const SCENES = [
  { id: "s1", label: "IDENTITY" },
  { id: "s2", label: "COMPANY" },
  { id: "s3", label: "ECOSYSTEM" },
  { id: "s4", label: "WAVES ONE" },
  { id: "s5", label: "SEAI" },
  { id: "s6", label: "WAVES MOTION" },
  { id: "s7", label: "CONVERGENCE" },
  { id: "s8", label: "LOCKUP" }
] as const;

export default function WavesBrandFilm() {
  return (
    <Artboard
      width={ARTBOARD_W}
      height={ARTBOARD_H}
      frameClassName="bf-frame"
      artboardClassName="bf-artboard"
      scaleProperty="--bf-scale"
      stageVersion={BRAND_FILM_STAGE_VERSION}
    >
        <div className="bf-vignette" />
        <div className="bf-halo" />

        {/* frame furniture — present for the whole film */}
        <span className="bf-corner bf-corner-tl" />
        <span className="bf-corner bf-corner-tr" />
        <span className="bf-corner bf-corner-bl" />
        <span className="bf-corner bf-corner-br" />

        {/* the wordmark persists across scenes: hero, corner mark, hero again */}
        <div className="bf-wordmark">WAVES</div>

        <div className="bf-scene bf-scene-1">
          <div className="bf-rule bf-rule-1" />
          <div className="bf-s1-sub">SYSTEMS THAT MOVE BUSINESSES</div>
        </div>

        <div className="bf-scene bf-scene-2">
          <div className="bf-s2-label">01 / THE COMPANY</div>
          <div className="bf-statement">WAVES builds systems that run businesses.</div>
          <div className="bf-rule bf-rule-2" />
        </div>

        {/* one connected ecosystem: hub, spine, and three tapped products */}
        <div className="bf-scene bf-scene-3">
          <div className="bf-eco-label">02 / ECOSYSTEM</div>
          <div className="bf-hub">
            <span className="bf-hub-mark">W</span>
          </div>
          <div className="bf-spine" />
          <div className="bf-bus" />
          <div className="bf-tap bf-tap-1" />
          <div className="bf-tap bf-tap-2" />
          <div className="bf-tap bf-tap-3" />
          <span className="bf-pulse bf-pulse-1" />
          <span className="bf-pulse bf-pulse-2" />
          <span className="bf-pulse bf-pulse-3" />
          <div className="bf-node bf-node-1">
            <div className="bf-node-name">WAVES ONE</div>
            <div className="bf-node-role">Command center</div>
          </div>
          <div className="bf-node bf-node-2">
            <div className="bf-node-name">WAVES Motion</div>
            <div className="bf-node-role">Motion intelligence</div>
          </div>
          <div className="bf-node bf-node-3">
            <div className="bf-node-name">SEAI</div>
            <div className="bf-node-role">AI-built websites</div>
          </div>
        </div>

        <div className="bf-scene bf-scene-4">
          <div className="bf-one-label">03 / WAVES ONE</div>
          <div className="bf-one-panel">
            <div className="bf-one-line">Think.</div>
            <div className="bf-one-line">Command.</div>
            <div className="bf-one-line">Execute.</div>
            <div className="bf-console">
              <div className="bf-console-bar">
                <span className="bf-console-dot" />
                <span className="bf-console-dot" />
                <span className="bf-console-dot" />
                <span className="bf-console-label">waves-one · ops</span>
              </div>
              <div className="bf-console-rows">
                <span className="bf-console-row" />
                <span className="bf-console-row" />
                <span className="bf-console-row" />
                <span className="bf-console-row" />
              </div>
              <div className="bf-scan" />
              <span className="bf-caret" />
            </div>
          </div>
        </div>

        {/* SEAI as a real page assembling itself, not a floating card */}
        <div className="bf-scene bf-scene-5">
          <div className="bf-seai-label">04 / SEAI</div>
          <div className="bf-web">
            <div className="bf-web-bar">
              <span className="bf-web-dot" />
              <span className="bf-web-dot" />
              <span className="bf-web-dot" />
              <div className="bf-web-url">seai.build</div>
            </div>
            <div className="bf-web-nav">
              <span className="bf-web-nav-item">Product</span>
              <span className="bf-web-nav-item">Work</span>
              <span className="bf-web-nav-item">Pricing</span>
              <span className="bf-web-nav-item">Contact</span>
            </div>
            <div className="bf-web-hero">
              <div className="bf-web-hero-line bf-web-hero" />
              <div className="bf-web-hero-line bf-web-hero bf-web-hero-short" />
              <div className="bf-web-copy" />
            </div>
            <div className="bf-web-cards">
              <div className="bf-web-card">
                <div className="bf-web-card-bar" />
                <div className="bf-web-card-line" />
              </div>
              <div className="bf-web-card">
                <div className="bf-web-card-bar" />
                <div className="bf-web-card-line" />
              </div>
              <div className="bf-web-card">
                <div className="bf-web-card-bar" />
                <div className="bf-web-card-line" />
              </div>
            </div>
            <div className="bf-web-progress">
              <div className="bf-web-prog" />
            </div>
          </div>
          <div className="bf-seai-lines">
            <div className="bf-seai-line">AI builds.</div>
            <div className="bf-seai-line">Websites ship.</div>
            <div className="bf-seai-line">Businesses launch.</div>
          </div>
        </div>

        {/* WAVES Motion: each concept is demonstrated by real GSAP motion */}
        <div className="bf-scene bf-scene-6">
          <div className="bf-motion-label">05 / WAVES MOTION</div>
          <div className="bf-motion-title">Motion, engineered.</div>
          <div className="bf-demos">
            <div className="bf-demo">
              <div className="bf-d-label">GSAP TIMELINE</div>
              <div className="bf-d1">
                <div className="bf-d1-track" />
                <span className="bf-d1-tick" />
                <span className="bf-d1-tick" />
                <span className="bf-d1-tick" />
                <span className="bf-d1-tick" />
                <span className="bf-d1-tick" />
                <span className="bf-d1-head" />
              </div>
            </div>
            <div className="bf-demo">
              <div className="bf-d-label">TEXT REVEAL</div>
              <div className="bf-d2">
                <div className="bf-d2-word">WAVES</div>
              </div>
            </div>
            <div className="bf-demo">
              <div className="bf-d-label">STAGGER</div>
              <div className="bf-d3">
                <span className="bf-d3-bar" />
                <span className="bf-d3-bar" />
                <span className="bf-d3-bar" />
                <span className="bf-d3-bar" />
                <span className="bf-d3-bar" />
              </div>
            </div>
            <div className="bf-demo">
              <div className="bf-d-label">PARALLAX</div>
              <div className="bf-d4">
                <span className="bf-d4-layer bf-d4-layer-1" />
                <span className="bf-d4-layer bf-d4-layer-2" />
                <span className="bf-d4-layer bf-d4-layer-3" />
              </div>
            </div>
            <div className="bf-demo">
              <div className="bf-d-label">SPRING</div>
              <div className="bf-d5">
                <span className="bf-d5-dot" />
              </div>
            </div>
            <div className="bf-demo">
              <div className="bf-d-label">SCROLL MOTION</div>
              <div className="bf-d6">
                <div className="bf-d6-inner">
                  <span className="bf-d6-row" />
                  <span className="bf-d6-row" />
                  <span className="bf-d6-row" />
                  <span className="bf-d6-row" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* convergence: three products travel into one mark */}
        <div className="bf-scene bf-scene-7">
          <div className="bf-con-label">06 / ONE SYSTEM</div>
          <div className="bf-con bf-con-1">WAVES ONE</div>
          <div className="bf-plus bf-plus-1">+</div>
          <div className="bf-con bf-con-2">SEAI</div>
          <div className="bf-plus bf-plus-2">+</div>
          <div className="bf-con bf-con-3">WAVES Motion</div>
          <div className="bf-con-core" />
        </div>

        <div className="bf-scene bf-scene-8">
          <div className="bf-tagline">Systems that move.</div>
          <div className="bf-rule bf-rule-3" />
          <div className="bf-meta">
            <span>WAVES ONE</span>
            <span>SEAI</span>
            <span>WAVES MOTION</span>
          </div>
        </div>

        {/* scene readout + the 19s progress hairline that is the timeline */}
        <div className="bf-readout">
          {SCENES.map((scene, index) => (
            <div className={`bf-num bf-num-${index + 1}`} key={scene.id}>
              <span className="bf-num-index">0{index + 1}</span>
              <span className="bf-num-label">{scene.label}</span>
            </div>
          ))}
        </div>
        <div className="bf-progress" />
    </Artboard>
  );
}
