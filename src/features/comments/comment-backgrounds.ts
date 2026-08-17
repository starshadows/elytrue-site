import { BACKGROUNDS } from '../../config/assets'

const RECENT_LIMIT = 5
const assignments = new Map<string, string>()
const recent: string[] = []
let bag: string[] = []

function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[target]] = [result[target]!, result[index]!]
  }
  return result
}

function availablePortraits(): string[] {
  const startup = window.__ELY_VISIT_ASSETS__?.commentBackgrounds
  if (startup?.length) return [...startup]
  return shuffle(
    BACKGROUNDS.filter(({ layout }) => layout === 'portrait').map(
      ({ preview }) => preview,
    ),
  )
}

function refill(): void {
  const candidates = availablePortraits()
  const fresh = candidates.filter((source) => !recent.includes(source))
  bag = fresh.length ? shuffle(fresh) : shuffle(candidates)
}

export function commentBackground(key: string | number): string {
  const stableKey = String(key)
  const assigned = assignments.get(stableKey)
  if (assigned) return assigned
  if (!bag.length) refill()
  const source = bag.shift() ?? availablePortraits()[0] ?? ''
  assignments.set(stableKey, source)
  recent.push(source)
  if (recent.length > RECENT_LIMIT) recent.shift()
  return source
}

export function resetCommentBackgroundsForTest(): void {
  assignments.clear()
  recent.length = 0
  bag = []
}
