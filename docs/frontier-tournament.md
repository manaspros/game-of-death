# Frontier tournament (2026-10-04)


9 models played a full round-robin, 2 games per pair with seats swapped, 72 matches over 5 rounds each. All models ran at `reasoning_effort: medium` through a LiteLLM proxy, except kimi-k3 at `high`, because its scale has no medium. 71 matches were valid and 1 was void (a timeout).

<img src="../assets/readme/leaderboard.png" alt="Leaderboard" width="100%">

| # | Model | Rating (95% CI) | W/D/L | Tokens/game | Spend |
|---|---|---|---|---|---|
| 1 | gpt-6.1-sol | **1145** (1079–1253) | 9/5/2 | 37.5k | $1.78 |
| 2 | kimi-k3 | 1131 (1059–1219) | 7/7/1 | 113k | $22.58 |
| 3 | glm-5.2 | 1102 (999–1261) | 8/5/3 | 253k | $6.94 |
| 4 | claude-opus-5-5 | 1040 (937–1147) | 6/6/4 | 76k | $12.35 |
| 5 | grok-4.6 | 992 (921–1081) | 5/5/5 | 128k | $9.28 |
| 6 | claude-sonnet-5-5 | 940 (843–1042) | 4/5/7 | 58k | $2.68 |
| 7 | gpt-6-luna | 940 (855–1020) | 2/9/5 | 69k | $0.29 |
| 8 | deepseek-v4.1-flash | 855 (769–938) | 1/7/8 | 321k | $5.16 |
| 9 | gemini-3.1-pro | 855 (779–919) | 1/7/8 | 56k | $5.09 |

Ratings are Bradley-Terry (MM, draw = ½) on an Elo scale, anchored so the geometric mean = 1000, with 95% CIs from 200 bootstrap resamples. Total spend was about $66.

### What we learned

- **Price ≠ skill.** #1 spent $1.78 on the whole tournament, and #2 spent $22.58.
- **"Medium" effort is not one setting.** The same flag produced 37k tokens/game for one model and 253k for another.
- **Reliability is part of the score.** Some models lost whole turns to runaway reasoning or never called the tool. That shows in the invalid+skip rate (up to 3.1/game).
- **Game length decides whether the benchmark discriminates.** A 1-round rehearsal was almost all draws, with ratings bunched between 963 and 1037. With 5 rounds, 43 of 71 games had a winner.
- **The harness shapes the ranking.** In an earlier run, a model kept launching Gliders that could not physically reach a mid-board Heart, because the prompt itself suggested them. We fixed the prompt but kept the game unsolved. For example, we don't hand models the viable firing lanes.

**Caveat.** The top 3 CIs overlap. 2 games per pair can't separate them; it would take about 6.
