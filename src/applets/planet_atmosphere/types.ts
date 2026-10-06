export type GasMode = "box" | "planet";

export type PlanetPresetId = "big_planet" | "small_planet" | "hot_gas" | "small_cold";

/**
 * Sim units: particle mass m = 1 and k_B = 1, so in 2D the temperature is the
 * mean kinetic energy per particle, T = <v²>/2, and the most probable speed is √T.
 */
export type GasSettings = {
  mode: GasMode;
  temperature: number;
  count: number;
  /** Planet mass relative to the default planet; the planet radius is fixed. */
  planetMass: number;
  /**
   * Planet mode: when true the surface re-emits particles with thermal speeds at
   * `temperature` (a sun-warmed ground); when false it reflects them elastically.
   */
  warmGround: boolean;
};

export type GasStats = {
  simTime: number;
  /**
   * Measured from particle speeds (planet mode: gas near the ground only), not the slider
   * value, and smoothed over ~0.6 sim seconds so the readout doesn't flicker.
   */
  temperature: number;
  meanSpeed: number;
  /** Particles included in temperature, mean speed and the speed histogram. */
  measuredCount: number;
  /** Particles drawn in the frame; in planet mode bound particles can be off-screen. */
  visibleCount: number;
  /** Box mode: measured wall force per unit length; null until enough hits are averaged. */
  pressure: number | null;
  escaped: number;
  /** Bound particles / (bound + escaped). */
  keptFraction: number;
  /** Escape speed from the planet surface (planet mode). */
  escapeSpeed: number;
};

export type TrailPoint = { x: number; y: number };

/** Typed arrays are reused between frames: read them during render, don't keep them. */
export type GasSnapshot = {
  mode: GasMode;
  count: number;
  x: Float64Array;
  y: Float64Array;
  speed: Float32Array;
  /** Planet mode: 1 when the particle moves faster than the escape speed at its height. */
  canEscape: Uint8Array;
  /** 1 when the particle counts toward the temperature readout and histogram. */
  measured: Uint8Array;
  particleRadius: number;
  tracerIndex: number;
  tracerEscaped: boolean;
  trail: TrailPoint[];
  planetRadius: number;
  planetMass: number;
  gm: number;
  stats: GasStats;
};
