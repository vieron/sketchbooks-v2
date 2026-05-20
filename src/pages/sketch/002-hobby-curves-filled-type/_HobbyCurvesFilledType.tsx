import { useEffect, useMemo, useRef, useState } from 'react';
import { button, Leva, useControls } from 'leva';
import { createHobbyBezier } from 'hobby-curve';
import { colorPalette } from '../../../controls/colorPalettePlugin';
import { originalPlaygroundPalette, sketchPalettePresets } from '../../../data/palettes';
import {
  getFontByValue,
  getFontFamilyById,
  getFontFamilyOptions,
  getFontVariantOptions,
  type FontMeta,
} from '../../../data/fonts';

type Point = {
  x: number;
  y: number;
};

type GridPoint = Point | null | undefined;

type PointLine = {
  points: Point[];
  stripeIndex: number;
};

type PointGrouping = 'horizontal' | 'vertical' | 'diagonal' | 'flow';

type DrawSettings = {
  text: string;
  textLayout: TextLayout;
  fontFamily: string;
  fontWeight: string;
  fontStyle: FontMeta['style'];
  fontScale: number;
  letterSpacing: number;
  seed: number;
  radius: number;
  grouping: PointGrouping;
  lineTension: number;
  lineWeight: number;
  pointsPerLine: number;
  strokeWidth: number;
  strokeColor: string;
  background: string;
  palette: string[];
};

type TextLayout = 'letters' | 'text';

type HobbyCurvesFilledTypeProps = {
  textLayout?: TextLayout;
};

type SpacedCanvasContext = CanvasRenderingContext2D & {
  fontKerning?: CanvasFontKerning;
  letterSpacing?: string;
};

type RandomSource = {
  next(min?: number, max?: number): number;
};

type IndexedPoint = Point & {
  col: number;
  row: number;
  index: number;
};

type SvgLine = {
  id: string;
  d: string;
  color: string;
};

type HobbyBezierSegment = {
  startControl: Point;
  endControl: Point;
  point: Point;
};

type SvgScene = {
  width: number;
  height: number;
  lines: SvgLine[];
};

const loadedSvgFonts = new Map<string, Promise<void>>();
const DEFAULT_FONT_FAMILY_ID = 'geist';
const DEFAULT_FONT_VALUE = 'geist-black';
const DEFAULT_LINE_LENGTH = 100;
const FLOW_NEIGHBOR_RADIUS = 2;
const FLOW_MIN_SCORE = -0.2;

function getDefaultFontForFamily(fontFamily: ReturnType<typeof getFontFamilyById>) {
  return getFontByValue(
    fontFamily.fonts,
    fontFamily.id === DEFAULT_FONT_FAMILY_ID ? DEFAULT_FONT_VALUE : fontFamily.defaultFont.value,
    fontFamily.defaultFont,
  );
}

function isSvgFontLoaded(font: FontMeta) {
  let loaded = false;
  document.fonts.forEach((face) => {
    if (face.family === font.value && face.weight === font.weight && face.style === font.style && face.status === 'loaded') {
      loaded = true;
    }
  });
  return loaded;
}

function loadSvgFont(font: FontMeta) {
  if (typeof FontFace === 'undefined') return Promise.resolve();
  if (isSvgFontLoaded(font)) return Promise.resolve();

  const cached = loadedSvgFonts.get(font.value);
  if (cached) return cached;

  const promise = new FontFace(font.value, `url(${font.url})`, { weight: font.weight, style: font.style })
    .load()
    .then((loadedFont) => {
      document.fonts.add(loadedFont);
    });

  loadedSvgFonts.set(font.value, promise);
  return promise;
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

function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number, clamp = false) {
  const mapped = outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
  if (!clamp) return mapped;
  return Math.min(Math.max(mapped, Math.min(outMin, outMax)), Math.max(outMin, outMax));
}

function pathNumber(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function hashGrid(x: number, y: number, seed: number) {
  let value = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return (value ^ (value >>> 16)) >>> 0;
}

function gradient(ix: number, iy: number, x: number, y: number, seed: number) {
  const angle = (hashGrid(ix, iy, seed) / 4294967296) * Math.PI * 2;
  const dx = x - ix;
  const dy = y - iy;
  return Math.cos(angle) * dx + Math.sin(angle) * dy;
}

function perlin2(x: number, y: number, seed: number) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const sx = fade(x - x0);
  const sy = fade(y - y0);
  const n0 = gradient(x0, y0, x, y, seed);
  const n1 = gradient(x1, y0, x, y, seed);
  const ix0 = lerp(n0, n1, sx);
  const n2 = gradient(x0, y1, x, y, seed);
  const n3 = gradient(x1, y1, x, y, seed);
  const ix1 = lerp(n2, n3, sx);

  return (lerp(ix0, ix1, sy) + 1) / 2;
}

function applyTextStyle(
  context: CanvasRenderingContext2D,
  fontFamily: string,
  fontSize: number,
  fontWeight: string,
  fontStyle: FontMeta['style'],
  letterSpacing = 0,
) {
  const spacedContext = context as SpacedCanvasContext;
  context.font = `${fontStyle} ${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
  if ('fontKerning' in spacedContext) spacedContext.fontKerning = 'normal';
  if ('letterSpacing' in spacedContext) spacedContext.letterSpacing = `${letterSpacing}px`;
}

function getFallbackSpacingWidth(context: CanvasRenderingContext2D, text: string, letterSpacing: number) {
  return 'letterSpacing' in context ? 0 : Math.max(0, text.length - 1) * letterSpacing;
}

function measureTextBounds(
  context: CanvasRenderingContext2D,
  text: string,
  fontFamily: string,
  fontSize: number,
  fontWeight: string,
  fontStyle: FontMeta['style'],
  letterSpacing = 0,
) {
  applyTextStyle(context, fontFamily, fontSize, fontWeight, fontStyle, letterSpacing);
  const measure = context.measureText(text);
  const left = Number.isFinite(measure.actualBoundingBoxLeft) ? measure.actualBoundingBoxLeft : 0;
  const right = (Number.isFinite(measure.actualBoundingBoxRight) ? measure.actualBoundingBoxRight : measure.width)
    + getFallbackSpacingWidth(context, text, letterSpacing);
  const ascent = Number.isFinite(measure.actualBoundingBoxAscent) ? measure.actualBoundingBoxAscent : fontSize;
  const descent = Number.isFinite(measure.actualBoundingBoxDescent) ? measure.actualBoundingBoxDescent : fontSize * 0.2;

  return {
    left,
    right,
    ascent,
    descent,
    width: Math.max(1, Math.ceil(left + right)),
    height: Math.max(1, Math.ceil(ascent + descent)),
  };
}

function getFontSizeToFit(
  text: string,
  width: number,
  height: number,
  fontFamily: string,
  fontWeight: string,
  fontStyle: FontMeta['style'],
  letterSpacing = 0,
) {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return 120;
  const bounds = measureTextBounds(context, text, fontFamily, 100, fontWeight, fontStyle, letterSpacing);
  return Math.max(10, Math.min((width / bounds.width) * 100, (height / bounds.height) * 100));
}

function createTextImage(
  text: string,
  fontFamily: string,
  fontSize: number,
  fontWeight: string,
  fontStyle: FontMeta['style'],
  letterSpacing = 0,
) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas context unavailable');
  const bounds = measureTextBounds(context, text, fontFamily, fontSize, fontWeight, fontStyle, letterSpacing);
  const padding = Math.max(4, Math.ceil(fontSize * 0.04));

  canvas.width = bounds.width + padding * 2;
  canvas.height = bounds.height + padding * 2;
  applyTextStyle(context, fontFamily, fontSize, fontWeight, fontStyle, letterSpacing);
  context.fillStyle = '#000000';
  context.textBaseline = 'alphabetic';
  context.fillText(text, padding + bounds.left, padding + bounds.ascent);

  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function poissonDisk(
  random: RandomSource,
  {
    radius,
    tries,
    width,
    height,
    skipPoint = () => false,
  }: {
    radius: number;
    tries: number;
    width: number;
    height: number;
    skipPoint?: (point: Point) => boolean;
  },
) {
  const cellSize = radius / Math.sqrt(2);
  const cols = Math.max(1, Math.floor(width / cellSize));
  const rows = Math.max(1, Math.floor(height / cellSize));
  const grid: GridPoint[] = Array.from({ length: cols * rows });
  const active: Point[] = [];
  const points: Point[] = [];
  const start = { x: width / 2, y: height / 2 };
  const startIndex = Math.floor(start.x / cellSize) + Math.floor(start.y / cellSize) * cols;

  grid[startIndex] = start;
  active.push(start);
  if (!skipPoint(start)) points.push(start);

  while (active.length > 0) {
    const randomIndex = active.length - 1;
    const point = active[randomIndex] as Point;
    let found = false;

    for (let n = 0; n < tries; n += 1) {
      const angle = random.next(0, Math.PI * 2);
      const magnitude = random.next(radius, radius * 2);
      const sample = {
        x: point.x + Math.cos(angle) * magnitude,
        y: point.y + Math.sin(angle) * magnitude,
      };
      const col = Math.floor(sample.x / cellSize);
      const row = Math.floor(sample.y / cellSize);
      const cellIndex = col + row * cols;

      if (col < 0 || row < 0 || col >= cols || row >= rows || typeof grid[cellIndex] !== 'undefined') continue;

      let valid = true;
      for (let i = -1; i <= 1; i += 1) {
        for (let j = -1; j <= 1; j += 1) {
          const neighbor = grid[col + i + (row + j) * cols];
          if (neighbor && Math.hypot(sample.x - neighbor.x, sample.y - neighbor.y) < radius) {
            valid = false;
            break;
          }
        }
        if (!valid) break;
      }

      if (valid) {
        found = true;
        active.push(sample);
        if (skipPoint(sample)) {
          grid[cellIndex] = null;
        } else {
          grid[cellIndex] = sample;
          points.push(sample);
        }
        break;
      }
    }

    if (!found) active.splice(randomIndex, 1);
  }

  return { grid, points, cols, rows };
}

function groupLines(
  grid: GridPoint[],
  cols: number,
  rows: number,
  grouping: PointGrouping,
  pointsPerLine: number,
  seed: number,
) {
  const lines: PointLine[] = [];
  const maxPoints = Math.max(2, Math.round(pointsPerLine));

  const pushLine = (linePoints: Point[], stripeIndex: number) => {
    if (linePoints.length < 2) return;
    pushLineSegments(linePoints, stripeIndex);
  };

  const pushLineSegments = (linePoints: Point[], stripeIndex: number) => {
    if (linePoints.length <= maxPoints) {
      lines.push({ points: linePoints, stripeIndex });
      return;
    }

    const step = Math.max(1, maxPoints - 1);
    for (let index = 0; index < linePoints.length - 1; index += step) {
      const segment = linePoints.slice(index, index + maxPoints);
      if (segment.length > 1) lines.push({ points: segment, stripeIndex });
    }
  };

  if (grouping === 'flow') {
    const pointIndex = new Map<Point, IndexedPoint>();
    grid.forEach((point, index) => {
      if (!point) return;
      pointIndex.set(point, {
        ...point,
        col: index % cols,
        row: Math.floor(index / cols),
        index: pointIndex.size,
      });
    });
    const unused = new Set([...pointIndex.values()].map((point) => point.index));
    const indexedGrid = grid.map((point) => (point ? pointIndex.get(point) : undefined));
    const getNeighbor = (col: number, row: number) => {
      if (col < 0 || row < 0 || col >= cols || row >= rows) return undefined;
      return indexedGrid[col + row * cols];
    };

    pointIndex.forEach((start) => {
      if (!start || !unused.has(start.index)) return;

      const line: Point[] = [];
      let current = start;

      while (current && unused.has(current.index) && line.length < maxPoints) {
        line.push(current);
        unused.delete(current.index);

        const angle = perlin2(current.col * 0.12, current.row * 0.12, seed) * Math.PI * 2;
        const direction = { x: Math.cos(angle), y: Math.sin(angle) };
        let next: IndexedPoint | undefined;
        let bestScore = -Infinity;

        for (let rowOffset = -FLOW_NEIGHBOR_RADIUS; rowOffset <= FLOW_NEIGHBOR_RADIUS; rowOffset += 1) {
          for (let colOffset = -FLOW_NEIGHBOR_RADIUS; colOffset <= FLOW_NEIGHBOR_RADIUS; colOffset += 1) {
            if (rowOffset === 0 && colOffset === 0) continue;
            const candidate = getNeighbor(current.col + colOffset, current.row + rowOffset);
            if (!candidate || !unused.has(candidate.index)) continue;
            const dx = candidate.x - current.x;
            const dy = candidate.y - current.y;
            const distance = Math.max(0.001, Math.hypot(dx, dy));
            const alignment = (dx / distance) * direction.x + (dy / distance) * direction.y;
            const score = alignment - distance * 0.015;
            if (score > bestScore) {
              bestScore = score;
              next = candidate;
            }
          }
        }

        if (!next || bestScore < FLOW_MIN_SCORE) break;
        current = next;
      }

      if (line.length > 1) lines.push({ points: line, stripeIndex: lines.length });
    });

    return lines;
  }

  let currentLine: Point[] = [];
  const endLine = (stripeIndex: number) => {
    pushLine(currentLine, stripeIndex);
    currentLine = [];
  };

  if (grouping === 'horizontal') {
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const point = grid[col + row * cols];
        if (point) currentLine.push(point);
        if (point === null) endLine(row);
      }
      endLine(row);
    }
  } else if (grouping === 'vertical') {
    for (let col = 0; col < cols; col += 1) {
      for (let row = 0; row < rows; row += 1) {
        const point = grid[col + row * cols];
        if (point) currentLine.push(point);
        if (point === null) endLine(col);
      }
      endLine(col);
    }
  } else {
    for (let diagonal = -cols + 1; diagonal < rows; diagonal += 1) {
      for (let col = 0; col < cols; col += 1) {
        const row = diagonal + col;
        if (row < 0 || row >= rows) continue;
        const point = grid[col + row * cols];
        if (point) currentLine.push(point);
        if (point === null) endLine(diagonal + cols - 1);
      }
      endLine(diagonal + cols - 1);
    }
  }

  return lines;
}

function lineToPath(origin: Point, points: { startControl: Point; endControl: Point; point: Point }[]) {
  return [
    `M${pathNumber(origin.x)} ${pathNumber(origin.y)}`,
    ...points.map(({ startControl, endControl, point }) => (
      `C${pathNumber(startControl.x)} ${pathNumber(startControl.y)} ${pathNumber(endControl.x)} ${pathNumber(endControl.y)} ${pathNumber(point.x)} ${pathNumber(point.y)}`
    )),
  ].join('');
}

function createSvgScene(width: number, height: number, settings: DrawSettings): SvgScene {
  const margin = mapRange(width, 320, 2200, 24, 96, true);
  const safeMargin = margin + Math.max(width, height) * 0.04;
  const random = createRandom(Math.round(settings.seed));
  const text = settings.text.trim() || 'TYPE';
  const fontSize = getFontSizeToFit(
    text,
    width - safeMargin * 2,
    height - safeMargin * 2,
    settings.fontFamily,
    settings.fontWeight,
    settings.fontStyle,
    settings.letterSpacing,
  ) * settings.fontScale;

  if (settings.textLayout === 'text') {
    const image = createTextImage(text, settings.fontFamily, fontSize, settings.fontWeight, settings.fontStyle, settings.letterSpacing);
    const { grid, cols, rows } = poissonDisk(random, {
      radius: settings.radius,
      tries: 30,
      width: image.width,
      height: image.height,
      skipPoint: (point) => {
        const x = Math.floor(point.x);
        const y = Math.floor(point.y);
        const alpha = image.data[(y * image.width + x) * 4 + 3];
        return alpha === 0 || typeof alpha === 'undefined';
      },
    });
    const textLines = groupLines(grid, cols, rows, settings.grouping, settings.pointsPerLine, settings.seed);
    const xOffset = width / 2 - image.width / 2;
    const yOffset = height / 2 - image.height / 2;
    const lines = textLines.flatMap((line, lineIndex) => {
      if (line.points.length < 2) return [];
      const origin = { x: xOffset + line.points[0].x, y: yOffset + line.points[0].y };
      const beziers = (createHobbyBezier(line.points, { tension: settings.lineTension, cyclic: false }) as HobbyBezierSegment[]).map((bezier) => ({
        startControl: { x: xOffset + bezier.startControl.x, y: yOffset + bezier.startControl.y },
        endControl: { x: xOffset + bezier.endControl.x, y: yOffset + bezier.endControl.y },
        point: { x: xOffset + bezier.point.x, y: yOffset + bezier.point.y },
      }));
      const color = settings.palette[line.stripeIndex % settings.palette.length] ?? '#111111';

      return [{
        id: `text-${lineIndex}`,
        d: lineToPath(origin, beziers),
        color,
      }];
    });

    return { width, height, lines };
  }

  const letters = text.split('').map((char) => {
    const image = createTextImage(char, settings.fontFamily, fontSize, settings.fontWeight, settings.fontStyle);
    const { grid, cols, rows } = poissonDisk(random, {
      radius: settings.radius,
      tries: 30,
      width: image.width,
      height: image.height,
      skipPoint: (point) => {
        const x = Math.floor(point.x);
        const y = Math.floor(point.y);
        const alpha = image.data[(y * image.width + x) * 4 + 3];
        return alpha === 0 || typeof alpha === 'undefined';
      },
    });

    return {
      image,
      lines: groupLines(grid, cols, rows, settings.grouping, settings.pointsPerLine, settings.seed),
    };
  });
  const lettersSize = letters.reduce(
    (size, letter, index) => ({
      width: size.width + letter.image.width + (index > 0 ? settings.letterSpacing : 0),
      height: Math.max(size.height, letter.image.height),
    }),
    { width: 0, height: 0 },
  );
  const lines: SvgLine[] = [];
  let xOffset = width / 2 - lettersSize.width / 2;
  const yOffset = height / 2 - lettersSize.height / 2;

  letters.forEach((letter, letterIndex) => {
    letter.lines.forEach((line, lineIndex) => {
      if (line.points.length < 2) return;
      const origin = { x: xOffset + line.points[0].x, y: yOffset + line.points[0].y };
      const beziers = (createHobbyBezier(line.points, { tension: settings.lineTension, cyclic: false }) as HobbyBezierSegment[]).map((bezier) => ({
        startControl: { x: xOffset + bezier.startControl.x, y: yOffset + bezier.startControl.y },
        endControl: { x: xOffset + bezier.endControl.x, y: yOffset + bezier.endControl.y },
        point: { x: xOffset + bezier.point.x, y: yOffset + bezier.point.y },
      }));
      const color = settings.palette[line.stripeIndex % settings.palette.length] ?? '#111111';

      lines.push({
        id: `${letterIndex}-${lineIndex}`,
        d: lineToPath(origin, beziers),
        color,
      });
    });
    xOffset += letter.image.width + settings.letterSpacing;
  });

  return { width, height, lines };
}

function saveSvg(svgElement: SVGSVGElement | null) {
  if (!svgElement) return;
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `hobby-curves-svg-${Date.now()}.svg`;
  link.click();
  URL.revokeObjectURL(url);
}

function useStageSize() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 960, height: 720 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const update = () => {
      setSize({
        width: Math.max(320, element.clientWidth),
        height: Math.max(320, element.clientHeight),
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();

    return () => observer.disconnect();
  }, []);

  return { ref, size };
}

export default function HobbyCurvesFilledType({ textLayout = 'text' }: HobbyCurvesFilledTypeProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { ref: stageRef, size } = useStageSize();
  const [fontReady, setFontReady] = useState(false);
  const setTypographyRef = useRef<((value: { fontFamily?: string; fontVariant?: string }) => void) | null>(null);
  const [selectedFontFamilyId, setSelectedFontFamilyId] = useState(DEFAULT_FONT_FAMILY_ID);
  const selectedFontFamily = getFontFamilyById(selectedFontFamilyId);
  const defaultFont = getDefaultFontForFamily(selectedFontFamily);

  const [typography, setTypography] = useControls(
    'Typography',
    () => ({
      text: 'FORM',
      fontFamily: {
        value: selectedFontFamily.id,
        options: getFontFamilyOptions(),
        label: 'family',
        onChange: (familyId: string) => {
          const nextFamily = getFontFamilyById(familyId);
          const nextDefaultFont = getDefaultFontForFamily(nextFamily);
          setSelectedFontFamilyId(nextFamily.id);
          setTypographyRef.current?.({
            fontFamily: nextFamily.id,
            fontVariant: nextDefaultFont.value,
          });
        },
      },
      fontVariant: {
        value: defaultFont.value,
        options: getFontVariantOptions(selectedFontFamily.fonts),
        label: 'variant',
      },
      fontScale: { value: 1, min: 0.1, max: 2, step: 0.01, label: 'size' },
      letterSpacing: { value: 0, min: -80, max: 160, step: 1, label: 'spacing' },
    }),
    { collapsed: false },
    [selectedFontFamily.id],
  );
  setTypographyRef.current = setTypography;
  const selectedFont = getFontByValue(selectedFontFamily.fonts, String(typography.fontVariant), defaultFont);
  const randomness = useControls('Randomness', {
    seed: { value: 11, min: 0, max: 999999, step: 1 },
  }, { collapsed: false });
  const points = useControls('Points', {
    radius: { value: 9, min: 2, max: 52, step: 1 },
    grouping: {
      value: 'horizontal',
      options: ['horizontal', 'vertical', 'diagonal', 'flow'],
    },
    pointsPerLine: { value: DEFAULT_LINE_LENGTH, min: 2, max: 160, step: 1, label: 'line length' },
  }, { collapsed: false });
  const lines = useControls('Lines', {
    lineTension: { value: 0.85, min: 0.1, max: 1, step: 0.05, label: 'tension' },
    lineWeight: { value: 9, min: 0.5, max: 70, step: 0.5, label: 'weight' },
    strokeWidth: { value: 0.8, min: 0, max: 30, step: 0.2, label: 'outline' },
  }, { collapsed: false });
  const colors = useControls('Color', {
    background: '#ffffff',
    strokeColor: '#ffffff',
    palette: colorPalette({
      value: { source: 'original-playground', colors: [...originalPlaygroundPalette] },
      palettes: sketchPalettePresets,
    }),
  }, { collapsed: false });
  useControls({
    'Download SVG': button(() => saveSvg(svgRef.current)),
  });

  useEffect(() => {
    let cancelled = false;
    setFontReady(false);

    loadSvgFont(selectedFont).then(() => {
      if (!cancelled) setFontReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedFont]);

  const settings = useMemo<DrawSettings>(() => ({
    text: String(typography.text),
    textLayout,
    fontFamily: selectedFont.value,
    fontWeight: selectedFont.weight,
    fontStyle: selectedFont.style,
    fontScale: Number(typography.fontScale),
    letterSpacing: Number(typography.letterSpacing),
    seed: Number(randomness.seed),
    radius: Number(points.radius),
    grouping: points.grouping as PointGrouping,
    lineTension: Number(lines.lineTension),
    lineWeight: Number(lines.lineWeight),
    pointsPerLine: Number(points.pointsPerLine),
    strokeWidth: Number(lines.strokeWidth),
    strokeColor: String(colors.strokeColor),
    background: String(colors.background),
    palette: colors.palette.colors,
  }), [colors, lines, points, randomness.seed, selectedFont, textLayout, typography]);

  const scene = useMemo(
    () => (fontReady ? createSvgScene(size.width, size.height, settings) : { width: size.width, height: size.height, lines: [] }),
    [fontReady, settings, size.height, size.width],
  );

  return (
    <section className="sketch-workbench">
      <div className="sketch-stage" ref={stageRef}>
        <svg
          ref={svgRef}
          className="type-svg"
          viewBox={`0 0 ${scene.width} ${scene.height}`}
          role="img"
          aria-label="Hobby curves filled type SVG"
          style={{ background: settings.background }}
        >
          {scene.lines.map((line) => (
            <g key={line.id}>
              {settings.strokeWidth > 0 && (
                <path
                  d={line.d}
                  fill="none"
                  stroke={settings.strokeColor}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={settings.lineWeight + settings.strokeWidth * 2}
                />
              )}
              <path
                d={line.d}
                fill="none"
                stroke={line.color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={settings.lineWeight}
              />
            </g>
          ))}
        </svg>
      </div>
      <aside className="sketch-controls">
        <Leva fill flat collapsed={false} oneLineLabels={false} />
      </aside>
    </section>
  );
}
