# Client-side content protection limitations (#128)

`src/lib/content-protection.ts` only deters ordinary save shortcuts, context
menus, and drag operations on media. It **does not** protect against a
deliberate user with browser developer tools, JavaScript execution in the
page, direct API requests, OS screenshots, printing from another context, or
recording the screen.

Prior code replaced `HTMLCanvasElement.prototype.toDataURL` and `toBlob`
and exposed `window.__markCanvasTainted`. Same-origin JavaScript could
bypass or overwrite these hooks, and the canvas marker was never used by
the project's other modules. They have been removed to avoid presenting
a false sense of data-loss-prevention protection and to preserve native
browser API behavior for embedded games.

If a media object must actually be private, authorization must be enforced
**before** the bytes are served by the backend; browser-side controls cannot
make a public asset confidential. Do not describe UI-only controls as DRM.
