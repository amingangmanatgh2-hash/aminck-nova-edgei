import type { D1Database } from '@cloudflare/workers-types';
import { asBool, asInt, asString } from './db/db';
import { MarzbanDriver } from './node/marzban';
import { MockNodeDriver, type NodeDriver, type NodeRecord } from './node/driver';

/**
 * Build the node list and its drivers from D1.
 *
 * The rule that matters: a node is only given a real driver when it has the
 * credentials to talk to its panel. Anything else gets the mock, and the mock
 * is visibly labelled — never dressed up as a working server.
 */
export async function mapNodesWithDrivers(
  db: D1Database,
): Promise<{ nodes: NodeRecord[]; drivers: Map<string, NodeDriver> }> {
  const res = await db
    .prepare('SELECT * FROM nodes ORDER BY priority, name')
    .all<Record<string, unknown>>();

  const nodes: NodeRecord[] = [];
  const drivers = new Map<string, NodeDriver>();

  for (const r of res.results) {
    const node = mapRow(r);
    nodes.push(node);

    const hasPanel = node.panelUrl && node.panelUser && node.panelKey;
    if (node.driver === 'mock') {
      drivers.set(node.id, new MockNodeDriver());
    } else if (hasPanel) {
      // Constructing the driver does not call the panel; it validates config.
      // A node with a bad URL throws here, and we must not lose the whole boot
      // over one misconfigured server.
      try {
        drivers.set(node.id, new MarzbanDriver(node));
      } catch {
        drivers.set(node.id, new MockNodeDriver());
      }
    } else {
      drivers.set(node.id, new MockNodeDriver());
    }
  }

  return { nodes, drivers };
}

function mapRow(r: Record<string, unknown>): NodeRecord {
  return {
    id: asString(r.id),
    name: asString(r.name),
    country: asString(r.country),
    countryLabel: asString(r.country_label, asString(r.country)),
    flag: asString(r.flag),
    protocol: (asString(r.protocol, 'vless') as NodeRecord['protocol']) ?? 'vless',
    security: (asString(r.security, 'reality') as NodeRecord['security']) ?? 'reality',
    publicIp: asString(r.public_ip),
    port: asInt(r.port, 443),
    sni: asString(r.sni),
    realityPbk: asString(r.reality_pbk),
    realityFp: asString(r.reality_fp, 'chrome'),
    realitySpider: asString(r.reality_spider),
    wsPath: asString(r.ws_path),
    inboundTag: asString(r.inbound_tag, 'VLESS'),
    panelUrl: asString(r.panel_url),
    panelUser: asString(r.panel_user),
    panelKey: asString(r.panel_key),
    priority: asInt(r.priority, 100),
    weight: asInt(r.weight, 1),
    health: (asString(r.health, 'unknown') as NodeRecord['health']) ?? 'unknown',
    consecutiveFailures: asInt(r.consecutive_failures, 0),
    enabled: asBool(r.enabled),
    capacityUsers: asInt(r.capacity_users, 0),
    currentUsers: asInt(r.current_users, 0),
    driver: asString(r.driver, 'mock'),
  };
}
