/**
 * Cline model catalog loader.
 *
 * Cline exposes no live `/models` endpoint for the subscription; the catalog is
 * shipped inside the installed `@cline/llms` package as
 * `getGeneratedProviderModels()['cline-pass']`. We load that at runtime so the
 * model list reflects whatever Cline version the user has installed, rather
 * than a list hard-coded in openclaude. A static snapshot is kept only as a
 * fallback for environments where the Cline package cannot be resolved.
 */
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'

import type { ModelCatalogEntry } from '../../integrations/descriptors.js'
import { logForDebugging } from '../../utils/debug.js'
import { getClineModelType } from './clineAuth.js'

type RawClineModel = {
  id?: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  pricing?: { input?: number; output?: number }
}

function isFreeModel(model: RawClineModel): boolean {
  return model.pricing?.input === 0 && model.pricing?.output === 0
}

type ClineLlmsModule = {
  getGeneratedProviderModels: () => Record<string, Record<string, RawClineModel>>
}

// Snapshot of cline-pass at the time of writing - only used when the installed
// Cline package cannot be located. The live list is preferred.
const FALLBACK_MODELS: ModelCatalogEntry[] = [
  { id: 'cline-pass/glm-5.2', apiName: 'cline-pass/glm-5.2', label: 'GLM-5.2', contextWindow: 1_048_576, maxOutputTokens: 32_768, modelDescriptorId: 'glm-5.2' },
  { id: 'cline-pass/deepseek-v4-pro', apiName: 'cline-pass/deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_048_576, maxOutputTokens: 384_000, modelDescriptorId: 'deepseek-v4-pro' },
  { id: 'cline-pass/deepseek-v4-flash', apiName: 'cline-pass/deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { id: 'cline-pass/kimi-k2.7-code', apiName: 'cline-pass/kimi-k2.7-code', label: 'Kimi K2.7 Code', contextWindow: 262_144, maxOutputTokens: 16_384 },
  { id: 'cline-pass/kimi-k2.6', apiName: 'cline-pass/kimi-k2.6', label: 'Kimi K2.6', contextWindow: 262_144, maxOutputTokens: 262_144 },
  { id: 'cline-pass/qwen3.7-plus', apiName: 'cline-pass/qwen3.7-plus', label: 'Qwen3.7 Plus', contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { id: 'cline-pass/qwen3.7-max', apiName: 'cline-pass/qwen3.7-max', label: 'Qwen3.7 Max', contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { id: 'cline-pass/minimax-m3', apiName: 'cline-pass/minimax-m3', label: 'MiniMax-M3', contextWindow: 524_288, maxOutputTokens: 512_000 },
  { id: 'cline-pass/mimo-v2.5', apiName: 'cline-pass/mimo-v2.5', label: 'MiMo-V2.5', contextWindow: 32_000, maxOutputTokens: 131_072 },
  { id: 'cline-pass/mimo-v2.5-pro', apiName: 'cline-pass/mimo-v2.5-pro', label: 'MiMo-V2.5-Pro', contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  { id: 'cline-pass/kimi-k3', apiName: 'cline-pass/kimi-k3', label: 'Kimi K3' },
  // Free tier (work via streaming, which openclaude always uses):
  { id: 'stepfun/step-3.7-flash', apiName: 'stepfun/step-3.7-flash', label: 'Step 3.7 Flash (free)' },
  { id: 'poolside/laguna-m.1:free', apiName: 'poolside/laguna-m.1:free', label: 'Laguna M.1 (free)' },
  { id: 'deepseek/deepseek-v4-flash', apiName: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash (free)' },
]

const require = createRequire(import.meta.url)

function findClineLlmsEntry(): string | null {
  const override = process.env.CLINE_LLMS_PATH?.trim()
  if (override && existsSync(override)) return override

  const bin = findClineBinary()
  if (!bin) return null

  // Ascend from the resolved cline binary looking for the bundled @cline/llms.
  let dir = dirname(bin)
  for (let depth = 0; depth < 6; depth++) {
    for (const candidate of [
      join(dir, 'node_modules', '@cline', 'llms', 'dist', 'index.js'),
      join(dir, 'node_modules', 'cline', 'node_modules', '@cline', 'llms', 'dist', 'index.js'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
    dir = dirname(dir)
  }
  return null
}

function findClineBinary(): string | null {
  const pathDirs = (process.env.PATH ?? '').split(delimiter)
  for (const pathDir of pathDirs) {
    if (!pathDir) continue
    for (const name of ['cline', 'cline.cmd', 'cline.exe']) {
      const candidate = join(pathDir, name)
      if (existsSync(candidate)) {
        try {
          return realpathSync(candidate)
        } catch {
          return candidate
        }
      }
    }
  }
  return null
}

function loadRawModels(providerId: string): RawClineModel[] | null {
  const entry = findClineLlmsEntry()
  if (!entry) return null
  try {
    const mod = require(entry) as ClineLlmsModule
    const collections = mod.getGeneratedProviderModels?.()
    const collection = collections?.[providerId]
    if (!collection) return null
    const models = Object.values(collection)
    return models.length > 0 ? models : null
  } catch (error) {
    logForDebugging(
      `[cline-models] failed to load models from ${entry}: ${(error as Error).message}`,
      { level: 'warn' },
    )
    return null
  }
}

function toCatalogEntry(model: RawClineModel): ModelCatalogEntry | null {
  const apiName = model.id?.trim()
  if (!apiName) return null
  const name = model.name?.trim() || apiName
  // Cline exposes both a paid and a free variant of some models (e.g.
  // cline-pass/deepseek-v4-flash vs deepseek/deepseek-v4-flash) under the same
  // display name. Tag free ones so the picker shows distinct labels - but don't
  // double-tag when the name already says "free".
  const label =
    isFreeModel(model) && !/free/i.test(name) ? `${name} (free)` : name
  return {
    id: apiName,
    apiName,
    label,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
  }
}

let cached: ModelCatalogEntry[] | null = null

/**
 * Model catalog for the active Cline provider, read live from the installed
 * Cline package, falling back to a bundled snapshot.
 */
export function loadClineCatalogModels(): ModelCatalogEntry[] {
  if (cached) return cached
  const providerId = getClineModelType()
  const raw = loadRawModels(providerId) ?? loadRawModels('cline-pass')
  const live = raw
    ?.map(toCatalogEntry)
    .filter((entry): entry is ModelCatalogEntry => entry !== null)
  cached = live && live.length > 0 ? live : FALLBACK_MODELS
  return cached
}

/** Test/runtime hook to clear the in-process cache. */
export function clearClineCatalogCache(): void {
  cached = null
}
