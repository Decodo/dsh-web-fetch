import type { Context } from '@deepseek-ai/cordis'
import { createDecodoFetchProvider } from './provider.ts'
import type { Config } from './provider.ts'

export { CODES, INTEGRATION, PROVIDER_ID, createDecodoFetchProvider, defaultConfig, resolveConfig } from './provider.ts'
export type { Config, Deps, Output } from './provider.ts'

export const name = 'web-fetch-decodo'
export const inject = ['web']

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const provider = createDecodoFetchProvider(config)
  ctx.effect(function* () {
    const dispose = ctx.web.registerFetchProvider(provider)
    yield () => dispose()
  })
}
