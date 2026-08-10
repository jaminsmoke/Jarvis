import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { CONNECTORS } from "./registry"
import type { ConnectorPlatform, DeviceFlowPoll, GitHubConnectorPlatform, GitHubConnectorStatus } from "./types"

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type GitHubConnectorController = ReturnType<typeof useGitHubConnector>

let useGitHubConnector: (typeof import("./use-connector"))["useGitHubConnector"]
let useConnector: (typeof import("./use-connector"))["useConnector"]

// Mutable context stand-ins: the mock.module factories close over these objects,
// so per-test values are read at call time (use-connector reads them on each
// useGitHubConnector() invocation).
const platform: { value: { platform: string; connector?: Record<string, ConnectorPlatform>; fetch?: FetchLike } } = {
  value: { platform: "web" },
}
const serverSDK: { value: () => unknown } = { value: () => undefined }

beforeAll(async () => {
  // Load the real context modules first and spread their exports: bun shares the
  // module registry across test files in one run, so a NARROW mock here would
  // replace the module for src/context/* tests too (missing exports -> failures).
  // Spreading the real surface + overriding only the two hooks keeps other
  // consumers intact (only this test imports `useServerSDK`).
  const realPlatform = await import("@/context/platform")
  const realServerSDK = await import("@/context/server-sdk")

  mock.module("@/context/platform", () => ({
    ...realPlatform,
    usePlatform: () => platform.value,
  }))
  mock.module("@/context/server-sdk", () => ({
    ...realServerSDK,
    useServerSDK: () => serverSDK.value,
  }))
  const mod = await import("./use-connector")
  useGitHubConnector = mod.useGitHubConnector
  useConnector = mod.useConnector
})

beforeEach(() => {
  platform.value = { platform: "web" }
  serverSDK.value = () => undefined
})

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * NOTE on solid-js in bun tests: `solid-js` resolves to the SERVER build under
 * bun's "node" export condition, where `onMount`/`createEffect` are no-ops.
 * These tests therefore exercise the controller's explicit async actions
 * (toggleEnabled/startConnect/cancelConnect/disconnect) and transport
 * resolution, not the onMount status-load (covered in the desktop manual test
 * matrix). Use sync createRoot like the rest of the repo's tests.
 */
function mount(): [GitHubConnectorController, () => void] {
  return createRoot((dispose) => [useGitHubConnector(), dispose]) as [GitHubConnectorController, () => void]
}

function createMockApi(overrides: Partial<GitHubConnectorPlatform> = {}): GitHubConnectorPlatform {
  return {
    getStatus: mock(async (): Promise<GitHubConnectorStatus> => ({ enabled: false, connected: false })),
    setEnabled: mock(async (enabled: boolean): Promise<GitHubConnectorStatus> => ({ enabled, connected: false })),
    startDeviceFlow: mock(async () => ({
      sessionId: "s1",
      userCode: "ABC-DEF",
      verificationUri: "https://github.com/login/device",
      interval: 0,
      expiresIn: 900,
    })),
    pollDeviceFlow: mock(async (): Promise<DeviceFlowPoll> => ({
      status: "success",
      user: { login: "jaminsmoke", avatar: "https://avatars.example/a.png" },
    })),
    disconnect: mock(async (): Promise<GitHubConnectorStatus> => ({ enabled: true, connected: false })),
    getToken: mock(async () => null),
    ...overrides,
  }
}

describe("useGitHubConnector", () => {
  test("resolves the desktop platform bridge and routes actions through it", async () => {
    const api = createMockApi()
    platform.value = { platform: "desktop", connector: { github: api } }

    const [controller, dispose] = mount()
    try {
      expect(controller.available()).toBe(true)

      await controller.toggleEnabled(true)
      expect(api.setEnabled).toHaveBeenCalledWith(true)

      await controller.startConnect()
      await waitFor(() => controller.polling() === false)
      expect(api.startDeviceFlow).toHaveBeenCalled()
      expect(api.pollDeviceFlow).toHaveBeenCalledWith("s1")
      expect(controller.status().connected).toBe(true)
    } finally {
      dispose()
    }
  })

  test("is unavailable when no transport exists", () => {
    const [controller, dispose] = mount()
    try {
      expect(controller.available()).toBe(false)
      expect(controller.status().connected).toBe(false)
    } finally {
      dispose()
    }
  })

  test("toggleEnabled delegates to the platform and updates status", async () => {
    const api = createMockApi()
    platform.value = { platform: "desktop", connector: { github: api } }

    const [controller, dispose] = mount()
    try {
      await controller.toggleEnabled(true)
      expect(api.setEnabled).toHaveBeenCalledWith(true)
      expect(controller.status().enabled).toBe(true)
    } finally {
      dispose()
    }
  })

  test("toggleEnabled surfaces a generic error when the platform call fails", async () => {
    const api = createMockApi({
      setEnabled: mock(async () => {
        throw new Error("boom")
      }),
    })
    platform.value = { platform: "desktop", connector: { github: api } }

    const [controller, dispose] = mount()
    try {
      await controller.toggleEnabled(true)
      expect(controller.error()).toBe("generic")
    } finally {
      dispose()
    }
  })

  test("startConnect shows the code, polls, and connects on success", async () => {
    const api = createMockApi()
    platform.value = { platform: "desktop", connector: { github: api } }

    const [controller, dispose] = mount()
    try {
      await controller.startConnect()

      expect(controller.device()?.userCode).toBe("ABC-DEF")
      expect(controller.polling()).toBe(true)

      await waitFor(() => controller.polling() === false)
      expect(api.pollDeviceFlow).toHaveBeenCalledWith("s1")
      expect(controller.status().connected).toBe(true)
      expect(controller.status().user?.login).toBe("jaminsmoke")
      expect(controller.error()).toBeNull()
      expect(controller.device()).toBeNull()
    } finally {
      dispose()
    }
  })

  test("startConnect reports denied when the user declines", async () => {
    const api = createMockApi({
      pollDeviceFlow: mock(async (): Promise<DeviceFlowPoll> => ({ status: "denied" })),
    })
    platform.value = { platform: "desktop", connector: { github: api } }

    const [controller, dispose] = mount()
    try {
      await controller.startConnect()
      await waitFor(() => controller.error() !== null)
      expect(controller.error()).toBe("denied")
      expect(controller.polling()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("startConnect reports expired when the codes lapse", async () => {
    const api = createMockApi({
      pollDeviceFlow: mock(async (): Promise<DeviceFlowPoll> => ({ status: "expired" })),
    })
    platform.value = { platform: "desktop", connector: { github: api } }

    const [controller, dispose] = mount()
    try {
      await controller.startConnect()
      await waitFor(() => controller.error() !== null)
      expect(controller.error()).toBe("expired")
    } finally {
      dispose()
    }
  })

  test("cancelConnect stops a pending poll loop", async () => {
    const api = createMockApi({
      pollDeviceFlow: mock(async (): Promise<DeviceFlowPoll> => ({ status: "pending" })),
    })
    platform.value = { platform: "desktop", connector: { github: api } }

    const [controller, dispose] = mount()
    try {
      await controller.startConnect()
      expect(controller.polling()).toBe(true)

      controller.cancelConnect()
      await waitFor(() => controller.polling() === false)
      expect(controller.device()).toBeNull()
    } finally {
      dispose()
    }
  })

  test("disconnect delegates to the platform and clears status", async () => {
    const api = createMockApi({
      disconnect: mock(async (): Promise<GitHubConnectorStatus> => ({ enabled: false, connected: false })),
    })
    platform.value = { platform: "desktop", connector: { github: api } }

    const [controller, dispose] = mount()
    try {
      await controller.disconnect()
      expect(api.disconnect).toHaveBeenCalled()
      expect(controller.status().connected).toBe(false)
      expect(controller.status().enabled).toBe(false)
    } finally {
      dispose()
    }
  })

  test("falls back to the server-backed web transport when there is no platform bridge", async () => {
    const http = { url: "http://localhost:4078/", username: "user", password: "pass" }
    const fetchImpl = mock<FetchLike>(async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({ enabled: true, connected: false }), { status: 200 })
    })
    platform.value = { platform: "web", fetch: fetchImpl }
    serverSDK.value = () => ({ server: { http } })

    const [controller, dispose] = mount()
    try {
      expect(controller.available()).toBe(true)

      await controller.toggleEnabled(true)

      const call = fetchImpl.mock.calls[0]
      expect(String(call[0])).toBe("http://localhost:4078/connector/github/set-enabled")
      expect(call[1]?.method).toBe("POST")
      const headers = call[1]?.headers as Record<string, string> | undefined
      expect(headers?.["Authorization"]).toStartWith("Basic ")
      expect(controller.status().enabled).toBe(true)
    } finally {
      dispose()
    }
  })
})

describe("useConnector (config-driven, google & microsoft)", () => {
  test("resolves each connector from its own platform bridge slot", async () => {
    const gapi: ConnectorPlatform = {
      getStatus: mock(async () => ({ enabled: false, connected: false })),
      setEnabled: mock(async (enabled: boolean) => ({ enabled, connected: false })),
      startDeviceFlow: mock(async () => ({
        sessionId: "g1",
        userCode: "ABCD-EFGH",
        verificationUri: "https://www.google.com/device",
        interval: 0,
        expiresIn: 900,
      })),
      pollDeviceFlow: mock(async (): Promise<DeviceFlowPoll> => ({
        status: "success",
        user: { login: "user@example.com", avatar: "https://example.com/p.png" },
      })),
      disconnect: mock(async () => ({ enabled: false, connected: false })),
      getToken: mock(async () => null),
    }
    const mapi: ConnectorPlatform = {
      getStatus: mock(async () => ({ enabled: false, connected: false })),
      setEnabled: mock(async (enabled: boolean) => ({ enabled, connected: false })),
      startDeviceFlow: mock(async () => ({
        sessionId: "m1",
        userCode: "WXYZ-1234",
        verificationUri: "https://microsoft.com/devicelogin",
        interval: 0,
        expiresIn: 900,
      })),
      pollDeviceFlow: mock(async (): Promise<DeviceFlowPoll> => ({
        status: "success",
        user: { login: "user@contoso.com", avatar: "" },
      })),
      disconnect: mock(async () => ({ enabled: false, connected: false })),
      getToken: mock(async () => null),
    }
    platform.value = { platform: "desktop", connector: { google: gapi, microsoft: mapi } }

    const [google, disposeG] = createRoot((d) => [useConnector(CONNECTORS.google), d]) as [
      ReturnType<typeof useConnector>,
      () => void,
    ]
    const [ms, disposeM] = createRoot((d) => [useConnector(CONNECTORS.microsoft), d]) as [
      ReturnType<typeof useConnector>,
      () => void,
    ]
    try {
      expect(google.available()).toBe(true)
      expect(ms.available()).toBe(true)

      await google.startConnect()
      await waitFor(() => google.polling() === false)
      expect(gapi.startDeviceFlow).toHaveBeenCalled()
      expect(google.status().connected).toBe(true)
      expect(google.status().user?.login).toBe("user@example.com")

      await ms.startConnect()
      await waitFor(() => ms.polling() === false)
      expect(mapi.startDeviceFlow).toHaveBeenCalled()
      expect(ms.status().connected).toBe(true)
      expect(ms.status().user?.login).toBe("user@contoso.com")
    } finally {
      disposeG()
      disposeM()
    }
  })

  test("web fallback uses the connector-specific route", async () => {
    const http = { url: "http://localhost:4078/", username: "user", password: "pass" }
    const fetchImpl = mock<FetchLike>(async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({ enabled: false, connected: false }), { status: 200 })
    })
    platform.value = { platform: "web", fetch: fetchImpl }
    serverSDK.value = () => ({ server: { http } })

    const [controller, dispose] = createRoot((d) => [useConnector(CONNECTORS.microsoft), d]) as [
      ReturnType<typeof useConnector>,
      () => void,
    ]
    try {
      expect(controller.available()).toBe(true)
      await controller.toggleEnabled(true)
      const call = fetchImpl.mock.calls[0]
      expect(String(call[0])).toBe("http://localhost:4078/connector/microsoft/set-enabled")
      expect(call[1]?.method).toBe("POST")
    } finally {
      dispose()
    }
  })
})
