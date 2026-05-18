import { Hono } from 'hono'

export const crowdApp = new Hono()

// Placeholder routes
crowdApp.get('/signal', (c) => c.text('Signaling endpoint'))
crowdApp.post('/tasks', (c) => c.json({ status: 'queued' }))
crowdApp.get('/tasks/:id', (c) => c.json({ id: c.req.param('id'), status: 'pending' }))
crowdApp.post('/tasks/:id/result', (c) => c.json({ status: 'accepted' }))
crowdApp.get('/nodes', (c) => c.json({ nodes: [] }))
crowdApp.post('/nodes/register', (c) => c.json({ status: 'registered' }))
