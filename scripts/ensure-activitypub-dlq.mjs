import { pathToFileURL } from 'node:url';

export async function ensureActivityPubDlq(env, request = fetch) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error('Cloudflare account and API token are required');
  const queueName = 'activitypub-delivery-dlq';
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/queues`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function call(url, init) {
    const response = await request(url, { ...init, headers });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(`Cloudflare queue request failed (${response.status})`);
    return body.result;
  }
  const existing = await call(`${endpoint}?name=${queueName}`);
  if (!Array.isArray(existing)) throw new Error('Invalid Cloudflare queue list');
  if (existing.some((queue) => queue.queue_name === queueName)) return;
  await call(endpoint, { method: 'POST', body: JSON.stringify({ queue_name: queueName }) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ensureActivityPubDlq(process.env);
}
