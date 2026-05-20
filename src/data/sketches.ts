export type SketchMeta = {
  id: string;
  number: string;
  title: string;
  description: string;
  href: string;
  image: string;
  medium: string;
};

export const sketches: SketchMeta[] = [
  {
    id: 'typographic-slicing',
    number: '001',
    title: 'Typographic Slicing',
    description: 'Variable slices, glyph paths, and exportable SVG type experiments.',
    href: '/sketch/001-typographic-slicing',
    image: '/images/sketches/typographic-slicing.png',
    medium: 'svg / opentype',
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
    id: 'flow-field-particles',
    number: '003',
    title: 'Flow Field Particles',
    description: 'A field of particles tracing persistent paths through seeded noise.',
    href: '/sketch/003-flow-field-particles',
    image: '/images/sketches/flow-field-particles.png',
    medium: 'svg / noise',
  },
  {
    id: 'perlin-noise-circle-overlap',
    number: '004',
    title: 'Perlin Noise Circle Overlap',
    description: 'Layered noisy circular contours accumulating into an orange field.',
    href: '/sketch/004-perlin-noise-circle-overlap',
    image: '/images/sketches/perlin-noise-circle-overlap.png',
    medium: 'svg / perlin',
  },
];

export function getSketchById(id: string) {
  return sketches.find((sketch) => sketch.id === id);
}
