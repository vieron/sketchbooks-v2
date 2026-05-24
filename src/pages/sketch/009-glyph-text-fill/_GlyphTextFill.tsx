import { useMemo, useRef, useState } from 'react';
import { button, folder, useControls } from 'leva';
import { SketchControls } from '../../../components/SketchControls';
import { colorPalette } from '../../../controls/colorPalettePlugin';
import { nativeNumber } from '../../../controls/nativeNumberPlugin';
import { sketchPalettePresets } from '../../../data/palettes';
import {
  getFontByValue,
  getFontFamilyById,
  getFontFamilyOptions,
  getFontVariantOptions,
  geistFonts,
  thunderFonts,
} from '../../../data/fonts';
import { downloadSvg } from '../../../utils/svgDownload';
import { buildGlyphPath, formatPathNumber, useOpenTypeFont } from '../003-typographic-slicing/_opentype';
import type { Bounds, OpenTypeCommand, OpenTypeFont, OpenTypeGlyph, Point } from '../003-typographic-slicing/_types';

type GlyphFillLine = {
  id: string;
  d: string;
  x: number;
  y: number;
  marker: {
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
  } | null;
};

type FilledGlyph = {
  id: string;
  d: string;
  bounds: Bounds;
  lines: GlyphFillLine[];
};

type TextTokenBounds = {
  text: string;
  x: number;
  width: number;
};

type GlyphPlacement = {
  glyph: OpenTypeGlyph;
  x: number;
};

const STAGE = { width: 1800, height: 1200 };
const MAIN_SIZE_SCALE = 4.8;
const TRACKING_SCALE = 3;
const CURVE_STEPS = 10;
const STAGE_MARGIN = 70;
const EDITORIAL_HIGHLIGHTER_PALETTE = {
  id: 'editorial-highlighter',
  label: 'Editorial Highlighter',
  colors: ['#168fd2', '#12b27f', '#ff551e', '#ffd32f', '#f09bea', '#c9c9c6'],
};
const MARKER_PALETTES = [EDITORIAL_HIGHLIGHTER_PALETTE, ...sketchPalettePresets];
const DEFAULT_WORDS = 'GORP BARBIE COTTAGE DARKROOM TECH NORM CLUTTER ANGEL ROYAL HOBI CABIN BALLET CRAFT FAIRY ROBOT DREAM WEIRD SPACE CLOWN';

const defaultOuterFont = thunderFonts.find((font) => font.variant === 'Extra Bold LC') ?? thunderFonts[6];
const defaultInnerFont = geistFonts.find((font) => font.variant === 'Regular') ?? geistFonts[6];

function cleanFilePart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'glyph-text-fill';
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hashNumber(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function mergeBounds(current: Bounds | null, next: Bounds | null) {
  if (!next) return current;
  if (!current) return next;
  return {
    x1: Math.min(current.x1, next.x1),
    y1: Math.min(current.y1, next.y1),
    x2: Math.max(current.x2, next.x2),
    y2: Math.max(current.y2, next.y2),
  };
}

function measureTextWidth(font: OpenTypeFont, value: string, size: number, tracking = 0) {
  const glyphs = font.stringToGlyphs(value);
  const scale = size / font.unitsPerEm;
  let width = 0;

  glyphs.forEach((glyph, index) => {
    const previousGlyph = glyphs[index - 1];
    if (previousGlyph && font.getKerningValue) width += font.getKerningValue(previousGlyph, glyph) * scale;
    width += glyph.advanceWidth * scale;
    if (index < glyphs.length - 1) width += tracking;
  });

  return Math.max(width, 0);
}

function buildTextPath(font: OpenTypeFont, value: string, size: number, tracking = 0, originX = 0) {
  const glyphs = font.stringToGlyphs(value);
  const scale = size / font.unitsPerEm;
  let cursor = originX;
  const pieces: string[] = [];

  glyphs.forEach((glyph, index) => {
    const previousGlyph = glyphs[index - 1];
    if (previousGlyph && font.getKerningValue) cursor += font.getKerningValue(previousGlyph, glyph) * scale;
    const path = buildGlyphPath(glyph, cursor, 0, scale);
    if (path.d) pieces.push(path.d);
    cursor += glyph.advanceWidth * scale;
    if (index < glyphs.length - 1) cursor += tracking;
  });

  return {
    d: pieces.join(''),
    width: Math.max(cursor - originX, 1),
  };
}

function buildJustifiedTextPath(font: OpenTypeFont, value: string, size: number, tracking: number, targetWidth: number) {
  const tokens = value.match(/\S+/g) ?? [];
  if (!tokens.length) return { d: '', width: 0, tokens: [] as TextTokenBounds[] };

  const naturalWidth = measureTextWidth(font, value, size, tracking);
  const extraWidth = Math.max(0, targetWidth - naturalWidth);
  const gapCount = Math.max(0, tokens.length - 1);
  const wordGap = measureTextWidth(font, ' ', size, tracking) + tracking * 2;
  const extraWordGap = gapCount > 0 ? extraWidth / gapCount : 0;
  const singleTokenTracking = gapCount === 0 && tokens[0].length > 1
    ? tracking + extraWidth / (tokens[0].length - 1)
    : tracking;
  let cursor = 0;
  const tokenBounds: TextTokenBounds[] = [];
  const pieces: string[] = [];

  tokens.forEach((token, index) => {
    const tokenTracking = gapCount === 0 ? singleTokenTracking : tracking;
    const tokenPath = buildTextPath(font, token, size, tokenTracking, cursor);

    if (tokenPath.d) pieces.push(tokenPath.d);

    tokenBounds.push({
      text: token,
      x: cursor,
      width: tokenPath.width,
    });

    cursor += tokenPath.width;
    if (index < tokens.length - 1) cursor += wordGap + extraWordGap;
  });

  return {
    d: pieces.join(''),
    width: Math.max(cursor, naturalWidth),
    tokens: tokenBounds,
  };
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

function flattenGlyphContours(glyph: OpenTypeGlyph, x: number, y: number, scale: number) {
  const commands = glyph.path?.commands ?? [];
  const contours: Point[][] = [];
  let contour: Point[] = [];
  let current: Point | null = null;
  let start: Point | null = null;

  function point(rawX: number, rawY: number) {
    return {
      x: x + rawX * scale,
      y: y - rawY * scale,
    };
  }

  function closeContour() {
    if (contour.length > 2) contours.push(contour);
    contour = [];
    current = null;
    start = null;
  }

  commands.forEach((command: OpenTypeCommand) => {
    if (command.type === 'M') {
      closeContour();
      current = point(command.x, command.y);
      start = current;
      contour.push(current);
      return;
    }

    if (!current) return;

    if (command.type === 'L') {
      current = point(command.x, command.y);
      contour.push(current);
      return;
    }

    if (command.type === 'Q') {
      const control = point(command.x1, command.y1);
      const end = point(command.x, command.y);
      for (let step = 1; step <= CURVE_STEPS; step += 1) {
        contour.push(pointOnQuadratic(current, control, end, step / CURVE_STEPS));
      }
      current = end;
      return;
    }

    if (command.type === 'C') {
      const controlA = point(command.x1, command.y1);
      const controlB = point(command.x2, command.y2);
      const end = point(command.x, command.y);
      for (let step = 1; step <= CURVE_STEPS; step += 1) {
        contour.push(pointOnCubic(current, controlA, controlB, end, step / CURVE_STEPS));
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

function getLineSpans(bounds: Bounds, contours: Point[][], y: number, inset: number) {
  const spans: { x: number; width: number }[] = [];
  const left = bounds.x1 + inset;
  const right = bounds.x2 - inset;
  const intersections: number[] = [];

  contours.forEach((contour) => {
    for (let index = 0; index < contour.length; index += 1) {
      const a = contour[index];
      const b = contour[(index + 1) % contour.length];
      const crosses = a.y > y !== b.y > y;
      if (!crosses) continue;

      const x = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (Number.isFinite(x)) intersections.push(clamp(x, left, right));
    }
  });

  intersections.sort((a, b) => a - b);

  for (let index = 0; index < intersections.length - 1; index += 2) {
    const x1 = clamp(intersections[index], left, right);
    const x2 = clamp(intersections[index + 1], left, right);
    const width = x2 - x1;
    if (width > inset * 2) spans.push({ x: x1, width });
  }

  return spans;
}

function makeLineText(font: OpenTypeFont, words: string[], targetWidth: number, size: number, tracking: number, seed: number) {
  if (!words.length) return '';

  let best = '';
  let index = seed % words.length;
  let nextWord = words[index % words.length] || '';

  for (let count = 0; count < 48; count += 1) {
    const next = words[index % words.length];
    const candidate = best ? `${best} ${next}` : next;
    const candidateWidth = measureTextWidth(font, candidate, size, tracking);

    if (candidateWidth > targetWidth) {
      nextWord = next;
      break;
    }

    best = candidate;
    index += 1;
    nextWord = words[index % words.length] || '';
  }

  let packed = best;
  let partial = '';
  for (const letter of nextWord) {
    const candidatePartial = `${partial}${letter}`;
    const candidate = best ? `${best} ${candidatePartial}` : candidatePartial;
    if (measureTextWidth(font, candidate, size, tracking) > targetWidth) break;
    packed = candidate;
    partial = candidatePartial;
  }

  return packed;
}

function createWordMarker(
  tokens: TextTokenBounds[],
  seed: number,
  x: number,
  baseline: number,
  size: number,
  chance: number,
  colors: string[],
) {
  const roll = ((seed * 9301 + 49297) % 233280) / 233280;
  if (roll > chance) return null;

  const markerTokens = tokens.filter((token) => token.text.length >= 3);
  if (!markerTokens.length) return null;

  const token = markerTokens[seed % markerTokens.length];
  const markerX = x + token.x;
  const markerWidth = token.width;

  if (markerWidth < size * 0.45) return null;

  return {
    x: markerX,
    y: baseline - size * 0.88,
    width: markerWidth + size * 0.08,
    height: size * 0.98,
    color: colors[seed % Math.max(1, colors.length)] ?? '#00a878',
  };
}

export default function GlyphTextFill() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [outerFontFamilyId, setOuterFontFamilyId] = useState('thunder');
  const outerFontFamily = getFontFamilyById(outerFontFamilyId);
  const [outerFontValue, setOuterFontValue] = useState(defaultOuterFont?.value ?? outerFontFamily.defaultFont.value);
  const outerFontMeta = getFontByValue(outerFontFamily.fonts, outerFontValue, outerFontFamily.defaultFont);

  const [innerFontFamilyId, setInnerFontFamilyId] = useState('geist');
  const innerFontFamily = getFontFamilyById(innerFontFamilyId);
  const [innerFontValue, setInnerFontValue] = useState(defaultInnerFont?.value ?? innerFontFamily.defaultFont.value);
  const innerFontMeta = getFontByValue(innerFontFamily.fonts, innerFontValue, innerFontFamily.defaultFont);

  const outerTypography = useControls(
    'Outer Typography',
    {
      fontFamily: {
        value: outerFontFamily.id,
        options: getFontFamilyOptions(),
        label: 'family',
        onChange: (familyId: string) => {
          const nextFamily = getFontFamilyById(familyId);
          setOuterFontFamilyId(nextFamily.id);
          setOuterFontValue(nextFamily.defaultFont.value);
        },
      },
      fontVariant: {
        value: outerFontMeta.value,
        options: getFontVariantOptions(outerFontFamily.fonts),
        label: 'variant',
        onChange: setOuterFontValue,
      },
      text: { value: 'CABIN', rows: 4, label: 'text' },
      size: nativeNumber({ current: 156, min: 42, max: 230, step: 1 }),
      tracking: nativeNumber({ current: 10, min: -24, max: 48, step: 0.5 }),
    },
    { collapsed: false },
    [outerFontFamily.id, outerFontMeta.value],
  );

  const innerTypography = useControls(
    'Inner Typography',
    {
      fontFamily: {
        value: innerFontFamily.id,
        options: getFontFamilyOptions(),
        label: 'family',
        onChange: (familyId: string) => {
          const nextFamily = getFontFamilyById(familyId);
          setInnerFontFamilyId(nextFamily.id);
          setInnerFontValue(nextFamily.defaultFont.value);
        },
      },
      fontVariant: {
        value: innerFontMeta.value,
        options: getFontVariantOptions(innerFontFamily.fonts),
        label: 'variant',
        onChange: setInnerFontValue,
      },
      words: DEFAULT_WORDS,
      size: { ...nativeNumber({ current: 19.5, min: 8, max: 70, step: 0.5 }), label: 'line size' },
      tracking: nativeNumber({ current: 0, min: -10, max: 40, step: 0.25 }),
    },
    { collapsed: false },
    [innerFontFamily.id, innerFontMeta.value],
  );

  const filling = useControls(
    'Filling',
    {
      mask: false,
      leading: nativeNumber({ current: 0.96, min: 0.58, max: 1.35, step: 0.01 }),
      markers: nativeNumber({ current: 0.4, min: 0, max: 0.85, step: 0.01 }),
      seed: nativeNumber({ current: 2048, min: 1, max: 9999, step: 1 }),
    },
    { collapsed: false },
  );

  const drawing = useControls(
    'Drawing',
    {
      ink: '#070707',
      background: '#f2f1ee',
      outline: nativeNumber({ current: 0, min: 0, max: 3, step: 0.1 }),
      Markers: folder({
        markerAlpha: { ...nativeNumber({ current: 0.92, min: 0.2, max: 1, step: 0.01 }), label: 'marker alpha' },
        editorialMarkerColors: {
          ...colorPalette({
            value: { source: EDITORIAL_HIGHLIGHTER_PALETTE.id, colors: EDITORIAL_HIGHLIGHTER_PALETTE.colors },
            palettes: MARKER_PALETTES,
          }),
          label: 'marker colors',
        },
      }, { collapsed: false }),
    },
    { collapsed: false },
  );

  useControls({
    'Download SVG': button(() => {
      downloadSvg(svgRef.current, `${cleanFilePart(String(outerTypography.text))}-glyph-text-fill.svg`);
    }),
  });

  const { font: outerFont, error: outerFontError } = useOpenTypeFont(outerFontMeta.url);
  const { font: innerFont, error: innerFontError } = useOpenTypeFont(innerFontMeta.url);
  const mainSize = Number(outerTypography.size) * MAIN_SIZE_SCALE;
  const mainTracking = Number(outerTypography.tracking) * TRACKING_SCALE;
  const lineSize = Number(innerTypography.size);
  const lineStep = Math.max(4, lineSize * Number(filling.leading));
  const spanInset = 0;
  const fillTracking = Number(innerTypography.tracking);
  const outlineWidth = Number(drawing.outline);
  const markerColors = drawing.editorialMarkerColors.colors;
  const words = String(innerTypography.words).toUpperCase().split(/[\s,;/]+/).filter(Boolean);

  const filledGlyphs = useMemo<FilledGlyph[]>(() => {
    if (!outerFont || !innerFont) return [];

    const glyphs = outerFont.stringToGlyphs(String(outerTypography.text).toUpperCase() || ' ');
    const scale = mainSize / outerFont.unitsPerEm;
    let cursor = 0;
    let layoutBounds: Bounds | null = null;
    const placements: GlyphPlacement[] = [];

    glyphs.forEach((glyph, index) => {
      const previousGlyph = glyphs[index - 1];
      if (previousGlyph && outerFont.getKerningValue) cursor += outerFont.getKerningValue(previousGlyph, glyph) * scale;

      placements.push({ glyph, x: cursor });
      layoutBounds = mergeBounds(layoutBounds, buildGlyphPath(glyph, cursor, 0, scale).bounds);

      cursor += glyph.advanceWidth * scale;
      if (index < glyphs.length - 1) cursor += mainTracking;
    });

    const bounds = layoutBounds ?? { x1: 0, y1: -mainSize, x2: Math.max(cursor, 1), y2: 0 };
    const paddedWidth = Math.max(bounds.x2 - bounds.x1, 1);
    const paddedHeight = Math.max(bounds.y2 - bounds.y1, 1);
    const maxWidth = Math.max(1, STAGE.width - STAGE_MARGIN * 2);
    const maxHeight = Math.max(1, STAGE.height - STAGE_MARGIN * 2);
    const fitScale = Math.min(1, maxWidth / paddedWidth, maxHeight / paddedHeight);
    const finalScale = scale * fitScale;
    const offsetX = STAGE.width / 2 - (bounds.x1 + paddedWidth / 2) * fitScale;
    const offsetY = STAGE.height / 2 - (bounds.y1 + paddedHeight / 2) * fitScale;

    return placements.flatMap((placement, glyphIndex) => {
      const path = buildGlyphPath(placement.glyph, offsetX + placement.x * fitScale, offsetY, finalScale);
      if (!path.bounds || !path.d) return [];

      const contours = flattenGlyphContours(placement.glyph, offsetX + placement.x * fitScale, offsetY, finalScale);
      const top = path.bounds.y1 + lineSize * 0.48;
      const bottom = path.bounds.y2 - lineSize * 0.32;
      const lines: GlyphFillLine[] = [];

      for (let y = top; y <= bottom; y += lineStep) {
        const spans = getLineSpans(path.bounds, contours, y, spanInset);

        spans.forEach((span, spanIndex) => {
          if (span.width < lineSize * 1.6) return;

          const seed = hashNumber(`${Number(filling.seed)}-${glyphIndex}-${Math.round(y)}-${spanIndex}`);
          const text = makeLineText(innerFont, words, span.width, lineSize, fillTracking, seed);
          const linePath = buildJustifiedTextPath(innerFont, text, lineSize, fillTracking, span.width);
          if (!linePath.d) return;

          const baseline = y + lineSize * 0.34;
          lines.push({
            id: `${glyphIndex}-${Math.round(y)}-${spanIndex}`,
            d: linePath.d,
            x: span.x,
            y: baseline,
            marker: createWordMarker(
              linePath.tokens,
              seed,
              span.x,
              baseline,
              lineSize,
              Number(filling.markers),
              markerColors,
            ),
          });
        });
      }

      return [{
        id: `${placement.glyph.index}-${glyphIndex}`,
        d: path.d,
        bounds: path.bounds,
        lines,
      }];
    });
  }, [
    outerFont,
    innerFont,
    outerTypography.text,
    mainSize,
    mainTracking,
    lineSize,
    lineStep,
    spanInset,
    fillTracking,
    filling.seed,
    filling.markers,
    markerColors.join('|'),
    words.join('|'),
  ]);

  if (outerFontError || innerFontError) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Font failed to load: {outerFontError || innerFontError}</div>
        <SketchControls fill flat />
      </section>
    );
  }

  if (!outerFont || !innerFont) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Loading font...</div>
        <SketchControls fill flat />
      </section>
    );
  }

  return (
    <section className="sketch-workbench">
      <div className="sketch-stage">
        <svg
          ref={svgRef}
          className="type-svg"
          viewBox={`0 0 ${STAGE.width} ${STAGE.height}`}
          role="img"
          aria-label={`${outerTypography.text} filled with rows of glyph text`}
          style={{ backgroundColor: String(drawing.background) }}
        >
          {filling.mask && (
            <defs>
              {filledGlyphs.map((glyph) => (
                <clipPath key={`clip-${glyph.id}`} id={`glyph-text-fill-${glyph.id}`} clipPathUnits="userSpaceOnUse">
                  <path d={glyph.d} />
                </clipPath>
              ))}
            </defs>
          )}

          <rect width={STAGE.width} height={STAGE.height} fill={String(drawing.background)} />

          {filledGlyphs.map((glyph) => (
            <g key={glyph.id} clipPath={filling.mask ? `url(#glyph-text-fill-${glyph.id})` : undefined}>
              {glyph.lines.map((line) => (
                <g key={line.id}>
                  {line.marker && (
                    <rect
                      x={formatPathNumber(line.marker.x)}
                      y={formatPathNumber(line.marker.y)}
                      width={formatPathNumber(line.marker.width)}
                      height={formatPathNumber(line.marker.height)}
                      fill={line.marker.color}
                      opacity={Number(drawing.markerAlpha)}
                    />
                  )}
                  <path
                    d={line.d}
                    fill={String(drawing.ink)}
                    transform={`translate(${formatPathNumber(line.x)} ${formatPathNumber(line.y)})`}
                  />
                </g>
              ))}
            </g>
          ))}

          {outlineWidth > 0 && filledGlyphs.map((glyph) => (
            <path
              key={`outline-${glyph.id}`}
              d={glyph.d}
              fill="none"
              stroke={String(drawing.ink)}
              strokeWidth={outlineWidth}
              vectorEffect="non-scaling-stroke"
              opacity="0.24"
            />
          ))}
        </svg>
      </div>
      <SketchControls fill flat collapsed={false} oneLineLabels={false} />
    </section>
  );
}
