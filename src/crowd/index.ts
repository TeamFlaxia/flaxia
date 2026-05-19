import { Hono } from 'hono'

import { signalingHandler } from './signaling'

export const crowdApp = new Hono()

// Placeholder routes
crowdApp.get('/signal', signalingHandler)
crowdApp.post('/tasks', (c) => c.json({ status: 'queued' }))
crowdApp.get('/tasks/:id', (c) => c.json({ id: c.req.param('id'), status: 'pending' }))
crowdApp.post('/tasks/:id/result', (c) => c.json({ status: 'accepted' }))
crowdApp.get('/nodes', (c) => c.json({ nodes: [] }))
crowdApp.post('/nodes/register', (c) => c.json({ status: 'registered' }))
