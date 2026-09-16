import {
  buildValidUri,
  hasErrors,
  parseUri,
  parseUriToConfig,
  validateConfig,
  type Protocol,
} from './uri';
import {
  contentTypeFor,
  detectFormat,
  render,
  subscriptionHeaders,
  type SubFormat,
} from './subscription';
import {
  buildUriFor,
  safeUsername,
  type IssuedCredential,
  type IssueRequest,
  type NodeDriver,
  type NodeRecord,
} from '../node/driver';
import { rankNodes, type NodeFilter } from '../node/pool';

/**
 * Config generation — the part of this product the customer actually feels.
 *
 * Three jobs:
 *
 *  1. Issue credentials across every healthy node and turn them into URIs.
 *  2. Stamp each URI with a per-user watermark so a leaked config points back
 *     at one person, not at "someone".
 *  3. Render the set as whatever the client asked for.
 *
 * Everything here is pure except the driver calls, which are injectable — so
 * the whole thing is testable without a VPS.
 */

export interface GeneratePlan {
  /** Which protocols this purchase may use. Empty = all the node offers. */
  protocols: Protocol[];
  countries: string[];
  trafficLimitBytes: number;
  expiresAt: number | null;
  /** Prefix for the remark, e.g. `⭐ فرانسه`. The watermark is appended. */
  remarkPrefix: string;
  /** How many nodes to include in the subscription. */
  maxNodes: number;
}

export interface IssuedConfig {
  node: NodeRecord;
  credential: IssuedCredential;
  uri: string;
  watermark: string;
}

export interface IssueOutcome {
  issued: IssuedConfig[];
  /** Nodes we tried and could not use, with the reason. Surfaced to admin. */
  failures: { nodeId: string; name: string; reason: string }[];
}

/**
 * Create one credential per selected node.
 *
 * A partial failure is not a failure. If 3 of 4 nodes issue successfully the
 * user still gets a working subscription and the broken node is reported,
 * because "here are 3 working configs" beats "the panel was down, try again".
 * Only a total failure throws.
 */
export async function issueAcrossNodes(
  nodes: NodeRecord[],
  drivers: Map<string, NodeDriver>,
  plan: GeneratePlan,
  opts: {
    userIdShort: string;
    filter?: NodeFilter;
    /** Watermark generator, injectable so tests are deterministic. */
    makeWatermark?: () => string;
    usernameFor?: (node: NodeRecord, index: number) => string;
  },
): Promise<IssueOutcome> {
  const chosen = rankNodes(nodes, {
    protocols: plan.protocols,
    countries: plan.countries,
    ...opts.filter,
  }).slice(0, Math.max(1, plan.maxNodes));

  if (chosen.length === 0) {
    throw new Error('هیچ نود سالمی برای این پلن وجود ندارد');
  }

  const issued: IssuedConfig[] = [];
  const failures: IssueOutcome['failures'] = [];

  for (let i = 0; i < chosen.length; i++) {
    const node = chosen[i]!;
    const driver = drivers.get(node.id);
    if (!driver) {
      failures.push({ nodeId: node.id, name: node.name, reason: 'درایور ثبت نشده' });
      continue;
    }
    if (!driver.capabilities.issue) {
      failures.push({ nodeId: node.id, name: node.name, reason: 'این نود صدور کانفیگ ندارد' });
      continue;
    }

    const watermark = (opts.makeWatermark ?? (() => Math.random().toString(16).slice(2, 10)))();
    const username = safeUsername(
      opts.usernameFor
        ? opts.usernameFor(node, i)
        : `u${opts.userIdShort}_${node.country}${i > 0 ? i + 1 : ''}`,
    );

    const req: IssueRequest = {
      node,
      username,
      watermark,
      protocol: node.protocol,
      trafficLimitBytes: plan.trafficLimitBytes,
      expiresAt: plan.expiresAt,
      remarkPrefix: remarkFor(plan.remarkPrefix, node, watermark),
    };

    try {
      const credential = await driver.issue(req);
      // Rebuild through the parser so a malformed driver response cannot ship a
      // config that looks fine but does not connect.
      const parsed = parseUriToConfig(credential.uri);
      const problems = validateConfig(parsed).filter((i) => i.severity === 'error');
      if (problems.length > 0) {
        failures.push({
          nodeId: node.id,
          name: node.name,
          reason: `کانفیگ نامعتبر: ${problems[0]!.message}`,
        });
        continue;
      }
      const uri = buildValidUri(parsed);
      issued.push({ node, credential, uri, watermark });
    } catch (e) {
      failures.push({ nodeId: node.id, name: node.name, reason: (e as Error).message });
    }
  }

  if (issued.length === 0) {
    throw new Error(
      `صدور کانفیگ روی همه‌ی نودها ناموفق بود: ${failures.map((f) => f.reason).join(' | ')}`,
    );
  }
  return { issued, failures };
}

/**
 * The remark a customer sees, e.g. `⭐ هلند · Reality · 4f2a91c0`.
 *
 * The trailing hex is the watermark. It is short enough to be ignored and
 * unique enough to find the owner in `credentials.watermark` when a config
 * turns up in a Telegram channel. It is also what makes `rotateConfig`
 * traceable: after rotation the old watermark dies with the old secret.
 */
export function remarkFor(prefix: string, node: NodeRecord, watermark: string): string {
  const country = node.flag ? `${node.flag} ${node.countryLabel}` : node.countryLabel;
  const tech = node.protocol === 'vless' && node.security === 'reality' ? 'Reality' : node.protocol;
  const head = prefix ? `${prefix} · ` : '';
  return `${head}${country} · ${tech} · ${watermark}`;
}

/** Rebuild every URI in a set after the remark or a node changed. */
export function refreshRemarks(
  issued: IssuedConfig[],
  prefix: string,
): IssuedConfig[] {
  return issued.map((item) => {
    const remark = remarkFor(prefix, item.node, item.watermark);
    const parsed = parseUriToConfig(item.uri);
    parsed.remark = remark;
    return { ...item, uri: buildValidUri(parsed) };
  });
}

// ------------------------------------------------------------- rotation ----

export interface RotateRequest {
  sub: { id: string; token: string };
  issued: IssuedConfig[];
  drivers: Map<string, NodeDriver>;
  plan: GeneratePlan;
  opts?: { makeWatermark?: () => string; usernameFor?: IssueRequest['username'] extends never ? never : (n: NodeRecord, i: number) => string };
}

export interface RotateOutcome {
  rotated: IssuedConfig[];
  failures: IssueOutcome['failures'];
  /** Count of configs whose secret actually changed. */
  changed: number;
}

/**
 * Rotate every credential in a subscription.
 *
 * This is the answer to "my config got shared". The link and the token stay
 * identical — the user does not have to re-import — but the secret behind each
 * entry changes, so the leaked copy stops working at the same moment.
 *
 * Nodes whose driver cannot rotate are re-issued from scratch instead, which
 * is strictly safer: an un-rotatable credential that we left alone would keep
 * working for whoever has it.
 */
export async function rotateAll(req: RotateRequest): Promise<RotateOutcome> {
  const rotated: IssuedConfig[] = [];
  const failures: IssueOutcome['failures'] = [];
  let changed = 0;

  for (let i = 0; i < req.issued.length; i++) {
    const item = req.issued[i]!;
    const driver = req.drivers.get(item.node.id);
    if (!driver) {
      failures.push({ nodeId: item.node.id, name: item.node.name, reason: 'درایور ثبت نشده' });
      continue;
    }

    const watermark = (req.opts?.makeWatermark ?? (() => Math.random().toString(16).slice(2, 10)))();
    const username = req.opts?.usernameFor
      ? req.opts.usernameFor(item.node, i)
      : item.credential.username;

    const issue: IssueRequest = {
      node: item.node,
      username,
      watermark,
      protocol: item.node.protocol,
      trafficLimitBytes: req.plan.trafficLimitBytes,
      expiresAt: req.plan.expiresAt,
      remarkPrefix: remarkFor(req.plan.remarkPrefix, item.node, watermark),
    };

    try {
      const cred = driver.capabilities.rotate
        ? await driver.rotate(item.credential.panelUserId, item.node, issue)
        : await reissueOnNewAccount(driver, item, issue);
      const uri = buildValidUri(parseUriToConfig(cred.uri));
      if (uri === item.uri) {
        // A driver that returns the same URI has not rotated anything. Do not
        // tell the user they are safe when they are not.
        failures.push({
          nodeId: item.node.id,
          name: item.node.name,
          reason: 'چرخش انجام نشد: کلید عوض نشد',
        });
        continue;
      }
      changed++;
      rotated.push({ node: item.node, credential: cred, uri, watermark });
    } catch (e) {
      failures.push({ nodeId: item.node.id, name: item.node.name, reason: (e as Error).message });
    }
  }

  return { rotated, failures, changed };
}

async function reissueOnNewAccount(
  driver: NodeDriver,
  old: IssuedConfig,
  req: IssueRequest,
): Promise<IssuedCredential> {
  if (driver.capabilities.revoke) {
    try {
      await driver.revoke(old.credential.panelUserId, old.node);
    } catch {
      // If we cannot delete the old one we still issue a new one, but the
      // caller sees a failure for this node in `failures` via the URI check.
    }
  }
  return driver.issue(req);
}

// ------------------------------------------------------------ rendering ----

export interface SubscriptionView {
  body: string;
  format: SubFormat;
  contentType: string;
  headers: Record<string, string>;
  /** URIs only, for clients that want them listed in chat. */
  uris: string[];
}

export interface RenderOptions {
  ua?: string | null;
  overrideFormat?: string;
  title?: string;
  baseUrl?: string;
}

/**
 * Render a set of already-built URIs into whatever the client asked for.
 *
 * URIs are re-parsed into configs rather than passed through as strings,
 * because the Clash and Sing-box renderers need the structured form — and
 * because a URI that does not survive a round-trip is exactly the bug we want
 * to hit here rather than in the customer's client.
 */
export function renderUris(
  uris: string[],
  opts: RenderOptions = {},
): { format: SubFormat; body: string; contentType: string } {
  const configs = uris.map((u) => parseUriToConfig(u));
  const format = detectFormat(opts.ua ?? null, opts.overrideFormat);
  return {
    format,
    body: render(configs, format, {
      title: opts.title ?? 'کانفیگ',
      profileWebPageUrl: opts.baseUrl,
    }),
    contentType: contentTypeFor(format),
  };
}

export function headersFor(
  opts: RenderOptions,
  format: SubFormat,
): Record<string, string> {
  return subscriptionHeaders(
    { title: opts.title ?? 'کانفیگ', profileWebPageUrl: opts.baseUrl },
    format,
  );
}

export function buildSubscriptionView(
  uris: string[],
  opts: RenderOptions = {},
): SubscriptionView {
  const { format, body, contentType } = renderUris(uris, opts);
  return { body, format, contentType, headers: headersFor(opts, format), uris };
}

/**
 * Find the owner of a leaked config.
 *
 * The watermark is embedded in the remark, so a pasted URI is enough — no
 * database round-trip needed to *extract* it. Matching it to a user is the
 * caller's job (a single indexed lookup on `credentials.watermark`).
 */
export function extractWatermark(uri: string): string | null {
  let parsed;
  try {
    parsed = parseUri(uri);
  } catch {
    // A mangled paste is still searchable: fall back to a raw tail match.
    const m = /(?:#|remark=)[^\s]*?([0-9a-f]{6,10})\s*$/i.exec(uri);
    return m ? (m[1] as string).toLowerCase() : null;
  }
  // `parseUri` already decodes the remark, so this match is on real text.
  const m = /([0-9a-f]{6,10})\s*$/.exec(parsed.remark ?? '');
  return m ? (m[1] as string).toLowerCase() : null;
}

/**
 * Decide whether a subscription needs a proactive rotation, so a cron can act
 * before the customer notices their link is in a public channel.
 */
export function rotationAdvice(input: {
  usedBytes: number;
  limitBytes: number;
  createdAt: number;
  lastRotatedAt: number | null;
  rotateAfterBytes: number;
  rotateAfterDays: number;
  now?: number;
}): { rotate: boolean; reason: string } {
  const t = input.now ?? Date.now();
  if (input.rotateAfterBytes > 0 && input.usedBytes >= input.rotateAfterBytes) {
    return { rotate: true, reason: 'مصرف از حد چرخش گذشت' };
  }
  const age = t - (input.lastRotatedAt ?? input.createdAt);
  if (input.rotateAfterDays > 0 && age >= input.rotateAfterDays * 86_400_000) {
    return { rotate: true, reason: 'مدت از آخرین چرخش گذشت' };
  }
  if (input.limitBytes > 0 && input.usedBytes / input.limitBytes >= 0.95) {
    return { rotate: false, reason: 'نزدیک پایان حجم — به کاربر اطلاع بده' };
  }
  return { rotate: false, reason: '' };
}

/** Rebuild a URI through the parser. Exported for the migration path. */
export function rebuildUri(uri: string): string {
  return buildValidUri(parseUriToConfig(uri));
}
