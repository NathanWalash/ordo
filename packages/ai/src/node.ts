// Node-only parts of the AI layer: adapters that use fetch or spawn processes.
// Import from '@ordo/ai/node' in the Electron main process; never in the renderer.
import type { ModelProvider, ProviderId } from './types'
import { ClaudeCliProvider, CodexCliProvider } from './node/cli'
import { LmStudioProvider, OllamaProvider } from './node/local'
import { CommandResolver } from './node/process'

export { ClaudeCliProvider, CodexCliProvider, type CliProviderOptions } from './node/cli'
export { LmStudioProvider, OllamaProvider } from './node/local'
export {
  CommandResolver,
  findOnPath,
  quoteWindowsArg,
  runProcess,
  type ResolverOptions,
} from './node/process'
export { requestJson } from './node/http'

export interface ProviderConfig {
  lmstudioUrl?: string
  ollamaUrl?: string
  claudeCommand?: string
  codexCommand?: string
  resolver?: CommandResolver
}

/** One adapter per provider id. */
export function createProviders(config: ProviderConfig = {}): Record<ProviderId, ModelProvider> {
  const resolver = config.resolver ?? new CommandResolver()
  return {
    lmstudio: new LmStudioProvider(config.lmstudioUrl),
    ollama: new OllamaProvider(config.ollamaUrl),
    'claude-cli': new ClaudeCliProvider({ resolver, command: config.claudeCommand }),
    'codex-cli': new CodexCliProvider({ resolver, command: config.codexCommand }),
  }
}
