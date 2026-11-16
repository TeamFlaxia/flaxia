/**
 * happy-dom bootstrap for renderer tests.
 *
 * The renderer touches the DOM only inside functions, so installing globals
 * before importing a test module is enough. Keep this list to the APIs the
 * engine actually uses; adding more here hides accidental browser coupling.
 */
import { Window } from 'happy-dom';

const window = new Window({ url: 'https://flaxia.test/' });

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
globals.Node = window.Node;
globals.Element = window.Element;
globals.HTMLElement = window.HTMLElement;
globals.Text = window.Text;
globals.Comment = window.Comment;
globals.DocumentFragment = window.DocumentFragment;
globals.Event = window.Event;
globals.CustomEvent = window.CustomEvent;
globals.KeyboardEvent = window.KeyboardEvent;
globals.NodeFilter = window.NodeFilter;
globals.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globals.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

export { window };
