import { TaskRecord } from '../types/task'

export class TaskQueue {
  state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const method = url.pathname.slice(1)

    switch (method) {
      case 'enqueue':
        return this.handleEnqueue(await request.json())
      case 'assign':
        return this.handleAssign(await request.json())
      case 'complete':
        return this.handleComplete(await request.json())
      case 'fail':
        return this.handleFail(await request.json())
      case 'getTask':
        return this.handleGetTask(url.searchParams.get('id')!)
      default:
        return new Response('Not Found', { status: 404 })
    }
  }

  private async handleEnqueue(task: Omit<TaskRecord, 'status' | 'retryCount' | 'createdAt'>): Promise<Response> {
    const taskId = task.id
    const record: TaskRecord = {
      ...task,
      status: 'pending',
      retryCount: 0,
      createdAt: Date.now()
    }
    await this.state.storage.put(`task:${taskId}`, record)
    // Update queue:pending...
    return new Response(JSON.stringify({ status: 'ok' }))
  }

  private async handleAssign(body: { taskId: string, nodeId: string }): Promise<Response> {
    // Logic to move from pending to processing
    return new Response(JSON.stringify({ status: 'ok' }))
  }

  private async handleComplete(body: { taskId: string, result: unknown }): Promise<Response> {
    // Logic to move to done
    return new Response(JSON.stringify({ status: 'ok' }))
  }

  private async handleFail(body: { taskId: string, error: string }): Promise<Response> {
    // Logic to move to failed or retry
    return new Response(JSON.stringify({ status: 'ok' }))
  }

  private async handleGetTask(taskId: string): Promise<Response> {
    const task = await this.state.storage.get<TaskRecord>(`task:${taskId}`)
    return new Response(JSON.stringify(task))
  }

  async alarm() {
    // Timeout processing
  }
}
