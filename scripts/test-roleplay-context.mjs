#!/usr/bin/env node

/**
 * Focused regression coverage for Roleplay Lab's roleplay prompt renderer.
 *
 * TypeScript transpiles the real renderer utility module in-process rather
 * than duplicating its substitution behavior in the test.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'roleplay-lab-context-test-'))
const compilerOptions = {
  importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  module: ts.ModuleKind.ES2022,
  target: ts.ScriptTarget.ES2022
}

async function transpile(sourcePath, outputName, replacements = []) {
  const source = await readFile(resolve(ROOT, sourcePath), 'utf8')
  let output = ts.transpileModule(source, { compilerOptions }).outputText
  for (const [from, to] of replacements) output = output.replaceAll(from, to)
  await writeFile(join(temporaryRoot, outputName), output, 'utf8')
}

await transpile('src/shared/types.ts', 'types.mjs')
await transpile('src/shared/defaults.ts', 'defaults.mjs', [
  ["'./types'", "'./types.mjs'"],
  ['"./types"', '"./types.mjs"']
])
await transpile('src/renderer/src/lib/workspace.ts', 'workspace.mjs', [
  ["'../../../shared/defaults'", "'./defaults.mjs'"],
  ['"../../../shared/defaults"', '"./defaults.mjs"']
])

const workspace = await import(pathToFileURL(join(temporaryRoot, 'workspace.mjs')).href)
const pathFromSystemTemp = relative(resolve(tmpdir()), resolve(temporaryRoot))
assert(
  pathFromSystemTemp.length > 0 &&
    !pathFromSystemTemp.startsWith('..') &&
    !isAbsolute(pathFromSystemTemp),
  `Refusing to clean unexpected test path: ${temporaryRoot}`
)
await rm(temporaryRoot, { recursive: true, force: true })

const pane = workspace.createPane(0)
pane.roleplay = {
  systemPrompt: '#HERIKA_NAME# trusts #PLAYER_NAME#.',
  playerName: 'Aria',
  npcName: 'Nyx',
  npcBiography: '#HERIKA_NAME# remembers #PLAYER_NAME#.',
  scenario: '#PLAYER_NAME# meets #NPC_NAME# at the gate.'
}
pane.analysis.instructions = 'Evaluate #HERIKA_NAME# while protecting #PLAYER_NAME# agency.'
pane.messages = [
  {
    id: 'history-user',
    role: 'user',
    content: '#PLAYER_NAME# asks #HERIKA_NAME# to wait.',
    createdAt: new Date().toISOString()
  },
  {
    id: 'history-assistant',
    role: 'assistant',
    content: 'Provider output retains #HERIKA_NAME# literally.',
    createdAt: new Date().toISOString()
  }
]

const renderedSystem = workspace.renderRoleplaySystem(pane.roleplay)
assert(renderedSystem.includes('Nyx trusts Aria.'), '#HERIKA_NAME# did not map to the NPC name.')
assert(
  renderedSystem.includes('Nyx remembers Aria.'),
  'Biography placeholders were not rendered.'
)
assert(
  renderedSystem.includes('Aria meets Nyx at the gate.'),
  '#NPC_NAME# did not map to the NPC name.'
)
assert(
  !renderedSystem.includes('#HERIKA_NAME#') && !renderedSystem.includes('#PLAYER_NAME#'),
  'Rendered roleplay context still contains cast placeholders.'
)

const chatMessages = workspace.buildChatMessages(
  pane,
  { mode: 'retain-all', maxMessages: 24 },
  '#PLAYER_NAME# greets #HERIKA_NAME#.'
)
assert(
  chatMessages[1]?.content === 'Aria asks Nyx to wait.',
  'Remembered player-message placeholders were not rendered.'
)
assert(
  chatMessages[2]?.content === 'Provider output retains #HERIKA_NAME# literally.',
  'Provider output should not be rewritten as prompt-template text.'
)
assert(
  chatMessages.at(-1)?.content === 'Aria greets Nyx.',
  'Current player-message placeholders were not rendered.'
)

const reviewerMessages = workspace.buildReviewerMessages(
  pane,
  '#PLAYER_NAME# challenges #HERIKA_NAME#.',
  'Nyx answers in character.'
)
assert(
  reviewerMessages[0]?.content.includes('Evaluate Nyx while protecting Aria agency.'),
  'Reviewer instruction placeholders were not rendered.'
)
assert(
  reviewerMessages[1]?.content.includes('Aria challenges Nyx.'),
  'Reviewer artifact placeholders were not rendered.'
)

const mismatchedHistoryPane = workspace.createPane(1)
mismatchedHistoryPane.messages = [
  {
    id: 'orphan-user',
    role: 'user',
    content: 'This prompt lost its own response.',
    createdAt: '2026-07-24T10:00:00.000Z',
    requestId: 'request-one'
  },
  {
    id: 'orphan-assistant',
    role: 'assistant',
    content: 'This response lost its own prompt.',
    createdAt: '2026-07-24T10:01:00.000Z',
    requestId: 'request-two'
  }
]
const mismatchedHistory = workspace.buildChatMessages(
  mismatchedHistoryPane,
  { mode: 'retain-all', maxMessages: 24 },
  'A clean next turn.'
)
assert(
  !mismatchedHistory.some((message) => message.content.includes('lost its own')),
  'Orphaned messages with different request IDs were incorrectly paired into memory.'
)
assert(
  workspace.findLatestExchange(mismatchedHistoryPane.messages) === null,
  'Prompt Review paired an orphan response with the wrong user message.'
)

const legacyHistoryPane = workspace.createPane(8)
legacyHistoryPane.messages = [
  {
    id: 'legacy-user-one',
    role: 'user',
    content: 'Legacy first request.',
    createdAt: '2026-07-24T10:00:00.000Z'
  },
  {
    id: 'legacy-assistant-one',
    role: 'assistant',
    content: 'Legacy first response.',
    createdAt: '2026-07-24T10:00:01.000Z'
  },
  {
    id: 'legacy-assistant-two-orphan',
    role: 'assistant',
    content: 'This response lost its immediately preceding user message.',
    createdAt: '2026-07-24T10:00:03.000Z'
  }
]
const legacyHistory = workspace.buildChatMessages(
  legacyHistoryPane,
  { mode: 'retain-all', maxMessages: 24 },
  'Continue after deleting the second legacy user message.'
)
assert(
  !legacyHistory.some((message) => message.content.includes('lost its immediately')),
  'An ID-less orphan response was re-paired with an older legacy user message.'
)
assert(
  workspace.findLatestExchange(legacyHistoryPane.messages)?.assistant.id ===
    'legacy-assistant-one',
  'Prompt Review selected an ID-less orphan instead of the last intact legacy pair.'
)

function comparisonPane(index, name, modelId, requestId, assistantPatch = {}) {
  const candidatePane = workspace.createPane(index)
  candidatePane.name = name
  candidatePane.connection.modelId = modelId
  candidatePane.roleplay = {
    ...candidatePane.roleplay,
    playerName: 'Aria',
    npcName: name,
    systemPrompt: 'You are #HERIKA_NAME# speaking naturally with #PLAYER_NAME#.'
  }
  candidatePane.messages = [
    {
      id: `${requestId}-user`,
      role: 'user',
      content: '#PLAYER_NAME# asks #HERIKA_NAME# to make an autonomous choice.',
      createdAt: '2026-07-24T11:00:00.000Z',
      requestId,
      batchId: 'round-7-shared'
    },
    {
      id: `${requestId}-assistant`,
      role: 'assistant',
      content: `${name} makes a distinct choice.`,
      createdAt: '2026-07-24T11:00:01.000Z',
      requestId,
      batchId: 'round-7-shared',
      pending: false,
      ...assistantPatch
    }
  ]
  return candidatePane
}

const candidateA = comparisonPane(2, 'Nyx', 'model-nyx', 'request-a')
const candidateB = comparisonPane(3, 'Vera', 'model-vera', 'request-b')
candidateA.messages[1].comparisonSnapshot = {
  laneName: 'Nyx RP',
  modelId: 'model-nyx-v7',
  renderedSystemPrompt: 'Captured system prompt for Nyx and Aria.',
  renderedUserMessage: 'Aria asks Nyx to make an autonomous choice.'
}
candidateA.name = 'Nyx pane renamed later'
candidateA.connection.modelId = 'model-changed-after-round'
candidateA.roleplay.systemPrompt = 'Current prompt must not replace the captured prompt.'
candidateA.messages.unshift(
  {
    id: 'prior-user',
    role: 'user',
    content: 'Remember our earlier choice.',
    createdAt: '2026-07-24T10:59:58.000Z',
    requestId: 'prior-request'
  },
  {
    id: 'prior-assistant',
    role: 'assistant',
    content: 'I remember and act on it.',
    createdAt: '2026-07-24T10:59:59.000Z',
    requestId: 'prior-request'
  }
)
candidateA.messages.unshift(
  {
    id: 'round-six-user-a',
    role: 'user',
    content: 'Aria asks what Nyx remembers from yesterday.',
    createdAt: '2026-07-24T10:58:00.000Z',
    requestId: 'round-six-request-a',
    batchId: 'round-6-shared'
  },
  {
    id: 'round-six-assistant-a',
    role: 'assistant',
    content: 'Nyx recalls the promise and changes her plan.',
    createdAt: '2026-07-24T10:58:01.000Z',
    requestId: 'round-six-request-a',
    batchId: 'round-6-shared',
    comparisonSnapshot: {
      laneName: 'Nyx RP',
      modelId: 'model-nyx-v7',
      renderedSystemPrompt: 'Earlier captured system prompt for Nyx and Aria.',
      renderedUserMessage: 'Aria asks what Nyx remembers from yesterday.'
    }
  }
)
candidateB.messages.unshift(
  {
    id: 'round-six-user-b',
    role: 'user',
    content: 'Aria asks what Vera remembers from yesterday.',
    createdAt: '2026-07-24T10:58:00.000Z',
    requestId: 'round-six-request-b',
    batchId: 'round-6-shared'
  },
  {
    id: 'round-six-assistant-b',
    role: 'assistant',
    content: 'Vera contradicts the promise from yesterday.',
    createdAt: '2026-07-24T10:58:01.000Z',
    requestId: 'round-six-request-b',
    batchId: 'round-6-shared'
  }
)
const pendingCandidate = comparisonPane(4, 'Mira', 'model-mira', 'request-c', {
  content: '',
  pending: true
})
const failedCandidate = comparisonPane(5, 'Tess', 'model-tess', 'request-d', {
  content: 'Partial response',
  error: 'Provider failed.'
})
const notIncluded = workspace.createPane(6)
notIncluded.name = 'No round'
const mismatchedCandidate = comparisonPane(7, 'Orphan', 'model-orphan', 'request-e')
mismatchedCandidate.messages[1].requestId = 'different-request'

const rounds = workspace.collectGlobalReviewRounds([
  candidateA,
  candidateB,
  pendingCandidate,
  failedCandidate,
  notIncluded,
  mismatchedCandidate
])
assert(rounds.length === 2, 'The shared comparison rounds were not collected.')
const comparisonRound = rounds.find((round) => round.batchId === 'round-7-shared')
const earlierComparisonRound = rounds.find((round) => round.batchId === 'round-6-shared')
assert(comparisonRound, 'The newest shared comparison round was not collected.')
assert(earlierComparisonRound, 'The earlier shared comparison round was not collected.')
assert(
  comparisonRound.candidates.length === 2,
  'Global review included a pending, failed, or mismatched response.'
)
assert(
  comparisonRound.pendingPaneIds.includes(pendingCandidate.id),
  'Pending comparison responses were not identified.'
)
assert(
  comparisonRound.failedPaneIds.includes(failedCandidate.id),
  'Failed comparison responses were not identified.'
)
assert(
  comparisonRound.missingResponsePaneIds.includes(mismatchedCandidate.id),
  'Mismatched request IDs were not excluded from the comparison.'
)
assert(
  comparisonRound.notIncludedPaneIds.includes(notIncluded.id),
  'Lanes outside the selected round were not identified.'
)
assert(
  workspace.globalReviewRoundLabel(comparisonRound).startsWith('Round 7 · 2 completed'),
  'The comparison round label did not summarize the selected round.'
)
assert(
  workspace.highestComparisonRoundNumber([candidateA, candidateB]) === 7,
  'Restored comparison rounds did not produce the correct next-round baseline.'
)
const capturedCandidate = comparisonRound.candidates.find(
  (candidate) => candidate.paneId === candidateA.id
)
const legacyCandidate = comparisonRound.candidates.find(
  (candidate) => candidate.paneId === candidateB.id
)
assert(
  capturedCandidate?.paneName === 'Nyx RP' &&
    capturedCandidate.modelId === 'model-nyx-v7' &&
    capturedCandidate.renderedSystem === 'Captured system prompt for Nyx and Aria.' &&
    capturedCandidate.configurationApproximate === false,
  'The global review collector did not prefer the send-time comparison snapshot.'
)
assert(
  legacyCandidate?.paneName === 'Vera' &&
    legacyCandidate.modelId === 'model-vera' &&
    legacyCandidate.configurationApproximate === true,
  'A legacy comparison turn was not marked as approximate current-config attribution.'
)
assert(
  workspace.orderedGlobalReviewCandidates(comparisonRound)
    .map((candidate) => candidate.paneId)
    .join(',') ===
    workspace
      .orderedGlobalReviewCandidates({
        ...comparisonRound,
        candidates: [...comparisonRound.candidates].reverse()
      })
      .map((candidate) => candidate.paneId)
      .join(','),
  'Anonymous candidate ordering was not deterministic.'
)

const reviewer = {
  connection: { ...candidateA.connection },
  parameters: { ...candidateA.parameters },
  priorities:
    'Prioritize autonomous, natural dialogue and adult-only consensual scenario alignment.'
}
const globalReviewMessages = workspace.buildGlobalReviewerMessages(
  reviewer,
  [comparisonRound, earlierComparisonRound],
  'selected'
)
assert(
  globalReviewMessages[0]?.content.includes('# Global Comparison Report') &&
    globalReviewMessages[0]?.content.includes('NPC Autonomy /10') &&
    globalReviewMessages[0]?.content.includes('| ---: | --- |'),
  'The global reviewer did not request the ranking and scorecard structure.'
)
assert(
  globalReviewMessages[1]?.content.includes('Nyx makes a distinct choice.') &&
    globalReviewMessages[1]?.content.includes('Vera makes a distinct choice.') &&
    globalReviewMessages[1]?.content.includes('Nyx recalls the promise') &&
    globalReviewMessages[1]?.content.includes('Vera contradicts the promise'),
  'The global reviewer artifact omitted an eligible model response.'
)
assert(
  globalReviewMessages[1]?.content.includes('Aria asks Nyx to make an autonomous choice.'),
  'The global reviewer artifact did not render lane-specific cast variables.'
)
assert(
  globalReviewMessages[1]?.content.includes('I remember and act on it.'),
  'The global reviewer artifact omitted bounded recent dialogue context.'
)
assert(
  globalReviewMessages[1]?.content.includes('"laneName": "Nyx RP"') &&
    globalReviewMessages[1]?.content.includes('"modelId": "model-nyx-v7"') &&
    globalReviewMessages[1]?.content.includes('"laneName": "Vera"') &&
    globalReviewMessages[1]?.content.includes('"modelId": "model-vera"') &&
    !globalReviewMessages[1]?.content.includes('Candidate 1'),
  'The reviewer artifact did not use the real lane and model names.'
)
assert(
  globalReviewMessages[0]?.content.includes('never use model/provider reputation') &&
    globalReviewMessages[0]?.content.includes('oldest to newest'),
  'The reviewer was not instructed to evaluate named models without reputation bias.'
)
assert(
  globalReviewMessages[1]?.content.indexOf('"batchId": "round-6-shared"') <
    globalReviewMessages[1]?.content.indexOf('"batchId": "round-7-shared"'),
  'Selected comparison rounds were not serialized oldest-to-newest.'
)
assert(
  globalReviewMessages[1]?.content.includes(
    'approximate — legacy turn using the lane’s current name'
  ) &&
    !globalReviewMessages[1]?.content.includes(
      'Current prompt must not replace the captured prompt.'
    ),
  'Historical snapshot provenance was not preserved in the reviewer artifact.'
)
assert(
  workspace.isGlobalReviewRoundEligible(earlierComparisonRound) &&
    !workspace.isGlobalReviewRoundEligible(comparisonRound),
  'Global review eligibility did not distinguish settled and pending rounds.'
)
const reviewStats = workspace.globalReviewSelectionStats([
  comparisonRound,
  earlierComparisonRound
])
assert(
  reviewStats.roundCount === 2 &&
    reviewStats.responseCount === 4 &&
    reviewStats.laneCount === 2 &&
    reviewStats.laneModelCount === 2,
  'Global review selection totals were calculated incorrectly.'
)
assert(
  workspace.estimateGlobalReviewInputCharacters([
    comparisonRound,
    earlierComparisonRound
  ]) > 1_000,
  'Global review input sizing omitted substantial artifact content.'
)

console.log('Roleplay cast-variable regression test passed.')
console.log('  #PLAYER_NAME# → Aria')
console.log('  #HERIKA_NAME# → Nyx')
console.log('Conversation deletion and legacy memory-safety regression test passed.')
console.log('Multi-round global comparison and reviewer-prompt regression test passed.')
