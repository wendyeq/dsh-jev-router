/** Atomic router sidecars; invalid records fail rather than choose another route. */
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { PersistedRouter } from './types.ts'

const effortWire = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  requestEffort: z.string().min(1),
  effectiveEffort: z.string().min(1),
}).strict()

const persisted = z.object({
  version: z.literal(1),
  selection: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() }).strict(),
  afterSeq: z.number().int().min(-1),
  pin: z.object({ provider: z.string().min(1), model: z.string().min(1), selectedAt: z.number().finite() }).strict().nullable(),
  effortWire: effortWire.optional(),
}).strict() satisfies z.ZodType<PersistedRouter>

/** @returns the default router sidecar directory. */
export function defaultStateDirectory(): string {
  return join(homedir(), '.dsh-jev-router', 'sessions')
}

/** One sidecar per Session. The wire baseline is not the user's effort selection. */
export class RouterStore {
  private readonly cache = new Map<SessionId, PersistedRouter>()

  /** @param directory - absolute directory for session records. */
  constructor(private readonly directory: string) {}

  /** @param sessionId - durable Session identity.
   * @returns the saved record, or undefined when no routing choice has been saved.
   */
  read(sessionId: SessionId): PersistedRouter | undefined {
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    let text: string
    try {
      text = readFileSync(this.file(sessionId), 'utf8')
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    const value = persisted.parse(JSON.parse(text))
    this.cache.set(sessionId, value)
    return value
  }

  /** @param sessionId - durable Session identity.
   * @param next - complete replacement; published to memory only after rename succeeds.
   */
  write(sessionId: SessionId, next: PersistedRouter): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = this.file(sessionId)
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 })
      renameSync(temporary, file)
    } finally {
      rmSync(temporary, { force: true })
    }
    this.cache.set(sessionId, next)
  }

  private file(sessionId: SessionId): string {
    return join(this.directory, `${encodeURIComponent(sessionId)}.json`)
  }
}
