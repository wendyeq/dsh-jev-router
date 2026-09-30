import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, vi } from 'vitest'

export interface StoredRequest {
  time: string
  sessionId: string
  body: string
}

export function requestRecords(stateDirectory: string, sessionId: string): StoredRequest[] {
  let text: string
  try {
    text = readFileSync(join(stateDirectory, 'requests', `${encodeURIComponent(sessionId)}.jsonl`), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (!text.endsWith('\n')) throw new Error('request append still in progress')
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as StoredRequest)
}

/** Wait for complete JSONL appends before assertions or fixture deletion. */
export async function waitForRequestRecords(stateDirectory: string, sessionId: string, count: number): Promise<StoredRequest[]> {
  await vi.waitFor(() => expect(requestRecords(stateDirectory, sessionId)).toHaveLength(count), { timeout: 5000, interval: 10 })
  return requestRecords(stateDirectory, sessionId)
}
