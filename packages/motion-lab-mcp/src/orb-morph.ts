/**
 * WAVES Orb Morph System — morph between visual states with the orb as the fundamental form.
 *
 * The orb is not just a decorative animation.
 * It is the underlying visual representation of WAVES intelligence.
 *
 * Transforms are actual shape transformations, not fade out + fade in.
 *
 * Supported transformations:
 * - ORB → SEARCH (disperse into particles with search intent)
 * - ORB → CRM (reorganize into table structure)
 * - ORB → NOTEBOOK (transform into research surface)
 * - ORB → WORKFLOW (rearrange into process chain)
 * - ORB → DATA (reconfigure into visualization)
 * - ORB → BROWSER (reshape into browser window)
 * - ORB → AGENT (reconfigure into agent interface)
 * - ORB → ORB (different configuration)
 */

export interface OrbMorphConfig {
  from: OrbState;
  to: OrbState;
  durationMs: number;
  easing: string;
  particles: number;
  particleSize: number;
  color: string;
}

export type OrbState =
  | { kind: "orb" }
  | { kind: "search" }
  | { kind: "crm" }
  | { kind: "notebook" }
  | { kind: "workflow" }
  | { kind: "data" }
  | { kind: "browser" }
  | { kind: "agent" };

export interface OrbMorphAnimation {
  target: string;
  properties: Record<string, string | number>;
  options: {
    duration?: number;
    delay?: number;
    easing?: string;
    stagger?: number;
  };
}

/**
 * Calculate morph path between two orb states.
 */
export function calculateMorphPath(from: OrbState, to: OrbState): OrbMorphAnimation[] {
  if (from.kind === to.kind) {
    return createOrbConfiguration(from as OrbState);
  }

  // Orb is the common intermediate state
  const fromMorph = createOrbConfiguration(from);
  const toMorph = createOrbConfiguration(to);

  // Combine with proper timing
  const animations: OrbMorphAnimation[] = [];

  // First phase: transform from current state to orb base
  for (const anim of fromMorph) {
    animations.push({
      ...anim,
      options: {
        ...anim.options,
        duration: anim.options.duration ?? 600,
        easing: anim.options.easing ?? "waves-smooth"
      }
    });
  }

  // Second phase: morph to target state
  const targetStartDelay = fromMorph.reduce((max, anim) => {
    const duration = anim.options.duration ?? 600;
    const delay = anim.options.delay ?? 0;
    const stagger = anim.options.stagger ?? 0;
    return Math.max(max, delay + duration + stagger * 4);
  }, 0);

  for (const anim of toMorph) {
    animations.push({
      ...anim,
      options: {
        ...anim.options,
        duration: anim.options.duration ?? 600,
        delay: (anim.options.delay ?? 0) + targetStartDelay,
        easing: anim.options.easing ?? "waves-smooth"
      }
    });
  }

  return animations;
}

/**
 * Create base orb configuration animation.
 */
function createOrbConfiguration(state: OrbState): OrbMorphAnimation[] {
  const animations: OrbMorphAnimation[] = [];

  switch (state.kind) {
    case "orb": {
      // Base orb: radial distribution, spiral pattern
      animations.push({
        target: "--orb-radius",
        properties: { value: "46px" },
        options: { duration: 400, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-spiral",
        properties: { value: "2.399963" },
        options: { duration: 400, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-particle-count",
        properties: { value: 72 },
        options: { duration: 400, easing: "waves-smooth" }
      });
      break;
    }

    case "search": {
      // Search: dispersed particles with radial search pattern
      animations.push({
        target: "--orb-radius",
        properties: { value: "60px" },
        options: { duration: 500, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-particle-count",
        properties: { value: 120 },
        options: { duration: 500, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-mode",
        properties: { value: "search" },
        options: { duration: 500, easing: "waves-smooth" }
      });
      break;
    }

    case "crm": {
      // CRM: organize into table grid
      animations.push({
        target: "--orb-layout",
        properties: { value: "grid" },
        options: { duration: 600, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-columns",
        properties: { value: 4 },
        options: { duration: 600, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-row-height",
        properties: { value: 48 },
        options: { duration: 600, easing: "waves-smooth" }
      });
      break;
    }

    case "notebook": {
      // Notebook: arrange into research surface
      animations.push({
        target: "--orb-layout",
        properties: { value: "list" },
        options: { duration: 600, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-item-height",
        properties: { value: 64 },
        options: { duration: 600, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-item-gap",
        properties: { value: 16 },
        options: { duration: 600, easing: "waves-smooth" }
      });
      break;
    }

    case "workflow": {
      // Workflow: chain structure
      animations.push({
        target: "--orb-layout",
        properties: { value: "chain" },
        options: { duration: 600, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-chain-items",
        properties: { value: 6 },
        options: { duration: 600, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-chain-gap",
        properties: { value: 32 },
        options: { duration: 600, easing: "waves-smooth" }
      });
      break;
    }

    case "data": {
      // Data: visualization chart
      animations.push({
        target: "--orb-layout",
        properties: { value: "chart" },
        options: { duration: 600, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-chart-type",
        properties: { value: "bar" },
        options: { duration: 600, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-data-series",
        properties: { value: 5 },
        options: { duration: 600, easing: "waves-smooth" }
      });
      break;
    }

    case "browser": {
      // Browser: window structure
      animations.push({
        target: "--orb-layout",
        properties: { value: "window" },
        options: { duration: 600, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-window-height",
        properties: { value: 600 },
        options: { duration: 600, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-window-width",
        properties: { value: 900 },
        options: { duration: 600, easing: "waves-smooth" }
      });
      break;
    }

    case "agent": {
      // Agent: interface with input/output
      animations.push({
        target: "--orb-layout",
        properties: { value: "agent" },
        options: { duration: 600, easing: "waves-smooth" }
      });
      animations.push({
        target: "--orb-agent-mode",
        properties: { value: "chat" },
        options: { duration: 600, easing: "waves-smooth" }
      });
      break;
    }
  }

  return animations;
}

/**
 * Create morph sequence for animation planning.
 */
export function createMorphSequence(
  from: OrbState,
  to: OrbState,
  startTime: number,
  duration: number
) {
  const animations = calculateMorphPath(from, to);
  let currentTime = startTime;

  return animations.map((anim, index) => {
    const thisDuration = anim.options.duration ?? 400;
    const stagger = anim.options.stagger ?? 0;
    const totalSpan = thisDuration + stagger * 4;

    return {
      ...anim,
      options: {
        ...anim.options,
        delay: currentTime + (anim.options.delay ?? 0)
      }
    };
  });
}
