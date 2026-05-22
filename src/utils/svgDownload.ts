type SvgViewBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DownloadSvgOptions = {
  horizontalPaddingRatio?: number;
};

const DEFAULT_HORIZONTAL_PADDING_RATIO = 0.12;

function formatNumber(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

function numberAttribute(element: Element, name: string) {
  const value = element.getAttribute(name);
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getViewBox(svgElement: SVGSVGElement): SvgViewBox | null {
  const viewBox = svgElement.getAttribute('viewBox')?.trim();
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
  }

  const width = numberAttribute(svgElement, 'width');
  const height = numberAttribute(svgElement, 'height');
  if (width && height) return { x: 0, y: 0, width, height };

  return null;
}

function nearlyEqual(left: number | null, right: number) {
  return left !== null && Math.abs(left - right) < 0.001;
}

function expandFullCanvasRect(svgElement: SVGSVGElement, original: SvgViewBox, expanded: SvgViewBox) {
  const firstRect = Array.from(svgElement.children).find((child) => child.tagName.toLowerCase() === 'rect');
  if (!(firstRect instanceof SVGRectElement)) return;

  const x = numberAttribute(firstRect, 'x') ?? 0;
  const y = numberAttribute(firstRect, 'y') ?? 0;
  const width = numberAttribute(firstRect, 'width');
  const height = numberAttribute(firstRect, 'height');

  const coversOriginalCanvas =
    nearlyEqual(x, original.x) &&
    nearlyEqual(y, original.y) &&
    nearlyEqual(width, original.width) &&
    nearlyEqual(height, original.height);

  if (!coversOriginalCanvas) return;

  firstRect.setAttribute('x', String(formatNumber(expanded.x)));
  firstRect.setAttribute('y', String(formatNumber(expanded.y)));
  firstRect.setAttribute('width', String(formatNumber(expanded.width)));
  firstRect.setAttribute('height', String(formatNumber(expanded.height)));
}

function addHorizontalPadding(svgElement: SVGSVGElement, horizontalPaddingRatio: number) {
  const original = getViewBox(svgElement);
  if (!original || horizontalPaddingRatio <= 0) return;

  const padding = original.width * horizontalPaddingRatio;
  const expanded = {
    x: original.x - padding,
    y: original.y,
    width: original.width + padding * 2,
    height: original.height,
  };

  svgElement.setAttribute(
    'viewBox',
    `${formatNumber(expanded.x)} ${formatNumber(expanded.y)} ${formatNumber(expanded.width)} ${formatNumber(expanded.height)}`,
  );
  expandFullCanvasRect(svgElement, original, expanded);
}

export function downloadSvg(svgElement: SVGSVGElement | null, fileName: string, options: DownloadSvgOptions = {}) {
  if (!svgElement) return;

  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  addHorizontalPadding(clone, options.horizontalPaddingRatio ?? DEFAULT_HORIZONTAL_PADDING_RATIO);

  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
