// This legacy same-origin route depended on /api/sandbox/sw.js to serve
// user-provided ZIP content. Both endpoints are retired together (#79).
// Interactive games must use the isolated sandbox.flaxia.app + WVFS flow.
export default {
  fetch(): Response {
    return new Response('Legacy ZIP sandbox has been retired', {
      status: 410,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};
