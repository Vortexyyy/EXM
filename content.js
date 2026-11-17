// EXM content script: reads the chess.com board, asks the engine, draws arrows + the top-3 panel.
(() => {
  if (window.__exmLoaded) return;
  window.__exmLoaded = true;

  const S = {
    enabled: true,
    arrows: true,
    panelVisible: true,
    onlyMyTurn: false,
    depth: 20,
    panelPos: null,
    humanize: true,
    blunderRate: 20, // percentage chance of recommending a 2nd or 3rd tier move
    showBlunders: true
  };
  const COLORS = ["#3ddc6f", "#3ddc6f", "#ff9a2e"];
  const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
  const GLYPH = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "", k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "" };

  let board = null;
  let observer = null;
  let svg = null;
  let scanTimer = null;
  let lastKey = "";
  let reqId = 0;
  let latestId = 0;
  let ctx = null; // { grid, turn, flipped, fen } for the position being analyzed
  let lastLines = null;
  let manualFlipFor = null; // placement string the user hit ⇄ on
  const turnCache = new Map();

  // ---------- board reading ----------

  function findBoard() {
    const cands = [...document.querySelectorAll("wc-chess-board, chess-board")].filter((b) => b.querySelector(".piece"));
    if (!cands.length) return null;
    return cands.reduce((a, b) => (b.getBoundingClientRect().width > a.getBoundingClientRect().width ? b : a));
  }

  const squareOf = (el) => {
    const m = typeof el.className === "string" && el.className.match(/\bsquare-(\d)(\d)\b/);
    return m ? { f: +m[1] - 1, r: +m[2] - 1 } : null;
  };

  // grid[rank][file], rank 0 = rank 1, file 0 = a. Uppercase = white.
  function readGrid(b) {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    let wk = 0, bk = 0;
    for (const el of b.querySelectorAll(".piece")) {
      const p = typeof el.className === "string" && el.className.match(/\b([wb])([pnbrqk])\b/);
      const sq = squareOf(el);
      if (!p || !sq) continue;
      const pc = p[1] === "w" ? p[2].toUpperCase() : p[2];
      grid[sq.r][sq.f] = pc;
      if (pc === "K") wk++;
      if (pc === "k") bk++;
    }
    if (wk !== 1 || bk !== 1) return null;
    for (let f = 0; f < 8; f++) {
      if ((grid[0][f] || "").toLowerCase() === "p" || (grid[7][f] || "").toLowerCase() === "p") return null; // mid-promotion
    }
    return grid;
  }

  function placementOf(g) {
    let out = "";
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const pc = g[r][f];
        if (!pc) empty++;
        else {
          if (empty) out += empty;
          empty = 0;
          out += pc;
        }
      }
      if (empty) out += empty;
      if (r) out += "/";
    }
    return out;
  }

  // Last-move highlights: whichever highlighted square holds a piece, that colour just moved.
  // Only trusted with exactly 2 highlights (a selected piece or premove adds more).
  function highlightInfo(b, g) {
    const hl = [...b.querySelectorAll(".highlight")].map(squareOf).filter(Boolean);
    if (hl.length !== 2) return null;
    for (const s of hl) {
      const pc = g[s.r][s.f];
      if (pc) return { turn: pc === pc.toUpperCase() ? "b" : "w", squares: hl, moved: s, piece: pc };
    }
    return null;
  }

  function attacked(g, r, f, byWhite) {
    const at = (rr, ff) => (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 ? g[rr][ff] : null);
    const is = (pc, t) => !!pc && pc === (byWhite ? t.toUpperCase() : t);
    const pr = byWhite ? r - 1 : r + 1;
    if (is(at(pr, f - 1), "p") || is(at(pr, f + 1), "p")) return true;
    for (const [dr, df] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]])
      if (is(at(r + dr, f + df), "n")) return true;
    for (const [dr, df] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]])
      if (is(at(r + dr, f + df), "k")) return true;
    const slide = (dirs, types) => {
      for (const [dr, df] of dirs) {
        let rr = r + dr, ff = f + df;
        while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
          const pc = g[rr][ff];
          if (pc) {
            if (types.some((t) => is(pc, t))) return true;
            break;
          }
          rr += dr;
          ff += df;
        }
      }
      return false;
    };
    return (
      slide([[1, 1], [1, -1], [-1, 1], [-1, -1]], ["b", "q"]) ||
      slide([[1, 0], [-1, 0], [0, 1], [0, -1]], ["r", "q"])
    );
  }

  function findPiece(g, pc) {
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) if (g[r][f] === pc) return { r, f };
    return null;
  }

  function castling(g) {
    let c = "";
    if (g[0][4] === "K") {
      if (g[0][7] === "R") c += "K";
      if (g[0][0] === "R") c += "Q";
    }
    if (g[7][4] === "k") {
      if (g[7][7] === "r") c += "k";
      if (g[7][0] === "r") c += "q";
    }
    return c || "-";
  }

  function enPassant(hi, turn) {
    if (!hi || hi.piece.toLowerCase() !== "p") return "-";
    const [a, b] = hi.squares;
    if (a.f !== b.f || Math.abs(a.r - b.r) !== 2) return "-";
    if (turn === "w" && hi.piece === "p" && hi.moved.r === 4) return String.fromCharCode(97 + a.f) + "6";
    if (turn === "b" && hi.piece === "P" && hi.moved.r === 3) return String.fromCharCode(97 + a.f) + "3";
    return "-";
  }

  // ---------- move formatting ----------

  function play(g, uci) {
    const n = g.map((row) => row.slice());
    const ff = uci.charCodeAt(0) - 97, fr = +uci[1] - 1, tf = uci.charCodeAt(2) - 97, tr = +uci[3] - 1, promo = uci[4];
    const pc = n[fr][ff];
    if (!pc) return n;
    n[fr][ff] = null;
    if (pc.toLowerCase() === "p" && ff !== tf && !n[tr][tf]) n[fr][tf] = null; // en passant
    if (pc.toLowerCase() === "k" && Math.abs(tf - ff) === 2) {
      const rf = tf > ff ? 7 : 0, nf = tf > ff ? 5 : 3;
      n[fr][nf] = n[fr][rf];
      n[fr][rf] = null;
    }
    n[tr][tf] = promo ? (pc === pc.toUpperCase() ? promo.toUpperCase() : promo) : pc;
    return n;
  }

  function san(g, uci) {
    const ff = uci.charCodeAt(0) - 97, fr = +uci[1] - 1, tf = uci.charCodeAt(2) - 97, tr = +uci[3] - 1, promo = uci[4];
    const pc = g[fr]?.[ff];
    if (!pc) return uci;
    const t = pc.toLowerCase();
    const cap = !!g[tr][tf] || (t === "p" && ff !== tf);
    const dest = uci.slice(2, 4);
    if (t === "k" && Math.abs(tf - ff) === 2) return tf > ff ? "O-O" : "O-O-O";
    if (t === "p") return (cap ? uci[0] + "x" : "") + dest + (promo ? "=" + promo.toUpperCase() : "");
    return t.toUpperCase() + (cap ? "x" : "") + dest;
  }

  function pvText(g, pv, max = 7) {
    const out = [];
    let cur = g;
    for (const mv of pv.slice(0, max)) {
      out.push(san(cur, mv));
      cur = play(cur, mv);
    }
    return out.join(" ");
  }

  function evalText(line) {
    if (line.type === "mate") return (line.value < 0 ? "-M" : "M") + Math.abs(line.value);
    const v = line.value / 100;
    return (v > 0 ? "+" : "") + v.toFixed(2);
  }

  // ---------- panel (shadow DOM so chess.com CSS can't touch it) ----------

  const host = document.createElement("div");
  host.id = "exm-host";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      .panel{position:fixed;width:280px;z-index:2147483647;background:#15171c;color:#e8e8ea;
        font:13px/1.35 "Segoe UI",system-ui,sans-serif;border:1px solid #2c2f38;border-radius:10px;
        box-shadow:0 12px 32px rgba(0,0,0,.5);overflow:hidden;user-select:none}
      .hd{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1d2027;cursor:move}
      .logo{font-weight:900;letter-spacing:3px;color:#7cf29c}
      .dot{width:8px;height:8px;border-radius:50%;background:#555;flex:none}
      .dot.think{background:#f2c94c;animation:p 1s infinite}
      .dot.done{background:#7cf29c}
      .dot.err{background:#ff6b6b}
      @keyframes p{50%{opacity:.35}}
      .st{flex:1;color:#9aa0aa;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      button{all:unset;cursor:pointer;color:#9aa0aa;padding:0 4px;font-size:14px;line-height:1}
      button:hover{color:#fff}
      .bd{padding:6px 10px 10px}
      .turn{font-size:11px;color:#9aa0aa;display:flex;justify-content:space-between}
      .row{display:grid;grid-template-columns:22px 1fr auto;gap:2px 8px;align-items:center;
        padding:6px 8px;border-radius:7px;background:#1b1e24;margin-top:6px;border-left:3px solid transparent}
      .rk{width:20px;height:20px;border-radius:5px;display:grid;place-items:center;font-weight:800;color:#111;font-size:12px}
      .mv{font-size:16px;font-weight:700}
      .sq{font-size:11px;color:#8a909a;font-weight:400;margin-left:6px}
      .ev{font-variant-numeric:tabular-nums;font-weight:700}
      .pv{grid-column:2/4;font-size:11px;color:#8a909a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .empty{color:#8a909a;font-size:12px;padding:10px 2px 2px}
      .collapsed .bd{display:none}
      .hidden{display:none}
    </style>
    <div class="panel">
      <div class="hd">
        <span class="logo">EXM</span><span class="dot"></span><span class="st">looking for a board…</span>
        <button class="flip" title="Wrong side to move? Flip it">⇄</button>
        <button class="min" title="Collapse">–</button>
        <button class="close" title="Hide (Alt+X)">×</button>
      </div>
      <div class="bd">
        <div class="turn"><span class="who"></span><span class="hint">eval for side to move</span></div>
        <div class="lines"><div class="empty">open a game or analysis board</div></div>
      </div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const panel = $(".panel");

  function placePanel() {
    const pos = S.panelPos || { x: window.innerWidth - 300, y: 90 };
    const x = Math.min(Math.max(0, pos.x), window.innerWidth - 60);
    const y = Math.min(Math.max(0, pos.y), window.innerHeight - 40);
    panel.style.left = x + "px";
    panel.style.top = y + "px";
  }

  (function dragging() {
    let dx = 0, dy = 0, on = false;
    $(".hd").addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      on = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!on) return;
      panel.style.left = e.clientX - dx + "px";
      panel.style.top = e.clientY - dy + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!on) return;
      on = false;
      const r = panel.getBoundingClientRect();
      save({ panelPos: { x: Math.round(r.left), y: Math.round(r.top) } });
    });
  })();

  $(".min").addEventListener("click", () => panel.classList.toggle("collapsed"));
  $(".close").addEventListener("click", () => save({ panelVisible: false }));
  $(".flip").addEventListener("click", () => {
    if (!ctx) return;
    const placement = ctx.fen.split(" ")[0];
    manualFlipFor = manualFlipFor === placement ? null : placement;
    lastKey = "";
    scan();
  });
  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "x") save({ panelVisible: !S.panelVisible });
  });
  window.addEventListener("resize", placePanel);

  function setStatus(text, state) {
    $(".st").textContent = text;
    $(".dot").className = "dot" + (state ? " " + state : "");
  }

  function setEmpty(text) {
    $(".lines").innerHTML = `<div class="empty">${text}</div>`;
  }

  // Seeded/deterministic choice per FEN so lines don't flicker while thinking
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function getActiveMoveIndex(lines) {
    if (!S.humanize || !ctx || lines.length <= 1) return 0;
    const seed = hashString(ctx.fen);
    const roll = seed % 100;
    if (roll < S.blunderRate) {
      // Pick 2nd or 3rd move to play like a human
      if (lines.length >= 3 && (seed % 2 === 0)) return 2;
      return 1;
    }
    return 0;
  }

  function renderLines(lines) {
    if (!ctx) return;
    if (!lines.length) {
      setEmpty("no legal moves — game over");
      clearArrows();
      return;
    }
    const recIdx = getActiveMoveIndex(lines);
    $(".lines").innerHTML = lines
      .slice(0, 3)
      .map((l, i) => {
        const mv = l.pv[0];
        const pc = ctx.grid[+mv[1] - 1][mv.charCodeAt(0) - 97] || "";
        const isRec = i === recIdx;
        const tag = S.humanize && isRec ? (i === 0 ? `<span class="rec-badge" style="background:#2a4a34;color:#7cf29c;font-size:10px;padding:2px 5px;border-radius:4px;margin-left:6px">BEST</span>` : `<span class="rec-badge" style="background:#553a1a;color:#ffb454;font-size:10px;padding:2px 5px;border-radius:4px;margin-left:6px">HUMAN</span>`) : "";
        return `<div class="row" style="border-left-color:${COLORS[i]}; ${isRec && S.humanize ? 'background:#242831;' : ''}">
          <span class="rk" style="background:${COLORS[i]}">${i + 1}</span>
          <span class="mv">${GLYPH[pc] || ""} ${san(ctx.grid, mv)}<span class="sq">${mv.slice(0, 2)}→${mv.slice(2, 4)}</span>${tag}</span>
          <span class="ev">${evalText(l)}</span>
          <span class="pv">${pvText(ctx.grid, l.pv)}</span>
        </div>`;
      })
      .join("");
    drawArrows(lines);
  }

  // ---------- arrows ----------

  function ensureSvg() {
    if (svg && svg.isConnected && svg.parentNode === board) return svg;
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 800 800");
    svg.setAttribute("id", "exm-arrows");
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
    if (getComputedStyle(board).position === "static") board.style.position = "relative";
    board.appendChild(svg);
    return svg;
  }

  function center(sq, flipped) {
    const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
    return flipped ? [(7 - f) * 100 + 50, r * 100 + 50] : [f * 100 + 50, (7 - r) * 100 + 50];
  }

  function drawArrows(lines) {
    if (!S.arrows || !S.enabled || !board || !ctx) return clearArrows();
    const s = ensureSvg();
    const recIdx = getActiveMoveIndex(lines);
    // If humanize is on and we want to highlight the human choice, we adjust arrow thickness & prominence
    let widths = [24, 10, 7];
    let alphas = [0.9, 0.75, 0.75];
    if (S.humanize && recIdx > 0) {
      // Give the selected human move prominence so you know what to play to stay undetected
      widths = [12, 12, 12];
      widths[recIdx] = 22;
      widths[0] = 10;
      alphas[recIdx] = 0.95;
      alphas[0] = 0.6;
    }

    let defs = "", body = "";
    lines.slice(0, 3).reverse().forEach((l, ri) => {
      const i = Math.min(lines.length, 3) - 1 - ri;
      const mv = l.pv[0];
      const [x1, y1] = center(mv.slice(0, 2), ctx.flipped);
      const [x2, y2] = center(mv.slice(2, 4), ctx.flipped);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const sx = x1 + ux * 22, sy = y1 + uy * 22; // start just off the piece centre
      const ex = x2 - ux * 28, ey = y2 - uy * 28; // leave room for the head
      const head = [2.6, 4, 4.6][i]; // thin lines get relatively bigger heads so they stay readable
      defs += `<marker id="exm-h${i}" viewBox="0 0 10 10" refX="3" refY="5" markerWidth="${head}" markerHeight="${head}" orient="auto">
        <path d="M0,0 L10,5 L0,10 z" fill="${COLORS[i]}"/></marker>`;
      body += `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="${COLORS[i]}" stroke-width="${widths[i]}"
        stroke-linecap="round" opacity="${alphas[i]}" marker-end="url(#exm-h${i})"/>`;
    });
    s.innerHTML = `<defs>${defs}</defs>${body}`;
  }

  function clearArrows() {
    if (svg) svg.innerHTML = "";
  }

  // ---------- main loop ----------

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 120);
  }

  function attach(b) {
    observer?.disconnect();
    svg?.remove();
    svg = null;
    board = b;
    lastKey = "";
    if (!b) {
      ctx = null;
      setStatus("looking for a board…", "");
      setEmpty("open a game or analysis board");
      return;
    }
    observer = new MutationObserver((muts) => {
      if (muts.every((m) => svg && (m.target === svg || svg.contains(m.target)))) return;
      scheduleScan();
    });
    observer.observe(b, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    scan();
  }

  function scan() {
    if (!S.enabled || !board) return;
    const grid = readGrid(board);
    if (!grid) return;
    const flipped = board.classList.contains("flipped");
    const placement = placementOf(grid);
    const hi = highlightInfo(board, grid);

    let turn = hi?.turn || turnCache.get(placement) || (placement === START ? "w" : flipped ? "b" : "w");
    const wk = findPiece(grid, "K"), bk = findPiece(grid, "k");
    const wChk = attacked(grid, wk.r, wk.f, false);
    const bChk = attacked(grid, bk.r, bk.f, true);
    if (wChk && bChk) return setStatus("can't read this position", "err");
    if (turn === "w" && bChk) turn = "b"; // side not to move can't be in check
    if (turn === "b" && wChk) turn = "w";
    turnCache.set(placement, turn);
    if (manualFlipFor && manualFlipFor !== placement) manualFlipFor = null;
    if (manualFlipFor === placement) {
      const flippedTurn = turn === "w" ? "b" : "w";
      if (!(flippedTurn === "w" ? bChk : wChk)) turn = flippedTurn;
    }

    const fen = `${placement} ${turn} ${castling(grid)} ${enPassant(hi, turn)} 0 1`;
    const key = `${fen}|${flipped}|${S.depth}|${S.onlyMyTurn}`;
    if (key === lastKey) {
      if (S.arrows && lastLines && (!svg || !svg.isConnected)) drawArrows(lastLines); // board re-rendered under us
      return;
    }
    lastKey = key;
    ctx = { grid, turn, flipped, fen };
    lastLines = null;
    $(".who").textContent = (turn === "w" ? "White" : "Black") + " to move";

    const mine = flipped ? "b" : "w";
    if (S.onlyMyTurn && turn !== mine) {
      latestId = 0;
      clearArrows();
      setStatus("opponent's turn", "");
      setEmpty("waiting for your move…");
      return;
    }

    latestId = ++reqId;
    setStatus("thinking…", "think");
    try {
      chrome.runtime.sendMessage({ type: "exm-analyze", id: latestId, fen, depth: S.depth }).catch(onDeadContext);
    } catch (e) {
      onDeadContext(e);
    }
  }

  function onDeadContext() {
    setStatus("extension reloaded — refresh the page", "err");
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "exm-update" || msg.id !== latestId || !S.enabled) return;
    if (msg.error) return setStatus(msg.error, "err");
    lastLines = msg.lines;
    renderLines(msg.lines);
    setStatus(msg.done ? `depth ${msg.depth} ✓` : `thinking… d${msg.depth}`, msg.done ? "done" : "think");
  });

  // ---------- settings ----------

  function save(patch) {
    Object.assign(S, patch);
    chrome.storage.local.set(patch).catch(() => {});
    apply();
  }

  function apply() {
    panel.classList.toggle("hidden", !S.enabled || !S.panelVisible);
    placePanel();
    if (!S.enabled) {
      clearArrows();
      latestId = 0;
      lastKey = "";
      return;
    }
    if (!S.arrows) clearArrows();
    else if (lastLines) drawArrows(lastLines);
    scan();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let rescan = false;
    for (const [k, v] of Object.entries(changes)) {
      S[k] = v.newValue;
      if (k === "depth" || k === "onlyMyTurn" || k === "enabled" || k === "humanize" || k === "blunderRate") rescan = true;
    }
    if (rescan) lastKey = "";
    apply();
  });

  chrome.storage.local.get(S).then((v) => {
    Object.assign(S, v);
    document.documentElement.appendChild(host);
    apply();
    attach(findBoard());
    // chess.com is an SPA: boards come and go without page loads
    setInterval(() => {
      const b = findBoard();
      if (b !== board) attach(b);
    }, 1000);
  });
})();
