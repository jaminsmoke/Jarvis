import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { discoverGithubScopes, computeGrants } from "../../../src/tool/github/discovery"
import { CAPABILITIES, type ConnectorId } from "@opencode-ai/schema/connector"

// ── computeGrants (pure, no HTTP) ───────────────────────────────────────────

describe("computeGrants — GitHub", () => {
  const connectorId: ConnectorId = "github"

  test("maps public_repo to read capabilities", () => {
    const grants = computeGrants(connectorId, ["public_repo", "read:user"])
    const readRepos = grants.find((g) => g.capabilityId === "github:read_repos")
    expect(readRepos).toBeDefined()
    expect(readRepos!.supported).toBe(true)
    expect(readRepos!.granted).toBe(true)
    expect(readRepos!.enabled).toBe(true) // defaultEnabled is true
    expect(readRepos!.active).toBe(true)
  })

  test("maps repo scope to write capabilities", () => {
    const grants = computeGrants(connectorId, ["repo", "read:user"])
    const writeIssues = grants.find((g) => g.capabilityId === "github:write_issues")
    expect(writeIssues).toBeDefined()
    expect(writeIssues!.supported).toBe(true)
    expect(writeIssues!.granted).toBe(true)
    expect(writeIssues!.enabled).toBe(false) // defaultEnabled is false for write
    expect(writeIssues!.active).toBe(false)
  })

  test("respects user overrides", () => {
    const grants = computeGrants(connectorId, ["public_repo", "read:user"], {
      "github:read_repos": false,
    })
    const readRepos = grants.find((g) => g.capabilityId === "github:read_repos")
    expect(readRepos!.enabled).toBe(false)
    expect(readRepos!.active).toBe(false)
  })

  test("returns empty for unknown connector", () => {
    // Google has its own capabilities, so passing google connectorId returns google capabilities
    const grants = computeGrants("github" as ConnectorId, [])
    expect(grants.length).toBeGreaterThan(0)
    expect(grants.every((g) => g.granted === false)).toBe(true)
  })

  test("marks capabilities as unsupported when scope not granted", () => {
    const grants = computeGrants(connectorId, ["read:user"]) // no repo scopes
    const readRepos = grants.find((g) => g.capabilityId === "github:read_repos")
    expect(readRepos!.granted).toBe(false)
    expect(readRepos!.active).toBe(false)
  })
})

// ── discoverGithubScopes (HTTP mock) ────────────────────────────────────────

describe("discoverGithubScopes", () => {
  function mockHttpClient(scopesHeader: string) {
    return HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ login: "test" }), {
            status: 200,
            headers: {
              "x-oauth-scopes": scopesHeader,
              "content-type": "application/json",
            },
          }),
        ),
      ),
    )
  }

  test("extracts scopes from X-OAuth-Scopes header", async () => {
    const http = mockHttpClient("public_repo, read:user")
    const result = await Effect.runPromise(
      discoverGithubScopes("gh_test_token", http),
    )

    expect(result.grants.length).toBeGreaterThan(0)
    expect(result.discoveredAt).toBeDefined()

    const readRepos = result.grants.find((g) => g.capabilityId === "github:read_repos")
    expect(readRepos!.granted).toBe(true)
  })

  test("identifies unknown scopes", async () => {
    const http = mockHttpClient("public_repo, read:user, read:org, write:packages")
    const result = await Effect.runPromise(
      discoverGithubScopes("gh_test_token", http),
    )

    expect(result.unknownScopes).toContain("read:org")
    expect(result.unknownScopes).toContain("write:packages")
  })

  test("returns empty unknownScopes when all scopes are known", async () => {
    // public_repo is a known scope for GitHub capabilities
    const http = mockHttpClient("public_repo")
    const result = await Effect.runPromise(
      discoverGithubScopes("gh_test_token", http),
    )

    expect(result.unknownScopes).toHaveLength(0)
  })

  test("fails gracefully on API error", async () => {
    const http = HttpClient.make(() =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          {} as any,
          new Response("Unauthorized", { status: 401 }),
        ),
      ),
    )

    const result = await Effect.runPromise(
      discoverGithubScopes("gh_invalid_token", http).pipe(Effect.exit),
    )

    expect(result._tag).toBe("Failure")
  })
})
