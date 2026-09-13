import type {
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageShell,
  SessionMessageUser,
} from "@opencode-ai/client/promise"
import type { AssistantMessage, FilePart, Message, Part, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import { Option, Schema } from "effect"

const emptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const emptyModel: { id: string; providerID: string; variant?: string } = { id: "", providerID: "" }
const decodeToolInput = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export function compareMessages(a: Pick<Message, "id" | "time">, b: Pick<Message, "id" | "time">) {
  const left = messageKey(a)
  const right = messageKey(b)
  return left < right ? -1 : left > right ? 1 : 0
}

export const messageKey = (message: Pick<Message, "id" | "time">) => message.time.created + message.id

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeToolInput(name: string, input: Record<string, unknown>) {
  if (!["edit", "write"].includes(name) || typeof input.path !== "string" || typeof input.filePath === "string")
    return input
  return { ...input, filePath: input.path }
}

function normalizeToolMetadata(name: string, metadata: Record<string, unknown>) {
  if (name !== "edit" || !Array.isArray(metadata.files)) return metadata
  const file = metadata.files.find(record)
  if (!file || typeof file.file !== "string") return metadata
  return {
    ...metadata,
    filediff: {
      file: file.file,
      patch: typeof file.patch === "string" ? file.patch : undefined,
      additions: typeof file.additions === "number" ? file.additions : 0,
      deletions: typeof file.deletions === "number" ? file.deletions : 0,
    },
  }
}

// Streaming deltas rebuild the whole message array while keeping untouched message object
// identities, so the fold below is memoized per source message: a cache hit replays its
// emissions instead of re-decoding parts and re-building message objects. Entries also carry
// the fold state (agent/model/parentID) they were computed under, which both validates the
// hit and skips the state transitions. Inputs are the same shapes as the live fold.
type NormalizeModel = { id: string; providerID: string; variant?: string }
type NormalizeCache = {
  agent: string
  model: NormalizeModel
  parentID: string | undefined
  messages: Message[]
  parts: Array<[string, Part[]]>
  compaction: { parentID: string; part: Part } | undefined
  parentAgent: string | undefined
      parentModel: { providerID: string; modelID: string; variant?: string } | undefined
      emittedUser: UserMessage | undefined
  next: { agent: string; model: NormalizeModel; parentID: string | undefined }
}

const normalizeCache = new WeakMap<object, NormalizeCache>()

function sameModel(a: NormalizeModel, b: NormalizeModel) {
  return a === b || (a.id === b.id && a.providerID === b.providerID && a.variant === b.variant)
}

export function normalizeSessionMessages(sessionID: string, source: readonly SessionMessageInfo[]) {
  const messages: Message[] = []
  const parts = new Map<string, Part[]>()
  let agent = ""
  let model: NormalizeModel = emptyModel
  let parentID: string | undefined
  let lastUser: UserMessage | undefined

  source.forEach((message) => {
    const cached = normalizeCache.get(message)
    if (cached && cached.agent === agent && sameModel(cached.model, model) && cached.parentID === parentID) {
      if (cached.messages.length) messages.push(...cached.messages)
      for (const entry of cached.parts) parts.set(entry[0], entry[1])
      if (cached.compaction) {
        const target = cached.compaction.parentID
        parts.set(target, [...(parts.get(target) ?? []), cached.compaction.part])
      }
      if (cached.parentAgent !== undefined && lastUser && lastUser.id === parentID) {
        lastUser.agent = cached.parentAgent
        lastUser.model = cached.parentModel!
      }
      if (cached.emittedUser) lastUser = cached.emittedUser
      agent = cached.next.agent
      model = cached.next.model
      parentID = cached.next.parentID
      return
    }

    const inAgent = agent
    const inModel = model
    const inParentID = parentID
    const outMessages: Message[] = []
    const outParts: Array<[string, Part[]]> = []
    let compaction: { parentID: string; part: Part } | undefined
    let parentAgent: string | undefined
    let parentModel: { providerID: string; modelID: string; variant?: string } | undefined
    let emittedUser: UserMessage | undefined

    if (message.type === "agent-switched") {
      agent = message.agent
    } else if (message.type === "model-switched") {
      model = message.model
    } else if (message.type === "user") {
      parentID = message.id
      const built = userMessage(sessionID, message, agent, model)
      const list = userParts(sessionID, message)
      messages.push(built)
      parts.set(message.id, list)
      outMessages.push(built)
      outParts.push([message.id, list])
      lastUser = built
      emittedUser = built
    } else if (message.type === "synthetic" && message.description?.trim()) {
      parentID = message.id
      const built: UserMessage = {
        id: message.id,
        sessionID,
        role: "user",
        time: message.time,
        agent,
        model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
      }
      const list = [textPart(sessionID, message.id, 0, message.description, true)]
      messages.push(built)
      parts.set(message.id, list)
      outMessages.push(built)
      outParts.push([message.id, list])
      lastUser = built
      emittedUser = built
    } else if (message.type === "shell") {
      const built = shellMessages(sessionID, message, agent, model)
      messages.push(...built)
      outMessages.push(...built)
      const commandList = [textPart(sessionID, message.id, 0, message.command)]
      const shellList = [shellPart(sessionID, message)]
      parts.set(message.id, commandList)
      parts.set(`${message.id}:assistant`, shellList)
      outParts.push([message.id, commandList], [`${message.id}:assistant`, shellList])
      parentID = undefined
    } else if (message.type === "assistant") {
      agent = message.agent
      model = message.model
      if (parentID && lastUser && lastUser.id === parentID) {
        parentAgent = message.agent
        parentModel = { providerID: message.model.providerID, modelID: message.model.id, variant: message.model.variant }
        lastUser.agent = parentAgent
        lastUser.model = parentModel
      }
      if (parentID) {
        const built = assistantMessage(sessionID, parentID, message)
        const list = assistantParts(sessionID, message)
        messages.push(built)
        parts.set(message.id, list)
        outMessages.push(built)
        outParts.push([message.id, list])
      }
    } else if (message.type === "compaction" && parentID) {
      const part: Part = {
        id: `${message.id}:compaction`,
        sessionID,
        messageID: parentID,
        type: "compaction",
        auto: message.reason === "auto",
      }
      const list = [...(parts.get(parentID) ?? []), part]
      parts.set(parentID, list)
      outParts.push([parentID, list])
      compaction = { parentID, part }
    }

    normalizeCache.set(message, {
      agent: inAgent,
      model: inModel,
      parentID: inParentID,
      messages: outMessages,
      parts: outParts,
      compaction,
      parentAgent,
      parentModel,
      emittedUser,
      next: { agent, model, parentID },
    })
  })

  return { messages, parts }
}

function shellMessages(
  sessionID: string,
  message: SessionMessageShell,
  agent: string,
  model: { id: string; providerID: string; variant?: string },
): [UserMessage, AssistantMessage] {
  return [
    {
      id: message.id,
      sessionID,
      role: "user",
      time: { created: message.time.created },
      agent,
      model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
    },
    {
      id: `${message.id}:assistant`,
      sessionID,
      role: "assistant",
      time: message.time,
      parentID: message.id,
      modelID: model.id,
      providerID: model.providerID,
      variant: model.variant,
      mode: agent,
      agent,
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: emptyTokens,
    },
  ]
}

function shellPart(sessionID: string, message: SessionMessageShell): ToolPart {
  const input = { command: message.command }
  const start = message.time.created
  const state: ToolPart["state"] =
    message.status === "running"
      ? { status: "running", input, time: { start } }
      : {
          status: "completed",
          input,
          output: message.output?.output ?? "",
          title: "Shell",
          metadata: {
            status: message.status,
            exit: message.exit,
            truncated: message.output?.truncated,
          },
          time: { start, end: message.time.completed ?? start },
        }
  return {
    id: `${message.id}:tool`,
    sessionID,
    messageID: `${message.id}:assistant`,
    type: "tool",
    callID: message.shellID,
    tool: "bash",
    state,
  }
}

export function sessionMessagePartID(messageID: string, type: "text" | "reasoning", ordinal: number) {
  return `${messageID}:${type}:${ordinal}`
}

function userMessage(
  sessionID: string,
  message: SessionMessageUser,
  agent: string,
  model: { id: string; providerID: string; variant?: string },
): UserMessage {
  return {
    id: message.id,
    sessionID,
    role: "user",
    time: message.time,
    agent,
    model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
  }
}

function userParts(sessionID: string, message: SessionMessageUser): Part[] {
  return [
    textPart(sessionID, message.id, 0, message.text),
    ...(message.files ?? []).map(
      (file, index): FilePart => ({
        id: `${message.id}:file:${index}`,
        sessionID,
        messageID: message.id,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
        source: file.mention
          ? {
              type: "file",
              text: { value: file.mention.text, start: file.mention.start, end: file.mention.end },
              path: file.mention.text.startsWith("@") ? file.mention.text.slice(1) : (file.name ?? file.mention.text),
            }
          : undefined,
      }),
    ),
    ...(message.agents ?? []).map(
      (item, index): Part => ({
        id: `${message.id}:agent:${index}`,
        sessionID,
        messageID: message.id,
        type: "agent",
        name: item.name,
        source: item.mention
          ? { value: item.mention.text, start: item.mention.start, end: item.mention.end }
          : undefined,
      }),
    ),
  ]
}

function assistantMessage(sessionID: string, parentID: string, message: SessionMessageAssistant): AssistantMessage {
  const error = message.error
    ? message.error.type.toLowerCase().includes("abort") || message.error.type.toLowerCase().includes("interrupt")
      ? { name: "MessageAbortedError" as const, data: { message: message.error.message } }
      : { name: "UnknownError" as const, data: { message: message.error.message } }
    : undefined
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    time: message.time,
    error,
    parentID,
    modelID: message.model.id,
    providerID: message.model.providerID,
    variant: message.model.variant,
    mode: message.agent,
    agent: message.agent,
    path: { cwd: "", root: "" },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? emptyTokens,
    finish: message.finish,
  }
}

function assistantParts(sessionID: string, message: SessionMessageAssistant): Part[] {
  const ordinals = { text: 0, reasoning: 0 }
  return message.content.flatMap((content): Part[] => {
    if (content.type === "text") {
      const part = textPart(sessionID, message.id, ordinals.text++, content.text)
      return content.text.trim() ? [part] : []
    }
    if (content.type === "reasoning") {
      const part: Part = {
        id: sessionMessagePartID(message.id, "reasoning", ordinals.reasoning++),
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: content.text,
        metadata: content.state,
        time: {
          start: content.time?.created ?? message.time.created,
          end: content.time?.completed,
        },
      }
      return content.text.trim() ? [part] : []
    }
    return [toolPart(sessionID, message.id, content)]
  })
}

function textPart(sessionID: string, messageID: string, ordinal: number, text: string, synthetic?: boolean): Part {
  return {
    id: sessionMessagePartID(messageID, "text", ordinal),
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic,
  }
}

function toolPart(sessionID: string, messageID: string, tool: SessionMessageAssistantTool): ToolPart {
  const start = tool.time.ran ?? tool.time.created
  const state = (() => {
    if (tool.state.status === "streaming") {
      const value = Option.getOrUndefined(decodeToolInput(tool.state.input))
      const input = normalizeToolInput(tool.name, record(value) ? value : {})
      return { status: "pending" as const, input, raw: tool.state.input }
    }
    if (tool.state.status === "running") {
      return {
        status: "running" as const,
        input: normalizeToolInput(tool.name, tool.state.input),
        // metadata: normalizeToolMetadata(tool.name, tool.state.structured),
        metadata: normalizeToolMetadata(tool.name, tool.state.metadata ?? {}),
        time: { start },
      }
    }
    if (tool.state.status === "error") {
      return {
        status: "error" as const,
        input: normalizeToolInput(tool.name, tool.state.input),
        error: tool.state.error.message,
        // metadata: normalizeToolMetadata(tool.name, tool.state.structured),
        metadata: normalizeToolMetadata(tool.name, tool.state.metadata ?? {}),
        time: { start, end: tool.time.completed ?? start },
      }
    }
    const attachments = tool.state.content.flatMap((item, index): FilePart[] =>
      item.type === "file"
        ? [
            {
              id: `${tool.id}:file:${index}`,
              sessionID,
              messageID,
              type: "file",
              mime: item.mime,
              filename: item.name,
              url: item.uri,
            },
          ]
        : [],
    )
    return {
      status: "completed" as const,
      input: normalizeToolInput(tool.name, tool.state.input),
      output: tool.state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
      title: tool.name,
      // metadata: normalizeToolMetadata(tool.name, tool.state.structured),
      metadata: normalizeToolMetadata(tool.name, tool.state.metadata ?? {}),
      time: { start, end: tool.time.completed ?? start },
      attachments: attachments.length ? attachments : undefined,
    }
  })()
  return {
    id: tool.id,
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state,
    metadata: { providerState: tool.providerState, providerResultState: tool.providerResultState },
  }
}
