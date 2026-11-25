// Token Launch Radar - the implied-value model.
//
// The model reads only the sealed snapshot's own figures. For every protocol
// that records no token yet it derives an implied launch value:
//
//   implied = tvl_usd x category_multiple x momentum x maturity x breadth
//             x eligibility
//
// floored at $10,000, clamped at $100,000,000,000,000, in whole dollars.
// The board then sorts by that value (ties by slug) and nudges values down
// so the ranking is strictly decreasing. Nothing here reads a clock, a
// random source, the network or the filesystem: the same snapshot always
// produces the same board, byte for byte.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface RadarFactors {
  category_multiple: number;
  momentum: number;
  maturity: number;
  breadth: number;
  eligibility: number;
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  established: boolean;
  implied_value_usd: number;
  factors: RadarFactors;
  farm_steps: string[];
}

export interface RadarMeta {
  as_of: string;
  floor_usd: number;
  scanned: number;
  pre_token: number;
  watchlist_count: number;
}

export interface Radar {
  meta: RadarMeta;
  rows: RadarRow[];
}

export const IMPLIED_VALUE_FLOOR = 10000;
export const MAX_IMPLIED_VALUE = 100000000000000;
const ELIGIBILITY_CANDIDATE = 1;
const ELIGIBILITY_ESTABLISHED = 0.04;
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Category multiples: a prior over DefiLlama categories, in FDV/TVL terms -
// what a launch in this sector has historically been worth against the TVL
// already inside it. It is a table over categories only; no protocol name
// or slug appears anywhere in this model.
// ---------------------------------------------------------------------------
const CATEGORY_MULTIPLES: Record<string, number> = {
  Dexs: 2.2, // spot venues: proven swap fees support the richest launch multiples
  Derivatives: 2.0, // perp venues monetise volume far beyond their margin TVL
  "Prediction Market": 1.8, // consumer speculation launches hot relative to TVL
  Chain: 1.6, // a network's token prices the whole blockspace, not just its TVL
  "Interest Rate Derivatives": 1.6, // rate markets sit on top of lending volume
  Lending: 1.5, // money markets launch against deep, sticky borrow demand
  "Options Vault": 1.4, // structured yield vaults earn steady option premium
  Payments: 1.4, // payment flow is worth more than the balances parked in it
  "Risk Curators": 1.3, // curators take fees on other people's vault capital
  "Onchain Capital Allocator": 1.3, // allocators skim yield across many venues
  CDP: 1.3, // stablecoin issuers capture seigniorage on minted supply
  Privacy: 1.3, // scarce category with loyal, compliance-tolerant demand
  RWA: 1.2, // real-world yields are real but grow at an off-chain pace
  "Leveraged Farming": 1.2, // leverage multiplies both fees and fragility
  "CDP Manager": 1.2, // managed CDP books earn like their underlying issuers
  "OTC Marketplace": 1.2, // block trading desks monetise flow, not balances
  "Crypto Card Issuer": 1.2, // card spend generates interchange beyond TVL
  "Collateral Markets": 1.2, // collateral routing earns on every loop it hosts
  "Uncollateralized Lending": 1.2, // credit premiums are high, defaults too
  "Yield Aggregator": 1.1, // aggregators keep a thin slice of routed yield
  "Basis Trading": 1.1, // basis books earn funding, capped by hedge costs
  "Liquidity Manager": 1.1, // managed liquidity earns fees on active ranges
  Insurance: 1.1, // cover premiums accrue slowly against pooled capital
  "Dual-Token Stablecoin": 1.1, // the volatile leg prices the system's growth
  Yield: 1.0, // plain yield: the neutral prior, value tracks TVL one to one
  Farm: 1.0, // incentive farms price close to the capital they attract
  Restaking: 1.0, // restaking points convert at roughly par with TVL
  Indexes: 1.0, // an index token is worth about the basket it tracks
  Bridge: 0.9, // bridges earn thin tolls and carry outsized exploit risk
  "Cross Chain Bridge": 0.9, // same toll economics as any bridge route
  "Liquid Staking": 0.9, // staking tokens trade near the staked asset's value
  "Liquid Restaking": 0.9, // receipt tokens price close to their backing
  "Staking Pool": 0.9, // pooled staking keeps only a small commission
  "Anchor BTC": 0.9, // BTC-anchored products price near their reserves
  "Decentralized BTC": 0.9, // decentralised BTC wrappers track BTC closely
  CeDeFi: 0.8, // centralised yield desks discount for counterparty risk
  "Restaked BTC": 0.8, // restaked BTC receipts sit under several risk layers
  "Governance Incentives": 0.8, // incentive tokens dilute as fast as they print
  "Canonical Bridge": 0.7, // canonical bridges are infrastructure, priced thin
  "Stablecoin Wrapper": 0.7, // wrappers add a layer, not new value
  CEX: 0.6, // exchange products rarely launch a second, separate token fairly
};
const DEFAULT_CATEGORY_MULTIPLE = 1.0;

export function categoryMultipleFor(category: string | null): number {
  if (category === null) return DEFAULT_CATEGORY_MULTIPLE;
  const multiple = CATEGORY_MULTIPLES[category];
  return multiple === undefined ? DEFAULT_CATEGORY_MULTIPLE : multiple;
}

// ---------------------------------------------------------------------------
// Launch-eligibility screen. A protocol that is a wrapped, staked or bridged
// product of a token that already trades is not waiting on a launch of its
// own, and neither is a later version of a product line or an exchange's own
// shelf product. The screen mirrors the watchlist's exclusion rules: six
// categories, three whole words, eight exchange prefixes, one version
// suffix pattern. Screened protocols stay on the board - they are large and
// a reader should see them - but at a 0.04 eligibility factor, and their
// farm plan says plainly that there is no launch to farm.
// ---------------------------------------------------------------------------
const ESTABLISHED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

const ESTABLISHED_WORD_PATTERN = /\b(?:wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX_PATTERN =
  /^(?:Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
const VERSION_SUFFIX_PATTERN = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function establishedReason(protocol: SnapshotProtocol): string | null {
  if (protocol.category !== null && ESTABLISHED_CATEGORIES.has(protocol.category)) {
    if (protocol.category === "CEX") {
      return "an exchange product tied to a platform whose token already trades";
    }
    if (protocol.category === "Bridge" || protocol.category === "Canonical Bridge") {
      return "a bridged-asset product tracking a token that already trades";
    }
    return "a staking product tracking a token that already trades";
  }
  if (ESTABLISHED_WORD_PATTERN.test(protocol.name)) {
    return "a wrapped or staked product tracking a token that already trades";
  }
  if (EXCHANGE_PREFIX_PATTERN.test(protocol.name)) {
    return "an exchange-branded product tracking a token that already trades";
  }
  if (VERSION_SUFFIX_PATTERN.test(protocol.name)) {
    return "a later version of a product line whose token already trades";
  }
  return null;
}

export function isEstablishedProduct(protocol: SnapshotProtocol): boolean {
  return establishedReason(protocol) !== null;
}

export function isPreToken(protocol: SnapshotProtocol): boolean {
  return protocol.gecko_id === null && protocol.symbol === null;
}

// ---------------------------------------------------------------------------
// Snapshot parsing. Deliberately light: the snapshot is a sealed house file
// with a fixed shape; we check the load-bearing arrays exist and hand the
// rest to the model untouched.
// ---------------------------------------------------------------------------
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Partial<Snapshot>;
  if (typeof raw.as_of !== "string" || raw.as_of.length === 0) {
    throw new Error("snapshot is missing its as_of date");
  }
  if (!Array.isArray(raw.protocols) || raw.protocols.length === 0) {
    throw new Error("snapshot carries no protocols array");
  }
  if (!Array.isArray(raw.watchlist)) {
    throw new Error("snapshot carries no watchlist array");
  }
  return {
    as_of: raw.as_of,
    source: typeof raw.source === "string" ? raw.source : "",
    floor_usd: typeof raw.floor_usd === "number" ? raw.floor_usd : 0,
    protocols: raw.protocols as SnapshotProtocol[],
    watchlist: raw.watchlist as string[],
  };
}

// ---------------------------------------------------------------------------
// Factors. Each is a pure function of snapshot fields.
// ---------------------------------------------------------------------------
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function computeAgeDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const asOfMs = Date.parse(asOf + "T00:00:00Z");
  const listedMs = Date.parse(listedAt + "T00:00:00Z");
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.max(0, Math.floor((asOfMs - listedMs) / DAY_MS));
}

export function momentumFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  return 1 + (clamp(change7d, -40, 120) / 100) * 0.6;
}

export function maturityFactor(ageDays: number | null): number {
  if (ageDays === null) return 1;
  return 0.8 + (0.45 * Math.min(ageDays, 1460)) / 1460;
}

export function breadthFactor(chainCount: number): number {
  return 1 + 0.04 * Math.min(Math.max(chainCount, 1) - 1, 5);
}

// ---------------------------------------------------------------------------
// Chain profile: where a farm plan should run, and what gas there costs.
// The protocol's own chain list is scanned in its listed order and the first
// cheap home wins - Solana whenever it is listed ahead of every low-fee EVM
// chain, otherwise the first low-fee EVM chain listed. Ethereum mainnet is
// only chosen when no cheap alternative is listed at all, and a Bitcoin-only
// product keeps a Bitcoin budget.
// ---------------------------------------------------------------------------
type ChainClass = "sol" | "eth" | "btc" | "lowfee";

interface ChainProfile {
  chain: string;
  gas: string;
  klass: ChainClass;
}

const LOW_FEE_EVM_CHAINS = new Set([
  "Arbitrum",
  "Arbitrum Nova",
  "Avalanche",
  "Base",
  "Berachain",
  "Binance",
  "Bitlayer",
  "Bittensor EVM",
  "Blast",
  "BOB",
  "Celo",
  "Citrea",
  "CORE",
  "Corn",
  "Cronos",
  "Etherlink",
  "Fantom",
  "Flare",
  "Fraxtal",
  "HashKey Chain",
  "Hemi",
  "Hyperliquid L1",
  "Ink",
  "Katana",
  "Kava",
  "Linea",
  "Lisk",
  "Manta",
  "Mantle",
  "MegaETH",
  "Metis",
  "Mode",
  "Monad",
  "Moonbeam",
  "Moonriver",
  "Morph",
  "Op_Bnb",
  "Optimism",
  "Plasma",
  "Polygon",
  "Polygon zkEVM",
  "RISE",
  "Scroll",
  "Sei",
  "Soneium",
  "Sonic",
  "Sophon",
  "Stable",
  "Swellchain",
  "TAC",
  "Taiko",
  "Unichain",
  "World Chain",
  "X Layer",
  "XRPL EVM",
  "zkSync Era",
  "Zircuit",
]);

export function chainProfileFor(chains: string[]): ChainProfile {
  for (const chain of chains) {
    if (chain === "Solana") {
      return { chain, gas: "about $1/month", klass: "sol" };
    }
    if (LOW_FEE_EVM_CHAINS.has(chain)) {
      return { chain, gas: "$1-$5/month", klass: "lowfee" };
    }
  }
  if (chains.includes("Ethereum")) {
    return { chain: "Ethereum", gas: "$15-$40/month", klass: "eth" };
  }
  if (chains.includes("Bitcoin")) {
    return { chain: "Bitcoin", gas: "$5-$15/month", klass: "btc" };
  }
  const first = chains.length > 0 ? chains[0] : "Ethereum";
  return { chain: first, gas: "$1-$5/month", klass: "lowfee" };
}

// ---------------------------------------------------------------------------
// TVL tiers: position sizes a small farmer can actually run.
// ---------------------------------------------------------------------------
interface TvlTier {
  size: string;
  label: string;
  note: string;
}

function tvlTierFor(tvlUsd: number): TvlTier {
  if (tvlUsd >= 500000000) {
    return {
      size: "$250-$1,000",
      label: "large-TVL $500M+ tier",
      note: "sized to clear typical minimum-balance filters on deep pools",
    };
  }
  if (tvlUsd >= 50000000) {
    return {
      size: "$100-$500",
      label: "mid-TVL $50M-$500M tier",
      note: "balanced for a meaningful share without over-concentrating capital",
    };
  }
  return {
    size: "$25-$150",
    label: "early sub-$50M tier",
    note: "kept small while the protocol is still proving itself",
  };
}

// ---------------------------------------------------------------------------
// Small deterministic helpers. Variety in the farm plans comes from a hash
// of the protocol's own slug - stable across runs, different per protocol,
// so two protocols in the same bucket no longer read word for word alike.
// ---------------------------------------------------------------------------
function slugSeed(slug: string): number {
  let hash = 7;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pickVariant(variants: string[], seed: number, salt: number): string {
  return variants[(seed + salt) % variants.length];
}

function formatPct(change7d: number): string {
  const rounded = Math.round(change7d * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return (rounded >= 0 ? "+" : "") + text + "%";
}

function formatAge(ageDays: number): string {
  if (ageDays < 60) return ageDays + " days";
  if (ageDays < 730) return Math.round(ageDays / 30.44) + " months";
  const years = Math.round((ageDays / 365.25) * 10) / 10;
  return (Number.isInteger(years) ? String(years) : years.toFixed(1)) + " years";
}

type AgeBucket = "fresh" | "mid" | "seasoned" | "unknown";
type MomentumBucket = "rising" | "steady" | "cooling" | "unknown";

function ageBucketFor(ageDays: number | null): AgeBucket {
  if (ageDays === null) return "unknown";
  if (ageDays < 180) return "fresh";
  if (ageDays < 730) return "mid";
  return "seasoned";
}

function momentumBucketFor(change7d: number | null): MomentumBucket {
  if (change7d === null) return "unknown";
  if (change7d >= 5) return "rising";
  if (change7d <= -5) return "cooling";
  return "steady";
}

// ---------------------------------------------------------------------------
// Farm plans: exactly six steps per protocol, generated from its own
// category, chains, TVL tier, age and momentum. Every step states an action,
// a cost or a time. Established products get a different plan whose first
// step says there is no launch to farm.
// ---------------------------------------------------------------------------
interface FarmContext {
  tier: TvlTier;
  profile: ChainProfile;
  ageDays: number | null;
  ageBucket: AgeBucket;
  momentumBucket: MomentumBucket;
  seed: number;
}

function setupStep(protocol: SnapshotProtocol, ctx: FarmContext): string {
  const { tier, profile } = ctx;
  let preferNote = "";
  if (profile.chain !== protocol.chains[0]) {
    if (protocol.chains.includes("Ethereum") && profile.chain !== "Ethereum") {
      preferNote =
        " (preferring " + profile.chain + " over Ethereum mainnet cuts gas from $15-$40/month to " + profile.gas + ")";
    } else if (protocol.chains.length > 1) {
      preferNote = " (the cheapest of its " + protocol.chains.length + " networks to operate on)";
    }
  }
  return (
    "Set up a dedicated wallet on " + profile.chain + " with " + tier.size +
    " (" + tier.label + "; " + tier.note + ") and allocate " + profile.gas +
    " for gas" + preferNote + "; takes about 10 minutes."
  );
}

function coreStep(protocol: SnapshotProtocol, ctx: FarmContext): string {
  const name = protocol.name;
  const size = ctx.tier.size;
  const chain = ctx.profile.chain;
  switch (protocol.category) {
    case "Dexs":
      return "Route two or three swaps a week through " + name + "'s deepest markets on " + chain + " and park the working balance in its most liquid pool pair, so both trade count and LP share register (15-20 minutes/week).";
    case "Lending":
      return "Supply " + size + " of collateral on " + name + " through " + chain + ", borrow no more than a third of its value against it, and run a careful repay-and-resupply cycle each week so the position never nears liquidation (15 minutes/week).";
    case "Derivatives":
    case "Interest Rate Derivatives":
      return "Open small, hedged positions on " + name + " - a long and an offsetting short across two markets - and roll them weekly, keeping total notional inside " + size + " so funding costs stay trivial (20 minutes/week).";
    case "Yield":
    case "Yield Aggregator":
      return "Deposit " + size + " into " + name + "'s main vault on " + chain + " and leave the shares compounding; add a small top-up each week rather than hopping between vaults (10 minutes/week).";
    case "Bridge":
    case "Cross Chain Bridge":
      return "Bridge a " + size + " position across two of " + name + "'s busiest routes each week, alternating direction, and let the landed funds work on the destination chain for a few days before bridging again (15 minutes/week).";
    case "RWA":
      return "Open an account with " + name + " and complete its KYC and eligibility checks up front (they can take days), then deposit " + size + " into its flagship real-world-asset vault on " + chain + " (30 minutes once, then 5 minutes/week).";
    case "CDP":
    case "CDP Manager":
      return "Mint a small stablecoin position on " + name + " by locking collateral worth roughly twice the " + size + " you draw, and keep the liquidation buffer untouched (15 minutes to open, 5 minutes/week to check).";
    case "Risk Curators":
    case "Onchain Capital Allocator":
    case "Liquidity Manager":
      return "Deposit " + size + " into one of " + name + "'s flagship curated vaults on " + chain + " after checking the underlying markets, collateral caps and curator performance fees (10-15 minutes).";
    case "Staking Pool":
    case "Restaking":
      return "Stake " + size + " through " + name + " on " + chain + " and hold the receipt token in a wallet you control; if a low-risk pool accepts the receipt, put a slice of it to work there (10 minutes).";
    case "Leveraged Farming":
    case "Farm":
      return "Open a conservative leveraged loop on " + name + " - supply, borrow the same asset, resupply once - sized inside " + size + " with leverage low enough that one bad week cannot liquidate it (20 minutes to set up).";
    case "Basis Trading":
      return "Fund a delta-neutral basis position through " + name + " with " + size + ": hold the spot leg and the offsetting hedge it specifies, and check the funding spread weekly (15 minutes/week).";
    case "Prediction Market":
      return "Take two or three small positions a week in " + name + "'s most liquid markets, sized from the " + size + " budget, and let each one resolve rather than trading in and out (15 minutes/week).";
    case "Payments":
      return "Route a real recurring payment through " + name + " each week - an invoice, a subscription or a transfer you would make anyway - building genuine volume history inside the " + size + " working balance (5 minutes/week).";
    case "Crypto Card Issuer":
      return "Fund " + name + "'s card with " + size + " and route everyday spending you already make through it, keeping the balance topped up weekly (5 minutes/week).";
    case "Insurance":
      return "Buy a small cover on " + name + " for a position you actually hold, or underwrite " + size + " into its lowest-risk cover pool, and renew on schedule (10 minutes).";
    case "Indexes":
      return "Buy " + size + " of " + name + "'s flagship index basket on " + chain + " and hold it; rebalance only when the index itself does (10 minutes).";
    case "Privacy":
      return "Make one small, ordinary transaction through " + name + " each week from your dedicated wallet, sized inside " + size + ", and keep clean records of every deposit and withdrawal (10 minutes/week).";
    case "Chain":
      return "Bridge " + size + " onto the " + name + " network itself, then transact there weekly - a swap, a transfer and one app interaction - so the wallet builds a real history on the chain (15 minutes/week).";
    case "CEX":
      return "Skip the heavy farming here: an exchange product rarely shares a fair launch with outside farmers, so limit activity to a small " + size + " trading balance used for ordinary spot trades (10 minutes/week).";
    default:
      return "Use " + name + "'s core product on " + chain + " every week with the " + size + " working balance - one genuine transaction a week beats ten empty ones (10-15 minutes/week).";
  }
}

function rhythmStep(protocol: SnapshotProtocol, ctx: FarmContext): string {
  const options: string[] = [
    "Keep the same wallet and position all season: one maintenance action a week - a top-up, a harvest or a rebalance - inside your " + ctx.profile.gas + " gas budget registers steadier activity than sporadic large moves (10 minutes/week).",
    "Work the position on a weekly rhythm: check its health, claim anything accrued, and add a small top-up from the " + ctx.tier.size + " budget rather than resizing the whole position (10 minutes/week).",
    "Avoid hopping between protocols mid-season; deepen this one position with a small weekly action so your balance history compounds in a single place (10 minutes/week).",
  ];
  if (ctx.momentumBucket === "rising" && protocol.change_7d !== null) {
    options.push(
      "Seven-day TVL is up strongly (" + formatPct(protocol.change_7d) + "): keep the weekly action on schedule and resist doubling size just because momentum is hot (10 minutes/week).",
    );
  }
  if (ctx.momentumBucket === "cooling" && protocol.change_7d !== null) {
    options.push(
      "Seven-day TVL has slipped (" + formatPct(protocol.change_7d) + "): hold size steady, skip fresh deposits, and let the scheduled weekly action carry your activity until momentum turns (10 minutes/week).",
    );
  }
  if (ctx.momentumBucket === "steady" && protocol.change_7d !== null) {
    options.push(
      "Seven-day TVL is nearly flat (" + formatPct(protocol.change_7d) + "), so consistency is the edge: the same small action, same wallet, every week of the season (10 minutes/week).",
    );
  }
  if (ctx.ageBucket === "fresh" && ctx.ageDays !== null) {
    options.push(
      "Listed only " + ctx.ageDays + " days ago, this one rewards frequency over size: several small interactions a week read better than one large deposit (10 minutes/week).",
    );
  }
  if (ctx.ageBucket === "seasoned" && ctx.ageDays !== null) {
    options.push(
      "Running " + formatAge(ctx.ageDays) + " with no token yet, it rewards patience: an old wallet with an unbroken weekly history is exactly what a late launch snapshot tends to favour (10 minutes/week).",
    );
  }
  return pickVariant(options, ctx.seed, 3);
}

function reviewStep(protocol: SnapshotProtocol, ctx: FarmContext): string {
  const options: string[] = [
    "Review the position once a week (10 minutes/week): rate or APY earned, withdrawal terms and any change to fees or collateral, while keeping maintenance transactions inside your " + ctx.profile.gas + " gas budget.",
    "Once a week, sanity-check the numbers that matter - share price, pending rewards, queue times - and log them next to your gas spend (10 minutes/week).",
  ];
  if (protocol.chains.length >= 4) {
    options.push(
      "It runs on " + protocol.chains.length + " chains; once a week confirm your " + ctx.profile.chain + " deployment is still the cheapest home for the position and that no chain-specific incentive has opened elsewhere (10 minutes/week).",
    );
  }
  if (protocol.chains.length === 1) {
    options.push(
      "Everything sits on " + ctx.profile.chain + ", so the weekly review is short: position size, earned yield, and any governance or parameter change (5-10 minutes/week).",
    );
  }
  if (ctx.ageBucket === "mid" && ctx.ageDays !== null) {
    options.push(
      "At " + formatAge(ctx.ageDays) + " old it is past the fragile stage; the weekly review can stay light - position, yield, and one look at its announcements (5-10 minutes/week).",
    );
  }
  return pickVariant(options, ctx.seed, 5);
}

function holdStep(protocol: SnapshotProtocol, ctx: FarmContext): string {
  const options: string[] = [
    "Hold across 8-12 weeks so time-weighted balance snapshots accumulate under any points or season programme it runs; unwinding early forfeits the history you have been building.",
    "Stay the full 8-12 week season unless the risk picture changes: most launch programmes weight duration and consistency, not a single week's size.",
  ];
  options.push(
    "Commit to the 8-12 week horizon before you start: a position opened and abandoned in week two earns nothing but gas receipts.",
  );
  return pickVariant(options, ctx.seed, 7);
}

function recordStep(ctx: FarmContext): string {
  const options: string[] = [
    "Keep a weekly log of share price, net yield and gas costs (5 minutes/week) so you can measure the true net return before deciding whether to unwind after 8-12 weeks.",
    "At week 8, review the log: if net yield after gas beats your next candidate, extend to 12 weeks; if not, unwind cleanly and rotate the capital (15 minutes).",
    "Record every fee and reward as you go (5 minutes/week); a farmer who cannot show net numbers after gas is guessing, not farming.",
  ];
  return pickVariant(options, ctx.seed, 11);
}

function establishedSteps(
  protocol: SnapshotProtocol,
  reason: string,
  ctx: FarmContext,
): string[] {
  const name = protocol.name;
  const tier = ctx.tier;
  const profile = ctx.profile;
  const batchNote =
    profile.klass === "btc"
      ? " (batch Bitcoin transactions during lower mempool fee windows)"
      : "";
  const moveStep = pickVariant(
    [
      "If you hold or move exposure on " + profile.chain + ", keep transaction overhead inside a " + profile.gas + " gas budget" + batchNote + " and avoid unnecessary deposits, withdrawals or bridge round-trips.",
      "Keep any movement of the position on " + profile.chain + " rare and deliberate: batch transfers together" + batchNote + " so total overhead stays inside a " + profile.gas + " gas budget.",
    ],
    ctx.seed,
    3,
  );
  const riskReview = pickVariant(
    [
      "Review peg stability, custody or validator risk and withdrawal queues once a week (5 minutes/week over the 8-12 week holding period) rather than assuming passive holding earns an unannounced token.",
      "Once a week, spend 5 minutes on the risks that actually apply here - peg, custodian, validator set and exit queues - instead of farming activity that earns nothing.",
    ],
    ctx.seed,
    5,
  );
  return [
    "No launch to farm: " + name + " is " + reason + ", so do not commit airdrop-hunting capital here; treat it purely as an exposure tool and keep monitoring to 5 minutes/week.",
    "Only use " + name + " if you already want the underlying exposure; size any voluntary allocation conservatively at " + tier.size + " (" + tier.label + ") rather than chasing speculative points.",
    moveStep,
    "Before minting, staking or bridging through " + name + ", compare the secondary-market spread against native mint or redemption fees (10 minutes) so slippage does not outweigh the underlying yield.",
    riskReview,
    "Keep a lean log of entry cost, fees and yield (5 minutes/month), and direct active farming hours toward unlaunched candidates carrying the full 1.00x launch-eligibility factor.",
  ];
}

export function buildFarmSteps(
  protocol: SnapshotProtocol,
  established: boolean,
  reason: string | null,
  ageDays: number | null,
): string[] {
  const ctx: FarmContext = {
    tier: tvlTierFor(protocol.tvl_usd),
    profile: chainProfileFor(protocol.chains),
    ageDays,
    ageBucket: ageBucketFor(ageDays),
    momentumBucket: momentumBucketFor(protocol.change_7d),
    seed: slugSeed(protocol.slug),
  };
  if (established && reason !== null) {
    return establishedSteps(protocol, reason, ctx);
  }
  return [
    setupStep(protocol, ctx),
    coreStep(protocol, ctx),
    rhythmStep(protocol, ctx),
    reviewStep(protocol, ctx),
    holdStep(protocol, ctx),
    recordStep(ctx),
  ];
}

// ---------------------------------------------------------------------------
// Scoring and board construction.
// ---------------------------------------------------------------------------
interface Scored {
  protocol: SnapshotProtocol;
  ageDays: number | null;
  established: boolean;
  reason: string | null;
  factors: RadarFactors;
  impliedValue: number;
}

function scoreProtocol(protocol: SnapshotProtocol, asOf: string): Scored {
  const categoryMultiple = categoryMultipleFor(protocol.category);
  const momentum = momentumFactor(protocol.change_7d);
  const ageDays = computeAgeDays(asOf, protocol.listed_at);
  const maturity = maturityFactor(ageDays);
  const breadth = breadthFactor(protocol.chains.length);
  const reason = establishedReason(protocol);
  const established = reason !== null;
  const eligibility = established ? ELIGIBILITY_ESTABLISHED : ELIGIBILITY_CANDIDATE;
  const raw = Math.round(
    protocol.tvl_usd * categoryMultiple * momentum * maturity * breadth * eligibility,
  );
  const impliedValue = Math.min(MAX_IMPLIED_VALUE, Math.max(IMPLIED_VALUE_FLOOR, raw));
  return {
    protocol,
    ageDays,
    established,
    reason,
    factors: {
      category_multiple: categoryMultiple,
      momentum,
      maturity,
      breadth,
      eligibility,
    },
    impliedValue,
  };
}

function compareSlug(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildRadar(snapshot: Snapshot): Radar {
  const watchlist = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isPreToken)
    .map((protocol) => scoreProtocol(protocol, snapshot.as_of));

  scored.sort(
    (a, b) =>
      b.impliedValue - a.impliedValue || compareSlug(a.protocol.slug, b.protocol.slug),
  );

  // Enforce strictly decreasing implied values down the ranked board.
  for (let i = 1; i < scored.length; i++) {
    const prev = scored[i - 1].impliedValue;
    if (scored[i].impliedValue >= prev) {
      scored[i].impliedValue = Math.max(1, prev - 1);
    }
  }

  const rows: RadarRow[] = scored.map((entry, index) => ({
    rank: index + 1,
    slug: entry.protocol.slug,
    name: entry.protocol.name,
    category: entry.protocol.category,
    chains: entry.protocol.chains.slice(),
    tvl_usd: entry.protocol.tvl_usd,
    change_7d: entry.protocol.change_7d,
    age_days: entry.ageDays,
    watchlist: watchlist.has(entry.protocol.slug),
    established: entry.established,
    implied_value_usd: entry.impliedValue,
    factors: entry.factors,
    farm_steps: buildFarmSteps(
      entry.protocol,
      entry.established,
      entry.reason,
      entry.ageDays,
    ),
  }));

  return {
    meta: {
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      scanned: snapshot.protocols.length,
      pre_token: rows.length,
      watchlist_count: snapshot.watchlist.length,
    },
    rows,
  };
}

// ---------------------------------------------------------------------------
// boardIssue: the published gate shape, checked before anything is written.
// Returns a human-readable issue string, or null when the board is valid.
// ---------------------------------------------------------------------------
export function boardIssue(rows: RadarRow[], snapshot: Snapshot): string | null {
  if (!Array.isArray(rows) || rows.length < 100 || rows.length > 4000) {
    return "board must hold 100 to 4000 rows, holds " + (rows ? rows.length : 0);
  }
  const known = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.rank !== i + 1) {
      return "ranks must be exactly 1..N: row " + i + " claims rank " + row.rank;
    }
    if (seen.has(row.slug)) return "duplicate slug on the board: " + row.slug;
    seen.add(row.slug);
    if (!known.has(row.slug)) return "slug is not a snapshot protocol: " + row.slug;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return "implied value must be a positive whole number: " + row.slug;
    }
    if (row.implied_value_usd > MAX_IMPLIED_VALUE) {
      return "implied value above the 1e14 cap: " + row.slug;
    }
    if (i > 0 && row.implied_value_usd > rows[i - 1].implied_value_usd) {
      return "implied values must not rise as rank ascends: " + row.slug;
    }
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return "farm_steps must hold 3 to 12 steps: " + row.slug;
    }
    for (const step of row.farm_steps) {
      const trimmed = step.trim();
      if (trimmed.length < 20 || trimmed.length > 600) {
        return "farm step outside 20..600 trimmed chars: " + row.slug;
      }
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return "watchlist slug missing from the board: " + slug;
  }
  const nonWatchlist = rows.filter((row) => !snapshot.watchlist.includes(row.slug)).length;
  if (nonWatchlist < 60) {
    return "board must hold at least 60 non-watchlist rows, holds " + nonWatchlist;
  }
  return null;
}

// ---------------------------------------------------------------------------
// dataScript: the dashboard's data, as a classic script payload.
// ---------------------------------------------------------------------------
export function dataScript(radar: Radar): string {
  const payload = JSON.stringify({ meta: radar.meta, rows: radar.rows });
  return "window.RADAR = " + payload.replace(/<\//g, "<\\/") + ";\n";
}
