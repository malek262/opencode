import { describe, expect, test } from "bun:test"
import http from "node:http"
import { Agent, fetch as undiciFetch } from "undici"
import { createUndiciDispatcher, resolveTimeoutMs } from "../../src/util/undici-dispatcher"

const withNodeVersions = <T>(fn: () => T): T => {
  const versions = process.versions as Record<string, string | undefined>
  const original = versions.bun
  delete versions.bun
  try {
    return fn()
  } finally {
    if (original !== undefined) versions.bun = original
  }
}

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

  test("builds an Agent on Node", () => {
    withNodeVersions(() => {
      const agent = createUndiciDispatcher({ headerTimeout: false, chunkTimeout: 60_000 })
      expect(agent).toBeInstanceOf(Agent)
      return agent?.close()
    })
  })
})

// Scaled-down transport checks against a real HTTP server. undici enforces
// headersTimeout/bodyTimeout below any AbortSignal wiring, and Node's global
// fetch is undici, so this proves the dispatcher lifts the hidden 300s wall
// (timeout: false -> 0) while a finite cap still surfaces as an undici error
// that OpenCode's own earlier-firing timer normally preempts.
describe("undici transport behavior", () => {
  const serve = (handler: http.RequestListener) =>
    new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const server = http.createServer(handler)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as { port: number }
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          close: () => new Promise<void>((done) => server.close(() => done())),
        })
      })
    })

  const slowHeaders = () =>
    serve((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("ok")
      }, 700)
    })

  test("slow headers succeed when headerTimeout is disabled", async () => {
    const server = await slowHeaders()
    try {
      const dispatcher = withNodeVersions(() => createUndiciDispatcher({ headerTimeout: false }))!
      const response = await undiciFetch(server.url, { dispatcher })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("ok")
      await dispatcher.close()
    } finally {
      await server.close()
    }
  }, 10_000)

  test("a finite transport cap still rejects with an undici timeout", async () => {
    const server = await slowHeaders()
    try {
      const dispatcher = new Agent({ headersTimeout: 200, bodyTimeout: 200 })
      await expect(undiciFetch(server.url, { dispatcher })).rejects.toThrow()
      await dispatcher.close()
    } finally {
      await server.close()
    }
  }, 10_000)

  test("mid-stream silence survives when chunkTimeout is disabled", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write("data: one\n\n")
      setTimeout(() => {
        res.write("data: two\n\n")
        res.end()
      }, 700)
    })
    try {
      const dispatcher = withNodeVersions(() => createUndiciDispatcher({ chunkTimeout: false }))!
      const response = await undiciFetch(server.url, { dispatcher })
      expect(await response.text()).toContain("data: two")
      await dispatcher.close()
    } finally {
      await server.close()
    }
  }, 10_000)
})
