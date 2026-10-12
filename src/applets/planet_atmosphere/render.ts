import { setLogicalTransform } from "../../core/canvasScale";
import { BOX_H, BOX_W, CANVAS_H, CANVAS_W, NEAR_GROUND_R, PX_PER_UNIT } from "./sim";
import type { GasSnapshot } from "./types";
import { AURORA_FADE, fieldAt, fieldModel, WIND_TRAIL_POINTS } from "./wind";

/** Logical size of the histogram overlay (CSS pixels); the backing store follows devicePixelRatio. */
export const HIST_W = 300;
export const HIST_H = 170;

type SceneOptions = {
  showTrail: boolean;
  showGravity: boolean;
  /** Planet mode: 1 shows the standard frame; below 1 looks from further away. */
  zoom: number;
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
/** Solar wind: a hue apart from the warm speed ramp, the cyan escape ring and the white tracer. */
const WIND = "#b9a2ff";
const WIND_RGB = "185, 162, 255";
const WIND_TAIL = `rgba(${WIND_RGB}, 0.45)`;
/** Wind while the magnetic field bends it: aurora-like green, apart from the cyan escape ring. */
const TURNED = "#7dffaa";
const TURNED_RGB = "125, 255, 170";
/** Auroral green (oxygen's 558 nm line). */
const AURORA_RGB = "150, 255, 140";
/** Violet trails show only the newest points; green trails use all WIND_TRAIL_POINTS. */
const VIOLET_TRAIL_POINTS = 14;
const FIELD_RGB = "110, 150, 255";
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

/** Pixels per world unit for the frame being drawn: PX_PER_UNIT times the zoom. */
let scale = PX_PER_UNIT;

function toPx(x: number): number {
  return CANVAS_W / 2 + x * scale;
}

function toPy(y: number): number {
  return CANVAS_H / 2 - y * scale;
}

/** Disks stay at least this big on screen when zoomed out. */
const MIN_DOT_PX = 1.2;

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
  const ringR = 2 * snap.planetRadius * scale;
  // Length ∝ g at the ring, so it scales with planet mass only (the ring is fixed).
  const len = 22 * snap.planetMass * (scale / PX_PER_UNIT);
  const cx = toPx(0);
  const cy = toPy(0);
  for (let k = 0; k < 12; k++) {
    const ang = (k / 12) * Math.PI * 2 + Math.PI / 12;
    const ux = Math.cos(ang);
    const uy = -Math.sin(ang);
    drawArrow(ctx, cx + ux * ringR, cy + uy * ringR, -ux * len, -uy * len, GRAVITY);
  }
}

/** The field glow is computed at this fraction of the canvas resolution and scaled up smoothly. */
const FIELD_SAMPLE = 4;
let fieldLayer: HTMLCanvasElement | null = null;
let fieldLayerKey = "";

/**
 * Glow from the field the wind actually feels: brightest near the planet, a blunt edge facing the
 * Sun, and a faint tail behind. Brightness grows as a gentle power of the strength, so the weak
 * tail still shows.
 */
function drawField(ctx: CanvasRenderingContext2D, snap: GasSnapshot): void {
  const w = snap.wind;
  const model = fieldModel(
    { on: w.on, speed: w.speed, density: w.density, field: true, fieldStrength: w.fieldStrength },
    snap.planetRadius
  );
  if (!model) {
    return;
  }
  const cols = Math.ceil(CANVAS_W / FIELD_SAMPLE);
  const rows = Math.ceil(CANVAS_H / FIELD_SAMPLE);
  if (!fieldLayer) {
    fieldLayer = document.createElement("canvas");
    fieldLayer.width = cols;
    fieldLayer.height = rows;
  }
  const key = `${scale}|${model.nose}|${model.omegaSurface}`;
  const lctx = fieldLayer.getContext("2d");
  if (!lctx) {
    return;
  }
  if (key !== fieldLayerKey) {
    fieldLayerKey = key;
    const image = lctx.createImageData(cols, rows);
    // Just inside the nose: the planet's field there, doubled by the edge currents.
    const atNose = (2 * model.omegaSurface * model.planetR ** 3) / model.nose ** 3;
    for (let j = 0; j < rows; j++) {
      const wy = (CANVAS_H / 2 - (j + 0.5) * FIELD_SAMPLE) / scale;
      for (let i = 0; i < cols; i++) {
        const wx = ((i + 0.5) * FIELD_SAMPLE - CANVAS_W / 2) / scale;
        const om = fieldAt(model, wx, wy);
        const k = 4 * (j * cols + i);
        image.data[k] = 110;
        image.data[k + 1] = 150;
        image.data[k + 2] = 255;
        image.data[k + 3] = om > 0 ? Math.round(255 * Math.min(0.34, 0.24 * (om / atNose) ** 0.35)) : 0;
      }
    }
    lctx.putImageData(image, 0, 0);
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "low";
  ctx.drawImage(fieldLayer, 0, 0, cols * FIELD_SAMPLE, rows * FIELD_SAMPLE);
  ctx.restore();
}

let windInView = new Int32Array(0);

/** Soft glow under bent wind: drawn small, then scaled up, which blurs it (two sizes for a bloom). */
const GLOW_SAMPLES = [4, 10];
const glowLayers: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }[] = [];

function glowLayer(k: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (!glowLayers[k]) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(CANVAS_W / GLOW_SAMPLES[k]);
    canvas.height = Math.ceil(CANVAS_H / GLOW_SAMPLES[k]);
    const gctx = canvas.getContext("2d");
    if (!gctx) {
      return null;
    }
    glowLayers[k] = { canvas, ctx: gctx };
  }
  return glowLayers[k];
}

/**
 * Each wind particle trails its actual recent path, fading with age, so the flow's curves show.
 * While the magnetic field bends a particle it glows green, and so does that stretch of its trail,
 * which lingers twice as long as the violet parts.
 */
function drawWind(ctx: CanvasRenderingContext2D, snap: GasSnapshot): void {
  const w = snap.wind;
  const rpx = Math.max(1.6, w.particleRadius * scale);
  const margin = 320;
  if (windInView.length < w.count) {
    windInView = new Int32Array(w.count);
  }
  let m = 0;
  let anyTurned = false;
  for (let i = 0; i < w.count; i++) {
    const px = toPx(w.x[i]);
    const py = toPy(w.y[i]);
    if (px > -margin && py > -margin && px < CANVAS_W + margin && py < CANVAS_H + margin) {
      windInView[m++] = i;
      for (let k = 0; !anyTurned && k < WIND_TRAIL_POINTS; k++) {
        anyTurned = (k === 0 ? w.bent[i] : w.trailBent[i * WIND_TRAIL_POINTS + k]) === 1;
      }
    }
  }

  // Zoomed out, trail points sit only a few pixels apart: join every stride-th one instead.
  const stride = scale < PX_PER_UNIT * 0.4 ? 3 : scale < PX_PER_UNIT * 0.75 ? 2 : 1;
  // Segment k joins trail point k (newer; point 0 is the particle itself) to point k + stride.
  const segment = (c: CanvasRenderingContext2D, i: number, k: number): void => {
    const base = i * WIND_TRAIL_POINTS;
    c.moveTo(toPx(k === 0 ? w.x[i] : w.trailX[base + k]), toPy(k === 0 ? w.y[i] : w.trailY[base + k]));
    c.lineTo(toPx(w.trailX[base + k + stride]), toPy(w.trailY[base + k + stride]));
  };
  const isTurned = (i: number, k: number): boolean =>
    k === 0 ? w.bent[i] === 1 : w.trailBent[i * WIND_TRAIL_POINTS + k] === 1;
  const strokeAges = (
    c: CanvasRenderingContext2D,
    turnedPart: boolean,
    points: number,
    width: number,
    alpha: number,
    rgb: string
  ): void => {
    c.lineWidth = width;
    for (let k = 0; k + stride < points; k += stride) {
      c.strokeStyle = `rgba(${rgb}, ${(alpha * (1 - k / (points - 1))).toFixed(3)})`;
      c.beginPath();
      for (let j = 0; j < m; j++) {
        const i = windInView[j];
        if (w.trailLength[i] > k + stride && isTurned(i, k) === turnedPart) {
          segment(c, i, k);
        }
      }
      c.stroke();
    }
  };

  // Butt ends: round ones overlap at every joint and show as beads.
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  strokeAges(ctx, false, VIOLET_TRAIL_POINTS, 1.6, 0.7, WIND_RGB);

  if (anyTurned) {
    for (let g = 0; g < GLOW_SAMPLES.length; g++) {
      const layer = glowLayer(g);
      if (!layer) {
        continue;
      }
      const gc = layer.ctx;
      gc.setTransform(1, 0, 0, 1, 0, 0);
      gc.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      gc.setTransform(1 / GLOW_SAMPLES[g], 0, 0, 1 / GLOW_SAMPLES[g], 0, 0);
      gc.globalCompositeOperation = "lighter";
      gc.lineCap = "round";
      gc.lineJoin = "round";
      // Faint per trail, so overlapping trails add up to a soft haze rather than white.
      const zoomFit = Math.sqrt(Math.min(1, scale / PX_PER_UNIT));
      strokeAges(gc, true, WIND_TRAIL_POINTS, (6 + 1.6 * GLOW_SAMPLES[g]) * zoomFit, g === 0 ? 0.11 : 0.07, TURNED_RGB);
      gc.fillStyle = `rgba(${TURNED_RGB}, 0.16)`;
      gc.beginPath();
      for (let j = 0; j < m; j++) {
        const i = windInView[j];
        if (w.bent[i]) {
          const px = toPx(w.x[i]);
          const py = toPy(w.y[i]);
          const r = (4 + GLOW_SAMPLES[g]) * zoomFit;
          gc.moveTo(px + r, py);
          gc.arc(px, py, r, 0, Math.PI * 2);
        }
      }
      gc.fill();
    }
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    for (let g = 0; g < glowLayers.length; g++) {
      const layer = glowLayers[g];
      ctx.drawImage(layer.canvas, 0, 0, layer.canvas.width * GLOW_SAMPLES[g], layer.canvas.height * GLOW_SAMPLES[g]);
    }
    strokeAges(ctx, true, WIND_TRAIL_POINTS, 1.7, 0.8, TURNED_RGB);
    ctx.restore();
  }

  for (const turnedPart of [false, true]) {
    ctx.fillStyle = turnedPart ? TURNED : WIND;
    ctx.beginPath();
    for (let j = 0; j < m; j++) {
      const i = windInView[j];
      if ((w.bent[i] === 1) !== turnedPart) {
        continue;
      }
      const px = toPx(w.x[i]);
      const py = toPy(w.y[i]);
      ctx.moveTo(px + rpx, py);
      ctx.arc(px, py, rpx, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

/**
 * Aurora: soft green glows on the disk (seen from above the pole) where slipped-in wind reached the
 * upper air, fading over about a second.
 */
function drawAurora(ctx: CanvasRenderingContext2D, snap: GasSnapshot): void {
  const w = snap.wind;
  const radius = Math.max(5, 0.16 * snap.planetRadius * scale);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let k = 0; k < w.auroraCount; k++) {
    const glow = 0.45 * Math.exp(-w.auroraAge[k] / AURORA_FADE);
    const px = toPx(w.auroraX[k]);
    const py = toPy(w.auroraY[k]);
    const g = ctx.createRadialGradient(px, py, 0, px, py, radius);
    g.addColorStop(0, `rgba(${AURORA_RGB}, ${glow.toFixed(3)})`);
    g.addColorStop(1, `rgba(${AURORA_RGB}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPlanet(ctx: CanvasRenderingContext2D, snap: GasSnapshot): void {
  const cx = toPx(0);
  const cy = toPy(0);
  const rpx = snap.planetRadius * scale;

  // Faint ring: the layer whose speeds feed the temperature readout and histogram.
  ctx.strokeStyle = HAIRLINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, NEAR_GROUND_R * scale, 0, Math.PI * 2);
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
  const rpx = Math.max(MIN_DOT_PX, snap.particleRadius * scale);
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
  const rpx = Math.max(MIN_DOT_PX, snap.particleRadius * scale);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(toPx(snap.x[i]), toPy(snap.y[i]), rpx + 3, 0, Math.PI * 2);
  ctx.stroke();
}

/** Right edge for the bottom-left key; past it the key starts a second row, clear of the histogram card. */
const LEGEND_RIGHT = 560;

/** Bottom-left key: speed colours, plus the markers that are currently in use. */
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

  const keys: { label: string; draw: (kx: number, ky: number) => void }[] = [];
  const ring = (color: string) => (kx: number, ky: number): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(kx + 5, ky, 5, 0, Math.PI * 2);
    ctx.stroke();
  };
  if (snap.mode === "planet") {
    keys.push({ label: "faster than escape speed", draw: ring(ESCAPE) });
  }
  if (showTrail) {
    keys.push({ label: snap.tracerEscaped ? "followed (escaped)" : "followed", draw: ring("#ffffff") });
  }
  if (snap.wind.on || snap.wind.count > 0) {
    keys.push({
      label: "solar wind",
      draw: (kx, ky) => {
        ctx.strokeStyle = WIND_TAIL;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(kx - 4, ky);
        ctx.lineTo(kx + 8, ky);
        ctx.stroke();
        ctx.fillStyle = WIND;
        ctx.beginPath();
        ctx.arc(kx + 9, ky, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
  if (snap.wind.field && (snap.wind.on || snap.wind.count > 0)) {
    keys.push({
      label: "bent by the field",
      draw: (kx, ky) => {
        ctx.strokeStyle = `rgba(${TURNED_RGB}, 0.35)`;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(kx - 3, ky);
        ctx.lineTo(kx + 8, ky);
        ctx.stroke();
        ctx.strokeStyle = TURNED;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.fillStyle = TURNED;
        ctx.beginPath();
        ctx.arc(kx + 9, ky, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
  if (snap.wind.auroraCount > 0) {
    keys.push({
      label: "aurora",
      draw: (kx, ky) => {
        const g = ctx.createRadialGradient(kx + 5, ky, 0, kx + 5, ky, 7);
        g.addColorStop(0, `rgba(${AURORA_RGB}, 0.85)`);
        g.addColorStop(1, `rgba(${AURORA_RGB}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(kx + 5, ky, 7, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
  if (snap.wind.field) {
    keys.push({
      label: "magnetic field",
      draw: (kx, ky) => {
        const g = ctx.createRadialGradient(kx + 5, ky, 0, kx + 5, ky, 7);
        g.addColorStop(0, `rgba(${FIELD_RGB}, 0.7)`);
        g.addColorStop(1, `rgba(${FIELD_RGB}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(kx + 5, ky, 7, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
  // A key that would run into the histogram card starts a new row above.
  const placed: { x: number; y: number; key: (typeof keys)[number] }[] = [];
  let rowY = y;
  for (const key of keys) {
    const width = 15 + ctx.measureText(key.label).width;
    if (x + width > LEGEND_RIGHT && x > 16) {
      rowY -= 18;
      x = 16;
    }
    placed.push({ x, y: rowY, key });
    x += width + 18;
  }
  for (const p of placed) {
    p.key.draw(p.x, p.y);
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(p.key.label, p.x + 15, p.y);
  }
}

export function renderGasScene(
  ctx: CanvasRenderingContext2D,
  snap: GasSnapshot,
  options: SceneOptions
): void {
  setLogicalTransform(ctx, CANVAS_W);
  scale = snap.mode === "planet" ? PX_PER_UNIT * options.zoom : PX_PER_UNIT;
  const bg = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  bg.addColorStop(0, SURFACE_TOP);
  bg.addColorStop(1, SURFACE_BOTTOM);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  if (snap.mode === "box") {
    drawBox(ctx);
  } else {
    if (snap.wind.field) {
      drawField(ctx, snap);
    }
    if (options.showGravity) {
      drawGravityArrows(ctx, snap);
    }
    drawPlanet(ctx, snap);
    if (snap.wind.auroraCount > 0) {
      drawAurora(ctx, snap);
    }
  }
  if (options.showTrail) {
    drawTrail(ctx, snap);
  }
  if (snap.wind.count > 0) {
    drawWind(ctx, snap);
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
