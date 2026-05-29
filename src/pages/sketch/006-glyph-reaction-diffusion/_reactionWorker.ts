type GridBounds = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type MaskGeometry = {
  width: number;
  height: number;
  mask: Uint8Array;
  edge: Uint8Array;
  distance: Uint16Array;
  boundaryBleed: number;
  boundarySeed: number;
  activeBounds: GridBounds;
  active: Int32Array;
  neighbors: Int32Array;
};

type ReactionSimulation = {
  geometry: MaskGeometry;
  u: Float32Array;
  v: Float32Array;
  nextU: Float32Array;
  nextV: Float32Array;
};

type SeedMode = 'walls' | 'islands' | 'both';

type ReactionSettings = {
  feed: number;
  kill: number;
};

type DrawingSettings = {
  contrast: number;
  threshold: number;
  band: number;
  weight: number;
  smooth: number;
};

type GridPoint = {
  x: number;
  y: number;
};

type Bounds = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type ReactionWorkerRequest = {
  jobId: number;
  glyphIndex: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  cellSize: number;
  glyphBounds: Bounds[];
  glyphMask: Uint8Array;
  settings: ReactionSettings;
  seedMode: SeedMode;
  seed: number;
  birth: number;
  steps: number;
  boundaryBleed: number;
  drawing: DrawingSettings;
};

type ReactionWorkerResponse = {
  jobId: number;
  glyphIndex: number;
  inkPath: string;
};

const DEFAULT_DIFFUSION_B = 0.5;
const CONVERGENCE_CHECK_INTERVAL = 80;
const MIN_CONVERGENCE_STEPS = 960;
const CONVERGENCE_MAX_DELTA = 0.000012;
const NEIGHBOR_COUNT = 8;
const NEIGHBOR_OFFSETS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

function pathNumber(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mix(a: number, b: number, amount: number) {
  return a + (b - a) * amount;
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const amount = clamp((value - edge0) / Math.max(edge1 - edge0, 0.000001), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function mulberry32(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function hashNoise(x: number, y: number, seed: number) {
  let value = Math.imul(x + seed * 374761393, 668265263) ^ Math.imul(y + seed * 1274126177, 2246822519);
  value = Math.imul(value ^ (value >>> 13), 3266489917);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, scale: number, seed: number) {
  const scaledX = x / scale;
  const scaledY = y / scale;
  const left = Math.floor(scaledX);
  const top = Math.floor(scaledY);
  const amountX = smoothstep(0, 1, scaledX - left);
  const amountY = smoothstep(0, 1, scaledY - top);
  const topMix = mix(hashNoise(left, top, seed), hashNoise(left + 1, top, seed), amountX);
  const bottomMix = mix(hashNoise(left, top + 1, seed), hashNoise(left + 1, top + 1, seed), amountX);

  return mix(topMix, bottomMix, amountY);
}

function organicBoundaryNoise(x: number, y: number, seed: number) {
  return clamp(
    valueNoise(x, y, 34, seed) * 0.52 +
      valueNoise(x + 31.7, y - 19.3, 15, seed + 17) * 0.34 +
      valueNoise(x - 8.5, y + 42.1, 72, seed + 41) * 0.14,
    0,
    1,
  );
}

function getNeighborIndex(mask: Uint8Array, width: number, height: number, index: number, dx: number, dy: number) {
  const x = index % width;
  const y = Math.floor(index / width);
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || nx >= width || ny < 0 || ny >= height) return index;

  const neighbor = ny * width + nx;
  return mask[neighbor] ? neighbor : index;
}

function boundaryChangesAt(boundaryMask: Uint8Array, width: number, height: number, index: number) {
  const x = index % width;
  const y = Math.floor(index / width);
  const value = boundaryMask[index];

  for (let offsetIndex = 0; offsetIndex < NEIGHBOR_OFFSETS.length; offsetIndex += 1) {
    const [dx, dy] = NEIGHBOR_OFFSETS[offsetIndex];
    const nx = x + dx;
    const ny = y + dy;

    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
    if (boundaryMask[ny * width + nx] !== value) return true;
  }

  return false;
}

function buildMaskGeometry(
  mask: Uint8Array,
  width: number,
  height: number,
  boundaryMask: Uint8Array,
  distance: Uint16Array,
  boundaryBleed: number,
  boundarySeed: number,
): MaskGeometry {
  const activeList: number[] = [];
  const edge = new Uint8Array(mask.length);
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;

    const x = index % width;
    const y = Math.floor(index / width);
    activeList.push(index);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const active = Int32Array.from(activeList);
  const neighbors = new Int32Array(active.length * NEIGHBOR_COUNT);
  const activeBounds = active.length > 0
    ? { x1: minX, y1: minY, x2: maxX, y2: maxY }
    : { x1: 0, y1: 0, x2: 0, y2: 0 };

  for (let activeIndex = 0; activeIndex < active.length; activeIndex += 1) {
    const index = active[activeIndex];
    const base = activeIndex * NEIGHBOR_OFFSETS.length;

    for (let offsetIndex = 0; offsetIndex < NEIGHBOR_OFFSETS.length; offsetIndex += 1) {
      const [dx, dy] = NEIGHBOR_OFFSETS[offsetIndex];
      neighbors[base + offsetIndex] = getNeighborIndex(mask, width, height, index, dx, dy);
    }

    edge[index] = boundaryChangesAt(boundaryMask, width, height, index) ? 1 : 0;
  }

  return { width, height, mask, edge, distance, boundaryBleed, boundarySeed, activeBounds, active, neighbors };
}

function expandMaskWithDistance(mask: Uint8Array, width: number, height: number, radius: number) {
  const maxDistance = 65535;
  const iterations = Math.max(0, Math.round(radius));
  const expanded = new Uint8Array(mask);
  const distance = new Uint16Array(mask.length);
  let frontier: number[] = [];

  distance.fill(maxDistance);

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    distance[index] = 0;
    frontier.push(index);
  }

  for (let step = 1; step <= iterations && frontier.length > 0; step += 1) {
    const nextFrontier: number[] = [];

    for (let frontierIndex = 0; frontierIndex < frontier.length; frontierIndex += 1) {
      const index = frontier[frontierIndex];
      const x = index % width;
      const y = Math.floor(index / width);

      for (let offsetIndex = 0; offsetIndex < NEIGHBOR_OFFSETS.length; offsetIndex += 1) {
        const [dx, dy] = NEIGHBOR_OFFSETS[offsetIndex];
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

        const neighbor = ny * width + nx;
        if (distance[neighbor] !== maxDistance) continue;

        distance[neighbor] = step;
        expanded[neighbor] = 1;
        nextFrontier.push(neighbor);
      }
    }

    frontier = nextFrontier;
  }

  return { mask: expanded, distance };
}

function distanceToBoundsSquared(x: number, y: number, bounds: Bounds) {
  const dx = x < bounds.x1 ? bounds.x1 - x : x > bounds.x2 ? x - bounds.x2 : 0;
  const dy = y < bounds.y1 ? bounds.y1 - y : y > bounds.y2 ? y - bounds.y2 : 0;

  return dx * dx + dy * dy;
}

function applyGlyphOwnershipMask(
  expandedMask: Uint8Array,
  glyphMask: Uint8Array,
  width: number,
  request: ReactionWorkerRequest,
) {
  const ownedMask = new Uint8Array(expandedMask.length);

  for (let index = 0; index < expandedMask.length; index += 1) {
    if (!expandedMask[index]) continue;
    if (glyphMask[index]) {
      ownedMask[index] = 1;
      continue;
    }

    const x = request.originX + ((index % width) + 0.5) * request.cellSize;
    const y = request.originY + (Math.floor(index / width) + 0.5) * request.cellSize;
    let nearestGlyphIndex = request.glyphIndex;
    let nearestDistance = Infinity;

    for (let glyphIndex = 0; glyphIndex < request.glyphBounds.length; glyphIndex += 1) {
      const distance = distanceToBoundsSquared(x, y, request.glyphBounds[glyphIndex]);
      if (distance >= nearestDistance) continue;

      nearestGlyphIndex = glyphIndex;
      nearestDistance = distance;
    }

    if (nearestGlyphIndex === request.glyphIndex) ownedMask[index] = 1;
  }

  return ownedMask;
}

function createReactionGeometry(request: ReactionWorkerRequest) {
  const { width, height, glyphMask, boundaryBleed, seed } = request;
  const simulationBleed = boundaryBleed <= 0 ? 0 : Math.round(boundaryBleed * 1.85 + 8);
  const { mask: activeMask, distance } = expandMaskWithDistance(glyphMask, width, height, simulationBleed);
  const ownedMask = applyGlyphOwnershipMask(activeMask, glyphMask, width, request);
  return buildMaskGeometry(ownedMask, width, height, glyphMask, distance, boundaryBleed, seed);
}

function seedPatch(
  geometry: MaskGeometry,
  u: Float32Array,
  v: Float32Array,
  center: number,
  radius: number,
  rng: () => number,
) {
  const { width, height, mask } = geometry;
  const centerX = center % width;
  const centerY = Math.floor(center / width);
  const radiusCeil = Math.ceil(radius);

  for (let dy = -radiusCeil; dy <= radiusCeil; dy += 1) {
    const y = centerY + dy;
    if (y < 0 || y >= height) continue;

    for (let dx = -radiusCeil; dx <= radiusCeil; dx += 1) {
      const x = centerX + dx;
      if (x < 0 || x >= width) continue;

      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;

      const index = y * width + x;
      if (!mask[index]) continue;

      const falloff = 1 - distance / Math.max(radius, 1);
      u[index] = Math.min(u[index], 0.32 + rng() * 0.16 + (1 - falloff) * 0.18);
      v[index] = Math.max(v[index], 0.34 + falloff * 0.42 + rng() * 0.07);
    }
  }
}

function createSimulation(geometry: MaskGeometry, seed: number, seedMode: SeedMode, density: number) {
  const { width, height, active, edge } = geometry;
  const count = width * height;
  const u = new Float32Array(count);
  const v = new Float32Array(count);
  const nextU = new Float32Array(count);
  const nextV = new Float32Array(count);
  const rng = mulberry32(seed);

  u.fill(1);
  nextU.fill(1);

  if ((seedMode === 'walls' || seedMode === 'both') && active.length > 0) {
    const wallChance = 0.06 + density * 0.3;

    for (let activeIndex = 0; activeIndex < active.length; activeIndex += 1) {
      const index = active[activeIndex];
      if (!edge[index] || rng() > wallChance) continue;
      u[index] = 0.42 + rng() * 0.12;
      v[index] = 0.34 + rng() * 0.3;
    }
  }

  if ((seedMode === 'islands' || seedMode === 'both') && active.length > 0) {
    const clusterCount = Math.max(10, Math.round((active.length / 640) * density));
    const maxRadius = Math.max(2.5, Math.min(width, height) * (0.008 + density * 0.017));

    for (let index = 0; index < clusterCount; index += 1) {
      const center = active[Math.floor(rng() * active.length)];
      seedPatch(geometry, u, v, center, 2 + rng() * maxRadius, rng);
    }

    const scatterChance = 0.0022 + density * 0.0082;
    for (let activeIndex = 0; activeIndex < active.length; activeIndex += 1) {
      const index = active[activeIndex];
      if (edge[index] || rng() > scatterChance) continue;
      seedPatch(geometry, u, v, index, 1 + rng() * 3.5, rng);
    }
  }

  for (let activeIndex = 0; activeIndex < active.length; activeIndex += 1) {
    const index = active[activeIndex];
    const noise = (rng() - 0.5) * 0.028;
    u[index] = clamp(u[index] + noise, 0, 1);
    v[index] = clamp(v[index] - noise * 0.4, 0, 1);
  }

  return { geometry, u, v, nextU, nextV } satisfies ReactionSimulation;
}

function stepSimulation(simulation: ReactionSimulation, feed: number, kill: number) {
  const { active, neighbors } = simulation.geometry;
  const { u, v, nextU, nextV } = simulation;
  const killFeed = kill + feed;

  for (let activeIndex = 0; activeIndex < active.length; activeIndex += 1) {
    const index = active[activeIndex];
    const uCenter = u[index];
    const vCenter = v[index];
    const base = activeIndex * NEIGHBOR_COUNT;
    const left = neighbors[base];
    const right = neighbors[base + 1];
    const top = neighbors[base + 2];
    const bottom = neighbors[base + 3];
    const topLeft = neighbors[base + 4];
    const topRight = neighbors[base + 5];
    const bottomLeft = neighbors[base + 6];
    const bottomRight = neighbors[base + 7];
    const laplaceU =
      -uCenter +
      0.2 * (u[left] + u[right] + u[top] + u[bottom]) +
      0.05 * (u[topLeft] + u[topRight] + u[bottomLeft] + u[bottomRight]);
    const laplaceV =
      -vCenter +
      0.2 * (v[left] + v[right] + v[top] + v[bottom]) +
      0.05 * (v[topLeft] + v[topRight] + v[bottomLeft] + v[bottomRight]);
    const reaction = uCenter * vCenter * vCenter;
    let nextUValue = uCenter + laplaceU - reaction + feed * (1 - uCenter);
    let nextVValue = vCenter + DEFAULT_DIFFUSION_B * laplaceV + reaction - killFeed * vCenter;

    if (nextUValue < 0) nextUValue = 0;
    else if (nextUValue > 1) nextUValue = 1;

    if (nextVValue < 0) nextVValue = 0;
    else if (nextVValue > 1) nextVValue = 1;

    nextU[index] = nextUValue;
    nextV[index] = nextVValue;
  }

  simulation.u = nextU;
  simulation.v = nextV;
  simulation.nextU = u;
  simulation.nextV = v;
}

function measureSimulationDelta(simulation: ReactionSimulation) {
  const { active } = simulation.geometry;
  const { u, v, nextU: previousU, nextV: previousV } = simulation;
  let maxDelta = 0;

  for (let activeIndex = 0; activeIndex < active.length; activeIndex += 1) {
    const index = active[activeIndex];
    const deltaU = u[index] >= previousU[index] ? u[index] - previousU[index] : previousU[index] - u[index];
    const deltaV = v[index] >= previousV[index] ? v[index] - previousV[index] : previousV[index] - v[index];
    if (deltaU > maxDelta) maxDelta = deltaU;
    if (deltaV > maxDelta) maxDelta = deltaV;
  }

  return maxDelta;
}

function buildInkField(simulation: ReactionSimulation, drawing: DrawingSettings) {
  const { active, boundaryBleed, boundarySeed, distance, mask, width } = simulation.geometry;
  const inkField = new Float32Array(mask.length);

  for (let activeIndex = 0; activeIndex < active.length; activeIndex += 1) {
    const index = active[activeIndex];

    const x = index % width;
    const y = Math.floor(index / width);
    const baseInk = clamp(simulation.v[index] * drawing.contrast + (1 - simulation.u[index]) * 0.22, 0, 1);
    const edgeDistance = distance[index];
    const envelope = edgeDistance === 0 || boundaryBleed <= 0
      ? 1
      : (() => {
        const noise = organicBoundaryNoise(x, y, boundarySeed);
        const localBleed = Math.max(1, boundaryBleed * (0.58 + noise * 0.82));
        const fadeStart = localBleed * 0.24;
        return 1 - smoothstep(fadeStart, localBleed, edgeDistance);
      })();

    if (envelope <= 0.001) continue;
    inkField[index] = baseInk * envelope;
  }

  return inkField;
}

function gridPointKey(point: GridPoint) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
}

function addSegment(
  segments: { start: GridPoint; end: GridPoint }[],
  edgesByPoint: Map<string, number[]>,
  start: GridPoint,
  end: GridPoint,
) {
  const index = segments.length;
  segments.push({ start, end });

  [start, end].forEach((point) => {
    const key = gridPointKey(point);
    const edges = edgesByPoint.get(key);
    if (edges) {
      edges.push(index);
    } else {
      edgesByPoint.set(key, [index]);
    }
  });
}

function interpolatePoint(a: GridPoint, b: GridPoint, valueA: number, valueB: number, iso: number) {
  const amount = Math.abs(valueA - valueB) < 0.000001
    ? 0.5
    : clamp((iso - valueA) / (valueB - valueA), 0, 1);

  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
  };
}

function polygonArea(points: GridPoint[]) {
  let area = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }

  return area / 2;
}

function distanceToSegment(point: GridPoint, start: GridPoint, end: GridPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared <= 0.000001) return Math.hypot(point.x - start.x, point.y - start.y);

  const amount = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  const projected = {
    x: start.x + dx * amount,
    y: start.y + dy * amount,
  };

  return Math.hypot(point.x - projected.x, point.y - projected.y);
}

function simplifyContour(points: GridPoint[], tolerance: number) {
  if (points.length < 8 || tolerance <= 0) return points;

  const simplified: GridPoint[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const turn = distanceToSegment(current, previous, next);

    if (turn > tolerance || index % 5 === 0) {
      simplified.push(current);
    }
  }

  return simplified.length >= 4 ? simplified : points;
}

function scalePoint(point: GridPoint, request: ReactionWorkerRequest) {
  return {
    x: request.originX + point.x * request.cellSize,
    y: request.originY + point.y * request.cellSize,
  };
}

function buildSmoothedContourPath(
  points: GridPoint[],
  request: ReactionWorkerRequest,
  smooth: number,
) {
  if (points.length < 3 || Math.abs(polygonArea(points)) < 0.45) return '';

  const smoothing = clamp(smooth, 0, 1);
  const simplified = simplifyContour(points, 0.16 + smoothing * 0.18);
  const scaled = simplified.map((point) => scalePoint(point, request));

  if (smoothing <= 0.001 || scaled.length < 4) {
    const [first, ...rest] = scaled;
    return `M${pathNumber(first.x)} ${pathNumber(first.y)}${
      rest.map((point) => `L${pathNumber(point.x)} ${pathNumber(point.y)}`).join('')
    }Z`;
  }

  const first = scaled[0];
  const pieces = [`M${pathNumber(first.x)} ${pathNumber(first.y)}`];
  const tension = smoothing;

  for (let index = 0; index < scaled.length; index += 1) {
    const previous = scaled[(index - 1 + scaled.length) % scaled.length];
    const current = scaled[index];
    const next = scaled[(index + 1) % scaled.length];
    const afterNext = scaled[(index + 2) % scaled.length];
    const controlA = {
      x: current.x + ((next.x - previous.x) * tension) / 6,
      y: current.y + ((next.y - previous.y) * tension) / 6,
    };
    const controlB = {
      x: next.x - ((afterNext.x - current.x) * tension) / 6,
      y: next.y - ((afterNext.y - current.y) * tension) / 6,
    };

    pieces.push(
      `C${pathNumber(controlA.x)} ${pathNumber(controlA.y)} ${pathNumber(controlB.x)} ${pathNumber(controlB.y)} ${pathNumber(next.x)} ${pathNumber(next.y)}`,
    );
  }

  pieces.push('Z');
  return pieces.join('');
}

function buildContourPath(
  inkField: Float32Array,
  geometry: MaskGeometry,
  request: ReactionWorkerRequest,
  smooth: number,
  iso: number,
) {
  const { active, activeBounds, width, height } = geometry;
  const segments: { start: GridPoint; end: GridPoint }[] = [];
  const edgesByPoint = new Map<string, number[]>();
  const remaining = new Set<number>();

  if (active.length === 0) return '';

  function valueAt(x: number, y: number) {
    return inkField[y * width + x] ?? 0;
  }

  const minX = Math.max(0, activeBounds.x1 - 1);
  const minY = Math.max(0, activeBounds.y1 - 1);
  const maxX = Math.min(width - 2, activeBounds.x2 + 1);
  const maxY = Math.min(height - 2, activeBounds.y2 + 1);

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const cornerPoints = [
        { x: x + 0.5, y: y + 0.5 },
        { x: x + 1.5, y: y + 0.5 },
        { x: x + 1.5, y: y + 1.5 },
        { x: x + 0.5, y: y + 1.5 },
      ];
      const cornerValues = [
        valueAt(x, y),
        valueAt(x + 1, y),
        valueAt(x + 1, y + 1),
        valueAt(x, y + 1),
      ];
      const inside = cornerValues.map((value) => value >= iso);
      const caseIndex =
        (inside[0] ? 1 : 0) |
        (inside[1] ? 2 : 0) |
        (inside[2] ? 4 : 0) |
        (inside[3] ? 8 : 0);

      if (caseIndex === 0 || caseIndex === 15) continue;

      const intersections: GridPoint[] = [];
      const addIntersection = (from: number, to: number) => {
        intersections.push(interpolatePoint(
          cornerPoints[from],
          cornerPoints[to],
          cornerValues[from],
          cornerValues[to],
          iso,
        ));
      };

      if (inside[0] !== inside[1]) addIntersection(0, 1);
      if (inside[1] !== inside[2]) addIntersection(1, 2);
      if (inside[2] !== inside[3]) addIntersection(2, 3);
      if (inside[3] !== inside[0]) addIntersection(3, 0);

      if (intersections.length === 2) {
        addSegment(segments, edgesByPoint, intersections[0], intersections[1]);
      } else if (intersections.length === 4) {
        if (caseIndex === 5) {
          addSegment(segments, edgesByPoint, intersections[0], intersections[3]);
          addSegment(segments, edgesByPoint, intersections[1], intersections[2]);
        } else {
          addSegment(segments, edgesByPoint, intersections[0], intersections[1]);
          addSegment(segments, edgesByPoint, intersections[2], intersections[3]);
        }
      }
    }
  }

  segments.forEach((_, index) => remaining.add(index));

  const contours: GridPoint[][] = [];

  while (remaining.size > 0) {
    const firstIndex = remaining.values().next().value as number | undefined;
    if (firstIndex === undefined) break;

    remaining.delete(firstIndex);

    const firstSegment = segments[firstIndex];
    const startKey = gridPointKey(firstSegment.start);
    const points = [firstSegment.start, firstSegment.end];
    let current = firstSegment.end;
    let guard = 0;

    while (gridPointKey(current) !== startKey && guard < width * height * 8) {
      const candidates = edgesByPoint.get(gridPointKey(current)) ?? [];
      const nextIndex = candidates.find((index) => remaining.has(index));
      if (nextIndex === undefined) break;

      remaining.delete(nextIndex);
      const nextSegment = segments[nextIndex];
      const nextPoint = gridPointKey(nextSegment.start) === gridPointKey(current)
        ? nextSegment.end
        : nextSegment.start;
      points.push(nextPoint);
      current = nextPoint;
      guard += 1;
    }

    if (points.length >= 4 && gridPointKey(points[points.length - 1]) === startKey) {
      contours.push(points.slice(0, -1));
    }
  }

  return contours.map((contour) => buildSmoothedContourPath(contour, request, smooth)).join('');
}

function renderStaticReaction(request: ReactionWorkerRequest) {
  const geometry = createReactionGeometry(request);
  const simulation = createSimulation(geometry, request.seed, request.seedMode, request.birth);
  const { feed, kill } = request.settings;

  for (let index = 0; index < request.steps; index += 1) {
    const step = index + 1;
    stepSimulation(simulation, feed, kill);

    if (
      step >= MIN_CONVERGENCE_STEPS &&
      step % CONVERGENCE_CHECK_INTERVAL === 0 &&
      measureSimulationDelta(simulation) < CONVERGENCE_MAX_DELTA
    ) {
      break;
    }
  }

  const inkField = buildInkField(simulation, request.drawing);
  const iso = clamp(
    request.drawing.threshold - request.drawing.band * 0.5 - request.drawing.weight * 0.015,
    0.02,
    0.95,
  );

  return buildContourPath(inkField, geometry, request, request.drawing.smooth, iso);
}

self.onmessage = (event: MessageEvent<ReactionWorkerRequest>) => {
  const { jobId, glyphIndex } = event.data;
  const response: ReactionWorkerResponse = {
    jobId,
    glyphIndex,
    inkPath: renderStaticReaction(event.data),
  };

  self.postMessage(response);
};
