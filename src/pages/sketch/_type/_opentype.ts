import { useEffect, useState } from 'react';
import * as opentype from 'opentype.js';
import type { Bounds, GlyphPathResult, OpenTypeFont, OpenTypeGlyph } from './_types';

type OpenTypeParser = {
  parse(buffer: ArrayBuffer): unknown;
};

export function useOpenTypeFont(url: string) {
  const [font, setFont] = useState<OpenTypeFont | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setFont(null);
    setError('');

    async function loadFont() {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Font request failed with ${response.status}`);
        const buffer = await response.arrayBuffer();
        setFont((opentype as OpenTypeParser).parse(buffer) as OpenTypeFont);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load font');
        }
      }
    }

    void loadFont();
    return () => controller.abort();
  }, [url]);

  return { font, error };
}

export function formatPathNumber(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

export function buildGlyphPath(glyph: OpenTypeGlyph, x: number, y: number, scale: number): GlyphPathResult {
  const commands = glyph.path?.commands ?? [];
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

    return `${formatPathNumber(px)} ${formatPathNumber(py)}`;
  }

  const d = commands
    .map((command) => {
      if (command.type === 'M') return `M${point(command.x, command.y)}`;
      if (command.type === 'L') return `L${point(command.x, command.y)}`;
      if (command.type === 'Q') return `Q${point(command.x1, command.y1)} ${point(command.x, command.y)}`;
      if (command.type === 'C') {
        return `C${point(command.x1, command.y1)} ${point(command.x2, command.y2)} ${point(command.x, command.y)}`;
      }
      if (command.type === 'Z') return 'Z';
      return '';
    })
    .join('');

  return {
    d,
    bounds: Number.isFinite(bounds.x1) ? bounds : null,
  };
}
