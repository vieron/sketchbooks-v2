export type Bounds = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type GlyphPathResult = {
  d: string;
  bounds: Bounds | null;
};

export type OpenTypeCommand =
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' };

export type OpenTypeGlyph = {
  index: number;
  advanceWidth: number;
  path?: {
    commands?: OpenTypeCommand[];
  };
};

export type OpenTypeFont = {
  unitsPerEm: number;
  stringToGlyphs(value: string): OpenTypeGlyph[];
  getKerningValue?(leftGlyph: OpenTypeGlyph, rightGlyph: OpenTypeGlyph): number;
};

export type Point = {
  x: number;
  y: number;
};

export type SlicePolygons = Point[][][];
