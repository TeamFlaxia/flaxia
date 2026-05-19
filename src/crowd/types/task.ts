export type TaskStatus = 'pending' | 'assigning' | 'processing' | 'done' | 'failed'

export type WorkloadType = 'ai-inference' | 'image-process' | 'file-convert'

export type TaskRecord = {
  id: string
  status: TaskStatus
  workload: WorkloadType
  payload: unknown
  createdAt: number       // unixtime ms
  assignedAt?: number
  completedAt?: number
  assignedNodeId?: string
  retryCount: number      // max 3
  timeoutMs: number       // デフォルト 30000
  callbackUrl?: string    // 完了時にPOSTする先（SDK側）
  result?: unknown
  error?: string
}
