import { Clipper, FillRule, type Path64, Paths64 } from 'clipper2-js';
import { formatPathNumber } from './_opentype';
import type { Point, SlicePolygons } from './_types';

export function polygonToPath(points: Point[]) {
  if (!points.length) return '';
  const [firstPoint, ...restPoints] = points;
  if (!firstPoint) return '';

  return [
    `M${formatPathNumber(firstPoint.x)} ${formatPathNumber(firstPoint.y)}`,
    ...restPoints.map((point) => `L${formatPathNumber(point.x)} ${formatPathNumber(point.y)}`),
    'Z',
  ].join('');
}

function path64ToPoints(path: Path64): Point[] {
  return path.map((point) => ({ x: point.x, y: point.y }));
}

export function getSliceProjectionBoundaries(sliceCount: number, angle: number, phase: number, width: number, height: number) {
  const slices = Math.max(1, Math.round(sliceCount));
  const radians = (angle * Math.PI) / 180;
  const normal = { x: -Math.sin(radians), y: Math.cos(radians) };
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const projections = corners.map((corner) => corner.x * normal.x + corner.y * normal.y);
  const minProjection = Math.min(...projections) - 2;
  const maxProjection = Math.max(...projections) + 2;
  const bandSize = (maxProjection - minProjection) / slices;
  const shiftedPhase = Math.max(-0.99, Math.min(0.99, Number(phase) || 0));

  return [
    minProjection,
    ...Array.from({ length: slices - 1 }, (_, index) => minProjection + bandSize * (index + 1 + shiftedPhase)),
    maxProjection,
  ];
}

export function getSlicePolygons(
  sliceCount: number,
  angle: number,
  phase: number,
  maskPaddingX: number,
  maskPaddingY: number,
  width: number,
  height: number,
): SlicePolygons {
  const slices = Math.max(1, Math.round(sliceCount));

  if (slices === 1) {
    return [[[
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ]]];
  }

  const radians = (angle * Math.PI) / 180;
  const direction = { x: Math.cos(radians), y: Math.sin(radians) };
  const normal = { x: -Math.sin(radians), y: Math.cos(radians) };
  const boundaries = getSliceProjectionBoundaries(slices, angle, phase, width, height);
  const far = Math.hypot(width, height) * 2;
  const stage = new Paths64();
  stage.push(Clipper.makePath([
    -Math.max(0, maskPaddingX),
    -Math.max(0, maskPaddingY),
    width + Math.max(0, maskPaddingX),
    -Math.max(0, maskPaddingY),
    width + Math.max(0, maskPaddingX),
    height + Math.max(0, maskPaddingY),
    -Math.max(0, maskPaddingX),
    height + Math.max(0, maskPaddingY),
  ]));

  return Array.from({ length: slices }, (_, index) => {
    const start = boundaries[index] ?? boundaries[0] ?? 0;
    const end = boundaries[index + 1] ?? boundaries.at(-1) ?? 0;
    const band = new Paths64();

    band.push(Clipper.makePath([
      normal.x * start - direction.x * far,
      normal.y * start - direction.y * far,
      normal.x * start + direction.x * far,
      normal.y * start + direction.y * far,
      normal.x * end + direction.x * far,
      normal.y * end + direction.y * far,
      normal.x * end - direction.x * far,
      normal.y * end - direction.y * far,
    ]));

    return Clipper.Intersect(stage, band, FillRule.NonZero).map(path64ToPoints);
  });
}
