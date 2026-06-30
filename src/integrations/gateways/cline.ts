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
  catalog: {
    source: 'static',
    models: [
      {
        id: 'cline-pass-glm-5-2',
        apiName: 'cline-pass/glm-5.2',
        label: 'GLM 5.2 (Cline)',
        modelDescriptorId: 'glm-5.2',
      },
      {
        id: 'cline-pass-deepseek-v4-pro',
        apiName: 'cline-pass/deepseek-v4-pro',
        label: 'DeepSeek V4 Pro (Cline)',
        modelDescriptorId: 'deepseek-v4-pro',
      },
    ],
  },
  usage: { supported: false },
})
