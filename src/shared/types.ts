/**
 * Types shared by the isolated renderer, preload bridge, and Electron main process.
 *
 * Secrets are intentionally optional on ConnectionConfig. A freshly typed apiKey may
 * cross the bridge once; the main process replaces it with an opaque credentialId
 * before persisting the workspace. Loaded workspaces never contain a raw API key.
 */

export const WORKSPACE_SCHEMA_VERSION = 2 as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface ConnectionConfig {
  /** API root, normally ending in `/v1` (for example https://api.openai.com/v1). */
  baseUrl: string
  modelId: string
  /**
   * Ephemeral value accepted from a password input. It is never written to the
   * workspace file or returned by workspace.load().
   */
  apiKey?: string
  /** Opaque key used by the main-process encrypted credential vault. */
  credentialId?: string
  /** Additional non-secret provider headers. Authorization-like names are rejected. */
  customHeaders: Record<string, string>
  timeoutMs: number
}

export type MaxTokenField = 'max_tokens' | 'max_completion_tokens' | 'omit'

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export interface ReasoningParameters {
  enabled: boolean
  exclude: boolean
  effort: ReasoningEffort
}

export interface GenerationParameters {
  temperature: number
  topP: number
  /** Provider-specific Top K sampling. null omits `top_k` from the request. */
  topK: number | null
  /** null omits the structured `reasoning` object from the request. */
  reasoning: ReasoningParameters | null
  maxOutputTokens: number
  maxTokenField: MaxTokenField
  presencePenalty: number
  frequencyPenalty: number
  seed: number | null
  stop: string[]
  /** Provider-specific JSON fields. Reserved chat-completion fields are rejected. */
  extra: Record<string, JsonValue>
}

export type MemoryMode = 'retain-all' | 'sliding-window' | 'fresh-each-turn'

export interface MemoryConfig {
  mode: MemoryMode
  /** Used only by sliding-window mode. */
  maxMessages: number
}

export interface RoleplayContext {
  systemPrompt: string
  playerName: string
  npcName: string
  npcBiography: string
  npcBiographySource?: string
  scenario: string
  scenarioSource?: string
}

export type ConversationRole = 'system' | 'developer' | 'user' | 'assistant'

/**
 * Non-secret identity and rendered prompt data captured when a comparison turn
 * is sent. This keeps historical reviews tied to the configuration that
 * actually produced a response, even after a pane is renamed or reconfigured.
 */
export interface ComparisonTurnSnapshot {
  laneName: string
  modelId: string
  renderedSystemPrompt: string
  renderedUserMessage: string
}

export interface ConversationMessage {
  id: string
  role: ConversationRole
  content: string
  createdAt: string
  requestId?: string
  batchId?: string
  finishReason?: string
  usage?: TokenUsage
  latencyMs?: number
  contextLabel?: string
  /** True while a streamed assistant response is still arriving. */
  pending?: boolean
  /** Populated when a provider request failed after a partial response. */
  error?: string
  /** Present on comparison responses created by schema-v2 workspaces. */
  comparisonSnapshot?: ComparisonTurnSnapshot
}

export interface PromptAnalysisConfig {
  enabled: boolean
  connection: ConnectionConfig
  parameters: GenerationParameters
  instructions: string
}

export interface GlobalReviewerConfig {
  connection: ConnectionConfig
  parameters: GenerationParameters
  priorities: string
}

export interface TestPaneConfig {
  id: string
  name: string
  connection: ConnectionConfig
  parameters: GenerationParameters
  roleplay: RoleplayContext
  /** null means use the workspace-wide memory policy. */
  memory: MemoryConfig | null
  analysis: PromptAnalysisConfig
  messages: ConversationMessage[]
}

export interface WorkspaceSettings {
  loggingEnabled: boolean
  sendToAllByDefault: boolean
}

export interface AppWorkspace {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION
  name: string
  createdAt: string
  updatedAt: string
  globalMemory: MemoryConfig
  globalReviewer: GlobalReviewerConfig
  settings: WorkspaceSettings
  panes: TestPaneConfig[]
  selectedPaneId: string
}

export interface AppError {
  code: string
  message: string
  retryable: boolean
  httpStatus?: number
  providerMessage?: string
  requestId?: string
  retryAfterMs?: number
}

export interface ProviderModel {
  id: string
  ownedBy?: string
  created?: number
}

export interface ModelListResult {
  models: ProviderModel[]
  fetchedAt: string
}

export interface ChatRequestMessage {
  role: ConversationRole
  content: string
  name?: string
}

export interface ChatStartRequest {
  /** Renderer-generated so the optimistic assistant message can be correlated. */
  requestId: string
  paneId: string
  batchId?: string
  connection: ConnectionConfig
  parameters: GenerationParameters
  messages: ChatRequestMessage[]
  /** Friendly pane label used only in human-readable logs. */
  logLabel?: string
}

export interface ChatStartResult {
  requestId: string
  acceptedAt: string
}

export interface ChatCancelRequest {
  requestId: string
}

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export type ChatEvent =
  | {
      type: 'delta'
      requestId: string
      paneId: string
      delta: string
      /** Full accumulated assistant text, including this delta. */
      text: string
      emittedAt: string
    }
  | {
      type: 'done'
      requestId: string
      paneId: string
      text: string
      finishReason?: string
      usage?: TokenUsage
      emittedAt: string
    }
  | {
      type: 'error'
      requestId: string
      paneId: string
      /** Partial text is preserved when a stream fails. */
      text: string
      error: AppError
      emittedAt: string
    }
  | {
      type: 'cancelled'
      requestId: string
      paneId: string
      /** Partial text is preserved when a request is cancelled. */
      text: string
      emittedAt: string
    }

export interface WorkspaceLoadResult {
  workspace: AppWorkspace
  warnings: string[]
  /** Whether persistent OS-backed secret encryption is currently available. */
  secretsAvailable: boolean
}

export interface WorkspaceSaveResult {
  /** Sanitized copy that contains credential IDs in place of freshly typed keys. */
  workspace: AppWorkspace
  savedAt: string
  secretsPersisted: boolean
  warnings: string[]
}

export interface CredentialSaveRequest {
  credentialId?: string
  value: string
}

export interface CredentialSaveResult {
  credentialId: string
  persisted: boolean
}

export interface CredentialReference {
  credentialId: string
}

export interface CredentialStatus {
  credentialId: string
  available: boolean
  persisted: boolean
}

export type ImportKind = 'biography' | 'scenario' | 'prompt'

export interface FileImportRequest {
  kind: ImportKind
}

export interface FileImportResult {
  cancelled: boolean
  fileName?: string
  filePath?: string
  format?: 'csv' | 'text'
  content?: string
  /** Parsed rows are included for CSV files; content always retains the original. */
  rows?: string[][]
}

export interface ReportExportRequest {
  suggestedFileName: string
  content: string
}

export interface ReportExportResult {
  cancelled: boolean
  filePath?: string
}

export interface WorkspaceImportResult {
  cancelled: boolean
  workspace?: AppWorkspace
  filePath?: string
  warnings: string[]
}

export interface WorkspaceExportResult {
  cancelled: boolean
  filePath?: string
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  workspacePath: string
  logsPath: string
  secretStorageAvailable: boolean
}

export interface RpCompareApi {
  app: {
    getInfo(): Promise<AppInfo>
    onBeforeClose(listener: () => void): () => void
    readyToClose(saved: boolean): void
  }
  credentials: {
    save(request: CredentialSaveRequest): Promise<CredentialSaveResult>
    delete(request: CredentialReference): Promise<boolean>
    status(request: CredentialReference): Promise<CredentialStatus>
  }
  workspace: {
    load(): Promise<WorkspaceLoadResult>
    save(workspace: AppWorkspace): Promise<WorkspaceSaveResult>
    import(): Promise<WorkspaceImportResult>
    export(workspace: AppWorkspace): Promise<WorkspaceExportResult>
  }
  models: {
    list(connection: ConnectionConfig): Promise<ModelListResult>
  }
  chat: {
    start(request: ChatStartRequest): Promise<ChatStartResult>
    cancel(request: ChatCancelRequest): Promise<boolean>
    onEvent(listener: (event: ChatEvent) => void): () => void
  }
  files: {
    importText(request: FileImportRequest): Promise<FileImportResult>
    exportReport(request: ReportExportRequest): Promise<ReportExportResult>
  }
  logs: {
    setEnabled(enabled: boolean): Promise<boolean>
    reveal(): Promise<void>
  }
}

export const IPC_CHANNELS = {
  appInfo: 'rp-compare:app:info',
  appBeforeClose: 'rp-compare:app:before-close',
  appCloseReady: 'rp-compare:app:close-ready',
  credentialSave: 'rp-compare:credentials:save',
  credentialDelete: 'rp-compare:credentials:delete',
  credentialStatus: 'rp-compare:credentials:status',
  workspaceLoad: 'rp-compare:workspace:load',
  workspaceSave: 'rp-compare:workspace:save',
  workspaceImport: 'rp-compare:workspace:import',
  workspaceExport: 'rp-compare:workspace:export',
  modelsList: 'rp-compare:models:list',
  chatStart: 'rp-compare:chat:start',
  chatCancel: 'rp-compare:chat:cancel',
  chatEvent: 'rp-compare:chat:event',
  fileImport: 'rp-compare:files:import',
  reportExport: 'rp-compare:files:export-report',
  logsSetEnabled: 'rp-compare:logs:set-enabled',
  logsReveal: 'rp-compare:logs:reveal'
} as const
