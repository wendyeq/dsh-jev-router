/** Request-level effort versus a later configuration update. */
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { EffortWire } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Producer of a configuration-update developer message. */
    'jev-configuration-update': { kind: 'jev-configuration-update' }
  }
}

/** How the next main request should carry `effort` without busting an existing prefix. */
export interface EffortChange {
  /** Value for `reasoning.effort` / `reasoning_effort`. Stable until the model route changes. */
  readonly requestEffort: string
  /** Effort the model should use on this request. */
  readonly effectiveEffort: string
  /** Insert one configuration update before the next user message. */
  readonly append: boolean
  readonly wire: EffortWire
}

interface Route {
  readonly provider: string
  readonly model: string
}

function updateOf(message: RequestMessage | undefined, route: Route): string | undefined {
  if (message?.role !== 'developer' || message.content.length !== 1) return undefined
  const block = message.content[0]
  if (block?.type !== 'configuration-update') return undefined
  if (block.provider !== route.provider || block.model !== route.model) return undefined
  return block.effort
}

/** True when another update can be inserted without sitting directly beside the previous one. */
function separated(history: readonly RequestMessage[], route: Route): boolean {
  let last = -1
  for (let index = 0; index < history.length; index += 1) {
    if (updateOf(history[index], route) !== undefined) last = index
  }
  if (last < 0) return true
  return history.slice(last + 1).some(message => updateOf(message, route) === undefined && message.content.every(block => block.type !== 'configuration-update'))
}

/**
 * Split a chosen effort into 设档 or 中途改档.
 * The first effort for a model route is request-level. A later change appends one
 * configuration update and keeps that request-level value, unless nothing but
 * another update would separate them — the API rejects adjacent updates.
 * @param wire - baseline already committed for this session, if any.
 * @param route - concrete model this request will call.
 * @param effort - effort chosen for this request.
 * @param history - durable history before this request's new user message is logged.
 * @returns the request-level effort to send and whether to record an update.
 */
export function planEffortChange(
  wire: EffortWire | undefined,
  route: Route,
  effort: string,
  history: readonly RequestMessage[],
): EffortChange {
  let recorded: string | undefined
  for (const message of history) {
    const update = updateOf(message, route)
    if (update !== undefined) recorded = update
  }
  const same = wire?.provider === route.provider && wire.model === route.model
  if (!same) {
    const restated = recorded !== undefined && recorded !== effort && separated(history, route)
    const effective = restated || recorded === undefined || recorded === effort ? effort : recorded
    return {
      requestEffort: effort,
      effectiveEffort: effective,
      append: restated,
      wire: { ...route, requestEffort: effort, effectiveEffort: effective },
    }
  }
  const inForce = recorded ?? wire.requestEffort
  if (inForce === effort || !separated(history, route)) {
    return {
      requestEffort: wire.requestEffort,
      effectiveEffort: inForce,
      append: false,
      wire: { ...wire, effectiveEffort: inForce },
    }
  }
  return {
    requestEffort: wire.requestEffort,
    effectiveEffort: effort,
    append: true,
    wire: { ...wire, effectiveEffort: effort },
  }
}
