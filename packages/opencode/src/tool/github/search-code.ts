export * as GithubSearchCodeTool from "./search-code"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Tool } from "@opencode-ai/core/tool/tool"
import { githubGet, SEARCH_ACCEPT } from "./common"

export const name = "github_search_code"

export const description = `Search code across GitHub repositories accessible to the authenticated user.

Uses GitHub's code search API. The query syntax supports:
- Plain text: "function authenticate" — matches files containing these words.
- Language filter: "language:typescript" — restricts to a specific language.
- Repo filter: "repo:owner/name" — search within a specific repository.
- Path filter: "path:src/" — restrict to files under a path.

Results include the repository, file path, and a matching code snippet.
Rate limit: authenticated users get 30 requests per minute for search.`

export const Input = Schema.Struct({
  query: Schema.String.annotate({
    description: "Search query (supports language:, repo:, path:, org: qualifiers)",
  }),
  language: Schema.optional(Schema.String).annotate({
    description: "Filter by language (e.g. typescript, python, rust)",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum results to return (1–20, default: 10)",
  }),
})

const CodeResult = Schema.Struct({
  repo: Schema.String,
  path: Schema.String,
  language: Schema.optional(Schema.String),
  snippet: Schema.String,
  html_url: Schema.String,
})

export const Output = Schema.Struct({
  results: Schema.Array(CodeResult),
  total_count: Schema.Number,
})

export function make(token: Effect.Effect<string, ToolFailure>, http: HttpClient.HttpClient) {
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
        const limit = Math.min(Math.max(input.limit ?? 10, 1), 20)

        let q = input.query
        if (input.language) q += ` language:${input.language}`

        const url = new URL("https://api.github.com/search/code")
        url.searchParams.set("q", q)
        url.searchParams.set("per_page", String(limit))

        const data = (yield* (githubGet(
          http, url.toString(), accessToken, SEARCH_ACCEPT,
        ).pipe(
          Effect.catchIf(
            (e) => e instanceof ToolFailure && e.message.includes("422"),
            () => Effect.fail(new ToolFailure({ message: `GitHub search query invalid: ${input.query}` })),
          ),
        ))) as { items: any[]; total_count: number }

        return {
          results: (data.items ?? []).map((item: any) => ({
            repo: String(item.repository?.full_name ?? "unknown"),
            path: String(item.path ?? ""),
            language: item.repository?.language ? String(item.repository.language) : undefined,
            snippet: String(
              item.text_matches?.[0]?.fragment ?? item.name ?? "",
            ),
            html_url: String(item.html_url ?? ""),
          })),
          total_count: Number(data.total_count ?? 0),
        }
      }),
  })
}
