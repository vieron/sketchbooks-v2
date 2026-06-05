import { Delaunay } from 'd3-delaunay';
import Flatten from '@flatten-js/core';
import * as Clipper2 from '@countertype/clipper2-ts';
import * as opentype from 'opentype.js';

export type Point = {
  x: number;
  y: number;
};

export type Polygon = Point[];

type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type GlyphCommand =
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' };

type OpenTypePath = {
  commands: GlyphCommand[];
};

type OpenTypeFont = {
  getPath(text: string, x: number, y: number, fontSize: number): OpenTypePath;
};

type OpenTypeLoader = {
  load(fontUrl: string): Promise<OpenTypeFont>;
};

type SeedPoint = Point & {
  weight: number;
  insetJitter: number;
};

type GlyphGeometry = {
  contours: Polygon[];
  glyphPath: string;
  bounds: Bounds;
};

type OrganicCell = {
  id: string;
  rings: Polygon[];
  area: number;
};

export type OrganicGlyphFillOptions = {
  fontUrl: string;
  text: string;
  fontSize: number;
  width: number;
  height: number;
  cellCount: number;
  lloydIterations: number;
  gap: number;
  smoothing: number;
  seed: number | string;
  foregroundColor: string;
  backgroundColor: string;
  glyphColor?: string;
  anisotropyX?: number;
  anisotropyY?: number;
  chaikinPasses?: number;
  arcTolerance?: number;
  boundaryMargin?: number;
  blobificationAmount?: number;
  minAreaRatio?: number;
};

const CURVE_SEGMENTS = 20;
const CLIPPER_SCALE = 100;
const MIN_CELL_AREA = 18;
const DEFAULT_ARC_TOLERANCE = 1.5;
const DEFAULT_MIN_AREA_RATIO = 0.006;
const DEFAULT_BOUNDARY_MARGIN = 18;
const DEFAULT_BLOBIFICATION_AMOUNT = 0.18;
const DEFAULT_GLYPH_COLOR = '#ebe8e1';
const FONT_CACHE = new Map<string, Promise<OpenTypeFont>>();

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

function escapeAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function hashSeed(value: number | string) {
  const input = String(value);
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function createPrng(seed: number | string) {
  let state = hashSeed(seed) || 0x9e3779b9;

  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distancePointToSegment(point: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq <= 0.0001) return distance(point, a);

  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq, 0, 1);
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function distancePointToLine(point: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);

  if (length <= 0.0001) return distance(point, a);

  return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / length;
}

function distanceToGlyphBoundary(point: Point, contours: Polygon[]) {
  let minDistance = Infinity;

  contours.forEach((contour) => {
    for (let index = 0; index < contour.length; index += 1) {
      minDistance = Math.min(
        minDistance,
        distancePointToSegment(point, contour[index], contour[(index + 1) % contour.length]),
      );
    }
  });

  return Number.isFinite(minDistance) ? minDistance : 0;
}

function nearlySamePoint(a: Point, b: Point, epsilon = 0.001) {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

function cleanPolygon(points: Polygon) {
  const cleaned: Polygon = [];

  points.forEach((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const previous = cleaned[cleaned.length - 1];
    if (!previous || !nearlySamePoint(previous, point)) cleaned.push(point);
  });

  if (cleaned.length > 1 && nearlySamePoint(cleaned[0], cleaned[cleaned.length - 1])) {
    cleaned.pop();
  }

  return cleaned;
}

function rotatePolygon(points: Polygon, startIndex: number) {
  return points.slice(startIndex).concat(points.slice(0, startIndex));
}

function rdpOpen(points: Polygon, tolerance: number): Polygon {
  if (points.length <= 2) return points;

  const first = points[0];
  const last = points[points.length - 1];
  let maxDistance = 0;
  let maxIndex = 0;

  for (let index = 1; index < points.length - 1; index += 1) {
    const candidateDistance = distancePointToLine(points[index], first, last);

    if (candidateDistance > maxDistance) {
      maxDistance = candidateDistance;
      maxIndex = index;
    }
  }

  if (maxDistance <= tolerance) return [first, last];

  return rdpOpen(points.slice(0, maxIndex + 1), tolerance).slice(0, -1).concat(rdpOpen(points.slice(maxIndex), tolerance));
}

function simplifyClosedPolygon(points: Polygon, tolerance: number) {
  const polygon = cleanPolygon(points);
  if (polygon.length <= 8 || tolerance <= 0) return polygon;

  const bounds = polygonBounds(polygon);
  let startIndex = 0;
  let bestScore = Infinity;

  polygon.forEach((point, index) => {
    const score = point.x + point.y * 0.13 + (point.x - bounds.minX) * 0.001;
    if (score < bestScore) {
      bestScore = score;
      startIndex = index;
    }
  });

  const rotated = rotatePolygon(polygon, startIndex);
  const simplified = rdpOpen([...rotated, rotated[0]], tolerance).slice(0, -1);

  if (simplified.length < 6) return polygon.filter((_, index) => index % Math.ceil(polygon.length / 10) === 0);
  return cleanPolygon(simplified);
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

function getBounds(polygons: Polygon[]) {
  const bounds: Bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };

  polygons.forEach((polygon) => {
    polygon.forEach((point) => {
      bounds.minX = Math.min(bounds.minX, point.x);
      bounds.minY = Math.min(bounds.minY, point.y);
      bounds.maxX = Math.max(bounds.maxX, point.x);
      bounds.maxY = Math.max(bounds.maxY, point.y);
    });
  });

  if (!Number.isFinite(bounds.minX)) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }

  return bounds;
}

function transformCommand(command: GlyphCommand, transform: (point: Point) => Point) {
  if (command.type === 'Z') return 'Z';

  if (command.type === 'M' || command.type === 'L') {
    const point = transform(command);
    return `${command.type}${formatNumber(point.x)} ${formatNumber(point.y)}`;
  }

  if (command.type === 'Q') {
    const control = transform({ x: command.x1, y: command.y1 });
    const end = transform(command);
    return `Q${formatNumber(control.x)} ${formatNumber(control.y)} ${formatNumber(end.x)} ${formatNumber(end.y)}`;
  }

  if (command.type === 'C') {
    const controlA = transform({ x: command.x1, y: command.y1 });
    const controlB = transform({ x: command.x2, y: command.y2 });
    const end = transform(command);
    return `C${formatNumber(controlA.x)} ${formatNumber(controlA.y)} ${formatNumber(controlB.x)} ${formatNumber(controlB.y)} ${formatNumber(end.x)} ${formatNumber(end.y)}`;
  }

  return '';
}

function commandsToContours(commands: GlyphCommand[], transform: (point: Point) => Point = (point) => point) {
  const contours: Polygon[] = [];
  let contour: Polygon = [];
  let current: Point | null = null;
  let start: Point | null = null;

  function closeContour() {
    const cleaned = cleanPolygon(contour);
    if (cleaned.length >= 3 && Math.abs(polygonArea(cleaned)) > 0.01) contours.push(cleaned);
    contour = [];
    current = null;
    start = null;
  }

  commands.forEach((command) => {
    if (command.type === 'M') {
      closeContour();
      current = transform(command);
      start = current;
      contour.push(current);
      return;
    }

    if (!current) return;

    if (command.type === 'L') {
      current = transform(command);
      contour.push(current);
      return;
    }

    if (command.type === 'Q') {
      const control = transform({ x: command.x1, y: command.y1 });
      const end = transform(command);
      for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
        contour.push(pointOnQuadratic(current, control, end, step / CURVE_SEGMENTS));
      }
      current = end;
      return;
    }

    if (command.type === 'C') {
      const controlA = transform({ x: command.x1, y: command.y1 });
      const controlB = transform({ x: command.x2, y: command.y2 });
      const end = transform(command);
      for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
        contour.push(pointOnCubic(current, controlA, controlB, end, step / CURVE_SEGMENTS));
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

function buildPathForText(font: OpenTypeFont, text: string, fontSize: number) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const lineHeight = fontSize * 0.92;
  const commands: GlyphCommand[] = [];

  lines.forEach((line, lineIndex) => {
    const path = font.getPath(line || ' ', 0, lineIndex * lineHeight, fontSize);
    commands.push(...(path.commands ?? []));
  });

  return commands;
}

function makeTransform(rawBounds: Bounds, width: number, height: number) {
  const rawWidth = Math.max(rawBounds.maxX - rawBounds.minX, 1);
  const rawHeight = Math.max(rawBounds.maxY - rawBounds.minY, 1);
  const padding = Math.min(width, height) * 0.08;
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(availableWidth / rawWidth, availableHeight / rawHeight);
  const rawCenterX = rawBounds.minX + rawWidth / 2;
  const rawCenterY = rawBounds.minY + rawHeight / 2;

  return (point: Point) => ({
    x: width / 2 + (point.x - rawCenterX) * scale,
    y: height / 2 + (point.y - rawCenterY) * scale,
  });
}

async function loadFont(fontUrl: string) {
  const cached = FONT_CACHE.get(fontUrl);
  if (cached) return cached;

  const promise = (opentype as OpenTypeLoader).load(fontUrl);
  FONT_CACHE.set(fontUrl, promise);
  return promise;
}

export function glyphPathToPolygons(commands: GlyphCommand[], transform?: (point: Point) => Point): Polygon[] {
  return commandsToContours(commands, transform);
}

function pointOnSegment(point: Point, a: Point, b: Point) {
  const cross = (point.y - a.y) * (b.x - a.x) - (point.x - a.x) * (b.y - a.y);
  if (Math.abs(cross) > 0.001) return false;

  const dot = (point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y);
  if (dot < -0.001) return false;

  const lengthSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return dot <= lengthSq + 0.001;
}

function pointInsideRing(point: Point, ring: Polygon) {
  let inside = false;

  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index, index += 1) {
    const a = ring[index];
    const b = ring[previousIndex];

    if (pointOnSegment(point, a, b)) return true;

    const intersects = a.y > point.y !== b.y > point.y;
    if (!intersects) continue;

    const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (point.x < x) inside = !inside;
  }

  return inside;
}

function pointInsideGlyph(point: Point, contours: Polygon[]) {
  let inside = false;

  contours.forEach((contour) => {
    if (pointInsideRing(point, contour)) inside = !inside;
  });

  return inside;
}

function makeDensityFields(rng: () => number, bounds: Bounds, contours: Polygon[]) {
  const fields: { center: Point; radiusX: number; radiusY: number; weight: number }[] = [];
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const fieldPlan = [
    { count: 2, radius: 0.34, weight: 0.28 },
    { count: 3, radius: 0.18, weight: 0.48 },
    { count: 5, radius: 0.075, weight: 0.74 },
  ];
  let attempts = 0;

  fieldPlan.forEach((plan) => {
    let created = 0;

    while (created < plan.count && attempts < 1200) {
      attempts += 1;
      const center = {
        x: bounds.minX + rng() * width,
        y: bounds.minY + rng() * height,
      };

      if (!pointInsideGlyph(center, contours)) continue;
      if (distanceToGlyphBoundary(center, contours) < Math.min(width, height) * 0.035) continue;

      fields.push({
        center,
        radiusX: width * plan.radius * (0.75 + rng() * 0.65),
        radiusY: height * plan.radius * (0.75 + rng() * 0.65),
        weight: plan.weight * (0.75 + rng() * 0.55),
      });
      created += 1;
    }
  });

  return fields;
}

function densityAt(point: Point, fields: ReturnType<typeof makeDensityFields>, seed: number) {
  let density = 0.18;
  const phase = (seed % 997) * 0.013;

  fields.forEach((field) => {
    const dx = (point.x - field.center.x) / Math.max(1, field.radiusX);
    const dy = (point.y - field.center.y) / Math.max(1, field.radiusY);
    density += field.weight * Math.exp(-(dx * dx + dy * dy) / 2);
  });

  density += 0.13 * (0.5 + 0.5 * Math.sin(point.x * 0.011 + point.y * 0.004 + phase));
  return clamp(density, 0.1, 1);
}

function distanceScaleForWeight(weight: number) {
  if (weight >= 1.5) return 1.22;
  if (weight <= 0.7) return 0.62;
  return 0.86 + (weight - 0.8) * 0.22;
}

function randomSeedWeight(rng: () => number) {
  const roll = rng();

  if (roll < 0.7) return 0.8 + rng() * 0.4;
  if (roll < 0.9) return 1.5 + rng() * 1;
  return 0.4 + rng() * 0.3;
}

export function samplePointsInsidePolygon(
  contours: Polygon[],
  bounds: Bounds,
  count: number,
  seed: number | string,
  boundaryInset = 0,
): SeedPoint[] {
  const rng = createPrng(seed);
  const numericSeed = hashSeed(seed);
  const targetCount = Math.max(3, Math.floor(count));
  const fields = makeDensityFields(rng, bounds, contours);
  const points: SeedPoint[] = [];
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const nominalDistance = Math.sqrt((width * height) / Math.max(targetCount, 1));
  const baseMinDistance = clamp(nominalDistance * 0.18, 5, 64);
  let attempts = 0;
  const maxAttempts = targetCount * 2400;

  while (points.length < targetCount && attempts < maxAttempts) {
    attempts += 1;
    const point = {
      x: bounds.minX + rng() * width,
      y: bounds.minY + rng() * height,
    };

    if (!pointInsideGlyph(point, contours)) continue;
    const density = densityAt(point, fields, numericSeed);
    const attemptProgress = attempts / maxAttempts;
    const activeBoundaryInset = boundaryInset * clamp(1 - attemptProgress * 0.72, 0.26, 1);
    if (distanceToGlyphBoundary(point, contours) < activeBoundaryInset) continue;
    if (rng() > density) continue;

    const weight = randomSeedWeight(rng);
    const activeMinDistance = baseMinDistance * distanceScaleForWeight(weight) * clamp(1.15 - density * 0.48, 0.52, 1.05) * clamp(1 - attemptProgress * 0.55, 0.42, 1);
    if (points.some((existing) => distance(existing, point) < activeMinDistance * Math.min(1.05, distanceScaleForWeight(existing.weight)))) continue;

    points.push({
      ...point,
      weight,
      insetJitter: 0.75 + rng() * 0.5,
    });
  }

  let gridStep = Math.sqrt((width * height) / Math.max(targetCount, 1)) * 0.38;
  gridStep = clamp(gridStep, 4, Math.max(width, height));

  for (let y = bounds.minY; points.length < targetCount && y <= bounds.maxY; y += gridStep) {
    for (let x = bounds.minX; points.length < targetCount && x <= bounds.maxX; x += gridStep) {
      const jittered = {
        x: x + (rng() - 0.5) * gridStep * 0.55,
        y: y + (rng() - 0.5) * gridStep * 0.55,
      };

      if (
        pointInsideGlyph(jittered, contours) &&
        distanceToGlyphBoundary(jittered, contours) >= boundaryInset * 0.22
      ) {
        points.push({ ...jittered, weight: randomSeedWeight(rng), insetJitter: 0.75 + rng() * 0.5 });
      }
    }
  }

  return points;
}

export function buildVoronoi(points: Point[], bounds: Bounds, anisotropyX = 1, anisotropyY = 1): Polygon[] {
  const ax = Math.max(0.05, Math.abs(anisotropyX));
  const ay = Math.max(0.05, Math.abs(anisotropyY));
  const transformedPoints = points.map((point) => [point.x * ax, point.y * ay] as [number, number]);
  const delaunay = Delaunay.from(transformedPoints);
  const minX = Math.min(bounds.minX * ax, bounds.maxX * ax);
  const maxX = Math.max(bounds.minX * ax, bounds.maxX * ax);
  const minY = Math.min(bounds.minY * ay, bounds.maxY * ay);
  const maxY = Math.max(bounds.minY * ay, bounds.maxY * ay);
  const voronoi = delaunay.voronoi([minX, minY, maxX, maxY]);

  return points.map((_, index) => {
    const polygon = voronoi.cellPolygon(index);
    if (!polygon) return [];

    return cleanPolygon(
      polygon.map(([x, y]) => ({
        x: x / ax,
        y: y / ay,
      })),
    );
  });
}

function polygonToPath64(polygon: Polygon): Clipper2.Path64 {
  return cleanPolygon(polygon).map((point) => ({
    x: Math.round(point.x * CLIPPER_SCALE),
    y: Math.round(point.y * CLIPPER_SCALE),
  }));
}

function polygonsToPaths64(polygons: Polygon[]): Clipper2.Paths64 {
  return polygons
    .map((polygon) => polygonToPath64(polygon))
    .filter((path) => path.length >= 3);
}

function path64ToPolygon(path: Clipper2.Path64): Polygon {
  return cleanPolygon(
    path.map((point) => ({
      x: point.x / CLIPPER_SCALE,
      y: point.y / CLIPPER_SCALE,
    })),
  );
}

function cleanClipperPaths(paths: Clipper2.Paths64) {
  return Clipper2.simplifyPaths(paths, 4, true)
    .map((path) => Clipper2.stripDuplicates(path, true))
    .filter((path) => path.length >= 3 && Math.abs(Clipper2.area(path)) / (CLIPPER_SCALE * CLIPPER_SCALE) > 0.1);
}

export function clipPolygon(cell: Polygon, glyphPaths: Clipper2.Paths64): Clipper2.Paths64 {
  if (cell.length < 3) return [];
  const subject = polygonsToPaths64([cell]);
  return cleanClipperPaths(Clipper2.intersect(subject, glyphPaths, Clipper2.FillRule.EvenOdd));
}

export function polygonArea(polygon: Polygon) {
  let area = 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    area += current.x * next.y - next.x * current.y;
  }

  return area / 2;
}

function polygonPerimeter(polygon: Polygon) {
  return polygon.reduce((total, point, index) => total + distance(point, polygon[(index + 1) % polygon.length]), 0);
}

function polygonBounds(polygon: Polygon) {
  return getBounds([polygon]);
}

function pathArea(path: Clipper2.Path64) {
  return Clipper2.area(path) / (CLIPPER_SCALE * CLIPPER_SCALE);
}

function pathCentroid(path: Clipper2.Path64) {
  const polygon = path64ToPolygon(path);
  return polygonCentroid(polygon);
}

export function polygonCentroid(polygon: Polygon) {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const cross = current.x * next.y - next.x * current.y;
    twiceArea += cross;
    cx += (current.x + next.x) * cross;
    cy += (current.y + next.y) * cross;
  }

  if (Math.abs(twiceArea) < 0.0001) {
    const sum = polygon.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 });
    return {
      x: sum.x / Math.max(1, polygon.length),
      y: sum.y / Math.max(1, polygon.length),
    };
  }

  return {
    x: cx / (3 * twiceArea),
    y: cy / (3 * twiceArea),
  };
}

function compoundCentroid(paths: Clipper2.Paths64, fallback: Point) {
  let areaSum = 0;
  let xSum = 0;
  let ySum = 0;

  paths.forEach((path) => {
    const area = pathArea(path);
    const centroid = pathCentroid(path);
    areaSum += area;
    xSum += centroid.x * area;
    ySum += centroid.y * area;
  });

  if (Math.abs(areaSum) < 0.001) return fallback;

  return {
    x: xSum / areaSum,
    y: ySum / areaSum,
  };
}

function isValidPolygon(polygon: Polygon) {
  if (polygon.length < 3 || Math.abs(polygonArea(polygon)) < 0.01) return false;

  try {
    const flatPolygon = new Flatten.Polygon(polygon.map((point) => [point.x, point.y] as [number, number]));
    return flatPolygon.isValid() && flatPolygon.area() > 0.01;
  } catch {
    return false;
  }
}

function isUsableCellRing(polygon: Polygon, minArea: number, gap: number) {
  if (!isValidPolygon(polygon)) return false;

  const area = Math.abs(polygonArea(polygon));
  const bounds = polygonBounds(polygon);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const perimeter = polygonPerimeter(polygon);
  const compactness = perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;

  if (area < minArea * 0.42) return false;
  if (Math.min(width, height) < Math.max(5, gap * 0.7)) return false;
  if (compactness < 0.018 && area < minArea * 1.8) return false;

  return true;
}

export function offsetPolygon(paths: Clipper2.Paths64, gap: number, arcTolerance = DEFAULT_ARC_TOLERANCE): Clipper2.Paths64 {
  if (!paths.length || gap <= 0) return paths;

  const delta = -Math.round(gap * CLIPPER_SCALE);
  const scaledArcTolerance = Math.max(2, Math.round(Math.max(0.1, arcTolerance) * CLIPPER_SCALE));
  const inset = Clipper2.inflatePaths(
    paths,
    delta,
    Clipper2.JoinType.Round,
    Clipper2.EndType.Polygon,
    2,
    scaledArcTolerance,
  );

  return cleanClipperPaths(inset);
}

export function chaikinSubdivision(points: Polygon, passes = 1): Polygon {
  let result = cleanPolygon(points);
  const safePasses = Math.max(0, Math.min(3, Math.floor(passes)));

  for (let pass = 0; pass < safePasses; pass += 1) {
    if (result.length < 3) return result;

    const next: Polygon = [];
    for (let index = 0; index < result.length; index += 1) {
      const current = result[index];
      const following = result[(index + 1) % result.length];
      next.push({
        x: current.x * 0.75 + following.x * 0.25,
        y: current.y * 0.75 + following.y * 0.25,
      });
      next.push({
        x: current.x * 0.25 + following.x * 0.75,
        y: current.y * 0.25 + following.y * 0.75,
      });
    }
    result = next;
  }

  return result;
}

function localRadiusAt(points: Polygon, index: number) {
  const previous = points[(index - 1 + points.length) % points.length];
  const current = points[index];
  const next = points[(index + 1) % points.length];

  return Math.min(distance(current, previous), distance(current, next));
}

function resampleClosedPolygon(points: Polygon, targetSpacing: number) {
  const polygon = cleanPolygon(points);
  const perimeter = polygonPerimeter(polygon);
  const safeSpacing = Math.max(2, targetSpacing);

  if (polygon.length < 3 || perimeter <= safeSpacing * 3) return polygon;

  const targetCount = clamp(Math.round(perimeter / safeSpacing), 12, 96);
  const stepLength = perimeter / targetCount;
  const resampled: Polygon = [];
  let segmentIndex = 0;
  let segmentStart = polygon[0];
  let segmentEnd = polygon[1];
  let segmentLength = distance(segmentStart, segmentEnd);
  let traversed = 0;

  for (let sample = 0; sample < targetCount; sample += 1) {
    const targetDistance = sample * stepLength;

    while (traversed + segmentLength < targetDistance && segmentIndex < polygon.length + 1) {
      traversed += segmentLength;
      segmentIndex += 1;
      segmentStart = polygon[segmentIndex % polygon.length];
      segmentEnd = polygon[(segmentIndex + 1) % polygon.length];
      segmentLength = distance(segmentStart, segmentEnd);
    }

    const t = segmentLength <= 0.0001 ? 0 : clamp((targetDistance - traversed) / segmentLength, 0, 1);
    resampled.push({
      x: segmentStart.x + (segmentEnd.x - segmentStart.x) * t,
      y: segmentStart.y + (segmentEnd.y - segmentStart.y) * t,
    });
  }

  return cleanPolygon(resampled);
}

function smoothPeriodicValue(values: number[], index: number) {
  const count = values.length;
  return (
    values[(index - 2 + count) % count] * 0.08 +
    values[(index - 1 + count) % count] * 0.22 +
    values[index] * 0.4 +
    values[(index + 1) % count] * 0.22 +
    values[(index + 2) % count] * 0.08
  );
}

function blobifyPolygon(points: Polygon, amount: number, seed: number | string) {
  const polygon = cleanPolygon(points);
  const safeAmount = clamp(amount, 0, 0.32);

  if (polygon.length < 5 || safeAmount <= 0) return polygon;

  const rng = createPrng(seed);
  const centroid = polygonCentroid(polygon);
  const waves = Array.from({ length: polygon.length }, () => rng() * 2 - 1);
  const softenedWaves = waves.map((_, index) => smoothPeriodicValue(waves, index));

  return polygon.map((point, index) => {
    const radial = {
      x: point.x - centroid.x,
      y: point.y - centroid.y,
    };
    const radialLength = Math.hypot(radial.x, radial.y) || 1;
    const inward = {
      x: radial.x / radialLength,
      y: radial.y / radialLength,
    };
    const localRadius = localRadiusAt(polygon, index);
    const wave = smoothPeriodicValue(softenedWaves, index);
    const shrink = (0.35 + Math.abs(wave) * 0.65) * safeAmount * Math.min(localRadius * 1.8, radialLength * 0.09);

    return {
      x: point.x - inward.x * shrink,
      y: point.y - inward.y * shrink,
    };
  });
}

function moveToward(from: Point, to: Point, amount: number) {
  const length = distance(from, to);
  if (length <= 0.0001) return from;

  const ratio = clamp(amount / length, 0, 1);
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
}

export function polygonToSvgPath(polygon: Polygon) {
  const points = cleanPolygon(polygon);
  if (points.length < 3) return '';

  const [first, ...rest] = points;
  return `M${formatNumber(first.x)} ${formatNumber(first.y)}${rest
    .map((point) => `L${formatNumber(point.x)} ${formatNumber(point.y)}`)
    .join('')}Z`;
}

export function roundPolygonCorners(polygon: Polygon, smoothing = 1) {
  const points = cleanPolygon(polygon);
  const amount = clamp(smoothing, 0, 1);

  if (points.length < 3) return '';
  if (amount <= 0.001) return polygonToSvgPath(points);

  const tension = 0.095 + amount * 0.185;
  let d = `M${formatNumber(points[0].x)} ${formatNumber(points[0].y)}`;

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const afterNext = points[(index + 2) % points.length];
    const segmentLength = distance(current, next);
    const maxHandle = segmentLength * clamp(0.32 + amount * 0.28, 0.32, 0.6);
    const rawControlA = {
      x: current.x + (next.x - previous.x) * tension,
      y: current.y + (next.y - previous.y) * tension,
    };
    const rawControlB = {
      x: next.x - (afterNext.x - current.x) * tension,
      y: next.y - (afterNext.y - current.y) * tension,
    };
    const controlADistance = distance(current, rawControlA);
    const controlBDistance = distance(next, rawControlB);
    const controlA = controlADistance > maxHandle ? moveToward(current, rawControlA, maxHandle) : rawControlA;
    const controlB = controlBDistance > maxHandle ? moveToward(next, rawControlB, maxHandle) : rawControlB;

    d += `C${formatNumber(controlA.x)} ${formatNumber(controlA.y)} ${formatNumber(controlB.x)} ${formatNumber(controlB.y)} ${formatNumber(next.x)} ${formatNumber(next.y)}`;
  }

  return `${d}Z`;
}

function softenCellRing(ring: Polygon, options: { chaikinPasses: number; blobificationAmount: number; smoothing: number; seed: string }) {
  const initial = cleanPolygon(ring);
  if (initial.length < 3) return '';

  const perimeter = polygonPerimeter(initial);
  const simplification = clamp(perimeter / 72, 7, 26);
  const spacing = clamp(perimeter / 24, 12, 34);
  const simplified = simplifyClosedPolygon(initial, simplification);
  const softened = chaikinSubdivision(simplified, options.chaikinPasses);
  const secondaryResample = resampleClosedPolygon(softened, spacing);
  const blobified = blobifyPolygon(secondaryResample, options.blobificationAmount, options.seed);
  const finalSoftened = chaikinSubdivision(blobified, Math.max(1, Math.min(2, options.chaikinPasses)));

  return roundPolygonCorners(finalSoftened, options.smoothing);
}

function buildGlyphGeometry(font: OpenTypeFont, options: OrganicGlyphFillOptions): GlyphGeometry {
  const rawCommands = buildPathForText(font, options.text || 'D', Math.max(1, options.fontSize));
  const rawContours = commandsToContours(rawCommands);
  const rawBounds = getBounds(rawContours);
  const transform = makeTransform(rawBounds, Math.max(1, options.width), Math.max(1, options.height));
  const contours = glyphPathToPolygons(rawCommands, transform);
  const bounds = getBounds(contours);
  const glyphPath = rawCommands.map((command) => transformCommand(command, transform)).join('');

  return { contours, bounds, glyphPath };
}

function relaxSeeds(
  seeds: SeedPoint[],
  contours: Polygon[],
  glyphPaths: Clipper2.Paths64,
  bounds: Bounds,
  iterations: number,
  anisotropyX: number,
  anisotropyY: number,
) {
  let current = seeds;
  const safeIterations = Math.max(0, Math.floor(iterations));

  for (let iteration = 0; iteration < safeIterations; iteration += 1) {
    const cells = buildVoronoi(current, bounds, anisotropyX, anisotropyY);

    current = current.map((seed, index) => {
      const clipped = clipPolygon(cells[index] ?? [], glyphPaths);
      const centroid = compoundCentroid(clipped, seed);
      const pull = clamp(0.82 + (1.15 - seed.weight) * 0.08, 0.64, 0.92);
      const next = {
        x: seed.x + (centroid.x - seed.x) * pull,
        y: seed.y + (centroid.y - seed.y) * pull,
        weight: seed.weight,
        insetJitter: seed.insetJitter,
      };

      return pointInsideGlyph(next, contours) ? next : seed;
    });
  }

  return current;
}

function buildOrganicCells(
  seeds: SeedPoint[],
  glyphPaths: Clipper2.Paths64,
  bounds: Bounds,
  gap: number,
  anisotropyX: number,
  anisotropyY: number,
  glyphArea: number,
  arcTolerance: number,
  minAreaRatio: number,
) {
  const finalVoronoi = buildVoronoi(seeds, bounds, anisotropyX, anisotropyY);
  const cells: OrganicCell[] = [];
  const idealArea = Math.max(1, glyphArea / Math.max(1, seeds.length));
  const minCellArea = Math.max(MIN_CELL_AREA, glyphArea * minAreaRatio);

  finalVoronoi.forEach((cell, index) => {
    const clipped = clipPolygon(cell, glyphPaths);
    const clippedArea = Math.abs(Clipper2.areaPaths(clipped)) / (CLIPPER_SCALE * CLIPPER_SCALE);
    const seed = seeds[index];
    const sizeBoost = 1 + clamp((clippedArea / idealArea - 1) * 0.12, -0.1, 0.24);
    const cellGap = gap * (seed?.insetJitter ?? 1) * sizeBoost;
    const inset = offsetPolygon(clipped, cellGap, arcTolerance);

    if (clippedArea < minCellArea * 0.65) return;

    const rings = inset
      .map((path) => path64ToPolygon(path))
      .filter((polygon) => isUsableCellRing(polygon, minCellArea, cellGap));

    if (!rings.length) return;

    const area = rings.reduce((total, ring) => total + Math.abs(polygonArea(ring)), 0);
    if (area < minCellArea) return;

    cells.push({
      id: `cell-${index}`,
      rings,
      area,
    });
  });

  return cells;
}

export function generateSvg(
  options: OrganicGlyphFillOptions,
  glyphPath: string,
  cells: OrganicCell[],
) {
  const width = Math.max(1, options.width);
  const height = Math.max(1, options.height);
  const smoothing = Number(options.smoothing);
  const chaikinPasses = Math.max(0, Math.min(3, Math.floor(options.chaikinPasses ?? 1)));
  const blobificationAmount = options.blobificationAmount ?? DEFAULT_BLOBIFICATION_AMOUNT;
  const foregroundColor = options.foregroundColor || '#30363a';
  const glyphColor = options.glyphColor || DEFAULT_GLYPH_COLOR;
  const backgroundColor = options.backgroundColor || '#ff6a00';
  const cellPaths = cells
    .map((cell) => {
      const d = cell.rings
        .map((ring, ringIndex) => {
          return softenCellRing(ring, {
            chaikinPasses,
            blobificationAmount,
            smoothing,
            seed: `${options.seed}-${cell.id}-${ringIndex}`,
          });
        })
        .join('');

      if (!d) return '';

      return `<path d="${d}" fill="${escapeAttribute(foregroundColor)}" fill-rule="evenodd"/>`;
    })
    .filter(Boolean)
    .join('');

  return [
    `<svg class="type-svg organic-glyph-fill-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${formatNumber(width)} ${formatNumber(height)}" width="${formatNumber(width)}" height="${formatNumber(height)}" role="img" aria-label="${escapeAttribute(String(options.text || 'glyph'))} filled with rounded organic cells">`,
    `<rect x="0" y="0" width="${formatNumber(width)}" height="${formatNumber(height)}" fill="${escapeAttribute(backgroundColor)}"/>`,
    `<path d="${glyphPath}" fill="${escapeAttribute(glyphColor)}" fill-rule="evenodd"/>`,
    `<g class="organic-glyph-fill__cells">${cellPaths}</g>`,
    '</svg>',
  ].join('');
}

export async function generateOrganicGlyphFill(options: OrganicGlyphFillOptions): Promise<string> {
  const font = await loadFont(options.fontUrl);
  const geometry = buildGlyphGeometry(font, options);
  const glyphPaths = polygonsToPaths64(geometry.contours);
  const targetCellCount = clamp(Math.floor(options.cellCount), 3, 120);
  const baseGap = Math.max(0, options.gap);
  const anisotropyX = options.anisotropyX ?? 1.6;
  const anisotropyY = options.anisotropyY ?? 0.7;
  const arcTolerance = options.arcTolerance ?? DEFAULT_ARC_TOLERANCE;
  const minAreaRatio = options.minAreaRatio ?? DEFAULT_MIN_AREA_RATIO;
  const boundaryMargin = options.boundaryMargin ?? DEFAULT_BOUNDARY_MARGIN;
  const lloydIterations = clamp(Math.floor(options.lloydIterations), 0, 24);
  const glyphArea = Math.max(
    1,
    Math.abs(Clipper2.areaPaths(glyphPaths)) / (CLIPPER_SCALE * CLIPPER_SCALE),
  );
  const boundaryInset = Math.max(boundaryMargin, baseGap * 1.5, Math.sqrt(glyphArea / targetCellCount) * 0.08);
  let bestCells: OrganicCell[] = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attemptCellCount = Math.min(targetCellCount + attempt * 2, targetCellCount + 4);
    const attemptSeed = attempt === 0 ? options.seed : `${options.seed}-${attempt}`;
    const seedPoints = samplePointsInsidePolygon(
      geometry.contours,
      geometry.bounds,
      attemptCellCount,
      attemptSeed,
      boundaryInset * (1 - attempt * 0.22),
    );
    const relaxedSeeds = relaxSeeds(
      seedPoints,
      geometry.contours,
      glyphPaths,
      geometry.bounds,
      lloydIterations,
      anisotropyX,
      anisotropyY,
    );
    const cells = buildOrganicCells(
      relaxedSeeds,
      glyphPaths,
      geometry.bounds,
      baseGap,
      anisotropyX,
      anisotropyY,
      glyphArea,
      arcTolerance,
      minAreaRatio,
    );

    if (cells.length > bestCells.length) bestCells = cells;
    if (cells.length >= Math.max(3, Math.floor(targetCellCount * 0.72))) {
      bestCells = cells;
      break;
    }
  }

  return generateSvg(options, geometry.glyphPath, bestCells);
}
