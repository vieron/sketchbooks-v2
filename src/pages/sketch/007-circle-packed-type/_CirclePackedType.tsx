import { useEffect, useMemo, useRef, useState } from 'react';
import { button, folder, useControls } from 'leva';
import { SketchControls } from '../../../components/SketchControls';
import { colorPalette } from '../../../controls/colorPalettePlugin';
import { nativeNumber } from '../../../controls/nativeNumberPlugin';
import {
  getFontByValue,
  getFontFamilyById,
  getFontFamilyOptions,
  getFontVariantOptions,
} from '../../../data/fonts';
import { sketchPalettePresets } from '../../../data/palettes';
import { downloadSvg } from '../../../utils/svgDownload';
import { useOpenTypeFont } from '../003-typographic-slicing/_opentype';
import type { Bounds, OpenTypeCommand, OpenTypeFont, OpenTypeGlyph, Point } from '../003-typographic-slicing/_types';

type TextAlignment = 'left' | 'center' | 'right';
type ColorMode = 'radius' | 'random' | 'glyph' | 'rows';

type LayoutOptions = {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  alignment: TextAlignment;
};

type GlyphLayout = {
  id: string;
  glyphIndex: number;
  lineIndex: number;
  d: string;
  commands: OpenTypeCommand[];
  bounds: Bounds;
};

type WorkerGlyphLayout = Omit<GlyphLayout, 'commands'>;

type TextLayout = {
  glyphs: GlyphLayout[];
  bounds: Bounds;
};

type PackedCircle = {
  id: string;
  x: number;
  y: number;
  r: number;
  glyphId: string;
  glyphLineIndex: number;
  glyphIndex: number;
};

type PackingOptions = {
  seed: number;
  maxCircles: number;
  candidates: number;
  minRadius: number;
  maxRadius: number;
  gap: number;
  edgeSamples: number;
  tightness: number;
  variation: number;
  radiusPower: number;
};

type ColoringOptions = {
  seed: number;
  minRadius: number;
  maxRadius: number;
  innerColorMix: number;
  colorMode: ColorMode;
  palette: string[];
};

type PackedScene = {
  circles: PackedCircle[];
  viewBox: Bounds;
};

type RandomSource = {
  next(min?: number, max?: number): number;
};

type PackingControlValues = {
  seed: number;
  fill: number;
  minRatio: number;
  maxRatio: number;
  spacing: number;
  sizeVariation: number;
};

type PackedSceneState = {
  scene: PackedScene | null;
  pending: boolean;
};

type PackingWorkerResponse = {
  type: 'result' | 'error' | 'unsupported';
  requestId: number;
  index: number;
  circleData?: Float32Array;
  message?: string;
};

type SampleOffset = {
  x: number;
  y: number;
};

type CircleSpatialGrid = {
  cellSize: number;
  cells: Map<string, PackedCircle[]>;
};

const DEFAULT_TEXT = 'PACK';
const DEFAULT_PALETTE = ['#0053ff', '#00c2a8'];
const packingPalettePresets = [
  {
    id: 'playground-blue-teal',
    label: 'Playground blue teal',
    colors: DEFAULT_PALETTE,
  },
  ...sketchPalettePresets,
];
const VIEWBOX_PADDING = 42;
const MIN_BOUNDS_SIZE = 1;
const MAX_BINARY_STEPS = 10;
const EMPTY_ROUND_LIMIT = 72;
const MAX_PACKING_WORKERS = 4;
const PACKING_CONTROL_SCALE = 100;
let packingRequestId = 0;

function round(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

function pointToPath(point: Point) {
  return `${round(point.x)} ${round(point.y)}`;
}

function emptyBounds(): Bounds {
  return { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
}

function includePoint(bounds: Bounds, point: Point) {
  bounds.x1 = Math.min(bounds.x1, point.x);
  bounds.y1 = Math.min(bounds.y1, point.y);
  bounds.x2 = Math.max(bounds.x2, point.x);
  bounds.y2 = Math.max(bounds.y2, point.y);
}

function includeCommand(bounds: Bounds, command: OpenTypeCommand) {
  if (command.type === 'Z') return;
  if (command.type === 'Q') includePoint(bounds, { x: command.x1, y: command.y1 });
  if (command.type === 'C') {
    includePoint(bounds, { x: command.x1, y: command.y1 });
    includePoint(bounds, { x: command.x2, y: command.y2 });
  }
  includePoint(bounds, { x: command.x, y: command.y });
}

function commandBounds(commands: OpenTypeCommand[]) {
  const bounds = emptyBounds();
  commands.forEach((command) => includeCommand(bounds, command));
  return bounds;
}

function padBounds(bounds: Bounds, padding: number): Bounds {
  if (!Number.isFinite(bounds.x1)) {
    return { x1: -padding, y1: -padding, x2: padding + MIN_BOUNDS_SIZE, y2: padding + MIN_BOUNDS_SIZE };
  }

  return {
    x1: round(bounds.x1 - padding),
    y1: round(bounds.y1 - padding),
    x2: round(bounds.x2 + padding),
    y2: round(bounds.y2 + padding),
  };
}

function boundsToViewBox(bounds: Bounds) {
  return `${round(bounds.x1)} ${round(bounds.y1)} ${round(Math.max(bounds.x2 - bounds.x1, MIN_BOUNDS_SIZE))} ${round(Math.max(bounds.y2 - bounds.y1, MIN_BOUNDS_SIZE))}`;
}

function commandsToPath(commands: OpenTypeCommand[]) {
  return commands.map((command) => {
    if (command.type === 'M') return `M${pointToPath(command)}`;
    if (command.type === 'L') return `L${pointToPath(command)}`;
    if (command.type === 'Q') return `Q${pointToPath({ x: command.x1, y: command.y1 })} ${pointToPath(command)}`;
    if (command.type === 'C') {
      return `C${pointToPath({ x: command.x1, y: command.y1 })} ${pointToPath({ x: command.x2, y: command.y2 })} ${pointToPath(command)}`;
    }
    return 'Z';
  }).join('');
}

function pointFromGlyph(rawX: number, rawY: number, x: number, y: number, scale: number): Point {
  return { x: x + rawX * scale, y: y - rawY * scale };
}

function glyphToCommands(glyph: OpenTypeGlyph, x: number, y: number, scale: number) {
  return (glyph.path?.commands ?? []).map((command): OpenTypeCommand => {
    if (command.type === 'M' || command.type === 'L') return { type: command.type, ...pointFromGlyph(command.x, command.y, x, y, scale) };
    if (command.type === 'Q') {
      const end = pointFromGlyph(command.x, command.y, x, y, scale);
      const control = pointFromGlyph(command.x1, command.y1, x, y, scale);
      return { type: 'Q', ...end, x1: control.x, y1: control.y };
    }

    if (command.type === 'C') {
      const end = pointFromGlyph(command.x, command.y, x, y, scale);
      const controlA = pointFromGlyph(command.x1, command.y1, x, y, scale);
      const controlB = pointFromGlyph(command.x2, command.y2, x, y, scale);
      return { type: 'C', ...end, x1: controlA.x, y1: controlA.y, x2: controlB.x, y2: controlB.y };
    }

    return { type: 'Z' };
  });
}

function measureLine(font: OpenTypeFont, glyphs: OpenTypeGlyph[], scale: number, letterSpacing: number) {
  return glyphs.reduce((width, glyph, glyphIndex) => {
    const previousGlyph = glyphs[glyphIndex - 1];
    const kerning = previousGlyph && font.getKerningValue
      ? font.getKerningValue(previousGlyph, glyph) * scale
      : 0;
    const spacing = glyphIndex < glyphs.length - 1 ? letterSpacing : 0;

    return width + kerning + glyph.advanceWidth * scale + spacing;
  }, 0);
}

function layoutText(font: OpenTypeFont, text: string, options: LayoutOptions): TextLayout {
  const bounds = emptyBounds();
  const scale = options.fontSize / font.unitsPerEm;
  const baselineStep = options.fontSize * options.lineHeight;
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const glyphs = font.stringToGlyphs(line || ' ');
    return {
      glyphs,
      width: measureLine(font, glyphs, scale, options.letterSpacing),
    };
  });
  const maxLineWidth = Math.max(...lines.map((line) => line.width), MIN_BOUNDS_SIZE);
  const glyphs = lines.flatMap((line, lineIndex) => {
    const alignX = options.alignment === 'center'
      ? (maxLineWidth - line.width) / 2
      : options.alignment === 'right'
        ? maxLineWidth - line.width
        : 0;
    let cursor = alignX;

    return line.glyphs.map((glyph, glyphIndex) => {
      const previousGlyph = line.glyphs[glyphIndex - 1];
      if (previousGlyph && font.getKerningValue) cursor += font.getKerningValue(previousGlyph, glyph) * scale;

      const commands = glyphToCommands(glyph, cursor, lineIndex * baselineStep, scale);
      const glyphBounds = commandBounds(commands);
      commands.forEach((command) => includeCommand(bounds, command));
      cursor += glyph.advanceWidth * scale;
      if (glyphIndex < line.glyphs.length - 1) cursor += options.letterSpacing;

      if (!Number.isFinite(glyphBounds.x1)) return null;

      return {
        id: `glyph-${lineIndex}-${glyphIndex}-${glyph.index}`,
        glyphIndex,
        lineIndex,
        d: commandsToPath(commands),
        commands,
        bounds: glyphBounds,
      };
    }).filter((glyph): glyph is GlyphLayout => Boolean(glyph));
  });

  if (!Number.isFinite(bounds.x1)) {
    includePoint(bounds, { x: 0, y: 0 });
    includePoint(bounds, { x: Math.max(options.fontSize, MIN_BOUNDS_SIZE), y: Math.max(options.fontSize, MIN_BOUNDS_SIZE) });
  }

  return { glyphs, bounds };
}

function createRandom(seed: number): RandomSource {
  let state = seed >>> 0;

  return {
    next(min = 0, max = 1) {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      const unit = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      return min + unit * (max - min);
    },
  };
}

function seededVariation(seed: number, size: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return Math.floor(Math.abs(value - Math.floor(value)) * size);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function mix(left: number, right: number, amount: number) {
  return left + (right - left) * amount;
}

function radiusFromRatio(ratio: number) {
  return mix(0.35, 24, clamp(ratio, 0, 1));
}

function scaledControl(value: number) {
  return value / PACKING_CONTROL_SCALE;
}

function derivePackingOptions(controls: PackingControlValues): PackingOptions {
  const fill = clamp(scaledControl(controls.fill), 0, 1);
  const minRatio = clamp(scaledControl(controls.minRatio), 0, 1);
  const maxRatio = Math.max(minRatio + 0.02, clamp(scaledControl(controls.maxRatio), 0, 1));
  const sizeVariation = clamp(scaledControl(controls.sizeVariation), 0, 1);
  const minRadius = radiusFromRatio(minRatio);
  const maxRadius = radiusFromRatio(Math.min(1, maxRatio));
  const densityScale = Math.pow(8 / Math.max(2, maxRadius), 1.25);
  const maxCircles = Math.round(clamp(mix(120, 720, fill) * densityScale, 60, 2400));

  return {
    seed: controls.seed,
    maxCircles,
    candidates: Math.round(mix(28, 80, fill)),
    minRadius,
    maxRadius,
    gap: clamp(scaledControl(controls.spacing), 0, 4),
    edgeSamples: 14,
    tightness: mix(0.96, 1, fill),
    variation: mix(0.12, 0.9, sizeVariation),
    radiusPower: mix(0.65, 2.3, sizeVariation),
  };
}

function useDebouncedValue<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);

  return debounced;
}

function createEdgeOffsets(samples: number) {
  const offsets: SampleOffset[] = [];
  const sampleCount = Math.max(8, Math.round(samples));

  for (let ringIndex = 0; ringIndex < 2; ringIndex += 1) {
    const ringRadius = ringIndex === 0 ? 1 : 0.58;
    for (let index = 0; index < sampleCount; index += 1) {
      const angle = (index / sampleCount) * Math.PI * 2 + ringIndex * 0.19;
      offsets.push({
        x: Math.cos(angle) * ringRadius,
        y: Math.sin(angle) * ringRadius,
      });
    }
  }

  return offsets;
}

function glyphToWorkerPayload(glyph: GlyphLayout): WorkerGlyphLayout {
  return {
    id: glyph.id,
    glyphIndex: glyph.glyphIndex,
    lineIndex: glyph.lineIndex,
    d: glyph.d,
    bounds: glyph.bounds,
  };
}

function createCircleGrid(maxRadius: number, gap: number): CircleSpatialGrid {
  return {
    cellSize: Math.max(1, maxRadius + gap),
    cells: new Map(),
  };
}

function gridKey(cellX: number, cellY: number) {
  return `${cellX}:${cellY}`;
}

function circleCell(grid: CircleSpatialGrid, point: Point) {
  return {
    x: Math.floor(point.x / grid.cellSize),
    y: Math.floor(point.y / grid.cellSize),
  };
}

function insertCircle(grid: CircleSpatialGrid, circle: PackedCircle) {
  const cell = circleCell(grid, circle);
  const key = gridKey(cell.x, cell.y);
  const circles = grid.cells.get(key);
  if (circles) {
    circles.push(circle);
    return;
  }

  grid.cells.set(key, [circle]);
}

function nearbyCircleDistanceLimit(grid: CircleSpatialGrid, point: Point, maxRadius: number, gap: number) {
  const cell = circleCell(grid, point);
  const range = Math.ceil((maxRadius * 2 + gap) / grid.cellSize) + 1;
  let limit = Infinity;

  for (let y = cell.y - range; y <= cell.y + range; y += 1) {
    for (let x = cell.x - range; x <= cell.x + range; x += 1) {
      const cellCircles = grid.cells.get(gridKey(x, y));
      if (!cellCircles) continue;

      for (const circle of cellCircles) {
        const dx = circle.x - point.x;
        const dy = circle.y - point.y;
        const lowerBound = Math.max(Math.abs(dx), Math.abs(dy)) - circle.r - gap;
        if (lowerBound >= limit) continue;
        limit = Math.min(limit, Math.hypot(dx, dy) - circle.r - gap);
      }
    }
  }

  return limit;
}

function pointIsInside(context: CanvasRenderingContext2D, path: Path2D, x: number, y: number) {
  return context.isPointInPath(path, x, y, 'nonzero');
}

function circleFitsPath(
  context: CanvasRenderingContext2D,
  path: Path2D,
  center: Point,
  radius: number,
  edgeOffsets: SampleOffset[],
  centerIsInside = false,
) {
  if (!centerIsInside && !pointIsInside(context, path, center.x, center.y)) return false;

  for (const offset of edgeOffsets) {
    if (!pointIsInside(context, path, center.x + offset.x * radius, center.y + offset.y * radius)) {
      return false;
    }
  }

  return true;
}

function fittedRadius(
  context: CanvasRenderingContext2D,
  path: Path2D,
  center: Point,
  collisionLimit: number,
  options: PackingOptions,
  edgeOffsets: SampleOffset[],
) {
  let high = Math.min(options.maxRadius, collisionLimit);
  if (!Number.isFinite(high) || high < options.minRadius) return 0;

  let low = 0;
  for (let step = 0; step < MAX_BINARY_STEPS; step += 1) {
    const mid = (low + high) / 2;
    if (circleFitsPath(context, path, center, mid, edgeOffsets, true)) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low >= options.minRadius ? low : 0;
}

function colorForCircle(
  circleIndex: number,
  circle: PackedCircle,
  options: ColoringOptions,
) {
  const palette = options.palette.length > 0 ? options.palette : DEFAULT_PALETTE;
  if (options.colorMode === 'glyph') return palette[circle.glyphIndex % palette.length] ?? palette[0];
  if (options.colorMode === 'rows') return palette[(circle.glyphLineIndex + circleIndex) % palette.length] ?? palette[0];
  if (options.colorMode === 'random') {
    return palette[seededVariation(options.seed + circleIndex * 97 + circle.glyphIndex * 733, palette.length)] ?? palette[0];
  }

  const span = Math.max(1, options.maxRadius - options.minRadius);
  const ratio = Math.min(1, Math.max(0, (circle.r - options.minRadius) / span));
  const radiusIndex = Math.floor((1 - ratio) * (palette.length - 1));
  const randomIndex = seededVariation(options.seed + circleIndex * 149 + circle.glyphIndex * 401 + Math.round(circle.r * 31), palette.length);
  const innerMix = Math.max(0, Math.min(1, options.innerColorMix));
  const innerChance = 0.36 + Math.pow(1 - ratio, 0.7) * innerMix * 0.64;
  const index = seededVariation(options.seed + circleIndex * 47 + circle.glyphIndex * 911, 1000) / 1000 < innerChance
    ? randomIndex
    : radiusIndex;
  return palette[index] ?? palette[0];
}

function variedRadius(radiusLimit: number, random: RandomSource, options: PackingOptions, variation: number, power: number) {
  const largestRadius = Math.max(options.minRadius, radiusLimit * options.tightness);
  const shrink = variation * (1 - Math.pow(random.next(), power));
  return mix(largestRadius, options.minRadius, shrink);
}

function packGlyph(
  context: CanvasRenderingContext2D,
  glyph: GlyphLayout,
  options: PackingOptions,
) {
  const path = new Path2D(glyph.d);
  const random = createRandom(options.seed + glyph.lineIndex * 1009 + glyph.glyphIndex * 337);
  const edgeOffsets = createEdgeOffsets(options.edgeSamples);
  const grid = createCircleGrid(options.maxRadius, options.gap);
  const candidateCount = Math.max(1, Math.round(options.candidates));
  const variation = Math.max(0, Math.min(1, options.variation));
  const power = Math.max(0.15, options.radiusPower);
  const circles: PackedCircle[] = [];
  let emptyRounds = 0;

  while (circles.length < options.maxCircles && emptyRounds < EMPTY_ROUND_LIMIT) {
    let best: PackedCircle | null = null;

    for (let index = 0; index < candidateCount; index += 1) {
      const center = {
        x: random.next(glyph.bounds.x1, glyph.bounds.x2),
        y: random.next(glyph.bounds.y1, glyph.bounds.y2),
      };
      if (!pointIsInside(context, path, center.x, center.y)) continue;

      const collisionLimit = nearbyCircleDistanceLimit(grid, center, options.maxRadius, options.gap);
      const radiusLimit = fittedRadius(context, path, center, collisionLimit, options, edgeOffsets);
      if (radiusLimit <= 0) continue;

      const radius = variedRadius(radiusLimit, random, options, variation, power);
      if (!circleFitsPath(context, path, center, radius, edgeOffsets, true)) continue;

      const score = radius * (0.94 + random.next(0, 0.12));
      if (!best || score > best.r) {
        best = {
          id: `${glyph.id}-circle-${circles.length}-${index}`,
          x: center.x,
          y: center.y,
          r: radius,
          glyphId: glyph.id,
          glyphLineIndex: glyph.lineIndex,
          glyphIndex: glyph.glyphIndex,
        };
      }
    }

    if (!best) {
      emptyRounds += 1;
      continue;
    }

    circles.push(best);
    insertCircle(grid, best);
    emptyRounds = 0;
  }

  return circles;
}

function packLayout(layout: TextLayout, options: PackingOptions): PackedScene {
  if (typeof document === 'undefined') return { circles: [], viewBox: padBounds(layout.bounds, VIEWBOX_PADDING) };
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return { circles: [], viewBox: padBounds(layout.bounds, VIEWBOX_PADDING) };

  const bounds = padBounds(layout.bounds, Math.max(VIEWBOX_PADDING, options.maxRadius + VIEWBOX_PADDING));
  const circles = layout.glyphs.flatMap((glyph) => packGlyph(context, glyph, options));

  return { circles, viewBox: bounds };
}

function unpackWorkerCircles(glyph: GlyphLayout, circleData: Float32Array) {
  const circles: PackedCircle[] = [];

  for (let offset = 0; offset < circleData.length; offset += 3) {
    const circleIndex = offset / 3;
    circles.push({
      id: `${glyph.id}-circle-${circleIndex}`,
      x: circleData[offset],
      y: circleData[offset + 1],
      r: circleData[offset + 2],
      glyphId: glyph.id,
      glyphLineIndex: glyph.lineIndex,
      glyphIndex: glyph.glyphIndex,
    });
  }

  return circles;
}

function getWorkerCount(glyphCount: number) {
  const hardwareThreads = typeof navigator === 'undefined'
    ? 2
    : Math.max(2, navigator.hardwareConcurrency || 2);
  return Math.max(1, Math.min(glyphCount, hardwareThreads - 1, MAX_PACKING_WORKERS));
}

function useWorkerPackedScene(layout: TextLayout | null, options: PackingOptions): PackedSceneState {
  const [state, setState] = useState<PackedSceneState>({ scene: null, pending: false });

  useEffect(() => {
    if (!layout) {
      setState({ scene: null, pending: false });
      return undefined;
    }

    const viewBox = padBounds(layout.bounds, Math.max(VIEWBOX_PADDING, options.maxRadius + VIEWBOX_PADDING));
    if (layout.glyphs.length === 0) {
      setState({ scene: { circles: [], viewBox }, pending: false });
      return undefined;
    }

    if (typeof Worker === 'undefined') {
      setState({ scene: packLayout(layout, options), pending: false });
      return undefined;
    }

    const requestId = packingRequestId + 1;
    packingRequestId = requestId;
    let cancelled = false;
    let finished = false;
    let nextGlyphIndex = 0;
    let completedGlyphs = 0;
    let workers: Worker[] = [];
    const circlesByGlyph: PackedCircle[][] = new Array(layout.glyphs.length);

    setState((previous) => ({ scene: previous.scene, pending: true }));

    const stopWorkers = () => {
      workers.forEach((worker) => worker.terminate());
      workers = [];
    };

    const finishWithFallback = () => {
      if (cancelled || finished) return;
      finished = true;
      stopWorkers();
      setState({ scene: packLayout(layout, options), pending: false });
    };

    const assignGlyph = (worker: Worker) => {
      if (cancelled || finished) return;

      const index = nextGlyphIndex;
      nextGlyphIndex += 1;
      if (index >= layout.glyphs.length) return;

      worker.postMessage({
        type: 'pack',
        requestId,
        index,
        glyph: glyphToWorkerPayload(layout.glyphs[index]),
        options,
      });
    };

    const finishIfComplete = () => {
      if (cancelled || finished || completedGlyphs < layout.glyphs.length) return;

      finished = true;
      stopWorkers();
      setState({
        scene: {
          circles: circlesByGlyph.flat(),
          viewBox,
        },
        pending: false,
      });
    };

    try {
      workers = Array.from({ length: getWorkerCount(layout.glyphs.length) }, () => {
        const worker = new Worker(new URL('./_circlePackingWorker.ts', import.meta.url), { type: 'module' });

        worker.onmessage = (event: MessageEvent<PackingWorkerResponse>) => {
          if (cancelled || finished) return;

          const message = event.data;
          if (message.requestId !== requestId) return;
          if (message.type !== 'result' || !message.circleData) {
            finishWithFallback();
            return;
          }

          circlesByGlyph[message.index] = unpackWorkerCircles(layout.glyphs[message.index], message.circleData);
          completedGlyphs += 1;
          assignGlyph(worker);
          finishIfComplete();
        };

        worker.onerror = () => finishWithFallback();
        return worker;
      });

      workers.forEach((worker) => assignGlyph(worker));
    } catch {
      finishWithFallback();
    }

    return () => {
      cancelled = true;
      stopWorkers();
    };
  }, [layout, options]);

  return state;
}

function colorPackedCircles(circles: PackedCircle[], options: ColoringOptions) {
  return circles.map((circle, circleIndex) => ({
    ...circle,
    color: colorForCircle(circleIndex, circle, options),
  }));
}

function getDefaultFontForFamily(fontFamily: ReturnType<typeof getFontFamilyById>) {
  return getFontByValue(
    fontFamily.fonts,
    fontFamily.defaultFont.value,
    fontFamily.defaultFont,
  );
}

export default function CirclePackedType() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const defaultFamily = getFontFamilyById('humane');
  const [selectedFontFamilyId, setSelectedFontFamilyId] = useState(defaultFamily.id);
  const selectedFontFamily = getFontFamilyById(selectedFontFamilyId);
  const [selectedFontValue, setSelectedFontValue] = useState(getDefaultFontForFamily(defaultFamily).value);
  const selectedFont = getFontByValue(selectedFontFamily.fonts, selectedFontValue, selectedFontFamily.defaultFont);

  const typography = useControls(
    'Typography',
    {
      fontFamily: {
        value: selectedFontFamily.id,
        options: getFontFamilyOptions(),
        label: 'family',
        onChange: (familyId: string) => {
          const nextFamily = getFontFamilyById(familyId);
          setSelectedFontFamilyId(nextFamily.id);
          setSelectedFontValue(getDefaultFontForFamily(nextFamily).value);
        },
      },
      fontVariant: {
        value: selectedFont.value,
        options: getFontVariantOptions(selectedFontFamily.fonts),
        label: 'variant',
        onChange: (value: string) => setSelectedFontValue(value),
      },
      text: { value: DEFAULT_TEXT, rows: 4, label: 'text' },
      fontSize: { ...nativeNumber({ current: 184, min: 36, max: 420, step: 1 }), label: 'font size' },
      lineHeight: { ...nativeNumber({ current: 0.86, min: 0.45, max: 1.4, step: 0.01 }), label: 'line height' },
      letterSpacing: { ...nativeNumber({ current: 0, min: -60, max: 160, step: 0.5 }), label: 'letter spacing' },
      alignment: {
        value: 'center',
        options: ['left', 'center', 'right'],
        label: 'alignment',
      },
    },
    { collapsed: false },
    [selectedFontFamily.id, selectedFont.value],
  );

  const packing = useControls('Packing', {
    seed: { ...nativeNumber({ current: 4671, min: 0, max: 9999, step: 1 }), label: 'seed' },
    fill: { ...nativeNumber({ current: 97, min: 10, max: 100, step: 1 }), label: 'fill' },
    minRatio: { ...nativeNumber({ current: 2, min: 0, max: 20, step: 0.5 }), label: 'min ratio' },
    maxRatio: { ...nativeNumber({ current: 14, min: 0, max: 20, step: 0.5 }), label: 'max ratio' },
    spacing: { ...nativeNumber({ current: 12, min: 0, max: 400, step: 1 }), label: 'spacing' },
    sizeVariation: { ...nativeNumber({ current: 99, min: 0, max: 100, step: 1 }), label: 'size variety' },
  }, { collapsed: false });

  const drawing = useControls('Drawing', {
    showFaces: { value: false, label: 'glyph face' },
    circleStroke: { value: false, label: 'circle stroke' },
    colorMode: {
      value: 'random',
      options: ['radius', 'random', 'glyph', 'rows'],
      label: 'color mode',
    },
    innerColorMix: { ...nativeNumber({ current: 0.78, min: 0, max: 1, step: 0.01 }), label: 'inner color mix' },
    circleOpacity: { ...nativeNumber({ current: 1, min: 0.1, max: 1, step: 0.01 }), label: 'opacity' },
    faceOpacity: { ...nativeNumber({ current: 0.055, min: 0, max: 1, step: 0.005 }), label: 'face alpha' },
    Color: folder({
      background: '#ffffff',
      face: '#11110f',
      palette: colorPalette({
        value: { source: 'playground-blue-teal', colors: DEFAULT_PALETTE },
        palettes: packingPalettePresets,
      }),
    }, { collapsed: false }),
  }, { collapsed: false });

  useControls({
    'Download SVG': button(() => downloadSvg(svgRef.current, `circle-packed-type-${Date.now()}.svg`, { horizontalPaddingRatio: 0 })),
  });

  const { font, error } = useOpenTypeFont(selectedFont.url);
  const inputText = String(typography.text);
  const layout = useMemo(() => {
    if (!font) return null;
    return layoutText(font, inputText, {
      fontSize: Number(typography.fontSize),
      lineHeight: Number(typography.lineHeight),
      letterSpacing: Number(typography.letterSpacing),
      alignment: typography.alignment as TextAlignment,
    });
  }, [font, inputText, typography.alignment, typography.fontSize, typography.letterSpacing, typography.lineHeight]);
  const activePalette = drawing.palette.colors?.length
    ? drawing.palette.colors
    : DEFAULT_PALETTE;
  const activePaletteKey = activePalette.join('|');
  const stablePalette = useMemo(() => activePalette, [activePaletteKey]);
  const packingOptions = useMemo(() => derivePackingOptions({
    seed: Number(packing.seed),
    fill: Number(packing.fill),
    minRatio: Number(packing.minRatio),
    maxRatio: Number(packing.maxRatio),
    spacing: Number(packing.spacing),
    sizeVariation: Number(packing.sizeVariation),
  }), [
    packing.fill,
    packing.maxRatio,
    packing.minRatio,
    packing.seed,
    packing.sizeVariation,
    packing.spacing,
  ]);
  const debouncedPackingOptions = useDebouncedValue(packingOptions, 120);
  const { scene: packed, pending: packingPending } = useWorkerPackedScene(layout, debouncedPackingOptions);
  const coloringOptions = useMemo((): ColoringOptions => ({
    seed: debouncedPackingOptions.seed,
    minRadius: debouncedPackingOptions.minRadius,
    maxRadius: debouncedPackingOptions.maxRadius,
    innerColorMix: Number(drawing.innerColorMix),
    colorMode: drawing.colorMode as ColorMode,
    palette: stablePalette,
  }), [
    debouncedPackingOptions.maxRadius,
    debouncedPackingOptions.minRadius,
    debouncedPackingOptions.seed,
    drawing.colorMode,
    drawing.innerColorMix,
    stablePalette,
  ]);
  const coloredCircles = useMemo(() => (
    packed ? colorPackedCircles(packed.circles, coloringOptions) : []
  ), [coloringOptions, packed]);

  if (error) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Font failed to load: {error}</div>
        <SketchControls fill flat />
      </section>
    );
  }

  if (!font || !layout || !packed) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">{font && layout && packingPending ? 'Packing...' : 'Loading font...'}</div>
        <SketchControls fill flat />
      </section>
    );
  }

  return (
    <section className="sketch-workbench circle-packed-type">
      <div className="sketch-stage circle-packed-type__stage">
        <svg
          ref={svgRef}
          className="type-svg circle-packed-type__svg"
          viewBox={boundsToViewBox(packed.viewBox)}
          role="img"
          aria-label={`${inputText} rendered as packed circles inside glyph shapes`}
          style={{ backgroundColor: String(drawing.background) }}
          shapeRendering="geometricPrecision"
        >
          <rect x={packed.viewBox.x1} y={packed.viewBox.y1} width={packed.viewBox.x2 - packed.viewBox.x1} height={packed.viewBox.y2 - packed.viewBox.y1} fill={String(drawing.background)} />
          <g className="packed-glyphs">
            {drawing.showFaces && layout.glyphs.map((glyph) => (
              <path
                key={`${glyph.id}-face`}
                d={glyph.d}
                fill={String(drawing.face)}
                fillRule="nonzero"
                opacity={Number(drawing.faceOpacity)}
              />
            ))}
            {coloredCircles.map((circle) => (
              <circle
                key={circle.id}
                cx={round(circle.x)}
                cy={round(circle.y)}
                r={round(circle.r)}
                fill={circle.color}
                opacity={Number(drawing.circleOpacity)}
                stroke={drawing.circleStroke ? String(drawing.background) : undefined}
                strokeWidth={drawing.circleStroke ? Math.max(0.25, debouncedPackingOptions.gap * 0.5) : undefined}
                data-glyph-id={circle.glyphId}
                data-glyph-index={circle.glyphIndex}
              />
            ))}
          </g>
        </svg>
      </div>
      <SketchControls fill flat collapsed={false} oneLineLabels={false} />
    </section>
  );
}
