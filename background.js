// 任务台 · background service worker
// 职责：右键捕获、快捷键唤起弹窗、图标角标、飞书同步调度
// 状态一律落 chrome.storage.local —— MV3 的 service worker 随时会被回收，内存里存不住东西。

// popup.html / manage.html 是用 <script src> 直接引这几个文件的，
// 在那种场景下 importScripts 不存在，所以要判一下再用。
/* ★ mascot.js 也要进 SW（v0.24.0）：推给桌面球的快照里带着吉祥物配置，
   而那份配置的解析口径只有 mascot.js 里那一个 readConfig —— 不加载它，
   ball.js 就得自己再写一份默认值（等于把口径复制到第二个仓库去了）。
   ★ 它在这个作用域里是安全的：不碰 document，root 落在 self 上。 */
if (typeof importScripts === "function") importScripts("feishu.js", "sync.js", "mascot.js", "ball.js");

/* ---------- 桌面悬浮球：连一次、推快照 ----------
   ★ native messaging 只能由 Service Worker（或 popup）发起，**内容脚本里不可用**，
     所以这条线挂在这里，不在 popup.js 里。
   ★ SW 被回收又唤醒时整个文件会重新执行一遍 → 这里再 boot 一次是安全的
     （Ball 内部有 booted 兜底，不会重复建连接）。 */
function ballBoot() {
  if (typeof Ball !== "undefined") Ball.boot();
}

var KEY = "taskboard.v1";        // 任务数据
var PKEY = "taskboard.projects"; // 项目列表
var SYNC_TICK = "taskboard-sync-tick"; // 定时兜底的 alarm 名
var SYNC_SOON = "taskboard-sync-soon"; // 改动后几秒内的一次性兜底 alarm 名

function pad(n) { return (n < 10 ? "0" : "") + n; }
function todayStr() {
  var d = new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function uid() { return Math.random().toString(36).slice(2, 9); }

/* ---------- 右键菜单：把当前页 / 选中文字存成任务 ---------- */
/* 升级时自动留一份数据快照。
   目的：万一新版本的数据结构改动有问题，用户还能找回上一版的数据。
   只在「版本号真的变了」时才写，不是每次启动都写 —— 否则备份会被
   新数据覆盖，等于没备份。 */
var BAK = "taskboard.backup";
function backupOnUpgrade(reason, prev) {
  var now = chrome.runtime.getManifest().version;
  if (reason !== "update" || !prev || prev === now) return;
  chrome.storage.local.get(["taskboard.v1", "taskboard.projects", BAK], function (o) {
    if (!o || !o["taskboard.v1"]) return;          // 没数据就别造一个空备份出来
    var patch = {};
    patch[BAK] = {
      at: Date.now(),
      from: prev,
      to: now,
      data: o["taskboard.v1"],
      projects: o["taskboard.projects"] || null
    };
    chrome.storage.local.set(patch);
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: "save-page",
      title: "把当前页存到任务台",
      contexts: ["page", "selection", "link"]
    });
  });
  backupOnUpgrade(details && details.reason, details && details.previousVersion);
  updateBadge();
  ensureSyncAlarm();
  ballBoot();          // 装好/升级后立刻连一次球
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId !== "save-page") return;

  var title = (info.selectionText && info.selectionText.trim()) ||
              (tab && tab.title) || "未命名任务";
  var url = info.linkUrl || (tab && tab.url) || "";
  // 浏览器内部页面存了也没意义，直接丢掉链接只留标题
  if (/^(chrome|edge|about|devtools|chrome-extension|edge-extension):/.test(url)) url = "";

  addTask(title.replace(/\s+/g, " ").slice(0, 160), url);
});

function addTask(title, url) {
  chrome.storage.local.get([KEY, PKEY, "lastProject"], function (o) {
    var data = o[KEY] || { view: "today", tasks: [] };
    if (!data.tasks) data.tasks = [];
    var list = (Array.isArray(o[PKEY]) && o[PKEY].length) ? o[PKEY] : null;
    var fallback = list ? list[0].name : "工作";

    data.tasks.unshift({
      id: uid(),
      title: title,
      status: "todo",
      project: o.lastProject || fallback,
      date: todayStr(),
      note: "",
      url: url,
      createdAt: Date.now(),
      doneAt: null,
      // v0.7.0 起有的两个字段。右键建的任务一律默认档、无手动序位。
      priority: "",
      order: null
    });

    var patch = {};
    patch[KEY] = data;
    chrome.storage.local.set(patch, function () { updateBadge(); });
  });
}

/* ---------- 图标角标：未完成数 ----------
   挂起(status==="hold")不算 —— 挂起的意思就是「这事先不占我的心力」，
   再把它算进角标数字里，等于白挂。 */
function updateBadge() {
  chrome.storage.local.get(KEY, function (o) {
    var d = o[KEY];
    var n = (d && d.tasks) ? d.tasks.filter(function (t) {
      return t.status !== "done" && t.status !== "hold";
    }).length : 0;
    chrome.action.setBadgeText({ text: n ? String(n) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#5c636e" });
  });
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes[KEY]) return;
  updateBadge();

  /* 球只做视图 → 数据一变就把新快照推下去（Ball 内部会合并 250ms 内的连续改动）。
     ★★ 这一行必须排在下面那句 `if (typeof Sync === "undefined") return;` **之前**：
        那句 return 会把后面整段吃掉 —— 一起消失的就是球的数据，而且一声不响。 */
  if (typeof Ball !== "undefined") Ball.pushSoon();

  // 任务数据被改了 → 安排一次延迟同步。
  // 但同步自己写回本地时也会走到这里，不拦就是死循环：
  // 同步写回 → 触发本事件 → 又要同步 → 又写回…
  // 所以用内容指纹认出「这是我自己刚写的」并跳过。
  if (typeof Sync === "undefined") return;
  if (Sync.isSelfWrite(changes[KEY].newValue)) return;
  Sync.readCfg().then(function (cfg) {
    if (!Sync.ready(cfg)) return;
    Sync.scheduleSync();
    armSoon();
  });
});

/* ★ 除了 Sync 里那个「延迟几秒推」，同一时刻再排一个一次性 alarm 当保险。
   原因：MV3 的 service worker 空闲一会儿就会被回收，setTimeout 不保证活到点 ——
   那次延迟推送会跟着一起消失，只能等 5 分钟的周期 alarm 补上。现象就是
   「我在弹窗里加了一条任务，过了半天飞书里还是没有」。
   alarm 是唯一能把被回收的 service worker 叫醒的手段。同名 alarm 再 create
   会直接覆盖，所以连续改好几次任务也只会排一个，不会堆积。 */
function armSoon() {
  if (!chrome.alarms) return;
  chrome.alarms.create(SYNC_SOON, { delayInMinutes: 0.1 });
}

chrome.runtime.onStartup.addListener(function () {
  updateBadge();
  ballBoot();          // 浏览器起来时球可能已经在桌面上了，主动连一次
});

/* ---------- 飞书同步调度 ----------
   MV3 的 service worker 会被回收，setTimeout 不保证活到点。
   所以除了「改动后延迟 3 秒推」（在 Sync.scheduleSync 里），
   再加一个定时 alarm 兜底：万一那次延迟推送被回收掐掉了，这里补上。
   alarms 是唤醒 service worker 的唯一可靠手段。 */
function ensureSyncAlarm() {
  if (!chrome.alarms) return;
  chrome.alarms.create(SYNC_TICK, { periodInMinutes: 5 });
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(function (a) {
    if (typeof Sync === "undefined") return;
    if (a.name === SYNC_SOON) {
      Sync.readCfg().then(function (cfg) {
        if (Sync.ready(cfg)) Sync.syncNow({});
      });
      return;
    }
    if (a.name !== SYNC_TICK) return;
    Sync.readCfg().then(function (cfg) {
      if (Sync.ready(cfg)) Sync.syncNow({});
    });
  });
}

/* ---------- 给 popup / manage 页的消息接口 ---------- */
if (chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;

    /* 桌面悬浮球：设置页问状态、点「测试连接」。
       ★ 这两条必须排在下面那句 `typeof Sync === "undefined"` guard **之前** ——
         设置页问的是球，跟飞书配没配毫无关系；被那句吃掉的表现是
         「飞书没配 → 球的状态永远显示成没反应」，查起来毫无头绪。 */
    if (msg.type === "ball-status") {
      sendResponse(typeof Ball !== "undefined" ? Ball.status()
                                                : { ok: false, supported: false, error: "球桥没加载" });
      return;
    }
    if (msg.type === "ball-probe") {
      if (typeof Ball === "undefined") {
        sendResponse({ ok: false, supported: false, error: "球桥没加载" });
        return;
      }
      Ball.probe().then(sendResponse);
      return true;   // 异步应答
    }
    if (msg.type === "ball-push") {
      // 设置页改完东西想让球立刻对表时用；正常路径走 storage.onChanged
      if (typeof Ball !== "undefined") Ball.pushNow();
      sendResponse(typeof Ball !== "undefined" ? Ball.status() : { ok: false, error: "球桥没加载" });
      return;
    }

    if (typeof Sync === "undefined") return;
    if (msg.type === "sync-now") {
      Sync.readCfg().then(function (cfg) {
        if (!Sync.ready(cfg)) { sendResponse({ ok: false, reason: "未配置或未开启" }); return; }
        Sync.syncNow({ force: !!msg.force }).then(sendResponse);
      });
      return true;   // 异步应答
    }
    if (msg.type === "sync-status") {
      Sync.getStatus().then(sendResponse);
      return true;
    }
    if (msg.type === "sync-wake") {
      // 弹窗打开时叫一声：太久没同步才真的去拉，避免每开一次弹窗就发一轮请求
      Sync.syncIfStale().then(sendResponse);
      return true;
    }
    if (msg.type === "sync-selftest") {
      Sync.readCfg().then(function (cfg) {
        if (!cfg || !cfg.appId || !cfg.appSecret || !cfg.baseToken || !cfg.tableId) {
          sendResponse({ ok: false, needConfig: true });
          return;
        }
        Feishu.selftest(cfg).then(sendResponse);
      });
      return true;
    }
  });
}

/* ---------- 快捷键：打开任务台 ----------
   两种路径，先弹窗后兜底：
   1. chrome.action.openPopup()：Chrome/Edge 127+ 可用。它必须在用户手势的
      同步路径里调用，中间不能有 await，否则报
      "may only be called in response to a user gesture"。
   2. 退回 chrome.tabs.create：某些 Chromium 分支（如 Tabbit）不暴露
      openPopup，或调用当场失败。这时把任务台当普通标签页打开，
      功能一点不打折，只是从弹窗变成页面。

   两条路都不依赖任何额外权限（tabs.create 不需要 tabs 权限）。 */
chrome.commands.onCommand.addListener(function (cmd) {
  if (cmd !== "quick-add") return;
  openBoard();
});

function openBoard() {
  if (chrome.action && typeof chrome.action.openPopup === "function") {
    try {
      var p = chrome.action.openPopup();
      if (p && p.catch) {
        p.catch(function (err) {
          console.warn("[任务台] 弹窗打不开，改用标签页：", err && err.message || err);
          openAsTab();
        });
      }
      return;
    } catch (e) {
      console.warn("[任务台] openPopup 抛错，改用标签页：", e && e.message || e);
    }
  } else {
    console.info("[任务台] 当前浏览器不提供 action.openPopup，改用标签页打开");
  }
  openAsTab();
}

function openAsTab() {
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  } catch (e) {
    console.error("[任务台] 标签页也打不开：", e);
  }
}

/* ---------- 每次 SW 起来都连一次球（★ 必须在顶层） ----------
   为什么不能只挂在 onInstalled / onStartup 里：
   MV3 的 service worker 会因为很多原因被唤醒 —— 打开弹窗、收到消息、alarm 到点…
   而 onStartup 只覆盖「浏览器启动」、onInstalled 只覆盖「装上 / 升级」。
   于是「浏览器一直开着，球是后来才双击打开的」这个**最常见**的场景两条都不占：
   那时 SW 早被回收过了，谁都不会去连球，球上就一直挂着「没连上扩展」。
   顶层代码每次唤醒都会重新执行一遍，所以放这里最省心（Ball 内部有 booted 兜底）。 */
ballBoot();

