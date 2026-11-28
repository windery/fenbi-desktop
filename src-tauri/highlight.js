/* 粉笔刷题 wrapper —— 做题页的划词标记
 *
 * 由 src-tauri/src/lib.rs 和 init.js 一起拼进 initialization_script，每个粉笔页面都带，
 * 但只在 spa.fenbi.com 的做题页生效：每次按键时按当前地址判断（站点是 SPA，换页不重载）。
 *
 * 边界（CLAUDE.md「包装层的边界」、docs/adr/0004）：
 *   - 只用 CSS Custom Highlight API（CSS.highlights / Highlight / Range）叠底色，
 *     不往页面插元素、不改站点节点和属性；唯一加进页面的是一条 ::highlight() 样式。
 *     登记表 CSS.highlights 在同一个文档里，站点脚本看得到它（只是不会去读）。
 *   - 不读题目数据：只看选区是否为空和它的位置，不取选中的文字。
 *   - 不记日志、不联网、不调站点接口、不写任何存储；标记只活在当前页面。
 *   - 浏览器不支持 CSS.highlights 时整个功能不出现。
 *   - 焦点在输入框、文本框、可编辑区域里时一律不拦键；只在真的标记/删除时 preventDefault。
 *
 * 按键（第一版，不能改键）：
 *   H                       选中文字后标记（第 1 种颜色），并取消选区让底色露出来；
 *                           没有选区时，鼠标停在一处标记上按 H 换下一种颜色（3 色循环）
 *   Delete / Backspace      鼠标停在一处标记上：删掉这一处
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

  /* 做题页：2026-11-28 在真实页面上核实过的两种地址（spa.fenbi.com）。
   *   /ti/exam/exercise/<id>   练习（从「练习历史 → 继续做题」进入）
   *   /ti/memorize/<id>        背题
   * 路径必须正好是一个 id（允许结尾的 /，查询串不看）。/tiku 下的旧做题页没有核实，不写。 */
  var PRACTICE_PATH = /^\/ti\/(?:exam\/exercise|memorize)\/[^/]+\/?$/;

  /* 一道题的容器：做题页上每道题一个 <app-ti>，整页是长列表（实测 15 题 15 个）。 */
  var QUESTION_SELECTOR = "app-ti";

  /* 3 种颜色：白底上读得清，和站点的蓝色选中态、站点自带划线的 #ff9 黄都分得开。
   * 文字颜色也固定成深色，站点切到深色主题时底色上的字照样读得清。 */
  var COLORS = ["#ffd8a8", "#c3f0c8", "#ffc9de"];
  var TEXT_COLOR = "#1f2328";
  var HOVER_LINE = "underline 2px #e8590c";

  var NAMES = ["fenbi-mark-1", "fenbi-mark-2", "fenbi-mark-3"];
  var HOVER_NAME = "fenbi-mark-hover";

  /* 当前页面的全部标记：{ range, origin, color }。range 是活的 Range（浏览器画它、取它的矩形），
   * origin 是标记时的四个边界，用来认出站点改过节点；color 是 COLORS 的下标。 */
  var marks = [];
  var groups = null;
  var hoverGroup = null;
  var hovered = null;
  var markedPath = null;
  var pointer = null;

  function onPracticePage() {
    return PRACTICE_PATH.test(location.pathname);
  }

  function ensureRegistered() {
    if (groups) return;
    groups = [];
    for (var i = 0; i < NAMES.length; i++) {
      var group = new Highlight();
      groups.push(group);
      CSSApi.highlights.set(NAMES[i], group);
    }
    hoverGroup = new Highlight();
    hoverGroup.priority = 1;
    CSSApi.highlights.set(HOVER_NAME, hoverGroup);

    var css = "";
    for (var j = 0; j < NAMES.length; j++) {
      css +=
        "::highlight(" + NAMES[j] + ") { background-color: " + COLORS[j] +
        "; color: " + TEXT_COLOR + "; }\n";
    }
    css += "::highlight(" + HOVER_NAME + ") { text-decoration: " + HOVER_LINE + "; }\n";
    try {
      var style = document.createElement("style");
      style.setAttribute("data-fenbi-wrapper", "highlight");
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    } catch (e) {}
  }

  function setHovered(mark) {
    if (hovered === mark) return;
    hovered = mark;
    if (!hoverGroup) return;
    hoverGroup.clear();
    if (mark) hoverGroup.add(mark.range);
  }

  function removeMark(mark) {
    var at = marks.indexOf(mark);
    if (at < 0) return;
    marks.splice(at, 1);
    groups[mark.color].delete(mark.range);
    if (hovered === mark) setHovered(null);
  }

  function clearAll() {
    for (var i = marks.length - 1; i >= 0; i--) removeMark(marks[i]);
  }

  function sameRange(a, b) {
    return (
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset
    );
  }

  /* 站点换页或把题目节点换掉之后，范围就失效了：换页（路径变了）清空全部，
   * 节点被摘掉的那几处单独清掉。活 Range 在节点被摘时会把边界挪到父节点，范围不一定塌、
   * 两端也还在文档里，所以拿标记时记下的边界比对：边界变了就算失效。
   * 按键、鼠标移动、滚动、浏览器前进后退时都先跑一遍（站点用 pushState 换页不发事件）。 */
  function prune() {
    if (!marks.length) return;
    if (location.pathname !== markedPath) {
      clearAll();
      return;
    }
    for (var i = marks.length - 1; i >= 0; i--) {
      var mark = marks[i];
      if (
        !sameRange(mark.range, mark.origin) ||
        mark.range.collapsed ||
        !mark.origin.startContainer.isConnected ||
        !mark.origin.endContainer.isConnected
      ) {
        removeMark(mark);
      }
    }
  }

  /* 鼠标下面的那一处标记；有重叠时取后标的那处（画在上面）。 */
  function markAtPointer() {
    if (!pointer) return null;
    for (var i = marks.length - 1; i >= 0; i--) {
      var rects = marks[i].range.getClientRects();
      for (var j = 0; j < rects.length; j++) {
        var r = rects[j];
        if (pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom) {
          return marks[i];
        }
      }
    }
    return null;
  }

  function closestQuestion(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return el && el.closest ? el.closest(QUESTION_SELECTOR) : null;
  }

  function selectedRange() {
    var selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    var range = selection.getRangeAt(0);
    return range.collapsed ? null : { selection: selection, range: range };
  }

  /* 一处标记只能属于一道题，否则「清当前题」会误删或删不掉：起点要落在某道题里，
   * 终点在同一道题里。全选这类两端都在题外的选区也不算。页面上认不出题目容器
   * （站点改版）时不做这道检查。 */
  function withinOneQuestion(range) {
    if (!document.querySelector(QUESTION_SELECTOR)) return true;
    var question = closestQuestion(range.startContainer);
    return !!question && question === closestQuestion(range.endContainer);
  }

  function nextColor(mark) {
    groups[mark.color].delete(mark.range);
    mark.color = (mark.color + 1) % COLORS.length;
    groups[mark.color].add(mark.range);
  }

  /* H：有选区就标记；选区正好是已有的一处就给它换色。标完取消选区，
   * 否则站点的蓝色选中态盖在底色上面，看不见标的是什么颜色。
   * 没有选区时，给鼠标下面那一处换色。 */
  function markSelection() {
    var picked = selectedRange();
    if (!picked) {
      var under = markAtPointer();
      if (!under) return false;
      nextColor(under);
      return true;
    }
    if (!withinOneQuestion(picked.range)) return false;
    ensureRegistered();
    var existing = null;
    for (var i = 0; i < marks.length; i++) {
      if (sameRange(marks[i].range, picked.range)) existing = marks[i];
    }
    if (existing) {
      nextColor(existing);
    } else {
      var range = picked.range;
      var mark = {
        range: range.cloneRange(),
        origin: {
          startContainer: range.startContainer,
          startOffset: range.startOffset,
          endContainer: range.endContainer,
          endOffset: range.endOffset,
        },
        color: 0,
      };
      marks.push(mark);
      groups[0].add(mark.range);
      markedPath = location.pathname;
    }
    picked.selection.removeAllRanges();
    return true;
  }

  function deleteHovered() {
    var under = markAtPointer();
    if (!under) return false;
    removeMark(under);
    return true;
  }

  /* 「当前题」= 鼠标所在的那道题（<app-ti>）。鼠标不在任何一道题上、或已经离开内容区就不动；
   * 页面上一个 <app-ti> 都没有（站点改版、选择器对不上）就清掉本页全部标记。 */
  function clearQuestion() {
    if (!marks.length || !pointer) return false;
    if (!document.querySelector(QUESTION_SELECTOR)) {
      clearAll();
      return true;
    }
    var target = document.elementFromPoint ? document.elementFromPoint(pointer.x, pointer.y) : null;
    var question = closestQuestion(target);
    if (!question) return false;
    var removed = false;
    for (var i = marks.length - 1; i >= 0; i--) {
      if (question.contains(marks[i].range.startContainer)) {
        removeMark(marks[i]);
        removed = true;
      }
    }
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

  function keyOf(e) {
    if (e.code === "KeyH") return "h";
    if (e.code === "Delete" || e.code === "Backspace") return "delete";
    var key = typeof e.key === "string" ? e.key.toLowerCase() : "";
    if (key === "h") return "h";
    if (key === "delete" || key === "backspace") return "delete";
    return "";
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing || e.repeat) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var key = keyOf(e);
    if (!key) return;
    prune();
    if (!onPracticePage()) return;
    if (isEditable(e.target) || isEditable(document.activeElement)) return;

    var done = false;
    if (key === "h" && !e.shiftKey) done = markSelection();
    else if (key === "delete" && !e.shiftKey) done = deleteHovered();
    else if (key === "delete" && e.shiftKey) done = clearQuestion();
    if (done) {
      e.preventDefault();
      setHovered(markAtPointer());
    }
  }

  function refresh() {
    prune();
    if (marks.length) setHovered(markAtPointer());
  }

  function onPointer(e) {
    pointer = { x: e.clientX, y: e.clientY };
    refresh();
  }

  /* 鼠标离开这个 WebView（工具栏是另一个 WebView）或窗口失焦：忘掉指针，
   * 否则内容区还留着键盘焦点，按删除键会删掉鼠标早已不在上面的那处标记。 */
  function forgetPointer() {
    pointer = null;
    setHovered(null);
  }

  var PASSIVE = { capture: true, passive: true };
  window.addEventListener("keydown", onKeyDown, true);
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
})();
