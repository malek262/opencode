import Store from "electron-store"
import electron from "electron"
import { rmSync } from "node:fs"
import { join } from "node:path"

import { SETTINGS_STORE } from "./store-keys"
import { deleteStoreFileIfEmpty } from "./store-cleanup"

const cache = new Map<string, Store>()
// electron-store (conf) re-reads and re-parses the whole file on every get, and re-reads it
// again on every set. All renderer access funnels through IPC, so keep a write-through value
// cache here; every write path (IPC and main-side) must go through the helpers below.
const valueCache = new Map<string, Map<string, unknown>>()

function cached(name: string) {
  let values = valueCache.get(name)
  if (!values) valueCache.set(name, (values = new Map()))
  return values
}

export function storeGet(name: string, key: string) {
  const values = cached(name)
  if (values.has(key)) return values.get(key)
  const value = getStore(name).get(key)
  values.set(key, value)
  return value
}

export function storeSet(name: string, key: string, value: unknown) {
  getStore(name).set(key, value)
  cached(name).set(key, value)
}

export function storeDelete(name: string, key: string) {
  getStore(name).delete(key)
  cached(name).delete(key)
}

export function storeClear(name: string) {
  getStore(name).clear()
  valueCache.delete(name)
}

// We cannot instantiate the electron-store at module load time because
// module import hoisting causes this to run before app.setPath("userData", ...)
// in index.ts has executed, which would result in files being written to the default directory
// (e.g. bad: %APPDATA%\@opencode-ai\desktop\opencode.settings vs good: %APPDATA%\ai.opencode.desktop.dev\opencode.settings).
export function getStore(name = SETTINGS_STORE) {
  const cached = cache.get(name)
  if (cached) return cached
  const next = new Store({
    name,
    cwd: electron.app.getPath("userData"),
    fileExtension: "",
    accessPropertiesByDotNotation: false,
  })
  cache.set(name, next)
  return next
}

export async function removeStoreFileIfEmpty(name: string) {
  if (await deleteStoreFileIfEmpty(electron.app.getPath("userData"), name)) {
    cache.delete(name)
    valueCache.delete(name)
  }
}

export function removeStoreFile(name: string) {
  rmSync(join(electron.app.getPath("userData"), name), { force: true })
  cache.delete(name)
  valueCache.delete(name)
}
