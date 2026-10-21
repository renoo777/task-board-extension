/* 任务台 · 团队任务派发（v0.33.0）
 *
 * 一句话职责：把「我派给别人的任务」写进一个**团队共用**的飞书多维表格，
 * 并从那里把「别人派给我的」拉回来，提醒我。
 * 那个 Base 里有两张子表：一张存任务，一张存**组员名单**（纯名单，见下）。
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
 *   「任务」—— 派出去的活（字段集 TF，12 列）
 *   「组员」—— **纯名单**（字段集 PTF，2 列：姓名 / 成员）
 *
 * ★★★ v0.41.0：组员表**不再有「身份」列**（原「本人 / 组员」单选）。
 *   老大原话：「『身份：本人』不应该写入到多维表格 —— 团队成员共用这个多维表格，
 *   『本人』是我还是他？写进去不合理」。
 *   ⇒ 语义层的错：**「本人」是每个客户端私有的判断，不是全组共有的事实。**
 *     A 打开看到「本人」指的是 A，B 打开看到指的是 B，写进共享表就没有意义。
 *   ⇒ 替代：「我是谁」**只由 open_id 答**（应用所有者那个账号，零配置就有），
 *     组员表的「成员」人员字段负责把 open_id 解析成人名。见 `resolveMe`。
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
 *   b) 应用的**登记所有者** open_id（`resolveMe` 的 b/c 级）—— 零配置，
 *      而且组员表里若有这个人，人员字段还能把 open_id 解析成人名。
 *   ★ v0.41.0 之前这里还写着「组员表里标『本人』那行」—— 那条已经不存在了。
 *   两个都没有**不影响任何功能**：扩展读写这张表本来就不依赖归属。
 *
 * ★★ 为什么组员表非要有「成员」这个**人员字段**（type 11）：
 *   只有它带 open_id。派发对象本身只要名字就够（文本列也能存），
 *   但「把这表转给本人」「以后给他发飞书消息」都要 open_id ——
 *   文本列做不到，等到需要时再补一个字段，存量数据就得人手重填一遍。
 *
 * ============================================================
 * 六、派发闭环：从「写出去就断了」到「随时答得出三个问题」（v0.39.0）
 *
 * 老大原话：「也不确定有没有派发成功，对方有没有接收到，我也不知道。
 * 整个交互都不够完善，逻辑也不够清晰。」—— 这三句话各自对应一处**真实缺失**：
 *   · 成功只弹一句 2 秒就消失的 toast，之后不留任何痕迹（`recordId` 拿到就丢）；
 *   · 「对方收到没」**没有回执链路**（收件侧不回传、派发侧也不回读）；
 *   · 没有「我派出去的」视图（`mineOnly` 只留「接收人 == 我」）。
 *
 * ★★★ 一句话概括：**派发原来是一条单向的路，写出去就断了**。这一版把它接回来：
 *   `recordId` 落账（`t.assign.rid`）→ 轮询时顺手筛出「我派出去的」
 *   （`outboxOf`，与 `mineOnly` **并列**）→ 快照落 `OUTK` → popup 按 `rid`
 *   并回本地 `t.assign.st`（`applyOutbox`，单调递增）。
 *
 * ★ 三条不变量（改这块之前先读它们）：
 *   ① `mineOnly` **一行不改** —— 收件箱条数不许漂移（有判据钉着）；
 *      `outboxOf` 是并列的第二路，两者互补：同一条记录只可能落在其中一边。
 *   ② 状态**单调递增**（`laterState`）：两个来源必然不同步，
 *      让「最新」赢就会出现「已完成 → 待办」这种倒退 —— 倒退比停滞更糟。
 *   ③ 状态词只有 `ST_TEXT` **一处**；界面**绝不出现英文字母状态码**。
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
  /* 「我派出去的」那一行的**回读快照**（v0.39.0）。
     ★★ 为什么另开一个 key，而不是让后台顺手改本地任务数组（`taskboard.v1`）：
       写任务数组的**只有 popup**（用户每次编辑都会整数组读-改写）。
       后台轮询若也去改写同一个数组，两边并发就会丢更新 ——
       而那种丢法**零报错**（后写的那份覆盖前一份，谁都不知道少了一条任务）。
       ⇒ 后台只写这个 key（单一写入者 = 后台），popup 读它、把状态并回自己的
         任务数组（单一写入者 = popup）。两个 key、两个写入者，不存在竞争。 */
  var OUTK = "taskboard.inbox.outbox";

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
    doneAt: "完成时间",
    /* ---------- ★★ v0.39.0：两个**可选新列**（见 `TF_OPT`）----------
       ★ 为什么叫「可选」：`provision` 给新表会建它们、老表点一次「一键生成」也会补上，
         但**没有它们功能照常跑**（P0 不读也不写这两列）。
       ★★★ 为什么绝不能进 `TF_REQ`：那是 v0.38.1 的现场 ——
         「你的表 10 列一个不缺，却被指去修一个本就不该有的列」。
         新列若进必检，**所有老表立刻被判「缺列」**，同一个 bug 原地复发。
         ⇒ 可选新列 = 只进 `TEAM_SCHEMA`（建表）+ `TF`（读写视图），不进必检。
       ★ `deliver` 的用处：接收人**没装扩展**时，表格是他唯一能看见的界面；
         `notifyAt` 记飞书消息发出时间（P1 才写）。 */
    deliver: "送达状态",
    notifyAt: "通知时间"
  };

  /* ---------- ★★★ v0.38.1：把「列」的三种语义拆开 ----------
     一个 `TF` 原来被三处按各自的需要解释，它们**必然**会互相矛盾：
       ① 建表     —— `TEAM_SCHEMA`（只建该有的那几列）
       ② 读写     —— `TF`（含兼容用的旧列名）
       ③ 必检     —— **「测试连接」时判「这张表能不能用」**
     ③ 直接拿了 ② 的全量（`Object.keys(Inbox.TF)`），于是要求一张
     **我们自己都不会建**的表结构 —— `TEAM_SCHEMA` 里根本没有「派发人」，
     而 `from` 早在 v0.32.0 就降级成了「老表还没补这一列时照样能读」。
     ⇒ 症状（老大 2026-09-25 真机原话）：
         「连上了，但这张表还不能用：表里还缺这些列：派发人」
         —— 他的团队表 10 列**一个不缺**，唯独没有一个**本就不该有**的列。

     拆法：一份定义（`TF`）＋ 两个派生视图。谁要问「能不能用」只许读 `TF_REQ`。 */

  /* **兼容列** —— 只用于「回退读取」的旧列名。缺了照常用，不进建表、不进必检。
     ★ 键名与 `TF` 一一对应（值就是真实列名），这样 `TF_REQ` 能直接算出来。 */
  var TF_LEGACY = { from: 1 };

  /* **可选新列**（v0.39.0）—— 我们会建、会读写，但**缺了不算这张表不可用**。
     ★★ 为什么另开一个集合、而不是并进 `TF_LEGACY`：
       `TF_LEGACY` 的语义是「**旧**列名，只用于回退读取」（`from` 那种），
       这两个是**新**列，语义正相反。并进去的话，将来有人清理老列时会
       顺手把新列一起删掉 —— 而症状是「对方的状态永远同步不回来」，零报错。
     ★★★ 为什么它们不进 `TF_REQ`：见上面 v0.38.1 那段。缺了照常用。 */
  var TF_OPT = { deliver: 1, notifyAt: 1 };

  /* **必需列** = `TF` 减去兼容列、再减去可选新列。**判据只有这一处。**
     ★ 别在别处再抄一份清单、也别再遍历 `TF` 来问「缺不缺列」——
       原来 `background.js` 的 `Object.keys(Inbox.TF)` 就是那个 bug 的现场。 */
  var TF_REQ = (function () {
    var o = {};
    Object.keys(TF).forEach(function (k) {
      if (!TF_LEGACY[k] && !TF_OPT[k]) o[k] = TF[k];
    });
    return o;
  })();

  /* ---------- 组员表的字段（v0.33.0 / v0.34.0）----------
     ★★ 为什么名单要单开一张表，而不是继续在设置页手填：
        名单和「我是谁」是**全组共有的事实**。放在每个人的扩展里，就会出现
        「A 机器上名单是旧的、B 机器上多了个新同事」—— 这种不一致零症状，
        你只会某天发现派错了人，或者新同事一直收不到活。
        挪进表里之后，谁加了人，全组下一次轮询就都看得到。
     ★ 用「身份」单选（本人 / 组员）来指认「哪一行是我」的做法**已在 v0.41.0 撤掉**，
       理由与替代方案见上面 `PTF` 那段 —— 一句话：共享表里放不下「私有视角」。
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
  /* ★★★ v0.41.0：**「身份」列删掉了**（老大 2026-09-27）。原本它是
     「本人 / 组员」单选，用来指认「哪一行是我」。删的理由是语义层的一条：
     **「本人」是每个客户端私有的判断，不是全组共有的事实。**
     这张表全组共用，A 打开看到「本人」指的是 A、B 打开看到指的是 B ——
     写进表里的那一刻，这个词就没有意义了（老大原话：「『本人』是我还是他？」）。
     ★ 那「我是谁」现在靠什么：**只靠 open_id**（应用所有者那个账号）。
       实测四条证据一致（应用 owner / creator / 表 owner / 表最近修改人），
       而组员表里那个人的**人员字段**能把 open_id 解析成人名。
       见 `resolveMe` —— 改造后它只剩 b/c 两级，且**一个写请求都不发**。
     ★ 老表上那一列**留着不动**（`provision` 只补不删，既有原则）：
       代码不再读它，多一列也读不错（`fromPeopleFields` 按名字取，多余的键没人碰）。 */
  var PTF = {
    name: "姓名",
    member: "成员"
  };
  var PEOPLE_SCHEMA = [
    { field_name: PTF.name, type: 1 },
    /* ★ property.multiple:false —— 这一列**只该是一个人**。默认是 true（允许多选），
       不显式关掉的话，下拉里能勾一串人，而「接收人」在整条链路上都是单值：
       读取只取第一个（userOf），于是表里选了三个、派发只认一个，零报错。 */
    { field_name: PTF.member, type: 11, property: { multiple: false } }
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

  /* ============================================================
     派发状态机（v0.39.0）——「我派出去的那条，现在到哪一步了」
     ============================================================
     ★★★ 这一整块的由来（老大原话）：「也不确定有没有派发成功，对方有没有接收到，
       我也不知道。整个交互都不够完善，逻辑也不够清晰。」
       ⇒ 那三句话各自对应一处**真实缺失**，不是体验问题：
         · 成功只弹一句 2 秒就消失的 toast，之后不留任何痕迹；
         · 「对方收到没」**根本没有回执链路**（收件侧不回传、派发侧不回读）；
         · 没有「我派出去的」视图 —— `mineOnly` 只留「接收人 == 我」，
           于是**派发人从不读取自己派出去的那一行**，那一行后来变成什么样，
           这一侧完全不可见。派发是一条单向的路，写出去就断了。

     ★★ 「状态只进不退」（PRD §7.1）：已读不会被「未读」覆盖，已完成不会被回退。
       为什么不是「以最新为准」：状态有**两个来源**（本地记录 + 对方回写的表格），
       它们必然不同步；让最新那个赢，就会出现「已完成 → 待办」这种倒退 ——
       而倒退比停滞更糟：用户会以为活被退回来了。⇒ 单调递增，见 `laterState`。

     ★ 界面文案与状态码**只有这一个映射**（PRD §7.4 ④）——
       照 v0.38.2 的教训：同一件事有两种口径，迟早给出两个答案。 */
  var ST_TEXT = {
    sending:  "派发中",
    recorded: "已派发",
    sent:     "已通知",
    read:     "已读",
    ack:      "已接收",
    doing:    "进行中",
    done:     "已完成",
    failed:   "没派出去",
    revoked:  "已撤回"
  };
  /* 单调序。★ `failed` / `revoked` **故意不在表里** ——
     它们不是「路程上的一站」（一个是异常态、一个是本地终态），
     编进序里的话，「失败后重试成功」会被判成倒退。 */
  var ST_RANK = { sending: 0, recorded: 1, sent: 2, read: 3, ack: 4, doing: 5, done: 6 };

  /* ★★★ v0.40.0：**允许上界面**的状态档 = 当前真的有生产者的那些。
     ★ 为什么不直接用 `ST_TEXT` 当候选：
       `sent`（已通知）/ `read`（已读）/ `ack`（已接收）是 P1（飞书消息通道）
       才会产出的档，**现在没有任何代码会写它们**。而 `ST_TEXT` 是
       「状态码 → 中文」的**完整**映射表 —— 它必须留全，因为团队表「送达状态」
       那一列的 options 就是照着它的 6 档建的（动了那张表就动了存量表结构）。
     ⇒ 所以两件事分开：
          `ST_TEXT` = 映射表（完整，谁问都能翻译）
          `ST_LIVE` = 可上界面（只有真有生产者、真读得到的档才许画）
     ★ 判据（`_validate.py` 有门）：`ST_LIVE` 的每个键都必须能在项目里找到写入点；
       多一个 = 「产不出来的状态上了界面」，用户会看见一个永远不变、也永远不来的词。 */
  var ST_LIVE = { sending: 1, recorded: 1, doing: 1, done: 1, failed: 1, revoked: 1 };

  /* 状态码 → 界面词。★ 认不出来时返回**空串**（界面据此不画徽标）——
     绝不把裸状态码漏到界面上（P0-4 的验收：任何位置不出现英文状态码）。

     ★★★ v0.40.0（D7 拍板）：第二个参数 `side` —— 同一个码在**两侧视角**下叫法不同：
        · 派发人（不给 side）看到 `recorded` = **「已派发」**（我把它交出去了）
        · 接收人（side === "in"）看到 `recorded` = **「待办」**（这是我的活，还没动）
       其余各档两侧同词 —— 一件事的两个视角，两个名字都最准
       （Relay 的 Sent / Received 就是这个道理，PRD §4.1）。

     ★ 为什么不给接收人**另写一张词表**：两张表会各自漂移，而本仓库
       「同一件事两种口径」的血债最多（v0.38.0、v0.39.0 各一次）。
       一张基础表 ＋ 一条视角规则 ＝ 规则仍然只有一处。 */
  function stText(st, side) {
    var s = trim(st);
    if (side === "in" && s === "recorded") return "待办";
    return ST_TEXT[s] || "";
  }
  /* ★★★ v0.40.0：状态码 → **可上界面**的状态码。
     没有生产者的档（`sent` / `read` / `ack`）以及认不出来的码，一律返回**空串**
     ⇒ 界面据此**不画徽标**（不是画一个空框、也不是把码漏出去）。
     ★ 为什么不让 `stText` 自己过滤：它是**纯映射**，必须能翻译任何一档
       （团队表「送达状态」那一列就有 6 档值）。而「能不能上界面」是**界面策略**。
       两件事分开，才不会互相将就。 */
  function uiState(st) {
    var s = trim(st);
    return ST_LIVE[s] ? s : "";
  }
  function stRank(st) {
    var r = ST_RANK[trim(st)];
    return (typeof r === "number") ? r : -1;
  }
  /* 两个来源的状态，取更靠后的那个（单调递增）。 */
  function laterState(a, b) {
    var A = trim(a), B = trim(b);
    if (!A) return B;
    if (!B) return A;
    if (A === B) return A;
    /* 撤回是本地终态：远端再怎么变都不该把它拽回来。 */
    if (A === "revoked") return A;
    if (B === "revoked") return B;
    /* 失败是异常态：有真实状态可依时以真实状态为准（重试成功就走回正路）。 */
    if (A === "failed") return B;
    if (B === "failed") return A;
    return stRank(B) > stRank(A) ? B : A;
  }
  /* 团队表「状态」列的中文 → 我们的状态码。**只有这一个实现**（Q5 口径）：
     `done` 只认「状态 = 已完成」。★ 不看「完成时间非空」——
     手填的时间、别的流程写的时间都会让它给出另一个答案，而同一件事不能有两种口径。
     对方扩展点「完成」时 `syncBack` 写的正是「状态」列，它就是权威来源。 */
  function stateFromStatusWord(word) {
    var w = trim(word);
    if (w === "已完成") return "done";
    if (w === "进行中") return "doing";
    return "";
  }

  /* ★★★ v0.40.0：**收件侧**的 `it.status`（todo / doing / done）→ 状态机的码。
     ★ 为什么需要它、以及为什么**不用 `rst`** —— 这两个字段其实是同一件事
       （团队表「状态」那一列）的两个映射，所以必须挑一个，不能两个都用：
       · `it.status` 是收件侧**本来就有的统一口径**：我点「完成」写它（并回写远端），
         远端那一格被别人改了也写它（`mergeItems` 把 `r.status` 合并回来）。
       · `rst`（v0.39.0）是给**派发人视角**加的（「他走到哪一步了」）。
         拿它当收件侧徽标会出现一个自相矛盾的窗口：
         「我刚在本机点了完成，徽标却还写着待办」，要等下一轮轮询才追上。
     ⇒ 规矩：**收件侧认 `it.status`，发件侧认 `assign.st`。** */
  function stateFromLocalStatus(status) {
    var s = trim(status);
    if (s === "done") return "done";
    if (s === "doing") return "doing";
    /* 「还没动」= 已派出去、对方没动 —— 正是 `recorded`。
       接收人视角下它由 `stText(st, "in")` 翻成「待办」（D7 拍板）。 */
    if (s === "todo") return "recorded";
    return "";
  }

  /* ============================================================
     状态「类别」（v0.40.0 · 看板的列）
     ============================================================
     ★ 为什么要有**第二层**抽象：Jira 那条官方判据 —— 状态可以多，**类别只有三个**
       （To Do / In Progress / Done）。看板按**类别**分列，不按状态分列：
       把九个状态摆成九列没人看得懂（PRD §4.1 的调研结论）。
     ★★ `failed` / `revoked` 这两个档**故意没有类别**（值给空串）：
       它们是**流程外的两条支路** —— 一条从没出去过、一条已经退出。
       塞进「未开始」的话，那一列会同时混着「派出去了、对方还没动」和
       「压根没派出去」两件事，而这两件事要做的动作完全不同（一个去催、一个去重派）。
       ⇒ 它们各自在下面用一句话单独说清（照搬看板「另有 N 条没归到任何项目」的做法）。
     ★ 门要断言：`ST_LIVE` 里**每一档在这张表里都有键**（值可以是空串，键必须在）——
       漏一档 = 那一档在看板上凭空消失，且没有任何地方会报错。 */
  var CAT_TEXT = { todo: "未开始", doing: "进行中", done: "已完成" };
  var ST_CAT = {
    sending: "todo", recorded: "todo", doing: "doing", done: "done",
    failed: "", revoked: ""
  };
  function catOf(st) { return ST_CAT[trim(st)] || ""; }

  /* ============================================================
     「他还没回应」的门槛（v0.40.0 · D5 拍板 = 48 小时）
     ============================================================
     ★ 一天太吵（人家可能只是还没打开那张表）、三天太晚（事已经黄了）。
     ★★ 这个数**只在这一处**（v0.40.0 收口）：
       它原来生在 `popup.js` 里；这一版看板也要用同一个门槛，
       差一点就写成第二份 —— 那样「浮层说还没回应、看板说没事」这种自相矛盾
       迟早会出现，而用户只会觉得这两个数字里有一个是假的。
       ⇒ 判据：全项目 `48 * 3600 * 1000` 只出现一次（就在下面）。 */
  var NO_REPLY_MS = 48 * 3600 * 1000;

  /* 一条「我派的」是不是已经太久没动静。**返回 0 = 不该打标记**（含各种不适用）。
     ★ 只看 `recorded`：`doing` 说明他已经动了（在做了，不该再催）；
       `failed` / `revoked` 各有自己的话，不叠这一条。
     ★ 起点算 `stAt`（状态最后一次变化 = 派出去那一刻），老数据没 `stAt` 时退回 `at`。
       两者都没有 ⇒ 返回 0：**判不出来就不打标记**，绝不拿 `Date.now()` 兜底
       （那会让一条刚派出去的老格式数据立刻变成「还没回应」）。 */
  function staleOf(a) {
    if (!a || trim(a.st) !== "recorded") return 0;
    var since = Number(a.stAt) || Number(a.at) || 0;
    return (since && (Date.now() - since) >= NO_REPLY_MS) ? since : 0;
  }

  /* ============================================================
     团队那两屏的**空态文案**（v0.40.0 收口到一处）
     ============================================================
     ★ 为什么放这儿：同一个现场两句话，用户会以为是两回事 ——
       而「同一件事两种口径」是本项目付过两次账的那类病（v0.38.0 / v0.39.0）。
       现在弹窗的团队视图与看板的团队块读的是**同一份字符串常量**。
     ★★ `EMPTY_OFF` 里那句「到设置页的「团队」那一栏开一下」是**能照做的话**，
       不是解释 —— 空态必须说清「为什么空」（PRD §7.4 ②）：
       「还没开派发」与「没有人派活给你」是两件事，混成一句会让人以为功能坏了。 */
  var EMPTY_MINE = "还没有人派任务给你";
  var EMPTY_OUT = "你还没派过任务给别人";
  var EMPTY_OFF = "团队派发还没打开 —— 到设置页的「团队」那一栏开一下，别人派的活就会出现在这儿";

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
    { field_name: TF.doneAt, type: 5, property: { date_formatter: "yyyy/MM/dd HH:mm", auto_fill: false } },
    /* ★ v0.39.0 两个**可选新列**（见 `TF_OPT`）。
       ★ 单选的 options 必须**列全**：往单选里写一个不在 options 里的值，
         飞书是**报错**（1254xxx），不是自动加选项 —— 少写一档，
         就有一条状态永远写不进去，而报错信息只说「字段值不合法」。
         所以这六个名字与 `ST_TEXT` 里对应的那六个**必须逐字一致**。 */
    { field_name: TF.deliver, type: 3, property: { options: [
      { name: "已派发" }, { name: "已通知" }, { name: "已读" },
      { name: "已接收" }, { name: "进行中" }, { name: "已完成" }] } },
    { field_name: TF.notifyAt, type: 5, property: { date_formatter: "yyyy/MM/dd HH:mm", auto_fill: false } }
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
         ★ 留空也**不算错**：那时改从「应用的登记所有者」（`resolveMe` 的 b/c 级）
           读 open_id —— 零配置、自动生效，不用你去表里标什么。 */
      ownerMail: trim(v.ownerMail),
      /* 上次拉组员表的时间。轮询靠它决定「这一分钟要不要去拉」——
         跟别的字段一样只是个数值，界面上看不见。 */
      peopleAt: Number(v.peopleAt) || 0,
      /* ★★★ v0.38.0：认人的结果必须**读得回来**。
         配置有两扇门，而它们是不对称的：`saveCfg` 是**原样存**（不过滤），
         这里是**白名单**（只保留列出来的字段）。于是这四个键
         存得进去、**读不回来** —— 写的时候在，下一次读就没了。
         症状极难查，因为它看起来像「功能没做」：
           · `meId` 丢 ⇒ 每次派发都得重新认一次人（多一轮网络），
             更要命的是「没名字时拿 id 兜底」这条路**手里根本没有 id**；
           · `meSrc` / `meSuspect` 一起丢 ⇒ 设置页那行
             「从哪认出来的 / 是不是占位名」**永远不显示**；
           · `meWhy` 丢 ⇒ 认人失败的原因过不了下一次读，
             界面上只剩一句笼统的「先认一下你是谁」——老大这次报的就是它。
         ★ 这三个键是 v0.37.0 加的，加的时候只改了写、没改读。
         999 条门里没有一条看着「白名单是不是漏了键」——已补（见 _validate.py）。 */
      meId: trim(v.meId),
      meSrc: trim(v.meSrc),
      meSuspect: v.meSuspect === true,
      meWhy: trim(v.meWhy),
      /* ★★★ v0.45.0：**本机选定的身份**（open_id）。
         为什么必须有它：`resolveMe` 原来的唯一来源是 `Feishu.appOwner` ——
         那是**应用登记所有者**，而应用凭据是全组共用的 ⇒ 同一个 appId、同一个 owner
         ⇒ **每台机器认出来都是同一个人**（老大）。同事那边于是收件箱、我派的、
         派发人三处同时错，而且一个字都不报。
         ★ 只存 `storage.local`，**绝不写进共享表**：「本人」是每个客户端私有的判断，
           不是全组共有的事实（v0.41.0 已经为这条否决过一次）。
         ★★ 必须加进这个白名单。v0.38.0 的 `meId` / `meSrc` / `meWhy` 就是
           「写得进去、读不回来」，症状看起来像「功能没做」（见上面那段）。 */
      selfId: trim(v.selfId),
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
      /* ★★★ v0.41.0：`role`（「身份」列）**不再读**。老表上那一列还在，
         但代码不看它 —— 它就是一行普通的多余数据，删列不可逆，没必要动。
         空行判据也从「role 是不是本人」变成了「**姓名与人员字段都空**」（见下）。 */
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
      /* ★★ v0.41.0：**名单里不再有「本人」这一格**。
         改造前这里还判过 `p.role === ROLE_ME` 并把那一行记成 me —— 现在没有了，
         因为「身份」列已经不存在，而名单有了更干净的定义：**它就是表里的全部行**。
         ★ 那「我是谁」由谁答：**只由 `resolveMe` 答**（uid 命中应用所有者）。
           `fromPeopleRecords` 从今往后只干一件事 —— 把组员表读成一张名单。
         ★★ 为什么这一段要写这么重：改造前**每一行都会被 push 进名单**，
           包括「本人」那一行 —— 于是 `cfg.people` 里混进了自己的名字，
           界面上靠 `assignNames()` 的 `.filter(n => n !== me)` 兜住。
           那是**在出口堵**，而堵住的原因（认出的 me 恰好等于名单里那条）是巧合：
           换个客户端、或者 me 认出的是 open_id 而不是那个占位名，就漏了。
           ⇒ 源头不放进，比出口过滤可靠（铁律：同一件事两处各写一份必然漂开）。 */
      if (!seen[p.name]) { seen[p.name] = 1; people.push(p.name); }
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
    /* ★ v0.38.0：`meId` 也要跟着进来 —— 名字拿不到时它就是派发人的落点
       （见 `whoOf`）。少了这一行，认出来的 id 会在下一次读配置时丢掉。 */
    if (trim(got && got.meId)) o.meId = trim(got.meId);
    /* 记一笔「刚拉过」——轮询靠它判断这一分钟要不要再去拉组员表。
       ★ 只有真读过才盖时间戳：读失败还盖的话，会变成「每 5 分钟才试一次」，
         网断的时候恢复得比预期慢。 */
    if (got && got.at) o.peopleAt = Number(got.at) || o.peopleAt;
    return o;
  }

  /* ============================================================
     认人：我是谁（v0.37.0）
     ============================================================
     一句话职责：**零配置**认出「这张表里的派发人应该是谁」，并在组员表里
     把那一行补上。它服务的是「第一次上手」——不该让人先去表里认领自己。

     ★★★ 为什么必须提成**公共函数**（v0.36.0 的形态不是这样）：
       v0.36.0 那套三级认人是 `generate()` 里的一个**局部函数**（`ownerTarget`），
       只有「一键生成 / 转归属」那条链路调得到。于是「派发」那条路上 `cfg.me`
       仍然是空的 —— 老大报的那句「现在提示缺少派发人」就是这么来的。
       同一件事实（我是谁）在两个地方各算一遍，迟早漂开；
       提上来之后**派发 / 转归属 / 设置页三条路共用同一个实现**。

     ★★ 为什么「零配置」成立：应用是自建应用，登记时必然绑了所有者，
       而那个 open_id 与文档域里的身份完全一致（实测四处：应用 owner / 应用 creator /
       表 owner / 表最近修改人，见 feishu.js `appOwner` 那段）。
       所以不填任何东西也能知道「你是谁」——**知道的是 id，不是名字**。

     ★★★ 「知道 id」与「知道名字」是两件事，这是本功能最容易踩空的地方：
       飞书对姓名做了字段级管控 —— `GET /contact/v3/users/:open_id` 的完整返回里
       **只有 open_id / union_id / mobile_visible**，姓名那一格压根不返回；
       `contact/v3/users/search` 直接报 99991663（只认 user token）；
       应用信息里的 `owner.name`、文档元数据、协作者列表**都不带名字**。
       ⇒ 纯只读的路全试过（2026-09-25 穷举，见 `_probe_me.py` / `_probe_me2.py`），
         拿不到名字。

     ★★ 破局点是**组员表的「成员」人员字段**：它是个 **open_id → 名字 的解析器**。
       写进去只需要 `[{id:"ou_…"}]`，**名字是飞书在「读」的时候补上的**
       （实测：写入 `ou_97df…` 读回 `{"id":"ou_97df…","name":"周明(ming.zhou)"}`）。
       所以流程是：认出 open_id → 补一行 → **回读** → 名字到手。

     ★★★ 但实测还发现一件事，必须写在这儿（否则将来会有人把它当成 bug 再查一遍）：
       同一个读法下，周明解析出真名 `周明(ming.zhou)`、应用自己解析出 `任务插件`，
       而**应用所有者那个账号解析出来是 `用户613803`** —— 形态上就是飞书给的
       脱敏/占位名。⇒ 于是有了 `looksPlaceholder`：**拿到了占位名要能认出来**，
       不能把它当成「拿到了名字」（它是合法非空字符串，混过去零报错）。

     ★ 降级纪律（顺序即优先级，b/c 都拿不到才提示人工）：
       b 组员表里 uid == 应用所有者那行 —— id 确定，名字（若表里手打过）解析得到
       c 应用登记所有者 —— 纯零配置，只有 id
       ★ v0.41.0 删掉了原 a 级（组员表「身份」=「本人」那行）：那一列已经不存在，
         而且实测它在**结果上**与 b/c 级等价（认出的占位名被 `whoOf` 挡掉后
         照样退回 open_id）。详见 `resolveMe` / `PTF` 两段的论证。
     ============================================================ */

  /* 飞书给的**占位名**：`用户` + 一串数字（实测：`用户613803`）。
     ★ 为什么必须单独认它：它是一条**合法、非空**的字符串 —— 不认的话，
       「拿到了名字」与「拿到了一个占位名」在代码里走同一条路，
       后果是把 `用户613803` 当成派发人**静默**写进团队表。
     ★ 判据来自实测而不是猜：同一次读里，同租户的另一个人解出 `周明(ming.zhou)`，
       只有这个账号解出 `用户613803` —— 形态明显不同，不是「有人就叫这个名」。 */
  var PLACEHOLDER_NAME = /^用户\d+$/;
  function looksPlaceholder(n) { return PLACEHOLDER_NAME.test(trim(n)); }

  /* 所有者 id 是 34 位的串（`ou_` + 32 hex），原样打进界面会把那一行撑开、
     把真正的信息（到底认成了谁）挤没。缩成 前 8 + 后 4。
     ★ 放在顶层、只有这一份：它原来在 `generate()` 里是局部的，而认人的提示语
       现在有多处要用 —— 抄成两份的话，漂移的症状是「设置页缩了、提示里没缩」。 */
  function shortId(v) {
    /* ★ v0.45.1：实现搬到 `Feishu.shortId` —— 飞书同步的「新建一张」也要缩 id。
       两份实现漂移的症状是「设置页缩了、同步页没缩」。 */
    return Feishu.shortId(v);
  }

  /* 「转归属该转给谁」——**只有这一份**（v0.45.1 从 `generate()` 的局部函数提上来）。
     ★★★ 为什么必须提上来：v0.34.0 只给「团队一键生成」加了转归属，而飞书同步的
       「新建一张」走 `Feishu.provision`，那条路上一个认人的代码都没有 ——
       同一个动作两条路，一条做了、一条没做，用户看到的差别就是「这张表是我的，
       那张表是应用的」。★ 与 v0.37.0 把 `resolveMe` 提上来是**同一条教训**：
       同一件事实（我是谁）在两处各算一遍，迟早漂开。
     a) 配置里的「我的飞书邮箱」——**明确指认**，建表那一刻就有，一次到位；
     b) 没有邮箱才走 `resolveMe`（本机选择 / 组员表 / 应用所有者）—— 推断。
     ★ 返回 `{mt, mid, src}` 或 null（认不出）。认不出**不抛**：调用方把它当
       「这一步没做成」如实说，而不是让整件事失败。 */
  function ownerTargetOf(cfg, appToken, peopleTableId) {
    var mail = trim(cfg && cfg.ownerMail);
    if (mail) return Promise.resolve({ mt: "email", mid: mail, src: "邮箱" });
    /* ★ 必须能带进**刚建出来的**组员表 id：`cfg.peopleTableId` 在首次生成那一步
       还是空值，拿它去读会读成「还没配组员表」。 */
    var c = {};
    Object.keys(cfg || {}).forEach(function (k) { c[k] = cfg[k]; });
    if (trim(appToken)) c.baseToken = trim(appToken);
    if (trim(peopleTableId)) c.peopleTableId = trim(peopleTableId);
    return resolveMe(c).then(function (r) {
      if (!r || !trim(r.meId)) return null;
      /* ★ member_type 按 id 前缀判，不写死 "openid"：组员表里填的可能是裸 user_id，
         写死的话飞书会回「成员不存在」，而 id 明明是对的 —— 人会往权限上想。 */
      return { mt: Feishu.memberTypeOf(r.meId), mid: r.meId, src: r.src || "应用" };
    }, function () { return null; });
  }

  /* ★★★ v0.38.0：派发人**写进团队表**的那个值 —— 「我是谁」的唯一口径。
     有名字用名字（人能读），没名字用 open_id。
     ★★ 为什么 id 可以当派发人（老大 2026-09-25 原话就是
       「派发人不需要去填写，默认 = 飞书 openid」）：
       「你是谁」的**权威答案**本来就是 open_id —— 它是飞书发的、零配置拿得到
       （实测四处一致：应用 owner / creator / 表 owner / 表最近修改人），
       名字只是**显示层**，而且偏偏是飞书做了字段级管控的那一格
       （`contact/v3/users/:open_id` 的完整返回**只有** open_id/union_id/
       mobile_visible，姓名压根不返回）。把名字当**前提**，等于把「能不能派发」
       绑在一个飞书不肯给的字段上 —— 这正是老大那句「提示需要派发人」的根：
       认人链走完了，可它最后一步要的是名字，拿不到就整条作废。
     ★★★ 为什么**不能**直接把 `cfg.me` 改成 id（这是最容易做错的一步）：
       `cfg.me` 还兼着另一件事 —— `mineOnly()` 用它比对团队表的「接收人」，
       也就是「**别人派给我的任务，我收不收得到**」。而接收人写的是**名字**
       （派发方的下拉从组员表来）。一旦把 id 塞进 `cfg.me`，这条匹配就永远
       不成立，症状是「别人派给我的任务全丢」——而且是**一个字都不报**的静默。
       ⇒ 两个语义分开：`cfg.me` 仍是名字（**允许为空**），`cfg.meId` 是 id；
          「派发人是谁」只认这个 `whoOf`。 */
  function whoOf(cfg) {
    var n = trim(cfg && cfg.me);
    var id = trim(cfg && cfg.meId);
    /* ★★★ 占位名（`用户613803`）**不算名字**，这一格是本功能最阴的一处：
       它是一条**合法、非空**的字符串，形态上跟真名没法区分（除了 `用户+数字`），
       当成名字用掉不会报任何错 —— 于是团队表的「我是谁」列里会静默写进
       `用户613803`，而它**没有信息量**：读的人既不知道是谁，也没法跟账号对上。
       open_id 至少能对应到唯一一个账号，而且它才是「你是谁」的权威答案。
       ⇒ 优先级：**真名 → open_id → 占位名**（最后这个只在我们两样都拿不到时兜底，
         总比把这一格留空好）。 */
    if (n && !looksPlaceholder(n)) return n;
    return id || n;
  }

  /* 组员表的行 → 可直接判的数组。带上 `recordId`（排障用：能定位到具体哪一行）。 */
  function peopleRows(recs) {
    return (recs || []).map(function (r) {
      var p = fromPeopleFields(r);
      p.recordId = (r && r.recordId) || "";
      return p;
    });
  }

  /* 读组员表。**不抛** —— 读不到是一种正常结果（还没配 / 网络抖），
     调用方要的是「能不能认人」，不是「为什么读不到」的异常。 */
  function readPeopleRows(cfg) {
    var pid = trim(cfg && cfg.peopleTableId);
    if (!pid) return Promise.resolve({ ok: false, rows: [], why: "还没配「组员」表" });
    return Feishu.listAll(derived(cfg, cfg.baseToken, pid)).then(function (recs) {
      return { ok: true, rows: peopleRows(recs), why: "" };
    }, function (e) {
      return { ok: false, rows: [], why: (e && e.message) || "读不到「组员」表" };
    });
  }

  /* ★★★ v0.41.0：`ensureMeRow` **整个删掉了**（原第 846-894 行）。
     它活着的唯一理由是「往组员表里写一行、并给那一行的『身份』列填『本人』」。
     「身份」列没了（见 `PTF` 段），它要写的东西就不存在了 —— 留着的话，
     下一次调用会带着一个不存在的列名发请求，飞书回 `1254045 FieldNameNotFound`，
     而症状是「认人偶尔失败」，看不出跟删列有关。
     ⇒ 连它的幂等指标（P0-4「连点三次只有一行」）一起消失，但那**不是损失**：
       改造后 `resolveMe` 是**一个写请求都不发**的纯只读函数（见下），
       幂等由「从来不写」天然满足 —— 比原来更强。

     ★ 同时删掉的还有 `opts.write`：它原来是「要不要补那一行」的开关。
       现在没有可补的东西了。调用方传了也无害（多余参数被忽略），
       但必须把参数**保留在签名里** —— popup / manage 那边传的是
       `{ write: false }` 这类对象，删掉形参会让它们变成静默无效调用，
       而调用点看不出任何异常。 */

  function meFrom(row, oid, src) {
    var nm = trim(row && row.name);
    return {
      meId: trim(oid) || trim(row && row.uid), me: nm, src: src,
      suspect: looksPlaceholder(nm), why: "", wrote: ""
    };
  }

  /* 认人。返回（**形状与 listPeople 兼容**，可以直接喂 applyPeople）：
       { meId, me, src, suspect, why, wrote, people:[...], rows:[...], at }
     ★★★ v0.41.0：**纯只读** —— 这一版起它一个写请求都不发（原因见下）。
     opts.rows 可传入已读到的行，省一次列表请求。 */
  function resolveMe(cfg, opts) {
    opts = opts || {};
    var readP = opts.rows
      ? Promise.resolve({ ok: true, rows: opts.rows, why: "" })
      : readPeopleRows(cfg);
    return readP.then(function (got) {
      var rows = got.rows || [];
      var names = [], seen = {};
      rows.forEach(function (r) {
        if (r.name && !seen[r.name]) { seen[r.name] = 1; names.push(r.name); }
      });
      function pack(extra) {
        var o = {
          people: names, rows: rows, at: Date.now(),
          meId: "", me: "", src: "", suspect: false, why: "", wrote: ""
        };
        Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
        return o;
      }
      /* ★★★ v0.45.0：**第 0 级 —— 本机选择**，排在一切推断之前。
         为什么必须排最前：下面 b/c 两级唯一的输入是 `Feishu.appOwner(cfg)`，
         而那是**应用登记所有者**；应用凭据全组共用 ⇒ 同一个 appId ⇒ 同一个 owner
         ⇒ 同事机器上永远认成老大。**推断级在结构上不可能因人而异。**
         ⇒ 只有「这台机器自己说了算」能解决，而且它必须是**最高优先级** ——
           放到推断级后面等于没加（推断级永远有答案，永远不会走到这里）。

         ★ 只认**有 uid 的命中**：open_id 才是稳定主键，姓名是可变的显示层。
         ★★ 没命中时**不许退回推断级**：那会静默变成"老大"，比认不出更糟 ——
           认不出至少看得见（`why` 会说出来）。这里用 selfId 本身当身份，
           `whoOf` 会退成写 open_id，派发照常可用。 */
      var selfId = trim(cfg && cfg.selfId);
      if (selfId) {
        var picked = null;
        for (var k0 = 0; k0 < rows.length; k0++) {
          if (trim(rows[k0].uid) && trim(rows[k0].uid) === selfId) { picked = rows[k0]; break; }
        }
        if (picked && trim(picked.name)) {
          return pack(meFrom(picked, selfId, "本机选择"));
        }
        return pack({
          meId: selfId, me: picked ? trim(picked.name) : "", src: "本机选择",
          why: picked ? "" : "本机选的那个账号已经不在「组员」表里了，去设置页重选一次"
        });
      }
      /* ★★★ v0.41.0：原 a 级（「身份」=「本人」那行）在此处 —— **已删**。
         它读的列不存在了。删掉它不损失任何东西（论证见下），而它的**第二个用处**
         「在『姓名』列手填一次就能永久盖掉占位名」**仍然成立**，只是路线变了：
         现在只要表里那一行的 uid 命中应用所有者，那一行的「姓名」就被采用
         （见 b 级），所以填一次名字照样生效 —— 不需要先标「本人」。
      */
      /* ★★★ v0.41.0：只剩**两级**，而且两级都是**只读**。
         原 a 级（「身份」=「本人」那行）已删 —— 它要读的列不存在了。
         删掉它**不损失任何东西**：改造前实测（2026-09-27）那条路上认出来的
         名字恰好是个占位名（`用户613803`），被 `whoOf` 挡掉之后照样退回 open_id，
         也就是说 a 级在**结果上**与下面的 b/c 级完全等价，只是多绕一圈。

         ★ b 级：应用所有者那个账号**已经在组员表里**（uid 命中）
           ⇒ 拿那一行的 `name`（飞书用人员字段解析出来的，或者填表人手打的）
             交给 `whoOf`：真名就用真名，占位名/空就退回 open_id。
         ★ c 级：认出了 open_id，但组员表里没有这个人 ⇒ 直接用 open_id。
           这一级**必须留着**（不是兜底彩蛋）：首次生成时组员表是空的，
           而「派发」不该因为「表里还没填人」就整个停住 ——
           老大原话：「派发人不需要去填写，默认 = 飞书 openid」。

         ★★ 为什么原来那句「命中但身份不对时只改那一格」不见了：
           那次修改就是写「身份」列。没有可写的列 ⇒ 没有写请求 ⇒
           这一段从「读 + 可能写 + 回读」缩成「读 + 选一行」。 */
      return Feishu.appOwner(cfg).then(function (ow) {
        var oid = trim(ow && ow.id);
        if (!oid) {
          return pack({ why: "认不出你是谁：飞书没告诉我这个应用属于哪个账号" });
        }
        var same = null;
        for (var j = 0; j < rows.length; j++) {
          if (trim(rows[j].uid) && trim(rows[j].uid) === oid) { same = rows[j]; break; }
        }
        /* b 级：uid 命中就认 —— **不再要求「身份」列写着本人**（那一列已不存在）。
           命中即算，因为 uid 是飞书给的、权威，而「身份」是手工标的、可能标错或没标。
           ⇒ 一个写请求都不发，这就是 P0-4 幂等现在的落点（而且比原来更强：
             它不再是「写了但没重复」，而是「压根没写」）。 */
        if (same && trim(same.name)) {
          return pack(meFrom(same, oid, "组员表"));
        }
        /* c 级：组员表里没有他，或者有但解析不出名字（frozen 成 open_id 那一档）。
           ★ `why` 只在**读表失败**时才带原因 —— 读成功但没这个人，不是错误，
             是本功能第一天的正常状态，不该往界面上塞一句「失败」。 */
        return pack({
          meId: oid, me: same ? trim(same.name) : "", src: "应用",
          why: got.ok ? "" : got.why
        });
      }, function (e) {
        return pack({ why: "查「应用属于谁」失败：" + ((e && e.message) || "未知原因") });
      });
    });
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
      /* ★ v0.39.0：**我派出去**那一侧的「他到哪一步了」。
         它来自团队表的「状态」列（对方点完成时 `syncBack` 写的就是这一列），
         与上面那个 `status`（**我作为接收人**的任务状态）是**两件事**，
         所以故意分成两个字段 —— 合成一个的话，同一个字段在收件箱与发件箱里
         含义不同，那正是「同一件事两种口径」的另一种写法。 */
      rst: stateFromStatusWord(sel(f[TF.status])),
      at: Date.now()
    };
  }

  /* ---------- 拉取：只留「派给我的」 ----------
     ★★ 这一步是隔离的第一道门：表里全是别人的任务，只有接收人 == me 的才留下。
        不做过滤的话，二十几个人的任务会全灌进你的本地，而且看起来「像是同步来的」。 */
  function mineOnly(items, me, meId) {
    var m = trim(me), i = trim(meId);
    return (items || []).filter(function (it) {
      if (!it) return false;
      /* ★★ v0.38.0 两条：
         ① 「我」可以是名字**或** open_id —— 名字拿不到时，派发侧会把 id 写进
            团队表（见 `whoOf`），拉取侧就得认得出那一条，否则自己派出去的任务
            自己收不回来。
         ② `m` 为空时**直接不匹配**（原来会退化成 `sameName(it.to, "")`）——
            飞书表里「接收人」空着的记录不少（草稿行、别人手填漏了），
            原来它们会被当成「派给我的」**静默**灌进本地清单。 */
      return (m && sameName(it.to, m)) || (i && sameName(it.to, i));
    });
  }

  /* ---------- 发件箱：我是谁 == 我，**且** 接收人 ≠ 我（v0.39.0）----------
     ★★★ 为什么要新增一个函数、而不是改 `mineOnly` 的条件：
       `mineOnly` 只留「接收人 == 我」，于是**派发人永远读不到自己派出去的那一行** ——
       那一行后来变成什么样（对方开工 / 做完 / 被改期），派发人这一侧完全不可见。
       但 `mineOnly` 被收件箱的判据钉着、而且服务的是已发布行为，
       改它会让收件箱条数**静默**漂移。⇒ 新增一个**并列**的过滤，`mineOnly` 一行不改。

     ★★ 两者的**互补性**是这一版的核心不变量：同一条记录不可能同时落在两个集合里
       （P0-3 的验收：「收件箱条数一条不多」）。`toMe` 那一半就是守卫 ——
       自己派给自己的任务（`to == me`）仍然只出现在收件箱，不会被算两次。 */
  function outboxOf(items, me, meId) {
    var m = trim(me), i = trim(meId);
    return (items || []).filter(function (it) {
      if (!it || !trim(it.rid)) return false;    /* 没有 record_id：无从回读，不算我派的 */
      var mine = (m && sameName(it.from, m)) || (i && sameName(it.from, i));
      var toMe = (m && sameName(it.to, m)) || (i && sameName(it.to, i));
      return mine && !toMe;
    });
  }

  /* 一条任务**当前该显示**的派发状态（**唯一口径**）。
     ★★ 为什么要提成一个函数：老数据（v0.39.0 之前派出去的）只有 `{to, at}`、
       没有 `st` —— 「缺 `st` 就按已派发算」这条推断如果写在界面上，
       徽标那处写一遍、抽屉那处又写一遍，两处迟早漂开（本项目反复栽的就是这个）。
     ★ 没有 `to` 的返回空串（不是「已派发」）：那根本没派过。 */
  function assignState(a) {
    if (!a || !trim(a.to)) return "";
    return trim(a.st) || "recorded";
  }

  /* 「这条任务交出去了吗」—— **全项目唯一口径**（v0.43.0）。

     ★★ 为什么必须住在 `inbox.js`、不能写在弹窗里：这个判据有**三个 runtime 的调用方** ——
       · `popup.js`     个人视图该不该显示它（`myTasks`）
       · `ballpage.js`  球上那个角标算不算它（`openCount`）
       · `notify.js`    吉祥物开口时算不算它（`facts`）
       而 `inbox.js` 是**唯一同时被这三者加载**的模块：`popup.html` 用 `<script>` 引它、
       `manifest.json` 的 content script 数组引它、`background.js` 的 `importScripts` 也引它。
       写在弹窗里，另外两处就只能各抄一份 —— 而**「各抄一份」正是这个 bug 的成因本身**：
       老大报的「派出去的活还在我的个人待办里」，根因就是同一个判断散在三处、
       谁也没把 `assign` 读进来。

     ★★★ **写成白名单，不写黑名单。** 只认「对方确定拿到了」的那三档：
       `recorded`（那一行已经写进团队表）/ `doing`（对方动手了）/ `done`（对方完成了）。

     ★★★★ 为什么不是 `!!st && st !== "revoked"`（本版初稿就是这么写的，**是个坑**）：
       黑名单的方向是**默认藏起来**，于是任何**没有真实交出去**的状态都会被误藏。
       开工后量现场抓到两个，都是真会发生的：

       · `failed`（派发失败）—— `runDispatch` 的网络/配置那一步 catch 里写的就是它
         （连「团队派发没配好」这种最常见的情况都走这里）。
         **那一刻活根本没交出去，对方连见都没见过。** 黑名单会把它从我的个人视图里
         抹掉，于是「没派出去」的活连我都不记得了 —— 比老大报的那个 bug 更糟。
       · `sending`（派发中）—— `runDispatch` 刚按下去那一瞬间的状态。
         请求挂住（网络没断也没回）时它会一直停在这儿；黑名单会让这条活
         **永久隐身**，而「我派的」那边又没有「重派一次」（那只给 `failed`）——
         一条谁也够不着的死任务。

       ⇒ 白名单是**安全方向**：将来谁再加一个状态（`queued` / `retrying`…），
         它默认落在「**还在我手上**」，也就是「多显示一条」；
         而黑名单会让它默认落在「藏起来」。「多显示」是我能补救的，
         「藏起来」是用户再也想不起来的。

     ★★ 被白名单**排除**的三档，各自有理由（一条都不能少）：
       · `revoked` —— 撤回 = 活回到我手上。★ 撤回的实现是「**保留 `assign`、
         只把 `st` 改成 `revoked`**」（见下面 `applyOutbox` 里那句
         `if (trim(a.st) === "revoked") return;`），不是删掉 `assign`。
         所以判据写成最自然的 `!!t.assign` 会把撤回的活**永久藏掉**。
       · `failed` —— 上一条已说：没交出去。
       · `sending` —— 还没确认；藏了就可能永久隐身（见上）。
       ★ 这三档的坏法都指向**同一个方向**（藏过头），所以它只需要**一条**判据；
         但门必须**逐档点名**（G1 分别盯 `revoked` / `failed`），
         否则写一条「排除 revoked」就当交差，另外两档照旧漏。 */
  function isGivenAway(t) {
    var st = assignState(t && t.assign);
    return st === "recorded" || st === "doing" || st === "done";
  }

  /* 「这条算我的『我派的』那一摞吗」—— ★★★★ **与上面那条是两个不同的问题**（v0.43.0）。

     ★★★★ 为什么**不能**把 `outItems` 收口成 `filter(isGivenAway)`（初稿就是这么写的，
       而且是在「收口」这面旗帜下写的 —— 所以它格外值得记下来）：
       · `isGivenAway` 回答「这活**离开我手上了**吗」→ 用来**过滤个人视图**；
       · `isOutgoing` 回答「我**派过**它吗」        → 用来填**「我派的」那一摞**。
       两者只在**成功派发之后**同真，在另外两档上**正好相反**：
         · `failed`（派发失败）—— 没离开我的手（⇒ 要留在个人视图）**但**我确实派过
           （⇒ 要出现在「我派的」里）。★ 后者不是口味问题：**「重派一次」那颗按钮
           只画在那一行上**（`outCardEl` 里那个 `re`），把它排除掉 = 失败之后
           **再没有任何地方能重派** —— 一条谁也够不着的死任务。
         · `sending`（派发中）—— 同理，两边都要看得见。
       ★★ 教训的形状：「一个问题一个函数」这条纪律，**用错地方会变成新的病** ——
         两个问题各自需要自己的名字；共用一个名字比各写一份更危险，
         因为改一处会**同时误伤另一处**，而且从改动本身看不出伤到了哪边。

     ★★ 两条判据的**默认方向是相反的，这不是巧合**：
       · `isGivenAway` = **白名单**（只认确定到了对方手上那三档）⇒ 拿不准时**多显示一条**；
       · `isOutgoing`  = 「有状态且没撤回」⇒ 拿不准时**多留一条记录**。
       两条都往「多留痕迹」的方向倒 —— 因为「看不见」比「多一行」贵得多：
       多出来的一行用户会自己划掉；看不见的那件事，他再也想不起来。 */
  function isOutgoing(t) {
    var st = assignState(t && t.assign);
    return !!st && st !== "revoked";
  }

  /* 把回读快照并回本地任务（popup 侧调用）。
     输入：本地任务数组 + OUTK 里的 rows；输出 `{ tasks, changed }` ——
     **只在真变了时说变了**，否则每次开弹窗都会白写一次盘。
     ★ 按 `rid` 认，不按位置：本地那条任务与表里那一行就是靠 `rid` 绑起来的。 */
  function applyOutbox(tasks, rows) {
    var byRid = {};
    (rows || []).forEach(function (r) { if (r && trim(r.rid)) byRid[trim(r.rid)] = r; });
    var changed = 0;
    (tasks || []).forEach(function (t) {
      var a = t && t.assign;
      if (!a || !trim(a.rid)) return;
      var r = byRid[trim(a.rid)];
      if (!r) return;
      /* 撤回是本地终态：远端再变也不回填（否则「撤回」过一会儿自己复活）。 */
      if (trim(a.st) === "revoked") return;
      /* ★ 老数据只有 `{to, at}`、没有 `st` —— 但**老数据也没有 `rid`**，
         所以它本来就匹配不到这里（回读要按 record_id 认）。
         它的状态由 `assignState()` 在显示层推断成「已派发」。
         ⇒ 别在这儿补一个「rid 为空时按 to 匹配」的兜底：同名的人有好几个，
           按名字匹配会把别人的状态灌到你的任务上，而且零报错。 */
      var nx = laterState(trim(a.st) || "recorded", r.st);
      if (nx && nx !== trim(a.st)) {
        a.st = nx;
        a.stAt = Number(r.at) || Date.now();
        changed++;
      }
    });
    return { tasks: tasks, changed: changed };
  }

  /* 远端拉回来的 items → 与本已有的合并。
     ★ 按 id 认、不按下标（下标会因为中间删一条整体挪位）。
     ★ 远端删掉的记录：`keep` 为 true 时**保留本地**（P0 不动本地 ——
       删除比保留危险得多：留着顶多是一条多余的任务，删了就找不回来了）。

     ★★★ v0.40.0：下面这串赋值是**字段白名单**，它有两个「静默」的性质，
     所以必须由门守着（`_validate.py` 有一条：`fromTeamFields` 产出的每个字段
     都得在这串里出现，少一个就报红）：
       ① **漏一个字段 = 那个字段永远不再更新**，而且零报错 ——
          新记录那一次走的是上面 `out.push(r)`，字段是全的；
          从**第二次轮询**起才走这里，于是症状是「第一次对、之后就不动了」。
       ② 本仓库已经栽过**同一个病的另一个形态**：v0.38.0 `readCfg` 的**白名单漏键**
          （写进去读不出来），当时查了很久。字段拷贝这种地方，人手维护必漏。
     ★ v0.40.0 补的：`to`（接收人换了要跟着变）、`rst`（v0.39.0 新增的
       「他做到哪一步了」—— 漏了它，「派给我的」那一侧的进度会停在第一次看到的值）、
       `at`（这条最后一次从远端看到的时刻）。 */
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
      old.to = r.to;
      old.rid = r.rid;
      old.rst = r.rst;
      old.at = r.at;
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

  /* 派发前必须有「我」。已有的直接用；没有就**现场认一次**（v0.37.0）。
     ★★ 为什么把认人放进 dispatch，而不是只靠界面先认：
       界面有两条路（项目行上的按钮 / 抽屉里的单条派发），任何一条漏了调用，
       症状都是老大原话那句「明明认出来了，这里还问我要」——
       而那种错**只在界面上**看得到：单测里 dispatch 永远有人喂好 cfg.me，全绿。
       把判据放在**唯一的写入口**上，两条路就都跑不掉。
     ★ 认到了顺手落盘，否则每次派发都要多一轮「读组员表 + 查应用」。 */
  function ensureMe(cfg) {
    var have = whoOf(cfg);
    if (have) return Promise.resolve(have);
    return resolveMe(cfg).then(function (r) {
      /* ★★★ v0.38.0：派发人要的是「**你是谁**」，不是「你叫什么」。
         名字拿不到（飞书字段级管控 / 通讯录不可见 / 只解析出占位名）都不该
         拦住派发 —— open_id 是零配置就拿到手的那个权威答案，名字只是显示层。
         老大的原话：「派发人不需要去填写，默认 = 飞书 openid」。
         ★ v0.37.0 这里写的是「没有 `r.me` 就 throw」—— 于是
           「组员表没配 / 补不进去 / 飞书没给名字」这三种情况**全都派不出去**，
           而它们一个都不影响「把任务写进团队表」这件事本身。
           把可选增强（拿名字）当成了必经步骤，这是设计层的错，不是某一行。 */
      /* ★★★ v0.38.2：口径与 `whoOf` 统一 —— 名字优先，但**占位名不算名字**。
         v0.38.0 这里写的是 `trim(r.me) || trim(r.meId)` ⇒ 组员表里那个账号
         由飞书解析出来的**占位名**（`用户613803`）会被当成派发人写进
         团队表的「我是谁」列 —— 而它没有任何信息量：读的人既不知道是谁，
         也没法拿它跟任何账号对上（open_id 才是「你是谁」的权威答案）。
         同一个功能里 `whoOf` 明明已经过滤了占位名，这里却没过 ⇒
         **同一件事两种口径** —— 本项目反复栽的就是这一类。
         ⇒ 不再手写一遍优先级，直接复用 `whoOf`：真名 → open_id → 占位名（末位兜底）。 */
      var who = whoOf({ me: r && r.me, meId: r && r.meId });
      if (!who) throw new Error(trim(r && r.why) || "认不出你是谁");
      var o = readCfg(cfg);
      /* ★ 名字**有才写**：写空串会把上一次认到的名字冲掉（而那是唯一能读的）。 */
      if (trim(r.me)) o.me = trim(r.me);
      if (trim(r.meId)) o.meId = trim(r.meId);
      o.meSrc = trim(r.src);
      o.meSuspect = !!r.suspect;
      /* ★★ v0.38.0：认人**没走到名字**时，原因必须留下来。
         只写内存的话，下一次打开弹窗就没了 —— 界面上只剩一句笼统的
         「先认一下你是谁」，而真正的原因（读不到表 / 写不进去 / 飞书没给名字）
         跟着那次弹窗一起消失。老大这次报的坑正是这个：
         看得见的是结果，看不见的是为什么。 */
      o.meWhy = trim(r.me) ? "" : trim(r.why);
      return saveCfg(o).then(function () { return who; });
    });
  }

  /* ---------- 派发：写一条到团队表 ---------- */
  function dispatch(cfg, task, to) {
    if (!ready(cfg)) return Promise.reject(new Error("团队派发没配好"));
    var who = trim(to);
    if (!who) return Promise.reject(new Error("没选接收人"));
    /* ★★ v0.38.0：`ensureMe` 给回来的是**派发人的标识**（真名，拿不到就是
       open_id），不再要求「必须是个名字」—— 这是老大原话
       「派发人不需要去填写，默认 = 飞书 openid」落到代码里的那一行。 */
    return ensureMe(cfg).then(function (from) {
      return Feishu.createRaw(cfg, [toTeamFields(task, from, who)]);
    }).then(function (got) {
      /* ★★★ v0.39.0：把 `recordId` **交出去**。
         `createRaw` 一直在返回它（`[{recordId, fields}]`），只是调用方拿到就丢 ——
         于是「我派出去的那一行」没有任何本地锚点，「回读」无从谈起。
         ⇒ 这一行是整条闭环的技术入口（PRD §3.1）。
         ★ 在这里把返回形态规范化，让调用方不必知道 `createRaw` 的数组结构：
           两处各解析一遍的话，飞书改一次返回体就会有一处**静默**落空。 */
      var r0 = (got && got[0]) || null;
      return { recordId: trim(r0 && r0.recordId), raw: got };
    });
  }

  /* ---------- 失败原因 → **能照做的一句话**（v0.39.0 / P0-5）----------
     ★ 为什么必须过这一层：把原始 message 甩给用户等于没说 ——
       「请求失败」「未知原因」这类字，一个都照做不了。
     ★ 只做**有确定依据**的改写，认不出来就原样返回原文：
       猜一句可能是错的话（比如把网络问题说成权限问题），比说「不知道」更坏 ——
       用户会照着错的指引去翻后台，然后白花半小时。
     ★ 带飞书错误码的「去后台把 X 加上」比「失败」有用一百倍；
       这也是竞品调研里 `FeishuIndex` 那个项目最值得抄的一点（错误自愈 + 连通性测试）。 */
  function failText(e) {
    var msg = trim(e && (e.message || e.msg || e.errmsg));
    /* ★★★ 别拿 `String(e)` 当兜底：`new Error("")` 的字符串形式是 `"Error"` ——
       那是**构造函数的名字**，不是原因。它会伪装成一句「原因」通过所有判据，
       而用户在界面上看到的是「没派出去：Error」—— 跟 §P0-5 要的「说得出卡在哪」
       正好相反，而且**看起来像有原因**，所以没人会去查它。
       ⇒ 只有 `e` 本身是字符串（飞书那边有些地方直接抛字符串）时才取它。 */
    if (!msg && typeof e === "string") msg = trim(e);
    var code = trim((e && e.code) || (e && e.errCode));
    var all = msg + " " + code;
    if (/没配好|没配组员表|团队派发/.test(msg)) {
      return msg + "（去设置页点一下「一键生成」）";
    }
    if (/没选接收人/.test(msg)) return "还没选接收人";
    if (/99991672|99991663|permission|权限/i.test(all)) {
      return "应用缺权限（" + (code || "99991672") + "）：去飞书开发者后台给这个应用开「多维表格」读写权限，再派一次";
    }
    if (/1254045|FieldNameNotFound|字段名不存在/i.test(all)) {
      return "团队表缺列（" + (code || "1254045") + "）：去设置页点「一键生成」把列补齐";
    }
    if (/1254302|1254001|invalid.{0,8}field|字段值不合法/i.test(all)) {
      return "团队表某列的值不合法（" + (code || "1254xxx") + "）：多半是单选列少一档选项，去设置页点「一键生成」补齐";
    }
    if (/Failed to fetch|NetworkError|network|timeout|超时|ENOTFOUND|ECONN/i.test(all)) {
      return "网络没通（" + msg + "）：检查网络后重派一次";
    }
    return msg || "未知原因";
  }

  /* ---------- 拉取一轮：返回 { items, added, fresh } ----------
     ★ 网络失败**向外抛**：调用方（后台）自己决定要不要出声。
        在这里 catch 掉的话，症状是「派了任务对方永远收不到」，
        而日志里干干净净 —— 静默失败比报错难查得多。 */
  function pull(cfg, known) {
    if (!ready(cfg)) return Promise.reject(new Error("团队派发没配好"));
    return Feishu.listAll(cfg).then(function (recs) {
      var all = recs.map(fromTeamFields);
      /* ★★ v0.38.0：把 `meId` 一起传下去 —— 「我」有两个合法形态
         （名字 / open_id，见 `whoOf`），漏传的话自己派出去的任务收不回来。 */
      var mine = mineOnly(all, cfg.me, cfg.meId);
      /* ★★★ v0.39.0：**同一份全表数据**顺手分出第二路 —— 我派出去的那些。
         零额外请求：`listAll` 拉的本来就是全表，以前筛完收件就把其余全丢了。
         ⇒ 这就是「派发人回读」的全部实现（PRD §8）。
         ★ `st` 取的是那一行「状态」列回读出来的码，可能是空串
           （对方还没动过 / 没装扩展）—— 空串**照原样带上**，
           由 `applyOutbox` 的单调递增去决定要不要改本地状态。 */
      var out = outboxOf(all, cfg.me, cfg.meId).map(function (x) {
        return { rid: x.rid, st: x.rst || "", to: x.to, title: x.title };
      });
      var m = mergeItems(known || [], mine);
      var seenIds = {};
      (known || []).forEach(function (x) { if (x && x.id) seenIds[x.id] = 1; });
      var fresh = m.added.filter(function (x) { return x && x.id && !seenIds[x.id]; });
      /* ★ v0.33.0：这里原来还会「把任务表里出现过的名字并进名单」。
         名单改由组员表提供之后删掉了 —— 留着的话名单就有**两个来源**，
         而这个功能的全部意义就是「名单只有一处、谁加了人全组都看得见」。 */
      return { items: m.items, added: m.added, fresh: fresh, outbox: out };
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
     产出：①「任务」—— 派出去的活；②「组员」—— **纯名单**（v0.41.0 起）。
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

      /* ---------- 认人（v0.36.0 三级 → v0.37.0 改成调公共函数）----------
         ★★★ 这一整块逻辑**搬到了顶层 `resolveMe`**，这里只留一个薄壳。
           为什么必须搬：它原来是个**局部函数**，只有「一键生成」这条链路调得到 ——
           于是「派发」那条路上 `cfg.me` 仍然是空的，老大原话那句
           「现在提示缺少派发人」就是这么来的。
           同一件事实（我是谁）在两个地方各算一遍，迟早漂开。
         ★ 留薄壳而不是直接调：转归属要的是 `{mt, mid, src}`
           （member_type + id），而 resolveMe 回的是 `{meId, me, src}` ——
           形态不同，转换放在调用点最清楚。
         ★ 「我的飞书邮箱」只在这里有：`transfer_owner` 接受邮箱，而派发那条路
           要的是**名字**，邮箱在那儿没用 —— 所以它不进 resolveMe。 */
      function ownerTarget(appToken) {
        /* ★ v0.45.1：实现搬到顶层 `ownerTargetOf` —— 飞书同步的「新建一张」那条路
           也要同一份认人规则（邮箱 → resolveMe）。这里只负责把**刚建出来的**
           组员表 id 带进去：`cfg.peopleTableId` 在这一步还是它进来时的值。 */
        return ownerTargetOf(cfg, appToken, out.peopleTableId);
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
        /* ★ v0.45.1：判据搬到 `Feishu.ownerIs` —— 「新建一张」那条路也要回读验证。
           同一套判断（cli_ 前缀 / 邮箱档不比对 id）只有这一份。 */
        return Feishu.ownerIs(cfg, appToken, tgt);
      }

      /* 所有者 id 缩成 前 8 + 后 4 —— 实现搬到了顶层 `shortId`（v0.37.0）。
         认人的提示语现在多处要用它，抄成两份的话，漂移的症状是
         「设置页缩了、toast 里没缩」。 */

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
             ★★★ v0.36.0 认人升成**三级零配置兜底**（实现见 ownerTarget）；
               v0.41.0 降为**两级**（原 a 级「组员表标『本人』那行」已删）：
               a) 配置里的「我的飞书邮箱」—— 建表那一刻就有，一次到位；
               b) 应用的**登记所有者** —— 零配置，不用填任何东西
                  （组员表里有这个人的话，人员字段还能解析出人名）。
             ★ 为什么登记所有者排在邮箱之后：邮箱是**明确指认**，
               而登记所有者是**推断**（理论上可以和日常账号不是一个人）。
               能明确指认就轮不到推断。
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
              "还认不出你是谁：在「" + PEOPLE_TABLE_NAME + "」里给自己加一行、" +
              "「成员」选上你；或者在「我的飞书邮箱」里填一下你的邮箱 —— 然后**再点一次这个按钮**",
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
                (v.got ? shortId(v.got) : (v.detail || "读不出来"));
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
    CFK: CFK, ITK: ITK, PEND: PEND, LOGK: LOGK, OUTK: OUTK,
    /* ★ v0.39.0：`TF_OPT` 也要导出 —— 门槛要断言「可选新列不在 `TF_REQ` 里」，
       而判据得能拿到这两个集合，否则只能靠读源码字符串（那种门会自己变绿）。 */
    TF: TF, TF_REQ: TF_REQ, TF_LEGACY: TF_LEGACY, TF_OPT: TF_OPT, TEAM_SCHEMA: TEAM_SCHEMA,
    /* ★ v0.41.0：`ROLE_ME` / `ROLE_MEMBER` 已经不存在（「身份」列没了）——
       导出一起删。留着的话，某个还没改的调用方会拿到 `undefined`
       去跟字符串比较，恒不相等而**零报错**，那正是这一版要根除的那类静默。 */
    PTF: PTF, PEOPLE_SCHEMA: PEOPLE_SCHEMA,
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
    /* ★ v0.37.0 认人：派发 / 转归属 / 设置页三条路共用这一个实现 */
    resolveMe: resolveMe,
    ownerTargetOf: ownerTargetOf,
    looksPlaceholder: looksPlaceholder,
    toTeamFields: toTeamFields,
    fromTeamFields: fromTeamFields,
    mineOnly: mineOnly,
    /* ★ v0.39.0 派发闭环四件套：
       `outboxOf` 与 `mineOnly` **并列**（互补，不是替换）；
       `applyOutbox` 是「回读结果 → 本地状态」的唯一入口；
       `stText` / `laterState` 是状态词与单调递增的唯一口径。 */
    outboxOf: outboxOf,
    applyOutbox: applyOutbox,
    assignState: assignState,
    /* ★ v0.43.0：`isGivenAway` —— 「这活交出去了吗」的唯一口径，
       三个 runtime 共用（弹窗个人视图 / 球角标 / 吉祥物开口）。
       与 `assignState` 的关系：它就是这个状态判据的**语义版**
       （`assignState` 回答"什么状态"，它回答"算不算交出去"）。 */
    isGivenAway: isGivenAway,
    /* ★ v0.43.0：`isOutgoing` —— 「我派过它吗」的唯一口径（**与 `isGivenAway` 是两个问题**，
       见上面那段：`failed` / `sending` 在两边的答案**正好相反**）。
       只给「我派的」那一摞取数用；别拿去过滤个人视图。 */
    isOutgoing: isOutgoing,
    ST_TEXT: ST_TEXT,
    stText: stText,
    /* ★ v0.40.0：`ST_LIVE` / `uiState` —— 「哪些档**允许上界面**」的唯一口径。
       与 `ST_TEXT`（完整映射表）分开的理由见 `ST_LIVE` 上面那段。 */
    ST_LIVE: ST_LIVE,
    uiState: uiState,
    laterState: laterState,
    stateFromStatusWord: stateFromStatusWord,
    /* ★ v0.40.0：收件侧 `it.status` → 状态码的唯一映射（与 `stateFromStatusWord`
       是**两个不同的入口**：那个读团队表的中文词，这个读收件侧的本地三态）。 */
    stateFromLocalStatus: stateFromLocalStatus,
    /* ★ v0.40.0：看板的「状态类别」与「还没回应」门槛 —— 两处**唯一口径**。
       看板（`board.js`）读它们，不自己再写一份；`CAT_TEXT` 的键就是列的个数。 */
    CAT_TEXT: CAT_TEXT,
    ST_CAT: ST_CAT,
    catOf: catOf,
    NO_REPLY_MS: NO_REPLY_MS,
    staleOf: staleOf,
    /* ★ v0.40.0：团队那两屏的空态文案（弹窗与看板共用同一份）。 */
    EMPTY_MINE: EMPTY_MINE,
    EMPTY_OUT: EMPTY_OUT,
    EMPTY_OFF: EMPTY_OFF,
    failText: failText,
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
    uid: uid,
    /* ★ v0.38.0：派发人（「我是谁」）的**唯一口径** —— 名字优先、open_id 兜底。
       导出它是为了让**界面**别自己再算一遍：popup / 设置页各有入口，
       各写一份「有名字用名字、没有用 id」就是三次机会漂开。 */
    whoOf: whoOf
  };

  root.Inbox = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
