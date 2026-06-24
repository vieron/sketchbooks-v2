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
    id: 'glyph-flow-field',
    number: '001',
    title: 'Glyph Flow Field',
    description: 'OpenType glyph shapes used as clipped vessels for seeded flow-field particle trails.',
    href: '/sketch/001-glyph-flow-field',
    image: '/images/sketches/glyph-flow-field.svg',
    medium: 'svg / opentype / flow',
  },
  {
    id: 'hobby-curves-filled-type',
    number: '002',
    title: 'Hobby Curves Filled Type',
    description: 'Poisson points inside type forms, joined into weighted bezier ribbons.',
    href: '/sketch/002-hobby-curves-filled-type',
    image: '/images/sketches/hobby-curves-filled-type.svg',
    medium: 'svg / hobby curves',
  },
  {
    id: 'liquid-type-distortion',
    number: '003',
    title: 'Liquid Type Distortion',
    description: 'Typography pulled through layered waves, displacement, and viscous streaks.',
    href: '/sketch/003-liquid-type-distortion',
    image: '/images/sketches/liquid-type-distortion.svg',
    medium: 'svg / displacement',
  },
  {
    id: 'svg-type-extrusion',
    number: '004',
    title: 'SVG Type Extrusion',
    description: 'OpenType glyph outlines flattened into bright isometric side faces.',
    href: '/sketch/004-svg-type-extrusion',
    image: '/images/sketches/svg-type-extrusion.svg',
    medium: 'svg / opentype',
  },
  {
    id: 'glyph-text-fill',
    number: '005',
    title: 'Glyph Text Fill',
    description: 'OpenType character outlines packed with scanline rows of smaller glyph text.',
    href: '/sketch/005-glyph-text-fill',
    image: '/images/sketches/glyph-text-fill.svg',
    medium: 'svg / glyph fill',
  },
  {
    id: 'glyph-reaction-diffusion',
    number: '006',
    title: 'Glyph Reaction Diffusion',
    description: 'Editable glyph vessels seeded with Gray-Scott reaction diffusion textures.',
    href: '/sketch/006-glyph-reaction-diffusion',
    image: '/images/sketches/glyph-reaction-diffusion.svg',
    medium: 'canvas / glyphs / gray-scott',
  },
];

export const homeSketches = sketches.filter((sketch) => sketch.visible !== false);

export function getSketchById(id: string) {
  return sketches.find((sketch) => sketch.id === id);
}
