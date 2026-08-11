export * as GithubTools from "./index"

import { ToolFailure } from "@opencode-ai/llm"
import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { CAPABILITIES, type CapabilityGrant } from "@opencode-ai/schema/connector"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { discoverGithubScopes } from "./discovery"
import { make as listRepos } from "./list-repos"
import { make as readIssue } from "./read-issue"
import { make as searchCode } from "./search-code"

const GITHUB_INTEGRATION_ID = "github" as Integration.ID

/**
 * Resolve the GitHub access token with lazy credential resolution.
 * Each tool calls this at execution time, so it always uses fresh credentials.
 */
function resolveToken(
  credential: Credential.Service,
): Effect.Effect<string, ToolFailure> {
  return Effect.gen(function* () {
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

/**
 * Tool factory map — all GitHub tools keyed by name.
 * Used by registerEffect to conditionally register active capabilities.
 */
const TOOL_FACTORIES: Record<
  string,
  (token: Effect.Effect<string, ToolFailure>, http: HttpClient.HttpClient) => any
> = {
  github_list_repos: listRepos,
  github_read_issue: readIssue,
  github_search_code: searchCode,
}

/**
 * Build the set of tools to register based on active capability grants.
 */
function buildActiveTools(
  grants: CapabilityGrant[],
  token: Effect.Effect<string, ToolFailure>,
  http: HttpClient.HttpClient,
): Record<string, any> {
  const activeTools: Record<string, any> = {}
  const activeGrants = grants.filter((g) => g.active)
  for (const grant of activeGrants) {
    const cap = CAPABILITIES.find((c) => c.id === grant.capabilityId)
    if (!cap) continue
    for (const toolName of cap.tools) {
      const factory = TOOL_FACTORIES[toolName]
      if (factory) {
        activeTools[toolName] = factory(token, http)
      }
    }
  }
  return activeTools
}

const registerEffect = Effect.gen(function* () {
  const apps = yield* ApplicationTools.Service
  const http = yield* HttpClient.HttpClient
  const credential = yield* Credential.Service

  // Create lazy token effect (resolved per-execution, not captured at startup)
  const token = resolveToken(credential)

  // Discover granted scopes and compute capability grants
  const tokenValue = yield* resolveToken(credential)
  const capabilityState = yield* discoverGithubScopes(tokenValue, http)

  // Store capability state in credential metadata for UI consumption
  const entries = yield* credential.list(GITHUB_INTEGRATION_ID)
  const stored = entries[0]
  if (stored) {
    yield* credential.update(stored.id, {
      value: {
        ...stored.value,
        metadata: {
          ...(stored.value.metadata ?? {}),
          capabilities: capabilityState,
        },
      },
    })
  }

  // Register only tools from active capabilities
  const activeTools = buildActiveTools(capabilityState.grants, token, http)

  if (Object.keys(activeTools).length > 0) {
    yield* apps.register(activeTools).pipe(Effect.orDie)
  }
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
