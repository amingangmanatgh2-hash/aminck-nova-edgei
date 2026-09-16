import type { NodeHealth, NodeRecord } from './driver';

/**
 * Node pool — deciding *which* server a user gets.
 *
 * This is where "it works on my machine" dies. A node that is down, full, or
 * disabled must never be handed to a paying customer, and a node that recovers
 * must come back on its own. So:
 *
 *  - selection filters, then weights, then breaks ties randomly — never
 *    round-robin by array order, or every customer piles onto the first node.
 *  - capacity is a soft cap that is only enforced when `capacityUsers > 0`.
 *  - health decays: one failed probe does not remove a node, three do, and a
 *    node comes back after a successful probe (not after a timer, which would
 *    resurrect a server that is still broken).
 */

export interface NodeFilter {
  /** Restrict to these protocols, e.g. a plan that only sells vless. */
  protocols?: string[];
  /** Restrict to these country codes. */
  countries?: string[];
  /** Include nodes currently marked down. */
  includeDown?: boolean;
}

export function isSelectable(
  node: NodeRecord,
  filter: NodeFilter = {},
): boolean {
  if (!node.enabled) return false;
  if (!filter.includeDown && node.health === 'down') return false;
  if (filter.protocols?.length && !filter.protocols.includes(node.protocol)) return false;
  if (filter.countries?.length && !filter.countries.includes(node.country)) return false;
  if (node.capacityUsers > 0 && node.currentUsers >= node.capacityUsers) return false;
  return true;
}

/**
 * Weighted random pick. Weight is `weight`, and a node that has never been
 * probed (`health: 'unknown'`) is halved so we do not send everyone to an
 * unverified server, but we still try it — a brand-new node has to be
 * exercised somehow.
 */
export function pickNode(
  nodes: NodeRecord[],
  filter: NodeFilter = {},
  rand: () => number = Math.random,
): NodeRecord | null {
  const candidates = nodes.filter((n) => isSelectable(n, filter));
  if (candidates.length === 0) return null;

  const weights = candidates.map((n) => {
    let w = Math.max(0, n.weight || 1);
    if (n.health === 'unknown') w *= 0.5;
    // Prefer lower priority numbers (1 = primary). Priority is a band, not a
    // hard partition: we scale it rather than bucketing, so a busy primary
    // still spills to secondary instead of overflowing.
    w /= 1 + Math.max(0, (n.priority ?? 100) - 100) / 100;
    return Math.max(w, 0.01);
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return candidates[i]!;
  }
  return candidates[candidates.length - 1]!;
}

/**
 * All usable nodes, best first. Used by the config engine: a subscription
 * normally contains every healthy node so the client can fall over by itself,
 * and we want the primary listed first.
 */
export function rankNodes(nodes: NodeRecord[], filter: NodeFilter = {}): NodeRecord[] {
  return nodes
    .filter((n) => isSelectable(n, filter))
    .sort((a, b) => {
      const healthRank = (h: NodeHealth) => (h === 'up' ? 0 : h === 'unknown' ? 1 : 2);
      const hd = healthRank(a.health) - healthRank(b.health);
      if (hd !== 0) return hd;
      const pd = (a.priority ?? 100) - (b.priority ?? 100);
      if (pd !== 0) return pd;
      return (b.weight ?? 1) - (a.weight ?? 1) || a.name.localeCompare(b.name);
    });
}

/**
 * Apply one health probe. Returns the new state so the caller can persist it.
 *
 * `failureThreshold` consecutive failures mark a node down; a single success
 * marks it up again. The counter is reset on success so a flaky node does not
 * accumulate failures forever and never recover.
 */
export function applyProbe(
  node: NodeRecord,
  ok: boolean,
  failureThreshold = 3,
): { health: NodeHealth; consecutiveFailures: number; justChanged: boolean } {
  const before = node.health;

  if (ok) {
    return {
      health: 'up',
      consecutiveFailures: 0,
      justChanged: before !== 'up',
    };
  }

  const failures = (node.consecutiveFailures ?? 0) + 1;
  const health: NodeHealth = failures >= failureThreshold ? 'down' : before === 'down' ? 'down' : 'unknown';
  return { health, consecutiveFailures: failures, justChanged: before !== health };
}

/**
 * Choose a migration target when a node is being retired or is dead.
 * Deliberately excludes the node being left, and prefers a node in the same
 * country when one exists — a user in Tehran on an Amsterdam box does not want
 * to land in São Paulo because that was the only other healthy node.
 */
export function pickMigrationTarget(
  nodes: NodeRecord[],
  leavingNodeId: string,
  preferredCountry?: string,
  rand: () => number = Math.random,
): NodeRecord | null {
  const candidates = nodes.filter((n) => n.id !== leavingNodeId && isSelectable(n));
  if (candidates.length === 0) return null;
  const sameCountry = preferredCountry
    ? candidates.filter((n) => n.country === preferredCountry)
    : [];
  return pickNode(sameCountry.length ? sameCountry : candidates, {}, rand);
}

/** Country roll-up for the admin dashboard. */
export function groupByCountry(nodes: NodeRecord[]): Map<string, NodeRecord[]> {
  const map = new Map<string, NodeRecord[]>();
  for (const n of nodes) {
    const list = map.get(n.country) ?? [];
    list.push(n);
    map.set(n.country, list);
  }
  return map;
}

/**
 * Sanity-check a node record before it is saved. A node with a blank IP or a
 * reality protocol without a public key is a config that will be sold and will
 * not connect — better to refuse it at the admin form.
 */
export function validateNode(
  node: Pick<
    NodeRecord,
    'id' | 'name' | 'publicIp' | 'port' | 'protocol' | 'security' | 'realityPbk' | 'country'
  >,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!node.name.trim()) errors.push('نام نود خالی است');
  if (!node.country.trim()) errors.push('کشور انتخاب نشده');
  if (!node.publicIp.trim()) errors.push('IP سرور خالی است');
  if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) {
    errors.push('پورت باید بین ۱ و ۶۵۵۳۵ باشد');
  } else if (node.port < 1024) {
    warnings.push('پورت زیر ۱۰۲۴ نیاز به دسترسی root روی سرور دارد');
  }
  if (node.protocol === 'vless' && node.security === 'reality' && !node.realityPbk) {
    errors.push('برای Reality کلید عمومی (pbk) الزامی است');
  }
  if (/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(node.publicIp)) {
    errors.push('IP خصوصی است؛ کاربر از بیرون به آن نمی‌رسد');
  }

  return { errors, warnings };
}
