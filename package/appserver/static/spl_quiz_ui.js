/**
 * SPL Quiz — Splunk dashboard client (grading and SPL wiring ported from spl-lesson-sample).
 */
require(["jquery"], function ($) {
  "use strict";

  var SPL_QUIZ_APP_ID = "spl_quiz";
  var SPL_QUIZ_BUNDLE = "0.1.0";
  /** transforms.conf user lookup name (CSV basename) */
  var SPL_QUIZ_LOOKUP_USER = "spl_quiz_user_problems";
  /** Sample-problems lookup (same wide CSV columns as SPL_QUIZ_LOOKUP_USER) */
  var SPL_QUIZ_LOOKUP_SAMPLE = "spl_quiz_sample_problems";
  /** Sample events as one lookup (virtual_index names the virtual index) */
  var SPL_QUIZ_SAMPLE_EVENTS_LOOKUP = "spl_quiz_sample_events";
  /** Sample: virtual_index used to force zero rows when leading index= mismatches problem indexName (name absent from lookup) */
  var SPL_QUIZ_SAMPLE_FALSE_INDEX = "zz_spl_quiz_nomatch";
  /** Legacy: column holding one-cell JSON problem object (read compat) */
  var USER_LOOKUP_LEGACY_JSON_FIELD = "problem_json";
  /** Column order for spl_quiz_user_problems.csv (matches header and outputlookup table) */
  var LOOKUP_PROBLEM_FIELDS = [
    "id",
    "category",
    "title",
    "indexName",
    "statement",
    "hint",
    "placeholder",
    "logPreviewSpl",
    "referenceSpl",
  ];

  /** Placeholder sample for edit form (same as lookup row b1) */
  var EDITOR_FORM_SAMPLE_B1 = {
    id: "b1",
    category: "Beginner",
    title: "5xx event count",
    indexName: "tutorial_b1",
    statement:
      "Count events whose HTTP status is in the 5xx range. Use status filtering and stats count. Return exactly one row.",
    hint: "Filter to 5xx with status>=500, then stats count.",
    placeholder: "index=tutorial_b1\n(filter to 5xx, then count)",
    referenceSpl: "status>=500 | stats count",
  };

  /** Always-on console diagnostic line (one JSON line, easy to correlate with Network) */
  function splQuizClientLog(evt, detail) {
    var o = { ts: new Date().toISOString(), bundle: SPL_QUIZ_BUNDLE, evt: String(evt || "") };
    if (detail && typeof detail === "object") {
      var k;
      for (k in detail) {
        if (Object.prototype.hasOwnProperty.call(detail, k)) {
          o[k] = detail[k];
        }
      }
    } else if (detail != null) {
      o.msg = String(detail);
    }
    try {
      console.warn("[spl_quiz]", JSON.stringify(o));
    } catch (e1) {
      try {
        console.warn("[spl_quiz]", evt, detail);
      } catch (e2) {}
    }
  }

  /** For console paste: trace boot→init (not in server _internal) */
  function installSplQuizDiagHandlers() {
    if (window.__splQuizDiagHandlers) return;
    window.__splQuizDiagHandlers = true;
    try {
      window.addEventListener(
        "error",
        function (ev) {
          try {
            splQuizClientLog("diag_js_error", {
              message: (ev && ev.message) || "",
              file: (ev && ev.filename) || "",
              line: ev && ev.lineno != null ? ev.lineno : "",
              col: ev && ev.colno != null ? ev.colno : "",
            });
          } catch (ignore) {}
        },
        true
      );
    } catch (ignore) {}
    try {
      window.addEventListener("unhandledrejection", function (ev) {
        try {
          var r = ev && ev.reason;
          splQuizClientLog("diag_js_unhandledrejection", {
            reason: r && r.message ? String(r.message) : r != null ? String(r) : "",
          });
        } catch (ignore2) {}
      });
    } catch (ignore3) {}
  }
  installSplQuizDiagHandlers();

  /** Avoid touching Splunk Web globals before load (prevents ReferenceError killing the dashboard) */
  function getSplunkUtil() {
    try {
      var w = window;
      for (var depth = 0; depth < 5; depth++) {
        if (typeof w.Splunk !== "undefined" && w.Splunk && w.Splunk.util) {
          return w.Splunk.util;
        }
        try {
          if (w === w.parent) break;
          w = w.parent;
        } catch (e) {
          break;
        }
      }
    } catch (ignore) {}
    return null;
  }

  /**
   * Splunk 10+ may render dashboard body inside an iframe.
   * Top-level $("#sl-...") then finds nothing and the UI stays blank.
   */
  var quizScope$ = null;
  var editScope$ = null;

  function forEachDashboardDocument(fn) {
    function walk(doc, depth) {
      if (!doc || depth > 4) return;
      try {
        fn(doc);
      } catch (e) {}
      try {
        var iframes = doc.getElementsByTagName("iframe");
        var f;
        for (f = 0; f < iframes.length; f++) {
          try {
            var idoc =
              iframes[f].contentDocument ||
              (iframes[f].contentWindow && iframes[f].contentWindow.document);
            if (idoc) walk(idoc, depth + 1);
          } catch (err) {}
        }
      } catch (e2) {}
    }
    walk(document, 0);
  }

  /** Some Splunk 10 UIs render panels inside open shadowRoot; getElementById alone misses them. */
  function getElementByIdInDocumentDeep(rootNode, id) {
    if (!rootNode || !id) return null;
    try {
      if (rootNode.getElementById) {
        var byId = rootNode.getElementById(id);
        if (byId) return byId;
      }
    } catch (e) {}
    try {
      var all = rootNode.querySelectorAll ? rootNode.querySelectorAll("*") : [];
      var i;
      for (i = 0; i < all.length; i++) {
        var n = all[i];
        if (n.shadowRoot) {
          var inner = getElementByIdInDocumentDeep(n.shadowRoot, id);
          if (inner) return inner;
        }
      }
    } catch (e2) {}
    return null;
  }

  /** Collect all id-matching nodes in tree (incl. open shadow). Splunk may clone hidden duplicates. */
  function collectNodesWithIdDeep(rootNode, idStr, out) {
    if (!rootNode || !out) return;
    var idAttr = String(idStr || "");
    if (!idAttr) return;
    try {
      if (rootNode.querySelectorAll) {
        var nl = rootNode.querySelectorAll('[id="' + idAttr.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"]');
        var i;
        for (i = 0; i < nl.length; i++) out.push(nl[i]);
      }
    } catch (e0) {}
    try {
      var all = rootNode.querySelectorAll ? rootNode.querySelectorAll("*") : [];
      var j;
      for (j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) collectNodesWithIdDeep(all[j].shadowRoot, idStr, out);
      }
    } catch (e1) {}
  }

  /** Prefer a node with real on-screen area (skip 0×0 hidden clones) */
  function pickVisibleRootCandidate(nodes) {
    if (!nodes || !nodes.length) return { el: null, index: -1, total: 0, fallback: false };
    var k;
    var pickedIndex = -1;
    for (k = 0; k < nodes.length; k++) {
      var node = nodes[k];
      if (!node || !node.isConnected) continue;
      try {
        var r = node.getBoundingClientRect();
        if (r.width >= 2 && r.height >= 2) {
          pickedIndex = k;
          break;
        }
      } catch (eR) {}
    }
    if (pickedIndex < 0) {
      for (k = 0; k < nodes.length; k++) {
        if (nodes[k] && nodes[k].isConnected) {
          return { el: nodes[k], index: k, total: nodes.length, fallback: true };
        }
      }
      return { el: nodes[0] || null, index: 0, total: nodes.length, fallback: true };
    }
    return { el: nodes[pickedIndex], index: pickedIndex, total: nodes.length, fallback: false };
  }

  /**
   * Fallback for legacy DOM without id / single match.
   * Walks shadow roots too.
   */
  function findQuizRootLegacyInSubtree(rootNode) {
    if (!rootNode) return null;
    try {
      var byId = getElementByIdInDocumentDeep(rootNode, "spl-quiz-root");
      if (byId) return byId;
    } catch (e0) {}
    try {
      if (rootNode.querySelector) {
        var q = rootNode.querySelector(
          ".spl-quiz-exercise-sample, .spl-quiz-exercise-user, .spl-quiz-exercise"
        );
        if (q) return q;
      }
    } catch (e1) {}
    try {
      var all = rootNode.querySelectorAll ? rootNode.querySelectorAll("*") : [];
      var j;
      for (j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) {
          var inner = findQuizRootLegacyInSubtree(all[j].shadowRoot);
          if (inner) return inner;
        }
      }
    } catch (e2) {}
    return null;
  }

  function findEditRootLegacyInSubtree(rootNode) {
    if (!rootNode) return null;
    try {
      var byId = getElementByIdInDocumentDeep(rootNode, "spl-quiz-edit-root");
      if (byId) return byId;
    } catch (e0) {}
    try {
      if (rootNode.querySelector) {
        var q = rootNode.querySelector(".spl-quiz-edit-root");
        if (q) return q;
      }
    } catch (e1) {}
    try {
      var all = rootNode.querySelectorAll ? rootNode.querySelectorAll("*") : [];
      var j;
      for (j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) {
          var inner2 = findEditRootLegacyInSubtree(all[j].shadowRoot);
          if (inner2) return inner2;
        }
      }
    } catch (e2) {}
    return null;
  }

  function resolveSplQuizRootElement() {
    var merged = [];
    forEachDashboardDocument(function (doc) {
      try {
        collectNodesWithIdDeep(doc, "spl-quiz-root", merged);
      } catch (e) {}
    });
    var pv = pickVisibleRootCandidate(merged);
    if (pv.el) {
      if (pv.total > 1 || pv.fallback) {
        try {
          splQuizClientLog("diag_root_visible_pick", {
            kind: "quiz",
            total: pv.total,
            pickedIndex: pv.index,
            fallback: !!pv.fallback,
          });
        } catch (ignoreP) {}
      }
      return pv.el;
    }
    var found = null;
    forEachDashboardDocument(function (doc) {
      if (found) return;
      try {
        found = findQuizRootLegacyInSubtree(doc);
      } catch (e2) {}
    });
    return found;
  }

  function resolveSplQuizEditRootElement() {
    var merged = [];
    forEachDashboardDocument(function (doc) {
      try {
        collectNodesWithIdDeep(doc, "spl-quiz-edit-root", merged);
      } catch (e) {}
    });
    var pv = pickVisibleRootCandidate(merged);
    if (pv.el) {
      if (pv.total > 1 || pv.fallback) {
        try {
          splQuizClientLog("diag_root_visible_pick", {
            kind: "edit",
            total: pv.total,
            pickedIndex: pv.index,
            fallback: !!pv.fallback,
          });
        } catch (ignoreP2) {}
      }
      return pv.el;
    }
    var found = null;
    forEachDashboardDocument(function (doc) {
      if (found) return;
      try {
        found = findEditRootLegacyInSubtree(doc);
      } catch (e2) {}
    });
    return found;
  }

  function getSplQuizRootJq($jq) {
    var el = resolveSplQuizRootElement();
    return el ? $jq(el) : $jq([]);
  }

  function getSplQuizRootEl() {
    return resolveSplQuizRootElement();
  }

  function getSplQuizEditRootJq($jq) {
    var el = resolveSplQuizEditRootElement();
    return el ? $jq(el) : $jq([]);
  }

  function getSplQuizEditRootEl() {
    return resolveSplQuizEditRootElement();
  }

  /** Intersection of getBoundingClientRect with viewport (visible portion) */
  function intersectClientRectWithViewport(r) {
    if (!r) return null;
    var vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
    var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
    var left = Math.max(r.left, 0);
    var top = Math.max(r.top, 0);
    var right = Math.min(r.right, vw);
    var bottom = Math.min(r.bottom, vh);
    if (right <= left || bottom <= top) return null;
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  /**
   * When the root sits under the title bar, rect top can be negative and
   * hit-testing targets the dashboard header. Scroll panel into view.
   */
  function scrollSplQuizPanelIntoView(why) {
    var root = null;
    try {
      if (isSplQuizEditViewUrl()) root = resolveSplQuizEditRootElement();
      else root = resolveSplQuizRootElement();
    } catch (e0) {}
    if (!root) return;
    try {
      root.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (e1) {
      try {
        root.scrollIntoView(true);
      } catch (e2) {}
    }
    try {
      splQuizClientLog("diag_scroll_into_view", { why: String(why || "") });
    } catch (e3) {}
  }

  /**
   * If dashboard row/panel wrappers use overflow:hidden + fixed height, children get clipped:
   * getBoundingClientRect looks large but offsetHeight stays small (DOM exists but looks invisible).
   * From root toward body, reset hidden/clip to visible (only from this dashboard's script).
   */
  function repairSplunkHtmlPanelOverflowClip(why) {
    var root = null;
    try {
      if (isSplQuizEditViewUrl()) root = resolveSplQuizEditRootElement();
      else root = resolveSplQuizRootElement();
    } catch (e0) {}
    if (!root) return;
    try {
      root.style.setProperty("contain", "none", "important");
    } catch (eR0) {}
    var el = root;
    var n = 0;
    var fixed = 0;
    while (el && n < 26) {
      try {
        if (el.nodeType === 1) {
          var st = window.getComputedStyle(el);
          var o = st && st.overflow ? String(st.overflow) : "";
          var ox = st && st.overflowX ? String(st.overflowX) : "";
          var oy = st && st.overflowY ? String(st.overflowY) : "";
          if (
            o === "hidden" ||
            o === "clip" ||
            ox === "hidden" ||
            ox === "clip" ||
            oy === "hidden" ||
            oy === "clip"
          ) {
            el.style.setProperty("overflow", "visible", "important");
            try {
              el.style.setProperty("overflow-x", "visible", "important");
            } catch (eOx) {}
            try {
              el.style.setProperty("overflow-y", "visible", "important");
            } catch (eOy) {}
            fixed++;
          }
        }
      } catch (e1) {}
      try {
        el = el.parentElement;
      } catch (e2) {
        break;
      }
      n++;
    }
    try {
      splQuizClientLog("diag_overflow_clip_repair", {
        why: String(why || ""),
        ancestorsOverflowFixed: fixed,
        walked: n,
      });
    } catch (e3) {}
    try {
      var br = root.getBoundingClientRect();
      var oh = root.offsetHeight;
      var ow = root.offsetWidth;
      if (Math.abs(br.height - oh) > 80 || Math.abs(br.width - ow) > 80) {
        splQuizClientLog("diag_root_layout_mismatch", {
          why: String(why || ""),
          bboxH: Math.round(br.height),
          offsetH: oh,
          bboxW: Math.round(br.width),
          offsetW: ow,
          hint: "Possible parent overflow/max-height clip; see diag_overflow_clip_repair",
        });
      }
    } catch (e4) {}
  }

  /**
   * In Simple XML HTML panels, Splunk wrappers often use pointer-events:none with auto on children,
   * but some builds leave ancestors at none so clicks never reach visible UI.
   * Walk from quiz/edit root toward body and restore auto only where needed.
   * @param {string} [why] for diagnostic logs
   */
  function repairSplunkHtmlPanelPointerEvents(why) {
    var root = null;
    try {
      if (isSplQuizEditViewUrl()) root = resolveSplQuizEditRootElement();
      else root = resolveSplQuizRootElement();
    } catch (e0) {}
    if (!root) return;
    scrollSplQuizPanelIntoView(why);
    repairSplunkHtmlPanelOverflowClip(why);
    var fixed = 0;
    var depth = 0;
    var el = root;
    while (el && depth < 28) {
      try {
        if (el.nodeType === 1) {
          var st = window.getComputedStyle(el);
          if (st && st.pointerEvents === "none") {
            el.style.setProperty("pointer-events", "auto", "important");
            fixed++;
          }
        }
      } catch (e1) {}
      try {
        el = el.parentElement;
      } catch (e2) {
        break;
      }
      depth++;
    }
    try {
      root.style.setProperty("position", "relative", "important");
      root.style.setProperty("z-index", "200", "important");
      root.style.setProperty("pointer-events", "auto", "important");
    } catch (e3) {}
    try {
      splQuizClientLog("diag_pointer_repair", {
        why: String(why || ""),
        ancestorsPointerEventsFixed: fixed,
        walked: depth,
      });
    } catch (e4) {}
  }

  /**
   * elementFromPoint at center of root∩viewport (avoid hitting only the title band).
   */
  function diagPointerHitThrough(why) {
    var root = null;
    try {
      if (isSplQuizEditViewUrl()) root = resolveSplQuizEditRootElement();
      else root = resolveSplQuizRootElement();
    } catch (e0) {}
    if (!root || !root.getBoundingClientRect) return;
    var r = root.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    var vis = intersectClientRectWithViewport(r);
    if (!vis || vis.width < 2 || vis.height < 2) {
      try {
        splQuizClientLog("diag_element_from_point", {
          why: String(why || ""),
          note: "no_visible_intersection",
          rootTop: Math.round(r.top),
          rootH: Math.round(r.height),
        });
      } catch (e0b) {}
      return;
    }
    var x = Math.floor(vis.left + vis.width * 0.5);
    var y = Math.floor(vis.top + vis.height * 0.5);
    try {
      var hit = document.elementFromPoint(x, y);
      var under = false;
      try {
        under = !!(hit && root.contains(hit));
      } catch (e1) {}
      var cls = "";
      try {
        cls =
          hit && hit.className
            ? String(hit.className)
                .replace(/\s+/g, " ")
                .slice(0, 180)
            : "";
      } catch (e2) {}
      splQuizClientLog("diag_element_from_point", {
        why: String(why || ""),
        x: x,
        y: y,
        rootTop: Math.round(r.top),
        visibleSlice: { w: Math.round(vis.width), h: Math.round(vis.height) },
        hitTag: hit ? hit.tagName : "",
        hitId: hit && hit.id ? String(hit.id).slice(0, 96) : "",
        hitCls: cls,
        underSplQuizRoot: under,
      });
    } catch (e3) {}
  }

  /** Hit-test after layout settles post-scrollIntoView */
  function scheduleDiagPointerHitThrough(why) {
    var w = String(why || "");
    function run() {
      try {
        diagPointerHitThrough(w);
      } catch (e0) {}
    }
    try {
      if (window.requestAnimationFrame) {
        window.requestAnimationFrame(function () {
          window.requestAnimationFrame(run);
        });
      } else {
        setTimeout(run, 32);
      }
    } catch (e1) {
      setTimeout(run, 0);
    }
  }

  /**
   * Splunk Enterprise may cover the UI with a body-level `.preload` ("Loading…").
   * If internal REST errors delay completion callbacks, that layer can hide the dashboard.
   * Only dismiss when this app's quiz/edit UI exists in the real DOM (not other pages; script is view-only).
   * @param {string} [why] for diagnostic logs
   */
  function dismissSplunkEnterprisePreloadOverlay(why) {
    function quizShellReady() {
      try {
        var root = resolveSplQuizRootElement();
        if (root && root.querySelector && root.querySelector("#sl-problem")) return true;
      } catch (e1) {}
      return false;
    }
    function editShellReady() {
      try {
        var er = resolveSplQuizEditRootElement();
        if (er && er.querySelector && er.querySelector("#sl-editor-list")) return true;
      } catch (e2) {}
      return false;
    }
    if (!quizShellReady() && !editShellReady()) {
      try {
        splQuizClientLog("diag_preload_skip", {
          why: String(why || ""),
          reason: "shell_not_ready",
        });
      } catch (e0) {}
      return;
    }
    var seen = {};
    function hideOne(pre) {
      if (!pre || seen[pre]) return;
      seen[pre] = true;
      try {
        pre.style.setProperty("display", "none", "important");
      } catch (e3) {}
      try {
        pre.style.setProperty("visibility", "hidden", "important");
      } catch (e4) {}
      try {
        pre.style.setProperty("pointer-events", "none", "important");
      } catch (e5) {}
    }
    function collectPreloads() {
      var out = [];
      function q(doc) {
        if (!doc || !doc.querySelector) return;
        try {
          var p = doc.querySelector(".preload");
          if (p) out.push(p);
        } catch (e6) {}
      }
      q(document);
      try {
        if (window.top && window.top !== window) q(window.top.document);
      } catch (e7) {}
      return out;
    }
    var list = collectPreloads();
    if (!list.length) {
      try {
        splQuizClientLog("diag_preload_skip", { why: String(why || ""), reason: "no_preload_node" });
      } catch (e8) {}
      repairSplunkHtmlPanelPointerEvents(why);
      scheduleDiagPointerHitThrough(why);
      return;
    }
    var i;
    for (i = 0; i < list.length; i++) hideOne(list[i]);
    try {
      document.body && document.body.classList.add("spl-quiz-preload-dismissed");
    } catch (e9) {}
    try {
      if (window.top && window.top.document && window.top.document.body) {
        window.top.document.body.classList.add("spl-quiz-preload-dismissed");
      }
    } catch (e10) {}
    try {
      splQuizClientLog("diag_preload_dismiss", { why: String(why || ""), count: list.length });
    } catch (e11) {}
    repairSplunkHtmlPanelPointerEvents(why);
    scheduleDiagPointerHitThrough(why);
  }

  /**
   * Whether we are on the edit view. Prefer URL over DOM id (avoid mis-detecting edit vs quiz).
   * @returns {boolean}
   */
  function isSplQuizEditViewUrl() {
    try {
      var u = window.location.href || "";
      var p = window.location.pathname || "";
      return u.indexOf("spl_quiz_edit") >= 0 || p.indexOf("spl_quiz_edit") >= 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Exercise mode when not on edit: spl_quiz=user-only, spl_quiz_sample=sample-only.
   * iframe URLs may omit view name; resolveSplQuizExerciseMode prefers DOM.
   * @returns {"user"|"sample"}
   */
  function getSplQuizExerciseMode() {
    try {
      var parts = [];
      function pushLoc(w) {
        if (!w) return;
        try {
          parts.push(String(w.location.href || ""));
          parts.push(String(w.location.pathname || ""));
        } catch (ignore) {}
      }
      pushLoc(window);
      try {
        if (window.parent && window.parent !== window) {
          pushLoc(window.parent);
        }
      } catch (ignore2) {}
      var blob = parts.join("\n");
      if (blob.indexOf("spl_quiz_sample") >= 0) {
        return "sample";
      }
      return "user";
    } catch (e2) {
      return "user";
    }
  }

  /**
   * Prefer dashboard XML data-spl-quiz-mode when iframe URL lacks view name.
   * @param {JQuery} $quizRoot from getSplQuizRootJq
   * @returns {"user"|"sample"}
   */
  function resolveSplQuizExerciseMode($quizRoot) {
    try {
      if ($quizRoot && $quizRoot.length) {
        var el = $quizRoot.get ? $quizRoot.get(0) : null;
        if (el) {
          try {
            if (el.classList && el.classList.contains("spl-quiz-exercise-sample")) {
              return "sample";
            }
            if (el.classList && el.classList.contains("spl-quiz-exercise-user")) {
              return "user";
            }
          } catch (ignoreCls) {}
          if (typeof el.getAttribute === "function") {
            var m = el.getAttribute("data-spl-quiz-mode");
            if (m === "sample" || m === "user") {
              return m;
            }
          }
        }
      }
    } catch (ignore) {}
    return getSplQuizExerciseMode();
  }

  /** Scoped find under quiz or edit root (iframe-aware) */
  function sl(selector) {
    try {
      if (quizScope$ && quizScope$.length) {
        var nl = quizScope$.get(0);
        if (nl && typeof nl.isConnected === "boolean" && !nl.isConnected) {
          var fixL = getSplQuizRootJq($);
          if (fixL.length && fixL.find("#sl-problem").length) quizScope$ = fixL;
        }
      }
      if (editScope$ && editScope$.length) {
        var ne = editScope$.get(0);
        if (ne && typeof ne.isConnected === "boolean" && !ne.isConnected) {
          var fixE = getSplQuizEditRootJq($);
          if (fixE.length && fixE.find("#sl-editor-list").length) editScope$ = fixE;
        }
      }
    } catch (ignoreSl) {}
    var scope =
      quizScope$ && quizScope$.length ? quizScope$ : editScope$ && editScope$.length ? editScope$ : null;
    if (!scope || !scope.length) return $();
    return scope.find(selector);
  }

  function initSplQuizApp(mvc, SearchManager) {
  var BLOCKED_REGEX = [
    /\|\s*script\b/i,
    /\brunshell\b/i,
    /\bwalklex\b/i,
    /\|\s*collect\b/i,
    /\boutputcsv\b/i,
    /\boutputlookup\b/i,
    /\|\s*rest\b/i,
    /\bsendemail\b/i,
    /\bmcollect\b/i,
    /\bmeventcollect\b/i,
  ];
  /** Index name embedded in index="..." (quote-safe, injection-safe) */
  var INDEX_NAME_RE = /^[A-Za-z0-9_.@-]{1,200}$/;

  /* Avoid Set for older IE compatibility */
  var INTERNAL_KEYS = {
    _bkt: 1,
    _cd: 1,
    _indextime: 1,
    _si: 1,
    _serial: 1,
    _sourcetype: 1,
    linecount: 1,
    splunk_server: 1,
    splunk_server_group: 1,
    punct: 1,
    timestamp: 1,
    virtual_index: 1,
  };

  function isInternalResultKey(k) {
    if (!k) return true;
    if (INTERNAL_KEYS[k]) return true;
    if (k === "_splQuizJob") return true;
    return false;
  }

  function stripTimeClauses(s) {
    return String(s || "")
      .replace(/\bearliest\s*=\s*[^\s|]+/gi, " ")
      .replace(/\blatest\s*=\s*[^\s|]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Shared validation for SPL sent from the client (user input and lookup-derived).
   * @param {{ stripLeadingPipe?: boolean }} opts do not strip leading pipes from lookup (e.g. | sort …).
   */
  function splSafetyCore(raw, opts) {
    opts = opts || {};
    var stripLead = opts.stripLeadingPipe !== false;
    var s = String(raw || "").trim();
    if (!s) {
      var e0 = new Error("SPL is empty");
      e0.code = "EMPTY";
      throw e0;
    }
    if (s.length > 8000) {
      var eL = new Error("SPL is too long");
      eL.code = "TOO_LONG";
      throw eL;
    }
    var bi;
    for (bi = 0; bi < BLOCKED_REGEX.length; bi++) {
      if (BLOCKED_REGEX[bi].test(s)) {
        var eB = new Error("SPL contains a blocked command or pipe (client-side policy).");
        eB.code = "BLOCKED";
        throw eB;
      }
    }
    s = stripTimeClauses(s);
    if (stripLead) {
      while (s.indexOf("|") === 0) s = s.replace(/^\|\s*/, "").trim();
    }
    s = s.replace(/\bindex\s*=\s+/gi, "index=");
    return s;
  }

  function sanitizeUserFragment(raw) {
    return splSafetyCore(raw, { stripLeadingPipe: true });
  }

  /** Problem logPreviewSpl / referenceSpl (preserve leading |) */
  function sanitizeLookupSplFragment(raw) {
    return splSafetyCore(raw, { stripLeadingPipe: false });
  }

  function assertSafeIndexNameForSearch(name) {
    var n = String(name || "").trim();
    if (!n) {
      var e = new Error("index name is empty");
      e.code = "EMPTY_INDEX";
      throw e;
    }
    if (!INDEX_NAME_RE.test(n)) {
      var e2 = new Error("index name must be alphanumeric plus ._@- only, up to 200 characters.");
      e2.code = "BAD_INDEX";
      throw e2;
    }
    return n;
  }

  function buildProblemSearch(indexName, fragment) {
    var safeIdx = assertSafeIndexNameForSearch(indexName);
    var idx = safeIdx.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    var base = 'search earliest=0 latest=now index="' + idx + '"';
    var f = sanitizeLookupSplFragment(fragment);
    return base + " " + f;
  }

  function buildUserSearch(fragment) {
    var inner = sanitizeUserFragment(fragment);
    if (!/\bindex\s*=/i.test(inner)) {
      var e = new Error("SPL must include index=... (e.g. index=tutorial_p001).");
      e.code = "NO_INDEX";
      throw e;
    }
    if (inner.indexOf("|") === 0) {
      var e2 = new Error("Start with index=... (do not begin with |).");
      e2.code = "BAD_START";
      throw e2;
    }
    return "search earliest=0 latest=now " + inner;
  }

  /**
   * Sample: replace real index with one lookup filtered by virtual_index.
   * Rewrite `[ search index=... ]` subsearches to the same lookup.
   */
  function sampleVirtualDataBase(indexName) {
    var safeIdx = assertSafeIndexNameForSearch(indexName);
    var idx = safeIdx.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return (
      "| inputlookup " +
      SPL_QUIZ_SAMPLE_EVENTS_LOOKUP +
      ' | search virtual_index="' +
      idx +
      '" | eval _time=tonumber(_time) | eval status=tonumber(status)'
    );
  }

  function rewriteSampleSubsearches(fragment) {
    var s = String(fragment || "");
    var lu = SPL_QUIZ_SAMPLE_EVENTS_LOOKUP;
    return s.replace(/\[(\s*)search\s+index\s*=\s*([\w.*@-]+)\s+/gi, function (_full, sp, idx) {
      return "[" + sp + "| inputlookup " + lu + ' | search virtual_index="' + idx + '" ';
    });
  }

  /**
   * Unlike index searches, lookup-based pipelines treat a bare predicate after the pipe as continuing eval.
   * Prefix non-| fragments with | search.
   */
  function prefixSamplePipelineFragment(fragment) {
    var f = String(fragment || "").trim();
    if (!f) return f;
    if (f.indexOf("|") === 0) return f;
    return "| search " + f;
  }

  function buildSampleVirtualSearch(indexName, fragment) {
    var f = sanitizeLookupSplFragment(fragment);
    f = rewriteSampleSubsearches(f);
    f = prefixSamplePipelineFragment(f);
    return sampleVirtualDataBase(indexName) + " " + f;
  }

  /**
   * Sample: whether user's index= matches this problem's indexName (exact or *-only glob).
   * Patterns Splunk won't match (e.g. *abc) yield false → zero rows.
   */
  function sampleIndexPatternMatchesExpected(userPat, expectedIndexName) {
    var p = String(userPat || "");
    var e = String(expectedIndexName || "");
    if (p.indexOf("*") < 0) {
      return p === e;
    }
    if (p === "*") {
      return true;
    }
    var esc = function (seg) {
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    };
    var parts = p.split("*");
    var pi;
    for (pi = 0; pi < parts.length; pi++) {
      parts[pi] = esc(parts[pi]);
    }
    var body = parts.join(".*");
    return new RegExp("^" + body + "$").test(e);
  }

  function buildUserSearchSample(fragment, expectedIndexName) {
    var inner = sanitizeUserFragment(fragment);
    /* Unquoted values allow *; pattern [\w.*@-]+ (- only at end) */
    var idxMatch = inner.match(/^\s*index\s*=\s*(?:"([^"]+)"|([\w.*@-]+))\s*/i);
    if (!idxMatch) {
      var e0 = new Error("SPL must include index=... (e.g. index=tutorial_b1).");
      e0.code = "NO_INDEX";
      throw e0;
    }
    var idxVal = idxMatch[1] || idxMatch[2];
    var idxStr = String(idxVal);
    var expStr = String(expectedIndexName);
    var rest = inner.slice(idxMatch[0].length).trim();
    rest = rewriteSampleSubsearches(rest);
    rest = prefixSamplePipelineFragment(rest);
    var vIndex = sampleIndexPatternMatchesExpected(idxStr, expStr)
      ? expectedIndexName
      : SPL_QUIZ_SAMPLE_FALSE_INDEX;
    return sampleVirtualDataBase(vIndex) + " " + rest;
  }

  function pickExerciseProblemSearch(exerciseMode, indexName, fragment) {
    if (exerciseMode === "sample") {
      return buildSampleVirtualSearch(indexName, fragment);
    }
    return buildProblemSearch(indexName, fragment);
  }

  function pickExerciseUserSearch(exerciseMode, spl, indexName) {
    if (exerciseMode === "sample") {
      return buildUserSearchSample(spl, indexName);
    }
    return buildUserSearch(spl);
  }

  function normalizeRow(row) {
    var o = {};
    var keys = Object.keys(row).sort();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (INTERNAL_KEYS[k]) continue;
      var v = row[k];
      if (typeof v === "string" && v !== "" && /^-?\d+(\.\d+)?$/.test(v.trim())) {
        var n = Number(v);
        if (!isNaN(n)) v = n;
      }
      o[k] = v;
    }
    return o;
  }

  function normalizeResults(results) {
    return results
      .map(normalizeRow)
      .sort(function (a, b) {
        return JSON.stringify(a).localeCompare(JSON.stringify(b));
      });
  }

  function resultsEqual(a, b) {
    return JSON.stringify(normalizeResults(a)) === JSON.stringify(normalizeResults(b));
  }

  function bothSingleRowCountZero(nUser, nRef) {
    if (nUser.length !== 1 || nRef.length !== 1) return false;
    var a = nUser[0];
    var b = nRef[0];
    if (!Object.prototype.hasOwnProperty.call(a, "count") || !Object.prototype.hasOwnProperty.call(b, "count")) {
      return false;
    }
    var ca = Number(a.count);
    var cb = Number(b.count);
    if (isNaN(ca) || isNaN(cb)) return false;
    return ca === 0 && cb === 0;
  }

  function normalizeB2DistinctIpRows(rows) {
    if (!Array.isArray(rows) || rows.length !== 1) return rows;
    var r = rows[0];
    if (!r || typeof r !== "object") return rows;
    var c = r.count;
    var dc = r["dc(clientip)"];
    if (c != null && dc == null) return [{ count: Number(c) }];
    if (dc != null) return [{ count: Number(dc) }];
    return rows;
  }

  function normalizeTopStyleRows(rows, groupField) {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    var cleaned = rows.map(function (row) {
      if (!row || typeof row !== "object") return row;
      var g = row[groupField];
      var c = row.count;
      if (g === undefined || g === null || c === undefined || c === null) return row;
      var o = {};
      o[groupField] = g;
      o.count = Number(c);
      return o;
    });
    cleaned.sort(function (a, b) {
      return String(a[groupField]).localeCompare(String(b[groupField]), undefined, { numeric: true });
    });
    return cleaned;
  }

  function normalizeA1MaxSeqRows(rows) {
    if (!Array.isArray(rows) || rows.length !== 1) return rows;
    var r = rows[0];
    if (!r || typeof r !== "object") return rows;
    var maxKey = null;
    var keys = Object.keys(r);
    for (var i = 0; i < keys.length; i++) {
      if (/^max\(/i.test(keys[i])) {
        maxKey = keys[i];
        break;
      }
    }
    if (!maxKey) return rows;
    var v = Number(r[maxKey]);
    if (isNaN(v)) return rows;
    return [{ "max(seq)": v }];
  }

  function normalizeRowsForGrade(problemId, rows) {
    switch (problemId) {
      case "b2":
        return normalizeB2DistinctIpRows(rows);
      case "b3":
        return normalizeTopStyleRows(rows, "status");
      case "a2":
        return normalizeTopStyleRows(rows, "order_id");
      case "a1":
        return normalizeA1MaxSeqRows(rows);
      default:
        return rows;
    }
  }

  function gradeSubmission(userResults, refResults) {
    var nUser = normalizeResults(userResults);
    var nRef = normalizeResults(refResults);
    var ok = resultsEqual(userResults, refResults);
    if (nRef.length === 0 || nUser.length === 0) {
      ok = false;
    } else if (ok && bothSingleRowCountZero(nUser, nRef)) {
      ok = false;
    }
    return { ok: ok, nUser: nUser.length, nRef: nRef.length };
  }

  function nonemptyField(v) {
    return v !== undefined && v !== null && String(v).trim() !== "";
  }

  function alignLogPreviewRows(rows) {
    return rows.map(function (row) {
      var r = $.extend({}, row);
      var hasU = nonemptyField(r._time);
      var hasT = nonemptyField(r.time);

      if (!hasU && !hasT && typeof r._raw === "string") {
        try {
          var j = JSON.parse(r._raw);
          if (j && j.time != null) {
            r.time = j.time;
            hasT = true;
          }
        } catch (ignore) {}
      }

      hasU = nonemptyField(r._time);
      hasT = nonemptyField(r.time);
      if (hasU && !hasT) r.time = r._time;
      if (hasT && !hasU) r._time = r.time;
      return r;
    });
  }

  function parseSplunkError(xhr) {
    if (xhr && xhr.message && xhr.responseText == null && typeof xhr.status === "undefined") {
      return String(xhr.message);
    }
    var t = (xhr && xhr.responseText) || "";
    if (/^\s*<!DOCTYPE/i.test(t) || /^\s*<html/i.test(t)) {
      var st = (xhr && xhr.status) || "";
      return "Server returned an HTML error page (often 404/403). Status: " + st + " — check static asset paths and permissions.";
    }
    var m = t.match(/<msg[^>]*type="[^"]*"[^>]*>([^<]+)<\/msg>/i) || t.match(/<msg[^>]*>([^<]+)<\/msg>/i);
    if (m) return m[1].trim();
    try {
      var j = typeof xhr.responseJSON === "object" && xhr.responseJSON ? xhr.responseJSON : JSON.parse(t);
      if (j.messages && j.messages[0]) {
        return (j.messages[0].text || j.messages[0]).toString();
      }
    } catch (e) {}
    return (t && t.slice(0, 500)) || xhr.statusText || "Search failed";
  }

  /**
   * Normalize Splunk fields array when entries are objects like { name: "id" }.
   * Without this, keys become "[object Object]" and inputlookup id is always empty.
   */
  function normalizeSplunkFieldNames(fields) {
    if (!Array.isArray(fields)) return [];
    var out = [];
    var i;
    for (i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f == null) {
        out.push("");
      } else if (typeof f === "string") {
        out.push(f);
      } else if (typeof f === "object" && f.name != null) {
        out.push(String(f.name));
      } else {
        out.push(String(f));
      }
    }
    return out;
  }

  /**
   * Splunk MVC results models vary: toJSON() may return
   * - an array of row objects, or
   * - a matrix { fields: [...], rows: [...] }.
   * Treating only the latter as an array yields zero rows.
   */
  function rowsFromToJsonPayload(j) {
    if (j == null) return [];
    if (typeof j === "string") {
      try {
        j = JSON.parse(j);
      } catch (e) {
        return [];
      }
    }
    if (Array.isArray(j)) {
      return j.map(function (row) {
        if (row && typeof row.toJSON === "function") return row.toJSON();
        return row;
      });
    }
    /** Splunk REST output_mode=json uses { results: [...] }; MVC toJSON may match. */
    if (typeof j === "object" && Array.isArray(j.results)) {
      return j.results.map(function (row) {
        if (row && typeof row.toJSON === "function") return row.toJSON();
        return row;
      });
    }
    if (
      typeof j === "object" &&
      j.data &&
      Array.isArray(j.data.rows) &&
      (Array.isArray(j.data.fields) || Array.isArray(j.data.columns))
    ) {
      j = { fields: j.data.fields || j.data.columns, rows: j.data.rows };
    }
    if (
      typeof j === "object" &&
      Array.isArray(j.rows) &&
      (Array.isArray(j.fields) || Array.isArray(j.columns))
    ) {
      var fields = normalizeSplunkFieldNames(j.fields || j.columns);
      return j.rows.map(function (rowVals) {
        var o = {};
        var ri;
        for (ri = 0; ri < fields.length; ri++) {
          var fname = fields[ri];
          if (!fname) {
            fname = LOOKUP_PROBLEM_FIELDS[ri] != null ? LOOKUP_PROBLEM_FIELDS[ri] : String(ri);
          }
          o[fname] = rowVals[ri];
        }
        return o;
      });
    }
    return [];
  }

  function rowsFromResultsModelDeep(resultsModel) {
    if (!resultsModel || typeof resultsModel.data !== "function") return [];
    try {
      var data = resultsModel.data();
      if (!data) return [];
      if (data.attributes && Array.isArray(data.attributes.rows) && Array.isArray(data.attributes.fields)) {
        return rowsFromToJsonPayload({ fields: data.attributes.fields, rows: data.attributes.rows });
      }
    } catch (ignore) {}
    return [];
  }

  /**
   * Some builds return a Job model from manager.get("sid") instead of a string,
   * producing REST paths like /jobs/[object Object]/... (404). Normalize to a string SID.
   */
  function normalizeSearchJobSid(val) {
    if (val == null) return null;
    if (typeof val === "string") {
      var ts = val.replace(/^\s+|\s+$/g, "");
      return ts.length ? ts : null;
    }
    if (typeof val === "number" && isFinite(val)) {
      return String(val);
    }
    if (typeof val === "object") {
      if (typeof val.get === "function") {
        try {
          var g = val.get("sid");
          if (g != null && g !== val) {
            var nested = normalizeSearchJobSid(g);
            if (nested) return nested;
          }
        } catch (ignore) {}
      }
      if (val.sid != null && val.sid !== val) {
        return normalizeSearchJobSid(val.sid);
      }
      if (val.attributes && val.attributes.sid != null) {
        return normalizeSearchJobSid(val.attributes.sid);
      }
    }
    return null;
  }

  /**
   * When SearchManager's sid is a composite like "admin__...__1740000000.42",
   * REST may only accept the trailing "1740000000.42" form (the full key can 404 on /jobs/...).
   */
  function toSplunkRestJobSid(str) {
    if (!str || typeof str !== "string") return null;
    var t = str.replace(/^\s+|\s+$/g, "");
    if (!t) return null;
    if (/^\d+\.\d+$/.test(t)) return t;
    var m = t.match(/(\d{6,}\.\d+)$/);
    if (m) return m[1];
    return null;
  }

  /** Session owner for REST /servicesNS/{owner}/… (fallback admin). */
  function getSplunkSessionOwner() {
    try {
      if (typeof Splunk !== "undefined" && Splunk.session && typeof Splunk.session.get === "function") {
        var u = Splunk.session.get("user");
        if (u && typeof u.get === "function") {
          var n = u.get("name") || u.get("username");
          if (n) return String(n);
        }
      }
      if (typeof Splunk !== "undefined" && Splunk.util && typeof Splunk.util.getConfigValue === "function") {
        var c = Splunk.util.getConfigValue("USERNAME");
        if (c) return String(c);
      }
    } catch (ignore) {}
    return "admin";
  }

  /**
   * Enumerate both composite sid and trailing short sid (which works varies by build).
   * Prefer attributes over manager.get("sid") to avoid extra splunkd GETs.
   */
  function getSearchJobSidCandidates(manager) {
    if (!manager) return [];
    var raw = [];
    function push(x) {
      if (x != null) raw.push(x);
    }
    try {
      var job = manager.job;
      if (job) {
        if (job.attributes && job.attributes.sid != null) push(job.attributes.sid);
        if (job.sid != null) push(job.sid);
        if (typeof job.get === "function") push(job.get("sid"));
      }
      if (manager.searchJob) {
        var sj = manager.searchJob;
        if (sj.attributes && sj.attributes.sid != null) push(sj.attributes.sid);
        if (typeof sj.get === "function") push(sj.get("sid"));
      }
      if (manager.attributes && manager.attributes.sid != null) push(manager.attributes.sid);
      if (typeof manager.get === "function") push(manager.get("sid"));
    } catch (ignore) {}
    var seen = {};
    var order = [];
    raw.forEach(function (item) {
      var n = normalizeSearchJobSid(item);
      if (!n) return;
      if (!seen[n]) {
        seen[n] = true;
        order.push(n);
      }
      var tail = toSplunkRestJobSid(n);
      if (tail && tail !== n && !seen[tail]) {
        seen[tail] = true;
        order.push(tail);
      }
    });
    /* Try numeric SID tail first to reduce GET 404s with composite keys */
    var numericFirst = [];
    var rest = [];
    order.forEach(function (s) {
      if (/^\d+\.\d+$/.test(s)) {
        numericFirst.push(s);
      } else {
        rest.push(s);
      }
    });
    return numericFirst.concat(rest);
  }

  function getSearchJobSid(manager) {
    var c = getSearchJobSidCandidates(manager);
    return c.length ? c[0] : null;
  }

  /** On :8000, POST to /ja-JP/services/… may 404; /splunkd/__raw/services/… tunnels to splunkd. */
  function splunkdRawServicePath(servicePath) {
    if (!servicePath || servicePath.indexOf("/services") !== 0) return servicePath;
    return "/splunkd/__raw" + servicePath;
  }

  function jobEndpointsForSid(util, sid, suffix) {
    if (!util || typeof util.make_url !== "function" || !sid) return [];
    var enc = encodeURIComponent(sid);
    var owner = encodeURIComponent(getSplunkSessionOwner());
    var app = encodeURIComponent(getPreferredSplunkAppId());
    suffix = suffix || "";
    var nsRel = "/servicesNS/" + owner + "/" + app + "/search/jobs/" + enc + suffix;
    var glRel = "/services/search/jobs/" + enc + suffix;
    return [
      util.make_url(splunkdRawServicePath(nsRel)),
      util.make_url(splunkdRawServicePath(glRel)),
      util.make_url(nsRel),
      util.make_url(glRel),
    ];
  }

  function searchJobsPostUrlCandidates(util) {
    if (!util || typeof util.make_url !== "function") return [];
    var owner = encodeURIComponent(getSplunkSessionOwner());
    var app = encodeURIComponent(getPreferredSplunkAppId());
    var a = "/servicesNS/" + owner + "/" + app + "/search/jobs";
    var b = "/services/search/jobs";
    return [
      util.make_url(splunkdRawServicePath(a)),
      util.make_url(splunkdRawServicePath(b)),
      util.make_url(a),
      util.make_url(b),
    ];
  }

  function uniqueUrls(urlLists) {
    var seen = {};
    var out = [];
    var i;
    for (i = 0; i < urlLists.length; i++) {
      var j;
      for (j = 0; j < urlLists[i].length; j++) {
        var u = urlLists[i][j];
        if (u && !seen[u]) {
          seen[u] = true;
          out.push(u);
        }
      }
    }
    return out;
  }

  function splunkFormKeyHeader() {
    var h = {};
    try {
      if (typeof Splunk !== "undefined" && Splunk.util && typeof Splunk.util.getConfigValue === "function") {
        var fk = Splunk.util.getConfigValue("FORM_KEY");
        if (fk) h["X-Splunk-Form-Key"] = fk;
      }
    } catch (ignore) {}
    return h;
  }

  /** If MVC results are empty but SID exists, fetch via REST (try servicesNS first). */
  function fetchJobResultsViaRest(manager) {
    var dfd = $.Deferred();
    var cands = getSearchJobSidCandidates(manager);
    var util = getSplunkUtil();
    if (!cands.length || !util || typeof util.make_url !== "function") {
      dfd.resolve([]);
      return dfd.promise();
    }
    var urlLists = [];
    var ci;
    for (ci = 0; ci < cands.length; ci++) {
      urlLists.push(jobEndpointsForSid(util, cands[ci], "/results"));
    }
    var urls = uniqueUrls(urlLists);
    function tryUrlIndex(idx) {
      if (idx >= urls.length) {
        splQuizClientLog("job_get_results_exhausted", { sidCandidates: cands.length });
        dfd.resolve([]);
        return;
      }
      var url = urls[idx];
      $.ajax({
        url: url,
        type: "GET",
        dataType: "json",
        data: { output_mode: "json_rows", count: 10000 },
        headers: splunkFormKeyHeader(),
      })
        .done(function (data) {
          var rows = rowsFromToJsonPayload(data);
          if (rows && rows.length > 0) {
            dfd.resolve(rows);
            return;
          }
          $.ajax({
            url: url,
            type: "GET",
            dataType: "json",
            data: { output_mode: "json", count: 10000 },
            headers: splunkFormKeyHeader(),
          })
            .done(function (data2) {
              var rows2 = rowsFromToJsonPayload(data2);
              if (rows2 && rows2.length > 0) {
                dfd.resolve(rows2);
              } else {
                tryUrlIndex(idx + 1);
              }
            })
            .fail(function () {
              tryUrlIndex(idx + 1);
            });
        })
        .fail(function () {
          $.ajax({
            url: url,
            type: "GET",
            dataType: "json",
            data: { output_mode: "json", count: 10000 },
            headers: splunkFormKeyHeader(),
          })
            .done(function (data2) {
              var rows2 = rowsFromToJsonPayload(data2);
              if (rows2 && rows2.length > 0) {
                dfd.resolve(rows2);
              } else {
                tryUrlIndex(idx + 1);
              }
            })
            .fail(function () {
              tryUrlIndex(idx + 1);
            });
        });
    }
    tryUrlIndex(0);
    return dfd.promise();
  }

  /**
   * Some builds use internal Web job IDs so GET …/jobs/{sid}/results always 404.
   * POST the same SPL with exec_mode=oneshot and read results without the job SID.
   * @see https://docs.splunk.com/Documentation/Splunk/latest/RESTREF/RESTsearch#POST_search/jobs
   */
  function fetchSearchResultsViaOneshot(fullSearch) {
    var dfd = $.Deferred();
    var q = String(fullSearch || "").trim();
    if (!q) {
      dfd.resolve([]);
      return dfd.promise();
    }
    var util = getSplunkUtil();
    if (!util || typeof util.make_url !== "function") {
      dfd.resolve([]);
      return dfd.promise();
    }
    var urls = searchJobsPostUrlCandidates(util);
    var modes = ["json_rows", "json"];
    /** Saw HTTP 200 JSON with zero rows (job done, no rows). */
    var sawSuccessfulEmpty = false;
    function tryAt(uix, mix) {
      if (uix >= urls.length) {
        splQuizClientLog("oneshot_exhausted", {
          searchHead: q.slice(0, 200),
          sawSuccessfulEmpty: sawSuccessfulEmpty,
        });
        var emptyOut = [];
        if (sawSuccessfulEmpty) {
          emptyOut._splQuizOneshotEmpty = true;
        }
        dfd.resolve(emptyOut);
        return;
      }
      if (mix >= modes.length) {
        tryAt(uix + 1, 0);
        return;
      }
      var reqUrl = urls[uix];
      $.ajax({
        url: reqUrl,
        type: "POST",
        dataType: "json",
        traditional: true,
        data: {
          search: q,
          exec_mode: "oneshot",
          output_mode: modes[mix],
          count: 10000,
        },
        headers: splunkFormKeyHeader(),
      })
        .done(function (resp) {
          var payload = resp;
          if (typeof payload === "string") {
            try {
              payload = JSON.parse(payload);
            } catch (parseErr) {
              splQuizClientLog("oneshot_parse_fail", { url: reqUrl, mode: modes[mix] });
              tryAt(uix, mix + 1);
              return;
            }
          }
          var rows = rowsFromToJsonPayload(payload);
          if (rows && rows.length > 0) {
            splQuizClientLog("oneshot_ok", { url: reqUrl, mode: modes[mix], rows: rows.length });
            dfd.resolve(rows);
          } else {
            sawSuccessfulEmpty = true;
            tryAt(uix, mix + 1);
          }
        })
        .fail(function (xhr, textStatus, errThrown) {
          splQuizClientLog("oneshot_http_fail", {
            url: reqUrl,
            mode: modes[mix],
            status: xhr && xhr.status,
            textStatus: textStatus,
            err: String(errThrown || ""),
            responseHead: xhr && xhr.responseText && xhr.responseText.slice(0, 280),
          });
          tryAt(uix, mix + 1);
        });
    }
    tryAt(0, 0);
    return dfd.promise();
  }

  /** GET …/search/jobs/{sid} for eventCount etc. (try servicesNS first) */
  function fetchJobPropertiesViaRest(manager) {
    var dfd = $.Deferred();
    var cands = getSearchJobSidCandidates(manager);
    var util = getSplunkUtil();
    if (!cands.length || !util || typeof util.make_url !== "function") {
      dfd.resolve(null);
      return dfd.promise();
    }
    var urlLists = [];
    var pi;
    for (pi = 0; pi < cands.length; pi++) {
      urlLists.push(jobEndpointsForSid(util, cands[pi], ""));
    }
    var urls = uniqueUrls(urlLists);
    function parseContent(data) {
      var content = null;
      try {
        if (data && data.entry && data.entry[0] && data.entry[0].content) {
          content = data.entry[0].content;
        } else if (data && data.content) {
          content = data.content;
        }
      } catch (e) {}
      return content;
    }
    function tryPropIndex(pidx) {
      if (pidx >= urls.length) {
        splQuizClientLog("job_get_props_exhausted", { sidCandidates: cands.length });
        dfd.resolve(null);
        return;
      }
      $.ajax({
        url: urls[pidx],
        type: "GET",
        dataType: "json",
        data: { output_mode: "json" },
        headers: splunkFormKeyHeader(),
      })
        .done(function (data) {
          var content = parseContent(data);
          if (content) {
            dfd.resolve(content);
          } else {
            tryPropIndex(pidx + 1);
          }
        })
        .fail(function (xhr, textStatus, errThrown) {
          splQuizClientLog("job_get_props_http_fail", {
            url: urls[pidx],
            status: xhr && xhr.status,
            textStatus: textStatus,
          });
          tryPropIndex(pidx + 1);
        });
    }
    tryPropIndex(0);
    return dfd.promise();
  }

  function jobContentNumber(content, key) {
    if (!content || content[key] == null) return null;
    var n = Number(content[key]);
    return isNaN(n) ? null : n;
  }

  function rowsFromResultsModel(resultsModel) {
    if (!resultsModel) return [];
    try {
      if (resultsModel.data && typeof resultsModel.data === "function") {
        var data = resultsModel.data();
        if (!data) return [];
        if (typeof data.toJSON === "function") {
          return rowsFromToJsonPayload(data.toJSON());
        }
        if (data.rows && Array.isArray(data.rows)) {
          return data.rows.map(function (row) {
            if (row && typeof row.toJSON === "function") return row.toJSON();
            return row;
          });
        }
        if (data.models && typeof data.each === "function") {
          var out = [];
          data.each(function (m) {
            if (m && typeof m.toJSON === "function") out.push(m.toJSON());
            else if (m && m.attributes) out.push(m.attributes);
          });
          return out;
        }
        if (data.models && typeof data.models === "function") {
          var out2 = [];
          data.models().forEach(function (m) {
            if (m && typeof m.toJSON === "function") out2.push(m.toJSON());
          });
          return out2;
        }
      }
    } catch (ignore) {}
    return [];
  }

  /**
   * This bundle is spl_quiz-only. If getCurrentApp() is search etc.,
   * SearchManager runs in another app context and bundled transforms/lookups won't resolve.
   */
  function getPreferredSplunkAppId() {
    return SPL_QUIZ_APP_ID;
  }

  /** Oneshot for reads; outputlookup side effects must use SearchManager jobs. */
  function searchUsesOutputlookup(q) {
    return /\boutputlookup\b/i.test(String(q || ""));
  }

  /**
   * If oneshot returns rows, skip SearchManager (avoids noisy 404s when the UI hits /jobs/... with composite SIDs).
   * Fall back to SearchManager only on empty or total URL failure.
   */
  function runSearchSplunk(fullSearch) {
    var d = $.Deferred();
    if (!SearchManager) {
      d.reject(new Error("splunkjs/mvc/searchmanager is not available."));
      return d.promise();
    }
    if (!mvc) {
      d.reject(new Error("splunkjs/mvc is not available."));
      return d.promise();
    }
    if (searchUsesOutputlookup(fullSearch)) {
      runSearchSplunkViaManager(fullSearch)
        .done(function (rows) {
          d.resolve(rows);
        })
        .fail(function (err) {
          d.reject(err instanceof Error ? err : new Error(String(err)));
        });
      return d.promise();
    }
    fetchSearchResultsViaOneshot(fullSearch).done(function (oneRows) {
      if (oneRows && oneRows.length > 0) {
        splQuizClientLog("run_search_oneshot_short_circuit", {
          rows: oneRows.length,
          searchHead: String(fullSearch || "").slice(0, 120),
        });
        d.resolve(oneRows);
        return;
      }
      /* If oneshot confirms success with zero rows, skip SearchManager (faster wrong-index cases) */
      if (oneRows && oneRows._splQuizOneshotEmpty) {
        splQuizClientLog("run_search_oneshot_empty_no_manager", {
          searchHead: String(fullSearch || "").slice(0, 120),
        });
        d.resolve(oneRows);
        return;
      }
      runSearchSplunkViaManager(fullSearch)
        .done(function (rows) {
          d.resolve(rows);
        })
        .fail(function (err) {
          d.reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
    return d.promise();
  }

  /**
   * Run searches via the dashboard SearchManager when service.jobs.create is unavailable.
   */
  function runSearchSplunkViaManager(fullSearch) {
    var d = $.Deferred();
    if (!SearchManager) {
      d.reject(new Error("splunkjs/mvc/searchmanager is not available."));
      return d.promise();
    }
    if (!mvc) {
      d.reject(new Error("splunkjs/mvc is not available."));
      return d.promise();
    }

    var smId = "spl_quiz_sm_" + Date.now() + "_" + String(Math.random()).slice(2, 10);
    var manager;
    var timeoutId = setTimeout(function () {
      try {
        if (manager && typeof manager.dispose === "function") manager.dispose();
      } catch (e) {}
      d.reject(new Error("Search timed out (120 seconds)."));
    }, 120000);

    function cleanup() {
      clearTimeout(timeoutId);
      try {
        if (manager && typeof manager.dispose === "function") manager.dispose();
      } catch (e) {}
    }

    function finishOk(rows) {
      cleanup();
      d.resolve(Array.isArray(rows) ? rows : []);
    }

    function finishNg(err) {
      cleanup();
      d.reject(err instanceof Error ? err : new Error(String(err)));
    }

    try {
      manager = new SearchManager(
        {
          id: smId,
          app: getPreferredSplunkAppId(),
          owner: getSplunkSessionOwner(),
          search: fullSearch,
          preview: false,
          cache: false,
          status_buckets: 0,
          autostart: false,
        },
        { tokens: true, tokenNamespace: "submitted" }
      );
    } catch (e0) {
      finishNg(new Error("Could not create SearchManager: " + (e0.message || String(e0))));
      return d.promise();
    }

    try {
      mvc.Components.registerInstance(manager);
    } catch (regErr) {
      /* Optional on some builds */
    }

    manager.on("search:error", function (err) {
      finishNg(new Error((err && err.message) || "A search error occurred."));
    });
    manager.on("search:failed", function (state, err) {
      var msg =
        err && err.message
          ? err.message
          : state && state.content && state.content.messages && state.content.messages[0]
            ? state.content.messages[0].text
            : "Search failed.";
      finishNg(new Error(msg));
    });

    manager.on("search:done", function () {
      try {
        var resultsModel =
          manager.data("results", { count: 10000, outputMode: "json_rows" }) || manager.data("results", { count: 10000 });
        if (!resultsModel) {
          finishNg(new Error("Could not fetch result data (results)."));
          return;
        }
        var settled = false;
        var poll = null;
        function tryModelRows() {
          var rows = rowsFromResultsModel(resultsModel);
          if (!rows.length) rows = rowsFromResultsModelDeep(resultsModel);
          return rows;
        }
        function finishRows(rows) {
          if (settled) return;
          settled = true;
          try {
            if (poll) clearInterval(poll);
          } catch (ignore) {}
          var r = Array.isArray(rows) ? rows : [];
          var sid0 = getSearchJobSid(manager);
          if (r.length === 0) {
            splQuizClientLog("preview_zero", {
              sid: sid0 || "",
              searchHead: String(fullSearch || "").slice(0, 400),
            });
          }
          function pushMetaAndFinish(meta) {
            try {
              if (meta && typeof r === "object") {
                r._splQuizJob = meta;
              }
            } catch (e) {}
            finishOk(r);
          }
          if (r.length === 0 && getSearchJobSidCandidates(manager).length) {
            fetchJobPropertiesViaRest(manager).done(function (meta) {
              pushMetaAndFinish(meta);
            });
          } else {
            pushMetaAndFinish(null);
          }
        }
        function maybeRestFallback() {
          if (settled) return;
          /* Some builds treat rerunning outputlookup SPL via oneshot as blocked/double-write; use job REST only. */
          if (searchUsesOutputlookup(fullSearch)) {
            fetchJobResultsViaRest(manager).done(function (restRows) {
              if (settled) return;
              if (restRows && restRows.length > 0) {
                finishRows(restRows);
              } else {
                finishRows([]);
              }
            });
            return;
          }
          /* Many builds 404 on GET …/jobs/…/results; try working oneshot first to save time */
          fetchSearchResultsViaOneshot(fullSearch).done(function (oneRows) {
            if (settled) return;
            if (oneRows && oneRows.length > 0) {
              finishRows(oneRows);
              return;
            }
            fetchJobResultsViaRest(manager).done(function (restRows) {
              if (settled) return;
              if (restRows && restRows.length > 0) {
                finishRows(restRows);
              } else {
                finishRows([]);
              }
            });
          });
        }
        resultsModel.on("data", function () {
          if (settled) return;
          var rows = tryModelRows();
          if (rows.length) finishRows(rows);
        });
        resultsModel.on("sync", function () {
          if (settled) return;
          var rows = tryModelRows();
          if (rows.length) finishRows(rows);
        });
        var pollN = 0;
        poll = setInterval(function () {
          if (settled) {
            clearInterval(poll);
            return;
          }
          var rows = tryModelRows();
          if (rows.length) {
            clearInterval(poll);
            finishRows(rows);
            return;
          }
          /* outputlookup often yields zero rows at pipe end; treat job done as write complete and resolve. */
          if (searchUsesOutputlookup(fullSearch)) {
            clearInterval(poll);
            finishRows([]);
            return;
          }
          pollN++;
          /* If MVC returns no rows, wait until here then oneshot (~0.6s) */
          if (pollN >= 6) {
            clearInterval(poll);
            maybeRestFallback();
          }
        }, 100);
      } catch (e1) {
        finishNg(e1 instanceof Error ? e1 : new Error(String(e1)));
      }
    });

    try {
      manager.startSearch();
    } catch (e2) {
      finishNg(e2 instanceof Error ? e2 : new Error(String(e2)));
    }

    return d.promise();
  }

  function publicProblem(p) {
    var rest = $.extend({}, p);
    delete rest.referenceSpl;
    delete rest.logPreviewSpl;
    rest.hasReference = Boolean(p.referenceSpl);
    rest.hasLogPreview = Boolean(p.logPreviewSpl);
    return rest;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Escape for input/textarea placeholder (& and " only) */
  function htmlPlaceholderAttr(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");
  }

  function renderTable($container, rows, keys) {
    $container.empty();
    if (!rows || rows.length === 0) {
      $container.append('<p class="sl-empty">(no rows)</p>');
      return;
    }
    var useKeys = keys;
    if (!useKeys || useKeys.length === 0) {
      var keySet = {};
      rows.forEach(function (r) {
        Object.keys(r).forEach(function (k) {
          if (!isInternalResultKey(k)) keySet[k] = true;
        });
      });
      useKeys = Object.keys(keySet);
    }
    var $wrap = $('<div class="sl-table-wrap"/>');
    var $table = $("<table/>");
    var $thead = $("<thead><tr/></thead>");
    useKeys.forEach(function (k) {
      $thead.find("tr").append($("<th/>").text(k));
    });
    var $tbody = $("<tbody/>");
    rows.forEach(function (row) {
      var $tr = $("<tr/>");
      useKeys.forEach(function (k) {
        var v = row[k];
        $tr.append($("<td/>").text(v != null ? String(v) : ""));
      });
      $tbody.append($tr);
    });
    $table.append($thead).append($tbody);
    $wrap.append($table);
    $container.append($wrap);
  }

  /** Case-insensitive field lookup (Splunk may change field name casing) */
  function lookupRowField(row, name) {
    if (!row || typeof row !== "object") return "";
    if (row[name] != null && row[name] !== "") return row[name];
    var nl = String(name).toLowerCase();
    var k;
    for (k in row) {
      if (!Object.prototype.hasOwnProperty.call(row, k)) continue;
      if (isInternalResultKey(k)) continue;
      if (String(k).toLowerCase() === nl) return row[k];
    }
    return "";
  }

  /**
   * Coerce matrix / "0","1" keyed rows into named lookup objects (environment quirks).
   */
  function coerceLookupResultRow(row) {
    if (row == null) return row;
    if (Array.isArray(row)) {
      var o = {};
      var ai;
      for (ai = 0; ai < LOOKUP_PROBLEM_FIELDS.length && ai < row.length; ai++) {
        o[LOOKUP_PROBLEM_FIELDS[ai]] = row[ai];
      }
      return o;
    }
    if (typeof row !== "object") return row;
    if (lookupRowField(row, "id")) return row;
    var o = $.extend({}, row);
    var changed = false;
    var bi;
    for (bi = 0; bi < LOOKUP_PROBLEM_FIELDS.length; bi++) {
      var fn = LOOKUP_PROBLEM_FIELDS[bi];
      if (o[fn] != null && String(o[fn]).trim() !== "") continue;
      var nk = String(bi);
      if (o[nk] != null && String(o[nk]).trim() !== "") {
        o[fn] = o[nk];
        changed = true;
      } else if (o[bi] != null && String(o[bi]).trim() !== "") {
        o[fn] = o[bi];
        changed = true;
      }
    }
    return changed ? o : row;
  }

  /** Legacy JP tier strings (\u*) → Beginner|Intermediate|Advanced; pass through otherwise. */
  function canonicalCategoryName(raw) {
    var s = String(raw || "").trim();
    if (s === "\u521d\u7d1a") return "Beginner";
    if (s === "\u4e2d\u7d1a") return "Intermediate";
    if (s === "\u4e0a\u7d1a") return "Advanced";
    return s;
  }

  /** Prefer category; fall back to legacy tier. */
  function categoryFromPayload(o) {
    if (!o || typeof o !== "object") return "";
    var c = o.category != null ? String(o.category).trim() : "";
    if (c) return canonicalCategoryName(c);
    return canonicalCategoryName(o.tier != null ? String(o.tier).trim() : "");
  }

  /**
   * Strip leading "Category — " from title when optgroup already shows category.
   */
  function stripCategoryPrefixFromTitle(category, title) {
    var t = String(title || "").trim();
    var c = String(category || "").trim();
    if (!c || !t) return t;
    var esc = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var re = new RegExp("^" + esc + "\\s*[\\u2014\\u2013\\-\\:：]\\s*");
    var out = t.replace(re, "").trim();
    return out === "" ? t : out;
  }

  /** Normalize multi-column CSV / legacy problem_json to UI object (allowed keys; index via INDEX_NAME_RE) */
  function normalizeProblemObject(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    var id = String(o.id || "").trim();
    if (!id) return null;
    var indexName = String(o.indexName || "").trim();
    if (!indexName || !INDEX_NAME_RE.test(indexName)) return null;
    var cat = categoryFromPayload(o);
    return {
      id: id,
      category: cat,
      title: stripCategoryPrefixFromTitle(cat, String(o.title || "")),
      indexName: indexName,
      statement: String(o.statement || ""),
      hint: String(o.hint || ""),
      placeholder: String(o.placeholder || ""),
      logPreviewSpl: String(o.logPreviewSpl || ""),
      referenceSpl: String(o.referenceSpl || ""),
    };
  }

  function inferTutorialIndexFromProblemId(problemId) {
    var id = String(problemId || "").trim();
    var m = id.match(/^([bma])(\d+)$/i);
    if (!m) return "";
    var letter = m[1].toLowerCase();
    var num = m[2];
    if (letter === "b") return "tutorial_b" + num;
    if (letter === "m") return "tutorial_m" + num;
    if (letter === "a") return "tutorial_a" + num;
    return "";
  }

  /**
   * Fix shifted columns for old 9-col CSV + json_rows (legacy rows after problem_json migration).
   */
  function repairShiftedLookupColumns(p) {
    if (!p || typeof p !== "object") return p;
    var ix = String(p.indexName || "").trim();
    var lp = String(p.logPreviewSpl || "").trim();
    if (/^\|/.test(ix) && /^(?:Beginner|Intermediate|Advanced)$/.test(lp)) {
      var inferred = inferTutorialIndexFromProblemId(p.id);
      if (inferred) {
        return $.extend({}, p, {
          indexName: inferred,
          logPreviewSpl: ix,
          category: lp,
        });
      }
    }
    return p;
  }

  function problemFromLookupRow(row) {
    row = coerceLookupResultRow(row);
    if (!row || typeof row !== "object") return null;
    var id = lookupRowField(row, "id");
    id = id != null && id !== "" ? String(id).trim() : "";
    if (!id) return null;
    return repairShiftedLookupColumns({
      id: id,
      category: canonicalCategoryName(
        String(lookupRowField(row, "category") || lookupRowField(row, "tier") || "")
      ),
      title: String(lookupRowField(row, "title") || ""),
      indexName: String(lookupRowField(row, "indexName") || ""),
      statement: String(lookupRowField(row, "statement") || ""),
      hint: String(lookupRowField(row, "hint") || ""),
      placeholder: String(lookupRowField(row, "placeholder") || ""),
      logPreviewSpl: String(lookupRowField(row, "logPreviewSpl") || ""),
      referenceSpl: String(lookupRowField(row, "referenceSpl") || ""),
    });
  }

  /**
   * Turn user lookup rows into problem objects.
   * Prefer legacy problem_json (or payload) JSON; else interpret multi-column CSV via problemFromLookupRow.
   */
  function parseUserLookupRows(rows) {
    if (!Array.isArray(rows)) return [];
    var out = [];
    var i;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      var raw = lookupRowField(row, USER_LOOKUP_LEGACY_JSON_FIELD);
      if (raw == null || String(raw).trim() === "") {
        raw = lookupRowField(row, "payload");
      }
      if (raw != null && String(raw).trim() !== "") {
        try {
          var jo = JSON.parse(String(raw));
          if (jo && typeof jo === "object" && !Array.isArray(jo)) {
            var np = normalizeProblemObject(jo);
            if (np) {
              out.push(np);
              continue;
            }
          }
        } catch (eJ) {
          splQuizClientLog("lookup_problem_json_parse_fail", {
            rowIndex: i,
            idHint: String(lookupRowField(row, "id") || ""),
          });
        }
      }
      var leg = problemFromLookupRow(row);
      if (leg) out.push(leg);
    }
    return out;
  }

  /** String for embedding inside Splunk eval double-quoted literal */
  function splEvalStringForSpl(s) {
    return String(s != null ? s : "")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/\f/g, "\\f");
  }

  /** RFC4180-ish: split CSV text into rows handling quotes/newlines */
  function parseCsvRows(text) {
    var t = String(text || "").replace(/^\uFEFF/, "");
    var rows = [];
    var row = [];
    var cur = "";
    var inQ = false;
    var i = 0;
    while (i < t.length) {
      var c = t[i];
      if (inQ) {
        if (c === '"') {
          if (i + 1 < t.length && t[i + 1] === '"') {
            cur += '"';
            i += 2;
            continue;
          }
          inQ = false;
          i++;
          continue;
        }
        cur += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQ = true;
        i++;
        continue;
      }
      if (c === ",") {
        row.push(cur);
        cur = "";
        i++;
        continue;
      }
      if (c === "\r") {
        i++;
        continue;
      }
      if (c === "\n") {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
        i++;
        continue;
      }
      cur += c;
      i++;
    }
    row.push(cur);
    rows.push(row);
    while (
      rows.length &&
      rows[rows.length - 1].length === 1 &&
      rows[rows.length - 1][0] === ""
    ) {
      rows.pop();
    }
    if (inQ) {
      throw new Error("CSV has an unclosed quote");
    }
    return rows;
  }

  function csvEscapeField(val) {
    var s = String(val != null ? val : "");
    if (/[,"\r\n\t]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /** Map import CSV header variants (case/spacing) to LOOKUP_PROBLEM_FIELDS keys */
  function canonicalizeCsvHeaderName(h) {
    var low = String(h || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    var map = {
      id: "id",
      category: "category",
      tier: "category",
      title: "title",
      indexname: "indexName",
      statement: "statement",
      hint: "hint",
      placeholder: "placeholder",
      logpreviewspl: "logPreviewSpl",
      referencespl: "referenceSpl",
      problem_json: USER_LOOKUP_LEGACY_JSON_FIELD,
      payload: "payload",
    };
    return map[low] ? map[low] : String(h || "").trim();
  }

  /** Same wide columns as spl_quiz_user_problems.csv (LOOKUP_PROBLEM_FIELDS order) */
  function buildUserLookupCsvFileContent(problems) {
    var fields = LOOKUP_PROBLEM_FIELDS;
    var lines = [fields.join(",")];
    var pi;
    for (pi = 0; pi < problems.length; pi++) {
      var pr = problems[pi];
      lines.push(
        fields
          .map(function (fn) {
            return csvEscapeField(pr[fn] != null ? pr[fn] : "");
          })
          .join(",")
      );
    }
    return lines.join("\r\n");
  }

  /**
   * Import export CSV, legacy two-column CSV, or export-compatible JSON { problems: [...] }.
   */
  function parseProblemsBundleImportText(raw) {
    var t = String(raw || "").replace(/^\uFEFF/, "");
    var trimmed = t.trim();
    if (!trimmed) {
      throw new Error("Input is empty.");
    }
    if (trimmed.charAt(0) === "{") {
      var o;
      try {
        o = JSON.parse(trimmed);
      } catch (eImp) {
        throw new Error("Invalid import file (if it starts with {, it must be export-compatible JSON only).");
      }
      if (!o || !Array.isArray(o.problems)) {
        throw new Error("JSON must contain a problems array.");
      }
      var imported = [];
      var ji;
      for (ji = 0; ji < o.problems.length; ji++) {
        var npj = normalizeProblemObject(o.problems[ji]);
        if (!npj) {
          throw new Error("problems[" + ji + "] is invalid.");
        }
        imported.push(npj);
      }
      return imported;
    }
    var rows;
    try {
      rows = parseCsvRows(t);
    } catch (eCsv) {
      throw new Error("Failed to parse CSV: " + (eCsv.message || String(eCsv)));
    }
    if (!rows.length) {
      throw new Error("No data rows.");
    }
    var header = rows[0].map(function (h) {
      return String(h).trim();
    });
    if (header.length < 2 || canonicalizeCsvHeaderName(header[0]) !== "id") {
      throw new Error("First column must be id.");
    }
    var h1 = canonicalizeCsvHeaderName(header[1]);
    if (h1 === USER_LOOKUP_LEGACY_JSON_FIELD || h1 === "payload") {
      var outLegacy = [];
      var ri;
      for (ri = 1; ri < rows.length; ri++) {
        var cells = rows[ri];
        if (!cells || cells.length < 2) {
          continue;
        }
        var jo;
        try {
          jo = JSON.parse(cells[1]);
        } catch (ignoreJl) {
          throw new Error("Row " + (ri + 1) + ": could not parse legacy column 2 (problem_json).");
        }
        var npL = normalizeProblemObject(jo);
        if (!npL) {
          throw new Error("Row " + (ri + 1) + ": invalid problem data.");
        }
        outLegacy.push(npL);
      }
      return outLegacy;
    }
    var out = [];
    var rj;
    for (rj = 1; rj < rows.length; rj++) {
      var rowCells = rows[rj];
      var obj = {};
      var hi;
      for (hi = 0; hi < header.length; hi++) {
        var key = canonicalizeCsvHeaderName(header[hi]);
        if (!key) {
          continue;
        }
        obj[key] = hi < rowCells.length ? rowCells[hi] : "";
      }
      var np = normalizeProblemObject(obj);
      if (!np) {
        throw new Error("Row " + (rj + 1) + ": invalid problem data (check id, indexName, etc.).");
      }
      out.push(np);
    }
    return out;
  }

  /**
   * outputlookup zero rows to clear the lookup (overwrite).
   * inputlookup must be the first command of a search, so do not prefix "search |" (pipe-first).
   * append=false / override_if_empty=true replaces existing lookup on zero-row results.
   * @see https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/Outputlookup
   */
  function buildEmptyLookupOutputSearch(lookupName) {
    return (
      "| inputlookup " +
      lookupName +
      " | where 1=0 | outputlookup " +
      lookupName +
      " append=false override_if_empty=true"
    );
  }

  /**
   * SPL to persist user problems to a lookup (columns match LOOKUP_PROBLEM_FIELDS).
   */
  function buildOutputLookupSearch(problems, lookupName) {
    var n = problems.length;
    if (n === 0) {
      return buildEmptyLookupOutputSearch(lookupName);
    }
    var parts = ["| makeresults count=" + n, "| streamstats count as seq"];
    var fields = LOOKUP_PROBLEM_FIELDS;
    var fi;
    for (fi = 0; fi < fields.length; fi++) {
      var fn = fields[fi];
      var caseParts = [];
      var i;
      for (i = 0; i < n; i++) {
        var v = problems[i][fn];
        if (v === undefined || v === null) {
          v = "";
        }
        caseParts.push("seq==" + (i + 1) + ',"' + splEvalStringForSpl(String(v)) + '"');
      }
      caseParts.push('true(),""');
      parts.push("| eval " + fn + "=case(" + caseParts.join(", ") + ")");
    }
    parts.push("| table " + fields.join(" "));
    parts.push("| outputlookup " + lookupName + " append=false");
    /* makeresults must be the first search command (search | makeresults is FATAL). Pipe-first. */
    return parts.join(" ");
  }

  function buildClearLookupSearch(lookupName) {
    return buildEmptyLookupOutputSearch(lookupName);
  }

  /** Dropdown order: Beginner→Intermediate→Advanced, then id within category */
  function sortProblemsForUi(problems) {
    var categoryRank = {
      Beginner: 0,
      Intermediate: 1,
      Advanced: 2,
    };
    return problems.slice().sort(function (a, b) {
      var ta = categoryRank[a.category] !== undefined ? categoryRank[a.category] : 99;
      var tb = categoryRank[b.category] !== undefined ? categoryRank[b.category] : 99;
      if (ta !== tb) return ta - tb;
      return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });
  }

  function buildQuizUi($root, quizExerciseMode) {
    quizExerciseMode = quizExerciseMode || "user";
    var title = quizExerciseMode === "sample" ? "SPL Quiz (sample)" : "SPL Quiz (user problems)";
    $root.html(
      [
        '<div class="sl-header">',
        '<div class="sl-header-row">',
        "<h1>" + title + "</h1>",
        "</div>",
        '<div class="sl-banner" id="sl-splunk-banner"></div>',
        '<div class="sl-banner sl-banner-kv" id="sl-kv-banner"></div>',
        "</div>",
        '<div class="sl-grid sl-grid-main">',
        '<div class="sl-panel">',
        '<div class="sl-panel-head">Problem</div>',
        '<div class="sl-panel-body">',
        '<div class="sl-field"><label for="sl-problem">Problem</label>',
        '<select id="sl-problem" class="sl-select"></select></div>',
        '<div class="sl-statement" id="sl-statement"></div>',
        '<p><button type="button" class="sl-btn" id="sl-toggle-hint">Hint</button></p>',
        '<div class="sl-hint" id="sl-hint"></div>',
        "</div></div>",
        '<div class="sl-panel">',
        '<div class="sl-panel-head">SPL</div>',
        '<div class="sl-panel-body">',
        '<div class="sl-field"><label for="sl-spl">Enter SPL. Include the index named in the problem statement. Time range modifiers are not needed (searches run across all time).</label>',
        '<textarea id="sl-spl" class="sl-spl" spellcheck="false"></textarea></div>',
        '<div class="sl-actions">',
        '<button type="button" class="sl-btn sl-btn-primary" id="sl-btn-preview">Run search</button>',
        '<button type="button" class="sl-btn sl-btn-primary" id="sl-btn-submit">Submit answer</button>',
        "</div>",
        '<div class="sl-msg sl-msg-info" id="sl-msg-status"></div>',
        "</div></div>",
        "</div>",
        '<div class="sl-grid" style="margin-top:1rem">',
        '<div class="sl-panel"><div class="sl-panel-head">Problem log (_raw, up to 100 events)</div>',
        '<div class="sl-panel-body"><div id="sl-log-table"></div></div></div>',
        '<div class="sl-panel"><div class="sl-panel-head">Search results</div>',
        '<div class="sl-panel-body"><div id="sl-result-table"></div></div></div>',
        "</div>",
      ].join("")
    );
  }

  function buildEditUi($root) {
    $root.html(
      [
        '<div class="sl-header">',
        '<div class="sl-header-row">',
        "<h1>Edit problems</h1>",
        "</div>",
        '<div class="sl-banner" id="sl-splunk-banner"></div>',
        '<div class="sl-banner sl-banner-kv" id="sl-kv-banner"></div>',
        "</div>",
        '<div class="sl-panel sl-edit-panel">',
        '<div class="sl-panel-head">Add, edit, or delete problems</div>',
        '<div class="sl-panel-body">',
        '<p class="sl-modal-note">Edit your own problems here. You can bulk import, bulk delete, or export. You may also edit spl_quiz_user_problems.csv directly; be careful with column counts and commas or newlines inside cells so the CSV stays valid.</p>',
        '<div class="sl-editor-toolbar">',
        '<button type="button" class="sl-btn sl-btn-primary" id="sl-editor-add">Add one problem</button>',
        '<button type="button" class="sl-btn" id="sl-editor-import-btn">Bulk import</button>',
        '<button type="button" class="sl-btn" id="sl-editor-revert">Delete all</button>',
        '<button type="button" class="sl-btn" id="sl-editor-export">Export</button>',
        '<input type="file" class="sl-editor-import-file-input" accept=".csv,text/csv,application/json,.json,text/plain,.txt" id="sl-editor-import-file"/>',
        "</div>",
        '<div id="sl-editor-list" class="sl-editor-list"></div>',
        '<div class="sl-editor-form" id="sl-editor-form">',
        '<div class="sl-editor-form-title" id="sl-editor-form-title">New problem</div>',
        '<div class="sl-field"><label for="sl-ef-id">ID (letters, digits, _-, up to 64 chars)</label>',
        '<input type="text" id="sl-ef-id" class="sl-input" maxlength="64" placeholder="' +
          htmlPlaceholderAttr(EDITOR_FORM_SAMPLE_B1.id) +
          '"/></div>',
        '<div class="sl-field"><label for="sl-ef-category">Category</label>',
        '<input type="text" id="sl-ef-category" class="sl-input" maxlength="100" placeholder="' +
          htmlPlaceholderAttr(EDITOR_FORM_SAMPLE_B1.category) +
          '"/></div>',
        '<div class="sl-field"><label for="sl-ef-title">Title</label>',
        '<input type="text" id="sl-ef-title" class="sl-input" maxlength="500" placeholder="' +
          htmlPlaceholderAttr(EDITOR_FORM_SAMPLE_B1.title) +
          '"/></div>',
        '<div class="sl-field"><label for="sl-ef-index">Index (target index name)</label>',
        '<input type="text" id="sl-ef-index" class="sl-input" maxlength="200" placeholder="' +
          htmlPlaceholderAttr(EDITOR_FORM_SAMPLE_B1.indexName) +
          '"/></div>',
        '<div class="sl-field"><label for="sl-ef-statement">Problem statement (HTML allowed)</label>',
        '<textarea id="sl-ef-statement" class="sl-textarea" rows="4" spellcheck="false" placeholder="' +
          htmlPlaceholderAttr(EDITOR_FORM_SAMPLE_B1.statement) +
          '"></textarea></div>',
        '<div class="sl-field"><label for="sl-ef-hint">Hint (HTML allowed)</label>',
        '<textarea id="sl-ef-hint" class="sl-textarea" rows="3" spellcheck="false" placeholder="' +
          htmlPlaceholderAttr(EDITOR_FORM_SAMPLE_B1.hint) +
          '"></textarea></div>',
        '<div class="sl-field"><label for="sl-ef-reference">Reference SPL (for grading)</label>',
        '<p class="sl-field-help">SPL used to compare the user submission with the expected answer.</p>',
        '<textarea id="sl-ef-reference" class="sl-textarea" rows="3" spellcheck="false" placeholder="' +
          htmlPlaceholderAttr(EDITOR_FORM_SAMPLE_B1.referenceSpl) +
          '"></textarea></div>',
        '<div class="sl-field"><label for="sl-ef-placeholder">Placeholder (initial SPL box text)</label>',
        '<p class="sl-field-help">Example text shown in the answer SPL field before the user types anything.</p>',
        '<textarea id="sl-ef-placeholder" class="sl-textarea" rows="3" spellcheck="false" placeholder="' +
          htmlPlaceholderAttr(EDITOR_FORM_SAMPLE_B1.placeholder) +
          '"></textarea></div>',
        '<div class="sl-field"><label for="sl-ef-logprev">Extra SPL for problem log</label>',
        '<p class="sl-field-help">SPL appended for the Problem log view; it filters after the reference SPL base. Usually you can leave the default.</p>',
        '<textarea id="sl-ef-logprev" class="sl-textarea" rows="2" spellcheck="false"></textarea></div>',
        '<p class="sl-editor-form-err" id="sl-editor-form-err"></p>',
        '<div class="sl-editor-form-actions">',
        '<button type="button" class="sl-btn sl-btn-primary" id="sl-ef-save">Save</button>',
        '<button type="button" class="sl-btn" id="sl-ef-cancel">Cancel</button>',
        "</div></div></div></div>",
      ].join("")
    );
  }

  var state = {
    problems: [],
    byId: {},
    current: null,
    busy: false,
    problemsFromUserLookup: false,
    editorMode: null,
    editorOriginalId: null,
    editorListIndex: null,
    problemsLoadSource: "",
    /** Quiz view only: "user" | "sample". null on edit view */
    quizExerciseMode: null,
  };

  /**
   * If Splunk swaps the HTML panel before async search completes, quizScope$/editScope$
   * keep pointing at detached nodes and sl() misses. Rebuild if the UI kit is missing on the new root.
   * (Placed here, not only in init(), because runProblemLogPreview also relies on it.)
   */
  function reconcileQuizExerciseDom() {
    if (isSplQuizEditViewUrl()) {
      var $e = getSplQuizEditRootJq($);
      if (!$e.length) return;
      if (!$e.find("#sl-editor-list").length) {
        editScope$ = $e;
        splQuizClientLog("dom_reconcile_rebuild", { kind: "edit" });
        buildEditUi($e);
      } else {
        editScope$ = $e;
      }
      return;
    }
    var $r = getSplQuizRootJq($);
    if (!$r.length) return;
    if ($r.find("#sl-problem").length) {
      quizScope$ = $r;
      return;
    }
    var ex = resolveSplQuizExerciseMode($r);
    state.quizExerciseMode = ex;
    quizScope$ = $r;
    splQuizClientLog("dom_reconcile_rebuild", { kind: "exercise", mode: ex });
    buildQuizUi($r, ex);
  }

  function setBusy(b) {
    state.busy = b;
    sl(
      "#sl-btn-preview, #sl-btn-submit, #sl-editor-add, #sl-editor-revert, #sl-editor-export, #sl-editor-import-btn, #sl-ef-save, #sl-ef-cancel"
    ).prop("disabled", b);
  }

  function showStatus(kind, text) {
    var $m = sl("#sl-msg-status");
    $m.removeClass("sl-msg-ok sl-msg-ng sl-msg-info visible");
    if (!text) {
      $m.removeClass("visible");
      return;
    }
    $m.addClass("visible");
    if (kind === "ok") $m.addClass("sl-msg-ok");
    else if (kind === "ng") $m.addClass("sl-msg-ng");
    else $m.addClass("sl-msg-info");
    $m.text(text);
  }

  function selectProblem(id) {
    state.current = state.byId[id] || null;
    var p = state.current;
    if (!p) return;
    sl("#sl-statement").html(
      '<div class="sl-problem-block">' +
        '<span class="sl-badge">' +
        escapeHtml(p.category) +
        "</span> " +
        '<div class="sl-problem-body">' +
        (p.statement || "") +
        "</div>" +
        '<div class="sl-index-hint" role="note">' +
        '<span class="sl-index-hint-label">Index for this problem:</span> ' +
        '<span class="sl-mono-spl">index=' +
        escapeHtml(p.indexName || "") +
        "</span>" +
        "</div>" +
        "</div>"
    );
    sl("#sl-spl").attr("placeholder", p.placeholder || "");
    sl("#sl-spl").val("");
    sl("#sl-hint").removeClass("visible").html(p.hint || "");
    sl("#sl-log-table").empty();
    sl("#sl-result-table").empty();
    showStatus("", "");
    runProblemLogPreview();
  }

  /** Auto-fetch problem log preview for selection (no button; runs right after pick) */
  function runProblemLogPreview() {
    var p = state.current;
    if (!p || !p.logPreviewSpl) return;
    setBusy(true);
    showStatus("", "");
    var search;
    try {
      search = pickExerciseProblemSearch(state.quizExerciseMode, p.indexName, p.logPreviewSpl);
    } catch (e) {
      setBusy(false);
      showStatus("ng", e.message || String(e));
      return;
    }
    runSearchSplunk(search)
      .done(function (results) {
        reconcileQuizExerciseDom();
        var jobMeta = null;
        try {
          if (results && results._splQuizJob) jobMeta = results._splQuizJob;
        } catch (e) {}
        var rows = alignLogPreviewRows(results).map(function (r) {
          return { _raw: r && r._raw != null && r._raw !== undefined ? String(r._raw) : "" };
        });
        var $log = sl("#sl-log-table");
        $log.empty();
        var $wrap = $('<div class="sl-table-wrap sl-log-raw"/>');
        var $table = $("<table/>");
        $table.append($("<thead><tr><th>_raw</th></tr></thead>"));
        var $tb = $("<tbody/>");
        rows.forEach(function (row) {
          $tb.append($("<tr/>").append($("<td/>").text(row._raw)));
        });
        $table.append($tb);
        $wrap.append($table);
        $log.append($wrap);
        if (rows.length === 0) {
          var ec = jobMeta ? jobContentNumber(jobMeta, "eventCount") : null;
          var rc = jobMeta ? jobContentNumber(jobMeta, "resultCount") : null;
          var sc = jobMeta ? jobContentNumber(jobMeta, "scanCount") : null;
          var msg;
          if (ec === 0 || (ec == null && sc === 0)) {
            if (state.quizExerciseMode === "sample") {
              msg =
                "Sample lookup " +
                SPL_QUIZ_SAMPLE_EVENTS_LOOKUP +
                " has no row with virtual_index=" +
                (p.indexName || "") +
                " (job eventCount=" +
                (ec != null ? ec : "?") +
                "). Check lookups/spl_quiz_sample_events.csv and transforms.conf in the app.";
            } else {
              msg =
                "For this user, index=" +
                (p.indexName || "") +
                " returned 0 events (job eventCount=" +
                (ec != null ? ec : "?") +
                "). In Splunk: Settings → Roles → your role → Indexes, allow tutorial_* or ask an admin. For data loading, see spl-lesson-sample load-splunk, etc.";
            }
          } else if (ec != null && ec > 0 && rc != null && rc > 0) {
            msg =
              "Server reports resultCount=" +
              rc +
              " but the browser could not retrieve rows. For admins: check Search Head / proxy responses.";
          } else if (ec != null && ec > 0) {
            msg =
              "Events visible: " +
              ec +
              ", but result rows are 0. Check pipes after the base search (sort/head) or client rendering.";
          } else {
            if (state.quizExerciseMode === "sample") {
              msg =
                "Log is empty. Check that lookup " +
                SPL_QUIZ_SAMPLE_EVENTS_LOOKUP +
                " has a row for virtual_index=" +
                (p.indexName || "") +
                ".";
            } else {
              msg =
                "Log is empty. Check that index=" +
                (p.indexName || "") +
                " has tutorial data and that your role can search those indexes.";
            }
          }
          showStatus("ng", msg);
        } else {
          showStatus("", "");
        }
      })
      .fail(function (err) {
        var msg =
          err && err.message
            ? err.message
            : typeof err === "string"
              ? err
              : parseSplunkError(err && err.responseText ? err : { responseText: String(err) });
        showStatus("ng", msg);
      })
      .always(function () {
        setBusy(false);
      });
  }

  function init() {
    var onEditUrl = isSplQuizEditViewUrl();
    var $root;
    try {
      var pathHint = "";
      try {
        pathHint = String(window.location.pathname || "").slice(-80);
      } catch (eP) {}
      splQuizClientLog("diag_init_start", {
        view: onEditUrl ? "edit" : "lesson",
        pathTail: pathHint,
        inIframe: window !== window.top,
      });
    } catch (ignoreD0) {}
    if (onEditUrl) {
      state.quizExerciseMode = null;
      $root = getSplQuizEditRootJq($);
      if (!$root.length) {
        splQuizClientLog("diag_init_skip_no_root", { which: "spl-quiz-edit-root" });
        return;
      }
      editScope$ = $root;
      quizScope$ = $();
      buildEditUi($root);
      try {
        splQuizClientLog("diag_init_edit_shell_ok", {
          hasEditorList: $root.find("#sl-editor-list").length > 0,
        });
      } catch (ignoreD2) {}
    } else {
      $root = getSplQuizRootJq($);
      if (!$root.length) {
        splQuizClientLog("diag_init_skip_no_root", { which: "spl-quiz-root" });
        return;
      }
      var exerciseMode = resolveSplQuizExerciseMode($root);
      state.quizExerciseMode = exerciseMode;
      quizScope$ = $root;
      editScope$ = $();
      buildQuizUi($root, exerciseMode);
      try {
        var el0 = $root.get && $root.get(0);
        splQuizClientLog("diag_init_shell_ok", {
          mode: exerciseMode,
          rootConnected: el0 && typeof el0.isConnected === "boolean" ? el0.isConnected : "",
          hasSlProblem: $root.find("#sl-problem").length > 0,
        });
      } catch (ignoreD1) {}
    }

    var $banner = sl("#sl-splunk-banner");
    $banner.removeClass("visible").text("");
    var util0 = getSplunkUtil();
    if (!util0) {
      $banner.addClass("visible").text(
        "Splunk shell utilities are not loaded. Open Home, then open this page again."
      );
    }

    /**
     * Load lookup via inputlookup ([Search Reference / inputlookup](https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/Inputlookup)).
     * User and sample use multi-column CSV (legacy two-column id + problem_json OK). Normalize with parseUserLookupRows.
     */
    function readLookupPromise(lookupName) {
      var attempts = [
        "| inputlookup " + lookupName,
        "search | inputlookup " + lookupName,
      ];
      var dfd = $.Deferred();
      var ai = 0;
      function tryNext(errPrev) {
        if (ai >= attempts.length) {
          dfd.reject(
            errPrev instanceof Error
              ? errPrev
              : new Error(String(errPrev || "inputlookup failed: " + lookupName))
          );
          return;
        }
        var q = attempts[ai];
        ai++;
        runSearchSplunk(q)
          .done(function (rows) {
            var arr = Array.isArray(rows) ? rows : [];
            var probs = parseUserLookupRows(arr);
            splQuizClientLog("inputlookup_ok", {
              lookup: lookupName,
              splHead: q.slice(0, 120),
              rawRows: arr.length,
              problems: probs.length,
            });
            dfd.resolve(probs);
          })
          .fail(function (err) {
            splQuizClientLog("inputlookup_try_fail", {
              lookup: lookupName,
              splHead: q.slice(0, 120),
              msg: err && err.message ? err.message : String(err),
            });
            tryNext(err);
          });
      }
      tryNext();
      return dfd.promise();
    }

    /** Data-source banner on quiz views (spl_quiz / spl_quiz_sample) */
    function updateQuizExerciseBanner(kind, detail) {
      var $kb = sl("#sl-kv-banner");
      if (!$kb.length) return;
      $kb.removeClass("visible sl-banner-kv-ok sl-banner-kv-warn sl-banner-kv-file");
      if (kind === "sample") {
        $kb
          .addClass("visible sl-banner-kv-ok")
          .html(
            "You are viewing sample problems. To solve user-created problems, open <strong>SPL Quiz (user problems)</strong>."
          );
        return;
      }
      if (kind === "sample_lookup_error") {
        $kb
          .addClass("visible sl-banner-kv-warn")
          .html(
            "Failed to load sample lookup: " +
              escapeHtml((detail && detail.msg) || "Unknown error") +
              " — check <code>inputlookup " +
              SPL_QUIZ_LOOKUP_SAMPLE +
              "</code> and <code>lookups/" +
              SPL_QUIZ_LOOKUP_SAMPLE +
              ".csv</code>."
          );
        return;
      }
      if (kind === "sample_lookup_empty") {
        $kb
          .addClass("visible sl-banner-kv-file")
          .html(
            "No sample problems were found. Check rows in <code>lookups/" +
              SPL_QUIZ_LOOKUP_SAMPLE +
              ".csv</code>."
          );
        return;
      }
      if (kind === "user_lookup_ok") {
        $kb
          .addClass("visible sl-banner-kv-ok")
          .html("Showing user-created problems.");
        return;
      }
      if (kind === "user_empty") {
        $kb
          .addClass("visible sl-banner-kv-file")
          .html("No user-created problems yet.");
        return;
      }
      if (kind === "user_lookup_error") {
        $kb
          .addClass("visible sl-banner-kv-warn")
          .html(
            "Failed to load lookup: " +
              escapeHtml((detail && detail.msg) || "Unknown error") +
              " — the problem list cannot be shown."
          );
        return;
      }
    }

    /** Data-source banner on edit view */
    function updateLookupDataBanner(mode, errDetail) {
      var $kb = sl("#sl-kv-banner");
      if (!$kb.length) return;
      $kb.removeClass("visible sl-banner-kv-ok sl-banner-kv-warn sl-banner-kv-file");
      if (mode === "lookup_ok") {
        $kb
          .addClass("visible sl-banner-kv-ok")
          .html(
            "You can edit problem data here.<br>" +
              "Lookuptable: <code>" +
              SPL_QUIZ_LOOKUP_USER +
              ".csv</code> can also be edited on disk; if you do, edit carefully to keep valid CSV."
          );
      } else if (mode === "error") {
        $kb
          .addClass("visible sl-banner-kv-warn")
          .html(
            "Could not load lookup: " +
              escapeHtml(errDetail || "Unknown error") +
              " — check <code>inputlookup " +
              SPL_QUIZ_LOOKUP_USER +
              "</code> and permissions."
          );
      } else {
        $kb
          .addClass("visible sl-banner-kv-file")
          .html(
            "spl_quiz_user_problems.csv is empty. Add a problem."
          );
      }
    }

    var PROBLEM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

    function findDuplicateProblemIndex(problems, id, skipIndex) {
      for (var i = 0; i < problems.length; i++) {
        if (i === skipIndex) continue;
        if (problems[i].id === id) return i;
      }
      return -1;
    }

    function validateProblemForList(p, problems, skipIndex) {
      if (!p || typeof p !== "object") return "Invalid data.";
      var id = String(p.id || "").trim();
      if (!PROBLEM_ID_RE.test(id)) return "ID must be letters, digits, hyphen, or underscore only, 1–64 characters.";
      if (!String(p.indexName || "").trim()) return "Enter indexName.";
      if (!INDEX_NAME_RE.test(String(p.indexName || "").trim())) {
        return "indexName must be alphanumeric plus ._@- only, up to 200 characters.";
      }
      if (!String(p.title || "").trim()) return "Enter a title.";
      if (!String(p.category || "").trim()) return "Enter a category.";
      if (findDuplicateProblemIndex(problems, id, skipIndex) >= 0) return "A problem with this ID already exists.";
      return null;
    }

    function applyProblemsData(data, source, opts) {
      reconcileQuizExerciseDom();
      opts = opts || {};
      var preserveId = opts.preserveSelectId;
      state.problemsLoadSource = source || "";
      splQuizClientLog("diag_apply_problems_start", {
        source: String(source || ""),
        rawListLen: (data && data.problems && data.problems.length) || 0,
      });
      var list = (data && data.problems) || [];
      state.problems = list.slice();
      state.byId = {};
      state.problems.forEach(function (p) {
        state.byId[p.id] = p;
      });
      var ordered = sortProblemsForUi(state.problems);
      var onEdit = isSplQuizEditViewUrl();
      if (onEdit) {
        if (!ordered.length) {
          state.current = null;
          sl("#sl-editor-list").html(
            '<p class="sl-empty">No problems yet. Use Add one problem or import a CSV.</p>'
          );
          splQuizClientLog("diag_apply_problems_done", { view: "edit", orderedCount: 0 });
          dismissSplunkEnterprisePreloadOverlay("edit_apply_empty");
          return;
        }
        renderEditorList();
        splQuizClientLog("diag_apply_problems_done", { view: "edit", orderedCount: ordered.length });
        dismissSplunkEnterprisePreloadOverlay("edit_apply");
        return;
      }
      var categories = {};
      ordered.forEach(function (p) {
        categories[p.category] = true;
      });
      var $sel = sl("#sl-problem");
      $sel.empty();
      var categoryOrderPreferred = ["Beginner", "Intermediate", "Advanced"];
      var categoryOrder = [];
      categoryOrderPreferred.forEach(function (cat) {
        if (categories[cat]) categoryOrder.push(cat);
      });
      Object.keys(categories).forEach(function (cat) {
        if (categoryOrder.indexOf(cat) < 0) categoryOrder.push(cat);
      });
      categoryOrder.forEach(function (cat) {
        var $og = $("<optgroup/>").attr("label", cat);
        ordered
          .filter(function (p) {
            return p.category === cat;
          })
          .forEach(function (p) {
            var pub = publicProblem(p);
            $og.append(
              $("<option/>")
                .val(p.id)
                .text(pub.id + " — " + pub.title)
            );
          });
        $sel.append($og);
      });
      if (!ordered.length) {
        state.current = null;
        var emptyQuizMsg =
          state.quizExerciseMode === "user"
            ? '<p class="sl-empty">No problems have been created yet.</p>'
            : state.quizExerciseMode === "sample"
              ? '<p class="sl-empty">No sample problems defined. Check <code>inputlookup ' +
                SPL_QUIZ_LOOKUP_SAMPLE +
                "</code> or <code>lookups/" +
                SPL_QUIZ_LOOKUP_SAMPLE +
                ".csv</code>.</p>"
              : '<p class="sl-empty">No problems.</p>';
        sl("#sl-statement").html(emptyQuizMsg);
        sl("#sl-spl").val("").attr("placeholder", "");
        sl("#sl-hint").removeClass("visible").empty();
        sl("#sl-log-table").empty();
        sl("#sl-result-table").empty();
        splQuizClientLog("diag_apply_problems_done", {
          view: "quiz",
          orderedCount: 0,
          selectOptions: 0,
          mode: state.quizExerciseMode || "",
        });
        dismissSplunkEnterprisePreloadOverlay("quiz_apply_empty");
        return;
      }
      if (preserveId && state.byId[preserveId]) {
        $sel.val(preserveId);
        selectProblem(preserveId);
      } else if (ordered.length) {
        var firstId = ordered[0].id;
        $sel.val(firstId);
        selectProblem(firstId);
      }
      try {
        var sc = quizScope$ && quizScope$.get(0);
        var layout = {};
        if (sc && sc.getBoundingClientRect) {
          var br = sc.getBoundingClientRect();
          layout.rootRect = {
            w: Math.round(br.width),
            h: Math.round(br.height),
            top: Math.round(br.top),
            left: Math.round(br.left),
          };
        }
        if (sc) {
          layout.rootOffsetWh = { w: sc.offsetWidth, h: sc.offsetHeight };
        }
        splQuizClientLog("diag_apply_problems_done", {
          view: "quiz",
          orderedCount: ordered.length,
          selectOptions: sl("#sl-problem option").length,
          slProblemExists: sl("#sl-problem").length,
          mode: state.quizExerciseMode || "",
          quizScopeConnected: sc && typeof sc.isConnected === "boolean" ? sc.isConnected : "",
          layout: layout,
        });
        dismissSplunkEnterprisePreloadOverlay("apply_problems_done");
      } catch (ignoreDa) {}
    }

    function persistAndApplyProblems(preserveSelectId, problemsArr) {
      var list = (problemsArr != null ? problemsArr : state.problems).slice();
      var d = $.Deferred();
      setBusy(true);
      var spl = buildOutputLookupSearch(list, SPL_QUIZ_LOOKUP_USER);
      runSearchSplunk(spl)
        .done(function () {
          state.problemsFromUserLookup = true;
          updateLookupDataBanner("lookup_ok");
          applyProblemsData({ problems: list }, "lookup", {
            preserveSelectId: preserveSelectId,
          });
          splQuizClientLog("lookup_sync_ok", { count: list.length });
          d.resolve();
        })
        .fail(function (err) {
          var msg = err && err.message ? err.message : String(err);
          sl("#sl-editor-form-err").text(msg);
          try {
            window.alert(msg);
          } catch (e2) {}
          splQuizClientLog("lookup_sync_fail", { msg: msg });
          d.reject(err);
        })
        .always(function () {
          setBusy(false);
        });
      return d.promise();
    }

    function renderEditorList() {
      var $list = sl("#sl-editor-list");
      $list.empty();
      var ordered = sortProblemsForUi(state.problems);
      if (!ordered.length) {
        $list.append('<p class="sl-empty">No problems. Use Add one problem.</p>');
        return;
      }
      var $wrap = $('<div class="sl-table-wrap"/>');
      var $table = $("<table/>");
      $table.append(
        $(
          "<thead><tr><th>ID</th><th>Category</th><th>Title</th><th>Index</th><th></th></tr></thead>"
        )
      );
      var $tb = $("<tbody/>");
      ordered.forEach(function (p) {
        var idx = state.problems.indexOf(p);
        var $tr = $("<tr/>");
        $tr.append($("<td/>").text(p.id));
        $tr.append($("<td/>").text(p.category || ""));
        $tr.append($("<td/>").text(p.title || ""));
        $tr.append($("<td/>").text(p.indexName || ""));
        var $td = $("<td/>");
        var $b1 = $('<button type="button" class="sl-btn sl-btn-sm"/>')
          .text("Edit")
          .data("slIdx", idx);
        var $b2 = $('<button type="button" class="sl-btn sl-btn-sm sl-btn-danger"/>')
          .text("Delete")
          .data("slIdx", idx);
        $td.append($b1).append(" ").append($b2);
        $tr.append($td);
        $tb.append($tr);
      });
      $table.append($tb);
      $wrap.append($table);
      $list.append($wrap);
    }

    function setCategoryFormFields(categoryVal) {
      sl("#sl-ef-category").val(categoryVal != null ? String(categoryVal) : "");
    }

    function readCategoryFromForm() {
      return String(sl("#sl-ef-category").val() || "").trim();
    }

    function hideEditorForm() {
      state.editorMode = null;
      state.editorOriginalId = null;
      state.editorListIndex = null;
      sl("#sl-editor-form").removeClass("visible");
      sl("#sl-editor-form-err").text("");
    }

    function openEditorFormAdd() {
      state.editorMode = "add";
      state.editorOriginalId = null;
      state.editorListIndex = null;
      sl("#sl-editor-form-title").text("New problem");
      sl("#sl-ef-id").prop("readonly", false).val("");
      setCategoryFormFields("");
      sl("#sl-ef-title").val("");
      sl("#sl-ef-index").val("");
      sl("#sl-ef-statement").val("");
      sl("#sl-ef-hint").val("");
      sl("#sl-ef-placeholder").val("");
      sl("#sl-ef-logprev").val("| sort 0 _time | head 100");
      sl("#sl-ef-reference").val("");
      sl("#sl-editor-form-err").text("");
      sl("#sl-editor-form").addClass("visible");
    }

    function openEditorFormEdit(idx) {
      var p = state.problems[idx];
      if (!p) return;
      state.editorMode = "edit";
      state.editorOriginalId = p.id;
      state.editorListIndex = idx;
      sl("#sl-editor-form-title").text("Edit problem");
      sl("#sl-ef-id").prop("readonly", false).val(p.id);
      setCategoryFormFields(p.category || "");
      sl("#sl-ef-title").val(p.title || "");
      sl("#sl-ef-index").val(p.indexName || "");
      sl("#sl-ef-statement").val(p.statement || "");
      sl("#sl-ef-hint").val(p.hint || "");
      sl("#sl-ef-placeholder").val(p.placeholder || "");
      sl("#sl-ef-logprev").val(p.logPreviewSpl || "");
      sl("#sl-ef-reference").val(p.referenceSpl || "");
      sl("#sl-editor-form-err").text("");
      sl("#sl-editor-form").addClass("visible");
    }

    function collectEditorFormProblem() {
      return {
        id: String(sl("#sl-ef-id").val() || "").trim(),
        category: readCategoryFromForm(),
        title: String(sl("#sl-ef-title").val() || "").trim(),
        indexName: String(sl("#sl-ef-index").val() || "").trim(),
        statement: String(sl("#sl-ef-statement").val() || ""),
        hint: String(sl("#sl-ef-hint").val() || ""),
        placeholder: String(sl("#sl-ef-placeholder").val() || ""),
        logPreviewSpl: String(sl("#sl-ef-logprev").val() || "").trim(),
        referenceSpl: String(sl("#sl-ef-reference").val() || "").trim(),
      };
    }

    if (isSplQuizEditViewUrl()) {
      readLookupPromise(SPL_QUIZ_LOOKUP_USER)
        .done(function (probs) {
          if (probs && probs.length > 0) {
            state.problemsFromUserLookup = true;
            updateLookupDataBanner("lookup_ok");
            applyProblemsData({ problems: probs }, "lookup", {});
          } else {
            state.problemsFromUserLookup = false;
            updateLookupDataBanner("empty");
            applyProblemsData({ problems: [] }, "lookup_empty", {});
          }
        })
        .fail(function (err) {
          state.problemsFromUserLookup = false;
          updateLookupDataBanner("error", err && err.message ? err.message : String(err));
          var msg = "Failed to load lookup: " + (err && err.message ? err.message : String(err));
          sl("#sl-editor-list").html('<p class="sl-empty">' + escapeHtml(msg) + "</p>");
        });
    } else if (state.quizExerciseMode === "user") {
      readLookupPromise(SPL_QUIZ_LOOKUP_USER)
        .done(function (probs) {
          if (probs && probs.length > 0) {
            state.problemsFromUserLookup = true;
            updateQuizExerciseBanner("user_lookup_ok");
            applyProblemsData({ problems: probs }, "lookup", {});
          } else {
            state.problemsFromUserLookup = false;
            updateQuizExerciseBanner("user_empty");
            applyProblemsData({ problems: [] }, "lookup_empty", {});
          }
        })
        .fail(function (err) {
          state.problemsFromUserLookup = false;
          updateQuizExerciseBanner("user_lookup_error", {
            msg: err && err.message ? err.message : String(err),
          });
          applyProblemsData({ problems: [] }, "lookup_error", {});
        });
    } else {
      readLookupPromise(SPL_QUIZ_LOOKUP_SAMPLE)
        .done(function (probs) {
          state.problemsFromUserLookup = false;
          if (probs && probs.length > 0) {
            updateQuizExerciseBanner("sample", {});
            applyProblemsData({ problems: probs }, "sample_lookup", {});
          } else {
            updateQuizExerciseBanner("sample_lookup_empty", {});
            applyProblemsData({ problems: [] }, "sample_lookup_empty", {});
          }
        })
        .fail(function (err) {
          state.problemsFromUserLookup = false;
          var detail = err && err.message ? err.message : String(err);
          var msg = "Failed to load sample lookup: " + detail;
          updateQuizExerciseBanner("sample_lookup_error", { msg: detail });
          applyProblemsData({ problems: [] }, "sample_lookup_error", {});
          sl("#sl-statement").html('<p class="sl-empty">' + escapeHtml(msg) + "</p>");
        });
    }

    sl("#sl-editor-add").on("click", function () {
      openEditorFormAdd();
    });
    sl("#sl-editor-revert").on("click", function () {
      if (
        !window.confirm(
          "This will clear the user-problems lookup (" +
            SPL_QUIZ_LOOKUP_USER +
            "). Continue?"
        )
      ) {
        return;
      }
      setBusy(true);
      runSearchSplunk(buildClearLookupSearch(SPL_QUIZ_LOOKUP_USER))
        .done(function () {
          state.problemsFromUserLookup = true;
          updateLookupDataBanner("empty");
          applyProblemsData({ problems: [] }, "lookup_empty", { preserveSelectId: null });
          renderEditorList();
          hideEditorForm();
        })
        .fail(function (err) {
          try {
            window.alert(err && err.message ? err.message : String(err));
          } catch (e) {}
        })
        .always(function () {
          setBusy(false);
        });
    });
    sl("#sl-editor-export").on("click", function () {
      var csv = buildUserLookupCsvFileContent(state.problems);
      var blob = new Blob([csv], {
        type: "text/csv;charset=utf-8",
      });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = SPL_QUIZ_LOOKUP_USER + ".csv";
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
      }, 1500);
    });
    sl("#sl-editor-import-btn").on("click", function () {
      var el = document.getElementById("sl-editor-import-file");
      if (el && typeof el.click === "function") {
        el.click();
      }
    });
    sl("#sl-editor-import-file").on("change", function (ev) {
      var f = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var list = parseProblemsBundleImportText(String(reader.result || ""));
          var next = [];
          for (var i = 0; i < list.length; i++) {
            var err = validateProblemForList(list[i], next, -1);
            if (err) throw new Error("Row " + (i + 1) + ": " + err);
            next.push(list[i]);
          }
          persistAndApplyProblems(null, next)
            .done(function () {
              renderEditorList();
              hideEditorForm();
            })
            .fail(function () {});
        } catch (e2) {
          alert("Import failed: " + (e2.message || String(e2)));
        }
      };
      reader.readAsText(f);
    });

    sl("#sl-editor-list").on("click", "button", function () {
      var idx = $(this).data("slIdx");
      if (idx == null || idx < 0) return;
      if ($(this).hasClass("sl-btn-danger")) {
        if (!window.confirm("Delete this problem?")) return;
        var removedId = state.problems[idx] && state.problems[idx].id;
        var next = state.problems.slice();
        next.splice(idx, 1);
        var preserve =
          state.current && state.current.id !== removedId ? state.current.id : null;
        if (!preserve && next.length) preserve = next[0].id;
        persistAndApplyProblems(preserve, next)
          .done(function () {
            renderEditorList();
            hideEditorForm();
          })
          .fail(function () {});
      } else {
        openEditorFormEdit(idx);
      }
    });

    sl("#sl-ef-cancel").on("click", function () {
      hideEditorForm();
    });
    sl("#sl-ef-save").on("click", function () {
      var p = collectEditorFormProblem();
      var skipIdx = state.editorMode === "edit" ? state.editorListIndex : -1;
      var err = validateProblemForList(p, state.problems, skipIdx);
      if (err) {
        sl("#sl-editor-form-err").text(err);
        return;
      }
      var newId = p.id;
      var next = state.problems.slice();
      if (state.editorMode === "edit" && state.editorListIndex != null) {
        next[state.editorListIndex] = p;
      } else {
        next.push(p);
      }
      persistAndApplyProblems(newId, next)
        .done(function () {
          renderEditorList();
          hideEditorForm();
        })
        .fail(function () {});
    });

    sl("#sl-problem").on("change", function () {
      selectProblem($(this).val());
    });

    sl("#sl-toggle-hint").on("click", function () {
      var $h = sl("#sl-hint");
      $h.toggleClass("visible");
      $(this).text($h.hasClass("visible") ? "Close" : "Hint");
    });

    sl("#sl-btn-preview").on("click", function () {
      var p = state.current;
      if (!p) return;
      var spl = sl("#sl-spl").val();
      setBusy(true);
      showStatus("", "");
      var search;
      try {
        search = pickExerciseUserSearch(state.quizExerciseMode, spl, p.indexName);
      } catch (e) {
        setBusy(false);
        showStatus("ng", e.message || String(e));
        return;
      }
      runSearchSplunk(search)
        .done(function (results) {
          renderTable(sl("#sl-result-table"), results);
          showStatus("", "");
        })
        .fail(function (err) {
          var msg = err && err.message ? err.message : parseSplunkError(err);
          showStatus("ng", msg);
        })
        .always(function () {
          setBusy(false);
        });
    });

    sl("#sl-btn-submit").on("click", function () {
      var p = state.current;
      if (!p || !p.referenceSpl) {
        showStatus("ng", "This problem has no reference SPL defined for grading.");
        return;
      }
      var spl = sl("#sl-spl").val();
      setBusy(true);
      showStatus("", "");
      var userSearch;
      var refSearch;
      try {
        userSearch = pickExerciseUserSearch(state.quizExerciseMode, spl, p.indexName);
        refSearch = pickExerciseProblemSearch(state.quizExerciseMode, p.indexName, p.referenceSpl);
      } catch (e) {
        setBusy(false);
        showStatus("ng", e.message || String(e));
        return;
      }

      $.when(runSearchSplunk(userSearch), runSearchSplunk(refSearch))
        .done(function (userResults, refResults) {
          var userForGrade = normalizeRowsForGrade(p.id, userResults);
          var refForGrade = normalizeRowsForGrade(p.id, refResults);
          var graded = gradeSubmission(userForGrade, refForGrade);
          var ok = graded.ok;
          var nu = normalizeResults(userResults);
          var nr = normalizeResults(refResults);
          var message;
          if (ok) {
            message = "Correct";
          } else if (nr.length === 0) {
            message =
              state.quizExerciseMode === "sample"
                ? "Cannot grade: reference search returned 0 rows. Check lookup spl_quiz_sample_events and virtual_index."
                : "Cannot grade: reference search returned 0 rows. Check that the index has tutorial data.";
          } else if (nu.length === 0) {
            message = "Incorrect (your result has 0 rows).";
          } else if (bothSingleRowCountZero(nu, nr)) {
            message =
              "Incorrect (both your result and the reference have count 0 — check data or predicates).";
          } else {
            message = "Incorrect";
          }
          renderTable(sl("#sl-result-table"), userResults);
          showStatus(ok ? "ok" : "ng", message);
        })
        .fail(function (err) {
          var msg = err && err.message ? err.message : parseSplunkError(err);
          showStatus("ng", msg);
        })
        .always(function () {
          setBusy(false);
        });
    });

    /**
     * Splunk Web may lazily mount Simple XML dashboard body/panels.
     * On first init, #spl-quiz-root may not yet be on the visible panel side;
     * quizScope$ may need rebinding when the node is inserted later.
     * (The script is tied to the dashboard, but panel DOM can appear asynchronously.)
     */
    function scheduleDomStabilizePass() {
      var delays = [200, 600, 1600, 4000];
      var hi;
      for (hi = 0; hi < delays.length; hi++) {
        (function (ms) {
          setTimeout(function () {
            try {
              if (isSplQuizEditViewUrl()) {
                var elE = resolveSplQuizEditRootElement();
                var curE = editScope$ && editScope$.get(0);
                if (!elE) return;
                var rE = elE.getBoundingClientRect();
                var rCurE =
                  curE && curE.isConnected ? curE.getBoundingClientRect() : { width: 0, height: 0 };
                var aE = rE.width * rE.height;
                var aCurE = rCurE.width * rCurE.height;
                if (elE !== curE || (aCurE < 4 && aE >= 400)) {
                  splQuizClientLog("diag_dom_stabilize_rebind", {
                    view: "edit",
                    afterMs: ms,
                    areaNew: Math.round(aE),
                    areaOld: Math.round(aCurE),
                  });
                  editScope$ = $(elE);
                  reconcileQuizExerciseDom();
                  if (state.problems && state.problems.length) {
                    applyProblemsData(
                      { problems: state.problems.slice() },
                      state.problemsLoadSource || "stabilize",
                      {}
                    );
                  }
                }
                return;
              }
              var el = resolveSplQuizRootElement();
              var cur = quizScope$ && quizScope$.get(0);
              if (!el) return;
              var rN = el.getBoundingClientRect();
              var rC = cur && cur.isConnected ? cur.getBoundingClientRect() : { width: 0, height: 0 };
              var aN = rN.width * rN.height;
              var aC = rC.width * rC.height;
              if (el !== cur || (aC < 4 && aN >= 400) || (el === cur && aC < 4 && aN > aC)) {
                splQuizClientLog("diag_dom_stabilize_rebind", {
                  view: "quiz",
                  afterMs: ms,
                  areaNew: Math.round(aN),
                  areaOld: Math.round(aC),
                  sameEl: el === cur,
                });
                quizScope$ = $(el);
                reconcileQuizExerciseDom();
                if (state.problems && state.problems.length) {
                  applyProblemsData(
                    { problems: state.problems.slice() },
                    state.problemsLoadSource || "stabilize",
                    {
                      preserveSelectId:
                        state.current && state.current.id ? state.current.id : null,
                    }
                  );
                }
              }
            } catch (eSt) {
              try {
                splQuizClientLog("diag_dom_stabilize_err", {
                  msg: eSt && eSt.message ? String(eSt.message) : String(eSt),
                });
              } catch (ignoreSe) {}
            }
          }, ms);
        })(delays[hi]);
      }
    }
    scheduleDomStabilizePass();
    dismissSplunkEnterprisePreloadOverlay("init_end");
  }

  try {
    init();
  } catch (eInit) {
    try {
      splQuizClientLog("diag_init_throw", {
        message: eInit && eInit.message ? String(eInit.message) : String(eInit),
      });
    } catch (ignoreDt) {}
    var $rx = getSplQuizRootJq($).add(getSplQuizEditRootJq($));
    if ($rx.length) {
      $rx.html(
        '<p style="padding:1rem;color:#e89898;background:#251818;border:1px solid #5c3838;border-radius:8px;">Initialization error: ' +
          (eInit && eInit.message ? eInit.message : String(eInit)) +
          "</p>"
      );
    }
  }
  }

  /**
   * Load jQuery first: if splunkjs/mvc hangs, downstream code never ran and only hints remained.
   * Require splunkjs after #spl-quiz-root is detected.
   * Private/cold starts can be slow: combine MutationObserver, polling, and iframe load.
   */
  function runSplunkJsWhenRootReady() {
    var maxMs = 180000;
    var started = Date.now();
    var bootDone = false;
    var mo = null;
    var pollIv = null;

    function wireIframe(ifr) {
      if (!ifr || ifr._splQuizWired) return;
      ifr._splQuizWired = true;
      try {
        ifr.addEventListener("load", function () {
          setTimeout(attempt, 0);
        });
      } catch (e) {}
    }

    function cleanupWatchers() {
      try {
        if (mo) {
          mo.disconnect();
          mo = null;
        }
      } catch (e) {}
      try {
        if (pollIv) {
          clearInterval(pollIv);
          pollIv = null;
        }
      } catch (e2) {}
    }

    function showTimeoutUi() {
      var el = getSplQuizRootEl() || getSplQuizEditRootEl();
      if (el) {
        el.innerHTML =
          '<p style="padding:1rem;color:#e89898;background:#251818;border:1px solid #5c3838;border-radius:8px;">Could not find #spl-quiz-root or #spl-quiz-edit-root within ' +
          Math.round(maxMs / 1000) +
          ' seconds. In private windows, rendering can be slow right after login. Confirm the URL ends with <code>.../spl_quiz</code>, <code>.../spl_quiz_sample</code>, or <code>.../spl_quiz_edit</code>, then reload.</p>';
      } else {
        try {
          document.body.appendChild(
            (function () {
              var d = document.createElement("div");
              d.setAttribute(
                "style",
                "padding:1rem;margin:1rem;color:#d4c4a0;background:#2a2618;border:1px solid #5a4d2a;border-radius:8px;"
              );
              d.textContent =
                "spl_quiz: #spl-quiz-root / #spl-quiz-edit-root not found. Reopen the view or try a normal (non-private) window.";
              return d;
            })()
          );
        } catch (e3) {}
        try {
          console.error("spl_quiz: lesson/edit root not found after " + maxMs + "ms");
        } catch (e4) {}
      }
    }

    function attempt() {
      if (bootDone) return;
      var wantEdit = false;
      try {
        wantEdit =
          (window.location.href || "").indexOf("spl_quiz_edit") >= 0 ||
          (window.location.pathname || "").indexOf("spl_quiz_edit") >= 0;
      } catch (eUrl) {}
      var $r = wantEdit ? getSplQuizEditRootJq($) : getSplQuizRootJq($);
      if ($r.length) {
        bootDone = true;
        cleanupWatchers();
        try {
          splQuizClientLog("diag_boot_root_found", {
            ms: Date.now() - started,
            wantEdit: wantEdit,
            inIframe: window !== window.top,
          });
        } catch (ignoreDb) {}
        require(["splunkjs/mvc", "splunkjs/mvc/searchmanager"], function (mvc, SearchManager) {
          try {
            splQuizClientLog("diag_boot_splunkjs_ok", {});
          } catch (ignoreDc) {}
          initSplQuizApp(mvc, SearchManager);
        }, function (req2) {
          try {
            splQuizClientLog("diag_boot_splunkjs_fail", {
              msg: req2 && String(req2),
            });
          } catch (ignoreDd) {}
          try {
            console.error("spl_quiz: splunkjs bundle failed", req2);
          } catch (e) {}
          $r.html(
            '<p style="padding:1rem;color:#e89898;background:#251818;border:1px solid #5c3838;border-radius:8px;">Failed to load splunkjs/mvc. In Network, check splunkjs for 404 or stuck pending requests.</p>'
          );
        });
        return;
      }
      if (Date.now() - started >= maxMs) {
        bootDone = true;
        cleanupWatchers();
        try {
          splQuizClientLog("diag_boot_timeout_ms", { maxMs: maxMs });
        } catch (ignoreDe) {}
        showTimeoutUi();
      }
    }

    $(function () {
      try {
        console.info("spl_quiz: jquery ok, waiting for lesson/edit root");
      } catch (e0) {}
      attempt();
      try {
        mo = new MutationObserver(function (muts) {
          if (muts && muts.length) {
            var k;
            for (k = 0; k < muts.length; k++) {
              var added = muts[k].addedNodes;
              var n;
              for (n = 0; n < added.length; n++) {
                var node = added[n];
                if (node && node.tagName === "IFRAME") wireIframe(node);
              }
            }
          }
          attempt();
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e1) {}
      try {
        pollIv = setInterval(attempt, 280);
      } catch (e2) {}
      try {
        window.addEventListener("pageshow", function () {
          attempt();
        });
      } catch (e3) {}
      try {
        document.addEventListener("readystatechange", function () {
          attempt();
        });
      } catch (e4) {}
      try {
        var ifs0 = document.getElementsByTagName("iframe");
        var j;
        for (j = 0; j < ifs0.length; j++) wireIframe(ifs0[j]);
      } catch (e5) {}
    });
  }

  runSplunkJsWhenRootReady();
}, function (requireErr) {
  /**
   * If jQuery/splunkjs fail to load, the callback never runs (near-blank UI).
   * errback must not depend on jQuery (require may have failed before jquery).
   */
  var root = (function findRootVanilla() {
    function pickInDoc(d) {
      if (!d) return null;
      var e = d.getElementById("spl-quiz-root") || d.getElementById("spl-quiz-edit-root");
      if (e) return e;
      try {
        if (d.querySelector) {
          e = d.querySelector(
            ".spl-quiz-exercise-sample, .spl-quiz-exercise-user, .spl-quiz-exercise, .spl-quiz-edit-root"
          );
          if (e) return e;
        }
      } catch (ignore) {}
      return null;
    }
    function walkFrames(doc, depth) {
      if (!doc || depth > 6) return null;
      var e = pickInDoc(doc);
      if (e) return e;
      try {
        var iframes = doc.getElementsByTagName("iframe");
        var i;
        for (i = 0; i < iframes.length; i++) {
          try {
            var next =
              iframes[i].contentDocument ||
              (iframes[i].contentWindow && iframes[i].contentWindow.document);
            if (next) {
              var inner = walkFrames(next, depth + 1);
              if (inner) return inner;
            }
          } catch (err) {}
        }
      } catch (e2) {}
      return null;
    }
    return walkFrames(document, 0);
  })();
  var detail = "";
  try {
    if (requireErr && requireErr.requireType) {
      detail += " requireType=" + String(requireErr.requireType);
    }
    if (requireErr && requireErr.requireModules && requireErr.requireModules.length) {
      detail += " modules=" + requireErr.requireModules.join(",");
    }
  } catch (ignore) {}
  if (root) {
    var p = document.createElement("p");
    p.setAttribute(
      "style",
      "padding:1rem;color:#e89898;background:#251818;border:1px solid #5c3838;border-radius:8px;max-width:52rem;line-height:1.5"
    );
    p.textContent =
      "Could not load script dependencies (RequireJS error). Log in to Splunk, then reload this page." +
      (detail ? " [" + detail.trim() + "]" : "");
    root.innerHTML = "";
    root.appendChild(p);
  }
  try {
    if (typeof console !== "undefined" && console.error) {
      console.error("spl_quiz: require() failed", requireErr);
    }
  } catch (ignore) {}
});
