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
  // Google is only enabled when GOOGLE_CLIENT_SECRET exists at module load.
  // Set it before importing so the google connector behaves as enabled.
  process.env.GOOGLE_CLIENT_SECRET = "test-secret"
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

/** Decrypt + parse the stored credential JSON (mirrors connectors.ts). */
function storedCredential(prefix: string): Record<string, unknown> | null {
  const raw = store.get(`${prefix}.token.encrypted`) as string | undefined
  if (!raw) return null
  const decrypted = Buffer.from(raw, "base64").toString()
  if (!decrypted.startsWith("enc:")) return null
  return JSON.parse(decrypted.slice(4))
}

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

  test("completes the flow, stores the encrypted credential and marks connected", async () => {
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
    // Credential persisted encrypted (never plaintext), user + enabled alongside.
    // GitHub has no refresh token: stored as access-only (never expires).
    expect(storedCredential("connector.github")).toEqual({ access: "tok-123" })
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
    expect(poll.status).toBe("error")
    expect(poll.status === "error" && poll.message).toContain("API error: 500")
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
    store.set(
      "connector.github.token.encrypted",
      Buffer.from(`enc:${JSON.stringify({ access: "tok" })}`).toString("base64"),
    )
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

  test("legacy plaintext token is read as access-only credential", async () => {
    store.set("connector.github.token.encrypted", Buffer.from("enc:legacy-tok").toString("base64"))
    store.set("connector.github.enabled", true)

    const status = await connectors.githubStatus()
    expect(status).toEqual({ enabled: true, connected: true, user: undefined })
  })
})

// ── Google & Microsoft (config-driven connectors) ──

describe("google connector", () => {
  const GOOGLE_DEVICE_URL = "https://oauth2.googleapis.com/device/code"
  const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
  const GOOGLE_USER_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

  test("completes the flow and stores the credential under connector.google.*", async () => {
    routeFetch({
      [GOOGLE_DEVICE_URL]: () => jsonResponse({ device_code: "gd1", user_code: "ABCD-EFGH", interval: 5, expires_in: 900 }),
      [GOOGLE_TOKEN_URL]: () => jsonResponse({ access_token: "gtok-123", refresh_token: "grefresh-1", expires_in: 3600 }),
      [GOOGLE_USER_URL]: () =>
        jsonResponse({ email: "user@example.com", picture: "https://example.com/p.png", name: "User" }),
    })

    const started = await connectors.googleStartDeviceFlow()
    expect(started.userCode).toBe("ABCD-EFGH")
    expect(started.sessionId).toBeTypeOf("string")

    const poll = await connectors.googlePollDeviceFlow(started.sessionId)
    expect(poll).toEqual({
      status: "success",
      user: { login: "user@example.com", avatar: "https://example.com/p.png", name: "User" },
    })
    const cred = storedCredential("connector.google")
    expect(cred?.access).toBe("gtok-123")
    expect(cred?.refresh).toBe("grefresh-1")
    expect(cred?.expiresAt).toBeTypeOf("number")
    expect(store.get("connector.google.enabled")).toBe(true)
  })

  test("auto-refreshes an expired access token using the stored refresh token", async () => {
    routeFetch({
      [GOOGLE_DEVICE_URL]: () => jsonResponse({ device_code: "gd1", user_code: "ABCD-EFGH", interval: 5, expires_in: 900 }),
      // Device grant returns an already-expired access token + refresh token;
      // the refresh grant returns a fresh token.
      [GOOGLE_TOKEN_URL]: (init) => {
        const body = new URLSearchParams(String(init?.body))
        return body.get("grant_type") === "refresh_token"
          ? jsonResponse({ access_token: "gtok-fresh", refresh_token: "grefresh-2", expires_in: 3600 })
          : jsonResponse({ access_token: "gtok-old", refresh_token: "grefresh-1", expires_in: -10 })
      },
      [GOOGLE_USER_URL]: () =>
        jsonResponse({ email: "user@example.com", picture: "https://example.com/p.png" }),
    })

    const started = await connectors.googleStartDeviceFlow()
    await connectors.googlePollDeviceFlow(started.sessionId)

    // status() sees the expired token and refreshes it automatically.
    const after = await connectors.googleStatus()
    expect(after.connected).toBe(true)
    expect(storedCredential("connector.google")?.access).toBe("gtok-fresh")
  })

  test("reports disconnected when the refresh grant fails", async () => {
    store.set(
      "connector.google.token.encrypted",
      Buffer.from(
        `enc:${JSON.stringify({ access: "gtok-old", refresh: "grefresh-1", expiresAt: Date.now() - 1000 })}`,
      ).toString("base64"),
    )
    store.set("connector.google.user", JSON.stringify({ login: "user@example.com", avatar: "x" }))
    store.set("connector.google.enabled", true)

    routeFetch({
      [GOOGLE_TOKEN_URL]: () => jsonResponse({ error: "invalid_grant" }),
    })

    const status = await connectors.googleStatus()
    expect(status).toEqual({ enabled: true, connected: false, user: { login: "user@example.com", avatar: "x" } })
  })

  test("uses its own denied error code", async () => {
    routeFetch({
      [GOOGLE_DEVICE_URL]: () => jsonResponse({ device_code: "gd1", user_code: "ABCD-EFGH" }),
      [GOOGLE_TOKEN_URL]: () => jsonResponse({ error: "access_denied" }),
    })
    const started = await connectors.googleStartDeviceFlow()
    expect(await connectors.googlePollDeviceFlow(started.sessionId)).toEqual({ status: "denied" })
  })
})

describe("microsoft connector (disabled backend enforcement)", () => {
  test("status reports disabled", async () => {
    expect(await connectors.microsoftStatus()).toEqual({ enabled: false, connected: false })
  })

  test("setEnabled is a no-op when disabled", async () => {
    const status = await connectors.microsoftSetEnabled(true)
    expect(status.enabled).toBe(false)
    expect(store.get("connector.microsoft.enabled")).toBeUndefined()
  })

  test("startDeviceFlow refuses to initiate OAuth", async () => {
    expect(connectors.microsoftStartDeviceFlow()).rejects.toThrow(/disabled/)
  })

  test("disconnect clears the microsoft credential (disabled reports disabled)", async () => {
    store.set(
      "connector.microsoft.token.encrypted",
      Buffer.from(`enc:${JSON.stringify({ access: "tok" })}`).toString("base64"),
    )
    store.set("connector.microsoft.user", JSON.stringify({ login: "user@contoso.com", avatar: "" }))
    store.set("connector.microsoft.enabled", true)

    const status = await connectors.microsoftDisconnect()

    // Disabled connectors always report disabled, even after disconnect.
    expect(status).toEqual({ enabled: false, connected: false })
    expect(store.get("connector.microsoft.token.encrypted")).toBeUndefined()
  })
})
