type SketchProgressProps = {
  active: boolean;
  label?: string;
  detail?: string;
  value?: number | null;
  max?: number;
  className?: string;
};

function clampProgress(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function SketchProgress({
  active,
  label = "Rendering",
  detail,
  value = null,
  max = 1,
  className,
}: SketchProgressProps) {
  if (!active) return null;

  const isDeterminate =
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isFinite(max) &&
    max > 0;
  const progress = isDeterminate ? clampProgress(value / max) : 0;
  const percentage = Math.round(progress * 100);
  const classNames = [
    "sketch-progress",
    isDeterminate ? "is-determinate" : "is-indeterminate",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classNames}
      role="progressbar"
      aria-label={label}
      aria-valuemin={isDeterminate ? 0 : undefined}
      aria-valuemax={isDeterminate ? max : undefined}
      aria-valuenow={isDeterminate ? value : undefined}
    >
      <div className="sketch-progress__meta">
        <span>{label}</span>
        <span>{detail ?? (isDeterminate ? `${percentage}%` : "working")}</span>
      </div>
      <div className="sketch-progress__track">
        <span
          className="sketch-progress__bar"
          style={
            isDeterminate
              ? { transform: `scaleX(${Math.max(progress, 0.03)})` }
              : undefined
          }
        />
      </div>
    </div>
  );
}
