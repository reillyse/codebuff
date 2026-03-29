import fs from 'fs'

/**
 * Write a file atomically: write to a temp file in the same directory,
 * then rename over the target. Prevents corruption from crashes or
 * concurrent writes across processes.
 */
export const atomicWriteFileSync = (filePath: string, data: string): void => {
  const tmpPath = `${filePath}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    fs.writeFileSync(tmpPath, data, { mode: 0o600 })
    fs.renameSync(tmpPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(tmpPath) } catch {}
    throw error
  }
}

/**
 * In-process lock that serializes all read-modify-write operations on
 * credentials.json. Prevents intra-process races when multiple async
 * operations (e.g. concurrent token refreshes) access the file.
 *
 * Since both the SDK (Claude/ChatGPT OAuth) and the CLI (user credentials)
 * write to the same credentials.json file, this single shared lock
 * ensures no concurrent writes can corrupt data.
 */
let credentialFileLock: Promise<void> = Promise.resolve()

export function withCredentialFileLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = credentialFileLock
  let resolve: () => void
  credentialFileLock = new Promise<void>(r => { resolve = r })
  return prev.then(fn).finally(() => resolve!())
}
