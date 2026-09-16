/**
 * Worker entry point.
 *
 * Serves the public site, the admin panel, and the JSON API. Static assets are
 * generated from src/ui/* by scripts/build-public.mjs and served through the
 * ASSETS binding, but `run_worker_first` keeps every request inside the Worker
 * so security headers apply to HTML and JS alike.
 */
import { handleApi } from './api/router';
import type { ApiEnv } from './api/router';
import { withSecurityHeaders, err } from './net/security';
import { SITE_HTML } from './ui/site';
import { ADMIN_HTML } from './ui/admin';
import { loadSettings } from './db/db';
import { decideRecovery, evaluateHealth, DEFAULT_HEALTH_CONFIG } from './monitor/health';
import type { Heartbeat, RecoveryState } from './monitor/health';
import type { ServerStatus } from './types';
import { all, one, run, audit } from './db/db';
import { newId, now } from './utils';

export { ServerLock, Matchmaker, AntiCheatOracle } from './do/objects';

export interface Env extends ApiEnv {
  ASSETS?: Fetcher;
  SERVER_LOCK: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  ANTICHEAT: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/healthz') {
        return withSecurityHeaders(
          new Response(JSON.stringify({ ok: true, app: 'minecraft-god-server', ts: now() }), {
            headers: { 'content-type': 'application/json' },
          }),
          { cors: true },
        );
      }

      if (path.startsWith('/api/')) {
        return await handleApi(request, env);
      }

      // --- server-rendered pages. Kept inline so the panel works even if the
      //     static asset build has not been run.
      if (path === '/' || path === '/index.html') {
        const settings = await loadSettings(env.GODDB);
        const html = SITE_HTML.replace(
          '<title>Minecraft God Server</title>',
          `<title>${escapeHtml(settings.serverName)}</title>`,
        ).replace('<span class="brand" id="serverName">Minecraft God Server</span>',
          `<span class="brand" id="serverName">${escapeHtml(settings.serverName)}</span>`);
        return withSecurityHeaders(htmlResponse(html));
      }

      if (path === '/admin' || path === '/admin/' || path === '/admin/index.html') {
        return withSecurityHeaders(htmlResponse(ADMIN_HTML));
      }

      // --- static assets
      if (env.ASSETS) {
        const res = await env.ASSETS.fetch(request);
        if (res.status !== 404) return withSecurityHeaders(res, { csp: false });
      }

      return withSecurityHeaders(err('not_found', 404));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (env.DEBUG_ERRORS === '1') console.error('[worker-error]', path, e);
      ctx.waitUntil(
        audit(env.GODDB, {
          actor: 'system',
          action: 'error.unhandled',
          detail: `${path}: ${msg}`.slice(0, 400),
        }).catch(() => undefined),
      );
      // Never leak internals to the client.
      return withSecurityHeaders(err('internal_error', 500));
    }
  },

  /**
   * Cron: health evaluation, recovery decisions, and stale-server cleanup.
   * Registered for the 5-minute (health), 30-minute (pricing) and 04:00
   * (backup) schedules declared in wrangler.jsonc.
   */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const cron = (event as unknown as { cron?: string }).cron ?? '';
    if (cron.includes('*/5')) await runHealthPass(env);
    if (cron.includes('*/30')) await runPricingPass(env);
    if (cron.includes('0 4 * * *')) await runBackupPass(env);
  },
} satisfies ExportedHandler<Env>;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// ------------------------------------------------------------------ cron
/**
 * Mark servers whose heartbeat has gone stale, and record the health history.
 *
 * Note what this deliberately does NOT do: it never restarts a container on
 * its own authority. It computes the decision and stores it; actually bouncing
 * a runtime requires the container orchestration binding, which is documented
 * in docs/FEASIBILITY.md as unavailable on the free plan.
 */
async function runHealthPass(env: Env): Promise<void> {
  const rows = await all<{
    id: string; status: string; last_heartbeat: number | null;
    tps: number | null; mem_used_mb: number | null; mem_max_mb: number | null;
    online_players: number | null;
  }>(env.GODDB, 'SELECT id, status, last_heartbeat, tps, mem_used_mb, mem_max_mb, online_players FROM servers');

  const t = now();
  for (const r of rows) {
    const hb: Heartbeat | null = r.last_heartbeat
      ? {
          serverId: r.id,
          instanceId: 'unknown',
          processAlive: true,
          players: r.online_players ?? 0,
          maxPlayers: 20,
          tps: r.tps ?? 20,
          memUsedMb: r.mem_used_mb ?? 0,
          memMaxMb: r.mem_max_mb ?? 0,
          cpuPercent: 0,
          version: null,
          motd: null,
          worldSavedAt: null,
          at: r.last_heartbeat,
        }
      : null;

    const verdict = evaluateHealth(
      hb,
      (r.status as ServerStatus) || 'offline',
      DEFAULT_HEALTH_CONFIG,
      t,
    );
    const recovery: RecoveryState = { attempts: 0, lastAttemptAt: null, gaveUp: false };
    const decision = decideRecovery(recovery, verdict);

    await run(
      env.GODDB,
      'UPDATE servers SET status = ?, updated_at = ? WHERE id = ?',
      verdict.status,
      t,
      r.id,
    );
    await run(
      env.GODDB,
      `INSERT INTO health_checks (id, server_id, status, process_ok, port_ok, ping_ms, players,
          mem_mb, cpu_pct, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      newId(),
      r.id,
      verdict.status,
      verdict.metrics.heartbeatAgeMs === null ? 0 : 1,
      null,
      null,
      verdict.metrics.players,
      verdict.metrics.memFraction === null ? null : Math.round(verdict.metrics.memFraction * 100),
      null,
      `${verdict.reason} | recovery: ${decision.action} (${decision.reason})`.slice(0, 400),
      t,
    );
  }
}

/** Refresh discount campaigns from observed conversion data. */
async function runPricingPass(env: Env): Promise<void> {
  const { profileDemand, decideDiscount } = await import('./shop/pricing');
  const events = await all<{
    product_id: string; hour_of_day: number; day_of_week: number;
    impressions: number; conversions: number; revenue_usd: number;
  }>(env.GODDB, 'SELECT product_id, hour_of_day, day_of_week, impressions, conversions, revenue_usd FROM price_events');
  const profiles = profileDemand(
    events.map((e) => ({
      productId: e.product_id,
      hourOfDay: e.hour_of_day,
      dayOfWeek: e.day_of_week,
      impressions: e.impressions,
      conversions: e.conversions,
      revenueUsd: e.revenue_usd,
    })),
  );
  const products = await all<{ id: string; base_usd: number }>(
    env.GODDB,
    'SELECT id, base_usd FROM products WHERE active = 1',
  );
  for (const p of products) {
    const d = decideDiscount(p.id, p.base_usd, profiles.get(p.id));
    await run(env.GODDB, 'UPDATE products SET price_usd = ? WHERE id = ?', d.finalUsd, p.id);
    if (d.pct > 0) {
      await run(
        env.GODDB,
        `INSERT INTO discount_campaigns (id, product_id, pct, rationale, model_used, starts_at, ends_at, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        newId(), p.id, d.pct, d.rationale.slice(0, 400), 'rule-based-demand', now(), now() + 3600_000, now(),
      );
    }
  }
}

/**
 * Backups.
 *
 * Honestly scoped: this exports the DATABASE to R2. It cannot snapshot a
 * Minecraft world, because no world lives on Cloudflare — see
 * docs/FEASIBILITY.md. Claiming otherwise would be a lie.
 */
async function runBackupPass(env: Env): Promise<void> {
  const tables = ['users', 'orders', 'entitlements', 'bans', 'appeals', 'audit_logs', 'cheat_cases', 'servers'];
  const dump: Record<string, unknown[]> = {};
  for (const t of tables) {
    try {
      const r = await env.GODDB.prepare(`SELECT * FROM ${t} LIMIT 5000`).all();
      dump[t] = r.results ?? [];
    } catch {
      dump[t] = [];
    }
  }
  const key = `backups/db-${new Date().toISOString().slice(0, 10)}.json`;
  await env.GODR2.put(key, JSON.stringify(dump), {
    httpMetadata: { contentType: 'application/json' },
  });
  await audit(env.GODDB, { actor: 'system', action: 'backup.daily', target: key });
}

export const internals = { evaluateHealth, decideRecovery, newId };
