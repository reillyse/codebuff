import type { ChatCompletionRequestBody } from './types'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { InsertMessageBigqueryFn } from '@codebuff/common/types/contracts/bigquery'

export function isFireworksModel(_model: string): boolean {
  return false
}

export class FireworksError extends Error {
  statusCode: number
  statusText: string
  constructor(message: string, statusCode: number, statusText: string) {
    super(message)
    this.name = 'FireworksError'
    this.statusCode = statusCode
    this.statusText = statusText
  }
  toJSON() {
    return { error: { message: this.message, code: this.statusCode } }
  }
}

export async function handleFireworksStream(_params: {
  body: ChatCompletionRequestBody
  userId: string
  stripeCustomerId: string | null
  agentId: string | undefined
  fetch: typeof globalThis.fetch
  logger: Logger
  insertMessageBigquery: InsertMessageBigqueryFn
}): Promise<ReadableStream> {
  throw new Error('Fireworks provider is not available')
}

export async function handleFireworksNonStream(_params: {
  body: ChatCompletionRequestBody
  userId: string
  stripeCustomerId: string | null
  agentId: string | undefined
  fetch: typeof globalThis.fetch
  logger: Logger
  insertMessageBigquery: InsertMessageBigqueryFn
}): Promise<Response> {
  throw new Error('Fireworks provider is not available')
}
