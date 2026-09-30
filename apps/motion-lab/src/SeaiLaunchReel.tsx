/**
 * SEAI launch reel — the stage. 1080×1920 (9:16) artboard for Instagram / Reels /
 * TikTok, six labelled scenes, 15 seconds.
 *
 * Pure presentation, same rule as the brand film: no CSS animation, no keyframes,
 * nothing here that moves on its own. Every visible change is a GSAP op in
 * `seai-launch-reel.ts` targeting a plain selector in this markup.
 *
 * Copy provenance — nothing in this file is invented product marketing:
 *   - the hook, claim, four-pillar and lockup lines come from the reel brief
 *   - "AI-BUILT WEBSITES." and "BUILD YOURS →" match SEAI's own positioning
 *     (site title: "SEAI - AI-built websites for real businesses"; primary CTA:
 *     "Build my website →")
 *   - the four website cards are demonstration builds for fictional sample
 *     businesses. They are the deliverables being shown, not claims about SEAI:
 *     no testimonials, client counts, ratings, or performance figures appear
 *     anywhere in the reel.
 */

import Artboard from "./Artboard";
import "./seai-reel.css";

export const SEAI_REEL_W = 1080;
export const SEAI_REEL_H = 1920;

/** Bump whenever this markup changes shape; the Lab reloads once when the
 *  published spec and the loaded bundle disagree. */
export const SEAI_REEL_STAGE_VERSION = 1;

/** Browser chrome + nav + content blocks that make each card read as a real
 *  built website rather than a coloured rectangle. */
function SiteChrome({ name, kind }: { name: string; kind: string }) {
  return (
    <>
      <div className="sr-browser" aria-hidden="true">
        <span className="sr-dot" />
        <span className="sr-dot" />
        <span className="sr-dot" />
        <span className="sr-url">{name.toLowerCase().replace(/[^a-z]/g, "")}.com</span>
      </div>
      <div className="sr-site-nav">
        <span className="sr-site-brand">{name}</span>
        <span className="sr-site-links">
          <i />
          <i />
          <i />
        </span>
      </div>
    </>
  );
}

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

      {/* Persistent chrome: a hairline top/bottom frame and a live progress rail. */}
      <span className="sr-edge sr-edge-top" aria-hidden="true" />
      <span className="sr-edge sr-edge-bottom" aria-hidden="true" />
      <span className="sr-progress" aria-hidden="true" />
      <span className="sr-serial" aria-hidden="true">SEAI / BUILD</span>

      {/* 01 — HOOK */}
      <section className="sr-scene sr-s1">
        <span className="sr-kicker">SEAI</span>
        <h2 className="sr-headline">
          <span className="sr-line" data-split="sr-hook-a">YOUR BUSINESS</span>
          <span className="sr-line sr-line-2" data-split="sr-hook-b">NEEDS A WEBSITE.</span>
        </h2>
        <span className="sr-underline" aria-hidden="true" />
      </section>

      {/* 02 — CLAIM */}
      <section className="sr-scene sr-s2">
        <h2 className="sr-claim">
          <span className="sr-line" data-split="sr-claim-a">WE BUILD IT.</span>
          <span className="sr-line sr-claim-2" data-split="sr-claim-b">WITH AI.</span>
        </h2>
        <span className="sr-underline sr-underline-wide" aria-hidden="true" />
      </section>

      {/* 03 — WORK: four built sites on a masked, continuously moving rail */}
      <section className="sr-scene sr-s3">
        <span className="sr-scene-tag">BUILT SITES</span>
        <div className="sr-rail">
          <article className="sr-card" data-site="restaurant">
            <SiteChrome name="Forno" kind="restaurant" />
            <div className="sr-card-hero">
              <span className="sr-card-eyebrow">EST. 1994</span>
              <h3 className="sr-card-title">WOOD FIRE<br />KITCHEN</h3>
              <span className="sr-card-cta">BOOK A TABLE</span>
            </div>
            <div className="sr-card-row">
              <span className="sr-tile" />
              <span className="sr-tile" />
              <span className="sr-tile" />
            </div>
          </article>

          <article className="sr-card" data-site="gym">
            <SiteChrome name="Ironworks" kind="gym" />
            <div className="sr-card-hero">
              <span className="sr-card-eyebrow">STRENGTH / CONDITIONING</span>
              <h3 className="sr-card-title">IRON<br />WORKS</h3>
              <span className="sr-card-cta">FREE FIRST SESSION</span>
            </div>
            <div className="sr-card-metrics">
              <span><b>06</b>DAYS</span>
              <span><b>05</b>AM OPEN</span>
            </div>
          </article>

          <article className="sr-card" data-site="salon">
            <SiteChrome name="Lumen" kind="salon" />
            <div className="sr-card-hero">
              <span className="sr-card-eyebrow">HAIR / SKIN / NAILS</span>
              <h3 className="sr-card-title">LUMEN<br />SALON</h3>
              <span className="sr-card-cta">APPOINTMENTS</span>
            </div>
            <div className="sr-card-row">
              <span className="sr-tile sr-tile-tall" />
              <span className="sr-tile" />
            </div>
          </article>

          <article className="sr-card" data-site="estate">
            <SiteChrome name="North &amp; Key" kind="estate" />
            <div className="sr-card-hero">
              <span className="sr-card-eyebrow">SALES / LETTINGS</span>
              <h3 className="sr-card-title">NORTH<br />&amp; KEY</h3>
              <span className="sr-card-cta">VIEW LISTINGS</span>
            </div>
            <div className="sr-card-list">
              <span className="sr-listing"><i /><b>3 BED</b><em>SEMI — LET</em></span>
              <span className="sr-listing"><i /><b>2 BED</b><em>FLAT — SALE</em></span>
            </div>
          </article>
        </div>
      </section>

      {/* 04 — SYSTEM: four pillars, then collapse into one */}
      <section className="sr-scene sr-s4">
        <div className="sr-pillars">
          <span className="sr-pillar" data-split="sr-p1">DESIGN.</span>
          <span className="sr-pillar" data-split="sr-p2">CODE.</span>
          <span className="sr-pillar" data-split="sr-p3">CONTENT.</span>
          <span className="sr-pillar" data-split="sr-p4">SEO.</span>
        </div>
        <h2 className="sr-one" data-split="sr-one">ONE WEBSITE.</h2>
      </section>

      {/* 05 — RESULT: one finished site taking the whole screen */}
      <section className="sr-scene sr-s5">
        <div className="sr-site">
          <div className="sr-browser" aria-hidden="true">
            <span className="sr-dot" />
            <span className="sr-dot" />
            <span className="sr-dot" />
            <span className="sr-url">forno.com</span>
          </div>
          <div className="sr-site-nav">
            <span className="sr-site-brand">Forno</span>
            <span className="sr-site-links"><i /><i /><i /></span>
          </div>
          <div className="sr-site-hero">
            <span className="sr-card-eyebrow" data-depth="1">EST. 1994</span>
            <h3 className="sr-site-title" data-depth="2">WOOD FIRE<br />KITCHEN</h3>
            <span className="sr-site-cta" data-depth="3">BOOK A TABLE</span>
          </div>
          <div className="sr-site-strip" data-depth="4">
            <span className="sr-tile" />
            <span className="sr-tile" />
            <span className="sr-tile" />
          </div>
        </div>
        <h2 className="sr-built">
          <span className="sr-line" data-split="sr-built-a">BUILT FOR</span>
          <span className="sr-line sr-built-2" data-split="sr-built-b">YOUR BUSINESS.</span>
        </h2>
      </section>

      {/* 06 — LOCKUP */}
      <section className="sr-scene sr-s6">
        <div className="sr-lockup">
          <h2 className="sr-logo" data-split="sr-logo">SEAI</h2>
          <p className="sr-tagline" data-split="sr-tag">AI-BUILT WEBSITES.</p>
          <span className="sr-cta" data-split="sr-cta">
            <span className="sr-cta-text">BUILD YOURS</span>
            <span className="sr-cta-arrow">→</span>
          </span>
        </div>
      </section>
    </Artboard>
  );
}
