import { describe, expect, it } from 'vitest';
import {
  coefficientOfVariation,
  eloDelta,
  hashPassword,
  hashPhone,
  isPrivateIp,
  isUuidLike,
  isValidIranPhone,
  isValidMcName,
  normalizePhone,
  sign,
  timingSafeEqual,
  verify,
  verifyPassword,
} from '../src/utils';

describe('phone normalisation', () => {
  it('accepts every common Iranian format', () => {
    for (const [input, want] of [
      ['09123456789', '+989123456789'],
      ['9123456789', '+989123456789'],
      ['+989123456789', '+989123456789'],
      ['00989123456789', '+989123456789'],
      ['989123456789', '+989123456789'],
      ['0912 345 6789', '+989123456789'],
      ['۰۹۱۲۳۴۵۶۷۸۹', '+989123456789'], // Persian digits
    ] as const) {
      expect(normalizePhone(input), input).toBe(want);
    }
  });

  it('validates only real mobile prefixes', () => {
    expect(isValidIranPhone('+989123456789')).toBe(true);
    expect(isValidIranPhone('+982112345678')).toBe(false); // landline
    expect(isValidIranPhone('+98912345678')).toBe(false); // too short
    expect(isValidIranPhone('+14155551234')).toBe(false); // not Iran
  });
});

describe('IP classification', () => {
  it('blocks private, loopback and CGNAT ranges', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('allows public addresses, including common Iranian ones', () => {
    for (const ip of ['8.8.8.8', '5.160.0.1', '2.180.1.1', '172.32.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
  it('treats an empty IP as unsafe', () => {
    expect(isPrivateIp('')).toBe(true);
  });
});

describe('HMAC sessions', () => {
  it('verifies a signature it produced', async () => {
    const tag = await sign('hello', 'secret', 'usage');
    await expect(verify('hello', tag, 'secret', 'usage')).resolves.toBe(true);
  });
  it('rejects a tampered payload', async () => {
    const tag = await sign('hello', 'secret', 'usage');
    await expect(verify('hell0', tag, 'secret', 'usage')).resolves.toBe(false);
  });
  it('rejects a different secret', async () => {
    const tag = await sign('hello', 'secret', 'usage');
    await expect(verify('hello', tag, 'other', 'usage')).resolves.toBe(false);
  });
  it('separates usages so an OTP hash cannot sign a session', async () => {
    const tag = await sign('x', 'secret', 'otp');
    await expect(verify('x', tag, 'secret', 'player-session')).resolves.toBe(false);
  });
});

describe('timing-safe comparison', () => {
  it('handles differing lengths without throwing', () => {
    expect(timingSafeEqual('a', 'abc')).toBe(false);
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });
});

describe('password hashing', () => {
  it('round-trips and uses a random salt each time', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    await expect(verifyPassword('correct horse battery staple', a)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', a)).resolves.toBe(false);
  }, 20_000);
});

describe('phone hashing', () => {
  it('is stable and secret-dependent', async () => {
    const a = await hashPhone('09123456789', 's1');
    const b = await hashPhone('+989123456789', 's1');
    const c = await hashPhone('09123456789', 's2');
    expect(a).toBe(b); // same number, different format
    expect(a).not.toBe(c); // different secret
  });
});

describe('ELO', () => {
  it('gains more when beating a stronger opponent', () => {
    const upset = eloDelta(1000, 1400, true);
    const expected = eloDelta(1000, 1400, false);
    expect(upset).toBeGreaterThan(0);
    expect(expected).toBeLessThan(0);
    expect(upset).toBeGreaterThan(eloDelta(1000, 1000, true));
  });
  it('shrinks the K-factor as players settle', () => {
    expect(eloDelta(1000, 1000, true, 5)).toBeGreaterThan(eloDelta(1000, 1000, true, 100));
  });
  it('is zero-sum for equal ratings', () => {
    const w = eloDelta(1200, 1200, true);
    const l = eloDelta(1200, 1200, false);
    expect(Math.abs(w + l)).toBeLessThanOrEqual(1);
  });
});

describe('statistics', () => {
  it('separates machine-like from human clicking', () => {
    const machine = Array.from({ length: 200 }, (_, i) => 50 + (i % 2)); // near-constant
    const human = Array.from({ length: 200 }, (_, i) => 50 + ((i * 37) % 60) - 30);
    expect(coefficientOfVariation(machine)).toBeLessThan(coefficientOfVariation(human));
    expect(coefficientOfVariation(machine)).toBeLessThan(0.06);
  });
});

describe('Minecraft identifiers', () => {
  it('enforces Java username rules', () => {
    expect(isValidMcName('Notch')).toBe(true);
    expect(isValidMcName('a_b_1')).toBe(true);
    expect(isValidMcName('ab')).toBe(false); // too short
    expect(isValidMcName('has space')).toBe(false);
    expect(isValidMcName('x'.repeat(17))).toBe(false);
  });
  it('allows spaces for Bedrock', () => {
    expect(isValidMcName('Steve Player', 'bedrock')).toBe(true);
  });
  it('accepts dashed and undashed UUIDs', () => {
    expect(isUuidLike('069a79f4-44e9-4726-a5be-fca90e38aaf5')).toBe(true);
    expect(isUuidLike('069a79f444e94726a5befca90e38aaf5')).toBe(true);
    expect(isUuidLike('not-a-uuid')).toBe(false);
  });
});
