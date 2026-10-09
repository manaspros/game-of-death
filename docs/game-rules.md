# Game rules and harness design

## How a match works

| | |
|---|---|
| **Board** | 48×40 (`skirmish` preset). Each player has a 14-column build zone on its own side. |
| **Heart** | Each player places a fixed 10-cell Heart once. Hearts start at 100 HP. |
| **Build** | Each round a model gets 30 moves (1 move = 1 live cell). It places patterns such as LWSS, Glider, Acorn and blocks through native tool calls: `place`, `save_blueprint`, `end_turn`. |
| **Simulate** | 160 generations of per-player B3/S23. Each owner's cells evolve using only their own neighbours. A square where both players would give birth stays empty. Opposing cells that touch annihilate. |
| **Damage** | Each enemy cell inside a Heart zone deals 10 HP and is removed. At most 5 cells count per generation, so a Heart takes at most 50 HP per generation. Heart zones are cleared at the end of every round. |
| **Feedback** | A counterfactual post-mortem, e.g. *"LWSS@8,20: alone it hits their Heart box from generation 57 and deals 58"*. The model also keeps its own notes and the last few rounds of history. |
| **Win** | A Heart at 0 HP is a KO. Otherwise the higher HP after N rounds wins. |

<p align="center">
  <img src="../assets/readme/board.png" alt="Opus's tandem LWSS in flight toward Gemini's Heart" width="49%">
  <img src="../assets/readme/opus-reasoning.png" alt="Opus's analysis between rounds" width="49%">
</p>
<p align="center"><sub>Left: Opus's two LWSS flying in tandem at Gemini's Heart. Right: Opus between rounds: <i>"together dealt 50 … it works, so I repeat it."</i></sub></p>

## Harness design

- **Stateless calls.** Each turn gets the system prompt plus a JSON observation: board, zones, HP, budget, history, notes and post-mortem. Temperature is 0.3.
- **Bad responses.** A model gets 2 attempts per bad response, plus one escalated retry if the output was truncated for length. After that the turn is skipped, and unspent moves are lost.
- **Cost guards.** There is a per-match USD cap and a total cap, and in-flight calls are reserved before they're sent. A match that hits its cap or loses its provider is void and excluded from ratings.
- **Full trace.** Every call's analysis, rationale, notes, tokens and cost are logged to JSONL. Every finished match is rendered to mp4 with headless Chrome and ffmpeg.

## Project layout

```
src/engine/       Life engine: per-player rules, collisions, Heart damage
src/game/         Game state, presets, pattern library
src/bench/        LLM harness: providers, loop, observation, post-mortem
  tournament.ts   Round-robin runner (seat swap, sharding, resume, cost caps)
  leaderboard.ts  Bradley-Terry + bootstrap CI
  studio/         Local web studio (start matches, watch, export)
  video/          Headless replay → mp4
src/spectate/     Live spectator and replay renderer
```
