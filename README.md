[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/jehan771/pump-fun-bot-sprint-make-bot-and-win/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/jehan771/pump-fun-bot-sprint-make-bot-and-win/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Dip-bounce sniper on proven runners

A paper-trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition on [make.fun](https://make.fun). It trades paper SOL on a replay of pump.fun bonding-curve events and is ranked on net PnL.

## Strategy

Most new coins spike hard in their first minutes and then fade. The coins that
pay are the ones that spiked at least **4x** off their create price and then
pulled back without dying: buy the dip after a proven 4x run, exit on a modest
take-profit or a tight stop.

- **Entry** (once per coin; a rejected/failed buy may be retried while the setup holds):
  - coin created at most 3600 s ago
  - real SOL reserves >= 5 SOL
  - peak price since create >= 4x the create price
  - current price <= 90% of that peak
  - size = min(1 SOL, 0.95% of real quote reserves), at least 0.01 SOL
- **Exit** (checked on every batch for every open position):
  - take profit at 1.30x the filled cost basis
  - stop loss at 0.90x the filled cost basis
  - max hold 600 s from the fill
- **Risk**: at most 5 open positions; buys at 500 bps max slippage, sells at
  5000 bps; no shorts, no leverage.

The cost basis for take-profit / stop-loss is the harness's own blended
position cost (SOL spent on the tokens still held, fees included), not the
curve price at fill time — the two differ by ~2% (fees on top plus the buy's
own price impact), which is enough to flip exits near the boundary.

The bot is deterministic: every decision is a pure function of the event
stream and the constants in `main.ts`, with exact BigInt price comparisons.
No clock, no randomness, no network.

## Dev results (kit's own grader, `grade-local --driver process`)

- **Net PnL +1.555 SOL** (+15.55% on 10 SOL), 90% interval −0.287 … +3.492 SOL
- 166 fills over 65 coins, 65 round trips, win rate 43.1%, max drawdown 6.2%
- Fees 0.793 SOL curve + 0.018 SOL tx; **at 2x fees still +0.735 SOL**
- Top 3 coins made 26% of the gains; without them net PnL is still +0.380 SOL
- Guardrails met: 65 coins hold a round trip of at least 0.01 SOL, drawdown ok
- Two executions reproduce byte for byte (L1 regrade)
- `result_sha256` e314f5b20496022c09b2f93c6448c9d88a06ca66a244ea1bd67911b73f885520

Robustness on the dev window (own simulator, calibrated against the grader):
4 x 6h chunks +0.002 / +0.267 / +0.730 / +0.703 SOL — non-negative in every
chunk. The final is a fresh 6h window, so the dev score is a guide, not a
promise: the 90% interval and the chunk spread say the same.

## Layout

- `main.ts` — the bot (TypeScript, runs on Node 22 via the kit's harness)
- `vendor/makefun-bot.ts` — the kit's SDK shim, unmodified
- `LICENSE` — MIT
- `package.json`
