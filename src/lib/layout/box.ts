/**
 * Layout primitives.
 *
 * Every media slot gets a reserved box before its contents arrive. The outer
 * size is decided by the box, never by the child, so a late image, iframe or
 * ad cannot move the feed.
 */

import { html, type Renderable } from '../render/index.ts';

export type BoxRatio = '16 / 9' | '4 / 3' | '1 / 1' | '9 / 16' | '16 / 10' | '9 / 12';

export interface MediaBoxOptions {
  ratio: BoxRatio;
  minHeight?: number;
  label: string;
  className?: string;
}

export function MediaBox(options: MediaBoxOptions, children: () => Renderable): Renderable {
  const className = `fx-box${options.className ? ` ${options.className}` : ''}`;
  const style = {
    '--fx-ratio': options.ratio,
    '--fx-min': `${options.minHeight ?? 0}px`,
  };

  return html`<div
    class=${className}
    style=${style}
    role="group"
    aria-label=${options.label}
  >
    <div class="fx-box__inner">${children}</div>
  </div>`;
}

export interface SkeletonOptions {
  ratio: BoxRatio;
  minHeight?: number;
  className?: string;
}

export function Skeleton(options: SkeletonOptions): Renderable {
  const className = `fx-box fx-skeleton${options.className ? ` ${options.className}` : ''}`;

  return html`<div
    class=${className}
    style=${{
      '--fx-ratio': options.ratio,
      '--fx-min': `${options.minHeight ?? 0}px`,
    }}
    aria-hidden="true"
  >
    <div class="fx-box__inner"></div>
  </div>`;
}
