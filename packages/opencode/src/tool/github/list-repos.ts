export * as GithubListReposTool from "./list-repos"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Tool } from "@opencode-ai/core/tool/tool"
import { githubGet } from "./common"

export const name = "github_list_repos"

export const description = `List GitHub repositories accessible to the authenticated user.

Returns up to 30 repositories sorted by most recently updated. Each result includes:
- full_name (owner/repo), description, language, stars, and last updated date.
- private flag to distinguish public from private repos.

Use this to discover what projects the user has on GitHub before reading issues or searching code.`

export const Input = Schema.Struct({
  owner: Schema.optional(Schema.String).annotate({
    description: "GitHub organization or user to list repos for (omit for authenticated user)",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum repos to return (1–30, default: 10)",
  }),
})

const RepoInfo = Schema.Struct({
  full_name: Schema.String,
  description: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  stars: Schema.Number,
  updated_at: Schema.String,
  private: Schema.Boolean,
})

export const Output = Schema.Struct({
  repos: Schema.Array(RepoInfo),
  total: Schema.Number,
})

export function make(token: Effect.Effect<string, ToolFailure>, http: HttpClient.HttpClient) {
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
        const limit = Math.min(Math.max(input.limit ?? 10, 1), 30)

        const owner = input.owner ?? (yield* fetchUserLogin(accessToken, http))

        const url = new URL(owner ? `/users/${owner}/repos` : "/user/repos", "https://api.github.com")
        url.searchParams.set("sort", "updated")
        url.searchParams.set("per_page", String(limit))

        const data = (yield* githubGet(http, url.toString(), accessToken)) as any[]

        const repos = data.map((repo) => ({
          full_name: String(repo.full_name),
          description: repo.description ? String(repo.description) : undefined,
          language: repo.language ? String(repo.language) : undefined,
          stars: Number(repo.stargazers_count ?? 0),
          updated_at: String(repo.updated_at),
          private: Boolean(repo.private),
        }))

        return { repos: repos.slice(0, limit), total: repos.length }
      }),
  })
}

function fetchUserLogin(token: string, http: HttpClient.HttpClient): Effect.Effect<string, ToolFailure> {
  return Effect.gen(function* () {        const user = (yield* githubGet(http, "https://api.github.com/user", token)) as { login: string }
    return user.login
  })
}
