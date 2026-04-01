#!/usr/bin/env bun

import { spawnSync, type SpawnSyncOptions } from 'child_process'
import { chmodSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

type TargetInfo = {
  bunTarget: string
  platform: NodeJS.Platform
  arch: string
}

const VERBOSE = process.env.VERBOSE === 'true'
const OVERRIDE_TARGET = process.env.OVERRIDE_TARGET
const OVERRIDE_PLATFORM = process.env.OVERRIDE_PLATFORM as
  | NodeJS.Platform
  | undefined
const OVERRIDE_ARCH = process.env.OVERRIDE_ARCH ?? undefined

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const cliLiteRoot = join(__dirname, '..')
const repoRoot = dirname(cliLiteRoot)

function log(message: string) {
  if (VERBOSE) {
    console.log(message)
  }
}

function logAlways(message: string) {
  console.log(message)
}

function runCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: VERBOSE ? 'inherit' : 'pipe',
    env: options.env,
  })

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? ''
    throw new Error(
      `Command "${command} ${args.join(' ')}" failed with exit code ${
        result.status
      }${stderr ? `\n${stderr}` : ''}`,
    )
  }
}

function getTargetInfo(): TargetInfo {
  if (OVERRIDE_TARGET && OVERRIDE_PLATFORM && OVERRIDE_ARCH) {
    return {
      bunTarget: OVERRIDE_TARGET,
      platform: OVERRIDE_PLATFORM,
      arch: OVERRIDE_ARCH,
    }
  }

  const platform = process.platform
  const arch = process.arch

  const mappings: Record<string, TargetInfo> = {
    'linux-x64': { bunTarget: 'bun-linux-x64', platform: 'linux', arch: 'x64' },
    'linux-arm64': {
      bunTarget: 'bun-linux-arm64',
      platform: 'linux',
      arch: 'arm64',
    },
    'darwin-x64': {
      bunTarget: 'bun-darwin-x64',
      platform: 'darwin',
      arch: 'x64',
    },
    'darwin-arm64': {
      bunTarget: 'bun-darwin-arm64',
      platform: 'darwin',
      arch: 'arm64',
    },
    'win32-x64': {
      bunTarget: 'bun-windows-x64',
      platform: 'win32',
      arch: 'x64',
    },
  }

  const key = `${platform}-${arch}`
  const target = mappings[key]

  if (!target) {
    throw new Error(`Unsupported build target: ${key}`)
  }

  return target
}

async function main() {
  const [, , binaryNameArg, versionArg] = process.argv
  const binaryName = binaryNameArg ?? 'codebuff-lite'

  if (!versionArg) {
    throw new Error('Version argument is required when building a binary')
  }

  // Append git short SHA to version if not already present
  let version = versionArg
  if (!version.includes('+')) {
    try {
      const gitResult = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: repoRoot,
        stdio: 'pipe',
      })
      if (gitResult.status === 0) {
        const sha = gitResult.stdout.toString().trim()
        if (sha) version = `${version}+${sha}`
      }
    } catch {
      // git not available — skip SHA suffix
    }
  }

  log(`Building ${binaryName} @ ${version}`)

  const targetInfo = getTargetInfo()
  const binDir = join(cliLiteRoot, 'bin')

  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true })
  }

  // Generate bundled agents file before compiling
  log('Generating bundled agents...')
  runCommand('bun', ['run', 'scripts/prebuild-agents.ts'], {
    cwd: cliLiteRoot,
    env: process.env,
  })

  // Build SDK dependencies
  log('Building SDK dependencies...')
  runCommand('bun', ['run', '--cwd', '../sdk', 'build'], {
    cwd: cliLiteRoot,
    env: process.env,
  })

  const outputFilename =
    targetInfo.platform === 'win32' ? `${binaryName}.exe` : binaryName
  const outputFile = join(binDir, outputFilename)

  // Collect all NEXT_PUBLIC_* environment variables
  const nextPublicEnvVars = Object.entries(process.env)
    .filter(([key]) => key.startsWith('NEXT_PUBLIC_'))
    .map(([key, value]) => [`process.env.${key}`, `"${value ?? ''}"`])

  const defineFlags = [
    ['process.env.NODE_ENV', '"production"'],
    ['process.env.CODEBUFF_IS_BINARY', '"true"'],
    ['process.env.CODEBUFF_CLI_VERSION', `"${version}"`],
    [
      'process.env.CODEBUFF_CLI_TARGET',
      `"${targetInfo.platform}-${targetInfo.arch}"`,
    ],
    ...nextPublicEnvVars,
  ]

  const buildArgs = [
    'build',
    'src/index.ts',
    '--compile',
    '--production',
    `--target=${targetInfo.bunTarget}`,
    `--outfile=${outputFile}`,
    '--sourcemap=none',
    ...defineFlags.flatMap(([key, value]) => ['--define', `${key}=${value}`]),
    '--env "NEXT_PUBLIC_*"',
  ]

  log(
    `bun ${buildArgs
      .map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))
      .join(' ')}`,
  )

  runCommand('bun', buildArgs, { cwd: cliLiteRoot })

  if (targetInfo.platform !== 'win32') {
    chmodSync(outputFile, 0o755)
  }

  logAlways(
    `\u2705 Built ${outputFilename} (${targetInfo.platform}-${targetInfo.arch})`,
  )
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message)
  } else {
    console.error(error)
  }
  process.exit(1)
})
