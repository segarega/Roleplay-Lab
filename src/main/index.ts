import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type WebContents
} from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import {
  createDefaultAnalysisConfig,
  createDefaultConnection,
  createDefaultGlobalReviewerConfig,
  createDefaultPane,
  createDefaultParameters,
  createDefaultWorkspace
} from '../shared/defaults'
import {
  IPC_CHANNELS,
  WORKSPACE_SCHEMA_VERSION,
  type AppError,
  type AppWorkspace,
  type ChatEvent,
  type ChatRequestMessage,
  type ChatStartRequest,
  type ComparisonTurnSnapshot,
  type ConnectionConfig,
  type ConversationMessage,
  type CredentialSaveResult,
  type FileImportRequest,
  type FileImportResult,
  type GenerationParameters,
  type JsonValue,
  type ModelListResult,
  type ProviderModel,
  type ReportExportResult,
  type ReasoningEffort,
  type ReasoningParameters,
  type TestPaneConfig,
  type TokenUsage,
  type WorkspaceExportResult,
  type WorkspaceImportResult,
  type WorkspaceLoadResult,
  type WorkspaceSaveResult
} from '../shared/types'

// Roleplay Lab's interface is regular DOM/CSS and does not require WebGL or
// GPU compute. Keep Chromium on its software-rendering path by default so a
// browser GPU-process fault cannot destabilize the display driver. These must
// be applied before app readiness and before any BrowserWindow is created.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-gpu-rasterization')
app.commandLine.appendSwitch('disable-webgl')

const MAX_WORKSPACE_BYTES = 25 * 1024 * 1024
const MAX_IMPORT_BYTES = 8 * 1024 * 1024
const MAX_REPORT_BYTES = 8 * 1024 * 1024
const MAX_PROVIDER_BODY_BYTES = 2 * 1024 * 1024
const MIN_TIMEOUT_MS = 2_000
const MAX_TIMEOUT_MS = 10 * 60_000
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey'
])
const RESERVED_COMPLETION_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'reasoning',
  'max_tokens',
  'max_completion_tokens',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'stop'
])

interface StoredCredentialVault {
  version: 1
  entries: Record<string, string>
}

interface WorkspaceEnvelope {
  format: 'roleplay-lab-workspace'
  version: 1
  exportedAt: string
  workspace: AppWorkspace
}

interface ActiveChat {
  key: string
  request: ChatStartRequest
  sender: WebContents
  controller: AbortController
  abortKind?: 'user' | 'timeout' | 'shutdown'
  text: string
  finishReason?: string
  usage?: TokenUsage
  startedAt: number
  loggingEnabled: boolean
  completion?: Promise<void>
}

class BackendError extends Error {
  readonly detail: AppError

  constructor(detail: AppError) {
    super(detail.message)
    this.name = 'BackendError'
    this.detail = detail
  }
}

const sessionCredentials = new Map<string, string>()
const activeChats = new Map<string, ActiveChat>()
const watchedWebContents = new Set<number>()
const windowsReadyToClose = new WeakSet<BrowserWindow>()
const closeFallbackTimers = new WeakMap<BrowserWindow, ReturnType<typeof setTimeout>>()
let credentialEntries: Record<string, string> = {}
let credentialLoadPromise: Promise<void> | undefined
let credentialWriteChain: Promise<void> = Promise.resolve()
let workspaceWriteChain: Promise<void> = Promise.resolve()
let logWriteChain: Promise<void> = Promise.resolve()
let loggingEnabled = false
let ipcRegistered = false

function workspaceFilePath(): string {
  return join(app.getPath('userData'), 'workspace.json')
}

function credentialFilePath(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

function logsDirectoryPath(): string {
  return join(app.getPath('userData'), 'logs')
}

function clearCloseFallback(window: BrowserWindow): void {
  const timer = closeFallbackTimers.get(window)
  if (timer) clearTimeout(timer)
  closeFallbackTimers.delete(window)
}

function armCloseFallback(window: BrowserWindow): void {
  clearCloseFallback(window)
  const timer = setTimeout(() => {
    if (window.isDestroyed()) return
    windowsReadyToClose.add(window)
    window.close()
  }, 15_000)
  timer.unref()
  closeFallbackTimers.set(window, timer)
}

async function waitBounded(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([
    operation.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      timer.unref()
    })
  ])
}

async function finalizeWindowClose(window: BrowserWindow, sender: WebContents): Promise<void> {
  const completions: Promise<void>[] = []
  for (const active of activeChats.values()) {
    if (active.sender.id !== sender.id) continue
    active.abortKind = 'shutdown'
    active.controller.abort()
    if (active.completion) completions.push(active.completion)
  }
  if (completions.length) {
    await waitBounded(Promise.allSettled(completions), 3_000)
  }
  await waitBounded(logWriteChain, 2_000)
  if (window.isDestroyed()) return
  windowsReadyToClose.add(window)
  window.close()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = '', maxLength = 1_000_000): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback
}

function optionalString(value: unknown, maxLength = 1_000_000): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : undefined
}

function finiteNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

function integerValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Math.round(finiteNumber(value, fallback, minimum, maximum))
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function isSensitiveHeaderName(name: string): boolean {
  const lowercase = name.toLowerCase()
  const compact = lowercase.replace(/[^a-z0-9]/g, '')
  return (
    SENSITIVE_HEADER_NAMES.has(lowercase) ||
    compact.includes('authorization') ||
    compact.includes('apikey') ||
    compact.includes('accesstoken') ||
    compact.includes('authtoken') ||
    compact.includes('credential') ||
    compact.includes('secret')
  )
}

function cleanJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) {
    throw backendError('INVALID_CONFIGURATION', 'Provider-specific parameters are nested too deeply.')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw backendError('INVALID_CONFIGURATION', 'Provider-specific parameters contain a non-finite number.')
    }
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) {
      throw backendError('INVALID_CONFIGURATION', 'A provider-specific parameter array is too large.')
    }
    return value.map((item) => cleanJsonValue(item, depth + 1))
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
    if (entries.length > 500) {
      throw backendError('INVALID_CONFIGURATION', 'Provider-specific parameters contain too many fields.')
    }
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of entries) {
      result[key.slice(0, 200)] = cleanJsonValue(item, depth + 1)
    }
    return result
  }
  throw backendError('INVALID_CONFIGURATION', 'Provider-specific parameters must be valid JSON.')
}

function normalizeConnection(
  value: unknown,
  warnings: string[],
  label: string
): ConnectionConfig {
  const source = isRecord(value) ? value : {}
  const defaults = createDefaultConnection()
  const customHeaders: Record<string, string> = {}
  if (isRecord(source.customHeaders)) {
    for (const [rawName, rawValue] of Object.entries(source.customHeaders).slice(0, 64)) {
      const name = rawName.trim()
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || typeof rawValue !== 'string') {
        warnings.push(`${label}: ignored an invalid custom header.`)
        continue
      }
      if (isSensitiveHeaderName(name)) {
        warnings.push(`${label}: ignored ${name}; enter credentials in the API key field instead.`)
        continue
      }
      if (/[\r\n]/.test(rawValue)) {
        warnings.push(`${label}: ignored ${name} because its value contains a line break.`)
        continue
      }
      customHeaders[name] = rawValue.slice(0, 8_192)
    }
  }

  const credentialId = optionalString(source.credentialId, 128)
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey.slice(0, 65_536) : undefined
  return {
    baseUrl: stringValue(source.baseUrl, defaults.baseUrl, 4_096).trim(),
    modelId: stringValue(source.modelId, defaults.modelId, 1_024).trim(),
    ...(apiKey ? { apiKey } : {}),
    ...(credentialId ? { credentialId } : {}),
    customHeaders,
    timeoutMs: integerValue(
      source.timeoutMs,
      defaults.timeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    )
  }
}

function normalizeParameters(value: unknown): GenerationParameters {
  const source = isRecord(value) ? value : {}
  const defaults = createDefaultParameters()
  const rawStop = Array.isArray(source.stop) ? source.stop : defaults.stop
  const stop = rawStop
    .filter((item): item is string => typeof item === 'string')
    .slice(0, 32)
    .map((item) => item.slice(0, 2_048))
  const maxTokenField =
    source.maxTokenField === 'max_completion_tokens' ||
    source.maxTokenField === 'omit' ||
    source.maxTokenField === 'max_tokens'
      ? source.maxTokenField
      : defaults.maxTokenField
  const extra = isRecord(source.extra)
    ? (cleanJsonValue(source.extra) as Record<string, JsonValue>)
    : {}
  const reasoning = normalizeReasoningParameters(source.reasoning)

  return {
    temperature: finiteNumber(source.temperature, defaults.temperature, 0, 5),
    topP: finiteNumber(source.topP, defaults.topP, 0, 1),
    topK:
      source.topK === null || source.topK === undefined
        ? null
        : integerValue(source.topK, 0, 0, 1_000_000),
    reasoning,
    maxOutputTokens: integerValue(
      source.maxOutputTokens,
      defaults.maxOutputTokens,
      1,
      2_000_000
    ),
    maxTokenField,
    presencePenalty: finiteNumber(source.presencePenalty, defaults.presencePenalty, -2, 2),
    frequencyPenalty: finiteNumber(source.frequencyPenalty, defaults.frequencyPenalty, -2, 2),
    seed:
      source.seed === null || source.seed === undefined
        ? null
        : integerValue(source.seed, 0, -2_147_483_648, 2_147_483_647),
    stop,
    extra
  }
}

function normalizeReasoningParameters(value: unknown): ReasoningParameters | null {
  if (!isRecord(value)) return null
  const effort: ReasoningEffort =
    value.effort === 'medium' ||
    value.effort === 'high' ||
    value.effort === 'xhigh' ||
    value.effort === 'low'
      ? value.effort
      : 'low'
  return {
    enabled: booleanValue(value.enabled, true),
    exclude: booleanValue(value.exclude, false),
    effort
  }
}

function normalizeUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const promptTokens = finiteOptionalNumber(value.promptTokens)
  const completionTokens = finiteOptionalNumber(value.completionTokens)
  const totalTokens = finiteOptionalNumber(value.totalTokens)
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined
  }
  return { promptTokens, completionTokens, totalTokens }
}

function finiteOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined
}

function normalizeComparisonTurnSnapshot(value: unknown): ComparisonTurnSnapshot | undefined {
  if (!isRecord(value)) return undefined
  return {
    laneName: stringValue(value.laneName, '', 256),
    modelId: stringValue(value.modelId, '', 1_024),
    renderedSystemPrompt: stringValue(value.renderedSystemPrompt, '', 2_000_000),
    renderedUserMessage: stringValue(value.renderedUserMessage, '', 4_000_000)
  }
}

function normalizeConversationMessage(value: unknown): ConversationMessage | undefined {
  if (!isRecord(value)) return undefined
  const role =
    value.role === 'system' ||
    value.role === 'developer' ||
    value.role === 'user' ||
    value.role === 'assistant'
      ? value.role
      : undefined
  if (!role || typeof value.content !== 'string') return undefined
  return {
    id: stringValue(value.id, randomUUID(), 256),
    role,
    content: value.content.slice(0, 4_000_000),
    createdAt: stringValue(value.createdAt, new Date().toISOString(), 64),
    requestId: optionalString(value.requestId, 128),
    batchId: optionalString(value.batchId, 128),
    finishReason: optionalString(value.finishReason, 128),
    usage: normalizeUsage(value.usage),
    latencyMs: finiteOptionalNumber(value.latencyMs),
    contextLabel: optionalString(value.contextLabel, 512),
    pending: typeof value.pending === 'boolean' ? value.pending : undefined,
    error: optionalString(value.error, 4_096),
    comparisonSnapshot: normalizeComparisonTurnSnapshot(value.comparisonSnapshot)
  }
}

function normalizePane(value: unknown, index: number, warnings: string[]): TestPaneConfig {
  const source = isRecord(value) ? value : {}
  const fallback = createDefaultPane(`pane-${index + 1}`, `Model ${String.fromCharCode(65 + (index % 26))}`)
  const roleplaySource = isRecord(source.roleplay) ? source.roleplay : {}
  const analysisSource = isRecord(source.analysis) ? source.analysis : {}
  const memorySource = isRecord(source.memory) ? source.memory : undefined
  const memoryMode =
    memorySource?.mode === 'retain-all' ||
    memorySource?.mode === 'sliding-window' ||
    memorySource?.mode === 'fresh-each-turn'
      ? memorySource.mode
      : 'retain-all'
  const rawMessages = Array.isArray(source.messages) ? source.messages : []
  if (rawMessages.length > 10_000) {
    warnings.push(`${fallback.name}: retained only the latest 10,000 saved messages.`)
  }
  const messages = rawMessages
    .slice(-10_000)
    .map(normalizeConversationMessage)
    .filter((message): message is ConversationMessage => Boolean(message))

  return {
    id: stringValue(source.id, fallback.id, 256),
    name: stringValue(source.name, fallback.name, 256),
    connection: normalizeConnection(source.connection, warnings, `${fallback.name} connection`),
    parameters: normalizeParameters(source.parameters),
    roleplay: {
      systemPrompt: stringValue(
        roleplaySource.systemPrompt,
        fallback.roleplay.systemPrompt,
        2_000_000
      ),
      playerName: stringValue(roleplaySource.playerName, fallback.roleplay.playerName, 256),
      npcName: stringValue(roleplaySource.npcName, fallback.roleplay.npcName, 256),
      npcBiography: stringValue(roleplaySource.npcBiography, '', 4_000_000),
      npcBiographySource: optionalString(roleplaySource.npcBiographySource, 1_024),
      scenario: stringValue(roleplaySource.scenario, '', 4_000_000),
      scenarioSource: optionalString(roleplaySource.scenarioSource, 1_024)
    },
    memory:
      source.memory === null || source.memory === undefined
        ? null
        : {
            mode: memoryMode,
            maxMessages: integerValue(memorySource?.maxMessages, 24, 1, 10_000)
          },
    analysis: {
      enabled: booleanValue(analysisSource.enabled, false),
      connection: normalizeConnection(
        analysisSource.connection,
        warnings,
        `${fallback.name} analysis connection`
      ),
      parameters: normalizeParameters(
        analysisSource.parameters ?? createDefaultAnalysisConfig().parameters
      ),
      instructions: stringValue(
        analysisSource.instructions,
        createDefaultAnalysisConfig().instructions,
        1_000_000
      )
    },
    messages
  }
}

function normalizeWorkspace(value: unknown, warnings: string[] = []): AppWorkspace {
  if (!isRecord(value)) {
    throw backendError('INVALID_WORKSPACE', 'The workspace is not a JSON object.')
  }
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== 1 &&
    value.schemaVersion !== WORKSPACE_SCHEMA_VERSION
  ) {
    throw backendError(
      'UNSUPPORTED_WORKSPACE',
      `This workspace uses unsupported schema version ${String(value.schemaVersion)}.`
    )
  }
  if (value.schemaVersion === 1) {
    warnings.push('Workspace schema 1 was upgraded to schema 2.')
  }
  const now = new Date().toISOString()
  const rawPanes = Array.isArray(value.panes) ? value.panes : []
  const panes =
    rawPanes.length > 0
      ? rawPanes.slice(0, 100).map((pane, index) => normalizePane(pane, index, warnings))
      : [createDefaultPane()]
  if (rawPanes.length === 0) warnings.push('The workspace had no test panes; a default pane was added.')
  if (rawPanes.length > 100) warnings.push('Only the first 100 test panes were loaded.')

  const usedIds = new Set<string>()
  for (const pane of panes) {
    if (!pane.id || usedIds.has(pane.id)) {
      pane.id = randomUUID()
      warnings.push('A missing or duplicate pane identifier was repaired.')
    }
    usedIds.add(pane.id)
  }
  const globalMemory = isRecord(value.globalMemory) ? value.globalMemory : {}
  const globalReviewerSource = isRecord(value.globalReviewer) ? value.globalReviewer : {}
  const globalReviewerDefaults = createDefaultGlobalReviewerConfig()
  const globalMode =
    globalMemory.mode === 'sliding-window' ||
    globalMemory.mode === 'fresh-each-turn' ||
    globalMemory.mode === 'retain-all'
      ? globalMemory.mode
      : 'retain-all'
  const settings = isRecord(value.settings) ? value.settings : {}
  const selectedPaneId = stringValue(value.selectedPaneId, panes[0].id, 256)

  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name: stringValue(value.name, 'Roleplay comparison', 512),
    createdAt: stringValue(value.createdAt, now, 64),
    updatedAt: stringValue(value.updatedAt, now, 64),
    globalMemory: {
      mode: globalMode,
      maxMessages: integerValue(globalMemory.maxMessages, 24, 1, 10_000)
    },
    globalReviewer: {
      connection: normalizeConnection(
        globalReviewerSource.connection,
        warnings,
        'Global reviewer connection'
      ),
      parameters: normalizeParameters(
        globalReviewerSource.parameters ?? globalReviewerDefaults.parameters
      ),
      priorities: stringValue(
        globalReviewerSource.priorities,
        globalReviewerDefaults.priorities,
        1_000_000
      )
    },
    settings: {
      loggingEnabled: booleanValue(settings.loggingEnabled, false),
      sendToAllByDefault: booleanValue(settings.sendToAllByDefault, true)
    },
    panes,
    selectedPaneId: usedIds.has(selectedPaneId) ? selectedPaneId : panes[0].id
  }
}

function backendError(
  code: string,
  message: string,
  options: Partial<Omit<AppError, 'code' | 'message' | 'retryable'>> & {
    retryable?: boolean
  } = {}
): BackendError {
  return new BackendError({
    code,
    message,
    retryable: options.retryable ?? false,
    httpStatus: options.httpStatus,
    providerMessage: options.providerMessage,
    requestId: options.requestId,
    retryAfterMs: options.retryAfterMs
  })
}

function asAppError(error: unknown, requestId?: string): AppError {
  if (error instanceof BackendError) {
    return { ...error.detail, requestId: error.detail.requestId ?? requestId }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      code: 'REQUEST_ABORTED',
      message: 'The request was aborted.',
      retryable: true,
      requestId
    }
  }
  return {
    code: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message.slice(0, 1_000) : 'An unexpected error occurred.',
    retryable: false,
    requestId
  }
}

function toInvokeError(error: unknown): Error {
  const detail = asAppError(error)
  return new Error(`[${detail.code}] ${detail.message}`)
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function ensureCredentialVaultLoaded(): Promise<void> {
  if (credentialLoadPromise) return credentialLoadPromise
  credentialLoadPromise = (async () => {
    try {
      const raw = await fs.readFile(credentialFilePath(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.entries)) {
        credentialEntries = Object.fromEntries(
          Object.entries(parsed.entries).filter(
            (entry): entry is [string, string] =>
              /^[A-Za-z0-9._:-]{1,128}$/.test(entry[0]) && typeof entry[1] === 'string'
          )
        )
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        console.error('Unable to load the encrypted credential vault.', error)
      }
    }
  })()
  return credentialLoadPromise
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function validCredentialId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
}

async function writeCredentialVault(): Promise<void> {
  const payload: StoredCredentialVault = { version: 1, entries: credentialEntries }
  await atomicWrite(credentialFilePath(), `${JSON.stringify(payload, null, 2)}\n`)
}

async function saveCredential(
  credentialId: string | undefined,
  value: string
): Promise<CredentialSaveResult> {
  if (!value || value.length > 65_536) {
    throw backendError('INVALID_CREDENTIAL', 'Enter a non-empty API key.')
  }
  const id = credentialId && validCredentialId(credentialId) ? credentialId : randomUUID()
  sessionCredentials.set(id, value)
  if (!safeStorage.isEncryptionAvailable()) {
    return { credentialId: id, persisted: false }
  }

  const operation = credentialWriteChain.then(async () => {
    await ensureCredentialVaultLoaded()
    credentialEntries[id] = safeStorage.encryptString(value).toString('base64')
    await writeCredentialVault()
  })
  credentialWriteChain = operation.catch(() => undefined)
  await operation
  return { credentialId: id, persisted: true }
}

async function deleteCredential(credentialId: string): Promise<boolean> {
  if (!validCredentialId(credentialId)) return false
  const existedInSession = sessionCredentials.delete(credentialId)
  const operation = credentialWriteChain.then(async () => {
    await ensureCredentialVaultLoaded()
    const existed = Object.prototype.hasOwnProperty.call(credentialEntries, credentialId)
    if (existed) {
      delete credentialEntries[credentialId]
      await writeCredentialVault()
    }
    return existed
  })
  credentialWriteChain = operation.then(
    () => undefined,
    () => undefined
  )
  return existedInSession || (await operation)
}

async function getCredential(credentialId: string | undefined): Promise<string | undefined> {
  if (!credentialId || !validCredentialId(credentialId)) return undefined
  const inSession = sessionCredentials.get(credentialId)
  if (inSession !== undefined) return inSession
  if (!safeStorage.isEncryptionAvailable()) return undefined
  await credentialWriteChain
  await ensureCredentialVaultLoaded()
  const encrypted = credentialEntries[credentialId]
  if (!encrypted) return undefined
  try {
    const value = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    sessionCredentials.set(credentialId, value)
    return value
  } catch (error) {
    console.error(`Unable to decrypt credential ${credentialId}.`, error)
    return undefined
  }
}

function workspaceConnections(workspace: AppWorkspace): ConnectionConfig[] {
  return [
    workspace.globalReviewer.connection,
    ...workspace.panes.flatMap((pane) => [pane.connection, pane.analysis.connection])
  ]
}

async function pruneUnusedCredentials(workspace: AppWorkspace): Promise<void> {
  const referenced = new Set(
    workspaceConnections(workspace)
      .map((connection) => connection.credentialId)
      .filter((value): value is string => Boolean(value))
  )

  for (const credentialId of sessionCredentials.keys()) {
    if (!referenced.has(credentialId)) sessionCredentials.delete(credentialId)
  }
  if (!safeStorage.isEncryptionAvailable()) return

  const operation = credentialWriteChain.then(async () => {
    await ensureCredentialVaultLoaded()
    let changed = false
    for (const credentialId of Object.keys(credentialEntries)) {
      if (referenced.has(credentialId)) continue
      delete credentialEntries[credentialId]
      changed = true
    }
    if (changed) await writeCredentialVault()
  })
  credentialWriteChain = operation.catch(() => undefined)
  await operation
}

async function vaultWorkspaceSecrets(
  workspace: AppWorkspace,
  warnings: string[]
): Promise<{ workspace: AppWorkspace; persisted: boolean }> {
  let persisted = safeStorage.isEncryptionAvailable()
  for (const connection of workspaceConnections(workspace)) {
    if (connection.apiKey) {
      // Replacing a key is copy-on-write. Cloned lanes may intentionally share a
      // credential reference, and editing one must never mutate the others.
      const result = await saveCredential(undefined, connection.apiKey)
      connection.credentialId = result.credentialId
      persisted = persisted && result.persisted
    }
    delete connection.apiKey
  }
  if (!safeStorage.isEncryptionAvailable()) {
    warnings.push(
      'OS-backed encryption is unavailable. API keys are usable for this session but were not written to disk.'
    )
  }
  return { workspace, persisted }
}

function stripWorkspaceSecrets(workspace: AppWorkspace): boolean {
  let removed = false
  for (const connection of workspaceConnections(workspace)) {
    if (connection.apiKey || connection.credentialId) removed = true
    delete connection.apiKey
    delete connection.credentialId
  }
  return removed
}

async function saveWorkspace(value: unknown): Promise<WorkspaceSaveResult> {
  const serializedSize = Buffer.byteLength(JSON.stringify(value))
  if (serializedSize > MAX_WORKSPACE_BYTES) {
    throw backendError('WORKSPACE_TOO_LARGE', 'The workspace is too large to autosave.')
  }
  const warnings: string[] = []
  const normalized = normalizeWorkspace(value, warnings)
  normalized.updatedAt = new Date().toISOString()
  let secured!: { workspace: AppWorkspace; persisted: boolean }
  const operation = workspaceWriteChain.then(async () => {
    secured = await vaultWorkspaceSecrets(normalized, warnings)
    const payload = `${JSON.stringify(secured.workspace, null, 2)}\n`
    await atomicWrite(workspaceFilePath(), payload)
    try {
      await pruneUnusedCredentials(secured.workspace)
    } catch {
      warnings.push('Unused saved credentials could not be cleaned up during this save.')
    }
  })
  workspaceWriteChain = operation.catch(() => undefined)
  await operation
  loggingEnabled = secured.workspace.settings.loggingEnabled
  return {
    workspace: secured.workspace,
    savedAt: secured.workspace.updatedAt,
    secretsPersisted: secured.persisted,
    warnings
  }
}

async function loadWorkspace(): Promise<WorkspaceLoadResult> {
  const warnings: string[] = []
  try {
    const raw = await fs.readFile(workspaceFilePath(), 'utf8')
    if (Buffer.byteLength(raw) > MAX_WORKSPACE_BYTES) {
      throw backendError('WORKSPACE_TOO_LARGE', 'The saved workspace exceeds the safety limit.')
    }
    const parsed: unknown = JSON.parse(raw)
    const normalized = normalizeWorkspace(parsed, warnings)
    const containsLegacySecrets = workspaceConnections(normalized).some((connection) =>
      Boolean(connection.apiKey)
    )
    if (containsLegacySecrets) {
      warnings.push('Legacy plaintext API keys were moved into encrypted credential storage.')
      const result = await saveWorkspace(normalized)
      warnings.push(...result.warnings)
      loggingEnabled = result.workspace.settings.loggingEnabled
      return {
        workspace: result.workspace,
        warnings,
        secretsAvailable: safeStorage.isEncryptionAvailable()
      }
    }
    loggingEnabled = normalized.settings.loggingEnabled
    return {
      workspace: normalized,
      warnings,
      secretsAvailable: safeStorage.isEncryptionAvailable()
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      const workspace = createDefaultWorkspace()
      loggingEnabled = workspace.settings.loggingEnabled
      return {
        workspace,
        warnings,
        secretsAvailable: safeStorage.isEncryptionAvailable()
      }
    }
    if (error instanceof BackendError && error.detail.code === 'UNSUPPORTED_WORKSPACE') {
      const backupPath = join(
        app.getPath('userData'),
        `workspace-unsupported-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      )
      try {
        await fs.copyFile(workspaceFilePath(), backupPath)
        warnings.push(
          `A newer workspace format was preserved at ${backupPath}. A new workspace was opened without overwriting that backup.`
        )
      } catch {
        throw error
      }
      const workspace = createDefaultWorkspace()
      loggingEnabled = workspace.settings.loggingEnabled
      return {
        workspace,
        warnings,
        secretsAvailable: safeStorage.isEncryptionAvailable()
      }
    }
    if (error instanceof BackendError) throw error
    warnings.push('The saved workspace could not be read; a new workspace was opened instead.')
    console.error('Unable to load workspace.', error)
    return {
      workspace: createDefaultWorkspace(),
      warnings,
      secretsAvailable: safeStorage.isEncryptionAvailable()
    }
  }
}

function resolveApiUrl(baseUrl: string, relativePath: 'models' | 'chat/completions'): URL {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    throw backendError('INVALID_BASE_URL', 'Enter a valid HTTP or HTTPS API base URL.')
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw backendError('INVALID_BASE_URL', 'The API base URL must use HTTP or HTTPS.')
  }
  if (base.username || base.password || base.search || base.hash) {
    throw backendError(
      'INVALID_BASE_URL',
      'The API base URL cannot contain credentials, a query string, or a fragment.'
    )
  }
  if (!base.hostname) {
    throw backendError('INVALID_BASE_URL', 'The API base URL must include a host.')
  }
  const normalized = base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`
  return new URL(relativePath, normalized)
}

async function requestHeaders(connection: ConnectionConfig): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...connection.customHeaders
  }
  const credential =
    connection.apiKey ?? (connection.credentialId ? await getCredential(connection.credentialId) : undefined)
  if (connection.credentialId && credential === undefined) {
    throw backendError(
      'CREDENTIAL_UNAVAILABLE',
      'The saved API key is unavailable. Re-enter it for this connection.'
    )
  }
  if (credential) headers.Authorization = `Bearer ${credential}`
  return headers
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000))
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

async function providerHttpError(response: Response, requestId?: string): Promise<BackendError> {
  const body = (await response.text()).slice(0, MAX_PROVIDER_BODY_BYTES)
  let providerMessage: string | undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (isRecord(parsed) && isRecord(parsed.error)) {
      providerMessage = optionalString(parsed.error.message, 2_000)
    } else if (isRecord(parsed)) {
      providerMessage = optionalString(parsed.message, 2_000)
    }
  } catch {
    providerMessage = body.replace(/\s+/g, ' ').trim().slice(0, 1_000) || undefined
  }

  let code = 'PROVIDER_ERROR'
  let message = `The provider returned HTTP ${response.status}.`
  let retryable = response.status === 408 || response.status === 429 || response.status >= 500
  if (response.status === 401 || response.status === 403) {
    code = 'AUTHENTICATION_FAILED'
    message = 'The provider rejected the API credentials.'
    retryable = false
  } else if (response.status === 404) {
    code = 'ENDPOINT_OR_MODEL_NOT_FOUND'
    message = 'The provider could not find this endpoint or model.'
    retryable = false
  } else if (response.status === 429) {
    code = 'RATE_LIMITED'
    message = 'The provider rate limit was reached.'
  } else if (response.status >= 500) {
    code = 'PROVIDER_UNAVAILABLE'
    message = 'The provider is temporarily unavailable.'
  }
  return backendError(code, message, {
    retryable,
    httpStatus: response.status,
    providerMessage,
    requestId,
    retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after'))
  })
}

function parseProviderModels(value: unknown): ProviderModel[] {
  const raw =
    Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value.data)
        ? value.data
        : isRecord(value) && Array.isArray(value.models)
          ? value.models
          : undefined
  if (!raw) {
    throw backendError('INVALID_PROVIDER_RESPONSE', 'The model endpoint returned an unexpected response.')
  }
  const models: ProviderModel[] = []
  const seen = new Set<string>()
  for (const item of raw.slice(0, 20_000)) {
    const id =
      typeof item === 'string'
        ? item
        : isRecord(item)
          ? optionalString(item.id ?? item.name, 1_024)
          : undefined
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      ownedBy: isRecord(item) ? optionalString(item.owned_by ?? item.ownedBy, 512) : undefined,
      created: isRecord(item) ? finiteOptionalNumber(item.created) : undefined
    })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }))
}

async function fetchModels(value: unknown): Promise<ModelListResult> {
  const warnings: string[] = []
  const connection = normalizeConnection(value, warnings, 'Model connection')
  const url = resolveApiUrl(connection.baseUrl, 'models')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), connection.timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: await requestHeaders(connection),
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) throw await providerHttpError(response)
    const raw = await response.text()
    if (Buffer.byteLength(raw) > MAX_PROVIDER_BODY_BYTES) {
      throw backendError('INVALID_PROVIDER_RESPONSE', 'The model list response is too large.')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw backendError('INVALID_PROVIDER_RESPONSE', 'The model endpoint did not return JSON.')
    }
    return { models: parseProviderModels(parsed), fetchedAt: new Date().toISOString() }
  } catch (error) {
    if (error instanceof BackendError) throw error
    if (controller.signal.aborted) {
      throw backendError('REQUEST_TIMEOUT', 'Fetching models timed out.', { retryable: true })
    }
    throw backendError('NETWORK_ERROR', 'Could not reach the model endpoint.', {
      retryable: true,
      providerMessage: error instanceof Error ? error.message.slice(0, 1_000) : undefined
    })
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeChatMessage(value: unknown): ChatRequestMessage | undefined {
  if (!isRecord(value) || typeof value.content !== 'string') return undefined
  const role =
    value.role === 'system' ||
    value.role === 'developer' ||
    value.role === 'user' ||
    value.role === 'assistant'
      ? value.role
      : undefined
  if (!role) return undefined
  return {
    role,
    content: value.content.slice(0, 4_000_000),
    name: optionalString(value.name, 128)
  }
}

function validateChatRequest(value: unknown): ChatStartRequest {
  if (!isRecord(value)) {
    throw backendError('INVALID_REQUEST', 'The chat request is invalid.')
  }
  const requestId = stringValue(value.requestId, '', 128)
  const paneId = stringValue(value.paneId, '', 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
    throw backendError('INVALID_REQUEST_ID', 'The request ID is missing or invalid.')
  }
  if (!paneId) throw backendError('INVALID_PANE_ID', 'The pane ID is missing.')
  const warnings: string[] = []
  const connection = normalizeConnection(value.connection, warnings, 'Chat connection')
  if (!connection.modelId) throw backendError('MODEL_REQUIRED', 'Select or enter a model first.')
  resolveApiUrl(connection.baseUrl, 'chat/completions')
  const parameters = normalizeParameters(value.parameters)
  for (const key of Object.keys(parameters.extra)) {
    if (RESERVED_COMPLETION_FIELDS.has(key)) {
      throw backendError(
        'RESERVED_PARAMETER',
        `The provider-specific parameter "${key}" conflicts with a configured chat field.`
      )
    }
  }
  const messages = Array.isArray(value.messages)
    ? value.messages.map(normalizeChatMessage).filter((message): message is ChatRequestMessage => Boolean(message))
    : []
  if (messages.length === 0) throw backendError('MESSAGES_REQUIRED', 'The chat request has no messages.')
  if (messages.length > 2_000) throw backendError('TOO_MANY_MESSAGES', 'The chat request has too many messages.')

  return {
    requestId,
    paneId,
    batchId: optionalString(value.batchId, 128),
    connection,
    parameters,
    messages,
    logLabel: optionalString(value.logLabel, 512)
  }
}

function completionPayload(request: ChatStartRequest): Record<string, unknown> {
  const parameters = request.parameters
  const payload: Record<string, unknown> = {
    ...parameters.extra,
    model: request.connection.modelId,
    messages: request.messages,
    stream: true,
    temperature: parameters.temperature,
    top_p: parameters.topP,
    presence_penalty: parameters.presencePenalty,
    frequency_penalty: parameters.frequencyPenalty
  }
  if (parameters.maxTokenField !== 'omit') {
    payload[parameters.maxTokenField] = parameters.maxOutputTokens
  }
  if (parameters.seed !== null) payload.seed = parameters.seed
  if (parameters.stop.length > 0) payload.stop = parameters.stop
  if (parameters.topK !== null) payload.top_k = parameters.topK
  if (parameters.reasoning !== null) {
    payload.reasoning = {
      effort: parameters.reasoning.effort,
      enabled: parameters.reasoning.enabled,
      exclude: parameters.reasoning.exclude
    }
  }
  return payload
}

function emitChatEvent(active: ActiveChat, event: ChatEvent): void {
  if (active.sender.isDestroyed()) return
  try {
    active.sender.send(IPC_CHANNELS.chatEvent, event)
  } catch {
    // The renderer may have closed between isDestroyed() and send().
  }
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (isRecord(part) && typeof part.text === 'string') return part.text
      return ''
    })
    .join('')
}

function usageFromProvider(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const promptTokens = finiteOptionalNumber(value.prompt_tokens ?? value.promptTokens)
  const completionTokens = finiteOptionalNumber(value.completion_tokens ?? value.completionTokens)
  const totalTokens = finiteOptionalNumber(value.total_tokens ?? value.totalTokens)
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined
  }
  return { promptTokens, completionTokens, totalTokens }
}

function applyStreamPayload(active: ActiveChat, value: unknown): void {
  if (!isRecord(value)) {
    throw backendError('INVALID_PROVIDER_RESPONSE', 'The provider emitted an invalid stream event.', {
      requestId: active.request.requestId
    })
  }
  if (isRecord(value.error)) {
    const message = stringValue(value.error.message, 'The provider reported a streaming error.', 2_000)
    throw backendError('PROVIDER_STREAM_ERROR', 'The provider reported a streaming error.', {
      providerMessage: message,
      requestId: active.request.requestId
    })
  }
  const usage = usageFromProvider(value.usage)
  if (usage) active.usage = usage
  const choices = Array.isArray(value.choices) ? value.choices : []
  const choice = choices[0]
  if (!isRecord(choice)) return
  const delta = isRecord(choice.delta)
    ? extractTextContent(choice.delta.content)
    : isRecord(choice.message)
      ? extractTextContent(choice.message.content)
      : extractTextContent(choice.text)
  if (delta) {
    active.text += delta
    emitChatEvent(active, {
      type: 'delta',
      requestId: active.request.requestId,
      paneId: active.request.paneId,
      delta,
      text: active.text,
      emittedAt: new Date().toISOString()
    })
  }
  if (typeof choice.finish_reason === 'string') active.finishReason = choice.finish_reason
}

async function consumeEventStream(active: ActiveChat, response: Response): Promise<void> {
  if (!response.body) {
    throw backendError('INVALID_PROVIDER_RESPONSE', 'The provider returned an empty response stream.', {
      requestId: active.request.requestId
    })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''
  let dataLines: string[] = []
  let sawDone = false
  let parsedEvents = 0

  const dispatch = (): void => {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (!data) return
    if (data === '[DONE]') {
      sawDone = true
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw backendError('INVALID_PROVIDER_RESPONSE', 'The provider emitted malformed stream JSON.', {
        requestId: active.request.requestId
      })
    }
    parsedEvents += 1
    applyStreamPayload(active, parsed)
  }

  const processLine = (line: string): void => {
    if (line === '') {
      dispatch()
      return
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }

  while (!sawDone) {
    const { done, value } = await reader.read()
    if (done) break
    lineBuffer += decoder.decode(value, { stream: true })
    let newlineIndex = lineBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      let line = lineBuffer.slice(0, newlineIndex)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      lineBuffer = lineBuffer.slice(newlineIndex + 1)
      processLine(line)
      if (sawDone) break
      newlineIndex = lineBuffer.indexOf('\n')
    }
  }
  lineBuffer += decoder.decode()
  if (lineBuffer) processLine(lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer)
  dispatch()
  if (sawDone) await reader.cancel().catch(() => undefined)
  if (!sawDone && active.finishReason === undefined) {
    throw backendError(
      'STREAM_INTERRUPTED',
      parsedEvents > 0
        ? 'The response stream ended before the provider marked it complete.'
        : 'The provider returned no usable stream events.',
      { retryable: true, requestId: active.request.requestId }
    )
  }
}

async function consumeJsonResponse(active: ActiveChat, response: Response): Promise<void> {
  const raw = await response.text()
  if (Buffer.byteLength(raw) > MAX_PROVIDER_BODY_BYTES) {
    throw backendError('INVALID_PROVIDER_RESPONSE', 'The provider response is too large.', {
      requestId: active.request.requestId
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw backendError('INVALID_PROVIDER_RESPONSE', 'The provider did not return valid JSON.', {
      requestId: active.request.requestId
    })
  }
  applyStreamPayload(active, parsed)
  if (!active.text && active.finishReason === undefined) {
    throw backendError('INVALID_PROVIDER_RESPONSE', 'The provider response did not contain assistant text.', {
      requestId: active.request.requestId
    })
  }
}

async function runChat(active: ActiveChat): Promise<void> {
  const timeout = setTimeout(() => {
    active.abortKind = 'timeout'
    active.controller.abort()
  }, active.request.connection.timeoutMs)
  try {
    const response = await fetch(resolveApiUrl(active.request.connection.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: await requestHeaders(active.request.connection),
      body: JSON.stringify(completionPayload(active.request)),
      redirect: 'error',
      signal: active.controller.signal
    })
    if (!response.ok) throw await providerHttpError(response, active.request.requestId)
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
      await consumeJsonResponse(active, response)
    } else {
      await consumeEventStream(active, response)
    }
    emitChatEvent(active, {
      type: 'done',
      requestId: active.request.requestId,
      paneId: active.request.paneId,
      text: active.text,
      finishReason: active.finishReason,
      usage: active.usage,
      emittedAt: new Date().toISOString()
    })
    if (active.loggingEnabled) await appendChatLog(active, 'done')
  } catch (error) {
    if (active.abortKind === 'user' || active.abortKind === 'shutdown') {
      emitChatEvent(active, {
        type: 'cancelled',
        requestId: active.request.requestId,
        paneId: active.request.paneId,
        text: active.text,
        emittedAt: new Date().toISOString()
      })
      if (active.loggingEnabled) await appendChatLog(active, 'cancelled')
    } else {
      const detail =
        active.abortKind === 'timeout'
          ? asAppError(
              backendError('REQUEST_TIMEOUT', 'The chat request timed out.', {
                retryable: true,
                requestId: active.request.requestId
              }),
              active.request.requestId
            )
          : error instanceof TypeError
            ? asAppError(
                backendError('NETWORK_ERROR', 'The connection to the provider failed.', {
                  retryable: true,
                  requestId: active.request.requestId,
                  providerMessage: error.message.slice(0, 1_000)
                }),
                active.request.requestId
              )
          : asAppError(error, active.request.requestId)
      emitChatEvent(active, {
        type: 'error',
        requestId: active.request.requestId,
        paneId: active.request.paneId,
        text: active.text,
        error: detail,
        emittedAt: new Date().toISOString()
      })
      if (active.loggingEnabled) await appendChatLog(active, 'error', detail)
    }
  } finally {
    clearTimeout(timeout)
    if (activeChats.get(active.key) === active) activeChats.delete(active.key)
  }
}

function quoteMarkdown(value: string): string {
  if (!value) return '> _(empty)_'
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function metadataText(value: string): string {
  return value.replace(/[\r\n|]+/g, ' ').trim()
}

function displayEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return `${url.origin}${url.pathname}`
  } catch {
    return '(invalid endpoint)'
  }
}

async function appendChatLog(
  active: ActiveChat,
  outcome: 'done' | 'cancelled' | 'error',
  error?: AppError
): Promise<void> {
  const finishedAt = new Date()
  const lines = [
    '---',
    '',
    `## ${finishedAt.toLocaleString()} — ${metadataText(active.request.logLabel ?? active.request.paneId)}`,
    '',
    `- **Model:** ${metadataText(active.request.connection.modelId)}`,
    `- **Endpoint:** ${metadataText(displayEndpoint(active.request.connection.baseUrl))}`,
    `- **Request:** ${metadataText(active.request.requestId)}`,
    ...(active.request.batchId ? [`- **Comparison round:** ${metadataText(active.request.batchId)}`] : []),
    `- **Duration:** ${Date.now() - active.startedAt} ms`,
    `- **Result:** ${outcome}`,
    '',
    '### Context sent',
    ''
  ]
  for (const message of active.request.messages) {
    lines.push(`#### ${message.role}`, '', quoteMarkdown(message.content), '')
  }
  lines.push('### Assistant response', '', quoteMarkdown(active.text), '')
  if (active.usage) {
    lines.push(
      '### Token usage',
      '',
      `- Prompt: ${active.usage.promptTokens ?? 'unknown'}`,
      `- Completion: ${active.usage.completionTokens ?? 'unknown'}`,
      `- Total: ${active.usage.totalTokens ?? 'unknown'}`,
      ''
    )
  }
  if (error) {
    lines.push(
      '### Error',
      '',
      `- Code: ${metadataText(error.code)}`,
      `- Message: ${metadataText(error.message)}`,
      ...(error.providerMessage
        ? [`- Provider detail: ${metadataText(error.providerMessage)}`]
        : []),
      ''
    )
  }
  const filePath = join(logsDirectoryPath(), `${finishedAt.toISOString().slice(0, 10)}.md`)
  const content = `${lines.join('\n')}\n`
  const operation = logWriteChain.then(async () => {
    await fs.mkdir(logsDirectoryPath(), { recursive: true })
    await fs.appendFile(filePath, content, { encoding: 'utf8', mode: 0o600 })
  })
  logWriteChain = operation.catch((writeError) => {
    console.error('Unable to append the chat log.', writeError)
  })
  await operation.catch(() => undefined)
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (quoted) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }
    if (character === '"' && field.length === 0) {
      quoted = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (rows.length > 100_000) {
        throw backendError('CSV_TOO_LARGE', 'The CSV contains too many rows.')
      }
    } else {
      field += character
    }
  }
  if (quoted) throw backendError('INVALID_CSV', 'The CSV ends inside a quoted field.')
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function parentWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

async function showOpenDialog(
  event: IpcMainInvokeEvent,
  options: OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  const parent = parentWindow(event)
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
}

async function showSaveDialog(
  event: IpcMainInvokeEvent,
  options: SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
  const parent = parentWindow(event)
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options)
}

async function importTextFile(
  event: IpcMainInvokeEvent,
  request: FileImportRequest
): Promise<FileImportResult> {
  if (
    !isRecord(request) ||
    (request.kind !== 'biography' && request.kind !== 'scenario' && request.kind !== 'prompt')
  ) {
    throw backendError('INVALID_IMPORT_KIND', 'Choose a supported text import type.')
  }
  const result = await showOpenDialog(event, {
    title:
      request.kind === 'biography'
        ? 'Import NPC biography'
        : request.kind === 'scenario'
          ? 'Import scenario'
          : 'Import prompt',
    properties: ['openFile'],
    filters: [
      { name: 'Text and CSV', extensions: ['txt', 'md', 'csv'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return { cancelled: true }
  const filePath = result.filePaths[0]
  const stat = await fs.stat(filePath)
  if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) {
    throw backendError('IMPORT_TOO_LARGE', 'The selected import file is too large.')
  }
  const content = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '')
  const format = extname(filePath).toLowerCase() === '.csv' ? 'csv' : 'text'
  return {
    cancelled: false,
    fileName: basename(filePath),
    filePath,
    format,
    content,
    rows: format === 'csv' ? parseCsv(content) : undefined
  }
}

function sanitizeReportFileName(value: unknown): string {
  const requested = typeof value === 'string' ? basename(value.trim()) : ''
  const extension = extname(requested)
  let stem = extension ? requested.slice(0, -extension.length) : requested
  stem = stem
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[ .]+$/g, '')
    .trim()
    .slice(0, 180)
    .replace(/[ .]+$/g, '')

  if (!stem || /^\.+$/.test(stem)) stem = 'Roleplay-Lab-comparison-review'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`
  return `${stem}.txt`
}

function forceTxtExtension(filePath: string): string {
  const extension = extname(filePath)
  const withoutExtension = extension ? filePath.slice(0, -extension.length) : filePath
  return `${withoutExtension.replace(/[ .]+$/g, '')}.txt`
}

async function exportReport(
  event: IpcMainInvokeEvent,
  value: unknown
): Promise<ReportExportResult> {
  if (!isRecord(value) || typeof value.content !== 'string' || value.content.length === 0) {
    throw backendError('INVALID_REPORT', 'There is no comparison review to export.')
  }
  if (Buffer.byteLength(value.content, 'utf8') > MAX_REPORT_BYTES) {
    throw backendError('REPORT_TOO_LARGE', 'The comparison review exceeds the 8 MiB export limit.')
  }

  const result = await showSaveDialog(event, {
    title: 'Export comparison review',
    defaultPath: sanitizeReportFileName(value.suggestedFileName),
    filters: [{ name: 'Text document', extensions: ['txt'] }]
  })
  if (result.canceled || !result.filePath) return { cancelled: true }

  const filePath = forceTxtExtension(result.filePath)
  await atomicWrite(filePath, value.content)
  return { cancelled: false, filePath }
}

async function exportWorkspace(
  event: IpcMainInvokeEvent,
  value: unknown
): Promise<WorkspaceExportResult> {
  const warnings: string[] = []
  const workspace = normalizeWorkspace(value, warnings)
  stripWorkspaceSecrets(workspace)
  const result = await showSaveDialog(event, {
    title: 'Export Roleplay Lab workspace',
    defaultPath: 'Roleplay-Lab-workspace.json',
    filters: [{ name: 'Roleplay Lab workspace', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { cancelled: true }
  const envelope: WorkspaceEnvelope = {
    format: 'roleplay-lab-workspace',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace
  }
  await atomicWrite(result.filePath, `${JSON.stringify(envelope, null, 2)}\n`)
  return { cancelled: false, filePath: result.filePath }
}

async function importWorkspace(event: IpcMainInvokeEvent): Promise<WorkspaceImportResult> {
  const result = await showOpenDialog(event, {
    title: 'Import Roleplay Lab workspace',
    properties: ['openFile'],
    filters: [{ name: 'Roleplay Lab workspace', extensions: ['json'] }]
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { cancelled: true, warnings: [] }
  }
  const filePath = result.filePaths[0]
  const stat = await fs.stat(filePath)
  if (!stat.isFile() || stat.size > MAX_WORKSPACE_BYTES) {
    throw backendError('WORKSPACE_TOO_LARGE', 'The selected workspace is too large.')
  }
  const raw = await fs.readFile(filePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw backendError('INVALID_WORKSPACE', 'The selected file is not valid JSON.')
  }
  const payload = isRecord(parsed) && 'workspace' in parsed ? parsed.workspace : parsed
  const warnings: string[] = []
  const workspace = normalizeWorkspace(payload, warnings)
  if (stripWorkspaceSecrets(workspace)) {
    warnings.push('Credential references were removed from the imported workspace.')
  }
  workspace.updatedAt = new Date().toISOString()
  return { cancelled: false, workspace, filePath, warnings }
}

function watchWebContents(sender: WebContents): void {
  if (watchedWebContents.has(sender.id)) return
  watchedWebContents.add(sender.id)
  sender.once('destroyed', () => {
    watchedWebContents.delete(sender.id)
    for (const active of activeChats.values()) {
      if (active.sender.id === sender.id) {
        active.abortKind = 'shutdown'
        active.controller.abort()
      }
    }
  })
}

function registerIpcHandlers(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.handle(IPC_CHANNELS.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    workspacePath: workspaceFilePath(),
    logsPath: logsDirectoryPath(),
    secretStorageAvailable: safeStorage.isEncryptionAvailable()
  }))

  ipcMain.on(IPC_CHANNELS.appCloseReady, (event, saved: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) return
    clearCloseFallback(window)

    if (saved === true) {
      void finalizeWindowClose(window, event.sender)
      return
    }

    void dialog
      .showMessageBox(window, {
        type: 'error',
        title: 'Roleplay Lab could not save',
        message: 'The latest workspace changes could not be written to disk.',
        detail:
          'Check available disk space and folder permissions, then retry. You can also quit without saving the latest changes.',
        buttons: ['Retry Save', 'Quit Without Saving'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      .then((result) => {
        if (window.isDestroyed()) return
        if (result.response === 0) {
          window.webContents.send(IPC_CHANNELS.appBeforeClose)
          armCloseFallback(window)
          return
        }
        windowsReadyToClose.add(window)
        window.close()
      })
  })

  ipcMain.handle(IPC_CHANNELS.credentialSave, async (_event, value: unknown) => {
    try {
      if (!isRecord(value) || typeof value.value !== 'string') {
        throw backendError('INVALID_CREDENTIAL', 'Enter a valid API key.')
      }
      return await saveCredential(
        validCredentialId(value.credentialId) ? value.credentialId : undefined,
        value.value
      )
    } catch (error) {
      throw toInvokeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.credentialDelete, async (_event, value: unknown) => {
    try {
      if (!isRecord(value) || !validCredentialId(value.credentialId)) return false
      return await deleteCredential(value.credentialId)
    } catch (error) {
      throw toInvokeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.credentialStatus, async (_event, value: unknown) => {
    const credentialId =
      isRecord(value) && validCredentialId(value.credentialId) ? value.credentialId : ''
    if (!credentialId) {
      return { credentialId, available: false, persisted: false }
    }
    const available = (await getCredential(credentialId)) !== undefined
    await ensureCredentialVaultLoaded()
    return {
      credentialId,
      available,
      persisted:
        safeStorage.isEncryptionAvailable() &&
        Object.prototype.hasOwnProperty.call(credentialEntries, credentialId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.workspaceLoad, async (): Promise<WorkspaceLoadResult> => {
    try {
      return await loadWorkspace()
    } catch (error) {
      throw toInvokeError(error)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.workspaceSave,
    async (_event, value: unknown): Promise<WorkspaceSaveResult> => {
      try {
        return await saveWorkspace(value)
      } catch (error) {
        throw toInvokeError(error)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.workspaceImport,
    async (event): Promise<WorkspaceImportResult> => {
      try {
        return await importWorkspace(event)
      } catch (error) {
        throw toInvokeError(error)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.workspaceExport,
    async (event, value: unknown): Promise<WorkspaceExportResult> => {
      try {
        return await exportWorkspace(event, value)
      } catch (error) {
        throw toInvokeError(error)
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.modelsList, async (_event, value: unknown): Promise<ModelListResult> => {
    try {
      return await fetchModels(value)
    } catch (error) {
      throw toInvokeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.chatStart, (event, value: unknown) => {
    try {
      const request = validateChatRequest(value)
      const key = `${event.sender.id}:${request.requestId}`
      if (activeChats.has(key)) {
        throw backendError('DUPLICATE_REQUEST', 'A request with this ID is already running.')
      }
      watchWebContents(event.sender)
      const active: ActiveChat = {
        key,
        request,
        sender: event.sender,
        controller: new AbortController(),
        text: '',
        startedAt: Date.now(),
        loggingEnabled
      }
      activeChats.set(key, active)
      active.completion = runChat(active)
      return { requestId: request.requestId, acceptedAt: new Date().toISOString() }
    } catch (error) {
      throw toInvokeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.chatCancel, (event, value: unknown): boolean => {
    const requestId = isRecord(value) ? optionalString(value.requestId, 128) : undefined
    if (!requestId) return false
    const active = activeChats.get(`${event.sender.id}:${requestId}`)
    if (!active) return false
    active.abortKind = 'user'
    active.controller.abort()
    return true
  })

  ipcMain.handle(
    IPC_CHANNELS.fileImport,
    async (event, value: unknown): Promise<FileImportResult> => {
      try {
        return await importTextFile(event, value as FileImportRequest)
      } catch (error) {
        throw toInvokeError(error)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.reportExport,
    async (event, value: unknown): Promise<ReportExportResult> => {
      try {
        return await exportReport(event, value)
      } catch (error) {
        throw toInvokeError(error)
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.logsSetEnabled, (_event, value: unknown): boolean => {
    if (typeof value !== 'boolean') throw toInvokeError(backendError('INVALID_VALUE', 'Logging must be on or off.'))
    loggingEnabled = value
    return loggingEnabled
  })

  ipcMain.handle(IPC_CHANNELS.logsReveal, async (): Promise<void> => {
    await fs.mkdir(logsDirectoryPath(), { recursive: true })
    const error = await shell.openPath(logsDirectoryPath())
    if (error) throw new Error(error)
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1_560,
    height: 960,
    minWidth: 1_000,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    title: 'Roleplay Lab',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#080a10',
      symbolColor: '#c4cad8',
      height: 44
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  let closeRequested = false
  window.on('close', (event) => {
    if (windowsReadyToClose.has(window) || window.webContents.isDestroyed()) return
    event.preventDefault()
    if (closeRequested) return
    closeRequested = true
    window.webContents.send(IPC_CHANNELS.appBeforeClose)

    // Never leave an unresponsive window impossible to close. Healthy renderers
    // acknowledge only after their final atomic workspace save has completed.
    armCloseFallback(window)
  })
  window.once('closed', () => clearCloseFallback(window))

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  window.webContents.on('will-navigate', (event, targetUrl) => {
    let isInternal = false
    try {
      if (rendererUrl) {
        isInternal = new URL(targetUrl).origin === new URL(rendererUrl).origin
      } else {
        const target = new URL(targetUrl)
        isInternal =
          target.protocol === 'file:' &&
          decodeURIComponent(target.pathname).replace(/\\/g, '/').endsWith('/renderer/index.html')
      }
    } catch {
      isInternal = false
    }
    if (!isInternal) {
      event.preventDefault()
      if (targetUrl.startsWith('https://') || targetUrl.startsWith('http://')) {
        void shell.openExternal(targetUrl)
      }
    }
  })
  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.roleplaylab.desktop')
    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    for (const active of activeChats.values()) {
      active.abortKind = 'shutdown'
      active.controller.abort()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
