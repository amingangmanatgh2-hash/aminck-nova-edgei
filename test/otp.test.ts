import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestOtp, verifyOtp, testHelpers } from '../src/auth/otp';
import type { OtpDeps } from '../src/auth/otp';
import { exec } from './helpers';

let mf: Miniflare;
let deps: OtpDeps;
let sent: { phone: string; code: string }[] = [];

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch(){ return new Response("ok") } }',
    d1Databases: { GODDB: 'otp-db' },
    kvNamespaces: { GODKV: 'otp-kv' },
  });
  const db = await mf.getD1Database('GODDB');
  await exec(db, 'src/db/schema.sql');
  sent = [];
  deps = {
    db,
    kv: (await mf.getKVNamespace('GODKV')) as unknown as KVNamespace,
    otpSecret: 'test-otp-secret',
    devMode: true,
    send: async (phone, code) => {
      sent.push({ phone, code });
      return true;
    },
  };
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

const PHONE = '09121110001';

describe('OTP request', () => {
  it('rejects an invalid phone number', async () => {
    const r = await requestOtp(deps, '12345', '1.2.3.4');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_phone_number');
  });

  it('issues a code and returns it in dev mode', async () => {
    const r = await requestOtp(deps, PHONE, '1.2.3.4');
    expect(r.ok).toBe(true);
    expect(r.devCode).toMatch(/^\d{5}$/);
  });

  it('enforces the resend cooldown', async () => {
    const r = await requestOtp(deps, PHONE, '1.2.3.4');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('resend_cooldown');
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it('caps requests per phone', async () => {
    let last: Awaited<ReturnType<typeof requestOtp>> | null = null;
    for (let i = 0; i < 8; i++) {
      last = await requestOtp(deps, '09121110002', `10.0.0.${i}`);
      // Clear the cooldown between attempts so only the hourly cap can bite.
      await deps.kv.delete(testHelpers.kvKey(await phoneHash('09121110002')));
    }
    expect(last!.ok).toBe(false);
    expect(last!.reason).toBe('too_many_requests_phone');
  });

  it('caps requests per IP', async () => {
    let last: Awaited<ReturnType<typeof requestOtp>> | null = null;
    for (let i = 0; i < 14; i++) {
      last = await requestOtp(deps, `0912111${String(1000 + i).slice(-4)}`, '9.9.9.9');
      await deps.kv.delete(testHelpers.kvKey(await phoneHash(`0912111${String(1000 + i).slice(-4)}`)));
    }
    expect(last!.ok).toBe(false);
    expect(last!.reason).toBe('too_many_requests_ip');
  });
});

describe('OTP verify', () => {
  const P = '09121119999';

  it('accepts the correct code and burns the challenge', async () => {
    const req = await requestOtp(deps, P, '5.5.5.5');
    const ok = await verifyOtp(deps, P, req.devCode!, '5.5.5.5');
    expect(ok.ok).toBe(true);
    expect(ok.phoneE164).toBe('+989121119999');
    // Replay must fail: the challenge was deleted.
    const replay = await verifyOtp(deps, P, req.devCode!, '5.5.5.5');
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('no_challenge');
  });

  it('rejects a wrong code and counts down attempts', async () => {
    const P2 = '09121118888';
    await requestOtp(deps, P2, '6.6.6.6');
    const bad = await verifyOtp(deps, P2, '00000', '6.6.6.6');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('invalid_code');
    expect(bad.attemptsLeft).toBe(4);
  });

  it('locks the challenge after too many wrong attempts', async () => {
    const P3 = '09121117777';
    await requestOtp(deps, P3, '7.7.7.7');
    let last: Awaited<ReturnType<typeof verifyOtp>> | null = null;
    for (let i = 0; i < 6; i++) last = await verifyOtp(deps, P3, '00000', '7.7.7.7');
    expect(last!.ok).toBe(false);
    expect(['too_many_attempts', 'no_challenge']).toContain(last!.reason);
  });

  it('never stores the code in the clear', async () => {
    const P4 = '09121116666';
    const req = await requestOtp(deps, P4, '8.8.8.8');
    const stored = await deps.kv.get(testHelpers.kvKey(await phoneHash(P4)));
    expect(stored).toBeTruthy();
    expect(stored!).not.toContain(req.devCode!);
  });

  it('raises a fraud alert when many numbers verify from one IP', async () => {
    const db = deps.db;
    for (let i = 0; i < 7; i++) {
      const phone = `0912222${String(1000 + i).slice(-4)}`;
      const req = await requestOtp(deps, phone, '4.4.4.4');
      await verifyOtp(deps, phone, req.devCode!, '4.4.4.4');
    }
    const { results } = await db
      .prepare("SELECT COUNT(*) AS n FROM fraud_alerts WHERE kind='ip_cluster'")
      .all<{ n: number }>();
    expect(results![0]!.n).toBeGreaterThan(0);
  }, 60_000);
});

async function phoneHash(phone: string): Promise<string> {
  const { hashPhone, normalizePhone } = await import('../src/utils');
  return hashPhone(normalizePhone(phone), 'test-otp-secret');
}
