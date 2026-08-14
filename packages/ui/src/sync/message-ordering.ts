import type { Message } from "@opencode-ai/sdk/v2/client"

// See docs/records/incident-message-order-rollover.md: OpenCode IDs are opaque.
const compareIDs = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

export function compareMessages(left: Message, right: Message) {
  const leftCreated = left.time?.created
  const rightCreated = right.time?.created
  if (typeof leftCreated !== "number" || typeof rightCreated !== "number") {
    return compareIDs(left.id, right.id)
  }
  return leftCreated - rightCreated || compareIDs(left.id, right.id)
}

export function findMessageInsertionIndex(messages: readonly Message[], message: Message) {
  let left = 0
  let right = messages.length

  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if (compareMessages(messages[middle], message) < 0) left = middle + 1
    else right = middle
  }

  return left
}
