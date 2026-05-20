import { useMemo, useRef, useState } from 'react';
import { button, folder, useControls } from 'leva';
import { SketchControls } from '../../../components/SketchControls';
import { colorPalette } from '../../../controls/colorPalettePlugin';
import { nativeNumber } from '../../../controls/nativeNumberPlugin';
import { originalPlaygroundPalette, sketchPalettePresets } from '../../../data/palettes';
import {
  getFontByValue,
  getFontFamilyById,
  getFontFamilyOptions,
  getFontVariantOptions,
  humaneFontFamily,
} from '../../../data/fonts';
import { buildGlyphPath, useOpenTypeFont } from './_opentype';
import type { Bounds } from './_types';
import { getSlicePolygons, polygonToPath } from './_geometry';

type GlyphLayout = {
  glyphs: { id: string; d: string }[];
  metrics: { x: number; y: number; width: number; height: number };
};

const STAGE = { width: 30000, height: 15000 };
const SIZE_SCALE = 100;
const LETTER_SPACING_SCALE = 15;
const DISPLACEMENT_SCALE = 100;

function downloadSvg(svgElement: SVGSVGElement | null, fileName: string) {
  if (!svgElement) return;
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function cleanFilePart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'sketch';
}

function colorAt(colors: string[], index: number, total: number) {
  if (total <= 1) return colors[0] ?? '#111111';
  return colors[index % Math.max(1, colors.length)] ?? '#111111';
}

export default function TypographicSlicing() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [selectedFontFamilyId, setSelectedFontFamilyId] = useState(humaneFontFamily.id);
  const selectedFontFamily = getFontFamilyById(selectedFontFamilyId);
  const [selectedFontValue, setSelectedFontValue] = useState(selectedFontFamily.defaultFont.value);
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
      text: 'HUMANE',
      color: '#0f0f0d',
      size: nativeNumber({ current: 142, min: 12, max: 300, step: 0.5 }),
      letterSpacing: nativeNumber({ current: 0, min: -5, max: 80, step: 0.1 }),
    },
    { collapsed: false },
    [selectedFontFamily.id, selectedFont.value],
  );
  const canvas = useControls('Canvas', {
    background: '#f8f7f3',
  }, { collapsed: false });
  const slicingControls = useControls('Slicing', {
    enabled: true,
    count: nativeNumber({ current: 150, min: 1, max: 420, step: 1 }),
    angle: nativeNumber({ current: -18, min: -90, max: 90, step: 1 }),
    phase: nativeNumber({ current: 0, min: -0.99, max: 0.99, step: 0.01 }),
    gap: nativeNumber({ current: 0.5, min: 0, max: 18, step: 0.01 }),
    displaceX: { ...nativeNumber({ current: 0, min: -80, max: 80, step: 0.1 }), label: 'x' },
    displaceY: { ...nativeNumber({ current: 0, min: -80, max: 80, step: 0.1 }), label: 'y' },
    Color: folder({
      mode: {
        value: 'solid',
        options: { solid: 'solid', palette: 'palette' },
      },
      palette: colorPalette({
        value: { source: 'original-playground', colors: [...originalPlaygroundPalette] },
        palettes: sketchPalettePresets,
      }),
    }, { collapsed: false }),
  }, { collapsed: false });
  useControls({
    'Download SVG': button(() => {
      downloadSvg(svgRef.current, `${cleanFilePart(String(typography.text))}-${cleanFilePart(selectedFont.label)}.svg`);
    }),
  });

  const { font, error } = useOpenTypeFont(selectedFont.url);
  const numericSize = Number(typography.size) * SIZE_SCALE;
  const numericLetterSpacing = Number(typography.letterSpacing) * LETTER_SPACING_SCALE;
  const sliceCount = Math.max(1, Math.round(Number(slicingControls.count) || 1));
  const sliceCenter = (sliceCount - 1) / 2;
  const sliceRadians = (Number(slicingControls.angle) * Math.PI) / 180;
  const sliceNormal = { x: -Math.sin(sliceRadians), y: Math.cos(sliceRadians) };
  const gap = Number(slicingControls.gap) * DISPLACEMENT_SCALE;
  const manualX = Number(slicingControls.displaceX) * DISPLACEMENT_SCALE * (6 / sliceCount);
  const manualY = Number(slicingControls.displaceY) * DISPLACEMENT_SCALE * (6 / sliceCount);
  const maskPaddingX = Math.abs(sliceNormal.x * gap + manualX) * sliceCenter;
  const maskPaddingY = Math.abs(sliceNormal.y * gap + manualY) * sliceCenter;

  const glyphLayout = useMemo<GlyphLayout>(() => {
    if (!font) {
      return { glyphs: [], metrics: { x: 0, y: 0, width: 1, height: 1 } };
    }

    const glyphs = font.stringToGlyphs(String(typography.text).trim() || ' ');
    const scale = numericSize / font.unitsPerEm;
    let cursor = 0;
    let layoutMinX = 0;
    let bounds: Bounds | null = null;

    const paths = glyphs.map((glyph, index) => {
      const previousGlyph = glyphs[index - 1];
      if (previousGlyph && font.getKerningValue) cursor += font.getKerningValue(previousGlyph, glyph) * scale;
      const path = buildGlyphPath(glyph, cursor, 0, scale);

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
      if (index < glyphs.length - 1) cursor += numericLetterSpacing;
      return { id: `${glyph.index}-${index}`, d: path.d };
    });

    const measuredBounds = bounds as Bounds | null;
    const metrics = measuredBounds
      ? {
          x: Math.min(measuredBounds.x1, layoutMinX),
          y: measuredBounds.y1,
          width: Math.max(Math.max(measuredBounds.x2, cursor) - Math.min(measuredBounds.x1, layoutMinX), 1),
          height: Math.max(measuredBounds.y2 - measuredBounds.y1, 1),
        }
      : { x: 0, y: -numericSize, width: Math.max(cursor, 1), height: numericSize || 1 };

    return { glyphs: paths, metrics };
  }, [font, numericLetterSpacing, numericSize, typography.text]);

  const slicePolygons = useMemo(
    () => getSlicePolygons(
      sliceCount,
      Number(slicingControls.angle),
      Number(slicingControls.phase),
      maskPaddingX,
      maskPaddingY,
      STAGE.width,
      STAGE.height,
    ),
    [maskPaddingX, maskPaddingY, sliceCount, slicingControls.angle, slicingControls.phase],
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

  const translateX = STAGE.width / 2 - (glyphLayout.metrics.x + glyphLayout.metrics.width / 2);
  const translateY = STAGE.height / 2 - (glyphLayout.metrics.y + glyphLayout.metrics.height / 2);
  const palette = slicingControls.palette.colors;

  function renderGlyphs(fill = String(typography.color)) {
    return (
      <g transform={`translate(${translateX} ${translateY})`} overflow="visible">
        {glyphLayout.glyphs.map((glyph) => <path key={glyph.id} d={glyph.d} fill={fill} />)}
      </g>
    );
  }

  return (
    <section className="sketch-workbench">
      <div className="sketch-stage">
        <svg
          ref={svgRef}
          className="type-svg"
          viewBox={`0 0 ${STAGE.width} ${STAGE.height}`}
          overflow="visible"
          role="img"
          aria-label={`${typography.text} rendered as sliced SVG type`}
          style={{ backgroundColor: String(canvas.background) }}
        >
          {slicingControls.enabled && (
            <defs>
              {slicePolygons.map((polygon, index) => {
                const sliceOffset = index - sliceCenter;
                const gapX = sliceOffset * sliceNormal.x * gap;
                const gapY = sliceOffset * sliceNormal.y * gap;

                return (
                  <clipPath key={`slice-clip-${index}`} id={`slice-clip-${index}`} clipPathUnits="userSpaceOnUse">
                    {polygon.map((path, pathIndex) => (
                      <path
                        key={`slice-clip-${index}-${pathIndex}`}
                        d={polygonToPath(path)}
                        transform={`translate(${gapX} ${gapY})`}
                      />
                    ))}
                  </clipPath>
                );
              })}
            </defs>
          )}

          {slicingControls.enabled
            ? slicePolygons.map((_polygon, index) => {
                const sliceOffset = index - sliceCenter;
                const displacementX = sliceOffset * sliceNormal.x * gap + sliceOffset * manualX;
                const displacementY = sliceOffset * sliceNormal.y * gap + sliceOffset * manualY;
                const fill = slicingControls.mode === 'palette'
                  ? colorAt(palette, index, slicePolygons.length)
                  : String(typography.color);

                return (
                  <g key={`slice-${index}`} clipPath={`url(#slice-clip-${index})`}>
                    <g transform={`translate(${displacementX} ${displacementY})`}>{renderGlyphs(fill)}</g>
                  </g>
                );
              })
            : renderGlyphs()}
        </svg>
      </div>
      <SketchControls fill flat collapsed={false} oneLineLabels={false} />
    </section>
  );
}
