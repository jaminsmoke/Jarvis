import { describe, expect, test } from "bun:test"
import { Effect, Scope } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { githubGet, SEARCH_ACCEPT } from "../../../src/tool/github/common"
import { ToolFailure } from "@opencode-ai/llm"

const TEST_TOKEN = "gh_test_token_123"

/** Run an Effect with a local HTTP mock server + HttpClient. */
const runWithMock = <A>(
  handler: (req: Request) => Response | Promise<Response>,
  fn: (baseUrl: string) => Effect.Effect<A, ToolFailure | Error, HttpClient.HttpClient>,
): Promise<A> =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: handler })),
      (s) => Effect.sync(() => s.stop(true)),
    )
    return yield* fn(server.url.toString())
  }).pipe(
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
    Effect.runPromise,
  )

describe("github/common", () => {
  test("githubGet returns parsed JSON on 200", async () => {
    const result = await runWithMock(
      () =>
        new Response(JSON.stringify({ login: "octocat", id: 1 }), {
          status: 200,
          headers: { "x-ratelimit-remaining": "4999", "content-type": "application/json" },
        }),
      (baseUrl) =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient
          return yield* githubGet(http, `${baseUrl}/user`, TEST_TOKEN)
        }),
    )
    expect(result).toEqual({ login: "octocat", id: 1 })
  })

  test("githubGet fails with rate limit on x-ratelimit-remaining=0", async () => {
    try {
      await runWithMock(
        () =>
          new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
            status: 200,
            headers: { "x-ratelimit-remaining": "0" },
          }),
        (baseUrl) =>
          Effect.gen(function* () {
            const http = yield* HttpClient.HttpClient
            return yield* githubGet(http, `${baseUrl}/user`, TEST_TOKEN)
          }),
      )
      expect.unreachable("should have thrown")
    } catch (err) {
      const failure = err as ToolFailure
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toContain("rate limit")
    }
  })

  test("githubGet fails on non-200, non-rate-limit error", async () => {
    try {
      await runWithMock(
        () =>
          new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
            headers: { "x-ratelimit-remaining": "4998" },
          }),
        (baseUrl) =>
          Effect.gen(function* () {
            const http = yield* HttpClient.HttpClient
            return yield* githubGet(http, `${baseUrl}/nonexistent`, TEST_TOKEN)
          }),
      )
      expect.unreachable("should have thrown")
    } catch (err) {
      const failure = err as ToolFailure
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toContain("404")
    }
  })

  test("githubGet passes custom Accept header for search", async () => {
    const result = await runWithMock(
      (req) => {
        const accept = req.headers.get("accept")
        return new Response(JSON.stringify({ accept_received: accept, total_count: 0, items: [] }), {
          status: 200,
          headers: { "x-ratelimit-remaining": "29" },
        })
      },
      (baseUrl) =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient
          return yield* githubGet(http, `${baseUrl}/search/code?q=test`, TEST_TOKEN, SEARCH_ACCEPT)
        }),
    )
    expect(result).toHaveProperty("accept_received", SEARCH_ACCEPT)
  })
})
