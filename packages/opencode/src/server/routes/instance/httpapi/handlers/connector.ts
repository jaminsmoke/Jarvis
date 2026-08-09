/**
 * Connector handlers — server-side device-flow proxy (config-driven).
 *
 * Mirrors the desktop main-process implementation (packages/desktop/src/main/
 * connectors.ts) so the web app can connect external services through the
 * Jarvis server without hitting providers' CORS-restricted device endpoints.
 *
 * Every connector is defined in `@opencode-ai/app/connectors/registry`; this
 * module is a factory that turns each definition into Effect handlers, storing
 * the OAuth credential (access + refresh + expiry) in the server Credential
 * store (SQLite) keyed by the connector id. Tokens are never returned to the
 * browser.
 *
 * Security note: unlike the desktop build (Electron safeStorage), the token is
 * stored as-is in the server SQLite Credential table. This matches how AI
 * provider OAuth credentials are stored in this codebase; encrypting at rest
 * would require a server-side secret and is out of scope for the web proxy.
 * Per the kanban decision, connected tools must not be exposed until
 * encryption at rest exists.
 */

import { randomUUID } from "node:crypto"
import { Effect, Option } from "effect"
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
  const methodID = Integration.MethodID.make(def.id)

  /**
   * Refresh an expiring OAuth access token using the stored refresh token
   * (RFC 6749 §6). On success the credential is atomically replaced server-side;
   * on failure the old credential is kept and undefined is returned so callers
   * can report "disconnected" instead of leaking a stale token.
   */
  function refreshOAuth(id: Credential.ID, value: Credential.OAuth) {
    return Effect.gen(function* () {
      const body: Record<string, string> = {
        client_id: def.clientId,
        refresh_token: value.refresh,
        grant_type: "refresh_token",
      }
      // Google TV-type clients require client_secret at the token endpoint.
      // Read at runtime — the secret cannot be committed to the public repo.
      const secret = def.clientSecret ?? (def.id === "google" ? process.env.GOOGLE_CLIENT_SECRET : undefined)
      if (secret) body.client_secret = secret
      const data = yield* Effect.tryPromise({
        try: () => tokenPostForm(def.tokenUrl, body),
        catch: (error) => new ConnectorApiError({ name: "BadRequest", data: { message: errorMessage(error) } }),
      })
      if (data.error) return undefined
      const access = String(data.access_token ?? "")
      if (!access) return undefined
      const next: Credential.OAuth = {
        ...value,
        access,
        refresh: String(data.refresh_token ?? value.refresh),
        expires: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : value.expires,
      }
      const credential = yield* Credential.Service
      yield* credential.update(id, { value: next })
      return next
    })
  }

  /**
   * True when the stored credential is an OAuth credential (not a legacy key).
   * Legacy `key` credentials predate the OAuth contract and are treated as
   * connected on read (mirroring desktop) until they are replaced.
   */
  function isOAuth(value: Credential.Value): value is Credential.OAuth {
    return value.type === "oauth"
  }

  /** Metadata shared by both credential shapes (enabled flag, user). */
  function metadataOf(value: Credential.Value): Record<string, unknown> | undefined {
    return value.metadata
  }

  return {
    status: Effect.fn(`ConnectorHttpApi.${def.id}Status`)(function* () {
      if (def.disabled) return { enabled: false, connected: false }
      const credential = yield* Credential.Service
      const current = yield* credential.list(INTEGRATION_ID)
      const stored = current[0]
      if (!stored) return { enabled: false, connected: false }

      const metadata = metadataOf(stored.value) ?? {}
      const user = metadata.user as GitHubUser | undefined
      const enabled = metadata.enabled === true
      // Legacy `key` credentials: still connected (the token exists and has no
      // expiry tracking). They migrate to OAuth on the next successful poll.
      if (!isOAuth(stored.value)) {
        return { enabled, connected: true, user }
      }

      let value = stored.value
      // Auto-refresh when the access token has expired and a refresh token exists.
      // A refresh failure is not a transport error — report disconnected instead
      // of failing the status endpoint (which cannot raise ConnectorApiError).
      if (value.refresh && value.expires > 0 && Date.now() > value.expires) {
        const refreshed = yield* refreshOAuth(stored.id, value).pipe(Effect.option)
        if (Option.isSome(refreshed) && refreshed.value) value = refreshed.value
      }
      const connected = value.expires === 0 || Date.now() <= value.expires
      return { enabled, connected, user }
    }),

    setEnabled: Effect.fn(`ConnectorHttpApi.${def.id}SetEnabled`)(function* (ctx: {
      payload: { enabled: boolean }
    }) {
      if (def.disabled) return { enabled: false, connected: false }
      const credential = yield* Credential.Service
      const current = yield* credential.list(INTEGRATION_ID)
      const existing = current[0]
      if (!existing) {
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
      if (def.disabled) {
        return yield* Effect.fail(
          new ConnectorApiError({ name: "BadRequest", data: { message: `${def.id} connector is disabled` } }),
        )
      }
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
      if (def.disabled) return { status: "error", message: `${def.id} connector is disabled` } as const
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
      // Store the full OAuth credential: access + refresh + expiry. Providers
      // without refresh tokens (GitHub) store expires=0 (never expires).
      const refreshToken = String(data.refresh_token ?? "")
      const expiresIn = Number(data.expires_in ?? 0)
      yield* credential.create({
        integrationID: INTEGRATION_ID,
        value: {
          type: "oauth",
          methodID,
          access: accessToken,
          refresh: refreshToken,
          expires: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
          metadata: { enabled: true, user },
        },
      })

      return { status: "success", user } as const
    }),

    disconnect: Effect.fn(`ConnectorHttpApi.${def.id}Disconnect`)(function* () {
      const credential = yield* Credential.Service
      const current = yield* credential.list(INTEGRATION_ID)
      const stored = current[0]
      // Disconnecting does NOT disable the connector (switch = preference,
      // connected = authenticated). Match the desktop semantics.
      const metadata = stored ? metadataOf(stored.value) ?? {} : {}
      const enabled = metadata.enabled === true
      for (const entry of current) yield* credential.remove(entry.id)
      return { enabled, connected: false }
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
