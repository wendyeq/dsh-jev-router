import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCheck, main, summarizeLedger } from '../skills/dsh-jev-router-inspect/scripts/inspect.mjs'

const cleanup: string[] = []
afterEach(() => { for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const policy = {
  version: 1,
  candidates: [
    { provider: 'test', model: 'gpt-6-luna', description: 'fixture-luna' },
    { provider: 'test', model: 'gpt-6-sol', description: 'fixture-sol' },
    { model: 'gpt-6-astra', description: 'fixture-astra' },
  ],
  effortDescriptions: {},
  effortFloors: { 'gpt-6-sol': 'medium' },
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jev-inspect-'))
  cleanup.push(root)
  const stateDir = join(root, 'state')
  const dshHome = join(root, 'dsh')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, '_policy.json'), JSON.stringify(policy))
  const sidecar = (id: string, value: object, ledger: object[], mtime: number) => {
    writeFileSync(join(stateDir, `${id}.json`), JSON.stringify(value))
    writeFileSync(join(stateDir, `${id}.ledger.jsonl`), ledger.map(entry => JSON.stringify(entry)).join('\n') + '\n{"torn')
    utimesSync(join(stateDir, `${id}.json`), mtime, mtime)
    utimesSync(join(stateDir, `${id}.ledger.jsonl`), mtime, mtime)
  }
  sidecar('session-old', { version: 1, selection: { provider: 'test', model: 'gpt-6-luna', reasoningEffort: 'low' }, afterSeq: 1, pin: null }, [], 1000)
  sidecar('session-new', {
    version: 1, selection: { provider: 'auto', model: 'jev', reasoningEffort: 'auto/jev' }, afterSeq: 2,
    pin: { provider: 'test', model: 'gpt-6-sol', selectedAt: Date.UTC(2026, 8, 24) },
    effortWire: { provider: 'test', model: 'gpt-6-sol', requestEffort: 'medium', effectiveEffort: 'high' },
  }, [
    { time: 't1', question: 'model', outcome: 'chosen', model: 'test/gpt-6-sol', attempts: 1, inputTokens: 400, outputTokens: 20, cost: 0.001 },
    { time: 't2', question: 'effort', outcome: 'chosen', model: 'test/gpt-6-sol', choice: 'medium', attempts: 2, inputTokens: 300, outputTokens: 10, cost: 0.0005, dropped: 3 },
    { time: 't3', question: 'effort', outcome: 'unavailable', model: 'test/gpt-6-sol', reason: 'HTTP 503', attempts: 3 },
    { time: 't4', question: 'effort', outcome: 'fallback', model: 'test/gpt-6-sol', choice: 'medium', source: 'previous', reason: 'HTTP 503' },
    { time: 't5', question: 'effort', outcome: 'chosen', model: 'test/gpt-6-sol', choice: 'high', attempts: 1, inputTokens: 1000, outputTokens: 10 },
  ], 2000)
  const logDirectory = join(dshHome, 'sessions', '--Users-me-project--', 'session-new')
  mkdirSync(logDirectory, { recursive: true })
  const events = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'runtime-context' } } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Design the cross-system migration' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'SECRET-REASONING' }, { type: 'text', text: 'Here is a plan' }] } } },
    { type: 'tool/result', data: { content: [{ type: 'text', text: 'SECRET-TOOL' }] } },
  ]
  writeFileSync(join(logDirectory, 'session.v4.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
  return { stateDir, dshHome, args: ['--state-dir', stateDir, '--dsh-home', dshHome] }
}

it('lists sessions newest first with their selection, effort and usage totals', async () => {
  const { args } = fixture()
  expect(await main(['sessions', ...args])).toEqual([
    expect.objectContaining({ id: 'session-new', model: 'test/gpt-6-sol', modelMode: 'auto (pinned)', effortMode: 'auto', effort: 'high',
      evaluations: 4, inputTokens: 1700, outputTokens: 40, gatewayCostUsd: 0.0015 }),
    expect.objectContaining({ id: 'session-old', model: 'test/gpt-6-luna', modelMode: 'specified', effortMode: 'specified', effort: 'low', evaluations: 0 }),
  ])
})

it('summarizes effort distribution, fallbacks, failures, shortening and cost for one session', async () => {
  const { args, dshHome } = fixture()
  const shown = await main(['show', 'latest', ...args, '--input-price', '0.5', '--output-price', '2']) as Record<string, any>
  expect(shown.id).toBe('session-new')
  expect(shown.sessionLog).toBe(join(dshHome, 'sessions', '--Users-me-project--', 'session-new', 'session.v4.jsonl'))
  expect(shown.policy).toEqual({ candidates: ['test/gpt-6-luna', 'test/gpt-6-sol', 'gpt-6-astra'], effortFloors: { 'gpt-6-sol': 'medium' } })
  expect(shown.ledger).toMatchObject({
    records: 5,
    effortsByModel: { 'test/gpt-6-sol': { medium: 2, high: 1 } },
    fallbackSources: { previous: 1 },
    failureReasons: { 'HTTP 503': 2 },
    shortenedEvaluations: 1,
    usage: { evaluations: 4, httpAttempts: 7, inputTokens: 1700, outputTokens: 40, gatewayCostUsd: 0.0015,
      estimatedCostUsd: (1700 * 0.5 + 40 * 2) / 1e6, evaluationsWithoutUsage: 1 },
  })
  expect(summarizeLedger([]).usage.estimatedCostUsd).toBeNull()
  await expect(main(['show', 'missing', ...args])).rejects.toThrow('no router session missing')
  await expect(main(['show', 'latest', ...args, '--input-price', '-1'])).rejects.toThrow('non-negative')
})

it('offers keep plus every other candidate and sends only user and assistant body text', async () => {
  const { args } = fixture()
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({
    answers: { route: { choice: 'alt-1', probabilities: { keep: 0.3, 'alt-0': 0.05, 'alt-1': 0.65 } } },
    usage: { inputTokens: 520, outputTokens: 12 }, providerMetadata: { gateway: { cost: '0.00002' } },
  }))
  const result = await main(['check', 'session-new', ...args], { env: { AI_GATEWAY_API_KEY: 'key' }, fetcher }) as Record<string, any>
  expect(result).toMatchObject({ current: 'test/gpt-6-sol', suggestion: 'gpt-6-astra', alternatives: ['test/gpt-6-luna', 'gpt-6-astra'],
    probabilities: { keep: 0.3, 'test/gpt-6-luna': 0.05, 'gpt-6-astra': 0.65 },
    usage: { attempts: 1, inputTokens: 520, outputTokens: 12, gatewayCostUsd: 0.00002 } })
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body))
  expect(body.state.messages).toEqual([{ role: 'user', text: 'Design the cross-system migration' }, { role: 'assistant', text: 'Here is a plan' }])
  expect(Object.keys(body.questions.route.criteria)).toEqual(['keep', 'alt-0', 'alt-1'])
  expect(body.questions.route.criteria.keep).toContain('fixture-sol')
  expect(JSON.stringify(body)).not.toMatch(/SECRET|runtime context/)
})

it('dry-run and missing credentials make no request', async () => {
  const { args } = fixture()
  const fetcher = vi.fn<typeof fetch>()
  expect(await main(['check', 'latest', ...args, '--dry-run'], { env: {}, fetcher })).toMatchObject({ sentMessages: 2, requestBytes: expect.any(Number) })
  await expect(main(['check', 'latest', ...args], { env: {}, fetcher })).rejects.toThrow('AI_GATEWAY_API_KEY')
  expect(fetcher).not.toHaveBeenCalled()
})

it('retries a temporary gateway failure and rejects an answer outside the offered keys', async () => {
  const { args } = fixture()
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ answers: { route: { choice: 'keep' } } }))
  expect(await main(['check', 'latest', ...args], { env: { AI_GATEWAY_API_KEY: 'key' }, fetcher })).toMatchObject({ suggestion: 'keep', usage: { attempts: 2 } })
  const invalid = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: '9' } } }))
  await expect(main(['check', 'latest', ...args], { env: { AI_GATEWAY_API_KEY: 'key' }, fetcher: invalid })).rejects.toThrow('outside the offered criteria')
})

it('keeps a check within the request limit by shortening the latest user message', () => {
  const check = buildCheck('test/gpt-6-sol', policy as never, [{ role: 'assistant', text: 'old' }, { role: 'user', text: '汉'.repeat(20000) }])
  expect(Buffer.byteLength(check.body)).toBeLessThanOrEqual(28000)
  expect(check.sentMessages).toBe(1)
  expect(check.body).toContain('of 20000 characters')
})

it('runs as a CLI and reports errors on stderr', () => {
  const { args } = fixture()
  const script = join(import.meta.dirname, '..', 'skills', 'dsh-jev-router-inspect', 'scripts', 'inspect.mjs')
  const ok = spawnSync(process.execPath, [script, 'sessions', ...args, '--limit', '1'], { encoding: 'utf8' })
  expect(ok.status).toBe(0)
  expect(JSON.parse(ok.stdout)).toHaveLength(1)
  const linked = join(mkdtempSync(join(tmpdir(), 'jev-link-')), 'skill')
  cleanup.push(join(linked, '..'))
  symlinkSync(join(script, '..', '..'), linked)
  const viaLink = spawnSync(process.execPath, [join(linked, 'scripts', 'inspect.mjs'), 'sessions', ...args], { encoding: 'utf8' })
  expect(JSON.parse(viaLink.stdout)).toHaveLength(2)
  const bad = spawnSync(process.execPath, [script, 'nope'], { encoding: 'utf8' })
  expect(bad.status).toBe(1)
  expect(bad.stderr).toContain('Usage:')
})
