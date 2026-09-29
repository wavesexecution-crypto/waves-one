/**
 * Spring — the public surface of the Waves spring system.
 *
 * The house default (`stiffness: 210, damping: 29, mass: 1`) is essentially
 * critically damped: it lands with intent, with no visible bounce. Use
 * `waves.spring({...})` to retune per animation, and `SpringValue` when an
 * animation may be interrupted and must carry its velocity forward.
 */

export {
  createSpringEasing,
  describeSpring,
  normalizeSpring,
  sampleSpring,
  spring,
  springPhysics,
  springSettlingTime,
  springSparkline,
  springValuedAt,
  springVelocityAt,
  wavesSprings,
  OVERSHOOT_ZETA,
  type SpringPhysics,
  type SpringReport
} from "./physics";

export { SpringValue, normalizeVelocity, velocityFromDelta } from "./value";