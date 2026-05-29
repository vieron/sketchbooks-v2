import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { button, useControls } from "leva";
import { SketchControls } from "../../../components/SketchControls";
import { nativeNumber } from "../../../controls/nativeNumberPlugin";
import {
  getFontByValue,
  getFontFamilyById,
  getFontFamilyOptions,
  getFontVariantOptions,
  geistFonts,
} from "../../../data/fonts";
import { downloadSvg } from "../../../utils/svgDownload";
import {
  buildGlyphPath,
  formatPathNumber,
  useOpenTypeFont,
} from "../_type/_opentype";
import type { Bounds, OpenTypeFont, OpenTypeGlyph } from "../_type/_types";

type GlyphShape = {
  id: string;
  d: string;
  bounds: Bounds;
};

type GlyphPlacement = {
  glyph: OpenTypeGlyph;
  x: number;
  y: number;
};

type SeedMode = "walls" | "islands" | "both";

type StaticReactionOutput = {
  inkPaths: string[];
  shapes: GlyphShape[];
};

type GlyphMaskJob = {
  width: number;
  height: number;
  originX: number;
  originY: number;
  glyphMask: Uint8Array;
};

type GlyphMaskCache = {
  key: string;
  jobs: GlyphMaskJob[];
};

type ReactionWorkerResponse = {
  jobId: number;
  glyphIndex: number;
  inkPath: string;
};

type RateRange = {
  min: number;
  max: number;
  step: number;
};

type ReactionRates = {
  feed: number;
  kill: number;
};

type RateMapRanges = {
  feed: RateRange;
  kill: RateRange;
};

type RateMapPointerPoint = {
  x: number;
  y: number;
  rates: ReactionRates;
};

type RateMapPreviewSettings = {
  behavior: ReactionPresetKey;
  steps: number;
  grain: number;
  bleed: number;
  seed: number;
  birth: number;
  seedMode: SeedMode;
  ranges: RateMapRanges;
  contrast: number;
  threshold: number;
  band: number;
  weight: number;
  paper: string;
  ink: string;
};

type RateMapWorkerResponse = {
  jobId: number;
  width: number;
  height: number;
  pixels: ArrayBuffer;
};

const STAGE = { width: 1800, height: 1200 };
const STAGE_MARGIN = 78;
const MAIN_SIZE_SCALE = 4.72;
const TRACKING_SCALE = 3;
const DEFAULT_TEXT = "REACTION\nDIFFUSION";
const RENDER_DEBOUNCE_MS = 180;
const FEED_RANGE = { min: 0.008, max: 0.115, step: 0.0001 } satisfies RateRange;
const KILL_RANGE = { min: 0.055, max: 0.065, step: 0.0001 } satisfies RateRange;
const STEPS_RANGE = { min: 120, max: 3200, step: 20 } satisfies RateRange;
const GRAIN_RANGE = { min: 180, max: 2400, step: 10 } satisfies RateRange;
const BLEED_RANGE = { min: 0, max: 90, step: 1 } satisfies RateRange;
const BIRTH_RANGE = { min: 0.08, max: 1, step: 0.01 } satisfies RateRange;
const SEED_RANGE = { min: 1, max: 9999, step: 1 } satisfies RateRange;

const REACTION_PRESETS = {
  simsCoral: {
    label: "Sims coral",
    feed: 0.0545,
    kill: 0.062,
  },
  simsMitosis: {
    label: "Sims mitosis",
    feed: 0.0367,
    kill: 0.0649,
  },
  munafoLambda: {
    label: "MROB lambda spots",
    feed: 0.026,
    kill: 0.061,
  },
  munafoGamma: {
    label: "MROB gamma stripes",
    feed: 0.026,
    kill: 0.055,
  },
  munafoKappa: {
    label: "MROB kappa mazes",
    feed: 0.05,
    kill: 0.0609,
  },
  munafoPi: {
    label: "MROB pi loops",
    feed: 0.062,
    kill: 0.061,
  },
  munafoRho: {
    label: "MROB rho bubbles",
    feed: 0.09,
    kill: 0.059,
  },
} satisfies Record<string, { label: string; feed: number; kill: number }>;

type ReactionPresetKey = keyof typeof REACTION_PRESETS;

const REACTION_PRESET_OPTIONS = Object.fromEntries(
  Object.entries(REACTION_PRESETS).map(([key, preset]) => [preset.label, key]),
);

const SEED_MODE_OPTIONS = {
  "Walls + islands": "both",
  Walls: "walls",
  Islands: "islands",
} satisfies Record<string, SeedMode>;

const defaultFontFamily = getFontFamilyById("geist");
const defaultFont =
  geistFonts.find((font) => font.variant === "Black") ??
  defaultFontFamily.defaultFont;

function cleanFilePart(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "glyph-reaction-diffusion"
  );
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function snapRate(value: number, range: RateRange) {
  const snapped =
    range.min + Math.round((value - range.min) / range.step) * range.step;
  return Number(clampNumber(snapped, range.min, range.max).toFixed(4));
}

function formatRate(value: number) {
  return Number(value).toFixed(4);
}

function getFocusedRateRange(center: number, range: RateRange, span: number) {
  const halfSpan = span / 2;
  let min = center - halfSpan;
  let max = center + halfSpan;

  if (min < range.min) {
    max += range.min - min;
    min = range.min;
  }

  if (max > range.max) {
    min -= max - range.max;
    max = range.max;
  }

  return {
    min: snapRate(min, range),
    max: snapRate(max, range),
    step: range.step,
  };
}

function getRateMapRanges(behavior: ReactionPresetKey) {
  const preset = REACTION_PRESETS[behavior];

  return {
    feed: getFocusedRateRange(preset.feed, FEED_RANGE, 0.05),
    kill: getFocusedRateRange(preset.kill, KILL_RANGE, 0.005),
  } satisfies RateMapRanges;
}

function getRateMapPoint(feed: number, kill: number, ranges: RateMapRanges) {
  return {
    x:
      ((clampNumber(kill, ranges.kill.min, ranges.kill.max) - ranges.kill.min) /
        (ranges.kill.max - ranges.kill.min)) *
      100,
    y:
      (1 -
        (clampNumber(feed, ranges.feed.min, ranges.feed.max) -
          ranges.feed.min) /
          (ranges.feed.max - ranges.feed.min)) *
      100,
  };
}

function getRateFromMapPosition(x: number, y: number, ranges: RateMapRanges) {
  return {
    kill: snapRate(
      ranges.kill.min + x * (ranges.kill.max - ranges.kill.min),
      KILL_RANGE,
    ),
    feed: snapRate(
      ranges.feed.max - y * (ranges.feed.max - ranges.feed.min),
      FEED_RANGE,
    ),
  };
}

function formatCacheNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(3) : "0";
}

function getSimulationBleedCells(boundaryBleed: number) {
  return boundaryBleed <= 0 ? 0 : Math.round(boundaryBleed * 1.85 + 8);
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

function normalizeTextLines(value: string) {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  return lines.some((line) => line.trim().length > 0)
    ? lines
    : DEFAULT_TEXT.split("\n");
}

function layoutGlyphShapes(
  font: OpenTypeFont,
  text: string,
  size: number,
  tracking: number,
  lineHeight: number,
) {
  const scale = size / font.unitsPerEm;
  const baselineStep = size * lineHeight;
  const placements: GlyphPlacement[] = [];
  let layoutBounds: Bounds | null = null;

  normalizeTextLines(text).forEach((line, lineIndex) => {
    const glyphs = font.stringToGlyphs(line || " ");
    const baseline = lineIndex * baselineStep;
    const linePlacements: GlyphPlacement[] = [];
    let cursor = 0;
    let lineBounds: Bounds | null = null;

    for (let glyphIndex = 0; glyphIndex < glyphs.length; glyphIndex += 1) {
      const glyph = glyphs[glyphIndex];
      const previousGlyph = glyphs[glyphIndex - 1];
      if (previousGlyph && font.getKerningValue)
        cursor += font.getKerningValue(previousGlyph, glyph) * scale;

      linePlacements.push({ glyph, x: cursor, y: baseline });
      lineBounds = mergeBounds(
        lineBounds,
        buildGlyphPath(glyph, cursor, baseline, scale).bounds,
      );

      cursor += glyph.advanceWidth * scale;
      if (glyphIndex < glyphs.length - 1) cursor += tracking;
    }

    const resolvedLineBounds = lineBounds;
    if (!resolvedLineBounds) return;

    const lineOffsetX = -((resolvedLineBounds.x1 + resolvedLineBounds.x2) / 2);
    linePlacements.forEach((placement) =>
      placements.push({ ...placement, x: placement.x + lineOffsetX }),
    );
    layoutBounds = mergeBounds(layoutBounds, {
      x1: resolvedLineBounds.x1 + lineOffsetX,
      y1: resolvedLineBounds.y1,
      x2: resolvedLineBounds.x2 + lineOffsetX,
      y2: resolvedLineBounds.y2,
    });
  });

  const bounds = layoutBounds ?? { x1: 0, y1: -size, x2: size, y2: 0 };
  const width = Math.max(bounds.x2 - bounds.x1, 1);
  const height = Math.max(bounds.y2 - bounds.y1, 1);
  const maxWidth = Math.max(1, STAGE.width - STAGE_MARGIN * 2);
  const maxHeight = Math.max(1, STAGE.height - STAGE_MARGIN * 2);
  const fitScale = Math.min(1, maxWidth / width, maxHeight / height);
  const finalScale = scale * fitScale;
  const offsetX = STAGE.width / 2 - (bounds.x1 + width / 2) * fitScale;
  const offsetY = STAGE.height / 2 - (bounds.y1 + height / 2) * fitScale;

  return placements.flatMap((placement, glyphIndex) => {
    const x = offsetX + placement.x * fitScale;
    const y = offsetY + placement.y * fitScale;
    const path = buildGlyphPath(placement.glyph, x, y, finalScale);
    if (!path.bounds || !path.d) return [];

    return [
      {
        id: `${glyphIndex}-${placement.glyph.index}`,
        d: path.d,
        bounds: path.bounds,
      },
    ];
  });
}

function createRasterGlyphMask(
  width: number,
  height: number,
  shapes: GlyphShape[],
  originX: number,
  originY: number,
  cellSize: number,
) {
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const context = maskCanvas.getContext("2d", { willReadFrequently: true });
  const mask = new Uint8Array(width * height);

  if (!context) return mask;

  context.clearRect(0, 0, width, height);
  context.save();
  context.scale(1 / cellSize, 1 / cellSize);
  context.translate(-originX, -originY);
  context.fillStyle = "#ffffff";

  shapes.forEach((shape) => {
    context.fill(new Path2D(shape.d), "evenodd");
  });

  context.restore();

  const pixels = context.getImageData(0, 0, width, height).data;
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = pixels[index * 4 + 3] > 16 ? 1 : 0;
  }

  return mask;
}

function createGlyphMaskJob(
  shape: GlyphShape,
  cellSize: number,
  boundaryBleed: number,
): GlyphMaskJob {
  const simulationBleed = getSimulationBleedCells(boundaryBleed);
  const margin = (simulationBleed + 3) * cellSize;
  const originX = Math.floor((shape.bounds.x1 - margin) / cellSize) * cellSize;
  const originY = Math.floor((shape.bounds.y1 - margin) / cellSize) * cellSize;
  const maxX = Math.ceil((shape.bounds.x2 + margin) / cellSize) * cellSize;
  const maxY = Math.ceil((shape.bounds.y2 + margin) / cellSize) * cellSize;
  const width = Math.max(12, Math.ceil((maxX - originX) / cellSize));
  const height = Math.max(12, Math.ceil((maxY - originY) / cellSize));
  const glyphMask = createRasterGlyphMask(
    width,
    height,
    [shape],
    originX,
    originY,
    cellSize,
  );

  return { width, height, originX, originY, glyphMask };
}

function createGlyphMaskCacheKey(
  shapes: GlyphShape[],
  cellSize: number,
  boundaryBleed: number,
) {
  return [
    formatCacheNumber(cellSize),
    formatCacheNumber(boundaryBleed),
    shapes
      .map((shape) =>
        [
          shape.id,
          formatCacheNumber(shape.bounds.x1),
          formatCacheNumber(shape.bounds.y1),
          formatCacheNumber(shape.bounds.x2),
          formatCacheNumber(shape.bounds.y2),
          shape.d,
        ].join(":"),
      )
      .join("|"),
  ].join("::");
}

function FeedKillMapDialog({
  feed,
  kill,
  preview,
  onClose,
  onPick,
}: {
  feed: number;
  kill: number;
  preview: RateMapPreviewSettings;
  onClose: () => void;
  onPick: (rates: ReactionRates) => void;
}) {
  const mapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rateMapJobRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isPreviewPending, setIsPreviewPending] = useState(true);
  const point = useMemo(
    () => getRateMapPoint(feed, kill, preview.ranges),
    [feed, kill, preview.ranges],
  );
  const [hoverPoint, setHoverPoint] = useState<RateMapPointerPoint | null>(
    null,
  );
  const guidePoint = hoverPoint ?? { ...point, rates: { feed, kill } };
  const presetPoints = useMemo(
    () =>
      Object.entries(REACTION_PRESETS).flatMap(([key, preset]) => {
        if (
          preset.feed < preview.ranges.feed.min ||
          preset.feed > preview.ranges.feed.max ||
          preset.kill < preview.ranges.kill.min ||
          preset.kill > preview.ranges.kill.max
        ) {
          return [];
        }

        return [
          {
            key,
            label: preset.label,
            ...getRateMapPoint(preset.feed, preset.kill, preview.ranges),
          },
        ];
      }),
    [preview.ranges],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    setHoverPoint(null);
  }, [preview.ranges]);

  useEffect(() => {
    const canvas = mapCanvasRef.current;
    if (!canvas) return undefined;
    let worker: Worker | null = null;
    let canceled = false;

    const renderPreview = () => {
      const bounds = canvas.getBoundingClientRect();
      const targetWidth = Math.round(
        clampNumber(preview.grain * 0.45, 220, 520),
      );
      const targetHeight = Math.round(
        clampNumber(
          targetWidth * (bounds.height / Math.max(bounds.width, 1)),
          150,
          420,
        ),
      );
      const jobId = rateMapJobRef.current + 1;

      rateMapJobRef.current = jobId;
      setIsPreviewPending(true);
      worker?.terminate();
      worker = new Worker(new URL("./_rateMapWorker.ts", import.meta.url), {
        type: "module",
      });

      worker.onmessage = (event: MessageEvent<RateMapWorkerResponse>) => {
        if (canceled || event.data.jobId !== rateMapJobRef.current) return;

        const context = canvas.getContext("2d");
        if (!context) return;

        canvas.width = event.data.width;
        canvas.height = event.data.height;
        context.putImageData(
          new ImageData(
            new Uint8ClampedArray(event.data.pixels),
            event.data.width,
            event.data.height,
          ),
          0,
          0,
        );
        setIsPreviewPending(false);
        worker?.terminate();
        worker = null;
      };

      worker.onerror = () => {
        if (canceled || jobId !== rateMapJobRef.current) return;
        setIsPreviewPending(false);
        worker?.terminate();
        worker = null;
      };

      worker.postMessage({
        jobId,
        width: targetWidth,
        height: targetHeight,
        behavior: preview.behavior,
        feedRange: {
          min: preview.ranges.feed.min,
          max: preview.ranges.feed.max,
        },
        killRange: {
          min: preview.ranges.kill.min,
          max: preview.ranges.kill.max,
        },
        steps: preview.steps,
        grain: preview.grain,
        bleed: preview.bleed,
        seed: preview.seed,
        birth: preview.birth,
        seedMode: preview.seedMode,
        drawing: {
          contrast: preview.contrast,
          threshold: preview.threshold,
          band: preview.band,
          weight: preview.weight,
        },
        paper: preview.paper,
        ink: preview.ink,
      });
    };

    renderPreview();

    if (typeof ResizeObserver === "undefined") {
      return () => {
        canceled = true;
        worker?.terminate();
      };
    }

    const observer = new ResizeObserver(renderPreview);
    observer.observe(canvas);

    return () => {
      canceled = true;
      observer.disconnect();
      worker?.terminate();
    };
  }, [preview]);

  const getPointFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clampNumber(
      (event.clientX - rect.left) / Math.max(rect.width, 1),
      0,
      1,
    );
    const y = clampNumber(
      (event.clientY - rect.top) / Math.max(rect.height, 1),
      0,
      1,
    );
    return {
      x: x * 100,
      y: y * 100,
      rates: getRateFromMapPosition(x, y, preview.ranges),
    };
  };

  const updateFromPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    shouldPick: boolean,
  ) => {
    const nextPoint = getPointFromPointer(event);
    setHoverPoint(nextPoint);
    if (shouldPick) onPick(nextPoint.rates);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    updateFromPointer(event, true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    updateFromPointer(event, isDragging);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setIsDragging(false);
  };

  const handlePointerLeave = () => {
    if (!isDragging) setHoverPoint(null);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const multiplier = event.shiftKey ? 10 : 1;
    const feedStep = FEED_RANGE.step * multiplier;
    const killStep = KILL_RANGE.step * multiplier;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onPick({ feed, kill: snapRate(kill - killStep, KILL_RANGE) });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onPick({ feed, kill: snapRate(kill + killStep, KILL_RANGE) });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      onPick({ feed: snapRate(feed + feedStep, FEED_RANGE), kill });
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onPick({ feed: snapRate(feed - feedStep, FEED_RANGE), kill });
    }
  };

  return (
    <div
      className="rate-map"
      role="dialog"
      aria-modal="true"
      aria-label="pick feed and kill rate"
    >
      <div className="rate-map__panel">
        <div className="rate-map__header">
          <span>pick feed and kill rate</span>
          <button
            className="rate-map__close"
            type="button"
            aria-label="Close feed kill map"
            onClick={onClose}
          >
            X
          </button>
        </div>
        <div
          className={`rate-map__field${isPreviewPending ? " is-loading" : ""}`}
          role="application"
          aria-label={`feed ${formatRate(feed)}, kill ${formatRate(kill)}`}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
        >
          <canvas
            ref={mapCanvasRef}
            className="rate-map__canvas"
            aria-hidden="true"
          />

          {presetPoints.map((preset) => (
            <button
              key={preset.key}
              className="rate-map__preset"
              type="button"
              aria-label={preset.label}
              title={preset.label}
              style={{ left: `${preset.x}%`, top: `${preset.y}%` }}
              onClick={(event) => {
                event.stopPropagation();
                onPick({
                  feed: snapRate(
                    REACTION_PRESETS[preset.key as ReactionPresetKey].feed,
                    FEED_RANGE,
                  ),
                  kill: snapRate(
                    REACTION_PRESETS[preset.key as ReactionPresetKey].kill,
                    KILL_RANGE,
                  ),
                });
              }}
            />
          ))}

          <div
            className="rate-map__crosshair rate-map__crosshair--x"
            style={{ left: `${guidePoint.x}%` }}
          />
          <div
            className="rate-map__crosshair rate-map__crosshair--y"
            style={{ top: `${guidePoint.y}%` }}
          />
          <div
            className="rate-map__cursor"
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
          />
          <div
            className="rate-map__readout rate-map__readout--kill"
            style={{
              left: `${clampNumber(guidePoint.x, 8, 92)}%`,
              transform:
                guidePoint.x > 72
                  ? "translateX(calc(-100% - 0.7rem))"
                  : "translateX(0.7rem)",
            }}
          >
            k = {formatRate(guidePoint.rates.kill)}
          </div>
          <div
            className="rate-map__readout rate-map__readout--feed"
            style={{ top: `${guidePoint.y}%` }}
          >
            f = {formatRate(guidePoint.rates.feed)}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function GlyphReactionDiffusion() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const workerJobRef = useRef(0);
  const glyphMaskCacheRef = useRef<GlyphMaskCache | null>(null);
  const [fontFamilyId, setFontFamilyId] = useState(defaultFontFamily.id);
  const [fontValue, setFontValue] = useState(defaultFont.value);
  const [presetKey, setPresetKey] = useState<ReactionPresetKey>("munafoKappa");
  const [seedMode, setSeedMode] = useState<SeedMode>("both");
  const [rerollOffset, setRerollOffset] = useState(0);
  const [output, setOutput] = useState<StaticReactionOutput | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [isRateMapOpen, setIsRateMapOpen] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const fontFamily = getFontFamilyById(fontFamilyId);
  const fontMeta = getFontByValue(
    fontFamily.fonts,
    fontValue,
    fontFamily.defaultFont,
  );

  const typography = useControls(
    "Typography",
    {
      fontFamily: {
        value: fontFamily.id,
        options: getFontFamilyOptions(),
        label: "family",
        onChange: (familyId: string) => {
          const nextFamily = getFontFamilyById(familyId);
          setFontFamilyId(nextFamily.id);
          setFontValue(nextFamily.defaultFont.value);
        },
      },
      fontVariant: {
        value: fontMeta.value,
        options: getFontVariantOptions(fontFamily.fonts),
        label: "variant",
        onChange: setFontValue,
      },
      text: { value: DEFAULT_TEXT, rows: 3, label: "text" },
      size: nativeNumber({ current: 123, min: 48, max: 250, step: 1 }),
      tracking: nativeNumber({ current: 2, min: -30, max: 54, step: 0.5 }),
      lineHeight: {
        ...nativeNumber({ current: 0.92, min: 0.5, max: 1.35, step: 0.01 }),
        label: "leading",
      },
    },
    { collapsed: false },
    [fontFamily.id, fontMeta.value],
  );

  const [reaction, setReaction] = useControls(
    "Reaction",
    () => ({
      behavior: {
        value: presetKey,
        options: REACTION_PRESET_OPTIONS,
        label: "behavior",
        onChange: (nextPreset: string) =>
          setPresetKey(nextPreset as ReactionPresetKey),
      },
      feed: nativeNumber({
        current: REACTION_PRESETS[presetKey].feed,
        min: FEED_RANGE.min,
        max: FEED_RANGE.max,
        step: FEED_RANGE.step,
      }),
      kill: nativeNumber({
        current: REACTION_PRESETS[presetKey].kill,
        min: KILL_RANGE.min,
        max: KILL_RANGE.max,
        step: KILL_RANGE.step,
      }),
      "pick feed and kill rate": button(() => setIsRateMapOpen(true)),
      steps: nativeNumber({
        current: 2520,
        min: STEPS_RANGE.min,
        max: STEPS_RANGE.max,
        step: STEPS_RANGE.step,
      }),
      grain: nativeNumber({
        current: 1500,
        min: GRAIN_RANGE.min,
        max: GRAIN_RANGE.max,
        step: GRAIN_RANGE.step,
      }),
      bleed: nativeNumber({
        current: 10,
        min: BLEED_RANGE.min,
        max: BLEED_RANGE.max,
        step: BLEED_RANGE.step,
      }),
      seeding: {
        value: seedMode,
        options: SEED_MODE_OPTIONS,
        label: "seeding",
        onChange: (nextMode: string) => setSeedMode(nextMode as SeedMode),
      },
      birth: nativeNumber({
        current: 1,
        min: BIRTH_RANGE.min,
        max: BIRTH_RANGE.max,
        step: BIRTH_RANGE.step,
      }),
      seed: nativeNumber({
        current: 6044,
        min: SEED_RANGE.min,
        max: SEED_RANGE.max,
        step: SEED_RANGE.step,
      }),
      reroll: button(() => setRerollOffset((current) => current + 1)),
    }),
    { collapsed: false },
    [presetKey, seedMode],
  );

  const drawing = useControls(
    "Drawing",
    {
      paper: "#fafaf6",
      ink: "#0b0b09",
      contrast: nativeNumber({
        current: 2.05,
        min: 0.55,
        max: 4.5,
        step: 0.01,
      }),
      threshold: nativeNumber({
        current: 0.395,
        min: 0.08,
        max: 0.72,
        step: 0.005,
      }),
      band: nativeNumber({ current: 0.14, min: 0.006, max: 0.28, step: 0.001 }),
      weight: nativeNumber({ current: 3, min: 0, max: 5, step: 1 }),
      smooth: nativeNumber({ current: 0.72, min: 0, max: 1, step: 0.01 }),
      outline: nativeNumber({ current: 0, min: 0, max: 8, step: 0.1 }),
    },
    { collapsed: false },
  );

  const rateMapPreview = useMemo(
    () => ({
      behavior: presetKey,
      steps: Math.round(Number(reaction.steps)),
      grain: Math.round(Number(reaction.grain)),
      bleed: Number(reaction.bleed),
      seed: Math.round(Number(reaction.seed) + rerollOffset * 1009),
      birth: Number(reaction.birth),
      seedMode,
      ranges: getRateMapRanges(presetKey),
      contrast: Number(drawing.contrast),
      threshold: Number(drawing.threshold),
      band: Number(drawing.band),
      weight: Number(drawing.weight),
      paper: String(drawing.paper),
      ink: String(drawing.ink),
    }),
    [
      drawing.band,
      drawing.contrast,
      drawing.ink,
      drawing.paper,
      drawing.threshold,
      drawing.weight,
      presetKey,
      reaction.birth,
      reaction.bleed,
      reaction.grain,
      reaction.seed,
      reaction.steps,
      rerollOffset,
      seedMode,
    ],
  );

  useControls({
    "Download SVG": button(() => {
      downloadSvg(
        svgRef.current,
        `${cleanFilePart(String(typography.text))}-reaction-diffusion.svg`,
      );
    }),
  });

  const { font, error } = useOpenTypeFont(fontMeta.url);

  useEffect(() => {
    const preset = REACTION_PRESETS[presetKey];
    setReaction({ feed: preset.feed, kill: preset.kill });
  }, [presetKey, setReaction]);

  const text =
    String(typography.text ?? DEFAULT_TEXT).replace(/\r\n?/g, "\n") ||
    DEFAULT_TEXT;
  const mainSize = Number(typography.size) * MAIN_SIZE_SCALE;
  const tracking = Number(typography.tracking) * TRACKING_SCALE;
  const lineHeight = Number(typography.lineHeight);
  const shapes = useMemo(
    () =>
      font ? layoutGlyphShapes(font, text, mainSize, tracking, lineHeight) : [],
    [font, lineHeight, mainSize, text, tracking],
  );

  useEffect(() => {
    if (!font || shapes.length === 0) {
      setOutput(null);
      setIsRendering(false);
      return undefined;
    }

    const jobId = workerJobRef.current + 1;
    workerJobRef.current = jobId;
    const workers: Worker[] = [];
    let canceled = false;

    setIsRendering(true);
    setRenderError(null);

    const timeoutId = window.setTimeout(() => {
      const width = Math.max(64, Math.round(Number(reaction.grain)));
      const cellSize = STAGE.width / width;
      const seed = Math.round(Number(reaction.seed) + rerollOffset * 1009);
      const boundaryBleed = Number(reaction.bleed);
      const maskCacheKey = createGlyphMaskCacheKey(
        shapes,
        cellSize,
        boundaryBleed,
      );
      const cachedMaskJobs =
        glyphMaskCacheRef.current?.key === maskCacheKey
          ? glyphMaskCacheRef.current.jobs
          : shapes.map((shape) =>
              createGlyphMaskJob(shape, cellSize, boundaryBleed),
            );

      glyphMaskCacheRef.current = { key: maskCacheKey, jobs: cachedMaskJobs };

      const paths = Array.from({ length: shapes.length }, () => "");
      let completed = 0;
      let failed = false;
      let nextGlyphIndex = 0;
      const workerThreads = Math.max(
        1,
        Math.floor((navigator.hardwareConcurrency || 4) / 2),
      );
      const workerLimit = Math.max(
        1,
        Math.min(cachedMaskJobs.length, 4, workerThreads),
      );

      const removeWorker = (worker: Worker) => {
        const workerIndex = workers.indexOf(worker);
        if (workerIndex >= 0) workers.splice(workerIndex, 1);
      };

      const startNextWorker = () => {
        if (canceled || failed || completed === shapes.length) return;

        while (
          workers.length < workerLimit &&
          nextGlyphIndex < cachedMaskJobs.length
        ) {
          const glyphIndex = nextGlyphIndex;
          const maskJob = cachedMaskJobs[glyphIndex];
          nextGlyphIndex += 1;

          if (!maskJob) continue;

          const {
            glyphMask: cachedGlyphMask,
            originX,
            originY,
            width: glyphWidth,
            height: glyphHeight,
          } = maskJob;
          const glyphMask = new Uint8Array(cachedGlyphMask);
          const worker = new Worker(
            new URL("./_reactionWorker.ts", import.meta.url),
            { type: "module" },
          );

          worker.onmessage = (event: MessageEvent<ReactionWorkerResponse>) => {
            removeWorker(worker);
            worker.terminate();

            if (canceled || failed || event.data.jobId !== workerJobRef.current)
              return;

            paths[event.data.glyphIndex] = event.data.inkPath;
            completed += 1;

            if (completed !== shapes.length) {
              startNextWorker();
              return;
            }

            setOutput({
              inkPaths: paths,
              shapes,
            });
            setIsRendering(false);
          };

          worker.onerror = (event) => {
            removeWorker(worker);
            worker.terminate();

            if (canceled || jobId !== workerJobRef.current) return;

            failed = true;
            console.error("Reaction diffusion worker failed", event.message);
            setRenderError(event.message || "Render failed");
            setIsRendering(false);
            workers.forEach((activeWorker) => activeWorker.terminate());
            workers.length = 0;
          };

          worker.postMessage(
            {
              jobId,
              glyphIndex,
              width: glyphWidth,
              height: glyphHeight,
              originX,
              originY,
              cellSize,
              glyphBounds: shapes.map((glyphShape) => glyphShape.bounds),
              glyphMask,
              settings: {
                feed: Number(reaction.feed),
                kill: Number(reaction.kill),
              },
              seedMode,
              seed: seed + glyphIndex * 1009,
              birth: Number(reaction.birth),
              steps: Math.round(Number(reaction.steps)),
              boundaryBleed,
              drawing: {
                contrast: Number(drawing.contrast),
                threshold: Number(drawing.threshold),
                band: Number(drawing.band),
                weight: Number(drawing.weight),
                smooth: Number(drawing.smooth),
              },
            },
            [glyphMask.buffer],
          );
          workers.push(worker);
        }
      };

      startNextWorker();
    }, RENDER_DEBOUNCE_MS);

    return () => {
      canceled = true;
      window.clearTimeout(timeoutId);
      workers.forEach((worker) => worker.terminate());
    };
  }, [
    drawing.band,
    drawing.contrast,
    drawing.threshold,
    drawing.weight,
    drawing.smooth,
    font,
    reaction.birth,
    reaction.bleed,
    reaction.feed,
    reaction.grain,
    reaction.kill,
    reaction.seed,
    reaction.steps,
    rerollOffset,
    seedMode,
    shapes,
  ]);

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

  return (
    <section className="sketch-workbench">
      <div className="sketch-stage reaction-diffusion-stage">
        <svg
          ref={svgRef}
          className={`type-svg reaction-diffusion-svg${isRendering ? " is-rendering" : ""}`}
          viewBox={`0 0 ${STAGE.width} ${STAGE.height}`}
          role="img"
          aria-label={`${text} glyphs used as SVG boundaries for a static reaction diffusion pattern`}
          aria-busy={isRendering}
          data-render-state={
            renderError ? "error" : isRendering ? "rendering" : "ready"
          }
          shapeRendering="geometricPrecision"
          style={{ backgroundColor: String(drawing.paper) }}
        >
          <rect
            width={STAGE.width}
            height={STAGE.height}
            fill={String(drawing.paper)}
          />

          {output?.inkPaths.map(
            (inkPath, index) =>
              inkPath && (
                <path
                  key={`ink-${output.shapes[index]?.id ?? index}`}
                  d={inkPath}
                  fill={String(drawing.ink)}
                  fillRule="evenodd"
                  clipRule="evenodd"
                />
              ),
          )}

          {Number(drawing.outline) > 0 &&
            output?.shapes.map((shape) => (
              <path
                key={`outline-${shape.id}`}
                d={shape.d}
                fill="none"
                stroke={String(drawing.ink)}
                strokeWidth={formatPathNumber(Number(drawing.outline))}
                strokeOpacity="0.24"
                vectorEffect="non-scaling-stroke"
              />
            ))}
        </svg>
      </div>
      {isRateMapOpen && (
        <FeedKillMapDialog
          feed={Number(reaction.feed)}
          kill={Number(reaction.kill)}
          preview={rateMapPreview}
          onClose={() => setIsRateMapOpen(false)}
          onPick={(rates) => setReaction(rates)}
        />
      )}
      <SketchControls fill flat collapsed={false} oneLineLabels={false} />
    </section>
  );
}
