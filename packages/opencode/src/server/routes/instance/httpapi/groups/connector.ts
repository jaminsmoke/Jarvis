import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

const root = "/connector"

/**
 * Connector HTTP surface (one endpoint set per provider).
 *
 * The web app cannot talk to providers' device-flow endpoints directly (they
 * don't allow CORS), so the Jarvis server proxies the flow here. The access
 * token is stored in the server Credential store (like provider credentials)
 * and is never exposed to the browser.
 *
 * Endpoint ids are prefixed by provider (githubStatus, googleStatus, ...) so
 * the HttpApiBuilder handlers can map 1:1 with `.handle(name, fn)`.
 */

export const GitHubUser = Schema.Struct({
  login: Schema.String,
  avatar: Schema.String,
  name: Schema.optional(Schema.String),
})
export type GitHubUser = Schema.Schema.Type<typeof GitHubUser>

export const CapabilityGrant = Schema.Struct({
  capabilityId: Schema.String,
  supported: Schema.Boolean,
  granted: Schema.Boolean,
  enabled: Schema.Boolean,
  active: Schema.Boolean,
})
export type CapabilityGrant = Schema.Schema.Type<typeof CapabilityGrant>

export const ConnectorCapabilityState = Schema.Struct({
  grants: Schema.Array(CapabilityGrant),
  unknownScopes: Schema.Array(Schema.String),
  discoveredAt: Schema.String,
})
export type ConnectorCapabilityState = Schema.Schema.Type<typeof ConnectorCapabilityState>

export const GitHubConnectorStatus = Schema.Struct({
  enabled: Schema.Boolean,
  connected: Schema.Boolean,
  user: Schema.optional(GitHubUser),
  capabilities: Schema.optional(ConnectorCapabilityState),
})
export type GitHubConnectorStatus = Schema.Schema.Type<typeof GitHubConnectorStatus>

export const DeviceFlowStart = Schema.Struct({
  sessionId: Schema.String,
  userCode: Schema.String,
  verificationUri: Schema.String,
  interval: Schema.Number,
  expiresIn: Schema.Number,
})
export type DeviceFlowStart = Schema.Schema.Type<typeof DeviceFlowStart>

export const DeviceFlowPoll = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), user: GitHubUser }),
  Schema.Struct({ status: Schema.Literal("pending"), slowDown: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ status: Schema.Literal("expired") }),
  Schema.Struct({ status: Schema.Literal("denied") }),
  Schema.Struct({ status: Schema.Literal("error"), message: Schema.String }),
]).pipe(Schema.toTaggedUnion("status"))
export type DeviceFlowPoll = Schema.Schema.Type<typeof DeviceFlowPoll>

export class ConnectorApiError extends Schema.ErrorClass<ConnectorApiError>("ConnectorApiError")({
  name: Schema.Literal("BadRequest"),
  data: Schema.Struct({
    message: Schema.optional(Schema.String),
  }),
}, { httpApiStatus: 400 }) {}

type ConnectorId = "github" | "google" | "microsoft"

const CONNECTOR_LABELS: Record<ConnectorId, string> = {
  github: "GitHub",
  google: "Google",
  microsoft: "Microsoft",
}

/** Status endpoint for a provider. */
function statusEndpoint<const Id extends ConnectorId>(id: Id) {
  const name = CONNECTOR_LABELS[id]
  return HttpApiEndpoint.get(`${id}Status`, `${root}/${id}/status`, {
    success: described(GitHubConnectorStatus, `${name} connector status`),
  }).annotateMerge(
    OpenApi.annotations({
      identifier: `connector.${id}.status`,
      summary: `Get ${name} connector status`,
      description: `Whether the ${name} connector is enabled and connected, and which user is linked.`,
    }),
  )
}

/** Set-enabled endpoint for a provider. */
function setEnabledEndpoint<const Id extends ConnectorId>(id: Id) {
  const name = CONNECTOR_LABELS[id]
  return HttpApiEndpoint.post(`${id}SetEnabled`, `${root}/${id}/set-enabled`, {
    payload: Schema.Struct({ enabled: Schema.Boolean }),
    success: described(GitHubConnectorStatus, `${name} connector status`),
  }).annotateMerge(
    OpenApi.annotations({
      identifier: `connector.${id}.setEnabled`,
      summary: `Enable or disable the ${name} connector`,
      description: "Toggles the connector Switch. Disabling keeps the stored token (re-enabling is instant).",
    }),
  )
}

/** Device endpoint for a provider. */
function deviceEndpoint<const Id extends ConnectorId>(id: Id) {
  const name = CONNECTOR_LABELS[id]
  return HttpApiEndpoint.post(`${id}Device`, `${root}/${id}/device`, {
    success: described(DeviceFlowStart, "Device-flow authorization start"),
    error: ConnectorApiError,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: `connector.${id}.device`,
      summary: `Start a ${name} device-flow authorization`,
      description: "Starts RFC 8628 device flow and returns the user code to display. The device_code stays server-side.",
    }),
  )
}

/** Poll endpoint for a provider. */
function pollEndpoint<const Id extends ConnectorId>(id: Id) {
  const name = CONNECTOR_LABELS[id]
  return HttpApiEndpoint.post(`${id}Poll`, `${root}/${id}/poll`, {
    payload: Schema.Struct({ sessionId: Schema.String }),
    success: described(DeviceFlowPoll, "Device-flow poll result"),
    error: ConnectorApiError,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: `connector.${id}.poll`,
      summary: `Poll the ${name} device-flow attempt`,
      description: "Polls until the user authorizes. On success the server stores the token and returns the linked user.",
    }),
  )
}

/** Disconnect endpoint for a provider. */
function disconnectEndpoint<const Id extends ConnectorId>(id: Id) {
  const name = CONNECTOR_LABELS[id]
  return HttpApiEndpoint.post(`${id}Disconnect`, `${root}/${id}/disconnect`, {
    success: described(GitHubConnectorStatus, `${name} connector status`),
  }).annotateMerge(
    OpenApi.annotations({
      identifier: `connector.${id}.disconnect`,
      summary: `Disconnect the ${name} connector`,
      description: "Removes the stored token and disconnects the account. The connector resets to disabled (the token is the single source of truth server-side).",
    }),
  )
}

export const ConnectorApi = HttpApi.make("connector")
  .add(
    HttpApiGroup.make("connector")
      .add(
        statusEndpoint("github"),
        setEnabledEndpoint("github"),
        deviceEndpoint("github"),
        pollEndpoint("github"),
        disconnectEndpoint("github"),
        statusEndpoint("google"),
        setEnabledEndpoint("google"),
        deviceEndpoint("google"),
        pollEndpoint("google"),
        disconnectEndpoint("google"),
        statusEndpoint("microsoft"),
        setEnabledEndpoint("microsoft"),
        deviceEndpoint("microsoft"),
        pollEndpoint("microsoft"),
        disconnectEndpoint("microsoft"),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "connector",
          description: "External service connectors proxied through the Jarvis server (web support).",
        }),
      )
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "connector",
      version: "0.0.1",
      description: "External service connectors proxied through the Jarvis server.",
    }),
  )
