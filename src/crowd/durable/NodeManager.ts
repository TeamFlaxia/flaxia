import { DurableObject } from 'cloudflare:workers'

export class NodeManager extends DurableObject {
  constructor(state: DurableObjectState, env: any) {
    super(state, env)
  }

  async fetch(request: Request): Promise<Response> {
    // Basic implementation for now
    return new Response('NodeManager is alive')
  }
}
