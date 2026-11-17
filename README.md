<p align="center">
  <img src="docs/banner.svg" alt="EXM" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/chromium-MV3-34d399?style=for-the-badge&labelColor=0b0a24" alt="chromium">
  <img src="https://img.shields.io/badge/stockfish-17.1-facc15?style=for-the-badge&labelColor=0b0a24" alt="stockfish">
  <img src="https://img.shields.io/badge/runs-100%25%20local-22d3ee?style=for-the-badge&labelColor=0b0a24" alt="runs">
  <a href="https://github.com/Vortexyyy/EXM/stargazers"><img src="https://img.shields.io/github/stars/Vortexyyy/EXM?style=for-the-badge&color=facc15&labelColor=0b0a24&logo=github" alt="Stars"></a>
</p>

<h3 align="center">A Chromium extension that reads the chess.com board and shows Stockfish's top 3 moves, locally.</h3>

<p align="center"><b>⭐ Like it? <a href="https://github.com/Vortexyyy/EXM/stargazers">Drop a star</a>. It's free, takes a second, and helps others find it. ⭐</b></p>

---


Brave/Chromium MV3 extension for chess.com. Reads the board, runs Stockfish 17.1 (full NNUE, single-threaded WASM) locally, and shows the top 3 moves in a draggable panel with arrows drawn on the board.

> **Use it for analysis and learning.** Using engine help in rated or live games against other people breaks chess.com's fair-play rules and can get your account closed. Stick to analysis boards, puzzles, bot games and reviewing your own games.

## Install
1. Go to `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open chess.com and open the analysis board. The panel shows up on the right.

## Controls
- **Toolbar popup**: enable/disable, panel, arrows, only-on-my-turn, depth (8-30).
- **Panel**: drag it by the header. `-` collapses it, `x` hides it, the flip button switches side-to-move if EXM got it wrong.
- **Alt+X**: show/hide the panel.

## How it works
- `content.js` reads the `.piece` elements inside `wc-chess-board`, works out side-to-move from the last-move highlights (with a check-legality fallback), builds a FEN, and watches for changes with a MutationObserver.
- `background.js` starts `offscreen.html`, which runs Stockfish in a Web Worker with `MultiPV 3` and streams lines back as depth increases.
- Everything runs locally. No network calls apart from chess.com itself, no analytics, no accounts.

## License
Stockfish is licensed under the GPL v3 (see `engine/LICENSE-stockfish.txt`), so this project is distributed under the same terms. Not affiliated with chess.com.

If it helps your chess, a star is appreciated.
