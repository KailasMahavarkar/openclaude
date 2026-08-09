// Coverage for local-server discovery. The two things worth pinning down are
// (a) which base URLs count as "local" - Ollama owns its own provider path and
// must not be claimed here - and (b) that the /v1/models payload is parsed for
// both shapes servers actually return (OpenAI's {data:[{id}]} and
// llama-server's Ollama-flavoured {models:[{name}]}).

import { afterEach, describe, expect, test } from 'bun:test'
import { fetchLocalModels, getLocalBaseUrl, isLocalProvider } from './localModels.js'

const ENV_KEYS = [
  'LOCAL_LLM_BASE_URL',
  'LOCAL_LLM_CTX',
  'LOCAL_LLM_TPS',
  'OPENAI_BASE_URL',
] as const

const originalEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    const value = patch[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('getLocalBaseUrl', () => {
  test('prefers LOCAL_LLM_BASE_URL and strips trailing slashes', () => {
    setEnv({
      LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8081/v1/',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    })
    expect(getLocalBaseUrl()).toBe('http://127.0.0.1:8081/v1')
  })

  test('treats a loopback OPENAI_BASE_URL as local', () => {
    setEnv({ OPENAI_BASE_URL: 'http://localhost:8081/v1' })
    expect(getLocalBaseUrl()).toBe('http://localhost:8081/v1')
    expect(isLocalProvider()).toBe(true)
  })

  test('does not claim the Ollama port', () => {
    setEnv({ OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' })
    expect(getLocalBaseUrl()).toBeNull()
    expect(isLocalProvider()).toBe(false)
  })

  test('a remote OPENAI_BASE_URL is not local', () => {
    setEnv({ OPENAI_BASE_URL: 'https://api.openai.com/v1' })
    expect(getLocalBaseUrl()).toBeNull()
  })

  test('unset environment is not local', () => {
    setEnv({})
    expect(getLocalBaseUrl()).toBeNull()
    expect(isLocalProvider()).toBe(false)
  })
})

describe('fetchLocalModels', () => {
  const realFetch = globalThis.fetch

  function stubFetch(payload: unknown, ok = true): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: ok ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
  }

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('parses the OpenAI {data:[{id}]} shape', async () => {
    setEnv({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8081/v1' })
    stubFetch({ data: [{ id: 'Ternary-Bonsai-27B-Q2_0.gguf' }] })

    const options = await fetchLocalModels()
    expect(options).toHaveLength(1)
    expect(options[0]?.value).toBe('Ternary-Bonsai-27B-Q2_0.gguf')
    // The .gguf container and the quant tag are noise in a picker label.
    expect(options[0]?.label).toBe('Ternary Bonsai 27B')
    expect(options[0]?.description).toBe('Local · 27B · Q2_0')
  })

  test('parses the llama-server {models:[{name}]} shape', async () => {
    setEnv({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8081/v1' })
    stubFetch({ models: [{ name: 'qwen3-8b-Q4_K_M.gguf' }] })

    const options = await fetchLocalModels()
    expect(options.map(o => o.value)).toEqual(['qwen3-8b-Q4_K_M.gguf'])
  })

  test('folds context and measured throughput into the description', async () => {
    setEnv({
      LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8081/v1',
      LOCAL_LLM_CTX: '184320',
      LOCAL_LLM_TPS: '38.4',
    })
    stubFetch({ data: [{ id: 'Ternary-Bonsai-27B-Q2_0.gguf' }] })

    const [option] = await fetchLocalModels()
    expect(option?.description).toBe('Local · 27B · Q2_0 · 180K context · ~38 tok/s')
  })

  test('a server that is switched off yields no options rather than throwing', async () => {
    setEnv({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8081/v1' })
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    expect(await fetchLocalModels()).toEqual([])
  })

  test('a non-OK response yields no options', async () => {
    setEnv({ LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8081/v1' })
    stubFetch({ data: [{ id: 'x' }] }, false)

    expect(await fetchLocalModels()).toEqual([])
  })

  test('no local server configured means no request at all', async () => {
    setEnv({})
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch

    expect(await fetchLocalModels()).toEqual([])
    expect(called).toBe(false)
  })
})
