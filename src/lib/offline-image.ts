import { isFirstPartyApiUrl, isNativeApp } from './native-api.js';

const pending = new WeakMap<HTMLImageElement, symbol>();
/** Use the persistent native cache for image previews and avatars. */
export function setOfflineImage(image: HTMLImageElement, href: string): void {
  const url = new URL(href, window.location.href);
  if (!isNativeApp() || !isFirstPartyApiUrl(url) || !/^\/api\/(?:images|thumbnail)\//.test(url.pathname)) {
    image.src = href;
    return;
  }
  const token = Symbol();
  pending.set(image, token);
  void (async () => {
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error('Image unavailable');
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw new Error('Invalid image');
      const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      if (pending.get(image) === token) image.src = source;
    } catch {
      if (pending.get(image) !== token) return;
      if (navigator.onLine !== false) image.src = href;
      else image.dispatchEvent(new Event('error'));
    }
  })();
}
