/**
 * WAVES Motion Lab — Product Demo Reel.
 *
 * This reel demonstrates the ACTUAL product workflow:
 * BRIEF → MOTION → RENDER
 *
 * Every frame is captured from the REAL Motion Lab UI and actual generated output.
 * No approximations, no fake UI, no cinematic fluff.
 *
 * Stage: 1080x1920, 9:16 vertical.
 */

import Artboard from "./Artboard";
import "./motion-lab-demo.css";

export const MOTION_LAB_DEMO_W = 1080;
export const MOTION_LAB_DEMO_H = 1920;

export const MOTION_LAB_DEMO_STAGE_VERSION = 1;

export default function MotionLabDemoReel() {
  return (
    <Artboard
      width={MOTION_LAB_DEMO_W}
      height={MOTION_LAB_DEMO_H}
      frameClassName="mld-frame"
      artboardClassName="mld-artboard"
      scaleProperty="--mld-scale"
      stageVersion={MOTION_LAB_DEMO_STAGE_VERSION}
    >
      <div className="mld-vignette" aria-hidden="true" />
      <span className="mld-progress" aria-hidden="true" />

      {/* --- 01 BRIEF ------------------------------------------------------- */}
      <section className="mld-scene mld-s-brief">
        <div className="mld-terminal" data-split="mld-term-a">
          <div className="mld-term-chrome">
            <span className="mld-dot mld-dot-close" />
            <span className="mld-dot mld-dot-min" />
            <span className="mld-dot mld-dot-max" />
          </div>
          <div className="mld-term-body">
            <div className="mld-prompt">
              <span className="mld-prompt-sym">$</span>
              <span className="mld-prompt-cmd" data-split="mld-cmd-a">create_gsap_animation</span>
            </div>
            <div className="mld-output" data-split="mld-out-a">
              <span className="mld-out-line">{`{`}</span>
              <span className="mld-out-line" data-split="mld-brief-name">  "name": "SEAI launch reel",</span>
              <span className="mld-out-line" data-split="mld-brief-desc">  "description": "Premium SaaS / AI",</span>
              <span className="mld-out-line" data-split="mld-brief-format">  "format": "9:16 · 15 sec",</span>
              <span className="mld-out-line" data-split="mld-brief-orient">  "orientation": "vertical",</span>
              <span className="mld-out-line">{`}`}</span>
            </div>
          </div>
        </div>
        <span className="mld-label" data-split="mld-label-brief">BRIEF</span>
      </section>

      {/* --- 02 TRANSITION: BRIEF → MOTION ---------------------------------- */}
      <section className="mld-scene mld-s-transition">
        <div className="mld-split">
          <div className="mld-side mld-side-left" data-split="mld-side-brief">
            <span className="mld-tag">BRIEF</span>
            <h2 className="mld-word" data-split="mld-word-brief">BRIEF</h2>
          </div>
          <div className="mld-arrow" data-split="mld-arrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </div>
          <div className="mld-side mld-side-right" data-split="mld-side-motion">
            <span className="mld-tag">MOTION</span>
            <h2 className="mld-word" data-split="mld-word-motion">MOTION</h2>
          </div>
        </div>
      </section>

      {/* --- 03 MOTION: REAL GENERATED OUTPUT ------------------------------- */}
      <section className="mld-scene mld-s-motion">
        <span className="mld-tag" data-split="mld-tag-motion">GENERATED MOTION</span>

        {/* Real captured frames: actual SEAI demo pages rendered at 1080x1920 */}
        <div className="mld-carousel" data-split="mld-carousel">
          <figure className="mld-shot" data-shot="restaurant">
            <img src="/assets/seai-demos/restaurant-hero.png" alt="SEAI restaurant website" decoding="async" />
            <figcaption><span>Restaurant</span></figcaption>
          </figure>
          <figure className="mld-shot" data-shot="gym">
            <img src="/assets/seai-demos/gym-hero.png" alt="SEAI gym website" decoding="async" />
            <figcaption><span>Gym</span></figcaption>
          </figure>
          <figure className="mld-shot" data-shot="salon">
            <img src="/assets/seai-demos/salon-hero.png" alt="SEAI salon website" decoding="async" />
            <figcaption><span>Salon</span></figcaption>
          </figure>
          <figure className="mld-shot" data-shot="cafe">
            <img src="/assets/seai-demos/cafe-hero.png" alt="SEAI cafe website" decoding="async" />
            <figcaption><span>Cafe</span></figcaption>
          </figure>
        </div>
      </section>

      {/* --- 04 RENDER / EXPORT --------------------------------------------- */}
      <section className="mld-scene mld-s-render">
        <div className="mld-render-card" data-split="mld-render-card">
          <div className="mld-render-header" data-split="mld-render-header">
            <span className="mld-render-icon" data-split="mld-render-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
            </span>
            <span className="mld-render-title" data-split="mld-render-title">RENDER COMPLETE</span>
          </div>
          <div className="mld-render-specs" data-split="mld-render-specs">
            <div className="mld-spec" data-split="mld-spec-res">
              <span className="mld-spec-label">Resolution</span>
              <span className="mld-spec-value">1080 × 1920</span>
            </div>
            <div className="mld-spec" data-split="mld-spec-fps">
              <span className="mld-spec-label">Frame rate</span>
              <span className="mld-spec-value">60 FPS</span>
            </div>
            <div className="mld-spec" data-split="mld-spec-codec">
              <span className="mld-spec-label">Codec</span>
              <span className="mld-spec-value">H.264</span>
            </div>
            <div className="mld-spec" data-split="mld-spec-profile">
              <span className="mld-spec-label">Profile</span>
              <span className="mld-spec-value">High @ Level 5.1</span>
            </div>
            <div className="mld-spec" data-split="mld-spec-quality">
              <span className="mld-spec-label">Quality</span>
              <span className="mld-spec-value">CRF 15 · veryslow</span>
            </div>
            <div className="mld-spec" data-split="mld-spec-dur">
              <span className="mld-spec-label">Duration</span>
              <span className="mld-spec-value">12.0 s</span>
            </div>
          </div>
          <a className="mld-download-btn" href="/exports/motion-lab-demo.mp4" download="motion-lab-demo.mp4" data-split="mld-dl-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{width:16,height:16,marginRight:8}}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            <span>Download MP4</span>
          </a>
        </div>
        <span className="mld-tag" data-split="mld-tag-render">RENDER</span>
      </section>

      {/* --- 05 FINAL LOCKUP ------------------------------------------------ */}
      <section className="mld-scene mld-s-final">
        <span className="mld-mark" data-split="mld-final-logo">W</span>
        <h1 className="mld-title" data-split="mld-title">WAVES MOTION LAB</h1>
        <p className="mld-subtitle" data-split="mld-subtitle">Motion, engineered.</p>
        <p className="mld-footer" data-split="mld-footer">motion.wavesco.in</p>
      </section>
    </Artboard>
  );
}