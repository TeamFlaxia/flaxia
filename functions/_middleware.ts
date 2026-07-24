export async function onRequest(context: {
  request: Request;
  env: Record<string, unknown>;
  next: () => Promise<Response>;
}): Promise<Response> {
  const response = await context.next();

  // WebSocket upgrade (101) は webSocket プロパティを維持する必要があるためそのまま返す
  if (response.status === 101) {
    return response;
  }

  return response;
}
