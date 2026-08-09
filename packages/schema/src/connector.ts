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
}

/** GitHub (dev) — the original connector, restored with OAuth App Ov23lih... */
const github: ConnectorDefinition = {
  id: "github",
  clientId: "Ov23lih4N28LiBwVzv7X",
  scopes: "repo,user",
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
}

/**
 * Google (Drive/Docs) — device flow supported.
 * Requires an OAuth client of type "Desktop app" in Google Cloud Console
 * (APIs & Services → Credentials → Create credentials → OAuth client ID).
 * Public client: no client secret needed for device flow.
 */
const google: ConnectorDefinition = {
  id: "google",
  clientId: "REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  scopes: "https://www.googleapis.com/auth/drive.readonly",
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
  permissions: [
    "settings.connectors.google.permission.drive",
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
  clientId: "REPLACE_WITH_MICROSOFT_ENTRA_CLIENT_ID",
  scopes: "offline_access User.Read Files.Read.All",
  deviceCodeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
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
