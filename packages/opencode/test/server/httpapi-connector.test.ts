import { afterEach, describe, expect } from "bun:test"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const realFetch: FetchLike = globalThis.fetch

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * Route global fetch by URL prefix. Returns a restore function. Device-flow
 * handlers run inside the server runtime, so the mock must be installed on
 * the global fetch before the request and restored afterwards.
 */
function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const mock: FetchLike = async (input, init) => {
    const url = String(input)
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler(init)
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  globalThis.fetch = mock as typeof fetch
  return () => {
    globalThis.fetch = realFetch as typeof fetch
  }
}

function app() {
  return Server.Default().app
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("connector HttpApi", () => {
  it.live(
    "reports disconnected status when no GitHub credential is stored",
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ config: { formatter: false, lsp: false } })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/connector/github/status", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        enabled: false,
        connected: false,
      })
    }),
  )

  it.live(
    "disconnect is idempotent when nothing is stored",
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ config: { formatter: false, lsp: false } })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/connector/github/disconnect", {
            method: "POST",
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        enabled: false,
        connected: false,
      })
    }),
  )

  it.live(
    "completes the device flow and stores a full OAuth credential",
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ config: { formatter: false, lsp: false } })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      const restore = mockFetch({
        "https://github.com/login/device/code": () =>
          jsonResponse({
            device_code: "d123",
            user_code: "WDJB-MJHT",
            verification_uri: "https://github.com/login/device",
            interval: 5,
            expires_in: 900,
          }),
        "https://github.com/login/oauth/access_token": () =>
          jsonResponse({ access_token: "tok-123" }),
        "https://api.github.com/user": () =>
          jsonResponse({ login: "jaminsmoke", avatar_url: "https://avatars.example/a.png", name: "Jamin" }),
      })
      try {
        const device = yield* Effect.promise(() =>
          Promise.resolve(
            app().request("/connector/github/device", {
              method: "POST",
              headers: { "x-opencode-directory": tmp.path },
            }),
          ),
        )
        expect(device.status).toBe(200)
        const started = (yield* Effect.promise(() => device.json())) as { sessionId: string }
        expect(started.sessionId).toBeTypeOf("string")

        const poll = yield* Effect.promise(() =>
          Promise.resolve(
            app().request("/connector/github/poll", {
              method: "POST",
              headers: { "x-opencode-directory": tmp.path, "content-type": "application/json" },
              body: JSON.stringify({ sessionId: started.sessionId }),
            }),
          ),
        )
        expect(poll.status).toBe(200)
        expect(yield* Effect.promise(() => poll.json())).toEqual({
          status: "success",
          user: { login: "jaminsmoke", avatar: "https://avatars.example/a.png", name: "Jamin" },
        })

        // The stored credential is now visible through status (OAuth contract).
        const status = yield* Effect.promise(() =>
          Promise.resolve(
            app().request("/connector/github/status", {
              headers: { "x-opencode-directory": tmp.path },
            }),
          ),
        )
        expect(status.status).toBe(200)
        expect(yield* Effect.promise(() => status.json())).toEqual({
          enabled: true,
          connected: true,
          user: { login: "jaminsmoke", avatar: "https://avatars.example/a.png", name: "Jamin" },
        })
      } finally {
        restore()
      }
    }),
  )
})

describe("connector HttpApi — google & microsoft", () => {
  it.live(
    "reports disconnected status for google and microsoft when nothing is stored",
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ config: { formatter: false, lsp: false } })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      for (const id of ["google", "microsoft"]) {
        const response = yield* Effect.promise(() =>
          Promise.resolve(
            app().request(`/connector/${id}/status`, {
              headers: {
                "x-opencode-directory": tmp.path,
              },
            }),
          ),
        )
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toEqual({
          enabled: false,
          connected: false,
        })
      }
    }),
  )

  it.live(
    "disconnect is idempotent for google and microsoft",
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ config: { formatter: false, lsp: false } })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      for (const id of ["google", "microsoft"]) {
        const response = yield* Effect.promise(() =>
          Promise.resolve(
            app().request(`/connector/${id}/disconnect`, {
              method: "POST",
              headers: {
                "x-opencode-directory": tmp.path,
              },
            }),
          ),
        )
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toEqual({
          enabled: false,
          connected: false,
        })
      }
    }),
  )
})
