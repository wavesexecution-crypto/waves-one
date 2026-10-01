/**
 * SEAI launch reel — the stage. 1080×1920 (9:16), five labelled scenes, 15s.
 *
 * Pure presentation: no CSS animation, no keyframes. Every visible change is a
 * GSAP op in `seai-launch-reel.ts` targeting a selector in this markup.
 *
 * VISUAL SOURCE OF TRUTH — the real SEAI project, not a reconstruction:
 *   - `apps/motion-lab/public/assets/seai-demos/*.png` are screenshots of the
 *     actual `D:\seai.public\dist/examples/<vertical>.html` pages, captured in
 *     Chromium at this exact artboard size by
 *     `scripts/capture-seai-demos.mjs`. Seven verticals, hero + detail each.
 *   - Typography is SEAI's own three families, self-hosted from the project:
 *     Inter (display/body), Instrument Serif (editorial italic), JetBrains Mono
 *     (eyebrows, labels, stats).
 *   - Type scale, tracking, colour roles and the single easing curve follow
 *     `public/demo.css` in the SEAI project.
 *
 * Copy provenance: the reel's own script, plus SEAI's real positioning
 * ("AI-built websites for real businesses"). No invented metrics, no pricing,
 * no testimonials — the demo cards are SEAI's own example builds, shown as the
 * work, not as claims about the service.
 */

import Artboard from "./Artboard";
import "./seai-reel.css";

export const SEAI_REEL_W = 1080;
export const SEAI_REEL_H = 1920;

/** Bump when the markup below changes shape; the Lab reloads a stale bundle. */
export const SEAI_REEL_STAGE_VERSION = 2;

/** The seven verticals SEAI actually ships, in the order the reel runs them. */
const DEMOS = [
  { key: "restaurant", label: "RESTAURANT" },
  { key: "gym", label: "GYM" },
  { key: "salon", label: "SALON" },
  { key: "clinic", label: "CLINIC" },
  { key: "real-estate", label: "REAL ESTATE" },
  { key: "cafe", label: "CAFE" },
  { key: "business", label: "BUSINESS" }
] as const;

export default function SeaiLaunchReel() {
  return (
    <Artboard
      width={SEAI_REEL_W}
      height={SEAI_REEL_H}
      frameClassName="sr-frame"
      artboardClassName="sr-artboard"
      scaleProperty="--sr-scale"
      stageVersion={SEAI_REEL_STAGE_VERSION}
    >
      <div className="sr-vignette" aria-hidden="true" />

      {/* Persistent chrome, in SEAI's own vocabulary: a hairline rule, a mono
          progress rail, and the wordmark's baseline tick. */}
      <span className="sr-hair sr-hair-top" aria-hidden="true" />
      <span className="sr-progress" aria-hidden="true" />
      <span className="sr-corner" aria-hidden="true" />

      {/* 01 intro -------------------------------------------------------- */}
      <section className="sr-scene sr-s-intro">
        <img className="sr-logo" src="/assets/seai-brand/logo.svg" alt="SEAI" data-split="sr-logo" />
        <h1 className="sr-statement">
          <span className="sr-statement-line" data-split="sr-statement-a">YOUR BUSINESS</span>
          <span className="sr-statement-line sr-statement-sub" data-split="sr-statement-b">NEEDS A WEBSITE.</span>
        </h1>
        <span className="sr-rule" aria-hidden="true" />
        <span className="sr-eyebrow sr-eyebrow-center">AI-BUILT WEBSITES</span>
      </section>

      {/* 02 ai-build ------------------------------------------------------ */}
      <section className="sr-scene sr-s-ai">
        <h2 className="sr-claim">
          <span className="sr-claim-line" data-split="sr-claim-a">WE BUILD IT.</span>
          <span className="sr-claim-line sr-claim-2" data-split="sr-claim-b">WITH <em>AI</em>.</span>
        </h2>
        <span className="sr-rule sr-rule-wide" aria-hidden="true" />
      </section>

      {/* 03 showcase — the real SEAI demo sites --------------------------- */}
      <section className="sr-scene sr-s-showcase">
        <span className="sr-eyebrow sr-scene-tag">REAL SITES · BUILT BY SEAI</span>
        <div className="sr-rail">
          {DEMOS.map((demo) => (
            <figure className="sr-shot" key={demo.key} data-demo={demo.key}>
              <img
                className="sr-shot-img"
                src={`/assets/seai-demos/${demo.key}-hero.png`}
                alt={`SEAI ${demo.label.toLowerCase()} website`}
                decoding="async"
              />
              <figcaption className="sr-shot-cap">
                <span className="sr-shot-label">{demo.label}</span>
                <span className="sr-shot-dot" aria-hidden="true" />
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      {/* 04 capabilities -------------------------------------------------- */}
      <section className="sr-scene sr-s-caps">
        <div className="sr-pillars">
          <span className="sr-pillar" data-split="sr-cap-design">DESIGN.</span>
          <span className="sr-pillar" data-split="sr-cap-code">CODE.</span>
          <span className="sr-pillar" data-split="sr-cap-content">CONTENT.</span>
          <span className="sr-pillar" data-split="sr-cap-seo">SEO.</span>
        </div>
        <h2 className="sr-one" data-split="sr-one">ONE WEBSITE.</h2>
      </section>

      {/* 05 final — a real finished site, then the lockup ----------------- */}
      <section className="sr-scene sr-s-final">
        <div className="sr-plate">
          <img className="sr-plate-img" src="/assets/seai-demos/cafe-hero.png" alt="SEAI cafe website" decoding="async" />
          <div className="sr-plate-depth" aria-hidden="true" />
        </div>
        <h2 className="sr-built">
          <span className="sr-built-line" data-split="sr-built-a">BUILT FOR</span>
          <span className="sr-built-line sr-built-2" data-split="sr-built-b">YOUR BUSINESS.</span>
        </h2>

        <div className="sr-lockup">
          <img className="sr-lockup-logo" src="/assets/seai-brand/logo.svg" alt="SEAI" data-split="sr-lock-logo" />
          <p className="sr-lockup-tag" data-split="sr-lock-tag">AI-BUILT WEBSITES.</p>
          <span className="sr-cta" data-split="sr-lock-cta">
            <span className="sr-cta-text">BUILD YOURS</span>
            <span className="sr-cta-arrow">→</span>
          </span>
        </div>
      </section>
    </Artboard>
  );
}