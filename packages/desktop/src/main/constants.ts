import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// Fork builds ship on their own release cadence; the upstream feed must never offer to
// replace (or downgrade) them, so the updater stays off entirely.
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev" && import.meta.env.OPENCODE_FORK !== "1"

// Continuous network logging writes to disk for the whole session; keep it for development
// and explicit diagnostics only.
export const NET_LOG_ENABLED = !app.isPackaged || process.env.OPENCODE_NET_LOG === "1"
