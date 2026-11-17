// EXM engine host: runs Stockfish 17.1 (full NNUE, single-threaded) with MultiPV 3.
const ENGINE = "engine/stockfish-17.1-single-a496a04.js";
const EMIT_EVERY_MS = 150;

const worker = new Worker(ENGINE);
const send = (cmd) => worker.postMessage(cmd);

let current = null; // job being searched
let pending = null; // job waiting for the current search to stop
let searching = false;

send("uci");
send("setoption name MultiPV value 3");
send("setoption name Hash value 128");
send("isready");

worker.onmessage = (e) => onLine(String(e.data));

function analyze(job) {
  if (searching) {
    pending = job; // newest position wins; anything queued before it is dropped
    send("stop");
  } else {
    start(job);
  }
}

function start(job) {
  current = { ...job, lines: [], depthSeen: 0, lastEmit: 0 };
  searching = true;
  send("position fen " + job.fen);
  send("go depth " + job.depth);
}

function onLine(line) {
  if (line.startsWith("info") && line.includes(" pv ") && current) {
    if (line.includes("lowerbound") || line.includes("upperbound")) return;
    const depth = +(line.match(/ depth (\d+)/) || [])[1];
    const mpv = +((line.match(/ multipv (\d+)/) || [])[1] || 1);
    const score = line.match(/ score (cp|mate) (-?\d+)/);
    const pv = (line.match(/ pv (.+)$/) || [])[1];
    if (!score || !pv) return;
    current.lines[mpv - 1] = { depth, type: score[1], value: +score[2], pv: pv.trim().split(/\s+/) };
    current.depthSeen = Math.max(current.depthSeen, depth);
    const now = Date.now();
    if (now - current.lastEmit > EMIT_EVERY_MS) {
      current.lastEmit = now;
      emit(current, false);
    }
  } else if (line.startsWith("bestmove")) {
    searching = false;
    const finished = current;
    current = null;
    if (pending) {
      const next = pending;
      pending = null;
      start(next);
    } else if (finished) {
      emit(finished, true);
    }
  }
}

function emit(job, done) {
  chrome.runtime
    .sendMessage({
      target: "exm-bg",
      type: "update",
      tabId: job.tabId,
      id: job.id,
      depth: job.depthSeen,
      lines: job.lines.filter(Boolean),
      done,
    })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "exm-offscreen") return;
  if (msg.type === "analyze") analyze(msg);
});
