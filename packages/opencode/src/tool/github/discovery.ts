/**
 * GitHub discovery adapter.
 *
 * Extracts the granted OAuth scopes from the `X-OAuth-Scopes` header
 * returned by the GitHub API (e.g. GET /user).
 *
 * GitHub OAuth Apps expose scopes via this header; GitHub Apps use
 * `X-Accepted-GitHub-Permissions` instead. This adapter handles the
 * OAuth App case (our current connector).
 */

import { ToolFailure } from "@opencode-ai/llm"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
  CAPABILITIES,
  type CapabilityGrant,
  type ConnectorCapabilityState,
  type ConnectorId,
} from "@opencode-ai/schema/connector"

const CONNECTOR_ID: ConnectorId = "github"

/**
 * Discover which scopes the GitHub token actually has by making a lightweight
 * API call and reading the `X-OAuth-Scopes` response header.
 *
 * Returns a `ConnectorCapabilityState` with grants for each known capability.
 */
export function discoverGithubScopes(
  token: string,
  http: HttpClient.HttpClient,
): Effect.Effect<ConnectorCapabilityState, ToolFailure> {
  return Effect.gen(function* () {
    // Make a lightweight API call to get the scopes header
    const request = HttpClientRequest.get("https://api.github.com/user").pipe(
      HttpClientRequest.setHeaders({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
      }),
    )

    const response = yield* http.execute(request).pipe(
      Effect.mapError(
        (err) => new ToolFailure({ message: `GitHub API unreachable: ${String(err)}` }),
      ),
    )

    if (response.status !== 200) {
      return yield* Effect.fail(
        new ToolFailure({
          message: `GitHub API error ${response.status} during scope discovery`,
        }),
      )
    }

    // Parse the X-OAuth-Scopes header
    const scopesHeader = response.headers["x-oauth-scopes"] ?? ""
    const grantedScopes = scopesHeader
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)

    // Map granted scopes to capability grants
    const grants = computeGrants(CONNECTOR_ID, grantedScopes)

    // Find unknown scopes (granted but not mapped to any capability)
    const knownScopeSet = new Set(
      CAPABILITIES.flatMap((cap) => cap.scopeAliases[CONNECTOR_ID] ?? []),
    )
    const unknownScopes = grantedScopes.filter((scope) => !knownScopeSet.has(scope))

    return {
      grants,
      unknownScopes,
      discoveredAt: new Date().toISOString(),
    }
  })
}

/**
 * Compute capability grants for a connector given the granted scopes.
 *
 * For each known capability:
 * - supported: always true (if it's in CAPABILITIES, we know how to execute it)
 * - granted: true if ANY of the capability's scope aliases are in the granted set
 * - enabled: true if granted AND defaultEnabled (or previously enabled by user)
 * - active: supported && granted && enabled
 */
export function computeGrants(
  connectorId: ConnectorId,
  grantedScopes: string[],
  userEnabledOverrides?: Record<string, boolean>,
): CapabilityGrant[] {
  const grantedSet = new Set(grantedScopes)

  return CAPABILITIES.filter((cap) => connectorId in cap.scopeAliases).map((cap) => {
    const aliases = cap.scopeAliases[connectorId] ?? []
    const granted = aliases.some((scope) => grantedSet.has(scope))

    // Check user override first, then fall back to default
    const userOverride = userEnabledOverrides?.[cap.id]
    const enabled = userOverride !== undefined ? userOverride : granted && cap.defaultEnabled

    return {
      capabilityId: cap.id,
      supported: true,
      granted,
      enabled,
      active: granted && enabled,
    }
  })
}
