// Deterministic token-launch radar model: scores every pre-token protocol in a sealed snapshot
// strictly from snapshot-native fields (TVL, category, 7-day momentum, listing age, chain breadth)
// and generates a concrete 6-step farm plan for every ranked row.

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

export interface ModelFactors {
  category_multiple: number;
  momentum: number;
  maturity: number;
  breadth: number;
  eligibility: number;
}

export interface BoardRow {
  rank: number;
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
  age_days: number | null;
  watchlist: boolean;
  established: boolean;
  implied_value_usd: number;
  factors: ModelFactors;
  farm_steps: string[];
}

export interface RadarMeta {
  as_of: string;
  floor_usd: number;
  scanned: number;
  pre_token: number;
  watchlist_count: number;
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
  factors: ModelFactors;
  farm_steps: string[];
}

export interface RadarData {
  meta: RadarMeta;
  rows: RadarRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
export const IMPLIED_VALUE_FLOOR = 10_000;
export const MAX_IMPLIED_VALUE = 1e14;

/**
 * FDV/TVL category priors. Strictly category-level economics — never protocol names or slugs.
 */
export const CATEGORY_MULTIPLES: Readonly<Record<string, number>> = {
  Dexs: 2.2, // High fee turnover per dollar of liquidity and strong governance/fee-switch value.
  Derivatives: 2.0, // High trading fee velocity relative to collateral margin locked.
  'Interest Rate Derivatives': 1.9, // Leveraged rate trading captures outsized fees on modest TVL.
  Chain: 1.6, // Base-layer L1/L2 tokens accrue gas, MEV, and ecosystem monetary premiums.
  Options: 1.6, // Options venues earn spread and premium flow on relatively small collateral pools.
  'Prediction Market': 1.6, // Event volume and mindshare typically outpace resting open interest.
  Lending: 1.5, // Durable borrow demand and sticky institutional liquidity support mid-high multiples.
  'Options Vault': 1.5, // Structured options vaults monetize recurring yield and volatility flow.
  Payments: 1.4, // Payment rails monetize transaction throughput rather than idle locked capital.
  Privacy: 1.4, // Specialized privacy networks command scarcity premiums over raw shielded TVL.
  CDP: 1.4, // Stablecoin issuers monetize stability fees and seigniorage on collateral.
  'Uncollateralized Lending': 1.4, // Credit origination earns higher spreads than overcollateralized pools.
  'Collateral Markets': 1.4, // Modular collateral markets mirror core lending economics.
  'Risk Curators': 1.3, // Performance-fee curation scales across underlying vaults with low capital overhead.
  'Onchain Capital Allocator': 1.3, // Active multi-venue allocation earns management and performance fees.
  'CDP Manager': 1.3, // Automation and liquidation protection layers extract recurring service fees.
  'Governance Incentives': 1.3, // Bribe and vote-escrow marketplaces capture meta-governance cash flows.
  RWA: 1.2, // Real-world asset wrappers carry regulated yield with tighter net fee margins.
  'Leveraged Farming': 1.2, // Amplified strategy turnover boosts fee capture but remains cyclical.
  'Liquidity Manager': 1.2, // Automated concentrated-LP management takes a steady slice of swap fees.
  'Basis Trading': 1.2, // Funding-rate arbitrage earns carry but scales directly with hedge capacity.
  'OTC Marketplace': 1.2, // Block-trade venues generate brokerage fees without holding deep idle TVL.
  Insurance: 1.2, // Underwriting pools price risk premiums modestly above staked capacity.
  Indexes: 1.2, // Onchain index baskets earn streaming management fees on AUM.
  'Yield Aggregator': 1.1, // Auto-compounding aggregators retain thin performance fees on deposited TVL.
  'Dual-Token Stablecoin': 1.1, // Algorithmic/dual-token designs trade near collateral backing with dilution risk.
  Yield: 1.0, // General yield venues anchor the neutral baseline multiple.
  Farm: 1.0, // Standard liquidity-mining farms sit at baseline valuation per TVL dollar.
  'Stablecoin Wrapper': 1.0, // Wrapped yield-bearing stablecoins mirror underlying collateral value.
  'Crypto Card Issuer': 1.0, // Card programs earn interchange on spend with modest onchain token capture.
  Bridge: 0.45, // Cross-chain liquidity bridges earn thin basis-point spreads on large bridged custody.
  'Cross Chain Bridge': 0.45, // Third-party cross-chain bridges face tight routing fee compression.
  'Liquid Staking': 0.45, // Massive passive staking TVL with low commission take-rates compresses FDV/TVL.
  'Liquid Restaking': 0.5, // Restaking wrappers stack modest fee margins on large base collateral.
  Restaking: 0.5, // Shared-security collateral pools command sub-1x token-to-TVL ratios.
  'Staking Pool': 0.4, // Commoditized validator pools operate on narrow commission margins.
  'Restaked BTC': 0.45, // Wrapped BTC restaking vehicles mostly mirror passive underlying custody.
  'Decentralized BTC': 0.45, // Bridged/tokenized BTC backing commands low standalone protocol take-rates.
  'Anchor BTC': 0.4, // Custodial BTC anchor wrappers carry minimal standalone token capture.
  'Canonical Bridge': 0.35, // Native rollup/chain bridges rarely capture independent fee tokens.
  CeDeFi: 0.25, // Hybrid custodial products split economics offchain, sharply reducing token accrual.
  CEX: 0.15, // Centralized exchange custody rarely converts user balances into a retroactive token launch.
};

export const DEFAULT_CATEGORY_MULTIPLE = 1.0;

/**
 * Launch-eligibility screen mirroring the snapshot watchlist definition.
 * A launch radar ranks future token launches; established wrapped, staked, bridged, versioned,
 * and centralized-exchange products track tokens that already trade rather than waiting on a
 * launch of their own, so they receive a 0.04 eligibility factor instead of 1.0.
 */
export const ELIGIBILITY_CANDIDATE = 1.0;
export const ELIGIBILITY_ESTABLISHED = 0.04;

const ESTABLISHED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const ESTABLISHED_WORD_PATTERN = /\b(?:wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX_PATTERN = /^(?:Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
const VERSION_SUFFIX_PATTERN = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Returns true when a protocol is an established product rather than a genuine token launch candidate. */
export function isEstablishedProduct(protocol: SnapshotProtocol): boolean {
  if (protocol.category !== null && ESTABLISHED_CATEGORIES.has(protocol.category)) return true;
  if (ESTABLISHED_WORD_PATTERN.test(protocol.name)) return true;
  if (EXCHANGE_PREFIX_PATTERN.test(protocol.name)) return true;
  if (VERSION_SUFFIX_PATTERN.test(protocol.name)) return true;
  return false;
}

const EVM_L2_CHAINS = new Set([
  'Arbitrum',
  'Base',
  'Optimism',
  'Polygon',
  'Linea',
  'Scroll',
  'Blast',
  'zkSync Era',
  'Unichain',
  'Mode',
  'Mantle',
  'Avalanche',
  'Binance',
  'Sonic',
  'Berachain',
  'Monad',
  'Plasma',
  'Hyperliquid L1',
  'Gnosis',
  'Celo',
  'Fantom',
  'Metis',
  'Manta',
  'Taiko',
  'Katana',
  'Ink',
  'Soneium',
  'Abstract',
  'World Chain',
  'Robinhood Chain',
]);

const URL_PATTERN = /\b(?:https?:\/\/|www\.)/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function compareSlug(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whole UTC days between listed_at and the snapshot's as_of; null if listed_at is absent or invalid. */
export function computeAgeDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const listedMs = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.max(0, Math.floor((asOfMs - listedMs) / DAY_MS));
}

/** Category FDV/TVL prior lookup with neutral 1.0 fallback. */
export function categoryMultipleFor(category: string | null): number {
  if (category === null) return DEFAULT_CATEGORY_MULTIPLE;
  return CATEGORY_MULTIPLES[category] ?? DEFAULT_CATEGORY_MULTIPLE;
}

/** Compute the five model factors and raw floored implied value for one protocol. */
export function scoreProtocol(
  protocol: SnapshotProtocol,
  asOf: string,
): { age_days: number | null; established: boolean; factors: ModelFactors; implied_value_usd: number } {
  const category_multiple = categoryMultipleFor(protocol.category);

  const momentum =
    protocol.change_7d === null
      ? 1.0
      : 1 + (clamp(protocol.change_7d, -40, 120) / 100) * 0.6;

  const age_days = computeAgeDays(asOf, protocol.listed_at);
  const maturity =
    age_days === null ? 1.0 : 0.8 + (0.45 * Math.min(age_days, 1460)) / 1460;

  const chainCount = Math.max(1, protocol.chains.length);
  const breadth = 1 + 0.04 * Math.min(chainCount - 1, 5);

  // A launch radar ranks future launches; established products track existing tokens.
  const established = isEstablishedProduct(protocol);
  const eligibility = established ? ELIGIBILITY_ESTABLISHED : ELIGIBILITY_CANDIDATE;

  const rawImplied = Math.round(
    protocol.tvl_usd * category_multiple * momentum * maturity * breadth * eligibility,
  );
  const implied_value_usd = Math.max(IMPLIED_VALUE_FLOOR, rawImplied);

  return {
    age_days,
    established,
    factors: {
      category_multiple: round4(category_multiple),
      momentum: round4(momentum),
      maturity: round4(maturity),
      breadth: round4(breadth),
      eligibility: round4(eligibility),
    },
    implied_value_usd,
  };
}

/** Pre-token universe: protocols with neither CoinGecko id nor token ticker symbol. */
export function isPreToken(protocol: SnapshotProtocol): boolean {
  return protocol.gecko_id === null && protocol.symbol === null;
}

interface CapitalTier {
  sizeRange: string;
  tierLabel: string;
  splitNote: string;
}

function capitalTierFor(tvlUsd: number): CapitalTier {
  if (tvlUsd >= 500_000_000) {
    return {
      sizeRange: '$250-$1,000',
      tierLabel: 'large-TVL $500M+',
      splitNote: 'sized to clear typical minimum-balance filters on deep pools',
    };
  }
  if (tvlUsd >= 50_000_000) {
    return {
      sizeRange: '$100-$500',
      tierLabel: 'mid-TVL $50M-$500M',
      splitNote: 'balanced for meaningful share without over-concentrating capital',
    };
  }
  return {
    sizeRange: '$25-$150',
    tierLabel: 'early-TVL under $50M',
    splitNote: 'capped conservatively to manage smart-contract and liquidity risk',
  };
}

function displayChain(chain: string): string {
  return chain === 'Binance' ? 'BNB Chain' : chain;
}

interface ChainProfile {
  primaryChain: string;
  secondaryChain: string | null;
  gasBudget: string;
  chainNote: string;
}

function chainProfileFor(chains: string[]): ChainProfile {
  const hasSolana = chains.includes('Solana');
  const hasEthereum = chains.includes('Ethereum');
  const l2s = chains.filter((c) => EVM_L2_CHAINS.has(c));

  if (hasSolana && (chains[0] === 'Solana' || l2s.length === 0)) {
    const rawSecondary =
      l2s[0] ?? (hasEthereum ? 'Ethereum' : chains.find((c) => c !== 'Solana') ?? null);
    return {
      primaryChain: 'Solana',
      secondaryChain: rawSecondary ? displayChain(rawSecondary) : null,
      gasBudget: 'about $1/month',
      chainNote: 'Solana fees keep frequent weekly actions inexpensive',
    };
  }

  if (l2s.length > 0) {
    const rawPrimary = l2s[0]!;
    const rawSecondary =
      l2s[1] ?? (hasEthereum ? 'Ethereum' : chains.find((c) => c !== rawPrimary) ?? null);
    const primary = displayChain(rawPrimary);
    return {
      primaryChain: primary,
      secondaryChain: rawSecondary ? displayChain(rawSecondary) : null,
      gasBudget: '$1-$5/month',
      chainNote: hasEthereum
        ? `preferring ${primary} over Ethereum mainnet cuts gas from $15-$40/month down to $1-$5/month`
        : `${primary} execution keeps routine transactions cheap`,
    };
  }

  if (hasEthereum) {
    const rawSecondary = chains.find((c) => c !== 'Ethereum') ?? null;
    return {
      primaryChain: 'Ethereum',
      secondaryChain: rawSecondary ? displayChain(rawSecondary) : null,
      gasBudget: '$15-$40/month',
      chainNote: 'batch Ethereum mainnet transactions during off-peak gas windows',
    };
  }

  const rawPrimary = chains[0] ?? 'its primary chain';
  const rawSecondary = chains[1] ?? null;
  const primary = displayChain(rawPrimary);
  const isBitcoin = rawPrimary === 'Bitcoin';
  return {
    primaryChain: primary,
    secondaryChain: rawSecondary ? displayChain(rawSecondary) : null,
    gasBudget: isBitcoin ? '$5-$15/month' : '$1-$5/month',
    chainNote: isBitcoin
      ? 'batch Bitcoin transactions during lower mempool fee windows'
      : `${primary} network fees keep weekly usage low cost`,
  };
}

function horizonFor(ageDays: number | null): { span: string; adj: string } {
  if (ageDays !== null && ageDays < 180) return { span: '10-12 weeks', adj: '10-12 week' };
  if (ageDays !== null && ageDays > 730) return { span: '8-10 weeks', adj: '8-10 week' };
  return { span: '8-12 weeks', adj: '8-12 week' };
}

function ensureStepLength(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length > 600) return `${trimmed.slice(0, 597)}...`;
  if (trimmed.length < 20) return `${trimmed} Log date, wallet, and gas spent.`;
  return trimmed;
}

function establishedProductKind(protocol: SnapshotProtocol): string {
  const cat = protocol.category ?? '';
  if (cat === 'CEX' || EXCHANGE_PREFIX_PATTERN.test(protocol.name)) {
    return 'an exchange-backed or custodial product';
  }
  if (cat === 'Bridge' || cat === 'Canonical Bridge') {
    return 'a wrapped or bridged asset product';
  }
  if (
    cat === 'Liquid Staking' ||
    cat === 'Liquid Restaking' ||
    cat === 'Restaked BTC' ||
    ESTABLISHED_WORD_PATTERN.test(protocol.name)
  ) {
    return 'a wrapped or staked token product';
  }
  if (VERSION_SUFFIX_PATTERN.test(protocol.name)) {
    return 'a versioned deployment of an established protocol';
  }
  return 'an established wrapped, staked, or exchange product';
}

/**
 * Generate exactly 6 concrete, plain-text farm steps derived strictly from category, chains,
 * TVL tier, listing age, and launch eligibility. No URLs and no unverified protocol-specific claims.
 */
export function buildFarmSteps(
  protocol: SnapshotProtocol,
  ageDays: number | null,
  established: boolean,
): string[] {
  const tier = capitalTierFor(protocol.tvl_usd);
  const cp = chainProfileFor(protocol.chains);
  const horizon = horizonFor(ageDays);
  const cat = protocol.category ?? 'Default';
  const name = protocol.name;
  const routeNote =
    cp.secondaryChain !== null
      ? `${cp.primaryChain} and ${cp.secondaryChain}`
      : `${cp.primaryChain} and a major hub network`;

  let steps: string[];

  if (established) {
    const kind = establishedProductKind(protocol);
    steps = [
      `No launch to farm: ${name} is ${kind} tracking a token that already trades, so do not commit airdrop-hunting capital here; treat it purely as an exposure tool and keep monitoring to 5 minutes/week.`,
      `Only use ${name} if you already want underlying asset custody, liquidity, or staking yield, sizing any voluntary allocation conservatively at ${tier.sizeRange} (${tier.tierLabel} tier) rather than chasing speculative points.`,
      `If you hold or move exposure on ${cp.primaryChain}, keep transaction overhead inside a ${cp.gasBudget} gas budget (${cp.chainNote}) and avoid unnecessary deposits, withdrawals, or bridge round-trips.`,
      `Before minting, staking, or bridging through ${name}, compare secondary-market spread against native mint or redemption fees (10 minutes) so slippage does not outweigh the underlying yield.`,
      `Review peg stability, custody or validator risk, and withdrawal queues once a week (5 minutes/week over the ${horizon.adj} holding period) rather than assuming passive holding earns an unannounced token.`,
      `Keep a lean log of entry cost, fees, and yield (5 minutes/month), and direct active farming hours toward unlaunched candidates carrying a full 1.00x launch-eligibility factor.`,
    ];
  } else if (cat === 'CEX' || cat === 'CeDeFi') {
    steps = [
      `Low-priority skip plan: ${name} is classified as ${cat}, where custodial balances rarely earn a retroactive onchain token airdrop; keep this behind pure DeFi targets and cap time at 5 minutes/week.`,
      `Do not park idle capital strictly to farm ${name}; if you already hold an account, limit optional activity to ${tier.sizeRange} (${tier.tierLabel} tier) only when you genuinely need execution.`,
      `Keep onchain transfers minimal on ${cp.primaryChain} (${cp.gasBudget} gas budget; ${cp.chainNote}) rather than cycling deposits and withdrawals that erode capital in fees.`,
      `If ${name} launches an opt-in product or any points or season programme it runs, spend 5 minutes/week checking eligibility rules before committing fresh funds over the ${horizon.adj} window.`,
      `Prioritize self-custody protocols from higher-multiple categories first, and avoid KYC-gated lockups on ${name} unless net trading or yield utility justifies the commitment on its own.`,
      `Record any account funding dates and fees in a simple spreadsheet (5 minutes/month) so you can unwind cleanly without mistaking exchange balances for active DeFi farm exposure.`,
    ];
  } else if (cat === 'Dexs' || cat === 'Liquidity Manager') {
    steps = [
      `Prepare a dedicated wallet on ${cp.primaryChain} funded with ${tier.sizeRange} (${tier.tierLabel} tier; ${tier.splitNote}) plus a ${cp.gasBudget} gas buffer (${cp.chainNote}); setup takes 10 minutes.`,
      `Execute 2-3 organic spot swaps per week on ${name} across major pairs (10-15 minutes/week) to build consistent volume and distinct active weeks rather than one-off wash trades.`,
      `Provide ${tier.sizeRange} into a deep, blue-chip liquidity pool on ${name} on ${cp.primaryChain} and keep the LP position active so resting liquidity is captured across snapshots.`,
      `Rebalance or collect accrued swap fees every 2 weeks (15 minutes per review, within your ${cp.gasBudget} gas budget) to maintain active-range utilization and avoid stale out-of-range positions.`,
      `Maintain the swap-and-LP cadence for ${horizon.span}, checking weekly (5 minutes/week) whether positions qualify for any points or season programme it runs without chasing risky micro-cap pools.`,
      `Track swap volume, LP entry prices, impermanent loss, and cumulative gas in a farm log (5 minutes/week) before deciding whether to compound or unwind after the ${horizon.adj} cycle.`,
    ];
  } else if (
    cat === 'Lending' ||
    cat === 'Uncollateralized Lending' ||
    cat === 'Collateral Markets' ||
    cat === 'CDP' ||
    cat === 'CDP Manager'
  ) {
    steps = [
      `Fund a dedicated wallet on ${cp.primaryChain} with ${tier.sizeRange} in a liquid collateral asset (${tier.tierLabel} tier; ${tier.splitNote}) and reserve ${cp.gasBudget} for gas (${cp.chainNote}); 10 minutes setup.`,
      `Supply your ${tier.sizeRange} collateral to a core ${name} market on ${cp.primaryChain} and verify that supply receipts and interest accrual update cleanly onchain (10 minutes).`,
      `Borrow conservatively against your supply — keep loan-to-value at 30%-45% with a wide liquidation buffer — so your wallet records both lender and borrower usage on ${name}.`,
      `Run a disciplined repay-and-reborrow or partial-top-up cycle every 1-2 weeks (10-15 minutes/week within your ${cp.gasBudget} gas budget) while checking health factor whenever volatility spikes.`,
      `Hold the active supply-and-borrow loop for ${horizon.span}, spending 5 minutes/week monitoring borrow APR vs supply yield and verifying eligibility for any points or season programme it runs.`,
      `Maintain a position log with collateral ratio, net borrow interest, and gas spend (5 minutes/week), and repay the debt in full before withdrawing collateral at the end of the ${horizon.adj} window.`,
    ];
  } else if (
    cat === 'Derivatives' ||
    cat === 'Interest Rate Derivatives' ||
    cat === 'Options' ||
    cat === 'Options Vault' ||
    cat === 'Basis Trading' ||
    cat === 'Prediction Market'
  ) {
    steps = [
      `Deposit ${tier.sizeRange} of stable margin into a fresh wallet for ${name} on ${cp.primaryChain} (${tier.tierLabel} tier; ${tier.splitNote}) and budget ${cp.gasBudget} for gas (${cp.chainNote}); 10 minutes setup.`,
      `Open small, low-leverage (1x-2x) hedged perpetual or derivative positions on liquid markets inside ${name}, pairing exposure against spot or an offsetting leg to keep directional risk tight.`,
      `Place 2-4 measured trades per week (15-20 minutes/week) and let positions stay open for at least several hours so activity reflects genuine open interest rather than instant round-trips.`,
      `Cap weekly trading fees and funding drag below 1% of your ${tier.sizeRange} margin, keeping onchain settlement within the ${cp.gasBudget} gas allowance on ${cp.primaryChain}.`,
      `Sustain weekly trading and margin activity for ${horizon.span}, checking once a week (5 minutes/week) how volume and open interest count toward any points or season programme it runs.`,
      `Log realized PnL, funding paid, trading fees, and open-interest days weekly (5 minutes/week), then flatten hedges cleanly before withdrawing margin after the ${horizon.adj} horizon.`,
    ];
  } else if (
    cat === 'Yield' ||
    cat === 'Yield Aggregator' ||
    cat === 'Risk Curators' ||
    cat === 'Onchain Capital Allocator' ||
    cat === 'Farm' ||
    cat === 'Leveraged Farming' ||
    cat === 'Indexes'
  ) {
    const isCurator = cat === 'Risk Curators' || cat === 'Onchain Capital Allocator';
    steps = [
      `Set up a dedicated wallet on ${cp.primaryChain} with ${tier.sizeRange} (${tier.tierLabel} tier; ${tier.splitNote}) and allocate ${cp.gasBudget} for gas (${cp.chainNote}); takes 10 minutes.`,
      isCurator
        ? `Deposit ${tier.sizeRange} into one of ${name}'s flagship curated vaults on ${cp.primaryChain} after checking underlying lending markets, collateral caps, and curator performance fees (10-15 minutes).`
        : `Deposit ${tier.sizeRange} into one of ${name}'s primary audited vaults on ${cp.primaryChain} with healthy TVL and transparent underlying strategies (10-15 minutes initial deposit).`,
      `Leave vault shares staked or compounding continuously rather than hopping vaults daily, adding a small weekly top-up or harvest action (10 minutes/week) to register recurring activity.`,
      `Review strategy APY, withdrawal queue terms, and collateral composition once a week (10 minutes/week) while keeping maintenance transactions inside your ${cp.gasBudget} gas budget.`,
      `Hold the compounding vault position across ${horizon.span} so time-weighted balance snapshots accumulate under any points or season programme it runs.`,
      `Record vault share price, net yield earned, and total gas costs weekly (5 minutes/week) so you can measure true net return before unwinding after ${horizon.span}.`,
    ];
  } else if (cat === 'Bridge' || cat === 'Canonical Bridge' || cat === 'Cross Chain Bridge') {
    steps = [
      `Allocate ${tier.sizeRange} of liquid stablecoins or native assets (${tier.tierLabel} tier; ${tier.splitNote}) and a ${cp.gasBudget} gas budget (${cp.chainNote}) in a dedicated bridging wallet; 10 minutes setup.`,
      `Route 1-2 genuine cross-chain transfers per week through ${name} between ${routeNote} (10-15 minutes/week) to build recurring bridge volume across distinct source and destination chains.`,
      `Vary transfer sizes naturally within your ${tier.sizeRange} band and leave bridged funds on the destination chain for several days before bridging back so flows look organic.`,
      `Check quoted slippage and relayer fees before every transfer so combined bridge fees and ${cp.gasBudget} gas stay well controlled across ${protocol.chains.length} supported chain${protocol.chains.length === 1 ? '' : 's'}.`,
      `Continue steady cross-chain volume over ${horizon.span}, spending 5 minutes/week verifying transaction completion and checking eligibility under any points or season programme it runs.`,
      `Log source chain, destination chain, bridged USD volume, and fees per transfer (5 minutes/week) to track cumulative volume without stranding dust balances across networks.`,
    ];
  } else if (cat === 'RWA') {
    steps = [
      `Check ${name}'s jurisdiction, accreditation, and KYC/onboarding requirements first (15 minutes) before moving funds, since RWA issuers often restrict minting or redemption to verified wallets.`,
      `Fund an approved wallet on ${cp.primaryChain} with ${tier.sizeRange} in supported stablecoins (${tier.tierLabel} tier; ${tier.splitNote}) plus ${cp.gasBudget} for gas (${cp.chainNote}).`,
      `Mint or deposit into ${name}'s core tokenized yield asset on ${cp.primaryChain} and confirm the balance settles properly in your wallet (15 minutes).`,
      `Hold the RWA balance continuously and perform light weekly maintenance — checking yield accrual, redemption windows, or secondary liquidity (10 minutes/week within ${cp.gasBudget} gas).`,
      `Maintain the deposit for ${horizon.span} so holding duration counts across snapshots and any points or season programme it runs, while confirming T+0/T+1 exit liquidity before scaling up.`,
      `Keep a clean compliance and yield log (deposit timestamps, KYC wallet address, accrued yield, and gas; 5 minutes/week) to simplify tax reporting and eventual redemption.`,
    ];
  } else if (
    cat === 'Liquid Staking' ||
    cat === 'Liquid Restaking' ||
    cat === 'Restaking' ||
    cat === 'Staking Pool' ||
    cat === 'Restaked BTC' ||
    cat === 'Decentralized BTC' ||
    cat === 'Anchor BTC'
  ) {
    steps = [
      `Prepare a fresh wallet on ${cp.primaryChain} holding ${tier.sizeRange} of the native staking asset (${tier.tierLabel} tier; ${tier.splitNote}) plus ${cp.gasBudget} for gas (${cp.chainNote}); 10 minutes setup.`,
      `Stake ${tier.sizeRange} directly through ${name}'s minting contract on ${cp.primaryChain} rather than only swapping on a secondary DEX so the protocol records a direct staking deposit (10 minutes).`,
      `Put the minted receipt token to work productively — hold it in your wallet or supply it to a conservative lending or liquidity venue on ${cp.primaryChain} without taking excess leverage.`,
      `Check staking yield, receipt-token peg discount, and unbonding queue length once per week (10 minutes/week), keeping any restaking or claim actions inside your ${cp.gasBudget} gas budget.`,
      `Hold the staked position continuously for ${horizon.span} to build unbroken time-weighted balance for any points or season programme it runs.`,
      `Log mint rate, staking APY, receipt deployments, and gas spend weekly (5 minutes/week), and compare instant-swap exit vs native unstaking queue before unwinding after ${horizon.span}.`,
    ];
  } else {
    steps = [
      `Fund a dedicated wallet on ${cp.primaryChain} with ${tier.sizeRange} (${tier.tierLabel} tier; ${tier.splitNote}) and keep ${cp.gasBudget} reserved for gas (${cp.chainNote}); 10 minutes setup.`,
      `Complete one core product action on ${name} on ${cp.primaryChain} — depositing, transacting, or opening a primary position — so your wallet registers authentic first-party usage (15 minutes).`,
      `Return once per week for 10-15 minutes to perform a meaningful core interaction on ${name} (such as topping up, transacting, or rebalancing) rather than leaving the wallet dormant.`,
      `Keep onchain activity disciplined within your ${cp.gasBudget} gas budget on ${cp.primaryChain}${cp.secondaryChain ? ` (optionally testing ${cp.secondaryChain} as a second active chain)` : ''}.`,
      `Sustain weekly usage and an active balance across ${horizon.span}, spending 5 minutes/week verifying whether ongoing usage qualifies under any points or season programme it runs.`,
      `Document wallet address, transaction dates, active balance, and cumulative gas in a farm log (5 minutes/week) so you can cleanly review or unwind after the ${horizon.adj} period.`,
    ];
  }

  return steps.map(ensureStepLength);
}

/** Parse and validate snapshot.json text into a strongly typed Snapshot. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json root must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.as_of)) {
    throw new SnapshotError('snapshot.json is missing a valid YYYY-MM-DD as_of date');
  }
  if (typeof obj.source !== 'string' || obj.source.length === 0) {
    throw new SnapshotError('snapshot.json is missing source');
  }
  if (typeof obj.floor_usd !== 'number' || !Number.isSafeInteger(obj.floor_usd) || obj.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json is missing a positive integer floor_usd');
  }
  if (!Array.isArray(obj.protocols)) {
    throw new SnapshotError('snapshot.json is missing protocols array');
  }
  if (!Array.isArray(obj.watchlist) || obj.watchlist.some((w) => typeof w !== 'string')) {
    throw new SnapshotError('snapshot.json is missing watchlist string array');
  }

  const protocols: SnapshotProtocol[] = obj.protocols.map((entry, idx) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new SnapshotError(`snapshot.json protocol[${idx}] is not an object`);
    }
    const p = entry as Record<string, unknown>;
    if (
      typeof p.slug !== 'string' ||
      p.slug.length === 0 ||
      typeof p.name !== 'string' ||
      p.name.length === 0 ||
      typeof p.tvl_usd !== 'number' ||
      !Number.isFinite(p.tvl_usd) ||
      p.tvl_usd < 0
    ) {
      throw new SnapshotError(`snapshot.json protocol[${idx}] lacks valid slug, name, or tvl_usd`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains)
        ? p.chains.filter((c): c is string => typeof c === 'string')
        : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });

  return {
    as_of: obj.as_of,
    source: obj.source,
    floor_usd: obj.floor_usd,
    protocols,
    watchlist: obj.watchlist as string[],
  };
}

/** Build the ranked pre-token board and offline dashboard dataset from a snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const watchlistSet = new Set(snapshot.watchlist);
  const preTokenProtocols = snapshot.protocols.filter(isPreToken);

  const scored = preTokenProtocols.map((p) => {
    const result = scoreProtocol(p, snapshot.as_of);
    return {
      protocol: p,
      age_days: result.age_days,
      established: result.established,
      factors: result.factors,
      implied_value_usd: result.implied_value_usd,
    };
  });

  // Sort by implied value descending, ties by slug ascending.
  scored.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd ||
      compareSlug(a.protocol.slug, b.protocol.slug),
  );

  // Enforce strictly decreasing implied values down the ranked board.
  for (let i = 1; i < scored.length; i++) {
    const prev = scored[i - 1]!.implied_value_usd;
    const curr = scored[i]!.implied_value_usd;
    if (curr >= prev) {
      scored[i]!.implied_value_usd = Math.max(1, prev - 1);
    }
  }

  const board: BoardRow[] = scored.map((entry, idx) => {
    const p = entry.protocol;
    return {
      rank: idx + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      age_days: entry.age_days,
      watchlist: watchlistSet.has(p.slug),
      established: entry.established,
      implied_value_usd: entry.implied_value_usd,
      factors: entry.factors,
      farm_steps: buildFarmSteps(p, entry.age_days, entry.established),
    };
  });

  const rows: RadarRow[] = board.map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    age_days: r.age_days,
    watchlist: r.watchlist,
    established: r.established,
    implied_value_usd: r.implied_value_usd,
    factors: r.factors,
    farm_steps: r.farm_steps,
  }));

  const radar: RadarData = {
    meta: {
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      scanned: snapshot.protocols.length,
      pre_token: board.length,
      watchlist_count: snapshot.watchlist.length,
    },
    rows,
  };

  return { board, radar };
}

/** Validate every gate invariant on a generated board; returns an issue description or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) {
    return `board has ${board.length} rows; expected between 100 and 4000`;
  }

  const snapshotSlugs = new Set(snapshot.protocols.map((p) => p.slug));
  const watchlistSet = new Set(snapshot.watchlist);
  const seenSlugs = new Set<string>();
  let nonWatchlistCount = 0;

  for (let i = 0; i < board.length; i++) {
    const row = board[i]!;
    if (!snapshotSlugs.has(row.slug)) {
      return `row ${i + 1} slug "${row.slug}" is not present in the snapshot`;
    }
    if (seenSlugs.has(row.slug)) {
      return `duplicate slug "${row.slug}" in board`;
    }
    seenSlugs.add(row.slug);

    if (row.rank !== i + 1) {
      return `row ${i + 1} (${row.slug}) has rank ${row.rank}; expected ${i + 1}`;
    }

    const v = row.implied_value_usd;
    if (!Number.isSafeInteger(v) || v <= 0 || v > MAX_IMPLIED_VALUE) {
      return `${row.slug} has invalid implied_value_usd ${v}`;
    }
    if (i > 0 && v > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} (${row.slug}, $${v}) exceeds previous row ($${board[i - 1]!.implied_value_usd})`;
    }

    if (!watchlistSet.has(row.slug)) {
      nonWatchlistCount++;
    }

    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug} has ${row.farm_steps?.length ?? 0} farm_steps; expected 3..12`;
    }
    for (let s = 0; s < row.farm_steps.length; s++) {
      const step = row.farm_steps[s];
      if (typeof step !== 'string') {
        return `${row.slug} farm_steps[${s}] is not a string`;
      }
      const trimmed = step.trim();
      if (trimmed.length < 20 || trimmed.length > 600) {
        return `${row.slug} farm_steps[${s}] has trimmed length ${trimmed.length}; expected 20..600`;
      }
      if (URL_PATTERN.test(trimmed)) {
        return `${row.slug} farm_steps[${s}] contains a URL`;
      }
    }
  }

  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}`;
  }

  const missingWatchlist = snapshot.watchlist.filter((slug) => !seenSlugs.has(slug));
  if (missingWatchlist.length > 0) {
    return `board misses ${missingWatchlist.length} watchlist slug(s): ${missingWatchlist.slice(0, 5).join(', ')}`;
  }

  if (nonWatchlistCount < 60) {
    return `board has only ${nonWatchlistCount} non-watchlist rows; expected at least 60`;
  }

  return null;
}

/** Serialize the offline dashboard dataset as a single deterministic JS script. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
