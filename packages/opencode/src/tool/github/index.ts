export * as GithubTools from "./index"

import { ToolFailure } from "@opencode-ai/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
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

const registerEffect = Effect.gen(function* () {
  const apps = yield* ApplicationTools.Service
  const http = yield* HttpClient.HttpClient

  const tokenResult = yield* resolveGithubToken().pipe(
    Effect.match({
      onSuccess: (token) => token,
      onFailure: () => null as string | null,
    }),
  )

  if (!tokenResult) return

  const token = Effect.succeed(tokenResult)

  yield* apps.register({
    github_list_repos: listRepos(token, http),
    github_read_issue: readIssue(token, http),
    github_search_code: searchCode(token, http),
  }).pipe(Effect.orDie)
})

/**
 * Registers GitHub read-only tools as ApplicationTools (global, not per-session).
 * If GitHub is not connected, registration is skipped silently.
 *
 * The caller is responsible for providing Credential.Service, HttpClient, and
 * ApplicationTools.Service in the Effect runtime before executing this effect.
 */
export const registerGithubTools = registerEffect

class GithubToolsService extends Context.Service<GithubToolsService, void>()("@opencode/v2/GithubTools") {}

const initLayer = Layer.effect(GithubToolsService, registerEffect)

export const node = makeGlobalNode({
  service: GithubToolsService,
  layer: initLayer,
  deps: [Credential.node, ApplicationTools.node, httpClient],
})
