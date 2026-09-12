import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createUndiciDispatcher, resolveTimeoutMs } from "../../src/util/undici-dispatcher"

describe("resolveTimeoutMs", () => {
  test("false disables the transport timeout", () => {
    expect(resolveTimeoutMs(false)).toBe(0)
  })

  test("numeric option keeps 15s of slack over OpenCode's own timer", () => {
    expect(resolveTimeoutMs(600_000)).toBe(615_000)
    expect(resolveTimeoutMs(1)).toBe(15_001)
  })

  test("absent option falls back to the 300s default plus slack", () => {
    expect(resolveTimeoutMs(undefined)).toBe(315_000)
    expect(resolveTimeoutMs(null)).toBe(315_000)
    expect(resolveTimeoutMs(0)).toBe(315_000)
    expect(resolveTimeoutMs(-1)).toBe(315_000)
    expect(resolveTimeoutMs("300000")).toBe(315_000)
  })
})

describe("createUndiciDispatcher", () => {
  test("returns undefined under Bun so the CLI path is unchanged", () => {
    expect(createUndiciDispatcher({ headerTimeout: false, chunkTimeout: false })).toBeUndefined()
  })
})

// The transport-level proof must run under Node, where global fetch is undici
// (the Desktop sidecar runtime). Bun's own fetch ignores undici dispatchers,
// so an in-process test here would prove nothing. The companion .mjs fixture
// exercises real undici Agent semantics with scaled delays and reports JSON.
describe("undici transport behavior on node", () => {
  test("disabled timeouts wait out slow headers and SSE gaps, finite caps still error", async () => {
    const proc = Bun.spawn(["node", path.join(import.meta.dir, "undici-node-integration.mjs")], {
      cwd: path.join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    const code = await proc.exited
    if (code !== 0) throw new Error(`node integration script exited ${code}: ${err}`)
    expect(JSON.parse(out)).toEqual({
      slowHeadersDisabled: "ok",
      finiteCap: "UND_ERR_HEADERS_TIMEOUT",
      sseGapDisabled: "done",
    })
  }, 30_000)
})
