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

## Dependencies

Never use `latest` for pnpm dependency specifiers. Add dependencies with an explicit caret range, for example `^5.6.1`.

When updating dependencies, keep `package.json` and `pnpm-lock.yaml` in sync and prefer the currently resolved version when replacing an existing `latest` specifier.

## Verification

For behavior or visual changes, run `pnpm build` before handing off when practical. For sketch UI changes, verify the affected local page in the in-app browser.

Preserve unrelated worktree changes. This repo often has active sketch experiments in progress.
