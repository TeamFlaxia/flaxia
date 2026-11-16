/**
 * Structural directives built on top of `ChildPart`.
 *
 * `when` swaps a branch only when the condition flips. `each` keeps a keyed
 * range per item, so reordering a feed moves existing DOM instead of recreating
 * it — an iframe or `<video>` inside a card keeps its browsing context.
 */

import { createOwner, disposeOwner, type Owner, onCleanup, runInOwner } from './owner.ts';
import { type Accessor, effect, type Signal, signal, untrack } from './signal.ts';
import { ChildPart, type Directive, moveRangeBefore, type Renderable } from './template.ts';

export interface ItemRecord<T> {
  key: string | number;
  part: ChildPart;
  owner: Owner;
  item: T;
  itemSignal: Signal<T>;
  indexSignal: Signal<number>;
}

export function when(condition: Accessor<boolean>, onTrue: () => Renderable, onFalse?: () => Renderable): Directive {
  let disposeEffect: (() => void) | null = null;

  return {
    __flxDirective: true,
    render(part) {
      let current: boolean | null = null;

      disposeEffect = effect(() => {
        const next = Boolean(condition());
        if (next === current) return;
        current = next;
        untrack(() => part.renderContent(() => (next ? onTrue() : onFalse ? onFalse() : null)));
      });
    },
    dispose() {
      disposeEffect?.();
      disposeEffect = null;
    },
  };
}

function reconcile<T>(
  part: ChildPart,
  end: Comment,
  records: Map<string | number, ItemRecord<T>>,
  list: readonly T[],
  keyOf: (item: T) => string | number,
  render: (item: Accessor<T>, index: Accessor<number>) => Renderable,
): void {
  const nextKeys = new Set<string | number>();
  for (const item of list) {
    const key = keyOf(item);
    if (nextKeys.has(key)) throw new Error(`[render] duplicate key in each(): ${String(key)}`);
    nextKeys.add(key);
  }

  for (const [key, record] of [...records]) {
    if (!nextKeys.has(key)) {
      disposeOwner(record.owner);
      records.delete(key);
    }
  }

  // Walk backwards so each record can be placed immediately before the cursor
  // (the start of the already-processed item). Existing ranges that are already
  // in place are not moved.
  let cursor: Node = end;
  for (let index = list.length - 1; index >= 0; index--) {
    const item = list[index];
    const key = keyOf(item);
    const existing = records.get(key);

    if (existing) {
      existing.itemSignal.set(item);
      existing.indexSignal.set(index);
      existing.item = item;
      moveRangeBefore(existing.part.start, existing.part.end, cursor);
      cursor = existing.part.start;
      continue;
    }

    const anchor = document.createComment('flx:item');
    end.parentNode?.insertBefore(anchor, cursor);

    const owner = createOwner(part.owner);
    const itemSignal = signal(item);
    const indexSignal = signal(index);
    const itemPart = runInOwner(owner, () => new ChildPart(anchor, owner));
    const rendered = runInOwner(owner, () => render(itemSignal, indexSignal));
    runInOwner(owner, () => itemPart.set(rendered));

    records.set(key, { key, part: itemPart, owner, item, itemSignal, indexSignal });
    cursor = itemPart.start;
  }
}

export function each<T>(
  items: Accessor<readonly T[]>,
  keyOf: (item: T) => string | number,
  render: (item: Accessor<T>, index: Accessor<number>) => Renderable,
): Directive {
  let disposeEffect: (() => void) | null = null;
  let cleanup: (() => void) | null = null;

  return {
    __flxDirective: true,
    render(part) {
      const start = document.createComment('flx:each');
      const end = document.createComment('/flx:each');
      const parent = part.end.parentNode;
      if (!parent) throw new Error('[render] each() must be mounted before use');
      parent.insertBefore(start, part.end);
      parent.insertBefore(end, part.end);

      const records = new Map<string | number, ItemRecord<T>>();

      cleanup = () => {
        if (!cleanup) return;
        for (const record of records.values()) disposeOwner(record.owner);
        records.clear();
        start.remove();
        end.remove();
        cleanup = null;
      };
      onCleanup(cleanup);

      disposeEffect = effect(() => {
        const list = items();
        untrack(() => reconcile(part, end, records, list, keyOf, render));
      });
    },
    dispose() {
      disposeEffect?.();
      disposeEffect = null;
      cleanup?.();
    },
  };
}
