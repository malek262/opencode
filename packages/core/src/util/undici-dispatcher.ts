import { Agent, fetch as undiciFetch } from "undici"

// On Node, global fetch is undici, whose defaults are headersTimeout = 300s and
// bodyTimeout = 300s. That kills long-running provider requests at the transport
// level (slow reasoning models waiting >300s for first byte, SSE streams silent
// for >300s) regardless of OpenCode's own timeout options, which only drive
// AbortSignal-based timers and cannot lift the undici wall.
//
// createUndiciFetch derives an explicit undici Agent from the same options
// OpenCode already reads (headerTimeout / chunkTimeout):
//   false      -> 0 (disabled at transport level, so the option truly works on Node)
//   number N   -> N + slack (OpenCode's own timer fires first with its clean,
//                 retryable HeaderTimeoutError instead of an opaque undici error)
//   absent     -> 300s default + slack (same reasoning)
//
// The returned fetch routes through the SAME npm undici package that built the
// dispatcher. The dispatcher must never be handed to the global fetch: under
// Node the global fetch runs Node's internal undici build, and mixing the two
// fails every request with `invalid onRequestStart method` (the OpenAI SDK
// documents this exact error as a dispatcher/fetch version mismatch).
//
// Returns undefined under Bun: Bun's fetch honors the existing `timeout: false`
// init and has no undici defaults to lift, so the Bun/CLI path stays untouched.
// Port of anomalyco/opencode#33535 (closed unmerged by age-based cleanup).
const TIMEOUT_SLACK_MS = 15_000
const DEFAULT_TIMEOUT_MS = 300_000

export function resolveTimeoutMs(timeout: unknown): number {
  if (timeout === false) return 0
  if (typeof timeout === "number" && timeout > 0) return timeout + TIMEOUT_SLACK_MS
  return DEFAULT_TIMEOUT_MS + TIMEOUT_SLACK_MS
}

export function createUndiciFetch(timeouts: { headerTimeout?: unknown; chunkTimeout?: unknown }) {
  if (typeof process !== "object" || process === null) return undefined
  if ((process.versions as Record<string, string | undefined>).bun) return undefined
  const dispatcher = new Agent({
    headersTimeout: resolveTimeoutMs(timeouts.headerTimeout),
    bodyTimeout: resolveTimeoutMs(timeouts.chunkTimeout),
  })
  // `fetch as undiciFetch` above only avoids shadowing the global fetch.
  return (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init ?? {}),
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
}
