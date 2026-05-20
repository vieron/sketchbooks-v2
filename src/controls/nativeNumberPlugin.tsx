import { Components, createPlugin, useInputContext } from 'leva/plugin';
import type { LevaInputProps } from 'leva/plugin';

const { Label, Row } = Components;

export type NativeNumberInput = number | {
  current?: number;
  min?: number;
  max?: number;
  step?: number;
};

type NativeNumberSettings = {
  min: number;
  max: number;
  step: number;
  precision: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getPrecision(step: number) {
  if (!Number.isFinite(step)) return 0;
  const [, decimals = ''] = String(step).split('.');
  return Math.min(decimals.length, 4);
}

function normalizeNumber(input: NativeNumberInput | undefined) {
  const source = typeof input === 'number' ? { current: input } : input ?? {};
  const min = Number.isFinite(source.min) ? Number(source.min) : -Infinity;
  const max = Number.isFinite(source.max) ? Number(source.max) : Infinity;
  const step = Number.isFinite(source.step) && Number(source.step) > 0 ? Number(source.step) : 1;
  const fallback = Number.isFinite(min) && Number.isFinite(max) ? (min + max) / 2 : 0;
  const current = Number.isFinite(source.current) ? Number(source.current) : fallback;
  const value = clamp(current, min, max);

  return {
    value,
    settings: {
      min,
      max,
      step,
      precision: getPrecision(step),
    },
  };
}

function sanitizeNumber(value: unknown, settings: NativeNumberSettings) {
  const numeric = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(numeric)) return 0;

  const stepped = Number.isFinite(settings.step)
    ? Math.round(numeric / settings.step) * settings.step
    : numeric;

  return clamp(Number(stepped.toFixed(settings.precision)), settings.min, settings.max);
}

function formatNumber(value: number, settings: NativeNumberSettings) {
  return settings.precision > 0 ? value.toFixed(settings.precision) : String(value);
}

function NativeNumberComponent() {
  const { disabled, displayValue, label, onChange, onUpdate, settings, value } = useInputContext<
    LevaInputProps<number, NativeNumberSettings, string>
  >();
  const hasRange = Number.isFinite(settings.min) && Number.isFinite(settings.max);
  const labelText = typeof label === 'string' ? label : 'value';

  const commit = (nextValue: string | number) => {
    onUpdate(sanitizeNumber(nextValue, settings));
  };

  return (
    <Row input>
      <Label>{label}</Label>
      <div className="native-number-control">
        {hasRange && (
          <input
            aria-label={`${labelText} slider`}
            className="native-number-control__range"
            type="range"
            min={settings.min}
            max={settings.max}
            step={settings.step}
            value={value}
            disabled={disabled}
            onChange={(event) => commit(event.currentTarget.value)}
            onInput={(event) => commit(event.currentTarget.value)}
          />
        )}
        <input
          aria-label={labelText}
          className="native-number-control__input"
          type="number"
          step={settings.step}
          value={displayValue}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(event.currentTarget.value);
          }}
        />
      </div>
    </Row>
  );
}

export const nativeNumber = createPlugin<NativeNumberInput, number, NativeNumberSettings>({
  component: NativeNumberComponent,
  normalize(input) {
    return normalizeNumber(input);
  },
  sanitize(value, settings) {
    return sanitizeNumber(value, settings);
  },
  format(value, settings) {
    return formatNumber(value, settings);
  },
});
