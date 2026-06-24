import { useEffect, useMemo, useRef, useState } from 'react';
import { button, useControls } from 'leva';
import { SketchControls } from '../../../components/SketchControls';
import { colorPalette } from '../../../controls/colorPalettePlugin';
import { nativeNumber } from '../../../controls/nativeNumberPlugin';
import {
  getFontByValue,
  getFontFamilyById,
  getFontFamilyOptions,
  getFontVariantOptions,
  thunderFonts,
} from '../../../data/fonts';
import { getPaletteToneColors, sketchPalettePresets } from '../../../data/palettes';
import { downloadSvg } from '../../../utils/svgDownload';
import { buildGlyphPath, formatPathNumber, useOpenTypeFont } from '../_type/_opentype';
import type { Bounds, OpenTypeCommand, OpenTypeFont, OpenTypeGlyph, Point } from '../_type/_types';

type GlyphShape = {
  id: string;
  d: string;
  bounds: Bounds;
  contours: Point[][];
  area: number;
};

type FlowSettings = {
  particleCount: number;
  noiseScale: number;
  speed: number;
  frameLimit: number;
  angle: number;
  turns: number;
  seed: number;
};

type GlyphFlow = GlyphShape & {
  framePaths: string[];
  pending: boolean;
};

type GlyphPlacement = {
  glyph: OpenTypeGlyph;
  x: number;
  y: number;
};

type GradientLine = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

const STAGE = { width: 1800, height: 1200 };
const STAGE_MARGIN = 86;
const MAIN_SIZE_SCALE = 4.7;
const TRACKING_SCALE = 3;
const CURVE_STEPS = 12;
const MIN_PARTICLES_PER_GLYPH = 18;
const FRAME_LIMIT = 336;
const DEFAULT_CONTROL_PALETTE_COLOR = '#000000';
const DEFAULT_TEXT = 'FLOW\nFIELDS';
const defaultFontFamily = getFontFamilyById('thunder');
const defaultFont = thunderFonts.find((font) => font.variant === 'Black LC') ?? defaultFontFamily.defaultFont;

function createDefaultControlPaletteValue() {
  return {
    source: 'custom',
    colors: [DEFAULT_CONTROL_PALETTE_COLOR],
    slots: Array.from({ length: 6 }, (_, index) => ({
      color: DEFAULT_CONTROL_PALETTE_COLOR,
      enabled: index === 0,
    })),
  };
}

function cleanFilePart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'glyph-flow-field';
}

function rotateColors(colors: string[], offset: number) {
  if (colors.length <= 1) return colors;
  return colors.map((_, index) => colors[(index + offset) % colors.length] ?? colors[index]);
}

function stopOffset(index: number, total: number) {
  return total <= 1 ? 0 : (index / (total - 1)) * 100;
}

function hexToRgb(color: string) {
  const normalized = color.replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  const value = Number.parseInt(normalized, 16);

  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function luminance(color: string) {
  const rgb = hexToRgb(color);
  if (!rgb) return 0;
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function colorDistance(a: string, b: string) {
  const colorA = hexToRgb(a);
  const colorB = hexToRgb(b);
  if (!colorA || !colorB) return Infinity;

  return Math.hypot(colorA.r - colorB.r, colorA.g - colorB.g, colorA.b - colorB.b);
}

function getFlowGradientColors(colors: string[], background: string) {
  const palette = colors.length ? colors : [DEFAULT_CONTROL_PALETTE_COLOR];
  const backgroundLuminance = luminance(background);
  const visibleColors = palette.filter((color) => {
    const tooCloseToBackground = colorDistance(color, background) < 72;
    const paperOnLightBackground = backgroundLuminance > 210 && luminance(color) > 242;
    return !tooCloseToBackground && !paperOnLightBackground;
  });

  return visibleColors.length > 0 ? visibleColors : palette;
}

function glyphGradientAngle(baseAngle: number, seed: number, glyphIndex: number) {
  let value = (seed + 1) * 374761393 + (glyphIndex + 1) * 668265263;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  const unit = ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  return baseAngle + unit * 240 - 120;
}

function getGradientLine(bounds: Bounds, angleDegrees: number): GradientLine {
  const angle = (angleDegrees * Math.PI) / 180;
  const centerX = (bounds.x1 + bounds.x2) / 2;
  const centerY = (bounds.y1 + bounds.y2) / 2;
  const radius = Math.hypot(bounds.x2 - bounds.x1, bounds.y2 - bounds.y1) / 2;
  const dx = Math.cos(angle) * radius;
  const dy = Math.sin(angle) * radius;

  return {
    x1: centerX - dx,
    y1: centerY - dy,
    x2: centerX + dx,
    y2: centerY + dy,
  };
}

function mergeBounds(current: Bounds | null, next: Bounds | null) {
  if (!next) return current;
  if (!current) return next;
  return {
    x1: Math.min(current.x1, next.x1),
    y1: Math.min(current.y1, next.y1),
    x2: Math.max(current.x2, next.x2),
    y2: Math.max(current.y2, next.y2),
  };
}

function pointOnQuadratic(start: Point, control: Point, end: Point, t: number) {
  const mt = 1 - t;
  return {
    x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
    y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
  };
}

function pointOnCubic(start: Point, controlA: Point, controlB: Point, end: Point, t: number) {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * start.x + 3 * mt * mt * t * controlA.x + 3 * mt * t * t * controlB.x + t * t * t * end.x,
    y: mt * mt * mt * start.y + 3 * mt * mt * t * controlA.y + 3 * mt * t * t * controlB.y + t * t * t * end.y,
  };
}

function flattenGlyphContours(glyph: OpenTypeGlyph, x: number, y: number, scale: number) {
  const commands = glyph.path?.commands ?? [];
  const contours: Point[][] = [];
  let contour: Point[] = [];
  let current: Point | null = null;
  let start: Point | null = null;

  function point(rawX: number, rawY: number) {
    return {
      x: x + rawX * scale,
      y: y - rawY * scale,
    };
  }

  function closeContour() {
    if (contour.length > 2) contours.push(contour);
    contour = [];
    current = null;
    start = null;
  }

  commands.forEach((command: OpenTypeCommand) => {
    if (command.type === 'M') {
      closeContour();
      current = point(command.x, command.y);
      start = current;
      contour.push(current);
      return;
    }

    if (!current) return;

    if (command.type === 'L') {
      current = point(command.x, command.y);
      contour.push(current);
      return;
    }

    if (command.type === 'Q') {
      const control = point(command.x1, command.y1);
      const end = point(command.x, command.y);
      for (let step = 1; step <= CURVE_STEPS; step += 1) {
        contour.push(pointOnQuadratic(current, control, end, step / CURVE_STEPS));
      }
      current = end;
      return;
    }

    if (command.type === 'C') {
      const controlA = point(command.x1, command.y1);
      const controlB = point(command.x2, command.y2);
      const end = point(command.x, command.y);
      for (let step = 1; step <= CURVE_STEPS; step += 1) {
        contour.push(pointOnCubic(current, controlA, controlB, end, step / CURVE_STEPS));
      }
      current = end;
      return;
    }

    if (command.type === 'Z') {
      if (start) contour.push(start);
      closeContour();
    }
  });

  closeContour();
  return contours;
}

function normalizeTextLines(value: string) {
  const normalized = value.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  return lines.some((line) => line.length > 0) ? lines : DEFAULT_TEXT.split('\n');
}

function layoutGlyphShapes(font: OpenTypeFont, text: string, size: number, tracking: number, lineHeight: number) {
  const scale = size / font.unitsPerEm;
  let layoutBounds: Bounds | null = null;
  const placements: GlyphPlacement[] = [];
  const baselineStep = size * lineHeight;
  const lines = normalizeTextLines(text);

  lines.forEach((line, lineIndex) => {
    const glyphs = font.stringToGlyphs(line || ' ');
    let cursor = 0;
    const baseline = lineIndex * baselineStep;

    glyphs.forEach((glyph, glyphIndex) => {
      const previousGlyph = glyphs[glyphIndex - 1];
      if (previousGlyph && font.getKerningValue) cursor += font.getKerningValue(previousGlyph, glyph) * scale;

      placements.push({ glyph, x: cursor, y: baseline });
      layoutBounds = mergeBounds(layoutBounds, buildGlyphPath(glyph, cursor, baseline, scale).bounds);

      cursor += glyph.advanceWidth * scale;
      if (glyphIndex < glyphs.length - 1) cursor += tracking;
    });
  });

  const bounds = layoutBounds ?? { x1: 0, y1: -size, x2: size, y2: 0 };
  const width = Math.max(bounds.x2 - bounds.x1, 1);
  const height = Math.max(bounds.y2 - bounds.y1, 1);
  const maxWidth = Math.max(1, STAGE.width - STAGE_MARGIN * 2);
  const maxHeight = Math.max(1, STAGE.height - STAGE_MARGIN * 2);
  const fitScale = Math.min(1, maxWidth / width, maxHeight / height);
  const finalScale = scale * fitScale;
  const offsetX = STAGE.width / 2 - (bounds.x1 + width / 2) * fitScale;
  const offsetY = STAGE.height / 2 - (bounds.y1 + height / 2) * fitScale;

  return placements.flatMap((placement, glyphIndex) => {
    const x = offsetX + placement.x * fitScale;
    const y = offsetY + placement.y * fitScale;
    const path = buildGlyphPath(placement.glyph, x, y, finalScale);
    if (!path.bounds || !path.d) return [];

    const contours = flattenGlyphContours(placement.glyph, x, y, finalScale);
    const area = Math.max(1, (path.bounds.x2 - path.bounds.x1) * (path.bounds.y2 - path.bounds.y1));

    return [{
      id: `${glyphIndex}-${placement.glyph.index}`,
      d: path.d,
      bounds: path.bounds,
      contours,
      area,
    }];
  });
}

function getFrameOpacity(index: number, frameCount: number, trailAlpha: number, fadeAlpha: number) {
  const decay = Math.min(1, Math.max(0, 1 - fadeAlpha));
  return Math.min(1, Math.max(0, trailAlpha * decay ** (frameCount - index - 1)));
}

export default function GlyphFlowField() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const workerJobRef = useRef(0);
  const defaultPaletteAppliedRef = useRef(false);
  const [glyphFlows, setGlyphFlows] = useState<GlyphFlow[]>([]);
  const [fontFamilyId, setFontFamilyId] = useState(defaultFontFamily.id);
  const fontFamily = getFontFamilyById(fontFamilyId);
  const [fontValue, setFontValue] = useState(defaultFont.value);
  const fontMeta = getFontByValue(fontFamily.fonts, fontValue, fontFamily.defaultFont);

  const typography = useControls(
    'Typography',
    {
      fontFamily: {
        value: fontFamily.id,
        options: getFontFamilyOptions(),
        label: 'family',
        onChange: (familyId: string) => {
          const nextFamily = getFontFamilyById(familyId);
          setFontFamilyId(nextFamily.id);
          setFontValue(nextFamily.defaultFont.value);
        },
      },
      fontVariant: {
        value: fontMeta.value,
        options: getFontVariantOptions(fontFamily.fonts),
        label: 'variant',
        onChange: setFontValue,
      },
      text: { value: DEFAULT_TEXT, rows: 2, label: 'text' },
      size: nativeNumber({ current: 120, min: 56, max: 260, step: 1 }),
      tracking: nativeNumber({ current: 5, min: -28, max: 46, step: 0.5 }),
      lineHeight: { ...nativeNumber({ current: 0.77, min: 0.5, max: 1.4, step: 0.01 }), label: 'leading' },
    },
    { collapsed: false },
    [fontFamily.id, fontMeta.value],
  );

  const field = useControls(
    'Field',
    {
      particleCount: { ...nativeNumber({ current: 900, min: 250, max: 5200, step: 50 }), label: 'particles' },
      noiseScale: { ...nativeNumber({ current: 0.0072, min: 0.0004, max: 0.0075, step: 0.0001 }), label: 'scale' },
      speed: nativeNumber({ current: 4, min: 0.3, max: 6, step: 0.1 }),
      turns: nativeNumber({ current: 0.55, min: 0.25, max: 3.5, step: 0.05 }),
      angle: nativeNumber({ current: -103, min: -180, max: 180, step: 1 }),
      seed: nativeNumber({ current: 3100, min: 1, max: 9999, step: 1 }),
    },
    { collapsed: false },
  );

  const [drawing, setDrawing] = useControls(
    'Drawing',
    () => ({
      strokeWeight: { ...nativeNumber({ current: 0.45, min: 0.2, max: 4.5, step: 0.05 }), label: 'weight' },
      trailAlpha: { ...nativeNumber({ current: 0.15, min: 0.01, max: 1, step: 0.01 }), label: 'alpha' },
      fadeAlpha: { ...nativeNumber({ current: 0, min: 0, max: 0.12, step: 0.001 }), label: 'fade' },
      outline: nativeNumber({ current: 0, min: 0, max: 6, step: 0.1 }),
      gradient: nativeNumber({ current: 81, min: -180, max: 180, step: 1 }),
      background: '#ffffff',
      glyphFlowPalette: {
        ...colorPalette({
          value: createDefaultControlPaletteValue(),
          palettes: sketchPalettePresets,
        }),
        label: 'palette',
      },
    }),
    { collapsed: false },
  );

  useControls({
    'Download SVG': button(() => {
      downloadSvg(svgRef.current, `${cleanFilePart(String(typography.text))}-glyph-flow-field.svg`);
    }),
  });

  const { font, error } = useOpenTypeFont(fontMeta.url);
  useEffect(() => {
    if (defaultPaletteAppliedRef.current) return;
    defaultPaletteAppliedRef.current = true;
    setDrawing({ glyphFlowPalette: createDefaultControlPaletteValue() });
  }, [setDrawing]);

  const paletteTones = getPaletteToneColors(drawing.glyphFlowPalette.colors);
  const gradientColors = getFlowGradientColors(drawing.glyphFlowPalette.colors, String(drawing.background));
  const mainSize = Number(typography.size) * MAIN_SIZE_SCALE;
  const tracking = Number(typography.tracking) * TRACKING_SCALE;
  const lineHeight = Number(typography.lineHeight);
  const text = String(typography.text ?? DEFAULT_TEXT).replace(/\r\n?/g, '\n') || DEFAULT_TEXT;
  const flowSettings = useMemo<FlowSettings>(() => ({
    particleCount: Number(field.particleCount),
    noiseScale: Number(field.noiseScale),
    speed: Number(field.speed),
    frameLimit: FRAME_LIMIT,
    angle: Number(field.angle),
    turns: Number(field.turns),
    seed: Number(field.seed),
  }), [field]);

  const shapes = useMemo(
    () => (font ? layoutGlyphShapes(font, text, mainSize, tracking, lineHeight) : []),
    [font, lineHeight, mainSize, text, tracking],
  );

  useEffect(() => {
    const jobId = workerJobRef.current + 1;
    workerJobRef.current = jobId;

    setGlyphFlows(shapes.map((shape) => ({ ...shape, framePaths: [], pending: true })));

    if (!shapes.length) return undefined;

    let canceled = false;
    const workers: Worker[] = [];
    const totalArea = shapes.reduce((sum, shape) => sum + shape.area, 0) || 1;

    shapes.forEach((shape, glyphIndex) => {
      const particleCount = Math.max(
        MIN_PARTICLES_PER_GLYPH,
        Math.round((flowSettings.particleCount * shape.area) / totalArea),
      );
      const worker = new Worker(new URL('./_glyphFlowWorker.ts', import.meta.url), { type: 'module' });

      worker.onmessage = (event: MessageEvent<{ jobId: number; glyphIndex: number; framePaths: string[] }>) => {
        if (canceled || event.data.jobId !== workerJobRef.current) return;

        setGlyphFlows((current) => current.map((glyph, index) => (
          index === event.data.glyphIndex
            ? { ...glyph, framePaths: event.data.framePaths, pending: false }
            : glyph
        )));
        worker.terminate();
      };

      worker.onerror = (event) => {
        if (!canceled && jobId === workerJobRef.current) {
          console.error('Glyph flow worker failed', event.message);
          setGlyphFlows((current) => current.map((glyph, index) => (
            index === glyphIndex ? { ...glyph, pending: false } : glyph
          )));
        }
        worker.terminate();
      };

      worker.postMessage({
        jobId,
        glyphIndex,
        shape,
        particleCount,
        settings: flowSettings,
      });
      workers.push(worker);
    });

    return () => {
      canceled = true;
      workers.forEach((worker) => worker.terminate());
    };
  }, [flowSettings, shapes]);

  const trailAlpha = Number(drawing.trailAlpha);
  const fadeAlpha = Number(drawing.fadeAlpha);

  if (error) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Font failed to load: {error}</div>
        <SketchControls fill flat />
      </section>
    );
  }

  if (!font) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Loading font...</div>
        <SketchControls fill flat />
      </section>
    );
  }

  return (
    <section className="sketch-workbench">
      <div className="sketch-stage">
        <svg
          ref={svgRef}
          className="type-svg"
          viewBox={`0 0 ${STAGE.width} ${STAGE.height}`}
          role="img"
          aria-label={`${text} glyphs filled with seeded flow-field particles`}
          style={{ backgroundColor: String(drawing.background) }}
        >
          <defs>
            {glyphFlows.map((glyph, glyphIndex) => {
              const gradient = getGradientLine(
                glyph.bounds,
                glyphGradientAngle(Number(drawing.gradient), flowSettings.seed, glyphIndex),
              );
              const colors = rotateColors(gradientColors, glyphIndex);

              return (
                <g key={`defs-${glyph.id}`}>
                  <clipPath id={`glyph-flow-field-${glyph.id}`} clipPathUnits="userSpaceOnUse">
                    <path d={glyph.d} clipRule="evenodd" />
                  </clipPath>
                  <linearGradient
                    id={`glyph-flow-gradient-${glyph.id}`}
                    gradientUnits="userSpaceOnUse"
                    x1={formatPathNumber(gradient.x1)}
                    y1={formatPathNumber(gradient.y1)}
                    x2={formatPathNumber(gradient.x2)}
                    y2={formatPathNumber(gradient.y2)}
                  >
                    {colors.map((color, colorIndex) => (
                      <stop
                        key={`${color}-${colorIndex}`}
                        offset={`${formatPathNumber(stopOffset(colorIndex, colors.length))}%`}
                        stopColor={color}
                      />
                    ))}
                  </linearGradient>
                </g>
              );
            })}
          </defs>

          <rect width={STAGE.width} height={STAGE.height} fill={String(drawing.background)} />

          {glyphFlows.map((glyph) => (
            <g
              key={glyph.id}
              clipPath={`url(#glyph-flow-field-${glyph.id})`}
              fill="none"
              stroke={`url(#glyph-flow-gradient-${glyph.id})`}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={Number(drawing.strokeWeight)}
            >
              {glyph.framePaths.map((d, index) => (
                <path
                  key={index}
                  d={d}
                  strokeOpacity={getFrameOpacity(index, glyph.framePaths.length, trailAlpha, fadeAlpha)}
                />
              ))}
            </g>
          ))}

          {Number(drawing.outline) > 0 && glyphFlows.map((glyph) => (
            <path
              key={`outline-${glyph.id}`}
              d={glyph.d}
              fill="none"
              stroke={paletteTones.ink}
              strokeWidth={formatPathNumber(Number(drawing.outline))}
              strokeOpacity="0.28"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </div>
      <SketchControls fill flat collapsed={false} oneLineLabels={false} />
    </section>
  );
}
