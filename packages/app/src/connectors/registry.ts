/**
 * Connector registry (app facade).
 *
 * The canonical, config-driven definitions live in `@opencode-ai/schema/connector`
 * so the desktop main process, the web transport, the server proxy and the UI
 * all share the exact same source of truth without circular package deps.
 * This module re-exports them for the renderer's convenience.
 */

export {
  CONNECTORS,
  CONNECTOR_LIST,
  getConnector,
  CAPABILITIES,
  getCapabilitiesForConnector,
  getCapabilityForTool,
  type Capability,
  type CapabilityGrant,
  type ConnectorCapabilityState,
  type ConnectorDefinition,
  type ConnectorId,
  type ConnectorPlatform,
  type ConnectorStatus,
  type ConnectorUser,
  type DeviceFlowPoll,
  type DeviceFlowStart,
} from "@opencode-ai/schema/connector"
