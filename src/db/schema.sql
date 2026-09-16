-- Minecraft God Server — D1 schema
-- SQLite dialect. Apply with: npm run db:apply:remote
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- accounts
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone_e164    TEXT NOT NULL UNIQUE,
  phone_hash    TEXT NOT NULL UNIQUE,           -- HMAC(phone) so we never store raw numbers in logs
  username      TEXT,
  email         TEXT,
  rank_id       TEXT NOT NULL DEFAULT 'free',
  xp            INTEGER NOT NULL DEFAULT 0,
  coins         INTEGER NOT NULL DEFAULT 0,
  gems          INTEGER NOT NULL DEFAULT 0,
  elo           INTEGER NOT NULL DEFAULT 1000,
  status        TEXT NOT NULL DEFAULT 'active', -- active | suspended | banned
  locale        TEXT NOT NULL DEFAULT 'fa-IR',
  first_ip_hash TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  last_seen_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_rank   ON users(rank_id);
CREATE INDEX IF NOT EXISTS idx_users_elo    ON users(elo DESC);
CREATE INDEX IF NOT EXISTS idx_users_xp     ON users(xp DESC);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ------------------------------------------------------------------- ranks
CREATE TABLE IF NOT EXISTS ranks (
  id            TEXT PRIMARY KEY,               -- free|noob|normal|pro|god|ultragod
  label_fa      TEXT NOT NULL,
  label_en      TEXT NOT NULL,
  tier          INTEGER NOT NULL UNIQUE,        -- 0..5 ordering
  tag           TEXT NOT NULL,                  -- coloured chat tag
  colour_hex    TEXT NOT NULL,
  price_usd     INTEGER,                        -- NULL = not purchasable
  xp_threshold  INTEGER NOT NULL,               -- auto-promotion threshold
  max_paths     INTEGER NOT NULL,
  permissions   TEXT NOT NULL DEFAULT '[]',     -- JSON array
  perks         TEXT NOT NULL DEFAULT '[]'      -- JSON array
);

-- ----------------------------------------------------------------- admins
CREATE TABLE IF NOT EXISTS admins (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,                 -- PBKDF2-SHA256
  password_salt  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'admin', -- owner|admin|moderator|support
  permissions    TEXT NOT NULL DEFAULT '[]',
  totp_secret    TEXT,
  disabled       INTEGER NOT NULL DEFAULT 0,
  last_login_at  INTEGER,
  last_login_ip  TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admins_role ON admins(role);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id          TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip_hash     TEXT,
  user_agent  TEXT,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id, revoked_at);

-- ------------------------------------------------------------- game servers
CREATE TABLE IF NOT EXISTS servers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  host            TEXT NOT NULL,
  java_port       INTEGER NOT NULL DEFAULT 25565,
  bedrock_port    INTEGER,                      -- NULL => bedrock not exposed
  bedrock_enabled INTEGER NOT NULL DEFAULT 0,   -- see docs/FEASIBILITY.md
  edition         TEXT NOT NULL DEFAULT 'java', -- java|bedrock|both
  runtime         TEXT NOT NULL DEFAULT 'paper',-- paper|purpur|pocketmine|nukkit
  max_players     INTEGER NOT NULL DEFAULT 20,
  view_distance   INTEGER NOT NULL DEFAULT 6,
  sim_distance    INTEGER NOT NULL DEFAULT 4,
  status          TEXT NOT NULL DEFAULT 'offline', -- online|starting|stopping|offline|error|recovering
  online_players  INTEGER NOT NULL DEFAULT 0,
  tps             REAL,
  mem_used_mb     INTEGER,
  mem_max_mb      INTEGER,
  cpu_percent     REAL,
  last_heartbeat  INTEGER,
  lock_owner      TEXT,                         -- container/instance holding the DO lock
  version         TEXT,
  motd            TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);

CREATE TABLE IF NOT EXISTS server_settings (
  server_id  TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  settings   TEXT NOT NULL,                     -- JSON blob (paper/pocketmine config overrides)
  preset     TEXT NOT NULL DEFAULT 'CLOUDFLARE_LOW_RESOURCE',
  updated_at INTEGER NOT NULL
);

-- ------------------------------------------------------------------ players
CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  server_id     TEXT REFERENCES servers(id) ON DELETE CASCADE,
  mc_uuid       TEXT NOT NULL,                  -- Java UUID or Bedrock XUID
  mc_name       TEXT NOT NULL,
  edition       TEXT NOT NULL DEFAULT 'java',
  online        INTEGER NOT NULL DEFAULT 0,
  play_seconds  INTEGER NOT NULL DEFAULT 0,
  elo           INTEGER NOT NULL DEFAULT 1000,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  kills         INTEGER NOT NULL DEFAULT 0,
  deaths        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  UNIQUE(server_id, mc_uuid)
);
CREATE INDEX IF NOT EXISTS idx_players_server  ON players(server_id, online);
CREATE INDEX IF NOT EXISTS idx_players_user    ON players(user_id);
CREATE INDEX IF NOT EXISTS idx_players_mc_name ON players(mc_name);

-- ------------------------------------------------------------ shop & orders
CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,                   -- rank|cosmetic|bundle|config|booster
  sku          TEXT NOT NULL UNIQUE,
  title_fa     TEXT NOT NULL,
  title_en     TEXT NOT NULL,
  description  TEXT,
  price_usd    INTEGER NOT NULL,                -- cents
  base_usd     INTEGER NOT NULL,                -- pre-discount cents, for discount display
  image_key    TEXT,                            -- R2 key
  meta         TEXT NOT NULL DEFAULT '{}',      -- JSON: rank_id, cosmetic slot, etc.
  active       INTEGER NOT NULL DEFAULT 1,
  visible_before_auth INTEGER NOT NULL DEFAULT 0, -- gated by OTP by default
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_kind   ON products(kind, active);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  product_id    TEXT REFERENCES products(id) ON DELETE SET NULL,
  amount_usd    INTEGER NOT NULL,               -- cents actually charged
  discount_pct  INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD',
  method        TEXT NOT NULL,                  -- zarinpal|card2card|free
  gateway_ref   TEXT,                           -- zarinpal authority/ref_id
  status        TEXT NOT NULL DEFAULT 'pending',-- pending|awaiting_receipt|reviewing|paid|rejected|refunded|expired
  review_verdict TEXT,                          -- JSON from receipt review
  ip_hash       TEXT,
  created_at    INTEGER NOT NULL,
  paid_at       INTEGER,
  expires_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);

CREATE TABLE IF NOT EXISTS payment_receipts (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,                   -- uploaded image in R2
  sha256       TEXT NOT NULL,                   -- perceptual/content hash for duplicate detection
  bytes        INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|manual
  ai_verdict   TEXT,                            -- JSON: readable, tampered, amount, date, tracking
  ai_score     REAL,
  reason       TEXT,
  reviewed_by  TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_order ON payment_receipts(order_id, status);
CREATE INDEX IF NOT EXISTS idx_receipts_hash  ON payment_receipts(sha256);

CREATE TABLE IF NOT EXISTS entitlements (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  TEXT REFERENCES products(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,                    -- rank|cosmetic|bundle
  ref         TEXT NOT NULL,                    -- rank_id or cosmetic key
  granted_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  order_id    TEXT REFERENCES orders(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_entitlements_user ON entitlements(user_id, kind);

-- -------------------------------------------------------------- anti-cheat
CREATE TABLE IF NOT EXISTS cheat_signals (
  id          TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  server_id   TEXT REFERENCES servers(id) ON DELETE CASCADE,
  match_id    TEXT,
  check_id    TEXT NOT NULL,                    -- killaura|fly|speed|noclip|reach|autoclick|xray|fastbreak|collusion|jetpack|timer
  weight      REAL NOT NULL,
  metrics     TEXT NOT NULL,                    -- JSON numeric evidence, never just "was cheating"
  network_adj REAL NOT NULL DEFAULT 0,          -- negative when lag/ping explains it
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_player ON cheat_signals(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signals_check  ON cheat_signals(check_id, created_at);

CREATE TABLE IF NOT EXISTS cheat_cases (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  confidence    REAL NOT NULL,
  tier          INTEGER NOT NULL,               -- 1 log | 2 hidden admin alert | 3 match kick | 4 temp ban
  action_taken  TEXT NOT NULL,
  signal_ids    TEXT NOT NULL DEFAULT '[]',     -- JSON
  evidence_keys TEXT NOT NULL DEFAULT '[]',     -- JSON of R2 evidence bundles
  summary       TEXT,
  permanent     INTEGER NOT NULL DEFAULT 0,     -- never auto-set to 1
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cases_player ON cheat_cases(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cases_tier   ON cheat_cases(tier, created_at);

CREATE TABLE IF NOT EXISTS bans (
  id          TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  case_id     TEXT REFERENCES cheat_cases(id) ON DELETE SET NULL,
  scope       TEXT NOT NULL DEFAULT 'match',    -- match|server|global
  reason      TEXT NOT NULL,
  temp        INTEGER NOT NULL DEFAULT 1,       -- automatic bans are ALWAYS temporary
  expires_at  INTEGER,
  issued_by   TEXT,                             -- 'system' or admin id
  revoked_at  INTEGER,
  revoked_by  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bans_player ON bans(player_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS appeals (
  id          TEXT PRIMARY KEY,
  ban_id      TEXT NOT NULL REFERENCES bans(id) ON DELETE CASCADE,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL DEFAULT 'web',      -- web|telegram|discord
  message     TEXT NOT NULL,
  contact     TEXT,
  status      TEXT NOT NULL DEFAULT 'open',     -- open|approved|denied
  admin_note  TEXT,
  handled_by  TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  handled_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status, created_at);

-- ------------------------------------------------------------------- bots
CREATE TABLE IF NOT EXISTS bot_profiles (
  id           TEXT PRIMARY KEY,
  match_id     TEXT NOT NULL,
  model_tier   TEXT NOT NULL,                   -- nano|micro|small|pro
  model_name   TEXT,
  skill        REAL NOT NULL,                   -- 0..1
  reaction_ms  INTEGER NOT NULL,
  error_rate   REAL NOT NULL,                   -- deliberate imperfection
  elo_assumed  INTEGER NOT NULL,
  promoted_at  INTEGER,                         -- when tier escalated mid-match
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bots_match ON bot_profiles(match_id);

CREATE TABLE IF NOT EXISTS matches (
  id          TEXT PRIMARY KEY,
  server_id   TEXT REFERENCES servers(id) ON DELETE CASCADE,
  mode_id     TEXT NOT NULL,
  phase       TEXT NOT NULL DEFAULT 'lobby',    -- lobby|queue|playing|results|closed
  slots       INTEGER NOT NULL,
  humans      INTEGER NOT NULL DEFAULT 0,
  bots        INTEGER NOT NULL DEFAULT 0,
  avg_elo     INTEGER NOT NULL DEFAULT 1000,
  max_elo     INTEGER NOT NULL DEFAULT 1000,
  winner      TEXT,
  started_at  INTEGER,
  ended_at    INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_mode  ON matches(mode_id, phase);
CREATE INDEX IF NOT EXISTS idx_matches_phase ON matches(phase, created_at);

CREATE TABLE IF NOT EXISTS match_participants (
  match_id  TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  slot      INTEGER NOT NULL,
  team      TEXT,
  kind      TEXT NOT NULL,                      -- human|bot
  ref_id    TEXT NOT NULL,                      -- player_id or bot_profile id
  score     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, slot)
);

-- --------------------------------------------------------------- economy
CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta_coins INTEGER NOT NULL DEFAULT 0,
  delta_gems  INTEGER NOT NULL DEFAULT 0,
  reason      TEXT NOT NULL,
  ref         TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  started_at  INTEGER NOT NULL,
  renews_at   INTEGER,
  cancelled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id, status);

-- -------------------------------------------------------------- referrals
CREATE TABLE IF NOT EXISTS referrals (
  id            TEXT PRIMARY KEY,
  referrer_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referee_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  code          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',-- pending|credited|fraud
  reward_coins  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  credited_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id, status);
CREATE INDEX IF NOT EXISTS idx_referrals_code     ON referrals(code);

-- ------------------------------------------------------------ otp / fraud
CREATE TABLE IF NOT EXISTS otp_attempts (
  id          TEXT PRIMARY KEY,
  phone_hash  TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,
  stage       TEXT NOT NULL,                    -- request|verify
  ok          INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_attempts(phone_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_otp_ip    ON otp_attempts(ip_hash, created_at);

CREATE TABLE IF NOT EXISTS fraud_alerts (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                    -- duplicate_phone|ip_cluster|receipt_duplicate|chargeback|bot_like
  severity    TEXT NOT NULL DEFAULT 'info',     -- info|warn|critical
  subject     TEXT,
  detail      TEXT NOT NULL,
  notified    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fraud_kind ON fraud_alerts(kind, created_at);

-- ------------------------------------------------------------- monitoring
CREATE TABLE IF NOT EXISTS health_checks (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  process_ok  INTEGER,
  port_ok     INTEGER,
  ping_ms     INTEGER,
  players     INTEGER,
  mem_mb      INTEGER,
  cpu_pct     REAL,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_server ON health_checks(server_id, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,                     -- admin id | 'system' | user id
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip_hash    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_time   ON audit_logs(created_at DESC);

-- --------------------------------------------------------------- pricing
CREATE TABLE IF NOT EXISTS price_events (
  id           TEXT PRIMARY KEY,
  -- No ON DELETE CASCADE: analytics history is the evidence behind pricing
  -- decisions and must outlive a product being removed from the catalogue.
  product_id   TEXT REFERENCES products(id) ON DELETE SET NULL,
  hour_of_day  INTEGER NOT NULL,
  day_of_week  INTEGER NOT NULL,
  conversions  INTEGER NOT NULL DEFAULT 0,
  impressions  INTEGER NOT NULL DEFAULT 0,
  revenue_usd  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_price_events ON price_events(product_id, hour_of_day, day_of_week);

CREATE TABLE IF NOT EXISTS discount_campaigns (
  id           TEXT PRIMARY KEY,
  product_id   TEXT REFERENCES products(id) ON DELETE CASCADE,
  pct          INTEGER NOT NULL,                -- capped at 30 by the engine
  rationale    TEXT NOT NULL,                   -- why the model chose it (auditability)
  model_used   TEXT,
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_active ON discount_campaigns(product_id, ends_at);

-- ------------------------------------------------------------- cosmetics
CREATE TABLE IF NOT EXISTS cosmetics (
  id         TEXT PRIMARY KEY,
  slot       TEXT NOT NULL,                     -- cape|hat|trail|portal|nickcolour|chattag|pet
  key        TEXT NOT NULL UNIQUE,
  title_fa   TEXT NOT NULL,
  price_usd  INTEGER,                           -- NULL => earned only
  xp_needed  INTEGER NOT NULL DEFAULT 0,
  meta       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_cosmetics_slot ON cosmetics(slot);

CREATE TABLE IF NOT EXISTS user_cosmetics (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id) ON DELETE CASCADE,
  equipped    INTEGER NOT NULL DEFAULT 0,
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, cosmetic_id)
);

-- -------------------------------------------------------------- parties
CREATE TABLE IF NOT EXISTS parties (
  id         TEXT PRIMARY KEY,
  leader_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode_id    TEXT,
  max_size   INTEGER NOT NULL DEFAULT 5,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parties_leader ON parties(leader_id);

CREATE TABLE IF NOT EXISTS party_members (
  party_id  TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (party_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  party_id    TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  from_user   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     TEXT REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_to ON invites(to_user, status);

-- -------------------------------------------------------------- settings
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seasons (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  starts_at  INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL,
  rewards    TEXT NOT NULL DEFAULT '{}'
);

-- ------------------------------------------------------- connectivity (IR)
CREATE TABLE IF NOT EXISTS connection_configs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                     -- vless|vmess|trojan|wireguard
  label      TEXT NOT NULL,
  uri        TEXT,                              -- NULL until an admin supplies a real origin
  origin_id  TEXT,
  unlimited  INTEGER NOT NULL DEFAULT 0,
  verified   INTEGER NOT NULL DEFAULT 0,        -- only 1 after a real connectivity test
  tested_at  INTEGER,
  test_note  TEXT,
  active     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conn_active ON connection_configs(active, verified);
