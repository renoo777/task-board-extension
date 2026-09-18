/* 任务台 · 飞书同步引擎
 *
 * 分层：feishu.js 管「怎么跟飞书说话」，本文件管「什么时候说、说什么、谁覆盖谁」。
 *
 * ── 三条设计前提（改代码前先读这段）──────────────────────────
 *
 * 1) 本地仍是主库，飞书是镜像。
 *    弹窗绝不等待网络 —— 本地 storage 始终是 UI 的数据源，同步在后台异步发生。
 *    飞书 API 单次往返 200~500ms，且同表不支持并发写，把它当实时主库会让交互崩掉。
 *
 * 2) 判「谁改过」用字段快照比对，不用时间戳。
 *    syncmap 里存着上次同步后双方的规范快照。拉取时直接比内容：
 *      本地脏 = 本地当前快照 ≠ 基线快照
 *      远端脏 = 飞书当前快照 ≠ 基线快照
 *    不用时间戳是因为：自己推一次就会刷新飞书的修改时间，用时间戳会把
 *    「我自己刚写的」误判成「别人改的」，然后陷入无意义的来回推。
 *
 * 3) 冲突时飞书赢，并且记下来。
 *    两边都动了同一条时，你专程去飞书改的那个动作意图更明确；扩展里的快速拖拽
 *    更容易是误触。但绝不静默吞掉 —— 冲突会写进 status.conflicts，设置页看得到。
 *
 * ── 另外两个必须记得的守卫 ─────────────────────────────────
 *   · 写回本地会触发 storage.onChanged，进而又想同步 → 死循环。
 *     用 lastWriteHash 比对内容来识别「这是我自己写的」。
 *   · 远端记录大批消失时绝不照做。可能是分页失败或权限变了，
 *     照做等于一键清空你的飞书表。见 DELETE_ABS / DELETE_RATIO。
 */

var Sync = (function () {
  var KEY = "taskboard.v1";
  var PKEY = "taskboard.projects";
  var CFG = "taskboard.sync";         // 配置：appId / appSecret / baseToken / tableId / enabled
  var MAP = "taskboard.syncmap";      // { [本地id]: {recordId, snap} }
  var META = "taskboard.syncmeta";    // { table: "baseToken/tableId" } —— 上一轮同步的是哪张表
  var STAT = "taskboard.syncstatus";  // 给 UI 看的状态

  var DELAY = 3000;          // 改动后延迟几秒再推，把连续操作合并成一次批量请求
  var DELETE_ABS = 3;        // 远端待删记录数超过这个值…
  var DELETE_RATIO = 0.3;    // …且超过已知记录的这个比例，就中止删除并报警
  var STALE_MS = 60000;      // 超过这么久没同步过，打开弹窗时拉一次

  var running = null;        // 正在跑的同步 Promise（防重入）
  var timer = null;
  var lastWriteHash = null;  // 上次由同步自己写回本地的内容指纹

  function chromeStore() {
    return (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
  }
  function sget(keys) {
    var cs = chromeStore();
    if (cs) return new Promise(function (r) { cs.get(keys, function (o) { r(o || {}); }); });
    return Promise.resolve({});
  }
  function sset(obj) {
    var cs = chromeStore();
    if (cs) return new Promise(function (r) { cs.set(obj, function () { r(); }); });
    return Promise.resolve();
  }
  function surl() { return typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.getURL("manage.html") : ""; }

  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return String(h);
  }

  function uid() { return Math.random().toString(36).slice(2, 9); }

  function sched() { return (typeof setTimeout === "function") ? setTimeout : null; }

  /* ---------- 配置 ---------- */

  function readCfg() {
    return sget(CFG).then(function (o) { return o[CFG] || {}; });
  }

  function writeCfg(patch) {
    return readCfg().then(function (cur) {
      var next = {};
      Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
      Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
      var p = {};
      p[CFG] = next;
      return sset(p).then(function () { return next; });
    });
  }

  function ready(cfg) {
    return !!(cfg && cfg.enabled && cfg.appId && cfg.appSecret && cfg.baseToken && cfg.tableId);
  }

  /* 用「表」当身份标识：base token + table id 一起才是唯一的一张表。
     它的用途只有一个 —— 判断这一轮同步的目标表和上一轮是不是同一张。 */
  function tableKey(cfg) {
    return String((cfg && cfg.baseToken) || "") + "/" + String((cfg && cfg.tableId) || "");
  }

  /* ---------- 状态（给 UI 用） ---------- */

  function setStatus(patch) {
    return sget(STAT).then(function (o) {
      var cur = o[STAT] || { state: "idle" };
      var next = {};
      Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
      Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
      next.at = Date.now();
      var p = {};
      p[STAT] = next;
      return sset(p).then(function () { return next; });
    });
  }

  function getStatus() {
    return sget(STAT).then(function (o) { return o[STAT] || { state: "idle" }; });
  }

  /* ---------- 本地写入：标记来源，避免自己触发自己 ---------- */

  function writeLocal(data) {
    lastWriteHash = hash(JSON.stringify(data));
    var p = {};
    p[KEY] = data;
    return sset(p);
  }

  function isSelfWrite(value) {
    return lastWriteHash !== null && hash(JSON.stringify(value)) === lastWriteHash;
  }

  /* ---------- 主流程 ---------- */

  function syncNow(opts) {
    opts = opts || {};
    if (running) return running;   // 已经在跑就复用，不排队（避免同时打同一个表）

    running = run(opts).then(function (r) {
      running = null;
      return r;
    }, function (e) {
      running = null;
      return setStatus({ state: "error", message: (e && e.message) || String(e) })
        .then(function () { return { ok: false, error: (e && e.message) || String(e) }; });
    });
    return running;
  }

  function run(opts) {
    var cfg, local, map, t0 = Date.now();
    var retargeted = false;
    var ensureReport = null;   // 表结构检查结果（补了哪几列），带进状态给 UI 看

    return setStatus({ state: "running", message: "同步中…" })
      .then(readCfg)
      .then(function (c) {
        cfg = c;
        if (!ready(cfg)) return { ok: false, skipped: true, reason: "未配置或未开启" };
        return sget([KEY, MAP, META]).then(function (o) {
          local = o[KEY] || { view: "today", tasks: [] };
          if (!Array.isArray(local.tasks)) local.tasks = [];
          map = o[MAP] || {};

          /* ★ 换表要作废整份 syncmap。
             map 里存的是「本地任务 ↔ 飞书 record_id」，而 record_id 跟具体那张表绑定。
             一旦 baseToken / tableId 变了（一键建了张新表、或粘了另一个表的链接），
             这些 record_id 全部失效 —— 而 merge 里有一条「本地有、远端找不到这条」的
             分支，会因此把所有老任务静默跳过。表现就是：配置保存成功、状态显示
             「已同步」，但飞书表里一条都没有。这里一次性清掉，让它们当成全新任务
             重新推上去。 */
          var prev = (o[META] || {}).table || "";
          var now = tableKey(cfg);
          retargeted = !!prev && prev !== now;
          if (retargeted) map = {};

          /* ★ 表结构前置。v0.7.0 起要写「优先级」「排序序位」两列，而老表只有 9 列。
             齐了就零成本（一个 GET），缺了就自动补上。
             补不上必须当场失败 —— 揣着一列不存在的字段去同步，会撞一串 1254045，
             而那句报错只说「字段名对不上」，看不出是「列压根不存在」，
             太容易被误诊成「有人改了列名」。 */
          return Feishu.ensureFields(cfg).then(function (r) {
            if (!r.ok) {
              throw new Error("飞书表缺列，自动补列没成功 —— " + Feishu.describeEnsure(r));
            }
            return r;
          });
        }).then(function (ensure) {
          ensureReport = ensure;
          return Feishu.listAll(cfg);
        }).then(function (remote) {
          return merge(cfg, local, map, remote,
                       { force: !!(opts && opts.force), retargeted: retargeted,
                         ensureAdded: (ensureReport && ensureReport.added) || [] }, t0);
        }).then(function (r) {
          var p = {};
          p[META] = { table: tableKey(cfg), at: Date.now() };
          return sset(p).then(function () { return r; });
        });
      });
  }

  /* 合并 —— 整个同步的心脏。纯逻辑，不碰网络，便于测试。 */
  function merge(cfg, local, map, remote, opts, t0) {
    var tasks = local.tasks.slice();
    var byId = {};
    tasks.forEach(function (t) { byId[t.id] = t; });

    var knownIds = Object.keys(map);
    var knownRecordIds = {};
    knownIds.forEach(function (id) {
      if (map[id] && map[id].recordId) knownRecordIds[map[id].recordId] = true;
    });
    var remoteByLocalId = {};   // 本地ID → 远端记录
    var byRecordId = {};        // record_id → 远端记录（映射兜底，见下面 ②）
    var orphans = [];
    remote.forEach(function (rec) {
      var lid = Feishu.normText(rec.fields[Feishu.F.localId]);
      byRecordId[rec.recordId] = rec;
      if (lid) remoteByLocalId[lid] = rec;
      /* 没有本地ID 的远端记录分两种：
         ① 我们本来就在跟着它（syncmap 里存着它的 record_id，只是那一格被人手动清过）
            → 不算孤儿，交给 ② 按 record_id 对上再把键补回去；
         ② 真·在飞书里手工新建的 → 才认成新任务拉下来。
         不分这两种的话，谁清了一次「本地ID」，本地就会凭空多出一条重复任务。 */
      else if (!knownRecordIds[rec.recordId]) orphans.push(rec);
    });

    var stats = { created: 0, updated: 0, pulledNew: 0, pulledUpdate: 0, deleted: 0,
                  conflicts: 0, skippedDeletes: 0, revived: 0 };
    var conflicts = [];
    var toCreate = [], toUpdate = [];

    /* ① 飞书里手工建的记录（没有本地ID）→ 认成新任务拉下来 */
    orphans.forEach(function (rec) {
      var t = Feishu.fromFields(rec.fields, {});
      t.id = uid();
      if (!t.title) t.title = "（未命名）";
      tasks.unshift(t);
      byId[t.id] = t;
      map[t.id] = { recordId: rec.recordId, snap: Feishu.snapshot(rec.fields) };
      stats.pulledNew++;
    });

    /* ② 逐条比对 */
    tasks.forEach(function (t) {
      var entry = map[t.id];
      /* 找这条本地任务对应的远端记录，两条路：
         ① 按「本地ID」列找 —— 正规路径；
         ② 按 syncmap 里记着的 record_id 找 —— 兜底。两种情况必须走它：
            a) 刚从飞书认领下来的手工记录，飞书那条还没有本地ID（这一轮才要补上）；
            b) 有人在飞书里把「本地ID」列清空了 —— 不兜这一下就会当成新任务重推一条，
               于是同一件事在表里出现两份。
         两条都对不上，才说明远端真的没有这条记录（见下面的 revived）。 */
      var rec = remoteByLocalId[t.id] ||
                ((entry && entry.recordId) ? byRecordId[entry.recordId] : null);
      var localSnap = Feishu.snapshot(Feishu.toFields(t));

      if (!rec) {
        if (entry && entry.recordId) {
          /* 我们记着它曾在飞书存在，但远端现在没有这条了：
             换过表 / 表被重建 / 有人在飞书把它删了。
             本地任务还在 —— 就按「本地是主库」把它重新推上去，记进 revived 让报告说清楚。
             ★ 旧写法在这里直接 return，既不重建也不吭声，等于把这些任务永久卡死：
               状态显示「已同步」，实际永远推不上去，而且完全没有提示。 */
          delete map[t.id];
          stats.revived++;
        }
        // 全新任务，飞书那边还没有
        toCreate.push(t);
        return;
      }

      /* 关联本身需要修的三件事，一次处理掉，全部按「以本地为准」推上去：
         ① 第一次接上（换过表 / 本地没记着它）；
         ② record_id 变了（远端那条被删过又重建）；
         ③ 远端那条的「本地ID」跟我们的 id 对不上（有人手动清过那一格，
            或者这一轮刚从飞书认领下来、还没写回去）。
         ★ ③ 不能靠快照发现：快照里不含「本地ID」，那一格丢了对快照毫无影响，
           而丢了它两边就等于断了线 —— 必须显式比。 */
      if (!entry || !entry.recordId || entry.recordId !== rec.recordId ||
          Feishu.normText(rec.fields[Feishu.F.localId]) !== t.id) {
        map[t.id] = { recordId: rec.recordId, snap: Feishu.snapshot(rec.fields) };
        toUpdate.push({ recordId: rec.recordId, task: t });
        return;
      }

      var remoteSnap = Feishu.snapshot(rec.fields);
      var localDirty = localSnap !== entry.snap;
      var remoteDirty = remoteSnap !== entry.snap;

      if (remoteDirty && !localDirty) {
        // 只有飞书那边动过 → 拉回来
        applyRemote(t, rec.fields);
        entry.snap = remoteSnap;
        stats.pulledUpdate++;
      } else if (localDirty && !remoteDirty) {
        toUpdate.push({ recordId: rec.recordId, task: t });
      } else if (localDirty && remoteDirty) {
        // 两边都动了 → 飞书赢，但记账
        var before = { title: t.title, status: t.status, note: t.note };
        applyRemote(t, rec.fields);
        entry.snap = remoteSnap;
        conflicts.push({ id: t.id, title: t.title, local: before });
        stats.conflicts++;
      }
    });

    /* ③ 本地删掉的（我们记过 recordId，但本地已经没这条）→ 删远端 */
    var vanished = [];
    knownIds.forEach(function (id) {
      if (byId[id]) return;
      var e = map[id];
      if (e && e.recordId) vanished.push({ id: id, recordId: e.recordId });
    });

    var allowDelete = true;
    if (vanished.length) {
      var looksLikeWipe = tasks.length === 0 ||
        (vanished.length > DELETE_ABS && vanished.length >= knownIds.length * DELETE_RATIO);
      if (looksLikeWipe && !opts.force) {
        allowDelete = false;
        stats.skippedDeletes = vanished.length;
      }
    }

    /* ④ 落库：先本地，再远端 */
    var changedLocal = stats.pulledNew + stats.pulledUpdate + stats.conflicts > 0;
    var localStep = changedLocal
      ? writeLocal({ view: local.view || "today", tasks: tasks })
      : Promise.resolve();

    return localStep.then(function () {
      var chain = Promise.resolve();
      var conflictsNow = conflicts.slice();
      var skippedNow = allowDelete ? 0 : vanished.length;

      if (toCreate.length) {
        chain = chain.then(function () { return Feishu.batchCreate(cfg, toCreate); })
          .then(function (recs) {
            recs.forEach(function (r, i) {
              var t = toCreate[i];
              if (!t) return;
              map[t.id] = { recordId: r.recordId, snap: Feishu.snapshot(Feishu.toFields(t)) };
              stats.created++;
            });
          });
      }

      if (toUpdate.length) {
        chain = chain.then(function () { return Feishu.batchUpdate(cfg, toUpdate); })
          .then(function () {
            toUpdate.forEach(function (p) {
              map[p.task.id] = { recordId: p.recordId, snap: Feishu.snapshot(Feishu.toFields(p.task)) };
              stats.updated++;
            });
          });
      }

      if (vanished.length && allowDelete) {
        chain = chain.then(function () {
          return Feishu.batchDelete(cfg, vanished.map(function (v) { return v.recordId; }));
        }).then(function () {
          vanished.forEach(function (v) { delete map[v.id]; });
          stats.deleted = vanished.length;
        });
      }

      return chain.then(function () {
        var p = {};
        p[MAP] = map;
        return sset(p);
      }).then(function () {
        // 这一轮结束之后，飞书表里应该有多少条。
        // 拿「拉回来的条数 + 本轮新增 - 本轮删除」算 —— 直接报拉取时的数量会少掉
        // 这一轮刚推上去的那些，用户一看数字对不上又该怀疑没同步了。
        var remoteAfter = remote.length + stats.created - stats.deleted;
        return setStatus({
          state: "ok",
          message: "已同步",
          stats: stats,
          conflicts: conflictsNow,
          skippedDeletes: skippedNow,
          remoteTotal: remoteAfter,
          retargeted: !!(opts && opts.retargeted),
          /* 这一轮自动补了哪几列。空数组是常态（表结构早齐了）。
             ★ 必须从 opts 取，不能用 run() 的局部变量 —— merge 是独立函数，看不到它。 */
          ensureAdded: (opts && opts.ensureAdded) || [],
          tookMs: Date.now() - t0
        }).then(function () {
          return { ok: true, stats: stats, conflicts: conflictsNow, skippedDeletes: skippedNow,
                   remoteTotal: remoteAfter, retargeted: !!(opts && opts.retargeted),
                   ensureAdded: (opts && opts.ensureAdded) || [] };
        });
      });
    });
  }

  /* 把飞书字段写进本地任务对象（就地改，保住 id 与其它本地字段） */
  function applyRemote(t, fields) {
    var r = Feishu.fromFields(fields, t);
    t.title = r.title || t.title;
    t.status = r.status;
    t.project = r.project || t.project;
    t.date = r.date || t.date;
    t.note = r.note;
    t.url = r.url;
    if (r.createdAt) t.createdAt = r.createdAt;
    t.doneAt = r.doneAt;
    return t;
  }

  /* ---------- 延迟合并推送 ---------- */

  function scheduleSync(delay) {
    var st = sched();
    if (!st) return Promise.resolve({ skipped: true });
    if (timer) st.clearTimeout ? st.clearTimeout(timer) : clearTimeout(timer);
    timer = st(function () {
      timer = null;
      syncNow({});
    }, delay == null ? DELAY : delay);
    return Promise.resolve({ scheduled: true });
  }

  /* 打开弹窗时调用：太久没同步就拉一次，顺便把本地已有的推上去 */
  function syncIfStale() {
    return getStatus().then(function (s) {
      var stale = !s.at || (Date.now() - s.at) > STALE_MS;
      if (!stale) return { skipped: true };
      return syncNow({});
    });
  }

  /* 配置变了（设置页保存后）→ 立刻整一轮 */
  function reconfigure(patch) {
    return writeCfg(patch).then(function () { return syncNow({}); });
  }

  var api = {
    KEY: KEY,
    CFG: CFG,
    MAP: MAP,
    META: META,
    STAT: STAT,
    DELAY: DELAY,
    DELETE_ABS: DELETE_ABS,
    DELETE_RATIO: DELETE_RATIO,
    readCfg: readCfg,
    writeCfg: writeCfg,
    ready: ready,
    tableKey: tableKey,
    getStatus: getStatus,
    setStatus: setStatus,
    syncNow: syncNow,
    scheduleSync: scheduleSync,
    syncIfStale: syncIfStale,
    reconfigure: reconfigure,
    merge: merge,               // 暴露给测试
    isSelfWrite: isSelfWrite,
    writeLocal: writeLocal,
    hash: hash
  };
  return api;
})();

if (typeof module !== "undefined" && module.exports) module.exports = Sync;
