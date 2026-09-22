/* 任务台 · 团队任务派发（v0.33.0）
 *
 * 一句话职责：把「我派给别人的任务」写进一个**团队共用**的飞书多维表格，
 * 并从那里把「别人派给我的」拉回来，提醒我。
 * 那个 Base 里有两张子表：一张存任务，一张存组员名单（含「谁是本人」）。
 * 「一键生成」负责把这两张表和它们的列一次建出来（见 provision）。
 *
 * ============================================================
 * 一、为什么另开一个模块，而不是塞进 sync.js
 *
 * sync.js 干的是「个人镜像」：本地任务 ⇄ 我自己的那张表，**全量双向**。
 * 团队表里全是别人的任务 —— 走 Sync.merge() 会把别人的任务拉进我的本地清单，
 * 并且下一步就把它们推进我的个人镜像表（污染不可逆，而且没有任何报错）。
 * 所以这里是**独立模块 + 独立存储 key**，两条链路物理隔离，共用不到一处合并逻辑。
 *
 * ============================================================
 * 二、三条硬规矩（都是踩过或推演出来的，别改）
 *
 * ★ ① 派发出去的**不进个人镜像表**。团队表是它的唯一归宿。
 *     本地那条任务保留（我得知道我交出去了什么），但带 `assign` 标记，
 *     且**不计入角标** —— 已经交出去的活不该占着「我还有几件没干」。
 *
 * ★ ② 收到的（inbox）**绝不进 taskboard.v1**。它存在自己的 key 里。
 *     理由同上：进了任务数据就会污染导出 JSON、角标、以及个人镜像。
 *
 * ★ ③ 回写团队表**只传要改的那两列**（状态 / 完成时间），不传整行。
 *     飞书的 batch_update 是按传入的列覆盖写的 —— 传整行会静默盖掉
 *     派发人在你读取之后改的东西（比如他刚改了日期），而且不报错。
 *
 * ============================================================
 * 三、关于「实时」
 *
 * 扩展不是服务端：飞书多维表格的变更事件订阅要公网回调地址或长连接服务端，
 * 浏览器扩展两样都没有。所以到达靠**轮询**（1 分钟一次，见 background.js）。
 * 这不是偷懒 —— 没有服务端的产品做不到推送，业界通行的纯客户端做法就是轮询。
 *
 * ============================================================
 * 四、两张子表，和「一键生成」（v0.33.0）
 *
 * 一个 Base、两张表：
 *   「任务」—— 派出去的活（字段集 TF，10 列）
 *   「组员」—— 名单 + 谁是本人（字段集 PTF，2 列：姓名 / 身份）
 *
 * ★ 为什么名单要进表、不再留在设置页手填：名单和「我是谁」是**全组共有的事实**。
 *   留在每个人的扩展里，就会出现「A 机器上名单是旧的、B 机器上多了个新同事」——
 *   这种不一致零症状，你只会某天发现派错了人，或者新同事一直没收到活。
 * ★ 一键生成的两条入口（provision）：
 *   没填 Base → 新建一个（应用是所有者，所以顺手把链接设成「组织内可编辑」，
 *               否则你在飞书网页里打开只能看、填不了名单）；
 *   填了 Base → 在那个 Base 里补表补列，**绝不新建第二个**。
 * ★ 认表是**ID 优先、名字兜底**（ensureTable）：老大那张表可能改了名，
 *   按名字找会把他的表当成不存在再建一张 —— 数据分家且零报错。
 */
(function (root) {
  "use strict";

  /* 配置：{ on, me, people, appId, appSecret, baseToken, tableId, notifyOn, speakOn } */
  var CFK = "taskboard.inbox";
  /* 收到的任务。★ 与 taskboard.v1 完全隔离，见抬头 ②。 */
  var ITK = "taskboard.inbox.items";
  /* 待提示队列 —— 网页球读这一个 key（ballpage.js 的 onChanged 里挂了它）。
     ★ 单独一个 key 而不是混进 items：items 是「数据」，这是「还没播报的」，
       混在一起的话球一上来就会把历史上所有任务重播一遍。 */
  var PEND = "taskboard.inbox.pending";

  /* 团队表字段名。★ 与个人表（feishu.js 的 F）**不是同一套**，别混用。
     ★★ 「接收人 / 派发人」用**单行文本**（type 1）而不是单选：
        单选的组员名单要靠读字段的 options 拿，而 listFields() 只回
        name/type/uiType（不回 property.options）—— 名单来源断了，
        单选就退化成一个没法维护选项的字段。文本列谁都能写、不依赖选项表。 */
  var TF = {
    title: "任务",
    status: "状态",
    date: "日期",
    note: "备注",
    priority: "优先级",
    localId: "本地ID",
    assignee: "接收人",
    /* ★★ v0.32.0（老大拍板）：派发人**不从设置页手填的那个名字来**，
       而是**读表里那一列「我是谁」** —— 谁往表里填的这条记录，
       那一列写着谁，谁就是派发人。
       ★ 为什么这样更对：以前「我是谁」是本地配置，同一个人在别人机器上的
         扩展里派出来就是另一个名字，而收件方根本无从判断；改读表之后，
         **列的归属感由表格保证**（谁建的这一行谁负责），跟装在哪台机器上无关。
       ★ 兼容两种填法（读取侧统一兜住）：
         ① 文本列（`type 1`）—— 我们一键建表时建的就是这个，API 可写；
         ② 老大在表格里把这一列改成「人员」/「创建人」类型也照样认 ——
            那种字段读回来是 `[{id, name, en_name}]`，取 `name`。
       ★ 旧列 `from`（原「派发人」）降为**回退读取**：老表还没补这一列时照样能读。 */
    who: "我是谁",
    from: "派发人",
    createdAt: "创建时间",
    doneAt: "完成时间"
  };

  /* ---------- 组员表的字段（v0.33.0）----------
     ★★ 为什么名单要单开一张表，而不是继续在设置页手填：
        名单和「我是谁」是**全组共有的事实**。放在每个人的扩展里，就会出现
        「A 机器上名单是旧的、B 机器上多了个新同事」—— 这种不一致零症状，
        你只会某天发现派错了人，或者新同事一直收不到活。
        挪进表里之后，谁加了人，全组下一次轮询就都看得到。
     ★ 用「身份」单选（本人 / 组员）而不是复选框：单选 type 3 是这套 schema 里
        已经跑通的类型，而且表里一眼能看出谁是本人。
     ★ 姓名用**单行文本**，跟任务表的「接收人 / 派发人」同一套写法 ——
        精确匹配、不做模糊（「张伟」和「张伟伟」是两个人）。 */
  var PTF = {
    name: "姓名",
    role: "身份"
  };
  var ROLE_ME = "本人";
  var ROLE_MEMBER = "组员";
  var PEOPLE_SCHEMA = [
    { field_name: PTF.name, type: 1 },
    { field_name: PTF.role, type: 3, property: { options: [{ name: ROLE_ME }, { name: ROLE_MEMBER }] } }
  ];

  /* 两张子表的名字 + 新建 Base 的名字。
     ★ 表名只用于「对应 ID 还没填」时的首次生成 —— 已经填了 ID 的一律认 ID，
       见 ensureTable（按名字找会把老大那张改了名的表当成不存在，再建一张）。 */
  var TASK_TABLE_NAME = "任务";
  var PEOPLE_TABLE_NAME = "组员";
  var BASE_NAME = "任务台 · 团队";

  var STATUS_TEXT = { todo: "待办", doing: "进行中", done: "已完成" };
  var STATUS_BACK = { "待办": "todo", "进行中": "doing", "已完成": "done" };
  var PRIORITY_TEXT = { high: "高", mid: "中" };
  var PRIORITY_BACK = { "高": "high", "中": "mid" };

  /* 建表用的列定义。type：1=文本 3=单选 5=日期 */
  var TEAM_SCHEMA = [
    { field_name: TF.title, type: 1 },
    { field_name: TF.status, type: 3, property: { options: [
      { name: "待办" }, { name: "进行中" }, { name: "已完成" }] } },
    { field_name: TF.date, type: 5, property: { date_formatter: "yyyy/MM/dd", auto_fill: false } },
    { field_name: TF.note, type: 1 },
    { field_name: TF.priority, type: 3, property: { options: [{ name: "高" }, { name: "中" }] } },
    { field_name: TF.localId, type: 1 },
    { field_name: TF.assignee, type: 1 },
    { field_name: TF.who, type: 1 },
    { field_name: TF.createdAt, type: 5, property: { date_formatter: "yyyy/MM/dd HH:mm", auto_fill: false } },
    { field_name: TF.doneAt, type: 5, property: { date_formatter: "yyyy/MM/dd HH:mm", auto_fill: false } }
  ];

  /* 打扰闸门的两个数：8 小时内最多 3 条。
     ★ 为什么是「窗口 + 上限」而不是「每天 1 条」：派发是**别人推给你的**，
       你没法预期它什么时候来，一天一条会把第二条压到明天（那时它多半已经过期了）；
       而完全不限又会变成轰炸。窗口内给额度、超出合并成一条，两头都留了余地。 */
  var WINDOW_H = 8;
  var WINDOW_MAX = 3;

  /* ---------- 存储通道（测试里可整体替换） ---------- */
  var memory = {};
  function chromeStore() {
    return (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
  }
  var defaultStore = {
    get: function (keys) {
      var cs = chromeStore();
      if (cs) {
        return new Promise(function (res) { cs.get(keys, function (o) { res(o || {}); }); });
      }
      var out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
        if (k in memory) out[k] = memory[k];
      });
      return Promise.resolve(out);
    },
    set: function (obj) {
      var cs = chromeStore();
      if (cs) {
        return new Promise(function (res) { cs.set(obj, function () { res(); }); });
      }
      Object.keys(obj).forEach(function (k) { memory[k] = obj[k]; });
      return Promise.resolve();
    }
  };

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function trim(s) { return String(s == null ? "" : s).trim(); }
  function uid() { return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------- 单元格解析（任务表 / 组员表共用）----------
     ★ 抽到顶层而不是各写一份：两张表都要解「单行文本」和「单选」。
       一旦写成两份，漂移的症状是「这张表认得出来、那张表读成 [object Object]」，
       而两条链路的单测各测各的、全绿 —— 又是一次「绿的那边骗了我」。
     ★ sel 递归 + 认对象：单选读回来可能是 "待办"、["待办"] 或
       [{text:"待办"}]，三种形态都得认（飞书不同版本回的不一样）。 */
  function txt(v) {
    if (v == null) return "";
    if (typeof v === "string") return trim(v);
    if (Array.isArray(v)) {
      return v.map(function (x) {
        if (x == null) return "";
        if (typeof x === "string") return x;
        return trim(x.text || x.name || "");
      }).join("").trim();
    }
    return trim(v.text || v.name || "");
  }
  function sel(v) {
    if (Array.isArray(v)) return v.length ? sel(v[0]) : "";
    if (v && typeof v === "object") return trim(v.text || v.name || "");
    return trim(v);
  }

  /* ---------- 配置 ----------
     ★ `on` 严格 true：这个开关决定的是「要不要把你的任务写进一张别人也能看见的表」，
       默认必须关（跟 notify 那条同一个理由：风险不对称，默认值就不该对称）。
     ★ `notifyOn` / `speakOn` 同理默认关 —— 打扰必须先被同意。 */
  function readCfg(v) {
    v = (v && typeof v === "object") ? v : {};
    return {
      on: v.on === true,
      me: trim(v.me),
      people: trim(v.people),
      appId: trim(v.appId),
      appSecret: trim(v.appSecret),
      baseToken: trim(v.baseToken),
      tableId: trim(v.tableId),
      /* ★ v0.33.0：组员表 + 这个 Base 的网页地址。
         ★ peopleTableId 不进 ready()：没有组员表照样能派发（名单走本地缓存那份），
           少一个前置条件就少一种「明明能用却点不动」的死锁。 */
      peopleTableId: trim(v.peopleTableId),
      baseUrl: trim(v.baseUrl),
      /* 上次拉组员表的时间。轮询靠它决定「这一分钟要不要去拉」——
         跟别的字段一样只是个数值，界面上看不见。 */
      peopleAt: Number(v.peopleAt) || 0,
      notifyOn: v.notifyOn === true,
      speakOn: v.speakOn === true
    };
  }

  function ready(cfg) {
    return !!(cfg && cfg.on && cfg.appId && cfg.appSecret && cfg.baseToken && cfg.tableId);
  }

  /* 把飞书同步那边的凭据并进来（v0.32.0）。
     ★ 为什么团队派发**不自己存一份** appId / appSecret：同一个应用身份读写
       团队表，权限点是同一套。存两份的话，用户在「飞书同步」里换了应用，
       团队派发还在用旧的那份 —— 症状是「同步好好的，派发突然报 token 错」，
       而两个功能看起来毫无关系。
     ★ 只在团队这边**没填**时才取同步的：给「团队表用另一个应用」留了口子，
       填了就以填的为准。 */
  function withCred(cfg, syncCfg) {
    var o = readCfg(cfg);
    var s = (syncCfg && typeof syncCfg === "object") ? syncCfg : {};
    if (!o.appId) o.appId = trim(s.appId);
    if (!o.appSecret) o.appSecret = trim(s.appSecret);
    return o;
  }

  /* 造一份「换了表」的 cfg（v0.33.0）。
     ★ feishu.js 的 joinUrl 只读 cfg.baseToken / cfg.tableId，所以浅拷贝一份、
       换掉这两个字段，就能让 listAll / listFields / createField / createRaw
       全部直接对**另一张表**工作 —— 不用给它们各加一个 tableId 参数。
     ★ 为什么不做成「加参数」：多一个参数意味着每个调用点都要想
       「这次传哪张表」，漏传**不会报错**，只会安静地读到任务表里去。
       派生一份 cfg 从根上没有这个问题。 */
  function derived(cfg, appToken, tableId) {
    var o = {};
    Object.keys(cfg || {}).forEach(function (k) { o[k] = cfg[k]; });
    o.baseToken = trim(appToken) || o.baseToken;
    o.tableId = trim(tableId) || o.tableId;
    return o;
  }

  /* 名字匹配：★ 精确、trim 之后比。不做模糊 —— 「张伟」和「张伟伟」是两个人，
     模糊匹配会静默把任务派错人，而这种错没有任何提示。 */
  function sameName(a, b) { return trim(a) === trim(b); }

  /* ---------- 组员名单 ----------
     ★ v0.33.0：名单的**来源是组员表**（见 listPeople），这里读的是它在本地那份
       缓存 —— 断网时照样能派发；不同步只可能发生在网断着的那一小段时间，
       下一次轮询就追平了。
     ★ 精确匹配、不做模糊：「张伟」和「张伟伟」是两个人，模糊匹配会静默派错人，
       而派错这件事没有任何提示。 */
  function peopleOf(cfg) {
    var out = [], seen = {};
    trim(cfg && cfg.people).split(/[,，、;；\n\r]+/).forEach(function (s) {
      var n = trim(s);
      if (n && !seen[n]) { seen[n] = 1; out.push(n); }
    });
    return out;
  }

  /* ---------- 组员表：读（v0.33.0）----------
     表是名单与「我是谁」的**唯一事实源**，本地的 cfg.people / cfg.me
     只是它的缓存（断网时照着用）。
     ★ 为什么读不到要保留原值、而不是清空：一次网络抖动不该把名单清掉 ——
       清掉之后派发下拉会瞬间变空，而原因（「这次没拉到」）按本项目的界面
       约束**一个字都不会显示**，用户只会觉得「名单莫名没了」。 */
  function fromPeopleFields(rec) {
    var f = (rec && rec.fields) || {};
    return { name: txt(f[PTF.name]), role: sel(f[PTF.role]) };
  }

  function fromPeopleRecords(recs) {
    var people = [], me = "", seen = {};
    (recs || []).forEach(function (rec) {
      var p = fromPeopleFields(rec);
      if (!p.name) return;
      if (!seen[p.name]) { seen[p.name] = 1; people.push(p.name); }
      /* 只认第一个「本人」：表里标了两个的话那是编辑事故，
         认表里靠上的那个（跟行序一致），而不是随机认一个。 */
      if (!me && p.role === ROLE_ME) me = p.name;
    });
    return { people: people, me: me };
  }

  function listPeople(cfg) {
    var pid = trim(cfg && cfg.peopleTableId);
    if (!pid) return Promise.reject(new Error("还没配组员表"));
    return Feishu.listAll(derived(cfg, cfg.baseToken, pid)).then(function (recs) {
      var got = fromPeopleRecords(recs);
      /* 时间戳在这儿盖、不在 fromPeopleRecords 里盖：那个是纯解析函数，
         混进 Date.now() 之后就没法写「给定输入必得同一输出」的断言了。 */
      got.at = Date.now();
      return got;
    });
  }

  /* 把读回来的名单并进配置。空结果不动本地（理由见上面那段）。 */
  function applyPeople(cfg, got) {
    var o = readCfg(cfg);
    var p = (got && got.people) || [];
    if (p.length) o.people = p.join("、");
    if (trim(got && got.me)) o.me = trim(got.me);
    /* 记一笔「刚拉过」——轮询靠它判断这一分钟要不要再去拉组员表。
       ★ 只有真读过才盖时间戳：读失败还盖的话，会变成「每 5 分钟才试一次」，
         网断的时候恢复得比预期慢。 */
    if (got && got.at) o.peopleAt = Number(got.at) || o.peopleAt;
    return o;
  }

  /* ---------- 字段转换 ---------- */
  function msOf(dateStr) {
    var s = trim(dateStr);
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }
  function dateOfMs(ms) {
    if (!ms && ms !== 0) return "";
    var d = new Date(ms);
    if (isNaN(d.getTime())) return "";
    return ymd(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  /* 本地那条 task + 派发信息 → 团队表的一行 fields。 */
  function toTeamFields(task, from, to) {
    var t = task || {};
    var f = {};
    f[TF.title] = trim(t.title);
    f[TF.status] = STATUS_TEXT[t.status] || "待办";
    if (t.date) f[TF.date] = msOf(t.date);
    if (trim(t.note)) f[TF.note] = trim(t.note);
    if (t.priority && PRIORITY_TEXT[t.priority]) f[TF.priority] = PRIORITY_TEXT[t.priority];
    f[TF.localId] = trim(t.id) || uid();
    f[TF.assignee] = trim(to);
    /* ★ v0.32.0：写「我是谁」那一列（派发人的唯一落点），不再写旧列「派发人」。
       ★ 旧列仍在表上的话会是空的 —— 没有关系：读取那边把它当回退，读得到就用。 */
    f[TF.who] = trim(from);
    f[TF.createdAt] = Date.now();
    return f;
  }

  /* 团队表的一行 → 本地 inbox 条目。 */
  function fromTeamFields(rec) {
    var f = (rec && rec.fields) || {};
    var lid = txt(f[TF.localId]);
    return {
      id: lid || (rec && rec.recordId) || uid(),
      rid: (rec && rec.recordId) || "",
      title: txt(f[TF.title]),
      date: dateOfMs(f[TF.date]),
      note: txt(f[TF.note]),
      priority: PRIORITY_BACK[sel(f[TF.priority])] || "",
      status: STATUS_BACK[sel(f[TF.status])] || "todo",
      to: txt(f[TF.assignee]),
      /* ★★ v0.32.0：派发人**先读「我是谁」那一列**，空的再回退旧列「派发人」。
         ★ `txt()` 同时兜住「人员 / 创建人」类型（值是 [{id,name}]，取 name）——
           所以老大把这一列改成飞书的「创建人」字段（谁新建这条记录就自动填谁）
           之后，**连填都不用填**，派发人照样认得出来。 */
      from: txt(f[TF.who]) || txt(f[TF.from]),
      at: Date.now()
    };
  }

  /* ---------- 拉取：只留「派给我的」 ----------
     ★★ 这一步是隔离的第一道门：表里全是别人的任务，只有接收人 == me 的才留下。
        不做过滤的话，二十几个人的任务会全灌进你的本地，而且看起来「像是同步来的」。 */
  function mineOnly(items, me) {
    var m = trim(me);
    return (items || []).filter(function (it) { return it && sameName(it.to, m); });
  }

  /* 远端拉回来的 items → 与本已有的合并。
     ★ 按 id 认、不按下标（下标会因为中间删一条整体挪位）。
     ★ 远端删掉的记录：`keep` 为 true 时**保留本地**（P0 不动本地 ——
       删除比保留危险得多：留着顶多是一条多余的任务，删了就找不回来了）。 */
  function mergeItems(local, remote) {
    var byId = {};
    (local || []).forEach(function (x) { if (x && x.id) byId[x.id] = x; });
    var out = (local || []).slice();
    var added = [];
    (remote || []).forEach(function (r) {
      if (!r || !r.id) return;
      var old = byId[r.id];
      if (!old) {
        out.push(r);
        byId[r.id] = r;
        added.push(r);
        return;
      }
      old.title = r.title;
      old.date = r.date;
      old.note = r.note;
      old.priority = r.priority;
      old.status = r.status;
      old.from = r.from;
      old.rid = r.rid;
    });
    return { items: out, added: added };
  }

  /* ---------- 打扰闸门 ----------
     返回 { ok, why, take, merge }。
     ★ why 必须有值：没发通知这件事本身没有任何可见症状，
       只有布尔的话真机上永远只能靠猜（notify.js 那条同款规矩）。 */
  function gate(i) {
    i = i || {};
    if (i.on !== true) return { ok: false, why: "off", take: [], merge: 0 };
    var fresh = i.fresh || [];
    if (!fresh.length) return { ok: false, why: "none", take: [], merge: 0 };
    var now = Number(i.now) || 0;
    var win = WINDOW_H * 3600e3;
    var used = (i.sent || []).filter(function (s) {
      return now - (Number(s.at) || 0) < win;
    }).length;
    var left = WINDOW_MAX - used;
    if (left <= 0) {
      /* 额度用完了：合并成一条，而不是一条都不发（一条都不发的话，
         用户会在任务台里看见新任务、却从没被提醒过 —— 那等于功能没生效）。 */
      return { ok: true, why: "merged", take: [], merge: fresh.length };
    }
    return { ok: true, why: "ok", take: fresh.slice(0, left), merge: fresh.length - Math.min(left, fresh.length) };
  }

  /* ---------- 说什么 ----------
     ★ 不调模型：① service worker 里没有模型；② 它出现在你没看着它的时候，
       措辞必须稳定（notify.js 抬头里那两条在这里同样成立）。
     ★ 日期写成「今天 / 明天 / X月X日」，不写「2026-09-23」——
       通知是一眼扫过去的，让读的人自己算日子等于没说。 */
  function dateWord(dateStr, today) {
    var d = trim(dateStr);
    if (!d) return "";
    var t = trim(today) || todayStr();
    if (d === t) return "今天";
    var td = new Date(t + "T00:00:00");
    var dd = new Date(d + "T00:00:00");
    if (!isNaN(td.getTime()) && !isNaN(dd.getTime())) {
      var diff = Math.round((dd - td) / 86400000);
      if (diff === 1) return "明天";
      if (diff === 2) return "后天";
      if (diff === -1) return "昨天";
    }
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (m) return (+m[2]) + "月" + (+m[3]) + "日";
    return d;
  }

  /* 单条： 「{谁}给你派了个任务：{标题}，要在{什么时候}前完成」 */
  function line(it, today) {
    var x = it || {};
    var who = trim(x.from);
    var what = trim(x.title) || "一个任务";
    var when = dateWord(x.date, today);
    var head = who ? (who + "给你派了个任务") : "收到一个派给你的任务";
    var tail = when ? ("，要在" + when + "前完成") : "";
    return head + "：" + what + tail;
  }

  /* 多条合并： 「{谁}他们派了 N 个任务给你」 */
  function lineMany(items, today) {
    var n = (items || []).length;
    if (n <= 1) return line((items || [])[0], today);
    var names = {}, order = [];
    (items || []).forEach(function (x) {
      var w = trim(x && x.from);
      if (w && !names[w]) { names[w] = 1; order.push(w); }
    });
    var who = order.length ? (order.slice(0, 2).join("、") + (order.length > 2 ? " 等" : "")) : "";
    return (who ? who + "派了 " : "收到 ") + n + " 个任务给你";
  }

  /* ---------- 存储读写 ---------- */
  function loadCfg() {
    return api.store.get([CFK]).then(function (o) { return readCfg(o && o[CFK]); });
  }
  function saveCfg(cfg) {
    var p = {}; p[CFK] = cfg;
    return api.store.set(p).then(function () { return cfg; });
  }
  function loadItems() {
    return api.store.get([ITK]).then(function (o) {
      var v = o && o[ITK];
      return Array.isArray(v) ? v : [];
    });
  }
  function saveItems(items) {
    var p = {}; p[ITK] = items;
    return api.store.set(p).then(function () { return items; });
  }
  /* 已播报过的：{ ids: [...], sent: [{at, id}] } */
  function loadSeen() {
    return api.store.get([PEND]).then(function (o) {
      var v = (o && o[PEND]) || {};
      return {
        ids: Array.isArray(v.ids) ? v.ids : [],
        sent: Array.isArray(v.sent) ? v.sent : [],
        pending: Array.isArray(v.pending) ? v.pending : [],
        at: Number(v.at) || 0
      };
    });
  }
  function saveSeen(s) {
    var p = {}; p[PEND] = s;
    return api.store.set(p).then(function () { return s; });
  }

  /* ---------- 派发：写一条到团队表 ---------- */
  function dispatch(cfg, task, to) {
    if (!ready(cfg)) return Promise.reject(new Error("团队派发没配好"));
    var who = trim(to);
    if (!who) return Promise.reject(new Error("没选接收人"));
    if (!trim(cfg.me)) return Promise.reject(new Error("没填「我是谁」"));
    var fields = toTeamFields(task, cfg.me, who);
    return Feishu.createRaw(cfg, [fields]);
  }

  /* ---------- 拉取一轮：返回 { items, added, fresh } ----------
     ★ 网络失败**向外抛**：调用方（后台）自己决定要不要出声。
        在这里 catch 掉的话，症状是「派了任务对方永远收不到」，
        而日志里干干净净 —— 静默失败比报错难查得多。 */
  function pull(cfg, known) {
    if (!ready(cfg)) return Promise.reject(new Error("团队派发没配好"));
    return Feishu.listAll(cfg).then(function (recs) {
      var all = recs.map(fromTeamFields);
      var mine = mineOnly(all, cfg.me);
      var m = mergeItems(known || [], mine);
      var seenIds = {};
      (known || []).forEach(function (x) { if (x && x.id) seenIds[x.id] = 1; });
      var fresh = m.added.filter(function (x) { return x && x.id && !seenIds[x.id]; });
      /* ★ v0.33.0：这里原来还会「把任务表里出现过的名字并进名单」。
         名单改由组员表提供之后删掉了 —— 留着的话名单就有**两个来源**，
         而这个功能的全部意义就是「名单只有一处、谁加了人全组都看得见」。 */
      return { items: m.items, added: m.added, fresh: fresh };
    });
  }

  /* ---------- 回写：只传状态 / 完成时间 ----------
     ★ 见抬头 ③：传整行会静默盖掉派发人的修改。 */
  function backFields(it) {
    var f = {};
    f[TF.status] = STATUS_TEXT[it.status] || "待办";
    if (it.status === "done") f[TF.doneAt] = Date.now();
    return f;
  }
  function syncBack(cfg, items) {
    if (!ready(cfg)) return Promise.resolve(0);
    var pairs = (items || []).filter(function (x) {
      return x && x.rid && x.done;
    }).map(function (x) {
      return { recordId: x.rid, fields: backFields(x) };
    });
    if (!pairs.length) return Promise.resolve(0);
    return Feishu.updateRaw(cfg, pairs).then(function () { return pairs.length; });
  }

  /* ---------- 一键生成：一个 Base + 两张子表（v0.33.0）----------
     产出：①「任务」—— 派出去的活；②「组员」—— 名单 + 谁是本人。
     两种入口合成同一个动作：
       · 还没填 Base → 新建一个，并把链接设成「组织内拿到链接的人可编辑」。
         ★ 这一步**不需要任何人授权**：文档归应用自己（它是所有者），
           缺的只是「人手动在飞书网页里改」这一件事，而改分享设置就够了。
           不设的话，你在飞书网页打开它只能看，填不了名单。
       · 已经填了 Base → 就在那个 Base 里补表补列，**绝不新建第二个**。
     ★ 幂等：表在就补列、不在才建、列齐就一个写请求都不发。可以反复点。
     ★ 不 throw：分步留痕。一句「生成失败」看不出卡在权限、字段名还是网络，
       所以每一步的成败都记进 steps[]，设置页照着显示就行。
     ★ 「补齐这张表的列」这个旧按钮已经并进来了 —— 它是一键生成的**真子集**
       （表已存在时一键生成干的就是补列）。两个按钮并排只会让人犹豫点哪个。 */
  function provision(cfg, opts) {
    opts = opts || {};
    var steps = [];
    var out = {
      ok: false, error: "",
      baseToken: "", baseUrl: "", created: false,
      tableId: "", peopleTableId: "",
      steps: steps
    };
    function rec(name, ok, detail, optional) {
      steps.push({ name: name, ok: !!ok, detail: detail || "", optional: !!optional });
    }

    var known = trim(cfg && cfg.baseToken);
    var head = known
      ? Promise.resolve({ appToken: known, url: "", fresh: false, defaultTableId: "" })
      : Feishu.createBase(cfg, opts.baseName || BASE_NAME).then(function (b) {
        rec("建了一个新的多维表格", true, b.url || b.appToken);
        return {
          appToken: b.appToken, url: b.url || "",
          fresh: true, defaultTableId: b.defaultTableId || ""
        };
      });

    return head.then(function (b) {
      out.baseToken = b.appToken;
      out.baseUrl = b.url;
      out.created = !!b.fresh;
      if (!b.fresh) rec("用你填的那个多维表格", true, b.appToken);

      return ensureTable(cfg, b.appToken, cfg.tableId, TASK_TABLE_NAME, TEAM_SCHEMA)
        .then(function (r) {
          out.tableId = r.tableId;
          rec((r.created ? "建了" : "用上了") + "「" + TASK_TABLE_NAME + "」子表", true,
            r.added && r.added.length ? ("补上 " + r.added.length + " 列") : "");
        })
        .then(function () {
          return ensureTable(cfg, b.appToken, cfg.peopleTableId, PEOPLE_TABLE_NAME, PEOPLE_SCHEMA);
        })
        .then(function (r) {
          out.peopleTableId = r.tableId;
          rec((r.created ? "建了" : "用上了") + "「" + PEOPLE_TABLE_NAME + "」子表", true,
            r.added && r.added.length ? ("补上 " + r.added.length + " 列") : "");
        })
        .then(function () {
          /* 新 Base 自带一张平台默认表，清掉它 —— 不清的话你打开会看到三张表。
             ★ 只在「这次新建的 Base」上做：你原有 Base 里的表我们一张都不动。 */
          if (!b.fresh || !b.defaultTableId) return null;
          if (b.defaultTableId === out.tableId || b.defaultTableId === out.peopleTableId) return null;
          return Feishu.dropTable(cfg, b.appToken, b.defaultTableId).then(function () {
            rec("清掉平台自带的那张空表", true, "");
          }, function () {
            rec("清掉平台自带的那张空表", false, "没删掉，留着不影响使用", true);
          });
        })
        .then(function () {
          /* 分享设置只改**新建**的 Base：你自己那张表的分享是你的事，我们不碰。 */
          if (!b.fresh) return null;
          return Feishu.setLinkEditable(cfg, b.appToken).then(function () {
            rec("让拿到链接的人能编辑", true, "你和同事在飞书网页里可以直接改这两张表", true);
          }, function (e) {
            rec("让拿到链接的人能编辑", false,
              "没设上（" + ((e && e.message) || "未知原因") + "）。扩展读写不受影响，" +
              "只是你在飞书网页里打开它只能看", true);
          });
        });
    }).then(function () {
      out.ok = true;
      return out;
    }, function (e) {
      out.error = (e && e.message) || String(e);
      rec("中止", false, out.error);
      return out;
    });
  }

  /* 认表：**ID 优先、名字兜底**，然后把缺的列补上。
     ★ 为什么 ID 优先：老大那张团队表可能改了名，按名字找会把他的表当成
       「不存在」再建一张 —— 数据分家（旧表还在写、新表永远是空的），零报错。
     ★ 名字兜底只服务首次生成 —— 那时候还没有 ID 可认。 */
  function ensureTable(cfg, appToken, knownId, name, schema) {
    var id = trim(knownId);
    if (id) {
      return fillFields(cfg, appToken, id, schema).then(function (added) {
        return { tableId: id, created: false, added: added };
      });
    }
    return Feishu.listTables(cfg, appToken).then(function (tables) {
      var hit = (tables || []).filter(function (t) { return trim(t.name) === name; })[0];
      if (hit) {
        return fillFields(cfg, appToken, hit.tableId, schema).then(function (added) {
          return { tableId: hit.tableId, created: false, added: added };
        });
      }
      return Feishu.createTable(cfg, appToken, name, schema).then(function (tid) {
        return { tableId: tid, created: true, added: [] };
      });
    });
  }

  /* 表里缺哪列建哪列，返回建上的列名。
     ★ 一列失败不中断，剩下的接着建：中途 return 会让「第三列失败」变成
       「后面七列都没建」，而报告里只写一条原因，看起来像只缺一列。 */
  function fillFields(cfg, appToken, tableId, schema) {
    var d = derived(cfg, appToken, tableId);
    return Feishu.listFields(d).then(function (fields) {
      var by = {};
      (fields || []).forEach(function (f) { by[f.name] = f; });
      var missing = (schema || []).filter(function (fd) { return !by[fd.field_name]; });
      var added = [];
      var i = 0;
      function step() {
        if (i >= missing.length) return Promise.resolve(added);
        var fd = missing[i++];
        return Feishu.createField(d, fd).then(function () {
          added.push(fd.field_name);
          return step();
        }, function () {
          return step();   /* 失败也往下走，原因由上层按「缺了哪列」体现 */
        });
      }
      return step();
    });
  }

  var api = {
    CFK: CFK, ITK: ITK, PEND: PEND,
    TF: TF, TEAM_SCHEMA: TEAM_SCHEMA,
    PTF: PTF, PEOPLE_SCHEMA: PEOPLE_SCHEMA, ROLE_ME: ROLE_ME,
    TASK_TABLE_NAME: TASK_TABLE_NAME, PEOPLE_TABLE_NAME: PEOPLE_TABLE_NAME,
    WINDOW_H: WINDOW_H, WINDOW_MAX: WINDOW_MAX,
    store: defaultStore,
    readCfg: readCfg,
    ready: ready,
    withCred: withCred,
    derived: derived,
    sameName: sameName,
    peopleOf: peopleOf,
    fromPeopleFields: fromPeopleFields,
    fromPeopleRecords: fromPeopleRecords,
    listPeople: listPeople,
    applyPeople: applyPeople,
    toTeamFields: toTeamFields,
    fromTeamFields: fromTeamFields,
    mineOnly: mineOnly,
    mergeItems: mergeItems,
    gate: gate,
    dateWord: dateWord,
    line: line,
    lineMany: lineMany,
    loadCfg: loadCfg,
    saveCfg: saveCfg,
    loadItems: loadItems,
    saveItems: saveItems,
    loadSeen: loadSeen,
    saveSeen: saveSeen,
    dispatch: dispatch,
    pull: pull,
    backFields: backFields,
    syncBack: syncBack,
    provision: provision,
    ensureTable: ensureTable,
    todayStr: todayStr,
    uid: uid
  };

  root.Inbox = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
