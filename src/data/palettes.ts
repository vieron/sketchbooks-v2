export type ColorPalettePreset = {
  id: string;
  label: string;
  colors: string[];
};

export const originalPlaygroundPalette = ['#0053ff', '#ff3b30', '#ffcc00', '#00c2a8'] as const;

export const sketchPalettePresets = [
  {
    id: 'original-playground',
    label: 'Original playground',
    colors: [...originalPlaygroundPalette],
  },
  {
    id: 'ink',
    label: 'Ink',
    colors: ['#11110f', '#f8f7f3'],
  },
  {
    id: 'print',
    label: 'Print',
    colors: ['#11110f', '#e8462a', '#255f85', '#d7bf67'],
  },
  {
    id: 'signal',
    label: 'Signal',
    colors: ['#0b0f14', '#0053ff', '#ff3b30', '#f5f7fa'],
  },
  {
    id: 'citrus',
    label: 'Citrus',
    colors: ['#172018', '#00c2a8', '#e9ff70', '#ff7a00', '#ffffff'],
  },
  {
    id: 'six-tone',
    label: 'Six tone',
    colors: ['#0053ff', '#ff3b30', '#ffcc00', '#00c2a8', '#11110f', '#ffffff'],
  },
] satisfies ColorPalettePreset[];
