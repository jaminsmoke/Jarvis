import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { createWebConnector } from "./web-connector"
import {
  CONNECTORS,
  type ConnectorDefinition,
  type ConnectorPlatform,
  type DeviceFlowStart,
  type ConnectorStatus,
} from "./registry"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * SolidJS controller for a connector (config-driven).
 *
 * Resolves a `ConnectorPlatform` from the best available transport:
 * - Desktop: the platform bridge (`platform.connector[def.id]`), backed by IPC
 *   to the main process, which owns the device-flow polling and the encrypted
 *   token (safeStorage).
 * - Web: the Jarvis server connector endpoints, which proxy the device flow
 *   and store the token server-side (no CORS, no token in the browser).
 *
 * Returns null-ish behaviour gracefully when neither transport is available,
 * letting the UI show an "unavailable" state.
 */
export function useConnector(def: ConnectorDefinition) {
  const platform = usePlatform()
  const serverSDK = useServerSDK()

  // Cache the resolved transport for the lifetime of this controller instance.
  const api = createMemo<ConnectorPlatform | undefined>(() => {
    const platformConnector = (platform.connector as Record<string, ConnectorPlatform> | undefined)?.[def.id]
    if (platformConnector) return platformConnector
    try {
      const sdk = serverSDK()
      const http = sdk.server.http
      return createWebConnector(def, {
        baseUrl: http.url,
        username: http.username,
        password: http.password,
        fetch: platform.fetch,
      })
    } catch {
      // No active server (e.g. settings opened before a server is selected).
      return undefined
    }
  })

  const [status, setStatus] = createSignal<ConnectorStatus>({
    enabled: false,
    connected: false,
  })
  const [device, setDevice] = createSignal<DeviceFlowStart | null>(null)
  const [polling, setPolling] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // Load persisted status on mount.
  onMount(() => {
    const connector = api()
    if (!connector) return
    void connector
      .getStatus()
      .then(setStatus)
      .catch(() => undefined)
  })

  // Stop any in-flight polling loop when this controller is disposed
  // (e.g. the settings dialog closes mid-authorization).
  onCleanup(() => {
    setDevice(null)
    setPolling(false)
  })

  /** Toggle the connector Switch. Disabling keeps the token (re-enabling is instant). */
  async function toggleEnabled(enabled: boolean) {
    const connector = api()
    if (!connector) return
    try {
      const next = await connector.setEnabled(enabled)
      setStatus(next)
    } catch {
      setError("generic")
    }
  }

  /** Start a device-flow authorization and begin polling until a terminal state. */
  async function startConnect() {
    const connector = api()
    if (!connector) return
    setError(null)
    let started: DeviceFlowStart
    try {
      started = await connector.startDeviceFlow()
    } catch {
      setError("generic")
      return
    }
    setDevice(started)
    void pollLoop(started)
  }

  async function pollLoop(started: DeviceFlowStart) {
    const connector = api()
    if (!connector) return
    setPolling(true)
    try {
      let interval = started.interval
      while (device() !== null) {
        await sleep(interval * 1000)
        const current = device()
        if (!current || current.sessionId !== started.sessionId) return
        let result
        try {
          result = await connector.pollDeviceFlow(current.sessionId)
        } catch {
          setError("generic")
          setDevice(null)
          return
        }
        if (result.status === "pending") {
          if (result.slowDown) interval += 5
          continue
        }
        if (result.status === "success") {
          setStatus({ enabled: true, connected: true, user: result.user })
        } else if (result.status === "expired") {
          setError("expired")
        } else if (result.status === "denied") {
          setError("denied")
        } else {
          setError(result.message || "generic")
        }
        setDevice(null)
        return
      }
    } finally {
      setPolling(false)
    }
  }

  /** Cancel an in-flight authorization attempt (main-process session expires on its own). */
  function cancelConnect() {
    setDevice(null)
    setPolling(false)
  }

  /** Disconnect and immediately restart the device flow. */
  async function reconnect() {
    const connector = api()
    if (!connector) return
    setError(null)
    try {
      await connector.disconnect()
      setStatus({ enabled: true, connected: false })
      await startConnect()
    } catch {
      setError("generic")
    }
  }

  /** Revoke the stored token and disconnect the account. */
  async function disconnect() {
    const connector = api()
    if (!connector) return
    try {
      const next = await connector.disconnect()
      setStatus(next)
      setError(null)
    } catch {
      setError("generic")
    }
  }

  return {
    status,
    device,
    polling,
    error,
    /** Whether a transport exists (desktop bridge or web server connector). */
    available: () => api() !== undefined,
    toggleEnabled,
    startConnect,
    cancelConnect,
    disconnect,
    reconnect,
  }
}

/** Convenience wrapper for the GitHub connector (backwards compatible). */
export function useGitHubConnector() {
  return useConnector(CONNECTORS.github)
}

export type ConnectorController = ReturnType<typeof useConnector>
export type GitHubConnectorController = ReturnType<typeof useGitHubConnector>
