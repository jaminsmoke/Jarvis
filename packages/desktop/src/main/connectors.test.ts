import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

// ── In-memory electron-store stand-in ──

type MemoryStore = {
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
  delete: (key: string) => void
  clear: () => void
}

function createMemoryStore(): MemoryStore {
  const values = new Map<string, unknown>()
  return {
    get: (key) => values.get(key),
    set: (key, value) => void values.set(key, value),
    delete: (key) => void values.delete(key),
    clear: () => values.clear(),
  }
}

// ── Electron + store mocks ──

/**
 * safeStorage stand-in. `available`/`backend` are mutable so tests can switch
 * the encryption posture per case. Encryption is a reversible "enc:" prefix so
 * round-trips behave like the real backend (decrypt throws on foreign input).
 */
const safeStorage = {
  available: true,
  backend: "dpapi",
  isEncryptionAvailable: () => safeStorage.available,
  getSelectedStorageBackend: () => safeStorage.backend,
  encryptString: (value: string) => Buffer.from(`enc:${value}`),
  decryptString: (buffer: Buffer) => {
    const value = buffer.toString()
    if (!value.startsWith("enc:")) throw new Error("decryption failed")
    return value.slice(4)
  },
}

const store = createMemoryStore()

let connectors: typeof import("./connectors")

beforeAll(async () => {
  mock.module("electron", () => ({
    app: { whenReady: () => Promise.resolve() },
    safeStorage,
  }))
  mock.module("./store", () => ({ getStore: () => store }))
  connectors = await import("./connectors")
})

// ── fetch routing ──

const DEVICE_CODE_URL = "https://github.com/login/device/code"
const TOKEN_URL = "https://github.com/login/oauth/access_token"
const GITHUB_USER_URL = "https://api.github.com/user"

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const fetchMock = mock<FetchLike>(async (input) => {
  throw new Error(`unexpected fetch: ${String(input)}`)
})

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Route fetch by URL prefix for the current test. */
function routeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler(init)
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

beforeEach(() => {
  store.clear()
  globalThis.fetch = fetchMock
})

// ── Status ──

describe("githubStatus / githubSetEnabled", () => {
  test("reports disconnected when nothing is stored", async () => {
    expect(await connectors.githubStatus()).toEqual({ enabled: false, connected: false, user: undefined })
  })

  test("setEnabled persists the flag without requiring a token", async () => {
    const status = await connectors.githubSetEnabled(true)
    expect(status.enabled).toBe(true)
    expect(store.get("connector.github.enabled")).toBe(true)
  })
})

// ── Device flow ──

describe("githubStartDeviceFlow", () => {
  test("returns the user code and keeps the device_code in main-process memory only", async () => {
    routeFetch({
      [DEVICE_CODE_URL]: () =>
        jsonResponse({
          device_code: "d123",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        }),
    })

    const started = await connectors.githubStartDeviceFlow()

    expect(started.userCode).toBe("WDJB-MJHT")
    expect(started.verificationUri).toBe("https://github.com/login/device")
    expect(started.interval).toBe(5)
    expect(started.expiresIn).toBe(900)
    expect(started.sessionId).toBeTypeOf("string")
    // The device_code must never reach the renderer or the store.
    expect(JSON.stringify(started)).not.toContain("d123")
    expect(store.get("connector.github.token.encrypted")).toBeUndefined()
  })

  test("throws when GitHub omits the codes", async () => {
    routeFetch({ [DEVICE_CODE_URL]: () => jsonResponse({}) })
    expect(connectors.githubStartDeviceFlow()).rejects.toThrow(/device flow failed/)
  })
})

describe("githubPollDeviceFlow", () => {
  test("rejects unknown sessions", async () => {
    expect(await connectors.githubPollDeviceFlow("nope")).toEqual({
      status: "error",
      message: "Session not found or already finished",
    })
  })

  test("reports expired when the codes already expired", async () => {
    routeFetch({
      [DEVICE_CODE_URL]: () => jsonResponse({ device_code: "d1", user_code: "ABC-DEF", expires_in: -10 }),
    })
    const started = await connectors.githubStartDeviceFlow()
    expect(await connectors.githubPollDeviceFlow(started.sessionId)).toEqual({ status: "expired" })
    // Terminal state clears the in-memory session.
    expect(await connectors.githubPollDeviceFlow(started.sessionId)).toMatchObject({ status: "error" })
  })

  test("reports pending while the user has not authorized", async () => {
    routeFetch({
      [DEVICE_CODE_URL]: () => jsonResponse({ device_code: "d1", user_code: "ABC-DEF" }),
      [TOKEN_URL]: () => jsonResponse({ error: "authorization_pending" }),
    })
    const started = await connectors.githubStartDeviceFlow()
    expect(await connectors.githubPollDeviceFlow(started.sessionId)).toEqual({ status: "pending" })
  })

  test("reports pending with slowDown when GitHub asks to slow down", async () => {
    routeFetch({
      [DEVICE_CODE_URL]: () => jsonResponse({ device_code: "d1", user_code: "ABC-DEF" }),
      [TOKEN_URL]: () => jsonResponse({ error: "slow_down" }),
    })
    const started = await connectors.githubStartDeviceFlow()
    expect(await connectors.githubPollDeviceFlow(started.sessionId)).toEqual({ status: "pending", slowDown: true })
  })

  test("reports denied when the user declines", async () => {
    routeFetch({
      [DEVICE_CODE_URL]: () => jsonResponse({ device_code: "d1", user_code: "ABC-DEF" }),
      [TOKEN_URL]: () => jsonResponse({ error: "access_denied" }),
    })
    const started = await connectors.githubStartDeviceFlow()
    expect(await connectors.githubPollDeviceFlow(started.sessionId)).toEqual({ status: "denied" })
  })

  test("reports error with the GitHub description", async () => {
    routeFetch({
      [DEVICE_CODE_URL]: () => jsonResponse({ device_code: "d1", user_code: "ABC-DEF" }),
      [TOKEN_URL]: () => jsonResponse({ error: "incorrect_device_code", error_description: "bad code" }),
    })
    const started = await connectors.githubStartDeviceFlow()
    expect(await connectors.githubPollDeviceFlow(started.sessionId)).toEqual({
      status: "error",
      message: "bad code",
    })
  })

  test("completes the flow, stores the encrypted token and marks connected", async () => {
    routeFetch({
      [DEVICE_CODE_URL]: () => jsonResponse({ device_code: "d1", user_code: "ABC-DEF" }),
      [TOKEN_URL]: () => jsonResponse({ access_token: "tok-123" }),
      [GITHUB_USER_URL]: () =>
        jsonResponse({ login: "jaminsmoke", avatar_url: "https://avatars.example/a.png", name: "Jamin" }),
    })

    const started = await connectors.githubStartDeviceFlow()
    const poll = await connectors.githubPollDeviceFlow(started.sessionId)

    expect(poll).toEqual({
      status: "success",
      user: { login: "jaminsmoke", avatar: "https://avatars.example/a.png", name: "Jamin" },
    })
    // Token persisted encrypted (never plaintext), user + enabled alongside.
    expect(store.get("connector.github.token.encrypted")).toBe(Buffer.from("enc:tok-123").toString("base64"))
    expect(store.get("connector.github.enabled")).toBe(true)
    const status = await connectors.githubStatus()
    expect(status.connected).toBe(true)
    expect(status.user?.login).toBe("jaminsmoke")
  })

  test("reports error when the GitHub API user fetch fails after the token exchange", async () => {
    routeFetch({
      [DEVICE_CODE_URL]: () => jsonResponse({ device_code: "d1", user_code: "ABC-DEF" }),
      [TOKEN_URL]: () => jsonResponse({ access_token: "tok-123" }),
      [GITHUB_USER_URL]: () => new Response("boom", { status: 500 }),
    })
    const started = await connectors.githubStartDeviceFlow()
    const poll = await connectors.githubPollDeviceFlow(started.sessionId)
    expect(poll).toEqual({ status: "error", message: "GitHub API error: 500" })
    // The token must not be persisted when the user fetch fails.
    expect(store.get("connector.github.token.encrypted")).toBeUndefined()
  })

  test("refuses to store the token when safeStorage encryption is unavailable", async () => {
    safeStorage.available = false
    try {
      routeFetch({
        [DEVICE_CODE_URL]: () => jsonResponse({ device_code: "d1", user_code: "ABC-DEF" }),
        [TOKEN_URL]: () => jsonResponse({ access_token: "tok-123" }),
        [GITHUB_USER_URL]: () => jsonResponse({ login: "jaminsmoke", avatar_url: "https://avatars.example/a.png" }),
      })
      const started = await connectors.githubStartDeviceFlow()
      const poll = await connectors.githubPollDeviceFlow(started.sessionId)
      expect(poll.status).toBe("error")
      expect(poll.status === "error" && poll.message).toContain("safeStorage")
      expect(store.get("connector.github.token.encrypted")).toBeUndefined()
    } finally {
      safeStorage.available = true
    }
  })

  test("refuses to store the token when the backend is basic_text (obfuscation only)", async () => {
    safeStorage.backend = "basic_text"
    try {
      routeFetch({
        [DEVICE_CODE_URL]: () => jsonResponse({ device_code: "d1", user_code: "ABC-DEF" }),
        [TOKEN_URL]: () => jsonResponse({ access_token: "tok-123" }),
        [GITHUB_USER_URL]: () => jsonResponse({ login: "jaminsmoke", avatar_url: "https://avatars.example/a.png" }),
      })
      const started = await connectors.githubStartDeviceFlow()
      const poll = await connectors.githubPollDeviceFlow(started.sessionId)
      expect(poll.status).toBe("error")
      expect(store.get("connector.github.token.encrypted")).toBeUndefined()
    } finally {
      safeStorage.backend = "dpapi"
    }
  })
})

// ── Disconnect / cleanup / startup ──

describe("githubDisconnect and cleanup", () => {
  test("disconnect removes token and user but keeps the connector enabled", async () => {
    store.set("connector.github.token.encrypted", Buffer.from("enc:tok").toString("base64"))
    store.set("connector.github.user", JSON.stringify({ login: "x", avatar: "y" }))
    store.set("connector.github.enabled", true)

    const status = await connectors.githubDisconnect()

    expect(status).toEqual({ enabled: true, connected: false, user: undefined })
    expect(store.get("connector.github.token.encrypted")).toBeUndefined()
    expect(store.get("connector.github.user")).toBeUndefined()
  })

  test("clearDeviceSessions drops in-memory attempts across restarts", async () => {
    routeFetch({ [DEVICE_CODE_URL]: () => jsonResponse({ device_code: "d1", user_code: "ABC-DEF" }) })
    const started = await connectors.githubStartDeviceFlow()
    connectors.clearDeviceSessions()
    expect(await connectors.githubPollDeviceFlow(started.sessionId)).toMatchObject({ status: "error" })
  })

  test("startup hook clears a stored token that can no longer be decrypted", async () => {
    store.set("connector.github.token.encrypted", Buffer.from("not-enc:garbage").toString("base64"))
    store.set("connector.github.user", JSON.stringify({ login: "x", avatar: "y" }))

    connectors.githubStartupHook()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(store.get("connector.github.token.encrypted")).toBeUndefined()
    expect(store.get("connector.github.user")).toBeUndefined()
  })
})
