import { useEffect, useMemo, useRef, useState } from "react";
import * as opentype from "opentype.js";
import { button, folder, useControls } from "leva";
import { SketchControls } from "../../../components/SketchControls";
import { colorPalette } from "../../../controls/colorPalettePlugin";
import { nativeNumber } from "../../../controls/nativeNumberPlugin";
import {
  getFontByValue,
  getFontFamilyById,
  getFontFamilyOptions,
  getFontVariantOptions,
} from "../../../data/fonts";
import { getPaletteById, getPaletteToneColors, sketchPalettePresets } from "../../../data/palettes";
import { downloadSvg } from "../../../utils/svgDownload";
import type {
  Bounds,
  OpenTypeCommand,
  OpenTypeFont,
  OpenTypeGlyph,
  Point,
} from "../_type/_types";

type OpenTypeParser = {
  parse(buffer: ArrayBuffer): unknown;
};

type TextAlignment = "left" | "center" | "right" | "poster";

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
  fontSize: number;
};

type Contour = {
  points: Point[];
  closed: boolean;
};

type Point3D = {
  x: number;
  y: number;
  z: number;
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
  zone?: FaceZone;
  edgeIndex?: number;
  segmentIndex?: number;
  clipPathId?: string;
};

type FaceZone =
  | "outer-left"
  | "inner-left"
  | "inner-right"
  | "outer-right"
  | "outer-bottom";

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

type SideEdgeRun = {
  index: number;
  zone: FaceZone;
  edges: SideEdge[];
};

type GlyphClip = {
  id: string;
  d: string;
};

type RenderFace = {
  id: string;
  kind: "back" | "side" | "front";
  d: string;
  fill: string;
  glyphIndex: number;
  lineIndex: number;
  sortZ: number;
  polygons: Point[][];
  opacity?: number;
  zone?: FaceZone;
  edgeIndex?: number;
  segmentIndex?: number;
  visibilityScore?: number;
};

type RenderFaceGroup = {
  id: string;
  glyphIndex: number;
  lineIndex: number;
  sortX: number;
  sortZ: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  faces: RenderFace[];
};

type RenderedSvg = {
  sideFaces: SideFace[];
  frontFaces: GlyphLayout[];
  backFaces: GlyphLayout[];
  glyphClips: GlyphClip[];
  orderedFaces: RenderFace[];
  orderedFaceGroups: RenderFaceGroup[];
  viewBox: Bounds;
};

type PlaneOptions = {
  seed: number;
  baseRotateX: number;
  baseRotateY: number;
  baseRotateZ: number;
  randomRotateX: number;
  randomRotateY: number;
  randomRotateZ: number;
  depth: number;
  randomDepth: boolean;
  minDepth: number;
  maxDepth: number;
  depthScale: number;
  perspective: number;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
};

type RenderOptions = {
  plane: PlaneOptions;
  resolution: number;
  showFront: boolean;
  showSides: boolean;
  showBack: boolean;
  visibleSurfaceOnly: boolean;
  renderInnerFaces: boolean;
  randomizeColors: boolean;
  palette: string[];
};

const DEFAULT_TEXT = "EXTRUDE\nMY TYPE";
const DEFAULT_FONT_FAMILY_ID = "geist";
const DEFAULT_FONT_VALUE = "geist-black";
const DEFAULT_PALETTE_PRESET = getPaletteById("signal");
const DEFAULT_PALETTE = DEFAULT_PALETTE_PRESET.colors;
const DEFAULT_TONES = getPaletteToneColors(DEFAULT_PALETTE);
const FRONT_COLOR = DEFAULT_TONES.ink;
const BACK_COLOR = DEFAULT_PALETTE[3] ?? DEFAULT_TONES.paper;
const BACK_OPACITY = 0.32;
const VIEWBOX_PADDING = 42;
const MAX_EXTRUSION_DEPTH = 240;
const MIN_BOUNDS_SIZE = 1;
const DEFAULT_FONT_SIZE = 39;
const DEFAULT_FLATTENING_RESOLUTION = 20;
const DEFAULT_POSTER_OFFSET_X = -56;
const DEFAULT_POSTER_OFFSET_Y = -16;
const FACE_RUN_MIN_DOT = Math.cos(Math.PI / 6);
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
  if (command.type === "Z") return;
  if (command.type === "Q")
    includePoint(bounds, { x: command.x1, y: command.y1 });
  if (command.type === "C") {
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
    return {
      x1: -padding,
      y1: -padding,
      x2: padding + MIN_BOUNDS_SIZE,
      y2: padding + MIN_BOUNDS_SIZE,
    };
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

function pointFromGlyph(
  rawX: number,
  rawY: number,
  x: number,
  y: number,
  scale: number,
): Point {
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

function transformPoint(
  point: Point,
  center: Point,
  spin: number,
  shearX: number,
  shearY: number,
): Point {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const sheared = {
    x: center.x + dx + dy * shearX,
    y: center.y + dy + dx * shearY,
  };

  return rotatePoint(sheared, center, spin);
}

function transformCommand(
  command: OpenTypeCommand,
  center: Point,
  spin: number,
  shearX: number,
  shearY: number,
): OpenTypeCommand {
  if (command.type === "Z") return command;
  const point = transformPoint(command, center, spin, shearX, shearY);
  if (command.type === "M" || command.type === "L")
    return { ...command, ...point };
  if (command.type === "Q") {
    const control = transformPoint(
      { x: command.x1, y: command.y1 },
      center,
      spin,
      shearX,
      shearY,
    );
    return { ...command, ...point, x1: control.x, y1: control.y };
  }

  if (command.type === "C") {
    const controlA = transformPoint(
      { x: command.x1, y: command.y1 },
      center,
      spin,
      shearX,
      shearY,
    );
    const controlB = transformPoint(
      { x: command.x2, y: command.y2 },
      center,
      spin,
      shearX,
      shearY,
    );
    return {
      ...command,
      ...point,
      x1: controlA.x,
      y1: controlA.y,
      x2: controlB.x,
      y2: controlB.y,
    };
  }

  return command;
}

function transformCommands(
  commands: OpenTypeCommand[],
  spin: number,
  shearX: number,
  shearY: number,
) {
  if (
    Math.abs(spin) < 0.0001 &&
    Math.abs(shearX) < 0.0001 &&
    Math.abs(shearY) < 0.0001
  )
    return commands;
  const bounds = commandBounds(commands);
  const center = {
    x: (bounds.x1 + bounds.x2) / 2,
    y: (bounds.y1 + bounds.y2) / 2,
  };

  return commands.map((command) =>
    transformCommand(command, center, spin, shearX, shearY),
  );
}

function commandsToPath(commands: OpenTypeCommand[]) {
  return commands
    .map((command) => {
      if (command.type === "M") return `M${pointToPath(command)}`;
      if (command.type === "L") return `L${pointToPath(command)}`;
      if (command.type === "Q")
        return `Q${pointToPath({ x: command.x1, y: command.y1 })} ${pointToPath(command)}`;
      if (command.type === "C") {
        return `C${pointToPath({ x: command.x1, y: command.y1 })} ${pointToPath({ x: command.x2, y: command.y2 })} ${pointToPath(command)}`;
      }
      return "Z";
    })
    .join("");
}

function glyphToCommands(
  glyph: OpenTypeGlyph,
  x: number,
  y: number,
  scale: number,
) {
  return (glyph.path?.commands ?? []).map((command): OpenTypeCommand => {
    if (command.type === "M" || command.type === "L")
      return {
        type: command.type,
        ...pointFromGlyph(command.x, command.y, x, y, scale),
      };
    if (command.type === "Q") {
      return {
        type: "Q",
        ...pointFromGlyph(command.x, command.y, x, y, scale),
        x1: pointFromGlyph(command.x1, command.y1, x, y, scale).x,
        y1: pointFromGlyph(command.x1, command.y1, x, y, scale).y,
      };
    }

    if (command.type === "C") {
      return {
        type: "C",
        ...pointFromGlyph(command.x, command.y, x, y, scale),
        x1: pointFromGlyph(command.x1, command.y1, x, y, scale).x,
        y1: pointFromGlyph(command.x1, command.y1, x, y, scale).y,
        x2: pointFromGlyph(command.x2, command.y2, x, y, scale).x,
        y2: pointFromGlyph(command.x2, command.y2, x, y, scale).y,
      };
    }

    return { type: "Z" };
  });
}

function measureLine(
  font: OpenTypeFont,
  glyphs: OpenTypeGlyph[],
  scale: number,
  letterSpacing: number,
) {
  return glyphs.reduce((width, glyph, glyphIndex) => {
    const previousGlyph = glyphs[glyphIndex - 1];
    const kerning =
      previousGlyph && font.getKerningValue
        ? font.getKerningValue(previousGlyph, glyph) * scale
        : 0;
    const spacing = glyphIndex < glyphs.length - 1 ? letterSpacing : 0;

    return width + kerning + glyph.advanceWidth * scale + spacing;
  }, 0);
}

export function layoutText(
  font: OpenTypeFont,
  text: string,
  options: LayoutOptions,
): TextLayout {
  const bounds = emptyBounds();
  const scale = options.fontSize / font.unitsPerEm;
  const baselineStep = options.fontSize * options.lineHeight;
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const glyphs = font.stringToGlyphs(line || " ");
      return {
        glyphs,
        width: measureLine(font, glyphs, scale, options.letterSpacing),
      };
    });
  const maxLineWidth = Math.max(
    ...lines.map((line) => line.width),
    MIN_BOUNDS_SIZE,
  );
  const glyphs = lines.flatMap((line, lineIndex) => {
    const centeredStagger = lineIndex - (lines.length - 1) / 2;
    const alternatingNudge = lineIndex % 2 === 0 ? -0.18 : 0.18;
    const posterX =
      options.alignment === "poster"
        ? centeredStagger * options.posterOffsetX +
          alternatingNudge * Math.abs(options.posterOffsetX)
        : 0;
    const posterY =
      options.alignment === "poster" ? lineIndex * options.posterOffsetY : 0;
    const alignX =
      options.alignment === "center"
        ? (maxLineWidth - line.width) / 2
        : options.alignment === "right"
          ? maxLineWidth - line.width
          : 0;
    let cursor = posterX + alignX;

    return line.glyphs
      .map((glyph, glyphIndex) => {
        const previousGlyph = line.glyphs[glyphIndex - 1];
        if (previousGlyph && font.getKerningValue)
          cursor += font.getKerningValue(previousGlyph, glyph) * scale;

        const transformSeed =
          (lineIndex + 1) * 971 + (glyphIndex + 1) * 577 + glyph.index * 0.37;
        const spinRatio = Math.max(
          0,
          Math.min(1, Number(options.rotationSpin)),
        );
        const xRatio = Math.max(0, Math.min(1, Number(options.rotationX)));
        const yRatio = Math.max(0, Math.min(1, Number(options.rotationY)));
        const spinAngle =
          (seededUnit(transformSeed) * 2 - 1) *
          spinRatio *
          MAX_LETTER_ROTATION_DEGREES *
          (Math.PI / 180);
        const shearX = Math.tan(
          (seededUnit(transformSeed + 19) * 2 - 1) *
            xRatio *
            MAX_LETTER_AXIS_TILT_DEGREES *
            (Math.PI / 180),
        );
        const shearY = Math.tan(
          (seededUnit(transformSeed + 43) * 2 - 1) *
            yRatio *
            MAX_LETTER_AXIS_TILT_DEGREES *
            (Math.PI / 180),
        );
        const commands = transformCommands(
          glyphToCommands(
            glyph,
            cursor,
            lineIndex * baselineStep + posterY,
            scale,
          ),
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
        if (glyphIndex < line.glyphs.length - 1)
          cursor += options.letterSpacing;
        return layoutGlyph;
      })
      .filter((glyph) => glyph.d.length > 0);
  });

  if (!Number.isFinite(bounds.x1)) {
    includePoint(bounds, { x: 0, y: 0 });
    includePoint(bounds, {
      x: Math.max(options.fontSize, MIN_BOUNDS_SIZE),
      y: Math.max(options.fontSize, MIN_BOUNDS_SIZE),
    });
  }

  return { glyphs, bounds, fontSize: options.fontSize };
}

function lerp(left: number, right: number, t: number) {
  return left + (right - left) * t;
}

function lerpPoint(left: Point, right: Point, t: number): Point {
  return {
    x: lerp(left.x, right.x, t),
    y: lerp(left.y, right.y, t),
  };
}

function dotPoint(left: Point, right: Point) {
  return left.x * right.x + left.y * right.y;
}

export function flattenQuadratic(
  start: Point,
  control: Point,
  end: Point,
  resolution: number,
) {
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

export function flattenCubic(
  start: Point,
  controlA: Point,
  controlB: Point,
  end: Point,
  resolution: number,
) {
  const points: Point[] = [];
  for (let index = 1; index <= resolution; index += 1) {
    const t = index / resolution;
    const a = {
      x: lerp(start.x, controlA.x, t),
      y: lerp(start.y, controlA.y, t),
    };
    const b = {
      x: lerp(controlA.x, controlB.x, t),
      y: lerp(controlA.y, controlB.y, t),
    };
    const c = { x: lerp(controlB.x, end.x, t), y: lerp(controlB.y, end.y, t) };
    const d = { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    const e = { x: lerp(b.x, c.x, t), y: lerp(b.y, c.y, t) };
    points.push({ x: lerp(d.x, e.x, t), y: lerp(d.y, e.y, t) });
  }
  return points;
}

function pushPoint(contour: Point[], point: Point) {
  const previous = contour[contour.length - 1];
  if (
    !previous ||
    Math.hypot(previous.x - point.x, previous.y - point.y) > 0.001
  ) {
    contour.push(point);
  }
}

export function pathToContours(
  commands: OpenTypeCommand[],
  resolution: number,
): Contour[] {
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
    if (command.type === "M") {
      if (points.length > 1) finish(false);
      current = { x: command.x, y: command.y };
      start = current;
      points = [current];
      continue;
    }

    if (!current || !start) continue;

    if (command.type === "L") {
      current = { x: command.x, y: command.y };
      pushPoint(points, current);
      continue;
    }

    if (command.type === "Q") {
      flattenQuadratic(
        current,
        { x: command.x1, y: command.y1 },
        { x: command.x, y: command.y },
        segmentCount,
      ).forEach((point) => pushPoint(points, point));
      current = { x: command.x, y: command.y };
      continue;
    }

    if (command.type === "C") {
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

function polygonToPath(points: Point[]) {
  if (points.length === 0) return "";
  return `M${points.map(pointToPath).join("L")}Z`;
}

function contourSignedArea(points: Point[]) {
  return (
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length];
      return next ? area + point.x * next.y - point.y * next.x : area;
    }, 0) / 2
  );
}

function isConcaveVertex(
  points: Point[],
  pointIndex: number,
  contourArea: number,
) {
  const previous = points[(pointIndex - 1 + points.length) % points.length];
  const current = points[pointIndex];
  const next = points[(pointIndex + 1) % points.length];
  if (!previous || !current || !next) return false;

  const crossProduct =
    (current.x - previous.x) * (next.y - current.y) -
    (current.y - previous.y) * (next.x - current.x);

  return contourArea >= 0 ? crossProduct < -0.001 : crossProduct > 0.001;
}

function contourBounds(points: Point[]) {
  return points.reduce<Bounds>((bounds, point) => {
    includePoint(bounds, point);
    return bounds;
  }, emptyBounds());
}

function containsBounds(outer: Bounds, inner: Bounds) {
  return (
    outer.x1 <= inner.x1 &&
    outer.y1 <= inner.y1 &&
    outer.x2 >= inner.x2 &&
    outer.y2 >= inner.y2
  );
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
  const colors =
    palette.length > 1 ? palette.slice(1) : DEFAULT_PALETTE.slice(1);
  return colors.length > 0 ? colors : [BACK_COLOR];
}

function colorForGlyph(glyph: GlyphLayout, palette = DEFAULT_PALETTE) {
  const colors = extrusionColors(palette);
  return (
    colors[
      seededVariation(
        (glyph.lineIndex + 1) * 91 + (glyph.index + 1) * 17,
        colors.length,
      )
    ] ?? BACK_COLOR
  );
}

function colorForFaceZone(
  glyphIndex: number,
  contourIndex: number,
  zone: FaceZone,
  isHoleContour: boolean,
  palette = DEFAULT_PALETTE,
) {
  const colors = extrusionColors(palette);
  const zoneSeed: Record<FaceZone, number> = {
    "outer-left": 17,
    "inner-left": 131,
    "inner-right": 269,
    "outer-right": 421,
    "outer-bottom": 587,
  };
  const seed =
    (glyphIndex + 1) * 1009 +
    (contourIndex + 1) * 313 +
    zoneSeed[zone] +
    (isHoleContour ? 719 : 0);

  return (
    colors[seededVariation(seed, colors.length)] ?? colors[0] ?? BACK_COLOR
  );
}

function edgeFaceZone(
  a: Point,
  b: Point,
  normal: Point,
  bounds: Bounds,
): FaceZone {
  const length = Math.max(0.001, Math.hypot(normal.x, normal.y));
  const unitNormal = { x: normal.x / length, y: normal.y / length };
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const centerX = (bounds.x1 + bounds.x2) / 2;
  const bottomBand = Math.max(10, (bounds.y2 - bounds.y1) * 0.18);
  const isBottom = midpoint.y >= bounds.y2 - bottomBand && unitNormal.y > 0.2;

  if (isBottom) return "outer-bottom";
  if (midpoint.x < centerX)
    return unitNormal.x < 0 ? "outer-left" : "inner-left";
  return unitNormal.x < 0 ? "inner-right" : "outer-right";
}

function innerFaceZone(a: Point, b: Point, bounds: Bounds): FaceZone {
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const centerX = (bounds.x1 + bounds.x2) / 2;
  return midpoint.x < centerX ? "inner-left" : "inner-right";
}

function degreesToRadians(degrees: number) {
  return degrees * (Math.PI / 180);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function variedSignedRandom(
  baseSeed: number,
  glyphIndex: number,
  axisSeed: number,
) {
  const seed = baseSeed + axisSeed;
  const signPatterns = [
    [-1, 1, 1, -1],
    [1, -1, -1, 1],
    [-1, 1, -1, 1],
    [1, -1, 1, -1],
    [-1, -1, 1, 1],
    [1, 1, -1, -1],
  ];
  const blockIndex = Math.floor(glyphIndex / 4);
  const pattern =
    signPatterns[
      seededVariation(seed + blockIndex * 1709, signPatterns.length)
    ] ?? signPatterns[0];
  const sign = pattern[glyphIndex % pattern.length] ?? 1;
  const magnitude = lerp(0.55, 1, seededUnit(seed + glyphIndex * 1297));
  return clamp(sign * magnitude, -1, 1);
}

function rotateVector3D(
  point: Point3D,
  rotateX: number,
  rotateY: number,
  rotateZ: number,
): Point3D {
  const xAngle = degreesToRadians(rotateX);
  const yAngle = degreesToRadians(rotateY);
  const zAngle = degreesToRadians(rotateZ);
  const cosX = Math.cos(xAngle);
  const sinX = Math.sin(xAngle);
  const cosY = Math.cos(yAngle);
  const sinY = Math.sin(yAngle);
  const cosZ = Math.cos(zAngle);
  const sinZ = Math.sin(zAngle);
  let { x, y, z } = point;

  const rotatedY = y * cosX - z * sinX;
  const rotatedZ = y * sinX + z * cosX;
  y = rotatedY;
  z = rotatedZ;

  const tiltedX = x * cosY + z * sinY;
  const tiltedZ = -x * sinY + z * cosY;
  x = tiltedX;
  z = tiltedZ;

  return {
    x: x * cosZ - y * sinZ,
    y: x * sinZ + y * cosZ,
    z,
  };
}

function normalized3D(point: Point3D): Point3D {
  const length = Math.max(0.001, Math.hypot(point.x, point.y, point.z));
  return {
    x: point.x / length,
    y: point.y / length,
    z: point.z / length,
  };
}

function createProjector(bounds: Bounds, options: PlaneOptions) {
  const width = Math.max(MIN_BOUNDS_SIZE, bounds.x2 - bounds.x1);
  const height = Math.max(MIN_BOUNDS_SIZE, bounds.y2 - bounds.y1);
  const size = Math.max(width, height);
  const centerX = (bounds.x1 + bounds.x2) / 2;
  const centerY = (bounds.y1 + bounds.y2) / 2;
  const cameraX = centerX + options.cameraX * size;
  const cameraY = centerY + options.cameraY * size;
  const perspective = Math.max(0, options.perspective);
  const cameraDistance = Math.max(
    size * 0.35,
    size * Math.max(0.8, options.cameraZ),
  );

  return (point: Point3D): Point => {
    const denominator = Math.max(
      cameraDistance * 0.18,
      cameraDistance + point.z * perspective,
    );
    const scale = cameraDistance / denominator;
    return {
      x: cameraX + (point.x - cameraX) * scale,
      y: cameraY + (point.y - cameraY) * scale,
    };
  };
}

function includePathData(bounds: Bounds, d: string) {
  const tokens = d.match(/[MLCQZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || /[MLCQZ]/i.test(token)) continue;
    const x = Number(token);
    const y = Number(tokens[index + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      includePoint(bounds, { x, y });
      index += 1;
    }
  }
}

function boundsFromPathData(paths: string[]) {
  const bounds = emptyBounds();
  paths.forEach((path) => includePathData(bounds, path));
  return bounds;
}

type GlyphPlane = {
  center: Point;
  normal: Point3D;
  depth: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  sortZ: number;
  frontZ: number;
  backZ: number;
  project: (point: Point, depthOffset?: number) => Point;
  point3D: (point: Point, depthOffset?: number) => Point3D;
};

function createGlyphPlane(
  glyph: GlyphLayout,
  glyphIndex: number,
  options: PlaneOptions,
  project: (point: Point3D) => Point,
): GlyphPlane {
  const bounds = commandBounds(glyph.commands);
  const center = {
    x: (bounds.x1 + bounds.x2) / 2,
    y: (bounds.y1 + bounds.y2) / 2,
  };
  const baseSeed = Number(options.seed) + (glyph.lineIndex + 1) * 1009;
  const rotateX =
    options.baseRotateX +
    variedSignedRandom(baseSeed, glyphIndex, 11) * options.randomRotateX;
  const rotateY =
    options.baseRotateY +
    variedSignedRandom(baseSeed, glyphIndex, 23) * options.randomRotateY;
  const rotateZ =
    options.baseRotateZ +
    variedSignedRandom(baseSeed, glyphIndex, 37) * options.randomRotateZ;
  const normal = normalized3D(
    rotateVector3D({ x: 0, y: 0, z: -1 }, rotateX, rotateY, rotateZ),
  );
  const depth = options.randomDepth
    ? (() => {
        const minDepth = Math.max(
          0,
          Math.min(options.minDepth, options.maxDepth),
        );
        const maxDepth = Math.max(
          0,
          Math.max(options.minDepth, options.maxDepth),
        );
        const depthMix = (variedSignedRandom(baseSeed, glyphIndex, 53) + 1) / 2;
        return lerp(minDepth, maxDepth, depthMix);
      })()
    : Math.max(0, options.depth);
  const scaledDepth = depth * Math.max(0.01, options.depthScale);

  function point3D(point: Point, depthOffset = 0): Point3D {
    const rotated = rotateVector3D(
      {
        x: point.x - center.x,
        y: point.y - center.y,
        z: 0,
      },
      rotateX,
      rotateY,
      rotateZ,
    );

    return {
      x: center.x + rotated.x + normal.x * depthOffset,
      y: center.y + rotated.y + normal.y * depthOffset,
      z: rotated.z + normal.z * depthOffset,
    };
  }

  return {
    center,
    normal,
    depth: scaledDepth,
    rotateX,
    rotateY,
    rotateZ,
    sortZ: (point3D(center).z + point3D(center, scaledDepth).z) / 2,
    frontZ: point3D(center).z,
    backZ: point3D(center, scaledDepth).z,
    project: (point, depthOffset = 0) => project(point3D(point, depthOffset)),
    point3D,
  };
}

function projectCommands(
  commands: OpenTypeCommand[],
  plane: GlyphPlane,
  depthOffset = 0,
) {
  return commands.map((command) => {
    if (command.type === "M" || command.type === "L")
      return { ...command, ...plane.project(command, depthOffset) };
    if (command.type === "Q") {
      const control = plane.project(
        { x: command.x1, y: command.y1 },
        depthOffset,
      );
      return {
        ...command,
        ...plane.project(command, depthOffset),
        x1: control.x,
        y1: control.y,
      };
    }

    if (command.type === "C") {
      const controlA = plane.project(
        { x: command.x1, y: command.y1 },
        depthOffset,
      );
      const controlB = plane.project(
        { x: command.x2, y: command.y2 },
        depthOffset,
      );
      return {
        ...command,
        ...plane.project(command, depthOffset),
        x1: controlA.x,
        y1: controlA.y,
        x2: controlB.x,
        y2: controlB.y,
      };
    }

    return command;
  });
}

function projectedSideFace(
  a: Point,
  b: Point,
  plane: GlyphPlane,
  startRatio = 0,
  endRatio = 1,
) {
  const segmentA = lerpPoint(a, b, startRatio);
  const segmentB = lerpPoint(a, b, endRatio);
  const frontA = plane.project(segmentA);
  const frontB = plane.project(segmentB);
  const backB = plane.project(segmentB, plane.depth);
  const backA = plane.project(segmentA, plane.depth);

  return {
    d: polygonToPath([frontA, frontB, backB, backA]),
    polygon: [frontA, frontB, backB, backA],
    sortZ:
      (plane.point3D(segmentA).z +
        plane.point3D(segmentB).z +
        plane.point3D(segmentB, plane.depth).z +
        plane.point3D(segmentA, plane.depth).z) /
      4,
  };
}

function projectedSideRun(edges: SideEdge[], plane: GlyphPlane) {
  const sourcePoints =
    edges.length > 0 ? [edges[0].a, ...edges.map((edge) => edge.b)] : [];
  const frontPoints = sourcePoints.map((point) => plane.project(point));
  const backPoints = [...sourcePoints]
    .reverse()
    .map((point) => plane.project(point, plane.depth));
  const polygon = [...frontPoints, ...backPoints];
  const allZ = sourcePoints.flatMap((point) => [
    plane.point3D(point).z,
    plane.point3D(point, plane.depth).z,
  ]);
  const sortZ = allZ.reduce((sum, z) => sum + z, 0) / Math.max(1, allZ.length);

  return {
    d: polygonToPath(polygon),
    polygon,
    sortZ,
  };
}

function sideVisibilityScore(
  face: ReturnType<typeof projectedSideFace>,
  projectedContourArea: number,
) {
  const [frontA, frontB, backB, backA] = face.polygon;
  if (!frontA || !frontB || !backB || !backA) return 0;

  const normal = edgeNormal(frontA, frontB, projectedContourArea);
  const frontMidpoint = {
    x: (frontA.x + frontB.x) / 2,
    y: (frontA.y + frontB.y) / 2,
  };
  const backMidpoint = {
    x: (backA.x + backB.x) / 2,
    y: (backA.y + backB.y) / 2,
  };
  const depthVector = {
    x: backMidpoint.x - frontMidpoint.x,
    y: backMidpoint.y - frontMidpoint.y,
  };

  return dotPoint(normal, depthVector);
}

function contourVisibilityScore(
  face: ReturnType<typeof projectedSideFace>,
  projectedContourArea: number,
  isHoleContour: boolean,
) {
  const score = sideVisibilityScore(face, projectedContourArea);
  return isHoleContour ? -score : score;
}

function groupSideEdges(edges: SideEdge[], edgeCount: number): SideEdgeRun[] {
  function edgeDirection(edge: SideEdge) {
    const dx = edge.b.x - edge.a.x;
    const dy = edge.b.y - edge.a.y;
    const length = Math.max(0.001, Math.hypot(dx, dy));
    return { x: dx / length, y: dy / length };
  }

  function edgesContinueSmoothly(previous: SideEdge, current: SideEdge) {
    const previousDirection = edgeDirection(previous);
    const currentDirection = edgeDirection(current);
    // Keep flattened curves in one colored face, but split sharp corners
    // such as the inner crossing planes in X into separate SVG paths.
    return dotPoint(previousDirection, currentDirection) >= FACE_RUN_MIN_DOT;
  }

  const runs = edges.reduce<SideEdgeRun[]>((result, edge) => {
    const previousRun = result[result.length - 1];
    const previousEdge = previousRun?.edges[previousRun.edges.length - 1];
    const continuesPrevious =
      previousRun &&
      previousRun.zone === edge.zone &&
      previousEdge &&
      edge.pointIndex === previousEdge.pointIndex + 1 &&
      edgesContinueSmoothly(previousEdge, edge);

    if (continuesPrevious) {
      previousRun.edges.push(edge);
    } else {
      result.push({ index: result.length, zone: edge.zone, edges: [edge] });
    }

    return result;
  }, []);

  const firstRun = runs[0];
  const lastRun = runs[runs.length - 1];
  const firstEdge = firstRun?.edges[0];
  const lastEdge = lastRun?.edges[lastRun.edges.length - 1];
  if (
    runs.length > 1 &&
    firstRun &&
    lastRun &&
    firstRun.zone === lastRun.zone &&
    firstEdge?.pointIndex === 0 &&
    lastEdge?.pointIndex === edgeCount - 1 &&
    edgesContinueSmoothly(lastEdge, firstEdge)
  ) {
    firstRun.edges = [...lastRun.edges, ...firstRun.edges];
    runs.pop();
  }

  return runs.map((run, index) => ({ ...run, index }));
}

function faceDepthTieBreaker(kind: RenderFace["kind"]) {
  if (kind === "back") return 0;
  if (kind === "side") return 1;
  return 2;
}

function keepOwnFrontFaceOnTop(faces: RenderFace[]) {
  const result = [...faces];
  const glyphIndices = Array.from(
    new Set(result.map((face) => face.glyphIndex)),
  );

  glyphIndices.forEach((glyphIndex) => {
    const frontIndex = result.findIndex(
      (face) => face.glyphIndex === glyphIndex && face.kind === "front",
    );
    if (frontIndex < 0) return;

    const lastOwnNonFrontIndex = result.reduce(
      (lastIndex, face, index) =>
        face.glyphIndex === glyphIndex && face.kind !== "front"
          ? index
          : lastIndex,
      -1,
    );
    if (lastOwnNonFrontIndex < frontIndex) return;

    const [frontFace] = result.splice(frontIndex, 1);
    const insertAfter = result.reduce(
      (lastIndex, face, index) =>
        face.glyphIndex === glyphIndex && face.kind !== "front"
          ? index
          : lastIndex,
      -1,
    );
    result.splice(insertAfter + 1, 0, frontFace);
  });

  return result;
}

export function renderSvg(
  layout: TextLayout,
  options: RenderOptions,
): RenderedSvg {
  const projector = createProjector(layout.bounds, options.plane);
  const sideFaces: SideFace[] = [];
  const frontFaces: GlyphLayout[] = [];
  const backFaces: GlyphLayout[] = [];
  const faceGroups: RenderFaceGroup[] = [];

  layout.glyphs.forEach((glyph, glyphIndex) => {
    const plane = createGlyphPlane(glyph, glyphIndex, options.plane, projector);
    const glyphRenderFaces: RenderFace[] = [];
    const frontCommands = projectCommands(glyph.commands, plane);
    const frontFace = {
      ...glyph,
      d: commandsToPath(frontCommands),
      commands: frontCommands,
    };
    frontFaces.push(frontFace);

    if (options.showBack) {
      const backCommands = projectCommands(glyph.commands, plane, plane.depth);
      const backFace = {
        ...glyph,
        d: commandsToPath(backCommands),
        commands: backCommands,
      };
      backFaces.push(backFace);
      glyphRenderFaces.push({
        id: `${glyph.id}-back`,
        kind: "back",
        d: backFace.d,
        fill: colorForGlyph(glyph, options.palette),
        glyphIndex,
        lineIndex: glyph.lineIndex,
        sortZ: plane.backZ,
        polygons: [],
        opacity: BACK_OPACITY,
      });
    }

    const contours = pathToContours(glyph.commands, options.resolution).map(
      (contour) => ({
        ...contour,
        bounds: contourBounds(contour.points),
      }),
    );
    const contourMeta = contours.map((contour, contourIndex) => ({
      isHole: contours.some(
        (candidate, candidateIndex) =>
          candidateIndex !== contourIndex &&
          containsBounds(candidate.bounds, contour.bounds),
      ),
      clipPathId: `${glyph.id}-hole-${contourIndex}-clip`,
    }));
    const frontPolygons = contours
      .filter((_, contourIndex) => !contourMeta[contourIndex]?.isHole)
      .map((contour) => contour.points.map((point) => plane.project(point)));
    const orderedFrontFace: RenderFace = {
      id: `${glyph.id}-front`,
      kind: "front",
      d: frontFace.d,
      fill: frontColor(options.palette),
      glyphIndex,
      lineIndex: glyph.lineIndex,
      sortZ: plane.frontZ,
      polygons: frontPolygons,
    };
    contours.forEach((contour, contourIndex) => {
      const edgeCount = contour.closed
        ? contour.points.length
        : contour.points.length - 1;
      const contourArea = contour.closed
        ? contourSignedArea(contour.points)
        : -1;
      const projectedContourArea = contour.closed
        ? contourSignedArea(contour.points.map((point) => plane.project(point)))
        : -1;
      const isHoleContour = Boolean(contourMeta[contourIndex]?.isHole);
      const visibleEdges: SideEdge[] = [];
      if (isHoleContour && !options.renderInnerFaces) return;

      for (let pointIndex = 0; pointIndex < edgeCount; pointIndex += 1) {
        const a = contour.points[pointIndex];
        const b = contour.points[(pointIndex + 1) % contour.points.length];
        if (!a || !b) continue;
        const nextPointIndex = (pointIndex + 1) % contour.points.length;
        const normal = edgeNormal(a, b, contourArea);
        const fullProjectedFace = projectedSideFace(a, b, plane);
        const visibilityScore = contourVisibilityScore(
          fullProjectedFace,
          projectedContourArea,
          isHoleContour,
        );
        if (options.visibleSurfaceOnly && visibilityScore <= 0.001) continue;
        const concaveEdge =
          !isHoleContour &&
          (isConcaveVertex(contour.points, pointIndex, contourArea) ||
            isConcaveVertex(contour.points, nextPointIndex, contourArea));
        const edgeVector = { x: b.x - a.x, y: b.y - a.y };
        const horizontalNotchEdge =
          concaveEdge && Math.abs(edgeVector.x) > Math.abs(edgeVector.y) * 1.8;

        visibleEdges.push({
          pointIndex,
          a,
          b,
          normal,
          zone: horizontalNotchEdge
            ? innerFaceZone(a, b, contour.bounds)
            : edgeFaceZone(a, b, normal, contour.bounds),
          planeRank: 0,
          sortKey: 0,
        });
      }

      groupSideEdges(visibleEdges, edgeCount).forEach((run) => {
        const firstEdge = run.edges[0];
        if (!firstEdge) return;
        const runColor = colorForFaceZone(
          glyphIndex + Math.round(options.plane.seed),
          contourIndex + run.index,
          run.zone,
          isHoleContour,
          options.palette,
        );
        const projectedFace = projectedSideRun(run.edges, plane);
        const visibilityScore =
          run.edges.reduce(
            (score, edge) =>
              score +
              contourVisibilityScore(
                projectedSideFace(edge.a, edge.b, plane),
                projectedContourArea,
                isHoleContour,
              ),
            0,
          ) / Math.max(1, run.edges.length);
        const id = `${glyph.id}-side-${contourIndex}-${run.index}`;
        sideFaces.push({
          id,
          d: projectedFace.d,
          polygon: projectedFace.polygon,
          edgeA: projectedFace.polygon[0],
          edgeB: projectedFace.polygon[1],
          fill: runColor,
          glyphIndex,
          planeRank: plane.sortZ,
          sortKey: projectedFace.sortZ,
          zone: run.zone,
          edgeIndex: firstEdge.pointIndex,
        });
        if (options.showSides) {
          glyphRenderFaces.push({
            id,
            kind: "side",
            d: projectedFace.d,
            fill: runColor,
            glyphIndex,
            lineIndex: glyph.lineIndex,
            sortZ: projectedFace.sortZ,
            polygons: [projectedFace.polygon],
            zone: run.zone,
            edgeIndex: firstEdge.pointIndex,
            visibilityScore,
          });
        }
      });
    });
    if (options.showFront) glyphRenderFaces.push(orderedFrontFace);
    const orderedGlyphFaces = keepOwnFrontFaceOnTop(
      glyphRenderFaces.sort(
        (left, right) =>
          left.sortZ - right.sortZ ||
          faceDepthTieBreaker(left.kind) - faceDepthTieBreaker(right.kind),
      ),
    );
    faceGroups.push({
      id: `${glyph.id}-group`,
      glyphIndex,
      lineIndex: glyph.lineIndex,
      sortX: plane.center.x,
      sortZ: plane.frontZ,
      rotateX: plane.rotateX,
      rotateY: plane.rotateY,
      rotateZ: plane.rotateZ,
      faces: orderedGlyphFaces,
    });
  });
  sideFaces.sort(
    (left, right) =>
      right.planeRank - left.planeRank ||
      right.sortKey - left.sortKey ||
      left.glyphIndex - right.glyphIndex,
  );
  const orderedFaceGroups = faceGroups.sort(
    (left, right) =>
      right.sortX - left.sortX ||
      left.sortZ - right.sortZ ||
      left.glyphIndex - right.glyphIndex,
  );
  const orderedFaces = orderedFaceGroups.flatMap((group) => group.faces);
  const outputSideFaces = options.showSides ? sideFaces : [];
  const outputFrontFaces = options.showFront ? frontFaces : [];
  const outputBackFaces = options.showBack ? backFaces : [];
  const outputBounds = boundsFromPathData([
    ...outputSideFaces.map((face) => face.d),
    ...outputFrontFaces.map((glyph) => glyph.d),
    ...outputBackFaces.map((glyph) => glyph.d),
  ]);

  return {
    sideFaces: outputSideFaces,
    frontFaces: outputFrontFaces,
    backFaces: outputBackFaces,
    glyphClips: [],
    orderedFaces,
    orderedFaceGroups,
    viewBox: padBounds(outputBounds, VIEWBOX_PADDING),
  };
}

function useOpenTypeFont(url: string) {
  const [font, setFont] = useState<OpenTypeFont | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setFont(null);
    setError("");

    async function loadFont() {
      try {
        const buffer = await fetch(url, { signal: controller.signal }).then(
          (response) => {
            if (!response.ok)
              throw new Error(`Font request failed with ${response.status}`);
            return response.arrayBuffer();
          },
        );
        setFont((opentype as OpenTypeParser).parse(buffer) as OpenTypeFont);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load font",
          );
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
  const defaultFamily = getFontFamilyById(DEFAULT_FONT_FAMILY_ID);
  const defaultFont = getFontByValue(
    defaultFamily.fonts,
    DEFAULT_FONT_VALUE,
    defaultFamily.defaultFont,
  );
  const [selectedFontFamilyId, setSelectedFontFamilyId] = useState(
    defaultFamily.id,
  );
  const selectedFontFamily = getFontFamilyById(selectedFontFamilyId);
  const [selectedFontValue, setSelectedFontValue] = useState(defaultFont.value);
  const selectedFont = getFontByValue(
    selectedFontFamily.fonts,
    selectedFontValue,
    selectedFontFamily.defaultFont,
  );

  const typography = useControls(
    "Typography",
    {
      fontFamily: {
        value: selectedFontFamily.id,
        options: getFontFamilyOptions(),
        label: "family",
        onChange: (familyId: string) => {
          const nextFamily = getFontFamilyById(familyId);
          setSelectedFontFamilyId(nextFamily.id);
          setSelectedFontValue(nextFamily.defaultFont.value);
        },
      },
      fontVariant: {
        value: selectedFont.value,
        options: getFontVariantOptions(selectedFontFamily.fonts),
        label: "variant",
        onChange: (value: string) => {
          setSelectedFontValue(value);
        },
      },
      text: { value: DEFAULT_TEXT, rows: 4, label: "text" },
      fontSize: {
        ...nativeNumber({
          current: DEFAULT_FONT_SIZE,
          min: 36,
          max: 520,
          step: 1,
        }),
        label: "font size",
      },
      lineHeight: {
        ...nativeNumber({ current: 1.01, min: 0.45, max: 1.5, step: 0.01 }),
        label: "line height",
      },
      letterSpacing: {
        ...nativeNumber({ current: 0, min: -40, max: 180, step: 0.5 }),
        label: "letter spacing",
      },
      alignment: {
        value: "left",
        options: ["left", "center", "right", "poster"],
        label: "alignment",
      },
    },
    { collapsed: false },
    [selectedFontFamily.id, selectedFont.value],
  );

  const plane = useControls(
    "Character Planes",
    {
      seed: {
        ...nativeNumber({ current: 2206, min: 0, max: 9999, step: 1 }),
        label: "seed",
      },
      baseRotateX: {
        ...nativeNumber({ current: -18, min: -75, max: 75, step: 1 }),
        label: "base x",
      },
      baseRotateY: {
        ...nativeNumber({ current: 32, min: -75, max: 75, step: 1 }),
        label: "base y",
      },
      baseRotateZ: {
        ...nativeNumber({ current: 0, min: -180, max: 180, step: 1 }),
        label: "base z",
      },
      randomRotateX: {
        ...nativeNumber({ current: 16, min: 0, max: 90, step: 1 }),
        label: "random x",
      },
      randomRotateY: {
        ...nativeNumber({ current: 12, min: 0, max: 90, step: 1 }),
        label: "random y",
      },
      randomRotateZ: {
        ...nativeNumber({ current: 7, min: 0, max: 90, step: 1 }),
        label: "random z",
      },
      perspective: {
        ...nativeNumber({ current: 1, min: 0, max: 2.5, step: 0.05 }),
        label: "perspective",
      },
      cameraX: {
        ...nativeNumber({ current: -0.15, min: -2, max: 2, step: 0.05 }),
        label: "camera x",
      },
      cameraY: {
        ...nativeNumber({ current: -0.05, min: -2, max: 2, step: 0.05 }),
        label: "camera y",
      },
      cameraZ: {
        ...nativeNumber({ current: 9, min: 0.8, max: 9, step: 0.1 }),
        label: "camera z",
      },
    },
    { collapsed: false },
  );

  const extrusion = useControls(
    "Extrusion",
    {
      depth: {
        ...nativeNumber({
          current: 32,
          min: 0,
          max: MAX_EXTRUSION_DEPTH,
          step: 1,
        }),
        label: "depth",
      },
      randomDepth: { value: false, label: "random depth" },
      minDepth: {
        ...nativeNumber({
          current: 16,
          min: 0,
          max: MAX_EXTRUSION_DEPTH,
          step: 1,
        }),
        label: "min depth",
      },
      maxDepth: {
        ...nativeNumber({
          current: 48,
          min: 0,
          max: MAX_EXTRUSION_DEPTH,
          step: 1,
        }),
        label: "max depth",
      },
    },
    { collapsed: false },
  );

  const [drawing, setDrawing] = useControls(
    "Drawing",
    () => ({
      showFront: { value: true, label: "front face" },
      showSides: { value: true, label: "side faces" },
      showBack: { value: false, label: "back face" },
      randomizeColors: { value: false, label: "glyph variation" },
      faceBorders: { value: true, label: "stroke" },
      borderColor: "#000000",
      borderWidth: {
        ...nativeNumber({ current: 1.5, min: 0.25, max: 12, step: 0.25 }),
        label: "border width",
      },
      Color: folder(
        {
          background: "#ffffff",
          sidePalette: colorPalette({
            value: { source: DEFAULT_PALETTE_PRESET.id, colors: DEFAULT_PALETTE },
            palettes: sketchPalettePresets,
          }),
        },
        { collapsed: false },
      ),
    }),
    { collapsed: false },
  );

  useControls({
    "Download SVG": button(() =>
      downloadSvg(svgRef.current, "extruded-type.svg", {
        horizontalPaddingRatio: 0,
      }),
    ),
  });

  useEffect(() => {
    setDrawing({
      sidePalette: {
        source: DEFAULT_PALETTE_PRESET.id,
        colors: DEFAULT_PALETTE,
        slots: DEFAULT_PALETTE.map((color) => ({ color, enabled: true })),
      },
    });
  }, [setDrawing]);

  const { font, error } = useOpenTypeFont(selectedFont.url);
  const inputText = String(typography.text);
  const layout = useMemo(() => {
    if (!font) return null;
    return layoutText(font, inputText, {
      fontSize: Number(typography.fontSize),
      lineHeight: Number(typography.lineHeight),
      letterSpacing: Number(typography.letterSpacing),
      rotationSpin: 0,
      rotationX: 0,
      rotationY: 0,
      alignment: typography.alignment as TextAlignment,
      posterOffsetX: DEFAULT_POSTER_OFFSET_X,
      posterOffsetY: DEFAULT_POSTER_OFFSET_Y,
    });
  }, [
    font,
    inputText,
    typography.alignment,
    typography.fontSize,
    typography.letterSpacing,
    typography.lineHeight,
  ]);
  const activePalette = drawing.sidePalette.colors?.length
    ? drawing.sidePalette.colors
    : DEFAULT_PALETTE;

  const rendered = useMemo(() => {
    if (!layout) return null;
    const depthScale = layout.fontSize / DEFAULT_FONT_SIZE;
    return renderSvg(layout, {
      plane: {
        seed: Number(plane.seed),
        baseRotateX: Number(plane.baseRotateX),
        baseRotateY: Number(plane.baseRotateY),
        baseRotateZ: Number(plane.baseRotateZ),
        randomRotateX: Number(plane.randomRotateX),
        randomRotateY: Number(plane.randomRotateY),
        randomRotateZ: Number(plane.randomRotateZ),
        depth: Number(extrusion.depth),
        randomDepth: Boolean(extrusion.randomDepth),
        minDepth: Number(extrusion.minDepth),
        maxDepth: Number(extrusion.maxDepth),
        depthScale,
        perspective: Number(plane.perspective),
        cameraX: Number(plane.cameraX),
        cameraY: Number(plane.cameraY),
        cameraZ: Number(plane.cameraZ),
      },
      resolution: DEFAULT_FLATTENING_RESOLUTION,
      showFront: Boolean(drawing.showFront),
      showSides: Boolean(drawing.showSides),
      showBack: Boolean(drawing.showBack),
      visibleSurfaceOnly: true,
      renderInnerFaces: true,
      randomizeColors: Boolean(drawing.randomizeColors),
      palette: activePalette,
    });
  }, [
    activePalette,
    drawing.randomizeColors,
    drawing.showBack,
    drawing.showFront,
    drawing.showSides,
    extrusion.depth,
    extrusion.maxDepth,
    extrusion.minDepth,
    extrusion.randomDepth,
    layout,
    plane.baseRotateX,
    plane.baseRotateY,
    plane.baseRotateZ,
    plane.cameraX,
    plane.cameraY,
    plane.cameraZ,
    plane.perspective,
    plane.randomRotateX,
    plane.randomRotateY,
    plane.randomRotateZ,
    plane.seed,
  ]);

  if (error) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Font failed to load: {error}</div>
        <SketchControls fill flat />
      </section>
    );
  }

  if (!font || !layout || !rendered) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Loading font...</div>
        <SketchControls fill flat />
      </section>
    );
  }

  const depthScale = layout.fontSize / DEFAULT_FONT_SIZE;
  const strokeProps = drawing.faceBorders
    ? {
        stroke: String(drawing.borderColor),
        strokeWidth: Number(drawing.borderWidth),
        strokeLinejoin: "round" as const,
        strokeLinecap: "round" as const,
        vectorEffect: "non-scaling-stroke" as const,
      }
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
                <clipPath
                  key={clip.id}
                  id={clip.id}
                  clipPathUnits="userSpaceOnUse"
                >
                  <path d={clip.d} />
                </clipPath>
              ))}
            </defs>
          )}
          <rect
            x={rendered.viewBox.x1}
            y={rendered.viewBox.y1}
            width={rendered.viewBox.x2 - rendered.viewBox.x1}
            height={rendered.viewBox.y2 - rendered.viewBox.y1}
            fill={String(drawing.background)}
          />
          <g
            className="extruded-text depth-sorted-faces"
            data-depth={round(Number(extrusion.depth))}
            data-depth-scale={round(depthScale)}
            data-random-depth={Boolean(extrusion.randomDepth)}
            data-min-depth={round(Number(extrusion.minDepth))}
            data-max-depth={round(Number(extrusion.maxDepth))}
            data-camera-x={round(Number(plane.cameraX))}
            data-camera-y={round(Number(plane.cameraY))}
            data-camera-z={round(Number(plane.cameraZ))}
          >
            {rendered.orderedFaceGroups.map((group) => (
              <g
                key={group.id}
                className="glyph-group"
                data-glyph-index={group.glyphIndex}
                data-line-index={group.lineIndex}
                data-glyph-x-sort={round(group.sortX)}
                data-glyph-depth-sort={round(group.sortZ)}
                data-rotate-x={round(group.rotateX)}
                data-rotate-y={round(group.rotateY)}
                data-rotate-z={round(group.rotateZ)}
              >
                {group.faces.map((face) => (
                  <path
                    key={face.id}
                    className={`${face.kind}-face`}
                    data-face-kind={face.kind}
                    data-glyph-index={face.glyphIndex}
                    data-line-index={face.lineIndex}
                    data-depth-sort={round(face.sortZ)}
                    data-face-zone={face.zone}
                    data-edge-index={face.edgeIndex}
                    data-segment-index={face.segmentIndex}
                    data-visibility-score={
                      face.visibilityScore === undefined
                        ? undefined
                        : round(face.visibilityScore)
                    }
                    d={face.d}
                    fill={face.fill}
                    fillRule={
                      face.kind === "front" || face.kind === "back"
                        ? "evenodd"
                        : undefined
                    }
                    opacity={face.opacity}
                    {...strokeProps}
                  />
                ))}
              </g>
            ))}
          </g>
        </svg>
      </div>
      <SketchControls fill flat collapsed={false} oneLineLabels={false} />
    </section>
  );
}
