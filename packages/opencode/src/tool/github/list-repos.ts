export * as GithubListReposTool from "./list-repos"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"

export const name = "github_list_repos"

export const description = `List GitHub repositories accessible to the authenticated user.

Returns up to 30 repositories sorted by most recently updated. Each result includes:
- full_name (owner/repo), description, language, stars, and last updated date.
- private flag to distinguish public from private repos.

Use this to discover what projects the user has on GitHub before reading issues or searching code.`

export const Input = Schema.Struct({
  /** Optional owner filter — when omitted lists repos for the authenticated user. */
  owner: Schema.optional(Schema.String).annotate({
    description: "GitHub organization or user to list repos for (omit for authenticated user)",
  }),
  /** Maximum results (1–30). Default: 10. */
  limit: Schema.optional(
    Schema.Number,
  ).annotate({ description: "Maximum repos to return (1–30, default: 10)" }),
})

const RepoInfo = Schema.Struct({
  full_name: Schema.String.annotate({ description: "owner/repo" }),
  description: Schema.optional(Schema.String).annotate({ description: "Repository description" }),
  language: Schema.optional(Schema.String).annotate({ description: "Primary language" }),
  stars: Schema.Number.annotate({ description: "Star count" }),
  updated_at: Schema.String.annotate({ description: "ISO 8601 last-updated timestamp" }),
  private: Schema.Boolean.annotate({ description: "Whether the repo is private" }),
})

export const Output = Schema.Struct({
  repos: Schema.Array(RepoInfo).annotate({ description: "List of matching repositories" }),
  total: Schema.Number.annotate({ description: "Total count of accessible repos" }),
})

export type TokenProvider = Effect.Effect<string, ToolFailure>

export function make(token: TokenProvider) {
  return Tool.make({
    description,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [
      { type: "text", text: output.repos.map((r) =>
        `- **${r.full_name}** ${r.stars}⭐ | ${r.language ?? "N/A"} | ${r.private ? "🔒" : "🌐"} | ${r.description ?? ""}`
      ).join("\n") + `\n\n${output.total} repos total.` },
    ],
    execute: (input) =>
      Effect.gen(function* () {
        const accessToken = yield* token
        const owner = input.owner ?? (yield* fetchUserLogin(accessToken))
        const limit = input.limit ?? 10

        const url = new URL(owner ? `/users/${owner}/repos` : "/user/repos", "https://api.github.com")
        url.searchParams.set("sort", "updated")
        url.searchParams.set("per_page", String(limit))

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(url.toString(), {
              headers: {
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                Authorization: `Bearer ${accessToken}`,
              },
            }),
          catch: (err) => new ToolFailure({ message: `GitHub API unreachable: ${String(err)}` }),
        })

        if (!response.ok) {
          return yield* Effect.fail(
            new ToolFailure({ message: `GitHub API error ${response.status}: ${response.statusText}` }),
          )
        }

        const data = (yield* Effect.tryPromise({
          try: () => response.json() as Promise<any[]>,
          catch: (err) => new ToolFailure({ message: `Failed to parse GitHub response: ${String(err)}` }),
        })) as any[]

        const repos = data.map((repo) => ({
          full_name: String(repo.full_name),
          description: repo.description ? String(repo.description) : undefined,
          language: repo.language ? String(repo.language) : undefined,
          stars: Number(repo.stargazers_count ?? 0),
          updated_at: String(repo.updated_at),
          private: Boolean(repo.private),
        }))

        return {
          repos: repos.slice(0, limit),
          total: repos.length,
        }
      }),
  })
}

function fetchUserLogin(token: string): Effect.Effect<string, ToolFailure> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch("https://api.github.com/user", {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${token}`,
          },
        }),
      catch: (err) => new ToolFailure({ message: `GitHub /user unreachable: ${String(err)}` }),
    })

    if (!response.ok) {
      return yield* Effect.fail(new ToolFailure({ message: `GitHub /user error ${response.status}` }))
    }

    const user = (yield* Effect.tryPromise({
      try: () => response.json() as Promise<{ login: string }>,
      catch: (err) => new ToolFailure({ message: `Failed to parse /user: ${String(err)}` }),
    }))!

    return user.login
  })
}
