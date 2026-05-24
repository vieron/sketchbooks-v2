# AGENTS.md

## Project Shape

This is an Astro + React sketchbook. Interactive sketches live in `src/pages/sketch/<number>-<slug>/` and are registered in `src/data/sketches.ts`.

When adding a new sketch, follow the existing pattern:

- Create an `index.astro` page that uses `SketchLayout` and looks up its metadata with `getSketchById`.
- Put interactive React code in a colocated `_SketchName.tsx` component.
- Add homepage metadata and thumbnail information in `src/data/sketches.ts`.
- Prefer the existing `SketchControls` wrapper and Leva controls for sketch parameters.
- Use `nativeNumber` from `src/controls/nativeNumberPlugin.tsx` for numeric controls so sliders and typed values behave consistently.

## SVG Downloads

Always reuse the shared SVG export helper instead of duplicating `XMLSerializer`, Blob, object URL, or temporary anchor code inside sketches.

```ts
import { downloadSvg } from '../../../utils/svgDownload';
```

Use it from download controls like this:

```ts
downloadSvg(svgRef.current, `my-sketch-${Date.now()}.svg`);
```

The helper in `src/utils/svgDownload.ts` standardizes SVG export behavior across sketches, including the extra horizontal padding used for downloaded SVGs and background rect expansion. If export behavior needs to change for all sketches, update this helper rather than each sketch.

## Sketch Quality

- Prefer direct geometry changes over visual hacks. For typography distortion, warp glyph paths or sampled geometry when possible; avoid stacked clipping masks, repeated overlaid text, hidden static type, or shadow layers unless they are intentional visible features.
- Keep controls focused on visible creative decisions. If a parameter is technical, fixed, or hard to perceive, tune it internally instead of exposing it in Leva.
- Name controls by their visual effect rather than implementation details. Prefer labels like `amplitude`, `wave`, `angle`, `center x`, `center y`, `gravity`, and `phase`.
- Group controls around the creative workflow, such as `Typography`, form/distortion settings, `Motion`, and `Drawing`.
- Test control extremes before handoff. Min/max values should not create broken layouts, clipped output, serrated paths, or unexpected self-overlap artifacts.
- Rendered sketches and exported SVGs should match in composition, background behavior, and spacing conventions.
- Use real sketch output for homepage thumbnails. Store thumbnails in `public/images/sketches/` and reference them from `src/data/sketches.ts`.

## Dependencies

Never use `latest` for pnpm dependency specifiers. Add dependencies with an explicit caret range, for example `^5.6.1`.

When updating dependencies, keep `package.json` and `pnpm-lock.yaml` in sync and prefer the currently resolved version when replacing an existing `latest` specifier.

## Verification

For behavior or visual changes, run `pnpm build` before handing off when practical. For sketch UI changes, verify the affected local page in the in-app browser.

Preserve unrelated worktree changes. This repo often has active sketch experiments in progress.
