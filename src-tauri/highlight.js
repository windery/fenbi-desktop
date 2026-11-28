/* 粉笔刷题 wrapper —— 做题页的划词标记
 *
 * 由 src-tauri/src/lib.rs 和 init.js 一起拼进 initialization_script，每个粉笔页面都带，
 * 但只在 spa.fenbi.com 的做题页生效：每次操作时按当前地址判断（站点是 SPA，换页不重载）。
 *
 * 边界（AGENTS.md「包装层的边界」、docs/adr/0004）：
 *   - 只用 CSS Custom Highlight API（CSS.highlights / Highlight / Range）叠底色，
 *     不往页面插元素、不改站点节点和属性；唯一加进页面的是一条 ::highlight() 样式。
 *     登记表 CSS.highlights 在同一个文档里，站点脚本看得到它（只是不会去读）。
 *   - 不读题目数据：只看选区在哪、文字节点有多长（算题内偏移），不取选中的文字。
 *   - 不记日志、不联网、不调站点接口。
 *   - 按练习落盘（2026-11-28 用户授权放开，仅限划词标记）：只经 read_practice_marks /
 *     write_practice_marks 两条命令交给 Rust（marks.rs）存，只存「第几道题 + 题内文字偏移 + 颜色」，
 *     不存选中的文字；设置里「记住标记」关着时一条命令都不发。
 *   - 浏览器不支持 CSS.highlights 时整个功能不出现。
 *   - 焦点在输入框、文本框、可编辑区域里时一律不拦键、不标记；只在真的生效时 preventDefault。
 *
 * 操作（键位和颜色都在设置页面里改，见 settings.rs 的 highlight）：
 *   拖选题目文字松手          按当前笔色标记，并取消选区让底色露出来；这次拖选不再触发站点的点击（不会误选选项）。
 *                           设置成「选中后按键标记」时改成选中后按标记键（默认 H）；
 *                           那时没有选区、鼠标停在一处标记上按标记键，给这处换下一种颜色
 *   右键点一处标记            删掉这一处，不弹菜单；不在标记上的右键照常
 *   Shift+右键点一处标记      这一处换下一种颜色（3 色循环）
 *   切换笔色键（默认 C）       之后新标的用下一种颜色
 *   显示 / 隐藏键（默认 V）    隐藏全部标记（数据留着），再按恢复；隐藏时别的操作都不生效
 *   Shift+Delete / Shift+Backspace
 *                           清掉鼠标所在那道题的全部标记；页面上找不到题目容器
 *                           （站点改版）时清掉本页全部标记
 * 鼠标离开这个 WebView（移到工具栏、窗口外）或窗口失焦后，悬停类按键都不再生效。
 */
(function () {
  "use strict";

  if (location.hostname !== "spa.fenbi.com") return;
  var CSSApi = typeof CSS !== "undefined" ? CSS : null;
  if (!CSSApi || !CSSApi.highlights || typeof Highlight !== "function") return;
  var source = window.__fenbiSettings;
  if (!source) return;
  var invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;

  /* 做题页：2026-11-28 在真实页面上核实过的两种地址（spa.fenbi.com）。
   *   /ti/exam/exercise/<id>   练习（从「练习历史 → 继续做题」进入）
   *   /ti/memorize/<id>        背题
   * 路径必须正好是一个 id（允许结尾的 /，查询串不看）。/tiku 下的旧做题页没有核实，不写。
   * 存标记时按「exercise:<id>」「memorize:<id>」分开（marks.rs 的 valid_practice）。 */
  var PRACTICE_PATH = /^\/ti\/(exam\/exercise|memorize)\/([^/]+)\/?$/;

  /* 一道题的容器：做题页上每道题一个 <app-ti>，整页是长列表（实测 15 题 15 个）。 */
  var QUESTION_SELECTOR = "app-ti";

  /* 文字颜色固定成深色，站点切到深色主题时底色上的字照样读得清。 */
  var TEXT_COLOR = "#1f2328";
  var HOVER_LINE = "underline 2px #e8590c";
  var NAMES = ["fenbi-mark-1", "fenbi-mark-2", "fenbi-mark-3"];
  var HOVER_NAME = "fenbi-mark-hover";
  /* TreeWalker 只看文字节点（NodeFilter.SHOW_TEXT）。 */
  var SHOW_TEXT = 4;
  /* 还有没恢复上的标记（题目还没画出来）时，隔多久再找一次。 */
  var RETRY_MS = 500;

  var settings = source.get().highlight;
  /* 当前页面的全部标记：{ range, origin, color, spot }。range 是活的 Range（浏览器画它、取它的矩形），
   * origin 是标记时的四个边界，用来认出站点改过节点；color 是颜色下标；
   * spot 是 { q: 第几道题, start, end: 题内文字偏移 }，存盘和站点重绘后恢复用（算不出来时为 null）。 */
  var marks = [];
  /* 存过但还没画上的标记：[题号, 起, 止, 颜色]。题目画出来后按偏移恢复，对不上的丢掉。 */
  var pending = [];
  var groups = null;
  var hoverGroup = null;
  var style = null;
  var hovered = null;
  var pointer = null;
  var hidden = false;
  var pen = 0;
  /* 当前练习（exercise:<id> / memorize:<id>），不在做题页时为 null。 */
  var practice = null;
  /* 这份练习存的标记读回来了没有；读回来之前的改动先记着（dirty），读回来合并后再写。 */
  var loaded = false;
  var dirty = false;
  var loadRun = 0;
  var retryTimer = null;
  var suppressClick = false;

  function practiceOf(path) {
    var match = PRACTICE_PATH.exec(path);
    if (!match) return null;
    return (match[1] === "memorize" ? "memorize:" : "exercise:") + match[2];
  }

  function onPracticePage() {
    return PRACTICE_PATH.test(location.pathname);
  }

  function active() {
    return settings.enabled && onPracticePage();
  }

  function remembering() {
    return !!(settings.enabled && settings.remember && invoke);
  }

  function call(command, args) {
    try {
      return Promise.resolve(invoke(command, args));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /* ── 画 ─────────────────────────────────────────────── */

  function paintStyle() {
    if (!style) return;
    var css = "";
    for (var i = 0; i < NAMES.length; i++) {
      css +=
        "::highlight(" + NAMES[i] + ") { background-color: " + settings.colors[i] +
        "; color: " + TEXT_COLOR + "; }\n";
    }
    css += "::highlight(" + HOVER_NAME + ") { text-decoration: " + HOVER_LINE + "; }\n";
    style.textContent = css;
  }

  /* 隐藏 = 把几组高亮从登记表里拿掉（Range 还留在组里），显示时再登记回去。 */
  function applyVisibility() {
    if (!groups) return;
    var shown = settings.enabled && !hidden;
    for (var i = 0; i < NAMES.length; i++) {
      if (shown) CSSApi.highlights.set(NAMES[i], groups[i]);
      else CSSApi.highlights.delete(NAMES[i]);
    }
    if (shown) CSSApi.highlights.set(HOVER_NAME, hoverGroup);
    else CSSApi.highlights.delete(HOVER_NAME);
  }

  function ensureRegistered() {
    if (groups) return;
    groups = [];
    for (var i = 0; i < NAMES.length; i++) groups.push(new Highlight());
    hoverGroup = new Highlight();
    hoverGroup.priority = 1;
    try {
      style = document.createElement("style");
      style.setAttribute("data-fenbi-wrapper", "highlight");
      (document.head || document.documentElement).appendChild(style);
    } catch (e) {}
    paintStyle();
    applyVisibility();
  }

  function setHovered(mark) {
    if (hovered === mark) return;
    hovered = mark;
    if (!hoverGroup) return;
    hoverGroup.clear();
    if (mark) hoverGroup.add(mark.range);
  }

  /* ── 题内偏移 ─────────────────────────────────────────── */

  function questions() {
    return document.querySelectorAll(QUESTION_SELECTOR);
  }

  function closestQuestion(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return el && el.closest ? el.closest(QUESTION_SELECTOR) : null;
  }

  function textNodes(root) {
    var walker = document.createTreeWalker(root, SHOW_TEXT);
    var nodes = [];
    for (var node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    return nodes;
  }

  /* 边界（container, offset）落在文字节点 text 的前面吗：元素边界指的是「第 offset 个子节点之前」。 */
  function boundaryBefore(container, offset, text) {
    var child = container.childNodes[offset];
    if (child) return child === text || child.contains(text) || !!(child.compareDocumentPosition(text) & 4);
    return !container.contains(text) && !!(container.compareDocumentPosition(text) & 4);
  }

  /* 边界在 root 的文字里是第几个字符。只用文字节点的长度，不取文字。 */
  function offsetIn(root, container, offset) {
    var total = 0;
    var nodes = textNodes(root);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (container === node) return total + offset;
      if (container.nodeType === 1 && boundaryBefore(container, offset, node)) return total;
      total += node.length;
    }
    return container.nodeType === 1 ? total : -1;
  }

  function spotOf(range) {
    var root = closestQuestion(range.startContainer);
    if (!root) return null;
    var q = Array.prototype.indexOf.call(questions(), root);
    var start = offsetIn(root, range.startContainer, range.startOffset);
    var end = offsetIn(root, range.endContainer, range.endOffset);
    if (q < 0 || start < 0 || end <= start) return null;
    return { q: q, start: start, end: end };
  }

  /* 按题内偏移在 root 里重建 Range；文字比偏移短（站点改了这道题）就返回 null。 */
  function rangeAt(root, start, end) {
    var nodes = textNodes(root);
    var total = 0;
    var from = null;
    var to = null;
    for (var i = 0; i < nodes.length && !to; i++) {
      var length = nodes[i].length;
      if (!from && start < total + length) from = [nodes[i], start - total];
      if (from && end <= total + length) to = [nodes[i], end - total];
      total += length;
    }
    if (!from || !to) return null;
    var range = document.createRange();
    range.setStart(from[0], from[1]);
    range.setEnd(to[0], to[1]);
    return range;
  }

  function sameSpot(a, record) {
    return !!a && a.q === record[0] && a.start === record[1] && a.end === record[2];
  }

  /* ── 标记的增删 ───────────────────────────────────────── */

  function addMark(range, color, spot) {
    ensureRegistered();
    var mark = {
      range: range,
      origin: {
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset,
      },
      color: color,
      spot: spot,
    };
    marks.push(mark);
    groups[color].add(range);
    return mark;
  }

  function removeMark(mark) {
    var at = marks.indexOf(mark);
    if (at < 0) return;
    marks.splice(at, 1);
    groups[mark.color].delete(mark.range);
    if (hovered === mark) setHovered(null);
  }

  function clearLive() {
    for (var i = marks.length - 1; i >= 0; i--) removeMark(marks[i]);
  }

  function nextColor(mark) {
    groups[mark.color].delete(mark.range);
    mark.color = (mark.color + 1) % NAMES.length;
    groups[mark.color].add(mark.range);
  }

  function sameRange(a, b) {
    return (
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset
    );
  }

  /* ── 存与读 ─────────────────────────────────────────── */

  function records() {
    var list = [];
    for (var i = 0; i < marks.length; i++) {
      var spot = marks[i].spot;
      if (spot) list.push([spot.q, spot.start, spot.end, marks[i].color]);
    }
    return list.concat(pending);
  }

  function save() {
    if (!practice || !remembering()) return;
    if (!loaded) {
      dirty = true;
      return;
    }
    dirty = false;
    call("write_practice_marks", { practice: practice, marks: records() }).catch(function () {});
  }

  function validRecord(record) {
    if (!record || record.length !== 4) return false;
    for (var i = 0; i < 4; i++) {
      if (typeof record[i] !== "number" || record[i] < 0 || record[i] % 1) return false;
    }
    return record[1] < record[2] && record[3] < NAMES.length;
  }

  /* 读回这份练习存的标记，和读回来之前新标的合并。读失败就不写，免得盖掉存着的。 */
  function load(id) {
    var run = ++loadRun;
    call("read_practice_marks", { practice: id }).then(function (list) {
      if (run !== loadRun || practice !== id) return;
      loaded = true;
      for (var i = 0; list && i < list.length; i++) {
        var record = list[i];
        if (!validRecord(record)) continue;
        var known = false;
        for (var j = 0; j < marks.length && !known; j++) known = sameSpot(marks[j].spot, record);
        if (!known) pending.push(record.slice());
      }
      resolvePending();
      if (dirty) save();
    }, function () {});
  }

  /* 换了练习（或离开做题页）：清掉页面上的标记，读新练习存的。 */
  function switchPractice(next) {
    clearLive();
    pending = [];
    practice = next;
    dirty = false;
    loadRun++;
    loaded = !(next && remembering());
    if (!loaded) load(next);
  }

  function startRetry() {
    if (retryTimer === null) retryTimer = setInterval(sync, RETRY_MS);
  }

  function stopRetry() {
    if (retryTimer === null) return;
    clearInterval(retryTimer);
    retryTimer = null;
  }

  /* 把存着的标记按偏移画上去。题目还没画出来的留着下次再找；题目在、偏移对不上的丢掉。 */
  function resolvePending() {
    if (!pending.length || !active()) {
      stopRetry();
      return;
    }
    var all = questions();
    var keep = [];
    var dropped = false;
    for (var i = 0; i < pending.length; i++) {
      var record = pending[i];
      var root = all[record[0]];
      if (!root) {
        keep.push(record);
        continue;
      }
      var duplicate = false;
      for (var j = 0; j < marks.length && !duplicate; j++) duplicate = sameSpot(marks[j].spot, record);
      var range = duplicate ? null : rangeAt(root, record[1], record[2]);
      if (range) addMark(range, record[3], { q: record[0], start: record[1], end: record[2] });
      else dropped = true;
    }
    pending = keep;
    if (dropped) save();
    if (keep.length) startRetry();
    else stopRetry();
  }

  /* 站点换页或把题目节点换掉之后，范围就失效了。活 Range 在节点被摘时会把边界挪到父节点，
   * 范围不一定塌、两端也还在文档里，所以拿标记时记下的边界比对：边界变了就算失效。
   * 失效的标记退回「待恢复」，等站点画出新节点后按偏移重新画上；算不出偏移的直接丢掉。 */
  function prune() {
    for (var i = marks.length - 1; i >= 0; i--) {
      var mark = marks[i];
      if (
        !sameRange(mark.range, mark.origin) ||
        mark.range.collapsed ||
        !mark.origin.startContainer.isConnected ||
        !mark.origin.endContainer.isConnected
      ) {
        removeMark(mark);
        if (mark.spot) pending.push([mark.spot.q, mark.spot.start, mark.spot.end, mark.color]);
      }
    }
  }

  /* 每次操作、鼠标移动、滚动、前进后退时先跑一遍（站点用 pushState 换页不发事件）。 */
  function sync() {
    var next = practiceOf(location.pathname);
    if (next !== practice) switchPractice(next);
    prune();
    resolvePending();
  }

  /* ── 操作 ─────────────────────────────────────────────── */

  /* 鼠标下面的那一处标记；有重叠时取后标的那处（画在上面）。 */
  function markAt(x, y) {
    for (var i = marks.length - 1; i >= 0; i--) {
      var rects = marks[i].range.getClientRects();
      for (var j = 0; j < rects.length; j++) {
        var r = rects[j];
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return marks[i];
      }
    }
    return null;
  }

  function markAtPointer() {
    return pointer ? markAt(pointer.x, pointer.y) : null;
  }

  function selectedRange() {
    var selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    var range = selection.getRangeAt(0);
    return range.collapsed ? null : { selection: selection, range: range };
  }

  /* 一处标记只能属于一道题，否则「清当前题」会误删或删不掉：起点要落在某道题里，
   * 终点在同一道题里。全选这类两端都在题外的选区也不算。页面上认不出题目容器
   * （站点改版）时不做这道检查（这时的标记算不出题号，不存盘）。 */
  function withinOneQuestion(range) {
    if (!document.querySelector(QUESTION_SELECTOR)) return true;
    var question = closestQuestion(range.startContainer);
    return !!question && question === closestQuestion(range.endContainer);
  }

  /* 把选区标成当前笔色；选区正好是已有的一处就不重复标（按键模式下给它换色）。
   * 标完取消选区，否则站点的蓝色选中态盖在底色上面，看不见标的是什么颜色。 */
  function markPicked(picked, recolorSame) {
    if (!withinOneQuestion(picked.range)) return false;
    var existing = null;
    for (var i = 0; i < marks.length; i++) {
      if (sameRange(marks[i].range, picked.range)) existing = marks[i];
    }
    if (!existing) addMark(picked.range.cloneRange(), pen, spotOf(picked.range));
    else if (recolorSame) nextColor(existing);
    picked.selection.removeAllRanges();
    save();
    return true;
  }

  /* 按键模式的标记键：有选区就标；没有选区时给鼠标下面那一处换色。 */
  function markByKey() {
    var picked = selectedRange();
    if (picked) return markPicked(picked, true);
    var under = markAtPointer();
    if (!under) return false;
    nextColor(under);
    save();
    return true;
  }

  /* 「当前题」= 鼠标所在的那道题（<app-ti>）。鼠标不在任何一道题上、或已经离开内容区就不动；
   * 页面上一个 <app-ti> 都没有（站点改版、选择器对不上）就清掉本页全部标记。 */
  function clearQuestion() {
    if ((!marks.length && !pending.length) || !pointer) return false;
    if (!document.querySelector(QUESTION_SELECTOR)) {
      clearLive();
      pending = [];
      save();
      return true;
    }
    var target = document.elementFromPoint ? document.elementFromPoint(pointer.x, pointer.y) : null;
    var question = closestQuestion(target);
    if (!question) return false;
    var q = Array.prototype.indexOf.call(questions(), question);
    var removed = false;
    for (var i = marks.length - 1; i >= 0; i--) {
      if (question.contains(marks[i].range.startContainer)) {
        removeMark(marks[i]);
        removed = true;
      }
    }
    var before = pending.length;
    pending = pending.filter(function (record) {
      return record[0] !== q;
    });
    removed = removed || pending.length !== before;
    if (removed) save();
    return removed;
  }

  var TEXT_INPUT_TYPES = /^(text|search|email|url|tel|password|number|date|datetime-local|month|time|week)$/i;

  /* 正在打字的地方：文本框、文字类输入框、可编辑区域。单选框/复选框不算——
   * 选了答案之后焦点停在选项的 radio 上，划词照样要能用。 */
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") return TEXT_INPUT_TYPES.test(el.type || "text");
    return false;
  }

  function typing(e) {
    return isEditable(e.target) || isEditable(document.activeElement);
  }

  /* 快捷键是「Ctrl+Alt+Shift+Meta+<KeyboardEvent.code>」的子集（settings.rs 的 valid_shortcut），修饰键全等匹配。 */
  function codeOf(e) {
    if (e.code) return e.code;
    var key = typeof e.key === "string" ? e.key : "";
    if (/^[a-z]$/i.test(key)) return "Key" + key.toUpperCase();
    if (/^[0-9]$/.test(key)) return "Digit" + key;
    return key;
  }

  function hits(e, shortcut) {
    var parts = String(shortcut).split("+");
    var code = parts.pop();
    var mods = { Ctrl: false, Alt: false, Shift: false, Meta: false };
    for (var i = 0; i < parts.length; i++) mods[parts[i]] = true;
    return (
      codeOf(e) === code &&
      !!e.ctrlKey === mods.Ctrl &&
      !!e.altKey === mods.Alt &&
      !!e.shiftKey === mods.Shift &&
      !!e.metaKey === mods.Meta
    );
  }

  function isShiftDelete(e) {
    var code = codeOf(e);
    return (
      (code === "Delete" || code === "Backspace") &&
      e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
    );
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing || e.repeat) return;
    sync();
    if (!active() || typing(e)) return;

    var done = false;
    if (hits(e, settings.toggleKey)) {
      hidden = !hidden;
      if (hidden) setHovered(null);
      applyVisibility();
      done = true;
    } else if (hidden) {
      return;
    } else if (hits(e, settings.colorKey)) {
      pen = (pen + 1) % NAMES.length;
      done = true;
    } else if (settings.mode === "key" && hits(e, settings.markKey)) {
      done = markByKey();
    } else if (isShiftDelete(e)) {
      done = clearQuestion();
    }
    if (done) {
      e.preventDefault();
      if (!hidden) setHovered(markAtPointer());
    }
  }

  function onMouseDown(e) {
    if (e.button === 0) suppressClick = false;
  }

  /* 松手即标记。标上了就吞掉紧跟着的那次 click：拖选的起止点落在选项上时，
   * 浏览器会在松手后对它们的公共祖先发 click，站点会当成点了选项。 */
  function onMouseUp(e) {
    if (e.button !== 0) return;
    sync();
    if (settings.mode !== "release" || !active() || hidden || typing(e)) return;
    var picked = selectedRange();
    if (picked && markPicked(picked, false)) suppressClick = true;
  }

  function onClick(e) {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /* 右键点在标记上：删掉这一处（Shift+右键换色），不弹菜单。不在标记上就什么都不做，菜单照常。 */
  function onContextMenu(e) {
    sync();
    if (!active() || hidden) return;
    var mark = markAt(e.clientX, e.clientY);
    if (!mark) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) nextColor(mark);
    else removeMark(mark);
    save();
    setHovered(markAtPointer());
  }

  function refresh() {
    sync();
    if (marks.length && !hidden) setHovered(markAtPointer());
  }

  function onPointer(e) {
    pointer = { x: e.clientX, y: e.clientY };
    refresh();
  }

  /* 鼠标离开这个 WebView（工具栏是另一个 WebView）或窗口失焦：忘掉指针，
   * 否则内容区还留着键盘焦点，按 Shift+Delete 会清掉鼠标早已不在上面的那道题。 */
  function forgetPointer() {
    pointer = null;
    setHovered(null);
  }

  /* 设置页面改了：换颜色、开关、记住与否立即生效。刚打开「记住标记」时先读回存着的再合并写入。 */
  source.subscribe(function (next) {
    var wasRemembering = remembering();
    settings = next.highlight;
    paintStyle();
    if (!settings.enabled) setHovered(null);
    applyVisibility();
    if (!wasRemembering && remembering() && practice) {
      loaded = false;
      dirty = marks.length > 0;
      load(practice);
    }
    sync();
  });

  /* 设置页面点了「清除全部标记」：Rust 已经清掉了文件，这里只清页面上画着的。 */
  window.__fenbiClearMarks = function () {
    clearLive();
    pending = [];
    stopRetry();
  };

  var PASSIVE = { capture: true, passive: true };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("mousedown", onMouseDown, PASSIVE);
  window.addEventListener("mouseup", onMouseUp, PASSIVE);
  window.addEventListener("click", onClick, true);
  window.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("mousemove", onPointer, PASSIVE);
  window.addEventListener("scroll", refresh, PASSIVE);
  window.addEventListener("popstate", refresh);
  window.addEventListener(
    "mouseout",
    function (e) {
      if (!e.relatedTarget) forgetPointer();
    },
    PASSIVE
  );
  window.addEventListener("blur", forgetPointer);
  sync();
})();
