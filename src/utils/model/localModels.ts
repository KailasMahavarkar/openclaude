/**
 * Local model discovery for the /model picker.
 *
 * A model served from your own GPU behind an OpenAI-compatible endpoint
 * (llama-server, vLLM, LM Studio). Discovered at runtime and cached so the
 * synchronous getModelOptions() can use it, mirroring the Ollama path.
 *
 * The endpoint IS the credential: there is no key to configure, so presence of
 * a reachable server is what makes the provider active.
 */

import type { ModelOption } from './modelOptions.js'

let cachedLocalOptions: ModelOption[] | null = null
let fetchPromise: Promise<ModelOption[]> | null = null

const LOCAL_FETCH_TIMEOUT_MS = 3000
const OLLAMA_DEFAULT_PORT = '11434'

/**
 * Base URL of the local OpenAI-compatible server, without a trailing slash.
 * LOCAL_LLM_BASE_URL wins; otherwise a loopback OPENAI_BASE_URL counts as local.
 */
export function getLocalBaseUrl(): string | null {
  const explicit = process.env.LOCAL_LLM_BASE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const openaiBase = process.env.OPENAI_BASE_URL?.trim()
  if (!openaiBase) return null
  try {
    const parsed = new URL(openaiBase)
    const isLoopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '0.0.0.0'
    // Ollama owns its own provider path; do not claim its port here.
    if (isLoopback && parsed.port !== OLLAMA_DEFAULT_PORT) {
      return openaiBase.replace(/\/+$/, '')
    }
  } catch {
    return null
  }
  return null
}

/**
 * True when a local OpenAI-compatible server is configured.
 */
export function isLocalProvider(): boolean {
  return getLocalBaseUrl() !== null
}

/** Context the server was started with, for display only. */
function getLocalCtx(): number | null {
  const raw = process.env.LOCAL_LLM_CTX?.trim()
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Measured decode tok/s on this machine, if the operator recorded one. */
function getLocalTps(): number | null {
  const raw = process.env.LOCAL_LLM_TPS?.trim()
  if (!raw) return null
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Human label from a served model id. GGUF filenames are the common case and
 * carry noise ("Ternary-Bonsai-27B-Q2_0.gguf") that reads badly in a picker.
 */
function toLabel(id: string): string {
  return id
    .replace(/\.gguf$/i, '')
    .replace(/[-_](Q\d[\w.]*|F16|BF16|FP16|IQ\d\w*|TQ\d_\d)$/i, '')
    .replace(/[-_]/g, ' ')
    .trim()
}

/** Parameter count parsed from the id, e.g. "27B" -> "27B". */
function toParamSize(id: string): string | null {
  const m = id.match(/(\d+(?:\.\d+)?)\s*b\b/i)
  return m ? `${m[1]}B` : null
}

/** Quantization tag parsed from the id, e.g. "Q2_0". */
function toQuant(id: string): string | null {
  // Drop the container extension first, otherwise a trailing ".gguf" is swallowed
  // into the tag and renders as "Q2_0.GGUF".
  const stem = id.replace(/\.(gguf|safetensors|bin)$/i, '')
  const m = stem.match(/\b(Q\d+(?:_\w+)*|IQ\d+\w*|TQ\d_\d|F16|BF16)\b/i)
  return m ? m[1].toUpperCase() : null
}

function buildDescription(id: string): string {
  const ctx = getLocalCtx()
  const tps = getLocalTps()
  const parts = [
    toParamSize(id),
    toQuant(id),
    ctx ? `${Math.round(ctx / 1024)}K context` : null,
    tps ? `~${Math.round(tps)} tok/s` : null,
  ].filter(Boolean)
  // "Local" first so the picker makes the zero-cost, private option obvious.
  return parts.length > 0 ? `Local · ${parts.join(' · ')}` : 'Local model'
}

/**
 * Normalize the /v1/models payload. Servers disagree on the shape: vLLM and
 * LM Studio return the OpenAI form {data:[{id}]}, llama-server returns an
 * Ollama-flavoured {models:[{name, model}]}. Accept both.
 */
function normalizeIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const p = payload as {
    data?: Array<Record<string, unknown>>
    models?: Array<Record<string, unknown>>
  }
  const rows = p.data ?? p.models ?? []
  const ids: string[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const id = row.id ?? row.model ?? row.name
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}

/**
 * Fetch models from the local server's OpenAI-compatible /v1/models.
 */
export async function fetchLocalModels(): Promise<ModelOption[]> {
  const base = getLocalBaseUrl()
  if (!base) return []

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LOCAL_FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(`${base}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY ?? 'local'}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) return []

    return normalizeIds(await response.json()).map(id => ({
      value: id,
      label: toLabel(id),
      description: buildDescription(id),
    }))
  } catch {
    // A local server that is simply switched off is the normal case, not an error.
    return []
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Prefetch and cache local models. Call during startup.
 */
export function prefetchLocalModels(): void {
  if (!isLocalProvider()) return
  if (cachedLocalOptions && cachedLocalOptions.length > 0) return
  if (fetchPromise) return
  fetchPromise = fetchLocalModels()
    .then(options => {
      cachedLocalOptions = options
      return options
    })
    .finally(() => {
      fetchPromise = null
    })
}

/**
 * Get cached local model options (synchronous).
 * Returns empty array if not yet fetched.
 */
export function getCachedLocalModelOptions(): ModelOption[] {
  return cachedLocalOptions ?? []
}
