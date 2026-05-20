import { useEffect, useMemo, useRef, useState } from 'react';
import { button, folder, Leva, useControls } from 'leva';

type CircleSettings = {
  noiseMax: number;
  averageRadiusRatio: number;
  radiusVariationRatio: number;
  angleStep: number;
  phaseSpeed: number;
  zSpeed: number;
  frameLimit: number;
  strokeWeight: number;
  strokeAlpha: number;
  background: string;
  strokeColor: string;
  seed: number;
};

type SvgScene = {
  width: number;
  height: number;
  paths: string[];
};

const TAU = Math.PI * 2;

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

function pathNumber(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

function hashGrid(x: number, y: number, z: number, seed: number) {
  let value = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647) + Math.imul(seed, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return (value ^ (value >>> 16)) >>> 0;
}

function gradient(ix: number, iy: number, iz: number, x: number, y: number, z: number, seed: number) {
  const hash = hashGrid(ix, iy, iz, seed);
  const theta = (hash / 4294967296) * TAU;
  const phi = (((hash >>> 8) / 16777216) * 2 - 1) * Math.PI;
  const dx = x - ix;
  const dy = y - iy;
  const dz = z - iz;
  const gx = Math.cos(theta) * Math.cos(phi);
  const gy = Math.sin(theta) * Math.cos(phi);
  const gz = Math.sin(phi);

  return gx * dx + gy * dy + gz * dz;
}

function perlin3(x: number, y: number, z: number, seed: number) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;
  const sx = fade(x - x0);
  const sy = fade(y - y0);
  const sz = fade(z - z0);

  const n000 = gradient(x0, y0, z0, x, y, z, seed);
  const n100 = gradient(x1, y0, z0, x, y, z, seed);
  const n010 = gradient(x0, y1, z0, x, y, z, seed);
  const n110 = gradient(x1, y1, z0, x, y, z, seed);
  const n001 = gradient(x0, y0, z1, x, y, z, seed);
  const n101 = gradient(x1, y0, z1, x, y, z, seed);
  const n011 = gradient(x0, y1, z1, x, y, z, seed);
  const n111 = gradient(x1, y1, z1, x, y, z, seed);

  const ix00 = lerp(n000, n100, sx);
  const ix10 = lerp(n010, n110, sx);
  const ix01 = lerp(n001, n101, sx);
  const ix11 = lerp(n011, n111, sx);
  const iy0 = lerp(ix00, ix10, sy);
  const iy1 = lerp(ix01, ix11, sy);

  return (lerp(iy0, iy1, sz) + 1) / 2;
}

function createNoisyCirclePath(width: number, height: number, phase: number, zoff: number, settings: CircleSettings) {
  const referenceSize = Math.min(width, height);
  const averageRadius = referenceSize * settings.averageRadiusRatio;
  const radiusVariation = referenceSize * settings.radiusVariationRatio;
  const minRadius = averageRadius - radiusVariation * 0.5;
  const maxRadius = averageRadius + radiusVariation * 0.5;
  const commands: string[] = [];

  for (let angle = 0; angle < TAU; angle += (settings.angleStep * Math.PI) / 180) {
    const xoff = mapRange(Math.cos(angle + phase), -1, 1, 0, settings.noiseMax);
    const yoff = mapRange(Math.sin(angle + phase), -1, 1, 0, settings.noiseMax);
    const radius = mapRange(perlin3(xoff, yoff, zoff, settings.seed), 0, 1, minRadius, maxRadius);
    const x = width / 2 + radius * Math.cos(angle);
    const y = height / 2 + radius * Math.sin(angle);
    const prefix = angle === 0 ? 'M' : 'L';

    commands.push(`${prefix}${pathNumber(x)} ${pathNumber(y)}`);
  }

  return `${commands.join('')}Z`;
}

function createSvgScene(width: number, height: number, settings: CircleSettings): SvgScene {
  const frameLimit = Math.max(1, Math.round(settings.frameLimit));
  const paths: string[] = [];
  let phase = 0;
  let zoff = 0;

  for (let frame = 0; frame <= frameLimit; frame += 1) {
    paths.push(createNoisyCirclePath(width, height, phase, zoff, settings));
    phase += settings.phaseSpeed;
    zoff += settings.zSpeed;
  }

  return { width, height, paths };
}

function saveSvg(svgElement: SVGSVGElement | null) {
  if (!svgElement) return;
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `perlin-noise-circle-overlap-${Date.now()}.svg`;
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

export default function PerlinNoiseCircleOverlap() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { ref: stageRef, size } = useStageSize();
  const [visiblePathCount, setVisiblePathCount] = useState(0);

  const field = useControls('Field', {
    noiseMax: { value: 0.6, min: 0.05, max: 3, step: 0.01, label: 'noise' },
    averageRadiusRatio: { value: 0.3, min: 0.05, max: 0.7, step: 0.01, label: 'radius' },
    radiusVariationRatio: { value: 0.4, min: 0, max: 0.9, step: 0.01, label: 'variation' },
    angleStep: { value: 5, min: 1, max: 20, step: 1, label: 'detail' },
    seed: { value: 106, min: 1, max: 9999, step: 1 },
  }, { collapsed: false });
  const animation = useControls('Animation', {
    animate: { value: true, label: 'animate' },
    phaseSpeed: { value: 0.009, min: 0, max: 0.05, step: 0.001, label: 'phase' },
    zSpeed: { value: 0.003, min: 0, max: 0.03, step: 0.001, label: 'depth' },
    frameLimit: { value: 800, min: 30, max: 2000, step: 10, label: 'frames' },
  }, { collapsed: false });
  const drawing = useControls('Drawing', {
    strokeWeight: { value: 2, min: 0.2, max: 12, step: 0.1, label: 'weight' },
    strokeAlpha: { value: 0.06, min: 0.005, max: 0.6, step: 0.005, label: 'alpha' },
    Color: folder({
      background: '#ffffff',
      strokeColor: '#11110f',
    }, { collapsed: false }),
  }, { collapsed: false });
  useControls({
    'Download SVG': button(() => saveSvg(svgRef.current)),
  });

  const settings = useMemo<CircleSettings>(() => ({
    noiseMax: Number(field.noiseMax),
    averageRadiusRatio: Number(field.averageRadiusRatio),
    radiusVariationRatio: Number(field.radiusVariationRatio),
    angleStep: Number(field.angleStep),
    phaseSpeed: Number(animation.phaseSpeed),
    zSpeed: Number(animation.zSpeed),
    frameLimit: Number(animation.frameLimit),
    strokeWeight: Number(drawing.strokeWeight),
    strokeAlpha: Number(drawing.strokeAlpha),
    background: String(drawing.background),
    strokeColor: String(drawing.strokeColor),
    seed: Number(field.seed),
  }), [animation, drawing, field]);

  const scene = useMemo(
    () => createSvgScene(size.width, size.height, settings),
    [settings, size.height, size.width],
  );
  const shouldAnimate = Boolean(animation.animate);
  const visiblePaths = shouldAnimate ? scene.paths.slice(0, visiblePathCount) : scene.paths;

  useEffect(() => {
    if (!shouldAnimate) {
      setVisiblePathCount(scene.paths.length);
      return undefined;
    }

    let frame = 0;
    let nextPathCount = 0;
    setVisiblePathCount(0);

    const reveal = () => {
      nextPathCount += 1;
      setVisiblePathCount(Math.min(nextPathCount, scene.paths.length));

      if (nextPathCount < scene.paths.length) {
        frame = window.requestAnimationFrame(reveal);
      }
    };

    frame = window.requestAnimationFrame(reveal);

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [scene, shouldAnimate]);

  return (
    <section className="sketch-workbench">
      <div className="sketch-stage" ref={stageRef}>
        <svg
          ref={svgRef}
          className="type-svg"
          viewBox={`0 0 ${scene.width} ${scene.height}`}
          role="img"
          aria-label="Perlin noise circle overlap SVG"
        >
          <rect width={scene.width} height={scene.height} fill={settings.background} />
          <g
            fill="none"
            stroke={settings.strokeColor}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={Math.max(0, Math.min(1, settings.strokeAlpha))}
            strokeWidth={settings.strokeWeight}
          >
            {visiblePaths.map((path, index) => (
              <path key={index} d={path} />
            ))}
          </g>
        </svg>
      </div>
      <aside className="sketch-controls">
        <Leva fill flat collapsed={false} oneLineLabels={false} />
      </aside>
    </section>
  );
}
