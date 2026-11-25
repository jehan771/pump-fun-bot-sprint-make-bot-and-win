// Dip-bounce sniper on proven runners — Pump.fun Bot Sprint: Make Bot And Win.
//
// Strategy, derived from the dev replay (24h, 1,222 coins):
//   Most new coins spike hard in their first minutes and then fade. The coins
//   that pay are the ones that spiked at least 4x off their create price and
//   then pulled back without dying: buy the dip after a proven 4x run, exit
//   on a modest take-profit or a tight stop. Small coins and stale coins are
//   skipped; one trade per coin; at most 5 open positions.
//
// Entry (once per coin; a rejected/failed buy may be retried while the setup holds):
//   - coin created at most 3600 s ago
//   - real SOL reserves >= 5 SOL
//   - peak price since create >= 4x the create price
//   - current price <= 90% of that peak
//   - size = min(1 SOL, 0.95% of real quote reserves), at least 0.01 SOL
// Exit (checked on every batch for every open position):
//   - take profit at 1.30x the filled cost basis
//   - stop loss at 0.90x the filled cost basis
//   - max hold 600 s from the fill
//
// Deterministic: every decision is a pure function of the event stream and
// the constants below. No clock, no randomness, no network. All price
// comparisons are exact BigInt cross-multiplications of reserve ratios.

import { runBot } from "./vendor/makefun-bot.ts";
import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";

const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- strategy constants (swept on the dev replay; see README) ---
const SPIKE_NUM = 4n; // peak >= 4x create price
const SPIKE_DEN = 1n;
const DIP_NUM = 9n; // current price <= 90% of peak
const DIP_DEN = 10n;
const TP_NUM = 13n; // take profit 1.30x
const TP_DEN = 10n;
const SL_NUM = 9n; // stop loss 0.90x
const SL_DEN = 10n;
const HOLD_SECONDS = 600;
const MAX_AGE_SECONDS = 3600;
const MIN_REAL_SOL = 5n * LAMPORTS_PER_SOL;
const SIZE_CAP = 1n * LAMPORTS_PER_SOL; // never spend more than 1 SOL per buy
const SIZE_BPS_OF_REAL = 95n; // 0.95% of real quote reserves
const MIN_BUY = 10_000_000n; // 0.01 SOL: smallest round trip the guardrails count
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 5000;

interface MintInfo {
  createVq: bigint;
  createVt: bigint;
  createTs: number;
  peakVq: bigint;
  peakVt: bigint;
}

interface EntryInfo {
  // Peak price since entry (for the record; exits use the harness's own
  // blended cost basis from the position, not this).
  peakVq: bigint;
  peakVt: bigint;
  entryTs: number;
}

const mintInfo = new Map<string, MintInfo>();
const entries = new Map<string, EntryInfo>();
const traded = new Set<string>();
let nowTs = 0;

// price a/b >= price c/d  <=>  a*d >= c*b  (all positive)
function priceGte(aq: bigint, at: bigint, bq: bigint, bt: bigint): boolean {
  return aq * bt >= bq * at;
}

function eventTs(e: { block_time?: number | null; timestamp?: string }): number {
  if (typeof e.block_time === "number") return e.block_time;
  const t = Number(e.timestamp);
  return Number.isFinite(t) ? t : 0;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  for (const e of batch.events) {
    const ts = eventTs(e);
    if (ts > nowTs) nowTs = ts;
    if (e.event === "CreateEvent") {
      const vq = BigInt(e.virtual_quote_reserves);
      const vt = BigInt(e.virtual_token_reserves);
      if (vt > 0n) {
        mintInfo.set(e.mint, {
          createVq: vq,
          createVt: vt,
          createTs: ts,
          peakVq: vq,
          peakVt: vt,
        });
      }
    } else if (e.event === "TradeEvent") {
      const info = mintInfo.get(e.mint);
      if (info !== undefined) {
        const vq = BigInt(e.virtual_quote_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        if (vt > 0n && priceGte(vq, vt, info.peakVq, info.peakVt)) {
          info.peakVq = vq;
          info.peakVt = vt;
        }
      }
    }
  }

  // Reconcile fills: record entries, drop closed positions (once per coin).
  for (const f of batch.fills) {
    if (f.status !== "filled") continue;
    if (f.side === "buy") {
      const paid = BigInt(f.quote_lamports);
      const tokens = BigInt(f.token_amount);
      // First fill on a mint starts the hold clock and the peak record; a
      // duplicate buy while one is still pending blends into the position
      // without resetting either (matches the sim's first-fill accounting).
      if (paid > 0n && tokens > 0n && !entries.has(f.mint)) {
        const curve = state.curves.get(f.mint);
        const vq = curve ? curve.virtual_quote_reserves : 0n;
        const vt = curve ? curve.virtual_token_reserves : 1n;
        entries.set(f.mint, {
          peakVq: vq > 0n ? vq : paid,
          peakVt: vt > 0n ? vt : tokens,
          entryTs: nowTs,
        });
      }
    }
  }
  for (const mint of [...entries.keys()]) {
    if (!state.positions.has(mint)) {
      entries.delete(mint);
      traded.add(mint);
    }
  }

  const pendingSell = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === "sell") pendingSell.add(p.order.mint);
  }

  // --- exits: TP / SL / max hold, checked for every open position ---
  for (const [mint, holding] of state.positions) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (pendingSell.has(mint)) continue;
    const entry = entries.get(mint);
    const curve = state.curves.get(mint);
    if (entry === undefined || curve === undefined) continue;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    if (vt <= 0n || holding.token_amount <= 0n) continue;
    // track the peak since entry for the record (no trailing stop: sweep
    // showed trailing exits cut winners on this replay)
    if (priceGte(vq, vt, entry.peakVq, entry.peakVt)) {
      entry.peakVq = vq;
      entry.peakVt = vt;
    }
    // Blended cost basis, exactly as the harness tracks it: the SOL spent
    // on the tokens still held (fees included) over those tokens. A second
    // buy on the same mint blends in here; a per-fill basis would be wrong.
    const costQ = BigInt(holding.cost_lamports);
    const costT = holding.token_amount;
    // TP: price >= cost * 5/4  <=>  vq*costT*4 >= costQ*vt*5
    const takeProfit = vq * costT * TP_DEN >= costQ * vt * TP_NUM;
    // SL: price <= cost * 23/25  <=>  vq*costT*25 <= costQ*vt*23
    const stopLoss = vq * costT * SL_DEN <= costQ * vt * SL_NUM;
    const timedOut = nowTs - entry.entryTs >= HOLD_SECONDS;
    if (takeProfit || stopLoss || timedOut) {
      orders.push({
        side: "sell",
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      pendingSell.add(mint);
    }
  }

  // --- entries: dip after a proven 4x spike, one trade per coin ---
  // committedPositionCount() only sees orders from earlier batches, so count
  // this batch's own buys too: the harness rejects fills past 5 open
  // positions, and a rejected buy wastes its tx fee.
  let committed = state.committedPositionCount();
  const maxOpen = state.hello.caps.max_open_positions;
  for (const e of batch.events) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (e.event !== "TradeEvent") continue;
    const mint = e.mint;
    if (state.positions.has(mint) || traded.has(mint)) continue;
    if (committed >= maxOpen) break;
    const info = mintInfo.get(mint);
    const curve = state.curves.get(mint);
    if (info === undefined || curve === undefined || curve.complete) continue;
    if (nowTs - info.createTs > MAX_AGE_SECONDS) continue;
    if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    if (vt <= 0n) continue;
    // spike: peak >= 4x create  <=>  peakVq*createVt*DEN >= NUM*createVq*peakVt
    const spiked =
      SPIKE_DEN * info.peakVq * info.createVt >= SPIKE_NUM * info.createVq * info.peakVt;
    if (!spiked) continue;
    // dip: price <= 90% of peak  <=>  vq*peakVt*10 <= peakVq*vt*9
    const dipped = vq * info.peakVt * DIP_DEN <= info.peakVq * vt * DIP_NUM;
    if (!dipped) continue;
    // size: min(1 SOL, 0.95% of real quote reserves), at least 0.01 SOL,
    // and inside the harness cap (1% of real reserves per batch per mint).
    let spend = (curve.real_quote_reserves * SIZE_BPS_OF_REAL) / 10_000n;
    if (spend > SIZE_CAP) spend = SIZE_CAP;
    if (spend < MIN_BUY) continue;
    const cap = state.maxBuyLamports(mint);
    if (spend > cap) spend = cap;
    if (spend < MIN_BUY) continue;
    if (state.freeCashLamports() < spend + state.txFeeLamports()) continue;
    orders.push({
      side: "buy",
      mint,
      quote_lamports: spend,
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    committed += 1;
  }

  return orders;
}

await runBot({ onBatch });
