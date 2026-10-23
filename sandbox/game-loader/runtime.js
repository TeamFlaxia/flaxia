import { mimeType, resolvePath, validateFiles } from './protocol.js';

/** Runs only inside the opaque game shell, never in the trusted loader. */
export function prepareGame(files) {
  const entry = validateFiles(files);
  const blobs = new Map();
  const content = new Map(files.map((file) => [file.path, file.bytes]));
  const decoder = new TextDecoder();
  const creating = new Set();
  function assetUrl(raw, base = entry) {
    if (/^(blob:|data:)/i.test(raw)) return raw;
    const resolved = resolvePath(raw, base);
    if (!resolved) throw new Error('External assets are not supported by the prototype');
    if (!content.has(resolved.path)) throw new Error(`Missing archive asset: ${resolved.path}`);
    return getBlob(resolved.path) + resolved.suffix;
  }
  function getBlob(path) {
    if (blobs.has(path)) return blobs.get(path);
    if (creating.has(path)) throw new Error('Circular CSS imports are not supported');
    creating.add(path);
    let bytes = content.get(path);
    if (mimeType(path) === 'text/css') {
      let css = decoder.decode(bytes);
      css = css.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (_match, _quote, raw) =>
        raw.startsWith('#') ? `url("${raw}")` : `url("${assetUrl(raw, path)}")`,
      );
      css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (_match, _quote, raw) => `@import "${assetUrl(raw, path)}"`);
      bytes = css;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType(path) }));
    blobs.set(path, url);
    creating.delete(path);
    return url;
  }
  try {
    const doc = new DOMParser().parseFromString(decoder.decode(content.get(entry)), 'text/html');
    if (doc.querySelector('script[type="module"],iframe,frame,object,embed,[srcset]')) {
      throw new Error('Modules, nested frames, and srcset require the WVFS player');
    }
    doc.querySelectorAll('base,meta[http-equiv]').forEach((element) => {
      element.remove();
    });
    for (const element of doc.querySelectorAll('[src],link[href]')) {
      const attr = element.hasAttribute('src') ? 'src' : 'href';
      element.setAttribute(attr, assetUrl(element.getAttribute(attr)));
    }
    // Inline CSS uses the same dependency rewriting as external stylesheets.
    const rewriteStyle = (css) =>
      css.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (_match, _quote, raw) =>
        raw.startsWith('#') ? `url("${raw}")` : `url("${assetUrl(raw)}")`,
      );
    doc.querySelectorAll('style').forEach((element) => {
      element.textContent = rewriteStyle(element.textContent);
    });
    doc.querySelectorAll('[style]').forEach((element) => {
      element.setAttribute('style', rewriteStyle(element.getAttribute('style')));
    });
    return {
      html: '<!doctype html>\n' + doc.documentElement.outerHTML,
      assetUrl,
      dispose: () =>
        blobs.forEach((url) => {
          URL.revokeObjectURL(url);
        }),
    };
  } catch (error) {
    blobs.forEach((url) => {
      URL.revokeObjectURL(url);
    });
    throw error;
  }
}

export function installAssetRuntime(assetUrl) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const raw = input instanceof Request ? input.url : String(input);
    const method = options?.method ?? (input instanceof Request ? input.method : 'GET');
    if (!['GET', 'HEAD'].includes(method.toUpperCase()))
      return Promise.reject(new Error('Archive assets are read-only'));
    try {
      return originalFetch(
        assetUrl(raw),
        input instanceof Request ? { method, headers: input.headers, ...options } : options,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    return originalOpen.call(this, method, assetUrl(String(url)), ...args);
  };
  for (const [prototype, name] of [
    [HTMLImageElement.prototype, 'src'],
    [HTMLMediaElement.prototype, 'src'],
    [HTMLScriptElement.prototype, 'src'],
    [HTMLSourceElement.prototype, 'src'],
    [HTMLLinkElement.prototype, 'href'],
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor?.set) continue;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      set(value) {
        descriptor.set.call(this, assetUrl(String(value)));
      },
    });
  }
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name.toLowerCase() === 'src' || (name.toLowerCase() === 'href' && this instanceof HTMLLinkElement)) {
      value = assetUrl(String(value));
    }
    return originalSetAttribute.call(this, name, value);
  };
}
