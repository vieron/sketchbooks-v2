import type { Bounds, Point } from '../_type/_types';

type RandomSource = {
  next(min?: number, max?: number): number;
};

type Particle = {
  x: number;
  y: number;
};

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

type GlyphFlowRequest = {
  jobId: number;
  glyphIndex: number;
  shape: GlyphShape;
  particleCount: number;
  settings: FlowSettings;
};

type GlyphFlowResponse = {
  jobId: number;
  glyphIndex: number;
  framePaths: string[];
};

const TAU = Math.PI * 2;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function pathNumber(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
}

function hashGrid(x: number, y: number, seed: number) {
  let value = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return (value ^ (value >>> 16)) >>> 0;
}

function gradient(ix: number, iy: number, x: number, y: number, seed: number) {
  const angle = (hashGrid(ix, iy, seed) / 4294967296) * TAU;
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

function pointInContour(point: Point, contour: Point[]) {
  let inside = false;

  for (let index = 0, previousIndex = contour.length - 1; index < contour.length; previousIndex = index, index += 1) {
    const current = contour[index];
    const previous = contour[previousIndex];
    const crosses =
      current.y > point.y !== previous.y > point.y &&
      point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;

    if (crosses) inside = !inside;
  }

  return inside;
}

function pointInGlyph(point: Point, contours: Point[][]) {
  return contours.reduce((inside, contour) => (pointInContour(point, contour) ? !inside : inside), false);
}

function randomPointInGlyph(bounds: Bounds, contours: Point[][], random: RandomSource) {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const point = {
      x: random.next(bounds.x1, bounds.x2),
      y: random.next(bounds.y1, bounds.y2),
    };

    if (pointInGlyph(point, contours)) return point;
  }

  return {
    x: (bounds.x1 + bounds.x2) / 2,
    y: (bounds.y1 + bounds.y2) / 2,
  };
}

function createParticles(shape: GlyphShape, count: number, random: RandomSource) {
  return Array.from({ length: count }, () => randomPointInGlyph(shape.bounds, shape.contours, random));
}

function moveParticle(particle: Particle, settings: FlowSettings) {
  const noiseValue = perlin2(
    particle.x * settings.noiseScale + settings.seed * 0.017,
    particle.y * settings.noiseScale - settings.seed * 0.011,
    settings.seed,
  );
  const angle = (settings.angle * Math.PI) / 180 + TAU * noiseValue * settings.turns;

  return {
    x: particle.x + Math.cos(angle) * settings.speed,
    y: particle.y + Math.sin(angle) * settings.speed,
  };
}

function createGlyphFramePaths(shape: GlyphShape, count: number, settings: FlowSettings) {
  const framePaths: string[] = [];
  const particleRandom = createRandom(settings.seed + Number(shape.id.replace(/\D/g, '') || 0) * 971);
  const respawnRandom = createRandom(settings.seed * 13 + 97);
  const particles = createParticles(shape, count, particleRandom);
  const frameLimit = clamp(Math.round(settings.frameLimit), 1, 1200);

  for (let frame = 0; frame < frameLimit; frame += 1) {
    const commands: string[] = [];

    particles.forEach((particle) => {
      const previous = { x: particle.x, y: particle.y };
      const next = moveParticle(particle, settings);
      const nextInside = pointInGlyph(next, shape.contours);

      commands.push(`M${pathNumber(previous.x)} ${pathNumber(previous.y)}L${pathNumber(next.x)} ${pathNumber(next.y)}`);

      if (nextInside) {
        particle.x = next.x;
        particle.y = next.y;
      } else {
        const replacement = randomPointInGlyph(shape.bounds, shape.contours, respawnRandom);
        particle.x = replacement.x;
        particle.y = replacement.y;
      }
    });

    framePaths.push(commands.join(''));
  }

  return framePaths;
}

self.onmessage = (event: MessageEvent<GlyphFlowRequest>) => {
  const { jobId, glyphIndex, shape, particleCount, settings } = event.data;
  const response: GlyphFlowResponse = {
    jobId,
    glyphIndex,
    framePaths: createGlyphFramePaths(shape, particleCount, settings),
  };

  self.postMessage(response);
};
