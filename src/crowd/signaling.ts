import { Hono } from 'hono'
import { ClientMessage } from './types/signaling'

export const signalingHandler = (c: any) => {
  const token = c.req.query('token')
  
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  return c.upgradeWebSocket(async (ws: any) => {
    ws.on('message', async (data: string) => {
      try {
        const message: ClientMessage = JSON.parse(data)
        console.log('Received message from node:', message.type)
        
        // TODO: Route message to NodeManager Durable Object
      } catch (e) {
        console.error('Failed to parse message:', e)
      }
    })

    ws.on('close', () => {
      console.log('WebSocket closed')
    })

    ws.on('error', (err: any) => {
      console.error('WebSocket error:', err)
    })
  })
}
