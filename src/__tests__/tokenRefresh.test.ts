import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  getCredentialsPath,
  isTokenExpired,
  isTokenExpiringSoon,
  getOAuthClientId,
  ensureTokenFresh,
  getCredentialsPathsForProfiles,
  startTokenMonitor,
} from "../proxy/tokenRefresh"

// --- Pure function tests ---

describe("getCredentialsPath", () => {
  test("returns default path when no configDir", () => {
    const path = getCredentialsPath()
    expect(path).toContain(".claude")
    expect(path).toEndWith(".credentials.json")
  })

  test("uses provided configDir", () => {
    const path = getCredentialsPath("/home/dave/.claude")
    expect(path).toBe("/home/dave/.claude/.credentials.json")
  })
})

describe("isTokenExpired", () => {
  test("returns true for past timestamp", () => {
    expect(isTokenExpired(Date.now() - 60000)).toBe(true)
  })

  test("returns false for future timestamp", () => {
    expect(isTokenExpired(Date.now() + 60000)).toBe(false)
  })
})

describe("isTokenExpiringSoon", () => {
  test("returns true when within threshold", () => {
    const expiresAt = Date.now() + 10 * 60 * 1000 // 10 min
    expect(isTokenExpiringSoon(expiresAt, 30 * 60 * 1000)).toBe(true)
  })

  test("returns false when well beyond threshold", () => {
    const expiresAt = Date.now() + 2 * 60 * 60 * 1000 // 2 hours
    expect(isTokenExpiringSoon(expiresAt, 30 * 60 * 1000)).toBe(false)
  })

  test("returns true when already expired", () => {
    const expiresAt = Date.now() - 60000
    expect(isTokenExpiringSoon(expiresAt)).toBe(true)
  })
})

describe("getOAuthClientId", () => {
  const origEnv = process.env.CLAUDE_OAUTH_CLIENT_ID

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.CLAUDE_OAUTH_CLIENT_ID = origEnv
    } else {
      delete process.env.CLAUDE_OAUTH_CLIENT_ID
    }
  })

  test("returns default client ID", () => {
    delete process.env.CLAUDE_OAUTH_CLIENT_ID
    expect(getOAuthClientId()).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e")
  })

  test("returns env override", () => {
    process.env.CLAUDE_OAUTH_CLIENT_ID = "custom-id"
    expect(getOAuthClientId()).toBe("custom-id")
  })
})

describe("getCredentialsPathsForProfiles", () => {
  test("always includes default path", () => {
    const paths = getCredentialsPathsForProfiles([])
    expect(paths.length).toBe(1)
    expect(paths[0]).toEndWith(".credentials.json")
  })

  test("includes profile paths", () => {
    const paths = getCredentialsPathsForProfiles([
      { id: "dave", claudeConfigDir: "/home/dave/.claude" },
    ])
    expect(paths).toContain("/home/dave/.claude/.credentials.json")
  })

  test("skips API profiles", () => {
    const paths = getCredentialsPathsForProfiles([
      { id: "api-profile", type: "api", apiKey: "sk-123" },
    ])
    expect(paths.length).toBe(1) // only default
  })

  test("deduplicates paths", () => {
    const paths = getCredentialsPathsForProfiles([
      { id: "a", claudeConfigDir: "/home/dave/.claude" },
      { id: "b", claudeConfigDir: "/home/dave/.claude" },
    ])
    const daveCount = paths.filter((p) => p === "/home/dave/.claude/.credentials.json").length
    expect(daveCount).toBe(1)
  })
})

// --- I/O tests ---

describe("ensureTokenFresh", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "token-refresh-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("returns false when credentials file does not exist", async () => {
    const result = await ensureTokenFresh(join(tmpDir, "nonexistent.json"), "client-id")
    expect(result).toBe(false)
  })

  test("returns false when no OAuth section", async () => {
    const credPath = join(tmpDir, ".credentials.json")
    writeFileSync(credPath, JSON.stringify({}))
    const result = await ensureTokenFresh(credPath, "client-id")
    expect(result).toBe(false)
  })

  test("returns true when token is not expiring", async () => {
    const credPath = join(tmpDir, ".credentials.json")
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: "valid-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 2 * 60 * 60 * 1000, // 2 hours
        scopes: ["user:inference"],
      }
    }))
    const result = await ensureTokenFresh(credPath, "client-id")
    expect(result).toBe(true)
  })

  test("refreshes expired token and writes back", async () => {
    const credPath = join(tmpDir, ".credentials.json")
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 60000, // expired
        scopes: ["user:inference"],
        subscriptionType: "max",
      }
    }))

    // Mock fetch
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 28800,
      }),
    })) as unknown as typeof fetch

    try {
      const result = await ensureTokenFresh(credPath, "client-id")
      expect(result).toBe(true)

      const updated = JSON.parse(readFileSync(credPath, "utf8"))
      expect(updated.claudeAiOauth.accessToken).toBe("new-access")
      expect(updated.claudeAiOauth.refreshToken).toBe("new-refresh")
      expect(updated.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now())
      // Preserves other fields
      expect(updated.claudeAiOauth.subscriptionType).toBe("max")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns false on refresh failure", async () => {
    const credPath = join(tmpDir, ".credentials.json")
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 60000,
        scopes: [],
      }
    }))

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error": "invalid_grant"}',
    })) as unknown as typeof fetch

    try {
      const result = await ensureTokenFresh(credPath, "client-id")
      expect(result).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("startTokenMonitor", () => {
  test("returns handle with stop method", () => {
    const handle = startTokenMonitor([], "client-id")
    expect(typeof handle.stop).toBe("function")
    handle.stop()
  })

  test("returns no-op handle for empty paths", () => {
    const handle = startTokenMonitor([], "client-id")
    handle.stop() // should not throw
  })
})
