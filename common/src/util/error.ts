export type ErrorOr<T, E extends ErrorObject = ErrorObject> =
  | Success<T>
  | Failure<E>

export type Success<T> = {
  success: true
  value: T
}

export type Failure<E extends ErrorObject = ErrorObject> = {
  success: false
  error: E
}

/**
 * Result type for prompt functions that can be aborted.
 * Provides rich semantics to distinguish between successful completion and user abort.
 *
 * ## When to use `PromptResult<T>` vs `ErrorOr<T>`
 *
 * Use `PromptResult<T>` when:
 * - The operation can be cancelled by the user (via AbortSignal)
 * - An abort is an expected outcome, not an error
 * - You need to distinguish between errors (which might trigger fallbacks) and
 *   user-initiated aborts (which should propagate immediately)
 *
 * Use `ErrorOr<T>` when:
 * - The operation can fail with an error that should be handled
 * - There's no concept of user-initiated abort
 * - You want to return error details rather than throw
 *
 * ## Abort handling patterns
 *
 * 1. **Check and return early** - For graceful handling where abort means "stop, no error":
 *    ```ts
 *    const result = await promptAiSdk({ ... })
 *    if (result.aborted) return // or return null, false, etc.
 *    doSomething(result.value)
 *    ```
 *
 * 2. **Unwrap and throw** - For propagating aborts as exceptions:
 *    ```ts
 *    const value = unwrapPromptResult(await promptAiSdk({ ... }))
 *    // Throws if aborted, callers should use isAbortError() in catch blocks
 *    ```
 *
 * 3. **Rethrow in catch blocks** - Prevent swallowing abort errors:
 *    ```ts
 *    try {
 *      await someOperation()
 *    } catch (error) {
 *      if (isAbortError(error)) throw error // Don't swallow aborts
 *      // Handle other errors
 *    }
 *    ```
 */
export type PromptResult<T> = PromptSuccess<T> | PromptAborted

export type PromptSuccess<T> = {
  aborted: false
  value: T
}

export type PromptAborted = {
  aborted: true
  reason?: string
}

export type ErrorObject = {
  name: string
  message: string
  stack?: string
  /** HTTP status code from error.status (used by some libraries) */
  status?: number
  /** HTTP status code from error.statusCode (used by AI SDK and Codebuff errors) */
  statusCode?: number
  /** Optional machine-friendly error code, if available */
  code?: string
  /** Optional raw error object */
  rawError?: string
  /** Response body from API errors (AI SDK APICallError) */
  responseBody?: string
  /** URL that was called (API errors) */
  url?: string
  /** Whether the error is retryable (API errors) */
  isRetryable?: boolean
  /** Request body values that were sent (API errors) - stringified for safety */
  requestBodyValues?: string
  /** Cause of the error, if nested */
  cause?: ErrorObject
}

export function success<T>(value: T): Success<T> {
  return {
    success: true,
    value,
  }
}

export function failure(error: unknown): Failure<ErrorObject> {
  return {
    success: false,
    error: getErrorObject(error),
  }
}

/**
 * Create a successful prompt result.
 */
export function promptSuccess<T>(value: T): PromptSuccess<T> {
  return {
    aborted: false,
    value,
  }
}

/**
 * Create an aborted prompt result.
 */
export function promptAborted(reason?: string): PromptAborted {
  return {
    aborted: true,
    ...(reason !== undefined && { reason }),
  }
}

/**
 * Standard error message for aborted requests.
 * Use this constant when throwing abort errors to ensure consistency.
 */
export const ABORT_ERROR_MESSAGE = 'Request aborted'

/**
 * Custom error class for abort errors.
 * Use this class instead of generic Error for abort errors to ensure
 * robust detection via isAbortError() (checks error.name === 'AbortError').
 */
export class AbortError extends Error {
  constructor(reason?: string) {
    super(reason ? `${ABORT_ERROR_MESSAGE}: ${reason}` : ABORT_ERROR_MESSAGE)
    this.name = 'AbortError'
  }
}

/**
 * Check if an error is an abort error.
 * Use this helper to detect abort errors in catch blocks.
 *
 * Detects both:
 * - Errors with message starting with 'Request aborted' (thrown by our code via AbortError)
 * - Native AbortError (thrown by fetch/AI SDK when AbortSignal is triggered)
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  // Check for our custom abort error message:
  // - Exact match: 'Request aborted'
  // - With reason: 'Request aborted: <reason>' (from AbortError class)
  if (
    error.message === ABORT_ERROR_MESSAGE ||
    error.message.startsWith(`${ABORT_ERROR_MESSAGE}: `)
  ) {
    return true
  }
  // Check for native AbortError (DOMException or Error with name 'AbortError')
  // This is thrown by fetch, AI SDK, and other web APIs when AbortSignal is triggered
  if (error.name === 'AbortError') {
    return true
  }
  return false
}

/**
 * Unwrap a PromptResult, returning the value if successful or throwing if aborted.
 *
 * Use this helper for consistent abort handling when you want aborts to propagate
 * as exceptions. Callers should use `isAbortError()` in catch blocks to detect
 * and handle abort errors appropriately (e.g., rethrow instead of logging as errors).
 *
 * @throws {AbortError} When result.aborted is true.
 */
export function unwrapPromptResult<T>(result: PromptResult<T>): T {
  if (result.aborted) {
    throw new AbortError(result.reason)
  }
  return result.value
}

/**
 * Parses a JSON response body string from an API error to extract structured error details.
 * Used to extract machine-readable error codes and human-readable messages from API responses
 * (e.g., AI SDK's APICallError includes a responseBody with the server's JSON response).
 *
 * Returns extracted fields, or an empty object if the responseBody is not a valid JSON string
 * with the expected shape.
 */
export function parseApiErrorResponseBody(responseBody: unknown): {
  errorCode?: string
  message?: string
} {
  if (typeof responseBody !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(responseBody)
    if (!parsed || typeof parsed !== 'object') return {}
    const result: { errorCode?: string; message?: string } = {}
    if ('error' in parsed && typeof (parsed as { error: unknown }).error === 'string') {
      result.errorCode = (parsed as { error: string }).error
    }
    if ('message' in parsed && typeof (parsed as { message: unknown }).message === 'string') {
      result.message = (parsed as { message: string }).message
    }
    return result
  } catch {
    return {}
  }
}

/** HTTP status codes from upstream providers that are transient and safe to retry.
 * Includes Anthropic's 529 (Overloaded) — see https://docs.anthropic.com/en/api/errors */
export const TRANSIENT_API_STATUS_CODES = new Set([500, 502, 503, 504, 529])

/**
 * Name of the AI SDK error thrown when a stream completes without producing any
 * output. In practice this almost always reflects a transient provider failure
 * (e.g. an Anthropic 529 "Overloaded" that arrives *after* the stream opens, so
 * the underlying status code is swallowed inside the stream).
 */
export const NO_OUTPUT_GENERATED_ERROR_NAME = 'AI_NoOutputGeneratedError'

/**
 * Detects the AI SDK's `AI_NoOutputGeneratedError` (by name, with a message
 * fallback). This is treated as transient/retryable because it typically masks
 * a mid-stream provider overload — retrying (capped by MAX_STEP_RETRIES at the
 * call site) lets the run recover instead of failing outright.
 */
export function isNoOutputGeneratedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (
    'name' in error &&
    (error as { name: unknown }).name === NO_OUTPUT_GENERATED_ERROR_NAME
  ) {
    return true
  }
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('no output generated')
  ) {
    return true
  }
  return false
}

/**
 * Check if an error is a transient API error that is safe to retry.
 *
 * Classification (in order):
 * - **Option B:** an `AI_NoOutputGeneratedError` is transient (mid-stream
 *   provider overload surfaces this way).
 * - A present status code is authoritative *for that error* — a non-transient
 *   code (e.g. 400) won't trigger a retry even if the message happens to
 *   contain "overloaded".
 * - Falls back to a message heuristic for providers that return 'overloaded'
 *   errors without a structured status code.
 * - **Option A:** recursively unwraps `error.cause`, so a transient 529/overload
 *   nested inside a wrapper error (e.g. surfaced mid-stream via `cause`) is
 *   still recognized. Cycles are guarded via a `seen` set.
 */
export function isTransientApiError(error: unknown): boolean {
  return isTransientApiErrorImpl(error, new Set())
}

function isTransientApiErrorImpl(
  error: unknown,
  seen: Set<unknown>,
): boolean {
  if (!error || typeof error !== 'object') return false
  if (seen.has(error)) return false
  seen.add(error)

  // Option B: treat AI_NoOutputGeneratedError as transient.
  if (isNoOutputGeneratedError(error)) {
    return true
  }

  const statusCode = getErrorStatusCode(error)
  if (statusCode !== undefined) {
    if (TRANSIENT_API_STATUS_CODES.has(statusCode)) {
      return true
    }
    // A non-transient status code is authoritative for *this* error (we don't
    // fall back to the message heuristic), but a wrapper may still carry a
    // transient cause underneath — so we continue to the cause check below.
  } else if (
    error instanceof Error &&
    error.message.toLowerCase().includes('overloaded')
  ) {
    return true
  }

  // Option A: recursively unwrap the cause chain.
  if ('cause' in error) {
    return isTransientApiErrorImpl((error as { cause: unknown }).cause, seen)
  }

  return false
}

/**
 * Walks the `error.cause` chain (cycle-guarded) and returns the first transient
 * HTTP status code it finds, if any. Useful when a transient 529/5xx is nested
 * inside a wrapper error (e.g. a mid-stream overload surfaced via `cause`), so
 * the top-level error has no status code of its own.
 */
export function getTransientStatusCode(error: unknown): number | undefined {
  return getTransientStatusCodeImpl(error, new Set())
}

function getTransientStatusCodeImpl(
  error: unknown,
  seen: Set<unknown>,
): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  if (seen.has(error)) return undefined
  seen.add(error)

  const statusCode = getErrorStatusCode(error)
  if (statusCode !== undefined && TRANSIENT_API_STATUS_CODES.has(statusCode)) {
    return statusCode
  }
  if ('cause' in error) {
    return getTransientStatusCodeImpl((error as { cause: unknown }).cause, seen)
  }
  return undefined
}

/**
 * Produces a short, human-readable reason describing *why* a transient error is
 * being retried, for surfacing to the user in the retry notice. Distinguishes
 * the mid-stream case (an `AI_NoOutputGeneratedError`, which means the response
 * stream was interrupted before producing output — usually a provider overload)
 * from the standard status-coded case.
 *
 * Examples:
 * - `AI_NoOutputGeneratedError` → "Response stream interrupted (no output)"
 * - 529 (top-level or nested cause) → "Transient API error (529)"
 * - overloaded message, no status code → "Transient API error (provider overloaded)"
 * - otherwise → "Transient API error"
 */
export function describeTransientApiError(error: unknown): string {
  if (isNoOutputGeneratedError(error)) {
    // Not necessarily an overload (can be an empty completion, content filter,
    // etc.), so keep the reason neutral.
    return 'Response stream interrupted (no output)'
  }

  // Only report a *transient* status code (walking the cause chain). Using the
  // raw top-level code could surface a misleading non-transient code (e.g. a
  // 400 wrapper around a 529 cause).
  const statusCode = getTransientStatusCode(error)
  if (statusCode !== undefined) {
    return `Transient API error (${statusCode})`
  }

  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('overloaded')
  ) {
    return 'Transient API error (provider overloaded)'
  }

  return 'Transient API error'
}

/**
 * Extracts the HTTP status code from an error object, if present.
 * Checks 'statusCode' first (our convention / AI SDK errors), then 'status' (APICallError).
 *
 * This is the single source-of-truth for status code extraction — use this
 * instead of ad-hoc property checks scattered across the codebase.
 */
export function getErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  if ('statusCode' in error) {
    const statusCode = (error as { statusCode: unknown }).statusCode
    if (typeof statusCode === 'number') return statusCode
  }
  if ('status' in error) {
    const status = (error as { status: unknown }).status
    if (typeof status === 'number') return status
  }
  return undefined
}

// Extended error properties that various libraries add to Error objects
interface ExtendedErrorProperties {
  status?: number
  statusCode?: number
  code?: string
  // API error properties (AI SDK APICallError, etc.)
  responseBody?: string
  url?: string
  isRetryable?: boolean
  requestBodyValues?: Record<string, unknown>
  cause?: unknown
}

/**
 * Safely stringify an object, handling circular references and large objects.
 */
function safeStringify(value: unknown, maxLength = 10000): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value.slice(0, maxLength)
  try {
    const seen = new WeakSet()
    const str = JSON.stringify(
      value,
      (_, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]'
          seen.add(val)
        }
        return val
      },
      2,
    )
    return str?.slice(0, maxLength)
  } catch {
    return '[Unable to stringify]'
  }
}

export function getErrorObject(
  error: unknown,
  options: { includeRawError?: boolean } = {},
): ErrorObject {
  if (error instanceof Error) {
    const extError = error as Error & Partial<ExtendedErrorProperties>

    // Extract responseBody - could be string or object
    let responseBody: string | undefined
    if (extError.responseBody !== undefined) {
      responseBody = safeStringify(extError.responseBody)
    }

    // Extract requestBodyValues - typically an object, stringify for logging
    let requestBodyValues: string | undefined
    if (
      extError.requestBodyValues !== undefined &&
      typeof extError.requestBodyValues === 'object'
    ) {
      requestBodyValues = safeStringify(extError.requestBodyValues)
    }

    // Extract cause - recursively convert to ErrorObject if present
    let cause: ErrorObject | undefined
    if (extError.cause !== undefined) {
      cause = getErrorObject(extError.cause, options)
    }

    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      status: typeof extError.status === 'number' ? extError.status : undefined,
      statusCode:
        typeof extError.statusCode === 'number'
          ? extError.statusCode
          : undefined,
      code: typeof extError.code === 'string' ? extError.code : undefined,
      rawError: options.includeRawError
        ? safeStringify(error)
        : undefined,
      // API error fields
      responseBody,
      url: typeof extError.url === 'string' ? extError.url : undefined,
      isRetryable:
        typeof extError.isRetryable === 'boolean'
          ? extError.isRetryable
          : undefined,
      requestBodyValues,
      cause,
    }
  }

  // Handle plain objects that would otherwise stringify to [object Object]
  if (error && typeof error === 'object') {
    if ('message' in error && typeof (error as { message: unknown }).message === 'string') {
      return {
        name: 'Error',
        message: (error as { message: string }).message,
      }
    }
    const stringified = safeStringify(error, 500)
    return {
      name: 'Error',
      message: stringified ?? '[Unknown error]',
    }
  }

  return {
    name: 'Error',
    message: String(error),
  }
}
