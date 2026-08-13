import { describe, test, expect } from 'bun:test'

import { SLASH_COMMANDS } from '../../data/slash-commands'
import { findCommand, COMMAND_REGISTRY } from '../command-registry'
import {
  normalizeInput,
  parseCommand,
  isSlashCommand,
  parseCommandInput,
} from '../router-utils'

describe('router-utils', () => {
  describe('normalizeInput', () => {
    test('strips leading slash from input', () => {
      expect(normalizeInput('/help')).toBe('help')
      expect(normalizeInput('/exit')).toBe('exit')
    })

    test('preserves input without leading slash', () => {
      expect(normalizeInput('help')).toBe('help')
      expect(normalizeInput('some prompt text')).toBe('some prompt text')
    })

    test('handles empty string', () => {
      expect(normalizeInput('')).toBe('')
    })

    test('handles only slash', () => {
      expect(normalizeInput('/')).toBe('')
    })

    test('handles multiple slashes', () => {
      expect(normalizeInput('//help')).toBe('/help')
      expect(normalizeInput('///test')).toBe('//test')
    })

    test('preserves internal slashes', () => {
      expect(normalizeInput('/path/to/file')).toBe('path/to/file')
      expect(normalizeInput('path/to/file')).toBe('path/to/file')
    })

    test('preserves whitespace in input', () => {
      expect(normalizeInput('/help me')).toBe('help me')
      expect(normalizeInput('help me')).toBe('help me')
    })
  })

  describe('isSlashCommand', () => {
    test('returns true for input starting with /', () => {
      expect(isSlashCommand('/help')).toBe(true)
      expect(isSlashCommand('/exit')).toBe(true)
      expect(isSlashCommand('/')).toBe(true)
    })

    test('returns false for input not starting with /', () => {
      expect(isSlashCommand('help')).toBe(false)
      expect(isSlashCommand('exit')).toBe(false)
      expect(isSlashCommand('')).toBe(false)
    })

    test('handles whitespace correctly', () => {
      expect(isSlashCommand('  /help')).toBe(true)
      expect(isSlashCommand('  help')).toBe(false)
    })
  })

  describe('parseCommand', () => {
    test('extracts command from slashed input', () => {
      expect(parseCommand('/help')).toBe('help')
      expect(parseCommand('/exit')).toBe('exit')
      expect(parseCommand('/bash')).toBe('bash')
    })

    test('returns empty string for unslashed input (not a slash command)', () => {
      expect(parseCommand('help')).toBe('')
      expect(parseCommand('exit')).toBe('')
      expect(parseCommand('bash')).toBe('')
    })

    test('extracts first word as command when there are arguments', () => {
      expect(parseCommand('/help me')).toBe('help')
      expect(parseCommand('/bash ls -la')).toBe('bash')
    })

    test('converts command to lowercase', () => {
      expect(parseCommand('/HELP')).toBe('help')
      expect(parseCommand('/EXIT')).toBe('exit')
      expect(parseCommand('/BaSh')).toBe('bash')
    })

    test('handles empty string', () => {
      expect(parseCommand('')).toBe('')
    })

    test('handles whitespace-only input', () => {
      expect(parseCommand('   ')).toBe('')
    })

    test('handles only slash', () => {
      expect(parseCommand('/')).toBe('')
    })

    test('handles multiple spaces between words', () => {
      expect(parseCommand('/help   me')).toBe('help')
    })
  })

  describe('parseCommandInput', () => {
    test('returns command info for exact slashless matches', () => {
      expect(parseCommandInput('init')).toEqual({
        command: 'init',
        args: '',
        implicitCommand: true,
      })
      expect(parseCommandInput('new')).toEqual({
        command: 'new',
        args: '',
        implicitCommand: true,
      })
    })

    test('is case-insensitive and trims whitespace for slashless matches', () => {
      expect(parseCommandInput('INIT')).toEqual({
        command: 'init',
        args: '',
        implicitCommand: true,
      })
      expect(parseCommandInput('  new  ')).toEqual({
        command: 'new',
        args: '',
        implicitCommand: true,
      })
    })

    test('returns null for slashless commands with arguments', () => {
      expect(parseCommandInput('init something')).toBe(null)
      expect(parseCommandInput('new my message')).toBe(null)
    })

    test('returns null for commands not configured for slashless invocation', () => {
      expect(parseCommandInput('bash')).toBe(null)
      expect(parseCommandInput('history')).toBe(null)
    })

    test('distinguishes slashed and slashless invocation', () => {
      expect(parseCommandInput('/init')).toEqual({
        command: 'init',
        args: '',
        implicitCommand: false,
      })
    })

    test('does not match aliases for slashless commands', () => {
      const newCmd = SLASH_COMMANDS.find((cmd) => cmd.id === 'new')
      for (const alias of newCmd?.aliases ?? []) {
        expect(parseCommandInput(alias)).toBe(null)
      }
    })

    test('returns null for empty input', () => {
      expect(parseCommandInput('')).toBe(null)
      expect(parseCommandInput('   ')).toBe(null)
    })

    test('commands with implicitCommand are configured correctly', () => {
      const initCmd = SLASH_COMMANDS.find((cmd) => cmd.id === 'init')
      const newCmd = SLASH_COMMANDS.find((cmd) => cmd.id === 'new')

      expect(initCmd?.implicitCommand).toBe(true)
      expect(newCmd?.implicitCommand).toBe(true)
    })

    test('parseCommandInput matches all implicitCommand commands', () => {
      const implicitCommands = SLASH_COMMANDS.filter((cmd) => cmd.implicitCommand)
      for (const cmd of implicitCommands) {
        expect(parseCommandInput(cmd.id)).toEqual({
          command: cmd.id.toLowerCase(),
          args: '',
          implicitCommand: true,
        })
      }
    })
  })

  describe('slash commands only work with / prefix', () => {
    const slashCommands = [
      'exit',
      'clear',
      'new',
      'init',
      'bash',
      'help',
      'history',
    ]

    for (const cmd of slashCommands) {
      test(`"/${cmd}" is recognized as slash command`, () => {
        expect(parseCommand(`/${cmd}`)).toBe(cmd)
      })

      test(`"${cmd}" without slash is NOT a slash command (sent to agent)`, () => {
        expect(parseCommand(cmd)).toBe('')
      })
    }
  })

  describe('words that look like commands but are not', () => {
    const nonCommands = [
      'please help me',
      'clear the database',
      'exit the building',
      'bash scripting is fun',
    ]

    for (const input of nonCommands) {
      test(`"${input}" is NOT a slash command`, () => {
        expect(parseCommand(input)).toBe('')
      })
    }
  })
})

describe('command-registry', () => {
  describe('findCommand', () => {
    test('finds command by name', () => {
      const bash = findCommand('bash')
      expect(bash).toBeDefined()
      expect(bash?.name).toBe('bash')

      const historyCmd = findCommand('history')
      expect(historyCmd).toBeDefined()
      expect(historyCmd?.name).toBe('history')
    })

    test('finds command by alias', () => {
      const chats = findCommand('chats')
      expect(chats).toBeDefined()
      expect(chats?.name).toBe('history')

      const quit = findCommand('quit')
      expect(quit).toBeDefined()
      expect(quit?.name).toBe('exit')
    })

    test('returns undefined for unknown command', () => {
      expect(findCommand('unknown')).toBeUndefined()
      expect(findCommand('notacommand')).toBeUndefined()
    })

    test('is case insensitive', () => {
      expect(findCommand('BASH')?.name).toBe('bash')
      expect(findCommand('HISTORY')?.name).toBe('history')
      expect(findCommand('CHATS')?.name).toBe('history')
    })
  })

  describe('COMMAND_REGISTRY', () => {
    test('all commands have unique names', () => {
      const names = COMMAND_REGISTRY.map((c) => c.name)
      const uniqueNames = new Set(names)
      expect(names.length).toBe(uniqueNames.size)
    })

    test('all aliases are unique across all commands', () => {
      const allAliases = COMMAND_REGISTRY.flatMap((c) => c.aliases)
      const uniqueAliases = new Set(allAliases)
      expect(allAliases.length).toBe(uniqueAliases.size)
    })

    test('no alias conflicts with command names', () => {
      const names = new Set(COMMAND_REGISTRY.map((c) => c.name))
      const allAliases = COMMAND_REGISTRY.flatMap((c) => c.aliases)
      for (const alias of allAliases) {
        expect(names.has(alias)).toBe(false)
      }
    })

    test('slash command metadata maps to registered commands', () => {
      const registered = new Set([
        ...COMMAND_REGISTRY.map((c) => c.name),
        ...COMMAND_REGISTRY.flatMap((c) => c.aliases),
      ])

      // Commands with insertText are UI-only shortcuts that insert text into
      // the input field instead of executing a command.
      const executableCommands = SLASH_COMMANDS.filter((cmd) => !cmd.insertText)

      for (const slashCommand of executableCommands) {
        expect(registered.has(slashCommand.id)).toBe(true)
        for (const alias of slashCommand.aliases ?? []) {
          expect(registered.has(alias)).toBe(true)
        }
      }
    })

    test('connect:chatgpt is the only registered ChatGPT OAuth command (when feature flag enabled)', () => {
      const { CHATGPT_OAUTH_ENABLED } = require('@codebuff/common/constants/chatgpt-oauth')
      const hasConnectChatgpt = SLASH_COMMANDS.some(
        (cmd) => cmd.id === 'connect:chatgpt',
      )
      expect(hasConnectChatgpt).toBe(CHATGPT_OAUTH_ENABLED)

      // Bare /connect and /chatgpt are no longer registered
      const bareConnectSlash = SLASH_COMMANDS.some(
        (cmd) => cmd.id === 'connect',
      )
      expect(bareConnectSlash).toBe(false)

      const chatgptSlash = SLASH_COMMANDS.some(
        (cmd) => cmd.id === 'chatgpt',
      )
      expect(chatgptSlash).toBe(false)
    })

    test('findCommand resolves connect:chatgpt to the connect:chatgpt command (when enabled)', () => {
      const { CHATGPT_OAUTH_ENABLED } = require('@codebuff/common/constants/chatgpt-oauth')
      const command = findCommand('connect:chatgpt')
      if (CHATGPT_OAUTH_ENABLED) {
        expect(command).toBeDefined()
        expect(command?.name).toBe('connect:chatgpt')
      } else {
        expect(command).toBeUndefined()
      }
    })

    test('findCommand does not resolve /connect to the chatgpt OAuth command', () => {
      const command = findCommand('connect')
      expect(command).toBeUndefined()
    })

    test('findCommand does not resolve /chatgpt to the chatgpt OAuth command', () => {
      const command = findCommand('chatgpt')
      expect(command).toBeUndefined()
    })
  })
})
