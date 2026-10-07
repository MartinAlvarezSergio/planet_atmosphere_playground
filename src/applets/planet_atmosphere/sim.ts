import { gaussian, mulberry32 } from "./random";
import type { GasMode, GasSettings, GasSnapshot, PlanetPresetId, TrailPoint, WindPresetId, WindSettings } from "./types";
import {
  createSolarWind,
  shieldRadius,
  WIND_DEFAULTS,
  WIND_HIT_DISTANCE,
  WIND_MASS,
  WIND_PARTICLE_R,
  WIND_TRAIL_INTERVAL
} from "./wind";

export const CANVAS_W = 880;
export const CANVAS_H = 600;
/** World→pixel scale, shared by both modes so equal speeds look equally fast. */
export const PX_PER_UNIT = 130;
export const VIEW_HALF_W = CANVAS_W / 2 / PX_PER_UNIT;
export const VIEW_HALF_H = CANVAS_H / 2 / PX_PER_UNIT;

export const BOX_W = 6.4;
export const BOX_H = 4.2;
export const BOX_PARTICLE_R = 0.032;

export const PLANET_R = 1;
/** Smaller than in the box so a compressed atmosphere stays a dilute gas. */
export const PLANET_PARTICLE_R = 0.02;
/**
 * GM for planetMass = 1. At T = 1 the Jeans parameter λ = GM/(R·T) is 10:
 * escape speed is √20 ≈ 4.5 while the most probable gas speed is 1.
 */
export const GM_PER_MASS = 10;
/**
 * Planet-mode temperature and speed histogram use the gas below this radius.
 * Higher up the gas is nearly collisionless and particles there have traded speed for height.
 */
export const NEAR_GROUND_R = 1.5;

export const TEMPERATURE_MIN = 0.25;
export const TEMPERATURE_MAX = 3;
export const TEMPERATURE_DEFAULT = 1;
export const BOX_COUNT_MIN = 10;
export const BOX_COUNT_MAX = 2000;
export const BOX_COUNT_DEFAULT = 120;
export const PLANET_COUNT_MIN = 20;
export const PLANET_COUNT_MAX = 1000;
export const PLANET_COUNT_DEFAULT = 150;
export const PLANET_MASS_MIN = 0.1;
export const PLANET_MASS_MAX = 2;
export const PLANET_MASS_DEFAULT = 1;

export const PLANET_PRESETS: Record<PlanetPresetId, { temperature: number; planetMass: number }> = {
  big_planet: { temperature: 1, planetMass: 1.6 },
  small_planet: { temperature: 1, planetMass: 0.25 },
  hot_gas: { temperature: 2.6, planetMass: 1 },
  small_cold: { temperature: 0.3, planetMass: 0.3 }
};

/**
 * Solar-wind presets. The warm ground keeps the gas at one temperature, so losses come from the wind;
 * the Mars-like planet is heavy enough that heat alone loses almost nothing.
 */
export const WIND_PRESETS: Record<
  WindPresetId,
  { temperature: number; planetMass: number; warmGround: boolean; wind: WindSettings }
> = {
  mars: { temperature: 1, planetMass: 0.8, warmGround: true, wind: { ...WIND_DEFAULTS, on: true } },
  earth: { temperature: 1, planetMass: 2, warmGround: true, wind: { ...WIND_DEFAULTS, on: true, field: true } },
  earth_no_field: { temperature: 1, planetMass: 2, warmGround: true, wind: { ...WIND_DEFAULTS, on: true } }
};

/** Sim seconds per real second at 1× playback. */
const SIM_RATE = 0.6;
const MAX_FRAME_DT = 1 / 30;
const MAX_SUBSTEPS = 120;
/** Max travel per substep as a fraction of the particle radius, so pairs can't tunnel. */
const SUBSTEP_TRAVEL = 0.4;
/**
 * Max speed gravity may add per substep, as a fraction of the gas's rms speed. Collisions
 * are caught slightly late, and in a cold pile under strong gravity that bias heats the gas
 * in proportion to the step; at 0.005 the drift is ~2% per minute in the worst corner.
 */
const GRAVITY_SPEED_STEP = 0.005;
const SEED = 1337;
const TRACER_ID = 0;
const TRAIL_LEN = 160;
/** Wall impulses are summed over windows of this many sim seconds, then smoothed. */
const PRESSURE_WINDOW = 0.5;
const PRESSURE_SMOOTH = 0.2;
/** Time constant (sim seconds) for the temperature and mean-speed readouts. */
const STATS_SMOOTH_TIME = 0.6;
/** The initial atmosphere is sampled up to this many surface scale heights. */
const INIT_SCALE_HEIGHTS = 8;
const PLACE_TRIES = 300;

const CAPACITY = Math.max(BOX_COUNT_MAX, PLANET_COUNT_MAX);

export function particleRadiusFor(mode: GasMode): number {
  return mode === "box" ? BOX_PARTICLE_R : PLANET_PARTICLE_R;
}

export function countLimits(mode: GasMode): { min: number; max: number } {
  return mode === "box"
    ? { min: BOX_COUNT_MIN, max: BOX_COUNT_MAX }
    : { min: PLANET_COUNT_MIN, max: PLANET_COUNT_MAX };
}

export function escapeSpeedFor(planetMass: number): number {
  return Math.sqrt((2 * GM_PER_MASS * planetMass) / PLANET_R);
}

/** λ = (escape speed)² / (2 × most probable speed)²; the fraction of a 2D thermal gas above escape speed is e^(−λ). */
export function jeansParameter(planetMass: number, temperature: number): number {
  return (GM_PER_MASS * planetMass) / (PLANET_R * temperature);
}

type Grid = {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  head: Int32Array;
};

function makeGrid(halfW: number, halfH: number, cell: number): Grid {
  const nx = Math.ceil((2 * halfW) / cell);
  const ny = Math.ceil((2 * halfH) / cell);
  return { x0: -halfW, y0: -halfH, cell, nx, ny, head: new Int32Array(nx * ny) };
}

export type GasSim = {
  /** Rebuild the gas from scratch (same seed, so equal settings give the same start). */
  reset: (settings: GasSettings) => void;
  step: (realDt: number) => void;
  /** Heat or cool: rescale every speed so the measured temperature equals the target. */
  setTemperature: (temperature: number) => void;
  /** Add particles at the current temperature or remove random ones (never the tracer). */
  setCount: (count: number) => void;
  setPlanetMass: (planetMass: number) => void;
  setWarmGround: (warmGround: boolean) => void;
  setWind: (wind: WindSettings) => void;
  setPlayback: (playback: number) => void;
  getSnapshot: () => GasSnapshot;
};

export function createGasSim(initial: GasSettings): GasSim {
  const x = new Float64Array(CAPACITY);
  const y = new Float64Array(CAPACITY);
  const vx = new Float64Array(CAPACITY);
  const vy = new Float64Array(CAPACITY);
  const ids = new Int32Array(CAPACITY);
  const speed = new Float32Array(CAPACITY);
  const canEscape = new Uint8Array(CAPACITY);
  const measured = new Uint8Array(CAPACITY);
  const next = new Int32Array(CAPACITY);
  const cellOf = new Int32Array(CAPACITY);
  /**
   * 1 once a gas particle is hit by the solar wind; cleared when it touches the ground. Gas that the
   * wind only warmed (through other gas) and that then escapes counts as evaporated: thermal escape.
   */
  const windHit = new Uint8Array(CAPACITY);

  // Cells must be at least one particle diameter wide for the 3×3 neighbour search.
  const boxGrid = makeGrid(BOX_W / 2, BOX_H / 2, 0.1);
  const planetGrid = makeGrid(VIEW_HALF_W, VIEW_HALF_H, 0.06);
  const wind = createSolarWind({ halfW: VIEW_HALF_W, halfH: VIEW_HALF_H, planetR: PLANET_R });

  let settings: GasSettings = { ...initial };
  let r = particleRadiusFor(initial.mode);
  let gm = GM_PER_MASS * initial.planetMass;
  let rand = mulberry32(SEED);
  let n = 0;
  let nextId = 0;
  let playback = 1;
  let simTime = 0;
  let evaporated = 0;
  let stripped = 0;
  let tracerEscaped = false;
  let trail: TrailPoint[] = [];
  let wallImpulse = 0;
  let windowTime = 0;
  let pressure: number | null = null;
  let smoothTemperature = 0;
  let smoothMeanSpeed = 0;

  /** Same sample as the readout: everything in the box, or the gas near the ground. */
  function measureGas(): { temperature: number; meanSpeed: number } {
    const planet = settings.mode === "planet";
    let ke = 0;
    let speedSum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (planet && Math.hypot(x[i], y[i]) > NEAR_GROUND_R) {
        continue;
      }
      const v2 = vx[i] * vx[i] + vy[i] * vy[i];
      ke += v2;
      speedSum += Math.sqrt(v2);
      count++;
    }
    return count > 0
      ? { temperature: ke / (2 * count), meanSpeed: speedSum / count }
      : { temperature: 0, meanSpeed: 0 };
  }

  /** Jump the smoothed readouts to the current state after a deliberate change. */
  function snapReadouts(): void {
    const m = measureGas();
    smoothTemperature = m.temperature;
    smoothMeanSpeed = m.meanSpeed;
  }

  function sampleVelocity(i: number, temperature: number): void {
    const sigma = Math.sqrt(temperature);
    vx[i] = sigma * gaussian(rand);
    vy[i] = sigma * gaussian(rand);
  }

  function rescaleTo(temperature: number): void {
    const current = measureGas().temperature;
    if (current <= 1e-12) {
      for (let i = 0; i < n; i++) {
        sampleVelocity(i, temperature);
      }
      return;
    }
    const f = Math.sqrt(temperature / current);
    for (let i = 0; i < n; i++) {
      vx[i] *= f;
      vy[i] *= f;
    }
  }

  function activeGrid(): Grid {
    return settings.mode === "planet" ? planetGrid : boxGrid;
  }

  function insertIntoGrid(grid: Grid, i: number): void {
    const cx = Math.floor((x[i] - grid.x0) / grid.cell);
    const cy = Math.floor((y[i] - grid.y0) / grid.cell);
    if (cx < 0 || cy < 0 || cx >= grid.nx || cy >= grid.ny) {
      // Off-screen particles are in near-empty space; they skip collisions.
      cellOf[i] = -1;
      return;
    }
    const c = cy * grid.nx + cx;
    cellOf[i] = c;
    next[i] = grid.head[c];
    grid.head[c] = i;
  }

  function rebuildGrid(grid: Grid): void {
    grid.head.fill(-1);
    for (let i = 0; i < n; i++) {
      insertIntoGrid(grid, i);
    }
  }

  /** Grid lookup; addParticle keeps the grid current while placing. */
  function overlapsExisting(px: number, py: number): boolean {
    const grid = activeGrid();
    const minD2 = (2.05 * r) ** 2;
    const cx = Math.floor((px - grid.x0) / grid.cell);
    const cy = Math.floor((py - grid.y0) / grid.cell);
    for (let yy = cy - 1; yy <= cy + 1; yy++) {
      if (yy < 0 || yy >= grid.ny) {
        continue;
      }
      for (let xx = cx - 1; xx <= cx + 1; xx++) {
        if (xx < 0 || xx >= grid.nx) {
          continue;
        }
        for (let j = grid.head[yy * grid.nx + xx]; j !== -1; j = next[j]) {
          const dx = x[j] - px;
          const dy = y[j] - py;
          if (dx * dx + dy * dy < minD2) {
            return true;
          }
        }
      }
    }
    return false;
  }

  function pickBoxPosition(): [number, number] {
    const hx = BOX_W / 2 - r;
    const hy = BOX_H / 2 - r;
    let px = 0;
    let py = 0;
    for (let t = 0; t < PLACE_TRIES; t++) {
      px = (rand() * 2 - 1) * hx;
      py = (rand() * 2 - 1) * hy;
      if (!overlapsExisting(px, py)) {
        break;
      }
    }
    return [px, py];
  }

  /**
   * Isothermal equilibrium around a point mass: n(r) ∝ exp(GM/(T·r)).
   * Rejection-sampled over the annulus, so the gas starts settled at the slider temperature.
   */
  function samplePlanetRadius(temperature: number): number {
    const rMin = PLANET_R + r * 1.05;
    const scaleHeight = (temperature * PLANET_R * PLANET_R) / gm;
    const rMax = Math.max(
      rMin + 4 * r,
      Math.min(VIEW_HALF_H - r, PLANET_R + INIT_SCALE_HEIGHTS * scaleHeight)
    );
    const k = gm / temperature;
    for (let t = 0; t < 4000; t++) {
      const rr = Math.sqrt(rMin * rMin + rand() * (rMax * rMax - rMin * rMin));
      if (rand() < Math.exp(k * (1 / rr - 1 / rMin))) {
        return rr;
      }
    }
    return rMin + rand() * scaleHeight;
  }

  function pickPlanetPosition(temperature: number): [number, number] {
    let px = 0;
    let py = 0;
    for (let t = 0; t < PLACE_TRIES; t++) {
      const rr = samplePlanetRadius(temperature);
      const ang = rand() * Math.PI * 2;
      px = rr * Math.cos(ang);
      py = rr * Math.sin(ang);
      if (!overlapsExisting(px, py)) {
        return [px, py];
      }
    }
    // The equilibrium layer is full (dense gas, strong gravity): drop the particle onto
    // the pile at the lowest free spot, so the start is compact rather than loose.
    const rMin = PLANET_R + r * 1.05;
    const rTop = VIEW_HALF_H - r;
    for (let t = 0; t < PLACE_TRIES; t++) {
      const ang = rand() * Math.PI * 2;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      for (let rr = rMin; rr <= rTop; rr += 0.25 * r) {
        if (!overlapsExisting(rr * c, rr * s)) {
          return [rr * c, rr * s];
        }
      }
    }
    return [px, py];
  }

  function addParticle(temperature: number): void {
    if (n >= CAPACITY) {
      return;
    }
    const [px, py] =
      settings.mode === "box" ? pickBoxPosition() : pickPlanetPosition(temperature);
    const i = n++;
    x[i] = px;
    y[i] = py;
    ids[i] = nextId++;
    windHit[i] = 0;
    sampleVelocity(i, temperature);
    insertIntoGrid(activeGrid(), i);
  }

  function removeAt(i: number): void {
    const last = n - 1;
    if (i !== last) {
      x[i] = x[last];
      y[i] = y[last];
      vx[i] = vx[last];
      vy[i] = vy[last];
      ids[i] = ids[last];
      windHit[i] = windHit[last];
    }
    n--;
  }

  function clampCount(mode: GasMode, count: number): number {
    const { min, max } = countLimits(mode);
    return Math.min(max, Math.max(min, Math.round(count)));
  }

  function kick(h: number): void {
    for (let i = 0; i < n; i++) {
      const px = x[i];
      const py = y[i];
      const r2 = px * px + py * py;
      const inv = gm / (r2 * Math.sqrt(r2));
      vx[i] -= px * inv * h;
      vy[i] -= py * inv * h;
    }
  }

  function drift(h: number): void {
    for (let i = 0; i < n; i++) {
      x[i] += vx[i] * h;
      y[i] += vy[i] * h;
    }
  }

  /** Equal-mass elastic hard disks: swap the velocity components along the line of centres. */
  function collidePairs(grid: Grid): void {
    const D = 2 * r;
    const D2 = D * D;
    const { nx, ny, head } = grid;
    rebuildGrid(grid);

    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      if (c < 0) {
        continue;
      }
      const cx = c % nx;
      const cy = (c - cx) / nx;
      for (let oy = -1; oy <= 1; oy++) {
        const yy = cy + oy;
        if (yy < 0 || yy >= ny) {
          continue;
        }
        for (let ox = -1; ox <= 1; ox++) {
          const xx = cx + ox;
          if (xx < 0 || xx >= nx) {
            continue;
          }
          for (let j = head[yy * nx + xx]; j !== -1; j = next[j]) {
            if (j <= i) {
              continue;
            }
            const dx = x[j] - x[i];
            const dy = y[j] - y[i];
            const d2 = dx * dx + dy * dy;
            if (d2 >= D2 || d2 < 1e-18) {
              continue;
            }
            const d = Math.sqrt(d2);
            const ux = dx / d;
            const uy = dy / d;
            const vrel = (vx[j] - vx[i]) * ux + (vy[j] - vy[i]) * uy;
            if (vrel < 0) {
              vx[i] += vrel * ux;
              vy[i] += vrel * uy;
              vx[j] -= vrel * ux;
              vy[j] -= vrel * uy;
            }
            // Separate overlapping disks symmetrically; this never changes kinetic energy.
            const push = (D - d) / 2;
            x[i] -= ux * push;
            y[i] -= uy * push;
            x[j] += ux * push;
            y[j] += uy * push;
          }
        }
      }
    }
  }

  /**
   * Wind particle (mass m) on gas particle (mass 1), elastic: along the line of centres the gas gains
   * 2m/(1 + m) of the closing speed and the wind particle loses 2/(1 + m) of it. Uses the grid that
   * collidePairs just built; wind particles never hit each other.
   */
  function collideWind(grid: Grid): void {
    const D = WIND_HIT_DISTANCE;
    const D2 = D * D;
    const gasShare = (2 * WIND_MASS) / (1 + WIND_MASS);
    const windShare = 2 / (1 + WIND_MASS);
    const { nx, ny, head, x0, y0, cell } = grid;
    const wx = wind.x;
    const wy = wind.y;
    const wvx = wind.vx;
    const wvy = wind.vy;
    for (let k = 0; k < wind.count; k++) {
      if (!wind.near[k]) {
        continue;
      }
      const cx = Math.floor((wx[k] - x0) / cell);
      const cy = Math.floor((wy[k] - y0) / cell);
      if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) {
        continue;
      }
      for (let yy = Math.max(0, cy - 1); yy <= Math.min(ny - 1, cy + 1); yy++) {
        for (let xx = Math.max(0, cx - 1); xx <= Math.min(nx - 1, cx + 1); xx++) {
          for (let j = head[yy * nx + xx]; j !== -1; j = next[j]) {
            const dx = x[j] - wx[k];
            const dy = y[j] - wy[k];
            const d2 = dx * dx + dy * dy;
            if (d2 >= D2 || d2 < 1e-18) {
              continue;
            }
            const d = Math.sqrt(d2);
            const ux = dx / d;
            const uy = dy / d;
            const vrel = (vx[j] - wvx[k]) * ux + (vy[j] - wvy[k]) * uy;
            if (vrel < 0) {
              wvx[k] += windShare * vrel * ux;
              wvy[k] += windShare * vrel * uy;
              vx[j] -= gasShare * vrel * ux;
              vy[j] -= gasShare * vrel * uy;
              windHit[j] = 1;
            }
            // Separate about the centre of mass: the light wind particle moves most.
            const push = D - d;
            wx[k] -= ux * push * (1 / (1 + WIND_MASS));
            wy[k] -= uy * push * (1 / (1 + WIND_MASS));
            x[j] += ux * push * (WIND_MASS / (1 + WIND_MASS));
            y[j] += uy * push * (WIND_MASS / (1 + WIND_MASS));
          }
        }
      }
    }
  }

  /** Specular walls; reflected momentum is summed to measure pressure. */
  function collideBoxWalls(): void {
    const hx = BOX_W / 2 - r;
    const hy = BOX_H / 2 - r;
    for (let i = 0; i < n; i++) {
      if (x[i] < -hx) {
        if (vx[i] < 0) {
          wallImpulse += -2 * vx[i];
          vx[i] = -vx[i];
          x[i] = Math.min(hx, -2 * hx - x[i]);
        } else {
          x[i] = -hx;
        }
      } else if (x[i] > hx) {
        if (vx[i] > 0) {
          wallImpulse += 2 * vx[i];
          vx[i] = -vx[i];
          x[i] = Math.max(-hx, 2 * hx - x[i]);
        } else {
          x[i] = hx;
        }
      }
      if (y[i] < -hy) {
        if (vy[i] < 0) {
          wallImpulse += -2 * vy[i];
          vy[i] = -vy[i];
          y[i] = Math.min(hy, -2 * hy - y[i]);
        } else {
          y[i] = -hy;
        }
      } else if (y[i] > hy) {
        if (vy[i] > 0) {
          wallImpulse += 2 * vy[i];
          vy[i] = -vy[i];
          y[i] = Math.max(-hy, 2 * hy - y[i]);
        } else {
          y[i] = hy;
        }
      }
    }
  }

  /**
   * Elastic ground: flip the radial velocity and mirror any penetration.
   * Warm ground (thermal wall): re-emit with the flux-weighted Maxwellian at the slider
   * temperature — Rayleigh-distributed normal speed, Gaussian tangential speed.
   */
  function collideSurface(): void {
    const rr = PLANET_R + r;
    const rr2 = rr * rr;
    const warm = settings.warmGround;
    const sigma = Math.sqrt(settings.temperature);
    for (let i = 0; i < n; i++) {
      const px = x[i];
      const py = y[i];
      const d2 = px * px + py * py;
      if (d2 >= rr2) {
        continue;
      }
      const d = Math.sqrt(d2);
      if (d < 1e-9) {
        x[i] = rr;
        y[i] = 0;
        continue;
      }
      const ux = px / d;
      const uy = py / d;
      const vn = vx[i] * ux + vy[i] * uy;
      windHit[i] = 0;
      let nd = rr;
      if (vn < 0 && warm) {
        const vOut = sigma * Math.sqrt(-2 * Math.log(1 - rand()));
        const vTan = sigma * gaussian(rand);
        vx[i] = vOut * ux - vTan * uy;
        vy[i] = vOut * uy + vTan * ux;
      } else if (vn < 0) {
        vx[i] -= 2 * vn * ux;
        vy[i] -= 2 * vn * uy;
        nd = Math.min(2 * rr - d, rr + r);
      }
      x[i] = ux * nd;
      y[i] = uy * nd;
    }
  }

  /**
   * Escaped = outside the frame, moving outward, with positive orbital energy (it never returns).
   * Counted as stripped when the solar wind hit it since it last touched the ground.
   */
  function removeEscaped(): void {
    for (let i = n - 1; i >= 0; i--) {
      const px = x[i];
      const py = y[i];
      if (Math.abs(px) <= VIEW_HALF_W && Math.abs(py) <= VIEW_HALF_H) {
        continue;
      }
      const rad = Math.hypot(px, py);
      const vr = (px * vx[i] + py * vy[i]) / rad;
      if (vr < 0) {
        continue;
      }
      const energy = 0.5 * (vx[i] * vx[i] + vy[i] * vy[i]) - gm / rad;
      if (energy <= 0) {
        continue;
      }
      if (ids[i] === TRACER_ID) {
        tracerEscaped = true;
      }
      if (windHit[i]) {
        stripped++;
      } else {
        evaporated++;
      }
      removeAt(i);
    }
  }

  function substep(h: number): void {
    const planet = settings.mode === "planet";
    const windy = planet && wind.count > 0;
    if (planet) {
      kick(h / 2);
    }
    if (windy) {
      wind.kick(h / 2, gm);
      wind.drift(h);
    }
    drift(h);
    collidePairs(planet ? planetGrid : boxGrid);
    if (windy) {
      collideWind(planetGrid);
      wind.absorbAtGround();
    }
    if (planet) {
      collideSurface();
      kick(h / 2);
      if (windy) {
        wind.kick(h / 2, gm);
      }
      removeEscaped();
    } else {
      collideBoxWalls();
    }
  }

  function tracerIndex(): number {
    for (let i = 0; i < n; i++) {
      if (ids[i] === TRACER_ID) {
        return i;
      }
    }
    return -1;
  }

  function recordTrail(): void {
    const i = tracerIndex();
    if (i < 0) {
      return;
    }
    trail.push({ x: x[i], y: y[i] });
    if (trail.length > TRAIL_LEN) {
      trail.shift();
    }
  }

  function reset(next: GasSettings): void {
    settings = { ...next, wind: { ...next.wind }, count: clampCount(next.mode, next.count) };
    r = particleRadiusFor(settings.mode);
    gm = GM_PER_MASS * settings.planetMass;
    rand = mulberry32(SEED);
    n = 0;
    nextId = 0;
    simTime = 0;
    evaporated = 0;
    stripped = 0;
    tracerEscaped = false;
    trail = [];
    wallImpulse = 0;
    windowTime = 0;
    pressure = null;
    wind.clear();
    wind.configure(settings.wind);
    rebuildGrid(activeGrid());
    for (let k = 0; k < settings.count; k++) {
      addParticle(settings.temperature);
    }
    // Remove sampling noise so the readout starts exactly at the slider value.
    rescaleTo(settings.temperature);
    snapReadouts();
  }

  reset(initial);

  return {
    reset,

    step(realDt: number): void {
      const dt = Math.min(Math.max(realDt, 0), MAX_FRAME_DT) * SIM_RATE * playback;
      if (dt <= 0) {
        return;
      }
      const planet = settings.mode === "planet";
      // Wind particles far from the frame are advanced here; the substeps move the rest.
      const windSpeedMax = planet ? wind.beginFrame(dt, gm, rand) : 0;
      if (n > 0 || windSpeedMax > 0) {
        let v2max = 0;
        let v2sum = 0;
        for (let i = 0; i < n; i++) {
          const v2 = vx[i] * vx[i] + vy[i] * vy[i];
          v2max = Math.max(v2max, v2);
          v2sum += v2;
        }
        // A falling particle can gain up to g·dt during this frame.
        const g = planet ? gm / (PLANET_R * PLANET_R) : 0;
        const vmax = Math.max(Math.sqrt(v2max) + g * dt, windSpeedMax);
        const vrms = n > 0 ? Math.sqrt(v2sum / n) : 1;
        const nSub = Math.min(
          MAX_SUBSTEPS,
          Math.max(
            1,
            Math.ceil((vmax * dt) / (SUBSTEP_TRAVEL * r)),
            Math.ceil((g * dt) / (GRAVITY_SPEED_STEP * Math.max(vrms, 1e-6)))
          )
        );
        const h = dt / nSub;
        // Wind trails get a point every WIND_TRAIL_INTERVAL, spread evenly over the substeps.
        const trailPoints = windSpeedMax > 0 ? Math.max(1, Math.round(dt / WIND_TRAIL_INTERVAL)) : 0;
        for (let s = 0; s < nSub; s++) {
          substep(h);
          if (Math.floor(((s + 1) * trailPoints) / nSub) > Math.floor((s * trailPoints) / nSub)) {
            wind.recordTrails();
          }
        }
      }
      if (planet) {
        wind.endFrame(dt);
      }
      simTime += dt;

      if (settings.mode === "box") {
        windowTime += dt;
        if (windowTime >= PRESSURE_WINDOW) {
          const perimeter = 2 * (BOX_W - 2 * r + (BOX_H - 2 * r));
          const p = wallImpulse / (perimeter * windowTime);
          pressure = pressure === null ? p : pressure + (p - pressure) * PRESSURE_SMOOTH;
          wallImpulse = 0;
          windowTime = 0;
        }
      }
      const m = measureGas();
      const a = 1 - Math.exp(-dt / STATS_SMOOTH_TIME);
      smoothTemperature += (m.temperature - smoothTemperature) * a;
      smoothMeanSpeed += (m.meanSpeed - smoothMeanSpeed) * a;
      recordTrail();
    },

    setTemperature(temperature: number): void {
      settings.temperature = temperature;
      rescaleTo(temperature);
      snapReadouts();
    },

    setCount(count: number): void {
      const target = clampCount(settings.mode, count);
      settings.count = target;
      if (target < n) {
        for (let i = n - 1; i >= 0 && n > target; i--) {
          if (ids[i] !== TRACER_ID) {
            removeAt(i);
          }
        }
      } else {
        rebuildGrid(activeGrid());
        while (n < target) {
          addParticle(settings.temperature);
        }
        if (settings.mode === "box") {
          rescaleTo(settings.temperature);
        }
      }
      snapReadouts();
    },

    setPlanetMass(planetMass: number): void {
      settings.planetMass = planetMass;
      gm = GM_PER_MASS * planetMass;
    },

    setWarmGround(warmGround: boolean): void {
      settings.warmGround = warmGround;
    },

    setWind(next: WindSettings): void {
      settings.wind = { ...next };
      wind.configure(settings.wind);
    },

    setPlayback(value: number): void {
      playback = value;
    },

    getSnapshot(): GasSnapshot {
      const planet = settings.mode === "planet";
      let visible = 0;
      let measuredCount = 0;
      for (let i = 0; i < n; i++) {
        const v2 = vx[i] * vx[i] + vy[i] * vy[i];
        const s = Math.sqrt(v2);
        const rad = Math.hypot(x[i], y[i]);
        speed[i] = s;
        canEscape[i] = planet && 0.5 * v2 > gm / rad ? 1 : 0;
        measured[i] = !planet || rad <= NEAR_GROUND_R ? 1 : 0;
        if (Math.abs(x[i]) <= VIEW_HALF_W && Math.abs(y[i]) <= VIEW_HALF_H) {
          visible++;
        }
        measuredCount += measured[i];
      }
      return {
        mode: settings.mode,
        count: n,
        x,
        y,
        speed,
        canEscape,
        measured,
        particleRadius: r,
        tracerIndex: tracerIndex(),
        tracerEscaped,
        trail,
        planetRadius: PLANET_R,
        planetMass: settings.planetMass,
        gm,
        wind: {
          count: planet ? wind.count : 0,
          x: wind.x,
          y: wind.y,
          vx: wind.vx,
          vy: wind.vy,
          trailX: wind.trailX,
          trailY: wind.trailY,
          trailLength: wind.trailLength,
          particleRadius: WIND_PARTICLE_R,
          on: planet && settings.wind.on,
          field: planet && settings.wind.field,
          fieldStrength: settings.wind.fieldStrength,
          shieldRadius: planet ? shieldRadius(settings.wind, PLANET_R) : 0
        },
        stats: {
          simTime,
          temperature: smoothTemperature,
          meanSpeed: smoothMeanSpeed,
          measuredCount,
          visibleCount: visible,
          pressure: settings.mode === "box" ? pressure : null,
          escaped: evaporated + stripped,
          evaporated,
          stripped,
          keptFraction: n + evaporated + stripped > 0 ? n / (n + evaporated + stripped) : 1,
          escapeSpeed: Math.sqrt((2 * gm) / PLANET_R)
        }
      };
    }
  };
}
