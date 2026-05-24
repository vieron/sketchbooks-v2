export type SketchMeta = {
  id: string;
  number: string;
  title: string;
  description: string;
  href: string;
  image: string;
  medium: string;
  visible?: boolean;
};

export const sketches: SketchMeta[] = [
  {
    id: 'perlin-noise-circle-overlap',
    number: '001',
    title: 'Perlin Noise Circle Overlap',
    description: 'Layered noisy circular contours accumulating into an orange field.',
    href: '/sketch/001-perlin-noise-circle-overlap',
    image: '/images/sketches/perlin-noise-circle-overlap.png',
    medium: 'svg / perlin',
  },
  {
    id: 'flow-field-particles',
    number: '002',
    title: 'Flow Field Particles',
    description: 'A field of particles tracing persistent paths through seeded noise.',
    href: '/sketch/002-flow-field-particles',
    image: '/images/sketches/flow-field-particles.png',
    medium: 'svg / noise',
  },
  {
    id: 'typographic-slicing',
    number: '003',
    title: 'Typographic Slicing',
    description: 'Variable slices, glyph paths, and exportable SVG type experiments.',
    href: '/sketch/003-typographic-slicing',
    image: '/images/sketches/typographic-slicing.png',
    medium: 'svg / opentype',
  },
  {
    id: 'hobby-curves-filled-type',
    number: '004',
    title: 'Hobby Curves Filled Type',
    description: 'Poisson points inside type forms, joined into weighted bezier ribbons.',
    href: '/sketch/004-hobby-curves-filled-type',
    image: '/images/sketches/hobby-curves-filled-type.svg',
    medium: 'svg / hobby curves',
  },
  {
    id: 'liquid-type-distortion',
    number: '005',
    title: 'Liquid Type Distortion',
    description: 'Typography pulled through layered waves, displacement, and viscous streaks.',
    href: '/sketch/005-liquid-type-distortion',
    image: '/images/sketches/liquid-type-distortion.svg',
    medium: 'svg / displacement',
  },
  {
    id: 'svg-type-extrusion',
    number: '006',
    title: 'SVG Type Extrusion',
    description: 'OpenType glyph outlines flattened into bright isometric side faces.',
    href: '/sketch/006-svg-type-extrusion',
    image: '/images/sketches/svg-type-extrusion.svg',
    medium: 'svg / opentype',
  },
  {
    id: 'side-face-lines',
    number: '008',
    title: 'Side Face Lines',
    description: 'Extruded type reduced to visible side planes drawn as colored linework.',
    href: '/sketch/008-side-face-lines',
    image: '/images/sketches/side-face-lines.svg',
    medium: 'svg / line extrusion',
    visible: false,
  },
  {
    id: 'glyph-text-fill',
    number: '009',
    title: 'Glyph Text Fill',
    description: 'OpenType character outlines packed with scanline rows of smaller glyph text.',
    href: '/sketch/009-glyph-text-fill',
    image: '/images/sketches/glyph-text-fill.svg',
    medium: 'svg / glyph fill',
  },
];

export const homeSketches = sketches.filter((sketch) => sketch.visible !== false);

export function getSketchById(id: string) {
  return sketches.find((sketch) => sketch.id === id);
}
