/**
 * Real-composition guard: the plugin boots from a test cordis.yml through the
 * actual Loader, connects to a real relay, and serves plugin.list +
 * settings.describe/mutate over the wire.
 *
 * Order matters: register a device socket and pair the app BEFORE booting the
 * plugin, so the pairing code is consumed and the session token minted while
 * the test device socket is the registration. Booting the plugin afterwards
 * replaces that socket (same deviceId) — harmless, since requests now route
 * to the plugin's own live connection.
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { WebSocket } from 'ws'
import { RelayServer } from '@firefly0621/dsh-remote-relay'
import { parseMessage, serializeMessage, type Envelope } from '@firefly0621/dsh-remote-protocol'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file/src/index.ts'
import * as RemoteControlModule from '../src/index.ts'
import { RemoteControlGateway } from '../src/gateway.ts'

/** A consumer that registers the ui-theme namespace the test mutates. */
const themeConsumer = {
  name: 'theme-consumer',
  inject: ['settings'],
  apply: (ctx: Context) => {
    ctx.settings.register(settingsNamespace('ui-theme'), z.object({
      theme: z.union(['dark', 'light']).default('dark'),
    }))
  },
}

/** Resolve with the next parsed message matching `match`; reject on transport error. */
function nextMessage(socket: WebSocket, match: (message: Envelope) => boolean): Promise<Envelope> {
  return new Promise<Envelope>((resolve, reject) => {
    const handler = (data: unknown): void => {
      let message: Envelope
      try {
        message = parseMessage(Buffer.from(data as ArrayBuffer).toString())
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (match(message)) {
        socket.off('message', handler)
        resolve(message)
      }
    }
    socket.on('message', handler)
    socket.on('error', (error) => { reject(error instanceof Error ? error : new Error(String(error))) })
  })
}

describe('remote-control real composition', () => {
  let root: string | undefined
  let context: Context | undefined
  let relay: RelayServer | undefined

  afterEach(async () => {
    await context?.fiber.dispose()
    context = undefined
    await relay?.close()
    relay = undefined
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('serves inventory and settings over a real relay', async () => {
    relay = new RelayServer({ port: 0, requireTls: false, deviceSecrets: { 'test-pc': 'dev-secret' } })
    await relay.start()

    // Pair before booting the plugin: the device socket owns the registration.
    const device = new WebSocket(`ws://127.0.0.1:${relay.port}`)
    await new Promise<void>((resolve) => { device.on('open', () => { resolve() }) })
    device.send(serializeMessage({ type: 'hello', deviceId: 'test-pc', payload: { deviceSecret: 'dev-secret' } }))
    const issue = await nextMessage(device, message => message.type === 'pairing.issue')
    const code = (issue.payload as { code: string }).code
    expect(code).toMatch(/^\d{6}$/)

    const app = new WebSocket(`ws://127.0.0.1:${relay.port}`)
    await new Promise<void>((resolve) => { app.on('open', () => { resolve() }) })
    app.send(serializeMessage({ type: 'pair', payload: { pairingCode: code } }))
    const pairResult = await nextMessage(app, message => message.type === 'pair-result')
    const token = (pairResult.payload as { token: string }).token

    // Boot the plugin; its outbound client replaces the test device socket.
    root = await mkdtemp(join(tmpdir(), 'dsh-remote-control-'))
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, 'ui-theme:\n  theme: light\n')

    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: settings',
      "  name: '@deepseek-ai/dsh-settings-file'",
      '  config:',
      `    path: ${JSON.stringify(settingsPath)}`,
      '    debounceMs: 10',
      '- id: theme',
      '  name: test-theme-consumer',
      '- id: remote',
      "  name: '@firefly0621/dsh-remote-control'",
      '  config:',
      `    relayUrl: ${JSON.stringify(`ws://127.0.0.1:${relay.port}`)}`,
      "    phoneRelayUrl: 'wss://public.example.com'",
      '    deviceId: test-pc',
      '    deviceSecret: dev-secret',
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
      ['@firefly0621/dsh-remote-control', RemoteControlModule],
      ['test-theme-consumer', themeConsumer],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    // Give the plugin's outbound client a moment to register.
    await new Promise(resolve => setTimeout(resolve, 100))

    // plugin.list: the plugin must be in the inventory (it is a Loader entry).
    app.send(serializeMessage({
      type: 'request', id: 'r1', deviceId: 'test-pc',
      payload: { token, method: 'plugin.list', params: {} },
    }))
    const list = await nextMessage(app, message => message.type === 'response' && message.id === 'r1')
    const entries = (list.payload as { result: { entries: Array<{ moduleName: string }> } }).result.entries
    expect(entries.map(entry => entry.moduleName)).toContain('@firefly0621/dsh-remote-control')

    // settings.describe: the ui-theme namespace from the settings file.
    app.send(serializeMessage({
      type: 'request', id: 'r2', deviceId: 'test-pc',
      payload: { token, method: 'settings.describe', params: {} },
    }))
    const describe = await nextMessage(app, message => message.type === 'response' && message.id === 'r2')
    const namespaces = (describe.payload as { result: { namespaces: Array<{ ns: string; value: unknown }> } }).result.namespaces
    expect(namespaces.find(entry => entry.ns === 'ui-theme')?.value).toEqual({ theme: 'light' })

    // settings.mutate: change the theme and verify the file on disk updated.
    app.send(serializeMessage({
      type: 'request', id: 'r3', deviceId: 'test-pc',
      payload: { token, method: 'settings.mutate', params: { ns: 'ui-theme', ops: [{ op: 'set', path: ['theme'], value: 'dark' }] } },
    }))
    await nextMessage(app, message => message.type === 'response' && message.id === 'r3')
    expect(await readFile(settingsPath, 'utf8')).toContain('theme: dark')

    // The GUI-facing gateway exposes the live pairing code and a QR data URL.
    const gateway = ctx.get('remoteControl') as RemoteControlGateway
    const pairing = await gateway.pairing()
    expect(pairing.code).toMatch(/^\d{6}$/)
    expect(pairing.phoneRelayUrl).toBe('wss://public.example.com')
    expect(pairing.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    app.close()
  })

  it('boots with an embedded local relay and exposes pairing', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-remote-control-embedded-'))
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, 'ui-theme:\n  theme: light\n')

    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: settings',
      "  name: '@deepseek-ai/dsh-settings-file'",
      '  config:',
      `    path: ${JSON.stringify(settingsPath)}`,
      '    debounceMs: 10',
      '- id: theme',
      '  name: test-theme-consumer',
      '- id: remote',
      "  name: '@firefly0621/dsh-remote-control'",
      '  config:',
      '    port: 0',
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
      ['@firefly0621/dsh-remote-control', RemoteControlModule],
      ['test-theme-consumer', themeConsumer],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    await new Promise(resolve => setTimeout(resolve, 100))

    const gateway = ctx.get('remoteControl') as RemoteControlGateway
    const pairing = await gateway.pairing()
    expect(pairing.code).toMatch(/^\d{6}$/)
    expect(pairing.phoneRelayUrl).toMatch(/^ws:\/\/[^:]+:\d+$/)
    expect(pairing.qrDataUrl).toMatch(/^data:image\/png;base64,/)

    // The auto-generated identity was persisted into the settings document.
    expect(await readFile(settingsPath, 'utf8')).toContain('remote-control:')
  })
})
