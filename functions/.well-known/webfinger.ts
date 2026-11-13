/// <reference types="@cloudflare/workers-types" />
import { webfingerResponse } from '../lib/activitypub/webfinger';

interface Env {
  DB: D1Database;
  BASE_URL: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const result = await webfingerResponse(env, new URL(request.url).searchParams.get('resource') ?? undefined);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      'Content-Type': result.contentType ?? 'application/jrd+json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
};
