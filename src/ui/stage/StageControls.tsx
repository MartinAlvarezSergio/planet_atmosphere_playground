import { ReactNode } from "react";
import { StageIcon, StageIconName } from "./StageIcon";

/**
 * Minimal controls for the applet stage's glass panels. Each shows only its name and
 * value; the explanation goes in `tip` (hover tooltip and native title).
 */

type Tip = { tip?: string };

function tipProps(tip?: string): { title?: string; "data-hover-help"?: string } {
  return tip ? { title: tip, "data-hover-help": tip } : {};
}

export function StageSlider(
  props: Tip & {
    label: ReactNode;
    display: string;
    value: number;
    min: number;
    max: number;
    step: number;
    disabled?: boolean;
    onChange: (value: number) => void;
  }
): JSX.Element {
  return (
    <label className="stage-field" {...tipProps(props.tip)}>
      <span className="stage-field-head">
        <span>{props.label}</span>
        <strong>{props.display}</strong>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** With `label` it is a labelled field for the controls panel; without, a bare select for the top bar. */
export function StageSelect<T extends string>(
  props: Tip & {
    label?: ReactNode;
    ariaLabel?: string;
    value: T;
    options: { value: T; label: string }[];
    disabled?: boolean;
    onChange: (value: T) => void;
  }
): JSX.Element {
  const select = (
    <select
      value={props.value}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      onChange={(e) => props.onChange(e.target.value as T)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  if (props.label == null) {
    return (
      <span className="stage-select-bare" {...tipProps(props.tip)}>
        {select}
      </span>
    );
  }
  return (
    <label className="stage-field" {...tipProps(props.tip)}>
      <span className="stage-field-head">
        <span>{props.label}</span>
      </span>
      {select}
    </label>
  );
}

export function StageTextField(
  props: Tip & {
    label: ReactNode;
    value: string | number;
    type?: "text" | "number";
    placeholder?: string;
    min?: number;
    step?: number;
    disabled?: boolean;
    onChange: (value: string) => void;
  }
): JSX.Element {
  return (
    <label className="stage-field stage-field-inline" {...tipProps(props.tip)}>
      <span>{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        min={props.min}
        step={props.step}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

/** Pill button with aria-pressed, for on/off settings and display toggles. */
export function StageToggle(
  props: Tip & { label: ReactNode; on: boolean; disabled?: boolean; onChange: (on: boolean) => void }
): JSX.Element {
  return (
    <button
      type="button"
      className="stage-pill"
      aria-pressed={props.on}
      disabled={props.disabled}
      {...tipProps(props.tip)}
      onClick={() => props.onChange(!props.on)}
    >
      {props.label}
    </button>
  );
}

/** One-shot pill button (presets, actions). */
export function StagePillButton(
  props: Tip & { label: ReactNode; disabled?: boolean; onClick: () => void }
): JSX.Element {
  return (
    <button type="button" className="stage-pill" disabled={props.disabled} {...tipProps(props.tip)} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

export function StageSegmented<T extends string | number>(
  props: Tip & {
    ariaLabel: string;
    label?: ReactNode;
    value: T;
    options: { value: T; label: ReactNode; tip?: string; disabled?: boolean }[];
    disabled?: boolean;
    onChange: (value: T) => void;
  }
): JSX.Element {
  const group = (
    <div className="stage-seg" role="group" aria-label={props.ariaLabel} {...(props.label ? {} : tipProps(props.tip))}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={props.value === o.value}
          disabled={props.disabled || o.disabled}
          {...tipProps(o.tip)}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
  if (!props.label) {
    return group;
  }
  return (
    <div className="stage-field" {...tipProps(props.tip)}>
      <span className="stage-field-head">
        <span>{props.label}</span>
      </span>
      {group}
    </div>
  );
}

export function StageIconButton(
  props: Tip & { icon: StageIconName; label: string; pressed?: boolean; disabled?: boolean; onClick: () => void }
): JSX.Element {
  return (
    <button
      type="button"
      className="stage-icon"
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      {...tipProps(props.tip ?? props.label)}
      onClick={props.onClick}
    >
      <StageIcon name={props.icon} />
    </button>
  );
}

export function StageDivider(): JSX.Element {
  return <span className="stage-divider" aria-hidden="true" />;
}

/** Collapsible group inside the controls panel. */
export function StageSection(props: { title: string; defaultOpen?: boolean; children: ReactNode }): JSX.Element {
  return (
    <details className="stage-section" open={props.defaultOpen ?? true}>
      <summary>{props.title}</summary>
      <div className="stage-section-body">{props.children}</div>
    </details>
  );
}

export function StagePills({ children }: { children: ReactNode }): JSX.Element {
  return <div className="stage-pills">{children}</div>;
}

export function StageReadout(
  props: Tip & { label: ReactNode; value: ReactNode; muted?: boolean; valueColor?: string }
): JSX.Element {
  return (
    <div className={`stage-readout${props.muted ? " is-muted" : ""}`} {...tipProps(props.tip)}>
      <span>{props.label}</span>
      <strong style={props.valueColor ? { color: props.valueColor } : undefined}>{props.value}</strong>
    </div>
  );
}

/** Large headline number at the top of the readouts panel. */
export function StageHero(props: Tip & { label: ReactNode; value: ReactNode }): JSX.Element {
  return (
    <div className="stage-hero" {...tipProps(props.tip)}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
