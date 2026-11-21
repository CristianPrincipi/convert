// linux-local: the right-click conversion wheel. Inner ring: categories; resting on one opens an
// outer "aura" with its formats. The main process (src/electron-linux.cjs) sends the formats the
// file can reach ("wheel:show") and the cursor position ("wheel:place"), and gets the choice back.
"use strict";

const bridge = window.desktopWheel;
const NS = "http://www.w3.org/2000/svg";
const C = 210;
const R0 = 58;
const R1 = 122;
const R2 = 130;
const R3 = 196;
const GAP = 2.5;
const CELL = 44;
const DWELL = 230;
const BOX = 420;
const COLORS = { img: "--c-img", doc: "--c-doc", data: "--c-data", arc: "--c-arc", av: "--c-av" };

const wheelEl = document.getElementById("wheel");
let state = null;

const point = (r, a) => `${(C + r * Math.cos(a)).toFixed(2)} ${(C + r * Math.sin(a)).toFixed(2)}`;

function band(r0, r1, a0, a1, gap = GAP) {
  const po = gap / r1;
  const pi = gap / r0;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${point(r1, a0 + po)} A${r1} ${r1} 0 ${large} 1 ${point(r1, a1 - po)} L${point(r0, a1 - pi)} A${r0} ${r0} 0 ${large} 0 ${point(r0, a0 + pi)} Z`;
}

function svg(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function label(lines, x, y, lineHeight) {
  const text = svg("text", {
    x: x.toFixed(1),
    y: (y - ((lines.length - 1) * lineHeight) / 2).toFixed(1),
  });
  lines.forEach((line, i) => {
    const span = svg("tspan", { x: x.toFixed(1) });
    if (i) span.setAttribute("dy", String(lineHeight));
    span.textContent = line;
    text.append(span);
  });
  return text;
}

const stem = (name) => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);

/* ---------- building ---------- */

function build(data) {
  wheelEl.textContent = "";
  wheelEl.className = "wheel";
  const cats = data.categories.map((c) => ({ ...c, color: COLORS[c.id] ?? "--wheel-muted" }));
  state = {
    data,
    cats,
    hover: -1,
    open: -1,
    fmt: -1,
    level: "cat",
    timer: 0,
    hubHover: false,
    fmtEls: [],
  };

  const root = svg("svg", { viewBox: `0 0 ${BOX} ${BOX}` });
  const defs = svg("defs");
  const blur = svg("filter", {
    id: "auraBlur",
    x: "-30%",
    y: "-30%",
    width: "160%",
    height: "160%",
  });
  blur.append(svg("feGaussianBlur", { stdDeviation: "9" }));
  defs.append(blur);
  root.append(defs);

  state.auraG = svg("g", { class: "aura" });
  const base = svg("g", { class: "base" });
  const step = (Math.PI * 2) / cats.length;
  const start = -Math.PI / 2 - step / 2;
  cats.forEach((cat, i) => {
    const a0 = start + i * step;
    const a1 = a0 + step;
    cat.mid = (a0 + a1) / 2;
    const g = svg("g", {
      class: "cat" + (cat.items.length ? "" : " off"),
      role: "menuitem",
      "aria-label": `${cat.name}: ${cat.items.length} formati`,
    });
    g.style.setProperty("--cc", `var(${cat.color})`);
    g.append(svg("path", { class: "body", d: band(R0, R1, a0, a1) }));
    g.append(svg("path", { class: "edge", d: band(R1 - 4, R1, a0, a1) }));
    const rm = (R0 + R1) / 2 + 2;
    g.append(label(cat.label, C + rm * Math.cos(cat.mid), C + rm * Math.sin(cat.mid), 14));
    g.addEventListener("pointerenter", () => hoverCat(i));
    g.addEventListener("pointerleave", () => {
      if (state && state.hover === i) {
        clearTimeout(state.timer);
        state.hover = -1;
        paintCats();
        updateHub();
      }
    });
    g.addEventListener("click", () => {
      if (cat.items.length) openAura(i);
    });
    base.append(g);
  });
  root.append(state.auraG, base);
  wheelEl.append(root);
  state.catEls = [...base.children];

  const hub = document.createElement("div");
  hub.className = "hub";
  hub.innerHTML = '<div class="lvl"></div><div class="main"></div><div class="sub"></div>';
  hub.addEventListener("pointerenter", () => {
    state.hubHover = true;
    updateHub();
  });
  hub.addEventListener("pointerleave", () => {
    if (!state) return;
    state.hubHover = false;
    updateHub();
  });
  hub.addEventListener("click", () => bridge.openApp());
  wheelEl.append(hub);
  state.hub = hub;
  updateHub();
}

function place(where) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const insets = where?.insets ?? { top: 0, left: 0, right: 0, bottom: 0 };
  const s = Math.min(
    1,
    (W - 12) / (2 * R3 + 12),
    (H - insets.top - insets.bottom - 12) / (2 * R3 + 12),
  );
  const half = (R3 + 6) * s;
  const x0 = where ? where.x : W / 2;
  const y0 = where ? where.y : H / 2;
  const x = Math.max(insets.left + half, Math.min(x0, W - insets.right - half));
  const y = Math.max(insets.top + half, Math.min(y0, H - insets.bottom - half));
  wheelEl.style.left = `${x}px`;
  wheelEl.style.top = `${y}px`;
  wheelEl.style.setProperty("--s", String(s));
  wheelEl.hidden = false;
  wheelEl.classList.add("pop");
  wheelEl.focus({ preventScroll: true });
}

/* ---------- categories and aura ---------- */

function hoverCat(i) {
  state.hover = i;
  paintCats();
  updateHub();
  clearTimeout(state.timer);
  if (state.cats[i].items.length && state.open !== i)
    state.timer = setTimeout(() => openAura(i), DWELL);
}

function paintCats() {
  state.catEls.forEach((g, j) => {
    g.classList.toggle("hover", j === state.hover && j !== state.open);
    g.classList.toggle("open", j === state.open);
  });
}

function openAura(i) {
  clearTimeout(state.timer);
  const cat = state.cats[i];
  if (!cat.items.length) return;
  state.open = i;
  state.fmt = -1;
  paintCats();
  const g = state.auraG;
  g.textContent = "";
  g.style.setProperty("--cc", `var(${cat.color})`);
  const n = cat.items.length;
  const da = CELL / ((R2 + R3) / 2);
  const a0 = cat.mid - (n * da) / 2;
  g.append(
    svg("path", {
      class: "glow",
      d: band(R2 - 10, R3 + 14, a0 - 0.08, a0 + n * da + 0.08, 0),
      filter: "url(#auraBlur)",
    }),
  );
  state.fmtEls = cat.items.map((item, k) => {
    const b0 = a0 + k * da;
    const mid = b0 + da / 2;
    const fg = svg("g", {
      class: "fmt",
      role: "menuitem",
      "aria-label": `${item.label}: ${item.desc}`,
    });
    fg.style.animationDelay = `${k * 16}ms`;
    fg.append(svg("path", { d: band(R2, R3, b0, b0 + da) }));
    const rm = (R2 + R3) / 2;
    fg.append(label([item.label], C + rm * Math.cos(mid), C + rm * Math.sin(mid), 14));
    fg.addEventListener("pointerenter", () => {
      clearTimeout(state.timer);
      setFmt(k);
    });
    fg.addEventListener("pointerleave", () => {
      if (state && state.fmt === k) setFmt(-1);
    });
    fg.addEventListener("click", () => choose(item));
    g.append(fg);
    return fg;
  });
  updateHub();
}

function closeAura() {
  state.open = -1;
  state.fmt = -1;
  state.level = "cat";
  state.auraG.textContent = "";
  paintCats();
  updateHub();
}

function setFmt(k) {
  state.fmt = k;
  state.fmtEls.forEach((g, j) => g.classList.toggle("on", j === k));
  updateHub();
}

function updateHub() {
  const hub = state.hub;
  const [lvl, main, sub] = hub.children;
  const files = state.data.files;
  const openCat = state.cats[state.open];
  const hovCat = state.cats[state.hover];
  hub.style.removeProperty("--hc");
  if (state.hubHover) {
    lvl.textContent = "Centro";
    main.textContent = "Apri Convert completo";
    sub.textContent = "tutti i formati";
  } else if (openCat && state.fmt >= 0) {
    const item = openCat.items[state.fmt];
    hub.style.setProperty("--hc", `var(${openCat.color})`);
    lvl.textContent = openCat.name;
    main.textContent = item.desc;
    sub.textContent =
      files.length > 1 ? `${files.length} file → .${item.ext}` : `→ ${stem(files[0])}.${item.ext}`;
  } else if (hovCat && state.hover !== state.open) {
    hub.style.setProperty("--hc", `var(${hovCat.color})`);
    lvl.textContent = hovCat.name;
    main.textContent = hovCat.items.length
      ? `${hovCat.items.length} formati`
      : "Non disponibile per questo file";
    sub.textContent = hovCat.items.length ? "resta fermo per aprire" : "";
  } else if (openCat) {
    hub.style.setProperty("--hc", `var(${openCat.color})`);
    lvl.textContent = openCat.name;
    main.textContent = "Scegli il formato";
    sub.textContent = `${openCat.items.length} disponibili`;
  } else {
    lvl.textContent = state.data.source ?? "File";
    main.textContent = files.length > 1 ? `${files.length} file` : files[0];
    sub.textContent = "scegli una categoria";
  }
}

function choose(item) {
  state = null;
  wheelEl.hidden = true;
  bridge.choose(item.id);
}

function cancel() {
  if (state) clearTimeout(state.timer);
  state = null;
  wheelEl.hidden = true;
  bridge.cancel();
}

/* ---------- keyboard and clicks outside ---------- */

function keyCat(i) {
  clearTimeout(state.timer);
  state.hover = i;
  paintCats();
  updateHub();
}

document.addEventListener("keydown", (e) => {
  if (!state) return;
  const cats = state.cats;
  const nextCat = (from, d) => {
    for (let s = 1; s <= cats.length; s++) {
      const j = (((from + d * s) % cats.length) + cats.length) % cats.length;
      if (cats[j].items.length) return j;
    }
    return from;
  };
  const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
  const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
  const enter = e.key === "Enter" || e.key === " ";
  if (state.level === "cat") {
    const cur = state.hover >= 0 ? state.hover : state.open;
    if (forward) keyCat(nextCat(cur < 0 ? -1 : cur, 1));
    else if (back) keyCat(nextCat(cur < 0 ? 0 : cur, -1));
    else if (enter && cur >= 0 && cats[cur].items.length) {
      openAura(cur);
      state.level = "fmt";
      setFmt(0);
    } else if (e.key === "Escape") cancel();
    else return;
  } else {
    const n = state.fmtEls.length;
    if (forward) setFmt((state.fmt + 1) % n);
    else if (back) setFmt(state.fmt <= 0 ? n - 1 : state.fmt - 1);
    else if (enter && state.fmt >= 0) choose(cats[state.open].items[state.fmt]);
    else if (e.key === "Escape" || e.key === "Backspace") {
      const open = state.open;
      closeAura();
      keyCat(open);
    } else return;
  }
  e.preventDefault();
});

// Anything that isn't a category, a format or the center closes the wheel
document.addEventListener("pointerdown", (e) => {
  if (!state) return;
  if (e.button !== 0 || !e.target.closest?.(".cat, .fmt, .hub")) {
    e.preventDefault();
    cancel();
  }
});
document.addEventListener("contextmenu", (e) => e.preventDefault());

bridge.onShow((data) => {
  wheelEl.hidden = true;
  build(data);
});
bridge.onPlace((where) => {
  if (state) place(where);
});
