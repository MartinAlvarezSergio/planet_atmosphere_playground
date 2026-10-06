import { CSSProperties, HTMLAttributes, ReactNode, RefObject, useEffect, useRef, useState } from "react";
import { useCanvasBackingStore, useEscapeKey, useFullscreen, useHoverHelp } from "./hooks";
import { StageDivider, StageIconButton } from "./StageControls";
import { StageIcon } from "./StageIcon";

export type AppletStageProps = {
  /** Logical canvas size; the stage keeps this aspect ratio and the renderer draws in these units. */
  logicalWidth: number;
  logicalHeight: number;
  canvasRef: RefObject<HTMLCanvasElement>;
  canvasLabel: string;
  canvasProps?: HTMLAttributes<HTMLCanvasElement>;
  /** Called after the main canvas is resized (which clears it); redraw here if you don't animate. */
  onCanvasResize?: () => void;
  /** Left part of the top bar: experiment switch, transport, playback. */
  toolbar?: ReactNode;
  /** Sliders and toggles; shown in the left panel, which the user can hide. */
  controls?: ReactNode;
  /** Numbers shown top right. */
  readouts?: ReactNode;
  /** Small plot or legend, bottom right. */
  inset?: ReactNode;
  /** Optional second inset, bottom left (above the canvas legend). */
  insetLeft?: ReactNode;
  /** Explanations, colour keys and model simplifications: opened from the ⓘ button. */
  info?: ReactNode;
  /** Big play button over the experiment while it is stopped or paused. */
  play?: { visible: boolean; label: string; onClick: () => void };
  /** Content shown under the stage, e.g. captured runs. */
  below?: ReactNode;
  /** "light" for applets whose canvas follows the light colour theme; panels then use light glass. */
  surface?: "dark" | "light";
  /** Extra class on the stage root, so an applet can scope its own small stylesheet. */
  rootClassName?: string;
  /** Width of the controls panel in CSS px (default 240), for panels with long labels. */
  controlsWidth?: number;
  /** Told when the controls panel is shown or hidden, e.g. to keep a plot's axes clear of it. */
  onControlsVisibilityChange?: (visible: boolean) => void;
};

const TIPS = {
  controls: "Show or hide the controls.",
  info: "What the colours and markers mean, and how the model is simplified.",
  fullscreen: "Fill the screen with the experiment."
};

/**
 * Full-bleed experiment with translucent overlay panels. By default the stage is dark in
 * both colour themes (scientific canvases keep a dark surface); `surface="light"` switches
 * the panels to light glass for canvases that follow the light theme.
 */
export function AppletStage(props: AppletStageProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const { isFullscreen, toggleFullscreen } = useFullscreen(stageRef);

  useCanvasBackingStore([props.canvasRef], props.onCanvasResize);

  const { onControlsVisibilityChange } = props;
  useEffect(() => {
    onControlsVisibilityChange?.(showControls);
  }, [showControls, onControlsVisibilityChange]);
  useHoverHelp(stageRef);
  useEscapeKey(showInfo, () => setShowInfo(false));

  const sizeVars = {
    "--stage-w": props.logicalWidth,
    "--stage-h": props.logicalHeight,
    ...(props.controlsWidth ? { "--stage-controls-w": `${props.controlsWidth}px` } : {})
  } as CSSProperties;

  return (
    <div className={`stage-root${props.rootClassName ? ` ${props.rootClassName}` : ""}`} style={sizeVars}>
      <div
        ref={stageRef}
        className={`stage${isFullscreen ? " is-fullscreen" : ""}${props.surface === "light" ? " is-light" : ""}`}
      >
        <div className="stage-canvas-wrap">
          <canvas
            ref={props.canvasRef}
            className="stage-scene"
            role="img"
            aria-label={props.canvasLabel}
            {...props.canvasProps}
          />
          {props.play?.visible ? (
            <button type="button" className="stage-play" aria-label={props.play.label} onClick={props.play.onClick}>
              <StageIcon name="play" />
            </button>
          ) : null}
        </div>

        <div className="stage-glass stage-topbar">
          {props.toolbar}
          {props.toolbar ? <StageDivider /> : null}
          {props.controls ? (
            <StageIconButton
              icon="sliders"
              label="Controls"
              tip={TIPS.controls}
              pressed={showControls}
              onClick={() => setShowControls((s) => !s)}
            />
          ) : null}
          {props.info ? (
            <StageIconButton
              icon="info"
              label="About this model"
              tip={TIPS.info}
              pressed={showInfo}
              onClick={() => setShowInfo((s) => !s)}
            />
          ) : null}
          <StageIconButton
            icon={isFullscreen ? "shrink" : "expand"}
            label={isFullscreen ? "Exit full screen" : "Full screen"}
            tip={TIPS.fullscreen}
            onClick={toggleFullscreen}
          />
        </div>

        {props.controls && showControls ? <div className="stage-glass stage-controls">{props.controls}</div> : null}
        {props.readouts ? <div className="stage-glass stage-readouts">{props.readouts}</div> : null}
        {props.inset ? <div className="stage-glass stage-inset">{props.inset}</div> : null}
        {props.insetLeft ? <div className="stage-glass stage-inset stage-inset-left">{props.insetLeft}</div> : null}

        {props.info && showInfo ? (
          <div className="stage-glass stage-info" role="dialog" aria-label="About this model">
            <span className="stage-info-close">
              <StageIconButton icon="close" label="Close" onClick={() => setShowInfo(false)} />
            </span>
            {props.info}
          </div>
        ) : null}
      </div>
      {props.below ? <div className="stage-below">{props.below}</div> : null}
    </div>
  );
}
