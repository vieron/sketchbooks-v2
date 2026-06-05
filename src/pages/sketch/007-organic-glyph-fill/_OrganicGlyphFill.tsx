import { useEffect, useMemo, useRef, useState } from 'react';
import { button, folder, useControls } from 'leva';
import { SketchControls } from '../../../components/SketchControls';
import { nativeNumber } from '../../../controls/nativeNumberPlugin';
import {
  getFontByValue,
  getFontFamilyById,
  getFontFamilyOptions,
  getFontVariantOptions,
  thunderFonts,
} from '../../../data/fonts';
import { downloadSvg } from '../../../utils/svgDownload';
import { generateOrganicGlyphFill, type OrganicGlyphFillOptions } from './_organicGlyphFillGenerator';

type RenderState = {
  svg: string;
  pending: boolean;
  error: string;
};

const STAGE = { width: 1500, height: 1200 };
const GENERATE_DEBOUNCE_MS = 120;

const defaultFontFamily = getFontFamilyById('thunder');
const defaultFont = thunderFonts.find((font) => font.variant === 'Extra Bold LC') ?? defaultFontFamily.defaultFont;

function cleanFilePart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'organic-glyph-fill';
}

export default function OrganicGlyphFill() {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const generationRef = useRef(0);
  const [fontFamilyId, setFontFamilyId] = useState(defaultFontFamily.id);
  const fontFamily = getFontFamilyById(fontFamilyId);
  const [fontValue, setFontValue] = useState(defaultFont.value);
  const fontMeta = getFontByValue(fontFamily.fonts, fontValue, fontFamily.defaultFont);
  const [renderState, setRenderState] = useState<RenderState>({
    svg: '',
    pending: true,
    error: '',
  });

  const typography = useControls(
    'Typography',
    {
      fontFamily: {
        value: fontFamily.id,
        options: getFontFamilyOptions(),
        label: 'family',
        onChange: (familyId: string) => {
          const nextFamily = getFontFamilyById(familyId);
          setFontFamilyId(nextFamily.id);
          setFontValue(nextFamily.defaultFont.value);
        },
      },
      fontVariant: {
        value: fontMeta.value,
        options: getFontVariantOptions(fontFamily.fonts),
        label: 'variant',
        onChange: setFontValue,
      },
      text: { value: 'CELL', rows: 2, label: 'text' },
      size: nativeNumber({ current: 820, min: 160, max: 1120, step: 1 }),
    },
    { collapsed: false },
    [fontFamily.id, fontMeta.value],
  );

  const cells = useControls(
    'Cell Packing',
    {
      cellCount: { ...nativeNumber({ current: 24, min: 8, max: 80, step: 1 }), label: 'count' },
      relaxation: { ...nativeNumber({ current: 7, min: 0, max: 18, step: 1 }), label: 'relax' },
      gap: nativeNumber({ current: 12, min: 1, max: 34, step: 0.5 }),
      smoothing: nativeNumber({ current: 0.9, min: 0, max: 1, step: 0.01 }),
      seed: nativeNumber({ current: 12345, min: 1, max: 99999, step: 1 }),
    },
    { collapsed: false },
  );

  const form = useControls(
    'Blob Shape',
    {
      anisotropyXV3: { ...nativeNumber({ current: 1.6, min: 0.35, max: 2.4, step: 0.01 }), label: 'bias x' },
      anisotropyYV3: { ...nativeNumber({ current: 0.7, min: 0.35, max: 2.4, step: 0.01 }), label: 'bias y' },
      softenPassesV3: { ...nativeNumber({ current: 2, min: 0, max: 2, step: 1 }), label: 'soften' },
      blobAmountV3: { ...nativeNumber({ current: 0.18, min: 0, max: 0.32, step: 0.01 }), label: 'blob' },
    },
    { collapsed: false },
  );

  const cleanup = useControls(
    'Cell Cleanup',
    {
      arcToleranceV2: { ...nativeNumber({ current: 1.5, min: 0.2, max: 8, step: 0.1 }), label: 'arc' },
      boundaryMarginV2: { ...nativeNumber({ current: 18, min: 0, max: 80, step: 0.5 }), label: 'margin' },
      minAreaRatioV2: { ...nativeNumber({ current: 0.006, min: 0.001, max: 0.03, step: 0.001 }), label: 'min area' },
    },
    { collapsed: false },
  );

  const drawing = useControls(
    'Drawing',
    {
      cells: '#30363a',
      glyph: '#ebe8e1',
      background: '#ff6a00',
      Export: folder(
        {
          download: button(() => {
            const svgElement = frameRef.current?.querySelector('svg') ?? null;
            downloadSvg(svgElement, `${cleanFilePart(String(typography.text))}-organic-glyph-fill.svg`);
          }),
        },
        { collapsed: false },
      ),
    },
    { collapsed: false },
  );

  const generationOptions = useMemo<OrganicGlyphFillOptions>(() => ({
    fontUrl: fontMeta.url,
    text: String(typography.text || 'D').toUpperCase(),
    fontSize: Number(typography.size),
    width: STAGE.width,
    height: STAGE.height,
    cellCount: Number(cells.cellCount),
    lloydIterations: Number(cells.relaxation),
    gap: Number(cells.gap),
    smoothing: Number(cells.smoothing),
    seed: Number(cells.seed),
    foregroundColor: String(drawing.cells),
    backgroundColor: String(drawing.background),
    glyphColor: String(drawing.glyph),
    anisotropyX: Number(form.anisotropyXV3),
    anisotropyY: Number(form.anisotropyYV3),
    chaikinPasses: Number(form.softenPassesV3),
    blobificationAmount: Number(form.blobAmountV3),
    arcTolerance: Number(cleanup.arcToleranceV2),
    boundaryMargin: Number(cleanup.boundaryMarginV2),
    minAreaRatio: Number(cleanup.minAreaRatioV2),
  }), [
    fontMeta.url,
    typography.text,
    typography.size,
    cells.cellCount,
    cells.relaxation,
    cells.gap,
    cells.smoothing,
    cells.seed,
    drawing.cells,
    drawing.background,
    drawing.glyph,
    form.anisotropyXV3,
    form.anisotropyYV3,
    form.softenPassesV3,
    form.blobAmountV3,
    cleanup.arcToleranceV2,
    cleanup.boundaryMarginV2,
    cleanup.minAreaRatioV2,
  ]);

  useEffect(() => {
    const generationId = generationRef.current + 1;
    generationRef.current = generationId;
    setRenderState((current) => ({ ...current, pending: true, error: '' }));

    const timeout = window.setTimeout(() => {
      generateOrganicGlyphFill(generationOptions)
        .then((svg) => {
          if (generationRef.current !== generationId) return;
          setRenderState({ svg, pending: false, error: '' });
        })
        .catch((error: unknown) => {
          if (generationRef.current !== generationId) return;
          setRenderState({
            svg: '',
            pending: false,
            error: error instanceof Error ? error.message : 'Unable to generate glyph fill',
          });
        });
    }, GENERATE_DEBOUNCE_MS);

    return () => window.clearTimeout(timeout);
  }, [generationOptions]);

  if (renderState.error) {
    return (
      <section className="sketch-workbench">
        <div className="canvas-state">Organic glyph fill failed: {renderState.error}</div>
        <SketchControls fill flat collapsed={false} oneLineLabels={false} />
      </section>
    );
  }

  return (
    <section className="sketch-workbench">
      <div className="sketch-stage organic-glyph-fill-stage" style={{ backgroundColor: String(drawing.background) }}>
        {renderState.svg ? (
          <div
            ref={frameRef}
            className={renderState.pending ? 'organic-glyph-fill is-pending' : 'organic-glyph-fill'}
            dangerouslySetInnerHTML={{ __html: renderState.svg }}
          />
        ) : (
          <div className="canvas-state">Carving cells...</div>
        )}
      </div>
      <SketchControls fill flat collapsed={false} oneLineLabels={false} />
    </section>
  );
}
