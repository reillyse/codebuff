import os from 'node:os'
import path from 'node:path'

import { env } from '../env'

import type { ClientEnv } from '../types/contracts/env'

/**
 * ~/.config/manicode{-env}/
 *
 * Single source of truth for the Codebuff config directory. Uses os.homedir()
 * and an env suffix derived from NEXT_PUBLIC_CB_ENVIRONMENT.
 *
 * Kept in its own node-only module (NOT in util/credentials.ts) so that web
 * routes importing `genAuthCode`/`userSchema` from util/credentials don't pull
 * in the `env` import-time side effects or Node built-ins (os/path).
 */
export const getConfigDir = (clientEnv: ClientEnv = env): string => {
  const envSuffix =
    clientEnv.NEXT_PUBLIC_CB_ENVIRONMENT &&
    clientEnv.NEXT_PUBLIC_CB_ENVIRONMENT !== 'prod'
      ? `-${clientEnv.NEXT_PUBLIC_CB_ENVIRONMENT}`
      : ''
  return path.join(os.homedir(), '.config', `manicode${envSuffix}`)
}
