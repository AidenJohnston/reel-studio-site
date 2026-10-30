// The Worker entry. Only the default export: workerd refuses any other named export from this module.
import { handle, type Env } from './app'

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx, { fetch: globalThis.fetch.bind(globalThis), now: Date.now, cache: caches.default })
} satisfies ExportedHandler<Env>
