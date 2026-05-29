type SeedMode = 'walls' | 'islands' | 'both';

type RateMapRange = {
  min: number;
  max: number;
};

type RateMapDrawing = {
  contrast: number;
  threshold: number;
  band: number;
  weight: number;
};

type RateMapWorkerRequest = {
  jobId: number;
  width: number;
  height: number;
  behavior: string;
  feedRange: RateMapRange;
  killRange: RateMapRange;
  steps: number;
  grain: number;
  bleed: number;
  seed: number;
  birth: number;
  seedMode: SeedMode;
  drawing: RateMapDrawing;
  paper: string;
  ink: string;
};

type RateMapWorkerResponse = {
  jobId: number;
  width: number;
  height: number;
  pixels: ArrayBuffer;
};

const workerSelf = self as unknown as {
  onmessage: ((event: MessageEvent<RateMapWorkerRequest>) => void) | null;
  postMessage: (message: RateMapWorkerResponse, transfer: Transferable[]) => void;
};
const DEFAULT_DIFFUSION_B = 0.5;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

function parseColor(value: string, fallback: readonly [number, number, number]) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(value.trim());
  if (!match) return fallback;

  return [
    Number.parseInt(match[1], 16),
    Number.parseInt(match[2], 16),
    Number.parseInt(match[3], 16),
  ] as const;
}

function seedPatch(
  u: Float32Array,
  v: Float32Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
  rng: () => number,
) {
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(height - 1, Math.ceil(centerY + radius));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;

      const index = y * width + x;
      const falloff = 1 - distance / Math.max(radius, 1);
      u[index] = Math.min(u[index], 0.32 + rng() * 0.16 + (1 - falloff) * 0.18);
      v[index] = Math.max(v[index], 0.34 + falloff * 0.42 + rng() * 0.07);
    }
  }
}

function seedSimulation(
  u: Float32Array,
  v: Float32Array,
  width: number,
  height: number,
  request: RateMapWorkerRequest,
) {
  const behaviorHash = Array.from(request.behavior).reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261);
  const rng = mulberry32(request.seed ^ behaviorHash);
  const density = clamp(request.birth, 0.08, 1);
  const bleedAmount = clamp(request.bleed, 0, 90) / 90;
  const grainAmount = clamp((request.grain - 180) / (2400 - 180), 0, 1);
  const radiusScale = 0.82 + bleedAmount * 0.92 - grainAmount * 0.18;
  const countScale = 0.78 + grainAmount * 0.52 + bleedAmount * 0.18;
  u.fill(1);

  if (request.seedMode === 'walls' || request.seedMode === 'both') {
    const segmentCount = Math.max(28, Math.round(((width * height * density) / 1150) * countScale));

    for (let segment = 0; segment < segmentCount; segment += 1) {
      const centerX = rng() * (width - 1);
      const centerY = rng() * (height - 1);
      const angle = rng() * Math.PI * 2;
      const length = (4 + rng() * Math.min(width, height) * 0.08) * (0.9 + bleedAmount * 0.42);
      const samples = Math.max(3, Math.round(length / 2.4));

      for (let sample = 0; sample < samples; sample += 1) {
        const t = sample / Math.max(samples - 1, 1) - 0.5;
        const bend = Math.sin((t + 0.5) * Math.PI * 2 + rng() * 0.7) * length * 0.12;
        const x = centerX + Math.cos(angle) * t * length + Math.cos(angle + Math.PI / 2) * bend;
        const y = centerY + Math.sin(angle) * t * length + Math.sin(angle + Math.PI / 2) * bend;
        seedPatch(u, v, width, height, x, y, (1.15 + density * 1.8 + rng() * 0.9) * radiusScale, rng);
      }
    }
  }

  if (request.seedMode === 'islands' || request.seedMode === 'both') {
    const clusterCount = Math.max(18, Math.round(((width * height * density) / 950) * countScale));
    const radiusBase = Math.max(1.8, Math.min(width, height) * (0.006 + density * 0.012) * radiusScale);

    for (let index = 0; index < clusterCount; index += 1) {
      seedPatch(
        u,
        v,
        width,
        height,
        rng() * (width - 1),
        rng() * (height - 1),
        1.4 + rng() * radiusBase,
        rng,
      );
    }
  }

  const noiseAmount = 0.022;
  for (let index = 0; index < u.length; index += 1) {
    const noise = (rng() - 0.5) * noiseAmount;
    u[index] = clamp(u[index] + noise, 0, 1);
    v[index] = clamp(v[index] - noise * 0.4, 0, 1);
  }
}

function renderRateMap(request: RateMapWorkerRequest) {
  const { width, height } = request;
  let u = new Float32Array(width * height);
  let v = new Float32Array(width * height);
  let nextU = new Float32Array(width * height);
  let nextV = new Float32Array(width * height);
  const killByX = new Float32Array(width);
  const feedByY = new Float32Array(height);

  for (let x = 0; x < width; x += 1) {
    const amount = x / Math.max(width - 1, 1);
    killByX[x] = request.killRange.min + amount * (request.killRange.max - request.killRange.min);
  }

  for (let y = 0; y < height; y += 1) {
    const amount = y / Math.max(height - 1, 1);
    feedByY[y] = request.feedRange.max - amount * (request.feedRange.max - request.feedRange.min);
  }

  nextU.fill(1);
  seedSimulation(u, v, width, height, request);
  nextU.set(u);
  nextV.set(v);

  for (let step = 0; step < request.steps; step += 1) {
    for (let y = 0; y < height; y += 1) {
      const topY = y > 0 ? y - 1 : y;
      const bottomY = y < height - 1 ? y + 1 : y;
      const row = y * width;
      const topRow = topY * width;
      const bottomRow = bottomY * width;
      const feed = feedByY[y];

      for (let x = 0; x < width; x += 1) {
        const leftX = x > 0 ? x - 1 : x;
        const rightX = x < width - 1 ? x + 1 : x;
        const index = row + x;
        const uCenter = u[index];
        const vCenter = v[index];
        const laplaceU =
          -uCenter +
          0.2 * (u[row + leftX] + u[row + rightX] + u[topRow + x] + u[bottomRow + x]) +
          0.05 * (u[topRow + leftX] + u[topRow + rightX] + u[bottomRow + leftX] + u[bottomRow + rightX]);
        const laplaceV =
          -vCenter +
          0.2 * (v[row + leftX] + v[row + rightX] + v[topRow + x] + v[bottomRow + x]) +
          0.05 * (v[topRow + leftX] + v[topRow + rightX] + v[bottomRow + leftX] + v[bottomRow + rightX]);
        const reaction = uCenter * vCenter * vCenter;
        const killFeed = killByX[x] + feed;

        nextU[index] = clamp(uCenter + laplaceU - reaction + feed * (1 - uCenter), 0, 1);
        nextV[index] = clamp(vCenter + DEFAULT_DIFFUSION_B * laplaceV + reaction - killFeed * vCenter, 0, 1);
      }
    }

    const oldU = u;
    const oldV = v;
    u = nextU;
    v = nextV;
    nextU = oldU;
    nextV = oldV;
  }

  const paper = parseColor(request.paper, [250, 250, 246]);
  const ink = parseColor(request.ink, [11, 11, 9]);
  const pixels = new Uint8ClampedArray(width * height * 4);
  const iso = clamp(
    request.drawing.threshold - request.drawing.band * 0.5 - request.drawing.weight * 0.015,
    0.02,
    0.95,
  );
  const edgeLow = iso - Math.max(0.006, request.drawing.band * 0.5);
  const edgeHigh = iso + Math.max(0.006, request.drawing.band * 0.5);

  for (let index = 0; index < u.length; index += 1) {
    const baseInk = clamp(v[index] * request.drawing.contrast + (1 - u[index]) * 0.22, 0, 1);
    const amount = smoothstep(edgeLow, edgeHigh, baseInk);
    const pixelIndex = index * 4;

    pixels[pixelIndex] = Math.round(paper[0] + (ink[0] - paper[0]) * amount);
    pixels[pixelIndex + 1] = Math.round(paper[1] + (ink[1] - paper[1]) * amount);
    pixels[pixelIndex + 2] = Math.round(paper[2] + (ink[2] - paper[2]) * amount);
    pixels[pixelIndex + 3] = 255;
  }

  return pixels;
}

workerSelf.onmessage = (event: MessageEvent<RateMapWorkerRequest>) => {
  const pixels = renderRateMap(event.data);
  const response: RateMapWorkerResponse = {
    jobId: event.data.jobId,
    width: event.data.width,
    height: event.data.height,
    pixels: pixels.buffer as ArrayBuffer,
  };

  workerSelf.postMessage(response, [pixels.buffer as ArrayBuffer]);
};

export {};
