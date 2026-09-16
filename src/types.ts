/**
 * Minecraft God Server — shared domain types.
 * Everything (API, shop, anti-cheat, bots, panel) speaks these contracts.
 */

// ------------------------------------------------------------------ ranks
export type RankId = 'free' | 'noob' | 'normal' | 'pro' | 'god' | 'ultragod';

export interface RankSpec {
  id: RankId;
  labelFa: string;
  labelEn: string;
  tier: number;
  tag: string;
  colour: string;
  /** USD price in cents. null => earnable only, not purchasable. */
  priceUsd: number | null;
  /** XP needed to auto-promote into this rank. */
  xpThreshold: number;
  /** Hard backend cap on config paths / concurrent perks. */
  maxPaths: number;
  permissions: string[];
  perks: string[];
}

// ---------------------------------------------------------------- servers
export type ServerStatus =
  | 'online'
  | 'starting'
  | 'stopping'
  | 'offline'
  | 'error'
  | 'recovering';

export type Edition = 'java' | 'bedrock' | 'both';
export type Runtime = 'paper' | 'purpur' | 'pocketmine' | 'nukkit';

export interface ServerRecord {
  id: string;
  name: string;
  host: string;
  javaPort: number;
  bedrockPort: number | null;
  bedrockEnabled: boolean;
  edition: Edition;
  runtime: Runtime;
  maxPlayers: number;
  viewDistance: number;
  simDistance: number;
  status: ServerStatus;
  onlinePlayers: number;
  tps: number | null;
  memUsedMb: number | null;
  memMaxMb: number | null;
  cpuPercent: number | null;
  lastHeartbeat: number | null;
  lockOwner: string | null;
  version: string | null;
  motd: string | null;
}

// --------------------------------------------------------------- products
export type ProductKind = 'rank' | 'cosmetic' | 'bundle' | 'config' | 'booster';

export interface Product {
  id: string;
  kind: ProductKind;
  sku: string;
  titleFa: string;
  titleEn: string;
  description: string | null;
  /** Cents actually charged (after discount). */
  priceUsd: number;
  /** Cents before discount, so the UI can show the struck-through price. */
  baseUsd: number;
  imageKey: string | null;
  meta: Record<string, unknown>;
  active: boolean;
  /** Almost always false: products are hidden until OTP verification. */
  visibleBeforeAuth: boolean;
}

export type OrderStatus =
  | 'pending'
  | 'awaiting_receipt'
  | 'reviewing'
  | 'paid'
  | 'rejected'
  | 'refunded'
  | 'expired';

export type PaymentMethod = 'zarinpal' | 'card2card' | 'free';

export interface Order {
  id: string;
  userId: string | null;
  productId: string | null;
  amountUsd: number;
  discountPct: number;
  currency: string;
  method: PaymentMethod;
  gatewayRef: string | null;
  status: OrderStatus;
  createdAt: number;
  paidAt: number | null;
  expiresAt: number | null;
}

// ------------------------------------------------------------- anti-cheat
export type CheatCheckId =
  | 'killaura'
  | 'fly'
  | 'speed'
  | 'noclip'
  | 'reach'
  | 'autoclick'
  | 'xray'
  | 'fastbreak'
  | 'collusion'
  | 'jetpack'
  | 'timer';

export interface CheatSignal {
  id: string;
  playerId: string;
  serverId: string | null;
  matchId: string | null;
  checkId: CheatCheckId;
  weight: number;
  /** Numeric evidence. We never store only "was cheating". */
  metrics: Record<string, number | string | boolean>;
  /** Negative when lag/ping plausibly explains the signal. */
  networkAdjustment: number;
  createdAt: number;
}

/** 1 = log only, 2 = hidden admin alert, 3 = match kick, 4 = temporary ban. */
export type ActionTier = 1 | 2 | 3 | 4;

export interface CheatCase {
  id: string;
  playerId: string;
  confidence: number;
  tier: ActionTier;
  actionTaken: string;
  signalIds: string[];
  evidenceKeys: string[];
  summary: string;
  /** Automatic bans are never permanent. Only an admin may escalate. */
  permanent: boolean;
  createdAt: number;
}

// ------------------------------------------------------------------- bots
export type BotModelTier = 'nano' | 'micro' | 'small' | 'pro';

export interface BotTierSpec {
  tier: BotModelTier;
  /** Concrete Workers AI model id. */
  model: string;
  /** Match average ELO at which this tier starts being used. */
  minAvgElo: number;
  /** Match max ELO at which this tier starts being used. */
  minMaxElo: number;
  /** 0..1 baseline competence. */
  skill: number;
  reactionMs: [number, number];
  errorRate: number;
}

export interface BotProfile {
  id: string;
  matchId: string;
  modelTier: BotModelTier;
  model: string;
  skill: number;
  reactionMs: number;
  errorRate: number;
  eloAssumed: number;
}

// -------------------------------------------------------------- matches
export type MatchPhase = 'lobby' | 'queue' | 'playing' | 'results' | 'closed';

export interface Match {
  id: string;
  serverId: string | null;
  modeId: string;
  phase: MatchPhase;
  slots: number;
  humans: number;
  bots: number;
  avgElo: number;
  maxElo: number;
  winner: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

// ------------------------------------------------------------- game modes
export interface GameModeSpec {
  id: string;
  titleFa: string;
  titleEn: string;
  teamSize: number;
  teamCount: number;
  minPlayers: number;
  maxPlayers: number;
  /** Seconds a typical match lasts; used for queue timeouts. */
  targetDurationS: number;
  /** XP awarded per win / per kill / per objective. */
  rewards: { win: number; loss: number; kill: number; objective: number };
  /** Coins awarded per win. */
  coins: { win: number; kill: number };
  /** Which bot behaviours matter for this mode. */
  botSkills: string[];
  icon: string;
  banner: string;
}

// ------------------------------------------------------------------- otp
export type OtpStage = 'request' | 'verify';

export interface OtpChallenge {
  phoneE164: string;
  codeHash: string;
  attempts: number;
  createdAt: number;
  expiresAt: number;
  channel: 'telegram' | 'sms' | 'dev';
}

// -------------------------------------------------------------- receipts
export interface ReceiptVerdict {
  readable: boolean;
  tampered: boolean;
  amountVisible: boolean;
  dateVisible: boolean;
  trackingVisible: boolean;
  duplicate: boolean;
  /** 0..1 confidence that the receipt is genuine. */
  confidence: number;
  reasons: string[];
  /** true => auto-approve allowed. false => must go to a human. */
  autoApprove: boolean;
}

// ----------------------------------------------------------- monitoring
export interface HealthSnapshot {
  serverId: string;
  status: ServerStatus;
  processOk: boolean | null;
  portOk: boolean | null;
  pingMs: number | null;
  players: number | null;
  memMb: number | null;
  cpuPct: number | null;
  note: string | null;
  createdAt: number;
}

// ------------------------------------------------------------------- env
export interface Env {
  GODDB: D1Database;
  GODKV: KVNamespace;
  GODR2: R2Bucket;
  AI?: Ai;
  ASSETS?: Fetcher;
  SERVER_LOCK: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  ANTICHEAT: DurableObjectNamespace;

  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  OTP_SECRET: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OWNER_CHAT_ID?: string;
  SMS_PROVIDER_KEY?: string;
  ZARINPAL_MERCHANT_ID?: string;
  WORKER_HOST?: string;
}
