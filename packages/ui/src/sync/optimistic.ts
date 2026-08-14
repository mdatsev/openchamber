import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { compareMessages, findMessageInsertionIndex } from "./message-ordering"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

export type OptimisticItem = {
  message: Message
  parts: Part[]
}

export type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => Binary.search(parts, part.id, (item) => item.id).found)
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = Binary.search(next, part.id, (item) => item.id)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    const found = session.some((message) => message.id === item.message.id)
    if (!found) session.splice(findMessageInsertionIndex(session, item.message), 0, item.message)

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()]
      .sort((a, b) => cmp(a[0], b[0]))
      .map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

/** Merge two chronologically sorted message arrays, deduplicating.
 *  Preserves references from `a` for items that already exist — avoids
 *  unnecessary React re-renders when prepending older history. */
export function mergeMessages<T extends Message>(a: readonly T[], b: readonly T[]) {
  const existing = new Map(a.map((item) => [item.id, item] as const))
  let changed = false
  for (const item of b) {
    if (!existing.has(item.id)) {
      existing.set(item.id, item)
      changed = true
    }
  }
  if (!changed && a.every((message, index) => index === 0 || compareMessages(a[index - 1], message) <= 0)) {
    return a as T[]
  }
  return [...existing.values()].sort(compareMessages) as T[]
}
