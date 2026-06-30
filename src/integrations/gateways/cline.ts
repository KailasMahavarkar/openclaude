import { defineGateway } from '../define.js'

/**
 * Cline subscription provider. Reuses a logged-in Cline account
 * (the `cline-pass` / WorkOS OAuth subscription) as an OpenAI-compatible
 * endpoint. Activated with CLAUDE_CODE_USE_CLINE=1.
 *
 * Auth is not an API key: the runtime reads and refreshes the WorkOS token
 * Cline stores in ~/.cline/data/settings/providers.json. See
 * src/services/api/clineAuth.ts (resolveClineBearer) and the openaiShim
 * Cline branch.
 */
export default defineGateway({
  id: 'cline',
  label: 'Cline',
  category: 'aggregating',
  defaultBaseUrl: 'https://api.cline.bot/api/v1',
  defaultModel: 'cline-pass/glm-5.2',
  supportsModelRouting: true,
  setup: {
    // Auth is managed by the Cline app/CLI (WorkOS OAuth), not by an API key
    // entered in the wizard.
    requiresAuth: false,
    authMode: 'none',
    setupPrompt:
      'Sign in with the Cline app or CLI first, then set CLAUDE_CODE_USE_CLINE=1. No API key needed.',
  },
  startup: {
    enablementEnvVar: 'CLAUDE_CODE_USE_CLINE',
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsAuthHeaders: true,
      maxTokensField: 'max_tokens',
    },
  },
  preset: {
    id: 'cline',
    description: 'Cline subscription (sign in to Cline, set CLAUDE_CODE_USE_CLINE=1)',
    modelEnvVars: ['CLINE_MODEL', 'OPENAI_MODEL'],
    vendorId: 'openai',
  },
  validation: {
    kind: 'credential-env',
    routing: {
      enablementEnvVar: 'CLAUDE_CODE_USE_CLINE',
      // The /provider picker activates Cline by base URL (CLAUDE_CODE_USE_OPENAI
      // + OPENAI_BASE_URL=api.cline.bot) without the flag, so match on the URL
      // too - otherwise validation falls through to the OpenAI vendor, which
      // demands an API key.
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['api.cline.bot'],
    },
    // Credentials live in ~/.cline/data/settings/providers.json, resolved and
    // refreshed at request time, so no env credential is required here.
    credentialEnvVars: [],
    allowMissingCredential: true,
    missingCredentialMessage:
      'Sign in to Cline first (the app/CLI stores the token in ~/.cline/data/settings/providers.json).',
  },
  // Models are read live from the installed Cline package (@cline/llms) at
  // request time via the custom discovery hook - see services/api/clineModels.ts
  // and discoveryService.ts. Cline ships no live /models endpoint.
  catalog: {
    source: 'dynamic',
    discovery: { kind: 'custom' },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
  },
  usage: { supported: false },
})
