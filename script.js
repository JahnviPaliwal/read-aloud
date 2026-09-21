(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var synth = window.speechSynthesis;

  var src = $("#src"), reader = $("#reader"), bar = $("#bar"), statusEl = $("#status");
  var playBtn = $("#play"), pauseBtn = $("#pause"), restartBtn = $("#restart");
  var voiceSel = $("#voice"), rateEl = $("#rate"), pauseScaleEl = $("#pauseScale");
  var pitchEl = $("#pitch"), linePauseEl = $("#linePause"), voiceTip = $("#voiceTip");
  var zIn = $("#zIn"), zOut = $("#zOut"), zVal = $("#zVal");

  var SAMPLE =
    "# Welcome to Read Aloud\n\n" +
    "Paste any text or Markdown here, and I will read it to you, pausing at commas, full stops, and paragraph breaks. **Bold** and *italic* text is shown properly, and the symbols are never read out.\n\n" +
    "## How to jump around\n\n" +
    "- Switch to the Listen tab\n" +
    "- Double-click any word\n" +
    "  - I will pick up from exactly there\n" +
    "- [x] Tables, lists and quotes work too\n\n" +
    "| Feature | Works | Notes |\n" +
    "|---|:---:|---|\n" +
    "| Headings | Yes | Shown larger |\n" +
    "| Tables | Yes | Read cell by cell |\n" +
    "| Code blocks | Yes | Shown, not read aloud |\n\n" +
    "> Try pausing, resuming, or restarting: it works well, even in the middle of a sentence.";

  // =====================================================
  //  Text size (zoom)
  // =====================================================
  var ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.4];
  var zi = 3;
  try {
    var savedZ = ZOOMS.indexOf(parseFloat(localStorage.getItem("read-aloud-zoom")));
    if (savedZ > -1) zi = savedZ;
  } catch (e) {}

  function applyZoom(keepPlace) {
    document.documentElement.style.setProperty("--zoom", ZOOMS[zi]);
    zVal.textContent = Math.round(ZOOMS[zi] * 100) + "%";
    zOut.disabled = zi === 0;
    zIn.disabled = zi === ZOOMS.length - 1;
    try { localStorage.setItem("read-aloud-zoom", String(ZOOMS[zi])); } catch (e) {}
    if (keepPlace && !$("#paneListen").hidden && cur >= 0 && spans[cur]) {
      spans[cur].scrollIntoView({ block: "center" });
    }
  }
  zIn.addEventListener("click", function () { if (zi < ZOOMS.length - 1) { zi++; applyZoom(true); } });
  zOut.addEventListener("click", function () { if (zi > 0) { zi--; applyZoom(true); } });
  zVal.addEventListener("click", function () { zi = 3; applyZoom(true); });

  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    statusEl.textContent = "This browser does not support speech synthesis. Try Chrome, Edge, Safari or Firefox.";
    [playBtn, pauseBtn, restartBtn].forEach(function (b) { b.disabled = true; });
    applyZoom(false);
    return;
  }

  // ---------- state ----------
  var words = [];          // {parts, text, say, para, head, item, line, cell, row}
  var spans = [];
  var loadedText = null;
  var state = "idle";      // idle | playing | paused
  var resumeIdx = 0;
  var cur = -1;
  var token = 0;
  var gapTimer = null, estTimer = null, estCheck = null;
  var voices = [];
  var voiceChosenByUser = false;
  var textLang = "";

  // =====================================================
  //  Markdown parsing
  // =====================================================
  function isSep(l) {
    return l.indexOf("|") > -1 && l.indexOf("-") > -1 &&
      /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l);
  }

  function splitRow(line) {
    line = line.trim();
    if (line[0] === "|") line = line.slice(1);
    if (line.length && line[line.length - 1] === "|" && line[line.length - 2] !== "\\") line = line.slice(0, -1);
    var cells = [], buf = "", code = false;
    for (var c = 0; c < line.length; c++) {
      var ch = line[c];
      if (ch === "\\" && line[c + 1] === "|") { buf += "|"; c++; continue; }
      if (ch === "`") code = !code;
      if (ch === "|" && !code) { cells.push(buf.trim()); buf = ""; continue; }
      buf += ch;
    }
    cells.push(buf.trim());
    return cells;
  }

  function parseBlocks(text) {
    text = text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "")
      .replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(\n|$)/, "")      // front matter
      .replace(/<!--[\s\S]*?-->/g, "");                            // comments
    var lines = text.split("\n"), blocks = [], para = null, sawBlank = false, m, t;
    function flush() { if (para) { blocks.push(para); para = null; } }

    for (var n = 0; n < lines.length; n++) {
      var raw = lines[n];
      if (!raw.trim()) { flush(); sawBlank = true; continue; }
      var wasBlank = sawBlank;
      sawBlank = false;

      // fenced code block
      if ((m = raw.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/))) {
        flush();
        var fence = m[1], lang = m[2], code = [];
        var closer = new RegExp("^\\s{0,3}" + fence[0] + "{" + fence.length + ",}\\s*$");
        n++;
        while (n < lines.length && !closer.test(lines[n])) { code.push(lines[n]); n++; }
        blocks.push({ type: "code", lang: lang, text: code.join("\n") });
        continue;
      }

      // link reference definitions are not content
      if (/^\s{0,3}\[[^\]]+\]:\s+\S+/.test(raw)) { flush(); continue; }

      // table
      if (raw.indexOf("|") > -1 && n + 1 < lines.length && isSep(lines[n + 1])) {
        var head = splitRow(raw), sep = splitRow(lines[n + 1]);
        if (head.length === sep.length) {
          flush();
          var align = sep.map(function (c) {
            return /^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:-/.test(c) ? "left" : "";
          });
          var rows = [];
          n += 2;
          while (n < lines.length && lines[n].trim() && lines[n].indexOf("|") > -1) { rows.push(splitRow(lines[n])); n++; }
          n--;
          blocks.push({ type: "table", head: head, align: align, rows: rows });
          continue;
        }
      }

      if ((m = raw.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        flush(); blocks.push({ type: "h", level: m[1].length, lines: [m[2]] });
      } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) {
        flush(); blocks.push({ type: "hr" });
      } else if ((m = raw.match(/^\s*(?:>\s?)+(.*)$/))) {
        if (para && para.type === "q") para.lines.push(m[1]);
        else { flush(); para = { type: "q", lines: [m[1]] }; }
      } else if ((m = raw.match(/^(\s*)([-*+\u2022]|\d{1,3}[.)])\s+(.*)$/))) {
        flush();
        var item = { type: "li", indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), num: m[2], lines: [m[3]] };
        if ((t = m[3].match(/^\[([ xX])\]\s+(.*)$/))) { item.task = t[1] === " " ? " " : "x"; item.lines = [t[2]]; }
        blocks.push(item);
      } else if (!para && !wasBlank && blocks.length && blocks[blocks.length - 1].type === "li" && /^\s{2,}\S/.test(raw)) {
        blocks[blocks.length - 1].lines.push(raw.trim());        // wrapped list item
      } else if (!para && n + 1 < lines.length && /^\s{0,3}=+\s*$/.test(lines[n + 1])) {
        blocks.push({ type: "h", level: 1, lines: [raw.trim()] }); n++;        // setext h1
      } else if (!para && n + 1 < lines.length && /^\s{0,3}-{2,}\s*$/.test(lines[n + 1])) {
        blocks.push({ type: "h", level: 2, lines: [raw.trim()] }); n++;        // setext h2
      } else {
        if (para && para.type === "p") para.lines.push(raw.trim());
        else { flush(); para = { type: "p", lines: [raw.trim()] }; }
      }
    }
    flush();
    return blocks;
  }

  // light clean-up of inline HTML that shows up in Markdown files
  function prep(s) {
    return s.replace(/<br\s*\/?>/gi, " ")
      .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
      .replace(/<\/?(b|strong)>/gi, "**")
      .replace(/<\/?(i|em)>/gi, "*")
      .replace(/<\/?(p|div|span|a|img|u|sub|sup|small|center|kbd|mark|font|details|summary|h[1-6])(\s[^>]*)?\/?>/gi, "");
  }

  // Turns a line into styled segments: {t, b, i, s, c, href}
  function inline(str) {
    var segs = [], b = false, i = false, s = false, buf = "", p = 0;
    function flush() {
      if (buf) { segs.push({ t: buf, b: b, i: i, s: s, c: false, href: null }); buf = ""; }
    }
    while (p < str.length) {
      var ch = str[p], two = str.substr(p, 2), m;
      if (ch === "\\" && p + 1 < str.length && /[\\`*_{}\[\]()#+\-.!~>|]/.test(str[p + 1])) {
        buf += str[p + 1]; p += 2; continue;
      }
      if (ch === "`") {
        var e = str.indexOf("`", p + 1);
        if (e > p + 1) { flush(); segs.push({ t: str.slice(p + 1, e), b: b, i: i, s: s, c: true, href: null }); p = e + 1; continue; }
      }
      if (ch === "!" && str[p + 1] === "[" && (m = str.slice(p).match(/^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/))) {
        flush();
        segs.push({ t: m[1].trim() || "image", b: b, i: true, s: s, c: false, href: null });
        p += m[0].length; continue;
      }
      if (ch === "[" && (m = str.slice(p).match(/^\[([^\]]+)\]\(([^)\s]+)[^)]*\)/))) {
        flush();
        inline(m[1]).forEach(function (sg) { sg.b = sg.b || b; sg.i = sg.i || i; sg.s = sg.s || s; sg.href = m[2]; segs.push(sg); });
        p += m[0].length; continue;
      }
      if (two === "**" || two === "__") {
        if (b || (/\S/.test(str[p + 2] || "") && str.indexOf(two, p + 2) > -1)) { flush(); b = !b; p += 2; continue; }
      }
      if (two === "~~") {
        if (s || (/\S/.test(str[p + 2] || "") && str.indexOf("~~", p + 2) > -1)) { flush(); s = !s; p += 2; continue; }
      }
      if (ch === "*" || ch === "_") {
        var intraword = ch === "_" && !i && /\w/.test(str[p - 1] || "");
        if (!intraword && (i || (/\S/.test(str[p + 1] || "") && str.indexOf(ch, p + 1) > -1))) { flush(); i = !i; p += 1; continue; }
      }
      buf += ch; p++;
    }
    flush();
    return segs;
  }

  // Splits styled segments into words (a word can span several styles)
  function toWords(segs) {
    var out = [], w = null;
    segs.forEach(function (sg) {
      sg.t.split(/(\s+)/).forEach(function (pc) {
        if (!pc) return;
        if (/^\s+$/.test(pc)) { w = null; return; }
        if (!w) { w = { parts: [], para: false, head: false, item: false, line: false, cell: false, row: false }; out.push(w); }
        w.parts.push({ t: pc, b: sg.b, i: sg.i, s: sg.s, c: sg.c, href: sg.href });
      });
    });
    out.forEach(function (x) { x.text = x.parts.map(function (q) { return q.t; }).join(""); });
    return out;
  }

  function md(line) { return toWords(inline(prep(line))); }

  // What the narrator actually says: no markup symbols, emoji or raw URLs
  function speakable(text) {
    var t = text;
    if (/^(https?:\/\/|www\.)/i.test(t)) return "link" + (t.match(/[.,;:!?]+$/) || [""])[0];
    t = t.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "");
    t = t.replace(/^#+/, "").replace(/[*~`^|\\]+/g, "").replace(/_+/g, " ").trim();
    if (!/[\p{L}\p{N}]/u.test(t)) {
      var map = { "&": "and", "+": "plus", "=": "equals" };
      return map[t] || "";
    }
    return t;
  }

  // =====================================================
  //  Pauses
  // =====================================================
  var ABBR = /^(mr|mrs|ms|dr|prof|sr|jr|st|vs|[A-Z])\.$/;

  function basePause(w) {
    var core = w.text.replace(/["'\u201D\u2019\u00BB)\]}]+$/, "");
    var last = core.slice(-1), ms = 0;
    if (/[.!?\u0964\u2026]/.test(last)) {
      ms = ABBR.test(core.replace(/^["'\u201C\u2018(\[{]+/, "")) ? 0 : 650;
    } else if (/[;:]/.test(last)) ms = 420;
    else if (last === "," || last === "\u060C") ms = 280;
    else if (/[\u2014\u2013]/.test(last) || core === "-") ms = 300;
    return ms;
  }

  function pauseFor(k) {
    var w = words[k], ms = basePause(w);
    if (w.head) ms = Math.max(ms, 1100);
    else if (w.para) ms = Math.max(ms, 1000);
    else if (w.row) ms = Math.max(ms, 750);
    else if (w.cell) ms = Math.max(ms, 320);
    else if (w.item) ms = Math.max(ms, 550);
    else if (w.line && linePauseEl.checked) ms = Math.max(ms, 450);
    return ms;
  }

  // =====================================================
  //  Reader view
  // =====================================================
  function makeWordSpan(w, idx) {
    var s = document.createElement("span");
    s.className = "w";
    s.dataset.i = idx;
    w.parts.forEach(function (p) {
      if (!p.b && !p.i && !p.s && !p.c && !p.href) { s.appendChild(document.createTextNode(p.t)); return; }
      var e = document.createElement("span"), cl = [];
      if (p.b) cl.push("b");
      if (p.i) cl.push("i");
      if (p.s) cl.push("s");
      if (p.c) cl.push("c");
      if (p.href) cl.push("a");
      e.className = cl.join(" ");
      e.textContent = p.t;
      s.appendChild(e);
    });
    return s;
  }

  function build(text) {
    words = []; spans = [];
    reader.textContent = "";
    var stack = [];   // open lists: {el, indent, ordered, lastLi}

    function addWords(el, ws) {
      ws.forEach(function (w, wi) {
        w.say = speakable(w.text);
        words.push(w);
        var sp = makeWordSpan(w, words.length - 1);
        spans.push(sp);
        if (wi > 0) el.appendChild(document.createTextNode(" "));
        el.appendChild(sp);
      });
      return ws.length ? ws[ws.length - 1] : null;
    }

    function fillLines(el, lines) {
      var lastW = null;
      lines.forEach(function (line) {
        var ws = md(line);
        if (!ws.length) return;
        if (lastW) { lastW.line = true; el.appendChild(document.createElement("br")); }
        lastW = addWords(el, ws);
      });
      return lastW;
    }

    function listFor(bl) {
      while (stack.length && stack[stack.length - 1].indent > bl.indent) stack.pop();
      var top = stack[stack.length - 1];
      if (top && top.indent === bl.indent && top.ordered !== bl.ordered) { stack.pop(); top = stack[stack.length - 1]; }
      if (top && top.indent === bl.indent) return top;
      var parent = top && top.lastLi ? top.lastLi : reader;
      var el = document.createElement(bl.ordered ? "ol" : "ul");
      parent.appendChild(el);
      var entry = { el: el, indent: bl.indent, ordered: bl.ordered, lastLi: null };
      stack.push(entry);
      return entry;
    }

    function buildTable(bl) {
      var wrap = document.createElement("div");
      wrap.className = "tablewrap";
      var tbl = document.createElement("table");
      var thead = document.createElement("thead"), tbody = document.createElement("tbody");
      var lastAny = null;

      function row(cells, tag, parent) {
        var tr = document.createElement("tr"), lastW = null;
        for (var c = 0; c < bl.head.length; c++) {
          var td = document.createElement(tag);
          if (tag === "th") td.setAttribute("scope", "col");
          if (bl.align[c]) td.style.textAlign = bl.align[c];
          var lw = addWords(td, md(cells[c] || ""));
          if (lw) { lw.cell = true; lastW = lw; }
          tr.appendChild(td);
        }
        if (lastW) { lastW.cell = false; lastW.row = true; lastAny = lastW; }
        parent.appendChild(tr);
      }

      row(bl.head, "th", thead);
      bl.rows.forEach(function (r) { row(r, "td", tbody); });
      tbl.appendChild(thead);
      if (bl.rows.length) tbl.appendChild(tbody);
      wrap.appendChild(tbl);
      reader.appendChild(wrap);
      if (lastAny) lastAny.para = true;
    }

    parseBlocks(text).forEach(function (bl) {
      if (bl.type !== "li") stack = [];

      if (bl.type === "hr") {
        reader.appendChild(document.createElement("hr"));
        if (words.length) words[words.length - 1].para = true;
        return;
      }
      if (bl.type === "code") {
        var pre = document.createElement("pre"), code = document.createElement("code");
        code.textContent = bl.text;
        pre.appendChild(code);
        reader.appendChild(pre);
        if (words.length) words[words.length - 1].para = true;
        return;
      }
      if (bl.type === "table") { buildTable(bl); return; }

      var el;
      if (bl.type === "h") { el = document.createElement("h" + bl.level); reader.appendChild(el); }
      else if (bl.type === "q") { el = document.createElement("blockquote"); reader.appendChild(el); }
      else if (bl.type === "li") {
        var entry = listFor(bl);
        el = document.createElement("li");
        if (bl.ordered) el.value = parseInt(bl.num, 10) || 1;
        if (bl.task !== undefined) el.className = "task" + (bl.task !== " " ? " done" : "");
        entry.el.appendChild(el);
        entry.lastLi = el;
      } else { el = document.createElement("p"); reader.appendChild(el); }

      var lastW = fillLines(el, bl.lines);
      if (!lastW) { el.remove(); return; }
      if (bl.type === "h") lastW.head = true;
      else if (bl.type === "li") lastW.item = true;
      else lastW.para = true;
    });

    if (!words.length) {
      reader.textContent = "";
      var e = document.createElement("p");
      e.className = "empty";
      e.textContent = "Nothing to read yet. Paste some text on the Paste text tab.";
      reader.appendChild(e);
    }
  }

  function keepInView(el) {
    var r = el.getBoundingClientRect(), h = window.innerHeight;
    if (r.top < h * 0.15 || r.bottom > h * 0.55) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function highlight(i) {
    if (!spans.length) return;
    var prev = cur;
    cur = i;
    if (prev >= 0 && spans[prev]) spans[prev].classList.remove("now");
    if (i < 0) {
      spans.forEach(function (s) { s.classList.remove("read"); });
      bar.style.width = "0";
      return;
    }
    if (prev < 0 || i < prev) {
      for (var k = 0; k < spans.length; k++) spans[k].classList.toggle("read", k < i);
    } else {
      for (var k2 = prev; k2 < i; k2++) spans[k2].classList.add("read");
    }
    spans[i].classList.add("now");
    keepInView(spans[i]);
    bar.style.width = ((i + 1) / words.length * 100).toFixed(1) + "%";
  }

  // =====================================================
  //  Speech engine
  // =====================================================
  function clearTimers() {
    clearTimeout(gapTimer); clearInterval(estTimer); clearTimeout(estCheck);
    gapTimer = estTimer = estCheck = null;
  }

  function stopAll() {
    token++;
    clearTimers();
    synth.cancel();
    state = "idle";
  }

  function currentVoice() {
    return voices.filter(function (v) { return v.voiceURI === voiceSel.value; })[0] || null;
  }

  function speakChunk(i, t) {
    if (t !== token) return;
    if (i >= words.length) { finish(); return; }

    // a chunk runs to the next pause point (or 28 words at most)
    var j = i;
    while (j < words.length - 1 && pauseFor(j) === 0 && j - i < 28) j++;

    var text = "", offs = [];
    for (var k = i; k <= j; k++) {
      offs.push(text.length);
      if (words[k].say) text += words[k].say + " ";
    }
    text = text.trim();

    function next() {
      if (t !== token) return;
      clearInterval(estTimer); clearTimeout(estCheck);
      highlight(j);
      resumeIdx = j + 1;
      if (j + 1 >= words.length) { finish(); return; }
      var gap = pauseFor(j) * parseFloat(pauseScaleEl.value);
      gapTimer = setTimeout(function () { speakChunk(j + 1, t); }, gap);
    }

    // nothing speakable here (e.g. only a dash or symbol): just keep the pause
    if (!text) { highlight(i); setTimeout(next, 0); return; }

    var u = new SpeechSynthesisUtterance(text);
    var v = currentVoice();
    if (v && (!textLang || v.lang.toLowerCase().indexOf(textLang.slice(0, 2)) === 0)) {
      u.voice = v; u.lang = v.lang;
    } else if (textLang) {
      u.lang = textLang;
    }
    u.rate = parseFloat(rateEl.value);
    u.pitch = parseFloat(pitchEl.value);

    var gotBoundary = false;

    function wordAt(ch) {
      var idx = 0;
      for (var q = 0; q < offs.length; q++) { if (offs[q] <= ch) idx = q; else break; }
      return i + idx;
    }

    u.onstart = function () {
      if (t !== token) return;
      highlight(i);
      resumeIdx = i;
      // some voices never send word-boundary events; estimate timing for those
      estCheck = setTimeout(function () {
        if (t !== token || gotBoundary || state !== "playing") return;
        var cps = 15 * u.rate, began = Date.now() - 700;
        estTimer = setInterval(function () {
          if (t !== token) { clearInterval(estTimer); return; }
          var w = wordAt(((Date.now() - began) / 1000) * cps);
          highlight(w); resumeIdx = w;
        }, 120);
      }, 700);
    };

    u.onboundary = function (e) {
      if (t !== token) return;
      if (e.name && e.name !== "word") return;
      gotBoundary = true;
      clearInterval(estTimer);
      var w = wordAt(e.charIndex);
      highlight(w);
      resumeIdx = w;
    };

    u.onend = next;

    u.onerror = function (e) {
      if (t !== token) return;
      if (e.error === "interrupted" || e.error === "canceled") return;
      state = "paused";
      updateUI("Speech error (" + e.error + "). Press Play to try again.");
    };

    if (synth.paused) synth.resume();
    synth.speak(u);
  }

  function start(idx) {
    ensureLoaded();
    if (!words.length) { setMode("listen"); return; }
    setMode("listen");
    idx = Math.max(0, Math.min(idx, words.length - 1));
    token++;
    var t = token;
    clearTimers();
    synth.cancel();
    state = "playing";
    resumeIdx = idx;
    highlight(idx);
    updateUI();
    setTimeout(function () { if (t === token) speakChunk(idx, t); }, 60);
  }

  function pause() {
    if (state !== "playing") return;
    token++;
    clearTimers();
    synth.cancel();
    state = "paused";
    updateUI();
  }

  function finish() {
    token++;
    clearTimers();
    state = "idle";
    resumeIdx = 0;
    highlight(-1);
    updateUI("Finished");
  }

  // =====================================================
  //  UI wiring
  // =====================================================
  function updateUI(msg) {
    var hasText = src.value.trim().length > 0;
    playBtn.disabled = state === "playing" || !hasText;
    pauseBtn.disabled = state !== "playing";
    restartBtn.disabled = !hasText;
    $("#playLabel").textContent = state === "paused" ? "Resume" : "Play";
    statusEl.textContent = msg || (state === "playing" ? "Reading\u2026" : state === "paused" ? "Paused" : "Ready");
  }

  function updateCount() {
    var n = (src.value.match(/\S+/g) || []).length;
    $("#count").textContent = n ? n + (n === 1 ? " word" : " words") : "";
  }

  function detectLang(text) {
    var nl = /[\u0900-\u097F]/.test(text) ? "hi-IN" : "";
    if (nl !== textLang) { textLang = nl; populateVoices(); }
  }

  function ensureLoaded() {
    var text = src.value;
    if (text === loadedText) return;
    stopAll();
    build(text);
    loadedText = text;
    resumeIdx = 0;
    cur = -1;
    detectLang(text);
    updateUI();
  }

  function setMode(m) {
    var listen = m === "listen";
    if (listen) ensureLoaded();
    else pause();
    $("#panePaste").hidden = listen;
    $("#paneListen").hidden = !listen;
    $("#tabPaste").setAttribute("aria-selected", String(!listen));
    $("#tabListen").setAttribute("aria-selected", String(listen));
    if (listen && cur >= 0 && spans[cur]) setTimeout(function () { spans[cur].scrollIntoView({ block: "center" }); }, 0);
    if (!listen) window.scrollTo(0, 0);
  }

  // ---------- voices: rank so the friendliest one is chosen by default ----------
  function voiceScore(v) {
    var n = (v.name + " " + v.voiceURI).toLowerCase(), s = 0;
    if (/natural|neural/.test(n)) s += 60;
    if (/online/.test(n)) s += 20;
    if (/premium|enhanced/.test(n)) s += 45;
    if (/google/.test(n)) s += 30;
    if (!v.localService) s += 10;
    if (/\b(samantha|ava|allison|serena|karen|moira|tessa|zoe|aria|jenny|sonia|libby|neerja|swara|priya|veena|kalpana|zira|emma|michelle|nova)\b/.test(n)) s += 12;
    if (/espeak|compact|albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph|princess/.test(n)) s -= 80;
    return s;
  }

  function populateVoices() {
    voices = synth.getVoices();
    var pref = (textLang || navigator.language || "en-US").toLowerCase().replace("_", "-");
    var ranked = voices.map(function (v) {
      var l = v.lang.toLowerCase().replace("_", "-");
      var bonus = l === pref ? 200 : (l.slice(0, 2) === pref.slice(0, 2) ? 100 : 0);
      var sc = voiceScore(v);
      return { v: v, sc: sc, rank: sc + bonus };
    }).sort(function (a, b) { return b.rank - a.rank; });

    var keep = voiceSel.value;
    voiceSel.textContent = "";
    if (!ranked.length) {
      var o0 = document.createElement("option");
      o0.textContent = "Default voice";
      voiceSel.appendChild(o0);
      return;
    }
    ranked.forEach(function (r) {
      var o = document.createElement("option");
      o.value = r.v.voiceURI;
      o.textContent = (r.sc >= 40 ? "\u2605 " : "") + r.v.name + " (" + r.v.lang + ")";
      voiceSel.appendChild(o);
    });
    function has(uri) { return voices.some(function (v) { return v.voiceURI === uri; }); }

    if (!voiceChosenByUser) {
      var saved = null;
      try { saved = localStorage.getItem("read-aloud-voice"); } catch (e) {}
      if (saved && has(saved)) { voiceChosenByUser = true; keep = saved; }
    }
    if (voiceChosenByUser && keep && has(keep)) voiceSel.value = keep;
    else voiceSel.value = ranked[0].v.voiceURI;

    voiceTip.hidden = ranked[0].sc >= 40;
  }
  populateVoices();
  if ("onvoiceschanged" in synth) synth.onvoiceschanged = populateVoices;

  // ---------- buttons ----------
  playBtn.addEventListener("click", function () {
    ensureLoaded();
    if (!words.length) { setMode("listen"); return; }
    start(state === "paused" ? resumeIdx : (resumeIdx || 0));
  });
  pauseBtn.addEventListener("click", pause);
  restartBtn.addEventListener("click", function () { start(0); window.scrollTo({ top: 0 }); });

  // double-click a word to read from there
  reader.addEventListener("dblclick", function (e) {
    var s = e.target.closest(".w");
    if (!s) return;
    var sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    start(parseInt(s.dataset.i, 10));
  });

  // tabs & text controls
  $("#tabPaste").addEventListener("click", function () { setMode("paste"); });
  $("#tabListen").addEventListener("click", function () { setMode("listen"); });
  src.addEventListener("input", function () { updateCount(); updateUI(); });
  $("#sample").addEventListener("click", function () { src.value = SAMPLE; updateCount(); updateUI(); src.focus(); });
  $("#clear").addEventListener("click", function () { stopAll(); src.value = ""; loadedText = null; updateCount(); updateUI(); src.focus(); });

  // settings
  voiceSel.addEventListener("change", function () {
    voiceChosenByUser = true;
    try { localStorage.setItem("read-aloud-voice", voiceSel.value); } catch (e) {}
    if (state === "playing") start(resumeIdx);
  });
  function fmt(n) { return parseFloat(n).toFixed(2).replace(/0$/, "").replace(/\.$/, ""); }
  rateEl.addEventListener("input", function () { $("#rateVal").textContent = fmt(rateEl.value) + "\u00D7"; });
  pauseScaleEl.addEventListener("input", function () { $("#pauseVal").textContent = fmt(pauseScaleEl.value) + "\u00D7"; });
  pitchEl.addEventListener("input", function () { $("#pitchVal").textContent = fmt(pitchEl.value); });

  // Space toggles play/pause when not typing or focused on a control
  document.addEventListener("keydown", function (e) {
    if (e.code !== "Space") return;
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input" || tag === "select" || tag === "button" || tag === "summary") return;
    e.preventDefault();
    if (state === "playing") pause();
    else if (src.value.trim()) start(state === "paused" ? resumeIdx : 0);
  });

  window.addEventListener("pagehide", function () { synth.cancel(); });

  applyZoom(false);
  updateCount();
  updateUI();
})();
