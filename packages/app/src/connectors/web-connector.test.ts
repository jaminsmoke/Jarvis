import { describe, expect, mock, test } from "bun:test"
import { CONNECTORS } from "./registry"
import { createWebConnector } from "./web-connector"

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type CapturedRequest = { url: string; method?: string; headers?: Record<string, string>; body?: string }

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function setup(id: keyof typeof CONNECTORS, input?: { baseUrl?: string; username?: string; password?: string; responses?: Record<string, unknown> }) {
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

  const connector = createWebConnector(CONNECTORS[id], {
    baseUrl: input?.baseUrl ?? "http://localhost:4078",
    username: input?.username,
    password: input?.password,
    // `typeof fetch` includes static members (e.g. preconnect) that the mock lacks.
    fetch: fetchImpl as unknown as typeof fetch,
  })

  return { connector, calls, fetchImpl }
}

describe("createWebConnector (config-driven)", () => {
  for (const id of ["github", "google", "microsoft"] as const) {
    test(`${id}: routes to /connector/${id}/... and supports all actions`, async () => {
      const { connector, calls } = setup(id, {
        responses: { [`http://localhost:4078/connector/${id}/status`]: { enabled: false, connected: false } },
      })

      const status = await connector.getStatus()
      expect(status).toEqual({ enabled: false, connected: false })
      expect(calls[0].url).toBe(`http://localhost:4078/connector/${id}/status`)

      await connector.setEnabled(true)
      expect(calls[1].url).toBe(`http://localhost:4078/connector/${id}/set-enabled`)
      expect(calls[1].method).toBe("POST")
      expect(JSON.parse(calls[1].body ?? "{}")).toEqual({ enabled: true })

      await connector.startDeviceFlow()
      expect(calls[2].url).toBe(`http://localhost:4078/connector/${id}/device`)

      await connector.pollDeviceFlow("session-1")
      expect(calls[3].url).toBe(`http://localhost:4078/connector/${id}/poll`)
      expect(JSON.parse(calls[3].body ?? "{}")).toEqual({ sessionId: "session-1" })

      await connector.disconnect()
      expect(calls[4].url).toBe(`http://localhost:4078/connector/${id}/disconnect`)
    })
  }

  test("sends Basic auth when credentials are provided", async () => {
    const { connector, calls } = setup("google", { username: "user", password: "pass" })
    await connector.getStatus()
    expect(calls[0].headers?.["Authorization"]).toStartWith("Basic ")
  })

  test("strips a trailing slash from the base URL", async () => {
    const { connector, calls } = setup("microsoft", { baseUrl: "http://localhost:4078/" })
    await connector.getStatus()
    expect(calls[0].url).toBe("http://localhost:4078/connector/microsoft/status")
  })

  test("throws a descriptive error on non-ok responses", async () => {
    const fetchImpl = mock<FetchLike>(async () => new Response("nope", { status: 500 }))
    const connector = createWebConnector(CONNECTORS.google, {
      baseUrl: "http://localhost:4078",
      fetch: fetchImpl as unknown as typeof fetch,
    })
    expect(connector.getStatus()).rejects.toThrow("Connector API error: 500")
  })
})
