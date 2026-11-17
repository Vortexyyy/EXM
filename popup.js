const DEFAULTS = {
  enabled: true,
  arrows: true,
  panelVisible: true,
  onlyMyTurn: false,
  depth: 20,
  humanize: true,
  blunderRate: 20
};

const toggles = ["enabled", "panelVisible", "arrows", "onlyMyTurn", "humanize"];

function depthNote(d) {
  if (d <= 12) return "fast, ~2500 strength — club-killer";
  if (d <= 17) return "strong, around super-GM level";
  if (d <= 22) return "well past Magnus (~3200+)";
  return "full send — slow on long positions";
}

function blunderNote(rate) {
  if (rate <= 10) return "subtle (~94-96% accuracy, still risky)";
  if (rate <= 25) return "sweet spot (~86-92% accuracy, looks natural)";
  return "heavy human mistakes (~78-85% accuracy)";
}

chrome.storage.local.get(DEFAULTS).then((s) => {
  for (const id of toggles) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.checked = !!s[id];
    el.addEventListener("change", () => {
      chrome.storage.local.set({ [id]: el.checked });
      if (id === "humanize") {
        document.getElementById("blunderGroup").style.opacity = el.checked ? "1" : "0.4";
      }
    });
  }

  // Blunder slider
  const bRange = document.getElementById("blunderRate");
  const bGroup = document.getElementById("blunderGroup");
  const showB = () => {
    document.getElementById("bv").textContent = bRange.value + "%";
    document.getElementById("bn").textContent = blunderNote(+bRange.value);
  };
  bRange.value = s.blunderRate || 20;
  showB();
  if (!s.humanize) bGroup.style.opacity = "0.4";
  bRange.addEventListener("input", showB);
  bRange.addEventListener("change", () => chrome.storage.local.set({ blunderRate: +bRange.value }));

  // Depth slider
  const range = document.getElementById("depth");
  const show = () => {
    document.getElementById("dv").textContent = range.value;
    document.getElementById("dn").textContent = depthNote(+range.value);
  };
  range.value = s.depth;
  show();
  range.addEventListener("input", show);
  range.addEventListener("change", () => chrome.storage.local.set({ depth: +range.value }));
});
