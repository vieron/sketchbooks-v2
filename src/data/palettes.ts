export type ColorPalettePreset = {
  id: string;
  label: string;
  colors: string[];
};

export const originalPlaygroundPalette = ['#0053ff', '#ff3b30', '#ffcc00', '#00c2a8'] as const;

export const lospecPalettePresets = [
  {
    id: 'seoul-city',
    label: 'Seoul City',
    colors: ['#26547c', '#ef476f', '#f78c6b', '#ffd166', '#06d6a0', '#fffcf9'],
  },
  {
    id: 'berries-and-cream',
    label: 'Berries and Cream',
    colors: ['#031c29', '#0a6874', '#88c9d1', '#fbf7d1', '#d96297', '#a8275d'],
  },
  {
    id: 'septembit-23',
    label: 'Septembit 23',
    colors: ['#0a0d22', '#296baa', '#03a66b', '#fcffff', '#f3ac00', '#c81922'],
  },
  {
    id: 'cursed-turkey',
    label: 'Cursed Turkey',
    colors: ['#1e110c', '#b32a12', '#d65709', '#db7209', '#df8c00', '#d7ac64'],
  },
  {
    id: 'teaviie',
    label: 'Teaviie',
    colors: ['#f6e1ff', '#f6bafb', '#e26cd7', '#9729fc', '#6420a8', '#11002a'],
  },
  {
    id: 'cloudfrenzy',
    label: 'Cloudfrenzy',
    colors: ['#f4c4d4', '#ea92ab', '#af7fc2', '#9085d0', '#8c76be', '#61567d'],
  },
  {
    id: 'curiosities',
    label: 'Curiosities',
    colors: ['#46425e', '#15788c', '#00b9be', '#ffeecc', '#ffb0a3', '#ff6973'],
  },
  {
    id: 'ys-postapocalyptic-sunset',
    label: 'YS Postapocalyptic Sunset',
    colors: ['#1d0f44', '#f44e38'],
  },
  {
    id: 'window-of-opportunity',
    label: 'Window of Opportunity',
    colors: ['#fffff5', '#8f94c5', '#131457', '#433bff'],
  },
  {
    id: 'agb',
    label: 'AGB',
    colors: ['#1e4959', '#3ba155', '#a0c76f', '#ebe0b2'],
  },
  {
    id: 'italy-4',
    label: 'Italy 4',
    colors: ['#100f24', '#5d8d60', '#edeada', '#c74634'],
  },
  {
    id: 'foxfire',
    label: 'Foxfire',
    colors: ['#5a0084', '#e63900', '#ffc96b', '#ffffff'],
  },
  {
    id: 'lemon-lime',
    label: 'Lemon Lime',
    colors: ['#28375b', '#39809c', '#5fcc86', '#fff37b'],
  },
  {
    id: 'sweet-guarana',
    label: 'Sweet Guarana',
    colors: ['#253b46', '#18865f', '#61d162', '#ebe7ad'],
  },
  {
    id: 'b4sement',
    label: 'B4sement',
    colors: ['#222323', '#ff4adc', '#3dff98', '#f0f6f0'],
  },
  {
    id: 'megaman-v-sgb',
    label: 'Megaman V SGB',
    colors: ['#102533', '#42678e', '#6f9edf', '#cecece'],
  },
  {
    id: 'kankei4',
    label: 'Kankei4',
    colors: ['#ffffff', '#f42e1f', '#2f256b', '#060608'],
  },
  {
    id: '2-bit-matrix',
    label: '2 Bit Matrix',
    colors: ['#f2fff2', '#add9bc', '#5b8c7c', '#0d1a1a'],
  },
  {
    id: 'cherrymelon',
    label: 'Cherrymelon',
    colors: ['#fcdeea', '#ff4d6d', '#265935', '#012824'],
  },
  {
    id: 'fuzzyfour',
    label: 'Fuzzyfour',
    colors: ['#302387', '#ff3796', '#00faac', '#fffdaf'],
  },
  {
    id: 'soda-cap',
    label: 'Soda Cap',
    colors: ['#2176cc', '#ff7d6e', '#fca6ac', '#e8e7cb'],
  },
  {
    id: 'pokemon-sgb',
    label: 'Pokemon SGB',
    colors: ['#181010', '#84739c', '#f7b58c', '#ffefff'],
  },
  {
    id: 'arq4',
    label: 'ARQ4',
    colors: ['#ffffff', '#6772a9', '#3a3277', '#000000'],
  },
  {
    id: 'blk-aqu4',
    label: 'BLK AQU4',
    colors: ['#002b59', '#005f8c', '#00b9be', '#9ff4e5'],
  },
  {
    id: 'nintendo-gameboy-bgb',
    label: 'Nintendo Gameboy BGB',
    colors: ['#081820', '#346856', '#88c070', '#e0f8d0'],
  },
  {
    id: 'rustic-gb',
    label: 'Rustic GB',
    colors: ['#2c2137', '#764462', '#edb4a1', '#a96868'],
  },
  {
    id: 'ayy4',
    label: 'Ayy4',
    colors: ['#00303b', '#ff7777', '#ffce96', '#f1f2da'],
  },
  {
    id: 'moonlight-gb',
    label: 'Moonlight GB',
    colors: ['#0f052d', '#203671', '#36868f', '#5fc75d'],
  },
  {
    id: 'lava-gb',
    label: 'Lava GB',
    colors: ['#051f39', '#4a2480', '#c53a9d', '#ff8e80'],
  },
  {
    id: 'kirokaze-gameboy',
    label: 'Kirokaze Gameboy',
    colors: ['#332c50', '#46878f', '#94e344', '#e2f3e4'],
  },
  {
    id: 'ice-cream-gb',
    label: 'Ice Cream GB',
    colors: ['#7c3f58', '#eb6b6f', '#f9a875', '#fff6d3'],
  },
] satisfies ColorPalettePreset[];

export const legacyPalettePresets = [
  {
    id: 'original-playground',
    label: 'Original Playground',
    colors: [...originalPlaygroundPalette],
  },
  {
    id: 'ink',
    label: 'Ink',
    colors: ['#11110f', '#f8f7f3'],
  },
  {
    id: 'signal',
    label: 'Signal',
    colors: ['#0b0f14', '#0053ff', '#ff3b30', '#f5f7fa'],
  },
  {
    id: 'six-tone',
    label: 'Six Tone',
    colors: ['#0053ff', '#ff3b30', '#ffcc00', '#00c2a8', '#11110f', '#ffffff'],
  },
] satisfies ColorPalettePreset[];

export const sketchPalettePresets = [
  ...lospecPalettePresets,
  ...legacyPalettePresets,
] satisfies ColorPalettePreset[];

export const defaultSketchPalette = lospecPalettePresets[0] as ColorPalettePreset;

function hexToRgb(color: string) {
  const normalized = color.replace('#', '');
  const value = Number.parseInt(normalized, 16);

  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function relativeLuminance(color: string) {
  const { r, g, b } = hexToRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function getPaletteById(id: string, fallback = defaultSketchPalette) {
  return sketchPalettePresets.find((palette) => palette.id === id) ?? fallback;
}

export function getPaletteOptions() {
  return Object.fromEntries(sketchPalettePresets.map((palette) => [palette.label, palette.id]));
}

export function getPaletteToneColors(colors: string[]) {
  const palette = colors.length > 0 ? colors : defaultSketchPalette.colors;
  const sorted = [...palette].sort((a, b) => relativeLuminance(a) - relativeLuminance(b));

  return {
    ink: sorted[0] ?? '#111111',
    paper: sorted[sorted.length - 1] ?? '#ffffff',
  };
}
