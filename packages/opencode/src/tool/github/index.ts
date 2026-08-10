export * as GithubTools from "./index"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Scope } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { make as listRepos } from "./list-repos"
import { make as readIssue } from "./read-issue"
import { make as searchCode } from "./search-code"

const GITHUB_INTEGRATION_ID = "github" as Integration.ID

function resolveGithubToken(): Effect.Effect<string, ToolFailure, Credential.Service> {
  return Effect.gen(function* () {
    const credential = yield* Credential.Service
    const entries = yield* credential.list(GITHUB_INTEGRATION_ID)
    const stored = entries[0]
    if (!stored) {
      return yield* Effect.fail(
        new ToolFailure({ message: "GitHub is not connected. Connect in Settings → Connectors." }),
      )
    }

    const value = stored.value
    if (value.type !== "oauth") {
      return yield* Effect.fail(
        new ToolFailure({ message: "GitHub credential needs reconnection. Go to Settings → Connectors." }),
      )
    }

    const metadata = (value.metadata ?? {}) as Record<string, unknown>
    if (metadata.enabled !== true) {
      return yield* Effect.fail(
        new ToolFailure({ message: "GitHub connector is disabled. Enable it in Settings → Connectors." }),
      )
    }

    if (value.expires > 0 && Date.now() > value.expires) {
      return yield* Effect.fail(
        new ToolFailure({ message: "GitHub token has expired. Reconnect in Settings → Connectors." }),
      )
    }

    return value.access
  })
}

export const registerGithubTools = Effect.gen(function* () {
  const apps = yield* ApplicationTools.Service

  const tokenResult = yield* resolveGithubToken().pipe(
    Effect.match({
      onSuccess: (token) => token,
      onFailure: () => null as string | null,
    }),
  )

  if (!tokenResult) return

  yield* Effect.scoped(
    Effect.gen(function* () {
      const token = Effect.succeed(tokenResult)
      yield* apps.register({
        github_list_repos: listRepos(token),
        github_read_issue: readIssue(token),
        github_search_code: searchCode(token),
      }).pipe(Effect.orDie)
    }),
  )
}).pipe(
  Effect.provideService(Scope.Scope, Scope.makeUnsafe()),
)
