// The legacy same-origin ZIP sandbox is intentionally retired (#79).
// Modern games run through the isolated sandbox origin and WVFS. Do not
// resurrect a service worker that can serve arbitrary uploaded HTML from
// the first-party /api/ origin.
export default {
  fetch(): Response {
    return new Response('Legacy Service Worker sandbox has been retired', {
      status: 410,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};
