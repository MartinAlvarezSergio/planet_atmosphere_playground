import { setLogicalTransform } from "../../core/canvasScale";
import { BOX_H, BOX_W, CANVAS_H, CANVAS_W, NEAR_GROUND_R, PX_PER_UNIT } from "./sim";
import type { GasSnapshot } from "./types";

/** Logical size of the histogram overlay (CSS pixels); the backing store follows devicePixelRatio. */
export const HIST_W = 300;
export const HIST_H = 170;

type SceneOptions = {
  showTrail: boolean;
  showGravity: boolean;
};

/**
 * Sequential slow→fast ramp ("glowing hotter"), checked for monotone lightness and
 * ≥ 3:1 contrast of the slowest step against the dark canvas.
 */
const SPEED_RAMP = ["#b84a2a", "#d8622f", "#ee8838", "#f7ad5e", "#fdd9a6"];
/** Speeds at or above this get the brightest colour; fixed so heating visibly shifts colours. */
const COLOR_SPEED_MAX = 3.2;
const LUT_SIZE = 48;

const SURFACE_TOP = "#060a12";
const SURFACE_BOTTOM = "#0f141c";
const TEXT = "rgba(230, 228, 220, 0.92)";
const TEXT_MUTED = "rgba(200, 196, 188, 0.72)";
const HAIRLINE = "rgba(255, 255, 255, 0.14)";
const ESCAPE = "#66d9ff";
const ESCAPE_WASH = "rgba(102, 217, 255, 0.1)";
const WALL = "rgba(222, 216, 204, 0.75)";
const GRAVITY = "rgba(150, 178, 210, 0.55)";
const FONT_SMALL = "11px system-ui, sans-serif";

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function buildSpeedLut(): string[] {
  const stops = SPEED_RAMP.map(hexToRgb);
  const lut: string[] = [];
  for (let k = 0; k < LUT_SIZE; k++) {
    const pos = (k / (LUT_SIZE - 1)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(pos));
    const f = pos - i;
    const a = stops[i];
    const b = stops[i + 1];
    const mix = (c: number): number => Math.round(a[c] + (b[c] - a[c]) * f);
    lut.push(`rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`);
  }
  return lut;
}

const SPEED_LUT = buildSpeedLut();

function speedBucket(speed: number): number {
  return Math.min(LUT_SIZE - 1, Math.max(0, Math.round((speed / COLOR_SPEED_MAX) * (LUT_SIZE - 1))));
}

function toPx(x: number): number {
  return CANVAS_W / 2 + x * PX_PER_UNIT;
}

function toPy(y: number): number {
  return CANVAS_H / 2 - y * PX_PER_UNIT;
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: string
): void {
  const len = Math.hypot(dx, dy);
  if (len < 1) {
    return;
  }
  const ux = dx / len;
  const uy = dy / len;
  const head = Math.min(7, 2.5 + len * 0.25);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + dx - ux * head, y + dy - uy * head);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + dx, y + dy);
  ctx.lineTo(x + dx - ux * head - uy * head * 0.6, y + dy - uy * head + ux * head * 0.6);
  ctx.lineTo(x + dx - ux * head + uy * head * 0.6, y + dy - uy * head - ux * head * 0.6);
  ctx.closePath();
  ctx.fill();
}

function drawBox(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = WALL;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(toPx(-BOX_W / 2), toPy(BOX_H / 2), BOX_W * PX_PER_UNIT, BOX_H * PX_PER_UNIT, 6);
  ctx.stroke();
}

function drawGravityArrows(ctx: CanvasRenderingContext2D, snap: GasSnapshot): void {
  const ringR = 2 * snap.planetRadius * PX_PER_UNIT;
  // Length ∝ g at the ring, so it scales with planet mass only (the ring is fixed).
  const len = 22 * snap.planetMass;
  const cx = toPx(0);
  const cy = toPy(0);
  for (let k = 0; k < 12; k++) {
    const ang = (k / 12) * Math.PI * 2 + Math.PI / 12;
    const ux = Math.cos(ang);
    const uy = -Math.sin(ang);
    drawArrow(ctx, cx + ux * ringR, cy + uy * ringR, -ux * len, -uy * len, GRAVITY);
  }
}

function drawPlanet(ctx: CanvasRenderingContext2D, snap: GasSnapshot): void {
  const cx = toPx(0);
  const cy = toPy(0);
  const rpx = snap.planetRadius * PX_PER_UNIT;

  // Faint ring: the layer whose speeds feed the temperature readout and histogram.
  ctx.strokeStyle = HAIRLINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, NEAR_GROUND_R * PX_PER_UNIT, 0, Math.PI * 2);
  ctx.stroke();

  const g = ctx.createRadialGradient(cx - rpx * 0.35, cy - rpx * 0.35, rpx * 0.1, cx, cy, rpx);
  g.addColorStop(0, "#5a83a8");
  g.addColorStop(1, "#1c3149");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, rpx, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(150, 190, 225, 0.65)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawTrail(ctx: CanvasRenderingContext2D, snap: GasSnapshot): void {
  if (snap.trail.length < 2) {
    return;
  }
  ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
  ctx.lineWidth = 1.25;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(toPx(snap.trail[0].x), toPy(snap.trail[0].y));
  for (let k = 1; k < snap.trail.length; k++) {
    ctx.lineTo(toPx(snap.trail[k].x), toPy(snap.trail[k].y));
  }
  ctx.stroke();
}

let bucketScratch = new Uint8Array(0);

function drawParticles(ctx: CanvasRenderingContext2D, snap: GasSnapshot): void {
  const rpx = snap.particleRadius * PX_PER_UNIT;
  const n = snap.count;
  const used = new Uint8Array(LUT_SIZE);
  if (bucketScratch.length < n) {
    bucketScratch = new Uint8Array(n);
  }
  for (let i = 0; i < n; i++) {
    const b = speedBucket(snap.speed[i]);
    bucketScratch[i] = b;
    used[b] = 1;
  }
  // One path per colour keeps fillStyle switches to at most LUT_SIZE per frame.
  for (let b = 0; b < LUT_SIZE; b++) {
    if (!used[b]) {
      continue;
    }
    ctx.fillStyle = SPEED_LUT[b];
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (bucketScratch[i] !== b) {
        continue;
      }
      const px = toPx(snap.x[i]);
      const py = toPy(snap.y[i]);
      if (px < -rpx || py < -rpx || px > CANVAS_W + rpx || py > CANVAS_H + rpx) {
        continue;
      }
      ctx.moveTo(px + rpx, py);
      ctx.arc(px, py, rpx, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  if (snap.mode === "planet") {
    ctx.strokeStyle = ESCAPE;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (!snap.canEscape[i]) {
        continue;
      }
      const px = toPx(snap.x[i]);
      const py = toPy(snap.y[i]);
      ctx.moveTo(px + rpx + 1.8, py);
      ctx.arc(px, py, rpx + 1.8, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
}

function drawTracer(ctx: CanvasRenderingContext2D, snap: GasSnapshot): void {
  const i = snap.tracerIndex;
  if (i < 0) {
    return;
  }
  const rpx = snap.particleRadius * PX_PER_UNIT;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(toPx(snap.x[i]), toPy(snap.y[i]), rpx + 3, 0, Math.PI * 2);
  ctx.stroke();
}

/** Bottom-left key: speed colours, plus the ring markers that are currently in use. */
function drawLegend(ctx: CanvasRenderingContext2D, snap: GasSnapshot, showTrail: boolean): void {
  const y = CANVAS_H - 12;
  let x = 16;
  ctx.font = FONT_SMALL;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText("slow", x, y);
  x += ctx.measureText("slow").width + 6;
  const barW = 70;
  const grad = ctx.createLinearGradient(x, 0, x + barW, 0);
  SPEED_RAMP.forEach((c, k) => grad.addColorStop(k / (SPEED_RAMP.length - 1), c));
  ctx.fillStyle = grad;
  ctx.fillRect(x, y - 3.5, barW, 7);
  x += barW + 6;
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText("fast", x, y);
  x += ctx.measureText("fast").width + 18;

  const ringKey = (color: string, label: string): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x + 5, y, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(label, x + 15, y);
    x += 15 + ctx.measureText(label).width + 18;
  };
  if (snap.mode === "planet") {
    ringKey(ESCAPE, "faster than escape speed");
  }
  if (showTrail) {
    ringKey("#ffffff", snap.tracerEscaped ? "followed (escaped)" : "followed");
  }
}

export function renderGasScene(
  ctx: CanvasRenderingContext2D,
  snap: GasSnapshot,
  options: SceneOptions
): void {
  setLogicalTransform(ctx, CANVAS_W);
  const bg = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  bg.addColorStop(0, SURFACE_TOP);
  bg.addColorStop(1, SURFACE_BOTTOM);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  if (snap.mode === "box") {
    drawBox(ctx);
  } else {
    if (options.showGravity) {
      drawGravityArrows(ctx, snap);
    }
    drawPlanet(ctx, snap);
  }
  if (options.showTrail) {
    drawTrail(ctx, snap);
  }
  drawParticles(ctx, snap);
  if (options.showTrail) {
    drawTracer(ctx, snap);
  }
  drawLegend(ctx, snap, options.showTrail);
}

/** Rounds up to a clean number (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k) for the y-axis top. */
function niceCeil(v: number): number {
  if (v <= 0) {
    return 1;
  }
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (v <= m * p) {
      return m * p;
    }
  }
  return 10 * p;
}

const HIST_BINS = 32;

/** Transparent background: the overlay card behind it provides the surface. */
export function renderSpeedHistogram(ctx: CanvasRenderingContext2D, snap: GasSnapshot): void {
  setLogicalTransform(ctx, HIST_W);
  ctx.clearRect(0, 0, HIST_W, HIST_H);

  const left = 30;
  const right = HIST_W - 8;
  const top = 24;
  const bottom = HIST_H - 22;
  const plotW = right - left;
  const plotH = bottom - top;
  const planet = snap.mode === "planet";
  const vMax = planet ? 6.5 : 5;
  const dv = vMax / HIST_BINS;

  const counts = new Array<number>(HIST_BINS).fill(0);
  for (let i = 0; i < snap.count; i++) {
    if (!snap.measured[i]) {
      continue;
    }
    const b = Math.floor(snap.speed[i] / dv);
    if (b < HIST_BINS) {
      counts[b]++;
    }
  }
  const nMeas = snap.stats.measuredCount;
  const T = snap.stats.temperature;
  // 2D Maxwell–Boltzmann speed distribution, scaled to counts per bin.
  const expected = (v: number): number => (T > 0 ? nMeas * dv * (v / T) * Math.exp((-v * v) / (2 * T)) : 0);
  const peakExpected = T > 0 ? expected(Math.sqrt(T)) : 0;
  // Scale to the smooth expected peak so the axis doesn't jump with the noisy tallest bar.
  const yMax = niceCeil(Math.max(1, peakExpected * 1.4, Math.max(...counts) * 1.05));
  const xOf = (v: number): number => left + (v / vMax) * plotW;
  const yOf = (c: number): number => bottom - (c / yMax) * plotH;

  ctx.font = "10px system-ui, sans-serif";
  ctx.lineWidth = 1;
  ctx.strokeStyle = HAIRLINE;
  ctx.fillStyle = TEXT_MUTED;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const c of [0, yMax]) {
    const y = Math.round(yOf(c)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(c)), left - 5, y);
  }

  ctx.textBaseline = "top";
  ctx.textAlign = "right";
  ctx.fillText("speed", right, bottom + 4);
  const labelLeft = right - ctx.measureText("speed").width - 4;
  ctx.textAlign = "center";
  for (let v = 0; v <= vMax + 1e-9; v += 1) {
    // Skip ticks that would run into the axis label.
    if (xOf(v) + 6 < labelLeft) {
      ctx.fillText(String(v), xOf(v), bottom + 4);
    }
  }

  const vEsc = snap.stats.escapeSpeed;
  if (planet && vEsc < vMax) {
    ctx.fillStyle = ESCAPE_WASH;
    ctx.fillRect(xOf(vEsc), top, right - xOf(vEsc), plotH);
  }

  // Bars, coloured by speed so the histogram doubles as the particle colour key.
  const binW = plotW / HIST_BINS;
  for (let b = 0; b < HIST_BINS; b++) {
    if (counts[b] === 0) {
      continue;
    }
    const x = left + b * binW + 1;
    const y = yOf(counts[b]);
    const bh = bottom - y;
    ctx.fillStyle = SPEED_LUT[speedBucket((b + 0.5) * dv)];
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(1, binW - 2), bh, bh > 3 ? [2, 2, 0, 0] : 0);
    ctx.fill();
  }

  if (T > 0) {
    ctx.strokeStyle = TEXT;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let k = 0; k <= 160; k++) {
      const v = (k / 160) * vMax;
      const y = yOf(expected(v + dv / 2));
      if (k === 0) {
        ctx.moveTo(xOf(v), y);
      } else {
        ctx.lineTo(xOf(v), y);
      }
    }
    ctx.stroke();
  }

  if (planet && vEsc < vMax) {
    const x = Math.round(xOf(vEsc)) + 0.5;
    ctx.strokeStyle = ESCAPE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.fillStyle = TEXT_MUTED;
    ctx.textBaseline = "top";
    const label = "escape speed";
    const fitsRight = x + 4 + ctx.measureText(label).width <= right;
    ctx.textAlign = fitsRight ? "left" : "right";
    ctx.fillText(label, fitsRight ? x + 4 : x - 4, top + 2);
  }

  // Legend: bar swatch + line key.
  ctx.font = FONT_SMALL;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const ly = 10;
  ctx.fillStyle = SPEED_LUT[Math.round(LUT_SIZE * 0.35)];
  ctx.beginPath();
  ctx.roundRect(left, ly - 5, 7, 10, [2, 2, 0, 0]);
  ctx.fill();
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText("now", left + 11, ly);
  const lx = left + 11 + ctx.measureText("now").width + 14;
  ctx.strokeStyle = TEXT;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.lineTo(lx + 14, ly);
  ctx.stroke();
  ctx.fillText("expected", lx + 18, ly);

  if (nMeas === 0) {
    ctx.fillStyle = TEXT;
    ctx.textAlign = "center";
    ctx.fillText("no gas", left + plotW / 2, top + plotH / 2);
  }
}
