#!/usr/bin/env node

/**
 * End-to-end smoke test for Roleplay Lab's OpenAI-compatible transport.
 *
 * The test deliberately crosses every production boundary:
 *   local HTTP mock -> Electron main fetch/SSE parser -> IPC -> isolated preload
 *   bridge -> renderer, with the renderer driven through Chromium DevTools.
 *
 * Run through `pnpm test:transport` so the Electron bundles are built first.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import developmentElectronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..')
const packagedExecutable = process.env.ROLEPLAY_SMOKE_EXECUTABLE
const electronPath = packagedExecutable
  ? resolve(packagedExecutable)
  : developmentElectronPath
const REQUIRED_BUNDLES = [
  join(ROOT, 'out', 'main', 'index.js'),
  join(ROOT, 'out', 'preload', 'index.cjs'),
  join(ROOT, 'out', 'renderer', 'index.html')
]
const STARTUP_TIMEOUT_MS = 30_000
const SUITE_TIMEOUT_MS = 25_000

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function withTimeout(promise, timeoutMs, message, onTimeout) {
  let timeout
  const timeoutPromise = new Promise((_, rejectTimeout) => {
    timeout = setTimeout(() => {
      onTimeout?.()
      rejectTimeout(new Error(message))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeout)
  }
}

async function waitFor(predicate, timeoutMs, label, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${label}.${suffix}`)
}

async function readJsonBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > 2 * 1024 * 1024) throw new Error('Mock request body exceeded 2 MiB.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sse(value) {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
}

async function writeFragmented(response, wire, fragmentPattern = [1, 3, 2, 11, 5, 17]) {
  let offset = 0
  let fragmentIndex = 0
  while (offset < wire.length && !response.destroyed) {
    const length = fragmentPattern[fragmentIndex % fragmentPattern.length]
    response.write(wire.slice(offset, offset + length))
    offset += length
    fragmentIndex += 1
    await delay(2)
  }
  if (!response.destroyed) response.end()
}

function beginSse(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  response.flushHeaders()
}

async function createMockProvider() {
  const state = {
    modelRequests: 0,
    chatRequests: 0,
    cancellationObserved: false,
    violations: []
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const authorization = request.headers.authorization
      if (authorization !== 'Bearer smoke-secret') {
        state.violations.push(`Unexpected authorization header on ${url.pathname}.`)
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'bad test credential' } }))
        return
      }

      if (request.method === 'GET' && url.pathname === '/v1/models') {
        state.modelRequests += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'mock-roleplay-beta', owned_by: 'smoke-provider', created: 2 },
              { id: 'mock-roleplay-alpha', owned_by: 'smoke-provider', created: 1 }
            ]
          })
        )
        return
      }

      if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        state.violations.push(`Unexpected route ${request.method} ${url.pathname}.`)
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }

      state.chatRequests += 1
      const body = await readJsonBody(request)
      if (body.model !== 'mock-roleplay-alpha') {
        state.violations.push(`Unexpected model payload: ${String(body.model)}.`)
      }
      if (body.stream !== true) state.violations.push('Chat payload did not enable streaming.')
      if (!Array.isArray(body.messages)) state.violations.push('Chat payload omitted messages.')
      if (body.top_k !== 40) {
        state.violations.push(`Chat payload sent unexpected top_k: ${String(body.top_k)}.`)
      }
      if (
        body.reasoning?.enabled !== true ||
        body.reasoning?.exclude !== true ||
        body.reasoning?.effort !== 'medium'
      ) {
        state.violations.push(
          `Chat payload sent unexpected reasoning settings: ${JSON.stringify(body.reasoning)}.`
        )
      }
      const prompt = body.messages?.at(-1)?.content

      if (prompt === 'error-me') {
        response.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '0.05'
        })
        response.end(JSON.stringify({ error: { message: 'intentional smoke-test limit' } }))
        return
      }

      if (prompt === 'cancel-me') {
        beginSse(response)
        response.write(
          sse({
            id: 'cancel-stream',
            choices: [{ index: 0, delta: { content: 'partial ' }, finish_reason: null }]
          })
        )
        let completedNaturally = false
        let counter = 0
        const interval = setInterval(() => {
          if (response.destroyed) {
            clearInterval(interval)
            return
          }
          counter += 1
          response.write(
            sse({
              id: 'cancel-stream',
              choices: [{ index: 0, delta: { content: `tail-${counter} ` }, finish_reason: null }]
            })
          )
        }, 100)
        const naturalEnd = setTimeout(() => {
          completedNaturally = true
          clearInterval(interval)
          if (!response.destroyed) {
            response.write(
              sse({
                id: 'cancel-stream',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
              })
            )
            response.end(sse('[DONE]'))
          }
        }, 8_000)
        response.once('close', () => {
          clearInterval(interval)
          clearTimeout(naturalEnd)
          if (!completedNaturally) state.cancellationObserved = true
        })
        return
      }

      beginSse(response)
      const isolated = prompt === 'isolation-ok'
      const events = isolated
        ? [
            {
              id: 'isolated-stream',
              choices: [
                { index: 0, delta: { content: 'isolated stream ' }, finish_reason: null }
              ]
            },
            {
              id: 'isolated-stream',
              choices: [
                { index: 0, delta: { content: 'survived' }, finish_reason: 'stop' }
              ]
            },
            { id: 'isolated-stream', choices: [], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }
          ]
        : [
            {
              id: 'normal-stream',
              choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }]
            },
            {
              id: 'normal-stream',
              choices: [
                {
                  index: 0,
                  delta: { content: [{ type: 'text', text: 'from mock ' }] },
                  finish_reason: null
                }
              ]
            },
            {
              id: 'normal-stream',
              choices: [{ index: 0, delta: { content: 'roleplay!' }, finish_reason: 'stop' }]
            },
            {
              id: 'normal-stream',
              choices: [],
              usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
            }
          ]
      const wire = `${events.map((event) => sse(event)).join('')}data: [DONE]\n\n`
      await writeFragmented(response, wire)
    })().catch((error) => {
      state.violations.push(
        `Mock handler failed: ${error instanceof Error ? error.message : String(error)}`
      )
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      if (!response.destroyed) {
        response.end(JSON.stringify({ error: { message: 'mock handler failure' } }))
      }
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object', 'Mock provider did not expose a TCP address.')

  return {
    server,
    state,
    baseUrl: `http://127.0.0.1:${address.port}/v1`
  }
}

async function reservePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object', 'Could not allocate a DevTools port.')
  const port = address.port
  server.close()
  await once(server, 'close')
  return port
}

class DevToolsClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()

    socket.addEventListener('message', (event) => {
      void this.handleMessage(event.data)
    })
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('The DevTools connection closed.'))
      }
      this.pending.clear()
    })
  }

  static async connect(url) {
    assert(typeof WebSocket === 'function', 'This smoke test requires Node.js 22 or newer.')
    const socket = new WebSocket(url)
    await withTimeout(
      once(socket, 'open'),
      10_000,
      'Timed out connecting to Chromium DevTools.',
      () => socket.close()
    )
    return new DevToolsClient(socket)
  }

  async handleMessage(data) {
    let text
    if (typeof data === 'string') text = data
    else if (data instanceof Blob) text = await data.text()
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8')
    else text = Buffer.from(data).toString('utf8')
    const message = JSON.parse(text)
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
  }

  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const evaluation = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (evaluation.exceptionDetails) {
      const exception = evaluation.exceptionDetails.exception
      throw new Error(
        exception?.description ??
          evaluation.exceptionDetails.text ??
          'The renderer smoke suite threw an exception.'
      )
    }
    return evaluation.result?.value
  }

  close() {
    this.socket.close()
  }
}

async function findRendererTarget(port, child) {
  return waitFor(
    async () => {
      if (child.exitCode !== null) {
        throw new Error(`Electron exited early with code ${child.exitCode}.`)
      }
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (!response.ok) return undefined
      const targets = await response.json()
      return targets.find(
        (target) =>
          target.type === 'page' &&
          typeof target.webSocketDebuggerUrl === 'string' &&
          (target.url.includes('/renderer/index.html') || target.title.includes('Roleplay Lab'))
      )
    },
    STARTUP_TIMEOUT_MS,
    'the Roleplay Lab renderer target',
    100
  )
}

async function launchElectron(tempRoot, devToolsPort) {
  const childEnvironment = {
    ...process.env,
    APPDATA: tempRoot,
    LOCALAPPDATA: tempRoot,
    XDG_CONFIG_HOME: tempRoot,
    ELECTRON_ENABLE_LOGGING: '1'
  }
  delete childEnvironment.ELECTRON_RENDERER_URL

  const switches = [
    `--remote-debugging-port=${devToolsPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${join(tempRoot, 'chromium')}`,
    '--disable-gpu',
    '--disable-software-rasterizer'
  ]
  if (process.env.ROLEPLAY_SMOKE_VISIBLE !== '1') switches.push('--headless=new')
  if (process.platform === 'linux') switches.push('--ozone-platform=headless')
  if (typeof process.getuid === 'function' && process.getuid() === 0) switches.push('--no-sandbox')
  if (!packagedExecutable) switches.push(ROOT)

  const child = spawn(electronPath, switches, {
    cwd: ROOT,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  const capture = (chunk) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-30_000)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.once('error', capture)
  child.capturedOutput = () => output
  return child
}

async function launchConnectedElectron(tempRoot) {
  const devToolsPort = await reservePort()
  const child = await launchElectron(tempRoot, devToolsPort)
  try {
    const target = await findRendererTarget(devToolsPort, child)
    const devTools = await DevToolsClient.connect(target.webSocketDebuggerUrl)
    await devTools.send('Runtime.enable')
    await waitFor(
      async () => devTools.evaluate('Boolean(window.rpCompare?.chat?.start)'),
      STARTUP_TIMEOUT_MS,
      'the isolated preload bridge',
      100
    )
    return { child, devTools }
  } catch (error) {
    const output = child.capturedOutput?.().trim()
    await terminateChild(child)
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        output ? `\nElectron output (tail):\n${output}` : ''
      }`
    )
  }
}

async function captureGenerationControls(devTools, outputPath) {
  await waitFor(
    () =>
      devTools.evaluate(`
        [...document.querySelectorAll('button.tab-button')]
          .some((button) => button.textContent?.trim() === 'Setup')
      `),
    5_000,
    'the Setup lane navigation'
  )
  const controls = await devTools.evaluate(`
    (async () => {
      const setupButton = [...document.querySelectorAll('button.tab-button')]
        .find((button) => button.textContent?.trim() === 'Setup')
      if (!(setupButton instanceof HTMLButtonElement)) {
        return { ready: false, reason: 'Setup navigation was not found.' }
      }
      setupButton.click()
      await new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
      )
      const generationButton = [...document.querySelectorAll('button.segmented-button')]
        .find((button) => button.textContent?.trim() === 'Generation')
      if (!(generationButton instanceof HTMLButtonElement)) {
        return { ready: false, reason: 'Generation navigation was not found.' }
      }
      generationButton.click()
      await new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
      )
      const topK = document.querySelector('input[id^="top-k-"]')
      const reasoning = document.querySelector('select[id^="reasoning-mode-"]')
      const effort = document.querySelector('select[id^="reasoning-effort-"]')
      const exclude = document.querySelector('select[id^="reasoning-exclude-"]')
      const ready = [topK, reasoning, effort, exclude].every(Boolean)
      const defaults = {
        topKPlaceholder: topK?.getAttribute('placeholder'),
        reasoningValue: reasoning?.value,
        effortDisabled: effort?.disabled,
        excludeDisabled: exclude?.disabled
      }
      if (ready) {
        const setNativeValue = (element, value, eventName) => {
          const prototype =
            element instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : HTMLSelectElement.prototype
          Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
          element.dispatchEvent(new Event(eventName, { bubbles: true }))
        }
        setNativeValue(topK, '40', 'input')
        setNativeValue(reasoning, 'enabled', 'change')
        await new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
        )
        const enabledEffort = document.querySelector('select[id^="reasoning-effort-"]')
        const enabledExclude = document.querySelector('select[id^="reasoning-exclude-"]')
        setNativeValue(enabledEffort, 'xhigh', 'change')
        setNativeValue(enabledExclude, 'true', 'change')
        await new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
        )
      }
      const configuredTopK = document.querySelector('input[id^="top-k-"]')
      const configuredReasoning = document.querySelector('select[id^="reasoning-mode-"]')
      const configuredEffort = document.querySelector('select[id^="reasoning-effort-"]')
      const configuredExclude = document.querySelector('select[id^="reasoning-exclude-"]')
      const setupView = document.querySelector('.setup-view')
      if (setupView instanceof HTMLElement) setupView.scrollTop = 55
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
      return {
        ready,
        defaults,
        configured: {
          topKValue: configuredTopK?.value,
          reasoningValue: configuredReasoning?.value,
          effortValue: configuredEffort?.value,
          excludeValue: configuredExclude?.value,
          effortDisabled: configuredEffort?.disabled,
          excludeDisabled: configuredExclude?.disabled
        }
      }
    })()
  `)
  assert(controls.ready, controls.reason ?? 'The generation controls did not render.')
  assert(
    controls.defaults.topKPlaceholder === 'Not sent',
    'Top K did not expose its optional state.'
  )
  assert(
    controls.defaults.reasoningValue === 'omit',
    'Reasoning did not default to the safe omitted state.'
  )
  assert(
    controls.defaults.effortDisabled && controls.defaults.excludeDisabled,
    'Reasoning detail controls were active while the payload was omitted.'
  )
  assert(
    controls.configured.topKValue === '40' &&
      controls.configured.reasoningValue === 'enabled' &&
      controls.configured.effortValue === 'xhigh' &&
      controls.configured.excludeValue === 'true' &&
      !controls.configured.effortDisabled &&
      !controls.configured.excludeDisabled,
    `Generation controls did not retain the configured values: ${JSON.stringify(
      controls.configured
    )}`
  )

  await devTools.send('Page.enable')
  const screenshot = await devTools.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  })
  const resolvedOutput = resolve(outputPath)
  await fs.mkdir(dirname(resolvedOutput), { recursive: true })
  await fs.writeFile(resolvedOutput, Buffer.from(screenshot.data, 'base64'))
  return resolvedOutput
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null) return
  const exitPromise = once(child, 'exit')
  child.kill()
  await withTimeout(
    exitPromise,
    5_000,
    'Electron did not exit after the smoke test.',
    () => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  ).catch(() => undefined)
}

async function closeServer(server) {
  if (!server) return
  server.close()
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  await withTimeout(
    once(server, 'close'),
    2_000,
    'Mock provider did not close promptly.'
  ).catch(() => undefined)
}

async function removeTemporaryDirectory(tempRoot) {
  const resolvedTemporaryRoot = resolve(tempRoot)
  const resolvedSystemTemp = resolve(tmpdir())
  const pathFromSystemTemp = relative(resolvedSystemTemp, resolvedTemporaryRoot)
  assert(
    pathFromSystemTemp.length > 0 &&
      !pathFromSystemTemp.startsWith('..') &&
      !isAbsolute(pathFromSystemTemp),
    `Refusing to remove unexpected temporary path: ${resolvedTemporaryRoot}`
  )
  await fs.rm(resolvedTemporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 150
  })
}

function createSeededRecoveryWorkspace(baseUrl) {
  const now = new Date().toISOString()
  const parameters = {
    temperature: 0.9,
    topP: 1,
    topK: null,
    reasoning: null,
    maxOutputTokens: 256,
    maxTokenField: 'max_tokens',
    presencePenalty: 0,
    frequencyPenalty: 0,
    seed: null,
    stop: [],
    extra: {}
  }
  const connection = {
    baseUrl,
    modelId: 'mock-roleplay-alpha',
    customHeaders: {},
    timeoutMs: 10_000
  }
  return {
    schemaVersion: 1,
    name: 'Seeded recovery workspace',
    createdAt: now,
    updatedAt: now,
    globalMemory: { mode: 'retain-all', maxMessages: 24 },
    settings: { loggingEnabled: false, sendToAllByDefault: true },
    panes: [
      {
        id: 'recovery-pane',
        name: 'Recovery lane before close',
        connection,
        parameters,
        roleplay: {
          systemPrompt: 'Stay in character.',
          playerName: 'Player',
          npcName: 'Herika',
          npcBiography: 'A smoke-test character.',
          scenario: 'A response was interrupted.'
        },
        memory: null,
        analysis: {
          enabled: false,
          connection: {
            baseUrl,
            modelId: '',
            customHeaders: {},
            timeoutMs: 10_000
          },
          parameters: { ...parameters, temperature: 0.2 },
          instructions: 'Review the response.'
        },
        messages: [
          {
            id: 'seed-user',
            role: 'user',
            content: 'Are you still there?',
            createdAt: now,
            requestId: 'seed-interrupted'
          },
          {
            id: 'seed-assistant',
            role: 'assistant',
            content: 'A half-finished answer',
            createdAt: now,
            requestId: 'seed-interrupted',
            pending: true
          }
        ]
      }
    ],
    selectedPaneId: 'recovery-pane'
  }
}

async function inspectRecoveryUi() {
  const lane = document.querySelector('.model-lane')
  if (!lane) return { loaded: false }
  const card = lane.querySelector('.assistant-card')
  const laneName = lane.querySelector('.lane-name-input')?.value ?? ''
  const metaText = lane.querySelector('.lane-meta')?.textContent ?? ''
  const composer = lane.querySelector('.lane-composer textarea')
  return {
    loaded: laneName.length > 0 && Boolean(card),
    laneName,
    assistantText: card?.textContent ?? '',
    interrupted:
      card?.textContent?.includes(
        'This response was interrupted when Roleplay Lab closed and was not added to model context.'
      ) ?? false,
    pendingVisual:
      card?.classList.contains('streaming') ||
      Boolean(card?.querySelector('[aria-label="Streaming"]')),
    generatingStatus: metaText.includes('Generating'),
    stopControl: Boolean(lane.querySelector('.send-button.stop')),
    sendControl: Boolean(lane.querySelector('.send-button:not(.stop)')),
    composerDisabled: composer?.disabled ?? true
  }
}

function focusAndSelectLaneName() {
  const input = document.querySelector('.lane-name-input')
  if (!(input instanceof HTMLInputElement)) throw new Error('Recovery lane name input was not found.')
  window.__roleplaySmokeInputEvents = []
  for (const eventName of ['beforeinput', 'input', 'change']) {
    input.addEventListener(
      eventName,
      () => window.__roleplaySmokeInputEvents.push(eventName),
      { once: true }
    )
  }
  input.focus()
  input.select()
  return { selected: true, previousValue: input.value }
}

function verifyNativeEdit(expectedName) {
  const input = document.querySelector('.lane-name-input')
  if (!(input instanceof HTMLInputElement)) throw new Error('Recovery lane name input was not found.')
  if (input.value !== expectedName) {
    throw new Error(`Native input edit produced "${input.value}" instead of "${expectedName}".`)
  }
  return {
    applied: true,
    visibleValue: input.value,
    inputEvents: window.__roleplaySmokeInputEvents
  }
}

async function rendererTransportSuite(baseUrl) {
  const assertInRenderer = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const connection = {
    baseUrl,
    modelId: 'mock-roleplay-alpha',
    apiKey: 'smoke-secret',
    customHeaders: { 'X-Smoke-Test': 'transport' },
    timeoutMs: 10_000
  }
  const parameters = {
    temperature: 0.8,
    topP: 0.95,
    topK: 40,
    reasoning: {
      enabled: true,
      exclude: true,
      effort: 'medium'
    },
    maxOutputTokens: 128,
    maxTokenField: 'max_tokens',
    presencePenalty: 0,
    frequencyPenalty: 0,
    seed: null,
    stop: [],
    extra: {}
  }

  const captureChat = (requestId, prompt, cancelOnFirstDelta = false) =>
    new Promise((resolveCapture, rejectCapture) => {
      const events = []
      let cancellationPromise
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        unsubscribe()
        rejectCapture(new Error(`Timed out waiting for ${requestId}.`))
      }, 12_000)
      const finish = async (terminal) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        unsubscribe()
        const cancellationAccepted = cancellationPromise
          ? await cancellationPromise
          : undefined
        resolveCapture({ events, terminal, cancellationAccepted })
      }
      const unsubscribe = window.rpCompare.chat.onEvent((event) => {
        if (event.requestId !== requestId) return
        events.push(event)
        if (cancelOnFirstDelta && event.type === 'delta' && !cancellationPromise) {
          cancellationPromise = window.rpCompare.chat.cancel({ requestId })
        }
        if (
          event.type === 'done' ||
          event.type === 'error' ||
          event.type === 'cancelled'
        ) {
          void finish(event)
        }
      })
      void window.rpCompare.chat
        .start({
          requestId,
          paneId: `pane-${requestId}`,
          connection,
          parameters,
          messages: [{ role: 'user', content: prompt }],
          logLabel: `Transport smoke ${requestId}`
        })
        .catch((error) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          unsubscribe()
          rejectCapture(error)
        })
    })

  assertInRenderer(window.rpCompare, 'The preload bridge was not installed.')
  const appInfo = await window.rpCompare.app.getInfo()
  const listed = await window.rpCompare.models.list(connection)
  assertInRenderer(listed.models.length === 2, 'Model listing returned the wrong count.')
  assertInRenderer(
    listed.models[0].id === 'mock-roleplay-alpha',
    'Model listing was not normalized and sorted.'
  )

  const normal = await captureChat('smoke-normal', 'normal')
  assertInRenderer(normal.terminal.type === 'done', 'Normal stream did not complete.')
  assertInRenderer(
    normal.terminal.text === 'Hello from mock roleplay!',
    `Normal stream accumulated unexpected text: ${normal.terminal.text}`
  )
  assertInRenderer(normal.terminal.finishReason === 'stop', 'Finish reason was not preserved.')
  assertInRenderer(normal.terminal.usage?.totalTokens === 17, 'Usage was not preserved.')
  assertInRenderer(
    normal.events.filter((event) => event.type === 'delta').length === 3,
    'Normal stream did not emit all expected deltas.'
  )

  const [providerError, isolatedSuccess, cancelled] = await Promise.all([
    captureChat('smoke-error', 'error-me'),
    captureChat('smoke-isolated', 'isolation-ok'),
    captureChat('smoke-cancel', 'cancel-me', true)
  ])
  assertInRenderer(providerError.terminal.type === 'error', 'Provider error was not isolated.')
  assertInRenderer(
    providerError.terminal.error?.code === 'RATE_LIMITED',
    `Provider error code was ${providerError.terminal.error?.code}.`
  )
  assertInRenderer(
    providerError.terminal.error?.providerMessage === 'intentional smoke-test limit',
    'Provider error detail was not parsed.'
  )
  assertInRenderer(
    isolatedSuccess.terminal.type === 'done' &&
      isolatedSuccess.terminal.text === 'isolated stream survived',
    'A neighboring provider error contaminated the successful stream.'
  )
  assertInRenderer(cancelled.cancellationAccepted === true, 'Cancellation was not acknowledged.')
  assertInRenderer(cancelled.terminal.type === 'cancelled', 'Cancellation was not terminal.')
  assertInRenderer(
    cancelled.terminal.text.startsWith('partial '),
    'Partial text was not preserved on cancellation.'
  )

  return {
    appInfo,
    modelIds: listed.models.map((model) => model.id),
    normal: {
      text: normal.terminal.text,
      finishReason: normal.terminal.finishReason,
      totalTokens: normal.terminal.usage?.totalTokens
    },
    isolated: isolatedSuccess.terminal.text,
    errorCode: providerError.terminal.error?.code,
    cancelledText: cancelled.terminal.text
  }
}

async function main() {
  for (const bundle of REQUIRED_BUNDLES) {
    try {
      await fs.access(bundle)
    } catch {
      throw new Error(
        `Missing ${relative(ROOT, bundle)}. Run this test with "pnpm test:transport".`
      )
    }
  }

  const tempRoot = await fs.mkdtemp(join(tmpdir(), 'roleplay-lab-transport-'))
  let mock
  let electron
  let devTools
  try {
    mock = await createMockProvider()
    ;({ child: electron, devTools } = await launchConnectedElectron(tempRoot))

    let generationScreenshot
    if (process.env.ROLEPLAY_SMOKE_SCREENSHOT) {
      generationScreenshot = await captureGenerationControls(
        devTools,
        process.env.ROLEPLAY_SMOKE_SCREENSHOT
      )
    }

    const expression = `(${rendererTransportSuite.toString()})(${JSON.stringify(mock.baseUrl)})`
    const result = await withTimeout(
      devTools.evaluate(expression),
      SUITE_TIMEOUT_MS,
      'The renderer transport suite exceeded its timeout.'
    )

    const workspacePath = resolve(result.appInfo.workspacePath)
    const pathFromTempRoot = relative(resolve(tempRoot), workspacePath)
    assert(
      pathFromTempRoot.length > 0 &&
        !pathFromTempRoot.startsWith('..') &&
        !isAbsolute(pathFromTempRoot),
      `Electron user data escaped the isolated test directory: ${workspacePath}`
    )
    await waitFor(
      () => mock.state.cancellationObserved,
      2_000,
      'the mock server to observe connection cancellation'
    )
    assert(mock.state.modelRequests === 1, `Expected 1 model request, got ${mock.state.modelRequests}.`)
    assert(mock.state.chatRequests === 4, `Expected 4 chat requests, got ${mock.state.chatRequests}.`)
    assert(
      mock.state.violations.length === 0,
      `Mock provider violations:\n- ${mock.state.violations.join('\n- ')}`
    )

    devTools.close()
    devTools = undefined
    await terminateChild(electron)
    electron = undefined

    const seededWorkspace = createSeededRecoveryWorkspace(mock.baseUrl)
    await fs.mkdir(dirname(workspacePath), { recursive: true })
    await fs.writeFile(workspacePath, `${JSON.stringify(seededWorkspace, null, 2)}\n`, 'utf8')
    const preLaunchSeed = JSON.parse(await fs.readFile(workspacePath, 'utf8'))
    assert(
      preLaunchSeed.panes[0].messages[1].pending === true,
      'The recovery fixture was not seeded with a pending assistant response.'
    )

    ;({ child: electron, devTools } = await launchConnectedElectron(tempRoot))
    const recoveredBeforeClose = await waitFor(
      async () => {
        const state = await devTools.evaluate(`(${inspectRecoveryUi.toString()})()`)
        return state.loaded ? state : undefined
      },
      5_000,
      'the seeded recovery lane'
    )
    assert(
      recoveredBeforeClose.interrupted,
      'A pre-seeded pending response was not marked interrupted on restore.'
    )
    assert(
      !recoveredBeforeClose.pendingVisual &&
        !recoveredBeforeClose.generatingStatus &&
        !recoveredBeforeClose.stopControl &&
        recoveredBeforeClose.sendControl &&
        !recoveredBeforeClose.composerDisabled,
      `The recovered lane remained locked: ${JSON.stringify(recoveredBeforeClose)}`
    )

    const closeFlushName = 'Close flush persisted this lane'
    const selection = await devTools.evaluate(`(${focusAndSelectLaneName.toString()})()`)
    assert(selection.selected, 'The recovery lane name could not be selected for editing.')
    const editStartedAt = Date.now()
    await devTools.send('Input.insertText', { text: closeFlushName })
    const closeEdit = await devTools.evaluate(
      `(${verifyNativeEdit.toString()})(${JSON.stringify(closeFlushName)})`
    )
    assert(
      closeEdit.applied &&
        closeEdit.visibleValue === closeFlushName &&
        closeEdit.inputEvents.includes('input'),
      'The immediate pre-close edit was not applied in the renderer.'
    )
    // Let React commit the native input event, but remain comfortably below the
    // renderer's 850 ms autosave debounce before exercising the close handshake.
    await delay(100)
    const exitPromise = once(electron, 'exit')
    const closeStartedAt = Date.now()
    void devTools.send('Browser.close').catch(() => undefined)
    const [closeExitCode] = await withTimeout(
      exitPromise,
      4_500,
      'Electron did not finish the close-flush handshake.'
    )
    const closeElapsedMs = Date.now() - closeStartedAt
    const editToExitMs = Date.now() - editStartedAt
    assert(closeExitCode === 0, `Electron exited with code ${String(closeExitCode)} after close flush.`)
    assert(
      editToExitMs < 825,
      `Edit-to-exit took ${editToExitMs} ms, so persistence may have relied on the 850 ms autosave debounce.`
    )
    devTools.close()
    devTools = undefined
    electron = undefined

    const closeFlushedWorkspace = JSON.parse(await fs.readFile(workspacePath, 'utf8'))
    const closeFlushedPane = closeFlushedWorkspace.panes.find(
      (pane) => pane.id === 'recovery-pane'
    )
    const interruptedMessage = closeFlushedPane?.messages.find(
      (message) => message.id === 'seed-assistant'
    )
    assert(
      closeFlushedPane?.name === closeFlushName,
      `The edit made immediately before close was not persisted (saved name: ${String(
        closeFlushedPane?.name
      )}; renderer edit: ${JSON.stringify(closeEdit)}).`
    )
    assert(
      interruptedMessage?.pending === false &&
        typeof interruptedMessage.error === 'string' &&
        interruptedMessage.error.includes('interrupted when Roleplay Lab closed'),
      'The close-flushed workspace did not persist the assistant as interrupted.'
    )

    ;({ child: electron, devTools } = await launchConnectedElectron(tempRoot))
    const restoredAfterClose = await waitFor(
      async () => {
        const state = await devTools.evaluate(`(${inspectRecoveryUi.toString()})()`)
        return state.loaded && state.laneName === closeFlushName ? state : undefined
      },
      5_000,
      'the close-flushed workspace on relaunch'
    )
    assert(
      restoredAfterClose.interrupted &&
        !restoredAfterClose.pendingVisual &&
        !restoredAfterClose.generatingStatus &&
        !restoredAfterClose.stopControl &&
        restoredAfterClose.sendControl,
      `The relaunched lane was not usable after recovery: ${JSON.stringify(restoredAfterClose)}`
    )

    console.log('OpenAI-compatible Electron transport smoke test passed.')
    console.log(`  Models: ${result.modelIds.join(', ')}`)
    console.log(
      `  Stream: "${result.normal.text}" (${result.normal.finishReason}, ${result.normal.totalTokens} tokens)`
    )
    console.log(`  Isolation: "${result.isolated}" alongside ${result.errorCode}`)
    console.log(`  Cancellation preserved: "${result.cancelledText}"`)
    if (generationScreenshot) console.log(`  Generation UI: ${generationScreenshot}`)
    console.log(
      `  Close flush: "${closeFlushedPane.name}" persisted ${editToExitMs} ms after editing (${closeElapsedMs} ms close handshake)`
    )
    console.log('  Recovery: pending assistant restored as interrupted; lane remained usable')
  } catch (error) {
    const electronOutput = electron?.capturedOutput?.().trim()
    if (electronOutput) {
      console.error('\nElectron output (tail):')
      console.error(electronOutput)
    }
    throw error
  } finally {
    if (devTools) {
      await devTools.send('Browser.close').catch(() => undefined)
      await delay(300)
    }
    devTools?.close()
    await terminateChild(electron)
    await closeServer(mock?.server)
    await removeTemporaryDirectory(tempRoot)
  }
}

main().catch((error) => {
  console.error(
    `OpenAI-compatible transport smoke test failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }`
  )
  process.exitCode = 1
})
