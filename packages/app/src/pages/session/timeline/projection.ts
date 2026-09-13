import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { createMemo, type Accessor } from "solid-js"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow } from "./rows"

export { reuseTimelineRows } from "./row-reconciliation"

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  sessionMessages: Accessor<SessionMessageInfo[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
  inlineComments: Accessor<boolean>
}) {
  // One pass over messages and one over rows feeds every derived map; streaming deltas used
  // to re-run each of these as separate full-list memos per change.
  const messageIndex = createMemo(() => {
    const byID = new Map<string, Message>()
    const assistantsByParent = new Map<string, AssistantMessage[]>()
    for (const message of input.messages()) {
      byID.set(message.id, message)
      if (message.role !== "assistant") continue
      const list = assistantsByParent.get(message.parentID)
      if (list) list.push(message)
      if (!list) assistantsByParent.set(message.parentID, [message])
    }
    return { byID, assistantsByParent }
  })
  const projection = createMemo(() =>
    Timeline.constructSessionMessageRows(
      input.sessionMessages(),
      (messageID) => messageIndex().byID.get(messageID) as UserMessage | AssistantMessage | undefined,
      input.parts,
      input.showReasoningSummaries(),
      input.status().type,
      input.inlineComments(),
      input.userMessages(),
    ),
  )
  const activeMessageID = createMemo(() => projection().activeMessageID)
  const rows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
    reuseTimelineRows(previous, projection().rows),
  )
  const rowIndexes = createMemo(() => {
    const byKey = new Map<string, TimelineRow.TimelineRow>()
    const firstIndex = new Map<string, number>()
    const lastIndex = new Map<string, number>()
    const lastGroupKey = new Map<string, string>()
    rows().forEach((row, index) => {
      byKey.set(TimelineRow.key(row), row)
      if (!("userMessageID" in row)) return
      if (!firstIndex.has(row.userMessageID)) firstIndex.set(row.userMessageID, index)
      lastIndex.set(row.userMessageID, index)
      if (row._tag === "AssistantPart") lastGroupKey.set(row.userMessageID, row.group.key)
    })
    return { byKey, firstIndex, lastIndex, lastGroupKey }
  })

  return {
    activeMessageID,
    assistantMessagesByParent: () => messageIndex().assistantsByParent,
    lastAssistantGroupKey: () => rowIndexes().lastGroupKey,
    messageByID: () => messageIndex().byID,
    messageRowIndex: () => rowIndexes().firstIndex,
    messageLastRowIndex: () => rowIndexes().lastIndex,
    rowByKey: () => rowIndexes().byKey,
    rows,
  }
}
