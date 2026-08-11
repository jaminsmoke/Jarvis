/**
 * Google discovery adapter.
 *
 * Extracts the granted OAuth scopes from the Google tokeninfo endpoint.
 *
 * Google returns the granted scope in the token response and via:
 * https://oauth2.googleapis.com/tokeninfo?access_token=TOKEN
 *
 * The tokeninfo response includes a `scope` field with space-separated scopes.
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

const CONNECTOR_ID: ConnectorId = "google"

/**
 * Discover which scopes the Google token actually has by calling the
 * tokeninfo endpoint.
 *
 * Returns a `ConnectorCapabilityState` with grants for each known capability.
 */
export function discoverGoogleScopes(
  token: string,
  http: HttpClient.HttpClient,
): Effect.Effect<ConnectorCapabilityState, ToolFailure> {
  return Effect.gen(function* () {
    // Call the tokeninfo endpoint to get granted scopes
    const url = `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`

    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({
        Accept: "application/json",
      }),
    )

    const response = yield* http.execute(request).pipe(
      Effect.mapError(
        (err) => new ToolFailure({ message: `Google tokeninfo unreachable: ${String(err)}` }),
      ),
    )

    if (response.status !== 200) {
      return yield* Effect.fail(
        new ToolFailure({
          message: `Google tokeninfo error ${response.status} — token may be invalid or expired`,
        }),
      )
    }

    // Parse the response body
    const body = yield* response.text.pipe(
      Effect.mapError(
        (err) => new ToolFailure({ message: `Failed to read tokeninfo response: ${String(err)}` }),
      ),
    )

    const data = JSON.parse(body) as { scope?: string }
    const scopeString = data.scope ?? ""

    // Parse space-separated scopes
    const grantedScopes = scopeString.split(" ").filter(Boolean)

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
 * Same logic as GitHub discovery — shared via the CAPABILITIES constant.
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
