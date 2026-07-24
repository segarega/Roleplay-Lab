import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  BrainCircuit,
  Check,
  Clipboard,
  Copy,
  Database,
  FileText,
  Gauge,
  History,
  Import,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Network,
  Play,
  RefreshCw,
  Send,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  X
} from 'lucide-react'
import type {
  ConnectionConfig,
  GenerationParameters,
  ImportKind,
  MemoryConfig,
  ProviderModel,
  RoleplayContext,
  TestPaneConfig
} from '../../../shared/types'
import {
  LANE_COLORS,
  findLatestExchange,
  formatLatency,
  formatTimestamp,
  isConnectionReady,
  memoryLabel,
  parseExtraParameters,
  parseHeaders,
  prettyExtraParameters,
  prettyHeaders,
  renderRoleplaySystem,
  resolveMemory
} from '../lib/workspace'

export type LaneTab = 'chat' | 'review' | 'setup'
export type SetupSection = 'connection' | 'generation' | 'context' | 'memory'

export interface ModelLaneUiState {
  tab: LaneTab
  setupSection: SetupSection
  draft: string
  includeInBroadcast: boolean
  activeRequestId?: string
  models: ProviderModel[]
  modelLoading: boolean
  connectionFeedback?: {
    kind: 'success' | 'error' | 'info'
    message: string
  }
  reviewText: string
  reviewRunning: boolean
  reviewRequestId?: string
  reviewError?: string
}

type NoticeType = 'info' | 'success' | 'error'
type MaybePromise = void | Promise<void>

export interface ModelLaneProps {
  pane: TestPaneConfig
  index: number
  total: number
  globalMemory: MemoryConfig
  active: boolean
  ui: ModelLaneUiState
  onActivate(): void
  onUpdate(nextPane: TestPaneConfig): void
  onUiChange(patch: Partial<ModelLaneUiState>): void
  onSend(text: string): MaybePromise
  onStop(): MaybePromise
  onClone(direction: 'left' | 'right'): void
  onMove(direction: 'left' | 'right'): void
  onRemove(): void
  onClear(): void
  onDeleteMessage(messageId: string): void
  onFetchModels(): MaybePromise
  onImport(kind: ImportKind): MaybePromise
  onRunReview(): MaybePromise
  notify?(message: string, type?: NoticeType): void
}

interface SectionHeaderProps {
  icon: ReactNode
  title: string
  description: string
}

function SectionHeader({ icon, title, description }: SectionHeaderProps): React.JSX.Element {
  return (
    <div className="section-header">
      <span className="section-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <h3 className="section-title">{title}</h3>
        <p className="section-description">{description}</p>
      </div>
    </div>
  )
}

interface ToggleProps {
  checked: boolean
  label: string
  onChange(checked: boolean): void
}

function Toggle({ checked, label, onChange }: ToggleProps): React.JSX.Element {
  return (
    <label className="toggle-row">
      <span className="switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switch-track" />
      </span>
      <span>{label}</span>
    </label>
  )
}

function finiteNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function integerNumber(value: string, fallback: number): number {
  return Math.trunc(finiteNumber(value, fallback))
}

type ReasoningMode = 'omit' | 'enabled' | 'disabled'

function reasoningMode(reasoning: GenerationParameters['reasoning']): ReasoningMode {
  if (!reasoning) return 'omit'
  return reasoning.enabled ? 'enabled' : 'disabled'
}

function reasoningForMode(
  current: GenerationParameters['reasoning'],
  mode: ReasoningMode
): GenerationParameters['reasoning'] {
  if (mode === 'omit') return null
  return {
    ...(current ?? { effort: 'low', exclude: false, enabled: true }),
    enabled: mode === 'enabled'
  }
}

function endpointOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

function lastAssistantMessage(pane: TestPaneConfig) {
  for (let position = pane.messages.length - 1; position >= 0; position -= 1) {
    if (pane.messages[position].role === 'assistant') return pane.messages[position]
  }
  return undefined
}

function usageLabel(
  usage: TestPaneConfig['messages'][number]['usage']
): string | undefined {
  if (!usage) return undefined
  if (usage.totalTokens != null) return `${usage.totalTokens.toLocaleString()} tokens`
  if (usage.completionTokens != null) {
    return `${usage.completionTokens.toLocaleString()} output tokens`
  }
  if (usage.promptTokens != null) return `${usage.promptTokens.toLocaleString()} input tokens`
  return undefined
}

async function copyToClipboard(
  value: string,
  notify?: ModelLaneProps['notify'],
  successMessage = 'Copied to clipboard.'
): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    notify?.(successMessage, 'success')
  } catch {
    notify?.('Clipboard access was unavailable.', 'error')
  }
}

function isCompletedExchangeMessage(
  messages: TestPaneConfig['messages'],
  messageIndex: number
): boolean {
  const message = messages[messageIndex]
  if (message.role !== 'user' && message.role !== 'assistant') return false

  const assistantIsComplete = (
    candidate: TestPaneConfig['messages'][number] | undefined
  ): boolean =>
    candidate?.role === 'assistant' &&
    !candidate.pending &&
    !candidate.error &&
    Boolean(candidate.content.trim())

  if (!message.requestId) {
    if (message.role === 'user') {
      const assistant = messages[messageIndex + 1]
      return !assistant?.requestId && assistantIsComplete(assistant)
    }
    const user = messages[messageIndex - 1]
    return user?.role === 'user' && !user.requestId && assistantIsComplete(message)
  }

  const hasUser = messages.some(
    (candidate) =>
      candidate.role === 'user' && candidate.requestId === message.requestId
  )
  const hasCompleteAssistant = messages.some(
    (candidate) =>
      candidate.requestId === message.requestId && assistantIsComplete(candidate)
  )
  return hasUser && hasCompleteAssistant
}

interface MessageRowProps {
  message: TestPaneConfig['messages'][number]
  turn: number
  speakerName: string
  fallbackContext: string
  excludedFromMemory: boolean
  onDelete(): void
  notify?: ModelLaneProps['notify']
}

function MessageRow({
  message,
  turn,
  speakerName,
  fallbackContext,
  excludedFromMemory,
  onDelete,
  notify
}: MessageRowProps): React.JSX.Element | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null

  const isUser = message.role === 'user'
  const cancelled = Boolean(message.error && /cancel/i.test(message.error))
  const cardState = message.pending
    ? ' streaming'
    : cancelled
      ? ' cancelled'
      : message.error
        ? ' error'
        : ''
  const tokens = usageLabel(message.usage)
  const time = formatTimestamp(message.createdAt)
  const comparisonRound = message.batchId?.match(/^round-(\d+)-/)?.[1]

  return (
    <article className={`message ${message.role}`}>
      <div className="message-meta">
        <span>{isUser ? 'You' : speakerName}</span>
        <span>·</span>
        <span>{time}</span>
        <span className="round-badge">
          {comparisonRound ? `Round ${comparisonRound}` : `Turn ${turn}`}
        </span>
        {!isUser && (
          <span className="context-badge">{message.contextLabel || fallbackContext}</span>
        )}
        {excludedFromMemory && !message.pending && (
          <span className="memory-excluded-badge">Incomplete turn · excluded from memory</span>
        )}
      </div>

      {isUser ? (
        <div className="message-bubble">{message.content}</div>
      ) : (
        <div className={`assistant-card${cardState}`}>
          {message.content ? (
            <div className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          ) : message.pending ? (
            <span>Waiting for the first token</span>
          ) : null}
          {message.pending && <span className="stream-cursor" aria-label="Streaming" />}
          {message.error && (
            <p
              style={{
                margin: message.content ? '10px 0 0' : 0,
                fontSize: '10px',
                lineHeight: 1.45
              }}
            >
              {message.error}
            </p>
          )}
        </div>
      )}

      <div className="message-footer">
        {!isUser && message.latencyMs != null && <span>{formatLatency(message.latencyMs)}</span>}
        {!isUser && tokens && <span>{tokens}</span>}
        {!isUser && message.finishReason && <span>Finish: {message.finishReason}</span>}
        <span className="spacer" />
        <button
          type="button"
          className="copy-action"
          onClick={() => void copyToClipboard(message.content, notify)}
          disabled={!message.content}
          aria-label={`Copy ${isUser ? 'message' : 'response'}`}
        >
          <Copy size={11} />
          Copy
        </button>
        <button
          type="button"
          className="copy-action delete-action"
          onClick={onDelete}
          disabled={message.pending}
          aria-label={`Delete ${isUser ? 'message' : 'response'}`}
          title={message.pending ? 'Stop generation before deleting this response' : undefined}
        >
          <Trash2 size={11} />
          Delete
        </button>
      </div>
    </article>
  )
}

type LaneConfirmation =
  | {
      kind: 'delete-message'
      messageId: string
      messageKind: 'message' | 'response'
    }
  | { kind: 'clear-conversation' }
  | { kind: 'close-lane' }

interface ConfirmationModalProps {
  id: string
  title: string
  description: string
  confirmLabel: string
  onCancel(): void
  onConfirm(): void
}

function ConfirmationModal({
  id,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm
}: ConfirmationModalProps): React.JSX.Element {
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement
    cancelButtonRef.current?.focus()

    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onCancel()
    }

    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [onCancel])

  return createPortal(
    <div
      className="modal-backdrop"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={`${id}-title`}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Cancel"
            onClick={onCancel}
          >
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">
          <div id={`${id}-description`} className="helper-callout warning">
            {description}
          </div>
        </div>
        <div className="modal-footer">
          <button
            ref={cancelButtonRef}
            type="button"
            className="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="button danger" onClick={onConfirm}>
            <Trash2 size={13} />
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}

function reviewerScores(markdown: string): { label: string; score: string }[] {
  const patterns: [string, RegExp][] = [
    ['Character', /character\s+fidelity[^\d]*(\d+(?:\.\d+)?)(?:\s*\/\s*10)?/i],
    ['Story', /story\s+coherence[^\d]*(\d+(?:\.\d+)?)(?:\s*\/\s*10)?/i],
    ['Dialogue', /dialogue\s+naturalness[^\d]*(\d+(?:\.\d+)?)(?:\s*\/\s*10)?/i],
    ['Prompt', /prompt\s+clarity[^\d]*(\d+(?:\.\d+)?)(?:\s*\/\s*10)?/i]
  ]

  return patterns.flatMap(([label, pattern]) => {
    const match = pattern.exec(markdown)
    if (!match) return []
    const numeric = Number(match[1])
    return Number.isFinite(numeric) ? [{ label, score: `${numeric}/10` }] : []
  })
}

const setupSections: { id: SetupSection; label: string }[] = [
  { id: 'connection', label: 'Connection' },
  { id: 'generation', label: 'Generation' },
  { id: 'context', label: 'Context' },
  { id: 'memory', label: 'Memory' }
]

function ModelLaneComponent({
  pane,
  index,
  total,
  globalMemory,
  active,
  ui,
  onActivate,
  onUpdate,
  onUiChange,
  onSend,
  onStop,
  onClone,
  onMove,
  onRemove,
  onClear,
  onDeleteMessage,
  onFetchModels,
  onImport,
  onRunReview,
  notify
}: ModelLaneProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<LaneConfirmation | null>(null)
  const [headersText, setHeadersText] = useState(() =>
    prettyHeaders(pane.connection.customHeaders)
  )
  const [headersInvalid, setHeadersInvalid] = useState(false)
  const [extraText, setExtraText] = useState(() => prettyExtraParameters(pane.parameters))
  const [extraInvalid, setExtraInvalid] = useState(false)
  const [reviewHeadersText, setReviewHeadersText] = useState(() =>
    prettyHeaders(pane.analysis.connection.customHeaders)
  )
  const [reviewHeadersInvalid, setReviewHeadersInvalid] = useState(false)
  const [reviewExtraText, setReviewExtraText] = useState(() =>
    prettyExtraParameters(pane.analysis.parameters)
  )
  const [reviewExtraInvalid, setReviewExtraInvalid] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const credentialOriginRef = useRef(endpointOrigin(pane.connection.baseUrl))
  const reviewerCredentialOriginRef = useRef(
    endpointOrigin(pane.analysis.connection.baseUrl)
  )

  const headerSignature = JSON.stringify(pane.connection.customHeaders)
  const extraSignature = JSON.stringify(pane.parameters.extra)
  const reviewHeaderSignature = JSON.stringify(pane.analysis.connection.customHeaders)
  const reviewExtraSignature = JSON.stringify(pane.analysis.parameters.extra)

  useEffect(() => {
    setHeadersText(prettyHeaders(pane.connection.customHeaders))
    setHeadersInvalid(false)
  }, [pane.id, headerSignature])

  useEffect(() => {
    setExtraText(prettyExtraParameters(pane.parameters))
    setExtraInvalid(false)
  }, [pane.id, extraSignature])

  useEffect(() => {
    setReviewHeadersText(prettyHeaders(pane.analysis.connection.customHeaders))
    setReviewHeadersInvalid(false)
  }, [pane.id, reviewHeaderSignature])

  useEffect(() => {
    setReviewExtraText(prettyExtraParameters(pane.analysis.parameters))
    setReviewExtraInvalid(false)
  }, [pane.id, reviewExtraSignature])

  useEffect(() => {
    if (pane.connection.credentialId || pane.connection.apiKey) {
      credentialOriginRef.current = endpointOrigin(pane.connection.baseUrl)
    }
  }, [pane.connection.credentialId, Boolean(pane.connection.apiKey)])

  useEffect(() => {
    if (
      pane.analysis.connection.credentialId ||
      pane.analysis.connection.apiKey
    ) {
      reviewerCredentialOriginRef.current = endpointOrigin(
        pane.analysis.connection.baseUrl
      )
    }
  }, [
    pane.analysis.connection.credentialId,
    Boolean(pane.analysis.connection.apiKey)
  ])

  useEffect(() => {
    if (!menuOpen) return

    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  useEffect(() => {
    if (ui.tab !== 'chat') return
    bottomRef.current?.scrollIntoView({
      behavior: ui.activeRequestId ? 'auto' : 'smooth',
      block: 'end'
    })
  }, [
    ui.tab,
    ui.activeRequestId,
    pane.messages.length,
    pane.messages[pane.messages.length - 1]?.content
  ])

  const resolvedMemory = resolveMemory(pane, globalMemory)
  const renderedPrompt = useMemo(() => renderRoleplaySystem(pane.roleplay), [pane.roleplay])
  const latestExchange = useMemo(() => findLatestExchange(pane.messages), [pane.messages])
  const scores = useMemo(() => reviewerScores(ui.reviewText), [ui.reviewText])
  const lastAssistant = lastAssistantMessage(pane)
  const streaming = Boolean(ui.activeRequestId || lastAssistant?.pending)
  const cancelled = Boolean(lastAssistant?.error && /cancel/i.test(lastAssistant.error))
  const connectionReady = isConnectionReady(pane)
  const status = streaming
    ? 'streaming'
    : cancelled
      ? 'cancelled'
      : lastAssistant?.error
        ? 'error'
        : lastAssistant
          ? 'complete'
          : connectionReady
            ? 'ready'
            : 'idle'
  const statusLabel =
    status === 'streaming'
      ? 'Generating'
      : status === 'complete'
        ? 'Complete'
        : status === 'cancelled'
          ? 'Stopped'
          : status === 'error'
            ? 'Needs attention'
            : status === 'ready'
              ? 'Ready'
              : 'Setup required'

  const laneStyle = {
    '--lane-color': LANE_COLORS[index % LANE_COLORS.length],
    ...(active
      ? {
          borderColor: `color-mix(in srgb, ${LANE_COLORS[index % LANE_COLORS.length]} 38%, transparent)`
        }
      : {})
  } as CSSProperties

  const updateConnection = (patch: Partial<ConnectionConfig>): void => {
    onUpdate({
      ...pane,
      connection: {
        ...pane.connection,
        ...patch
      }
    })
  }

  const updateParameters = (patch: Partial<GenerationParameters>): void => {
    onUpdate({
      ...pane,
      parameters: {
        ...pane.parameters,
        ...patch
      }
    })
  }

  const updateRoleplay = (patch: Partial<RoleplayContext>): void => {
    onUpdate({
      ...pane,
      roleplay: {
        ...pane.roleplay,
        ...patch
      }
    })
  }

  const updateAnalysis = (patch: Partial<TestPaneConfig['analysis']>): void => {
    onUpdate({
      ...pane,
      analysis: {
        ...pane.analysis,
        ...patch
      }
    })
  }

  const updateAnalysisConnection = (patch: Partial<ConnectionConfig>): void => {
    updateAnalysis({
      connection: {
        ...pane.analysis.connection,
        ...patch
      }
    })
  }

  const updateAnalysisParameters = (patch: Partial<GenerationParameters>): void => {
    updateAnalysis({
      parameters: {
        ...pane.analysis.parameters,
        ...patch
      }
    })
  }

  const changeConnectionBaseUrl = (baseUrl: string): void => {
    const savedOrigin = credentialOriginRef.current
    const nextOrigin = endpointOrigin(baseUrl)
    if (
      (pane.connection.credentialId || pane.connection.apiKey) &&
      savedOrigin &&
      nextOrigin &&
      savedOrigin !== nextOrigin
    ) {
      credentialOriginRef.current = undefined
      updateConnection({ baseUrl, apiKey: undefined, credentialId: undefined })
      notify?.('The saved API key was detached because the provider host changed.', 'info')
      return
    }
    updateConnection({ baseUrl })
  }

  const changeReviewerBaseUrl = (baseUrl: string): void => {
    const savedOrigin = reviewerCredentialOriginRef.current
    const nextOrigin = endpointOrigin(baseUrl)
    if (
      (pane.analysis.connection.credentialId || pane.analysis.connection.apiKey) &&
      savedOrigin &&
      nextOrigin &&
      savedOrigin !== nextOrigin
    ) {
      reviewerCredentialOriginRef.current = undefined
      updateAnalysisConnection({ baseUrl, apiKey: undefined, credentialId: undefined })
      notify?.(
        'The saved reviewer API key was detached because the provider host changed.',
        'info'
      )
      return
    }
    updateAnalysisConnection({ baseUrl })
  }

  const commitHeaders = (): void => {
    try {
      const customHeaders = parseHeaders(headersText)
      setHeadersText(prettyHeaders(customHeaders))
      setHeadersInvalid(false)
      if (JSON.stringify(customHeaders) !== headerSignature) {
        updateConnection({ customHeaders })
        notify?.('Custom headers updated.', 'success')
      }
    } catch (error) {
      setHeadersInvalid(true)
      notify?.(error instanceof Error ? error.message : 'Invalid custom headers JSON.', 'error')
    }
  }

  const commitExtra = (): void => {
    try {
      const extra = parseExtraParameters(extraText)
      setExtraText(Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '')
      setExtraInvalid(false)
      if (JSON.stringify(extra) !== extraSignature) {
        updateParameters({ extra })
        notify?.('Custom generation parameters updated.', 'success')
      }
    } catch (error) {
      setExtraInvalid(true)
      notify?.(error instanceof Error ? error.message : 'Invalid custom parameter JSON.', 'error')
    }
  }

  const commitReviewHeaders = (): void => {
    try {
      const customHeaders = parseHeaders(reviewHeadersText)
      setReviewHeadersText(prettyHeaders(customHeaders))
      setReviewHeadersInvalid(false)
      if (JSON.stringify(customHeaders) !== reviewHeaderSignature) {
        updateAnalysisConnection({ customHeaders })
        notify?.('Reviewer headers updated.', 'success')
      }
    } catch (error) {
      setReviewHeadersInvalid(true)
      notify?.(error instanceof Error ? error.message : 'Invalid reviewer headers JSON.', 'error')
    }
  }

  const commitReviewExtra = (): void => {
    try {
      const extra = parseExtraParameters(reviewExtraText)
      setReviewExtraText(Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '')
      setReviewExtraInvalid(false)
      if (JSON.stringify(extra) !== reviewExtraSignature) {
        updateAnalysisParameters({ extra })
        notify?.('Reviewer parameters updated.', 'success')
      }
    } catch (error) {
      setReviewExtraInvalid(true)
      notify?.(error instanceof Error ? error.message : 'Invalid reviewer parameter JSON.', 'error')
    }
  }

  const submitDraft = async (): Promise<void> => {
    const value = ui.draft.trim()
    if (!value || streaming) return

    try {
      await onSend(value)
      onUiChange({ draft: '' })
    } catch (error) {
      notify?.(error instanceof Error ? error.message : 'Could not start this request.', 'error')
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void submitDraft()
    }
  }

  const fetchModels = async (): Promise<void> => {
    try {
      await onFetchModels()
    } catch (error) {
      notify?.(error instanceof Error ? error.message : 'Could not fetch models.', 'error')
    }
  }

  const importText = async (kind: ImportKind): Promise<void> => {
    try {
      await onImport(kind)
    } catch (error) {
      notify?.(error instanceof Error ? error.message : 'Could not import that file.', 'error')
    }
  }

  const runReview = async (): Promise<void> => {
    try {
      await onRunReview()
    } catch (error) {
      notify?.(error instanceof Error ? error.message : 'Could not start the review.', 'error')
    }
  }

  const confirmClear = (): void => {
    setMenuOpen(false)
    if (!pane.messages.length) {
      onClear()
      return
    }
    setConfirmation({ kind: 'clear-conversation' })
  }

  const confirmRemove = (): void => {
    setMenuOpen(false)
    if (!pane.messages.length) {
      onRemove()
      return
    }
    setConfirmation({ kind: 'close-lane' })
  }

  const confirmationDetails = confirmation
    ? confirmation.kind === 'delete-message'
      ? {
          title: `Delete this ${confirmation.messageKind}?`,
          description:
            'It will be removed from this transcript and future model context. Prompt-review reports that depend on the transcript will also be cleared.',
          confirmLabel: 'Delete'
        }
      : confirmation.kind === 'clear-conversation'
        ? {
            title: `Clear “${pane.name || `Model ${index + 1}`}”?`,
            description:
              'This removes every message from future model memory and clears dependent prompt-review reports. Existing log files are not deleted.',
            confirmLabel: 'Clear conversation'
          }
        : {
            title: `Close “${pane.name || `Model ${index + 1}`}”?`,
            description: 'The lane and its complete transcript will be removed.',
            confirmLabel: 'Close lane'
          }
    : null

  const applyConfirmation = (): void => {
    if (!confirmation) return
    setConfirmation(null)

    if (confirmation.kind === 'delete-message') {
      onDeleteMessage(confirmation.messageId)
      return
    }
    if (confirmation.kind === 'clear-conversation') {
      onClear()
      return
    }
    onRemove()
  }

  const annotatedMessages = useMemo(() => {
    let turn = 0
    return pane.messages.map((message, messageIndex) => {
      if (message.role === 'user') turn += 1
      return {
        message,
        turn: Math.max(1, turn),
        excludedFromMemory: !isCompletedExchangeMessage(pane.messages, messageIndex)
      }
    })
  }, [pane.messages])

  const renderConnection = (): React.JSX.Element => {
    const modelListId = `models-${pane.id}`

    return (
      <section className="section">
        <SectionHeader
          icon={<Network size={15} />}
          title="Model connection"
          description="Connect this lane to any OpenAI-compatible API root."
        />

        <div className="form-grid">
          <div className="field span-2">
            <div className="field-label-row">
              <label htmlFor={`base-url-${pane.id}`}>API base URL</label>
              <span className="field-hint">Usually ends in /v1</span>
            </div>
            <input
              id={`base-url-${pane.id}`}
              className="input"
              value={pane.connection.baseUrl}
              placeholder="https://provider.example/v1"
              spellCheck={false}
              onChange={(event) => changeConnectionBaseUrl(event.target.value)}
            />
          </div>

          <div className="field span-2">
            <div className="field-label-row">
              <label htmlFor={`api-key-${pane.id}`}>API key</label>
              <span className="field-hint">
                {pane.connection.credentialId ? 'Stored securely' : 'Kept in the OS vault'}
              </span>
            </div>
            <div className="input-with-action">
              <input
                id={`api-key-${pane.id}`}
                className="input"
                type="password"
                value={pane.connection.apiKey ?? ''}
                placeholder={
                  pane.connection.credentialId
                    ? 'Saved — type here to replace'
                    : 'Optional for local providers'
                }
                autoComplete="new-password"
                spellCheck={false}
                onChange={(event) => {
                  const apiKey = event.target.value || undefined
                  updateConnection({
                    apiKey,
                    ...(apiKey ? { credentialId: undefined } : {})
                  })
                }}
              />
              <button
                type="button"
                className="icon-button"
                title={
                  pane.connection.credentialId || pane.connection.apiKey
                    ? 'Detach API key from this lane'
                    : 'No API key attached'
                }
                aria-label="Detach API key from this lane"
                disabled={!pane.connection.credentialId && !pane.connection.apiKey}
                onClick={() => {
                  credentialOriginRef.current = undefined
                  updateConnection({ apiKey: undefined, credentialId: undefined })
                  notify?.('API key detached from this lane.', 'success')
                }}
              >
                <KeyRound size={14} />
              </button>
            </div>
          </div>

          <div className="field span-2">
            <div className="field-label-row">
              <label htmlFor={`model-${pane.id}`}>Model</label>
              <span className="field-hint">
                {ui.models.length ? `${ui.models.length} available` : 'Manual entry supported'}
              </span>
            </div>
            <div className="input-with-action">
              <input
                id={`model-${pane.id}`}
                className="input"
                list={modelListId}
                value={pane.connection.modelId}
                placeholder="Model ID"
                spellCheck={false}
                onChange={(event) => updateConnection({ modelId: event.target.value })}
              />
              <datalist id={modelListId}>
                {ui.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.ownedBy ? `${model.id} · ${model.ownedBy}` : model.id}
                  </option>
                ))}
              </datalist>
              <button
                type="button"
                className="button compact"
                onClick={() => void fetchModels()}
                disabled={ui.modelLoading || !pane.connection.baseUrl.trim()}
              >
                {ui.modelLoading ? (
                  <LoaderCircle size={13} className="spinner" />
                ) : (
                  <RefreshCw size={13} />
                )}
                {ui.modelLoading ? 'Loading' : 'Fetch'}
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor={`timeout-${pane.id}`}>Request timeout</label>
            <div className="input-with-action">
              <input
                id={`timeout-${pane.id}`}
                className="input"
                type="number"
                min={5}
                max={1800}
                value={Math.round(pane.connection.timeoutMs / 1000)}
                onChange={(event) =>
                  updateConnection({
                    timeoutMs: Math.max(
                      5_000,
                      integerNumber(event.target.value, pane.connection.timeoutMs / 1000) * 1000
                    )
                  })
                }
              />
              <span
                className="button compact"
                aria-hidden="true"
                style={{ pointerEvents: 'none', minWidth: '48px' }}
              >
                sec
              </span>
            </div>
          </div>

          <div className="field">
            <label>Resolved endpoint</label>
            <div className="connection-state" style={{ marginTop: 0, minHeight: '34px' }}>
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {pane.connection.baseUrl.replace(/\/+$/, '') || '—'}/chat/completions
              </span>
            </div>
          </div>

          <div className="field span-2">
            <div className="field-label-row">
              <label htmlFor={`headers-${pane.id}`}>Custom headers</label>
              <span className="field-hint">JSON · non-secret values only</span>
            </div>
            <textarea
              id={`headers-${pane.id}`}
              className="json-editor"
              value={headersText}
              placeholder={'{\n  "HTTP-Referer": "https://example.test"\n}'}
              spellCheck={false}
              aria-invalid={headersInvalid}
              style={headersInvalid ? { borderColor: 'var(--danger)' } : undefined}
              onChange={(event) => {
                setHeadersText(event.target.value)
                setHeadersInvalid(false)
              }}
              onBlur={commitHeaders}
            />
          </div>
        </div>

        {ui.connectionFeedback ? (
          <div
            className={`connection-state ${
              ui.connectionFeedback.kind === 'info' ? '' : ui.connectionFeedback.kind
            }`}
            role={ui.connectionFeedback.kind === 'error' ? 'alert' : 'status'}
          >
            {ui.connectionFeedback.kind === 'success' ? (
              <Check size={12} />
            ) : ui.connectionFeedback.kind === 'error' ? (
              <X size={12} />
            ) : (
              <Network size={12} />
            )}
            <span>{ui.connectionFeedback.message}</span>
          </div>
        ) : (
          <div className={`connection-state ${connectionReady ? 'success' : ''}`}>
            {connectionReady ? <Check size={12} /> : <Network size={12} />}
            <span>
              {connectionReady
                ? 'Connection settings are ready for a test request.'
                : 'Enter a valid API base URL and model ID to enable sending.'}
            </span>
          </div>
        )}

        <div className="helper-callout warning">
          <KeyRound size={13} />
          <span>
            Never place secrets in custom headers. API keys are encrypted separately by the
            desktop app.
          </span>
        </div>
      </section>
    )
  }

  const renderGeneration = (): React.JSX.Element => (
    <section className="section">
      <SectionHeader
        icon={<SlidersHorizontal size={15} />}
        title="Generation controls"
        description="Tune sampling for this model without affecting any other lane."
      />

      <div className="form-grid">
        <div className="field span-2">
          <div className="field-label-row">
            <label htmlFor={`temperature-${pane.id}`}>Temperature</label>
            <span className="field-hint">Creativity and variation</span>
          </div>
          <div className="range-row">
            <input
              id={`temperature-${pane.id}`}
              className="range"
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={pane.parameters.temperature}
              onChange={(event) =>
                updateParameters({
                  temperature: finiteNumber(event.target.value, pane.parameters.temperature)
                })
              }
            />
            <input
              className="input range-value"
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={pane.parameters.temperature}
              aria-label="Temperature value"
              onChange={(event) =>
                updateParameters({
                  temperature: finiteNumber(event.target.value, pane.parameters.temperature)
                })
              }
            />
          </div>
        </div>

        <div className="field span-2">
          <div className="field-label-row">
            <label htmlFor={`top-p-${pane.id}`}>Top P</label>
            <span className="field-hint">Nucleus sampling</span>
          </div>
          <div className="range-row">
            <input
              id={`top-p-${pane.id}`}
              className="range"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={pane.parameters.topP}
              onChange={(event) =>
                updateParameters({
                  topP: finiteNumber(event.target.value, pane.parameters.topP)
                })
              }
            />
            <input
              className="input range-value"
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={pane.parameters.topP}
              aria-label="Top P value"
              onChange={(event) =>
                updateParameters({
                  topP: finiteNumber(event.target.value, pane.parameters.topP)
                })
              }
            />
          </div>
        </div>

        <div className="field">
          <div className="field-label-row">
            <label htmlFor={`top-k-${pane.id}`}>Top K</label>
            <span className="field-hint">Optional · integer</span>
          </div>
          <input
            id={`top-k-${pane.id}`}
            className="input"
            type="number"
            min={0}
            max={1_000_000}
            step={1}
            value={pane.parameters.topK ?? ''}
            placeholder="Not sent"
            onChange={(event) =>
              updateParameters({
                topK: event.target.value
                  ? Math.max(0, integerNumber(event.target.value, pane.parameters.topK ?? 0))
                  : null
              })
            }
          />
        </div>

        <div className="field">
          <div className="field-label-row">
            <label htmlFor={`reasoning-mode-${pane.id}`}>Reasoning</label>
            <span className="field-hint">Structured payload</span>
          </div>
          <select
            id={`reasoning-mode-${pane.id}`}
            className="select"
            value={reasoningMode(pane.parameters.reasoning)}
            onChange={(event) =>
              updateParameters({
                reasoning: reasoningForMode(
                  pane.parameters.reasoning,
                  event.target.value as ReasoningMode
                )
              })
            }
          >
            <option value="omit">Do not send</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor={`reasoning-effort-${pane.id}`}>Reasoning effort</label>
          <select
            id={`reasoning-effort-${pane.id}`}
            className="select"
            value={pane.parameters.reasoning?.effort ?? 'low'}
            disabled={!pane.parameters.reasoning}
            onChange={(event) => {
              if (!pane.parameters.reasoning) return
              updateParameters({
                reasoning: {
                  ...pane.parameters.reasoning,
                  effort: event.target.value as NonNullable<
                    GenerationParameters['reasoning']
                  >['effort']
                }
              })
            }}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra high</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor={`reasoning-exclude-${pane.id}`}>Exclude reasoning output</label>
          <select
            id={`reasoning-exclude-${pane.id}`}
            className="select"
            value={String(pane.parameters.reasoning?.exclude ?? false)}
            disabled={!pane.parameters.reasoning}
            onChange={(event) => {
              if (!pane.parameters.reasoning) return
              updateParameters({
                reasoning: {
                  ...pane.parameters.reasoning,
                  exclude: event.target.value === 'true'
                }
              })
            }}
          >
            <option value="false">False</option>
            <option value="true">True</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor={`max-tokens-${pane.id}`}>Maximum output tokens</label>
          <input
            id={`max-tokens-${pane.id}`}
            className="input"
            type="number"
            min={1}
            step={1}
            value={pane.parameters.maxOutputTokens}
            onChange={(event) =>
              updateParameters({
                maxOutputTokens: Math.max(
                  1,
                  integerNumber(event.target.value, pane.parameters.maxOutputTokens)
                )
              })
            }
          />
        </div>

        <div className="field">
          <label htmlFor={`token-field-${pane.id}`}>Provider token field</label>
          <select
            id={`token-field-${pane.id}`}
            className="select"
            value={pane.parameters.maxTokenField}
            onChange={(event) =>
              updateParameters({
                maxTokenField: event.target.value as GenerationParameters['maxTokenField']
              })
            }
          >
            <option value="max_tokens">max_tokens</option>
            <option value="max_completion_tokens">max_completion_tokens</option>
            <option value="omit">Do not send</option>
          </select>
        </div>

        <div className="field span-2">
          <div className="field-label-row">
            <label htmlFor={`presence-${pane.id}`}>Presence penalty</label>
            <span className="field-hint">{pane.parameters.presencePenalty.toFixed(2)}</span>
          </div>
          <input
            id={`presence-${pane.id}`}
            className="range"
            type="range"
            min={-2}
            max={2}
            step={0.05}
            value={pane.parameters.presencePenalty}
            onChange={(event) =>
              updateParameters({
                presencePenalty: finiteNumber(
                  event.target.value,
                  pane.parameters.presencePenalty
                )
              })
            }
          />
        </div>

        <div className="field span-2">
          <div className="field-label-row">
            <label htmlFor={`frequency-${pane.id}`}>Frequency penalty</label>
            <span className="field-hint">{pane.parameters.frequencyPenalty.toFixed(2)}</span>
          </div>
          <input
            id={`frequency-${pane.id}`}
            className="range"
            type="range"
            min={-2}
            max={2}
            step={0.05}
            value={pane.parameters.frequencyPenalty}
            onChange={(event) =>
              updateParameters({
                frequencyPenalty: finiteNumber(
                  event.target.value,
                  pane.parameters.frequencyPenalty
                )
              })
            }
          />
        </div>

        <div className="field">
          <label htmlFor={`seed-${pane.id}`}>Seed</label>
          <input
            id={`seed-${pane.id}`}
            className="input"
            type="number"
            step={1}
            value={pane.parameters.seed ?? ''}
            placeholder="Random"
            onChange={(event) =>
              updateParameters({
                seed: event.target.value
                  ? integerNumber(event.target.value, pane.parameters.seed ?? 0)
                  : null
              })
            }
          />
        </div>

        <div className="field">
          <label htmlFor={`stop-${pane.id}`}>Stop sequences</label>
          <textarea
            id={`stop-${pane.id}`}
            className="textarea"
            style={{ minHeight: '72px' }}
            value={pane.parameters.stop.join('\n')}
            placeholder="One sequence per line"
            onChange={(event) =>
              updateParameters({
                stop: event.target.value
                  .split(/\r?\n/)
                  .map((item) => item.trim())
                  .filter(Boolean)
              })
            }
          />
        </div>

        <div className="field span-2">
          <div className="field-label-row">
            <label htmlFor={`extra-${pane.id}`}>Custom request parameters</label>
            <span className="field-hint">JSON · committed on blur</span>
          </div>
          <textarea
            id={`extra-${pane.id}`}
            className="json-editor"
            value={extraText}
            placeholder={'{\n  "min_p": 0.05,\n  "repetition_penalty": 1.05\n}'}
            spellCheck={false}
            aria-invalid={extraInvalid}
            style={extraInvalid ? { borderColor: 'var(--danger)' } : undefined}
            onChange={(event) => {
              setExtraText(event.target.value)
              setExtraInvalid(false)
            }}
            onBlur={commitExtra}
          />
        </div>
      </div>

      <div className="helper-callout">
        <Gauge size={13} />
        <span>
          Leave provider-specific options in Custom request parameters. Standard request fields
          above always take precedence.
        </span>
      </div>
    </section>
  )

  const renderContext = (): React.JSX.Element => (
    <>
      <section className="section">
        <SectionHeader
          icon={<FileText size={15} />}
          title="System prompt"
          description="The instruction layer applied to every request from this lane."
        />

        <div className="field">
          <div className="field-label-row">
            <label htmlFor={`system-prompt-${pane.id}`}>Instructions</label>
            <button
              type="button"
              className="button compact ghost"
              onClick={() => void importText('prompt')}
            >
              <Import size={12} />
              Import
            </button>
          </div>
          <textarea
            id={`system-prompt-${pane.id}`}
            className="textarea tall"
            value={pane.roleplay.systemPrompt}
            placeholder="Define the character, style, boundaries, and response behavior…"
            onChange={(event) => updateRoleplay({ systemPrompt: event.target.value })}
          />
        </div>

        <div className="helper-callout">
          <Sparkles size={13} />
          <span>
            Supported cast variables: #PLAYER_NAME#, #HERIKA_NAME#, and #NPC_NAME#.
          </span>
        </div>
      </section>

      <section className="section">
        <SectionHeader
          icon={<UserRound size={15} />}
          title="Cast and story context"
          description="Ground the character in a biography and a concrete scene."
        />

        <div className="form-grid">
          <div className="field">
            <label htmlFor={`player-name-${pane.id}`}>Player name</label>
            <input
              id={`player-name-${pane.id}`}
              className="input"
              value={pane.roleplay.playerName}
              placeholder="Player"
              onChange={(event) => updateRoleplay({ playerName: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`npc-name-${pane.id}`}>NPC name</label>
            <input
              id={`npc-name-${pane.id}`}
              className="input"
              value={pane.roleplay.npcName}
              placeholder="Herika"
              onChange={(event) => updateRoleplay({ npcName: event.target.value })}
            />
          </div>

          <div className="field span-2">
            <div className="field-label-row">
              <label htmlFor={`biography-${pane.id}`}>NPC biography</label>
              <span className="field-hint">Facts, voice, motives, relationships</span>
            </div>
            <textarea
              id={`biography-${pane.id}`}
              className="textarea tall"
              value={pane.roleplay.npcBiography}
              placeholder="Describe the character’s history, temperament, speaking style, goals…"
              onChange={(event) => updateRoleplay({ npcBiography: event.target.value })}
            />
            <div className="import-row">
              <span className="import-meta">
                {pane.roleplay.npcBiographySource || 'Typed directly · TXT and CSV supported'}
              </span>
              <button
                type="button"
                className="button compact"
                onClick={() => void importText('biography')}
              >
                <Import size={12} />
                Import biography
              </button>
            </div>
          </div>

          <div className="field span-2">
            <div className="field-label-row">
              <label htmlFor={`scenario-${pane.id}`}>Scenario</label>
              <span className="field-hint">Place, moment, stakes, current goal</span>
            </div>
            <textarea
              id={`scenario-${pane.id}`}
              className="textarea tall"
              value={pane.roleplay.scenario}
              placeholder="Describe where the scene begins and what is happening now…"
              onChange={(event) => updateRoleplay({ scenario: event.target.value })}
            />
            <div className="import-row">
              <span className="import-meta">
                {pane.roleplay.scenarioSource || 'Typed directly · TXT and CSV supported'}
              </span>
              <button
                type="button"
                className="button compact"
                onClick={() => void importText('scenario')}
              >
                <Import size={12} />
                Import scenario
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <SectionHeader
          icon={<Clipboard size={15} />}
          title="Rendered prompt preview"
          description="Exactly how the reusable system context is assembled before chat history."
        />
        <div className="prompt-preview">{renderedPrompt || 'No system context is configured.'}</div>
      </section>
    </>
  )

  const renderMemory = (): React.JSX.Element => {
    const memoryValue = pane.memory?.mode ?? 'global'

    return (
      <section className="section">
        <SectionHeader
          icon={<History size={15} />}
          title="Conversation context"
          description="Choose how much completed dialogue this model receives on its next turn."
        />

        <div className="form-grid single">
          <div className="field">
            <label htmlFor={`memory-mode-${pane.id}`}>Context policy</label>
            <select
              id={`memory-mode-${pane.id}`}
              className="select"
              value={memoryValue}
              onChange={(event) => {
                const mode = event.target.value
                onUpdate({
                  ...pane,
                  memory:
                    mode === 'global'
                      ? null
                      : {
                          mode: mode as MemoryConfig['mode'],
                          maxMessages: pane.memory?.maxMessages ?? globalMemory.maxMessages
                        }
                })
              }}
            >
              <option value="global">Use workspace default — {memoryLabel(globalMemory)}</option>
              <option value="retain-all">Full conversation</option>
              <option value="sliding-window">Recent messages</option>
              <option value="fresh-each-turn">Current message only</option>
            </select>
          </div>

          {pane.memory?.mode === 'sliding-window' && (
            <div className="field">
              <div className="field-label-row">
                <label htmlFor={`memory-size-${pane.id}`}>Messages retained</label>
                <span className="field-hint">Complete user/assistant pairs only</span>
              </div>
              <input
                id={`memory-size-${pane.id}`}
                className="input"
                type="number"
                min={2}
                max={1000}
                step={2}
                value={pane.memory.maxMessages}
                onChange={(event) =>
                  onUpdate({
                    ...pane,
                    memory: {
                      mode: 'sliding-window',
                      maxMessages: Math.max(
                        2,
                        integerNumber(event.target.value, pane.memory?.maxMessages ?? 24)
                      )
                    }
                  })
                }
              />
            </div>
          )}
        </div>

        <div className="connection-state success">
          <Database size={12} />
          <span>
            Effective policy: <strong>{memoryLabel(resolvedMemory)}</strong>
            {pane.memory ? ' · lane override' : ' · workspace default'}
          </span>
        </div>

        <div className="helper-callout">
          <History size={13} />
          <span>
            System prompt, biography, and scenario are always included. Failed, cancelled, and
            partial responses are never added to retained dialogue.
          </span>
        </div>
      </section>
    )
  }

  const renderSetup = (): React.JSX.Element => (
    <div className="setup-view">
      <nav className="inspector-nav" aria-label="Lane setup sections">
        {setupSections.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`segmented-button ${ui.setupSection === section.id ? 'active' : ''}`}
            onClick={() => onUiChange({ setupSection: section.id })}
          >
            {section.label}
          </button>
        ))}
      </nav>

      {ui.setupSection === 'connection' && renderConnection()}
      {ui.setupSection === 'generation' && renderGeneration()}
      {ui.setupSection === 'context' && renderContext()}
      {ui.setupSection === 'memory' && renderMemory()}
    </div>
  )

  const renderChat = (): React.JSX.Element => (
    <div className="conversation-view">
      <div className="message-list" aria-live="polite">
        {annotatedMessages.length ? (
          annotatedMessages.map(({ message, turn, excludedFromMemory }) => (
            <MessageRow
              key={message.id}
              message={message}
              turn={turn}
              speakerName={pane.roleplay.npcName.trim() || pane.name || 'Model'}
              fallbackContext={memoryLabel(resolvedMemory)}
              excludedFromMemory={excludedFromMemory}
              onDelete={() =>
                setConfirmation({
                  kind: 'delete-message',
                  messageId: message.id,
                  messageKind: message.role === 'user' ? 'message' : 'response'
                })
              }
              notify={notify}
            />
          ))
        ) : (
          <div className="empty-chat">
            <div className="empty-chat-inner">
              <div className="empty-orbit">
                <Bot size={23} />
              </div>
              <h3>Ready for a roleplay test</h3>
              <p>
                Send a lane-specific message below, or include this lane in a shared broadcast
                to compare identical prompts.
              </p>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="lane-composer">
        <div className="composer-box">
          <textarea
            value={ui.draft}
            placeholder={`Message ${pane.roleplay.npcName.trim() || pane.name || 'this model'}…`}
            aria-label={`Message ${pane.name}`}
            onChange={(event) => onUiChange({ draft: event.target.value })}
            onKeyDown={handleComposerKeyDown}
          />
          {streaming ? (
            <button
              type="button"
              className="send-button stop"
              title="Stop generation"
              aria-label="Stop generation"
              onClick={() => void onStop()}
            >
              <Square size={15} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="send-button"
              title="Send · Ctrl+Enter"
              aria-label="Send message"
              disabled={!ui.draft.trim() || !connectionReady}
              onClick={() => void submitDraft()}
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )

  const renderReview = (): React.JSX.Element => {
    const reviewConnection = pane.analysis.enabled
      ? pane.analysis.connection
      : pane.connection

    return (
      <div className="review-view">
        <div className="review-scroll">
          <section className="review-hero">
            <div className="review-eyebrow">
              <BrainCircuit size={13} />
              Prompt analysis
            </div>
            <h3>Review the latest roleplay turn</h3>
            <p>
              An independent reviewer checks story coherence, biography fidelity, natural
              dialogue, and the system prompt choices that shaped the response.
            </p>
            <button
              type="button"
              className="button primary"
              onClick={() => void runReview()}
              disabled={!latestExchange || ui.reviewRunning || streaming}
            >
              {ui.reviewRunning ? (
                <>
                  <LoaderCircle size={14} className="spinner" />
                  Analyzing
                </>
              ) : (
                <>
                  <Play size={14} />
                  Analyze latest turn
                </>
              )}
            </button>
            {!latestExchange && (
              <p style={{ margin: '9px 0 0', color: 'var(--faint)' }}>
                Complete one user/model exchange before running a review.
              </p>
            )}
            {ui.reviewError && (
              <div className="connection-state error" role="alert">
                <X size={12} />
                <span>{ui.reviewError}</span>
              </div>
            )}
          </section>

          <section className="section" style={{ marginTop: '13px' }}>
            <SectionHeader
              icon={<Settings2 size={15} />}
              title="Reviewer profile"
              description="Use the tested model or isolate evaluation on another endpoint."
            />

            <Toggle
              checked={pane.analysis.enabled}
              label="Use a separate endpoint, key, model, and reviewer parameters"
              onChange={(enabled) => updateAnalysis({ enabled })}
            />

            {!pane.analysis.enabled ? (
              <div className="connection-state success">
                <Check size={12} />
                <span>
                  Using {pane.connection.modelId || 'the lane model'} at{' '}
                  {pane.connection.baseUrl || 'the lane endpoint'}.
                </span>
              </div>
            ) : (
              <div className="form-grid" style={{ marginTop: '12px' }}>
                <div className="field span-2">
                  <label htmlFor={`review-url-${pane.id}`}>Reviewer API base URL</label>
                  <input
                    id={`review-url-${pane.id}`}
                    className="input"
                    value={pane.analysis.connection.baseUrl}
                    placeholder="https://provider.example/v1"
                    spellCheck={false}
                    onChange={(event) => changeReviewerBaseUrl(event.target.value)}
                  />
                </div>

                <div className="field span-2">
                  <div className="field-label-row">
                    <label htmlFor={`review-key-${pane.id}`}>Reviewer API key</label>
                    <span className="field-hint">
                      {pane.analysis.connection.credentialId ? 'Stored securely' : 'OS vault'}
                    </span>
                  </div>
                  <input
                    id={`review-key-${pane.id}`}
                    className="input"
                    type="password"
                    value={pane.analysis.connection.apiKey ?? ''}
                    placeholder={
                      pane.analysis.connection.credentialId
                        ? 'Saved — type here to replace'
                        : 'Optional for local providers'
                    }
                    autoComplete="new-password"
                    spellCheck={false}
                    onChange={(event) => {
                      const apiKey = event.target.value || undefined
                      updateAnalysisConnection({
                        apiKey,
                        ...(apiKey ? { credentialId: undefined } : {})
                      })
                    }}
                  />
                  {(pane.analysis.connection.credentialId ||
                    pane.analysis.connection.apiKey) && (
                    <button
                      type="button"
                      className="button compact"
                      onClick={() => {
                        reviewerCredentialOriginRef.current = undefined
                        updateAnalysisConnection({
                          apiKey: undefined,
                          credentialId: undefined
                        })
                        notify?.('Reviewer API key detached from this lane.', 'success')
                      }}
                    >
                      <KeyRound size={12} />
                      Detach key
                    </button>
                  )}
                </div>

                <div className="field">
                  <label htmlFor={`review-model-${pane.id}`}>Reviewer model</label>
                  <input
                    id={`review-model-${pane.id}`}
                    className="input"
                    value={pane.analysis.connection.modelId}
                    placeholder="Model ID"
                    spellCheck={false}
                    onChange={(event) =>
                      updateAnalysisConnection({ modelId: event.target.value })
                    }
                  />
                </div>

                <div className="field">
                  <label htmlFor={`review-timeout-${pane.id}`}>Timeout (seconds)</label>
                  <input
                    id={`review-timeout-${pane.id}`}
                    className="input"
                    type="number"
                    min={5}
                    max={1800}
                    value={Math.round(pane.analysis.connection.timeoutMs / 1000)}
                    onChange={(event) =>
                      updateAnalysisConnection({
                        timeoutMs: Math.max(
                          5_000,
                          integerNumber(
                            event.target.value,
                            pane.analysis.connection.timeoutMs / 1000
                          ) * 1000
                        )
                      })
                    }
                  />
                </div>

                <div className="field span-2">
                  <div className="field-label-row">
                    <label htmlFor={`review-headers-${pane.id}`}>Reviewer custom headers</label>
                    <span className="field-hint">JSON · non-secret values</span>
                  </div>
                  <textarea
                    id={`review-headers-${pane.id}`}
                    className="json-editor"
                    value={reviewHeadersText}
                    placeholder="{}"
                    spellCheck={false}
                    aria-invalid={reviewHeadersInvalid}
                    style={reviewHeadersInvalid ? { borderColor: 'var(--danger)' } : undefined}
                    onChange={(event) => {
                      setReviewHeadersText(event.target.value)
                      setReviewHeadersInvalid(false)
                    }}
                    onBlur={commitReviewHeaders}
                  />
                </div>
              </div>
            )}
          </section>

          <section className="section">
            <SectionHeader
              icon={<Gauge size={15} />}
              title="Reviewer behavior"
              description={
                pane.analysis.enabled
                  ? 'Low-variance settings keep critique consistent across repeated tests.'
                  : 'Saved here for whenever the separate reviewer profile is enabled.'
              }
            />

            <div className="form-grid">
              <div className="field">
                <label htmlFor={`review-temperature-${pane.id}`}>Temperature</label>
                <input
                  id={`review-temperature-${pane.id}`}
                  className="input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.05}
                  value={pane.analysis.parameters.temperature}
                  onChange={(event) =>
                    updateAnalysisParameters({
                      temperature: finiteNumber(
                        event.target.value,
                        pane.analysis.parameters.temperature
                      )
                    })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor={`review-top-p-${pane.id}`}>Top P</label>
                <input
                  id={`review-top-p-${pane.id}`}
                  className="input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={pane.analysis.parameters.topP}
                  onChange={(event) =>
                    updateAnalysisParameters({
                      topP: finiteNumber(event.target.value, pane.analysis.parameters.topP)
                    })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor={`review-top-k-${pane.id}`}>Top K</label>
                <input
                  id={`review-top-k-${pane.id}`}
                  className="input"
                  type="number"
                  min={0}
                  max={1_000_000}
                  step={1}
                  value={pane.analysis.parameters.topK ?? ''}
                  placeholder="Not sent"
                  onChange={(event) =>
                    updateAnalysisParameters({
                      topK: event.target.value
                        ? Math.max(
                            0,
                            integerNumber(
                              event.target.value,
                              pane.analysis.parameters.topK ?? 0
                            )
                          )
                        : null
                    })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor={`review-reasoning-mode-${pane.id}`}>Reasoning</label>
                <select
                  id={`review-reasoning-mode-${pane.id}`}
                  className="select"
                  value={reasoningMode(pane.analysis.parameters.reasoning)}
                  onChange={(event) =>
                    updateAnalysisParameters({
                      reasoning: reasoningForMode(
                        pane.analysis.parameters.reasoning,
                        event.target.value as ReasoningMode
                      )
                    })
                  }
                >
                  <option value="omit">Do not send</option>
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor={`review-reasoning-effort-${pane.id}`}>
                  Reasoning effort
                </label>
                <select
                  id={`review-reasoning-effort-${pane.id}`}
                  className="select"
                  value={pane.analysis.parameters.reasoning?.effort ?? 'low'}
                  disabled={!pane.analysis.parameters.reasoning}
                  onChange={(event) => {
                    if (!pane.analysis.parameters.reasoning) return
                    updateAnalysisParameters({
                      reasoning: {
                        ...pane.analysis.parameters.reasoning,
                        effort: event.target.value as NonNullable<
                          GenerationParameters['reasoning']
                        >['effort']
                      }
                    })
                  }}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">Extra high</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor={`review-reasoning-exclude-${pane.id}`}>
                  Exclude reasoning output
                </label>
                <select
                  id={`review-reasoning-exclude-${pane.id}`}
                  className="select"
                  value={String(pane.analysis.parameters.reasoning?.exclude ?? false)}
                  disabled={!pane.analysis.parameters.reasoning}
                  onChange={(event) => {
                    if (!pane.analysis.parameters.reasoning) return
                    updateAnalysisParameters({
                      reasoning: {
                        ...pane.analysis.parameters.reasoning,
                        exclude: event.target.value === 'true'
                      }
                    })
                  }}
                >
                  <option value="false">False</option>
                  <option value="true">True</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor={`review-max-tokens-${pane.id}`}>Maximum output tokens</label>
                <input
                  id={`review-max-tokens-${pane.id}`}
                  className="input"
                  type="number"
                  min={1}
                  value={pane.analysis.parameters.maxOutputTokens}
                  onChange={(event) =>
                    updateAnalysisParameters({
                      maxOutputTokens: Math.max(
                        1,
                        integerNumber(
                          event.target.value,
                          pane.analysis.parameters.maxOutputTokens
                        )
                      )
                    })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor={`review-seed-${pane.id}`}>Seed</label>
                <input
                  id={`review-seed-${pane.id}`}
                  className="input"
                  type="number"
                  value={pane.analysis.parameters.seed ?? ''}
                  placeholder="Random"
                  onChange={(event) =>
                    updateAnalysisParameters({
                      seed: event.target.value
                        ? integerNumber(event.target.value, pane.analysis.parameters.seed ?? 0)
                        : null
                    })
                  }
                />
              </div>

              <div className="field span-2">
                <div className="field-label-row">
                  <label htmlFor={`review-extra-${pane.id}`}>Custom reviewer parameters</label>
                  <span className="field-hint">JSON · committed on blur</span>
                </div>
                <textarea
                  id={`review-extra-${pane.id}`}
                  className="json-editor"
                  value={reviewExtraText}
                  placeholder="{}"
                  spellCheck={false}
                  aria-invalid={reviewExtraInvalid}
                  style={reviewExtraInvalid ? { borderColor: 'var(--danger)' } : undefined}
                  onChange={(event) => {
                    setReviewExtraText(event.target.value)
                    setReviewExtraInvalid(false)
                  }}
                  onBlur={commitReviewExtra}
                />
              </div>

              <div className="field span-2">
                <div className="field-label-row">
                  <label htmlFor={`review-instructions-${pane.id}`}>Review instructions</label>
                  <span className="field-hint">Added to the protected reviewer rubric</span>
                </div>
                <textarea
                  id={`review-instructions-${pane.id}`}
                  className="textarea tall"
                  value={pane.analysis.instructions}
                  placeholder="Describe what the reviewer should prioritize…"
                  onChange={(event) => updateAnalysis({ instructions: event.target.value })}
                />
              </div>
            </div>
          </section>

          {ui.reviewText ? (
            <div className="review-report">
              {scores.length > 0 && (
                <div className="score-grid">
                  {scores.map((score) => (
                    <div className="score-card" key={score.label}>
                      <strong>{score.score}</strong>
                      <span>{score.label}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="analysis-output">
                <div className="message-footer" style={{ marginBottom: '9px' }}>
                  <BrainCircuit size={12} />
                  <span>
                    Latest report
                    {latestExchange
                      ? ` · ${formatTimestamp(latestExchange.assistant.createdAt)}`
                      : ''}
                  </span>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="copy-action"
                    onClick={() =>
                      void copyToClipboard(ui.reviewText, notify, 'Review report copied.')
                    }
                  >
                    <Copy size={11} />
                    Copy
                  </button>
                </div>
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{ui.reviewText}</ReactMarkdown>
                </div>
              </div>
            </div>
          ) : (
            <div className="review-empty">
              <div>
                <BrainCircuit size={24} style={{ marginBottom: '9px' }} />
                <div>No review report yet.</div>
              </div>
            </div>
          )}

          {pane.analysis.enabled && (
            <div className="connection-state" style={{ marginBottom: '2px' }}>
              <Network size={12} />
              <span>
                Reviewer: {reviewConnection.modelId || 'model not selected'} ·{' '}
                {reviewConnection.baseUrl || 'endpoint not configured'}
              </span>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <section
      className={`model-lane${active ? ' active' : ''}`}
      style={laneStyle}
      aria-label={`${pane.name || `Model ${index + 1}`} comparison lane`}
      aria-current={active ? 'true' : undefined}
      onPointerDown={onActivate}
      onFocusCapture={onActivate}
    >
      <header className="lane-header">
        <button
          type="button"
          className={`broadcast-check ${ui.includeInBroadcast ? 'checked' : ''}`}
          aria-label={
            ui.includeInBroadcast ? 'Exclude from shared sends' : 'Include in shared sends'
          }
          aria-pressed={ui.includeInBroadcast}
          title={ui.includeInBroadcast ? 'Included in shared sends' : 'Excluded from shared sends'}
          onClick={() =>
            onUiChange({ includeInBroadcast: !ui.includeInBroadcast })
          }
        >
          <Check size={12} strokeWidth={3} />
        </button>

        <div className="lane-identity">
          <input
            className="lane-name-input"
            value={pane.name}
            aria-label="Lane name"
            onChange={(event) => onUpdate({ ...pane, name: event.target.value })}
            onBlur={() => {
              if (!pane.name.trim()) onUpdate({ ...pane, name: `Model ${index + 1}` })
            }}
          />
          <div className="lane-meta">
            <span className={`status-dot ${status}`} />
            <span>{statusLabel}</span>
            <span>·</span>
            <span className="lane-model-name">
              {pane.connection.modelId || 'No model selected'}
            </span>
          </div>
        </div>

        <div className="lane-actions">
          <button
            type="button"
            className="icon-button"
            title="Duplicate to the right"
            aria-label="Duplicate lane to the right"
            onClick={() => onClone('right')}
          >
            <Copy size={14} />
          </button>

          <div className="menu-wrap" ref={menuRef}>
            <button
              type="button"
              className={`icon-button ${menuOpen ? 'selected' : ''}`}
              title="Lane actions"
              aria-label="Open lane actions"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={16} />
            </button>

            {menuOpen && (
              <div className="menu" role="menu">
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onClone('left')
                  }}
                >
                  <Copy size={13} />
                  Duplicate to left
                </button>
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onClone('right')
                  }}
                >
                  <Copy size={13} />
                  Duplicate to right
                </button>
                <div className="menu-separator" />
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  disabled={index === 0}
                  onClick={() => {
                    setMenuOpen(false)
                    onMove('left')
                  }}
                >
                  <ArrowLeft size={13} />
                  Move left
                </button>
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  disabled={index >= total - 1}
                  onClick={() => {
                    setMenuOpen(false)
                    onMove('right')
                  }}
                >
                  <ArrowRight size={13} />
                  Move right
                </button>
                <div className="menu-separator" />
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  disabled={!pane.messages.length}
                  onClick={confirmClear}
                >
                  <Trash2 size={13} />
                  Clear conversation
                </button>
                <button
                  type="button"
                  className="menu-item danger"
                  role="menuitem"
                  disabled={total <= 1}
                  onClick={confirmRemove}
                >
                  <X size={13} />
                  Close lane
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="lane-tabs" aria-label={`${pane.name} views`}>
        <button
          type="button"
          className={`tab-button ${ui.tab === 'chat' ? 'active' : ''}`}
          onClick={() => onUiChange({ tab: 'chat' })}
        >
          <MessageSquare size={13} />
          Chat
        </button>
        <button
          type="button"
          className={`tab-button ${ui.tab === 'review' ? 'active' : ''}`}
          onClick={() => onUiChange({ tab: 'review' })}
        >
          <BrainCircuit size={13} />
          Prompt review
        </button>
        <button
          type="button"
          className={`tab-button ${ui.tab === 'setup' ? 'active' : ''}`}
          onClick={() => onUiChange({ tab: 'setup' })}
        >
          <Settings2 size={13} />
          Setup
        </button>
      </nav>

      <div className="lane-content">
        {ui.tab === 'chat' && renderChat()}
        {ui.tab === 'review' && renderReview()}
        {ui.tab === 'setup' && renderSetup()}
      </div>

      {confirmation && confirmationDetails && (
        <ConfirmationModal
          id={`lane-confirmation-${pane.id}`}
          title={confirmationDetails.title}
          description={confirmationDetails.description}
          confirmLabel={confirmationDetails.confirmLabel}
          onCancel={() => setConfirmation(null)}
          onConfirm={applyConfirmation}
        />
      )}
    </section>
  )
}

function modelLanePropsEqual(
  previous: ModelLaneProps,
  next: ModelLaneProps
): boolean {
  return (
    previous.pane === next.pane &&
    previous.index === next.index &&
    previous.total === next.total &&
    previous.globalMemory === next.globalMemory &&
    previous.active === next.active &&
    previous.ui === next.ui &&
    previous.notify === next.notify
  )
}

export const ModelLane = memo(ModelLaneComponent, modelLanePropsEqual)

export default ModelLane
