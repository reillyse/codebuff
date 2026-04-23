import { resetTerminalTitle } from './terminal-title'

import type { CliRenderer } from '@opentui/core'

let renderer: CliRenderer | null = null
let handlersInstalled = false
let terminalStateReset = false
let beforeExitHook: (() => Promise<void>) | null = null
let beforeExitHookRan = false

/**
 * Default hard timeout (ms) applied to a `beforeExitHook`. A Ctrl+C must feel
 * snappy, so we bound the user-visible delay even if the hook hangs or a
 * network flush stalls.
 */
const BEFORE_EXIT_HOOK_TIMEOUT_MS = 2_500

/**
 * Run the `beforeExitHook` (if any) with a hard timeout. Idempotent: a
 * second call resolves immediately. Never rejects — hook rejections are
 * caught inline so cleanup cannot block exit.
 */
async function runBeforeExitHook(): Promise<void> {
  if (beforeExitHookRan || !beforeExitHook) return
  beforeExitHookRan = true
  const hook = beforeExitHook
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      // `.catch` here is the sole error sink for the hook. Without it, a
      // rejection would propagate through Promise.race and make this
      // function reject — which would in turn fire as an unhandledRejection
      // from the `void cleanupAndExit(...)` call sites.
      hook().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BEFORE_EXIT_HOOK_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Terminal escape sequences to reset terminal state.
 * These are written directly to stdout to ensure they're sent even if the renderer is in a bad state.
 *
 * Sequences:
 * - \x1b[?1000l: Disable X10 mouse mode
 * - \x1b[?1002l: Disable button event mouse mode
 * - \x1b[?1003l: Disable any-event mouse mode (all motion tracking)
 * - \x1b[?1006l: Disable SGR extended mouse mode
 * - \x1b[?1004l: Disable focus reporting
 * - \x1b[?2004l: Disable bracketed paste mode
 * - \x1b[?25h: Show cursor (safety measure)
 */
const TERMINAL_RESET_SEQUENCES =
  '\x1b[?1000l' + // Disable X10 mouse mode
  '\x1b[?1002l' + // Disable button event mouse mode
  '\x1b[?1003l' + // Disable any-event mouse mode (all motion)
  '\x1b[?1006l' + // Disable SGR extended mouse mode
  '\x1b[?1004l' + // Disable focus reporting
  '\x1b[?2004l' + // Disable bracketed paste mode
  '\x1b[?25h' // Show cursor

/**
 * Reset terminal state by writing escape sequences directly to stdout.
 * This is called BEFORE renderer.destroy() to ensure sequences are sent
 * even if the renderer is in a bad state.
 *
 * This is especially important on Windows where signals like SIGTERM and SIGHUP
 * don't work, so we rely on the 'exit' event which is guaranteed to run.
 */
function resetTerminalState(): void {
  if (terminalStateReset) return
  terminalStateReset = true

  try {
    // Reset terminal title to default
    resetTerminalTitle()
    // Write directly to stdout - this is synchronous and will complete
    // before the process exits, ensuring the terminal is reset
    process.stdout.write(TERMINAL_RESET_SEQUENCES)
  } catch {
    // Ignore errors - stdout may already be closed
  }
}

/**
 * Clean up the renderer by calling destroy().
 * This resets terminal state to prevent garbled output after exit.
 */
function cleanup(): void {
  // FIRST: Reset terminal state by writing escape sequences directly to stdout.
  // This ensures mouse mode, focus reporting, etc. are disabled even if
  // renderer.destroy() fails or doesn't fully clean up.
  resetTerminalState()

  if (renderer && !renderer.isDestroyed) {
    try {
      renderer.destroy()
    } catch {
      // Ignore errors during cleanup - we're exiting anyway
    }
    renderer = null
  }
}

/**
 * Install process-level signal handlers to ensure terminal cleanup on all exit scenarios.
 * Call this once after creating the renderer in index.tsx.
 *
 * This handles:
 * - SIGTERM (kill)
 * - SIGHUP (terminal hangup)
 * - SIGINT (Ctrl+C)
 * - beforeExit / exit events
 * - uncaughtException / unhandledRejection
 *
 * Note: SIGKILL cannot be caught - it's an immediate termination signal.
 *
 * @param cliRenderer The OpenTUI renderer to destroy on exit.
 * @param options.beforeExitHook Optional async hook invoked with a hard
 *   timeout (2.5s) BEFORE `process.exit()`. Used e.g. to flush+shutdown
 *   telemetry so queued spans aren't lost on clean exits. Errors are
 *   swallowed. Runs at most once per process lifetime.
 */
export function installProcessCleanupHandlers(
  cliRenderer: CliRenderer,
  options: { beforeExitHook?: () => Promise<void> } = {},
): void {
  if (handlersInstalled) return
  handlersInstalled = true
  renderer = cliRenderer
  beforeExitHook = options.beforeExitHook ?? null

  const cleanupAndExit = async (exitCode: number) => {
    // Await the async pre-exit hook (with its own hard timeout) BEFORE
    // tearing down the renderer or calling process.exit. This is the only
    // place synchronous `process.exit` is called for signal-driven exits,
    // so it's the right place to thread async shutdown work through.
    await runBeforeExitHook()
    cleanup()
    process.exit(exitCode)
  }

  // SIGTERM - Default kill signal (e.g., `kill <pid>`)
  process.on('SIGTERM', () => {
    void cleanupAndExit(0)
  })

  // SIGHUP - Terminal hangup (e.g., closing the terminal window)
  process.on('SIGHUP', () => {
    void cleanupAndExit(0)
  })

  // SIGINT - Ctrl+C
  process.on('SIGINT', () => {
    void cleanupAndExit(0)
  })

  // beforeExit - Called when the event loop is empty and about to exit.
  // This is the natural-exit path (user types /exit, App unmounts, etc.).
  // Unlike 'exit', async work scheduled here DOES keep the loop alive and
  // gets to complete, so we can legitimately await the hook here.
  process.on('beforeExit', () => {
    void (async () => {
      await runBeforeExitHook()
      cleanup()
    })()
  })

  // exit - Last chance to run synchronous cleanup code. Async work here is
  // abandoned — we rely on beforeExit + signal handlers above to have
  // already awaited the hook. This is a best-effort safety net only.
  process.on('exit', () => {
    cleanup()
  })

  // uncaughtException - Safety net for unhandled errors.
  // We do NOT await the beforeExitHook here: the process is already in a
  // bad state and getting the error onto the user's terminal ASAP beats
  // flushing telemetry. Pending spans get dropped; that's acceptable for
  // a crash path.
  process.on('uncaughtException', (error) => {
    try {
      console.error('Uncaught exception:', error)
    } catch {
      // Ignore logging errors
    }
    cleanupAndExit(1)
  })

  // unhandledRejection - Safety net for unhandled promise rejections
  process.on('unhandledRejection', (reason) => {
    try {
      console.error('Unhandled rejection:', reason)
    } catch {
      // Ignore logging errors
    }
    cleanupAndExit(1)
  })
}
