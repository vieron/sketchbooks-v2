import { useEffect, useMemo, useRef, useState } from 'react';
import { button, folder, useControls } from 'leva';
import { SketchControls } from '../../../components/SketchControls';
import { nativeNumber } from '../../../controls/nativeNumberPlugin';
import {
  getFontByValue,
  getFontFamilyById,
  getFontFamilyOptions,
  getFontVariantOptions,
  geistFonts,
} from '../../../data/fonts';
import { downloadSvg } from '../../../utils/svgDownload';
import { useOpenTypeFont } from '../003-typographic-slicing/_opentype';
import type { Bounds, OpenTypeCommand, OpenTypeFont, OpenTypeGlyph } from '../003-typographic-slicing/_types';

type GlyphLayout = {
  glyphs: { id: string; commands: OpenTypeCommand[] }[];
  metrics: { x: number; y: number; width: number; height: number };
};

type WarpedPath = {
  id: string;
  d: string;
  fill: string;
};

type LiquidSettings = {
  amplitude: number;
  frequency: number;
  waveAngle: number;
  centerX: number;
  centerY: number;
  pull: number;
  slant: number;
  detail: number;
  phase: number;
  seed: number;
};

const STAGE = { width: 30000, height: 16000 };
const SIZE_SCALE = 100;
const TRACKING_SCALE = 18;
const DISPLACEMENT_SCALE = 100;
const TAU = Math.PI * 2;
const FIXED_DETAIL = 420;
const MAX_SEGMENTS_PER_COMMAND = 520;

function cleanFilePart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'liquid-type';
}

function pathNumber(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

function distance(ax: number, ay: number, bx: number, by: number) {
  return Math.hypot(bx - ax, by - ay);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getSegmentCount(length: number, detail: number, minimum = 1) {
  const step = clamp(14000 / Math.max(1, detail), 4, 900);
  return clamp(Math.ceil(length / step), minimum, MAX_SEGMENTS_PER_COMMAND);
}

function getLiquidOffset(stageX: number, stageY: number, settings: LiquidSettings) {
  const angle = (settings.waveAngle * Math.PI) / 180;
  const axis = { x: Math.sin(angle), y: Math.cos(angle) };
  const tangent = { x: axis.y, y: -axis.x };
  const centerX = settings.centerX * STAGE.width;
  const centerY = settings.centerY * STAGE.height;
  const wavePosition = (stageX - centerX) * axis.x + (stageY - centerY) * axis.y;
  const ratio = 0.5 + wavePosition / STAGE.height;
  const centerRatio = clamp(ratio, 0, 1);
  const centerWeight = 0.38 + Math.pow(Math.sin(centerRatio * Math.PI), 0.7) * 0.95;
  const drag = 0.42;
  const seedPhase = settings.seed * 0.031;
  const primary = Math.sin(ratio * TAU * settings.frequency + settings.phase + seedPhase);
  const undertow = Math.sin(ratio * TAU * (settings.frequency * 0.43 + 0.35) - settings.phase * 0.62 + seedPhase * 0.4) * 0.46;
  const ripple = Math.cos(ratio * TAU * (settings.frequency * 1.7 + 0.8) + settings.phase * 1.2 - seedPhase * 0.25) * 0.18;
  const waveOffset = (primary + undertow + ripple) * settings.amplitude * DISPLACEMENT_SCALE * centerWeight * drag;
  const gravityOffset = Math.cos(ratio * TAU * (settings.frequency * 0.55 + 0.3) + settings.phase) *
    settings.pull *
    settings.amplitude *
    DISPLACEMENT_SCALE *
    0.22;

  return {
    x: tangent.x * waveOffset,
    y: tangent.y * waveOffset + gravityOffset,
  };
}

function getGlyphPathCommands(glyph: OpenTypeGlyph, x: number, y: number, scale: number) {
  const bounds: Bounds = {
    x1: Infinity,
    y1: Infinity,
    x2: -Infinity,
    y2: -Infinity,
  };

  function point(rawX: number, rawY: number) {
    const px = x + rawX * scale;
    const py = y - rawY * scale;

    if (Number.isFinite(px) && Number.isFinite(py)) {
      bounds.x1 = Math.min(bounds.x1, px);
      bounds.y1 = Math.min(bounds.y1, py);
      bounds.x2 = Math.max(bounds.x2, px);
      bounds.y2 = Math.max(bounds.y2, py);
    }

    return { x: px, y: py };
  }

  const commands = (glyph.path?.commands ?? []).map((command): OpenTypeCommand => {
    if (command.type === 'M' || command.type === 'L') {
      return { type: command.type, ...point(command.x, command.y) };
    }

    if (command.type === 'Q') {
      return {
        type: command.type,
        ...point(command.x, command.y),
        x1: point(command.x1, command.y1).x,
        y1: point(command.x1, command.y1).y,
      };
    }

    if (command.type === 'C') {
      return {
        type: command.type,
        ...point(command.x, command.y),
        x1: point(command.x1, command.y1).x,
        y1: point(command.x1, command.y1).y,
        x2: point(command.x2, command.y2).x,
        y2: point(command.x2, command.y2).y,
      };
    }

    return { type: 'Z' };
  });

  return {
    commands,
    bounds: Number.isFinite(bounds.x1) ? bounds : null,
  };
}

function getGlyphLayout(font: OpenTypeFont | null, text: string, size: number, tracking: number): GlyphLayout {
  if (!font) return { glyphs: [], metrics: { x: 0, y: 0, width: 1, height: 1 } };

  const glyphs = font.stringToGlyphs(text.trim() || ' ');
  const scale = size / font.unitsPerEm;
  let cursor = 0;
  let layoutMinX = 0;
  let bounds: Bounds | null = null;

  const paths = glyphs.map((glyph, index) => {
    const previousGlyph = glyphs[index - 1];
    if (previousGlyph && font.getKerningValue) cursor += font.getKerningValue(previousGlyph, glyph) * scale;

    const path = getGlyphPathCommands(glyph, cursor, 0, scale);

    if (path.bounds) {
      layoutMinX = Math.min(layoutMinX, path.bounds.x1);
      bounds = bounds
        ? {
            x1: Math.min(bounds.x1, path.bounds.x1),
            y1: Math.min(bounds.y1, path.bounds.y1),
            x2: Math.max(bounds.x2, path.bounds.x2),
            y2: Math.max(bounds.y2, path.bounds.y2),
          }
        : path.bounds;
    }

    cursor += glyph.advanceWidth * scale;
    if (index < glyphs.length - 1) cursor += tracking;
    return { id: `${glyph.index}-${index}`, commands: path.commands };
  });

  const measuredBounds = bounds as Bounds | null;
  const metrics = measuredBounds
    ? {
        x: Math.min(measuredBounds.x1, layoutMinX),
        y: measuredBounds.y1,
        width: Math.max(Math.max(measuredBounds.x2, cursor) - Math.min(measuredBounds.x1, layoutMinX), 1),
        height: Math.max(measuredBounds.y2 - measuredBounds.y1, 1),
      }
    : { x: 0, y: -size, width: Math.max(cursor, 1), height: size || 1 };

  return { glyphs: paths, metrics };
}

function quadraticPoint(t: number, p0: number, p1: number, p2: number) {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

function cubicPoint(t: number, p0: number, p1: number, p2: number, p3: number) {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

function warpPoint(x: number, y: number, translateX: number, translateY: number, settings: LiquidSettings) {
  const stageX = x + translateX;
  const stageY = y + translateY;
  const offset = getLiquidOffset(stageX, stageY, settings);

  return {
    x: pathNumber(stageX + offset.x),
    y: pathNumber(stageY + offset.y),
  };
}

function lineToWarpedPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  translateX: number,
  translateY: number,
  settings: LiquidSettings,
) {
  const segments = getSegmentCount(distance(from.x, from.y, to.x, to.y), settings.detail);
  const points: string[] = [];

  for (let segment = 1; segment <= segments; segment += 1) {
    const t = segment / segments;
    const point = warpPoint(
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t,
      translateX,
      translateY,
      settings,
    );
    points.push(`L${point.x} ${point.y}`);
  }

  return points;
}

function warpGlyphPath(
  commands: OpenTypeCommand[],
  translateX: number,
  translateY: number,
  settings: LiquidSettings,
) {
  const pathCommands: string[] = [];
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };

  for (const command of commands) {
    if (command.type === 'M') {
      const point = warpPoint(command.x, command.y, translateX, translateY, settings);
      pathCommands.push(`M${point.x} ${point.y}`);
      current = { x: command.x, y: command.y };
      start = current;
      continue;
    }

    if (command.type === 'L') {
      pathCommands.push(...lineToWarpedPoints(current, command, translateX, translateY, settings));
      current = { x: command.x, y: command.y };
      continue;
    }

    if (command.type === 'Q') {
      const chord = distance(current.x, current.y, command.x, command.y);
      const controlLength = distance(current.x, current.y, command.x1, command.y1) + distance(command.x1, command.y1, command.x, command.y);
      const segments = getSegmentCount(Math.max(chord, controlLength), settings.detail, 4);

      for (let segment = 1; segment <= segments; segment += 1) {
        const t = segment / segments;
        const point = warpPoint(
          quadraticPoint(t, current.x, command.x1, command.x),
          quadraticPoint(t, current.y, command.y1, command.y),
          translateX,
          translateY,
          settings,
        );
        pathCommands.push(`L${point.x} ${point.y}`);
      }

      current = { x: command.x, y: command.y };
      continue;
    }

    if (command.type === 'C') {
      const chord = distance(current.x, current.y, command.x, command.y);
      const controlLength =
        distance(current.x, current.y, command.x1, command.y1) +
        distance(command.x1, command.y1, command.x2, command.y2) +
        distance(command.x2, command.y2, command.x, command.y);
      const segments = getSegmentCount(Math.max(chord, controlLength), settings.detail, 5);

      for (let segment = 1; segment <= segments; segment += 1) {
        const t = segment / segments;
        const point = warpPoint(
          cubicPoint(t, current.x, command.x1, command.x2, command.x),
          cubicPoint(t, current.y, command.y1, command.y2, command.y),
          translateX,
          translateY,
          settings,
        );
        pathCommands.push(`L${point.x} ${point.y}`);
      }

      current = { x: command.x, y: command.y };
      continue;
    }

    pathCommands.push(...lineToWarpedPoints(current, start, translateX, translateY, settings));
    pathCommands.push('Z');
    current = start;
  }

  return pathCommands.join('');
}

function splitContours(commands: OpenTypeCommand[]) {
  const contours: OpenTypeCommand[][] = [];
  let contour: OpenTypeCommand[] = [];

  for (const command of commands) {
    if (command.type === 'M' && contour.length > 0) {
      contours.push(contour);
      contour = [];
    }

    contour.push(command);

    if (command.type === 'Z') {
      contours.push(contour);
      contour = [];
    }
  }

  if (contour.length > 0) contours.push(contour);

  return contours;
}

function getContourPoints(commands: OpenTypeCommand[]) {
  return commands.flatMap((command) => {
    if (command.type === 'M' || command.type === 'L') return [{ x: command.x, y: command.y }];
    if (command.type === 'Q') return [{ x: command.x1, y: command.y1 }, { x: command.x, y: command.y }];
    if (command.type === 'C') return [{ x: command.x1, y: command.y1 }, { x: command.x2, y: command.y2 }, { x: command.x, y: command.y }];
    return [];
  });
}

function getContourBounds(commands: OpenTypeCommand[]) {
  const points = getContourPoints(commands);

  return points.reduce<Bounds>(
    (bounds, point) => ({
      x1: Math.min(bounds.x1, point.x),
      y1: Math.min(bounds.y1, point.y),
      x2: Math.max(bounds.x2, point.x),
      y2: Math.max(bounds.y2, point.y),
    }),
    { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity },
  );
}

function boundsContains(outer: Bounds, inner: Bounds) {
  return outer.x1 <= inner.x1 && outer.y1 <= inner.y1 && outer.x2 >= inner.x2 && outer.y2 >= inner.y2;
}

function classifyContours(commands: OpenTypeCommand[]) {
  const contours = splitContours(commands).map((contour) => ({
    commands: contour,
    bounds: getContourBounds(contour),
  }));

  return contours.map((contour, index) => ({
    ...contour,
    isHole: contours.some((candidate, candidateIndex) => candidateIndex !== index && boundsContains(candidate.bounds, contour.bounds)),
  }));
}

function useAnimationPhase(enabled: boolean, speed: number, manualPhase: number) {
  const [phase, setPhase] = useState(manualPhase);

  useEffect(() => {
    if (!enabled) {
      setPhase(manualPhase);
      return undefined;
    }

    let frame = 0;
    let start = 0;

    const tick = (time: number) => {
      if (!start) start = time;
      setPhase(manualPhase + ((time - start) / 1000) * speed);
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [enabled, manualPhase, speed]);

  return phase;
}

export default function LiquidTypeDistortion() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const defaultFamily = getFontFamilyById('geist');
  const [selectedFontFamilyId, setSelectedFontFamilyId] = useState(defaultFamily.id);
  const selectedFontFamily = getFontFamilyById(selectedFontFamilyId);
  const [selectedFontValue, setSelectedFontValue] = useState(
    geistFonts.find((font) => font.variant === 'Black Italic')?.value ?? selectedFontFamily.defaultFont.value,
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
        onChange: setSelectedFontValue,
      },
      text: 'liquid',
      size: nativeNumber({ current: 80, min: 36, max: 360, step: 1 }),
      tracking: nativeNumber({ current: -6, min: -20, max: 80, step: 0.25 }),
    },
    { collapsed: false },
    [selectedFontFamily.id, selectedFont.value],
  );

  const liquid = useControls('Liquid', {
    amplitude: { ...nativeNumber({ current: 15, min: 0, max: 90, step: 0.25 }), label: 'amplitude' },
    frequency: { ...nativeNumber({ current: 2.15, min: 0.1, max: 8, step: 0.05 }), label: 'wave' },
    waveAngle: { ...nativeNumber({ current: 0, min: -180, max: 180, step: 0.5 }), label: 'angle' },
    centerX: { ...nativeNumber({ current: 0.5, min: -0.5, max: 1.5, step: 0.01 }), label: 'center x' },
    centerY: { ...nativeNumber({ current: 0.5, min: -0.5, max: 1.5, step: 0.01 }), label: 'center y' },
    pull: { ...nativeNumber({ current: 0.8, min: 0, max: 12, step: 0.05 }), label: 'gravity' },
    slant: { ...nativeNumber({ current: -9, min: -38, max: 38, step: 0.25 }), label: 'slant' },
    seed: nativeNumber({ current: 77, min: 1, max: 999, step: 1 }),
  }, { collapsed: false });

  const motion = useControls('Motion', {
    animate: { value: true, label: 'animate' },
    speed: { ...nativeNumber({ current: 1.15, min: 0, max: 7, step: 0.05 }), label: 'speed' },
    phase: { ...nativeNumber({ current: 0.4, min: -TAU * 8, max: TAU * 8, step: 0.01 }), label: 'phase' },
  }, { collapsed: false });

  const drawing = useControls('Drawing', {
    Color: folder({
      background: '#fbfaf6',
      ink: '#0c0b09',
    }, { collapsed: false }),
  }, { collapsed: false });

  useControls({
    'Download SVG': button(() => {
      downloadSvg(svgRef.current, `${cleanFilePart(String(typography.text))}-${cleanFilePart(selectedFont.label)}-liquid.svg`);
    }),
  });

  const phase = useAnimationPhase(Boolean(motion.animate), Number(motion.speed), Number(motion.phase));
  const { font, error } = useOpenTypeFont(selectedFont.url);
  const numericSize = Number(typography.size) * SIZE_SCALE;
  const numericTracking = Number(typography.tracking) * TRACKING_SCALE;

  const glyphLayout = useMemo(
    () => getGlyphLayout(font, String(typography.text), numericSize, numericTracking),
    [font, numericSize, numericTracking, typography.text],
  );

  if (error) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Font failed to load: {error}</div>
        <SketchControls fill flat />
      </section>
    );
  }

  if (!font) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Loading font...</div>
        <SketchControls fill flat />
      </section>
    );
  }

  const settings: LiquidSettings = {
    amplitude: Number(liquid.amplitude),
    frequency: Number(liquid.frequency),
    waveAngle: Number(liquid.waveAngle),
    centerX: Number(liquid.centerX),
    centerY: Number(liquid.centerY),
    pull: Number(liquid.pull),
    slant: Number(liquid.slant),
    detail: FIXED_DETAIL,
    phase,
    seed: Number(liquid.seed),
  };
  const translateX = STAGE.width / 2 - (glyphLayout.metrics.x + glyphLayout.metrics.width / 2);
  const translateY = STAGE.height / 2 - (glyphLayout.metrics.y + glyphLayout.metrics.height / 2);
  const slantTransform = `translate(${STAGE.width / 2} ${STAGE.height / 2}) skewX(${settings.slant}) translate(${-STAGE.width / 2} ${-STAGE.height / 2})`;
  const warpedGlyphs = glyphLayout.glyphs.flatMap((glyph) => {
    const contours = classifyContours(glyph.commands);
    const outerPaths: WarpedPath[] = [];
    const holePaths: WarpedPath[] = [];

    contours.forEach((contour, index) => {
      const path = {
        id: `${glyph.id}-${index}`,
        d: warpGlyphPath(contour.commands, translateX, translateY, settings),
        fill: contour.isHole ? String(drawing.background) : String(drawing.ink),
      };

      if (contour.isHole) {
        holePaths.push(path);
      } else {
        outerPaths.push(path);
      }
    });

    return [...outerPaths, ...holePaths];
  });

  return (
    <section className="sketch-workbench">
      <div className="sketch-stage">
        <svg
          ref={svgRef}
          className="type-svg"
          viewBox={`0 0 ${STAGE.width} ${STAGE.height}`}
          overflow="visible"
          role="img"
          aria-label={`${typography.text} rendered as liquid distorted SVG type`}
          style={{ backgroundColor: String(drawing.background) }}
          shapeRendering="geometricPrecision"
        >
          <rect width={STAGE.width} height={STAGE.height} fill={String(drawing.background)} />

          <g transform={slantTransform}>
            {warpedGlyphs.map((glyph) => <path key={glyph.id} d={glyph.d} fill={glyph.fill} />)}
          </g>
        </svg>
      </div>
      <SketchControls fill flat collapsed={false} oneLineLabels={false} />
    </section>
  );
}
