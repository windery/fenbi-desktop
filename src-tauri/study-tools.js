/* 本地展示功能。高亮使用 CSS Highlight API，保留原有题目节点。 */
(() => {
  "use strict";

  const questionSelector = "app-tis app-ti";
  const editableSelector = "input, textarea, select, [contenteditable]:not([contenteditable=false])";
  const explanation = ".result-common-section:is([id^='section-solution-'], [id^='section-analysis-'])";
  const textSection = `:is(${explanation}, .result-common-section:has(> app-solution-analysis))`;
  const videoSection = ".result-common-section:is([id^='section-video-'], :has(> app-solution-video))";
  const result = `app-result-common :is(${explanation}, app-solution-analysis)`;
  const colors = ["#ffb3ad", "#ffc587", "#ffe072", "#aedeff"];

  function start() {
    const root = document.documentElement;
    const highlights = typeof Highlight === "function" ? colors.map((_, index) => {
      const highlight = new Highlight();
      CSS.highlights.set(`fenbi-desktop-mark-${index}`, highlight);
      return highlight;
    }) : [];
    const canMark = highlights.length > 0;
    const marks = new Map();
    let pointer;
    let editing;
    let color = 0;
    let drag;
    let suppressClickFor;
    let shortcutRevision = -1;
    let toggleKey = "e";
    let removeKey = "backspace";
    const controls = new Map();

    const style = document.createElement("style");
    const resultPanel = `app-result-common .result-common-container:has(> ${explanation}, > .result-common-section > app-solution-analysis)`;
    const solution = ":is(.solution-choice-container, .solution-blank-container, " +
      `.solution-smart-container, .solution-view-only-container):has(> ${result})`;
    const splitVideo = `${solution}:has(> app-result-common > .result-common-container > .result-common-section > app-solution-video)` +
      ":not(:has(> app-result-common > .result-common-container > .toggle-btn-active))";
    const splitPanel = `${splitVideo} > app-result-common > .result-common-container`;
    const independentColumns = `${splitVideo}:has(> app-result-common > .result-common-container > .result-common-section:first-of-type > app-solution-video)`;
    const independentPanel = `${independentColumns} > app-result-common > .result-common-container`;
    style.textContent = `
      ${colors.map((background, index) => `::highlight(fenbi-desktop-mark-${index}) {
        background: ${background}; color: #241703;
      }`).join("\n")}
      app-ti[data-fenbi-marking] .ti-content,
      app-ti[data-fenbi-marking] .ti-content * { user-select: text !important; }
      .fenbi-study-actions { display: inline-flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
      .fenbi-study-actions button {
        font: inherit; font-size: 13px; padding: 4px 8px; border-radius: 5px;
        border: 1px solid #8494a5; background: #f7fafc; color: #203247;
      }
      .fenbi-study-actions button[aria-pressed="true"] { background: var(--fenbi-mark-color); }
      app-result-common .result-common-section:is([id^="section-source-"], [id^="section-note-"], :has(> app-solution-note)) {
        display: none !important;
      }
      ${resultPanel} {
        display: flex; flex-direction: column;
      }
      ${resultPanel} > ${textSection} { order: -2; }
      ${resultPanel} > ${videoSection} { order: -1; }
      app-result-common .result-common-container-toggle > ${textSection} > app-solution-title {
        padding-inline-end: 36px;
      }
      @media (min-width: 1000px) {
        :is(.exercise-main, .questions-main, .solution-main):has(${result}) {
          max-width: max(var(--screen-width, 960px), min(1600px, calc(100vw - 48px)));
        }
        .exercise-main:has(${result}) > app-tis {
          max-width: none;
        }
        ${solution} {
          display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
          grid-template-rows: min-content 1fr; column-gap: 28px; align-items: start;
        }
        ${solution} > :not(app-result-common) { grid-column: 1; min-width: 0; }
        ${solution} > app-result-common {
          grid-area: 1 / 2 / span 2; margin-top: 0; min-width: 0;
        }
        ${splitVideo} {
          position: relative;
          grid-template-rows: min-content min-content 1fr;
        }
        ${splitVideo} > app-result-common, ${splitPanel} { display: contents; }
        ${splitVideo} > app-result-common > .result-common-labels,
        ${splitPanel} > .result-common-section {
          grid-column: 2; min-width: 0;
        }
        ${splitPanel} > ${textSection} { grid-row: 1 / span 3; }
        ${splitPanel} > ${videoSection} {
          grid-column: 1; order: 0; margin-top: 16px;
        }
        ${splitPanel} > :is(${textSection}, ${videoSection}) {
          padding: 16px;
          border: 1px solid var(--color-border-result-common, #e3e8ef);
          border-radius: 8px;
          background: var(--color-bg-result-common, #fff);
        }
        ${independentColumns} {
          display: block;
          column-count: 2;
          column-gap: 28px;
        }
        ${independentColumns} > :not(app-result-common),
        ${independentPanel} > .result-common-section {
          break-inside: avoid;
        }
        ${independentPanel} > ${videoSection} {
          break-after: column;
          margin-bottom: 0;
        }
        ${independentPanel} > .result-common-section:not(${videoSection}) {
          margin-bottom: 12px;
        }
      }
    `;
    document.head.append(style);
    root.style.setProperty("--fenbi-mark-color", colors[color]);

    function markingContent(target) {
      if (!editing?.isConnected || target?.closest?.(questionSelector) !== editing ||
          target.closest(editableSelector)) return null;
      return target.closest(".ti-content");
    }

    function update() {
      for (const [question, buttons] of controls) {
        const active = editing === question;
        question.toggleAttribute("data-fenbi-marking", active);
        const keyLabel = toggleKey.length === 1 ? toggleKey.toUpperCase() :
          toggleKey[0].toUpperCase() + toggleKey.slice(1);
        const label = active ? "退出标注" : `划词标注（${keyLabel}）`;
        if (buttons.mark.textContent !== label) buttons.mark.textContent = label;
        buttons.mark.setAttribute("aria-pressed", String(active));
        buttons.clear.hidden = !marks.has(question);
      }
    }

    function toggle(question) {
      if (!question?.isConnected || !canMark) return;
      editing = editing === question ? null : question;
      update();
    }

    function clear(question) {
      for (const mark of marks.get(question) || []) mark.highlight.delete(mark.range);
      marks.delete(question);
    }

    function removeAt(question, x, y) {
      const ranges = marks.get(question);
      const content = question.querySelector(".ti-content");
      if (!ranges || !content) return false;
      const range = new Range();
      // 重叠时先移除最后添加的一条。使用逐行矩形，避免把换行处的空白误判成高亮。
      for (let index = ranges.length - 1; index >= 0; index--) {
        const mark = ranges[index].range;
        if (!content.contains(mark.startContainer) || !content.contains(mark.endContainer)) continue;
        try {
          range.setStart(mark.startContainer, mark.startOffset);
          range.setEnd(mark.endContainer, mark.endOffset);
        } catch {
          continue; // 页面重绘后，旧的文字偏移可能已经失效。
        }
        if (!Array.from(range.getClientRects()).some((rect) =>
          rect.width > 0 && rect.height > 0 &&
          x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)) continue;
        ranges[index].highlight.delete(mark);
        ranges.splice(index, 1);
        if (!ranges.length) marks.delete(question);
        update();
        return true;
      }
      return false;
    }

    function addControls(question, content) {
      const actions = document.createElement("div");
      actions.className = "fenbi-study-actions";
      function button(label, action) {
        const element = document.createElement("button");
        element.type = "button";
        element.textContent = label;
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          action();
        });
        actions.append(element);
        return element;
      }
      const mark = button("划词标注", () => toggle(question));
      mark.disabled = !canMark;
      const clearButton = button("清除本题标注", () => { clear(question); update(); });
      content.before(actions);
      controls.set(question, { actions, mark, clear: clearButton });
    }

    function refresh() {
      for (const [question, buttons] of controls) {
        if (question.isConnected && buttons.actions.isConnected) continue;
        if (editing === question) editing = null;
        clear(question);
        controls.delete(question);
      }
      for (const question of document.querySelectorAll(questionSelector)) {
        const content = question.querySelector(".ti-content");
        if (content && !controls.has(question)) addControls(question, content);
      }
      update();
    }

    function trackPointer(event) {
      if (drag?.id === event.pointerId && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 4) {
        drag.moved = true;
      }
      if (event.pointerType !== "mouse") return;
      pointer = [event.clientX, event.clientY];
    }
    document.addEventListener("pointerover", trackPointer);
    document.addEventListener("pointermove", trackPointer, { passive: true });
    root.addEventListener("pointerleave", () => { pointer = null; });

    document.addEventListener("contextmenu", (event) => {
      if (event.button !== 2 || !markingContent(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      color = (color + 1) % colors.length;
      root.style.setProperty("--fenbi-mark-color", colors[color]);
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey ||
          event.altKey || event.metaKey || event.shiftKey ||
          event.target.closest?.(`${editableSelector}, [role=dialog]`) || !canMark) return;
      const pressed = event.key.toLowerCase();
      if (pressed !== toggleKey && pressed !== removeKey) return;
      const underPointer = pointer && document.elementFromPoint(...pointer);
      const question = underPointer?.closest(questionSelector);
      if (pressed === removeKey) {
        if (question && underPointer.closest(".ti-content") && removeAt(question, ...pointer)) {
          event.preventDefault();
          event.stopPropagation();
        }
      } else if (question || editing) {
        event.preventDefault();
        toggle(question || editing);
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      suppressClickFor = null;
      const content = markingContent(event.target);
      drag = content && { content, id: event.pointerId, x: event.clientX, y: event.clientY };
    }, true);
    document.addEventListener("pointercancel", (event) => {
      if (drag?.id === event.pointerId) drag = null;
    });
    document.addEventListener("click", (event) => {
      if (!event.detail || !suppressClickFor?.contains(event.target)) return;
      suppressClickFor = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    document.addEventListener("pointerup", (event) => {
      if (!drag || event.button !== 0 || drag.id !== event.pointerId) return;
      const { content, x, y, moved } = drag;
      drag = null;
      if (moved || Math.hypot(event.clientX - x, event.clientY - y) >= 4) suppressClickFor = content;
      if (markingContent(event.target) !== content) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return;
      const range = selection.getRangeAt(0);
      if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return;
      suppressClickFor = content;
      const mark = new StaticRange({
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset,
      });
      if (!marks.has(editing)) marks.set(editing, []);
      const highlight = highlights[color];
      marks.get(editing).push({ range: mark, highlight });
      highlight.add(mark);
      // 用户划过选项时，先让浏览器完成本次点击的原生处理。
      setTimeout(() => {
        if (selection.rangeCount && selection.getRangeAt(0) === range) selection.removeAllRanges();
      }, 0);
      update();
    }, true);

    refresh();
    window.__fenbiRefreshStudyShortcuts = async () => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (!invoke) return;
      try {
        const [revision, [nextToggle, nextRemove]] = await invoke("study_shortcuts");
        if (revision <= shortcutRevision) return;
        shortcutRevision = revision;
        toggleKey = nextToggle;
        removeKey = nextRemove;
        update();
      } catch (error) {
        console.warn("[fenbi-wrapper] 读取标注快捷键失败", error);
      }
    };
    window.__fenbiRefreshStudyShortcuts();
    new MutationObserver((records) => {
      if (records.some(({target}) => !target.closest?.(".fenbi-study-actions"))) refresh();
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
