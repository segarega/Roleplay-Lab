import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  CloudDownload,
  Copy,
  Download,
  FolderOpen,
  History,
  Import,
  Layers3,
  MessageSquareText,
  Plus,
  Radio,
  Scale,
  Send,
  Square,
  Trash2,
  X
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  AppWorkspace,
  ChatEvent,
  ConversationMessage,
  FileImportRequest,
  GlobalReviewerConfig,
  MemoryConfig,
  ProviderModel,
  TestPaneConfig
} from '../../shared/types'
import {
  createDefaultWorkspace,
  DEFAULT_GLOBAL_REVIEW_PRIORITIES
} from '../../shared/defaults'
import {
  buildGlobalReviewerMessages,
  buildChatMessages,
  buildReviewerMessages,
  clonePane,
  collectGlobalReviewRounds,
  createId,
  createPane,
  effectiveReviewConnection,
  effectiveReviewParameters,
  findLatestExchange,
  globalReviewRoundLabel,
  highestComparisonRoundNumber,
  isConnectionReady,
  memoryLabel,
  orderedGlobalReviewCandidates,
  renderImportedCsv,
  resolveMemory,
  trimProviderError,
  type GlobalReviewRound
} from './lib/workspace'
import {
  ModelLane,
  type ModelLaneUiState
} from './components/ModelLane'

type ToastKind = 'info' | 'success' | 'error'

interface Toast {
  id: string
  message: string
  kind: ToastKind
}

interface ImportPreview {
  paneId: string
  kind: FileImportRequest['kind']
  fileName: string
  format: 'csv' | 'text'
  content: string
}

type BroadcastTarget = 'selected' | 'all-ready' | 'active'

type GlobalReviewStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled'
type GlobalReviewScope = 'one' | 'selected' | 'all'

interface GlobalReviewProvenance {
  modelId: string
  endpointOrigin: string
  priorities: string
  maxOutputTokens: number
}

interface GlobalReviewState {
  open: boolean
  scope: GlobalReviewScope
  selectedBatchIds: string[]
  requestId?: string
  status: GlobalReviewStatus
  text: string
  error?: string
  snapshots?: GlobalReviewRound[]
  provenance?: GlobalReviewProvenance
  generatedAt?: string
}

const DEFAULT_GLOBAL_REVIEW_STATE: GlobalReviewState = {
  open: false,
  scope: 'one',
  selectedBatchIds: [],
  status: 'idle',
  text: ''
}

const DEFAULT_PANE_UI: ModelLaneUiState = {
  tab: 'chat',
  setupSection: 'connection',
  draft: '',
  includeInBroadcast: true,
  models: [],
  modelLoading: false,
  reviewText: '',
  reviewRunning: false
}

function freshPaneUi(overrides: Partial<ModelLaneUiState> = {}): ModelLaneUiState {
  return { ...DEFAULT_PANE_UI, ...overrides }
}

function importLabel(kind: ImportPreview['kind']): string {
  if (kind === 'biography') return 'Character Profile'
  if (kind === 'scenario') return 'Scene Context'
  return 'System Prompt'
}

function globalReviewerReady(reviewer: GlobalReviewerConfig): boolean {
  const connection = reviewer.connection
  try {
    const url = new URL(connection.baseUrl)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(connection.modelId.trim())
    )
  } catch {
    return false
  }
}

function endpointOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl.trim()
  }
}

function reportFilePart(value: string): string {
  return (
    value
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 60) || 'Workspace'
  )
}

function reportTimestamp(value = new Date()): string {
  return value.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function comparableReviewRounds(rounds: GlobalReviewRound[]): GlobalReviewRound[] {
  return rounds.filter(
    (round) => round.candidates.length >= 2 && round.pendingPaneIds.length === 0
  )
}

function selectedReviewRounds(
  rounds: GlobalReviewRound[],
  scope: GlobalReviewScope,
  selectedBatchIds: string[]
): GlobalReviewRound[] {
  const eligible = comparableReviewRounds(rounds)
  const selected = new Set(selectedBatchIds)
  const result =
    scope === 'all'
      ? eligible
      : scope === 'one'
        ? [eligible.find((round) => selected.has(round.batchId)) ?? eligible[0]].filter(
            (round): round is GlobalReviewRound => Boolean(round)
          )
        : eligible.filter((round) => selected.has(round.batchId))

  return [...result].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.batchId.localeCompare(right.batchId)
  )
}

function reconcileInterruptedResponses(source: AppWorkspace): {
  workspace: AppWorkspace
  changed: boolean
} {
  let changed = false
  const panes = source.panes.map((pane) => ({
    ...pane,
    messages: pane.messages.map((message) => {
      if (!message.pending) return message
      changed = true
      return {
        ...message,
        pending: false,
        error:
          message.error ??
          'This response was interrupted when Roleplay Lab closed and was not added to model context.'
      }
    })
  }))

  return {
    workspace: changed
      ? { ...source, panes, updatedAt: new Date().toISOString() }
      : source,
    changed
  }
}

function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState<AppWorkspace | null>(null)
  const [paneUi, setPaneUi] = useState<Record<string, ModelLaneUiState>>({})
  const [broadcastDraft, setBroadcastDraft] = useState('')
  const [broadcastTarget, setBroadcastTarget] = useState<BroadcastTarget>('selected')
  const [saveState, setSaveState] = useState<'loading' | 'saved' | 'saving' | 'error'>(
    'loading'
  )
  const [toasts, setToasts] = useState<Toast[]>([])
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [secretsAvailable, setSecretsAvailable] = useState(true)
  const [globalReview, setGlobalReview] = useState<GlobalReviewState>(
    DEFAULT_GLOBAL_REVIEW_STATE
  )
  const [globalReviewerModels, setGlobalReviewerModels] = useState<ProviderModel[]>([])
  const [globalReviewerModelsLoading, setGlobalReviewerModelsLoading] = useState(false)
  const [clearAllConfirmationOpen, setClearAllConfirmationOpen] = useState(false)

  const workspaceRef = useRef<AppWorkspace | null>(null)
  const lastSavedWorkspaceRef = useRef<AppWorkspace | null>(null)
  const requestStartedAt = useRef(new Map<string, number>())
  const activeRequests = useRef(new Map<string, string>())
  const reviewRequests = useRef(new Map<string, string>())
  const globalReviewRequestId = useRef<string | undefined>(undefined)
  const roundCounter = useRef(0)

  useEffect(() => {
    workspaceRef.current = workspace
  }, [workspace])

  useEffect(
    () =>
      window.rpCompare.app.onBeforeClose(() => {
        const current = workspaceRef.current
        void (async () => {
          let saved = true
          try {
            if (current) {
              const snapshot = reconcileInterruptedResponses(current).workspace
              await window.rpCompare.workspace.save({
                ...snapshot,
                updatedAt: new Date().toISOString()
              })
            }
          } catch {
            saved = false
          } finally {
            window.rpCompare.app.readyToClose(saved)
          }
        })()
      }),
    []
  )

  const notify = useCallback((message: string, kind: ToastKind = 'info') => {
    const toast: Toast = { id: createId('toast'), message, kind }
    setToasts((current) => [...current, toast])
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== toast.id))
    }, 4200)
  }, [])

  const updatePaneUi = useCallback(
    (paneId: string, patch: Partial<ModelLaneUiState>) => {
      setPaneUi((current) => ({
        ...current,
        [paneId]: {
          ...freshPaneUi(),
          ...(current[paneId] ?? {}),
          ...patch
        }
      }))
    },
    []
  )

  const updatePane = useCallback((paneId: string, nextPane: TestPaneConfig) => {
    setWorkspace((current) => {
      if (!current) return current
      return {
        ...current,
        panes: current.panes.map((pane) => (pane.id === paneId ? nextPane : pane)),
        selectedPaneId: paneId,
        updatedAt: new Date().toISOString()
      }
    })
  }, [])

  useEffect(() => {
    let mounted = true

    const load = async (): Promise<void> => {
      try {
        const result = await window.rpCompare.workspace.load()
        if (!mounted) return
        const restored = result.workspace?.panes?.length
          ? result.workspace
          : createDefaultWorkspace()
        const { workspace: loaded, changed: repairedInterruptedResponse } =
          reconcileInterruptedResponses(restored)
        workspaceRef.current = loaded
        lastSavedWorkspaceRef.current = repairedInterruptedResponse
          ? result.workspace ?? null
          : loaded
        roundCounter.current = highestComparisonRoundNumber(loaded.panes)
        setWorkspace(loaded)
        setSecretsAvailable(result.secretsAvailable)
        setPaneUi(
          Object.fromEntries(loaded.panes.map((pane) => [pane.id, freshPaneUi()]))
        )
        setSaveState('saved')
        await window.rpCompare.logs.setEnabled(loaded.settings.loggingEnabled)
        if (result.warnings.length) notify(result.warnings[0], 'info')
      } catch (error) {
        if (!mounted) return
        const fallback = createDefaultWorkspace()
        workspaceRef.current = fallback
        lastSavedWorkspaceRef.current = fallback
        roundCounter.current = highestComparisonRoundNumber(fallback.panes)
        setWorkspace(fallback)
        setPaneUi(
          Object.fromEntries(fallback.panes.map((pane) => [pane.id, freshPaneUi()]))
        )
        setSaveState('error')
        notify(
          `Could not restore the last workspace. A new one was opened. ${error instanceof Error ? error.message : ''}`,
          'error'
        )
      }
    }

    void load()
    return () => {
      mounted = false
    }
  }, [notify])

  useEffect(() => {
    if (!workspace || saveState === 'loading') return
    if (workspace === lastSavedWorkspaceRef.current) return

    setSaveState('saving')
    const timer = window.setTimeout(async () => {
      try {
        const submitted = workspace
        const result = await window.rpCompare.workspace.save({
          ...submitted,
          updatedAt: new Date().toISOString()
        })
        lastSavedWorkspaceRef.current = result.workspace
        setSecretsAvailable(result.secretsPersisted || secretsAvailable)
        setWorkspace((current) => {
          if (!current) return current
          if (current !== submitted) return current
          workspaceRef.current = result.workspace
          return result.workspace
        })
        setSaveState('saved')
        if (result.warnings.length) notify(result.warnings[0], 'info')
      } catch (error) {
        setSaveState('error')
        notify(
          `Autosave failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'error'
        )
      }
    }, 850)

    return () => window.clearTimeout(timer)
  }, [workspace, notify, secretsAvailable])

  useEffect(() => {
    const unsubscribe = window.rpCompare.chat.onEvent((event: ChatEvent) => {
      if (globalReviewRequestId.current === event.requestId) {
        if (event.type === 'delta') {
          setGlobalReview((current) => ({
            ...current,
            status: 'running',
            text: event.text,
            error: undefined
          }))
          return
        }

        globalReviewRequestId.current = undefined
        requestStartedAt.current.delete(event.requestId)
        if (event.type === 'done') {
          setGlobalReview((current) => ({
            ...current,
            requestId: undefined,
            status: 'done',
            text: event.text,
            error: undefined,
            generatedAt: new Date().toISOString()
          }))
          notify('Global comparison review completed.', 'success')
          return
        }
        if (event.type === 'error') {
          const message = trimProviderError(event.error.message)
          setGlobalReview((current) => ({
            ...current,
            requestId: undefined,
            status: 'error',
            text: event.text,
            error: message
          }))
          notify(`Global review failed: ${message}`, 'error')
          return
        }
        setGlobalReview((current) => ({
          ...current,
          requestId: undefined,
          status: 'cancelled',
          text: event.text,
          error: 'Global review cancelled. Any partial report is preserved.'
        }))
        notify('Global comparison review cancelled.', 'info')
        return
      }

      const reviewPaneId = reviewRequests.current.get(event.requestId)
      if (reviewPaneId) {
        if (event.type === 'delta') {
          updatePaneUi(reviewPaneId, { reviewText: event.text, reviewRunning: true })
          return
        }
        if (event.type === 'done') {
          reviewRequests.current.delete(event.requestId)
          activeRequests.current.delete(reviewPaneId)
          updatePaneUi(reviewPaneId, {
            reviewText: event.text,
            reviewRunning: false,
            reviewRequestId: undefined,
            reviewError: undefined
          })
          notify('Prompt Review completed.', 'success')
          return
        }
        if (event.type === 'error') {
          reviewRequests.current.delete(event.requestId)
          activeRequests.current.delete(reviewPaneId)
          updatePaneUi(reviewPaneId, {
            reviewText: event.text,
            reviewRunning: false,
            reviewRequestId: undefined,
            reviewError: event.error.message
          })
          notify(`Prompt Review failed: ${trimProviderError(event.error.message)}`, 'error')
          return
        }
        reviewRequests.current.delete(event.requestId)
        activeRequests.current.delete(reviewPaneId)
        updatePaneUi(reviewPaneId, {
          reviewText: event.text,
          reviewRunning: false,
          reviewRequestId: undefined,
          reviewError: 'Review cancelled.'
        })
        return
      }

      const assistantId = `assistant-${event.requestId}`
      const finished = event.type === 'done' || event.type === 'error' || event.type === 'cancelled'
      const latencyMs = finished
        ? Math.max(0, Date.now() - (requestStartedAt.current.get(event.requestId) ?? Date.now()))
        : undefined

      setWorkspace((current) => {
        if (!current) return current
        return {
          ...current,
          panes: current.panes.map((pane) => {
            if (pane.id !== event.paneId) return pane
            return {
              ...pane,
              messages: pane.messages.map((message) => {
                if (message.id !== assistantId) return message
                if (event.type === 'delta') {
                  return { ...message, content: event.text, pending: true }
                }
                if (event.type === 'done') {
                  return {
                    ...message,
                    content: event.text,
                    pending: false,
                    finishReason: event.finishReason,
                    usage: event.usage,
                    latencyMs,
                    error: undefined
                  }
                }
                if (event.type === 'error') {
                  return {
                    ...message,
                    content: event.text,
                    pending: false,
                    latencyMs,
                    error: event.error.message
                  }
                }
                return {
                  ...message,
                  content: event.text,
                  pending: false,
                  latencyMs,
                  error: 'Request cancelled.'
                }
              })
            }
          }),
          updatedAt: new Date().toISOString()
        }
      })

      if (finished) {
        activeRequests.current.delete(event.paneId)
        requestStartedAt.current.delete(event.requestId)
        updatePaneUi(event.paneId, { activeRequestId: undefined })
      }
    })

    return unsubscribe
  }, [notify, updatePaneUi])

  const sendToPane = useCallback(
    async (paneId: string, rawText: string, batchId?: string): Promise<boolean> => {
      const current = workspaceRef.current
      const pane = current?.panes.find((item) => item.id === paneId)
      const text = rawText.trim()
      if (!current || !pane || !text) return false

      if (activeRequests.current.has(paneId)) {
        notify(`${pane.name} is already generating.`, 'info')
        return false
      }

      if (!isConnectionReady(pane)) {
        updatePaneUi(paneId, { tab: 'setup', setupSection: 'connection' })
        notify(`Configure a valid Base URL and model for ${pane.name}.`, 'error')
        return false
      }

      const requestId = createId('chat')
      const now = new Date().toISOString()
      const requestMessages = buildChatMessages(pane, current.globalMemory, text)
      const renderedSystemPrompt =
        requestMessages.find((message) => message.role === 'system')?.content ?? ''
      const renderedUserMessage =
        [...requestMessages].reverse().find((message) => message.role === 'user')
          ?.content ?? text
      const userMessage: ConversationMessage = {
        id: createId('user'),
        role: 'user',
        content: text,
        createdAt: now,
        requestId,
        batchId
      }
      const assistantMessage: ConversationMessage = {
        id: `assistant-${requestId}`,
        role: 'assistant',
        content: '',
        createdAt: now,
        pending: true,
        requestId,
        batchId,
        contextLabel: memoryLabel(resolveMemory(pane, current.globalMemory)),
        comparisonSnapshot: batchId
          ? {
              laneName: pane.name,
              modelId: pane.connection.modelId,
              renderedSystemPrompt,
              renderedUserMessage
            }
          : undefined
      }

      activeRequests.current.set(paneId, requestId)
      requestStartedAt.current.set(requestId, Date.now())
      updatePaneUi(paneId, { activeRequestId: requestId, draft: '', tab: 'chat' })
      setWorkspace((state) => {
        if (!state) return state
        return {
          ...state,
          panes: state.panes.map((item) =>
            item.id === paneId
              ? { ...item, messages: [...item.messages, userMessage, assistantMessage] }
              : item
          ),
          selectedPaneId: paneId,
          updatedAt: now
        }
      })

      try {
        await window.rpCompare.chat.start({
          requestId,
          paneId,
          batchId,
          connection: pane.connection,
          parameters: pane.parameters,
          messages: requestMessages,
          logLabel: pane.name
        })
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The request could not start.'
        activeRequests.current.delete(paneId)
        requestStartedAt.current.delete(requestId)
        updatePaneUi(paneId, { activeRequestId: undefined })
        setWorkspace((state) => {
          if (!state) return state
          return {
            ...state,
            panes: state.panes.map((item) =>
              item.id === paneId
                ? {
                    ...item,
                    messages: item.messages.map((chatMessage) =>
                      chatMessage.id === `assistant-${requestId}`
                        ? { ...chatMessage, pending: false, error: message }
                        : chatMessage
                    )
                  }
                : item
            )
          }
        })
        notify(`Could not start ${pane.name}: ${trimProviderError(message)}`, 'error')
        return false
      }
    },
    [notify, updatePaneUi]
  )

  const stopPane = useCallback(
    async (paneId: string): Promise<void> => {
      const requestId = activeRequests.current.get(paneId)
      if (!requestId) return
      try {
        await window.rpCompare.chat.cancel({ requestId })
      } catch (error) {
        notify(
          `Could not cancel request: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'error'
        )
      }
    },
    [notify]
  )

  const runReview = useCallback(
    async (paneId: string): Promise<void> => {
      const current = workspaceRef.current
      const pane = current?.panes.find((item) => item.id === paneId)
      if (!pane || !current) return

      if (activeRequests.current.has(paneId)) {
        notify(`Wait for ${pane.name} to finish before running Prompt Review.`, 'info')
        return
      }

      const exchange = findLatestExchange(pane.messages)
      if (!exchange) {
        notify('Prompt Review needs a completed user/model exchange first.', 'info')
        return
      }

      const connection = effectiveReviewConnection(pane)
      if (!connection.baseUrl.trim() || !connection.modelId.trim()) {
        updatePaneUi(paneId, { tab: 'review' })
        notify('Configure the Reviewer Model before analyzing.', 'error')
        return
      }

      const requestId = createId('review')
      activeRequests.current.set(paneId, requestId)
      reviewRequests.current.set(requestId, paneId)
      requestStartedAt.current.set(requestId, Date.now())
      updatePaneUi(paneId, {
        tab: 'review',
        reviewRunning: true,
        reviewRequestId: requestId,
        reviewText: '',
        reviewError: undefined
      })

      try {
        await window.rpCompare.chat.start({
          requestId,
          paneId,
          connection,
          parameters: effectiveReviewParameters(pane),
          messages: buildReviewerMessages(pane, exchange.user.content, exchange.assistant.content),
          logLabel: `${pane.name} · Prompt Review`
        })
      } catch (error) {
        activeRequests.current.delete(paneId)
        reviewRequests.current.delete(requestId)
        const message = error instanceof Error ? error.message : 'Review could not start.'
        updatePaneUi(paneId, {
          reviewRunning: false,
          reviewRequestId: undefined,
          reviewError: message
        })
        notify(`Prompt Review could not start: ${trimProviderError(message)}`, 'error')
      }
    },
    [notify, updatePaneUi]
  )

  const updateGlobalReviewer = useCallback(
    (updater: (reviewer: GlobalReviewerConfig) => GlobalReviewerConfig) => {
      setWorkspace((current) => {
        if (!current) return current
        const globalReviewer = updater(current.globalReviewer)
        if (globalReviewer === current.globalReviewer) return current
        return {
          ...current,
          globalReviewer,
          updatedAt: new Date().toISOString()
        }
      })
    },
    []
  )

  const fetchGlobalReviewerModels = useCallback(async (): Promise<void> => {
    const reviewer = workspaceRef.current?.globalReviewer
    if (!reviewer?.connection.baseUrl.trim()) {
      notify('Enter the dedicated reviewer Base URL before loading models.', 'error')
      return
    }
    setGlobalReviewerModelsLoading(true)
    try {
      const result = await window.rpCompare.models.list(reviewer.connection)
      setGlobalReviewerModels(result.models)
      notify(`Loaded ${result.models.length} reviewer model${result.models.length === 1 ? '' : 's'}.`, 'success')
    } catch (error) {
      notify(
        `Could not load reviewer models: ${
          error instanceof Error ? trimProviderError(error.message) : 'Unknown error'
        }`,
        'error'
      )
    } finally {
      setGlobalReviewerModelsLoading(false)
    }
  }, [notify])

  const openGlobalReview = useCallback(() => {
    const current = workspaceRef.current
    if (!current) return
    const eligible = comparableReviewRounds(collectGlobalReviewRounds(current.panes))
    const eligibleIds = new Set(eligible.map((round) => round.batchId))

    setGlobalReview((previous) => {
      const retained = previous.selectedBatchIds.filter((batchId) =>
        eligibleIds.has(batchId)
      )
      return {
        ...previous,
        open: true,
        selectedBatchIds:
          retained.length > 0 ? retained : eligible[0] ? [eligible[0].batchId] : []
      }
    })
  }, [])

  const runGlobalReview = useCallback(async (): Promise<void> => {
    const current = workspaceRef.current
    if (!current || globalReviewRequestId.current) return
    if (activeRequests.current.size) {
      notify('Wait for all lane generations and reviews to finish before comparing.', 'info')
      return
    }

    const rounds = selectedReviewRounds(
      collectGlobalReviewRounds(current.panes),
      globalReview.scope,
      globalReview.selectedBatchIds
    )
    if (!rounds.length) {
      notify('Select at least one settled round with two completed responses.', 'info')
      return
    }
    const distinctPaneIds = new Set(
      rounds.flatMap((round) => round.candidates.map((candidate) => candidate.paneId))
    )
    if (distinctPaneIds.size < 2) {
      notify('The selected rounds need completed responses from at least two Model Lanes.', 'info')
      return
    }

    const reviewer = current.globalReviewer
    if (!globalReviewerReady(reviewer)) {
      notify('Configure the dedicated reviewer Base URL and model before comparing.', 'error')
      return
    }

    const requestId = createId('global-review')
    const reviewerForRun: GlobalReviewerConfig = {
      ...reviewer,
      priorities: reviewer.priorities.trim() || DEFAULT_GLOBAL_REVIEW_PRIORITIES
    }
    globalReviewRequestId.current = requestId
    requestStartedAt.current.set(requestId, Date.now())
    const snapshots = structuredClone(rounds)
    const provenance: GlobalReviewProvenance = {
      modelId: reviewerForRun.connection.modelId,
      endpointOrigin: endpointOrigin(reviewerForRun.connection.baseUrl),
      priorities: reviewerForRun.priorities,
      maxOutputTokens: reviewerForRun.parameters.maxOutputTokens
    }
    setGlobalReview((previous) => ({
      ...previous,
      open: true,
      requestId,
      status: 'running',
      text: '',
      error: undefined,
      snapshots,
      provenance,
      generatedAt: undefined
    }))

    try {
      await window.rpCompare.chat.start({
        requestId,
        paneId: 'global-review',
        batchId: snapshots.length === 1 ? snapshots[0].batchId : undefined,
        connection: reviewerForRun.connection,
        parameters: reviewerForRun.parameters,
        messages: buildGlobalReviewerMessages(
          reviewerForRun,
          snapshots,
          globalReview.scope
        ),
        logLabel:
          snapshots.length === 1
            ? `Global Compare & Review · ${globalReviewRoundLabel(snapshots[0])}`
            : `Global Compare & Review · ${snapshots.length} rounds`
      })
    } catch (error) {
      globalReviewRequestId.current = undefined
      requestStartedAt.current.delete(requestId)
      const message =
        error instanceof Error ? trimProviderError(error.message) : 'Global review could not start.'
      setGlobalReview((previous) => ({
        ...previous,
        requestId: undefined,
        status: 'error',
        error: message
      }))
      notify(`Global review could not start: ${message}`, 'error')
    }
  }, [
    globalReview.scope,
    globalReview.selectedBatchIds,
    notify
  ])

  const stopGlobalReview = useCallback(async (): Promise<void> => {
    const requestId = globalReviewRequestId.current
    if (!requestId) return
    try {
      await window.rpCompare.chat.cancel({ requestId })
    } catch (error) {
      notify(
        `Could not cancel global review: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
        'error'
      )
    }
  }, [notify])

  const copyGlobalReview = useCallback(async (): Promise<void> => {
    if (!globalReview.text) return
    try {
      await navigator.clipboard.writeText(globalReview.text)
      notify('Global comparison report copied.', 'success')
    } catch {
      notify('Clipboard access was unavailable.', 'error')
    }
  }, [globalReview.text, notify])

  const exportGlobalReview = useCallback(async (): Promise<void> => {
    if (!workspace || !globalReview.text || globalReview.status === 'running') return
    const snapshots = globalReview.snapshots ?? []
    const reviewedModels = new Map<string, { paneName: string; modelId: string }>()
    for (const round of snapshots) {
      for (const candidate of orderedGlobalReviewCandidates(round)) {
        const key = `${candidate.paneId}\u0000${candidate.modelId}`
        reviewedModels.set(key, {
          paneName: candidate.paneName,
          modelId: candidate.modelId
        })
      }
    }
    const complete = globalReview.status === 'done'
    const generated = globalReview.generatedAt ?? new Date().toISOString()
    const reviewScope =
      snapshots.length === 1
        ? globalReviewRoundLabel(snapshots[0])
        : `${snapshots.length} rounds`
    const content = [
      '# Roleplay Lab — Compare & Review',
      '',
      `- Workspace: ${workspace.name}`,
      `- Report status: ${complete ? 'Complete' : 'Partial'}`,
      `- Generated: ${generated}`,
      `- Review scope: ${reviewScope}`,
      `- Dedicated reviewer: ${globalReview.provenance?.modelId || 'Unknown model'}`,
      `- Reviewer endpoint: ${globalReview.provenance?.endpointOrigin || 'Unknown endpoint'}`,
      `- Output budget: ${globalReview.provenance?.maxOutputTokens ?? 0} tokens`,
      '',
      '## Reviewed lanes and models',
      '',
      ...(reviewedModels.size
        ? [...reviewedModels.values()].map(
            ({ paneName, modelId }) => `- ${paneName} — ${modelId || 'model ID unavailable'}`
          )
        : ['- Historical lane/model metadata unavailable']),
      '',
      '## Rounds included',
      '',
      ...(snapshots.length
        ? snapshots.map(
            (round) =>
              `- ${globalReviewRoundLabel(round)} — ${round.candidates.length} completed responses`
          )
        : ['- Snapshot metadata unavailable']),
      '',
      '## Evaluation priorities',
      '',
      globalReview.provenance?.priorities || DEFAULT_GLOBAL_REVIEW_PRIORITIES,
      '',
      '## Generated Report',
      '',
      globalReview.text
    ].join('\n')
    const scopePart = snapshots.length === 1 ? 'One-Round' : `${snapshots.length}-Rounds`
    try {
      const result = await window.rpCompare.files.exportReport({
        suggestedFileName: `Roleplay-Lab-${reportFilePart(workspace.name)}-${scopePart}-Review-${reportTimestamp()}.txt`,
        content
      })
      if (!result.cancelled) {
        notify('Comparison review exported as a Markdown-formatted text file.', 'success')
      }
    } catch (error) {
      notify(
        `Could not export the review: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
        'error'
      )
    }
  }, [globalReview, notify, workspace])

  const addLane = useCallback(() => {
    setWorkspace((current) => {
      if (!current) return current
      const pane = createPane(current.panes.length)
      setPaneUi((ui) => ({ ...ui, [pane.id]: freshPaneUi({ tab: 'setup' }) }))
      window.setTimeout(() => {
        document.querySelector(`[data-pane-id="${pane.id}"]`)?.scrollIntoView({
          behavior: 'smooth',
          inline: 'center',
          block: 'nearest'
        })
      }, 50)
      return {
        ...current,
        panes: [...current.panes, pane],
        selectedPaneId: pane.id,
        updatedAt: new Date().toISOString()
      }
    })
  }, [])

  const duplicateLane = useCallback(
    (paneId: string, direction: 'left' | 'right') => {
      setWorkspace((current) => {
        if (!current) return current
        const index = current.panes.findIndex((pane) => pane.id === paneId)
        if (index < 0) return current
        const source = current.panes[index]
        const copy = clonePane(source, `${source.name} · Copy`)
        const insertionIndex = direction === 'left' ? index : index + 1
        const panes = [...current.panes]
        panes.splice(insertionIndex, 0, copy)
        setPaneUi((ui) => ({ ...ui, [copy.id]: freshPaneUi() }))
        window.setTimeout(() => {
          document.querySelector(`[data-pane-id="${copy.id}"]`)?.scrollIntoView({
            behavior: 'smooth',
            inline: 'center',
            block: 'nearest'
          })
        }, 50)
        notify(`Duplicated ${source.name} with a fresh transcript.`, 'success')
        return {
          ...current,
          panes,
          selectedPaneId: copy.id,
          updatedAt: new Date().toISOString()
        }
      })
    },
    [notify]
  )

  const moveLane = useCallback((paneId: string, direction: 'left' | 'right') => {
    setWorkspace((current) => {
      if (!current) return current
      const from = current.panes.findIndex((pane) => pane.id === paneId)
      const to = direction === 'left' ? from - 1 : from + 1
      if (from < 0 || to < 0 || to >= current.panes.length) return current
      const panes = [...current.panes]
      const [pane] = panes.splice(from, 1)
      panes.splice(to, 0, pane)
      return { ...current, panes, updatedAt: new Date().toISOString() }
    })
  }, [])

  const removeLane = useCallback(
    (paneId: string) => {
      const current = workspaceRef.current
      const pane = current?.panes.find((item) => item.id === paneId)
      if (!current || !pane) return
      if (current.panes.length === 1) {
        notify('A workspace always keeps at least one Model Lane.', 'info')
        return
      }
      if (globalReviewRequestId.current) {
        notify('Stop the global comparison review before closing a lane.', 'info')
        return
      }
      if (activeRequests.current.has(paneId)) {
        notify(`Stop ${pane.name} before closing its lane.`, 'info')
        return
      }
      setWorkspace((state) => {
        if (!state) return state
        const panes = state.panes.filter((item) => item.id !== paneId)
        return {
          ...state,
          panes,
          selectedPaneId:
            state.selectedPaneId === paneId ? panes[0]?.id ?? '' : state.selectedPaneId,
          updatedAt: new Date().toISOString()
        }
      })
      setPaneUi((ui) => {
        const next = { ...ui }
        delete next[paneId]
        return next
      })
    },
    [notify]
  )

  const clearLane = useCallback(
    (paneId: string) => {
      const current = workspaceRef.current
      const pane = current?.panes.find((item) => item.id === paneId)
      if (!pane?.messages.length) return
      if (globalReviewRequestId.current) {
        notify('Stop the global comparison review before clearing a conversation.', 'info')
        return
      }
      if (activeRequests.current.has(paneId)) {
        notify(`Stop ${pane.name} before clearing its conversation.`, 'info')
        return
      }
      setWorkspace((state) => {
        if (!state) return state
        const next = {
          ...state,
          panes: state.panes.map((item) =>
            item.id === paneId ? { ...item, messages: [] } : item
          ),
          selectedPaneId: paneId,
          updatedAt: new Date().toISOString()
        }
        workspaceRef.current = next
        return next
      })
      updatePaneUi(paneId, { reviewText: '', reviewError: undefined })
      setGlobalReview((previous) => ({
        ...previous,
        status: 'idle',
        text: '',
        error: undefined,
        snapshots: undefined,
        provenance: undefined,
        generatedAt: undefined,
        selectedBatchIds: []
      }))
      notify(`Cleared ${pane.name}.`, 'success')
    },
    [notify, updatePaneUi]
  )

  const deleteMessage = useCallback(
    (paneId: string, messageId: string) => {
      const current = workspaceRef.current
      const pane = current?.panes.find((item) => item.id === paneId)
      const message = pane?.messages.find((item) => item.id === messageId)
      if (!pane || !message) return

      if (globalReviewRequestId.current) {
        notify('Stop the global comparison review before deleting transcript messages.', 'info')
        return
      }
      const activeRequestId = activeRequests.current.get(paneId)
      if (activeRequestId) {
        notify(`Stop ${pane.name} before deleting transcript messages.`, 'info')
        return
      }

      setWorkspace((state) => {
        if (!state) return state
        const next = {
          ...state,
          panes: state.panes.map((item) =>
            item.id === paneId
              ? {
                  ...item,
                  messages: item.messages.filter(
                    (conversationMessage) => conversationMessage.id !== messageId
                  )
                }
              : item
          ),
          selectedPaneId: paneId,
          updatedAt: new Date().toISOString()
        }
        workspaceRef.current = next
        return next
      })
      updatePaneUi(paneId, { reviewText: '', reviewError: undefined })
      setGlobalReview((previous) => ({
        ...previous,
        status: 'idle',
        text: '',
        error: undefined,
        snapshots: undefined,
        provenance: undefined,
        generatedAt: undefined,
        selectedBatchIds: []
      }))
      notify(
        `${message.role === 'user' ? 'Message' : 'Response'} deleted from ${pane.name} and future context.`,
        'success'
      )
    },
    [notify, updatePaneUi]
  )

  const clearAllConversations = useCallback(() => {
    const current = workspaceRef.current
    if (!current) return
    const affectedPanes = current.panes.filter((pane) => pane.messages.length)
    if (!affectedPanes.length) {
      notify('All conversations are already clear.', 'info')
      return
    }
    if (activeRequests.current.size || globalReviewRequestId.current) {
      notify('Stop all active generations and reviews before clearing conversations.', 'info')
      return
    }
    setClearAllConfirmationOpen(true)
  }, [notify])

  const confirmClearAllConversations = useCallback(() => {
    const current = workspaceRef.current
    if (!current) return
    const affectedPanes = current.panes.filter((pane) => pane.messages.length)
    if (!affectedPanes.length) {
      setClearAllConfirmationOpen(false)
      return
    }
    if (activeRequests.current.size || globalReviewRequestId.current) {
      setClearAllConfirmationOpen(false)
      notify('Stop all active generations and reviews before clearing conversations.', 'info')
      return
    }

    const now = new Date().toISOString()
    setWorkspace((state) => {
      if (!state) return state
      const next = {
        ...state,
        panes: state.panes.map((pane) =>
          pane.messages.length ? { ...pane, messages: [] } : pane
        ),
        updatedAt: now
      }
      workspaceRef.current = next
      return next
    })
    setPaneUi((currentUi) =>
      Object.fromEntries(
        Object.entries(currentUi).map(([paneId, ui]) => [
          paneId,
          { ...ui, reviewText: '', reviewError: undefined }
        ])
      )
    )
    roundCounter.current = 0
    setClearAllConfirmationOpen(false)
    setGlobalReview({
      ...DEFAULT_GLOBAL_REVIEW_STATE,
      open: globalReview.open
    })
    notify(
      `Cleared all conversations across ${affectedPanes.length} Model Lane${affectedPanes.length === 1 ? '' : 's'}. The next comparison starts at Round 1.`,
      'success'
    )
  }, [globalReview.open, notify])

  const fetchModels = useCallback(
    async (paneId: string): Promise<void> => {
      const pane = workspaceRef.current?.panes.find((item) => item.id === paneId)
      if (!pane) return
      if (!pane.connection.baseUrl.trim()) {
        notify('Enter an API Base URL before loading models.', 'error')
        return
      }
      updatePaneUi(paneId, {
        modelLoading: true,
        connectionFeedback: { kind: 'info', message: 'Loading available models…' }
      })
      try {
        const result = await window.rpCompare.models.list(pane.connection)
        updatePaneUi(paneId, {
          modelLoading: false,
          models: result.models,
          connectionFeedback: {
            kind: 'success',
            message: `Found ${result.models.length} model${result.models.length === 1 ? '' : 's'}.`
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Model listing failed.'
        updatePaneUi(paneId, {
          modelLoading: false,
          connectionFeedback: { kind: 'error', message: trimProviderError(message) }
        })
        notify(
          'This endpoint may not support /models. You can still enter the model ID manually.',
          'info'
        )
      }
    },
    [notify, updatePaneUi]
  )

  const importText = useCallback(
    async (paneId: string, kind: FileImportRequest['kind']): Promise<void> => {
      try {
        const result = await window.rpCompare.files.importText({ kind })
        if (result.cancelled) return
        const rendered =
          result.format === 'csv' && result.rows?.length
            ? renderImportedCsv(result.rows)
            : (result.content ?? '')
        if (!rendered.trim()) {
          notify('The selected file did not contain importable text.', 'error')
          return
        }
        setImportPreview({
          paneId,
          kind,
          fileName: result.fileName ?? 'Imported file',
          format: result.format ?? 'text',
          content: rendered
        })
      } catch (error) {
        notify(
          `Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'error'
        )
      }
    },
    [notify]
  )

  const applyImport = useCallback(
    (mode: 'replace' | 'append') => {
      if (!importPreview) return
      const pane = workspaceRef.current?.panes.find((item) => item.id === importPreview.paneId)
      if (!pane) return
      const roleplay = { ...pane.roleplay }
      const target =
        importPreview.kind === 'biography'
          ? 'npcBiography'
          : importPreview.kind === 'scenario'
            ? 'scenario'
            : 'systemPrompt'
      const previous = roleplay[target]
      roleplay[target] =
        mode === 'append' && previous.trim()
          ? `${previous.trim()}\n\n${importPreview.content.trim()}`
          : importPreview.content.trim()
      if (target === 'npcBiography') roleplay.npcBiographySource = importPreview.fileName
      if (target === 'scenario') roleplay.scenarioSource = importPreview.fileName
      updatePane(pane.id, { ...pane, roleplay })
      notify(
        `${importLabel(importPreview.kind)} imported from ${importPreview.fileName}.`,
        'success'
      )
      setImportPreview(null)
    },
    [importPreview, notify, updatePane]
  )

  const toggleLogging = useCallback(
    async (enabled: boolean) => {
      if (!workspaceRef.current) return
      try {
        await window.rpCompare.logs.setEnabled(enabled)
        setWorkspace((current) =>
          current
            ? {
                ...current,
                settings: { ...current.settings, loggingEnabled: enabled },
                updatedAt: new Date().toISOString()
              }
            : current
        )
        notify(enabled ? 'Session recording is on.' : 'Session recording is off.', 'success')
      } catch (error) {
        notify(
          `Could not change recording: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'error'
        )
      }
    },
    [notify]
  )

  const exportWorkspace = useCallback(async () => {
    const current = workspaceRef.current
    if (!current) return
    try {
      const result = await window.rpCompare.workspace.export(current)
      if (!result.cancelled) notify('Workspace exported without API keys.', 'success')
    } catch (error) {
      notify(
        `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      )
    }
  }, [notify])

  const importWorkspace = useCallback(async () => {
    try {
      const result = await window.rpCompare.workspace.import()
      if (result.cancelled || !result.workspace) return
      if ([...activeRequests.current].length || globalReviewRequestId.current) {
        notify('Stop active requests before importing a workspace.', 'info')
        return
      }
      setWorkspace(result.workspace)
      workspaceRef.current = result.workspace
      roundCounter.current = highestComparisonRoundNumber(result.workspace.panes)
      setPaneUi(
        Object.fromEntries(result.workspace.panes.map((pane) => [pane.id, freshPaneUi()]))
      )
      setGlobalReview(DEFAULT_GLOBAL_REVIEW_STATE)
      notify('Workspace imported. API keys were intentionally not included.', 'success')
      if (result.warnings.length) notify(result.warnings[0], 'info')
    } catch (error) {
      notify(
        `Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      )
    }
  }, [notify])

  const changeGlobalMemory = useCallback((mode: MemoryConfig['mode']) => {
    setWorkspace((current) =>
      current
        ? {
            ...current,
            globalMemory: { ...current.globalMemory, mode },
            updatedAt: new Date().toISOString()
          }
        : current
    )
  }, [])

  const globalReviewRounds = useMemo(
    () =>
      globalReview.open && workspace ? collectGlobalReviewRounds(workspace.panes) : [],
    [globalReview.open, workspace?.panes]
  )
  const eligibleGlobalReviewRounds = useMemo(
    () => comparableReviewRounds(globalReviewRounds),
    [globalReviewRounds]
  )
  const selectedGlobalRounds = useMemo(
    () =>
      selectedReviewRounds(
        globalReviewRounds,
        globalReview.scope,
        globalReview.selectedBatchIds
      ),
    [globalReview.scope, globalReview.selectedBatchIds, globalReviewRounds]
  )
  const selectedGlobalCandidates = useMemo(
    () =>
      selectedGlobalRounds.flatMap((round) =>
        orderedGlobalReviewCandidates(round)
      ),
    [selectedGlobalRounds]
  )
  const selectedGlobalLaneModels = useMemo(() => {
    const result = new Map<string, (typeof selectedGlobalCandidates)[number]>()
    for (const candidate of selectedGlobalCandidates) {
      result.set(`${candidate.paneId}\u0000${candidate.modelId}`, candidate)
    }
    return [...result.values()]
  }, [selectedGlobalCandidates])
  const selectedDistinctPaneCount = new Set(
    selectedGlobalCandidates.map((candidate) => candidate.paneId)
  ).size
  const selectedReviewerConnection = workspace?.globalReviewer.connection
  const selectedReviewerOrigin = endpointOrigin(selectedReviewerConnection?.baseUrl ?? '')
  const reviewerIsCandidate = Boolean(
    selectedReviewerConnection &&
      selectedGlobalCandidates.some(
        (candidate) =>
          candidate.endpointOrigin === selectedReviewerOrigin &&
          candidate.modelId.trim().toLowerCase() ===
            selectedReviewerConnection.modelId.trim().toLowerCase()
      )
  )
  const selectedReviewerOutputBudget =
    workspace?.globalReviewer.parameters.maxOutputTokens ?? 0
  const recommendedReviewOutputBudget = selectedGlobalCandidates.length
    ? Math.min(
        8_000,
        1_800 + selectedGlobalCandidates.length * 280 + selectedGlobalRounds.length * 300
      )
    : 0
  const estimatedReviewCharacters = selectedGlobalRounds.reduce(
    (total, round) =>
      total +
      round.rawRequest.length +
      round.candidates.reduce(
        (candidateTotal, candidate) =>
          candidateTotal +
          candidate.renderedSystem.length +
          candidate.renderedUserMessage.length +
          candidate.assistantMessage.length +
          candidate.recentDialogueContext.reduce(
            (contextTotal, message) => contextTotal + message.content.length,
            0
          ),
        0
      ),
    0
  )
  const estimatedReviewTokens = Math.ceil(estimatedReviewCharacters / 4)
  const broadcastCandidates = useMemo(() => {
    if (!workspace) return []
    if (broadcastTarget === 'active') {
      return workspace.panes.filter((pane) => pane.id === workspace.selectedPaneId)
    }
    if (broadcastTarget === 'selected') {
      return workspace.panes.filter((pane) => paneUi[pane.id]?.includeInBroadcast !== false)
    }
    return workspace.panes
  }, [broadcastTarget, paneUi, workspace])

  const readyBroadcastCount = useMemo(
    () =>
      broadcastCandidates.filter(
        (pane) => isConnectionReady(pane) && !activeRequests.current.has(pane.id)
      ).length,
    [broadcastCandidates, paneUi]
  )

  const sendBroadcast = useCallback(() => {
    const text = broadcastDraft.trim()
    if (!text) return
    const targets = broadcastCandidates.filter(
      (pane) => isConnectionReady(pane) && !activeRequests.current.has(pane.id)
    )
    const skipped = broadcastCandidates.length - targets.length
    if (!targets.length) {
      notify('No ready Model Lanes match the current broadcast target.', 'error')
      return
    }
    roundCounter.current =
      Math.max(
        roundCounter.current,
        highestComparisonRoundNumber(workspaceRef.current?.panes ?? [])
      ) + 1
    const roundNumber = roundCounter.current
    const batchId = `round-${roundNumber}-${createId('batch')}`
    setBroadcastDraft('')
    for (const pane of targets) void sendToPane(pane.id, text, batchId)
    notify(
      `Comparison Round ${roundNumber} sent to ${targets.length} lane${targets.length === 1 ? '' : 's'}${skipped ? `; ${skipped} skipped` : ''}.`,
      'success'
    )
  }, [broadcastCandidates, broadcastDraft, notify, sendToPane])

  const stopAll = useCallback(() => {
    for (const paneId of activeRequests.current.keys()) void stopPane(paneId)
    if (globalReviewRequestId.current) void stopGlobalReview()
  }, [stopGlobalReview, stopPane])

  if (!workspace) {
    return (
      <div className="loading-screen">
        <div className="loading-card">
          <div className="spinner" />
          Restoring your comparison workspace…
        </div>
      </div>
    )
  }

  const busyCount =
    [...activeRequests.current].length + (globalReview.status === 'running' ? 1 : 0)
  const saveCopy =
    saveState === 'saving'
      ? 'Saving locally…'
      : saveState === 'error'
        ? 'Autosave needs attention'
        : 'Saved locally'

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="./icon.png" alt="" />
          <div className="brand-copy">
            <span className="brand-name">Roleplay Lab</span>
            <span className="brand-subtitle">Model comparison workbench</span>
          </div>
        </div>

        <input
          className="workspace-title no-drag"
          value={workspace.name}
          aria-label="Workspace name"
          onChange={(event) =>
            setWorkspace({
              ...workspace,
              name: event.target.value,
              updatedAt: new Date().toISOString()
            })
          }
        />

        <div className="topbar-actions no-drag">
          <label className="control-pill" title="Default conversation context for all lanes">
            <History size={14} />
            <span>Context</span>
            <select
              value={workspace.globalMemory.mode}
              onChange={(event) =>
                changeGlobalMemory(event.target.value as MemoryConfig['mode'])
              }
            >
              <option value="retain-all">Full history</option>
              <option value="sliding-window">Recent messages</option>
              <option value="fresh-each-turn">Current message only</option>
            </select>
          </label>

          <label
            className={`record-toggle ${workspace.settings.loggingEnabled ? 'active' : ''}`}
            title="Write human-readable Markdown session logs"
          >
            <input
              type="checkbox"
              checked={workspace.settings.loggingEnabled}
              onChange={(event) => void toggleLogging(event.target.checked)}
            />
            <span className="record-dot" />
            Record session
          </label>

          <button
            className="icon-button"
            title="Open log folder"
            onClick={() => void window.rpCompare.logs.reveal()}
          >
            <FolderOpen size={15} />
          </button>
          <span className="toolbar-divider" />
          <button className="icon-button" title="Import workspace" onClick={importWorkspace}>
            <Import size={15} />
          </button>
          <button className="icon-button" title="Export workspace" onClick={exportWorkspace}>
            <Download size={15} />
          </button>
          <button className="button primary" onClick={addLane}>
            <Plus size={15} />
            Add Model
          </button>
        </div>
      </header>

      <div className="workspace-strip">
        <span className="autosave-state">
          <strong>{saveCopy}</strong>
        </span>
        <span>·</span>
        <span>
          {workspace.panes.length} Model Lane{workspace.panes.length === 1 ? '' : 's'}
        </span>
        {!secretsAvailable && (
          <>
            <span>·</span>
            <span>API keys are session-only on this system</span>
          </>
        )}
        <span className="strip-spacer" />
        <button
          type="button"
          className={`strip-action compare ${
            globalReview.status === 'running' ? 'active' : ''
          }`}
          title="Rank the latest shared round and generate prompt improvements"
          onClick={openGlobalReview}
        >
          <Scale size={12} />
          {globalReview.status === 'running' ? 'Reviewing…' : 'Compare & Review'}
        </button>
        <button
          type="button"
          className="strip-action danger"
          title="Remove every transcript and reset comparison rounds"
          onClick={clearAllConversations}
        >
          <Trash2 size={12} />
          Clear All Conversations
        </button>
        <span className="shortcut-hint">
          <kbd>Ctrl</kbd> + <kbd>Enter</kbd> send lane
        </span>
        <span className="shortcut-hint">
          <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Enter</kbd> broadcast
        </span>
      </div>

      <main className="lane-canvas">
        {workspace.panes.map((pane, index) => (
          <ModelLane
            key={pane.id}
            pane={pane}
            index={index}
            total={workspace.panes.length}
            globalMemory={workspace.globalMemory}
            active={workspace.selectedPaneId === pane.id}
            ui={paneUi[pane.id] ?? freshPaneUi()}
            onActivate={() =>
              setWorkspace((current) =>
                current && current.selectedPaneId !== pane.id
                  ? { ...current, selectedPaneId: pane.id }
                  : current
              )
            }
            onUpdate={(nextPane) => updatePane(pane.id, nextPane)}
            onUiChange={(patch) => updatePaneUi(pane.id, patch)}
            onSend={(text) => void sendToPane(pane.id, text)}
            onStop={() => void stopPane(pane.id)}
            onClone={(direction) => duplicateLane(pane.id, direction)}
            onMove={(direction) => moveLane(pane.id, direction)}
            onRemove={() => removeLane(pane.id)}
            onClear={() => clearLane(pane.id)}
            onDeleteMessage={(messageId) => deleteMessage(pane.id, messageId)}
            onFetchModels={() => void fetchModels(pane.id)}
            onImport={(kind) => void importText(pane.id, kind)}
            onRunReview={() => void runReview(pane.id)}
            notify={notify}
          />
        ))}

        <div className="add-lane-card">
          <button className="add-lane-button" onClick={addLane}>
            <span className="add-lane-icon">
              <Plus size={20} />
            </span>
            <strong>Add another model</strong>
            <span>Compare as many independent configurations as you need.</span>
          </button>
        </div>
      </main>

      <footer className="broadcast-bar">
        <div className="broadcast-label">
          <strong>
            <Radio size={14} />
            Broadcast Message
          </strong>
          <span>One prompt, parallel responses.</span>
        </div>
        <div className="broadcast-composer">
          <textarea
            value={broadcastDraft}
            placeholder="Send the same player message to multiple Model Lanes…"
            aria-label="Broadcast message"
            onChange={(event) => setBroadcastDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.ctrlKey && event.shiftKey) {
                event.preventDefault()
                sendBroadcast()
              }
            }}
          />
          <div className="broadcast-controls">
            <select
              className="broadcast-target"
              value={broadcastTarget}
              onChange={(event) => setBroadcastTarget(event.target.value as BroadcastTarget)}
            >
              <option value="selected">Selected lanes</option>
              <option value="all-ready">All ready lanes</option>
              <option value="active">Active lane only</option>
            </select>
            {busyCount ? (
              <button className="button danger full compact" onClick={stopAll}>
                <Square size={11} fill="currentColor" />
                Stop all ({busyCount})
              </button>
            ) : (
              <button
                className="button primary full compact"
                disabled={!broadcastDraft.trim() || !readyBroadcastCount}
                onClick={sendBroadcast}
              >
                <Send size={12} />
                Send to {readyBroadcastCount}
              </button>
            )}
          </div>
        </div>
      </footer>

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.kind === 'success' ? (
              <CheckCircle2 size={15} color="var(--success)" />
            ) : toast.kind === 'error' ? (
              <X size={15} color="var(--danger)" />
            ) : (
              <BrainCircuit size={15} color="var(--accent-2)" />
            )}
            {toast.message}
          </div>
        ))}
      </div>

      {importPreview && (
        <div className="modal-backdrop" onMouseDown={() => setImportPreview(null)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Import {importLabel(importPreview.kind)}</h2>
              <button className="icon-button" onClick={() => setImportPreview(null)}>
                <X size={15} />
              </button>
            </div>
            <div className="modal-body">
              <div className="section-header">
                <span className="section-icon">
                  {importPreview.format === 'csv' ? (
                    <Layers3 size={15} />
                  ) : (
                    <MessageSquareText size={15} />
                  )}
                </span>
                <div>
                  <h3 className="section-title">{importPreview.fileName}</h3>
                  <p className="section-description">
                    {importPreview.format === 'csv'
                      ? 'CSV rows were converted to readable context. Review before applying.'
                      : 'Review the imported text before applying it to this lane.'}
                  </p>
                </div>
              </div>
              <div className="csv-preview">{importPreview.content}</div>
            </div>
            <div className="modal-footer">
              <button className="button" onClick={() => setImportPreview(null)}>
                Cancel
              </button>
              <button className="button" onClick={() => applyImport('append')}>
                <CloudDownload size={13} />
                Append
              </button>
              <button className="button primary" onClick={() => applyImport('replace')}>
                Replace
              </button>
            </div>
          </section>
        </div>
      )}

      {clearAllConfirmationOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setClearAllConfirmationOpen(false)}
        >
          <section
            className="modal confirmation-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="clear-all-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="clear-all-title">Clear every conversation?</h2>
              <button
                className="icon-button"
                aria-label="Cancel clearing conversations"
                onClick={() => setClearAllConfirmationOpen(false)}
              >
                <X size={15} />
              </button>
            </div>
            <div className="modal-body confirmation-copy">
              <p>
                This removes every previous round from all Model Lanes and from model
                memory. The next message behaves like the first round.
              </p>
              <p>
                Human-readable log files are kept. Conversation removal cannot be
                undone.
              </p>
            </div>
            <div className="modal-footer">
              <button
                className="button"
                autoFocus
                onClick={() => setClearAllConfirmationOpen(false)}
              >
                Cancel
              </button>
              <button
                className="button danger"
                onClick={confirmClearAllConversations}
              >
                <Trash2 size={13} />
                Clear all conversations
              </button>
            </div>
          </section>
        </div>
      )}

      {globalReview.open && (
        <div
          className="modal-backdrop"
          onMouseDown={() =>
            setGlobalReview((current) => ({ ...current, open: false }))
          }
        >
          <section
            className="modal global-review-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header global-review-header">
              <span className="global-review-mark">
                <Scale size={17} />
              </span>
              <div>
                <h2>Compare & Review</h2>
                <p>
                  Judge one round, a selected range, or the full conversation history
                  with an independent reviewer model.
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="Close global review"
                onClick={() =>
                  setGlobalReview((current) => ({ ...current, open: false }))
                }
              >
                <X size={15} />
              </button>
            </div>

            <div className="modal-body global-review-body">
              <section className="global-review-config">
                <div className="review-scope-card">
                  <div className="field-label-row">
                    <span className="field-label">Review scope</span>
                    <span className="field-hint">
                      {eligibleGlobalReviewRounds.length} settled comparable round
                      {eligibleGlobalReviewRounds.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="review-scope-tabs" role="group" aria-label="Review scope">
                    {(
                      [
                        ['one', 'One round'],
                        ['selected', 'Selected rounds'],
                        ['all', 'All rounds']
                      ] as const
                    ).map(([scope, label]) => (
                      <button
                        key={scope}
                        type="button"
                        className={`segmented-button ${
                          globalReview.scope === scope ? 'active' : ''
                        }`}
                        disabled={globalReview.status === 'running'}
                        onClick={() =>
                          setGlobalReview((current) => ({
                            ...current,
                            scope,
                            selectedBatchIds:
                              current.selectedBatchIds.length > 0
                                ? current.selectedBatchIds
                                : eligibleGlobalReviewRounds[0]
                                  ? [eligibleGlobalReviewRounds[0].batchId]
                                  : [],
                            status: 'idle',
                            text: '',
                            error: undefined,
                            snapshots: undefined,
                            provenance: undefined,
                            generatedAt: undefined
                          }))
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {globalReview.scope === 'one' && (
                    <select
                      id="global-review-round"
                      className="select"
                      value={selectedGlobalRounds[0]?.batchId ?? ''}
                      disabled={globalReview.status === 'running'}
                      onChange={(event) =>
                        setGlobalReview((current) => ({
                          ...current,
                          selectedBatchIds: event.target.value
                            ? [event.target.value]
                            : [],
                          status: 'idle',
                          text: '',
                          error: undefined,
                          snapshots: undefined,
                          provenance: undefined,
                          generatedAt: undefined
                        }))
                      }
                    >
                      {!globalReviewRounds.length && (
                        <option value="">No shared rounds yet</option>
                      )}
                      {globalReviewRounds.map((round) => {
                        const ready =
                          round.candidates.length >= 2 &&
                          round.pendingPaneIds.length === 0
                        return (
                          <option key={round.batchId} value={round.batchId} disabled={!ready}>
                            {globalReviewRoundLabel(round)}
                            {!ready
                              ? round.pendingPaneIds.length
                                ? ' · still running'
                                : ' · fewer than 2 completed'
                              : ''}
                          </option>
                        )
                      })}
                    </select>
                  )}

                  {globalReview.scope === 'selected' && (
                    <div className="round-checklist">
                      <div className="round-checklist-actions">
                        <button
                          type="button"
                          className="copy-action"
                          onClick={() =>
                            setGlobalReview((current) => ({
                              ...current,
                              selectedBatchIds: eligibleGlobalReviewRounds.map(
                                (round) => round.batchId
                              ),
                              status: 'idle',
                              text: '',
                              error: undefined,
                              snapshots: undefined,
                              provenance: undefined,
                              generatedAt: undefined
                            }))
                          }
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          className="copy-action"
                          onClick={() =>
                            setGlobalReview((current) => ({
                              ...current,
                              selectedBatchIds: [],
                              status: 'idle',
                              text: '',
                              error: undefined,
                              snapshots: undefined,
                              provenance: undefined,
                              generatedAt: undefined
                            }))
                          }
                        >
                          Clear
                        </button>
                      </div>
                      {globalReviewRounds.map((round) => {
                        const ready =
                          round.candidates.length >= 2 &&
                          round.pendingPaneIds.length === 0
                        const checked = globalReview.selectedBatchIds.includes(round.batchId)
                        return (
                          <label
                            key={round.batchId}
                            className={`round-check ${ready ? '' : 'disabled'}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!ready || globalReview.status === 'running'}
                              onChange={(event) =>
                                setGlobalReview((current) => ({
                                  ...current,
                                  selectedBatchIds: event.target.checked
                                    ? [...new Set([...current.selectedBatchIds, round.batchId])]
                                    : current.selectedBatchIds.filter(
                                        (batchId) => batchId !== round.batchId
                                      ),
                                  status: 'idle',
                                  text: '',
                                  error: undefined,
                                  snapshots: undefined,
                                  provenance: undefined,
                                  generatedAt: undefined
                                }))
                              }
                            />
                            <span>
                              <strong>{globalReviewRoundLabel(round)}</strong>
                              <small>
                                {round.candidates.length} completed
                                {round.pendingPaneIds.length
                                  ? ` · ${round.pendingPaneIds.length} running`
                                  : ''}
                              </small>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  )}

                  {globalReview.scope === 'all' && (
                    <div className="all-rounds-summary">
                      Every settled round with at least two completed lane responses will
                      be reviewed oldest to newest.
                    </div>
                  )}
                </div>

                {selectedGlobalRounds.length > 0 ? (
                  <div className="comparison-round-card">
                    <div className="comparison-round-heading">
                      <strong>
                        {selectedGlobalRounds.length} round
                        {selectedGlobalRounds.length === 1 ? '' : 's'} selected
                      </strong>
                      <span>
                        {selectedGlobalCandidates.length} responses ·{' '}
                        {selectedGlobalLaneModels.length} lane/model
                        {selectedGlobalLaneModels.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="candidate-chips">
                      {selectedGlobalLaneModels.map((candidate) => (
                        <span
                          className="candidate-chip"
                          key={`${candidate.paneId}-${candidate.modelId}`}
                          title={
                            candidate.configurationApproximate
                              ? 'Legacy response: lane/model attribution uses current settings'
                              : 'Captured when this response was sent'
                          }
                        >
                          <strong>{candidate.paneName}</strong>
                          <small>{candidate.modelId || 'model ID unavailable'}</small>
                          {candidate.configurationApproximate && <small>approx.</small>}
                        </span>
                      ))}
                    </div>
                    <div className="selected-round-list">
                      {selectedGlobalRounds.map((round) => (
                        <span key={round.batchId}>
                          {globalReviewRoundLabel(round)} · {round.candidates.length}{' '}
                          responses
                          {round.failedPaneIds.length
                            ? ` · ${round.failedPaneIds.length} failed`
                            : ''}
                          {round.missingResponsePaneIds.length
                            ? ` · ${round.missingResponsePaneIds.length} missing`
                            : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="global-review-empty">
                    <Radio size={20} />
                    <div>
                      <strong>No comparable rounds selected</strong>
                      <span>
                        Broadcast the same message to at least two Model Lanes, then
                        select one or more completed rounds here.
                      </span>
                    </div>
                  </div>
                )}

                <div className="dedicated-reviewer-card">
                  <div className="dedicated-reviewer-heading">
                    <div>
                      <strong>Dedicated reviewer model</strong>
                      <span>Independent from every roleplay lane</span>
                    </div>
                    <BrainCircuit size={16} />
                  </div>
                  <div className="form-grid">
                    <div className="field span-2">
                      <label htmlFor="global-reviewer-url">API Base URL</label>
                      <input
                        id="global-reviewer-url"
                        className="input"
                        value={workspace.globalReviewer.connection.baseUrl}
                        disabled={globalReview.status === 'running'}
                        placeholder="https://provider.example/v1"
                        onChange={(event) => {
                          const baseUrl = event.target.value
                          updateGlobalReviewer((reviewer) => {
                            const originChanged =
                              endpointOrigin(reviewer.connection.baseUrl) !==
                              endpointOrigin(baseUrl)
                            return {
                              ...reviewer,
                              connection: {
                                ...reviewer.connection,
                                baseUrl,
                                apiKey: originChanged
                                  ? undefined
                                  : reviewer.connection.apiKey,
                                credentialId: originChanged
                                  ? undefined
                                  : reviewer.connection.credentialId
                              }
                            }
                          })
                          setGlobalReviewerModels([])
                        }}
                      />
                    </div>
                    <div className="field span-2">
                      <label htmlFor="global-reviewer-key">API Key</label>
                      <input
                        id="global-reviewer-key"
                        className="input"
                        type="password"
                        autoComplete="off"
                        value={workspace.globalReviewer.connection.apiKey ?? ''}
                        disabled={globalReview.status === 'running'}
                        placeholder={
                          workspace.globalReviewer.connection.credentialId
                            ? 'Saved securely — type to replace'
                            : 'Enter reviewer API key'
                        }
                        onChange={(event) => {
                          const apiKey = event.target.value
                          updateGlobalReviewer((reviewer) => ({
                            ...reviewer,
                            connection: {
                              ...reviewer.connection,
                              apiKey: apiKey || undefined,
                              credentialId: apiKey
                                ? undefined
                                : reviewer.connection.credentialId
                            }
                          }))
                        }}
                      />
                    </div>
                    <div className="field span-2">
                      <label htmlFor="global-reviewer-model">Reviewer model</label>
                      <div className="reviewer-model-row">
                        <input
                          id="global-reviewer-model"
                          className="input"
                          list="global-reviewer-models"
                          value={workspace.globalReviewer.connection.modelId}
                          disabled={globalReview.status === 'running'}
                          placeholder="Enter a model ID"
                          onChange={(event) =>
                            updateGlobalReviewer((reviewer) => ({
                              ...reviewer,
                              connection: {
                                ...reviewer.connection,
                                modelId: event.target.value
                              }
                            }))
                          }
                        />
                        <datalist id="global-reviewer-models">
                          {globalReviewerModels.map((model) => (
                            <option key={model.id} value={model.id} />
                          ))}
                        </datalist>
                        <button
                          type="button"
                          className="button"
                          disabled={
                            globalReview.status === 'running' ||
                            globalReviewerModelsLoading
                          }
                          onClick={() => void fetchGlobalReviewerModels()}
                        >
                          <CloudDownload size={13} />
                          {globalReviewerModelsLoading ? 'Loading…' : 'Fetch'}
                        </button>
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="global-reviewer-timeout">Timeout (seconds)</label>
                      <input
                        id="global-reviewer-timeout"
                        className="input"
                        type="number"
                        min={2}
                        max={600}
                        value={Math.round(
                          workspace.globalReviewer.connection.timeoutMs / 1000
                        )}
                        disabled={globalReview.status === 'running'}
                        onChange={(event) =>
                          updateGlobalReviewer((reviewer) => ({
                            ...reviewer,
                            connection: {
                              ...reviewer.connection,
                              timeoutMs: Math.max(
                                2_000,
                                Number(event.target.value || 120) * 1_000
                              )
                            }
                          }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="global-reviewer-budget">Output tokens</label>
                      <input
                        id="global-reviewer-budget"
                        className="input"
                        type="number"
                        min={256}
                        max={128000}
                        value={workspace.globalReviewer.parameters.maxOutputTokens}
                        disabled={globalReview.status === 'running'}
                        onChange={(event) =>
                          updateGlobalReviewer((reviewer) => ({
                            ...reviewer,
                            parameters: {
                              ...reviewer.parameters,
                              maxOutputTokens: Math.max(
                                256,
                                Number(event.target.value || 4000)
                              )
                            }
                          }))
                        }
                      />
                    </div>
                    <div className="field span-2">
                      <label htmlFor="global-reviewer-temperature">Temperature</label>
                      <input
                        id="global-reviewer-temperature"
                        className="input"
                        type="number"
                        min={0}
                        max={2}
                        step={0.05}
                        value={workspace.globalReviewer.parameters.temperature}
                        disabled={globalReview.status === 'running'}
                        onChange={(event) =>
                          updateGlobalReviewer((reviewer) => ({
                            ...reviewer,
                            parameters: {
                              ...reviewer.parameters,
                              temperature: Number(event.target.value || 0)
                            }
                          }))
                        }
                      />
                    </div>
                  </div>
                </div>

                {!globalReviewerReady(workspace.globalReviewer) && (
                  <div className="connection-state error">
                    <AlertTriangle size={13} />
                    Enter a valid dedicated reviewer URL and model ID.
                  </div>
                )}
                {selectedReviewerConnection && globalReviewerReady(workspace.globalReviewer) && (
                  <div className="review-data-disclosure">
                    <Layers3 size={14} />
                    <span>
                      Selected prompts, profiles, dialogue, requests, and responses are
                      sent to{' '}
                      <strong>{selectedReviewerOrigin || 'the configured endpoint'}</strong>{' '}
                      using <strong>{selectedReviewerConnection.modelId}</strong>. API keys
                      remain in the local credential vault.
                    </span>
                  </div>
                )}
                {reviewerIsCandidate && (
                  <div className="connection-state">
                    <AlertTriangle size={13} />
                    This reviewer endpoint and model also produced a selected response.
                    A genuinely separate judge reduces self-ranking bias.
                  </div>
                )}
                {selectedGlobalCandidates.length > 0 &&
                  selectedReviewerOutputBudget < recommendedReviewOutputBudget && (
                    <div className="connection-state">
                      <AlertTriangle size={13} />
                      The {selectedReviewerOutputBudget.toLocaleString()}-token output
                      budget may truncate this report. About{' '}
                      {recommendedReviewOutputBudget.toLocaleString()} tokens is safer.
                    </div>
                  )}
                {estimatedReviewTokens > 50_000 && (
                  <div className="connection-state">
                    <AlertTriangle size={13} />
                    The selected material is roughly{' '}
                    {estimatedReviewTokens.toLocaleString()} tokens before reviewer
                    instructions. Use Selected rounds if this exceeds the model context.
                  </div>
                )}

                <div className="field global-priorities">
                  <div className="field-label-row">
                    <label htmlFor="global-review-priorities">Evaluation priorities</label>
                    <span className="field-hint">Saved with this reviewer profile</span>
                  </div>
                  <textarea
                    id="global-review-priorities"
                    className="textarea"
                    value={workspace.globalReviewer.priorities}
                    disabled={globalReview.status === 'running'}
                    onChange={(event) =>
                      updateGlobalReviewer((reviewer) => ({
                        ...reviewer,
                        priorities: event.target.value
                      }))
                    }
                  />
                </div>
              </section>

              <section className="global-review-result">
                {globalReview.error && (
                  <div className="connection-state error">
                    <AlertTriangle size={13} />
                    {globalReview.error}
                  </div>
                )}

                {globalReview.text ? (
                  <div className="analysis-output global-analysis-output">
                    <div className="message-footer global-report-meta">
                      <BrainCircuit size={12} />
                      <span>
                        {globalReview.status === 'running'
                          ? 'Streaming comparison report…'
                          : 'Global comparison report'}
                      </span>
                      {globalReview.snapshots?.length === 1 && (
                        <span>
                          · {globalReviewRoundLabel(globalReview.snapshots[0])}
                        </span>
                      )}
                      {(globalReview.snapshots?.length ?? 0) > 1 && (
                        <span>· {globalReview.snapshots?.length} rounds</span>
                      )}
                      <span className="spacer" />
                      <button
                        type="button"
                        className="copy-action"
                        onClick={() => void copyGlobalReview()}
                      >
                        <Copy size={11} />
                        Copy
                      </button>
                      <button
                        type="button"
                        className="copy-action"
                        disabled={globalReview.status === 'running'}
                        onClick={() => void exportGlobalReview()}
                      >
                        <Download size={11} />
                        Save .txt
                      </button>
                    </div>
                    {globalReview.provenance && (
                      <div className="global-report-provenance">
                        <span>
                          <strong>Dedicated judge:</strong>{' '}
                          {globalReview.provenance.modelId}
                        </span>
                        <span>
                          <strong>Endpoint:</strong>{' '}
                          {globalReview.provenance.endpointOrigin || 'Local/custom'}
                        </span>
                        <span>
                          <strong>Output budget:</strong>{' '}
                          {globalReview.provenance.maxOutputTokens.toLocaleString()} tokens
                        </span>
                        <details>
                          <summary>Priorities used for this report</summary>
                          <pre>{globalReview.provenance.priorities}</pre>
                        </details>
                      </div>
                    )}
                    <div className="markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {globalReview.text}
                      </ReactMarkdown>
                      {globalReview.status === 'running' && (
                        <span className="stream-cursor" aria-label="Streaming" />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="global-review-empty report">
                    <BrainCircuit size={22} />
                    <div>
                      <strong>No global report yet</strong>
                      <span>
                        The reviewer will rank each response, diagnose cross-model patterns,
                        and propose shared and per-lane prompt fixes.
                      </span>
                    </div>
                  </div>
                )}
              </section>
            </div>

            <div className="modal-footer global-review-footer">
              <button
                className="button"
                onClick={() =>
                  setGlobalReview((current) => ({ ...current, open: false }))
                }
              >
                Close
              </button>
              {globalReview.text && (
                <>
                  <button className="button" onClick={() => void copyGlobalReview()}>
                    <Copy size={13} />
                    Copy report
                  </button>
                  <button
                    className="button"
                    disabled={globalReview.status === 'running'}
                    onClick={() => void exportGlobalReview()}
                  >
                    <Download size={13} />
                    Export .txt
                  </button>
                </>
              )}
              {globalReview.status === 'running' ? (
                <button className="button danger" onClick={() => void stopGlobalReview()}>
                  <Square size={11} fill="currentColor" />
                  Stop review
                </button>
              ) : (
                <button
                  className="button primary"
                  disabled={
                    selectedGlobalRounds.length === 0 ||
                    selectedDistinctPaneCount < 2 ||
                    !globalReviewerReady(workspace.globalReviewer)
                  }
                  onClick={() => void runGlobalReview()}
                >
                  <Scale size={13} />
                  Review {selectedGlobalRounds.length} round
                  {selectedGlobalRounds.length === 1 ? '' : 's'} ·{' '}
                  {selectedGlobalCandidates.length} responses ·{' '}
                  {selectedGlobalLaneModels.length} models
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
