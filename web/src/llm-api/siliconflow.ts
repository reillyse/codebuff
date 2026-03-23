import type { ChatCompletionRequestBody } from './types'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { InsertMessageBigqueryFn } from '@codebuff/common/types/contracts/bigquery'

export function isSiliconFlowModel(_model: string): boolean {
  return false
}

export class SiliconFlowError extends Error {
  statusCode: number
  statusText: string
  constructor(message: string, statusCode: number, statusText: string) {
    super(message)
    this.name = 'SiliconFlowError'
    this.statusCode = statusCode
    this.statusText = statusText
  }
  toJSON() {
    return { error: { message: this.message, code: this.statusCode } }
  }
}

export async function handleSiliconFlowStream(_params: {
  body: ChatCompletionRequestBody
  userId: string
  stripeCustomerId: string | null
  agentId: string | undefined
  fetch: typeof globalThis.fetch
  logger: Logger
  insertMessageBigquery: InsertMessageBigqueryFn
}): Promise<ReadableStream> {
  throw new Error('SiliconFlow provider is not available')
}

export async function handleSiliconFlowNonStream(_params: {
  body: ChatCompletionRequestBody
  userId: string
  stripeCustomerId: string | null
  agentId: string | undefined
  fetch: typeof globalThis.fetch
  logger: Logger
  insertMessageBigquery: InsertMessageBigqueryFn
}): Promise<Response> {
  throw new Error('SiliconFlow provider is not available')
}
