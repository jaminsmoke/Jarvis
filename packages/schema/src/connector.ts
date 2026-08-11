/**
 * Connector registry — the single source of truth for Jarvis connectors.
 *
 * Config-driven: adding a connector is a matter of adding one entry here
 * (client id, device-flow endpoints, scopes, user mapping, i18n prefix).
 * The desktop main process, the web transport, the server proxy and the UI
 * all consume these definitions — no hardcoded provider logic elsewhere.
 *
 * Auth strategy: OAuth 2.0 Device Authorization Grant (RFC 8628) — the same
 * flow used by `gh` CLI and Codex. No callback server, no redirect URI, no
 * client secret needed (client ids are public by design for public clients).
 */

/** Public user info returned by each provider — safe to store plaintext. */
export type ConnectorUser = {
  /** Username (GitHub) / email (Google) / UPN (Microsoft) shown in the UI. */
  login: string
  /** Avatar URL */
  avatar: string
  /** Optional display name */
  name?: string
}

/**
 * A capability represents a discrete unit of functionality that a connector can provide.
 * Each capability has associated OAuth scopes, risk level, and tools.
 */
export type Capability = {
  /** Stable id, e.g. "read_repos", "write_issues", "read_drive". */
  id: string
  /** Display name (i18n key or plain string). */
  name: string
  /** Scope aliases: maps each connector to the OAuth scopes that satisfy this capability. */
  scopeAliases: Partial<Record<ConnectorId, string[]>>
  /** Risk level: read = safe to auto-enable, write = requires explicit confirmation. */
  risk: "read" | "write"
  /** Tools provided by this capability (tool names from the registry). */
  tools: string[]
  /** Whether this capability is enabled by default when discovered. Read = true, write = false. */
  defaultEnabled: boolean
  /** Whether changing this capability requires reconnection (new token). */
  requiresReconnect: boolean
}

/**
 * Runtime state of a single capability for a connected user.
 * Calculated as: active = supported && granted && enabled.
 */
export type CapabilityGrant = {
  /** The capability ID this grant refers to. */
  capabilityId: string
  /** Whether this version of Jarvis knows how to execute this capability. */
  supported: boolean
  /** Whether the provider confirms the user has the required scopes. */
  granted: boolean
  /** Whether the user has chosen to enable this capability. */
  enabled: boolean
  /** Computed: supported && granted && enabled. */
  active: boolean
}

/**
 * Full capability state for a connector, discovered at runtime.
 */
export type ConnectorCapabilityState = {
  /** Grants for each known capability. */
  grants: CapabilityGrant[]
  /** Scopes the provider returned that don't map to any known capability. */
  unknownScopes: string[]
  /** ISO timestamp of when this state was discovered. */
  discoveredAt: string
}

/** Current state of a connector. */
export type ConnectorStatus = {
  /** Whether the connector is enabled (Switch ON). */
  enabled: boolean
  /** Whether an access token exists and the user is connected. */
  connected: boolean
  /** The connected user, if any. */
  user?: ConnectorUser
}

/** Result of starting a device-flow authorization attempt. */
export type DeviceFlowStart = {
  /** Opaque session id; the renderer passes it back to poll. The device_code itself never leaves the main process. */
  sessionId: string
  /** Human-readable code the user must enter at the verification URL, e.g. "WDJB-MJHT". */
  userCode: string
  /** URL to open in the browser. */
  verificationUri: string
  /** Minimum polling interval in seconds. */
  interval: number
  /** How long the codes are valid, in seconds. */
  expiresIn: number
}

/** Result of polling a device-flow authorization attempt. */
export type DeviceFlowPoll =
  | { status: "success"; user: ConnectorUser }
  | { status: "pending"; slowDown?: boolean }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "error"; message: string }

/** The platform bridge surface for a connector (desktop only). */
export type ConnectorPlatform = {
  /** Get current status (enabled + connected + user). */
  getStatus(): Promise<ConnectorStatus>
  /** Enable or disable the connector. Disabling does NOT revoke the token. */
  setEnabled(enabled: boolean): Promise<ConnectorStatus>
  /** Begin a device-flow authorization. Returns the code to show the user. */
  startDeviceFlow(): Promise<DeviceFlowStart>
  /** Poll the device-flow attempt. Call every `interval` seconds until a terminal state. */
  pollDeviceFlow(sessionId: string): Promise<DeviceFlowPoll>
  /** Revoke the stored token and disconnect. */
  disconnect(): Promise<ConnectorStatus>
}

export type ConnectorId = "github" | "google" | "microsoft"

export type ConnectorDefinition = {
  /** Stable id used in IPC channels, store keys and server routes. */
  id: ConnectorId
  /** Public OAuth client id. Device flow client ids are public by design. */
  clientId: string
  /** Optional OAuth client secret. Required by Google TV-type clients for the
   * token endpoint (not the device-code endpoint). Leave undefined for pure
   * public clients (GitHub, Microsoft).
   *
   * For Google this MUST be read at runtime (process.env.GOOGLE_CLIENT_SECRET)
   * rather than baked into the static definition, because the secret cannot be
   * committed to the public repo and has no sensible default. */
  clientSecret?: string
  /** When true the connector is shown but not interactive — the card renders a
   * "Coming soon" badge and the switch is disabled. Use for connectors whose
   * OAuth app / scopes are registered but the end-to-end flow is not yet
   * validated. */
  disabled?: boolean
  /** Space-separated OAuth scopes requested at authorization time. */
  scopes: string
  /** RFC 8628 device authorization endpoint (no CORS — runs in main/server). */
  deviceCodeUrl: string
  /** OAuth token endpoint used for polling. */
  tokenUrl: string
  /** Base URL for API calls (user profile fetch). */
  apiBaseUrl: string
  /** Path to the user profile endpoint, relative to apiBaseUrl. */
  userPath: string
  /** Error code the token endpoint returns when the user declines. */
  deniedErrorCode: string
  /** Prefix for settings-store keys, e.g. "connector.github". */
  storePrefix: string
  /** Build the JSON API headers for profile calls with an optional token. */
  apiHeaders: (token?: string) => Record<string, string>
  /** Map the provider's profile payload to the generic ConnectorUser. */
  mapUser: (data: Record<string, unknown>) => ConnectorUser
  /** Base icon set name (see @opencode-ai/ui/icon) — used when no provider sprite exists. */
  icon: string
  /** Provider sprite id (see @opencode-ai/ui/provider-icon) — preferred for brand logos. */
  providerIcon?: string
  /** i18n key prefix, e.g. "settings.connectors.github". */
  i18nPrefix: string
  /** Full i18n keys of the permission bullets shown in the connect modal. */
  permissions: string[]
  /** Tools provided by this connector (shown in the UI when connected). */
  tools?: { name: string; description: string }[]
}

/** GitHub (dev) — the original connector, restored with OAuth App Ov23lih... */
const github: ConnectorDefinition = {
  id: "github",
  clientId: "Ov23lih4N28LiBwVzv7X",
  // Least privilege for read-only MVP — no write access to any repo.
  scopes: "public_repo,read:user",
  deviceCodeUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  apiBaseUrl: "https://api.github.com",
  userPath: "/user",
  deniedErrorCode: "access_denied",
  storePrefix: "connector.github",
  apiHeaders: (token?: string) => ({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }),
  mapUser: (data) => ({
    login: String(data.login ?? ""),
    avatar: String(data.avatar_url ?? ""),
    name: typeof data.name === "string" ? data.name : undefined,
  }),
  // GitHub logo is NOT in the provider sprite (only google/azure/gitlab are);
  // the base Icon set has "github", so no providerIcon for this connector.
  icon: "github",
  i18nPrefix: "settings.connectors.github",
  permissions: [
    "settings.connectors.github.permission.repos",
    "settings.connectors.github.permission.profile",
  ],
  tools: [
    { name: "github_list_repos", description: "List your GitHub repositories" },
    { name: "github_read_issue", description: "Read a GitHub issue or pull request" },
    { name: "github_search_code", description: "Search code across your repositories" },
  ],
}

/**
 * Google (Drive/Docs) — device flow supported.
 * Requires an OAuth client of type "TVs and Limited Input devices" in Google Cloud Console
 * (APIs & Services → Credentials → Create credentials → OAuth client ID).
 * TV-type clients require a client_secret at the token endpoint — injected via
 * GOOGLE_CLIENT_SECRET at build time (never committed to the repo).
 */
const google: ConnectorDefinition = {
  id: "google",
  clientId: "878214801933-dcbah6u5mb6gpnvmlotto6pv1nk1pc5p.apps.googleusercontent.com",
  // clientSecret read at runtime from GOOGLE_CLIENT_SECRET env var — see
  // connectors.ts (desktop) and connector.ts (server handler).
  // drive.readonly deferred to v0.3.0 (no Drive tools yet).
  scopes: "openid email profile",
  deviceCodeUrl: "https://oauth2.googleapis.com/device/code",
  tokenUrl: "https://oauth2.googleapis.com/token",
  apiBaseUrl: "https://www.googleapis.com",
  userPath: "/oauth2/v2/userinfo",
  deniedErrorCode: "access_denied",
  storePrefix: "connector.google",
  apiHeaders: (token?: string) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }),
  mapUser: (data) => ({
    login: String(data.email ?? data.id ?? ""),
    avatar: String(data.picture ?? ""),
    name: typeof data.name === "string" ? data.name : undefined,
  }),
  icon: "google",
  providerIcon: "google",
  i18nPrefix: "settings.connectors.google",
  // Permissions reflect actual scopes requested — drive is NOT yet included.
  // When drive.readonly scope is added (v0.3.0), re-add the drive permission key here.
  permissions: [
    "settings.connectors.google.permission.profile",
  ],
}

/**
 * Microsoft (OneDrive / Microsoft Graph) — device flow supported.
 * Requires a public-client app registration in Entra ID (Azure AD):
 * App registrations → New registration → "Allow public client flows: Yes".
 * Scopes: offline_access + User.Read (+ Files.Read.All for OneDrive).
 */
const microsoft: ConnectorDefinition = {
  id: "microsoft",
  disabled: true,
  clientId: "28c5172c-5ad7-4cd4-8cf4-6a5c004ac3c3",
  scopes: "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Files.Read.All",
  deviceCodeUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode",
  tokenUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  apiBaseUrl: "https://graph.microsoft.com/v1.0",
  userPath: "/me",
  deniedErrorCode: "authorization_declined",
  storePrefix: "connector.microsoft",
  apiHeaders: (token?: string) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }),
  mapUser: (data) => ({
    login: String(data.userPrincipalName ?? data.id ?? ""),
    avatar: "",
    name: typeof data.displayName === "string" ? data.displayName : undefined,
  }),
  icon: "azure",
  providerIcon: "azure",
  i18nPrefix: "settings.connectors.microsoft",
  permissions: [
    "settings.connectors.microsoft.permission.files",
    "settings.connectors.microsoft.permission.profile",
  ],
}

/** All connectors, keyed by id. */
export const CONNECTORS: Record<ConnectorId, ConnectorDefinition> = {
  github,
  google,
  microsoft,
}

/** Stable ordering for the UI list. */
export const CONNECTOR_LIST: ConnectorDefinition[] = [github, google, microsoft]

export function getConnector(id: string): ConnectorDefinition | undefined {
  return CONNECTORS[id as ConnectorId]
}

/**
 * Initial capability definitions.
 * These are the capabilities that Jarvis knows how to execute.
 * Each capability maps to specific OAuth scopes per provider.
 */
export const CAPABILITIES: Capability[] = [
  // ─── GitHub ───────────────────────────────────────────────────────────
  {
    id: "github:read_repos",
    name: "Read repositories",
    scopeAliases: {
      github: ["public_repo", "repo", "repo:status", "repo_deployment"],
    },
    risk: "read",
    tools: ["github_list_repos"],
    defaultEnabled: true,
    requiresReconnect: false,
  },
  {
    id: "github:read_issues",
    name: "Read issues and pull requests",
    scopeAliases: {
      github: ["public_repo", "repo", "repo:status"],
    },
    risk: "read",
    tools: ["github_read_issue"],
    defaultEnabled: true,
    requiresReconnect: false,
  },
  {
    id: "github:search_code",
    name: "Search code",
    scopeAliases: {
      github: ["public_repo", "repo"],
    },
    risk: "read",
    tools: ["github_search_code"],
    defaultEnabled: true,
    requiresReconnect: false,
  },
  {
    id: "github:write_issues",
    name: "Create and update issues",
    scopeAliases: {
      github: ["repo"],
    },
    risk: "write",
    tools: [], // TODO: add write tools in v0.2+
    defaultEnabled: false,
    requiresReconnect: false,
  },
  {
    id: "github:write_prs",
    name: "Create and update pull requests",
    scopeAliases: {
      github: ["repo"],
    },
    risk: "write",
    tools: [], // TODO: add write tools in v0.2+
    defaultEnabled: false,
    requiresReconnect: false,
  },

  // ─── Google ───────────────────────────────────────────────────────────
  {
    id: "google:read_profile",
    name: "Read user profile",
    scopeAliases: {
      google: ["openid", "email", "profile"],
    },
    risk: "read",
    tools: [], // Profile is used for user display, not as a tool
    defaultEnabled: true,
    requiresReconnect: false,
  },
  {
    id: "google:read_drive",
    name: "Read Google Drive files",
    scopeAliases: {
      google: ["https://www.googleapis.com/auth/drive.readonly"],
    },
    risk: "read",
    tools: [], // TODO: add Drive tools in v0.3.0
    defaultEnabled: false,
    requiresReconnect: true,
  },
  {
    id: "google:read_docs",
    name: "Read Google Docs",
    scopeAliases: {
      google: ["https://www.googleapis.com/auth/documents.readonly"],
    },
    risk: "read",
    tools: [], // TODO: add Docs tools in v0.3.0
    defaultEnabled: false,
    requiresReconnect: true,
  },

  // ─── Microsoft (future) ──────────────────────────────────────────────
  {
    id: "microsoft:read_profile",
    name: "Read user profile",
    scopeAliases: {
      microsoft: ["https://graph.microsoft.com/User.Read"],
    },
    risk: "read",
    tools: [],
    defaultEnabled: true,
    requiresReconnect: false,
  },
  {
    id: "microsoft:read_onedrive",
    name: "Read OneDrive files",
    scopeAliases: {
      microsoft: ["https://graph.microsoft.com/Files.Read.All"],
    },
    risk: "read",
    tools: [], // TODO: add OneDrive tools
    defaultEnabled: false,
    requiresReconnect: false,
  },
]

/**
 * Get all capabilities for a specific connector.
 */
export function getCapabilitiesForConnector(connectorId: ConnectorId): Capability[] {
  return CAPABILITIES.filter(cap => connectorId in cap.scopeAliases)
}

/**
 * Find the capability that provides a specific tool.
 */
export function getCapabilityForTool(toolName: string): Capability | undefined {
  return CAPABILITIES.find(cap => cap.tools.includes(toolName))
}
