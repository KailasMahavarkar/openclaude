/**
 * Cline subscription auth bridge.
 *
 * openclaude can use a logged-in Cline account (the "cline-pass" subscription)
 * as an OpenAI-compatible provider. Cline stores its WorkOS OAuth session in
 * ~/.cline/data/settings/providers.json. The access token is a short-lived
 * (~1h) JWT that must be sent as `Authorization: Bearer workos:<jwt>` to
 * https://api.cline.bot/api/v1, and refreshed via WorkOS when it nears expiry.
 *
 * The Cline daemon only refreshes lazily (when Cline itself makes a call), so
 * during a long openclaude session we refresh the token ourselves and write the
 * rotated credentials back to providers.json to keep Cline in sync.
 *
 * Enabled with CLAUDE_CODE_USE_CLINE=1. Wire-up lives in client.ts (routing),
 * providerConfig.ts (base URL + model prefix) and openaiShim.ts (bearer).
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isEnvTruthy } from '../../utils/envUtils.js'

export const CLINE_API_BASE_URL = 'https://api.cline.bot/api/v1'
/** Model namespace Cline expects: requests use `<modelType>/<model>`. */
export const CLINE_DEFAULT_MODEL_TYPE = 'cline-pass'
export const CLINE_DEFAULT_MODEL = 'glm-5.2'

const WORKOS_TOKEN_ENDPOINT = 'https://api.workos.com/user_management/authenticate'
const WORKOS_TOKEN_PREFIX = 'workos:'
/** Refresh this far ahead of expiry. Matches Cline's own 5-minute skew. */
const REFRESH_BUFFER_MS = 300_000
const REFRESH_TIMEOUT_MS = 30_000

type ClineAuth = {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  accountId?: string
}

type ClineProviderEntry = {
  settings?: {
    provider?: string
    auth?: ClineAuth
    model?: string
  }
  tokenSource?: string
  updatedAt?: string
}

type ClineProvidersFile = {
  version?: number
  lastUsedProvider?: string
  providers?: Record<string, ClineProviderEntry>
}

export function isClineMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_CLINE)
}

/** True when a base URL targets the Cline gateway host. */
export function isClineBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.cline.bot'
  } catch {
    return false
  }
}

/**
 * Cline auth applies when explicitly enabled (CLAUDE_CODE_USE_CLINE) or
 * whenever the active endpoint is the Cline gateway - e.g. the `/provider`
 * picker activates Cline as an OpenAI-compatible route by base URL alone.
 */
export function shouldUseClineAuth(baseUrl: string | undefined): boolean {
  return isClineMode() || isClineBaseUrl(baseUrl)
}

export function getClineProvidersPath(): string {
  const override = process.env.CLINE_CONFIG_PATH?.trim()
  if (override) return override
  const home = process.env.CLINE_DIR?.trim() || join(homedir(), '.cline')
  return join(home, 'data', 'settings', 'providers.json')
}

export function stripWorkosPrefix(token: string): string {
  const trimmed = token.trim()
  return trimmed.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)
    ? trimmed.slice(WORKOS_TOKEN_PREFIX.length)
    : trimmed
}

export function addWorkosPrefix(token: string): string {
  const trimmed = token.trim()
  return trimmed.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)
    ? trimmed
    : `${WORKOS_TOKEN_PREFIX}${trimmed}`
}

/** Decode a JWT payload without verifying the signature. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const raw = stripWorkosPrefix(jwt)
  const parts = raw.split('.')
  if (parts.length < 2) return undefined
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Token expiry in epoch ms, preferring the JWT `exp` claim over stored value. */
export function tokenExpiryMs(auth: ClineAuth): number | undefined {
  if (auth.accessToken) {
    const exp = decodeJwtPayload(auth.accessToken)?.exp
    if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000
  }
  if (typeof auth.expiresAt === 'number' && Number.isFinite(auth.expiresAt)) {
    return auth.expiresAt
  }
  return undefined
}

function readProvidersFile(path: string): ClineProvidersFile {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    throw new Error(
      `Cline config not found at ${path}. Install and sign in to Cline, or set CLINE_CONFIG_PATH.`,
    )
  }
  try {
    const parsed = JSON.parse(contents)
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    return parsed as ClineProvidersFile
  } catch {
    throw new Error(`Cline config at ${path} is not valid JSON.`)
  }
}

function selectProviderId(file: ClineProvidersFile): string {
  const override = process.env.CLINE_PROVIDER_ID?.trim()
  if (override) return override
  if (file.lastUsedProvider?.trim()) return file.lastUsedProvider.trim()
  return CLINE_DEFAULT_MODEL_TYPE
}

/**
 * Namespace to prefix onto a bare model id (e.g. "glm-5.2" -> "cline-pass/…").
 * Defaults to "cline-pass" (the subscription). We deliberately do NOT derive it
 * from the active model's prefix - a free model like `deepseek/deepseek-v4-flash`
 * would otherwise make bare models resolve to the wrong namespace.
 */
export function getClineModelType(): string {
  return process.env.CLINE_MODEL_TYPE?.trim() || CLINE_DEFAULT_MODEL_TYPE
}

/** Ensure a model id carries the `<modelType>/` namespace Cline requires. */
export function ensureClineModelPrefix(model: string, modelType: string = getClineModelType()): string {
  const trimmed = model.trim()
  if (!trimmed) return trimmed
  return trimmed.includes('/') ? trimmed : `${modelType}/${trimmed}`
}

async function refreshWorkosToken(auth: ClineAuth): Promise<ClineAuth> {
  if (!auth.refreshToken) {
    throw new Error('Cline token expired and no refresh token is stored. Re-login via the Cline app.')
  }
  const clientId = decodeJwtPayload(auth.accessToken ?? '')?.client_id
  if (typeof clientId !== 'string' || !clientId) {
    throw new Error('Cline token is missing a client_id claim; cannot refresh. Re-login via the Cline app.')
  }

  const response = await fetch(WORKOS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      client_id: clientId,
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Cline token refresh failed (${response.status})${detail ? `: ${detail}` : ''}. Re-login via the Cline app.`,
    )
  }

  const json = (await response.json()) as {
    access_token?: string
    refresh_token?: string
  }
  if (!json.access_token || !json.refresh_token) {
    throw new Error('Cline token refresh returned an invalid response.')
  }

  return {
    accessToken: addWorkosPrefix(json.access_token),
    refreshToken: json.refresh_token,
    expiresAt: tokenExpiryMs({ accessToken: json.access_token }),
    accountId: auth.accountId,
  }
}

function writeBackAuth(
  path: string,
  file: ClineProvidersFile,
  providerId: string,
  refreshed: ClineAuth,
): void {
  const entry = file.providers?.[providerId]
  if (!entry?.settings) return
  entry.settings.auth = {
    ...entry.settings.auth,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    accountId: refreshed.accountId ?? entry.settings.auth?.accountId,
  }
  entry.updatedAt = new Date().toISOString()
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`)
    renameSync(tmp, path)
  } catch {
    /* best-effort: a failed write-back must not break the in-flight request */
  }
}

/**
 * Resolve a usable `Bearer` value for api.cline.bot, refreshing and persisting
 * the rotated token when the stored one is within REFRESH_BUFFER_MS of expiry.
 */
export async function resolveClineBearer(now: number = Date.now()): Promise<string> {
  const path = getClineProvidersPath()
  const file = readProvidersFile(path)
  const providerId = selectProviderId(file)
  const auth = file.providers?.[providerId]?.settings?.auth

  if (!auth?.accessToken) {
    throw new Error(
      `No Cline credentials for provider "${providerId}" in ${path}. Sign in to Cline first.`,
    )
  }

  const expiry = tokenExpiryMs(auth)
  if (expiry === undefined || expiry - now > REFRESH_BUFFER_MS) {
    return addWorkosPrefix(auth.accessToken)
  }

  const refreshed = await refreshWorkosToken(auth)
  writeBackAuth(path, file, providerId, refreshed)
  return addWorkosPrefix(refreshed.accessToken!)
}
