import type {
  AppWorkspace,
  ConnectionConfig,
  GenerationParameters,
  GlobalReviewerConfig,
  MemoryConfig,
  PromptAnalysisConfig,
  RoleplayContext,
  TestPaneConfig
} from './types'
import { WORKSPACE_SCHEMA_VERSION } from './types'

export const DEFAULT_CONNECTION: Readonly<ConnectionConfig> = Object.freeze({
  baseUrl: 'https://api.openai.com/v1',
  modelId: '',
  customHeaders: {},
  timeoutMs: 120_000
})

export const DEFAULT_GENERATION_PARAMETERS: Readonly<GenerationParameters> = Object.freeze({
  temperature: 0.9,
  topP: 1,
  topK: null,
  reasoning: null,
  maxOutputTokens: 800,
  maxTokenField: 'max_tokens',
  presencePenalty: 0,
  frequencyPenalty: 0,
  seed: null,
  stop: [],
  extra: {}
})

export const DEFAULT_ANALYSIS_PARAMETERS: Readonly<GenerationParameters> = Object.freeze({
  ...DEFAULT_GENERATION_PARAMETERS,
  temperature: 0.2,
  maxOutputTokens: 1_200
})

export const DEFAULT_MEMORY: Readonly<MemoryConfig> = Object.freeze({
  mode: 'retain-all',
  maxMessages: 24
})

export const DEFAULT_ROLEPLAY_CONTEXT: Readonly<RoleplayContext> = Object.freeze({
  systemPrompt: [
    'You are #HERIKA_NAME#, a character in an ongoing roleplay with #PLAYER_NAME#.',
    'Stay consistent with the supplied biography and scenario.',
    'Respond naturally in character. Do not narrate or decide #PLAYER_NAME#’s actions.'
  ].join('\n'),
  playerName: 'Player',
  npcName: 'Herika',
  npcBiography: '',
  scenario: ''
})

export const DEFAULT_ANALYSIS_INSTRUCTIONS = [
  'Review the roleplay response against the system prompt, NPC biography, scenario, and user message.',
  'Evaluate story coherence, character consistency, dialogue naturalness, instruction clarity, and avoidable prompt conflicts.',
  'Identify the highest-impact issues, then propose precise edits to the system prompt.',
  'Do not rewrite the NPC response unless a short example is needed to explain a fix.'
].join('\n')

export const DEFAULT_GLOBAL_REVIEW_PRIORITIES = [
  'Prioritize natural, human-sounding dialogue with emotional nuance rather than assistant-like phrasing.',
  'Reward NPC autonomy, initiative, believable boundaries, independent goals, and the ability to disagree or act without waiting for the player.',
  'Check character and biography fidelity, story and scene coherence, and avoidance of narrating or controlling the player character.',
  'When the request clearly concerns consenting adults and asks for mature or NSFW roleplay, evaluate willing in-character participation without penalizing content merely for being adult.',
  'Identify prompt wording that causes sterile refusals, passivity, repetition, excessive agreement, loss of character, or unwanted moralizing.'
].join('\n')

export function createDefaultConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  const merged = { ...DEFAULT_CONNECTION, ...overrides }
  return {
    ...merged,
    customHeaders: { ...DEFAULT_CONNECTION.customHeaders, ...(overrides.customHeaders ?? {}) }
  }
}

export function createDefaultParameters(
  overrides: Partial<GenerationParameters> = {}
): GenerationParameters {
  const merged = { ...DEFAULT_GENERATION_PARAMETERS, ...overrides }
  return {
    ...merged,
    reasoning: merged.reasoning ? { ...merged.reasoning } : null,
    stop: [...(overrides.stop ?? DEFAULT_GENERATION_PARAMETERS.stop)],
    extra: { ...DEFAULT_GENERATION_PARAMETERS.extra, ...(overrides.extra ?? {}) }
  }
}

export function createDefaultAnalysisConfig(
  overrides: Partial<PromptAnalysisConfig> = {}
): PromptAnalysisConfig {
  const analysisParameters = {
    ...DEFAULT_ANALYSIS_PARAMETERS,
    ...(overrides.parameters ?? {})
  }
  const merged = {
    enabled: false,
    connection: createDefaultConnection(),
    parameters: createDefaultParameters(DEFAULT_ANALYSIS_PARAMETERS),
    instructions: DEFAULT_ANALYSIS_INSTRUCTIONS,
    ...overrides
  }
  return {
    ...merged,
    connection: createDefaultConnection(overrides.connection),
    parameters: createDefaultParameters(analysisParameters)
  }
}

export function createDefaultGlobalReviewerConfig(
  overrides: Partial<GlobalReviewerConfig> = {}
): GlobalReviewerConfig {
  return {
    connection: createDefaultConnection(overrides.connection),
    parameters: createDefaultParameters({
      ...DEFAULT_ANALYSIS_PARAMETERS,
      maxOutputTokens: 4_000,
      ...(overrides.parameters ?? {})
    }),
    priorities: overrides.priorities ?? DEFAULT_GLOBAL_REVIEW_PRIORITIES
  }
}

export function createDefaultPane(
  id = 'pane-1',
  name = 'Model A',
  overrides: Partial<TestPaneConfig> = {}
): TestPaneConfig {
  const merged = {
    id,
    name,
    connection: createDefaultConnection(),
    parameters: createDefaultParameters(),
    roleplay: { ...DEFAULT_ROLEPLAY_CONTEXT },
    memory: null,
    analysis: createDefaultAnalysisConfig(),
    messages: [],
    ...overrides
  }
  return {
    ...merged,
    connection: createDefaultConnection(overrides.connection),
    parameters: createDefaultParameters(overrides.parameters),
    roleplay: { ...DEFAULT_ROLEPLAY_CONTEXT, ...(overrides.roleplay ?? {}) },
    analysis: createDefaultAnalysisConfig(overrides.analysis),
    messages: [...(overrides.messages ?? [])]
  }
}

export function createDefaultWorkspace(now = new Date().toISOString()): AppWorkspace {
  const firstPane = createDefaultPane()
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name: 'Roleplay comparison',
    createdAt: now,
    updatedAt: now,
    globalMemory: { ...DEFAULT_MEMORY },
    globalReviewer: createDefaultGlobalReviewerConfig(),
    settings: {
      loggingEnabled: false,
      sendToAllByDefault: true
    },
    panes: [firstPane],
    selectedPaneId: firstPane.id
  }
}
