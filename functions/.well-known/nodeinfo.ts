/// <reference types="@cloudflare/workers-types" />
interface Env {
  BASE_URL: string;
}

export const onRequestGet: PagesFunction<Env> = ({ env }) =>
  Response.json(
    {
      links: [
        {
          rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
          href: `${env.BASE_URL}/api/nodeinfo/2.1`,
        },
      ],
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
