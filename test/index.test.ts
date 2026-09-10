import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { WebFetchProvider } from '@deepseek-ai/dsh-web'
import { apply, inject, name } from '../src/index.ts'

type Disposer = () => void

function fakeContext() {
  const registered: WebFetchProvider[] = []
  const disposers: Disposer[] = []
  let unregistered = 0
  const ctx = {
    effect(callback: () => Generator<Disposer, void, unknown>) {
      const disposer = callback().next().value
      assert.ok(typeof disposer === 'function', 'effect must yield a disposer')
      disposers.push(disposer)
    },
    web: {
      registerFetchProvider(provider: WebFetchProvider): Disposer {
        registered.push(provider)
        return () => { unregistered += 1 }
      },
    },
  }
  return { ctx: ctx as unknown as Context, registered, disposers, unregistered: () => unregistered }
}

test('plugin metadata: name and the web dependency', () => {
  assert.equal(name, 'web-fetch-decodo')
  assert.deepEqual(inject, ['web'])
})

test('apply registers the decodo provider inside an effect and unregisters on dispose', () => {
  const { ctx, registered, disposers, unregistered } = fakeContext()
  apply(ctx, { maxFetchesPerSession: 5 })
  assert.equal(registered.length, 1)
  assert.equal(registered[0]?.id, 'decodo')
  assert.equal(typeof registered[0]?.fetch, 'function')
  assert.equal(disposers.length, 1)
  disposers[0]?.()
  assert.equal(unregistered(), 1)
})

test('apply rejects an invalid config before touching the seam', () => {
  const { ctx, registered } = fakeContext()
  assert.throws(() => apply(ctx, { output: 'pdf' as never }), /output must be one of/)
  assert.equal(registered.length, 0)
})
