/** Evaluation projections exclude system text, arguments, reasoning, and attachments. */
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { EvaluationMessage } from './jev.ts'

/**
 * Select the latest eight eligible messages after stripping non-body content.
 * @param messages - chronological history plus accepted, not-yet-logged input.
 * @param question - model selection excludes all tool results.
 * @returns bounded text messages; user/assistant text is untouched here and only shortened by {@link fitMessages}.
 */
export function evaluationMessages(messages: readonly RequestMessage[], question: 'model' | 'effort'): EvaluationMessage[] {
  const result: EvaluationMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') continue
    if (message.role === 'tool' && question === 'model') continue
    if (message.role === 'user' && 'source' in message && message.source?.kind !== 'user') continue
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (!text.trim()) continue
    result.push({ role: message.role, text: message.role === 'tool' ? Array.from(text).slice(0, 1600).join('') : text })
  }
  return result.slice(-8)
}

/** Messages admitted under the request byte limit, with what was left out. */
export interface Fitted {
  readonly messages: EvaluationMessage[]
  /** Whole messages removed, oldest first. */
  readonly dropped: number
  /** Characters removed from the middle of the kept message; 0 when it is intact. */
  readonly omitted: number
}

/** Visible to Jev in place of the removed middle, so the original size remains evidence. */
function omission(omitted: number, total: number): string {
  return `\n[… omitted ${omitted} of ${total} characters …]\n`
}

/**
 * Shrink evaluation input until `fits` accepts it.
 * First drop whole messages oldest first, never the latest user message (or, without one, the last message).
 * If that message alone is still too large, keep its head and tail and mark the omitted middle.
 * @param messages - output of {@link evaluationMessages}.
 * @param fits - whether a candidate list keeps the serialized request within its limit.
 * @returns the largest accepted list, or undefined when even one character of the kept message does not fit.
 */
export function fitMessages(messages: readonly EvaluationMessage[], fits: (messages: EvaluationMessage[]) => boolean): Fitted | undefined {
  const kept = [...messages]
  if (fits(kept)) return { messages: kept, dropped: 0, omitted: 0 }
  if (kept.length === 0) return undefined
  let anchor = kept.length - 1
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    if (kept[index]!.role === 'user') { anchor = index; break }
  }
  let dropped = 0
  while (kept.length > 1) {
    const index = anchor === 0 ? 1 : 0
    kept.splice(index, 1)
    dropped += 1
    if (index < anchor) anchor -= 1
    if (fits(kept)) return { messages: kept, dropped, omitted: 0 }
  }
  const { role, text } = kept[0]!
  const chars = Array.from(text)
  const shorten = (keep: number): EvaluationMessage[] => [{ role, text:
    chars.slice(0, Math.ceil(keep / 2)).join('') + omission(chars.length - keep, chars.length)
    + chars.slice(chars.length - Math.floor(keep / 2)).join('') }]
  let best = 0
  for (let low = 1, high = chars.length - 1; low <= high;) {
    const middle = Math.floor((low + high) / 2)
    if (fits(shorten(middle))) { best = middle; low = middle + 1 } else high = middle - 1
  }
  if (best === 0) return undefined
  return { messages: shorten(best), dropped, omitted: chars.length - best }
}
