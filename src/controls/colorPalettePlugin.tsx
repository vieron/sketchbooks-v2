import { Components, createPlugin, useInputContext } from 'leva/plugin';
import type { LevaInputProps } from 'leva/plugin';
import { sketchPalettePresets, type ColorPalettePreset } from '../data/palettes';

const { Label, Row } = Components;
const CUSTOM_SOURCE = 'custom';
const FALLBACK_COLOR = '#111111';
const SLOT_COUNT = 6;

type ColorPaletteSlot = {
  color: string;
  enabled: boolean;
};

export type ColorPaletteValue = {
  source: string;
  colors: string[];
  slots: ColorPaletteSlot[];
};

export type ColorPaletteInput = {
  value?: Partial<ColorPaletteValue> | string[];
  palettes?: ColorPalettePreset[];
};

type ColorPaletteSettings = {
  palettes: ColorPalettePreset[];
};

function sanitizeHexColor(color: unknown, fallback = FALLBACK_COLOR) {
  const value = String(color ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function normalizePresetColors(colors: unknown) {
  const sourceColors = Array.isArray(colors) ? colors : [];
  return sourceColors.slice(0, SLOT_COUNT).map((color) => sanitizeHexColor(color));
}

function getActiveColors(slots: ColorPaletteSlot[]) {
  const colors = slots.filter((slot) => slot.enabled).map((slot) => slot.color);
  return colors.length > 0 ? colors : [slots[0]?.color ?? FALLBACK_COLOR];
}

function normalizeSlots(value: Partial<ColorPaletteValue> | string[] | undefined, fallbackColors: string[]) {
  const input = Array.isArray(value) ? { colors: value } : value;
  const valueSlots = Array.isArray(input?.slots) ? input.slots : undefined;
  const valueColors = Array.isArray(input?.colors) ? input.colors : undefined;
  const sourceColors = valueSlots ?? valueColors ?? fallbackColors;
  const normalizedSlots = Array.from({ length: SLOT_COUNT }, (_, index) => {
    const source = sourceColors[index];
    const sourceIsSlot = typeof source === 'object' && source !== null && 'color' in source;
    const sourceColor = sourceIsSlot ? (source as ColorPaletteSlot).color : source;
    const previousColor = index > 0 ? sourceColors[index - 1] : undefined;
    const fallback = typeof previousColor === 'object' && previousColor !== null && 'color' in previousColor
      ? (previousColor as ColorPaletteSlot).color
      : previousColor;

    return {
      color: sanitizeHexColor(sourceColor, sanitizeHexColor(fallback, FALLBACK_COLOR)),
      enabled: sourceIsSlot ? Boolean((source as ColorPaletteSlot).enabled) : Array.isArray(sourceColors) && index < sourceColors.length,
    };
  });

  if (!normalizedSlots.some((slot) => slot.enabled)) {
    normalizedSlots[0] = { ...normalizedSlots[0], enabled: true };
  }

  return normalizedSlots;
}

function normalizePalettes(palettes: ColorPalettePreset[] | undefined) {
  const sourcePalettes = palettes?.length ? palettes : sketchPalettePresets;

  return sourcePalettes.map((palette) => ({
    ...palette,
    colors: normalizePresetColors(palette.colors),
  }));
}

function getPreset(source: string, palettes: ColorPalettePreset[]) {
  return palettes.find((palette) => palette.id === source);
}

function normalizePaletteValue(value: ColorPaletteInput['value'], settings: ColorPaletteSettings): ColorPaletteValue {
  const input = Array.isArray(value) ? { source: CUSTOM_SOURCE, colors: value } : value;
  const source = input?.source ?? settings.palettes[0]?.id ?? CUSTOM_SOURCE;
  const preset = getPreset(source, settings.palettes);
  const fallbackColors = preset?.colors ?? settings.palettes[0]?.colors ?? [FALLBACK_COLOR];
  const slots = normalizeSlots(input, fallbackColors);

  return {
    source: preset?.id ?? CUSTOM_SOURCE,
    colors: getActiveColors(slots),
    slots,
  };
}

function ColorPaletteComponent() {
  const { disabled, label, onUpdate, settings, value } = useInputContext<
    LevaInputProps<ColorPaletteValue, ColorPaletteSettings>
  >();
  const current = normalizePaletteValue(value, settings);
  const labelText = typeof label === 'string' ? label : 'palette';

  const update = (nextValue: ColorPaletteValue) => {
    onUpdate(normalizePaletteValue(nextValue, settings));
  };

  const updateColor = (index: number, color: string) => {
    const slots = [...current.slots];
    slots[index] = {
      color: sanitizeHexColor(color, slots[index]?.color),
      enabled: true,
    };
    update({ source: current.source, colors: getActiveColors(slots), slots });
  };

  const toggleSlot = (index: number) => {
    const slots = [...current.slots];
    const slot = slots[index];
    if (!slot) return;
    if (slot.enabled && current.colors.length <= 1) return;
    slots[index] = { ...slot, enabled: !slot.enabled };
    update({ source: current.source, colors: getActiveColors(slots), slots });
  };

  return (
    <Row input>
      <Label>{label}</Label>
      <div style={{ display: 'grid', gap: 6, width: '100%' }}>
        <select
          aria-label={`${labelText} preset`}
          value={current.source}
          disabled={disabled}
          onChange={(event) => {
            const source = event.currentTarget.value;
            const preset = getPreset(source, settings.palettes);
            update(
              preset
                ? { source: preset.id, colors: preset.colors, slots: normalizeSlots({ colors: preset.colors }, preset.colors) }
                : { source: CUSTOM_SOURCE, colors: current.colors, slots: current.slots },
            );
          }}
          style={{
            width: '100%',
            height: 24,
            border: 0,
            borderRadius: 3,
            background: '#3f4354',
            color: '#f4f7fb',
            fontFamily: 'inherit',
            fontSize: 11,
            padding: '0 6px',
          }}
        >
          <option value={CUSTOM_SOURCE}>Custom</option>
          {settings.palettes.map((palette) => (
            <option key={palette.id} value={palette.id}>
              {palette.label}
            </option>
          ))}
        </select>

        <div
          style={{
            display: 'grid',
            gap: 5,
            gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
          }}
        >
          {current.slots.map((slot, index) => (
            <div
              key={index}
              style={{
                position: 'relative',
                minWidth: 0,
                height: 22,
                overflow: 'hidden',
                borderRadius: 3,
                background: slot.enabled
                  ? slot.color
                  : 'linear-gradient(45deg, #f7f7f7 25%, transparent 25%), linear-gradient(-45deg, #f7f7f7 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #f7f7f7 75%), linear-gradient(-45deg, transparent 75%, #f7f7f7 75%), #dcdfe4',
                backgroundPosition: slot.enabled ? undefined : '0 0, 0 5px, 5px -5px, -5px 0',
                backgroundSize: slot.enabled ? undefined : '10px 10px',
                boxShadow: 'inset 0 0 0 1px rgba(32,36,45,0.18)',
              }}
            >
              <input
                aria-label={`${labelText} color ${index + 1}`}
                type="color"
                value={slot.color}
                disabled={disabled}
                onChange={(event) => updateColor(index, event.currentTarget.value)}
                style={{
                  width: '100%',
                  minWidth: 0,
                  height: 22,
                  border: 0,
                  borderRadius: 3,
                  background: slot.enabled ? slot.color : 'transparent',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: slot.enabled ? 1 : 0.01,
                  padding: 0,
                }}
              />
              <button
                type="button"
                aria-label={`${slot.enabled ? 'Disable' : 'Enable'} ${labelText} color ${index + 1}`}
                disabled={disabled || (slot.enabled && current.colors.length <= 1)}
                onClick={() => toggleSlot(index)}
                style={{
                  position: 'absolute',
                  right: 1,
                  top: 1,
                  width: 10,
                  height: 10,
                  border: 0,
                  borderRadius: 999,
                  background: slot.enabled ? 'rgba(244, 247, 251, 0.92)' : 'rgba(32, 36, 45, 0.92)',
                  color: slot.enabled ? '#20242d' : '#f4f7fb',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 8,
                  fontWeight: 700,
                  lineHeight: '10px',
                  padding: 0,
                }}
              >
                {slot.enabled ? '-' : '+'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Row>
  );
}

export const colorPalette = createPlugin<ColorPaletteInput, ColorPaletteValue, ColorPaletteSettings>({
  component: ColorPaletteComponent,
  normalize(input = {}) {
    const settings = {
      palettes: normalizePalettes(input.palettes),
    };

    return {
      value: normalizePaletteValue(input.value, settings),
      settings,
    };
  },
  sanitize(value, settings) {
    return normalizePaletteValue(value, settings);
  },
});
