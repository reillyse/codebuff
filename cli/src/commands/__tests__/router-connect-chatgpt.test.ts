import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import * as chatGptOAuthConstants from '@codebuff/common/constants/chatgpt-oauth'

import type { RouterParams } from '../command-registry'
import * as analytics from '../../utils/analytics'
import * as chatStore from '../../state/chat-store'

const setInputMode = mock(() => {})
const setMessages = mock(() => {})
const saveToHistory = mock(() => {})
const setInputValue = mock(() => {})
const handleChatGptAuthCode = mock(async () => ({
  success: true,
  message: 'ok',
}))

// `mock.module` is process-global in bun and is never restored, so this stub
// leaks into every test file that runs after this one. Replacing the module
// wholesale therefore stripped `reset()` (and every other store method) from the
// real store, breaking unrelated suites — e.g. bash-command.test.ts, whose
// beforeEach calls `useChatStore.getState().reset()`.
//
// Spread the real module and override only the fields this suite needs, so
// everything else survives for subsequent files. `realGetState` is captured
// before the mock is installed to avoid recursing into the stub.
// The override is also gated on `overrideActive`, which is cleared in afterAll:
// because the stub can never be uninstalled, leaving it permanently active would
// pin `inputMode` to 'connect:chatgpt' for every later suite. Once this file is
// done the module behaves exactly like the real one again.
const realGetState = chatStore.useChatStore.getState.bind(
  chatStore.useChatStore,
)
let overrideActive = true

mock.module('../../state/chat-store', () => ({
  ...chatStore,
  useChatStore: {
    ...chatStore.useChatStore,
    getState: () =>
      overrideActive
        ? {
            ...realGetState(),
            inputMode: 'connect:chatgpt',
            setInputMode,
            pendingAttachments: [],
          }
        : realGetState(),
  },
}))

mock.module('../../components/chatgpt-connect-banner', () => ({
  handleChatGptAuthCode,
}))

mock.module('../../utils/analytics', () => ({
  ...analytics,
  trackEvent: () => {},
}))

mock.module('@codebuff/common/constants/chatgpt-oauth', () => ({
  ...chatGptOAuthConstants,
  CHATGPT_OAUTH_ENABLED: true,
}))

afterAll(() => {
  // Release the module-level override so later suites see the real store.
  overrideActive = false
})

describe('routeUserPrompt connect:chatgpt mode', () => {
  beforeEach(() => {
    setInputMode.mockClear()
    setMessages.mockClear()
    saveToHistory.mockClear()
    setInputValue.mockClear()
    handleChatGptAuthCode.mockClear()
  })

  afterEach(() => {
    setInputMode.mockClear()
    setMessages.mockClear()
    saveToHistory.mockClear()
    setInputValue.mockClear()
    handleChatGptAuthCode.mockClear()
  })

  test('when in connect:chatgpt mode, it exchanges the auth code and updates messages', async () => {
    const { routeUserPrompt } = await import('../router')

    const params = {
      abortControllerRef: { current: null },
      agentMode: 'DEFAULT',
      inputRef: { current: null },
      inputValue: 'auth-code-123',
      isChainInProgressRef: { current: false },
      isStreaming: false,
      streamMessageIdRef: { current: null },
      addToQueue: () => {},
      clearMessages: () => {},
      saveToHistory,
      scrollToLatest: () => {},
      sendMessage: async () => {},
      setCanProcessQueue: () => {},
      setInputFocused: () => {},
      setInputValue,
      setMessages,
      stopStreaming: () => {},
    } satisfies RouterParams

    await routeUserPrompt(params)

    expect(handleChatGptAuthCode).toHaveBeenCalledWith('auth-code-123')
    expect(setMessages).toHaveBeenCalled()
    expect(setInputMode).toHaveBeenCalledWith('default')
  })
})
