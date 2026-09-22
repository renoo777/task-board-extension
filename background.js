// 任务台 · background service worker
// 职责：右键捕获、快捷键唤起弹窗、图标角标、飞书同步调度
// 状态一律落 chrome.storage.local —— MV3 的 service worker 随时会被回收，内存里存不住东西。

// popup.html / manage.html 是用 <script src> 直接引这几个文件的，
// 在那种场景下 importScripts 不存在，所以要判一下再用。
/* ★ notify.js 也必须进 SW（v0.25.0）—— 这是本轮**最容易漏、也最难发现**的一处：
   notifyTick() / sendNudge() / applyNudge() 全都在这个文件里，但它们调的是
   `Notify.facts` / `Notify.gate` / `Notify.localLine` / `Notify.actionOf` /
   `Notify.applyToday`。不 importScripts 它，那些函数里 `typeof Notify === "undefined"`
   的守卫会**安静地提前 return**：闹钟照样每小时响一次、存储照样读、什么都不报错，
   而通知**永远不会出现** —— 一个「功能整块失效但零症状」的形态。
   ★ 顺序无所谓（它是纯函数模块，不依赖前三个），排最后只是保持「先来的在前」。 */
/* ★★★ v0.32.0：inbox.js 同样**必须**进 SW —— 跟上面 notify.js 是同一个坑、
   同一种形态（连顺序都无所谓：inbox.js 也是纯函数模块，不依赖前几个）。
   漏掉它的后果完全相同且同样安静：inboxTick() 里 `typeof Inbox === "undefined"`
   的守卫、以及消息入口里那句 `{ok:false, reason:"模块没加载"}` 会让
   「到达提醒」**整条链静默失效** —— 闹钟照样每分钟响、表里数据照样在、
   而谁都收不到派给自己的任务。
   ★ 它当初确实被漏过一次（并发编辑把那次改动吃掉了），而当时**没有任何门**盯着
     这份名单 —— `_test_background.js` 现在补了一条（见那边的注释）。 */
if (typeof importScripts === "function")
  importScripts("feishu.js", "sync.js", "notify.js", "inbox.js");

var KEY = "taskboard.v1";        // 任务数据
var PKEY = "taskboard.projects"; // 项目列表
var SYNC_TICK = "taskboard-sync-tick"; // 定时兜底的 alarm 名
var SYNC_SOON = "taskboard-sync-soon"; // 改动后几秒内的一次性兜底 alarm 名
var NOTIFY_TICK = "taskboard-notify-tick";  // 主动提醒的检查 alarm 名（v0.25.0）
/* 团队派发的拉取 alarm（v0.32.0）。
   ★★ 为什么是 1 分钟而不是更快：chrome.alarms 的周期**最小就是 1 分钟**
      （再小会被浏览器静默抬到 1 分钟，写了等于没写），而飞书多维表格没有
      给纯客户端的变更推送（事件订阅要公网回调地址或长连接服务端）。
      所以「实时」在我们这儿的定义是**分钟级**：P50 约 30 秒，最坏约 70 秒。
   ★★ 为什么**总是**建这个 alarm，而不是「配好了才建」：闹钟的创建/删除
      发生在 service worker 里，而 SW 随时会被回收 —— 删漏了就是永远不拉，
      建漏了就是永远不响，两种都没有任何报错。宁可让它每 60 秒早退一次
      （成本是一次 storage 读），也不要赌「我一定记得在配置变更时去建它」。 */
var INBOX_TICK = "taskboard-inbox-tick";
/* 「最后一次动过任务台」的时间。★ 单独一个键，不塞进任务数据（v1）里：
   它不是任务的一部分，塞进去会污染导出 JSON 与飞书镜像。 */
var LASTUSE = "taskboard.lastUse";
/* 通知 id 固定 —— 同名会**替换**旧通知，不会在通知中心堆一排。 */
var NOTIFY_ID = "taskboard-nudge";

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
  ensureNotifyAlarm();
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
      /* ★ v0.32.0：派发出去的**不计入角标**。角标的意思是「我还有几件没干」，
         已经交出去的活不占这个数 —— 它现在占的是别人的。
         （本地那条任务仍然留着，只是不计数；见 inbox.js 抬头 ①。） */
      if (t.assign && t.assign.to) return false;
      return t.status !== "done" && t.status !== "hold";
    }).length : 0;
    chrome.action.setBadgeText({ text: n ? String(n) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#5c636e" });
  });
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes[KEY]) return;
  updateBadge();

  /* ★ v0.25.0：记下「他刚动过任务台」。闸门 ③（距上次使用 ≥ 20 小时）全靠
     这个时间戳 —— 依据是「你昨天下午 3 点有空，今天下午 3 点大概也有空」，
     时机来自行为数据，不是任何人的自由心证。
     ★★ 必须排在下面那句 `typeof Sync` guard **之前**：放到后面的话，
        没配飞书的用户永远不会更新它 → lastUse 恒为 0 → 闸门 ③ 恒通过 →
        每小时都可能开口（日限流只挡得住同一天）。这是一条**静默的过度打扰**
        路径，比「不发」严重得多，而它偏偏只影响没配飞书的那部分用户。 */
  var lp = {};
  lp[LASTUSE] = Date.now();
  chrome.storage.local.set(lp);

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
});

/* ---------- 飞书同步调度 ----------
   MV3 的 service worker 会被回收，setTimeout 不保证活到点。
   所以除了「改动后延迟 3 秒推」（在 Sync.scheduleSync 里），
   再加一个定时 alarm 兜底：万一那次延迟推送被回收掐掉了，这里补上。
   alarms 是唤醒 service worker 的唯一可靠手段。 */
/* ---------- 主动提醒（v0.25.0）----------
   ★★★ 这一段是整个功能里唯一有「打扰用户」风险的地方，所以**规则**全部
       写在 Notify.gate() 里（四道闸门，头一道就是「必须用户显式同意」），
       这里只负责**执行**：该发则发、发完记账、按钮点了就干活。
       为什么要这样分：判定写在这儿的话，「为什么没发」在真机上就只能靠猜，
       而「没发通知」这件事本身没有任何可见症状。

   ★★★ 为什么用系统通知，而不是让那颗球开口：
       · 桌面球静息只有几十像素，装不下一句话；要装下就得撑开窗口 ——
         而窗口几何是这个项目历史上最容易出 bug 的地方（见铁律里的「球被撑大」）；
       · 网页球是在**别人家的页面**上，它突然弹一句话比系统通知更没有边界感。
       系统通知是唯一一个「用户预期它会出现」的位置。

   ★★★ 文案**不调模型**，走 Notify.localLine()：
       ① service worker 里没有本机模型（window.LanguageModel 不存在），
          在 SW 里调等于把通知文案绑死在云端通道上；
       ② 通知出现在**你没看着它的时候**，措辞必须稳定。
       详理由见 ai.js 里 speakLine 的抬头。 */
function ensureNotifyAlarm() {
  if (!chrome.alarms) return;
  /* ★ 每 60 分钟看一次，不是每 24 小时。
     原因：alarm 的周期会被浏览器重启 / 长时间休眠打断并漂移，写 1440 分钟的话
     「今天这个点」一旦错过就要再等一整天，而用户感受到的是「它有时候提醒、
     有时候不提醒」。闸门 ④（每天最多一条）在 gate() 里 ——
     所以**看得勤不会变成发得勤**：检查是免费的，发出去才贵。 */
  chrome.alarms.create(NOTIFY_TICK, { periodInMinutes: 60 });
}

function notifyTick() {
  if (typeof Notify === "undefined" || !chrome.notifications) return;
  chrome.storage.local.get([KEY, Notify.KEY, LASTUSE], function (o) {
    var cfg = Notify.readCfg(o && o[Notify.KEY]);
    var f = Notify.facts(o && o[KEY]);
    var g = Notify.gate({
      on: cfg.on,
      over: f.over,
      now: Date.now(),
      lastUse: (o && o[LASTUSE]) || 0,
      lastAt: cfg.lastAt
    });
    /* ★ 不发就一声不响地退出 —— 这个过程每小时跑一次，任何一行 console
       都会把控制台变成噪声，而稳定噪声会让下一个人习惯性忽略这块输出。 */
    if (!g.ok) return;
    sendNudge(f);
  });
}

function sendNudge(f, dry) {
  var act = Notify.actionOf(f);
  var opt = {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "任务台",
    message: Notify.localLine(f)
  };
  /* ★ 有动作才画按钮（见 Notify.actionOf）—— 一个点了没事干的按钮
     比没有按钮更糟：用户会以为功能坏了。 */
  if (act) opt.buttons = [{ title: act.label }];
  chrome.notifications.create(NOTIFY_ID, opt, function () {
    /* ★ dry = 设置页里用户手点的那次「现在试一下」。它**不记账** ——
       否则用户试完就把今天那条额度用掉了，真到该提醒的时候它不吭声，
       而他会以为「这功能就是坏的」。 */
    if (dry) return;
    /* ★★ 记账必须在**回调里**（也就是「确实创建成功」之后），不能在 create()
       后面立刻写：写早了的话，create 失败（系统关了通知、被勿扰模式拦掉）
       也照样把「今天发过了」记上 —— 用户会连着几天什么都收不到，
       而他完全不知道为什么。 */
    chrome.storage.local.get(Notify.KEY, function (o) {
      var next = Notify.readCfg(o && o[Notify.KEY]);
      next.lastAt = Date.now();
      var patch = {};
      patch[Notify.KEY] = next;
      chrome.storage.local.set(patch);
    });
  });
}

/* 通知上那个动作 —— 「替你动手」，不是再催你一句。 */
function applyNudge() {
  if (typeof Notify === "undefined") return;
  chrome.storage.local.get([KEY], function (o) {
    var data = (o && o[KEY]) ? o[KEY] : null;
    if (!data || !Array.isArray(data.tasks)) return;
    var n = Notify.applyToday(data.tasks);
    if (!n) return;
    var patch = {};
    patch[KEY] = data;
    /* ★ 写回就走这一条路：updateBadge 刷角标、storage.onChanged 推给球、
       顺带安排一次飞书同步。不在这里各补一遍 —— 那等于把三条副作用抄成四份。 */
    chrome.storage.local.set(patch, function () { updateBadge(); });
  });
}

/* ---------- 团队派发（v0.32.0）----------
   这一段是「别人派给我的任务怎么到我手上」的执行端。判定（配额 / 窗口 /
   文案）全在 Inbox 里，这里只负责**执行**：拉、记账、发、把待播的交给球。
   分层的理由跟 notify 那条一样：判定写在这儿的话，「为什么没提醒」在真机上
   只能靠猜，而「没提醒」本身没有任何可见症状。

   ★★ 为什么**不**在收到新任务的瞬间发通知，而是走 1 分钟的轮询：
      扩展不是服务端，飞书的变更事件订阅要公网回调地址或长连接服务端，
      这条路上没有。轮询是纯客户端唯一能做的事（见 INBOX_TICK 那条注释）。 */
function ensureInboxAlarm() {
  if (!chrome.alarms) return;
  chrome.alarms.create(INBOX_TICK, { periodInMinutes: 1 });
}

var INBOX_NID = "taskboard-inbox";

function inboxTick() {
  if (typeof Inbox === "undefined") return;
  chrome.storage.local.get([Inbox.CFK, Inbox.ITK, Inbox.PEND], function (o) {
    var cfg = Inbox.readCfg(o && o[Inbox.CFK]);
    if (!cfg.on) return;                       // 没启用：一声不响地退出
    if (typeof Sync === "undefined") return;
    Sync.readCfg().then(function (sc) {
      var full = Inbox.withCred(cfg, sc);
      if (!Inbox.ready(full)) return;
      return Inbox.pull(full, (o && o[Inbox.ITK]) || []).then(function (res) {
        var patch = {};
        patch[Inbox.ITK] = res.items;

        /* 名单自动扩充：表里出现过、名单里还没有的名字并进来 ——
           新同事第一次被派活之后，下次就不用再手填一次。 */
        var add = Inbox.addPeople(cfg, res.names);
        if (add.added.length) { cfg.people = add.people; patch[Inbox.CFK] = cfg; }

        var raw = (o && o[Inbox.PEND]) || {};
        var seen = {
          ids: Array.isArray(raw.ids) ? raw.ids : [],
          sent: Array.isArray(raw.sent) ? raw.sent : [],
          pending: Array.isArray(raw.pending) ? raw.pending : [],
          at: Number(raw.at) || 0
        };
        if (res.fresh && res.fresh.length) {
          announce(cfg, res.fresh, seen);
          patch[Inbox.PEND] = seen;
        }
        chrome.storage.local.set(patch);
      });
    }).catch(function () {
      /* 网络错误**故意不出声**：这一分钟拉不到，下一分钟还会再拉。
         在这里 toast 或发通知的话，断网一小时就是 60 条「拉不到」，
         而用户对此无能为力 —— 那是纯粹的噪声。 */
    });
  });
}

/* 到货播报。★ 会**就地修改** seen（调用方负责把它写回去）。 */
function announce(cfg, fresh, seen) {
  var now = Date.now();

  /* ★★ 无论提不提醒，来过的都记账 —— 「同一条任务只提醒一次」是硬规矩。
     不记的话，用户把两个提醒通道都关着的那段时间里到的任务，
     会在他某天打开其中一个通道时**一次性全涌出来**（可能几十条）。 */
  fresh.forEach(function (x) {
    if (x && x.id && seen.ids.indexOf(x.id) < 0) seen.ids.push(x.id);
  });
  if (cfg.notifyOn !== true && cfg.speakOn !== true) return;

  var g = Inbox.gate({ on: cfg.notifyOn === true, fresh: fresh, now: now, sent: seen.sent });

  if (cfg.notifyOn === true && g.ok && chrome.notifications) {
    var take = (g.take && g.take.length) ? g.take : [];
    if (!take.length && g.merge > 0) {
      /* 额度用完了：合并成一条。★ 不发的话，用户会在任务台里看见新任务、
         却从没被提醒过 —— 那等于这功能没生效。 */
      sendInbox(INBOX_NID, Inbox.lineMany(fresh), null, seen);
    } else {
      take.forEach(function (it) {
        sendInbox(INBOX_NID + "-" + it.id, Inbox.line(it), it, seen);
      });
    }
  }

  /* 球那条路：把待播的文案排进队列，球自己来取（球在别人的页面上，
     后台不该替它决定什么时候开口 —— 它才知道自己现在是不是正被人看着）。 */
  if (cfg.speakOn === true) {
    fresh.forEach(function (it) {
      seen.pending.push({ id: it.id, text: Inbox.line(it) });
    });
    seen.at = now;
  }
}

function sendInbox(id, text, it, seen) {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "派给你的任务",
    message: text
  }, function () {
    /* ★ 记账必须在**回调里**（确实创建成功之后）—— 与 notify 那条同一个理由：
       写早了的话，create 失败（系统关了通知 / 勿扰模式）也照样记上，
       用户会连着好几天什么都收不到，而他完全不知道为什么。 */
    seen.sent.push({ at: Date.now(), id: (it && it.id) || "" });
  });
}

if (chrome.notifications) {
  /* ★★ 两个入口都要接，缺一个就是「某个平台上这条通知是死的」：
     ① onButtonClicked —— Windows / Linux 上通知带按钮；
     ② onClicked      —— **macOS 上 Chrome 不显示通知按钮**，只能点通知本体。
        只接①的话，Mac 用户看到一条点不动的通知，而这类「只在某个平台上死」
        的 bug 不会出现在任何日志里。 */
  if (chrome.notifications.onButtonClicked) {
    chrome.notifications.onButtonClicked.addListener(function (id, idx) {
      if (id !== NOTIFY_ID || idx !== 0) return;
      /* ★ 点按钮**不会**自动清掉通知（只有点通知本体才会）——
         不清的话它会一直挂在通知中心，用户处理完了还得自己划掉。 */
      chrome.notifications.clear(NOTIFY_ID);
      applyNudge();
    });
  }
  if (chrome.notifications.onClicked) {
    chrome.notifications.onClicked.addListener(function (id) {
      if (id === NOTIFY_ID) { applyNudge(); return; }
      /* ★ 点了「派给你的任务」那条通知 → 打开任务台。
         它不像逾期那条有个「拉回今天」的动作可做（任务的主人不是你，
         你能做的只有去看它），所以这里的动作就是**把界面打开**。 */
      if (typeof INBOX_NID === "string" && id.indexOf(INBOX_NID) === 0) {
        openBoard();
      }
    });
  }
}

function ensureSyncAlarm() {
  if (!chrome.alarms) return;
  chrome.alarms.create(SYNC_TICK, { periodInMinutes: 5 });
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(function (a) {
    /* ★★ 提醒的 tick 必须排在下面那句 `typeof Sync` guard **之前**：
       那句 return 会把后面整段吃掉，症状是「没配飞书的用户永远收不到提醒」——
       一声不响，而且正好是**最需要这个功能的那部分用户**（他们连飞书都没配，
       更不会去看控制台）。这类「guard 吃掉下游」本项目栽过好几次了。 */
    if (a.name === NOTIFY_TICK) { notifyTick(); return; }
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

    /* 设置页的「主动提醒」那一块：读状态 / 现在试一次（v0.25.0）。
       ★ 同样必须排在下面那句 `typeof Sync` guard **之前** —— 提醒跟飞书配没配
         毫无关系，被吃掉的表现是「设置页里这一块永远显示成不可用」。 */
    if (msg.type === "notify-status") {
      /* ★★ 守卫必须在**任何** `Notify.xxx` 之前 —— 原来这里写的是
         `chrome.storage.local.get([Notify.KEY, ...])` 然后才 `typeof Notify !== "undefined"`：
         那个 typeof 看着很稳，但它在**下一行**，而上一行已经解引用了 `Notify.KEY`。
         真到 Notify 没加载时抛的是 ReferenceError（不是「安静地走兜底分支」），
         而它发生在一个消息监听器里 —— 表现是「设置页那块一直转圈」。
         同一条规矩在本文件另外三处都写对了（notifyTick / notify-test / applyNudge），
         只有这一处把 typeof 挪到了后面。 */
      if (typeof Notify === "undefined" || !chrome.notifications) {
        sendResponse({ on: false, lastAt: 0, lastUse: 0, can: false });
        return;
      }
      chrome.storage.local.get([Notify.KEY, LASTUSE], function (o) {
        var cfg = Notify.readCfg(o && o[Notify.KEY]);
        sendResponse({
          on: cfg.on,
          lastAt: cfg.lastAt,
          lastUse: (o && o[LASTUSE]) || 0,
          can: true
        });
      });
      return true;   // 异步应答
    }
    if (msg.type === "notify-test") {
      if (typeof Notify === "undefined" || !chrome.notifications) {
        sendResponse({ ok: false });
        return;
      }
      chrome.storage.local.get(KEY, function (o) {
        var f = Notify.facts(o && o[KEY]);
        sendNudge(f, true);          /* dry：不消耗今天那条额度 */
        sendResponse({ ok: true, message: Notify.localLine(f) });
      });
      return true;
    }

    /* ---------- 团队派发（v0.32.0）----------
       这四个入口全部排在 `typeof Sync` guard **之前**：它们自己会去取 Sync 的
       凭据（Inbox.withCred），被那句 return 吃掉的话，设置页那一整块会永远
       显示「连不上」，而用户根本不知道这两个功能有什么关系。 */
    if (msg.type === "inbox-test") {
      if (typeof Inbox === "undefined") { sendResponse({ ok: false, reason: "模块没加载" }); return; }
      var tc = Inbox.readCfg(msg.cfg);
      if (!tc.baseToken || !tc.tableId) { sendResponse({ ok: false, reason: "还没填团队表" }); return; }
      /* 只列字段、不写数据：测试连接不该在别人的表里留下痕迹。 */
      Feishu.listFields(tc).then(function (fields) {
        var names = (fields || []).map(function (f) { return f.name; });
        var tf = Inbox.TF;
        var miss = Object.keys(tf).filter(function (k) { return names.indexOf(tf[k]) < 0; });
        sendResponse({
          ok: miss.length === 0,
          detail: miss.length ? ("表里还缺这些列：" + miss.map(function (k) { return tf[k]; }).join("、")) : ("列齐全（" + names.length + " 列）"),
          missing: miss.map(function (k) { return tf[k]; })
        });
      }).catch(function (e) {
        sendResponse({ ok: false, reason: (e && e.message) || String(e) });
      });
      return true;
    }
    if (msg.type === "inbox-ensure") {
      if (typeof Inbox === "undefined") { sendResponse({ ok: false, reason: "模块没加载" }); return; }
      Inbox.ensureTeam(Inbox.readCfg(msg.cfg)).then(function (r) {
        sendResponse({ ok: !!r.ok, added: r.added, reason: (r.failed || []).join("；") });
      }).catch(function (e) {
        sendResponse({ ok: false, reason: (e && e.message) || String(e) });
      });
      return true;
    }
    if (msg.type === "inbox-try") {
      if (typeof Inbox === "undefined" || !chrome.notifications) { sendResponse({ ok: false }); return; }
      /* ★ 试的这一条是**假的**，不写任何存储、不消耗额度 ——
         用户试完就该还能收到真的那一条。 */
      var demo = { from: "（示例）", title: "把这份周报发给客户", date: Inbox.todayStr() };
      chrome.notifications.create(INBOX_NID + "-try", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "派给你的任务",
        message: Inbox.line(demo)
      }, function () {});
      sendResponse({ ok: true, message: Inbox.line(demo) });
      return;
    }
    if (msg.type === "inbox-pull") {
      if (typeof Inbox === "undefined") { sendResponse({ ok: false, reason: "模块没加载" }); return; }
      inboxTick();
      sendResponse({ ok: true, fresh: 0 });
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
