import { gaussian } from "./random";
import type { WindSettings } from "./types";

/**
 * Solar wind for planet mode: light, fast, charged particles streaming in from the Sun's side
 * (the left). They feel the planet's gravity and, with the field on, its magnetic field; they never
 * hit each other (the real wind is nearly collisionless). Hits on the gas are handled in sim.ts.
 */

/** In units of the gas particle mass. Real wind protons are 14–32× lighter than N, O, N₂ and O₂. */
export const WIND_MASS = 0.1;
export const WIND_PARTICLE_R = 0.012;
/**
 * Centre distance at which a wind particle hits a gas particle. Smaller than the gas–gas contact
 * distance (0.04), as a proton's cross-section on a molecule is smaller than two molecules' on each
 * other; it also lets the stream be dense enough to see at a modest hit rate.
 */
export const WIND_HIT_DISTANCE = 0.01;
/** Points of recent path kept per particle for drawing, one every WIND_TRAIL_INTERVAL sim seconds. */
export const WIND_TRAIL_POINTS = 14;
export const WIND_TRAIL_INTERVAL = 0.004;

export const WIND_SPEED_MIN = 10;
export const WIND_SPEED_MAX = 36;
/**
 * A head-on hit gives a gas particle 2m/(m + M) ≈ 0.18 of the wind speed: 4.7 at this speed, above
 * the Mars preset's escape speed (4.0) and below the Earth preset's (6.3).
 */
export const WIND_SPEED_DEFAULT = 26;
export const WIND_DENSITY_MIN = 0.25;
export const WIND_DENSITY_MAX = 4;
export const WIND_DENSITY_DEFAULT = 1;
export const FIELD_STRENGTH_MIN = 0.2;
export const FIELD_STRENGTH_MAX = 3;
export const FIELD_STRENGTH_DEFAULT = 1;

export const WIND_DEFAULTS: WindSettings = {
  on: false,
  speed: WIND_SPEED_DEFAULT,
  density: WIND_DENSITY_DEFAULT,
  field: false,
  fieldStrength: FIELD_STRENGTH_DEFAULT
};

/**
 * In the equatorial plane of a dipole, no charge arriving from far away gets closer to the centre
 * than (√2 − 1) Störmer lengths, C = √(q·B₀·R³ / (m·v)) with B₀ the field at the surface.
 */
export const SHIELD_PER_STORMER = Math.SQRT2 - 1;
/** Shielded radius, in planet radii, at 1× field strength and the default wind speed. */
const SHIELD_R_REF = 1.45;
const STORMER_REF = SHIELD_R_REF / SHIELD_PER_STORMER;

/**
 * Incoming wind particles per unit area at density 1×. Kept modest: a stronger stream hits a kicked
 * particle again before it falls back, and then strips even the Earth preset without a field.
 */
const PER_AREA = 1;
/** Spread of the incoming velocities as a fraction of the wind speed (the real wind is cold for its speed). */
const SPREAD = 0.04;
const CAPACITY = 8000;
/** Far from the frame a particle is advanced on its own, in steps that turn or move it at most this much. */
const FAR_STEP_TURN = 0.2;
const FAR_STEP_TRAVEL = 0.2;
const FAR_MAX_STEPS = 64;

export function stormerLength(fieldStrength: number, windSpeed: number, planetR: number): number {
  return STORMER_REF * planetR * Math.sqrt((fieldStrength * WIND_SPEED_DEFAULT) / windSpeed);
}

export function shieldRadius(wind: WindSettings, planetR: number): number {
  return wind.field ? SHIELD_PER_STORMER * stormerLength(wind.fieldStrength, wind.speed, planetR) : 0;
}

export type WindGeometry = {
  /** Half-size of the visible frame; gas collisions happen only inside it. */
  halfW: number;
  halfH: number;
  planetR: number;
};

export type SolarWind = {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  /** 1 when the frame's substeps move this particle; 0 when beginFrame has already advanced it. */
  readonly near: Uint8Array;
  /** Recent positions, newest first: WIND_TRAIL_POINTS per particle, trailLength[i] of them valid. */
  readonly trailX: Float32Array;
  readonly trailY: Float32Array;
  readonly trailLength: Uint8Array;
  readonly count: number;
  configure: (settings: WindSettings) => void;
  clear: () => void;
  /**
   * Inject new particles, advance those too far from the frame to reach it this frame, and mark the
   * rest for the substeps. Returns the fastest speed among the marked ones.
   */
  beginFrame: (dt: number, gm: number, rand: () => number) => number;
  /** Gravity and magnetic turning for the marked particles. */
  kick: (h: number, gm: number) => void;
  drift: (h: number) => void;
  /** Remove marked particles that reached the ground. */
  absorbAtGround: () => void;
  /** Add every particle's current position to its trail. */
  recordTrails: () => void;
  /** Age particles and remove those that left the wind region. */
  endFrame: (dt: number) => void;
};

export function createSolarWind(geom: WindGeometry): SolarWind {
  const x = new Float64Array(CAPACITY);
  const y = new Float64Array(CAPACITY);
  const vx = new Float64Array(CAPACITY);
  const vy = new Float64Array(CAPACITY);
  /** Charge sign. Half the wind is positive and half negative, so the two curve opposite ways. */
  const charge = new Int8Array(CAPACITY);
  const near = new Uint8Array(CAPACITY);
  const age = new Float32Array(CAPACITY);
  const trailX = new Float32Array(CAPACITY * WIND_TRAIL_POINTS);
  const trailY = new Float32Array(CAPACITY * WIND_TRAIL_POINTS);
  const trailLength = new Uint8Array(CAPACITY);
  const R3 = geom.planetR ** 3;

  let n = 0;
  let carry = 0;
  let injected = 0;
  let settings: WindSettings = { ...WIND_DEFAULTS };
  /** (q/m)·B at the surface; the field falls off as 1/r³. */
  let omegaSurface = 0;
  let xIn = 0;
  let xOut = 0;
  let yHalf = 0;
  let maxAge = 0;

  function configure(next: WindSettings): void {
    settings = { ...next };
    const c = settings.field ? stormerLength(settings.fieldStrength, settings.speed, geom.planetR) : 0;
    // C² = (q/m)·B₀·R³ / v
    omegaSurface = (c * c * settings.speed) / R3;
    // With the field on, start far enough upstream that the field there is weak.
    xIn = -Math.max(geom.halfW + 0.5, 2.5 * c);
    xOut = Math.max(geom.halfW + 0.5, 1.5 * c);
    yHalf = geom.halfH + c + 0.5;
    // Long enough to cross the region several times; this ends orbits trapped near the planet.
    maxAge = (4 * (xOut - xIn)) / settings.speed;
  }

  function removeAt(i: number): void {
    const last = n - 1;
    if (i !== last) {
      x[i] = x[last];
      y[i] = y[last];
      vx[i] = vx[last];
      vy[i] = vy[last];
      charge[i] = charge[last];
      near[i] = near[last];
      age[i] = age[last];
      trailLength[i] = trailLength[last];
      trailX.copyWithin(i * WIND_TRAIL_POINTS, last * WIND_TRAIL_POINTS, (last + 1) * WIND_TRAIL_POINTS);
      trailY.copyWithin(i * WIND_TRAIL_POINTS, last * WIND_TRAIL_POINTS, (last + 1) * WIND_TRAIL_POINTS);
    }
    n--;
  }

  function kickOne(i: number, h: number, gm: number): void {
    const px = x[i];
    const py = y[i];
    const r2 = px * px + py * py;
    const r3 = r2 * Math.sqrt(r2);
    const g = (gm / r3) * (h / 2);
    vx[i] -= px * g;
    vy[i] -= py * g;
    if (omegaSurface > 0) {
      // dv/dt = (q/m)·v × B with B out of the screen: an exact rotation, so the field does no work.
      const turn = (-charge[i] * omegaSurface * R3 * h) / r3;
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      const ux = vx[i];
      const uy = vy[i];
      vx[i] = ux * c - uy * s;
      vy[i] = ux * s + uy * c;
    }
    vx[i] -= px * g;
    vy[i] -= py * g;
  }

  function advanceAlone(i: number, dt: number, gm: number, speed: number): void {
    const r3 = Math.hypot(x[i], y[i]) ** 3;
    const turnRate = (omegaSurface * R3) / r3;
    const steps = Math.min(
      FAR_MAX_STEPS,
      Math.max(1, Math.ceil((speed * dt) / FAR_STEP_TRAVEL), Math.ceil((turnRate * dt) / FAR_STEP_TURN))
    );
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      kickOne(i, h / 2, gm);
      x[i] += vx[i] * h;
      y[i] += vy[i] * h;
      kickOne(i, h / 2, gm);
    }
  }

  function inject(dt: number, rand: () => number): void {
    if (!settings.on) {
      carry = 0;
      return;
    }
    const u = settings.speed;
    carry += PER_AREA * settings.density * u * 2 * yHalf * dt;
    while (carry >= 1 && n < CAPACITY) {
      carry -= 1;
      const i = n++;
      // Spread over the strip that entered during this frame, so the stream has no gaps.
      x[i] = xIn + rand() * u * dt;
      y[i] = (2 * rand() - 1) * yHalf;
      vx[i] = u * (1 + SPREAD * gaussian(rand));
      vy[i] = u * SPREAD * gaussian(rand);
      charge[i] = injected++ % 2 === 0 ? 1 : -1;
      age[i] = 0;
      trailLength[i] = 0;
    }
    if (n >= CAPACITY) {
      carry = 0;
    }
  }

  configure(WIND_DEFAULTS);

  return {
    x,
    y,
    vx,
    vy,
    near,
    trailX,
    trailY,
    trailLength,
    get count() {
      return n;
    },
    configure,

    clear(): void {
      n = 0;
      carry = 0;
      injected = 0;
    },

    beginFrame(dt: number, gm: number, rand: () => number): number {
      inject(dt, rand);
      let vmax = 0;
      for (let i = 0; i < n; i++) {
        const speed = Math.hypot(vx[i], vy[i]);
        // Lower bound on the distance to the frame; the margin covers gravity's small speed-up.
        const gap = Math.max(Math.abs(x[i]) - geom.halfW, Math.abs(y[i]) - geom.halfH);
        if (gap > speed * dt * 1.2 + 0.1) {
          near[i] = 0;
          advanceAlone(i, dt, gm, speed);
        } else {
          near[i] = 1;
          vmax = Math.max(vmax, speed);
        }
      }
      return vmax;
    },

    kick(h: number, gm: number): void {
      for (let i = 0; i < n; i++) {
        if (near[i]) {
          kickOne(i, h, gm);
        }
      }
    },

    drift(h: number): void {
      for (let i = 0; i < n; i++) {
        if (near[i]) {
          x[i] += vx[i] * h;
          y[i] += vy[i] * h;
        }
      }
    },

    absorbAtGround(): void {
      const rr = geom.planetR + WIND_PARTICLE_R;
      const rr2 = rr * rr;
      for (let i = n - 1; i >= 0; i--) {
        if (near[i] && x[i] * x[i] + y[i] * y[i] < rr2) {
          removeAt(i);
        }
      }
    },

    recordTrails(): void {
      for (let i = 0; i < n; i++) {
        const base = i * WIND_TRAIL_POINTS;
        trailX.copyWithin(base + 1, base, base + WIND_TRAIL_POINTS - 1);
        trailY.copyWithin(base + 1, base, base + WIND_TRAIL_POINTS - 1);
        trailX[base] = x[i];
        trailY[base] = y[i];
        trailLength[i] = Math.min(WIND_TRAIL_POINTS, trailLength[i] + 1);
      }
    },

    endFrame(dt: number): void {
      for (let i = n - 1; i >= 0; i--) {
        age[i] += dt;
        if (x[i] > xOut + 0.5 || x[i] < xIn - 1 || Math.abs(y[i]) > yHalf + 1 || age[i] > maxAge) {
          removeAt(i);
        }
      }
    }
  };
}
