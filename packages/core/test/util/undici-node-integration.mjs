import http from "node:http"
import { Agent, fetch } from "undici"

// Runs under real Node (the Desktop sidecar runtime), where global fetch is
// undici. Mirrors the values resolveTimeoutMs produces: false -> 0 (disabled),
// finite -> the cap. Scaled delays (700ms) keep it CI-fast. Prints one JSON
// line with the outcome of each case.

const serve = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, server })
    })
  })

const slowHeaders = () =>
  serve((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("ok")
    }, 700)
  })

const results = {}

// Case A: headersTimeout 0 (headerTimeout: false) waits out slow headers
// that would die under undici's 300s default on a full-scale run.
{
  const { url, server } = await slowHeaders()
  const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
  try {
    const res = await fetch(url, { dispatcher: agent })
    results.slowHeadersDisabled = await res.text()
  } catch (err) {
    results.slowHeadersDisabled = `error: ${err.code ?? err.message}`
  } finally {
    server.close()
    await agent.close()
  }
}

// Case B: a finite transport cap surfaces as undici's headers timeout error.
// With the +15s slack policy OpenCode's own timer always fires before this,
// producing the clean retryable HeaderTimeoutError instead.
{
  const { url, server } = await slowHeaders()
  const agent = new Agent({ headersTimeout: 200, bodyTimeout: 200 })
  try {
    await fetch(url, { dispatcher: agent })
    results.finiteCap = "unexpected-success"
  } catch (err) {
    results.finiteCap = err.code ?? err.message
  } finally {
    server.close()
    await agent.close()
  }
}

// Case C: bodyTimeout 0 (chunkTimeout: false) survives mid-stream silence.
{
  const { url, server } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("data: one\n\n")
    setTimeout(() => {
      res.write("data: two\n\n")
      res.end()
    }, 700)
  })
  const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
  try {
    const res = await fetch(url, { dispatcher: agent })
    const body = await res.text()
    results.sseGapDisabled = body.includes("data: two") ? "done" : "missing-chunk"
  } catch (err) {
    results.sseGapDisabled = `error: ${err.code ?? err.message}`
  } finally {
    server.close()
    await agent.close()
  }
}

console.log(JSON.stringify(results))
