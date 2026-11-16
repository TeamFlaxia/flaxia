import { onCleanup } from './owner.ts';
import type { Directive } from './template.ts';

/**
 * Embed an existing imperative component while the rest of a view is migrated.
 *
 * `dispose` is where the legacy component's teardown (listeners, observers,
 * blob URLs) is called. Keeping this adapter in one place makes the migration
 * boundary visible in review and in the Phase 5 lint guard.
 */
export function legacy(node: Node, dispose?: () => void): Directive {
  return {
    __flxDirective: true,
    render(part) {
      part.renderContent(() => {
        if (dispose) onCleanup(dispose);
        return node;
      });
    },
  };
}
