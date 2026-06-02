#!/usr/bin/env bun

import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const cliLiteRoot = dirname(dirname(__filename))
const repoRoot = dirname(cliLiteRoot)
const pkgPath = join(cliLiteRoot, 'package.json')

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

// Strip any existing prerelease/build metadata to get the base semver
const baseVersion = pkg.version.replace(/[-+].*$/, '')

const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: repoRoot,
  stdio: 'pipe',
})

if (result.status !== 0) {
  console.error('Failed to get git SHA — is this a git repo?')
  process.exit(1)
}

const sha = result.stdout.toString().trim()
const stamped = `${baseVersion}-${sha}`

if (pkg.version === stamped) {
  console.log(`Version already stamped: ${stamped}`)
  process.exit(0)
}

pkg.version = stamped
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`Stamped cli-lite version: ${stamped}`)
