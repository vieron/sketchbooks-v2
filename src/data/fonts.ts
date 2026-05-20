export type FontMeta = {
  family: string;
  label: string;
  variant: string;
  value: string;
  url: string;
  weight: string;
  style: 'normal' | 'italic';
};

export type FontFamily = {
  id: string;
  label: string;
  fonts: FontMeta[];
  defaultFont: FontMeta;
};

export const humaneFonts = [
  ['Thin', 'Humane-Thin.ttf', '100'],
  ['Extra Light', 'Humane-ExtraLight.ttf', '200'],
  ['Light', 'Humane-Light.ttf', '300'],
  ['Regular', 'Humane-Regular.ttf', '400'],
  ['Medium', 'Humane-Medium.ttf', '500'],
  ['Semi Bold', 'Humane-SemiBold.ttf', '600'],
  ['Bold', 'Humane-Bold.ttf', '700'],
].map(([variant, file, weight]) => ({
  family: 'humane',
  label: `Humane ${variant}`,
  variant,
  value: `humane-${variant.toLowerCase().replaceAll(' ', '-')}`,
  url: `/fonts/humane/${file}`,
  weight,
  style: 'normal',
})) satisfies FontMeta[];

export const mangoGrotesqueFonts = [
  ['Thin', 'MangoGrotesque-Thin.otf', '100'],
  ['Extra Light', 'MangoGrotesque-ExtraLight.otf', '200'],
  ['Light', 'MangoGrotesque-Light.otf', '300'],
  ['Regular', 'MangoGrotesque-Regular.otf', '400'],
  ['Medium', 'MangoGrotesque-Medium.otf', '500'],
  ['Semi Bold', 'MangoGrotesque-SemiBold.otf', '600'],
  ['Bold', 'MangoGrotesque-Bold.otf', '700'],
  ['Extra Bold', 'MangoGrotesque-ExtraBold.otf', '800'],
  ['Black', 'MangoGrotesque-Black.otf', '900'],
].map(([variant, file, weight]) => ({
  family: 'mango-grotesque',
  label: `Mango Grotesque ${variant}`,
  variant,
  value: `mango-${variant.toLowerCase().replaceAll(' ', '-')}`,
  url: `/fonts/mango-grotesque/${file}`,
  weight,
  style: 'normal',
})) satisfies FontMeta[];

export const geistFonts = [
  ['Thin', 'Geist-Thin.otf', '100', 'normal'],
  ['Thin Italic', 'Geist-ThinItalic.otf', '100', 'italic'],
  ['Extra Light', 'Geist-ExtraLight.otf', '200', 'normal'],
  ['Extra Light Italic', 'Geist-ExtraLightItalic.otf', '200', 'italic'],
  ['Light', 'Geist-Light.otf', '300', 'normal'],
  ['Light Italic', 'Geist-LightItalic.otf', '300', 'italic'],
  ['Regular', 'Geist-Regular.otf', '400', 'normal'],
  ['Regular Italic', 'Geist-Italic.otf', '400', 'italic'],
  ['Medium', 'Geist-Medium.otf', '500', 'normal'],
  ['Medium Italic', 'Geist-MediumItalic.otf', '500', 'italic'],
  ['Semi Bold', 'Geist-SemiBold.otf', '600', 'normal'],
  ['Semi Bold Italic', 'Geist-SemiBoldItalic.otf', '600', 'italic'],
  ['Bold', 'Geist-Bold.otf', '700', 'normal'],
  ['Bold Italic', 'Geist-BoldItalic.otf', '700', 'italic'],
  ['Extra Bold', 'Geist-ExtraBold.otf', '800', 'normal'],
  ['Extra Bold Italic', 'Geist-ExtraBoldItalic.otf', '800', 'italic'],
  ['Black', 'Geist-Black.otf', '900', 'normal'],
  ['Black Italic', 'Geist-BlackItalic.otf', '900', 'italic'],
].map(([variant, file, weight, style]) => ({
  family: 'geist',
  label: `Geist ${variant}`,
  variant,
  value: `geist-${variant.toLowerCase().replaceAll(' ', '-')}`,
  url: `/fonts/geist/${file}`,
  weight,
  style: style as FontMeta['style'],
})) satisfies FontMeta[];

const thunderFontFiles = [
  ['Thin LC', 'Thunder-ThinLC.otf', '100'],
  ['Light LC', 'Thunder-LightLC.otf', '300'],
  ['Regular LC', 'Thunder-LC.otf', '400'],
  ['Medium LC', 'Thunder-MediumLC.otf', '500'],
  ['Semi Bold LC', 'Thunder-SemiBoldLC.otf', '600'],
  ['Bold LC', 'Thunder-BoldLC.otf', '700'],
  ['Extra Bold LC', 'Thunder-ExtraBoldLC.otf', '800'],
  ['Black LC', 'Thunder-BlackLC.otf', '900'],
];

export const thunderFonts = thunderFontFiles.map(([variant, file, weight]) => ({
  family: 'thunder',
  label: `Thunder ${variant}`,
  variant,
  value: `thunder-${variant.toLowerCase().replaceAll(' ', '-')}`,
  url: `/fonts/thunder/${file}`,
  weight,
  style: 'normal',
})) satisfies FontMeta[];

export const humaneFontFamily: FontFamily = {
  id: 'humane',
  label: 'Humane',
  fonts: humaneFonts,
  defaultFont: humaneFonts[6] as FontMeta,
};

export const fontFamilies = [
  humaneFontFamily,
  {
    id: 'mango-grotesque',
    label: 'Mango Grotesque',
    fonts: mangoGrotesqueFonts,
    defaultFont: mangoGrotesqueFonts[3] as FontMeta,
  },
  {
    id: 'geist',
    label: 'Geist',
    fonts: geistFonts,
    defaultFont: geistFonts[6] as FontMeta,
  },
  {
    id: 'thunder',
    label: 'Thunder',
    fonts: thunderFonts,
    defaultFont: thunderFonts[2] as FontMeta,
  },
] satisfies FontFamily[];

export function getFontFamilyOptions() {
  return Object.fromEntries(fontFamilies.map((family) => [family.label, family.id]));
}

export function getFontVariantOptions(fonts: FontMeta[]) {
  return Object.fromEntries(fonts.map((font) => [font.variant, font.value]));
}

export function getFontFamilyById(familyId: string, fallback = humaneFontFamily) {
  return fontFamilies.find((family) => family.id === familyId) ?? fallback;
}

export function getFontByValue(fonts: FontMeta[], value: string, fallback: FontMeta) {
  return fonts.find((font) => font.value === value) ?? fallback;
}
