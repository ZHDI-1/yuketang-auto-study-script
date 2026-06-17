// ==UserScript==
// @name         雨课堂全自动学习进度管理
// @namespace    https://kmustyjscfd.yuketang.cn/
// @version      0.8.2
// @description  自动遍历雨课堂课程章节视频，按配置倍速播放，并在播放结束后跳转下一节；遇到加载/卡顿故障自动刷新本页重试并保持自动模式。
// @author       local
// @license      GPL-3.0-only
// @match        https://kmustyjscfd.yuketang.cn/pro/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";

  /*
   * 合规声明：
   * 本脚本仅供个人学习效率提升，所有操作均基于用户合法授权及浏览器已登录状态。
   * 不篡改学习数据，不绕过平台验证码或安全机制。
   * 使用者应遵守雨课堂服务条款，因违规使用产生的后果自负。
   *
   * 播放器控制逻辑参考本地 yuketang.js「雨课堂刷课助手」的 Player 工具实现。
   * 原脚本许可证为 GPL3，因此本脚本以 GPL-3.0-only 发布。
   */

  var SCRIPT_NAME = "雨课堂自动学习";
  var ROUTE_STABLE_WAIT_MS = 5000;
  var POST_VIDEO_RESCAN_WAIT_MS = 5000;
  var VIDEO_END_SYNC_WAIT_MS = 7000;
  var POST_HEARTBACK_SETTLE_MS = 1500;
  var PANEL_RENDER_THROTTLE_MS = 200;
  var WAIT_MUTATION_THROTTLE_MS = 250;
  var VIDEO_WATCHDOG_INTERVAL_MS = 4000;
  var VIDEO_STALL_TIMEOUT_MS = 8000;
  var VIDEO_NEAR_END_SECONDS = 1.5;
  var MAX_STALL_RECOVERIES = 4;
  var MAX_TRAINING_REVISITS = 3;
  var CONFIG_KEYS = {
    playbackRate: "yt_auto.playbackRate",
    targetCourseName: "yt_auto.targetCourseName",
    autoStart: "yt_auto.autoStart",
    continueOnError: "yt_auto.continueOnError",
    maxRetries: "yt_auto.maxRetries",
    paused: "yt_auto.paused",
    courseQueue: "yt_auto.courseQueue",
    queueIndex: "yt_auto.queueIndex",
    queueSource: "yt_auto.queueSource",
    flowPhase: "yt_auto.flowPhase",
    myTrainingUrl: "yt_auto.myTrainingUrl"
  };
  var DEFAULT_CONFIG = {
    playbackRate: 2,
    targetCourseName: "",
    autoStart: true,
    continueOnError: true,
    maxRetries: 3,
    paused: false,
    courseQueue: [],
    queueIndex: 0,
    queueSource: "",
    flowPhase: "",
    myTrainingUrl: ""
  };
  var ROUTE = {
    selectCourse: /\/pro\/trainingproject\/selectcourse\//,
    myTraining: /\/pro\/trainingproject\/mytraining\/detail\/\d+/,
    courseAbout: /\/pro\/portal\/about\/project_/,
    studyContent: /\/pro\/lms\/[^/]+\/[^/]+\/studycontent(?:[/?#]|$)/,
    video: /\/pro\/lms\/[^/]+\/[^/]+\/video\//,
    lesson: /\/pro\/yktmanage\/s\/[^/]+\/lesson\//
  };
  var STATUS = {
    idle: "空闲",
    scanning: "运行中",
    playing: "播放中",
    complete: "已完成",
    paused: "已暂停",
    blocked: "需处理",
    retrying: "重试中"
  };
  var state = {
    status: STATUS.idle,
    message: "等待页面就绪",
    logs: [],
    courseItems: [],
    chapterItems: [],
    queueItems: [],
    observerDisposers: [],
    timers: [],
    running: false,
    videoRetryCount: 0,
    handledEnd: false,
    routeRunKey: "",
    completedRouteKey: "",
    navigatingTo: "",
    navigationStartedAt: 0,
    lastUserGestureAt: 0,
    panelRenderTimer: 0,
    lastTrainingTarget: "",
    trainingRevisits: 0,
    reacquiring: false
  };

  function getPageWindow() {
    try {
      if (typeof unsafeWindow !== "undefined" && unsafeWindow) return unsafeWindow;
    } catch (error) {
      // Fall through to the sandbox window when unsafeWindow is not available.
    }
    return window;
  }

  function readConfig() {
    return {
      playbackRate: normalizeRate(GM_getValue(CONFIG_KEYS.playbackRate, DEFAULT_CONFIG.playbackRate)),
      targetCourseName: String(GM_getValue(CONFIG_KEYS.targetCourseName, DEFAULT_CONFIG.targetCourseName) || "").trim(),
      autoStart: Boolean(GM_getValue(CONFIG_KEYS.autoStart, DEFAULT_CONFIG.autoStart)),
      continueOnError: Boolean(GM_getValue(CONFIG_KEYS.continueOnError, DEFAULT_CONFIG.continueOnError)),
      maxRetries: Math.max(0, Number(GM_getValue(CONFIG_KEYS.maxRetries, DEFAULT_CONFIG.maxRetries)) || DEFAULT_CONFIG.maxRetries),
      paused: Boolean(GM_getValue(CONFIG_KEYS.paused, DEFAULT_CONFIG.paused))
    };
  }

  function writeConfig(patch) {
    Object.keys(patch).forEach(function (name) {
      if (CONFIG_KEYS[name]) {
        GM_setValue(CONFIG_KEYS[name], patch[name]);
      }
    });
  }

  function safeJsonParse(value, fallback) {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function readQueue() {
    var queue = safeJsonParse(GM_getValue(CONFIG_KEYS.courseQueue, "[]"), []);
    if (!Array.isArray(queue)) queue = [];
    var index = Number(GM_getValue(CONFIG_KEYS.queueIndex, DEFAULT_CONFIG.queueIndex)) || 0;
    var source = String(GM_getValue(CONFIG_KEYS.queueSource, DEFAULT_CONFIG.queueSource) || "");
    var phase = String(GM_getValue(CONFIG_KEYS.flowPhase, DEFAULT_CONFIG.flowPhase) || "");
    var myTrainingUrl = String(GM_getValue(CONFIG_KEYS.myTrainingUrl, DEFAULT_CONFIG.myTrainingUrl) || "");
    return {
      items: queue,
      index: Math.max(0, Math.min(index, queue.length)),
      source: source,
      phase: phase,
      myTrainingUrl: myTrainingUrl
    };
  }

  function writeQueue(items, index, source, patch) {
    patch = patch || {};
    GM_setValue(CONFIG_KEYS.courseQueue, JSON.stringify(items || []));
    GM_setValue(CONFIG_KEYS.queueIndex, Math.max(0, Number(index) || 0));
    if (source !== undefined) GM_setValue(CONFIG_KEYS.queueSource, String(source || ""));
    if (patch.phase !== undefined) GM_setValue(CONFIG_KEYS.flowPhase, String(patch.phase || ""));
    if (patch.myTrainingUrl !== undefined) GM_setValue(CONFIG_KEYS.myTrainingUrl, String(patch.myTrainingUrl || ""));
    state.queueItems = items || [];
    requestRenderPanel();
  }

  function resetQueue(reason) {
    writeQueue([], 0, "", { phase: "", myTrainingUrl: "" });
    clearProgress();
    clearSkipState();
    state.routeRunKey = "";
    state.completedRouteKey = "";
    state.running = false;
    state.navigatingTo = "";
    state.lastTrainingTarget = "";
    state.trainingRevisits = 0;
    setStatus(STATUS.idle, reason || "课程队列已重置");
  }

  // 学习进度汇总（持久化，跨整页跳转仍可在面板展示）：
  // courseTotal/courseDone 来自培训进度页；videoTotal/videoDone 来自当前课程的学习内容页。
  var PROGRESS_KEY = "yt_auto.progress";
  var SKIPPED_COURSES_KEY = "yt_auto.skippedCourses";
  var SKIPPED_CHAPTERS_KEY = "yt_auto.skippedChapters";
  var CURRENT_CHAPTER_KEY = "yt_auto.currentChapter";

  function readProgress() {
    return safeJsonParse(GM_getValue(PROGRESS_KEY, ""), {}) || {};
  }

  function writeProgress(patch) {
    if (!patch) return;
    var next = Object.assign(readProgress(), patch);
    GM_setValue(PROGRESS_KEY, JSON.stringify(next));
    requestRenderPanel();
  }

  function clearProgress() {
    GM_setValue(PROGRESS_KEY, "{}");
    requestRenderPanel();
  }

  function readStore(key) {
    return safeJsonParse(GM_getValue(key, "{}"), {}) || {};
  }

  function writeStore(key, value) {
    GM_setValue(key, JSON.stringify(value || {}));
  }

  function clearSkipState() {
    writeStore(SKIPPED_COURSES_KEY, {});
    writeStore(SKIPPED_CHAPTERS_KEY, {});
    GM_setValue(CURRENT_CHAPTER_KEY, "");
  }

  function trainingIdFromUrl(url) {
    var match = String(url || "").match(/\/pro\/trainingproject\/mytraining\/detail\/(\d+)/);
    return match ? match[1] : "";
  }

  function activeTrainingId() {
    var direct = getTrainClassId();
    if (direct) return direct;
    var queue = readQueue();
    if (queue.myTrainingUrl) return trainingIdFromUrl(queue.myTrainingUrl);
    var current = readCurrentChapter();
    return current.trainingId || "";
  }

  function courseSkipKey(title, trainingId) {
    return String(trainingId || activeTrainingId() || "global") + "|" + String(title || "");
  }

  function markCourseSkipped(title, reason, trainingId) {
    title = String(title || "").trim();
    if (!title) return;
    var store = readStore(SKIPPED_COURSES_KEY);
    store[courseSkipKey(title, trainingId)] = {
      title: title,
      reason: reason || "本轮跳过",
      at: Date.now()
    };
    writeStore(SKIPPED_COURSES_KEY, store);
    log("本轮跳过课程：" + title + "（" + (reason || "无可播放内容") + "）");
  }

  function isCourseSkipped(title, trainingId) {
    title = String(title || "").trim();
    if (!title) return false;
    return Boolean(readStore(SKIPPED_COURSES_KEY)[courseSkipKey(title, trainingId)]);
  }

  function chapterSkipRecord(key) {
    key = String(key || "");
    return key ? readStore(SKIPPED_CHAPTERS_KEY)[key] || null : null;
  }

  function markChapterSkipped(chapter, reason) {
    var key = chapter && chapter.key ? String(chapter.key) : "";
    if (!key) return;
    var store = readStore(SKIPPED_CHAPTERS_KEY);
    store[key] = {
      title: chapter.title || "",
      reason: reason || "本轮跳过",
      at: Date.now()
    };
    writeStore(SKIPPED_CHAPTERS_KEY, store);
    log("本轮跳过章节：" + (chapter.title || key) + "（" + (reason || "无可播放内容") + "）");
  }

  function isChapterSkipped(item) {
    return Boolean(item && item.key && chapterSkipRecord(item.key));
  }

  function readCurrentChapter() {
    return safeJsonParse(GM_getValue(CURRENT_CHAPTER_KEY, ""), {}) || {};
  }

  function writeCurrentChapter(chapter) {
    GM_setValue(CURRENT_CHAPTER_KEY, JSON.stringify(chapter || {}));
  }

  function getCurrentCourseTitle() {
    var selectors = [".source-name", ".course-name", ".courseName", ".header-bar .title", ".study-content__container .title"];
    for (var i = 0; i < selectors.length; i += 1) {
      var el = document.querySelector(selectors[i]);
      if (el && textOf(el)) return textOf(el).slice(0, 80);
    }
    return "";
  }

  function currentQueueItem() {
    var queue = readQueue();
    return queue.items[queue.index] || null;
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      schedule(resolve, ms);
    });
  }

  function courseMatchesTarget(item, config) {
    return !config.targetCourseName || item.title === config.targetCourseName || item.name === config.targetCourseName;
  }

  function currentCourseSign() {
    var match = location.pathname.match(/\/pro\/portal\/about\/([^/?#]+)/) || location.pathname.match(/\/pro\/lms\/([^/]+)\//);
    if (match) return decodeURIComponent(match[1]);
    return "";
  }

  function goToQueuedCourse(reason) {
    var queue = readQueue();
    state.queueItems = queue.items;
    if (!queue.items.length) {
      setStatus(STATUS.idle, "课程队列为空");
      return false;
    }
    if (queue.index >= queue.items.length) {
      setStatus(STATUS.complete, "课程队列已完成，请重置队列后重新开始");
      return false;
    }
    var item = queue.items[queue.index];
    setStatus(STATUS.scanning, (reason || "进入课程") + "：" + item.title + "（" + (queue.index + 1) + "/" + queue.items.length + "）");
    if (item.selectUrl) {
      return navigateTo(item.selectUrl, "进入选课详情 " + item.title);
    }
    if (item.action) {
      clickElement(item.action, "进入队列课程 " + item.title);
      return true;
    }
    // 该队列项没有可进入的链接：跳过它，保持自动流程继续。
    log("队列课程缺少可进入链接，已跳过：" + item.title);
    return advanceQueue("跳过无法进入的课程");
  }

  function finishSelectionPhase(reason) {
    var queue = readQueue();
    writeQueue(queue.items, queue.items.length, queue.source, {
      phase: "learning",
      myTrainingUrl: queue.myTrainingUrl || buildMyTrainingUrl()
    });
    var target = queue.myTrainingUrl || buildMyTrainingUrl();
    if (target) {
      setStatus(STATUS.scanning, reason || "选课完成，返回培训进度页");
      return navigateTo(target, "返回培训进度页");
    }
    setStatus(STATUS.complete, reason || "选课完成");
    return false;
  }

  function advanceQueue(reason) {
    var queue = readQueue();
    if (!queue.items.length) {
      setStatus(STATUS.complete, reason || "当前课程已完成");
      return false;
    }
    var nextIndex = Math.min(queue.index + 1, queue.items.length);
    writeQueue(queue.items, nextIndex, queue.source, { phase: queue.phase, myTrainingUrl: queue.myTrainingUrl });
    if (nextIndex >= queue.items.length) {
      if (queue.phase === "selecting") return finishSelectionPhase("全部课程已选课");
      setStatus(STATUS.complete, "全部队列课程已完成");
      return false;
    }
    return goToQueuedCourse(reason || "进入下一门课程");
  }

  function syncQueueIndexToCurrentPage() {
    var sign = currentCourseSign();
    if (!sign) return;
    var queue = readQueue();
    if (queue.phase !== "selecting") return;
    if (!queue.items.length) return;
    var index = queue.items.findIndex(function (item) {
      return item.sign === sign;
    });
    if (index >= 0 && index !== queue.index) {
      writeQueue(queue.items, index, queue.source);
      log("队列索引已同步到当前课程：" + queue.items[index].title);
    }
  }

  function completeCurrentCourse(reason) {
    var queue = readQueue();
    if (queue.phase === "learning" || routeName() === "myTraining") {
      var url = queue.myTrainingUrl || buildMyTrainingUrl();
      if (url) {
        setStatus(STATUS.scanning, (reason || "当前课程完成") + "，等待平台同步后返回培训进度页");
        schedule(function () {
          if (!isPaused()) navigateTo(url, "返回培训进度页");
        }, ROUTE_STABLE_WAIT_MS);
        return true;
      }
    }
    return advanceQueue(reason || "当前课程完成");
  }

  function skipCurrentCourse(reason) {
    var progress = readProgress();
    var current = readCurrentChapter();
    var queueItem = currentQueueItem();
    var title = progress.currentCourse || current.courseTitle || getCurrentCourseTitle() || (queueItem && queueItem.title) || "";
    markCourseSkipped(title, reason || "当前课程无可播放内容", current.trainingId);
    var queue = readQueue();
    var url = queue.myTrainingUrl || current.myTrainingUrl || buildMyTrainingUrl();
    if (url) {
      setStatus(STATUS.scanning, (reason || "当前课程无可播放内容") + "，返回培训进度页继续下一门");
      schedule(function () {
        if (!isPaused()) navigateTo(url, "跳过当前课程后返回培训进度页");
      }, ROUTE_STABLE_WAIT_MS);
      return true;
    }
    block(reason || "当前课程无可播放内容，需要手动返回培训进度页");
    return false;
  }

  function skipCurrentChapter(reason) {
    var current = readCurrentChapter();
    if (current && current.key) markChapterSkipped(current, reason || "当前章节无可播放内容");
    var studyUrl = (current && current.studyUrl) || GM_getValue("yt_auto.studyUrl", "");
    if (studyUrl) {
      setStatus(STATUS.scanning, (reason || "当前章节无可播放内容") + "，返回学习内容页继续扫描");
      schedule(function () {
        if (!isPaused()) navigateTo(studyUrl, "跳过当前章节后返回学习内容页");
      }, ROUTE_STABLE_WAIT_MS);
      return true;
    }
    return skipCurrentCourse(reason || "当前章节无可播放内容");
  }

  function normalizeRate(value) {
    var rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) return DEFAULT_CONFIG.playbackRate;
    return Math.min(16, Math.max(0.25, rate));
  }

  function log(message, data) {
    var line = "[" + new Date().toLocaleTimeString() + "] " + message;
    state.logs.unshift(line);
    state.logs = state.logs.slice(0, 8);
    if (data !== undefined) {
      console.log("[" + SCRIPT_NAME + "] " + message, data);
    } else {
      console.log("[" + SCRIPT_NAME + "] " + message);
    }
    requestRenderPanel();
  }

  function setStatus(status, message) {
    message = message || "";
    if (state.status === status && state.message === message) {
      requestRenderPanel();
      return;
    }
    state.status = status;
    state.message = message;
    log(status + (message ? "：" + message : ""));
  }

  function isPaused() {
    return Boolean(readConfig().paused);
  }

  // 用户主动暂停：可随时“继续”。
  function pause(reason) {
    writeConfig({ paused: true });
    setStatus(STATUS.paused, reason || "已暂停，点击“继续”恢复");
  }

  // 脚本无法自行继续、需要人来处理（登录失效、找不到课程等）。处理后点“继续”。
  function block(reason) {
    writeConfig({ paused: true });
    setStatus(STATUS.blocked, reason || "需要手动处理后点击“继续”");
  }

  function resume() {
    writeConfig({ paused: false, autoStart: true });
    state.routeRunKey = "";
    state.completedRouteKey = "";
    state.running = false;
    state.navigatingTo = "";
    state.lastTrainingTarget = "";
    state.trainingRevisits = 0;
    setStatus(STATUS.scanning, "自动流程已启动");
    schedule(runRouter, 100);
  }

  function schedule(fn, delay) {
    var timer = window.setTimeout(function () {
      state.timers = state.timers.filter(function (item) { return item !== timer; });
      fn();
    }, delay);
    state.timers.push(timer);
    return timer;
  }

  function clearManagedAsync() {
    state.observerDisposers.forEach(function (dispose) {
      try { dispose(); } catch (error) { console.warn(error); }
    });
    state.observerDisposers = [];
    state.timers.forEach(function (timer) { window.clearTimeout(timer); });
    state.timers = [];
  }

  function textOf(node) {
    return (node && node.textContent ? node.textContent : "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    var style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function uniqueByElement(items) {
    var seen = new Set();
    return items.filter(function (item) {
      var key = item && (item.key || item.url || item.element);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function waitFor(predicate, options) {
    var opts = Object.assign({
      timeout: 15000,
      interval: 400,
      mutationThrottle: WAIT_MUTATION_THROTTLE_MS,
      observeAttributes: false,
      root: document.body || document.documentElement,
      label: "元素"
    }, options || {});

    return new Promise(function (resolve, reject) {
      var startedAt = Date.now();
      var settled = false;
      var interval = 0;
      var mutationTimer = 0;
      var observer = null;

      function cleanup() {
        if (interval) window.clearInterval(interval);
        if (mutationTimer) window.clearTimeout(mutationTimer);
        if (observer) observer.disconnect();
        state.observerDisposers = state.observerDisposers.filter(function (dispose) { return dispose !== cleanup; });
      }

      function requestCheck() {
        if (settled || mutationTimer) return;
        mutationTimer = window.setTimeout(function () {
          mutationTimer = 0;
          check();
        }, opts.mutationThrottle);
      }

      function check() {
        if (settled) return;
        if (isPaused()) {
          settled = true;
          cleanup();
          reject(new Error("自动流程已暂停"));
          return;
        }
        var result = null;
        try {
          result = predicate();
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
          return;
        }
        if (result) {
          settled = true;
          cleanup();
          resolve(result);
          return;
        }
        if (Date.now() - startedAt >= opts.timeout) {
          settled = true;
          cleanup();
          reject(new Error("等待" + opts.label + "超时"));
        }
      }

      interval = window.setInterval(check, opts.interval);
      observer = new MutationObserver(requestCheck);
      observer.observe(opts.root || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: Boolean(opts.observeAttributes)
      });
      state.observerDisposers.push(cleanup);
      check();
    });
  }

  function clickElement(element, reason) {
    if (!element) return false;
    log("触发：" + reason, element);
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return true;
  }

  function refreshCountKey() {
    return "yt_auto.refresh:" + location.pathname;
  }

  function clearRefreshCount() {
    try { window.sessionStorage.removeItem(refreshCountKey()); } catch (error) { /* ignore */ }
  }

  // 出现可恢复的故障时刷新当前页重试，并始终保持自动模式开启（除非用户手动暂停）。
  // 用逐步拉长的退避间隔避免在真正损坏的页面上疯狂刷新。
  function refreshCurrentPage(reason) {
    if (isPaused()) return;
    var key = refreshCountKey();
    var count = 0;
    try { count = Number(window.sessionStorage.getItem(key) || 0) || 0; } catch (error) { count = 0; }
    try { window.sessionStorage.setItem(key, String(count + 1)); } catch (error) { /* ignore */ }
    var delayMs = count < 4 ? 3000 : (count < 8 ? 8000 : 20000);
    setStatus(STATUS.retrying, reason + "，" + Math.round(delayMs / 1000) + " 秒后自动刷新本页重试（第 " + (count + 1) + " 次）");
    schedule(function () {
      if (!isPaused()) location.reload();
    }, delayMs);
  }

  function navigateTo(url, reason) {
    if (!url) return false;
    clearRefreshCount();
    var absoluteUrl = new URL(url, location.href).href;
    state.navigatingTo = absoluteUrl;
    state.navigationStartedAt = Date.now();
    log("跳转：" + (reason || absoluteUrl), absoluteUrl);
    if (location.href === absoluteUrl) {
      state.navigatingTo = "";
      state.navigationStartedAt = 0;
      schedule(runRouter, 300);
      return true;
    }
    // 整页跳转：每个视频都需要整页加载来重新初始化播放器心跳（带正确的视频参数），
    // 否则后端无法记进度。SPA router.push 会导致心跳参数不刷新 -> 进度恒为 0%。
    location.assign(absoluteUrl);
    return true;
  }

  function currentRouteKey() {
    return routeName() + "|" + location.href;
  }

  function shouldWaitForNavigation() {
    if (!state.navigatingTo) return false;
    if (location.href === state.navigatingTo) {
      state.navigatingTo = "";
      state.navigationStartedAt = 0;
      return false;
    }
    if (Date.now() - state.navigationStartedAt > 6000) {
      state.navigatingTo = "";
      state.navigationStartedAt = 0;
      return false;
    }
    return true;
  }

  function enterChapter(chapter, reason) {
    if (!chapter) return false;
    if (chapter.title) writeProgress({ currentVideo: chapter.title });
    writeCurrentChapter({
      key: chapter.key || "",
      title: chapter.title || "",
      studyUrl: routeName() === "studyContent" ? location.href : (GM_getValue("yt_auto.studyUrl", "") || ""),
      courseTitle: readProgress().currentCourse || getCurrentCourseTitle() || "",
      trainingId: activeTrainingId(),
      myTrainingUrl: readQueue().myTrainingUrl || buildMyTrainingUrl()
    });
    if (chapter.url) {
      return navigateTo(chapter.url, reason || chapter.title);
    }
    return clickElement(chapter.action || chapter.element, reason || ("进入章节 " + chapter.title));
  }

  function routeName() {
    var path = location.pathname;
    if (ROUTE.selectCourse.test(path)) return "selectCourse";
    if (ROUTE.myTraining.test(path)) return "myTraining";
    if (ROUTE.courseAbout.test(path)) return "courseAbout";
    if (ROUTE.studyContent.test(path)) return "studyContent";
    if (ROUTE.video.test(path)) return "video";
    if (ROUTE.lesson.test(path)) return "lesson";
    return "unknown";
  }

  // 接管播放器、且页面会停留（不应被 completedRouteKey 拦截重入）的路由。
  function isPlayerRoute(name) {
    return name === "video" || name === "lesson";
  }

  function looksLoggedOut() {
    var pageText = textOf(document.body);
    if (!pageText) return false;
    return /请先登录|登录已失效|重新登录|账号登录|验证码登录|扫码登录/.test(pageText);
  }

  function ensureLoggedIn() {
    if (looksLoggedOut()) {
      block("请先登录后点击“继续”");
      return false;
    }
    return true;
  }

  function initPanel() {
    if (document.getElementById("yt-auto-panel")) return;

    var style = document.createElement("style");
    style.id = "yt-auto-panel-style";
    style.textContent = [
      "#yt-auto-panel{position:fixed;top:64px;right:18px;z-index:2147483647;width:300px;max-width:calc(100vw - 24px);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;color:#1f2937;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.18);overflow:hidden}",
      "#yt-auto-panel *{box-sizing:border-box}",
      "#yt-auto-panel header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;cursor:move;user-select:none}",
      "#yt-auto-panel header .yt-h-title{font-weight:700;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "#yt-auto-panel .yt-badge{flex:0 0 auto;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;background:rgba(255,255,255,.22);color:#fff}",
      "#yt-auto-panel .yt-badge[data-variant='playing']{background:#22c55e}",
      "#yt-auto-panel .yt-badge[data-variant='working']{background:#f59e0b}",
      "#yt-auto-panel .yt-badge[data-variant='complete']{background:#10b981}",
      "#yt-auto-panel .yt-badge[data-variant='blocked']{background:#ef4444}",
      "#yt-auto-panel .yt-badge.yt-live{animation:yt-pulse 1.4s ease-in-out infinite}",
      "@keyframes yt-pulse{0%,100%{opacity:1}50%{opacity:.55}}",
      "#yt-auto-panel .yt-collapse{flex:0 0 auto;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:rgba(255,255,255,.2);color:#fff;cursor:pointer;font-size:15px;line-height:1}",
      "#yt-auto-panel main{padding:12px}",
      "#yt-auto-panel .yt-msg{color:#374151;word-break:break-word;min-height:18px}",
      "#yt-auto-panel .yt-sub{color:#94a3b8;font-size:11px;margin:2px 0 10px}",
      "#yt-auto-panel .yt-card{background:#f8fafc;border:1px solid #eef2f7;border-radius:9px;padding:10px;margin-bottom:10px}",
      "#yt-auto-panel .yt-prog+.yt-prog{margin-top:10px}",
      "#yt-auto-panel .yt-prog-head{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;margin-bottom:5px}",
      "#yt-auto-panel .yt-prog-head b{font-weight:600;color:#374151}",
      "#yt-auto-panel .yt-prog-head span{color:#64748b;font-variant-numeric:tabular-nums}",
      "#yt-auto-panel .yt-bar{height:8px;border-radius:999px;background:#e5e7eb;overflow:hidden}",
      "#yt-auto-panel .yt-bar-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#22c55e,#16a34a);width:0;transition:width .3s ease}",
      "#yt-auto-panel .yt-bar-fill.course{background:linear-gradient(90deg,#3b82f6,#6366f1)}",
      "#yt-auto-panel .yt-cur{margin-top:9px;font-size:12px;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "#yt-auto-panel .yt-cur b{color:#1f2937}",
      "#yt-auto-panel .yt-row{display:flex;gap:8px;align-items:center;margin:8px 0}",
      "#yt-auto-panel button{flex:1;height:32px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#111827;padding:0 8px;cursor:pointer;white-space:nowrap;font-size:13px}",
      "#yt-auto-panel button:hover{background:#f1f5f9}",
      "#yt-auto-panel button.yt-primary{background:#2563eb;border-color:#2563eb;color:#fff}",
      "#yt-auto-panel button.yt-primary:hover{background:#1d4ed8}",
      "#yt-auto-panel button.yt-danger{background:#fff;border-color:#fca5a5;color:#dc2626}",
      "#yt-auto-panel button.yt-danger:hover{background:#fef2f2}",
      "#yt-auto-panel label{display:flex;align-items:center;gap:6px;color:#374151;font-size:12px}",
      "#yt-auto-panel input[type=number],#yt-auto-panel input[type=text]{height:30px;min-width:0;border:1px solid #cbd5e1;border-radius:7px;padding:0 8px;background:#fff;color:#111827;font-size:13px}",
      "#yt-auto-panel .yt-list{max-height:150px;overflow:auto;border-top:1px solid #eef2f7;margin-top:6px;padding-top:6px}",
      "#yt-auto-panel .yt-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid #f3f4f6}",
      "#yt-auto-panel .yt-item:last-child{border-bottom:none}",
      "#yt-auto-panel .yt-item .yt-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}",
      "#yt-auto-panel .yt-item .yt-meta{font-size:11px;color:#94a3b8}",
      "#yt-auto-panel .yt-item button{flex:0 0 auto;height:26px;font-size:12px}",
      "#yt-auto-panel .yt-empty{color:#94a3b8;font-size:12px;text-align:center;padding:8px 0}",
      "#yt-auto-panel .yt-toggle{cursor:pointer;color:#64748b;font-size:12px;user-select:none;padding:7px 0 3px;border-top:1px solid #eef2f7;margin-top:6px}",
      "#yt-auto-panel .yt-log{max-height:96px;overflow:auto;color:#94a3b8;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace}",
      "#yt-auto-panel .yt-log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "#yt-auto-panel.yt-loghide .yt-log{display:none}",
      "#yt-auto-panel.yt-listhide .yt-list{display:none}",
      "#yt-auto-panel.yt-collapsed main{display:none}",
      "#yt-auto-panel.yt-collapsed{width:auto}"
    ].join("");

    var panel = document.createElement("section");
    panel.id = "yt-auto-panel";
    panel.className = "yt-loghide yt-listhide";
    panel.innerHTML = [
      "<header>",
      "  <span class='yt-h-title'>雨课堂自动学习</span>",
      "  <span class='yt-badge' data-role='status'></span>",
      "  <button class='yt-collapse' type='button' title='折叠/展开'>−</button>",
      "</header>",
      "<main>",
      "  <div class='yt-msg' data-role='message'></div>",
      "  <div class='yt-sub' data-role='sub'></div>",
      "  <div class='yt-card'>",
      "    <div class='yt-prog' data-role='prog1'>",
      "      <div class='yt-prog-head'><b data-role='prog1-label'>课程进度</b><span data-role='prog1-count'>—</span></div>",
      "      <div class='yt-bar'><div class='yt-bar-fill course' data-role='prog1-bar'></div></div>",
      "    </div>",
      "    <div class='yt-prog' data-role='prog2'>",
      "      <div class='yt-prog-head'><b data-role='prog2-label'>本课视频</b><span data-role='prog2-count'>—</span></div>",
      "      <div class='yt-bar'><div class='yt-bar-fill' data-role='prog2-bar'></div></div>",
      "    </div>",
      "    <div class='yt-cur' data-role='current'></div>",
      "  </div>",
      "  <div class='yt-row'>",
      "    <button class='yt-primary' type='button' data-action='toggle'>▶ 启动</button>",
      "    <button type='button' data-action='scan'>扫描并进入</button>",
      "  </div>",
      "  <div class='yt-row'>",
      "    <label><input type='checkbox' data-field='autoStart'>自动模式</label>",
      "    <label style='margin-left:auto'>倍速<input type='number' data-field='playbackRate' min='0.25' max='16' step='0.25' style='width:64px'></label>",
      "  </div>",
      "  <div class='yt-row'>",
      "    <input type='text' data-field='targetCourseName' placeholder='指定课程名，留空选第一个' style='flex:1'>",
      "    <button type='button' data-action='save' style='flex:0 0 auto'>保存</button>",
      "  </div>",
      "  <div class='yt-row'>",
      "    <button type='button' data-action='resetQueue'>重置队列</button>",
      "  </div>",
      "  <div class='yt-toggle' data-action='toggleList'>页面项目 ▾</div>",
      "  <div class='yt-list' data-role='items'></div>",
      "  <div class='yt-toggle' data-action='toggleLog'>运行日志 ▾</div>",
      "  <div class='yt-log' data-role='logs'></div>",
      "</main>"
    ].join("");

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(panel);

    panel.addEventListener("click", function (event) {
      state.lastUserGestureAt = Date.now();
      var target = event.target;
      if (!(target instanceof Element)) return;
      var collapse = target.closest(".yt-collapse");
      if (collapse) {
        panel.classList.toggle("yt-collapsed");
        collapse.textContent = panel.classList.contains("yt-collapsed") ? "+" : "−";
        return;
      }
      var action = target.getAttribute("data-action");
      if (!action) {
        var courseButton = target.closest("[data-course-index]");
        if (courseButton) {
          var index = Number(courseButton.getAttribute("data-course-index"));
          var item = state.courseItems[index];
          if (item) clickElement(item.action, "进入课程 " + item.title);
        }
        var chapterButton = target.closest("[data-chapter-index]");
        if (chapterButton) {
          var chapterIndex = Number(chapterButton.getAttribute("data-chapter-index"));
          var chapter = state.chapterItems[chapterIndex];
          if (chapter) enterChapter(chapter, "进入章节 " + chapter.title);
        }
        return;
      }
      if (action === "toggle") {
        // 单一主按钮：暂停态/未启动 → 启动或继续；运行中 → 暂停。
        if (isPaused() || !readConfig().autoStart) {
          savePanelConfig();
          resume();
        } else {
          pause("用户手动暂停");
        }
      } else if (action === "scan") {
        savePanelConfig();
        writeConfig({ paused: false });
        manualScanCurrentPage();
      } else if (action === "resetQueue") {
        resetQueue("用户已重置课程队列");
      } else if (action === "save") {
        savePanelConfig();
        setStatus(STATUS.idle, "配置已保存");
      } else if (action === "toggleList") {
        var listHidden = panel.classList.toggle("yt-listhide");
        target.textContent = "页面项目 " + (listHidden ? "▾" : "▴");
      } else if (action === "toggleLog") {
        var logHidden = panel.classList.toggle("yt-loghide");
        target.textContent = "运行日志 " + (logHidden ? "▾" : "▴");
      }
    });

    makePanelDraggable(panel);
    renderPanel();
  }

  function makePanelDraggable(panel) {
    var header = panel.querySelector("header");
    if (!header) return;
    var dragging = false;
    var startX = 0;
    var startY = 0;
    var startLeft = 0;
    var startTop = 0;

    header.addEventListener("mousedown", function (event) {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest(".yt-collapse"))) return;
      var rect = panel.getBoundingClientRect();
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.left = startLeft + "px";
      panel.style.top = startTop + "px";
      panel.style.right = "auto";
      event.preventDefault();
    });
    window.addEventListener("mousemove", function (event) {
      if (!dragging) return;
      var maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
      var maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
      var nextX = startLeft + (event.clientX - startX);
      var nextY = startTop + (event.clientY - startY);
      panel.style.left = Math.max(0, Math.min(nextX, maxX)) + "px";
      panel.style.top = Math.max(0, Math.min(nextY, maxY)) + "px";
    });
    window.addEventListener("mouseup", function () {
      dragging = false;
    });
  }

  function requestRenderPanel() {
    if (state.panelRenderTimer) return;
    state.panelRenderTimer = window.setTimeout(function () {
      state.panelRenderTimer = 0;
      renderPanel();
    }, PANEL_RENDER_THROTTLE_MS);
  }

  function savePanelConfig() {
    var panel = document.getElementById("yt-auto-panel");
    if (!panel) return;
    var autoStart = panel.querySelector("[data-field='autoStart']");
    var playbackRate = panel.querySelector("[data-field='playbackRate']");
    var targetCourseName = panel.querySelector("[data-field='targetCourseName']");
    writeConfig({
      autoStart: autoStart ? autoStart.checked : DEFAULT_CONFIG.autoStart,
      playbackRate: playbackRate ? normalizeRate(playbackRate.value) : DEFAULT_CONFIG.playbackRate,
      targetCourseName: targetCourseName ? targetCourseName.value.trim() : ""
    });
  }

  function renderPanel() {
    var panel = document.getElementById("yt-auto-panel");
    if (!panel) return;
    var config = readConfig();
    var prog = readProgress();

    var queue = readQueue();

    var status = panel.querySelector("[data-role='status']");
    if (status) {
      status.textContent = state.status;
      status.setAttribute("data-variant", statusVariant(state.status));
      status.classList.toggle("yt-live", isActiveStatus(state.status));
    }
    setPanelText(panel, "message", state.message || "");
    setPanelText(panel, "sub", describeFlow());

    // 主按钮随状态变化：暂停态→继续；未启动→启动；运行中→暂停。
    var toggle = panel.querySelector("[data-action='toggle']");
    if (toggle) {
      if (config.paused) toggle.textContent = "▶ 继续";
      else if (!config.autoStart) toggle.textContent = "▶ 启动";
      else toggle.textContent = "⏸ 暂停";
    }

    // 进度卡片按阶段切换：选课阶段显示选课进度（单条），学习阶段显示课程+本课视频（两条）。
    if (queue.phase === "selecting") {
      setProg(panel, "prog1", "选课进度", queue.index, queue.items.length, true);
      showProg(panel, "prog2", false);
    } else {
      setProg(panel, "prog1", "课程进度", prog.courseDone, prog.courseTotal, true);
      showProg(panel, "prog2", true);
      setProg(panel, "prog2", "本课视频", prog.videoDone, prog.videoTotal, false);
    }
    var current = panel.querySelector("[data-role='current']");
    if (current) {
      var parts = [];
      if (prog.currentCourse) parts.push("<b>" + escapeHtml(prog.currentCourse) + "</b>");
      if (prog.currentVideo) parts.push(escapeHtml(prog.currentVideo));
      current.innerHTML = (parts.length && queue.phase !== "selecting") ? ("正在学习：" + parts.join(" · ")) : "";
    }

    var autoStart = panel.querySelector("[data-field='autoStart']");
    var playbackRate = panel.querySelector("[data-field='playbackRate']");
    var targetCourseName = panel.querySelector("[data-field='targetCourseName']");
    if (autoStart) autoStart.checked = config.autoStart;
    if (playbackRate && document.activeElement !== playbackRate) playbackRate.value = String(config.playbackRate);
    if (targetCourseName && document.activeElement !== targetCourseName) targetCourseName.value = config.targetCourseName;

    var logs = panel.querySelector("[data-role='logs']");
    if (logs) {
      logs.innerHTML = state.logs.map(function (line) {
        return "<div title='" + escapeHtml(line) + "'>" + escapeHtml(line) + "</div>";
      }).join("");
    }
    var items = panel.querySelector("[data-role='items']");
    if (items) renderItems(items);
  }

  function setPanelText(panel, role, text) {
    var el = panel.querySelector("[data-role='" + role + "']");
    if (el) el.textContent = text;
  }

  function showProg(panel, key, visible) {
    var row = panel.querySelector("[data-role='" + key + "']");
    if (row) row.style.display = visible ? "" : "none";
  }

  function setProg(panel, key, label, done, total, isCourse) {
    done = Math.max(0, Number(done) || 0);
    total = Math.max(0, Number(total) || 0);
    showProg(panel, key, true);
    var labelEl = panel.querySelector("[data-role='" + key + "-label']");
    var countEl = panel.querySelector("[data-role='" + key + "-count']");
    var barEl = panel.querySelector("[data-role='" + key + "-bar']");
    if (labelEl) labelEl.textContent = label;
    if (countEl) countEl.textContent = total > 0 ? (done + " / " + total + "（剩 " + Math.max(0, total - done) + "）") : "—";
    if (barEl) {
      barEl.style.width = (total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0) + "%";
      barEl.className = "yt-bar-fill" + (isCourse ? " course" : "");
    }
  }

  function statusVariant(status) {
    if (status === STATUS.playing) return "playing";
    if (status === STATUS.scanning || status === STATUS.retrying) return "working";
    if (status === STATUS.complete) return "complete";
    if (status === STATUS.paused) return "paused";
    if (status === STATUS.blocked) return "blocked";
    return "idle";
  }

  function isActiveStatus(status) {
    return status === STATUS.playing || status === STATUS.scanning || status === STATUS.retrying;
  }

  function describeFlow() {
    var queue = readQueue();
    var phaseLabel = queue.phase === "selecting"
      ? "选课中"
      : (queue.phase === "learning" ? "学习中" : "未开始");
    return phaseLabel + " · 倍速 " + readConfig().playbackRate + "x";
  }

  function renderItems(container) {
    var name = routeName();
    if (name === "selectCourse") {
      container.innerHTML = state.courseItems.length ? state.courseItems.map(function (item, index) {
        return [
          "<div class='yt-item'>",
          "  <div class='yt-title' title='" + escapeHtml(item.title) + "'>" + escapeHtml(item.title) + "</div>",
          "  <button type='button' data-course-index='" + index + "'>进入</button>",
          "</div>"
        ].join("");
      }).join("") : "<div class='yt-empty'>尚未扫描到课程</div>";
      return;
    }
    if (name === "studyContent") {
      container.innerHTML = state.chapterItems.length ? state.chapterItems.slice(0, 20).map(function (item, index) {
        return [
          "<div class='yt-item'>",
          "  <div style='min-width:0'>",
          "    <div class='yt-title' title='" + escapeHtml(item.title) + "'>" + (item.complete ? "✓ " : "") + escapeHtml(item.title) + "</div>",
          "    <div class='yt-meta'>" + escapeHtml(item.statusLabel) + "</div>",
          "  </div>",
          (!isChapterSkipped(item) && (item.action || item.url)) ? "  <button type='button' data-chapter-index='" + index + "'>进入</button>" : "",
          "</div>"
        ].join("");
      }).join("") : "<div class='yt-empty'>尚未扫描到视频章节</div>";
      return;
    }
    if (name === "myTraining") {
      container.innerHTML = state.courseItems.length ? state.courseItems.slice(0, 20).map(function (item) {
        var skipped = isCourseSkipped(item.title);
        return [
          "<div class='yt-item'>",
          "  <div style='min-width:0'>",
          "    <div class='yt-title' title='" + escapeHtml(item.title) + "'>" + (item.complete ? "✓ " : (skipped ? "↷ " : "")) + escapeHtml(item.title) + "</div>",
          "    <div class='yt-meta'>" + (skipped ? "本轮已跳过 · " : "") + "进度 " + escapeHtml(item.progressText || "") + "</div>",
          "  </div>",
          "</div>"
        ].join("");
      }).join("") : "<div class='yt-empty'>尚未扫描到已选课程</div>";
      return;
    }
    container.innerHTML = "";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
      }[char];
    });
  }

  function manualScanCurrentPage() {
    if (!ensureLoggedIn()) return;
    var name = routeName();
    if (name === "selectCourse") {
      setStatus(STATUS.scanning, "正在扫描课程");
      collectCourseQueueFromSelectPage(readConfig(), true).then(function () {
        goToQueuedCourse("手动扫描完成");
      }).catch(function (error) {
        handleRecoverableError(error, "无法扫描课程队列");
      });
      return;
    }
    if (name === "courseAbout") {
      var goLearn = findGoLearnButton();
      if (goLearn) clickElement(goLearn, "进入学习");
      else block("当前课程介绍页未找到去学习按钮");
      return;
    }
    if (name === "myTraining") {
      handleMyTrainingPage(readConfig());
      return;
    }
    if (name === "studyContent") {
      handleStudyContentPage(readConfig());
      return;
    }
    if (name === "video") {
      setStatus(STATUS.playing, "正在接管视频播放");
      handleVideoPage();
      return;
    }
    if (name === "lesson") {
      setStatus(STATUS.playing, "正在接管直播回放播放");
      handleLessonPage();
      return;
    }
    setStatus(STATUS.idle, "当前页面不在自动流程范围内");
  }

  function runRouter() {
    initPanel();
    if (!ensureLoggedIn()) return;
    if (shouldWaitForNavigation()) return;

    var config = readConfig();
    if (config.paused) {
      setStatus(STATUS.paused, "自动模式已暂停");
      return;
    }
    if (!config.autoStart) {
      setStatus(STATUS.idle, "自动模式未开启");
      return;
    }

    var name = routeName();
    var key = currentRouteKey();
    if (state.running && state.routeRunKey === key) return;
    if (state.completedRouteKey === key && !isPlayerRoute(name)) return;
    if (state.routeRunKey !== key) {
      clearManagedAsync();
      state.routeRunKey = key;
    }
    state.running = true;

    var task = null;
    if (name === "courseAbout" || name === "studyContent" || name === "video") {
      syncQueueIndexToCurrentPage();
    }
    if (name === "selectCourse") {
      task = handleSelectCoursePage(config);
    } else if (name === "myTraining") {
      task = handleMyTrainingPage(config);
    } else if (name === "courseAbout") {
      task = handleCourseAboutPage(config);
    } else if (name === "studyContent") {
      task = handleStudyContentPage(config);
    } else if (name === "video") {
      task = handleVideoPage(config);
    } else if (name === "lesson") {
      task = handleLessonPage(config);
    } else {
      setStatus(STATUS.idle, "等待进入课程相关页面");
      state.running = false;
      state.completedRouteKey = key;
      return;
    }

    Promise.resolve(task).then(function () {
      if (state.routeRunKey !== key) return;
      if (!isPlayerRoute(name)) state.completedRouteKey = key;
    }).catch(function (error) {
      if (state.routeRunKey === key) {
        state.completedRouteKey = "";
        handleRecoverableError(error, "路由执行失败");
      }
    }).finally(function () {
      if (state.routeRunKey === key) state.running = false;
    });
  }

  function handleSelectCoursePage(config) {
    var queue = readQueue();
    state.queueItems = queue.items;
    if (queue.phase === "learning") {
      var trainingUrl = queue.myTrainingUrl || buildMyTrainingUrl();
      if (trainingUrl) {
        navigateTo(trainingUrl, "学习阶段返回培训进度页");
        return Promise.resolve();
      }
    }
    if (queue.items.length && queue.index < queue.items.length) {
      goToQueuedCourse("继续课程队列");
      return Promise.resolve();
    }
    if (queue.items.length && queue.index >= queue.items.length) {
      if (queue.phase === "selecting") finishSelectionPhase("全部课程已选课");
      else setStatus(STATUS.complete, "课程队列已完成，请重置队列后重新开始");
      return Promise.resolve();
    }

    setStatus(STATUS.scanning, "首次扫描全部课程分页");
    return collectCourseQueueFromSelectPage(config, false).then(function (items) {
      if (isPaused()) return;
      if (!items.length) {
        block(config.targetCourseName ? "未找到指定课程：" + config.targetCourseName : "课程列表无可用课程");
        return;
      }
      goToQueuedCourse("课程队列已建立");
    });
  }

  async function collectCourseQueueFromSelectPage(config, forceReset) {
    await retryWait(function () {
      return scanCourses().length ? true : null;
    }, "课程列表", config.maxRetries);

    if (forceReset) {
      writeQueue([], 0, "");
      clearSkipState();
    }
    await goToFirstSelectCoursePage();

    var all = [];
    var seen = new Set();
    var maxPages = 30;
    for (var page = 0; page < maxPages; page += 1) {
      if (isPaused()) throw new Error("自动流程已暂停");
      await retryWait(function () {
        return scanCourses().length ? true : null;
      }, "课程列表", config.maxRetries);

      var courses = scanCourses().filter(function (item) {
        return courseMatchesTarget(item, config);
      });
      courses.forEach(function (item) {
        var key = item.sign || item.selectUrl || item.title;
        if (!key || seen.has(key)) return;
        seen.add(key);
        all.push(stripCourseQueueItem(item));
      });
      state.courseItems = all;
      requestRenderPanel();
      log("已扫描课程 " + all.length + " 门");

      var next = findSelectCourseNextPageButton();
      if (!next) break;
      var before = selectCoursePageSignature();
      clickElement(next, "扫描课程下一页");
      await waitFor(function () {
        return selectCoursePageSignature() !== before && scanCourses().length;
      }, { timeout: 12000, label: "下一页课程" }).catch(function () {
        return delay(1200);
      });
    }

    writeQueue(all, 0, location.pathname + location.search, {
      phase: "selecting",
      myTrainingUrl: buildMyTrainingUrl()
    });
    state.courseItems = all;
    requestRenderPanel();
    return all;
  }

  function stripCourseQueueItem(item) {
    return {
      title: item.title,
      name: item.name || item.title,
      sign: item.sign || "",
      classroomId: item.classroomId || "",
      courseId: item.courseId || "",
      trainClassId: item.trainClassId || getTrainClassId(),
      selectUrl: item.selectUrl || "",
      studyUrl: item.studyUrl || ""
    };
  }

  async function goToFirstSelectCoursePage() {
    var active = document.querySelector(".el-pager li.active");
    if (active && textOf(active) === "1") return;
    var first = Array.from(document.querySelectorAll(".el-pager li")).find(function (node) {
      return isVisible(node) && textOf(node) === "1";
    });
    if (!first) return;
    var before = selectCoursePageSignature();
    clickElement(first, "返回课程第一页");
    await waitFor(function () {
      return selectCoursePageSignature() !== before && scanCourses().length;
    }, { timeout: 12000, label: "课程第一页" }).catch(function () {
      return delay(1200);
    });
  }

  function selectCoursePageSignature() {
    var wrap = document.querySelector(".select-course-wrap");
    var vm = wrap && wrap.__vue__;
    var page = vm && vm.$data && vm.$data.search ? vm.$data.search.page : "";
    return String(page) + "|" + scanCourses().map(function (item) { return item.title; }).join("||");
  }

  function findSelectCourseNextPageButton() {
    var buttons = Array.from(document.querySelectorAll(".el-pagination .btn-next, button.btn-next, button"));
    return buttons.find(function (button) {
      var text = textOf(button);
      var cls = String(button.className || "");
      var disabled = button.disabled || button.getAttribute("aria-disabled") === "true" || /disabled|is-disabled/.test(cls);
      return isVisible(button) && !disabled && (/下一页/.test(text) || /btn-next/.test(cls));
    }) || null;
  }

  function scanCourses() {
    var vueItems = scanCoursesFromVue();
    if (vueItems.length) return vueItems;

    var actionText = /选课|去学习|开始学习|继续学习|进入学习|学习/;
    var disabledText = /不可选|已结束|未开始|禁用|disabled/i;
    var buttons = Array.from(document.querySelectorAll("button,a,[role='button']"))
      .filter(isVisible)
      .filter(function (node) {
        var text = textOf(node);
        var disabled = node.disabled || node.getAttribute("aria-disabled") === "true" || disabledText.test(text);
        return !disabled && actionText.test(text);
      });

    var buttonItems = buttons.map(function (button) {
      var card = closestUsefulContainer(button);
      var title = extractCourseTitle(card, button);
      return {
        title: title,
        action: button,
        element: card || button
      };
    }).filter(function (item) {
      return item.title && item.action;
    });

    var courseCards = Array.from(document.querySelectorAll(".course-card"));
    if (!courseCards.length) courseCards = Array.from(document.querySelectorAll(".course-list > li"));
    var cardItems = courseCards
      .filter(isVisible)
      .map(function (card) {
        var text = textOf(card);
        var title = extractCourseTitle(card, null);
        if (!title || !/课程简介|学时|选课人数|已加入|开课时间/.test(text)) return null;
        return {
          title: title,
          action: findCourseAction(card) || card,
          element: card
        };
      })
      .filter(Boolean);

    return uniqueByElement(buttonItems.concat(cardItems));
  }

  function scanCoursesFromVue() {
    var wrap = document.querySelector(".select-course-wrap");
    var vm = wrap && wrap.__vue__;
    var list = vm && vm.$data && Array.isArray(vm.$data.courseList) ? vm.$data.courseList : [];
    var trainClassId = getTrainClassId();
    return list.map(function (course, index) {
      var name = course.name || course.course_name || course.title || "";
      var sign = course.sign || course.course_sign || "";
      var classroomId = Array.isArray(course.classroom_id) ? course.classroom_id[0] : course.classroom_id;
      if (!name || !sign) return null;
      var item = {
        title: name,
        name: name,
        sign: sign,
        classroomId: classroomId || "",
        courseId: course.course_id || "",
        trainClassId: trainClassId,
        selectUrl: buildCourseAboutUrl(sign, trainClassId),
        studyUrl: classroomId ? buildStudyContentUrlFor(sign, classroomId) : "",
        action: findCourseCardByTitle(name) || document.querySelectorAll(".course-card")[index] || wrap,
        element: findCourseCardByTitle(name) || document.querySelectorAll(".course-card")[index] || wrap
      };
      return item;
    }).filter(Boolean);
  }

  function getTrainClassId() {
    var fromUrl = new URLSearchParams(location.search).get("train_class_id");
    if (fromUrl) return fromUrl;
    var myTrainingMatch = location.pathname.match(/\/mytraining\/detail\/(\d+)/);
    if (myTrainingMatch) return myTrainingMatch[1];
    var pathMatch = location.pathname.match(/\/selectcourse\/(\d+)/);
    if (pathMatch) return pathMatch[1];
    var wrap = document.querySelector(".select-course-wrap");
    var vm = wrap && wrap.__vue__;
    var search = vm && vm.$data && vm.$data.search;
    return search && search.train_class_id ? String(search.train_class_id) : "";
  }

  function buildMyTrainingUrl() {
    var id = getTrainClassId();
    return id ? location.origin + "/pro/trainingproject/mytraining/detail/" + encodeURIComponent(id) : "";
  }

  function buildCourseAboutUrl(sign, trainClassId) {
    var url = location.origin + "/pro/portal/about/" + encodeURIComponent(sign);
    if (trainClassId) url += "?train_class_id=" + encodeURIComponent(trainClassId);
    return url;
  }

  function buildStudyContentUrlFor(sign, classroomId) {
    return location.origin + "/pro/lms/" + encodeURIComponent(sign) + "/" + encodeURIComponent(classroomId) + "/studycontent";
  }

  function findCourseCardByTitle(title) {
    return Array.from(document.querySelectorAll(".course-card")).find(function (card) {
      return textOf(card.querySelector(".card-title")) === title || textOf(card).indexOf(title) >= 0;
    }) || null;
  }

  function findCourseAction(card) {
    return Array.from(card.querySelectorAll("button,a,[role='button'],[class*='btn' i]"))
      .filter(isVisible)
      .find(function (node) {
        var text = textOf(node);
        var disabled = node.disabled || node.getAttribute("aria-disabled") === "true" || /disabled|is-disabled/.test(String(node.className));
        return !disabled && /选课|去学习|开始学习|继续学习|进入学习|学习|查看详情/.test(text);
      }) || null;
  }

  function closestUsefulContainer(element) {
    var candidates = [
      "[class*='card']",
      "[class*='course']",
      "[class*='item']",
      "[class*='list'] > *",
      "li",
      "tr",
      "article",
      "section"
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var found = element.closest(candidates[i]);
      if (found && found !== document.body && textOf(found).length < 1200) return found;
    }
    return element.parentElement;
  }

  function extractCourseTitle(card, action) {
    var directTitle = card ? card.querySelector(".card-title, [class*='course-title' i], h1, h2, h3") : null;
    if (directTitle && textOf(directTitle)) return textOf(directTitle).slice(0, 120);
    var nodes = card ? Array.from(card.querySelectorAll("h1,h2,h3,h4,[class*='title'],[class*='name'],span,div")) : [];
    var actionText = action ? textOf(action) : "";
    var candidates = nodes.map(textOf).filter(function (text) {
      return text && text !== actionText && text.length <= 120 && !/选课|去学习|开始学习|继续学习|进入学习/.test(text);
    });
    if (candidates.length) {
      candidates.sort(function (a, b) { return b.length - a.length; });
      return candidates[0];
    }
    var fallback = textOf(card || action).replace(actionText, "").trim();
    return fallback.slice(0, 120);
  }

  function handleCourseAboutPage(config) {
    setStatus(STATUS.scanning, "等待课程操作按钮");
    return retryWait(function () {
      return findCoursePrimaryButton();
    }, "课程操作按钮", config.maxRetries).then(function (button) {
      if (isPaused()) return;
      return handleCoursePrimaryButton(button, config);
    });
  }

  function findGoLearnButton() {
    return findCoursePrimaryButton(/去学习|开始学习|继续学习|进入学习/);
  }

  function findCoursePrimaryButton(pattern) {
    var matcher = pattern || /去学习|开始学习|继续学习|进入学习|选课|报名|加入课程|加入学习/;
    return Array.from(document.querySelectorAll("button,a,[role='button'],[class*='btn' i]"))
      .filter(isVisible)
      .find(function (node) {
        var text = textOf(node);
        var disabled = node.disabled || node.getAttribute("aria-disabled") === "true" || /disabled|is-disabled/.test(String(node.className));
        return !disabled && text.length <= 30 && matcher.test(text);
      }) || null;
  }

  function handleMyTrainingPage(config) {
    var queue = readQueue();
    if (queue.phase === "selecting" && queue.items.length && queue.index < queue.items.length) {
      // 选课尚未完成，不要清空队列，继续推进选课流程。
      goToQueuedCourse("继续选课流程");
      return Promise.resolve();
    }
    writeQueue([], 0, queue.source, {
      phase: "learning",
      myTrainingUrl: location.href
    });
    setStatus(STATUS.scanning, "等待培训进度页刷新");
    return delay(ROUTE_STABLE_WAIT_MS).then(function () {
      if (isPaused()) return null;
      setStatus(STATUS.scanning, "扫描已选课程进度");
      return retryWait(function () {
        var rows = scanMyTrainingRows();
        return rows.length ? rows : null;
      }, "已选课程表格", config.maxRetries);
    }).then(function (rows) {
      if (isPaused()) return;
      if (!rows) return;
      var summary = scanMyTrainingSummary();
      state.courseItems = summary.length ? summary : rows;
      if (summary.length) {
        writeProgress({
          courseTotal: summary.length,
          courseDone: summary.filter(function (c) { return c.complete; }).length
        });
      }
      requestRenderPanel();
      var next = rows.find(function (row) {
        return !row.complete && row.action && !isCourseSkipped(row.title);
      });
      if (!next) {
        state.lastTrainingTarget = "";
        state.trainingRevisits = 0;
        var skippedCount = rows.filter(function (row) {
          return !row.complete && row.action && isCourseSkipped(row.title);
        }).length;
        setStatus(STATUS.complete, skippedCount ? ("已选课程全部完成或本轮跳过不可学习课程 " + skippedCount + " 门") : "已选课程全部完成");
        return;
      }
      if (state.lastTrainingTarget === next.title) {
        state.trainingRevisits += 1;
      } else {
        state.lastTrainingTarget = next.title;
        state.trainingRevisits = 0;
      }
      if (state.trainingRevisits >= MAX_TRAINING_REVISITS) {
        // 进度迟迟未同步：不退出自动模式，刷新培训进度页等待平台回写后再继续。
        state.trainingRevisits = 0;
        refreshCurrentPage("课程“" + next.title + "”进度未同步为已完成");
        return;
      }
      // 进入新课程时清空“本课视频”进度，等学习内容页扫描后再填充。
      writeProgress({ currentCourse: next.title, currentVideo: "", videoTotal: 0, videoDone: 0 });
      clickElement(next.action, "进入未完成课程 " + next.title + "（" + next.progressText + "）");
    });
  }

  // 扫描培训进度页所有课程行（不要求有“去学习”按钮），用于统计课程总数/完成数。
  function scanMyTrainingSummary() {
    return Array.from(document.querySelectorAll("tr"))
      .filter(isVisible)
      .map(function (row) {
        var cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 2) return null;
        var title = cells[1] ? textOf(cells[1]) : "";
        var progressText = cells[5] ? textOf(cells[5]) : "";
        if (!progressText) {
          var m = textOf(row).match(/(\d+(?:\.\d+)?)\s*%|已完成/);
          progressText = m ? m[0] : "";
        }
        if (!title || !progressText) return null;
        return { title: title, progressText: progressText, complete: isProgressDone(progressText) };
      })
      .filter(Boolean);
  }

  function scanMyTrainingRows() {
    return Array.from(document.querySelectorAll("tr"))
      .filter(isVisible)
      .map(function (row) {
        var button = Array.from(row.querySelectorAll("button,a,[role='button']")).find(function (node) {
          return isVisible(node) && /去学习|继续学习|开始学习|进入学习/.test(textOf(node));
        });
        if (!button) return null;
        var cells = Array.from(row.querySelectorAll("td"));
        var title = cells[1] ? textOf(cells[1]) : "";
        var progressText = cells[5] ? textOf(cells[5]) : "";
        if (!title) {
          var rowText = textOf(row);
          title = rowText.replace(/^\d+\s*/, "").replace(/选修.*$/, "").trim();
        }
        if (!progressText) {
          var match = textOf(row).match(/(\d+(?:\.\d+)?)\s*%|已完成/);
          progressText = match ? match[0] : "";
        }
        return {
          title: title,
          progressText: progressText,
          complete: isProgressDone(progressText),
          action: button,
          element: row
        };
      })
      .filter(function (item) {
        return item && item.title;
      });
  }

  function isProgressDone(text) {
    if (!text) return false;
    if (/已完成/.test(text)) return true;
    var percent = String(text).match(/(\d+(?:\.\d+)?)\s*%/);
    return percent ? Number(percent[1]) >= 100 : false;
  }

  async function handleCoursePrimaryButton(button, config) {
    var text = textOf(button);
    var queue = readQueue();
    if (/选课|报名|加入课程|加入学习/.test(text)) {
      clickElement(button, "自动选课");
      if (queue.phase === "selecting") {
        var selectedButton = await retryWait(function () {
          return findGoLearnButton() || null;
        }, "选课完成状态", config.maxRetries).catch(function () {
          return null;
        });
        if (!selectedButton) {
          // 不退出自动模式：刷新课程详情页确认选课结果后继续。
          refreshCurrentPage("选课结果未确认");
          return;
        }
        advanceQueue("选课完成，继续下一门");
        return;
      }
      await delay(1500);
      var learnButton = await retryWait(function () {
        return findGoLearnButton() || null;
      }, "去学习按钮", config.maxRetries).catch(function () {
        return findCoursePrimaryButton();
      });
      if (!learnButton) {
        refreshCurrentPage("选课后未找到去学习按钮");
        return;
      }
      clickElement(learnButton, "选课后进入学习");
      return;
    }

    if (/去学习|开始学习|继续学习|进入学习/.test(text)) {
      if (queue.phase === "selecting") {
        advanceQueue("该课程已选，继续下一门");
        return;
      }
      clickElement(button, "自动进入学习");
      return;
    }

    var queueItem = currentQueueItem();
    if (queueItem && queueItem.studyUrl) {
      log("未识别按钮文案，使用队列学习页链接");
      navigateTo(queueItem.studyUrl, "进入学习页");
      return;
    }
    refreshCurrentPage("课程详情页未找到可执行操作");
  }

  function chooseCourse(courses, config) {
    if (!courses.length) return null;
    if (config.targetCourseName) {
      return courses.find(function (item) { return item.title === config.targetCourseName; }) || null;
    }
    return courses[0];
  }

  function handleStudyContentPage(config) {
    setStatus(STATUS.scanning, "等待章节列表");
    // 记录学习内容页地址，供直播回放页播完后返回（lesson 页无法推算 studycontent 地址）。
    GM_setValue("yt_auto.studyUrl", location.href);
    return delay(ROUTE_STABLE_WAIT_MS).then(function () {
      if (isPaused()) return null;
      return retryWait(function () {
        var chapters = scanChapters();
        if (chapters.length) {
          // Vue 的 chapter_list 通常先到，直播课可点击的 .leaf-detail 会晚几秒出现。
          // 此时继续等待，避免把“未完成但入口未渲染好”的 leaf 误判为没有可学内容。
          return hasPendingChapterAction(chapters) ? null : chapters;
        }
        if (isStudyContentUnavailable()) return [];
        return null;
      }, "章节列表", config.maxRetries, 20000);
    }).then(function (chapters) {
      if (isPaused()) return;
      if (!chapters) return;
      state.chapterItems = chapters;
      writeProgress({
        videoTotal: chapters.length,
        videoDone: chapters.filter(function (c) { return c.complete; }).length,
        currentCourse: readProgress().currentCourse || getCurrentCourseTitle() || ""
      });
      requestRenderPanel();
      var next = findNextPlayableChapter(chapters);
      if (next) {
        enterChapter(next, "自动进入未完成视频 " + next.title);
        return;
      }
      if (!chapters.length && isStudyContentUnavailable()) {
        skipCurrentCourse("当前课程未发布学习内容");
        return;
      }
      if (chapters.some(isChapterSkipped)) {
        skipCurrentCourse("当前课程剩余章节无可播放回放");
        return;
      }
      completeCurrentCourse("当前课程没有未完成视频章节");
    });
  }

  function hasPendingChapterAction(chapters) {
    return chapters.some(function (item) {
      return item.type === "video" && !item.complete && !item.locked && !isChapterSkipped(item) && item.pendingAction;
    });
  }

  function isStudyContentUnavailable() {
    var text = textOf(document.body);
    return /老师没有发布学习内容|未发布学习内容|暂无学习内容|暂无内容|未发布任何学习内容/.test(text);
  }

  function scanChapters() {
    var vueChapters = scanChaptersFromVue();
    if (vueChapters.length) return vueChapters;

    // 收窄到章节叶子本身，避免像 [class*='lesson'] 把整页容器（.lesson_student__container）选进来。
    var selectors = [
      ".study-content__container .chapter-list .leaf-detail",
      ".chapter-list .leaf-detail",
      ".leaf-detail",
      ".leaf-title",
      "a[href*='/video/']",
      "[data-type*='video' i]",
      "[role='treeitem']"
    ];
    var nodes = Array.from(document.querySelectorAll(selectors.join(","))).filter(isVisible);
    var items = nodes.map(function (node) {
      var row = closestChapterContainer(node);
      var hrefNode = row.querySelector("a[href*='/video/']") || (node.matches && node.matches("a[href*='/video/']") ? node : null);
      var action = hrefNode || findChapterAction(row) || node;
      var text = textOf(row);
      var title = extractChapterTitle(row, text);
      var type = detectChapterType(row, action, text);
      var complete = isChapterComplete(row, text);
      var locked = /未开放|不可学习|锁定|敬请期待/.test(text);
      var key = fallbackChapterKey(title);
      var skipped = Boolean(chapterSkipRecord(key));
      return {
        key: key,
        title: title,
        action: action,
        element: row,
        type: type,
        typeLabel: type === "video" ? "视频" : "非视频",
        complete: complete,
        statusLabel: skipped ? "本轮已跳过" : (complete ? "已完成" : (locked ? "不可学习" : "未完成")),
        locked: locked
      };
    }).filter(function (item) {
      return item.title && item.action && item.element && item.type === "video";
    });

    return uniqueByElement(items);
  }

  function scanChaptersFromVue() {
    var container = document.querySelector(".study-content__container");
    var vm = container && container.__vue__;
    var data = vm && vm.$data ? vm.$data : null;
    var chapters = data && Array.isArray(data.chapter_list) ? data.chapter_list : [];
    if (!data || !chapters.length) return [];

    var sign = data.sign || currentCourseSign();
    var classroomId = data.classroom_id || (location.pathname.match(/\/pro\/lms\/[^/]+\/([^/]+)\//) || [])[1] || "";
    var schedules = data.leaf_schedules || {};
    var items = [];

    chapters.forEach(function (chapter) {
      var leaves = Array.isArray(chapter.section_leaf_list) ? chapter.section_leaf_list : [];
      leaves.forEach(function (leaf) {
        if (!leaf || leaf.is_show === false || leaf.is_locked) return;
        var type = Number(leaf.leaf_type);
        var isVideo = type === 0;   // 普通视频
        var isLive = type === 8;    // 直播/线下课堂的回放
        if (!isVideo && !isLive) return;
        var progress = Number(schedules[leaf.id] || 0);
        var complete = progress >= 1;
        var title = leaf.name || chapter.name || ((isLive ? "直播回放 " : "视频 ") + leaf.id);
        // 普通视频用 /video/{id} 直接导航；直播回放没有该地址，必须点击章节里的 .leaf-detail
        // 让平台自己跳到 /pro/yktmanage/s/.../lesson/...。
        var url = isVideo
          ? (location.origin + "/pro/lms/" + encodeURIComponent(sign) + "/" + encodeURIComponent(classroomId) + "/video/" + encodeURIComponent(leaf.id))
          : "";
        var leafEl = findLeafDetailByTitle(title);
        var key = buildChapterKey(sign, classroomId, leaf.id);
        var skipped = Boolean(chapterSkipRecord(key));
        items.push({
          key: key,
          leafId: String(leaf.id),
          title: title,
          url: url,
          action: isVideo ? null : leafEl,
          element: leafEl || container,
          type: "video",
          live: isLive,
          typeLabel: isLive ? "直播回放" : "视频",
          complete: complete,
          progress: progress,
          statusLabel: skipped ? "本轮已跳过" : (complete ? "已完成" : Math.floor(progress * 100) + "%"),
          pendingAction: isLive && !leafEl,
          locked: false
        });
      });
    });

    return uniqueByElement(items);
  }

  function buildChapterKey(sign, classroomId, leafId) {
    return [sign || currentCourseSign() || "unknown", classroomId || "unknown", String(leafId || "")].join("|");
  }

  function fallbackChapterKey(title) {
    return [location.pathname, String(title || "")].join("|");
  }

  // 直播回放需要点击章节里的 .leaf-detail 才能跳转，这里按标题精确定位该元素。
  function findLeafDetailByTitle(title) {
    if (!title) return null;
    var leaves = Array.from(document.querySelectorAll(".chapter-list .leaf-detail, .leaf-detail")).filter(isVisible);
    return leaves.find(function (node) {
      return textOf(node).indexOf(title) >= 0;
    }) || null;
  }

  function findChapterElementByTitle(title) {
    return Array.from(document.querySelectorAll(".chapter-list, .leaf-detail, .leaf-title, .common-chapter")).find(function (node) {
      return textOf(node).indexOf(title) >= 0;
    }) || null;
  }

  function closestChapterContainer(element) {
    var selectors = [
      ".leaf-detail",
      ".content",
      ".leaf-title",
      ".chapter-list",
      "li",
      "[role='treeitem']",
      "[role='listitem']",
      "[class*='chapter' i]",
      "[class*='lesson' i]",
      "[class*='catalog' i]",
      "[class*='section' i]",
      "tr"
    ];
    for (var i = 0; i < selectors.length; i += 1) {
      var found = element.closest(selectors[i]);
      if (found && found !== document.body && textOf(found).length < 1600) return found;
    }
    return element;
  }

  function findChapterAction(row) {
    // 优先点击 .leaf-detail 本身——普通视频和直播回放点它都能正确跳转；.content 往往点不动。
    if (row.matches && row.matches(".leaf-detail") && isVisible(row)) return row;
    var leafDetail = Array.from(row.querySelectorAll(".leaf-detail")).filter(isVisible)[0];
    if (leafDetail) return leafDetail;
    var yuketangLeaf = Array.from(row.querySelectorAll(".content, .leaf-title"))
      .filter(isVisible)[0];
    if (yuketangLeaf) return yuketangLeaf;
    var preferred = Array.from(row.querySelectorAll("a,button,[role='button']")).filter(isVisible).find(function (node) {
      return /学习|播放|进入|继续|开始|查看|视频|下一节/.test(textOf(node)) || (node.href && /\/video\//.test(node.href));
    });
    if (preferred) return preferred;
    return row.matches && row.matches("a,button,[role='button']") ? row : row.querySelector("a,button,[role='button']");
  }

  function extractChapterTitle(row, text) {
    var leafTitle = row.querySelector(".leaf-title");
    if (leafTitle && textOf(leafTitle)) return textOf(leafTitle).slice(0, 140);
    var titleNode = Array.from(row.querySelectorAll("[class*='title' i],[class*='name' i],h1,h2,h3,h4,span,div,a")).map(function (node) {
      return textOf(node);
    }).filter(function (candidate) {
      return candidate && candidate.length <= 140 && !/已完成|未完成|学习|播放|进入|继续|开始|视频|文档|讨论|作业/.test(candidate);
    }).sort(function (a, b) {
      return b.length - a.length;
    })[0];
    if (titleNode) return titleNode;
    return text.replace(/已完成|未完成|学习|播放|进入|继续|开始|视频|文档|讨论|作业|100%|\d+%/g, "").trim().slice(0, 140);
  }

  function detectChapterType(row, action, text) {
    var href = action && action.href ? action.href : "";
    var icon = row.querySelector(".leaf-detail i, .content i, i[class*='icon--'], i[class*='icon-']");
    var iconClass = icon ? String(icon.className || "") : "";
    var marker = [
      row.getAttribute("data-type"),
      row.getAttribute("data-resource-type"),
      row.className,
      iconClass,
      href,
      text
    ].join(" ");
    if (/shipin|video/i.test(iconClass)) return "video";
    if (/tuwen|taolun|zuoye|kaoshi|kejian|ketang|yinpin|audio|wendang|doc/i.test(iconClass)) return "other";
    if (/文档|资料|讨论|作业|考试|测验|quiz|homework|discussion|doc/i.test(marker)) return "other";
    if (row.matches(".chapter-list, .leaf-detail") || row.querySelector(".leaf-title")) return "video";
    if (/video|视频|\/video\//i.test(marker)) return "video";
    return "other";
  }

  function isChapterComplete(row, text) {
    var aria = row.getAttribute("aria-label") || "";
    var marker = [text, aria, row.className].join(" ");
    if (/未完成|未学习|待学习|继续学习|未开始/.test(marker)) return false;
    var percent = marker.match(/(\d+(?:\.\d+)?)\s*%/);
    if (percent) return Number(percent[1]) >= 100;
    return /已完成|completed|finish/i.test(marker);
  }

  function findNextPlayableChapter(chapters) {
    return chapters.find(function (item) {
      return item.type === "video" && !item.complete && !item.locked && !isChapterSkipped(item) && !item.pendingAction && (item.action || item.url);
    }) || null;
  }

  function handleVideoPage(config) {
    config = config || readConfig();
    var existing = findVideoElement();
    if (existing && existing.__ytAutoAttached) return Promise.resolve();
    state.handledEnd = false;
    state.videoRetryCount = 0;
    state.reacquiring = false;
    setStatus(STATUS.playing, "等待播放器");
    // 参考 OCS v2_watch：先等播放器就绪，通过 Vue API 配置倍速/音量并重新初始化，再取 video 元素接管。
    return retryWait(function () {
      var context = findYuketangPlayerContext();
      if (context.player && context.player.options) return context;
      return findVideoElement() ? context : null;
    }, "播放器", config.maxRetries, 20000).then(function () {
      if (isPaused()) return null;
      setupYuketangPlayer(config.playbackRate);
      return retryWait(function () {
        return findVideoElement();
      }, "视频元素", config.maxRetries, 15000);
    }).then(function (video) {
      if (!video || isPaused()) return;
      attachVideoAutomation(video, config);
    });
  }

  // 直播/线下课堂回放页（/pro/yktmanage/s/.../lesson/...）：播放器在多层同源 iframe 里，
  // 没有顶层 .xtplayer / 常规 heartbeat。这里只接管那个 <video>，播完后回到学习内容页重新调度。
  function handleLessonPage(config) {
    config = config || readConfig();
    var existing = findVideoElement();
    if (existing && existing.__ytAutoAttached) return Promise.resolve();
    state.handledEnd = false;
    state.videoRetryCount = 0;
    state.reacquiring = false;
    setStatus(STATUS.playing, "等待直播回放播放器");
    return retryWait(function () {
      var media = findVideoElement();
      if (media) return { media: media };
      var unavailableReason = getLessonUnavailableReason();
      if (unavailableReason) return { unavailableReason: unavailableReason };
      triggerLessonPlaybackEntry();
      return null;
    }, "直播回放播放器", config.maxRetries, 25000).then(function (video) {
      if (!video || isPaused()) return;
      if (video.unavailableReason) {
        skipCurrentChapter(video.unavailableReason);
        return;
      }
      var media = video.media;
      if (!media) return;
      return setupLiveReplayPlayer(media, config.playbackRate).then(function () {
        attachVideoAutomation(media, config);
      });
    });
  }

  function setupLiveReplayPlayer(media, targetRate) {
    var effectiveRate = 0;
    return selectLiveReplayRate(targetRate, media).then(function (rate) {
      effectiveRate = rate;
      if (!media) return;
      if (!effectiveRate) {
        try { media.playbackRate = normalizeRate(targetRate); } catch (error) { /* ignore */ }
        log("直播回放未找到原生倍速组件，已回退到底层媒体倍速");
        return;
      }
      var actual = Number(media.playbackRate) || 0;
      if (Math.abs(actual - effectiveRate) > 0.01) {
        try { media.playbackRate = effectiveRate; } catch (error) { /* ignore */ }
        log("直播回放原生倍速点击后未生效，已用底层媒体倍速兜底");
      }
    });
  }

  function selectLiveReplayRate(targetRate, media) {
    var target = normalizeRate(targetRate);
    var control = findLiveReplayRateControl(media);
    if (!control) return Promise.resolve(0);
    dispatchMouseSequence(control, ["mouseover", "mouseenter", "mousemove", "click"]);
    return delay(250).then(function () {
      var options = collectLiveReplayRateOptions(control.ownerDocument);
      if (!options.length) return 0;
      var selected = chooseClosestRate(options.map(function (item) { return item.rate; }), target);
      var option = options.find(function (item) {
        return Math.abs(item.rate - selected) <= 0.001;
      });
      if (!option) return 0;
      dispatchMouseSequence(option.node, ["mouseover", "mouseenter", "mousemove", "mousedown", "mouseup", "click"]);
      log("通过直播回放原生倍速组件设置为 " + selected + "x");
      return delay(350).then(function () {
        return selected;
      });
    });
  }

  function findLiveReplayRateControl(media) {
    var docs = [];
    if (media && media.ownerDocument) docs.push(media.ownerDocument);
    collectFrameDocuments(document, [], 0).forEach(function (doc) {
      if (docs.indexOf(doc) < 0) docs.push(doc);
    });
    for (var i = 0; i < docs.length; i += 1) {
      var controls = Array.from(docs[i].querySelectorAll(".video-rate"));
      var visible = controls.find(isVisibleInOwnDocument);
      if (visible) return visible;
      if (controls[0]) return controls[0];
    }
    return null;
  }

  function collectLiveReplayRateOptions(doc) {
    var docs = [];
    if (doc) docs.push(doc);
    collectFrameDocuments(document, [], 0).forEach(function (item) {
      if (docs.indexOf(item) < 0) docs.push(item);
    });
    var options = [];
    docs.forEach(function (item) {
      Array.from(item.querySelectorAll(".video-rate .option-item, .rate-options-pc .option-item, .option-item")).forEach(function (node) {
        var match = textOf(node).match(/(\d+(?:\.\d+)?)\s*X/i);
        if (!match) return;
        var rate = Number(match[1]);
        if (!Number.isFinite(rate) || rate <= 0) return;
        options.push({ rate: rate, node: node });
      });
    });
    return options;
  }

  function chooseClosestRate(rates, target) {
    rates = rates.filter(function (rate) {
      return Number.isFinite(rate) && rate > 0;
    }).sort(function (a, b) {
      return a - b;
    });
    if (!rates.length) return target;
    for (var i = 0; i < rates.length; i += 1) {
      if (Math.abs(rates[i] - target) <= 0.001) return rates[i];
    }
    if (target <= rates[0]) return rates[0];
    if (target >= rates[rates.length - 1]) return rates[rates.length - 1];
    return rates.filter(function (rate) {
      return rate <= target;
    }).pop() || rates[rates.length - 1];
  }

  function dispatchMouseSequence(node, names) {
    if (!node) return;
    var view = node.ownerDocument && node.ownerDocument.defaultView ? node.ownerDocument.defaultView : window;
    names.forEach(function (name) {
      try {
        node.dispatchEvent(new MouseEvent(name, {
          bubbles: true,
          cancelable: true,
          view: view
        }));
      } catch (error) { /* ignore */ }
    });
  }

  function getLessonUnavailableReason() {
    var docs = collectFrameDocuments(document, [], 0);
    var text = docs.map(function (doc) {
      return doc.body ? textOf(doc.body) : "";
    }).join(" ");
    if (/本节课无课堂回放|暂无课堂回放|没有课堂回放|暂无回放|回放暂未生成|回放生成中/.test(text)) {
      return "当前直播章节无课堂回放";
    }
    return "";
  }

  function triggerLessonPlaybackEntry() {
    var docs = collectFrameDocuments(document, [], 0);
    var selectors = [".video-play", ".play-btn", ".fix-play-txt", ".player-from-btn", ".playback-overlay"];
    for (var d = 0; d < docs.length; d += 1) {
      for (var s = 0; s < selectors.length; s += 1) {
        var nodes = Array.from(docs[d].querySelectorAll(selectors[s]));
        for (var i = 0; i < nodes.length; i += 1) {
          var node = nodes[i];
          if (node.__ytLessonPlaybackClicked || !isVisibleInOwnDocument(node)) continue;
          var marker = [textOf(node), String(node.className || ""), selectors[s]].join(" ");
          if (!/立即播放|从这一页播放|播放|video-play|play-btn|fix-play-txt|playback-overlay/.test(marker)) continue;
          node.__ytLessonPlaybackClicked = true;
          try { node.scrollIntoView({ block: "center", inline: "center" }); } catch (error) { /* ignore */ }
          try {
            node.click();
            log("触发直播回放播放入口：" + (textOf(node) || selectors[s]));
            return true;
          } catch (error) {
            log("触发直播回放播放入口失败：" + error.message);
          }
        }
      }
    }
    return false;
  }

  // 根据当前路由选择完成后的跳转方式：直播回放走 lesson 专用流程，普通视频走原流程。
  function goNextAfter(video) {
    if (routeName() === "lesson") goNextAfterLesson(video);
    else goNextAfterVideo(video);
  }

  function goNextAfterLesson(video) {
    setStatus(STATUS.scanning, "直播回放结束，返回学习内容页重新调度");
    delay(POST_VIDEO_RESCAN_WAIT_MS).then(function () {
      if (isPaused()) return;
      var studyUrl = GM_getValue("yt_auto.studyUrl", "") || "";
      if (studyUrl) {
        navigateTo(studyUrl, "返回学习内容页");
        return;
      }
      // 没有记录到学习内容页地址时，回退用浏览器后退。
      try { history.back(); } catch (error) { refreshCurrentPage("无法返回学习内容页"); }
    });
  }

  // 判断 video 是否仍挂在它自己的文档树上（兼容 iframe 内的 video——顶层 document.contains 对它无效）。
  function isVideoConnected(video) {
    if (!video) return false;
    if (typeof video.isConnected === "boolean") return video.isConnected;
    var doc = video.ownerDocument;
    return Boolean(doc && doc.contains(video));
  }

  function isVisibleInOwnDocument(element) {
    if (!element || !element.ownerDocument || !element.ownerDocument.defaultView) return false;
    try {
      var style = element.ownerDocument.defaultView.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      var rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (error) {
      return false;
    }
  }

  function collectFrameDocuments(doc, acc, depth) {
    if (!doc || depth > 5) return acc;
    acc.push(doc);
    try {
      var frames = doc.querySelectorAll("iframe,frame");
      for (var i = 0; i < frames.length; i += 1) {
        var childDoc = null;
        try { childDoc = frames[i].contentDocument; } catch (error) { childDoc = null; }
        if (childDoc) collectFrameDocuments(childDoc, acc, depth + 1);
      }
    } catch (error) { /* ignore */ }
    return acc;
  }

  // 收集本文档及所有同源 iframe（直播回放播放器嵌套在多层 iframe 中）里的媒体元素。
  function collectMediaElements(doc, acc, depth) {
    if (!doc || depth > 5) return acc;
    try {
      Array.prototype.push.apply(acc, Array.from(doc.querySelectorAll("video,audio")).filter(isPlayableMediaElement));
      var frames = doc.querySelectorAll("iframe,frame");
      for (var i = 0; i < frames.length; i += 1) {
        var childDoc = null;
        try { childDoc = frames[i].contentDocument; } catch (error) { childDoc = null; } // 跨域 -> null
        if (childDoc) collectMediaElements(childDoc, acc, depth + 1);
      }
    } catch (error) { /* ignore */ }
    return acc;
  }

  function isPlayableMediaElement(media) {
    if (!media) return false;
    var tag = String(media.tagName || "").toLowerCase();
    if (tag === "video") return true;
    if (tag !== "audio") return false;
    var src = "";
    try { src = media.currentSrc || media.src || ""; } catch (error) { src = ""; }
    var duration = Number(media.duration) || 0;
    var ownerUrl = "";
    try { ownerUrl = media.ownerDocument && media.ownerDocument.location ? media.ownerDocument.location.href : ""; } catch (error) { ownerUrl = ""; }
    // 直播回放里音频课件是 <audio data-is-player data-liveid ...>；AI 助手等背景音频没有这些标记且没有有效 src。
    return media.hasAttribute("data-is-player") || media.hasAttribute("data-liveid") || Boolean(src) || duration > 0 || (media.readyState || 0) > 0 || /\/m\/v2\/lesson\/student\//.test(ownerUrl);
  }

  function mediaScore(media) {
    var tag = String(media.tagName || "").toLowerCase();
    var rect = media.getBoundingClientRect ? media.getBoundingClientRect() : { width: 0, height: 0 };
    var visible = isVisibleInOwnDocument(media);
    var duration = Number(media.duration) || 0;
    var src = "";
    try { src = media.currentSrc || media.src || ""; } catch (error) { src = ""; }
    var score = rect.width * rect.height;
    if (tag === "video") score += 100000000;
    if (tag === "audio") score += 50000000;
    if (visible) score += 1000000;
    if (duration > 0) score += 100000;
    if (src) score += 10000;
    if (media.hasAttribute && media.hasAttribute("data-is-player")) score += 1000;
    return score;
  }

  function pickBestMedia(list) {
    var mediaList = list.filter(function (media) {
      return isPlayableMediaElement(media) && (isVisibleInOwnDocument(media) || media.readyState > 0 || Number(media.duration) > 0 || media.currentSrc || media.src);
    });
    if (!mediaList.length) return null;
    mediaList.sort(function (a, b) {
      return mediaScore(b) - mediaScore(a);
    });
    return mediaList[0];
  }

  function findVideoElement() {
    // 普通视频页 <video> 就在顶层文档：优先用它，行为与改动前完全一致。
    var top = pickBestMedia(Array.from(document.querySelectorAll("video")));
    if (top) return top;
    var nestedVideos = collectMediaElements(document, [], 0).filter(function (media) {
      return String(media.tagName || "").toLowerCase() === "video";
    });
    var nestedVideo = pickBestMedia(nestedVideos);
    if (nestedVideo) return nestedVideo;
    // 顶层没有视频时（直播回放音频课）再使用同源 iframe 里的有效 <audio>。
    return pickBestMedia(collectMediaElements(document, [], 0).filter(function (media) {
      return String(media.tagName || "").toLowerCase() === "audio";
    }));
  }

  function attachVideoAutomation(video, config) {
    if (video.__ytAutoAttached) return;
    video.__ytAutoAttached = true;
    setStatus(STATUS.playing, "已接管播放器，目标倍速 " + config.playbackRate + "x");

    // OCS v2_watch 用 currentTime=1 触发加载；仅在视频还停在最前面时轻推，避免回退已观看进度。
    try { if (Number(video.currentTime || 0) < 1) video.currentTime = 1; } catch (error) { /* ignore */ }

    var onEnded = function () {
      if (state.handledEnd || isPaused()) return;
      state.handledEnd = true;
      log("检测到 ended 事件");
      goNextAfter(video);
    };
    var onPause = function () {
      // 参考 OCS：未结束就稍后续播，逻辑保持简单，不再维护冷却/重试计数等复杂状态。
      if (state.handledEnd || isPaused() || video.ended) return;
      schedule(function () {
        if (state.handledEnd || isPaused() || video.ended || !video.paused) return;
        playYuketangMedia(video);
      }, 1000);
    };
    var onPlaying = function () {
      clearRefreshCount();
    };
    var onError = function () {
      if (isPaused() || state.handledEnd) return;
      var maxRetries = readConfig().maxRetries;
      state.videoRetryCount += 1;
      var mediaError = video.error ? ("错误码 " + video.error.code) : "未知错误";
      if (state.videoRetryCount <= maxRetries) {
        // 先就地重载，处理瞬时网络抖动。
        setStatus(STATUS.playing, "视频加载失败（" + mediaError + "），3 秒后重试 " + state.videoRetryCount + "/" + maxRetries);
        schedule(function () {
          if (isPaused() || state.handledEnd) return;
          try {
            video.load();
            applyConfiguredPlaybackRate(video, readConfig().playbackRate);
            playYuketangMedia(video);
          } catch (error) {
            console.warn(error);
          }
        }, 3000);
        return;
      }
      // 就地重载无效，多半是播放凭证过期：整页刷新换取新的视频地址，而不是反复加载同一个失效链接。
      refreshCurrentPage("视频反复加载失败（" + mediaError + "）");
    };

    video.addEventListener("ended", onEnded);
    video.addEventListener("pause", onPause);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("error", onError);

    // 初始播放，参考 OCS playMedia：自动播放被浏览器拦截时提示点击一次后继续。
    playYuketangMedia(video);

    var stopWatchdog = startVideoWatchdog(video);

    state.observerDisposers.push(function () {
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("error", onError);
      if (stopWatchdog) stopWatchdog();
      video.__ytAutoAttached = false;
    });
  }

  // 参考 OCS playMedia：封装 video.play()，自动播放被浏览器拦截时提示用户点击一次页面后自动继续。
  function playYuketangMedia(video) {
    if (!video || isPaused() || state.handledEnd || video.ended) return;
    applyYuketangMediaDefaults(video);
    var promise;
    try {
      promise = video.play();
    } catch (error) {
      handlePlayRejection(video, error);
      return;
    }
    if (promise && typeof promise.then === "function") {
      promise.catch(function (error) { handlePlayRejection(video, error); });
    }
  }

  function handlePlayRejection(video, error) {
    var message = String((error && error.message) || error || "");
    if (/interact|NotAllowed|gesture/i.test(message)) {
      setStatus(STATUS.playing, "浏览器拦截了自动播放，请在页面任意处点击一次即可自动继续");
      armUserGesturePlay(video);
      return;
    }
    // 播放器重建/切换清晰度会把旧 <video> 移出文档，旧的事件监听全部失效。
    // 这种情况必须重新获取当前 video 并重新接管，否则整个自动流程会卡死。
    if (/removed from the document|not in the document/i.test(message) || !isVideoConnected(video)) {
      reacquireVideo("播放被打断（媒体已被移除）");
      return;
    }
    // “interrupted by a call to pause()/load()”等属于正常打断，忽略即可。
    if (/interrupted/i.test(message)) return;
    log("播放失败：" + message);
  }

  // 旧的 <video> 被播放器替换后，重新获取页面当前的 video 元素并重新接管。
  function reacquireVideo(reason) {
    if (isPaused() || state.handledEnd || state.reacquiring) return;
    state.reacquiring = true;
    log("重新接管播放器视频元素：" + reason);
    var tryAttach = function (attemptsLeft) {
      if (isPaused() || state.handledEnd) { state.reacquiring = false; return; }
      var video = findVideoElement();
      if (video && isVideoConnected(video) && !video.__ytAutoAttached) {
        state.reacquiring = false;
        attachVideoAutomation(video, readConfig());
        return;
      }
      if (video && video.__ytAutoAttached) { state.reacquiring = false; return; }
      if (attemptsLeft <= 0) {
        state.reacquiring = false;
        refreshCurrentPage("视频元素被移除后未能重新接管");
        return;
      }
      schedule(function () { tryAttach(attemptsLeft - 1); }, 1000);
    };
    schedule(function () { tryAttach(5); }, 600);
  }

  function armUserGesturePlay(video) {
    if (video.__ytGestureArmed) return;
    video.__ytGestureArmed = true;
    var handler = function () {
      document.removeEventListener("click", handler, true);
      document.removeEventListener("keydown", handler, true);
      video.__ytGestureArmed = false;
      // 取页面当前的 video（点击拦截期间播放器可能已重建元素），避免对失效元素调用 play。
      playYuketangMedia(findVideoElement() || video);
    };
    document.addEventListener("click", handler, true);
    document.addEventListener("keydown", handler, true);
  }

  function detectVideoQuizPopup() {
    var nodes = Array.from(document.querySelectorAll(
      ".xt_video_player_problem,[class*='video-problem' i],[class*='problembox' i],[class*='problem-box' i],[class*='subject-problem' i],.exercise-container"
    ));
    return nodes.some(function (node) {
      if (!isVisible(node)) return false;
      var text = textOf(node);
      return text.length > 0 && text.length < 800 && /提交|作答|答题|单选|多选|投票|本视频/.test(text);
    });
  }

  function startVideoWatchdog(video) {
    if (!video) return function () {};
    var lastTime = -1;
    var lastAdvanceAt = Date.now();
    var recoverAttempts = 0;
    var nudgeCount = 0;

    var timer = window.setInterval(function () {
      if (state.handledEnd || isPaused()) return;
      if (!isVideoConnected(video)) {
        // 播放器重建了 video 元素：停止这个 watchdog，并重新接管当前页面的 video。
        window.clearInterval(timer);
        reacquireVideo("watchdog 检测到视频已被移除");
        return;
      }
      if (video.ended) return;
      if (video.paused && detectVideoQuizPopup()) {
        // 弹题需要人工作答；不退出自动模式，作答后会自动继续播放。
        setStatus(STATUS.playing, "检测到视频内弹题，等待手动作答后自动继续");
        return;
      }
      var now = Date.now();
      var current = Number(video.currentTime) || 0;
      var duration = Number(video.duration) || 0;
      // 只有在“正在播放且进度确实推进”时才认为没卡；停在结尾(paused)时不会被 currentTime 抖动误判。
      if (!video.paused && Math.abs(current - lastTime) > 0.25) {
        lastTime = current;
        lastAdvanceAt = now;
        recoverAttempts = 0;
        nudgeCount = 0;
        return;
      }
      if (now - lastAdvanceAt < VIDEO_STALL_TIMEOUT_MS) return;
      // 注意：这里不再重置 lastAdvanceAt，卡住后每个 tick 都会尝试恢复，而不是每 30 秒一次。

      if (duration > 0 && current >= duration - VIDEO_NEAR_END_SECONDS) {
        nudgeCount += 1;
        log("视频停在结尾但未触发完成，尝试推动结束（" + nudgeCount + "）");
        try {
          video.currentTime = duration;
          playYuketangMedia(video);
        } catch (error) {
          console.warn(error);
        }
        if (nudgeCount >= 3 && !state.handledEnd) {
          state.handledEnd = true;
          log("多次推动仍未触发 ended，进入完成同步流程");
          goNextAfter(video);
        }
        return;
      }

      recoverAttempts += 1;
      if (recoverAttempts > MAX_STALL_RECOVERIES) {
        // 多次就地恢复无效，多半是加载/凭证问题：刷新当前页重试，保持自动模式。
        refreshCurrentPage("视频长时间无法继续播放");
        return;
      }
      setStatus(STATUS.playing, "视频卡住，尝试恢复播放（" + recoverAttempts + "/" + MAX_STALL_RECOVERIES + "）");
      try {
        if (recoverAttempts >= 2) {
          video.load();
          applyConfiguredPlaybackRate(video, readConfig().playbackRate);
        }
        playYuketangMedia(video);
      } catch (error) {
        console.warn(error);
      }
    }, VIDEO_WATCHDOG_INTERVAL_MS);

    return function () {
      window.clearInterval(timer);
    };
  }

  function applyYuketangMediaDefaults(video) {
    if (!video) return;
    try {
      if (!video.muted) video.muted = true;
      if (!video.defaultMuted) video.defaultMuted = true;
      if (video.volume !== 0) video.volume = 0;
      if (!video.hasAttribute("muted")) video.setAttribute("muted", "muted");
      if (!video.hasAttribute("playsinline")) video.setAttribute("playsinline", "playsinline");
      if (!video.hasAttribute("webkit-playsinline")) video.setAttribute("webkit-playsinline", "webkit-playsinline");
    } catch (error) {
      log("设置播放器默认参数失败：" + error.message);
    }
  }

  function applyConfiguredPlaybackRate(media, targetRate) {
    if (routeName() === "lesson") {
      setupLiveReplayPlayer(media || findVideoElement(), targetRate);
      return;
    }
    applyYuketangSpeedLight(targetRate);
  }

  // 参考 OCS v2_watch：通过 .xtplayer 的 Vue 播放器 API 设置倍速/音量，再 player.init() 让其生效，
  // 而不是反复改写 video.playbackRate 与播放器抢控制权。
  function setupYuketangPlayer(targetRate) {
    var effectiveRate = resolveYuketangRate(targetRate);
    var context = findYuketangPlayerContext();
    var player = context.player;
    try {
      if (player && player.options) {
        if (player.options.speed) player.options.speed.value = effectiveRate;
        if (player.options.volume) player.options.volume.value = 0;
        if (typeof player.init === "function") player.init();
      }
    } catch (error) {
      log("通过播放器 API 配置失败，回退到直接设置：" + error.message);
    }
    var video = (player && player.video) || context.video || findVideoElement();
    applyYuketangMediaDefaults(video);
    if (video) {
      try { video.playbackRate = effectiveRate; } catch (error) { /* ignore */ }
    }
    syncYuketangSpeedDom(effectiveRate);
    if (Number(effectiveRate) !== Number(normalizeRate(targetRate))) {
      log("目标倍速 " + targetRate + "x 不在播放器可选项，已使用 " + effectiveRate + "x");
    }
  }

  // 卡顿/出错恢复时用：只重设倍速，绝不调用 player.init()，避免重建 <video> 把已接管的元素移出文档。
  function applyYuketangSpeedLight(targetRate) {
    var effectiveRate = resolveYuketangRate(targetRate);
    var context = findYuketangPlayerContext();
    var player = context.player;
    try {
      if (player && player.options && player.options.speed) player.options.speed.value = effectiveRate;
    } catch (error) { /* ignore */ }
    var video = (player && player.video) || context.video || findVideoElement();
    applyYuketangMediaDefaults(video);
    if (video) {
      try { video.playbackRate = effectiveRate; } catch (error) { /* ignore */ }
    }
    syncYuketangSpeedDom(effectiveRate);
  }

  function findYuketangPlayerContext() {
    var pageWindow = getPageWindow();
    var pageDocument = (pageWindow && pageWindow.document) || document;
    var root = (pageDocument && pageDocument.querySelector && pageDocument.querySelector(".xtplayer")) || document.querySelector(".xtplayer");
    var vm = root && (root.__vue__ || (root.wrappedJSObject && root.wrappedJSObject.__vue__));
    var player = vm && vm.player;
    var video = (player && player.video) || (pageDocument && pageDocument.querySelector && pageDocument.querySelector("video")) || document.querySelector("video");
    return {
      pageWindow: pageWindow,
      root: root,
      vm: vm,
      player: player,
      video: video
    };
  }

  function resolveYuketangRate(targetRate) {
    var target = normalizeRate(targetRate);
    var speeds = Array.from(document.querySelectorAll("xt-speedlist [data-speed]"))
      .map(function (node) {
        return Number(node.getAttribute("data-speed"));
      })
      .filter(function (rate) {
        return Number.isFinite(rate) && rate > 0;
      })
      .sort(function (a, b) {
        return a - b;
      });
    if (!speeds.length) return target;
    for (var i = 0; i < speeds.length; i += 1) {
      if (Math.abs(speeds[i] - target) <= 0.001) return speeds[i];
    }
    if (target <= speeds[0]) return speeds[0];
    if (target >= speeds[speeds.length - 1]) return speeds[speeds.length - 1];
    return speeds.filter(function (rate) {
      return rate <= target;
    }).pop() || speeds[speeds.length - 1];
  }

  function syncYuketangSpeedDom(rate) {
    var speedKey = Number(rate).toFixed(2);
    var speedWrap = document.getElementsByTagName("xt-speedbutton")[0];
    var speedValue = speedWrap && speedWrap.querySelector("xt-speedvalue");
    if (speedValue && speedValue.textContent !== speedKey + "X") speedValue.textContent = speedKey + "X";
    Array.from(document.querySelectorAll("xt-speedlist [data-speed]")).forEach(function (node) {
      var active = Math.abs(Number(node.getAttribute("data-speed")) - Number(rate)) <= 0.001;
      if (node.classList.contains("xt_video_player_common_active") !== active) {
        node.classList.toggle("xt_video_player_common_active", active);
      }
    });
  }

  function goNextAfterVideo(video) {
    setStatus(STATUS.scanning, "等待平台同步视频完成状态");
    waitForYuketangVideoEndSync(video).then(function () {
      if (isPaused()) return;
      setStatus(STATUS.scanning, "准备进入下一节视频");
      // 优先返回学习内容页重新扫描：findNextPlayableChapter 只会选未完成的视频节点，
      // 避免“下一节”按钮把流程带到文档/讨论/作业等非视频内容上而卡死。
      var studyUrl = buildStudyContentUrl();
      if (studyUrl) {
        log("等待平台同步后返回学习内容页扫描下一节视频");
        delay(POST_VIDEO_RESCAN_WAIT_MS).then(function () {
          if (!isPaused()) navigateTo(studyUrl, "返回学习内容页重新扫描");
        });
        return;
      }
      var next = findNextButton();
      if (next) {
        next.dispatchEvent(new Event("mousemove", { bubbles: true }));
        clickElement(next, "跳转下一节");
        return;
      }
      var queue = readQueue();
      if (queue.phase === "learning" && queue.myTrainingUrl) {
        log("未找到学习内容页地址，等待平台同步后返回培训进度页重新调度");
        delay(POST_VIDEO_RESCAN_WAIT_MS).then(function () {
          if (!isPaused()) completeCurrentCourse("当前视频完成");
        });
        return;
      }
      refreshCurrentPage("无法确定下一节或学习内容页地址");
    });
  }

  function waitForYuketangVideoEndSync(video) {
    return new Promise(function (resolve) {
      var context = findYuketangPlayerContext();
      var player = context.player;
      var settled = false;
      var fallbackTimer = null;
      var flushAttempted = false;

      function detach(handler) {
        if (!player || !handler) return;
        try {
          if (typeof player.off === "function") {
            player.off("heartback", handler);
          } else if (typeof player.removeListener === "function") {
            player.removeListener("heartback", handler);
          } else if (player.eventArr && Array.isArray(player.eventArr.heartback)) {
            player.eventArr.heartback = player.eventArr.heartback.filter(function (item) {
              return item !== handler;
            });
          }
        } catch (error) {
          console.warn(error);
        }
      }

      function restartFallbackTimer(handler) {
        if (fallbackTimer) {
          window.clearTimeout(fallbackTimer);
          state.timers = state.timers.filter(function (item) { return item !== fallbackTimer; });
        }
        fallbackTimer = schedule(function () {
          if (tryFlushPendingVideoEnd(handler, "等待超时")) return;
          finish("等待超时兜底", handler);
        }, VIDEO_END_SYNC_WAIT_MS);
      }

      function getHeartbeatParams() {
        return player && player.heartBeat && player.heartBeat.params ? player.heartBeat.params : {};
      }

      function isCurrentVideoEndLog(log) {
        var params = getHeartbeatParams();
        if (!log || log.et !== "videoend") return false;
        if (params.v && String(log.v) !== String(params.v)) return false;
        if (params.c && String(log.c) !== String(params.c)) return false;
        if (params.classroomid && String(log.classroomid) !== String(params.classroomid)) return false;
        return true;
      }

      function hasPendingVideoEndLog() {
        var store = safeJsonParse(window.localStorage.getItem("nhd"), {});
        return Object.keys(store).some(function (key) {
          return isCurrentVideoEndLog(store[key]);
        });
      }

      function tryFlushPendingVideoEnd(handler, reason) {
        if (flushAttempted || !hasPendingVideoEndLog()) return false;
        var heartBeat = player && player.heartBeat;
        if (!heartBeat || typeof heartBeat.sendEvents !== "function") return false;
        flushAttempted = true;
        try {
          if (video && video.duration && heartBeat.params) {
            heartBeat.params.et = "videoend";
            heartBeat.preVideoTime = video.duration;
            if (typeof heartBeat.getParams === "function") heartBeat.getParams();
          }
          heartBeat.sendEvents();
          log("检测到 videoend 仍在本地队列，已调用播放器原生 heartbeat flush（" + reason + "）");
          restartFallbackTimer(handler);
          return true;
        } catch (error) {
          log("刷新本地 videoend 队列失败：" + error.message);
          return false;
        }
      }

      function finish(reason, handler) {
        if (settled) return;
        settled = true;
        if (fallbackTimer) {
          window.clearTimeout(fallbackTimer);
          state.timers = state.timers.filter(function (item) { return item !== fallbackTimer; });
        }
        detach(handler);
        log("视频完成同步等待结束：" + reason);
        delay(POST_HEARTBACK_SETTLE_MS).then(resolve);
      }

      var onHeartback = function () {
        if (tryFlushPendingVideoEnd(onHeartback, "heartback 后仍有待发送日志")) return;
        finish("收到 heartback", onHeartback);
      };

      if (player && typeof player.on === "function") {
        try {
          player.on("heartback", onHeartback);
          log("等待雨课堂 videoend heartback 后再跳转");
        } catch (error) {
          log("监听 heartback 失败，使用兜底等待：" + error.message);
        }
      } else {
        log("未找到播放器 heartback 事件，使用兜底等待");
      }

      if (video && !video.ended) {
        finish("视频未处于 ended 状态", onHeartback);
        return;
      }

      restartFallbackTimer(onHeartback);
    });
  }

  function findNextButton() {
    var candidates = Array.from(document.querySelectorAll("button,a,[role='button'],.btn-next,.header-bar .pointer,.header-bar span"))
      .filter(isVisible)
      .filter(function (node) {
        var text = textOf(node);
        var disabled = node.disabled || node.getAttribute("aria-disabled") === "true" || /disabled|disable/.test(String(node.className));
        return !disabled && text.length <= 30 && /下一单元|下一节|下一个|下一课|继续学习/.test(text);
      });
    candidates.sort(function (a, b) {
      var aScore = /btn-next/.test(String(a.className)) ? 0 : 1;
      var bScore = /btn-next/.test(String(b.className)) ? 0 : 1;
      return aScore - bScore;
    });
    return candidates[0] || null;
  }

  function buildStudyContentUrl() {
    var match = location.pathname.match(/^(\/pro\/lms\/[^/]+\/[^/]+)\/video\//);
    if (!match) return "";
    return location.origin + match[1] + "/studycontent" + location.search;
  }

  function retryWait(factory, label, maxRetries, timeout) {
    var attempt = 0;
    var limit = Math.max(0, Number(maxRetries) || 0);

    function runAttempt() {
      attempt += 1;
      return waitFor(factory, {
        timeout: timeout || 15000,
        label: label
      }).catch(function (error) {
        if (isPaused()) throw error;
        if (attempt <= limit) {
          log("等待" + label + "失败，重试 " + attempt + "/" + limit + "：" + error.message);
          return new Promise(function (resolve) {
            schedule(resolve, 1000);
          }).then(runAttempt);
        }
        throw error;
      });
    }

    return runAttempt();
  }

  function handleRecoverableError(error, fallbackMessage) {
    var config = readConfig();
    log(fallbackMessage + "：" + error.message);
    if (config.continueOnError && routeName() === "video") {
      var studyUrl = buildStudyContentUrl();
      if (studyUrl) {
        setStatus(STATUS.scanning, "出错，返回学习内容页重扫");
        schedule(function () { navigateTo(studyUrl, "视频页出错后返回学习内容页"); }, 1500);
        return;
      }
    }
    // 保持自动模式：刷新当前页重试，而不是直接暂停等待人工。
    refreshCurrentPage(fallbackMessage);
  }

  // 防切屏：浏览器不允许用代码把后台标签页切到前台（window.focus() 对后台标签无效），
  // 因此改为让页面始终被判定为“可见且有焦点”，从而阻止雨课堂在标签页未聚焦时反复暂停视频。
  function preventScreenCheck() {
    var win = getPageWindow();
    var docs = [];
    [(win && win.document) || null, document].forEach(function (d) {
      if (d && docs.indexOf(d) < 0) docs.push(d);
    });
    var blocked = ["visibilitychange", "webkitvisibilitychange", "mozvisibilitychange", "blur", "pagehide"];

    function defineVisible(obj, prop, getter) {
      try {
        Object.defineProperty(obj, prop, { configurable: true, get: getter });
      } catch (error) { /* 某些环境下不可重定义，忽略 */ }
    }
    docs.forEach(function (d) {
      defineVisible(d, "hidden", function () { return false; });
      defineVisible(d, "webkitHidden", function () { return false; });
      defineVisible(d, "mozHidden", function () { return false; });
      defineVisible(d, "visibilityState", function () { return "visible"; });
      defineVisible(d, "webkitVisibilityState", function () { return "visible"; });
      try { d.hasFocus = function () { return true; }; } catch (error) { /* ignore */ }
    });

    // 拦截“之后”注册的切屏/失焦监听（脚本早于播放器加载时最有效）。
    function wrapAdd(target) {
      if (!target || target.__ytAecWrapped) return;
      var original = target.addEventListener;
      if (typeof original !== "function") return;
      target.__ytAecOrigAdd = original;
      target.addEventListener = function (type) {
        if (blocked.indexOf(String(type)) >= 0) return undefined;
        return original.apply(this, arguments);
      };
      target.__ytAecWrapped = true;
    }
    [win].concat(docs).forEach(wrapAdd);

    // 兜底：用原始 addEventListener 在捕获阶段吞掉这些事件，尽量拦住已注册的处理器。
    function swallow(event) {
      try { event.stopImmediatePropagation(); } catch (error) { /* ignore */ }
    }
    [win].concat(docs).forEach(function (target) {
      if (!target) return;
      var add = target.__ytAecOrigAdd || target.addEventListener;
      blocked.forEach(function (type) {
        try { add.call(target, type, swallow, true); } catch (error) { /* ignore */ }
      });
    });
  }

  // 让后台/失焦标签页不被浏览器节流，从而保证雨课堂的心跳定时器按真实节奏上报、进度记满。
  // 关键手段：用近乎静音的音频让浏览器把本标签页标记为“正在播放声音”——可发声的标签页会被豁免后台定时器节流。
  // 注意：AudioContext 需要一次用户手势才能真正出声；纯无界面服务器上手势永远不来，
  // 这种环境必须用 Chrome 启动参数（见 README/下方说明）来彻底关闭节流。
  function installFocusKeepAlive() {
    var win = getPageWindow();
    var started = false;

    function startAudioKeepAlive() {
      if (started) return;
      try {
        var Ctx = win.AudioContext || win.webkitAudioContext || window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        var ctx = new Ctx();
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        gain.gain.value = 0.001;     // 近乎静音
        osc.frequency.value = 1;     // 次声，听不见
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        if (ctx.state === "suspended" && typeof ctx.resume === "function") ctx.resume();
        state.__ytAudioCtx = ctx;    // 持有引用避免被回收
        started = ctx.state === "running";
        if (started) log("已启动静音音频保活，避免后台标签页被节流");
      } catch (error) { /* ignore */ }
    }

    var onGesture = function () {
      startAudioKeepAlive();
      if (started) {
        document.removeEventListener("click", onGesture, true);
        document.removeEventListener("keydown", onGesture, true);
      }
    };
    startAudioKeepAlive();                 // 先试一次（部分环境无需手势）
    document.addEventListener("click", onGesture, true);
    document.addEventListener("keydown", onGesture, true);
  }

  function installNavigationHooks() {
    var originalPushState = history.pushState;
    var originalReplaceState = history.replaceState;
    history.pushState = function () {
      var result = originalPushState.apply(this, arguments);
      schedule(runRouter, 300);
      return result;
    };
    history.replaceState = function () {
      var result = originalReplaceState.apply(this, arguments);
      schedule(runRouter, 300);
      return result;
    };
    window.addEventListener("popstate", function () { schedule(runRouter, 300); });
    window.addEventListener("hashchange", function () { schedule(runRouter, 300); });
  }

  // 立即执行防切屏（document-start 时机最早，能在播放器注册监听前生效）。
  preventScreenCheck();

  function bootstrap() {
    installFocusKeepAlive();
    initPanel();
    installNavigationHooks();
    schedule(runRouter, 300);
  }
  if (document.body) {
    bootstrap();
  } else {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  }
})();
