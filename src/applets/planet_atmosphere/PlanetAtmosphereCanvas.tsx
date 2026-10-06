import { useEffect, useMemo, useRef, useState } from "react";
import { AppletHostAdapter } from "../../core/host";
import { AppletStage } from "../../ui/stage/AppletStage";
import { useCanvasBackingStore } from "../../ui/stage/hooks";
import {
  StageDivider,
  StageHero,
  StageIconButton,
  StagePillButton,
  StagePills,
  StageReadout,
  StageSegmented,
  StageSlider,
  StageToggle
} from "../../ui/stage/StageControls";
import { HIST_H, HIST_W, renderGasScene, renderSpeedHistogram } from "./render";
import {
  BOX_COUNT_DEFAULT,
  CANVAS_H,
  CANVAS_W,
  countLimits,
  createGasSim,
  PLANET_COUNT_DEFAULT,
  PLANET_MASS_DEFAULT,
  PLANET_MASS_MAX,
  PLANET_MASS_MIN,
  PLANET_PRESETS,
  TEMPERATURE_DEFAULT,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN
} from "./sim";
import type { GasMode, GasSettings, GasStats, PlanetPresetId } from "./types";

type Props = {
  host?: AppletHostAdapter;
};

const TIP = {
  box: "Gas sealed in a box: see what temperature means.",
  planet: "The same gas around a planet: see when gravity can hold on to it.",
  play: "Start or pause the motion. Sliders work while paused.",
  reset: "Rebuild the starting gas with the current settings.",
  playback: "Animation speed only; the physics is the same.",
  temperatureBox: "Average energy of motion. Moving the slider speeds up or slows down every particle.",
  temperatureElastic:
    "Heats or cools the gas now. With an elastic ground nothing keeps it warm, so it can cool again.",
  temperatureWarm: "Temperature of the sun-warmed ground; particles leave it with matching speeds.",
  densityBox: "Number of particles in the box. More particles → more collisions and wall hits.",
  densityPlanet: "Amount of gas on the planet (number of particles).",
  mass: "Planet mass; the size stays the same. More mass → stronger gravity → higher escape speed.",
  warmGround:
    "On: particles bounce off the ground with fresh thermal speeds at the set temperature, like sunlit soil.\nOff: perfectly elastic ground; no energy is added, so the gas cools as it rises and as fast particles escape.",
  trail: "Highlight one particle and draw its recent path.",
  gravity: "Arrows show the pull of gravity; longer = stronger.",
  kept: "Share of the gas still bound to the planet, including any that drifted off-screen on returning paths.",
  temperatureReadout: "Measured from the particle speeds.",
  temperatureReadoutPlanet: "Measured from the speeds of the gas inside the faint ring near the ground.",
  pressure: "Push of the particles on the walls (force per unit length).",
  escapeSpeed: "Speed needed to leave the planet from its surface.",
  histogram:
    "How many particles have each speed; bars use the particle colours.\nLine: the spread expected at the measured temperature (Maxwell–Boltzmann).",
  histogramPlanet:
    "Speeds of the gas near the ground; bars use the particle colours.\nLine: the spread expected at the measured temperature.\nShaded: faster than escape speed."
} as const;

const PRESETS: { id: PlanetPresetId; label: string; tip: string }[] = [
  { id: "big_planet", label: "Heavy", tip: "Heavy planet: mass 1.6×, temperature 1." },
  { id: "small_planet", label: "Light", tip: "Light planet: mass 0.25×, temperature 1." },
  { id: "hot_gas", label: "Hot", tip: "Hot gas: mass 1×, temperature 2.6." },
  { id: "small_cold", label: "Cold", tip: "Light planet with cold gas: mass 0.3×, temperature 0.3." }
];

const PLAYBACK_OPTIONS = [
  { value: 0.5, label: "½×" },
  { value: 1, label: "1×" },
  { value: 2, label: "2×" }
];

/** The density slider is logarithmic so sparse and dense gases both get room. */
const COUNT_SLIDER_STEPS = 1000;

function countFromSlider(pos: number, min: number, max: number): number {
  const v = min * (max / min) ** (pos / COUNT_SLIDER_STEPS);
  const step = v < 100 ? 1 : v < 1000 ? 10 : 50;
  return Math.min(max, Math.max(min, Math.round(v / step) * step));
}

function sliderFromCount(count: number, min: number, max: number): number {
  return Math.round((COUNT_SLIDER_STEPS * Math.log(count / min)) / Math.log(max / min));
}

export function PlanetAtmosphereCanvas({ host }: Props): JSX.Element {
  const sceneRef = useRef<HTMLCanvasElement | null>(null);
  const histRef = useRef<HTMLCanvasElement | null>(null);

  const reducedMotion = host?.readReducedMotion?.() ?? false;

  const [mode, setMode] = useState<GasMode>("box");
  const [temperature, setTemperature] = useState(TEMPERATURE_DEFAULT);
  const [boxCount, setBoxCount] = useState(BOX_COUNT_DEFAULT);
  const [planetCount, setPlanetCount] = useState(PLANET_COUNT_DEFAULT);
  const [planetMass, setPlanetMass] = useState(PLANET_MASS_DEFAULT);
  const [warmGround, setWarmGround] = useState(false);
  const [playback, setPlayback] = useState<number>(reducedMotion ? 0.5 : 1);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [showTrail, setShowTrail] = useState(false);
  const [showGravity, setShowGravity] = useState(true);
  const [stats, setStats] = useState<GasStats | null>(null);

  const sim = useMemo(
    () =>
      createGasSim({
        mode: "box",
        temperature: TEMPERATURE_DEFAULT,
        count: BOX_COUNT_DEFAULT,
        planetMass: PLANET_MASS_DEFAULT,
        warmGround: false
      }),
    []
  );

  const planet = mode === "planet";
  const count = planet ? planetCount : boxCount;
  const limits = countLimits(mode);
  const current: GasSettings = { mode, temperature, count, planetMass, warmGround };
  const moving = running && !paused;

  useCanvasBackingStore([histRef]);

  useEffect(() => {
    sim.setPlayback(playback);
  }, [playback, sim]);

  useEffect(() => {
    const sctx = sceneRef.current?.getContext("2d");
    const hctx = histRef.current?.getContext("2d");
    if (!sctx || !hctx) {
      return;
    }
    let last = performance.now();
    let lastReadout = -Infinity;
    let raf = 0;
    const tick = (time: number): void => {
      const dt = (time - last) / 1000;
      last = time;
      if (moving) {
        sim.step(dt);
      }
      const snap = sim.getSnapshot();
      renderGasScene(sctx, snap, { showTrail, showGravity });
      renderSpeedHistogram(hctx, snap);
      // Text readouts refresh a few times per second; canvases redraw every frame.
      if (time - lastReadout > 150) {
        lastReadout = time;
        setStats({ ...snap.stats });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [moving, showGravity, showTrail, sim]);

  // Before Start, setting changes rebuild a settled starting gas; afterwards they act on the live gas.
  function onModeChange(next: GasMode): void {
    if (next === mode) {
      return;
    }
    setMode(next);
    setRunning(false);
    setPaused(false);
    sim.reset({ ...current, mode: next, count: next === "planet" ? planetCount : boxCount });
  }

  function onTemperatureChange(value: number): void {
    setTemperature(value);
    if (running) {
      sim.setTemperature(value);
    } else {
      sim.reset({ ...current, temperature: value });
    }
  }

  function onCountChange(value: number): void {
    if (value === count) {
      return;
    }
    if (planet) {
      setPlanetCount(value);
    } else {
      setBoxCount(value);
    }
    if (running) {
      sim.setCount(value);
    } else {
      sim.reset({ ...current, count: value });
    }
  }

  function onPlanetMassChange(value: number): void {
    setPlanetMass(value);
    if (running) {
      sim.setPlanetMass(value);
    } else {
      sim.reset({ ...current, planetMass: value });
    }
  }

  function onWarmGroundChange(on: boolean): void {
    setWarmGround(on);
    sim.setWarmGround(on);
  }

  function applyPreset(id: PlanetPresetId): void {
    const preset = PLANET_PRESETS[id];
    setTemperature(preset.temperature);
    setPlanetMass(preset.planetMass);
    sim.reset({ ...current, ...preset });
  }

  function onPlayPause(): void {
    if (!running) {
      setRunning(true);
      setPaused(false);
    } else {
      setPaused((p) => !p);
    }
  }

  function onReset(): void {
    setRunning(false);
    setPaused(false);
    sim.reset(current);
    host?.onResult?.({ event: "reset", mode });
  }

  const temperatureTip = !planet ? TIP.temperatureBox : warmGround ? TIP.temperatureWarm : TIP.temperatureElastic;
  const playLabel = moving ? "Pause" : running ? "Resume" : "Start";

  const toolbar = (
    <>
      <StageSegmented
        ariaLabel="Experiment"
        value={mode}
        options={[
          { value: "box", label: "Box", tip: TIP.box },
          { value: "planet", label: "Planet", tip: TIP.planet }
        ]}
        onChange={onModeChange}
      />
      <StageDivider />
      <StageIconButton icon={moving ? "pause" : "play"} label={playLabel} tip={TIP.play} onClick={onPlayPause} />
      <StageIconButton icon="reset" label="Reset" tip={TIP.reset} onClick={onReset} />
      <StageSegmented ariaLabel="Playback speed" tip={TIP.playback} value={playback} options={PLAYBACK_OPTIONS} onChange={setPlayback} />
    </>
  );

  const controls = (
    <>
      <StageSlider
        label={planet && warmGround ? "Ground temperature" : "Temperature"}
        display={temperature.toFixed(2)}
        value={temperature}
        min={TEMPERATURE_MIN}
        max={TEMPERATURE_MAX}
        step={0.05}
        tip={temperatureTip}
        onChange={onTemperatureChange}
      />
      <StageSlider
        label="Density"
        display={`${count}`}
        value={sliderFromCount(count, limits.min, limits.max)}
        min={0}
        max={COUNT_SLIDER_STEPS}
        step={1}
        tip={planet ? TIP.densityPlanet : TIP.densityBox}
        onChange={(pos) => onCountChange(countFromSlider(pos, limits.min, limits.max))}
      />
      {planet ? (
        <StageSlider
          label="Planet mass"
          display={`${planetMass.toFixed(2)}×`}
          value={planetMass}
          min={PLANET_MASS_MIN}
          max={PLANET_MASS_MAX}
          step={0.05}
          tip={TIP.mass}
          onChange={onPlanetMassChange}
        />
      ) : null}
      <StagePills>
        {planet ? <StageToggle label="Warm ground" on={warmGround} tip={TIP.warmGround} onChange={onWarmGroundChange} /> : null}
        <StageToggle label="Follow" on={showTrail} tip={TIP.trail} onChange={setShowTrail} />
        {planet ? <StageToggle label="Gravity" on={showGravity} tip={TIP.gravity} onChange={setShowGravity} /> : null}
      </StagePills>
      {planet ? (
        <div className="stage-pills stage-presets">
          {PRESETS.map((p) => (
            <StagePillButton key={p.id} label={p.label} tip={p.tip} onClick={() => applyPreset(p.id)} />
          ))}
        </div>
      ) : null}
    </>
  );

  const readouts = stats ? (
    <>
      {planet ? (
        <>
          {/* Round down so a single escapee never reads as 100%. */}
          <StageHero label="Kept" value={`${Math.floor(stats.keptFraction * 100)}%`} tip={TIP.kept} />
          <StageReadout label="Escaped" value={String(stats.escaped)} />
          <StageReadout label="Escape speed" value={stats.escapeSpeed.toFixed(2)} tip={TIP.escapeSpeed} />
          <StageReadout label="Avg speed" value={stats.meanSpeed.toFixed(2)} tip={TIP.temperatureReadoutPlanet} />
          <StageReadout label="Temperature" value={stats.temperature.toFixed(2)} tip={TIP.temperatureReadoutPlanet} />
        </>
      ) : (
        <>
          <StageReadout label="Temperature" value={stats.temperature.toFixed(2)} tip={TIP.temperatureReadout} />
          <StageReadout label="Avg speed" value={stats.meanSpeed.toFixed(2)} />
          <StageReadout label="Pressure" value={stats.pressure === null ? "…" : stats.pressure.toFixed(1)} tip={TIP.pressure} />
        </>
      )}
      <StageReadout label="Time" value={stats.simTime.toFixed(1)} muted />
    </>
  ) : null;

  const inset = (
    <div title={planet ? TIP.histogramPlanet : TIP.histogram} data-hover-help={planet ? TIP.histogramPlanet : TIP.histogram}>
      <canvas ref={histRef} style={{ width: HIST_W, aspectRatio: `${HIST_W} / ${HIST_H}` }} />
    </div>
  );

  const info = (
    <>
      <h4>Reading the picture</h4>
      <ul>
        <li>
          Colour is particle speed. The histogram counts speeds; its line is the spread expected at that temperature
          (Maxwell–Boltzmann).
        </li>
        {planet ? (
          <>
            <li>
              A blue ring marks a particle faster than escape speed at its height. One that leaves the frame that fast is
              gone for good.
            </li>
            <li>Temperature and the histogram use the gas inside the faint ring near the ground.</li>
          </>
        ) : (
          <li>
            Pressure comes from wall hits. In a dense gas it rises above the ideal-gas value because the particles take up
            room.
          </li>
        )}
      </ul>
      {planet ? (
        <>
          <h4>Ground</h4>
          <ul>
            <li>Warm ground: particles leave the ground with thermal speeds at the set temperature, like sunlit soil.</li>
            <li>Elastic ground: no energy is added, so the gas cools as it rises and as its fastest particles escape.</li>
          </ul>
        </>
      ) : null}
      <h4>Model</h4>
      <ul>
        <li>2D hard disks with elastic collisions; gravity from the planet only (the gas does not attract itself).</li>
        <li>Sizes, speeds and times are scaled for viewing; real planets lose gas far more slowly.</li>
      </ul>
    </>
  );

  return (
    <AppletStage
      logicalWidth={CANVAS_W}
      logicalHeight={CANVAS_H}
      canvasRef={sceneRef}
      canvasLabel={planet ? "Gas particles around a planet, coloured by speed" : "Gas particles in a box, coloured by speed"}
      toolbar={toolbar}
      controls={controls}
      readouts={readouts}
      inset={inset}
      info={info}
      play={{ visible: !moving, label: playLabel, onClick: onPlayPause }}
    />
  );
}
