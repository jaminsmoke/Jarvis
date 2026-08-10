import { ToolFailure } from "@opencode-ai/llm"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

/** Shared GitHub API headers for every request. */
export function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
  }
}

/** Accept header that includes text-match fragments for code search. */
export const SEARCH_ACCEPT = "application/vnd.github.v3.text-match+json"

/**
 * Make an authenticated GET request to the GitHub API.
 * Checks x-ratelimit-remaining and returns a ToolFailure on exhaustion.
 * Returns the response body as parsed JSON.
 */
export function githubGet<T = unknown>(
  http: HttpClient.HttpClient,
  url: string,
  token: string,
  accept?: string,
): Effect.Effect<T, ToolFailure> {
  return Effect.gen(function* () {
    const headers = githubHeaders(token)
    if (accept) headers.Accept = accept

    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders(headers),
    )

    const response = yield* http.execute(request).pipe(
      Effect.mapError((err) => new ToolFailure({ message: `GitHub API unreachable: ${String(err)}` })),
    )

    // Rate limit check — fail fast before reading the body
    const remaining = response.headers["x-ratelimit-remaining"]
    if (remaining === "0") {
      return yield* Effect.fail(
        new ToolFailure({ message: "GitHub API rate limit exceeded. Wait before retrying." }),
      )
    }

    if (response.status !== 200) {
      return yield* Effect.fail(
        new ToolFailure({
          message: `GitHub API error ${response.status}${response.headers["status"] ? `: ${response.headers["status"]}` : ""}`,
        }),
      )
    }

    // Parse JSON from response body
    const body = yield* response.text.pipe(
      Effect.mapError((err) => new ToolFailure({ message: `Failed to read response body: ${String(err)}` })),
    )

    return yield* Effect.try({
      try: () => JSON.parse(body) as T,
      catch: (err) => new ToolFailure({ message: `Failed to parse GitHub JSON: ${String(err)}` }),
    })
  })
}
