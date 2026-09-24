/** Evaluation projections exclude system text, arguments, reasoning, and attachments. */
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { EvaluationMessage } from './jev.ts'

/**
 * Select the latest eight eligible messages after stripping non-body content.
 * @param messages - chronological history plus accepted, not-yet-logged input.
 * @param question - model selection excludes all tool results.
 * @returns bounded text messages; user/assistant text is never silently truncated.
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
