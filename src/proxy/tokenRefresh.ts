/**
 * OAuth token refresh for Claude Max profiles.
 *
 * Monitors credentials files for expiring access tokens and refreshes
 * them proactively using the OAuth refresh_token grant. The Claude CLI
 * does NOT auto-refresh tokens during query() calls, so the proxy must
 * handle this itself.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import type { ProfileConfig } from "./types"

// --- Constants ---

const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token"
const REFRESH_THRESHOLD_MS = 30 * 60 * 1000 // 30 minutes before expiry
const CHECK_INTERVAL_MS = 5 * 60 * 1000 // check every 5 minutes

// --- Types ---

interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType?: string
  rateLimitTier?: string
}

interface CredentialsFile {
  claudeAiOauth?: OAuthTokens
  [key: string]: unknown
}

interface RefreshResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string
  [key: string]: unknown
}

export interface TokenMonitorHandle {
  stop(): void
}

// --- Pure functions ---

export function getCredentialsPath(claudeConfigDir?: string): string {
  const base = claudeConfigDir || join(homedir(), ".claude")
  return join(base, ".credentials.json")
}

export function isTokenExpired(expiresAt: number): boolean {
  return expiresAt <= Date.now()
}

export function isTokenExpiringSoon(expiresAt: number, thresholdMs: number = REFRESH_THRESHOLD_MS): boolean {
  return expiresAt - Date.now() < thresholdMs
}

export function getOAuthClientId(): string {
  return process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID
}

// --- I/O functions ---

function readCredentials(credentialsPath: string): CredentialsFile | null {
  try {
    const contents = readFileSync(credentialsPath, "utf8")
    return JSON.parse(contents) as CredentialsFile
  } catch {
    return null
  }
}

function writeCredentials(credentialsPath: string, credentials: CredentialsFile): void {
  const dir = dirname(credentialsPath)
  mkdirSync(dir, { recursive: true })
  const tmp = credentialsPath + ".tmp"
  writeFileSync(tmp, JSON.stringify(credentials), { mode: 0o600 })
  renameSync(tmp, credentialsPath)
}

async function callRefreshEndpoint(refreshToken: string, clientId: string): Promise<RefreshResponse> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  })

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OAuth refresh failed (${response.status}): ${body}`)
  }

  return (await response.json()) as RefreshResponse
}

// --- Concurrency-safe refresh coordinator ---

const refreshPromiseByPath = new Map<string, Promise<boolean>>()

/**
 * Ensure the OAuth token at the given credentials path is fresh.
 * If the token is expiring soon or already expired, refresh it.
 * Concurrent calls for the same path are deduplicated.
 *
 * Returns true if the token is valid (or was refreshed), false if refresh failed.
 */
export async function ensureTokenFresh(credentialsPath: string, clientId: string): Promise<boolean> {
  // Deduplicate concurrent refresh attempts for the same credentials file
  const inflight = refreshPromiseByPath.get(credentialsPath)
  if (inflight) return inflight

  const creds = readCredentials(credentialsPath)
  if (!creds?.claudeAiOauth) return false

  const { expiresAt, refreshToken } = creds.claudeAiOauth
  if (!refreshToken || !expiresAt) return false
  if (!isTokenExpiringSoon(expiresAt)) return true

  const promise = (async () => {
    const minutesLeft = Math.round((expiresAt - Date.now()) / 60000)
    const label = isTokenExpired(expiresAt) ? "expired" : `expires in ${minutesLeft}m`
    console.log(`[TOKEN] Refreshing OAuth token for ${credentialsPath} (${label})`)

    try {
      const result = await callRefreshEndpoint(refreshToken, clientId)

      // Re-read the file to avoid clobbering concurrent changes to other fields
      const fresh = readCredentials(credentialsPath) || creds
      if (!fresh.claudeAiOauth) return false

      fresh.claudeAiOauth.accessToken = result.access_token
      fresh.claudeAiOauth.refreshToken = result.refresh_token
      fresh.claudeAiOauth.expiresAt = Date.now() + result.expires_in * 1000

      writeCredentials(credentialsPath, fresh)

      const newExpiry = new Date(fresh.claudeAiOauth.expiresAt).toISOString()
      console.log(`[TOKEN] OAuth token refreshed for ${credentialsPath} (new expiry: ${newExpiry})`)
      return true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes("invalid_grant")) {
        console.error(`[TOKEN] Refresh token is invalid or expired for ${credentialsPath}. Run 'claude login' to re-authenticate.`)
      } else {
        console.error(`[TOKEN] OAuth token refresh failed for ${credentialsPath}: ${msg}`)
      }
      return false
    }
  })()

  refreshPromiseByPath.set(credentialsPath, promise)
  try {
    return await promise
  } finally {
    refreshPromiseByPath.delete(credentialsPath)
  }
}

// --- Profile helpers ---

/**
 * Resolve credentials paths for all Claude Max profiles.
 * Deduplicates paths so each credentials file is only monitored once.
 */
export function getCredentialsPathsForProfiles(profiles: ProfileConfig[]): string[] {
  const paths = new Set<string>()

  // Always include the default path (no claudeConfigDir)
  paths.add(getCredentialsPath())

  for (const profile of profiles) {
    if (profile.type === "api") continue
    paths.add(getCredentialsPath(profile.claudeConfigDir))
  }

  return [...paths]
}

// --- Background monitor ---

/**
 * Start a background timer that checks all configured credentials files
 * and refreshes tokens that are expiring soon.
 */
export function startTokenMonitor(
  credentialsPaths: string[],
  clientId: string,
  intervalMs: number = CHECK_INTERVAL_MS,
): TokenMonitorHandle {
  if (credentialsPaths.length === 0) {
    return { stop() {} }
  }

  console.log(`[TOKEN] Starting token monitor for ${credentialsPaths.length} profile(s), checking every ${Math.round(intervalMs / 1000)}s`)

  const refresh = () => {
    for (const path of credentialsPaths) {
      ensureTokenFresh(path, clientId).catch(() => {})
    }
  }

  // Run immediately on startup
  refresh()

  const timer = setInterval(refresh, intervalMs)
  // Don't keep the process alive just for the monitor
  timer.unref()

  return {
    stop() {
      clearInterval(timer)
      console.log("[TOKEN] Token monitor stopped")
    },
  }
}
