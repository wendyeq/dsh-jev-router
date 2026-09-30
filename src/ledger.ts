/** Per-session decision and usage records for later inspection; never conversation text or credentials. */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { POLICY_VERSION } from '../../jev-router-policy/src/index.ts'
import type { ResolvedConfig } from './config.ts'
import { replacePrivateFile } from './store.ts'

/** File name of the effective routing policy inside the state directory. */
export const POLICY_FILE = '_policy.json'

/** One evaluation outcome or effort fallback. */
export interface LedgerEntry {
  readonly question: 'model' | 'effort'
  /** `single`: one option, no HTTP. `unavailable`: every attempt failed temporarily. `fallback`: effort used without Jev. */
  readonly outcome: 'chosen' | 'single' | 'unavailable' | 'failed' | 'fallback'
  /** Concrete `provider/model`: the chosen model, or the model whose effort was chosen. */
  readonly model?: string
  /** Effort key; absent on model records, where `model` is the choice. */
  readonly choice?: string
  /** Optional diagnostic distribution; never used to override routing. */
  readonly probabilities?: Record<string, number>
  readonly probabilityStatus?: 'available' | 'missing' | 'invalid'
  /** Fallback source: `previous`, `adapter-default`, or `floor`. */
  readonly source?: string
  /** Short failure label such as `HTTP 503`, `timeout`, or `invalid-answer`; never a response body. */
  readonly reason?: string
  readonly attempts?: number
  readonly durationMs?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  /** USD as reported by the gateway. */
  readonly cost?: number
  readonly dropped?: number
  readonly omittedChars?: number
  /** Shared effort policy. Old logs omit these; new logs do not replace them. */
  readonly policyVersion?: string
  readonly evaluationId?: string
  readonly entryMode?: string
  readonly candidates?: readonly string[]
  readonly currentEffort?: string | null
  readonly rawChoice?: string | null
  readonly rawConfidence?: number | null
  readonly confidenceStatus?: 'available' | 'missing' | 'invalid'
  readonly rawProbabilities?: Record<string, number | null>
  readonly topEffort?: string | null
  readonly topProbability?: number | null
  readonly runnerUpProbability?: number | null
  readonly margin?: number | null
  readonly selectedEffort?: string
  readonly effectiveEffort?: string | null
  readonly requestEffort?: string | null
  readonly decisionReason?: string
  readonly raised?: boolean
  readonly capped?: boolean
  readonly tied?: boolean
  readonly choiceTopMismatch?: boolean
  readonly failureClass?: string | null
  readonly fallbackSource?: string | null
  readonly omittedCodePoints?: number
  /** Normal eight-event window exclusion; independent of transport budget. */
  readonly windowDropped?: number
  /** Additional events excluded to fit the serialized Jev request. */
  readonly budgetDropped?: number
  readonly applyStatus?: 'selected' | 'applied' | 'not-applied' | 'apply-failed' | 'cancelled'
  readonly reused?: boolean
}

/** @param directory - router state directory.
 * @param sessionId - Session the entries belong to.
 * @returns the ledger path, beside the Session's sidecar.
 */
export function ledgerFile(directory: string, sessionId: SessionId): string {
  return join(directory, `${encodeURIComponent(sessionId)}.ledger.jsonl`)
}

/** Append-only writer. A failed write warns and never fails the model request. */
export class Ledger {
  /** @param directory - router state directory.
   * @param warn - Harness warning sink.
   */
  constructor(private readonly directory: string, private readonly warn: (message: string) => void) {}

  /** @param sessionId - owning Session.
   * @param entry - one outcome, stamped with the current time.
   */
  append(sessionId: SessionId, entry: LedgerEntry): void {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      appendFileSync(ledgerFile(this.directory, sessionId),
        JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
    } catch (_error) {
      // Inspection data must never turn a model request into a failed request.
      this.warn('dsh-jev-router: ledger write failed')
    }
  }
}

/**
 * Publish the policy this process routes with, so inspection uses the same candidates and floors.
 * @param config - validated settings; credentials are references and are not written.
 * @param warn - Harness warning sink for a failed write.
 */
export function writePolicy(config: ResolvedConfig, warn: (message: string) => void): void {
  const file = join(config.stateDirectory, POLICY_FILE)
  try {
    replacePrivateFile(config.stateDirectory, file, JSON.stringify({
      version: 1,
      policyVersion: POLICY_VERSION,
      writtenAt: new Date().toISOString(),
      candidates: config.candidates,
      effortDescriptions: config.effortDescriptions,
      effortFloors: config.effortFloors,
    }, null, 2) + '\n')
  } catch (_error) {
    warn('dsh-jev-router: policy snapshot write failed')
  }
}
