/** Validated deployment settings; v1 evaluation ceilings cannot be raised. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { defaultStateDirectory } from './store.ts'

/** Loader configuration; descriptions may change without resetting a session model. */
export const Config = z.object({
  enabled: z.boolean().default(false),
  credentialRefs: z.array(z.string().min(1)).default([]),
  logDecisions: z.boolean().default(false),
  /** Append each evaluation's outcome, tokens and gateway cost to `<stateDirectory>/<session>.ledger.jsonl`. */
  ledger: z.boolean().default(true),
  diagnosticLogFile: z.string().refine(isAbsolute, 'diagnosticLogFile must be absolute').optional(),
  stateDirectory: z.string().refine(isAbsolute, 'stateDirectory must be absolute').default(defaultStateDirectory),
  timeoutMs: z.number().int().positive().max(5000).default(5000),
  maxBodyBytes: z.number().int().positive().max(28000).default(28000),
  candidates: z.array(z.object({
    model: z.string().min(1),
    provider: z.string().min(1).optional(),
    description: z.string().min(1),
  }).strict()).refine(items => new Set(items.map(item => `${item.provider ?? ''}/${item.model}`)).size === items.length,
    'automatic routes must be unique').default([]),
  effortDescriptions: z.record(z.string(), z.record(z.string(), z.string().min(1))).default({}),
  /** Lowest automatic effort per `provider/model` or model ID; explicit user efforts are not affected. */
  effortFloors: z.record(z.string(), z.string().min(1)).default({}),
}).strict()

/** Optional inputs accepted by apply(). */
export type Config = z.input<typeof Config>
/** Fully defaulted settings used by request routing. */
export type ResolvedConfig = z.output<typeof Config>

/** @param config - Loader or same-process configuration.
 * @returns validated settings with explicit defaults.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = Config.parse(config)
  if (resolved.enabled && resolved.candidates.length === 0) throw new Error('enabled Jev routing requires candidates')
  return resolved
}
