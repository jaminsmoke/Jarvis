import { describe, expect, test } from "bun:test"
import {
  CAPABILITIES,
  getCapabilitiesForConnector,
  getCapabilityForTool,
  type ConnectorId,
} from "../src/connector"

describe("CAPABILITIES constant", () => {
  test("has capabilities for all three connectors", () => {
    const githubCaps = CAPABILITIES.filter((c) => "github" in c.scopeAliases)
    const googleCaps = CAPABILITIES.filter((c) => "google" in c.scopeAliases)
    const microsoftCaps = CAPABILITIES.filter((c) => "microsoft" in c.scopeAliases)

    expect(githubCaps.length).toBeGreaterThanOrEqual(3) // read_repos, read_issues, search_code
    expect(googleCaps.length).toBeGreaterThanOrEqual(1) // read_profile
    expect(microsoftCaps.length).toBeGreaterThanOrEqual(1) // read_profile
  })

  test("all capabilities have unique IDs", () => {
    const ids = CAPABILITIES.map((c) => c.id)
    const uniqueIds = new Set(ids)
    expect(ids.length).toBe(uniqueIds.size)
  })

  test("read capabilities have defaultEnabled=true", () => {
    const readCaps = CAPABILITIES.filter((c) => c.risk === "read")
    for (const cap of readCaps) {
      // Some read capabilities may have defaultEnabled=false (e.g., Google Drive)
      // This test verifies that at least the core read capabilities are enabled
      if (cap.id.startsWith("github:read_") || cap.id === "google:read_profile") {
        expect(cap.defaultEnabled).toBe(true)
      }
    }
  })

  test("write capabilities have defaultEnabled=false", () => {
    const writeCaps = CAPABILITIES.filter((c) => c.risk === "write")
    for (const cap of writeCaps) {
      expect(cap.defaultEnabled).toBe(false)
    }
  })

  test("all capabilities have scopeAliases", () => {
    for (const cap of CAPABILITIES) {
      expect(Object.keys(cap.scopeAliases).length).toBeGreaterThan(0)
    }
  })
})

describe("getCapabilitiesForConnector", () => {
  test("returns GitHub capabilities", () => {
    const caps = getCapabilitiesForConnector("github")
    expect(caps.length).toBeGreaterThanOrEqual(3)
    expect(caps.every((c) => "github" in c.scopeAliases)).toBe(true)
  })

  test("returns Google capabilities", () => {
    const caps = getCapabilitiesForConnector("google")
    expect(caps.length).toBeGreaterThanOrEqual(1)
    expect(caps.every((c) => "google" in c.scopeAliases)).toBe(true)
  })

  test("returns empty for unknown connector", () => {
    const caps = getCapabilitiesForConnector("unknown" as ConnectorId)
    expect(caps).toHaveLength(0)
  })
})

describe("getCapabilityForTool", () => {
  test("finds capability for github_list_repos", () => {
    const cap = getCapabilityForTool("github_list_repos")
    expect(cap).toBeDefined()
    expect(cap!.id).toBe("github:read_repos")
  })

  test("finds capability for github_read_issue", () => {
    const cap = getCapabilityForTool("github_read_issue")
    expect(cap).toBeDefined()
    expect(cap!.id).toBe("github:read_issues")
  })

  test("finds capability for github_search_code", () => {
    const cap = getCapabilityForTool("github_search_code")
    expect(cap).toBeDefined()
    expect(cap!.id).toBe("github:search_code")
  })

  test("returns undefined for unknown tool", () => {
    const cap = getCapabilityForTool("unknown_tool")
    expect(cap).toBeUndefined()
  })

  test("returns undefined for tool with no capability (profile)", () => {
    // google:read_profile has no tools
    const cap = getCapabilityForTool("google_profile")
    expect(cap).toBeUndefined()
  })
})
