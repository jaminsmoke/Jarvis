/**
 * Server-backed connector transport for the web build (config-driven).
 *
 * The desktop build talks to connectors through the platform bridge
 * (`platform.connector.<id>`), which proxies to the Electron main process.
 * The web build has no platform bridge, so it talks to the Jarvis server
 * connector endpoints instead — the server runs the device flow (providers'
 * device endpoints don't allow CORS) and stores the token server-side.
 */

import type { ConnectorDefinition, ConnectorPlatform } from "./registry"
import { authTokenFromCredentials } from "@/utils/server"

export function createWebConnector(def: ConnectorDefinition, input: {
  baseUrl: string
  username?: string
  password?: string
  fetch?: typeof fetch
}): ConnectorPlatform {
  const fetchImpl = input.fetch ?? globalThis.fetch
  const baseUrl = input.baseUrl.replace(/\/+$/, "")
  const headers: Record<string, string> = input.password
    ? { Authorization: `Basic ${authTokenFromCredentials({ username: input.username, password: input.password })}` }
    : {}
  const prefix = `/connector/${def.id}`

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...init?.headers },
    })
    if (!res.ok) throw new Error(`Connector API error: ${res.status}`)
    return (await res.json()) as T
  }

  const json = (init?: RequestInit): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...init,
  })

  return {
    getStatus: () => request(`${prefix}/status`),
    setEnabled: (enabled) => request(`${prefix}/set-enabled`, json({ body: JSON.stringify({ enabled }) })),
    startDeviceFlow: () => request(`${prefix}/device`, json()),
    pollDeviceFlow: (sessionId) => request(`${prefix}/poll`, json({ body: JSON.stringify({ sessionId }) })),
    disconnect: () => request(`${prefix}/disconnect`, json()),
  }
}
