export * as GithubReadIssueTool from "./read-issue"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"

export const name = "github_read_issue"

export const description = `Read a GitHub issue or pull request by owner, repo, and issue number.

Issues and PRs share the same numbering in GitHub. The response includes:
- Title, body (markdown), state (open/closed), author, labels, and comment count.
- For PRs: a pull_request object confirms it's a PR, not an issue.

Use this to understand a specific issue or PR that the user (or agent) references.`

export const Input = Schema.Struct({
  owner: Schema.String.annotate({ description: "Repository owner (user or organization)" }),
  repo: Schema.String.annotate({ description: "Repository name" }),
  number: Schema.Number.annotate({ description: "Issue or PR number" }),
})

export const Output = Schema.Struct({
  title: Schema.String.annotate({ description: "Issue title" }),
  body: Schema.optional(Schema.String).annotate({ description: "Issue body (markdown, truncated at 30k chars)" }),
  state: Schema.String.annotate({ description: "open or closed" }),
  author: Schema.String.annotate({ description: "GitHub login of the author" }),
  labels: Schema.Array(Schema.String).annotate({ description: "Label names" }),
  comments: Schema.Number.annotate({ description: "Number of comments" }),
  is_pr: Schema.Boolean.annotate({ description: "True if this is a pull request" }),
  html_url: Schema.String.annotate({ description: "Browser URL for the issue" }),
})

export function make(token: Effect.Effect<string, ToolFailure>) {
  return Tool.make({
    description,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [
      { type: "text", text: `## ${output.title} (#${output.is_pr ? "PR" : "Issue"})\n` +
        `**Author**: ${output.author} | **State**: ${output.state} | **Labels**: ${output.labels.join(", ") || "none"}\n` +
        `**Comments**: ${output.comments} | **URL**: ${output.html_url}\n\n${output.body ?? "(no description)"}` },
    ],
    execute: (input) =>
      Effect.gen(function* () {
        const accessToken = yield* token

        const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.number}`

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              headers: {
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                Authorization: `Bearer ${accessToken}`,
              },
            }),
          catch: (err) => new ToolFailure({ message: `GitHub API unreachable: ${String(err)}` }),
        })

        if (response.status === 404) {
          return yield* Effect.fail(
            new ToolFailure({ message: `Issue #${input.number} not found in ${input.owner}/${input.repo}` }),
          )
        }

        if (!response.ok) {
          return yield* Effect.fail(
            new ToolFailure({ message: `GitHub API error ${response.status}: ${response.statusText}` }),
          )
        }

        const data = (yield* Effect.tryPromise({
          try: () => response.json() as Promise<Record<string, unknown>>,
          catch: (err) => new ToolFailure({ message: `Failed to parse GitHub response: ${String(err)}` }),
        }))!

        const body = String(data.body ?? "")
        const MAX_BODY = 30_000

        return {
          title: String(data.title ?? ""),
          body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) + "\n\n...(truncated)" : (body || undefined),
          state: String(data.state ?? "unknown"),
          author: String((data.user as any)?.login ?? "unknown"),
          labels: Array.isArray(data.labels) ? data.labels.map((l: any) => String(l.name ?? l)) : [],
          comments: Number(data.comments ?? 0),
          is_pr: data.pull_request !== undefined && data.pull_request !== null,
          html_url: String(data.html_url ?? ""),
        }
      }),
  })
}
