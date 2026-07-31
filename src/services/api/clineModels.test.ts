import { afterEach, expect, test } from 'bun:test'

import { clearClineCatalogCache, loadClineCatalogModels } from './clineModels.js'

const originalPath = process.env.PATH

afterEach(() => {
  clearClineCatalogCache()
  delete process.env.CLINE_LLMS_PATH
  process.env.PATH = originalPath
})

test('loadClineCatalogModels returns namespaced entries', () => {
  const models = loadClineCatalogModels()
  expect(models.length).toBeGreaterThanOrEqual(2)
  for (const model of models) {
    expect(model.apiName).toBe(model.id)
    // Every model is namespaced (paid cline-pass/... or a free vendor prefix).
    expect(model.apiName.includes('/')).toBe(true)
    expect(typeof model.label).toBe('string')
    expect(model.label!.length).toBeGreaterThan(0)
  }
  // glm-5.2 is always present (live catalog or fallback snapshot)
  expect(models.some(m => m.apiName === 'cline-pass/glm-5.2')).toBe(true)
})

test('excludes cline-free models (API 403, product-surface only)', () => {
  const models = loadClineCatalogModels()
  expect(models.some(m => m.apiName.toLowerCase().startsWith('cline-free/'))).toBe(false)
})

test('free-model labels are not double-tagged', () => {
  const models = loadClineCatalogModels()
  for (const model of models) {
    expect(model.label).not.toMatch(/\(free\).*\(free\)/i)
  }
})

test('falls back to the bundled snapshot when the Cline package is unresolvable', () => {
  // Block both resolution strategies: invalid explicit path and empty PATH.
  process.env.CLINE_LLMS_PATH = '/nonexistent/@cline/llms/dist/index.js'
  process.env.PATH = ''
  clearClineCatalogCache()
  const models = loadClineCatalogModels()
  // Fallback snapshot has the full known cline-pass set.
  expect(models.length).toBeGreaterThanOrEqual(10)
  expect(models.some(m => m.apiName === 'cline-pass/deepseek-v4-pro')).toBe(true)
})
