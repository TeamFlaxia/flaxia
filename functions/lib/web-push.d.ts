declare module 'web-push' {
  interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }
  interface RequestDetails {
    endpoint: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }
  export function generateVAPIDKeys(): VapidKeys;
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function generateRequestDetails(subscription: any, payload: string): RequestDetails;
  export function sendNotification(subscription: any, payload: string): Promise<any>;
}
