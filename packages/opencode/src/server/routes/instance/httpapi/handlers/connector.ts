/**
 * Connector handlers — server-side device-flow proxy (config-driven).
 *
 * Mirrors the desktop main-process implementation (packages/desktop/src/main/
 * connectors.ts) so the web app can connect external services through the
 * Jarvis server without hitting providers' CORS-restricted device endpoints.
 *
 * Every connector is defined in `@opencode-ai/app/connectors/registry`; this
 * module is a factory that turns each definition into Effect handlers, storing
 * the access token in the server Credential store (SQLite) keyed by the
 * connector id. Tokens are never returned to the browser.
 *
 * Security note: unlike the desktop build (Electron safeStorage), the token is
 * stored as-is in the server SQLite Credential table. This matches how AI
 * provider OAuth credentials are stored in this codebase; encrypting at rest
 * would require a server-side secret and is out of scope for the web proxy.
 */

import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { CONNECTORS, type ConnectorDefinition } from "@opencode-ai/schema/connector"
import { InstanceHttpApi } from "../api"
import {
  ConnectorApiError,
  DeviceFlowStart,
  GitHubConnectorStatus,
  GitHubUser,
} from "../groups/connector"

type DeviceSession = {
  device_code: string
  interval: number
  expires_at: number
}

/** In-memory device-flow attempts keyed by opaque session id. */
const deviceSessions = new Map<string, DeviceSession>()

// Server processes are long-lived, so prune expired sessions opportunistically
// (on each device/poll call) instead of leaking abandoned attempts forever.
function pruneExpiredSessions() {
  const now = Date.now()
  for (const [id, session] of deviceSessions) {
    if (now > session.expires_at) deviceSessions.delete(id)
  }
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
  })
  if (!res.ok) throw new Error(`${url} error: ${res.status} ${res.statusText}`)
  return (await res.json()) as Record<string, unknown>
}

/** Like postForm but never throws on HTTP errors — the token endpoint returns
 *  authorization_pending / slow_down with HTTP 400, and those are expected
 *  intermediate states, not transport errors. Always parse the JSON body. */
async function tokenPostForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
  })
  return (await res.json()) as Record<string, unknown>
}

async function fetchUser(def: ConnectorDefinition, token: string): Promise<GitHubUser> {
  const res = await fetch(`${def.apiBaseUrl}${def.userPath}`, { headers: def.apiHeaders(token) })
  if (!res.ok) throw new Error(`${def.id[0].toUpperCase()}${def.id.slice(1)} API error: ${res.status}`)
  return def.mapUser((await res.json()) as Record<string, unknown>) as GitHubUser
}

/** Build the five connector handlers for a definition. */
function buildConnectorHandlers(def: ConnectorDefinition) {
  const INTEGRATION_ID = def.id as Integration.ID

  return {
    status: Effect.fn(`ConnectorHttpApi.${def.id}Status`)(function* () {
      const credential = yield* Credential.Service
      const current = yield* credential.list(INTEGRATION_ID)
      const stored = current[0]
      if (!stored || stored.value.type !== "key") return { enabled: false, connected: false }
      const metadata = stored.value.metadata ?? {}
      const user = metadata.user as GitHubUser | undefined
      const enabled = metadata.enabled === true
      return { enabled, connected: true, user }
    }),

    setEnabled: Effect.fn(`ConnectorHttpApi.${def.id}SetEnabled`)(function* (ctx: {
      payload: { enabled: boolean }
    }) {
      const credential = yield* Credential.Service
      const current = yield* credential.list(INTEGRATION_ID)
      const existing = current[0]
      if (!existing || existing.value.type !== "key") {
        return { enabled: ctx.payload.enabled, connected: false }
      }
      yield* credential.update(existing.id, {
        value: {
          ...existing.value,
          metadata: { ...(existing.value.metadata ?? {}), enabled: ctx.payload.enabled },
        },
      })
      return {
        enabled: ctx.payload.enabled,
        connected: true,
        user: existing.value.metadata?.user as GitHubUser | undefined,
      }
    }),

    device: Effect.fn(`ConnectorHttpApi.${def.id}Device`)(function* () {
      pruneExpiredSessions()
      const data = yield* Effect.tryPromise({
        try: () => postForm(def.deviceCodeUrl, { client_id: def.clientId, scope: def.scopes }),
        catch: (error) => new ConnectorApiError({ name: "BadRequest", data: { message: errorMessage(error) } }),
      })

      const device_code = String(data.device_code ?? "")
      const user_code = String(data.user_code ?? "")
      const verification_uri = String(data.verification_uri ?? data.verification_url ?? "")
      const interval = Number(data.interval ?? 5)
      const expires_in = Number(data.expires_in ?? 900)

      if (!device_code || !user_code) {
        return yield* Effect.fail(
          new ConnectorApiError({ name: "BadRequest", data: { message: `${def.id} device flow failed: ${JSON.stringify(data)}` } }),
        )
      }

      const sessionId = randomUUID()
      deviceSessions.set(sessionId, {
        device_code,
        interval,
        expires_at: Date.now() + expires_in * 1000,
      })

      return { sessionId, userCode: user_code, verificationUri: verification_uri, interval, expiresIn: expires_in } satisfies DeviceFlowStart
    }),

    poll: Effect.fn(`ConnectorHttpApi.${def.id}Poll`)(function* (ctx: {
      payload: { sessionId: string }
    }) {
      pruneExpiredSessions()
      const session = deviceSessions.get(ctx.payload.sessionId)
      if (!session) return { status: "error", message: "Session not found or already finished" } as const
      if (Date.now() > session.expires_at) {
        deviceSessions.delete(ctx.payload.sessionId)
        return { status: "expired" } as const
      }

      // Use tokenPostForm (does NOT throw on non-OK) because the token
      // endpoint returns 400 with authorization_pending / slow_down — those
      // are expected intermediate states, not errors.
      const tokenBody: Record<string, string> = {
        client_id: def.clientId,
        device_code: session.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }
      // Google TV-type clients require client_secret at the token endpoint.
      // Read at runtime — the secret cannot be committed to the public repo.
      const secret = def.clientSecret ?? (def.id === "google" ? process.env.GOOGLE_CLIENT_SECRET : undefined)
      if (secret) tokenBody.client_secret = secret
      const data = yield* Effect.tryPromise({
        try: () => tokenPostForm(def.tokenUrl, tokenBody),
        catch: (error) => new ConnectorApiError({ name: "BadRequest", data: { message: errorMessage(error) } }),
      })

      const error = data.error
      if (error === "authorization_pending") return { status: "pending" } as const
      if (error === "slow_down") return { status: "pending", slowDown: true } as const
      if (error === "expired_token") {
        deviceSessions.delete(ctx.payload.sessionId)
        return { status: "expired" } as const
      }
      if (error === def.deniedErrorCode) {
        deviceSessions.delete(ctx.payload.sessionId)
        return { status: "denied" } as const
      }
      if (error) {
        deviceSessions.delete(ctx.payload.sessionId)
        return { status: "error", message: String(data.error_description ?? error) } as const
      }

      const accessToken = String(data.access_token ?? "")
      if (!accessToken) return { status: "error", message: "No access_token in response" } as const

      deviceSessions.delete(ctx.payload.sessionId)

      const user = yield* Effect.tryPromise({
        try: () => fetchUser(def, accessToken),
        catch: (error) => new ConnectorApiError({ name: "BadRequest", data: { message: errorMessage(error) } }),
      })

      const credential = yield* Credential.Service
      yield* credential.create({
        integrationID: INTEGRATION_ID,
        value: { type: "key", key: accessToken, metadata: { enabled: true, user } },
      })

      return { status: "success", user } as const
    }),

    disconnect: Effect.fn(`ConnectorHttpApi.${def.id}Disconnect`)(function* () {
      const credential = yield* Credential.Service
      const current = yield* credential.list(INTEGRATION_ID)
      for (const entry of current) yield* credential.remove(entry.id)
      return { enabled: false, connected: false }
    }),
  }
}

export const connectorHandlers = HttpApiBuilder.group(InstanceHttpApi, "connector", (handlers) =>
  Effect.gen(function* () {
    // GitHub
    const gh = buildConnectorHandlers(CONNECTORS.github)
    // Google
    const ggl = buildConnectorHandlers(CONNECTORS.google)
    // Microsoft
    const ms = buildConnectorHandlers(CONNECTORS.microsoft)

    return handlers
      // GitHub
      .handle("githubStatus", gh.status)
      .handle("githubSetEnabled", gh.setEnabled)
      .handle("githubDevice", gh.device)
      .handle("githubPoll", gh.poll)
      .handle("githubDisconnect", gh.disconnect)
      // Google
      .handle("googleStatus", ggl.status)
      .handle("googleSetEnabled", ggl.setEnabled)
      .handle("googleDevice", ggl.device)
      .handle("googlePoll", ggl.poll)
      .handle("googleDisconnect", ggl.disconnect)
      // Microsoft
      .handle("microsoftStatus", ms.status)
      .handle("microsoftSetEnabled", ms.setEnabled)
      .handle("microsoftDevice", ms.device)
      .handle("microsoftPoll", ms.poll)
      .handle("microsoftDisconnect", ms.disconnect)
  }),
)

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : String(error)
}
