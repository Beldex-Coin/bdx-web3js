import { describe, it, expect } from 'vitest'
import { toAtomic, fromAtomic, parseAtomic, ATOMIC_PER_BDX } from '../src/units.js'

describe('toAtomic', () => {
  it('converts decimal strings', () => {
    expect(toAtomic('1.25')).toBe(1_250_000_000n)
    expect(toAtomic('0.000000001')).toBe(1n)
    expect(toAtomic('0')).toBe(0n)
    expect(toAtomic('42')).toBe(42_000_000_000n)
    expect(toAtomic(' 3.5 ')).toBe(3_500_000_000n)
  })

  it('converts numbers and bigints', () => {
    expect(toAtomic(1.25)).toBe(1_250_000_000n)
    expect(toAtomic(0)).toBe(0n)
    expect(toAtomic(2n)).toBe(2n * ATOMIC_PER_BDX)
  })

  it('rejects invalid input', () => {
    for (const bad of ['', '-1', '1.2.3', '1e9', 'abc', '1.0000000001', '.5', '1.']) {
      expect(() => toAtomic(bad), bad).toThrow(RangeError)
    }
    expect(() => toAtomic(-1)).toThrow(RangeError)
    expect(() => toAtomic(NaN)).toThrow(RangeError)
    expect(() => toAtomic(Infinity)).toThrow(RangeError)
    expect(() => toAtomic(-1n)).toThrow(RangeError)
    expect(() => toAtomic(1e21)).toThrow(RangeError) // exponent rendering
  })
})

describe('fromAtomic', () => {
  it('formats with trimmed trailing zeros', () => {
    expect(fromAtomic(1_250_000_000n)).toBe('1.25')
    expect(fromAtomic(1n)).toBe('0.000000001')
    expect(fromAtomic(0n)).toBe('0')
    expect(fromAtomic(42_000_000_000n)).toBe('42')
    expect(fromAtomic('12500000000')).toBe('12.5')
  })

  it('rejects invalid input', () => {
    expect(() => fromAtomic('1.5')).toThrow(RangeError)
    expect(() => fromAtomic('-3')).toThrow(RangeError)
    expect(() => fromAtomic(-1n)).toThrow(RangeError)
  })
})

describe('parseAtomic', () => {
  it('parses wire strings', () => {
    expect(parseAtomic('0')).toBe(0n)
    expect(parseAtomic('18446744073709551615')).toBe(18446744073709551615n) // u64 max
  })
  it('rejects non-integer strings', () => {
    for (const bad of ['', '1.5', '-1', '0x10', ' 1']) {
      expect(() => parseAtomic(bad), bad).toThrow(RangeError)
    }
  })
})

describe('round-trips (randomized)', () => {
  it('fromAtomic ∘ toAtomic is identity on random amounts', () => {
    for (let i = 0; i < 500; i++) {
      const whole = BigInt(Math.floor(Math.random() * 1_000_000))
      const frac = BigInt(Math.floor(Math.random() * 1_000_000_000))
      const atomic = whole * ATOMIC_PER_BDX + frac
      expect(toAtomic(fromAtomic(atomic))).toBe(atomic)
    }
  })

  it('survives u64-scale values', () => {
    const big = 18_446_744_073n * ATOMIC_PER_BDX + 709_551_615n
    expect(toAtomic(fromAtomic(big))).toBe(big)
  })
})

describe('token units (HF22, per-token decimals)', () => {
  it('converts both ways with arbitrary decimals', async () => {
    const { toTokenAtomic, fromTokenAtomic } = await import('../src/units.js')
    expect(toTokenAtomic('1.25', 6)).toBe(1_250_000n)
    expect(toTokenAtomic('7', 0)).toBe(7n)
    expect(toTokenAtomic(2n, 3)).toBe(2_000n)
    expect(fromTokenAtomic(1_250_000n, 6)).toBe('1.25')
    expect(fromTokenAtomic('1250000', 6)).toBe('1.25')
    expect(fromTokenAtomic(7n, 0)).toBe('7')
  })
  it('rejects excess precision, negatives, bad decimals', async () => {
    const { toTokenAtomic, fromTokenAtomic } = await import('../src/units.js')
    expect(() => toTokenAtomic('1.2345', 3)).toThrow(/3 decimal/)
    expect(() => toTokenAtomic(-1n, 6)).toThrow()
    expect(() => toTokenAtomic('1', 19)).toThrow(/decimalPoint/)
    expect(() => toTokenAtomic('1', 1.5)).toThrow(/decimalPoint/)
    expect(() => fromTokenAtomic(-1n, 6)).toThrow()
  })
})
