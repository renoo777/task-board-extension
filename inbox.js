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
 *   「组员」—— 名单 + 谁是本人（字段集 PTF，3 列：姓名 / 成员 / 身份）
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
 *
 * ============================================================
 * 五、归属：这张表得是你自己的（v0.34.0）
 *
 * 应用（tenant_access_token）建的云文档**归应用自己**，人在飞书里只是
 * 「被邀请的协作者」。上一版靠 setLinkEditable 让人**能改**，但所有者仍然不是他：
 * 看不到管理入口、改不了权限、也移不走。老大真机的原话是
 * 「我的飞书账号没有编辑跟管理权限，我需要一键创建多维表格，多维表格的归属人是我」。
 * ⇒ 只有转移所有者一条路，见 Feishu.transferOwner。
 *
 * ★ 「我是谁」在这里有**两个来源**，谁先有就用谁：
 *   a) 配置里的「我的飞书邮箱」—— 建表那一刻就有，一次到位；
 *   b) 组员表里标「本人」那行的人员字段 open_id —— 首次生成时表是空的，
 *      只能等他填完再点一次（幂等，可以反复点）。
 *   两个都没有**不影响任何功能**：扩展读写这张表本来就不依赖归属。
 *
 * ★★ 为什么组员表非要有「成员」这个**人员字段**（type 11）：
 *   只有它带 open_id。派发对象本身只要名字就够（文本列也能存），
 *   但「把这表转给本人」「以后给他发飞书消息」都要 open_id ——
 *   文本列做不到，等到需要时再补一个字段，存量数据就得人手重填一遍。
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
  /* 用过的团队表**存档**（v0.35.0）。
     ★ 为什么需要它（老大真机原话：「如果我已经填了多维表格我不小心删掉了，
       那我怎么知道我之前填的是哪一张团队的多维表格？可以留一个存档」）：
       飞书那边删表**不会通知任何人**，扩展手里的 baseToken 也不会自己变 ——
       表没了之后，设置页上能看到的只有两串长得一模一样的 token，
       谁也认不出哪串对的是哪张表。
     ★ 为什么另开一个 key、不并进配置：它是一份**历史**（数组、有上限、
       只增不减），并进配置会让每次读-改-写都多背一段它管不着的数据。
       自定义形象库（`taskboard.mc.customs`）也是这么分的。 */
  var LOGK = "taskboard.inbox.log";

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

  /* ---------- 组员表的字段（v0.33.0 / v0.34.0）----------
     ★★ 为什么名单要单开一张表，而不是继续在设置页手填：
        名单和「我是谁」是**全组共有的事实**。放在每个人的扩展里，就会出现
        「A 机器上名单是旧的、B 机器上多了个新同事」—— 这种不一致零症状，
        你只会某天发现派错了人，或者新同事一直收不到活。
        挪进表里之后，谁加了人，全组下一次轮询就都看得到。
     ★ 用「身份」单选（本人 / 组员）而不是复选框：单选 type 3 是这套 schema 里
        已经跑通的类型，而且表里一眼能看出谁是本人。
     ★★ v0.34.0：「成员」是一列**人员字段**（type 11）—— 老大原话
        「这个成员要从多维表格的**成员字段**里面去拉」。
        ★ 为什么必须是人员类型、不能再开一列文本：人员字段存的是飞书用户对象
          `[{id:"ou_xxx", name:"张三"}]`，那个 `id` 就是 open_id。有了 open_id 才能
          ① 把这张多维表格的**归属转给本人**（transfer_owner 要 open_id/邮箱）；
          ② 以后要发飞书消息通知也只差一步。文本列只有一个名字，这两件事都做不到。
        ★ 姓名列**仍然留着**，而且它有第二个身份：它是**初始索引字段**——
          索引字段只支持 文本/数字/日期/电话/超链接/公式/地理位置，
          **人员不在其中**（单选也不在，这条 v0.33.0 已经踩过一次：1254012）。
          所以索引列只能是文本，人员字段只能排第二。
        ★ 姓名列**可以留空**：人员字段自己带 name，读取时兜住（见 fromPeopleFields）——
          这样填表的人只需在下拉里选一次人，不用再手打一遍名字。 */
  var PTF = {
    name: "姓名",
    member: "成员",
    role: "身份"
  };
  var ROLE_ME = "本人";
  var ROLE_MEMBER = "组员";
  var PEOPLE_SCHEMA = [
    { field_name: PTF.name, type: 1 },
    /* ★ property.multiple:false —— 这一列**只该是一个人**。默认是 true（允许多选），
       不显式关掉的话，下拉里能勾一串人，而「接收人」在整条链路上都是单值：
       读取只取第一个（userOf），于是表里选了三个、派发只认一个，零报错。 */
    { field_name: PTF.member, type: 11, property: { multiple: false } },
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

  /* ---------- 人员字段解析（v0.34.0）----------
     ★ 跟 txt/sel 一起放在顶层：**任务表和组员表都要解人员字段**
       （任务表的「我是谁」允许被老大改成人员/创建人类型，见 TF.who 那段）。
       写成两份的话，漂移的症状是「组员表认得出来、任务表读成 [object Object]」，
       而两条链路的单测各测各的、全绿 —— 又是一次「绿的那边骗了我」。
     ★ 认三种形态（飞书不同版本回的不一样，跟 sel 那条同一个理由）：
       ① `[{id:"ou_x", name:"张三"}]` —— 现行文档里的样子；
       ② `[{open_id:"ou_x", name:"张三"}]` —— 少数版本拿 open_id 当键名；
       ③ `{id:"ou_x"}` / 裸字符串 `"ou_x"` —— 手写测试数据里就是这么给的。
     ★ 只回**第一个**：组员表的「成员」列是单值（multiple:false），任务表的
       「我是谁」也只该有一个人。多个人是编辑事故，取靠上的那个（跟行序一致），
       而不是随机认一个。
     ★ 姓名与 id **分开回**：要 id 的地方（转移归属）不能因为姓名读到了就以为拿到 id 了，
       这两个字段的可得性没有任何关系。 */
  function userOf(v) {
    var arr = Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
    for (var i = 0; i < arr.length; i++) {
      var x = arr[i];
      if (x == null || x === "") continue;
      if (typeof x === "string") return { id: trim(x), name: "" };
      var id = trim(x.id || x.open_id || x.openId || "");
      var nm = trim(x.name || x.en_name || "");
      if (id || nm) return { id: id, name: nm };
    }
    return { id: "", name: "" };
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
      /* ★★ v0.34.0：「我的飞书邮箱」。**只为一件事服务** —— 把一键生成出来的
         那张多维表格的归属转给本人（见 Feishu.transferOwner）。
         ★ 为什么需要它、而不是「从组员表读自己的 open_id」：
           组员表是**建表之后**才填的，而转移归属要发生在**建的那一次**；
           只走组员表的话，老大必须「点一次 → 去飞书填 → 再点一次」。
           邮箱是唯一能在第一次就把归属做对的凭据（transfer_owner 认 email）。
         ★ 留空也**不算错**：那时回退到「读组员表里标『本人』那行的人员字段」，
           只是要多点一次。两条路都在，谁先有就用谁。 */
      ownerMail: trim(v.ownerMail),
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
    var u = userOf(f[PTF.member]);
    return {
      /* ★ v0.34.0：姓名的**两个来源**，文本列优先、人员字段兜底。
         顺序不能反：可能两个人重名、而人员字段选得又不一样 ——
         文本列是填表的人**手打**的那一个，那是他认定要显示的名字。 */
      name: txt(f[PTF.name]) || u.name,
      role: sel(f[PTF.role]),
      /* open_id（或裸邮箱/手机号那串）。**只在这一行**能拿到 ——
         它是「把这张表转给本人」和「以后给他发飞书消息」的唯一凭据。 */
      uid: u.id
    };
  }

  function fromPeopleRecords(recs) {
    var people = [], me = "", meId = "", seen = {};
    (recs || []).forEach(function (rec) {
      var p = fromPeopleFields(rec);
      /* 姓名与人员字段**都没有**的行跳过：那是一行空记录（新建 Base 里常有一条），
         把它当成组员会往派发下拉里塞一个空字符串选项。 */
      if (!p.name) return;
      if (!seen[p.name]) { seen[p.name] = 1; people.push(p.name); }
      /* 只认第一个「本人」：表里标了两个的话那是编辑事故，
         认表里靠上的那个（跟行序一致），而不是随机认一个。 */
      if (!me && p.role === ROLE_ME) { me = p.name; meId = p.uid; }
    });
    return { people: people, me: me, meId: meId };
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
      /* ★ v0.34.0：这张表最后归谁。ownerDone 给设置页改回执用
         （「两张子表都好了」→「两张子表都好了，这张表归你了」）；
         ownerWhy 只在真的要转却没转成时有值。 */
      ownerDone: false, ownerWhy: "",
      /* ★ v0.35.0：「你原来记的那个数据表已经不在了，改用/重建了一张」这类
         必须让用户知道的事。它是**提示**不是失败 —— 表换掉不影响能不能用，
         但不说的话用户只看到「生成好了」，而他那张表已经悄悄换了人。 */
      note: "",
      steps: steps
    };
    function rec(name, ok, detail, optional) {
      steps.push({ name: name, ok: !!ok, detail: detail || "", optional: !!optional });
    }
    /* 认表那两步各自可能带一句 note（任务表 / 组员表各一张），都留下。 */
    function keepNote(r) {
      if (r && r.note) out.note = out.note ? (out.note + "；" + r.note) : r.note;
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

      /* ---------- 认人（v0.36.0）----------
         三级兜底，**顺序即优先级**：明确指认 > 老大自己填的表 > 推断。
         ★ 为什么第三级可以「零配置」：应用是自建应用，登记时必然绑了所有者，
           而那个人就是老大的账号 —— 实测它与文档域身份是同一个 open_id
           （证据见 feishu.js appOwner 那段）。所以不填任何东西也能认出人。 */
      function ownerTarget(appToken) {
        var mail = trim(cfg && cfg.ownerMail);
        if (mail) return Promise.resolve({ mt: "email", mid: mail, src: "邮箱" });
        var fromPeople = out.peopleTableId
          ? Feishu.listAll(derived(cfg, appToken, out.peopleTableId)).then(function (recs) {
              var meId = fromPeopleRecords(recs).meId;
              /* ★ member_type 按 id 前缀判，不写死 "openid"：老大在组员表里
                 填的可能是裸 user_id，写死的话飞书会回「成员不存在」，
                 而 id 明明是对的 —— 人会往权限上想。 */
              return meId ? { mt: Feishu.memberTypeOf(meId), mid: meId, src: "组员表" } : null;
            }, function () { return null; })
          : Promise.resolve(null);
        return fromPeople.then(function (t) {
          if (t) return t;
          /* 第三级。**失败不抛出** —— 认不出人是这条链路本来就允许的结果
             （三处都没配 / 应用查不到自己），不该让整步炸掉。
             ★ 也**不看 b.fresh**：认人这件事跟你填没填 baseToken 无关。 */
          return Feishu.appOwner(cfg).then(function (ow) {
            return (ow && ow.id)
              ? { mt: Feishu.memberTypeOf(ow.id), mid: ow.id, src: "应用" }
              : null;
          }, function () { return null; });
        });
      }

      /* 转移之后**回读**表上的所有者，确认真的转成了这个人。
         ★★★ 为什么非回读不可：「接口返回 code=0」与「所有者真变成了他」是两件事。
           v0.34.0 只信返回值就报了成功，老大这次正好撞上（铁律 523 记的误判）。
         ★ 为什么 id 来源才比对、邮箱来源不比对：回读拿到的**永远是 id**，
           邮箱那把是邮箱 —— 两者不可能相等，硬比会把每一次成功都报成失败。
           要拿邮箱换 id 得走通讯录接口，而实测这个应用对通讯录没有权限。
           所以邮箱那条只验「读到了、而且不是应用自己」。
         ★ 回读失败**不当失败**：它只说明「验不了」，把原因带出去让设置页照实说。 */
      function verifyOwner(appToken, tgt) {
        return Feishu.docOwner(cfg, appToken).then(function (own) {
          var got = trim(own && own.id);
          var want = trim(tgt && tgt.mid);
          /* 应用自己的 id 是 cli_… —— 回读到它 = 归属**根本没转出去**，真失败。 */
          var isApp = /^cli_/.test(got);
          if (tgt && tgt.mt === "email") return { ok: !!got && !isApp, got: got };
          return { ok: !!got && !!want && got === want, got: got };
        }, function (e) {
          return { ok: false, got: "", why: (e && e.message) || "读不出来" };
        });
      }

      /* 所有者 id 是 34 位的串（`ou_` + 32 hex），原样打进设置页会把那一行撑开、
         把真正的信息（到底转给谁了）挤没。缩成 前 8 + 后 4。 */
      function shortId(v) {
        var s = trim(v);
        return s.length > 14 ? (s.slice(0, 8) + "\u2026" + s.slice(-4)) : s;
      }

      return ensureTable(cfg, b.appToken, cfg.tableId, TASK_TABLE_NAME, TEAM_SCHEMA)
        .then(function (r) {
          out.tableId = r.tableId;
          keepNote(r);
          rec((r.created ? "建了" : "用上了") + "「" + TASK_TABLE_NAME + "」子表", true,
            r.note || (r.added && r.added.length ? ("补上 " + r.added.length + " 列") : ""));
        })
        .then(function () {
          return ensureTable(cfg, b.appToken, cfg.peopleTableId, PEOPLE_TABLE_NAME, PEOPLE_SCHEMA);
        })
        .then(function (r) {
          out.peopleTableId = r.tableId;
          keepNote(r);
          rec((r.created ? "建了" : "用上了") + "「" + PEOPLE_TABLE_NAME + "」子表", true,
            r.note || (r.added && r.added.length ? ("补上 " + r.added.length + " 列") : ""));
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
        })
        .then(function () {
          /* ★★★ v0.34.0：把这张多维表格的**归属**转给本人。
             ★★ 为什么非做不可：应用建的文档**归应用自己**，你在飞书里只是
               「被邀请的协作者」—— 上一版的 setLinkEditable 只让你**能改**，
               但所有者仍然不是你（看不到管理入口、改不了权限、移不走它）。
             ★ 为什么放在整条链路**最后**：前面任何一步挂了都不该动归属 ——
               一张列都没补全的表先转出去，出问题时应用就不好收拾了。
             ★★★ v0.36.0 认人升成**三级零配置兜底**（实现见 ownerTarget）：
               a) 配置里的「我的飞书邮箱」—— 建表那一刻就有，一次到位；
               b) 组员表里标「本人」那行的人员字段 —— 首次生成时表是空的，
                  只能等他填完再点一次（幂等，可以反复点）；
               c) 应用在开放平台登记的**所有者** —— 零配置，不用填任何东西。
             ★ 为什么 c 排在最后：它最省事，但语义上离「本人」最远
               （登记所有者理论上可以和日常账号不是一个人）。前两级是**明确指认**，
               能指认就轮不到推断。
             ★★ 为什么**不看 b.fresh**、每次都试着转：
               你这个 Base 可能是应用以前建的（那应用就是所有者，该转），
               也可能是你自己在飞书里建的（那本来就是你的，不该转）——
               这两种情况下 baseToken 都已填、fresh 都是 false，**从 fresh 分不出来**。
               而多试一次的代价只是一个请求：不是所有者时飞书回 1063002，
               我们回读一次真实所有者（见下），而不是瞎猜。 */
          return ownerTarget(b.appToken);
        })
        .then(function (tgt) {
          if (!tgt) {
            /* 认不出人。**v0.36.0 起不再只在「这次新建的」才吭声** ——
               复用你那张表时这一步原来是静默跳过，症状就是老大那句
               「新建的表格权限还是没有我」，而他根本不知道去哪儿找原因。
               ★ 归属仍是**可选**步骤：没转成不影响任何功能（扩展读写不依赖它），
                 所以记 optional，不让它把「一键生成」整体染成失败。 */
            rec("把这张表转成你的", false,
              "还认不出你是谁：在「" + PEOPLE_TABLE_NAME + "」里给自己那行选上「成员」、" +
              "身份标「本人」；或者在「我的飞书邮箱」里填一下你的邮箱 —— 然后**再点一次这个按钮**",
              true);
            return null;
          }
          return Feishu.transferOwner(cfg, b.appToken, tgt.mt, tgt.mid).then(function () {
            /* ★★★ 转完**必须回读**：「接口回 code=0」只说明这次请求被接受了，
               不说明所有者真的变成了目标 —— 它们是两件事。 */
            return verifyOwner(b.appToken, tgt).then(function (v) {
              if (v.ok) {
                out.ownerDone = true;
                out.ownerWhy = "";
                rec("这张表现在归你了", true,
                  (tgt.src === "邮箱" ? "" : "从" + tgt.src + "认出了你") +
                  (v.got ? "（所有者 " + shortId(v.got) + "）" : ""), true);
                return null;
              }
              /* 转出去了，但表上的所有者不是他 —— **真失败**，而且是最难自己发现的
                 那一种（接口明明回了成功）。把真实所有者报出来，别让人对着「成功」干瞪眼。 */
              out.ownerDone = false;
              out.ownerWhy = "转给了 " + shortId(tgt.mid) + "，但表上的所有者是 " +
                (v.got ? shortId(v.got) : (v.why || "读不出来"));
              rec("把这张表转成你的", false, out.ownerWhy, true);
              return null;
            });
          }, function (e) {
            /* ★ 1063002 = 「调用身份不是这张表的所有者」。两种成因都**不是故障**：
               ① 这张表本来就是你自己建的；② 上次已经转成功了（转完应用就不再是所有者）。
               ★★ v0.36.0 的改法：**回读一次真实所有者**（原来是静默 return null）——
                 因为「本来就归你」和「其实归了别人」在这个错误码上长得一模一样，
                 静默跳过等于把后者也一起盖住。回读到的 id 直接写进日志，归谁一目了然；
                 它仍然记成 **ok 的可选步骤**（归属不影响任何功能）。
               ★ 只有其它原因（网络 / 参数）才算失败，而且同样是可选步骤。 */
            var code = e && e.code;
            var msg = (e && e.message) || "未知原因";
            var notOwner = (code === 1063002) || /permission denied|不是.*所有者|所有者/i.test(msg);
            if (!notOwner) {
              out.ownerWhy = msg;
              rec("把这张表转成你的", false, msg, true);
              return null;
            }
            return Feishu.docOwner(cfg, b.appToken).then(function (own) {
              var got = trim(own && own.id);
              var isMine = !!(tgt && tgt.mid && got && got === trim(tgt.mid));
              /* 1063002 的意思就是「应用不是这张表的所有者」= 这表已经不在应用名下了。
                 回读到的 id 直接摆出来：是你就最好，不是你也至少知道该找谁。
                 ★ 不写「（就是你）」以外的判断 —— 目标是邮箱时两边形态不同、
                   根本比不了，硬下结论就会把「其实归了你」说成「归了别人」。 */
              rec("这张表已经不在应用名下了", true,
                got ? ("所有者 " + shortId(got) + (isMine ? "（就是你）" : ""))
                    : "读不出所有者",
                true);
              return null;
            }, function () { return null; });
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
     ★★ v0.35.0 修（老大真机原话：「团队多维表格生成报错没生成成功：
       TableIdNotFound（错误码 1254041）」）：
       老写法只在 ID 为**空**时才去找名字 —— ID 有值就拿着它直接调 `/fields`。
       而 ID **有值也可能已经失效**：表被删了 / Base 换过了 / 那串压根不是
       这个 Base 里的表（手填 token 时串台）。那时飞书回 1254041，
       **整条一键生成就地中止**，用户看到的是飞书那句英文原文加一个错误码 ——
       既不知道发生了什么，也不知道下一步该做什么。
       ⇒ 改成**先列出这个 Base 里真实存在的表**（一次请求），再决定认哪个：
         ① 存下来的 ID 真在里面 → 用它（老行为，一个字不变）；
         ② 不在、但有同名的 → 用同名的；
         ③ 都不在 → 建一张新的。
     ★★ ②③ 必须**带一句话回去**（note）：静默换表是本项目最忌讳的一类失败 ——
       旧表还在写、新表永远是空的，而用户以为一切正常。宁可多一次请求、
       多一句回执，也不让「表被换掉了」这件事无声发生。
     ★ 代价：每次一键生成多一次 listTables（首次生成本来也要调它）。
       一键生成是低频动作，这点请求换「不再撞 1254041」很划算。

     返回 { tableId, created, added, note }。 */
  function ensureTable(cfg, appToken, knownId, name, schema) {
    var id = trim(knownId);
    return Feishu.listTables(cfg, appToken).then(function (tables) {
      var list = tables || [];
      /* ① 存下来的 ID 真的在这个 Base 里 → 用它。
         ★ 这一条是**唯一**能让后面 fillFields 拿到 ID 的入口 ——
           正是它把 1254041 从根上挡掉：不再有「拿着没核对过的 ID 就去调接口」。 */
      var alive = id ? list.filter(function (t) {
        return trim(t.tableId) === id;
      })[0] : null;
      if (alive) {
        return fillFields(cfg, appToken, id, schema).then(function (added) {
          return { tableId: id, created: false, added: added, note: "" };
        });
      }
      /* 那句话里带上**失效的那个 ID 原文**：用户能拿它去对上存档里那一条，
         这是「原来我用的是哪张表」唯一的闭环。 */
      var gone = id ? ("原来记的那个数据表（" + id + "）已经不在这个多维表格里了，") : "";
      var hit = list.filter(function (t) { return trim(t.name) === name; })[0];
      if (hit) {
        return fillFields(cfg, appToken, hit.tableId, schema).then(function (added) {
          return { tableId: hit.tableId, created: false, added: added,
            note: gone + "改用同名的「" + name + "」表" };
        });
      }
      return Feishu.createTable(cfg, appToken, name, schema).then(function (tid) {
        return { tableId: tid, created: true, added: [],
          note: gone + "重新建了一张「" + name + "」表" };
      });
    }, function (e) {
      /* ★ 连表都列不出来 = **这个 Base 本身打不开**（被删了 / token 不对 /
         应用没权限）。这时**绝不自动新建**：自动新建会在这个人的飞书里
         凭空多出一张表，还得他自己去收；而他原来的表很可能只是躺在回收站里
         或者只是权限掉了。给他一句能照着做的话就够了 —— 清空「表链接」再点一次。
         ★ 保留原错误的 code：设置页/诊断要看得出底下是 1254003 还是 1063002。 */
      var e2 = new Error("打不开你填的这个多维表格（" + ((e && e.message) || "未知原因") +
        "）。如果它已经在飞书里被删了，把「表链接」那一格清空再点一次「一键生成」，会新建一个");
      e2.code = e && e.code;
      throw e2;
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
    CFK: CFK, ITK: ITK, PEND: PEND, LOGK: LOGK,
    TF: TF, TEAM_SCHEMA: TEAM_SCHEMA,
    PTF: PTF, PEOPLE_SCHEMA: PEOPLE_SCHEMA, ROLE_ME: ROLE_ME, ROLE_MEMBER: ROLE_MEMBER,
    TASK_TABLE_NAME: TASK_TABLE_NAME, PEOPLE_TABLE_NAME: PEOPLE_TABLE_NAME,
    WINDOW_H: WINDOW_H, WINDOW_MAX: WINDOW_MAX,
    store: defaultStore,
    readCfg: readCfg,
    ready: ready,
    withCred: withCred,
    derived: derived,
    sameName: sameName,
    userOf: userOf,
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
