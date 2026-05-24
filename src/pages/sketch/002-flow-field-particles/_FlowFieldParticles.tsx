import { useEffect, useMemo, useRef, useState } from 'react';
import { button, useControls } from 'leva';
import { SketchControls } from '../../../components/SketchControls';
import { colorPalette } from '../../../controls/colorPalettePlugin';
import { nativeNumber } from '../../../controls/nativeNumberPlugin';
import { getPaletteById, getPaletteToneColors, sketchPalettePresets } from '../../../data/palettes';
import { downloadSvg } from '../../../utils/svgDownload';

type Particle = {
  x: number;
  y: number;
  previousX: number;
  previousY: number;
};

type FlowSettings = {
  particleCount: number;
  noiseScale: number;
  speed: number;
  frameLimit: number;
  animate: boolean;
  strokeWeight: number;
  trailAlpha: number;
  fadeAlpha: number;
  offscreen: number;
  background: string;
  strokeColor: string;
  seed: number;
};

type RandomSource = {
  next(min?: number, max?: number): number;
};

type SvgFrame = {
  d: string;
  opacity: number;
};

type SvgScene = {
  width: number;
  height: number;
  frames: SvgFrame[];
};

const TAU = Math.PI * 2;
const DEFAULT_PALETTE = getPaletteById('ice-cream-gb');

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

function createParticles(width: number, height: number, settings: FlowSettings) {
  const random = createRandom(settings.seed);
  return Array.from({ length: Math.round(settings.particleCount) }, () => {
    const particle = {
      x: random.next(-settings.offscreen, width + settings.offscreen),
      y: random.next(-settings.offscreen, height + settings.offscreen),
      previousX: 0,
      previousY: 0,
    };
    particle.previousX = particle.x;
    particle.previousY = particle.y;
    return particle;
  });
}

function respawnParticle(particle: Particle, random: RandomSource, width: number, height: number) {
  particle.x = random.next(0, width);
  particle.y = random.next(0, height);
  particle.previousX = particle.x;
  particle.previousY = particle.y;
}

function createSvgScene(width: number, height: number, settings: FlowSettings): SvgScene {
  const frames: SvgFrame[] = [];
  const particles = createParticles(width, height, settings);
  const respawnRandom = createRandom(settings.seed);
  const frameLimit = Math.max(1, Math.round(settings.frameLimit));
  const decay = Math.max(0, Math.min(1, 1 - settings.fadeAlpha));

  for (let frame = 0; frame < frameLimit; frame += 1) {
    const commands: string[] = [];

    particles.forEach((particle) => {
      commands.push(
        `M${pathNumber(particle.previousX)} ${pathNumber(particle.previousY)}L${pathNumber(particle.x)} ${pathNumber(particle.y)}`,
      );

      particle.previousX = particle.x;
      particle.previousY = particle.y;

      const noiseValue = perlin2(
        particle.x * settings.noiseScale,
        particle.y * settings.noiseScale,
        settings.seed,
      );
      const angle = TAU * noiseValue;

      particle.x += Math.cos(angle) * settings.speed;
      particle.y += Math.sin(angle) * settings.speed;

      if (
        particle.x < -settings.offscreen ||
        particle.x > width + settings.offscreen ||
        particle.y < -settings.offscreen ||
        particle.y > height + settings.offscreen
      ) {
        respawnParticle(particle, respawnRandom, width, height);
      }
    });

    frames.push({
      d: commands.join(''),
      opacity: Math.max(0, Math.min(1, settings.trailAlpha * decay ** (frameLimit - frame - 1))),
    });
  }

  return { width, height, frames };
}

function saveSvg(svgElement: SVGSVGElement | null) {
  downloadSvg(svgElement, `flow-field-particles-${Date.now()}.svg`);
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

export default function FlowFieldParticles() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { ref: stageRef, size } = useStageSize();
  const [visibleFrameCount, setVisibleFrameCount] = useState(0);

  const field = useControls('Field', {
    particleCount: { ...nativeNumber({ current: 2500, min: 500, max: 12000, step: 250 }), label: 'particles' },
    noiseScale: { ...nativeNumber({ current: 0.0015, min: 0.0002, max: 0.008, step: 0.0001 }), label: 'scale' },
    speed: nativeNumber({ current: 1, min: 0.1, max: 4, step: 0.1 }),
    offscreen: nativeNumber({ current: 300, min: 0, max: 800, step: 10 }),
    seed: nativeNumber({ current: 502, min: 1, max: 9999, step: 1 }),
  }, { collapsed: false });
  const animation = useControls('Animation', {
    animate: { value: true, label: 'animate' },
    frameLimit: { ...nativeNumber({ current: 240, min: 20, max: 700, step: 10 }), label: 'frames' },
  }, { collapsed: false });
  const drawing = useControls('Drawing', {
    strokeWeight: { ...nativeNumber({ current: 1, min: 0.2, max: 4, step: 0.1 }), label: 'weight' },
    trailAlpha: { ...nativeNumber({ current: 40 / 255, min: 0.01, max: 1, step: 0.001 }), label: 'alpha' },
    fadeAlpha: { ...nativeNumber({ current: 0, min: 0, max: 0.18, step: 0.001 }), label: 'fade' },
    palette: colorPalette({
      value: { source: DEFAULT_PALETTE.id, colors: DEFAULT_PALETTE.colors },
      palettes: sketchPalettePresets,
    }),
  }, { collapsed: false });
  useControls({
    'Download SVG': button(() => saveSvg(svgRef.current)),
  });

  const paletteTones = getPaletteToneColors(drawing.palette.colors);
  const settings = useMemo<FlowSettings>(() => ({
    particleCount: Number(field.particleCount),
    noiseScale: Number(field.noiseScale),
    speed: Number(field.speed),
    frameLimit: Number(animation.frameLimit),
    animate: Boolean(animation.animate),
    strokeWeight: Number(drawing.strokeWeight),
    trailAlpha: Number(drawing.trailAlpha),
    fadeAlpha: Number(drawing.fadeAlpha),
    offscreen: Number(field.offscreen),
    background: '#ffffff',
    strokeColor: paletteTones.ink,
    seed: Number(field.seed),
  }), [animation, drawing, field, paletteTones.ink]);

  const scene = useMemo(
    () => createSvgScene(size.width, size.height, settings),
    [settings, size.height, size.width],
  );
  const visibleFrames = settings.animate ? scene.frames.slice(0, visibleFrameCount) : scene.frames;

  useEffect(() => {
    if (!settings.animate) {
      setVisibleFrameCount(scene.frames.length);
      return undefined;
    }

    let frame = 0;
    let nextFrameCount = 0;
    setVisibleFrameCount(0);

    const reveal = () => {
      nextFrameCount += 1;
      setVisibleFrameCount(Math.min(nextFrameCount, scene.frames.length));

      if (nextFrameCount < scene.frames.length) {
        frame = window.requestAnimationFrame(reveal);
      }
    };

    frame = window.requestAnimationFrame(reveal);

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [scene, settings.animate]);

  return (
    <section className="sketch-workbench">
      <div className="sketch-stage" ref={stageRef}>
        <svg
          ref={svgRef}
          className="type-svg"
          viewBox={`0 0 ${scene.width} ${scene.height}`}
          role="img"
          aria-label="Flow field particles SVG"
        >
          <rect width={scene.width} height={scene.height} fill={settings.background} />
          <g
            fill="none"
            stroke={settings.strokeColor}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={settings.strokeWeight}
          >
            {visibleFrames.map((frame, index) => (
              <path key={index} d={frame.d} strokeOpacity={frame.opacity} />
            ))}
          </g>
        </svg>
      </div>
      <SketchControls fill flat collapsed={false} oneLineLabels={false} />
    </section>
  );
}
