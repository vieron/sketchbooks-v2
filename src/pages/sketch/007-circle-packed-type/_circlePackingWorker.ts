type Bounds = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type Point = {
  x: number;
  y: number;
};

type GlyphLayout = {
  id: string;
  glyphIndex: number;
  lineIndex: number;
  d: string;
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

type RandomSource = {
  next(min?: number, max?: number): number;
};

type SampleOffset = {
  x: number;
  y: number;
};

type CircleSpatialGrid = {
  cellSize: number;
  cells: Map<string, PackedCircle[]>;
};

type PackGlyphRequest = {
  type: 'pack';
  requestId: number;
  index: number;
  glyph: GlyphLayout;
  options: PackingOptions;
};

type WorkerScope = typeof self & {
  onmessage: ((event: MessageEvent<PackGlyphRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const MAX_BINARY_STEPS = 10;
const EMPTY_ROUND_LIMIT = 72;
const edgeOffsetCache = new Map<number, SampleOffset[]>();
let cachedContext: OffscreenCanvasRenderingContext2D | null | undefined;

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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function mix(left: number, right: number, amount: number) {
  return left + (right - left) * amount;
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

function getEdgeOffsets(samples: number) {
  const key = Math.max(8, Math.round(samples));
  const cached = edgeOffsetCache.get(key);
  if (cached) return cached;

  const offsets = createEdgeOffsets(key);
  edgeOffsetCache.set(key, offsets);
  return offsets;
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

function pointIsInside(context: OffscreenCanvasRenderingContext2D, path: Path2D, x: number, y: number) {
  return context.isPointInPath(path, x, y, 'nonzero');
}

function circleFitsPath(
  context: OffscreenCanvasRenderingContext2D,
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
  context: OffscreenCanvasRenderingContext2D,
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

function variedRadius(radiusLimit: number, random: RandomSource, options: PackingOptions, variation: number, power: number) {
  const largestRadius = Math.max(options.minRadius, radiusLimit * options.tightness);
  const shrink = variation * (1 - Math.pow(random.next(), power));
  return mix(largestRadius, options.minRadius, shrink);
}

function packGlyph(
  context: OffscreenCanvasRenderingContext2D,
  glyph: GlyphLayout,
  options: PackingOptions,
) {
  const path = new Path2D(glyph.d);
  const random = createRandom(options.seed + glyph.lineIndex * 1009 + glyph.glyphIndex * 337);
  const edgeOffsets = getEdgeOffsets(options.edgeSamples);
  const grid = createCircleGrid(options.maxRadius, options.gap);
  const candidateCount = Math.max(1, Math.round(options.candidates));
  const variation = clamp(options.variation, 0, 1);
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

function packCircleData(circles: PackedCircle[]) {
  const circleData = new Float32Array(circles.length * 3);

  circles.forEach((circle, index) => {
    const offset = index * 3;
    circleData[offset] = circle.x;
    circleData[offset + 1] = circle.y;
    circleData[offset + 2] = circle.r;
  });

  return circleData;
}

function getContext() {
  if (cachedContext !== undefined) return cachedContext;

  if (typeof OffscreenCanvas === 'undefined' || typeof Path2D === 'undefined') {
    cachedContext = null;
    return cachedContext;
  }

  cachedContext = new OffscreenCanvas(1, 1).getContext('2d');
  return cachedContext;
}

const workerScope = self as WorkerScope;

workerScope.onmessage = (event: MessageEvent<PackGlyphRequest>) => {
  const message = event.data;
  if (message.type !== 'pack') return;

  const context = getContext();
  if (!context) {
    workerScope.postMessage({
      type: 'unsupported',
      requestId: message.requestId,
      index: message.index,
      message: 'Path2D or OffscreenCanvas is unavailable inside this worker.',
    });
    return;
  }

  try {
    const circleData = packCircleData(packGlyph(context, message.glyph, message.options));
    workerScope.postMessage({
      type: 'result',
      requestId: message.requestId,
      index: message.index,
      circleData,
    }, [circleData.buffer]);
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      requestId: message.requestId,
      index: message.index,
      message: error instanceof Error ? error.message : 'Packing worker failed.',
    });
  }
};

export {};
