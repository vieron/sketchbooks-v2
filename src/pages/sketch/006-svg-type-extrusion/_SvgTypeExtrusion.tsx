import { useEffect, useMemo, useRef, useState } from 'react';
import * as opentype from 'opentype.js';
import { Clipper, ClipType, FillRule } from 'clipper2-js';
import { button, folder, useControls } from 'leva';
import { SketchControls } from '../../../components/SketchControls';
import { colorPalette } from '../../../controls/colorPalettePlugin';
import { nativeNumber } from '../../../controls/nativeNumberPlugin';
import {
  getFontByValue,
  getFontFamilyById,
  getFontFamilyOptions,
  getFontVariantOptions,
  geistFonts,
} from '../../../data/fonts';
import { sketchPalettePresets } from '../../../data/palettes';
import { downloadSvg } from '../../../utils/svgDownload';
import type { Bounds, OpenTypeCommand, OpenTypeFont, OpenTypeGlyph, Point } from '../003-typographic-slicing/_types';

type OpenTypeParser = {
  parse(buffer: ArrayBuffer): unknown;
};

type TextAlignment = 'left' | 'center' | 'right' | 'poster';

type LayoutOptions = {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  rotationSpin: number;
  rotationX: number;
  rotationY: number;
  alignment: TextAlignment;
  posterOffsetX: number;
  posterOffsetY: number;
};

type GlyphLayout = {
  id: string;
  index: number;
  lineIndex: number;
  d: string;
  commands: OpenTypeCommand[];
};

type TextLayout = {
  glyphs: GlyphLayout[];
  bounds: Bounds;
};

type Contour = {
  points: Point[];
  closed: boolean;
};

type SideFace = {
  id: string;
  d: string;
  polygon: Point[];
  edgeA: Point;
  edgeB: Point;
  fill: string;
  glyphIndex: number;
  planeRank: number;
  sortKey: number;
  clipPathId?: string;
};

type FaceZone = 'outer-left' | 'inner-left' | 'inner-right' | 'outer-right' | 'outer-bottom';

type SideEdge = {
  pointIndex: number;
  a: Point;
  b: Point;
  normal: Point;
  zone: FaceZone;
  planeRank: number;
  sortKey: number;
  clipPathId?: string;
};

type GlyphClip = {
  id: string;
  d: string;
};

type RenderedSvg = {
  sideFaces: SideFace[];
  frontFaces: GlyphLayout[];
  backFaces: GlyphLayout[];
  glyphClips: GlyphClip[];
  viewBox: Bounds;
};

type RenderOptions = {
  depth: Point;
  resolution: number;
  showFront: boolean;
  showSides: boolean;
  showBack: boolean;
  visibleSurfaceOnly: boolean;
  renderInnerFaces: boolean;
  randomizeColors: boolean;
  palette: string[];
};

const DEFAULT_TEXT = 'EXTRUDE\nMY\nTEXT';
const DEFAULT_PALETTE = ['#000000', '#ff0033', '#ffb000', '#0077cc', '#00a88a', '#ff4fc3'];
const extrusionPalettePresets = [
  {
    id: 'extruded-poster',
    label: 'Extruded poster',
    colors: DEFAULT_PALETTE,
  },
  ...sketchPalettePresets,
];
const FRONT_COLOR = '#000000';
const BACK_COLOR = '#ffb000';
const BACK_OPACITY = 0.32;
const VIEWBOX_PADDING = 42;
const MAX_EXTRUSION_DEPTH = 240;
const STABLE_VIEWBOX_PADDING = VIEWBOX_PADDING + MAX_EXTRUSION_DEPTH;
const MIN_BOUNDS_SIZE = 1;
const CLIPPER_SCALE = 1000;
const LOWER_PLANE_NORMAL_THRESHOLD = 0.999;
const UNDERSIDE_EDGE_SLOPE = 0.001;
const UNDERSIDE_BAND_RATIO = 0.08;
const UNDERSIDE_MIN_EDGE_RATIO = 0.18;
const MAX_LETTER_ROTATION_DEGREES = 16;
const MAX_LETTER_AXIS_TILT_DEGREES = 14;

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

function pointFromGlyph(rawX: number, rawY: number, x: number, y: number, scale: number): Point {
  return { x: x + rawX * scale, y: y - rawY * scale };
}

function rotatePoint(point: Point, center: Point, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;

  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

function transformPoint(point: Point, center: Point, spin: number, shearX: number, shearY: number): Point {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const sheared = {
    x: center.x + dx + dy * shearX,
    y: center.y + dy + dx * shearY,
  };

  return rotatePoint(sheared, center, spin);
}

function transformCommand(command: OpenTypeCommand, center: Point, spin: number, shearX: number, shearY: number): OpenTypeCommand {
  if (command.type === 'Z') return command;
  const point = transformPoint(command, center, spin, shearX, shearY);
  if (command.type === 'M' || command.type === 'L') return { ...command, ...point };
  if (command.type === 'Q') {
    const control = transformPoint({ x: command.x1, y: command.y1 }, center, spin, shearX, shearY);
    return { ...command, ...point, x1: control.x, y1: control.y };
  }

  if (command.type === 'C') {
    const controlA = transformPoint({ x: command.x1, y: command.y1 }, center, spin, shearX, shearY);
    const controlB = transformPoint({ x: command.x2, y: command.y2 }, center, spin, shearX, shearY);
    return { ...command, ...point, x1: controlA.x, y1: controlA.y, x2: controlB.x, y2: controlB.y };
  }

  return command;
}

function transformCommands(commands: OpenTypeCommand[], spin: number, shearX: number, shearY: number) {
  if (Math.abs(spin) < 0.0001 && Math.abs(shearX) < 0.0001 && Math.abs(shearY) < 0.0001) return commands;
  const bounds = commandBounds(commands);
  const center = {
    x: (bounds.x1 + bounds.x2) / 2,
    y: (bounds.y1 + bounds.y2) / 2,
  };

  return commands.map((command) => transformCommand(command, center, spin, shearX, shearY));
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

function glyphToCommands(glyph: OpenTypeGlyph, x: number, y: number, scale: number) {
  return (glyph.path?.commands ?? []).map((command): OpenTypeCommand => {
    if (command.type === 'M' || command.type === 'L') return { type: command.type, ...pointFromGlyph(command.x, command.y, x, y, scale) };
    if (command.type === 'Q') {
      return {
        type: 'Q',
        ...pointFromGlyph(command.x, command.y, x, y, scale),
        x1: pointFromGlyph(command.x1, command.y1, x, y, scale).x,
        y1: pointFromGlyph(command.x1, command.y1, x, y, scale).y,
      };
    }

    if (command.type === 'C') {
      return {
        type: 'C',
        ...pointFromGlyph(command.x, command.y, x, y, scale),
        x1: pointFromGlyph(command.x1, command.y1, x, y, scale).x,
        y1: pointFromGlyph(command.x1, command.y1, x, y, scale).y,
        x2: pointFromGlyph(command.x2, command.y2, x, y, scale).x,
        y2: pointFromGlyph(command.x2, command.y2, x, y, scale).y,
      };
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

export function layoutText(font: OpenTypeFont, text: string, options: LayoutOptions): TextLayout {
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
    const centeredStagger = lineIndex - (lines.length - 1) / 2;
    const alternatingNudge = lineIndex % 2 === 0 ? -0.18 : 0.18;
    const posterX = options.alignment === 'poster'
      ? centeredStagger * options.posterOffsetX + alternatingNudge * Math.abs(options.posterOffsetX)
      : 0;
    const posterY = options.alignment === 'poster' ? lineIndex * options.posterOffsetY : 0;
    const alignX = options.alignment === 'center'
      ? (maxLineWidth - line.width) / 2
      : options.alignment === 'right'
        ? maxLineWidth - line.width
        : 0;
    let cursor = posterX + alignX;

    return line.glyphs.map((glyph, glyphIndex) => {
      const previousGlyph = line.glyphs[glyphIndex - 1];
      if (previousGlyph && font.getKerningValue) cursor += font.getKerningValue(previousGlyph, glyph) * scale;

      const transformSeed = (lineIndex + 1) * 971 + (glyphIndex + 1) * 577 + glyph.index * 0.37;
      const spinRatio = Math.max(0, Math.min(1, Number(options.rotationSpin)));
      const xRatio = Math.max(0, Math.min(1, Number(options.rotationX)));
      const yRatio = Math.max(0, Math.min(1, Number(options.rotationY)));
      const spinAngle = (seededUnit(transformSeed) * 2 - 1)
        * spinRatio
        * MAX_LETTER_ROTATION_DEGREES
        * (Math.PI / 180);
      const shearX = Math.tan((seededUnit(transformSeed + 19) * 2 - 1) * xRatio * MAX_LETTER_AXIS_TILT_DEGREES * (Math.PI / 180));
      const shearY = Math.tan((seededUnit(transformSeed + 43) * 2 - 1) * yRatio * MAX_LETTER_AXIS_TILT_DEGREES * (Math.PI / 180));
      const commands = transformCommands(
        glyphToCommands(glyph, cursor, lineIndex * baselineStep + posterY, scale),
        spinAngle,
        shearX,
        shearY,
      );
      commands.forEach((command) => includeCommand(bounds, command));

      const layoutGlyph = {
        id: `glyph-${lineIndex}-${glyphIndex}-${glyph.index}`,
        index: glyphIndex,
        lineIndex,
        d: commandsToPath(commands),
        commands,
      };

      cursor += glyph.advanceWidth * scale;
      if (glyphIndex < line.glyphs.length - 1) cursor += options.letterSpacing;
      return layoutGlyph;
    }).filter((glyph) => glyph.d.length > 0);
  });

  if (!Number.isFinite(bounds.x1)) {
    includePoint(bounds, { x: 0, y: 0 });
    includePoint(bounds, { x: Math.max(options.fontSize, MIN_BOUNDS_SIZE), y: Math.max(options.fontSize, MIN_BOUNDS_SIZE) });
  }

  return { glyphs, bounds };
}

function lerp(left: number, right: number, t: number) {
  return left + (right - left) * t;
}

export function flattenQuadratic(start: Point, control: Point, end: Point, resolution: number) {
  const points: Point[] = [];
  for (let index = 1; index <= resolution; index += 1) {
    const t = index / resolution;
    const mt = 1 - t;
    points.push({
      x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
      y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
    });
  }
  return points;
}

export function flattenCubic(start: Point, controlA: Point, controlB: Point, end: Point, resolution: number) {
  const points: Point[] = [];
  for (let index = 1; index <= resolution; index += 1) {
    const t = index / resolution;
    const a = { x: lerp(start.x, controlA.x, t), y: lerp(start.y, controlA.y, t) };
    const b = { x: lerp(controlA.x, controlB.x, t), y: lerp(controlA.y, controlB.y, t) };
    const c = { x: lerp(controlB.x, end.x, t), y: lerp(controlB.y, end.y, t) };
    const d = { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    const e = { x: lerp(b.x, c.x, t), y: lerp(b.y, c.y, t) };
    points.push({ x: lerp(d.x, e.x, t), y: lerp(d.y, e.y, t) });
  }
  return points;
}

function pushPoint(contour: Point[], point: Point) {
  const previous = contour[contour.length - 1];
  if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 0.001) {
    contour.push(point);
  }
}

export function pathToContours(commands: OpenTypeCommand[], resolution: number): Contour[] {
  const contours: Contour[] = [];
  let points: Point[] = [];
  let current: Point | null = null;
  let start: Point | null = null;
  const segmentCount = Math.max(1, Math.round(resolution));

  function finish(closed: boolean) {
    if (points.length > 1) contours.push({ points, closed });
    points = [];
    current = null;
    start = null;
  }

  for (const command of commands) {
    if (command.type === 'M') {
      if (points.length > 1) finish(false);
      current = { x: command.x, y: command.y };
      start = current;
      points = [current];
      continue;
    }

    if (!current || !start) continue;

    if (command.type === 'L') {
      current = { x: command.x, y: command.y };
      pushPoint(points, current);
      continue;
    }

    if (command.type === 'Q') {
      flattenQuadratic(current, { x: command.x1, y: command.y1 }, { x: command.x, y: command.y }, segmentCount)
        .forEach((point) => pushPoint(points, point));
      current = { x: command.x, y: command.y };
      continue;
    }

    if (command.type === 'C') {
      flattenCubic(
        current,
        { x: command.x1, y: command.y1 },
        { x: command.x2, y: command.y2 },
        { x: command.x, y: command.y },
        segmentCount,
      ).forEach((point) => pushPoint(points, point));
      current = { x: command.x, y: command.y };
      continue;
    }

    pushPoint(points, start);
    if (points.length > 1) points = points.slice(0, -1);
    finish(true);
  }

  if (points.length > 1) finish(false);
  return contours;
}

export function makeSideFace(a: Point, b: Point, depth: Point) {
  return polygonToPath(makeSideFacePolygon(a, b, depth));
}

function makeSideFacePolygon(a: Point, b: Point, depth: Point) {
  return [
    a,
    b,
    { x: b.x + depth.x, y: b.y + depth.y },
    { x: a.x + depth.x, y: a.y + depth.y },
  ];
}

function polygonToPath(points: Point[]) {
  if (points.length === 0) return '';
  return `M${points.map(pointToPath).join('L')}Z`;
}

function contourToPath(points: Point[]) {
  return polygonToPath(points);
}

function contourSignedArea(points: Point[]) {
  return points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return next ? area + point.x * next.y - point.y * next.x : area;
  }, 0) / 2;
}

function contourBounds(points: Point[]) {
  return points.reduce<Bounds>((bounds, point) => {
    includePoint(bounds, point);
    return bounds;
  }, emptyBounds());
}

function containsBounds(outer: Bounds, inner: Bounds) {
  return outer.x1 <= inner.x1 && outer.y1 <= inner.y1 && outer.x2 >= inner.x2 && outer.y2 >= inner.y2;
}

function windingContribution(points: Point[], point: Point) {
  let winding = 0;

  points.forEach((current, index) => {
    const next = points[(index + 1) % points.length];
    if (!next) return;

    const isLeft = (next.x - current.x) * (point.y - current.y) - (point.x - current.x) * (next.y - current.y);
    if (current.y <= point.y) {
      if (next.y > point.y && isLeft > 0) winding += 1;
    } else if (next.y <= point.y && isLeft < 0) {
      winding -= 1;
    }
  });

  return winding;
}

function pointInGlyphFill(contours: Contour[], point: Point) {
  return contours.reduce((winding, contour) => winding + windingContribution(contour.points, point), 0) !== 0;
}

function edgeNormal(a: Point, b: Point, contourArea = 0) {
  const edge = { x: b.x - a.x, y: b.y - a.y };

  // SVG uses screen coordinates: y grows downward. Positive signed area is a
  // clockwise contour, whose interior is on the edge's screen-right side.
  // The visible side decision needs the outward normal, so contour winding
  // decides which perpendicular points away from the glyph.
  return contourArea >= 0
    ? { x: edge.y, y: -edge.x }
    : { x: -edge.y, y: edge.x };
}

export function isVisibleEdge(a: Point, b: Point, depth: Point, contourArea = 0) {
  const normal = edgeNormal(a, b, contourArea);
  return normal.x * depth.x + normal.y * depth.y > 0.001;
}

function seededVariation(seed: number, size: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return Math.floor(Math.abs(value - Math.floor(value)) * size);
}

function seededUnit(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return Math.abs(value - Math.floor(value));
}

function frontColor(palette = DEFAULT_PALETTE) {
  return palette[0] ?? FRONT_COLOR;
}

function extrusionColors(palette = DEFAULT_PALETTE) {
  const colors = palette.length > 1 ? palette.slice(1) : DEFAULT_PALETTE.slice(1);
  return colors.length > 0 ? colors : [BACK_COLOR];
}

function colorForGlyph(glyph: GlyphLayout, palette = DEFAULT_PALETTE) {
  const colors = extrusionColors(palette);
  return colors[seededVariation((glyph.lineIndex + 1) * 91 + (glyph.index + 1) * 17, colors.length)] ?? BACK_COLOR;
}

function isLowerSideFace(a: Point, b: Point, normal: Point, depth: Point, bounds?: Bounds) {
  const edge = { x: b.x - a.x, y: b.y - a.y };
  const length = Math.max(0.001, Math.hypot(normal.x, normal.y));
  const unitNormal = { x: normal.x / length, y: normal.y / length };
  const edgeMidpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const edgeLength = Math.hypot(edge.x, edge.y);
  const nearHorizontalEdge = Math.abs(edge.y) <= Math.max(1, Math.abs(edge.x) * UNDERSIDE_EDGE_SLOPE);
  const minEdgeLength = bounds ? Math.max(10, (bounds.x2 - bounds.x1) * UNDERSIDE_MIN_EDGE_RATIO) : 10;
  const longEnough = edgeLength >= minEdgeLength;
  const lowerBandSize = bounds
    ? Math.max(4, Math.min(Math.abs(depth.y) * UNDERSIDE_BAND_RATIO, Math.max(4, (bounds.y2 - bounds.y1) * 0.18)))
    : Infinity;
  const inLowerBand = !bounds || (depth.y >= 0
    ? edgeMidpoint.y >= bounds.y2 - lowerBandSize
    : edgeMidpoint.y <= bounds.y1 + lowerBandSize);

  return nearHorizontalEdge && longEnough && inLowerBand && (depth.y >= 0
    ? unitNormal.y > LOWER_PLANE_NORMAL_THRESHOLD
    : unitNormal.y < -LOWER_PLANE_NORMAL_THRESHOLD);
}

export function colorForEdge(a: Point, b: Point, normal: Point, depth: Point, palette = DEFAULT_PALETTE, seed = 0, bounds?: Bounds) {
  const colors = extrusionColors(palette);
  const planeSeed = isLowerSideFace(a, b, normal, depth, bounds) ? 101 : 503;
  const faceSeed = seed + planeSeed;

  return colors[seededVariation(faceSeed, colors.length)] ?? colors[0] ?? BACK_COLOR;
}

function colorForFaceZone(glyphIndex: number, contourIndex: number, zone: FaceZone, isHoleContour: boolean, palette = DEFAULT_PALETTE) {
  const colors = extrusionColors(palette);
  const zoneSeed: Record<FaceZone, number> = {
    'outer-left': 17,
    'inner-left': 131,
    'inner-right': 269,
    'outer-right': 421,
    'outer-bottom': 587,
  };
  const seed = (glyphIndex + 1) * 1009
    + (contourIndex + 1) * 313
    + zoneSeed[zone]
    + (isHoleContour ? 719 : 0);

  return colors[seededVariation(seed, colors.length)] ?? colors[0] ?? BACK_COLOR;
}

function edgeFaceZone(a: Point, b: Point, normal: Point, bounds: Bounds): FaceZone {
  const length = Math.max(0.001, Math.hypot(normal.x, normal.y));
  const unitNormal = { x: normal.x / length, y: normal.y / length };
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const centerX = (bounds.x1 + bounds.x2) / 2;
  const bottomBand = Math.max(10, (bounds.y2 - bounds.y1) * 0.18);
  const isBottom = midpoint.y >= bounds.y2 - bottomBand && unitNormal.y > 0.2;

  if (isBottom) return 'outer-bottom';
  if (midpoint.x < centerX) return unitNormal.x < 0 ? 'outer-left' : 'inner-left';
  return unitNormal.x < 0 ? 'inner-right' : 'outer-right';
}

function sideFacePlaneRank(a: Point, b: Point, normal: Point, depth: Point, bounds?: Bounds) {
  // Horizontal/lower extrusion planes are visually behind the side walls in
  // this poster-style projection, so side walls must occlude them.
  return isLowerSideFace(a, b, normal, depth, bounds) ? 0 : 1;
}

function sideFaceSortKey(a: Point, b: Point, normal: Point, depth: Point, isHoleContour: boolean) {
  const edge = { x: b.x - a.x, y: b.y - a.y };
  const length = Math.max(0.001, Math.hypot(normal.x, normal.y));
  const unitNormal = { x: normal.x / length, y: normal.y / length };
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const depthLength = Math.max(0.001, Math.hypot(depth.x, depth.y));
  const depthProjection = (midpoint.x * depth.x + midpoint.y * depth.y) / depthLength;
  const verticalBias = Math.abs(edge.y) > Math.abs(edge.x) ? 0.2 : 0;
  const normalBias = Math.abs(unitNormal.x) > Math.abs(unitNormal.y) ? 0.1 : 0;

  // Paint side planes from deeper/back positions toward nearer/front positions.
  // This avoids hard-coded "bottom face last" ordering, which creates colored
  // overlaps in concave glyphs such as E and T.
  return (isHoleContour ? -10000 : 0) - depthProjection + verticalBias + normalBias;
}

function toClipperPath(points: Point[]) {
  return points.map((point) => ({
    x: Math.round(point.x * CLIPPER_SCALE),
    y: Math.round(point.y * CLIPPER_SCALE),
  }));
}

function fromClipperPoint(point: { x: number; y: number }): Point {
  return {
    x: point.x / CLIPPER_SCALE,
    y: point.y / CLIPPER_SCALE,
  };
}

function pathsToSvgPath(paths: Array<Array<{ x: number; y: number }>>) {
  return paths
    .map((path) => polygonToPath(path.map(fromClipperPoint)))
    .filter(Boolean)
    .join('');
}

function unionPaths(paths: Array<Array<{ x: number; y: number }>>) {
  return paths.length > 0
    ? Clipper.BooleanOp(ClipType.Union, paths, [], FillRule.NonZero)
    : [];
}

function cross(left: Point, right: Point) {
  return left.x * right.y - left.y * right.x;
}

function clipperPathCentroid(path: Array<{ x: number; y: number }>) {
  const total = path.reduce((sum, point) => ({
    x: sum.x + point.x,
    y: sum.y + point.y,
  }), { x: 0, y: 0 });

  return {
    x: total.x / Math.max(1, path.length) / CLIPPER_SCALE,
    y: total.y / Math.max(1, path.length) / CLIPPER_SCALE,
  };
}

function sideFaceDepthAtPoint(face: SideFace, point: Point, depth: Point) {
  const edge = {
    x: face.edgeB.x - face.edgeA.x,
    y: face.edgeB.y - face.edgeA.y,
  };
  const denominator = cross(depth, edge);
  if (Math.abs(denominator) < 0.0001) return 0;

  return cross({ x: point.x - face.edgeA.x, y: point.y - face.edgeA.y }, edge) / denominator;
}

function clippedSideFacesByDepth(faces: SideFace[], depth: Point) {
  const counterFaces = faces.filter((face) => face.clipPathId);
  const exteriorFaces = faces.filter((face) => !face.clipPathId);
  const clipperPolygons = new Map(exteriorFaces.map((face) => [face.id, toClipperPath(face.polygon)]));

  return [
    ...counterFaces,
    ...exteriorFaces.map((face) => {
      let paths = [clipperPolygons.get(face.id)].filter(Boolean) as Array<Array<{ x: number; y: number }>>;
      const occluders: Array<Array<{ x: number; y: number }>> = [];

      exteriorFaces.forEach((candidate) => {
        if (candidate.id === face.id) return;

        const candidatePath = clipperPolygons.get(candidate.id);
        const facePath = clipperPolygons.get(face.id);
        if (!candidatePath || !facePath) return;

        const intersection = Clipper.BooleanOp(ClipType.Intersection, [facePath], [candidatePath], FillRule.NonZero);
        const samplePath = intersection.find((path) => path.length > 0);
        if (!samplePath) return;

        const samplePoint = clipperPathCentroid(samplePath);
        const faceDepth = sideFaceDepthAtPoint(face, samplePoint, depth);
        const candidateDepth = sideFaceDepthAtPoint(candidate, samplePoint, depth);

        if (candidateDepth < faceDepth - 0.001) {
          occluders.push(candidatePath);
        }
      });

      if (occluders.length > 0) {
        paths = Clipper.BooleanOp(ClipType.Difference, paths, unionPaths(occluders), FillRule.NonZero);
      }

      return {
        ...face,
        d: pathsToSvgPath(paths),
      };
    }).filter((face) => face.d),
  ];
}

export function renderSvg(layout: TextLayout, options: RenderOptions): RenderedSvg {
  const bounds = emptyBounds();
  layout.glyphs.forEach((glyph) => glyph.commands.forEach((command) => includeCommand(bounds, command)));
  const sideFaces: SideFace[] = [];
  const glyphClips: GlyphClip[] = [];

  layout.glyphs.forEach((glyph, glyphIndex) => {
    const contours = pathToContours(glyph.commands, options.resolution).map((contour) => ({
      ...contour,
      bounds: contourBounds(contour.points),
    }));
    const contourMeta = contours.map((contour, contourIndex) => ({
      isHole: contours.some((candidate, candidateIndex) => (
        candidateIndex !== contourIndex && containsBounds(candidate.bounds, contour.bounds)
      )),
      clipPathId: `${glyph.id}-hole-${contourIndex}-clip`,
    }));

    contours.forEach((contour, contourIndex) => {
      const meta = contourMeta[contourIndex];
      if (meta?.isHole) {
        glyphClips.push({ id: meta.clipPathId, d: contourToPath(contour.points) });
      }
    });

    contours.forEach((contour, contourIndex) => {
      const edgeCount = contour.closed ? contour.points.length : contour.points.length - 1;
      const contourArea = contour.closed ? contourSignedArea(contour.points) : -1;
      const isHoleContour = Boolean(contourMeta[contourIndex]?.isHole);
      const clipPathId = contourMeta[contourIndex]?.clipPathId;
      const visibleEdges: SideEdge[] = [];
      if (isHoleContour && !options.renderInnerFaces) return;

      for (let pointIndex = 0; pointIndex < edgeCount; pointIndex += 1) {
        const a = contour.points[pointIndex];
        const b = contour.points[(pointIndex + 1) % contour.points.length];
        if (!a || !b) continue;
        const normal = edgeNormal(a, b, contourArea);
        const normalLength = Math.max(0.001, Math.hypot(normal.x, normal.y));
        const edgeMidpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const outsideSample = {
          x: edgeMidpoint.x + (normal.x / normalLength) * 0.75,
          y: edgeMidpoint.y + (normal.y / normalLength) * 0.75,
        };
        if (!isHoleContour && pointInGlyphFill(contours, outsideSample)) continue;
        if (!isHoleContour && options.visibleSurfaceOnly && !isVisibleEdge(a, b, options.depth, contourArea)) continue;

        const planeRank = sideFacePlaneRank(a, b, normal, options.depth, contour.bounds);
        visibleEdges.push({
          pointIndex,
          a,
          b,
          normal,
          zone: edgeFaceZone(a, b, normal, contour.bounds),
          planeRank,
          sortKey: sideFaceSortKey(a, b, normal, options.depth, isHoleContour),
          clipPathId: isHoleContour ? clipPathId : undefined,
        });
      }

      visibleEdges.forEach((edge) => {
        const runColor = colorForFaceZone(glyphIndex, contourIndex, edge.zone, isHoleContour, options.palette);
        sideFaces.push({
          id: `${glyph.id}-side-${contourIndex}-${edge.pointIndex}`,
          d: makeSideFace(edge.a, edge.b, options.depth),
          polygon: makeSideFacePolygon(edge.a, edge.b, options.depth),
          edgeA: edge.a,
          edgeB: edge.b,
          fill: runColor,
          glyphIndex,
          planeRank: edge.planeRank,
          sortKey: edge.sortKey,
          clipPathId: edge.clipPathId,
        });
      });
    });
  });
  sideFaces.sort((left, right) => {
    const glyphOrder = options.depth.x < 0
      ? left.glyphIndex - right.glyphIndex
      : right.glyphIndex - left.glyphIndex;

    return left.planeRank - right.planeRank || glyphOrder || left.sortKey - right.sortKey;
  });
  const visibleSideFaces = clippedSideFacesByDepth(sideFaces, options.depth);

  return {
    sideFaces: options.showSides ? visibleSideFaces : [],
    frontFaces: options.showFront ? layout.glyphs : [],
    backFaces: options.showBack ? layout.glyphs : [],
    glyphClips,
    viewBox: padBounds(bounds, STABLE_VIEWBOX_PADDING),
  };
}

function useOpenTypeFont(url: string) {
  const [font, setFont] = useState<OpenTypeFont | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setFont(null);
    setError('');

    async function loadFont() {
      try {
        const buffer = await fetch(url, { signal: controller.signal }).then((response) => {
          if (!response.ok) throw new Error(`Font request failed with ${response.status}`);
          return response.arrayBuffer();
        });
        setFont((opentype as OpenTypeParser).parse(buffer) as OpenTypeFont);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load font');
        }
      }
    }

    void loadFont();
    return () => controller.abort();
  }, [url]);

  return { font, error };
}

export default function SvgTypeExtrusion() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const defaultFamily = getFontFamilyById('geist');
  const [selectedFontFamilyId, setSelectedFontFamilyId] = useState(defaultFamily.id);
  const selectedFontFamily = getFontFamilyById(selectedFontFamilyId);
  const [selectedFontValue, setSelectedFontValue] = useState(
    geistFonts.find((font) => font.variant === 'Black')?.value ?? selectedFontFamily.defaultFont.value,
  );
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
          setSelectedFontValue(nextFamily.defaultFont.value);
        },
      },
      fontVariant: {
        value: selectedFont.value,
        options: getFontVariantOptions(selectedFontFamily.fonts),
        label: 'variant',
        onChange: (value: string) => {
          setSelectedFontValue(value);
        },
      },
      text: { value: DEFAULT_TEXT, rows: 4, label: 'text' },
      fontSize: { ...nativeNumber({ current: 220, min: 36, max: 520, step: 1 }), label: 'font size' },
      lineHeight: { ...nativeNumber({ current: 1.01, min: 0.45, max: 1.5, step: 0.01 }), label: 'line height' },
      letterSpacing: { ...nativeNumber({ current: 0, min: -40, max: 180, step: 0.5 }), label: 'letter spacing' },
      alignment: {
        value: 'left',
        options: ['left', 'center', 'right', 'poster'],
        label: 'alignment',
      },
    },
    { collapsed: false },
    [selectedFontFamily.id, selectedFont.value],
  );

  const rotation = useControls('Rotation', {
    spin: { ...nativeNumber({ current: 0, min: 0, max: 1, step: 0.01 }), label: 'spin' },
    xAxis: { ...nativeNumber({ current: 0, min: 0, max: 1, step: 0.01 }), label: 'x axis' },
    yAxis: { ...nativeNumber({ current: 0, min: 0, max: 1, step: 0.01 }), label: 'y axis' },
  }, { collapsed: false });

  const extrusion = useControls('Extrusion', {
    depthX: { ...nativeNumber({ current: -36, min: -MAX_EXTRUSION_DEPTH, max: MAX_EXTRUSION_DEPTH, step: 1 }), label: 'depth x' },
    depthY: { ...nativeNumber({ current: 27, min: -MAX_EXTRUSION_DEPTH, max: MAX_EXTRUSION_DEPTH, step: 1 }), label: 'depth y' },
    resolution: { ...nativeNumber({ current: 20, min: 2, max: 32, step: 1 }), label: 'flattening' },
    visibleSurfaceOnly: { value: true, label: 'visible sides' },
    renderInnerFaces: { value: true, label: 'inner faces' },
  }, { collapsed: false });

  const drawing = useControls('Drawing', {
    showFront: { value: true, label: 'front face' },
    showSides: { value: true, label: 'side faces' },
    showBack: { value: false, label: 'back face' },
    posterOffsetX: { ...nativeNumber({ current: -56, min: -180, max: 180, step: 1 }), label: 'line x' },
    posterOffsetY: { ...nativeNumber({ current: -16, min: -120, max: 120, step: 1 }), label: 'line y' },
    randomizeColors: { value: false, label: 'glyph variation' },
    debugStroke: { value: false, label: 'debug stroke' },
    Color: folder({
      background: '#ffffff',
      sidePalette: colorPalette({
        value: { source: 'extruded-poster', colors: DEFAULT_PALETTE },
        palettes: extrusionPalettePresets,
      }),
    }, { collapsed: false }),
  }, { collapsed: false });

  useControls({
    'Download SVG': button(() => downloadSvg(svgRef.current, 'extruded-type.svg', { horizontalPaddingRatio: 0 })),
  });

  const { font, error } = useOpenTypeFont(selectedFont.url);
  const inputText = String(typography.text);
  const depth = {
    x: Number(extrusion.depthX),
    y: Number(extrusion.depthY),
  };
  const layout = useMemo(() => {
    if (!font) return null;
    return layoutText(font, inputText, {
      fontSize: Number(typography.fontSize),
      lineHeight: Number(typography.lineHeight),
      letterSpacing: Number(typography.letterSpacing),
      rotationSpin: Number(rotation.spin),
      rotationX: Number(rotation.xAxis),
      rotationY: Number(rotation.yAxis),
      alignment: typography.alignment as TextAlignment,
      posterOffsetX: Number(drawing.posterOffsetX),
      posterOffsetY: Number(drawing.posterOffsetY),
    });
  }, [drawing.posterOffsetX, drawing.posterOffsetY, font, inputText, rotation.spin, rotation.xAxis, rotation.yAxis, typography.alignment, typography.fontSize, typography.letterSpacing, typography.lineHeight]);
  const activePalette = drawing.sidePalette.colors?.length
    ? drawing.sidePalette.colors
    : DEFAULT_PALETTE;

  const rendered = useMemo(() => {
    if (!layout) return null;
    return renderSvg(layout, {
      depth,
      resolution: Number(extrusion.resolution),
      showFront: Boolean(drawing.showFront),
      showSides: Boolean(drawing.showSides),
      showBack: Boolean(drawing.showBack),
      visibleSurfaceOnly: Boolean(extrusion.visibleSurfaceOnly),
      renderInnerFaces: Boolean(extrusion.renderInnerFaces),
      randomizeColors: Boolean(drawing.randomizeColors),
      palette: activePalette,
    });
  }, [activePalette, depth.x, depth.y, drawing.debugStroke, drawing.randomizeColors, drawing.showBack, drawing.showFront, drawing.showSides, extrusion.renderInnerFaces, extrusion.resolution, extrusion.visibleSurfaceOnly, layout]);

  if (error) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Font failed to load: {error}</div>
        <SketchControls fill flat />
      </section>
    );
  }

  if (!font || !rendered) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Loading font...</div>
        <SketchControls fill flat />
      </section>
    );
  }

  const depthTransform = `translate(${round(depth.x)} ${round(depth.y)})`;
  const strokeProps = drawing.debugStroke
    ? { stroke: '#ffffff', strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' as const }
    : {};

  return (
    <section className="sketch-workbench svg-type-extrusion">
      <div className="sketch-stage extrusion-stage">
        <svg
          ref={svgRef}
          className="type-svg extrusion-svg"
          viewBox={boundsToViewBox(rendered.viewBox)}
          role="img"
          aria-label={`${inputText} rendered as SVG extruded typography`}
          style={{ backgroundColor: String(drawing.background) }}
          shapeRendering="geometricPrecision"
        >
          {rendered.glyphClips.length > 0 && (
            <defs>
              {rendered.glyphClips.map((clip) => (
                <clipPath key={clip.id} id={clip.id} clipPathUnits="userSpaceOnUse">
                  <path d={clip.d} />
                </clipPath>
              ))}
            </defs>
          )}
          <rect x={rendered.viewBox.x1} y={rendered.viewBox.y1} width={rendered.viewBox.x2 - rendered.viewBox.x1} height={rendered.viewBox.y2 - rendered.viewBox.y1} fill={String(drawing.background)} />
          <g className="extruded-text">
            <g className="back-faces" transform={depthTransform} opacity={BACK_OPACITY}>
              {rendered.backFaces.map((glyph, index) => (
                <path
                  key={`${glyph.id}-back`}
                  className="back-face"
                  data-glyph-index={index}
                  data-line-index={glyph.lineIndex}
                  d={glyph.d}
                  fill={colorForGlyph(glyph, activePalette)}
                  fillRule="evenodd"
                />
              ))}
            </g>
            <g className="side-faces" data-depth-x={round(depth.x)} data-depth-y={round(depth.y)}>
              {rendered.sideFaces.map((face) => (
                <path
                  key={face.id}
                  className="side-face"
                  data-glyph-index={face.glyphIndex}
                  d={face.d}
                  fill={face.fill}
                  clipPath={face.clipPathId ? `url(#${face.clipPathId})` : undefined}
                  {...strokeProps}
                />
              ))}
            </g>
            <g className="front-faces">
              {rendered.frontFaces.map((glyph, index) => (
                <path
                  key={glyph.id}
                  className="front-face"
                  data-glyph-index={index}
                  data-line-index={glyph.lineIndex}
                  d={glyph.d}
                  fill={frontColor(activePalette)}
                  fillRule="evenodd"
                  {...strokeProps}
                />
              ))}
            </g>
          </g>
        </svg>
      </div>
      <SketchControls fill flat collapsed={false} oneLineLabels={false} />
    </section>
  );
}
