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
  const exists = (queues) => Array.isArray(queues) && queues.some((queue) => queue.queue_name === queueName);
  const existing = await call(`${endpoint}?name=${queueName}`);
  if (!Array.isArray(existing)) throw new Error('Invalid Cloudflare queue list');
  if (exists(existing)) {
    console.log(`ActivityPub dead-letter queue "${queueName}" already exists`);
    return;
  }
  await call(endpoint, { method: 'POST', body: JSON.stringify({ queue_name: queueName }) });

  // Creating a queue is not enough: deploys bind a consumer to it, and a
  // missing queue would make the whole deployment fail. Verify the new queue
  // is actually visible before reporting success.
  const created = await call(`${endpoint}?name=${queueName}`);
  if (!exists(created)) {
    throw new Error(`Created queue "${queueName}" but it is not visible in the Cloudflare queue list`);
  }
  console.log(`ActivityPub dead-letter queue "${queueName}" exists and is ready`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ensureActivityPubDlq(process.env);
}
