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
export const WIND_TRAIL_POINTS = 28;
export const WIND_TRAIL_INTERVAL = 0.004;
/**
 * The field counts as bending a particle while it curves the path tighter than this many planet
 * radii (its gyroradius, speed ÷ (q/m)B).
 */
const BENT_RADIUS = 1.7;
/** Share of the wind reaching the bubble's Sun-facing edge that slips in near the poles instead. */
const POLAR_SHARE = 0.12;
/** Speed along the field line on the way down, as a share of the particle's speed (the rest is gyration). */
const POLAR_SPEED = 0.6;
/** Aurora glow where a particle lands fades with this time constant (sim seconds). */
export const AURORA_FADE = 0.8;
const AURORA_CAPACITY = 600;

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
 * The wind squeezes the planet's field into a bubble (the magnetosphere): a blunt nose facing the
 * Sun and a tail stretched behind. Its edge follows the standard magnetopause shape
 * r(θ) = r₀·(2 / (1 + cos θ))^α (Shue et al. 1997), θ measured from the Sun direction. Real tails
 * keep widening (α ≈ 0.6), which works because the real wind flows around them like a fluid. Each
 * toy wind particle flies straight, so a widening edge would swallow the wind passing by; at small α
 * the tail barely widens past the planet and then narrows over several planet radii.
 */
const BUBBLE_FLARE = 0.2;
/** Nose distance, in planet radii, at the default field and wind. */
const NOSE_REF = 1.9;
/** (q/m)·B at the planet's surface for field strength 1×. */
const OMEGA_REF = 800;
/** Far down the tail the stretched field levels off at this fraction of the planet's own field at the nose. */
const TAIL_FIELD = 0.06;
/** Half-width of the bubble's soft edge, as a fraction of its radius. */
const EDGE = 0.06;

/**
 * Pressure balance at the nose: the field's pressure there (∝ B², B ∝ 1/r³) equals the wind's push
 * (∝ density × speed²), so the nose distance goes as (field² / (density·speed²))^(1/6).
 */
export function noseDistance(wind: WindSettings, planetR: number): number {
  const push = wind.density * (wind.speed / WIND_SPEED_DEFAULT) ** 2;
  return NOSE_REF * planetR * (wind.fieldStrength ** 2 / push) ** (1 / 6);
}

/** Distance from the planet's centre to the bubble's edge in the direction (x, y). */
export function bubbleRadius(nose: number, x: number, y: number): number {
  const r = Math.hypot(x, y);
  const cosFromSun = r > 0 ? -x / r : 1;
  return nose * (2 / (1 + cosFromSun)) ** BUBBLE_FLARE;
}

export type FieldModel = { omegaSurface: number; nose: number; planetR: number };

export function fieldModel(wind: WindSettings, planetR: number): FieldModel | null {
  return wind.field
    ? { omegaSurface: wind.fieldStrength * OMEGA_REF, nose: noseDistance(wind, planetR), planetR }
    : null;
}

/**
 * (q/m)·B for a unit charge at (x, y); B points out of the screen. Inside the bubble: the planet's
 * dipole, doubled at the nose by the currents along the bubble's edge, plus a weak field stretched
 * down the tail. Outside: none. In this flat slice any such B is a valid magnetic field.
 */
export function fieldAt(m: FieldModel, x: number, y: number): number {
  const r2 = x * x + y * y;
  const r = Math.sqrt(r2);
  const sunward = r > 0 ? (1 - x / r) / 2 : 1;
  const edgeR = m.nose * (1 / Math.max(sunward, 1e-12)) ** BUBBLE_FLARE;
  const s = r / edgeR;
  if (s >= 1 + EDGE) {
    return 0;
  }
  const R3 = m.planetR ** 3;
  const planet = (m.omegaSurface * R3) / (r2 * r);
  const compressed = planet * (1 + sunward * s * s * s);
  const tail = ((m.omegaSurface * R3) / m.nose ** 3) * TAIL_FIELD * (1 - sunward) ** 2;
  let edge = 1;
  if (s > 1 - EDGE) {
    const t = (s - (1 - EDGE)) / (2 * EDGE);
    edge = 1 - t * t * (3 - 2 * t);
  }
  return (compressed + tail) * edge;
}

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

export type WindGeometry = {
  /** Half-size of the gas frame; gas collisions happen only inside it. */
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
  /** 1 while the magnetic field is bending the particle's path. */
  readonly bent: Uint8Array;
  /**
   * 1 while the particle slides down a field line toward the pole, out of this slice: it no longer
   * meets the gas, and on screen it moves straight in toward the pole at the centre.
   */
  readonly polar: Uint8Array;
  /** Recent positions, newest first: WIND_TRAIL_POINTS per particle, trailLength[i] of them valid. */
  readonly trailX: Float32Array;
  readonly trailY: Float32Array;
  /** Per trail point: 1 if the field was bending the particle there. */
  readonly trailBent: Uint8Array;
  /** Where slipped-in particles reached the upper air near the pole, and how long ago (sim seconds). */
  readonly auroraX: Float32Array;
  readonly auroraY: Float32Array;
  readonly auroraAge: Float32Array;
  readonly auroraCount: number;
  readonly trailLength: Uint8Array;
  readonly count: number;
  configure: (settings: WindSettings) => void;
  /** Half-size of the region on screen; the wind enters at its left edge and leaves past its right. */
  setView: (halfW: number, halfH: number) => void;
  clear: () => void;
  /**
   * Inject new particles, advance those too far from the frame to reach it this frame, and mark the
   * rest for the substeps. Returns the fastest speed among the marked ones.
   */
  beginFrame: (dt: number, gm: number, rand: () => number) => number;
  /** Gravity and magnetic turning for the marked particles. */
  kick: (h: number, gm: number) => void;
  drift: (h: number) => void;
  /** Remove marked particles that reached the ground, and slipped-in ones that reached the upper air. */
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
  const bent = new Uint8Array(CAPACITY);
  /** 1 once the particle has had its one chance to slip in near the poles. */
  const rolled = new Uint8Array(CAPACITY);
  const polar = new Uint8Array(CAPACITY);
  /** Field line being followed: distance where it crosses this slice, direction, latitude now and at the ground. */
  const lineL = new Float32Array(CAPACITY);
  const linePhi = new Float32Array(CAPACITY);
  const lineLat = new Float32Array(CAPACITY);
  const lineLatEnd = new Float32Array(CAPACITY);
  const trailX = new Float32Array(CAPACITY * WIND_TRAIL_POINTS);
  const trailY = new Float32Array(CAPACITY * WIND_TRAIL_POINTS);
  const trailBent = new Uint8Array(CAPACITY * WIND_TRAIL_POINTS);
  const trailLength = new Uint8Array(CAPACITY);
  const auroraX = new Float32Array(AURORA_CAPACITY);
  const auroraY = new Float32Array(AURORA_CAPACITY);
  const auroraAge = new Float32Array(AURORA_CAPACITY);
  let auroraCount = 0;
  let frameRand: () => number = Math.random;

  let n = 0;
  let carry = 0;
  let injected = 0;
  let settings: WindSettings = { ...WIND_DEFAULTS };
  let field: FieldModel | null = null;
  let viewHalfW = geom.halfW;
  let viewHalfH = geom.halfH;
  let xIn = 0;
  let xOut = 0;
  let yHalf = 0;
  let maxAge = 0;

  function configure(next: WindSettings): void {
    settings = { ...next };
    field = fieldModel(settings, geom.planetR);
    // Start upstream of the bubble's nose; outside the bubble there is no field.
    xIn = -Math.max(viewHalfW + 0.5, (field?.nose ?? 0) + 0.5);
    xOut = viewHalfW + 0.5;
    yHalf = viewHalfH + 1;
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
      bent[i] = bent[last];
      rolled[i] = rolled[last];
      polar[i] = polar[last];
      lineL[i] = lineL[last];
      linePhi[i] = linePhi[last];
      lineLat[i] = lineLat[last];
      lineLatEnd[i] = lineLatEnd[last];
      trailLength[i] = trailLength[last];
      const from = last * WIND_TRAIL_POINTS;
      const to = from + WIND_TRAIL_POINTS;
      trailX.copyWithin(i * WIND_TRAIL_POINTS, from, to);
      trailY.copyWithin(i * WIND_TRAIL_POINTS, from, to);
      trailBent.copyWithin(i * WIND_TRAIL_POINTS, from, to);
    }
    n--;
  }

  /**
   * Leave this slice along the dipole field line through the particle (r = L·cos²λ): seen from above
   * the pole, it slides straight in toward the centre and reaches the ground at R·√(R/L).
   */
  function startPolar(i: number): void {
    const L = Math.hypot(x[i], y[i]);
    polar[i] = 1;
    bent[i] = 1;
    lineL[i] = L;
    linePhi[i] = Math.atan2(y[i], x[i]);
    lineLat[i] = 0;
    lineLatEnd[i] = Math.acos(Math.sqrt(geom.planetR / L));
  }

  function slide(i: number, h: number): void {
    const L = lineL[i];
    const lat = lineLat[i];
    // Arc length along a dipole line: ds = L·cos λ·√(1 + 3 sin²λ) dλ.
    const sinLat = Math.sin(lat);
    const ds = POLAR_SPEED * Math.hypot(vx[i], vy[i]) * h;
    lineLat[i] = Math.min(lineLatEnd[i], lat + ds / (L * Math.cos(lat) * Math.sqrt(1 + 3 * sinLat * sinLat)));
    const across = L * Math.cos(lineLat[i]) ** 3;
    x[i] = across * Math.cos(linePhi[i]);
    y[i] = across * Math.sin(linePhi[i]);
  }

  function kickOne(i: number, h: number, gm: number, canSlip: boolean): void {
    const px = x[i];
    const py = y[i];
    const r2 = px * px + py * py;
    const r = Math.sqrt(r2);
    const r3 = r2 * r;
    const g = (gm / r3) * (h / 2);
    vx[i] -= px * g;
    vy[i] -= py * g;
    const omega = field ? fieldAt(field, px, py) : 0;
    const speed = Math.hypot(vx[i], vy[i]);
    bent[i] = omega * BENT_RADIUS * geom.planetR > speed ? 1 : 0;
    // One chance per particle, on first reaching the bubble's Sun-facing edge (a stand-in for the
    // cusps, where the real wind gets in near the poles).
    if (canSlip && field && !rolled[i] && px < 0 && r < bubbleRadius(field.nose, px, py) * (1 + EDGE)) {
      rolled[i] = 1;
      if (frameRand() < POLAR_SHARE) {
        startPolar(i);
        return;
      }
    }
    if (omega > 0) {
      // dv/dt = (q/m)·v × B with B out of the screen: an exact rotation, so the field does no work.
      const turn = -charge[i] * omega * h;
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
    const turnRate = field ? fieldAt(field, x[i], y[i]) : 0;
    const steps = Math.min(
      FAR_MAX_STEPS,
      Math.max(1, Math.ceil((speed * dt) / FAR_STEP_TRAVEL), Math.ceil((turnRate * dt) / FAR_STEP_TURN))
    );
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      kickOne(i, h / 2, gm, false);
      x[i] += vx[i] * h;
      y[i] += vy[i] * h;
      kickOne(i, h / 2, gm, false);
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
      bent[i] = 0;
      rolled[i] = 0;
      polar[i] = 0;
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
    bent,
    polar,
    trailX,
    trailY,
    trailBent,
    trailLength,
    auroraX,
    auroraY,
    auroraAge,
    get count() {
      return n;
    },
    get auroraCount() {
      return auroraCount;
    },
    configure,

    setView(halfW: number, halfH: number): void {
      viewHalfW = Math.max(geom.halfW, halfW);
      viewHalfH = Math.max(geom.halfH, halfH);
      configure(settings);
    },

    clear(): void {
      n = 0;
      carry = 0;
      injected = 0;
      auroraCount = 0;
    },

    beginFrame(dt: number, gm: number, rand: () => number): number {
      frameRand = rand;
      inject(dt, rand);
      let vmax = 0;
      for (let i = 0; i < n; i++) {
        const speed = Math.hypot(vx[i], vy[i]);
        if (polar[i]) {
          near[i] = 1;
          vmax = Math.max(vmax, speed);
          continue;
        }
        const reach = speed * dt * 1.2 + 0.1;
        // Lower bound on the distance to the frame; the margin covers gravity's small speed-up.
        const gap = Math.max(Math.abs(x[i]) - geom.halfW, Math.abs(y[i]) - geom.halfH);
        // The bubble's edge is sharp, so anything that could reach it this frame needs the fine steps.
        const clearOfBubble =
          !field || Math.hypot(x[i], y[i]) > bubbleRadius(field.nose, x[i], y[i]) * (1 + EDGE) + reach;
        if (gap > reach && clearOfBubble) {
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
        if (near[i] && !polar[i]) {
          kickOne(i, h, gm, true);
        }
      }
    },

    drift(h: number): void {
      for (let i = 0; i < n; i++) {
        if (polar[i]) {
          slide(i, h);
        } else if (near[i]) {
          x[i] += vx[i] * h;
          y[i] += vy[i] * h;
        }
      }
    },

    absorbAtGround(): void {
      const rr = geom.planetR + WIND_PARTICLE_R;
      const rr2 = rr * rr;
      for (let i = n - 1; i >= 0; i--) {
        if (polar[i]) {
          if (lineLat[i] >= lineLatEnd[i]) {
            // Landed in the upper air near the pole: it glows there (the aurora).
            const k = auroraCount < AURORA_CAPACITY ? auroraCount++ : Math.floor(frameRand() * AURORA_CAPACITY);
            auroraX[k] = x[i];
            auroraY[k] = y[i];
            auroraAge[k] = 0;
            removeAt(i);
          }
        } else if (near[i] && x[i] * x[i] + y[i] * y[i] < rr2) {
          removeAt(i);
        }
      }
    },

    recordTrails(): void {
      for (let i = 0; i < n; i++) {
        const base = i * WIND_TRAIL_POINTS;
        trailX.copyWithin(base + 1, base, base + WIND_TRAIL_POINTS - 1);
        trailY.copyWithin(base + 1, base, base + WIND_TRAIL_POINTS - 1);
        trailBent.copyWithin(base + 1, base, base + WIND_TRAIL_POINTS - 1);
        trailX[base] = x[i];
        trailY[base] = y[i];
        trailBent[base] = bent[i];
        trailLength[i] = Math.min(WIND_TRAIL_POINTS, trailLength[i] + 1);
      }
    },

    endFrame(dt: number): void {
      for (let k = auroraCount - 1; k >= 0; k--) {
        auroraAge[k] += dt;
        if (auroraAge[k] > 4 * AURORA_FADE) {
          auroraCount--;
          auroraX[k] = auroraX[auroraCount];
          auroraY[k] = auroraY[auroraCount];
          auroraAge[k] = auroraAge[auroraCount];
        }
      }
      for (let i = n - 1; i >= 0; i--) {
        age[i] += dt;
        if (x[i] > xOut + 0.5 || x[i] < xIn - 1 || Math.abs(y[i]) > yHalf + 1 || age[i] > maxAge) {
          removeAt(i);
        }
      }
    }
  };
}
