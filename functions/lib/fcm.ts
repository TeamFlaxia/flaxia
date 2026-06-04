export interface FcmPayload {
  title: string;
  body: string;
}

interface ServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

function base64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function signRsa256(data: string, pemPrivateKey: string): Promise<string> {
  const pemBody = pemPrivateKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey('pkcs8', binaryDer, { name: 'RSASSA-PKCS1-V1_5', hash: 'SHA-256' }, false, [
    'sign',
  ]);

  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-V1_5' }, key, new TextEncoder().encode(data));

  return base64Url(sig);
}

async function getAccessToken(serviceAccount: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.accessToken;
  }

  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).buffer);
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now,
      }),
    ).buffer,
  );

  const signature = await signRsa256(`${header}.${payload}`, serviceAccount.private_key);
  const jwt = `${header}.${payload}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('[fcm] token exchange failed', res.status, body);
    throw new Error('FCM token exchange failed');
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { accessToken: data.access_token, expiresAt: now + (data.expires_in || 3600) };
  return data.access_token;
}

export async function sendPushToDevice(
  token: string,
  payload: FcmPayload,
  serviceAccountJson: string,
  _projectId?: string,
): Promise<boolean> {
  if (!serviceAccountJson) {
    console.error('[fcm] FCM_SERVER_KEY (service account JSON) not configured');
    return false;
  }

  try {
    const sa: ServiceAccount = JSON.parse(serviceAccountJson);
    const accessToken = await getAccessToken(sa);

    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token,
          notification: {
            title: payload.title,
            body: payload.body,
          },
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channelId: 'flaxia_notifications',
              icon: 'ic_launcher_foreground',
            },
          },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
              },
            },
          },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('[fcm] send failed', res.status, body);
      if (res.status === 400 || res.status === 404 || res.status === 410) {
        return false;
      }
      return false;
    }

    return true;
  } catch (err) {
    console.error('[fcm] send error', err);
    return false;
  }
}
