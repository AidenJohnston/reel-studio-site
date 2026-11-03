// The Worker entry. Only the default export: workerd refuses any other named export from this module.
import { handle, type Deps, type Env } from './app'
import { retention } from './retention'

/** Entitlement answers, kept a minute per isolate (sessions.ts). */
const entitlementCache: NonNullable<Deps['entitlementCache']> = new Map()
const deps = (): Deps => ({ fetch: globalThis.fetch.bind(globalThis), now: Date.now, entitlementCache })

export default {
  fetch: (request, env) => handle(request, env, deps()),
  scheduled: async (_controller, env, ctx) => {
    ctx.waitUntil(retention(env, { fetch: globalThis.fetch.bind(globalThis), now: Date.now }))
  }
} satisfies ExportedHandler<Env>
