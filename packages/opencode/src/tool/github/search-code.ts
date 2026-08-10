export * as GithubSearchCodeTool from "./search-code"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"

export const name = "github_search_code"

export const description = `Search code across GitHub repositories accessible to the authenticated user.

Uses GitHub's code search API. The query syntax supports:
- Plain text: "function authenticate" — matches files containing these words.
- Language filter: "language:typescript" — restricts to a specific language.
- Repo filter: "repo:owner/name" — search within a specific repository.
- Path filter: "path:src/" — restrict to files under a path.

Results include the repository, file path, and a snippet of matching code.
Rate limit: authenticated users get 30 requests per minute for search.`

export const Input = Schema.Struct({
  query: Schema.String.annotate({
    description: "Search query (supports language:, repo:, path:, org: qualifiers)",
  }),
  language: Schema.optional(Schema.String).annotate({
    description: "Filter by language (e.g. typescript, python, rust)",
  }),
  limit: Schema.optional(
    Schema.Number,
  ).annotate({ description: "Maximum results to return (1–20, default: 10)" }),
})

const CodeResult = Schema.Struct({
  repo: Schema.String.annotate({ description: "owner/repo where the match was found" }),
  path: Schema.String.annotate({ description: "File path within the repo" }),
  language: Schema.optional(Schema.String).annotate({ description: "Detected language" }),
  snippet: Schema.String.annotate({ description: "Matching code fragment (1–3 lines)" }),
  html_url: Schema.String.annotate({ description: "Browser URL to the file at the matching line" }),
})

export const Output = Schema.Struct({
  results: Schema.Array(CodeResult).annotate({ description: "Matching code results" }),
  total_count: Schema.Number.annotate({ description: "Total matches (API may cap at 1000)" }),
})

export function make(token: Effect.Effect<string, ToolFailure>) {
  return Tool.make({
    description,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [
      {
        type: "text",
        text: output.results.length === 0
          ? "No code results found."
          : output.results.map((r) =>
              `- **${r.repo}** | \`${r.path}\` (${r.language ?? "unknown"})\n  \`\`\`\n  ${r.snippet}\n  \`\`\`\n  ${r.html_url}`,
            ).join("\n\n") + `\n\n${output.total_count} total matches.`,
      },
    ],
    execute: (input) =>
      Effect.gen(function* () {
        const accessToken = yield* token
        const limit = input.limit ?? 10

        let q = input.query
        if (input.language) q += ` language:${input.language}`

        const url = new URL("https://api.github.com/search/code")
        url.searchParams.set("q", q)
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

        if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
          return yield* Effect.fail(
            new ToolFailure({ message: "GitHub search rate limit exceeded. Wait before retrying." }),
          )
        }

        if (response.status === 422) {
          return yield* Effect.fail(
            new ToolFailure({ message: `GitHub search query invalid: ${input.query}` }),
          )
        }

        if (!response.ok) {
          return yield* Effect.fail(
            new ToolFailure({ message: `GitHub API error ${response.status}: ${response.statusText}` }),
          )
        }

        const data = (yield* Effect.tryPromise({
          try: () => response.json() as Promise<{ items: any[]; total_count: number }>,
          catch: (err) => new ToolFailure({ message: `Failed to parse GitHub response: ${String(err)}` }),
        }))!

        return {
          results: (data.items ?? []).map((item: any) => ({
            repo: String(item.repository?.full_name ?? "unknown"),
            path: String(item.path ?? ""),
            language: item.repository?.language ? String(item.repository.language) : undefined,
            snippet: String(item.text_matches?.[0]?.fragment ?? item.name ?? ""),
            html_url: String(item.html_url ?? ""),
          })),
          total_count: Number(data.total_count ?? 0),
        }
      }),
  })
}
