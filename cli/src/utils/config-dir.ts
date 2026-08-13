import os from 'os'
import path from 'path'

import { env } from '@codebuff/common/env'

// Get the config directory path
export const getConfigDir = (): string => {
  return path.join(
    os.homedir(),
    '.config',
    'manicode' +
      // on a development stack?
      (env.NEXT_PUBLIC_CB_ENVIRONMENT !== 'prod'
        ? `-${env.NEXT_PUBLIC_CB_ENVIRONMENT}`
        : ''),
  )
}
