/// <reference types="@cloudflare/workers-types" />
interface Env {
  BASE_URL: string;
}

export const onRequestGet: PagesFunction<Env> = ({ env }) => {
  const base = new URL(env.BASE_URL);
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
  <Link rel="lrdd" template="${base.origin}/.well-known/webfinger?resource={uri}"/>
</XRD>`,
    {
      status: 200,
      headers: {
        'Content-Type': 'application/xrd+xml',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    },
  );
};
