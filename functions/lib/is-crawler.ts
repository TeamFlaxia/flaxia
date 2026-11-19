// List of common crawler user agents
const crawlerUserAgents = [
  'googlebot',
  'bingbot',
  'slurp',
  'duckduckbot',
  'baiduspider',
  'yandexbot',
  'facebookexternalhit',
  'twitterbot',
  'linkedinbot',
  'whatsapp',
  'telegrambot',
  'applebot',
  'semrushbot',
  'ahrefsbot',
  'mj12bot',
  'dotbot',
  'crawler',
  'spider',
  'bot',
];

export function isCrawler(userAgent: string): boolean {
  if (!userAgent) return false;

  const lowerCaseUserAgent = userAgent.toLowerCase();
  return crawlerUserAgents.some((bot) => lowerCaseUserAgent.includes(bot));
}
