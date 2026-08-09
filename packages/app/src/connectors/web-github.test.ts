import { describe, expect, mock, test } from "bun:test"
import { createWebGitHubConnector } from "./web-github"

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type CapturedRequest = { url: string; method?: string; headers?: Record<string, string>; body?: string }

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function setup(input?: { baseUrl?: string; username?: string; password?: string; responses?: Record<string, unknown> }) {
  const calls: CapturedRequest[] = []
  const fetchImpl = mock<FetchLike>(async (inputUrl, init) => {
    const headers: Record<string, string> = {}
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        headers[key] = String(value)
      }
    }
    calls.push({
      url: String(inputUrl),
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    const data = input?.responses?.[String(inputUrl)]
    return jsonResponse(data ?? { ok: true })
  })

  const connector = createWebGitHubConnector({
    baseUrl: input?.baseUrl ?? "http://localhost:4078",
    username: input?.username,
    password: input?.password,
    // `typeof fetch` includes static members (e.g. preconnect) that the mock lacks.
    fetch: fetchImpl as unknown as typeof fetch,
  })

  return { connector, calls, fetchImpl }
}

describe("createWebGitHubConnector", () => {
  test("getStatus GETs the status endpoint", async () => {
    const { connector, calls } = setup({
      responses: {
        "http://localhost:4078/connector/github/status": { enabled: true, connected: false },
      },
    })

    const status = await connector.getStatus()

    expect(status).toEqual({ enabled: true, connected: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://localhost:4078/connector/github/status")
    expect(calls[0].method).toBeUndefined()
  })

  test("setEnabled POSTs a JSON body with the enabled flag", async () => {
    const { connector, calls } = setup()

    await connector.setEnabled(true)

    expect(calls[0].url).toBe("http://localhost:4078/connector/github/set-enabled")
    expect(calls[0].method).toBe("POST")
    expect(calls[0].headers?.["Content-Type"]).toBe("application/json")
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ enabled: true })
  })

  test("startDeviceFlow POSTs the device endpoint", async () => {
    const { connector, calls } = setup()

    await connector.startDeviceFlow()

    expect(calls[0].url).toBe("http://localhost:4078/connector/github/device")
    expect(calls[0].method).toBe("POST")
  })

  test("pollDeviceFlow POSTs the session id", async () => {
    const { connector, calls } = setup()

    await connector.pollDeviceFlow("session-1")

    expect(calls[0].url).toBe("http://localhost:4078/connector/github/poll")
    expect(calls[0].method).toBe("POST")
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ sessionId: "session-1" })
  })

  test("disconnect POSTs the disconnect endpoint", async () => {
    const { connector, calls } = setup()

    await connector.disconnect()

    expect(calls[0].url).toBe("http://localhost:4078/connector/github/disconnect")
    expect(calls[0].method).toBe("POST")
  })

  test("sends Basic auth when credentials are provided", async () => {
    const { connector, calls } = setup({ username: "user", password: "pass" })

    await connector.getStatus()

    expect(calls[0].headers?.["Authorization"]).toStartWith("Basic ")
  })

  test("strips a trailing slash from the base URL", async () => {
    const { connector, calls } = setup({ baseUrl: "http://localhost:4078/" })

    await connector.getStatus()

    expect(calls[0].url).toBe("http://localhost:4078/connector/github/status")
  })

  test("throws a descriptive error on non-ok responses", async () => {
    const fetchImpl = mock<FetchLike>(async () => new Response("nope", { status: 500 }))
    const connector = createWebGitHubConnector({
      baseUrl: "http://localhost:4078",
      fetch: fetchImpl as unknown as typeof fetch,
    })

    expect(connector.getStatus()).rejects.toThrow("Connector API error: 500")
  })
})
