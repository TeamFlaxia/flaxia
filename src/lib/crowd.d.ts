export interface CrowdConfig {
  orchestratorUrl: string;
  siteId: string;
  consent: {
    brandName: string;
    position: string;
  };
  capabilities: string[];
  maxCpuLoad: number;
  [key: string]: unknown;
}

declare module '/api/crowd/*' {
  export function initFlaxiaNode(config: CrowdConfig): void;
}

