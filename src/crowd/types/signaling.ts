export type WorkloadType = 'ai-inference' | 'image-process' | 'file-convert'

// Worker → Node
export type HelloMessage = {
  type: 'hello'
  nodeId: string
}

export type TaskAssignMessage = {
  type: 'task'
  taskId: string
  workload: WorkloadType
  payload: unknown
  offer: RTCSessionDescriptionInit
  timeoutMs: number
}

export type PingMessage = {
  type: 'ping'
}

export type ServerMessage = HelloMessage | TaskAssignMessage | PingMessage

// Node → Worker
export type AnswerMessage = {
  type: 'answer'
  taskId: string
  answer: RTCSessionDescriptionInit
}

export type IceCandidateMessage = {
  type: 'ice'
  taskId: string
  candidate: RTCIceCandidateInit
}

export type ResultMessage = {
  type: 'result'
  taskId: string
  success: boolean
  payload: unknown
  processingMs: number
}

export type PongMessage = {
  type: 'pong'
  nodeId: string
  cpuLoad: number
}

export type ClientMessage = AnswerMessage | IceCandidateMessage | ResultMessage | PongMessage
