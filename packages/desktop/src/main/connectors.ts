/**
 * Jarvis connectors — implemented in the desktop main process.
 *
 * Auth strategy: OAuth 2.0 Device Flow (RFC 8628), the same flow used by
 * `gh` CLI and Codex. Config-driven: every connector is defined in
 * `@opencode-ai/app/connectors/registry` (client id, endpoints, scopes, user
 * mapping); this module is a thin factory that turns a definition into a
 * working connector.
 *
 * - No local callback server, no redirect URI, no client secret needed.
 * - The user authorizes THEIR OWN account from their browser.
 * - The access token is stored encrypted (Electron safeStorage) in the
 *   settings store.
 *
 * The renderer never sees the device_code or the access token: the device_code
 * lives in main-process memory during an attempt, and the token is encrypted on
 * disk. The renderer only receives the user_code (to show) and the poll result.
 */

import { randomUUID } from "node:crypto"
import { app, safeStorage } from "electron"
import {
  CONNECTORS,
  type ConnectorDefinition,
  type ConnectorPlatform,
  type ConnectorStatus,
  type ConnectorUser,
  type DeviceFlowPoll,
  type DeviceFlowStart,
} from "@opencode-ai/app/connectors/registry"
import { getStore } from "./store"

// ── Encrypted token storage ──

function store() {
  return getStore()
}

/**
 * safeStorage.isEncryptionAvailable() can be true while the backend is
 * `basic_text` (Linux without a keyring) — obfuscation, not real encryption.
 * Refuse to store the token in that case instead of leaking it in plaintext.
 */
function encryptionAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend
  if (typeof backend === "function" && backend.call(safeStorage) === "basic_text") return false
  return true
}

function encryptToken(token: string): string {
  if (!encryptionAvailable()) {
    // Fallback: plaintext would be insecure; refuse instead of leaking.
    throw new Error("safeStorage encryption is not available on this system")
  }
  return safeStorage.encryptString(token).toString("base64")
}

function decryptToken(encrypted: string): string | null {
  try {
    const buf = Buffer.from(encrypted, "base64")
    if (!encryptionAvailable()) return null
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
  })
  return (await res.json()) as Record<string, unknown>
}

type DeviceSession = {
  device_code: string
  interval: number
  expires_at: number
}

/**
 * Build a connector instance from its registry definition.
 * All per-connector state (sessions, store keys) is namespaced by definition,
 * so multiple connectors coexist without clashing.
 */
/**
 * All in-memory device sessions across every connector, keyed by connector id.
 * Kept module-level so `clearDeviceSessions` (app quit) can drop every attempt.
 */
const allDeviceSessions = new Map<string, Map<string, DeviceSession>>()

function createConnector(def: ConnectorDefinition): ConnectorPlatform & {
  startupHook(): void
} {
  const { id, storePrefix } = def

  // Google requires GOOGLE_CLIENT_SECRET at build time. If missing,
  // the connector is permanently disabled (shown as "Coming soon").
  const googleSecretMissing = id === "google" && !process.env.GOOGLE_CLIENT_SECRET

  const KEY_ENABLED = `${storePrefix}.enabled`
  const KEY_TOKEN = `${storePrefix}.token.encrypted` // base64(safeStorage.encryptString(token))
  const KEY_USER = `${storePrefix}.user` // JSON of public ConnectorUser (not a secret)

  /** In-memory device-flow attempts keyed by opaque session id. */
  const deviceSessions = new Map<string, DeviceSession>()
  allDeviceSessions.set(id, deviceSessions)

  function getStoredToken(): string | null {
    const enc = store().get(KEY_TOKEN) as string | undefined
    if (!enc) return null
    return decryptToken(enc)
  }

  function storeToken(token: string | null) {
    if (token === null) {
      store().delete(KEY_TOKEN)
      store().delete(KEY_USER)
      return
    }
    store().set(KEY_TOKEN, encryptToken(token))
  }

  function getStoredUser(): ConnectorUser | undefined {
    const raw = store().get(KEY_USER) as string | undefined
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as ConnectorUser
    } catch {
      return undefined
    }
  }

  async function fetchUser(token: string): Promise<ConnectorUser> {
    const res = await fetch(`${def.apiBaseUrl}${def.userPath}`, { headers: def.apiHeaders(token) })
    if (!res.ok) throw new Error(`${def.id[0].toUpperCase()}${def.id.slice(1)} API error: ${res.status}`)
    const data = (await res.json()) as Record<string, unknown>
    return def.mapUser(data)
  }

  async function status(): Promise<ConnectorStatus> {
    if (googleSecretMissing) return { enabled: false, connected: false }
    const enabled = Boolean(store().get(KEY_ENABLED))
    const token = getStoredToken()
    const user = getStoredUser()
    return { enabled, connected: token !== null, user }
  }

  async function setEnabled(enabled: boolean): Promise<ConnectorStatus> {
    if (googleSecretMissing) return status()
    store().set(KEY_ENABLED, enabled)
    return status()
  }

  async function startDeviceFlow(): Promise<DeviceFlowStart> {
    const data = await postForm(def.deviceCodeUrl, {
      client_id: def.clientId,
      scope: def.scopes,
    })

    const device_code = String(data.device_code ?? "")
    const user_code = String(data.user_code ?? "")
    const verification_uri = String(data.verification_uri ?? "")
    const interval = Number(data.interval ?? 5)
    const expires_in = Number(data.expires_in ?? 900)

    if (!device_code || !user_code) {
      throw new Error(`${def.id} device flow failed: ${JSON.stringify(data)}`)
    }

    const sessionId = randomUUID()
    deviceSessions.set(sessionId, {
      device_code,
      interval,
      expires_at: Date.now() + expires_in * 1000,
    })

    return { sessionId, userCode: user_code, verificationUri: verification_uri, interval, expiresIn: expires_in }
  }

  async function pollDeviceFlow(sessionId: string): Promise<DeviceFlowPoll> {
    const session = deviceSessions.get(sessionId)
    if (!session) return { status: "error", message: "Session not found or already finished" }
    if (Date.now() > session.expires_at) {
      deviceSessions.delete(sessionId)
      return { status: "expired" }
    }

    const body: Record<string, string> = {
      client_id: def.clientId,
      device_code: session.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }
    // Google TV-type clients require client_secret at the token endpoint.
    // The secret is read at runtime (not from the static definition) because
    // it cannot be committed to the public repo — set GOOGLE_CLIENT_SECRET.
    const secret = def.clientSecret ?? (def.id === "google" ? process.env.GOOGLE_CLIENT_SECRET : undefined)
    if (secret) body.client_secret = secret
    const data = await postForm(def.tokenUrl, body)

    const error = data.error
    if (error === "authorization_pending") return { status: "pending" }
    if (error === "slow_down") return { status: "pending", slowDown: true }
    if (error === "expired_token") {
      deviceSessions.delete(sessionId)
      return { status: "expired" }
    }
    if (error === def.deniedErrorCode) {
      deviceSessions.delete(sessionId)
      return { status: "denied" }
    }
    if (error) {
      deviceSessions.delete(sessionId)
      return { status: "error", message: String(data.error_description ?? error) }
    }

    const accessToken = String(data.access_token ?? "")
    if (!accessToken) return { status: "error", message: "No access_token in response" }

    deviceSessions.delete(sessionId)

    try {
      const user = await fetchUser(accessToken)
      storeToken(accessToken)
      store().set(KEY_USER, JSON.stringify(user))
      store().set(KEY_ENABLED, true)
      return { status: "success", user }
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : String(err) }
    }
  }

  async function disconnect(): Promise<ConnectorStatus> {
    storeToken(null)
    store().delete(KEY_USER)
    // Keep `enabled` as-is: disconnecting does not disable the connector.
    return status()
  }

  function startupHook() {
    void app.whenReady().then(() => {
      // Touch the store eagerly so decrypt failures surface early (and clear).
      if (getStoredToken() === null && store().get(KEY_TOKEN)) {
        store().delete(KEY_TOKEN)
        store().delete(KEY_USER)
      }
    })
  }

  return { getStatus: status, setEnabled, startDeviceFlow, pollDeviceFlow, disconnect, startupHook }
}

// ── Instances (one per registered connector) ──

const github = createConnector(CONNECTORS.github)
const google = createConnector(CONNECTORS.google)
const microsoft = createConnector(CONNECTORS.microsoft)

// ── Public API (IPC consumes CONNECTOR_APIS; wrappers kept for tests) ──

/** Map of connector id → API surface, consumed by IPC to register handlers. */
export const CONNECTOR_APIS: Record<
  string,
  {
    getStatus: () => Promise<ConnectorStatus>
    setEnabled: (enabled: boolean) => Promise<ConnectorStatus>
    startDeviceFlow: () => Promise<DeviceFlowStart>
    pollDeviceFlow: (sessionId: string) => Promise<DeviceFlowPoll>
    disconnect: () => Promise<ConnectorStatus>
    startupHook: () => void
  }
> = {
  github,
  google,
  microsoft,
}

export async function githubStatus() {
  return github.getStatus()
}
export async function githubSetEnabled(enabled: boolean) {
  return github.setEnabled(enabled)
}
export async function githubStartDeviceFlow() {
  return github.startDeviceFlow()
}
export async function githubPollDeviceFlow(sessionId: string) {
  return github.pollDeviceFlow(sessionId)
}
export async function githubDisconnect() {
  return github.disconnect()
}

export async function googleStatus() {
  return google.getStatus()
}
export async function googleSetEnabled(enabled: boolean) {
  return google.setEnabled(enabled)
}
export async function googleStartDeviceFlow() {
  return google.startDeviceFlow()
}
export async function googlePollDeviceFlow(sessionId: string) {
  return google.pollDeviceFlow(sessionId)
}
export async function googleDisconnect() {
  return google.disconnect()
}

export async function microsoftStatus() {
  return microsoft.getStatus()
}
export async function microsoftSetEnabled(enabled: boolean) {
  return microsoft.setEnabled(enabled)
}
export async function microsoftStartDeviceFlow() {
  return microsoft.startDeviceFlow()
}
export async function microsoftPollDeviceFlow(sessionId: string) {
  return microsoft.pollDeviceFlow(sessionId)
}
export async function microsoftDisconnect() {
  return microsoft.disconnect()
}

/** Register startup hooks for every connector (validates stored tokens). */
export function connectorStartupHooks() {
  for (const connector of Object.values(CONNECTOR_APIS)) connector.startupHook()
}

// ── Cleanup ──

/** Call on app quit so in-memory device sessions don't linger across restarts. */
export function clearDeviceSessions() {
  for (const sessions of allDeviceSessions.values()) sessions.clear()
}

/** Load any pre-existing user so the UI can show "connected" at startup. */
export function githubStartupHook() {
  github.startupHook()
}
