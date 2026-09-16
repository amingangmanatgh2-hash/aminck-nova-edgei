-- ============================================================================
--  ConfigBot — D1 schema
--
--  Design rules
--  - every id is a TEXT ulid/uuid, not an INTEGER. We run on the edge and never
--    want a guessable or enumerable primary key.
--  - created_at / updated_at are INTEGER unix milliseconds everywhere.
--  - money is INTEGER Toman. Never a float, never a string.
--  - secrets are never stored in plaintext except where the protocol demands
--    the raw value to build a URI (node private keys, issued credentials).
--    Those columns are marked and only ever read by the config engine.
--  - everything an admin can click is auditable, so `audit_log` exists.
-- ============================================================================

-- ---------------------------------------------------------------- settings --
-- A single row, id = 1. The admin panel writes here; the bot reads here.
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bot_name TEXT NOT NULL DEFAULT 'ConfigBot',
  support_chat TEXT NOT NULL DEFAULT '',
  support_channel TEXT NOT NULL DEFAULT '',
  default_language TEXT NOT NULL DEFAULT 'fa',
  currency TEXT NOT NULL DEFAULT 'تومان',
  trial_enabled INTEGER NOT NULL DEFAULT 1,
  trial_days INTEGER NOT NULL DEFAULT 3,
  trial_traffic_gb INTEGER NOT NULL DEFAULT 5,
  referral_enabled INTEGER NOT NULL DEFAULT 1,
  referral_percent INTEGER NOT NULL DEFAULT 15,
  card_holder TEXT NOT NULL DEFAULT '',
  card_number TEXT NOT NULL DEFAULT '',
  card_bank TEXT NOT NULL DEFAULT '',
  payment_message TEXT NOT NULL DEFAULT '',
  subscription_path TEXT NOT NULL DEFAULT '/s',
  sub_base_url TEXT NOT NULL DEFAULT '',
  traffic_overage_per_gb INTEGER NOT NULL DEFAULT 0,
  low_balance_warn_percent INTEGER NOT NULL DEFAULT 15,
  low_traffic_warn_percent INTEGER NOT NULL DEFAULT 20,
  expire_warn_days INTEGER NOT NULL DEFAULT 3,
  maintenance_mode INTEGER NOT NULL DEFAULT 0,
  maintenance_message TEXT NOT NULL DEFAULT '',
  ai_enabled INTEGER NOT NULL DEFAULT 1,
  ai_temperature REAL NOT NULL DEFAULT 0.4,
  admin_user_ids TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

-- ------------------------------------------------------------------ nodes --
-- One row per VPN server. A "node" is a machine running Marzban/Xray/3x-ui.
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,              -- 'nl', 'de', 'tr', ...
  country_label TEXT NOT NULL,        -- 'هلند'
  flag TEXT NOT NULL DEFAULT '',
  driver TEXT NOT NULL,               -- 'marzban' | 'xray' | '3xui' | 'mock'
  panel_url TEXT NOT NULL DEFAULT '',
  panel_user TEXT NOT NULL DEFAULT '',
  panel_key TEXT NOT NULL DEFAULT '', -- secret
  api_base TEXT NOT NULL DEFAULT '',
  inbound_tag TEXT NOT NULL DEFAULT 'VLESS',
  protocol TEXT NOT NULL DEFAULT 'vless',
  security TEXT NOT NULL DEFAULT 'reality',
  public_ip TEXT NOT NULL,
  port INTEGER NOT NULL,
  sni TEXT NOT NULL DEFAULT '',
  reality_pbk TEXT NOT NULL DEFAULT '',   -- secret (public key, but keep it out of UI)
  reality_fp TEXT NOT NULL DEFAULT 'chrome',
  reality_spider TEXT NOT NULL DEFAULT '',
  ws_path TEXT NOT NULL DEFAULT '',
  tls_cert TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 100,
  weight INTEGER NOT NULL DEFAULT 1,
  health TEXT NOT NULL DEFAULT 'unknown',  -- 'up' | 'down' | 'unknown'
  last_check_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  capacity_users INTEGER NOT NULL DEFAULT 0,  -- 0 = unlimited
  current_users INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_health ON nodes(health, enabled, priority);

-- ------------------------------------------------------------------ plans --
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'subscription', -- 'subscription' | 'single'
  protocol_filter TEXT NOT NULL DEFAULT '[]',  -- JSON array of protocols
  price INTEGER NOT NULL,
  old_price INTEGER,                  -- for the strikethrough price
  traffic_gb INTEGER NOT NULL DEFAULT 0,      -- 0 = unlimited
  duration_days INTEGER NOT NULL DEFAULT 30,
  max_devices INTEGER NOT NULL DEFAULT 2,
  allow_refill INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  badge TEXT NOT NULL DEFAULT '',     -- 'پرفروش'
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_visible ON plans(hidden, sort_order);

-- plan pricing per node — a plan can cost more in one country
CREATE TABLE IF NOT EXISTS plan_nodes (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  price_override INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (plan_id, node_id)
);

-- -------------------------------------------------------------- customers --
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  telegram_id INTEGER UNIQUE,
  username TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  language_code TEXT NOT NULL DEFAULT 'fa',
  is_premium INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'support' | 'admin' | 'owner'
  balance INTEGER NOT NULL DEFAULT 0, -- wallet, Toman
  total_spent INTEGER NOT NULL DEFAULT 0,
  referred_by TEXT REFERENCES users(id),
  referral_code TEXT UNIQUE,
  referral_earnings INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  block_reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  seen_terms_at INTEGER,
  last_active_at INTEGER,
  last_seen_ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(last_active_at);

-- ------------------------------------------------------------ credentials --
-- Every config we have ever issued. This is the leak-tracing table: if a
-- config is shared, we find the owner from `watermark`.
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  panel_user_id TEXT NOT NULL DEFAULT '', -- the id on the panel side
  username TEXT NOT NULL,
  -- protocol-specific secret material
  uuid TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  ss_method TEXT NOT NULL DEFAULT '',
  ss_key TEXT NOT NULL DEFAULT '',
  wg_private_key TEXT NOT NULL DEFAULT '',
  wg_public_key TEXT NOT NULL DEFAULT '',
  wg_psk TEXT NOT NULL DEFAULT '',
  wg_endpoint_port INTEGER NOT NULL DEFAULT 0,
  tuic_congestion TEXT NOT NULL DEFAULT 'cubic',
  hy2_auth TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  watermark TEXT NOT NULL DEFAULT '',  -- short id embedded in the remark
  uri TEXT NOT NULL DEFAULT '',        -- last built URI (cache + audit)
  traffic_bytes INTEGER NOT NULL DEFAULT 0,
  traffic_limit_bytes INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active', -- active|suspended|revoked|expired|migrated
  revoked_at INTEGER,
  revoke_reason TEXT NOT NULL DEFAULT '',
  last_used_at INTEGER,
  device_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_credentials_sub ON credentials(sub_id);
CREATE INDEX IF NOT EXISTS idx_credentials_watermark ON credentials(watermark);
CREATE INDEX IF NOT EXISTS idx_credentials_status ON credentials(status);

-- --------------------------------------------------------- subscriptions --
-- One row per purchase that grants a link. The link never changes on rotate.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,          -- in the URL; not guessable
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
  label TEXT NOT NULL DEFAULT '',
  traffic_gb INTEGER NOT NULL DEFAULT 0,
  traffic_used_bytes INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 30,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active', -- active|expired|suspended|canceled
  format_lock TEXT NOT NULL DEFAULT '',  -- pin a format if ?type= was used
  rotation_count INTEGER NOT NULL DEFAULT 0,
  last_rotated_at INTEGER,
  rotate_after_bytes INTEGER NOT NULL DEFAULT 0,
  rotate_after_days INTEGER NOT NULL DEFAULT 0,
  suspended_at INTEGER,
  suspend_reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_token ON subscriptions(token);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status, expires_at);

-- ---------------------------------------------------------------- orders --
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,           -- short code shown to the user
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'subscription', -- subscription|refill|renew|trial
  plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
  target_sub_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  traffic_gb INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 30,
  amount INTEGER NOT NULL,             -- Toman, what the user pays
  discount INTEGER NOT NULL DEFAULT 0,
  paid_from_balance INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'تومان',
  status TEXT NOT NULL DEFAULT 'pending',
    -- pending|awaiting_payment|paid|approved|rejected|canceled|expired|failed
  gateway TEXT NOT NULL DEFAULT '',    -- 'card' | 'zarinpal' | ...
  gateway_ref TEXT NOT NULL DEFAULT '',
  gateway_authority TEXT NOT NULL DEFAULT '',
  paid_at INTEGER,
  expires_at INTEGER,
  reject_reason TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at INTEGER,
  coupon_code TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_code ON orders(code);

-- -------------------------------------------------------------- payments --
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gateway TEXT NOT NULL,               -- 'card' | 'zarinpal' | 'nextpay' | 'wallet' | 'manual'
  direction TEXT NOT NULL DEFAULT 'in',-- 'in' | 'out'
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'تومان',
  status TEXT NOT NULL DEFAULT 'pending', -- pending|submitted|approved|rejected|refunded
  -- card-to-card proof
  receipt_photo TEXT NOT NULL DEFAULT '',   -- R2 key
  payer_card TEXT NOT NULL DEFAULT '',
  payer_name TEXT NOT NULL DEFAULT '',
  tracking_code TEXT NOT NULL DEFAULT '',
  paid_at INTEGER,
  -- gateway bookkeeping
  authority TEXT NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '',
  raw_response TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at INTEGER,
  review_note TEXT NOT NULL DEFAULT '',
  refunded_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_review ON payments(status, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- --------------------------------------------------------- wallet ledger --
-- Append-only. The balance in `users` is a cache of the sum of this table.
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,              -- +credit, -debit, in Toman
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,                -- 'deposit'|'purchase'|'refund'|'referral'|'adjust'
  ref_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON wallet_ledger(user_id, created_at);

-- --------------------------------------------------------------- coupons --
CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'percent', -- 'percent' | 'fixed' | 'days' | 'traffic'
  value INTEGER NOT NULL,
  min_amount INTEGER NOT NULL DEFAULT 0,
  max_amount INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
  used_count INTEGER NOT NULL DEFAULT 0,
  per_user_limit INTEGER NOT NULL DEFAULT 1,
  starts_at INTEGER,
  expires_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coupon_uses (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coupon_uses_user ON coupon_uses(user_id, coupon_id);

-- ---------------------------------------------------------------- tickets --
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
   -- 'payment'|'config'|'speed'|'access'|'refund'|'report'|'other'
  priority TEXT NOT NULL DEFAULT 'normal', -- 'low'|'normal'|'high'
  status TEXT NOT NULL DEFAULT 'open',     -- 'open'|pending_user|answered|closed
  assigned_to TEXT REFERENCES users(id),
  ai_suggested TEXT NOT NULL DEFAULT '',
  ai_confidence REAL NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, last_message_at);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, created_at);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,           -- 'user' | 'staff' | 'ai' | 'system'
  author_id TEXT REFERENCES users(id),
  body TEXT NOT NULL,
  attachment TEXT NOT NULL DEFAULT '',
  is_ai INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages(ticket_id, created_at);

-- --------------------------------------------------------------- tickets --
-- Telegram OTP login for the web/mini-app (no SMS gateway needed).
CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,             -- never store the plaintext code
  purpose TEXT NOT NULL DEFAULT 'login',
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_chat ON otp_codes(chat_id, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  last_seen_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ------------------------------------------------------- node diagnostics --
CREATE TABLE IF NOT EXISTS node_health (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ok INTEGER NOT NULL,
  latency_ms INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_health ON node_health(node_id, checked_at);

-- Usage snapshots, so the AI can see a trend and not just a point.
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id TEXT PRIMARY KEY,
  sub_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  traffic_used_bytes INTEGER NOT NULL,
  taken_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots ON usage_snapshots(sub_id, taken_at);

-- ---------------------------------------------------------- abuse / fraud --
CREATE TABLE IF NOT EXISTS receipts_review (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  ai_verdict TEXT NOT NULL DEFAULT '',   -- 'approve'|'reject'|'escalate'
  ai_confidence REAL NOT NULL DEFAULT 0,
  ai_reason TEXT NOT NULL DEFAULT '',
  duplicates_found INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS abuse_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- 'shared_config'|'receipt_reuse'|'spam'|'probe'
  detail TEXT NOT NULL DEFAULT '',
  severity INTEGER NOT NULL DEFAULT 1,
  acted_on INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_abuse_user ON abuse_events(user_id, created_at);

-- ------------------------------------------------------------- referrals --
CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referral_rewards(referrer_id);

-- -------------------------------------------------------------- messaging --
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all', -- 'all'|'active'|'expired'|'low_balance'
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft'|scheduled|sending|done|canceled
  scheduled_at INTEGER,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- 'expiry'|'traffic'|'balance'|'system'|'campaign'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

-- ---------------------------------------------------------------- webhook --
CREATE TABLE IF NOT EXISTS webhook_updates (
  update_id INTEGER PRIMARY KEY,     -- Telegram's own idempotency key
  handled_at INTEGER NOT NULL
);

-- ------------------------------------------------------------------ audit --
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,              -- 'payment.approve'|'user.block'|'node.delete'...
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',   -- JSON
  ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at);

-- --------------------------------------------------------------- outbox ---
-- Outbound Telegram sends are queued here so a cron can retry them. A Worker
-- must never block a webhook on a slow sendMessage.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'sendMessage',
  payload TEXT NOT NULL,            -- JSON
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed
  sent_at INTEGER,
  not_before INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, not_before);
