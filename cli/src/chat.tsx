import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import fs from 'fs'
import { useShallow } from 'zustand/react/shallow'

import { routeUserPrompt, addBashMessageToHistory } from './commands/router'
import { BottomStatusLine } from './components/bottom-status-line'
import { ChatInputBar } from './components/chat-input-bar'
import { InFlightToolsBox } from './components/in-flight-tools-box'
import { LoadPreviousButton } from './components/load-previous-button'
import { ReviewScreen } from './components/review-screen'
import { MessageWithAgents } from './components/message-with-agents'
import { PendingBashMessage } from './components/pending-bash-message'
import { StatusBar } from './components/status-bar'
import { TopBanner } from './components/top-banner'
import { getSlashCommandsWithSkills } from './data/slash-commands'
import { useAgentValidation } from './hooks/use-agent-validation'
import { useAskUserBridge } from './hooks/use-ask-user-bridge'
import { useChatInput } from './hooks/use-chat-input'
import {
  useChatKeyboard,
  type ChatKeyboardHandlers,
} from './hooks/use-chat-keyboard'
import { useChatMessages } from './hooks/use-chat-messages'
import { useChatState } from './hooks/use-chat-state'
import { useChatStreaming } from './hooks/use-chat-streaming'
import { useChatUI } from './hooks/use-chat-ui'
import { useClaudeQuotaQuery } from './hooks/use-claude-quota-query'
import { useClipboard } from './hooks/use-clipboard'
import { useEvent } from './hooks/use-event'
import { useInputHistory } from './hooks/use-input-history'
import { useSendMessage } from './hooks/use-send-message'
import { useSuggestionEngine } from './hooks/use-suggestion-engine'
import { getProjectRoot } from './project-files'
import { useChatHistoryStore } from './state/chat-history-store'
import { useChatStore } from './state/chat-store'
import { useReviewStore } from './state/review-store'
import { useMessageBlockStore } from './state/message-block-store'
import { reportActivity } from './utils/activity-tracker'
import { trackEvent } from './utils/analytics'
import { getClaudeOAuthStatus } from './utils/claude-oauth'
import { showClipboardMessage } from './utils/clipboard'
import { readClipboardImage } from './utils/clipboard-image'
import { HIPPO_BINARY, checkHippoConnection, getHippoSessionStats } from './utils/hippo-hooks'
import { getInputModeConfig } from './utils/input-modes'

import {
  type ChatKeyboardState,
  createDefaultChatKeyboardState,
} from './utils/keyboard-actions'
import { loadLocalAgents } from './utils/local-agent-registry'
import { logger } from './utils/logger'
import {
  addClipboardPlaceholder,
  addPendingImageFromFile,
  validateAndAddImage,
} from './utils/pending-attachments'
import { getLoadedSkills } from './utils/skill-registry'
import {
  getStatusIndicatorState,
  type AuthStatus,
} from './utils/status-indicator-state'
import {
  getInFlightTools,
  getLastStreamActivityAt,
  getRetryActivity,
  hasInFlightToolCalls,
} from './utils/stream-activity'
import { createPasteHandler } from './utils/strings'
import { setTerminalTitle } from './utils/terminal-title'
import { computeInputLayoutMetrics } from './utils/text-layout'

import type { CommandResult } from './commands/command-registry'
import type { MultilineInputHandle } from './components/multiline-input'
import type { MatchedSlashCommand } from './hooks/use-suggestion-engine'
import type { AgentMode } from './utils/constants'
import type { HippoSessionStats } from './utils/hippo-hooks'
import type { FileTreeNode } from '@codebuff/common/util/file'
import type { ScrollBoxRenderable } from '@opentui/core'

export const Chat = ({
  headerContent,
  initialPrompt,
  agentId,
  fileTree,
  inputRef,
  continueChat,
  continueChatId,
  authStatus,
  initialMode,
  gitRoot,
  onSwitchToGitRoot,
}: {
  headerContent: React.ReactNode
  initialPrompt: string | null
  agentId?: string
  fileTree: FileTreeNode[]
  inputRef: React.MutableRefObject<MultilineInputHandle | null>
  continueChat: boolean
  continueChatId?: string
  authStatus: AuthStatus
  initialMode?: AgentMode
  gitRoot?: string | null
  onSwitchToGitRoot?: () => void
}) => {
  const [forceFileOnlyMentions, setForceFileOnlyMentions] = useState(false)

  const { validate: validateAgents } = useAgentValidation()

  // Subscribe to ask_user bridge to trigger form display
  useAskUserBridge()

  // Get chat state from extracted hook
  const {
    inputValue,
    cursorPosition,
    lastEditDueToNav,
    setInputValue,
    inputFocused,
    setInputFocused,
    slashSelectedIndex,
    setSlashSelectedIndex,
    agentSelectedIndex,
    setAgentSelectedIndex,
    focusedAgentId,
    setFocusedAgentId,
    messages,
    setMessages,
    agentMode,
    setAgentMode,
    toggleAgentMode,
    isRetrying,
    isSearchingMemory,
    pendingBashMessages,
    refs: {
      activeAgentStreamsRef,
      isChainInProgressRef,
      activeSubagentsRef,
      abortControllerRef,
      sendMessageRef,
    },
  } = useChatState()

  const { statusMessage } = useClipboard()

  // Set initial mode from CLI flag on mount
  useEffect(() => {
    if (initialMode) {
      setAgentMode(initialMode)
    }
  }, [initialMode, setAgentMode])

  // Use extracted chat messages hook for message tree and pagination
  const {
    messageTree,
    visibleTopLevelMessages,
    hiddenMessageCount,
    handleCollapseToggle,
    isUserCollapsing,
    handleLoadPreviousMessages,
    handleToggleAll,
  } = useChatMessages({ messages, setMessages })

  // Use extracted UI hook for scroll, terminal dimensions, and theme
  const {
    scrollRef,
    scrollToLatest,
    scrollUp,
    scrollDown,
    appliedScrollboxProps,
    isAtBottom,
    hasOverflow,
    terminalWidth,
    terminalHeight,
    separatorWidth,
    messageAvailableWidth,
    isCompactHeight,
    isNarrowWidth,
    theme,
    markdownPalette,
  } = useChatUI({ messages, isUserCollapsing })

  const localAgents = useMemo(() => loadLocalAgents(agentMode), [agentMode])
  const inputMode = useChatStore((state) => state.inputMode)
  const setInputMode = useChatStore((state) => state.setInputMode)
  const askUserState = useChatStore((state) => state.askUserState)

  // Get loaded skills for slash commands
  const loadedSkills = useMemo(() => getLoadedSkills(), [])

  // Merge slash commands with skill commands.
  const filteredSlashCommands = useMemo(() => {
    return getSlashCommandsWithSkills(loadedSkills)
  }, [loadedSkills])

  const {
    slashContext,
    mentionContext,
    slashMatches,
    agentMatches,
    fileMatches,
    slashSuggestionItems,
    agentSuggestionItems,
    fileSuggestionItems,
  } = useSuggestionEngine({
    disableAgentSuggestions: forceFileOnlyMentions || inputMode !== 'default',
    inputValue: inputMode === 'bash' ? '' : inputValue,
    cursorPosition,
    slashCommands: filteredSlashCommands,
    localAgents,
    fileTree,
    currentAgentMode: agentMode,
  })

  useEffect(() => {
    if (!mentionContext.active) {
      setForceFileOnlyMentions(false)
    }
  }, [mentionContext.active])

  // Track when slash menu is activated
  const prevSlashActiveRef = useRef(false)
  useEffect(() => {
    if (slashContext.active && !prevSlashActiveRef.current) {
      trackEvent(AnalyticsEvent.SLASH_MENU_ACTIVATED, {
        queryLength: slashContext.query.length,
        matchCount: slashMatches.length,
        inputLength: inputValue.length,
      })
    }
    prevSlashActiveRef.current = slashContext.active
  }, [slashContext.active, slashContext.query, slashMatches.length, inputValue.length])

  // Reset suggestion menu indexes when context changes
  useEffect(() => {
    if (!slashContext.active) {
      setSlashSelectedIndex(0)
      return
    }
    setSlashSelectedIndex(0)
  }, [slashContext.active, slashContext.query, setSlashSelectedIndex])

  useEffect(() => {
    if (slashMatches.length > 0 && slashSelectedIndex >= slashMatches.length) {
      setSlashSelectedIndex(slashMatches.length - 1)
    }
    if (slashMatches.length === 0 && slashSelectedIndex !== 0) {
      setSlashSelectedIndex(0)
    }
  }, [slashMatches.length, slashSelectedIndex, setSlashSelectedIndex])

  useEffect(() => {
    if (!mentionContext.active) {
      setAgentSelectedIndex(0)
      return
    }
    setAgentSelectedIndex(0)
  }, [mentionContext.active, mentionContext.query, setAgentSelectedIndex])

  useEffect(() => {
    const totalMatches = agentMatches.length + fileMatches.length
    if (totalMatches > 0 && agentSelectedIndex >= totalMatches) {
      setAgentSelectedIndex(totalMatches - 1)
    }
    if (totalMatches === 0 && agentSelectedIndex !== 0) {
      setAgentSelectedIndex(0)
    }
  }, [
    agentMatches.length,
    fileMatches.length,
    agentSelectedIndex,
    setAgentSelectedIndex,
  ])

  const openFileMenuWithTab = useCallback(() => {
    const safeCursor = Math.max(0, Math.min(cursorPosition, inputValue.length))

    let wordStart = safeCursor
    while (wordStart > 0 && !/\s/.test(inputValue[wordStart - 1])) {
      wordStart--
    }

    const before = inputValue.slice(0, wordStart)
    const wordAtCursor = inputValue.slice(wordStart, safeCursor)
    const after = inputValue.slice(safeCursor)
    const mentionWord = wordAtCursor.startsWith('@')
      ? wordAtCursor
      : `@${wordAtCursor}`

    const text = `${before}${mentionWord}${after}`
    const nextCursor = before.length + mentionWord.length

    setInputValue({
      text,
      cursorPosition: nextCursor,
      lastEditDueToNav: false,
    })
    setForceFileOnlyMentions(true)
  }, [cursorPosition, inputValue, setInputValue])

  const { saveToHistory, navigateUp, navigateDown, resetHistoryNavigation } = useInputHistory(
    inputValue,
    setInputValue,
    { inputMode, setInputMode },
  )

  // Use extracted streaming hook for connection, timer, queue, and exit handling
  const {
    isConnected,
    showReconnectionMessage,
    mainAgentTimer,
    timerStartTime,
    streamStatus,
    isWaitingForResponse,
    isStreaming,
    setStreamStatus,
    queuedMessages,
    queuePaused,
    streamMessageIdRef,
    addToQueue,
    stopStreaming,
    setCanProcessQueue,
    pauseQueue,
    resumeQueue,
    clearQueue,
    isQueuePausedRef,
    isProcessingQueueRef,
    queuedCount,
    shouldShowQueuePreview,
    queuePreviewTitle,
    pausedQueueText,
    inputPlaceholder,
    handleCtrlC,
    ensureQueueActiveBeforeSubmit,
    nextCtrlCWillExit,
  } = useChatStreaming({
    agentMode,
    inputValue,
    setInputValue,
    terminalWidth,
    separatorWidth,
    isChainInProgressRef,
    activeAgentStreamsRef,
    sendMessageRef,
  })

  // When streaming completes, flush any pending bash commands into history (ghost mode only)
  // Non-ghost mode commands are already in history and will be cleared when user sends next message
  useEffect(() => {
    if (
      !isStreaming &&
      !streamMessageIdRef.current &&
      !isChainInProgressRef.current &&
      pendingBashMessages.length > 0
    ) {
      // Only flush ghost mode commands (those not already added to history) to UI
      const ghostModeMessages = pendingBashMessages.filter(
        (msg) => !msg.isRunning && !msg.addedToHistory,
      )

      // Add ghost mode messages to UI history
      for (const msg of ghostModeMessages) {
        addBashMessageToHistory({
          command: msg.command,
          stdout: msg.stdout,
          stderr: msg.stderr ?? null,
          exitCode: msg.exitCode,
          cwd: msg.cwd || process.cwd(),
          setMessages,
        })
      }

      // Mark ghost mode messages as added to history (so they don't show as ghost UI)
      // but keep them in pendingBashMessages so they get sent to LLM with next user message
      if (ghostModeMessages.length > 0) {
        const ghostIds = new Set(ghostModeMessages.map((m) => m.id))
        useChatStore.setState((state) => ({
          pendingBashMessages: state.pendingBashMessages.map((m) =>
            ghostIds.has(m.id) ? { ...m, addedToHistory: true } : m,
          ),
        }))
      }
    }
  }, [isStreaming, pendingBashMessages, setMessages])

  const { sendMessage, clearMessages } = useSendMessage({
    inputRef,
    activeSubagentsRef,
    isChainInProgressRef,
    setStreamStatus,
    setCanProcessQueue,
    abortControllerRef,
    agentId,
    onBeforeMessageSend: validateAgents,
    mainAgentTimer,
    scrollToLatest,
    onTimerEvent: () => {},
    isQueuePausedRef,
    isProcessingQueueRef,
    resumeQueue,
    continueChat,
    continueChatId,
  })

  sendMessageRef.current = sendMessage

  const onSubmitPrompt = useEvent(
    async (
      content: string,
      mode: AgentMode,
      options?: { preserveInputValue?: boolean },
    ) => {
      ensureQueueActiveBeforeSubmit()

      const preserveInput = options?.preserveInputValue === true
      const previousInputValue = preserveInput
        ? (() => {
            const {
              inputValue: text,
              cursorPosition,
              lastEditDueToNav,
            } = useChatStore.getState()
            return { text, cursorPosition, lastEditDueToNav }
          })()
        : null

      // Preserve attachments if needed (inline logic to avoid abstraction overhead)
      const preservedAttachments = preserveInput
        ? (() => {
            const items = useChatStore.getState().pendingAttachments
            if (items.length > 0) {
              useChatStore.getState().clearPendingAttachments()
              return [...items]
            }
            return null
          })()
        : null

      try {
        const result = await routeUserPrompt({
          abortControllerRef,
          agentMode: mode,
          inputRef,
          inputValue: content,
          isChainInProgressRef,
          isStreaming,
          streamMessageIdRef,
          addToQueue,
          clearMessages,
          saveToHistory,
          scrollToLatest,
          sendMessage,
          setCanProcessQueue,
          setInputFocused,
          setInputValue,
          setMessages,
          stopStreaming,
        })

        return result
      } finally {
        if (previousInputValue) {
          setInputValue({
            text: previousInputValue.text,
            cursorPosition: previousInputValue.cursorPosition,
            lastEditDueToNav: previousInputValue.lastEditDueToNav,
          })
        }

        // Restore attachments if they were preserved and none have been added since
        if (preservedAttachments && useChatStore.getState().pendingAttachments.length === 0) {
          useChatStore.setState((state) => {
            state.pendingAttachments = preservedAttachments
          })
        }
      }
    },
  )

  // Handle followup suggestion clicks
  useEffect(() => {
    const handleFollowupClick = (event: Event) => {
      const customEvent = event as CustomEvent<{
        prompt: string
        index: number
        toolCallId: string
      }>
      const { prompt, index, toolCallId } = customEvent.detail

      logger.info(
        { promptLength: prompt.length, index, toolCallId, agentMode },
        '[followup-click] Followup clicked',
      )

      // Track analytics event
      trackEvent(AnalyticsEvent.FOLLOWUP_CLICKED, {
        promptLength: prompt.length,
        index,
        agentMode,
      })

      // Mark this followup as clicked (persisted per toolCallId)
      useChatStore.getState().markFollowupClicked(toolCallId, index)

      // Send the followup prompt directly, preserving the user's current input
      onSubmitPrompt(prompt, agentMode, {
        preserveInputValue: true,
      })
        .then((result) => {
          logger.info(
            { hasResult: !!result },
            '[followup-click] onSubmitPrompt completed',
          )
        })
        .catch((error) => {
          logger.error(
            { error },
            '[followup-click] onSubmitPrompt failed with error',
          )
          showClipboardMessage('Failed to send followup', { durationMs: 3000 })
        })
    }

    globalThis.addEventListener('codebuff:send-followup', handleFollowupClick)
    return () => {
      globalThis.removeEventListener(
        'codebuff:send-followup',
        handleFollowupClick,
      )
    }
  }, [onSubmitPrompt, agentMode])

  const handleMentionItemClick = useCallback(
    (index: number) => {
      if (mentionContext.startIndex < 0) return

      let replacement: string
      if (index < agentMatches.length) {
        const selected = agentMatches[index]
        if (!selected) return
        replacement = `@${selected.displayName} `
      } else {
        const fileIndex = index - agentMatches.length
        const selectedFile = fileMatches[fileIndex]
        if (!selectedFile) return
        replacement = `@${selectedFile.filePath} `
      }
      const before = inputValue.slice(0, mentionContext.startIndex)
      const after = inputValue.slice(
        mentionContext.startIndex + 1 + mentionContext.query.length,
      )
      setInputValue({
        text: before + replacement + after,
        cursorPosition: before.length + replacement.length,
        lastEditDueToNav: false,
      })
      setAgentSelectedIndex(0)
    },
    [
      mentionContext,
      agentMatches,
      fileMatches,
      inputValue,
      setInputValue,
      setAgentSelectedIndex,
    ],
  )

  const { inputWidth, handleBuildFast, handleBuildMax, handleBuildFree } = useChatInput({
    setInputValue,
    agentMode,
    setAgentMode,
    separatorWidth,
    initialPrompt,
    onSubmitPrompt,
    isCompactHeight,
    isNarrowWidth,
  })

  const { reviewMode, closeReviewScreen } = useReviewStore(
    useShallow((state) => ({
      reviewMode: state.reviewMode,
      closeReviewScreen: state.closeReviewScreen,
    })),
  )

  const handleCommandResult = useCallback((result?: CommandResult) => {
    if (!result) return

    if (result.openChatHistory) {
      useChatHistoryStore.getState().openChatHistory()
    }

    if (result.openReviewScreen) {
      useReviewStore.getState().openReviewScreen()
    }
  }, [])

  // Helper to apply insertText for slash commands - returns true if handled
  const applySlashInsertText = useCallback(
    (selected: MatchedSlashCommand): boolean => {
      if (selected.insertText != null && slashContext.startIndex >= 0) {
        const before = inputValue.slice(0, slashContext.startIndex)
        const after = inputValue.slice(
          slashContext.startIndex + 1 + slashContext.query.length,
        )
        setInputValue({
          text: before + selected.insertText + after,
          cursorPosition: before.length + selected.insertText.length,
          lastEditDueToNav: false,
        })
        setSlashSelectedIndex(0)
        return true
      }
      return false
    },
    [slashContext, inputValue, setInputValue, setSlashSelectedIndex],
  )

  // Click handler for slash menu items - executes command or inserts text
  const handleSlashItemClick = useCallback(
    async (index: number) => {
      const selected = slashMatches[index]
      if (!selected) return

      // If the command has insertText, insert it instead of executing
      if (applySlashInsertText(selected)) return

      // Execute the selected slash command immediately
      const commandString = `/${selected.id}`
      setSlashSelectedIndex(0)

      const result = await onSubmitPrompt(commandString, agentMode)
      handleCommandResult(result)
    },
    [
      slashMatches,
      applySlashInsertText,
      setSlashSelectedIndex,
      onSubmitPrompt,
      agentMode,
      handleCommandResult,
    ],
  )

  const inputValueRef = useRef(inputValue)
  const cursorPositionRef = useRef(cursorPosition)
  useEffect(() => {
    inputValueRef.current = inputValue
  }, [inputValue])

  // Report activity on input changes (debounced via separate effect)
  const lastReportedActivityRef = useRef<number>(0)
  useEffect(() => {
    const now = Date.now()
    // Throttle to max once per second to avoid excessive calls
    if (now - lastReportedActivityRef.current > 1000) {
      lastReportedActivityRef.current = now
      reportActivity()
    }
  }, [inputValue])
  useEffect(() => {
    cursorPositionRef.current = cursorPosition
  }, [cursorPosition])

  const handleReviewOptionSelect = useCallback(
    (reviewText: string) => {
      closeReviewScreen()
      setInputFocused(true)
      // Submit the review request
      onSubmitPrompt(reviewText, agentMode)
        .then((result) => handleCommandResult(result))
        .catch((error) => {
          logger.error({ error }, '[review] Failed to submit review prompt')
          showClipboardMessage('Failed to send review request', { durationMs: 3000 })
        })
    },
    [closeReviewScreen, setInputFocused, onSubmitPrompt, agentMode, handleCommandResult],
  )

  const handleCloseReviewScreen = useCallback(() => {
    closeReviewScreen()
    setInputFocused(true)
  }, [closeReviewScreen, setInputFocused])

  // Ensure bracketed paste events target the active chat input
  useEffect(() => {
    if (!askUserState) {
      inputRef.current?.focus()
    }
  }, [askUserState, inputRef])

  const handleSubmit = useCallback(async () => {
    reportActivity()
    // Update terminal title with truncated user input
    if (inputValue.trim()) {
      setTerminalTitle(inputValue)
    }
    const result = await onSubmitPrompt(inputValue, agentMode)
    handleCommandResult(result)
  }, [onSubmitPrompt, inputValue, agentMode, handleCommandResult])

  const totalMentionMatches = agentMatches.length + fileMatches.length
  const historyNavUpEnabled =
    lastEditDueToNav ||
    (cursorPosition === 0 &&
      ((slashContext.active && slashSelectedIndex === 0) ||
        (mentionContext.active && agentSelectedIndex === 0) ||
        (!slashContext.active && !mentionContext.active)))
  const historyNavDownEnabled =
    lastEditDueToNav ||
    (cursorPosition === inputValue.length &&
      ((slashContext.active &&
        slashSelectedIndex === slashMatches.length - 1) ||
        (mentionContext.active &&
          agentSelectedIndex === totalMentionMatches - 1) ||
        (!slashContext.active && !mentionContext.active)))

  // Build keyboard state from store values
  const chatKeyboardState: ChatKeyboardState = useMemo(
    () => ({
      ...createDefaultChatKeyboardState(),
      inputMode,
      inputValue,
      cursorPosition,
      isStreaming,
      isWaitingForResponse,
      focusedAgentId,
      slashMenuActive: slashContext.active,
      mentionMenuActive: mentionContext.active,
      slashSelectedIndex,
      agentSelectedIndex,
      slashMatchesLength: slashMatches.length,
      totalMentionMatches: agentMatches.length + fileMatches.length,
      disableSlashSuggestions:
        getInputModeConfig(inputMode).disableSlashSuggestions,
      historyNavUpEnabled,
      historyNavDownEnabled,
      nextCtrlCWillExit,
      queuePaused,
      queuedCount,
    }),
    [
      inputMode,
      inputValue,
      cursorPosition,
      isStreaming,
      isWaitingForResponse,
      focusedAgentId,
      slashContext.active,
      mentionContext.active,
      slashSelectedIndex,
      agentSelectedIndex,
      slashMatches.length,
      agentMatches.length,
      fileMatches.length,
      historyNavUpEnabled,
      historyNavDownEnabled,
      nextCtrlCWillExit,
      queuePaused,
      queuedCount,
    ],
  )

  // Keyboard handlers
  const chatKeyboardHandlers: ChatKeyboardHandlers = useMemo(
    () => ({
      onExitInputMode: () => setInputMode('default'),
      onClearInput: () =>
        setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false }),
      onBackspaceExitMode: () => setInputMode('default'),
      onInterruptStream: () => {
        abortControllerRef.current?.abort()
        if (queuedMessages.length > 0) {
          pauseQueue()
        }
      },
      onSlashMenuDown: () => setSlashSelectedIndex((prev) => prev + 1),
      onSlashMenuUp: () => setSlashSelectedIndex((prev) => prev - 1),
      onSlashMenuTab: () => {
        // Do nothing if there's only one match - user needs to press Enter to select
        if (slashMatches.length <= 1) return
        setSlashSelectedIndex((prev) => (prev + 1) % slashMatches.length)
      },
      onSlashMenuShiftTab: () =>
        setSlashSelectedIndex(
          (prev) => (slashMatches.length + prev - 1) % slashMatches.length,
        ),
      onSlashMenuSelect: async () => {
        const selected = slashMatches[slashSelectedIndex] || slashMatches[0]
        if (!selected) return

        // If the command has insertText, insert it instead of executing
        if (applySlashInsertText(selected)) return

        // Execute the selected slash command immediately
        const commandString = `/${selected.id}`
        setSlashSelectedIndex(0)

        const result = await onSubmitPrompt(commandString, agentMode)

        handleCommandResult(result)
      },
      onSlashMenuComplete: () => {
        // Complete the word without executing - same as clicking on the item
        const selected = slashMatches[slashSelectedIndex] || slashMatches[0]
        if (!selected || slashContext.startIndex < 0) return

        // If the command has insertText, insert it instead of the command
        if (applySlashInsertText(selected)) return

        const before = inputValue.slice(0, slashContext.startIndex)
        const after = inputValue.slice(
          slashContext.startIndex + 1 + slashContext.query.length,
        )
        const replacement = `/${selected.id} `
        setInputValue({
          text: before + replacement + after,
          cursorPosition: before.length + replacement.length,
          lastEditDueToNav: false,
        })
        setSlashSelectedIndex(0)
      },
      onMentionMenuDown: () => setAgentSelectedIndex((prev) => prev + 1),
      onMentionMenuUp: () => setAgentSelectedIndex((prev) => prev - 1),
      onMentionMenuTab: () => {
        const totalMatches = agentMatches.length + fileMatches.length
        setAgentSelectedIndex((prev) => (prev + 1) % totalMatches)
      },
      onMentionMenuShiftTab: () => {
        const totalMatches = agentMatches.length + fileMatches.length
        setAgentSelectedIndex(
          (prev) => (totalMatches + prev - 1) % totalMatches,
        )
      },
      onMentionMenuSelect: () => {
        if (mentionContext.startIndex < 0) return

        const trySelectAtIndex = (index: number): boolean => {
          let replacement: string
          if (index < agentMatches.length) {
            const selected = agentMatches[index]
            if (!selected) return false
            replacement = `@${selected.displayName} `
          } else {
            const fileIndex = index - agentMatches.length
            const selectedFile = fileMatches[fileIndex]
            if (!selectedFile) return false
            replacement = `@${selectedFile.filePath} `
          }
          const before = inputValue.slice(0, mentionContext.startIndex)
          const after = inputValue.slice(
            mentionContext.startIndex + 1 + mentionContext.query.length,
          )
          setInputValue({
            text: before + replacement + after,
            cursorPosition: before.length + replacement.length,
            lastEditDueToNav: false,
          })
          setAgentSelectedIndex(0)
          return true
        }

        // Try current selection, fall back to first item
        trySelectAtIndex(agentSelectedIndex) || trySelectAtIndex(0)
      },
      onMentionMenuComplete: () => {
        // Complete the word without executing - same as select for mentions
        if (mentionContext.startIndex < 0) return

        let replacement: string
        const index = agentSelectedIndex
        if (index < agentMatches.length) {
          const selected = agentMatches.length > 0 ? (agentMatches[index] || agentMatches[0]) : undefined
          if (!selected) return
          replacement = `@${selected.displayName} `
        } else {
          const fileIndex = index - agentMatches.length
          const selectedFile = fileMatches.length > 0 ? (fileMatches[fileIndex] || fileMatches[0]) : undefined
          if (!selectedFile) return
          replacement = `@${selectedFile.filePath} `
        }
        const before = inputValue.slice(0, mentionContext.startIndex)
        const after = inputValue.slice(
          mentionContext.startIndex + 1 + mentionContext.query.length,
        )
        setInputValue({
          text: before + replacement + after,
          cursorPosition: before.length + replacement.length,
          lastEditDueToNav: false,
        })
        setAgentSelectedIndex(0)
      },
      onOpenFileMenuWithTab: () => {
        const safeCursor = Math.max(
          0,
          Math.min(cursorPosition, inputValue.length),
        )
        let wordStart = safeCursor
        while (wordStart > 0 && !/\s/.test(inputValue[wordStart - 1]!)) {
          wordStart--
        }
        if (wordStart < safeCursor) {
          openFileMenuWithTab()
          return true
        }
        return false
      },
      onHistoryUp: navigateUp,
      onHistoryDown: navigateDown,
      onToggleAgentMode: toggleAgentMode,
      onUnfocusAgent: () => {
        setFocusedAgentId(null)
        setInputFocused(true)
        inputRef.current?.focus()
      },
      onClearQueue: clearQueue,
      onExitAppWarning: () => handleCtrlC(),
      onExitApp: () => handleCtrlC(),
      onBashHistoryUp: navigateUp,
      onBashHistoryDown: navigateDown,
      onPasteImage: () => {
        const placeholderPath = addClipboardPlaceholder()

        // Process the image in the background
        setTimeout(() => {
          const result = readClipboardImage()
          if (!result.success || !result.imagePath) {
            useChatStore.getState().removePendingImage(placeholderPath)
            showClipboardMessage(result.error || 'Failed to paste image', {
              durationMs: 3000,
            })
            return
          }

          const cwd = getProjectRoot() ?? process.cwd()
          addPendingImageFromFile(result.imagePath, cwd, placeholderPath).catch(
            (error) => {
              logger.error({ error }, 'Failed to add pending image from file')
              showClipboardMessage('Failed to add image', { durationMs: 3000 })
            }
          )
        }, 0)
      },
      onPasteImagePath: (imagePath: string) => {
        const cwd = getProjectRoot() ?? process.cwd()
        validateAndAddImage(imagePath, cwd).catch((error) => {
          logger.error({ error, imagePath }, 'Failed to validate and add image')
          showClipboardMessage('Failed to add image', { durationMs: 3000 })
        })
      },
      onPasteText: (text: string) => {
        setInputValue((prev) => {
          const before = prev.text.slice(0, prev.cursorPosition)
          const after = prev.text.slice(prev.cursorPosition)
          return {
            text: before + text + after,
            cursorPosition: before.length + text.length,
            lastEditDueToNav: false,
          }
        })
      },
      onScrollUp: scrollUp,
      onScrollDown: scrollDown,
      onToggleAll: handleToggleAll,
    }),
    [
      setInputMode,
      setInputValue,
      abortControllerRef,
      queuedMessages.length,
      pauseQueue,
      setSlashSelectedIndex,
      slashMatches,
      slashSelectedIndex,
      slashContext,
      inputValue,
      applySlashInsertText,
      onSubmitPrompt,
      agentMode,
      handleCommandResult,
      setAgentSelectedIndex,
      agentMatches,
      fileMatches,
      agentSelectedIndex,
      mentionContext,
      cursorPosition,
      openFileMenuWithTab,
      navigateUp,
      navigateDown,
      toggleAgentMode,
      setFocusedAgentId,
      setInputFocused,
      inputRef,
      handleCtrlC,
      clearQueue,
      scrollUp,
      scrollDown,
      handleToggleAll,
    ],
  )

  // Use the chat keyboard hook
  useChatKeyboard({
    state: chatKeyboardState,
    handlers: chatKeyboardHandlers,
    disabled: askUserState !== null || reviewMode,
  })

  // Sync message block context to zustand store for child components
  const setMessageBlockContext = useMessageBlockStore(
    (state) => state.setContext,
  )
  const setMessageBlockCallbacks = useMessageBlockStore(
    (state) => state.setCallbacks,
  )

  // Update context when values change - useLayoutEffect ensures synchronous updates
  // to prevent message loss during rapid streaming (race condition fix)
  useLayoutEffect(() => {
    setMessageBlockContext({
      theme,
      markdownPalette,
      messageTree,
      isWaitingForResponse,
      timerStartTime,
      availableWidth: messageAvailableWidth,
    })
  }, [
    theme,
    markdownPalette,
    messageTree,
    isWaitingForResponse,
    timerStartTime,
    messageAvailableWidth,
    setMessageBlockContext,
  ])

  // Update callbacks once (they're stable)
  useEffect(() => {
    setMessageBlockCallbacks({
      onToggleCollapsed: handleCollapseToggle,
      onBuildFast: handleBuildFast,
      onBuildMax: handleBuildMax,
      onBuildFree: handleBuildFree,
    })
  }, [
    handleCollapseToggle,
    handleBuildFast,
    handleBuildMax,
    handleBuildFree,
    setMessageBlockCallbacks,
  ])

  const modeConfig = getInputModeConfig(inputMode)
  const hasSlashSuggestions =
    slashContext.active &&
    slashSuggestionItems.length > 0 &&
    !modeConfig.disableSlashSuggestions
  const hasMentionSuggestions =
    !slashContext.active &&
    mentionContext.active &&
    (agentSuggestionItems.length > 0 || fileSuggestionItems.length > 0)
  const hasSuggestionMenu = hasSlashSuggestions || hasMentionSuggestions

  const inputLayoutMetrics = useMemo(() => {
    // In bash mode, layout is based on the actual input (no ! prefix needed)
    const text = inputValue ?? ''
    const layoutContent = text.length > 0 ? text : ' '
    const safeCursor = Math.max(
      0,
      Math.min(cursorPosition, layoutContent.length),
    )
    const cursorProbe =
      safeCursor >= layoutContent.length
        ? layoutContent
        : layoutContent.slice(0, safeCursor)
    const cols = Math.max(1, inputWidth)
    return computeInputLayoutMetrics({
      layoutContent,
      cursorProbe,
      cols,
      maxHeight: Math.floor(terminalHeight / 2),
    })
  }, [inputValue, cursorPosition, inputWidth, terminalHeight])
  const isMultilineInput = inputLayoutMetrics.heightLines > 1
  const shouldCenterInputVertically = !hasSuggestionMenu && !isMultilineInput

  // Tick every second while a response is active so the derived status
  // (including the time-based "stalled" indicator) recomputes even when no new
  // chunks arrive. Without this tick, a silent stream would never re-render to
  // reveal the stalled state.
  const isActivePhase = streamStatus === 'waiting' || streamStatus === 'streaming'
  const [statusTick, setStatusTick] = useState(0)
  useEffect(() => {
    if (!isActivePhase) return
    const interval = setInterval(() => setStatusTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [isActivePhase])

  const statusIndicatorState = getStatusIndicatorState({
    statusMessage,
    streamStatus,
    nextCtrlCWillExit,
    isConnected,
    authStatus,
    showReconnectionMessage,
    isRetrying,
    isAskUserActive: askUserState !== null,
    isSearchingMemory,
    lastStreamActivityAt: getLastStreamActivityAt(),
    retryActivity: getRetryActivity(),
    hasInFlightTools: hasInFlightToolCalls(),
  })
  const hasStatusIndicatorContent = statusIndicatorState.kind !== 'idle'

  // Snapshot of currently-executing tools, read on the same 1s status tick so
  // the expandable "tools running" box (shown once a tool passes the ~30s
  // threshold) updates its elapsed times every second while active. Memoized on
  // the tick + active phase so unrelated chat re-renders (input changes, etc.)
  // don't re-snapshot.
  const inFlightTools = useMemo(
    () => getInFlightTools(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusTick drives refresh
    [statusTick, isActivePhase],
  )

  const isClaudeOAuthActive = getClaudeOAuthStatus().connected

  // Subscribe to hippo enabled state reactively (updates when /hippo enable/disable runs)
  const hippoEnabled = useChatStore((state) => state.hippoEnabled)
  const isHippoBinaryInstalled = useMemo(
    () => hippoEnabled && fs.existsSync(HIPPO_BINARY),
    [hippoEnabled],
  )

  // Track when hippo was last used (transition from searching → not searching)
  const [hippoLastUsedAt, setHippoLastUsedAt] = useState<number | null>(null)
  const prevSearchingMemoryRef = useRef(isSearchingMemory)
  useEffect(() => {
    if (prevSearchingMemoryRef.current && !isSearchingMemory) {
      setHippoLastUsedAt(Date.now())
    }
    prevSearchingMemoryRef.current = isSearchingMemory
  }, [isSearchingMemory])

  // Fetch hippo session stats when enabled and binary is installed, refresh after each memory search
  const chatSessionId = useChatStore((state) => state.chatSessionId)

  // Reset hippoLastUsedAt when session changes (e.g. /new command)
  useEffect(() => {
    setHippoLastUsedAt(null)
  }, [chatSessionId])
  const hippoRecalls = useChatStore((state) => state.hippoRecalls)
  const hippoConnectionOk = useChatStore((state) => state.hippoConnectionOk)
  const hippoLastError = useChatStore((state) => state.hippoLastError)
  const [isHippoRetrying, setIsHippoRetrying] = useState(false)
  const handleHippoRetry = useCallback(async () => {
    setIsHippoRetrying(true)
    try {
      const result = await checkHippoConnection()
      useChatStore.getState().setHippoConnectionOk(result.connectionOk)
      useChatStore.getState().setHippoLastError(result.lastError)
    } finally {
      setIsHippoRetrying(false)
    }
  }, [])
  const hippoFetchIdRef = useRef(0)
  const [hippoStats, setHippoStats] = useState<HippoSessionStats | null>(null)
  useEffect(() => {
    if (!isHippoBinaryInstalled) {
      setHippoStats(null)
      return
    }
    if (isSearchingMemory) return
    const fetchId = ++hippoFetchIdRef.current
    // Delay to allow storeRunToHippo (fire-and-forget) to complete before fetching stats
    const timer = setTimeout(() => {
      getHippoSessionStats(chatSessionId)
        .then((stats) => {
          if (hippoFetchIdRef.current === fetchId) setHippoStats(stats)
        })
        .catch(() => {
          if (hippoFetchIdRef.current === fetchId) setHippoStats(null)
        })
    }, 1500)
    return () => clearTimeout(timer)
  }, [isHippoBinaryInstalled, isSearchingMemory, chatSessionId])

  // Fetch Claude quota when OAuth is active
  const { data: claudeQuota } = useClaudeQuotaQuery({
    enabled: isClaudeOAuthActive,
    refetchInterval: 60 * 1000, // Refetch every 60 seconds
  })


  const inputBoxTitle = useMemo(() => {
    const segments: string[] = []

    if (queuePreviewTitle) {
      segments.push(queuePreviewTitle)
    } else if (pausedQueueText) {
      segments.push(`⏸ ${pausedQueueText}`)
    }

    if (segments.length === 0) {
      return undefined
    }

    return ` ${segments.join('   ')} `
  }, [queuePreviewTitle, pausedQueueText])

  // Determine if Claude is actively streaming/waiting
  const isClaudeActive = isStreaming || isWaitingForResponse

  const shouldShowStatusLine =
    hasStatusIndicatorContent || shouldShowQueuePreview || !isAtBottom

  const lastMouseActivityRef = useRef<number>(0)
  const handleMouseActivity = useCallback(() => {
    const now = Date.now()
    // Throttle to max once per second
    if (now - lastMouseActivityRef.current > 1000) {
      lastMouseActivityRef.current = now
      reportActivity()
    }
  }, [])

  return (
    <box
      onMouseMove={handleMouseActivity}
      style={{
        flexDirection: 'column',
        gap: 0,
        flexGrow: 1,
      }}
    >
      <scrollbox
        ref={scrollRef as React.Ref<ScrollBoxRenderable>}
        stickyScroll
        stickyStart="bottom"
        scrollX={false}
        scrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{
          visible: !isStreaming && !isWaitingForResponse && hasOverflow,
          trackOptions: { width: 1 },
        }}
        {...appliedScrollboxProps}
        style={{
          flexGrow: 1,
          rootOptions: {
            flexGrow: 1,
            padding: 0,
            gap: 0,
            flexDirection: 'row',
            shouldFill: true,
            backgroundColor: 'transparent',
          },
          wrapperOptions: {
            flexGrow: 1,
            border: false,
            shouldFill: true,
            backgroundColor: 'transparent',
            flexDirection: 'column',
          },
          contentOptions: {
            flexDirection: 'column',
            gap: 0,
            shouldFill: true,
            justifyContent: 'flex-end',
            backgroundColor: 'transparent',
            paddingLeft: 1,
            paddingRight: 2,
          },
        }}
      >
        <TopBanner gitRoot={gitRoot} onSwitchToGitRoot={onSwitchToGitRoot} />

        {headerContent}
        {hiddenMessageCount > 0 && (
          <LoadPreviousButton
            hiddenCount={hiddenMessageCount}
            onLoadMore={handleLoadPreviousMessages}
          />
        )}
        {visibleTopLevelMessages.map((message, idx) => {
          const isLast = idx === visibleTopLevelMessages.length - 1
          return (
            <MessageWithAgents
              key={message.id}
              message={message}
              depth={0}
              isLastMessage={isLast}
              availableWidth={messageAvailableWidth}
            />
          )
        })}
        {/* Pending bash messages as ghost messages (only show those not already in history) */}
        {pendingBashMessages
          .filter((msg) => !msg.addedToHistory)
          .map((msg) => (
            <PendingBashMessage key={`pending-bash-${msg.id}`} message={msg} />
          ))}
      </scrollbox>

      <box
        style={{
          flexShrink: 0,
          backgroundColor: 'transparent',
        }}
      >
        <InFlightToolsBox tools={inFlightTools} isActive={isActivePhase} />

        {shouldShowStatusLine && (
          <StatusBar
            timerStartTime={timerStartTime}
            isAtBottom={isAtBottom}
            scrollToLatest={scrollToLatest}
            statusIndicatorState={statusIndicatorState}
          />
        )}

        {reviewMode ? (
          <ReviewScreen
            onSelectOption={handleReviewOptionSelect}
            onCancel={handleCloseReviewScreen}
          />
        ) : (
          <ChatInputBar
            inputValue={inputValue}
            cursorPosition={cursorPosition}
            setInputValue={setInputValue}
            inputFocused={inputFocused}
            inputRef={inputRef}
            inputPlaceholder={inputPlaceholder}
            lastEditDueToNav={lastEditDueToNav}
            agentMode={agentMode}
            toggleAgentMode={toggleAgentMode}
            setAgentMode={setAgentMode}
            hasSlashSuggestions={hasSlashSuggestions}
            hasMentionSuggestions={hasMentionSuggestions}
            hasSuggestionMenu={hasSuggestionMenu}
            slashSuggestionItems={slashSuggestionItems}
            agentSuggestionItems={agentSuggestionItems}
            fileSuggestionItems={fileSuggestionItems}
            slashSelectedIndex={slashSelectedIndex}
            agentSelectedIndex={agentSelectedIndex}
            onSlashItemClick={handleSlashItemClick}
            onMentionItemClick={handleMentionItemClick}
            theme={theme}
            terminalHeight={terminalHeight}
            separatorWidth={separatorWidth}
            shouldCenterInputVertically={shouldCenterInputVertically}
            inputBoxTitle={inputBoxTitle}
            isCompactHeight={isCompactHeight}
            isNarrowWidth={isNarrowWidth}
            handleSubmit={handleSubmit}
            onPaste={createPasteHandler({
              text: inputValue,
              cursorPosition,
              onChange: setInputValue,
              onPasteImage: chatKeyboardHandlers.onPasteImage,
              onPasteImagePath: chatKeyboardHandlers.onPasteImagePath,
              onPasteLongText: (pastedText) => {
                const id = crypto.randomUUID()
                const preview = pastedText.slice(0, 100).replace(/\n/g, ' ')
                useChatStore.getState().addPendingTextAttachment({
                  id,
                  content: pastedText,
                  preview,
                  charCount: pastedText.length,
                })
                // Show temporary status message
                showClipboardMessage(
                  `📋 Pasted text (${pastedText.length.toLocaleString()} chars)`,
                  { durationMs: 5000 },
                )
              },
              cwd: getProjectRoot() ?? process.cwd(),
            })}
          />
        )}

        <BottomStatusLine
          isClaudeConnected={isClaudeOAuthActive}
          isClaudeActive={isClaudeActive}
          claudeQuota={claudeQuota}
          isHippoEnabled={hippoEnabled}
          isHippoBinaryInstalled={isHippoBinaryInstalled}
          isHippoActive={isSearchingMemory}
          hippoStats={hippoStats}
          hippoRecalls={hippoRecalls}
          hippoConnectionOk={hippoConnectionOk}
          hippoLastError={hippoLastError}
          isHippoRetrying={isHippoRetrying}
          onHippoRetry={handleHippoRetry}
          hippoLastUsedAt={hippoLastUsedAt}
        />
      </box>
    </box>
  )
}
