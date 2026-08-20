// Test double for the Beldex Wallet extension's dapp bridge. Two modes:
//
//  1. Provider mode (announce()): plays the inpage script — answers the
//     beldex:requestProvider handshake with a full BeldexProvider object.
//  2. Content-script mode (attachRelay()): listens for raw RpcRequest
//     envelopes on window.postMessage and answers with RpcResponse envelopes —
//     exercises PostMessageProvider over the real wire format.
//
// Handlers are per-method functions; defaults implement a happy-path wallet.

import type {
  BdxEvent, BdxMethod, BeldexProvider, RpcErrorShape
} from '../src/types.js'
import {
  ANNOUNCE_PROVIDER_EVENT, REQUEST_PROVIDER_EVENT, REQUEST_TARGET, RESPONSE_TARGET
} from '../src/types.js'

// 97-char base58 string starting 'bx' — passes shape validation.
export const MOCK_ADDRESS = 'bx' + 'V9Kj2mPq8RtW3nXbYcZdEfGhJkNpQrSsTuVwXyZabc123'.repeat(3).slice(0, 95)
export const MOCK_TXHASH = 'a'.repeat(64)

/** Deliver a message to the page the way a real browser would (source set).
 *  jsdom's window.postMessage delivers events with source: null, which the
 *  transport rightly drops — so tests dispatch MessageEvents directly. */
export function postToPage(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', {
    data, source: window as unknown as MessageEventSource
  }))
}

type Handler = (params: unknown) => unknown // return value, or throw RpcErrorShape

export class RpcHandlerError extends Error implements RpcErrorShape {
  constructor(public code: number, message: string) { super(message) }
}

function defaultHandlers(): Record<BdxMethod, Handler> {
  return {
    bdx_connect: () => ({ address: MOCK_ADDRESS, network: 'mainnet' }),
    bdx_disconnect: () => ({}),
    bdx_getAddress: () => ({ address: MOCK_ADDRESS }),
    bdx_getBalance: () => ({
      total: '12500000000', unlocked: '10000000000', approximate: true, height: 3_500_000
    }),
    bdx_sendTransaction: () => ({ txHash: MOCK_TXHASH, fee: '22110000' }),
    bdx_signMessage: () => ({ signature: 'SigV1mockmockmock', address: MOCK_ADDRESS }),
    bdx_verifyMessage: () => ({ valid: true }),
    bdx_resolveBns: (p) => ({
      name: (p as { name: string }).name, address: MOCK_ADDRESS, verified: false
    }),
    bdx_getNetwork: () => ({
      nettype: 'mainnet', height: 3_500_000, protocolVersion: 1, walletVersion: '0.1.0'
    }),
    bdx_getState: () => ({ state: 'unlocked' })
  }
}

export class MockWallet {
  handlers: Record<BdxMethod, Handler> = defaultHandlers()
  /** Calls received, for assertions. */
  calls: Array<{ method: BdxMethod; params: unknown }> = []
  /** Artificial async delay before answering (ms). */
  delayMs = 0

  private providerListeners = new Map<string, Set<(data: unknown) => void>>()
  private announceCleanup: (() => void) | null = null
  private relayCleanup: (() => void) | null = null

  readonly provider: BeldexProvider = {
    isBeldex: true,
    request: async ({ method, params }) => {
      this.calls.push({ method, params })
      if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs))
      const h = this.handlers[method]
      if (!h) throw { code: -32601, message: `method not found: ${method}` }
      return h(params)
    },
    on: (event, listener) => {
      let s = this.providerListeners.get(event)
      if (!s) this.providerListeners.set(event, (s = new Set()))
      s.add(listener)
    },
    off: (event, listener) => {
      this.providerListeners.get(event)?.delete(listener)
    }
  }

  /** Provider mode: answer the discovery handshake (and announce once now). */
  announce(): void {
    const respond = () => {
      window.dispatchEvent(new CustomEvent(ANNOUNCE_PROVIDER_EVENT, {
        detail: Object.freeze({
          info: { uuid: 'mock-uuid', name: 'Mock Beldex Wallet', icon: 'data:,', rdns: 'io.beldex.mock' },
          provider: this.provider
        })
      }))
    }
    window.addEventListener(REQUEST_PROVIDER_EVENT, respond)
    this.announceCleanup = () => window.removeEventListener(REQUEST_PROVIDER_EVENT, respond)
    respond()
  }

  /** Push an event to provider-mode subscribers AND relay-mode pages. */
  emit(event: BdxEvent, data?: unknown): void {
    for (const fn of this.providerListeners.get(event) ?? []) fn(data)
    if (this.relayCleanup) {
      postToPage({ target: RESPONSE_TARGET, event, ...(data !== undefined ? { data } : {}) })
    }
  }

  /** Content-script mode: answer raw envelopes over window.postMessage. */
  attachRelay(): void {
    const onMessage = (ev: MessageEvent) => {
      const m = ev.data
      if (typeof m !== 'object' || m === null || m.target !== REQUEST_TARGET) return
      if (typeof m.id !== 'string' || typeof m.method !== 'string') return
      this.calls.push({ method: m.method, params: m.params })
      const reply = (body: object) => {
        const send = () => postToPage({ target: RESPONSE_TARGET, id: m.id, ...body })
        this.delayMs ? setTimeout(send, this.delayMs) : send()
      }
      const h = this.handlers[m.method as BdxMethod]
      if (!h) return reply({ error: { code: -32601, message: 'method not found' } })
      try {
        reply({ result: h(m.params) })
      } catch (e) {
        const err = e as Partial<RpcErrorShape>
        reply({
          error: {
            code: typeof err.code === 'number' ? err.code : -32603,
            message: typeof err.message === 'string' ? err.message : 'internal'
          }
        })
      }
    }
    window.addEventListener('message', onMessage)
    this.relayCleanup = () => window.removeEventListener('message', onMessage)
  }

  destroy(): void {
    this.announceCleanup?.()
    this.relayCleanup?.()
    this.announceCleanup = this.relayCleanup = null
    this.providerListeners.clear()
    delete (window as { beldex?: unknown }).beldex
  }
}
