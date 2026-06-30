import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addWorkosPrefix,
  decodeJwtPayload,
  ensureClineModelPrefix,
  getClineModelType,
  getClineProvidersPath,
  isClineBaseUrl,
  resolveClineBearer,
  shouldUseClineAuth,
  stripWorkosPrefix,
  tokenExpiryMs,
} from './clineAuth.js'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

const originalEnv = {
  CLINE_CONFIG_PATH: process.env.CLINE_CONFIG_PATH,
  CLINE_DIR: process.env.CLINE_DIR,
  CLINE_PROVIDER_ID: process.env.CLINE_PROVIDER_ID,
  CLINE_MODEL_TYPE: process.env.CLINE_MODEL_TYPE,
}

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'clineauth-'))
  configPath = join(tmpDir, 'providers.json')
  process.env.CLINE_CONFIG_PATH = configPath
  delete process.env.CLINE_PROVIDER_ID
  delete process.env.CLINE_MODEL_TYPE
})

afterEach(() => {
  mock.restore()
  rmSync(tmpDir, { recursive: true, force: true })
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function writeConfig(accessExp: number, opts?: { refresh?: string; lastUsed?: string; model?: string }) {
  const access = makeJwt({ exp: accessExp, client_id: 'client_test', sub: 'u' })
  const config = {
    version: 1,
    lastUsedProvider: opts?.lastUsed ?? 'cline-pass',
    providers: {
      'cline-pass': {
        settings: {
          provider: 'cline-pass',
          model: opts?.model ?? 'cline-pass/glm-5.2',
          auth: {
            accessToken: `workos:${access}`,
            refreshToken: opts?.refresh ?? 'refresh-abc',
            expiresAt: accessExp * 1000,
            accountId: 'usr-1',
          },
        },
        tokenSource: 'oauth',
        updatedAt: '2026-06-29T00:00:00.000Z',
      },
    },
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  return access
}

test('isClineBaseUrl matches the cline gateway host only', () => {
  expect(isClineBaseUrl('https://api.cline.bot/api/v1')).toBe(true)
  expect(isClineBaseUrl('https://api.cline.bot')).toBe(true)
  expect(isClineBaseUrl('https://api.openai.com/v1')).toBe(false)
  expect(isClineBaseUrl('https://evil.com/api.cline.bot')).toBe(false)
  expect(isClineBaseUrl(undefined)).toBe(false)
})

test('shouldUseClineAuth triggers on flag or cline base url', () => {
  delete process.env.CLAUDE_CODE_USE_CLINE
  expect(shouldUseClineAuth('https://api.cline.bot/api/v1')).toBe(true)
  expect(shouldUseClineAuth('https://api.openai.com/v1')).toBe(false)
  process.env.CLAUDE_CODE_USE_CLINE = '1'
  try {
    expect(shouldUseClineAuth('https://api.openai.com/v1')).toBe(true)
  } finally {
    delete process.env.CLAUDE_CODE_USE_CLINE
  }
})

test('workos prefix add/strip are idempotent', () => {
  expect(stripWorkosPrefix('workos:abc')).toBe('abc')
  expect(stripWorkosPrefix('abc')).toBe('abc')
  expect(addWorkosPrefix('abc')).toBe('workos:abc')
  expect(addWorkosPrefix('workos:abc')).toBe('workos:abc')
})

test('decodeJwtPayload reads claims, tolerates workos prefix', () => {
  const jwt = makeJwt({ exp: 123, client_id: 'cid' })
  expect(decodeJwtPayload(jwt)?.client_id).toBe('cid')
  expect(decodeJwtPayload(`workos:${jwt}`)?.exp).toBe(123)
  expect(decodeJwtPayload('garbage')).toBeUndefined()
})

test('tokenExpiryMs prefers JWT exp over stored expiresAt', () => {
  const jwt = makeJwt({ exp: 2000 })
  expect(tokenExpiryMs({ accessToken: jwt, expiresAt: 9_999_000 })).toBe(2_000_000)
  expect(tokenExpiryMs({ expiresAt: 5000 })).toBe(5000)
  expect(tokenExpiryMs({})).toBeUndefined()
})

test('ensureClineModelPrefix only prefixes bare model ids', () => {
  expect(ensureClineModelPrefix('glm-5.2', 'cline-pass')).toBe('cline-pass/glm-5.2')
  expect(ensureClineModelPrefix('cline-pass/glm-5.2', 'cline-pass')).toBe('cline-pass/glm-5.2')
  expect(ensureClineModelPrefix('anthropic/claude', 'cline-pass')).toBe('anthropic/claude')
})

test('getClineProvidersPath honors override then CLINE_DIR then default', () => {
  expect(getClineProvidersPath()).toBe(configPath)
  delete process.env.CLINE_CONFIG_PATH
  process.env.CLINE_DIR = '/custom/cline'
  expect(getClineProvidersPath()).toBe('/custom/cline/data/settings/providers.json')
})

test('getClineModelType derives namespace from stored model', () => {
  writeConfig(Math.floor(Date.now() / 1000) + 3600, { model: 'cline-pass/deepseek-v4-pro' })
  expect(getClineModelType()).toBe('cline-pass')
  process.env.CLINE_MODEL_TYPE = 'override-type'
  expect(getClineModelType()).toBe('override-type')
})

test('resolveClineBearer returns stored token when far from expiry', async () => {
  const access = writeConfig(Math.floor(Date.now() / 1000) + 3600)
  const fetchSpy = mock(() => Promise.reject(new Error('should not refresh')))
  globalThis.fetch = fetchSpy as unknown as typeof fetch
  expect(await resolveClineBearer()).toBe(`workos:${access}`)
  expect(fetchSpy).not.toHaveBeenCalled()
})

test('resolveClineBearer refreshes near expiry and writes rotated creds back', async () => {
  writeConfig(Math.floor(Date.now() / 1000) + 30) // within 5-min buffer
  const newAccess = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'client_test' })
  const fetchSpy = mock((url: string, init: { body: URLSearchParams }) => {
    expect(url).toContain('api.workos.com/user_management/authenticate')
    const params = init.body
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('refresh-abc')
    expect(params.get('client_id')).toBe('client_test')
    return Promise.resolve(
      new Response(JSON.stringify({ access_token: newAccess, refresh_token: 'refresh-next' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
  globalThis.fetch = fetchSpy as unknown as typeof fetch

  const bearer = await resolveClineBearer()
  expect(bearer).toBe(`workos:${newAccess}`)
  expect(fetchSpy).toHaveBeenCalledTimes(1)

  const persisted = JSON.parse(readFileSync(configPath, 'utf8'))
  const stored = persisted.providers['cline-pass'].settings.auth
  expect(stored.accessToken).toBe(`workos:${newAccess}`)
  expect(stored.refreshToken).toBe('refresh-next')
})

test('resolveClineBearer surfaces a clear error on refresh failure', async () => {
  writeConfig(Math.floor(Date.now() / 1000) + 30)
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response('invalid_grant', { status: 400 })),
  ) as unknown as typeof fetch
  await expect(resolveClineBearer()).rejects.toThrow(/refresh failed \(400\)/)
})

test('resolveClineBearer errors when not signed in', async () => {
  writeFileSync(configPath, JSON.stringify({ version: 1, providers: {} }))
  await expect(resolveClineBearer()).rejects.toThrow(/No Cline credentials/)
})
