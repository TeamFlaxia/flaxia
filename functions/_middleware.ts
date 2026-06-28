export async function onRequest(context: {
  request: Request;
  env: Record<string, unknown>;
  next: () => Promise<Response>;
}): Promise<Response> {
  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.delete('Content-Security-Policy-Report-Only');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
