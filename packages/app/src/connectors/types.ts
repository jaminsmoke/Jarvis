/**
 * Shared types for Jarvis connectors.
 *
 * These types are used by:
 * - The renderer (UI components + platform bridge)
 * - The desktop main process (OAuth device flow implementation)
 *
 * The desktop main process owns the OAuth device flow and token storage
 * (encrypted with Electron safeStorage). The renderer only talks to it
 * through the platform bridge (`platform.connector.<id>`).
 *
 * The canonical, provider-agnostic types live in `./registry` (ConnectorUser,
 * ConnectorStatus, DeviceFlowStart, DeviceFlowPoll, ConnectorPlatform). The
 * GitHub-* aliases below are kept for backwards compatibility and readability
 * at call sites that predate the config-driven refactor.
 */

export type {
  ConnectorUser,
  ConnectorStatus,
  DeviceFlowStart,
  DeviceFlowPoll,
  ConnectorPlatform,
  ConnectorId,
  ConnectorDefinition,
} from "./registry"
export { CONNECTORS, CONNECTOR_LIST, getConnector } from "./registry"

/** Public GitHub user info — alias of ConnectorUser. */
export type GitHubUser = import("./registry").ConnectorUser

/** Current state of the GitHub connector. */
export type GitHubConnectorStatus = import("./registry").ConnectorStatus

/** The platform bridge surface for the GitHub connector (desktop only). */
export type GitHubConnectorPlatform = import("./registry").ConnectorPlatform

/** All connectors exposed on the platform bridge. */
export type ConnectorPlatformMap = {
  github: import("./registry").ConnectorPlatform
  google: import("./registry").ConnectorPlatform
  microsoft: import("./registry").ConnectorPlatform
}
