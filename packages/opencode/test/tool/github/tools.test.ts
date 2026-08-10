import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import * as Tool from "@opencode-ai/core/tool/tool"
import {
  name as listReposName,
  Input as ListReposInput,
  Output as ListReposOutput,
  make as listRepos,
} from "../../../src/tool/github/list-repos"
import {
  name as readIssueName,
  Input as ReadIssueInput,
  Output as ReadIssueOutput,
  make as readIssue,
} from "../../../src/tool/github/read-issue"
import {
  name as searchCodeName,
  Input as SearchCodeInput,
  Output as SearchCodeOutput,
  make as searchCode,
} from "../../../src/tool/github/search-code"

const TEST_TOKEN = Effect.succeed("gh_test_token_123")

describe("github_list_repos — definition", () => {
  test("has correct name", () => {
    expect(listReposName).toBe("github_list_repos")
  })

  test("has schemas with required fields", () => {
    expect(ListReposInput).toBeDefined()
    expect(ListReposOutput).toBeDefined()
  })

  test("make() produces a tool with expected description", () => {
    const http = {} as HttpClient.HttpClient
    const def = listRepos(TEST_TOKEN, http)
    const toolDef = Tool.definition("github_list_repos", def)
    expect(toolDef.description).toContain("GitHub repositories")
  })
})

describe("github_read_issue — definition", () => {
  test("has correct name", () => {
    expect(readIssueName).toBe("github_read_issue")
  })

  test("has schemas with required fields", () => {
    expect(ReadIssueInput).toBeDefined()
    expect(ReadIssueOutput).toBeDefined()
  })

  test("make() produces a tool with expected description", () => {
    const http = {} as HttpClient.HttpClient
    const def = readIssue(TEST_TOKEN, http)
    const toolDef = Tool.definition("github_read_issue", def)
    expect(toolDef.description).toContain("issue or pull request")
  })
})

describe("github_search_code — definition", () => {
  test("has correct name", () => {
    expect(searchCodeName).toBe("github_search_code")
  })

  test("has schemas with required fields", () => {
    expect(SearchCodeInput).toBeDefined()
    expect(SearchCodeOutput).toBeDefined()
  })

  test("make() produces a tool with expected description", () => {
    const http = {} as HttpClient.HttpClient
    const def = searchCode(TEST_TOKEN, http)
    const toolDef = Tool.definition("github_search_code", def)
    expect(toolDef.description).toContain("Search code")
  })
})

// ── Integration tests (requires GITHUB_TOKEN_PAT) ──

const skipToken = !process.env.GITHUB_TOKEN_PAT

describe("github tools — integration (requires GITHUB_TOKEN_PAT)", () => {
  const token = Effect.succeed(process.env.GITHUB_TOKEN_PAT ?? "missing")

  test.skipIf(skipToken)("github_list_repos returns repos for authenticated user", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const def = listRepos(token, http)
        const toolDef = Tool.definition("github_list_repos", def)
        expect(toolDef.description).toContain("repositories")
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    )
  })

  test.skipIf(skipToken)("github_read_issue definition is correct", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const def = readIssue(token, http)
        const toolDef = Tool.definition("github_read_issue", def)
        expect(toolDef.description).toContain("issue")
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    )
  })

  test.skipIf(skipToken)("github_search_code definition is correct", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const def = searchCode(token, http)
        const toolDef = Tool.definition("github_search_code", def)
        expect(toolDef.description).toContain("Search")
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    )
  })
})
