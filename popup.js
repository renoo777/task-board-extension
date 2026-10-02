(function(){
  "use strict";

  // ---- 先判断自己是「弹窗」还是「标签页」 ----
  // 不支持 action.openPopup 的 Chromium 分支（如 Tabbit）会让快捷键退回
  // chrome.tabs.create 打开本页，这时要放开固定尺寸、换成宽版布局。
  // 弹窗宽度固定 560，超过 620 就一定不是弹窗 —— 先同步判一次，避免闪一下；
  // 再用 chrome.tabs.getCurrent 做权威判断（弹窗里返回 undefined，标签页里返回当前 tab）。
  var root = document.documentElement;
  // ★ v0.10.0：浮到桌面时，本页是被宿主页用 iframe 装进浮窗的（URL 带 ?pip=1）。
  // 这一判必须排最前 —— 在 iframe 里 chrome.tabs.getCurrent 可能返回「宿主的标签页」，
  // 于是浮窗被误判成标签页形态，宽版布局塞进 560px 的浮窗会直接散架。
  var IS_PIP = /[?&]pip=1(?:&|$)/.test(location.search);
  if (IS_PIP) {
    root.classList.add("as-pip");
  } else {
    if (window.innerWidth > 620) root.classList.add("as-tab");
    if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.getCurrent) {
      try {
        chrome.tabs.getCurrent(function (tab) { if (tab) root.classList.add("as-tab"); });
      } catch (e) {}
    }
  }

  var KEY = "taskboard.v1";         // 任务数据
  var PKEY = "taskboard.projects";  // 项目列表
  var PREFKEY = "taskboard.prefs";  // 使用偏好（目前只有「自然语言输入」一个开关）

  /* 使用偏好。★ 默认全开：新功能不该靠用户去设置里「发现」才生效 ——
     一个默认关着的功能等于没做。设置页里给开关是为了能关掉，不是为了能打开。 */
  function readPrefs(v){
    return { nlp: !(v && v.nlp === false) };
  }
  var prefs = readPrefs(null);

  // 看板主列只有三个。「挂起」不占列，收在右侧窄条里 —— 这是有意的：
  // 挂起的意义就是让人别惦记它，给它一个和主列平权的位子等于没挂起。
  var STATUSES = ["todo","doing","done"];
  var HOLD = "hold";
  var ALL_STATUSES = STATUSES.concat([HOLD]);

  var PALETTE = ["#5b7fa6","#8b6ba6","#4f8a7d","#b07a5a","#b06b7d","#7a8290","#c0a45c","#5f8d9c"];
  var DEFAULT_PROJECT_NAMES = ["工作","个人","学习","生活","其他"];

  function defaultProjects(){
    return DEFAULT_PROJECT_NAMES.map(function(n,i){
      return { name:n, color:PALETTE[i % PALETTE.length] };
    });
  }

  /* ---------- 存储：扩展里走 chrome.storage，直接在浏览器打开时退回 localStorage ---------- */
  var Store = {
    get: function(key){
      key = key || KEY;
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        return chrome.storage.local.get(key).then(function(o){
          return o[key] !== undefined ? o[key] : null;
        });
      }
      try { var v = localStorage.getItem(key); return Promise.resolve(v ? JSON.parse(v) : null); }
      catch(e){ return Promise.resolve(null); }
    },
    set: function(v, key){
      key = key || KEY;
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        var o = {}; o[key] = v; return chrome.storage.local.set(o);
      }
      try { localStorage.setItem(key, JSON.stringify(v)); } catch(e){}
      return Promise.resolve();
    }
  };

  /* ---------- 日期工具 ---------- */
  function pad(n){ return (n<10?"0":"") + n; }
  function ymd(d){ return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()); }
  function todayStr(){ return ymd(new Date()); }
  function diffDays(s){
    if (!s) return NaN;
    var a = new Date(s + "T00:00:00"), b = new Date(todayStr() + "T00:00:00");
    return Math.round((a - b) / 86400000);
  }
  /* ★★ v0.43.0：**它不再返回「已过期」**，只负责把日期说成中文。
     为什么必须摘干净（而不是"留着反正没人走到"）：
       这个函数有 5 个调用点，其中 3 个是**日期回显**（搜索命中、改期确认）——
       在那儿印「已过期」属于**语义串线**：用户搜「日期」是想知道"哪天"，
       不是想知道"过期了没有"。
     ★ 而真正出事的是另外 2 个（挂起卡 / 按项目视图）：后加的调用点**顺手复用了**
       它，于是「日期文案」函数被当成「状态」函数用。
     ★ 留一行没人走的分支 = 给下一个人留一个现成的坑（本版这个 bug 就是这么来的）。
       ⇒ 过期一律由 `overdueOf()` + 那个点表达，这里一个字的判断都不留。 */
  function dateLabel(s){
    if (!s) return "未安排";
    var d = diffDays(s);
    if (d === 0) return "今天";
    if (d === 1) return "明天";
    if (d === -1) return "昨天";
    if (d === 2) return "后天";
    if (d > 2 && d < 7) return d + "天后";
    var p = s.split("-");
    return (+p[1]) + "月" + (+p[2]) + "日";
  }
  function dateRank(s){ return s ? diffDays(s) : 9999; }

  /* ---------- 「这张卡过期了吗」（v0.43.0）----------
     ★ 过期**只在「还没完成」时才成立**。两个反例各自荒谬：
       · 已完成 —— 活都交了，它哪天到期不再说明任何事。原来在「按项目」视图里，
         昨天做完的活今天会印一个「已过期」。老大原话：「这个逻辑就走不通，特别奇怪。」
       · 挂起   —— 主动放下，再提醒它过期是骚扰。
     ★★ 判据收窄成**一个函数、多个调用点共用**。不这么写就会重演老形状：
       v0.21.0 那个右上角的点**判对了**（`done`/`HOLD` 都排除），
       而挂起卡、「按项目」视图这两处**漏了** —— 同一个判断在三个地方各写一遍，
       漏一处**零症状**。这正是本版这个 bug 的成因，所以本条的重点不是"改对"，
       是"以后只有一处可改"。 */
  function overdueOf(t){
    if (!t || t.status === "done" || t.status === HOLD) return false;
    var d = diffDays(t.date);
    return !isNaN(d) && d < 0;
  }

  // 「今天」视图的过滤规则：
  //   未完成 → 日期 <= 今天（含已过期，过期必须看得见）
  //   已完成 → 只保留今天完成的（给即时反馈，不堆历史）
  //   挂起   → 不参与今天的主视野，只在窄条里露个数字
  function inToday(t){
    if (t.status === "done") {
      return t.doneAt ? ymd(new Date(t.doneAt)) === todayStr() : false;
    }
    var d = diffDays(t.date);
    return !isNaN(d) && d <= 0;
  }

  /* ---------- 自然语言输入（v0.9.1）----------

     在「记一笔」里直接写「明天交周报 #工作 !高」，回车就带上了日期、项目、优先级。
     目标用户是每天记二十条的人：每条约省三次下拉，一天就少点六十次。

     四条设计纪律（每一条都对应一类误伤）：
       1. **猜错了必须当场看得见** —— 解析结果实时显示在输入框下面（.nlpbar）。
          解析本质是猜；猜错却不说，用户只有两种下场：被静默改错（过几天才发现日期不对），
          或者干脆再也不敢用这个语法。把「猜」变成「看得见的一步」，是这条功能能不能用的分水岭。
       2. **项目只认已有项目名** —— 「修复 bug #12」里的 #12 不该被当成项目。
          这是自然语言输入最常见的一类误伤，靠「精确命中已有项目」从根上避免。
       3. **全摘光了就退回原文** —— 解析不能让标题变成空的，那样回车什么都不发生，
          用户只会以为回车坏了。
       4. **可关** —— 设置页一个开关（默认开）。任何「聪明」的输入改造都必须留退路，
          因为它在某些写法上必然猜错。

    支持的写法：
      日期  今天 / 明天 / 后天 / 大后天 / N天后 / 周X / 星期X / 下周X / 下下周X /
            X月X日 / X/X / 2026-09-15 / 周末 / 下周末 / 月底
            （日期词后面紧跟的「前 / 之前 / 以内」一起摘掉 ——「本周末前」不留一个「前」）
      项目  #项目名 或 @项目名（须命中已有项目）
      优先级 !高 !中 !普通，或 !!! / !! / !（后面只能跟标点或句末：`!高度`、`!=` 都不算）
            或者口语的「优先级比较高」「比较紧急」（否定式「不着急」先判）
      备注  显式的「备注 / 说明 / 注：」，一直吃到句尾（「注」必须带冒号） */

  var WEEK_CN = { "一":1, "二":2, "三":3, "四":4, "五":5, "六":6, "日":7, "天":7 };

  /* 今天到「本周某个星期几」差几天。0 = 周一 … 6 = 周日（周一起算，和「本周完成」同一口径）。
     ★ 目标日已经过去就顺延到下周 —— 「周三」在周五说出口，指的是下周三。 */
  function nlWeekdayDelta(tw){
    var wd = (new Date().getDay() + 6) % 7;
    var delta = (tw - 1) - wd;
    return delta < 0 ? delta + 7 : delta;
  }

  /* 「下周X / 下下周X」按**日历上的自然周**算（中文习惯）：weeks=1 是下周、2 是下下周，tw=1..7。
     ★★ 旧写法是 `dateOffset(7 * weeks + tw - 1)`：它把「下周」当成了「七天以后那一周」，
        跟今天是周几**完全无关**地往后硬加天数 —— 周五说「下周一要完成」，它记成 9 天后，
        还落在周五。中文里「下周」指的是下一个自然周（周一起算的整个七天），
        「下周X」就得落在那个自然周的星期X 上。
        这是实测出来的错（而且老测试的注释还把它当成「和今天是周几无关，是个确定值」夸过一句，
        那个「确定」正是错因本身）。 */
  function nlNthWeekDay(weeks, tw){
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    var wd = (d.getDay() + 6) % 7;                 // 0 = 周一 … 6 = 周日
    d.setDate(d.getDate() - wd + weeks * 7 + (tw - 1));
    return ymd(d);
  }

  /* 标题收尾：压掉连续空白，再剪掉**首尾**孤零零的标点。
     摘片段之后常会在断口留一个「，」，只 trim 空白是清不掉的。 */
  function tidyTitle(s){
    return String(s == null ? "" : s)
      .replace(/\s{2,}/g, " ")
      /* ★ 标点前面不留空格（v0.24.0 尾）：摘片段时会在断口补一个占位空格，
         而断口右边常常正好是个逗号 ——「买菜 !高，顺便修水管」摘掉 `!高` 之后
         会变成「买菜 ，顺便修水管」。中文里逗号前面多一个空格，一眼就是机器拼的。 */
      .replace(/\s+([，,、；;：:！!？?。.）)】」』])/g, "$1")
      .replace(/^[\s，,、;；]+|[\s，,、;；]+$/g, "")
      .trim();
  }

  /* 找一个正则在文本里的**所有**命中，返回 [start, end) 列表。
     ★ 用 exec + g 循环而不是 String.match：带 g 的 match 只回匹配串、拿不到下标，
       而这里每个命中都要算「从标题里摘掉哪一段」。 */
  function nlAll(re, text){
    var out = [], m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      out.push([m.index, m.index + m[0].length]);
      if (!m[0]) re.lastIndex++;                   // 空匹配 → 推一格，防死循环
    }
    re.lastIndex = 0;
    return out;
  }

  /* X月X日：已经过去的月份/日期顺延到下一年 —— 这是个「安排未来」的工具，
     写下过去的日期时意图几乎一定是明年那个。2月30日 这种直接判无效。 */
  function nlMonthDay(mo, day){
    var now = new Date(); now.setHours(0,0,0,0);
    var y = now.getFullYear();
    var dt = new Date(y, mo - 1, day);
    if (isNaN(dt.getTime()) || dt.getMonth() !== mo - 1 || dt.getDate() !== day) return null;
    if (dt < now) dt = new Date(y + 1, mo - 1, day);
    return ymd(dt);
  }

  /* 日期规则表。★ 选「最先出现」的那个候选，不是选规则表里靠前的：
     「下下周三」里同时含「下下周」「下周」「周三」三个候选，按位置取才是用户的意思。 */
  var NL_DATES = [
    { re: /(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})[日号]?/,
      mk: function(m){ return m[1] + "-" + pad(+m[2]) + "-" + pad(+m[3]); } },
    { re: /(\d{1,2})月(\d{1,2})[日号]?/,
      mk: function(m){ return nlMonthDay(+m[1], +m[2]); } },
    { re: /(\d{1,2})\/(\d{1,2})/,
      mk: function(m){ return nlMonthDay(+m[1], +m[2]); } },
    { re: /大后天/, mk: function(){ return dateOffset(3); } },
    { re: /后天/,   mk: function(){ return dateOffset(2); } },
    { re: /(\d{1,3})\s*天(?:后|以后)/, mk: function(m){ return dateOffset(+m[1]); } },
    { re: /今天|今日/, mk: function(){ return dateOffset(0); } },
    { re: /明天|明日/, mk: function(){ return dateOffset(1); } },
    { re: /下下\s*(?:周|星期|礼拜)\s*([一二三四五六日天])?/,
      mk: function(m){ return nlNthWeekDay(2, m[1] ? WEEK_CN[m[1]] : 1); } },
    { re: /下(?:个)?周末/, mk: function(){ return dateOffset(nlWeekdayDelta(7) + 7); } },
    { re: /下\s*(?:周|星期|礼拜)\s*([一二三四五六日天])?/,
      mk: function(m){ return nlNthWeekDay(1, m[1] ? WEEK_CN[m[1]] : 1); } },
    { re: /(?:本)?周末/, mk: function(){ return dateOffset(nlWeekdayDelta(7)); } },
    { re: /(?:周|星期|礼拜)\s*([一二三四五六日天])/,
      mk: function(m){ return dateOffset(nlWeekdayDelta(WEEK_CN[m[1]])); } },
    { re: /(?:本)?月底/, mk: function(){
        var d = new Date();
        return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
      } }
  ];

  var NL_PRI  = { "高":"high", "中":"mid", "普通":"" };
  var NL_BANG = { "!!!":"high", "!!":"mid", "!":"" };

  /* `!高` 这一小段的**收尾边界** —— 两个正则共用，写成一处免得走偏。
     ★ 原来写的是 `(?=\s|$)`：中文里 `!高` 后面跟的通常是**全角标点**而不是空格
       （「买菜 !高，顺便修下水管」），于是它既不进优先级、又**留在标题里** ——
       屏幕上写着一个 `!高`、卡片上却是普通，看着就是解析坏了。
       这块是 v0.24.0 尾才暴露的：那版加了「，备注：…」这种写法，两个语法第一次
       撞在同一句里（「交周报 !高，备注：记得带电脑」）。
     ★ 也不能一路放宽成「后面不是汉字就行」：`a != b` 会被误判成高优。
       所以挡三样 —— 汉字/字母/数字（`!高度`）、代码里的运算符（`a != b`）、多余的 `!`。 */
  var NL_PRI_TAIL = "(?![A-Za-z0-9_\\u4e00-\\u9fa5!$%&*+\\-/:<=>@\\\\^|~#])";
  /* ★ 提成模块级、不带 g 的正则：exec 无状态，重用一个对象就够，
     不必每次解析都现 new 两个 RegExp。 */
  var NL_PRI_W_RE = new RegExp("(^|\\s)!(高|中|普通)" + NL_PRI_TAIL);
  var NL_PRI_B_RE = new RegExp("(^|\\s)(!{1,3})" + NL_PRI_TAIL);

  /* 口语里的紧急程度（v0.24.0 尾）。
     人不会为了记一条任务去打 `!高`，他会写「优先级比较高」「比较紧急」。
     ★ 刻意**只收明确的说法**，不收「重要」「优先」这两个词 —— 它们更常是标题正文本身
       （「优先考虑 B 方案」「把重要的事排前面」），摘掉等于把任务内容删了。 */
  var NL_URG_RE = /(?:优先级|优先度)\s*(?:比较|很|非常|挺|特别)?\s*高|(?:比较|很|非常|挺|特别|有点|真)?\s*(?:紧急|加急|急件|着急)|(?:比较|很|非常|挺|特别|有点|真)\s*急/g;
  /* ★★ 否定式**必须先判**：上面那条会命中「不着急」里的「着急」——
     不先拦住，说「不着急」的人反而被判成高优。猜错方向比不猜糟得多。 */
  var NL_CALM_RE = /不(?:太|怎么|那么)?\s*(?:着急|急)|慢慢来|有空再说|不赶|不催/g;

  /* 预览条 chip 的固定顺序：跟着「先想清楚什么时候、然后是哪摊事、最后多急、还有没有要交代的」
     走，而不是跟着代码里的处理顺序走（那是实现细节，不该漏到界面上）。
     ★ 提成模块级常量：正则认出来的 chips 和模型补的 chips 要**按同一把尺子混排**，
       两处各写一份迟早对不上，而对不上时屏幕上看不出谁对。 */
  var NL_CHIP_ORDER = { date:0, proj:1, pri:2, note:3 };
  function nlPriLabel(v){ return v === "high" ? "高" : (v === "mid" ? "中" : "普通"); }

  function projectNames(){
    return (projects || []).map(function(p){ return String(p.name || ""); });
  }
  function mdShort(sv){
    var p = String(sv).split("-");
    return (+p[1]) + "-" + pad(+p[2]);
  }

  /* 解析。title 是**已经摘掉命中片段**的干净标题；hits 只用来画预览条。
     没有任何命中时 hits 是空数组，界面上一片安静（这条功能平时应该「不存在」）。 */
  function nlParse(raw, names){
    names = names || [];
    var text = String(raw == null ? "" : raw);
    var cuts = [];                       // [start, end) —— 要从标题里摘掉的区间
    var hits = [];
    var out = { title: text.trim(), date:"", project:"", priority:"", note:"" };

    /* —— 优先级 ——
       ★ 收尾边界见 NL_PRI_TAIL（不能用 `(?=\s|$)`，中文后面跟的是全角标点）。 */
    var pw = NL_PRI_W_RE.exec(text);
    var pb = NL_PRI_B_RE.exec(text);
    if (pw || pb) {
      var useW = pw && (!pb || pw.index <= pb.index);   // 都命中时取更靠前的
      var m = useW ? pw : pb;
      var tok = useW ? ("!" + m[2]) : m[2];
      var at = m.index + m[0].indexOf(tok);
      out.priority = useW ? NL_PRI[m[2]] : NL_BANG[m[2]];
      cuts.push([at, at + tok.length]);
      hits.push({ k:"pri", lb:"优先级", v:nlPriLabel(out.priority) });
    }

    /* —— 口语里的紧急程度（v0.24.0 尾）——
       「优先级比较高，比较紧急」这种写法要能认。两处命中就都从标题里摘掉 ——
       只摘一处的话另一处留在标题里，看着像没解析干净。
       ★ 不覆盖显式标记：已经写了 `!中` 就以 `!中` 为准（明确的写法比口语更算数）。 */
    var calmSpans = nlAll(NL_CALM_RE, text);
    var urgSpans  = nlAll(NL_URG_RE, text);
    var useUrg = !!urgSpans.length &&
                 (!calmSpans.length || urgSpans[0][0] <= calmSpans[0][0]);
    var mood = useUrg ? urgSpans : calmSpans;
    for (var s2 = 0; s2 < mood.length; s2++) cuts.push(mood[s2]);
    if (useUrg && !out.priority) {
      out.priority = "high";
      hits.push({ k:"pri", lb:"优先级", v:"高" });
    }
    /* ★ 否定式（「不着急」）只把词摘掉、**不写优先级**：任务默认就是普通，
       凭空写一个「普通」上去，等于替用户做了一个他没做的决定。 */

    /* —— 项目：只认已有项目名。
       ★ 用「前缀匹配」而不是全等：写「交周报#工作。」时句号会被一起吞进来，
         全等就永远匹配不上。（也只吃前缀命中那一段，句号留在标题里。） */
    var pmo = /([#@])([^\s#@!]+)/g, pm;
    while ((pm = pmo.exec(text))) {
      var tok2 = pm[2], best = null;
      for (var i = 0; i < names.length; i++) {
        var nm = names[i];
        if (!nm) continue;
        if (tok2.toLowerCase().indexOf(nm.toLowerCase()) === 0 &&
            (!best || nm.length > best.length)) best = nm;
      }
      if (best) {
        out.project = best;
        cuts.push([pm.index, pm.index + 1 + best.length]);
        hits.push({ k:"proj", lb:"项目", v:best });
        break;                            // 一条任务只归一个项目，后面的 # 当普通文字
      }
    }

    /* —— 日期：取最先出现的那个候选 —— */
    var bestAt = -1, bestV = null, bestTok = null;
    for (var r = 0; r < NL_DATES.length; r++) {
      var mm = NL_DATES[r].re.exec(text);
      if (!mm) continue;
      var v = NL_DATES[r].mk(mm);
      if (!v) continue;                   // 2月30日 这种：这一条作废，继续试其他规则
      if (bestAt < 0 || mm.index < bestAt) { bestAt = mm.index; bestV = v; bestTok = mm[0]; }
    }
    if (bestV) {
      /* ★ 日期词后面紧跟的「前 / 之前 / 以内」一起摘掉 ——
         「本周末前把方案定了」只摘「本周末」的话，标题会剩一个「前把方案定了」。
         这类残留最阴的地方是：日期是对的，所以只看预览条根本发现不了，
         要盯着标题才看得出来。 */
      var tailM = /^\s*(?:之前|以前|之内|以内|前)/.exec(text.slice(bestAt + bestTok.length));
      if (tailM) bestTok += tailM[0];
      out.date = bestV;
      cuts.push([bestAt, bestAt + bestTok.length]);
      hits.push({ k:"date", lb:"日期", v: dateLabel(bestV) + "，" + mdShort(bestV) });
    }

    /* —— 备注：显式的「备注 / 说明 / 注：」一直吃到句尾 ——
       ★ 必须吃到句尾，不能只吃一个词：备注是自由文本，长度不可预期。
       ★ 与已命中的片段**重叠就放弃**（宁可少拆，不能拆错）：
         「备注：带上合同，周一开会」里日期落在备注词之后，两者抢同一段文字，
         这时硬拆会把日期也吞进备注。
       ★ 「注」必须带冒号 —— 不然「注意别迟到」会被拆成备注「意别迟到」，
         而那句话本身就是任务，不是备注。 */
    var nm = /(?:^|[\s，,、;；])(?:备注|说明|注\s*[:：])\s*[:：]?\s*([\s\S]+)$/.exec(text);
    if (nm) {
      var noteVal = nm[1].trim();
      var clash = false, nFrom = nm.index;
      for (var c2 = 0; c2 < cuts.length; c2++) {
        if (cuts[c2][0] < text.length && cuts[c2][1] > nFrom) { clash = true; break; }
      }
      if (noteVal && !clash) {
        out.note = noteVal;
        cuts.push([nFrom, text.length]);
        hits.push({ k:"note", lb:"备注",
                    v: noteVal.length > 14 ? noteVal.slice(0, 14) + "…" : noteVal });
      }
    }

    /* —— 摘掉命中片段，剩下的才是标题 —— */
    if (cuts.length) {
      cuts.sort(function(a,b){ return b[0] - a[0]; });   // 从后往前删，前面下标才不错位
      var t = text;
      for (var c = 0; c < cuts.length; c++) {
        var s0 = cuts[c][0], e0 = cuts[c][1];
        /* ★ 断口清理：被摘片段左边要是紧挨着一个分隔标点，把它一起带走。
           不然标题尾巴上会留一个孤零零的「，」（「交周报，备注：带电脑」→「交周报，」）。
           查 original 串而不是正在被改的那个：s0 左边的文字从没被改过，用原件更稳。
           ★ 左边是**空白**的情况不在这里处理：下面一律补一个占位空格（防止把两个词粘起来），
             真要收走的是「这个占位空格正好落在标点前面」那种，交给 tidyTitle 统一收
             —— 两处各收一半，就会变成「谁生效看不出来」。 */
        if (s0 > 0 && /[，,、;；]/.test(text.charAt(s0 - 1))) s0 -= 1;
        t = t.slice(0, s0) + " " + t.slice(e0);
      }
      /* 收尾：压掉连续空白，再把标题**首尾**孤零零的标点剪掉（断口清理可能又留一个）。 */
      t = tidyTitle(t);
      /* ★ 全摘光了就退回原文：解析失败不能让标题变空（回车会什么都不发生，用户以为回车坏了）。 */
      out.title = t || text.trim();
    }

    /* 预览顺序固定成 日期 → 项目 → 优先级 → 备注（顺序表见上面的 NL_CHIP_ORDER）。 */
    var order = NL_CHIP_ORDER;
    hits.sort(function(a,b){ return order[a.k] - order[b.k]; });
    out.hits = hits;
    return out;
  }

  /* 解析预览条。★ 只读 —— 不给 chip 加「点掉」的操作：
     点掉之后文本和结果就不一致了（字还在输入框里），会立刻长出第二套要维护的状态。
     改主意直接改输入框里的字，预览跟着变。 */
  function renderNlpBar(){
    var bar = document.getElementById("nlpBar");
    var inp = document.getElementById("newTitle");
    if (!bar || !inp) return;
    bar.innerHTML = "";

    var raw = inp.value.trim();
    var r = (prefs.nlp && raw) ? nlParse(raw, projectNames()) : null;
    var chips = r ? r.hits.slice() : [];
    /* 模型补的那些槽位接在同一行后面（用虚线边框区分 —— 它们是**读出来的**，
       不是用户写下的标记）。★ 只收正则没认出来的：同一个槽位显示两遍会读成两条信息。 */
    var s = (prefs.nlp && raw) ? (aiPreShot || {})[raw] : null;
    if (s) chips = chips.concat(aiSlots(r || nlParse("", []), s));
    if (!chips.length) { bar.hidden = true; return; }

    chips.sort(function(a,b){ return NL_CHIP_ORDER[a.k] - NL_CHIP_ORDER[b.k]; });
    bar.appendChild(document.createTextNode("识别为"));
    for (var i = 0; i < chips.length; i++) {
      var c = document.createElement("span");
      c.className = "nlpc k-" + chips[i].k + (chips[i].ai ? " ai" : "");
      var b = document.createElement("b");
      b.textContent = chips[i].lb;
      c.appendChild(b);
      c.appendChild(document.createTextNode(chips[i].v));
      bar.appendChild(c);
    }
    bar.hidden = false;
  }

  /* ============================================================
     AI 兜底（v0.16.0）

     先说清楚这个功能**不做什么**，因为这几条比它做什么更重要：

       它不打扰。不会弹窗、不会在卡片上加一个「AI 觉得」的角标、不会因为你没理它就憋着 ——
         它的结论只出现在**输入框下面那条预览**里，你不看它就等于不存在。
       ★ v0.24.0 尾：原来是「你不回车，它不存在」，现在改成**输入停顿就先问一次**，
         把判断提前摆在预览条上。这是同一件事的两面：让它出现在预览里，
         是为了让「回车之后才发现它猜错了」这个场景根本不发生。
         变的是**调用时机**，不是性格 —— 它仍然不写任何数据、不改任何字，
         回车之前它对任务台没有半点影响。
       它不覆盖。正则认出来的槽位一个字都不动 —— 那是你熟悉的写法，
         改它就是在跟你的预期打架。它只填空着的那些。
       它不改写。标题只在「模型给的更短、而且是原话的子串」时才采纳。
         它想把「把方案发给张总」润成「发送方案给张总」，一律不接受。
       它不解释。失败、超时、格式不对、值越界 —— 全部收敛成「什么都不发生」。
         ★ 模型永远会给一个答案，它不会说「我不确定」。所以门限只能由代码保证：
           宁可不说，不能说错。用户被 AI 猜错五六次之后，会永久关掉这个功能，
           而那个代价比「少省几十次点击」大得多。

     为什么落库仍然是**同步**的：回车必须**立刻**建出任务来（这条产品的性格，
     也是 v0.9.1 那四条设计纪律里「猜错了必须当场看得见」的前提）。
     等模型回来再建任务，等于让每次回车都赌一次网络。
     所以先按正则建、几秒后模型想明白了就地改好，再给一个 5 秒的撤销。
     ★ 停顿预览已经问过的那条，回车时直接把结果并进去（预览上写着什么就落什么）——
       否则预览是个承诺、落库是另一回事，那比不给预览更糟。
     ============================================================ */

  var aiAsked = {};        // 一条任务只问一次。弹窗关掉就重来，最多多问一次，不累积。

  /* ---------- 输入停顿后的预览（v0.24.0 尾）----------
     打字停下来 900ms 就问一次模型，把它的判断**先摆在预览条上**。
     ★ 为什么不每敲一个字都问：那是把用户当输入法用 —— 一次网络请求换一个字符的变化。
     ★ 为什么不等到回车才问：那样「模型猜错了」只能等任务建完才知道，
       而这条功能整条存在的理由就是「猜错了必须当场看得见」—— 回车前后都该看得见。
     ★ 同一段文字只问一次（拿输入内容当键）。改一个字才算新问题；改回来也不重问。 */
  var aiPreShot = {};      // 输入串 → 模型的建议（问过且有结果才有键）
  var aiPreTimer = null;
  var AI_PRE_MS = 900;

  /* 「值不值得问模型」—— 预览和回车**共用这一个判据**。
     短句（「买咖啡豆」）没有可拆的东西，问了只是白花一次调用。
     ★ 两处必须一致：一处宽一处窄，就会出现「预览条上认出来了、回车之后又没了」
       这种自相矛盾，而这正是这个功能最不能出的错。 */
  function worthAsk(raw){
    return String(raw).length >= 12 || /[，,；;、]/.test(raw);
  }

  /* 把模型的建议整理成 chips —— **只收正则没认出来的槽位**。
     正则已经认出来的那个槽位，模型说什么都不显示：用户写的是他熟悉的写法，
     再摆一个上去只会让预览条变长，还让人以为有两份信息。 */
  function aiSlots(r, s){
    var out = [];
    if (s.dateWord && !r.date) {
      /* 模型只给相对词（「下周三」），换算仍然走现成那张规则表 —— 不让模型直接给日期。 */
      var dr = nlParse(s.dateWord, []);
      if (dr.date) out.push({ k:"date", lb:"日期", ai:1,
                              v: dateLabel(dr.date) + "，" + mdShort(dr.date) });
    }
    if (s.project && !r.project) out.push({ k:"proj", lb:"项目", v:s.project, ai:1 });
    if (s.priority && !r.priority) out.push({ k:"pri", lb:"优先级", v:nlPriLabel(s.priority), ai:1 });
    if (s.note && !r.note) {
      out.push({ k:"note", lb:"备注", ai:1,
                 v: s.note.length > 14 ? s.note.slice(0, 14) + "…" : s.note });
    }
    return out;
  }

  /* 把模型的建议并进解析结果 —— **只填空缺**，正则认出来的一律不动。
     和 aiFallback 里那套是同一个口径，只是时机不同（一个在回车前、一个在回车后）。 */
  function mergeAi(r, s){
    if (!r.date && s.dateWord) {
      var dr = nlParse(s.dateWord, []);
      if (dr.date) r.date = dr.date;
    }
    if (!r.project && s.project) r.project = s.project;
    if (!r.priority && s.priority) r.priority = s.priority;

    var tookNote = false;
    if (!r.note && s.note) {
      r.note = s.note;
      /* ★★ 备注收下了，就把它**从标题里摘掉** —— 同一段话在标题和备注里各出现一次
         就是重复（用户在卡片上会看到两遍「要提前定会议室」）。
         这一摘仍然守着「只摘、不写」：删掉的正是刚放进备注的那一段，
         模型没有任何机会往标题里塞新词。 */
      if (r.title.indexOf(s.note) >= 0) {
        r.title = tidyTitle(r.title.replace(s.note, ""));
        tookNote = true;
      }
    }
    /* 模型给的标题（更短 + 是原话的子串）只在**没摘过备注**时才考虑 ——
       它比「把备注那段摘走」更保守，优先级也更低。 */
    if (!tookNote && s.title && s.title.length >= 2 && s.title.length < r.title.length &&
        r.title.indexOf(s.title) >= 0) r.title = s.title;
    return r;
  }

  function aiPreTick(){
    aiPreTimer = null;
    var inp = document.getElementById("newTitle");
    if (!inp || typeof AI === "undefined") return;
    var raw = inp.value.trim();
    if (!prefs.nlp || !raw) return;
    if (!worthAsk(raw)) return;
    if (Object.prototype.hasOwnProperty.call(aiPreShot, raw)) return;

    var base = nlParse(raw, projectNames());
    if (base.date && base.project && base.note) return;   // 正则全认出来了，没有模型可插话的地方

    aiPreShot[raw] = { note:"" };                         // 先占位，防同一段文字被问两遍
    AI.suggestTask(raw, projectNames()).then(function (s) {
      /* ★ 失败 / 没配置 → **把占位删掉**，下次停顿还能重试。
         留一个「问过但没结果」的哨兵值，等于把「暂时不行」变成「一直不行」——
         那条教训在「本周小结」的缓存里已经写过一次了。 */
      if (!s) { delete aiPreShot[raw]; return; }
      aiPreShot[raw] = s;
      var el = document.getElementById("newTitle");
      /* ★ 期间用户又改过字 → 这份结果已经对不上了，扔掉。
         不扔的话预览会张冠李戴：屏幕上写着 A，下面注解着 B。 */
      if (!el || el.value.trim() !== raw) return;
      renderNlpBar();
    });
  }
  /* 撤销用的版本号。★ 存内存，不写进任务对象 —— 写进去的话，它会跟着导出 JSON
     和飞书同步一起走，在用户自己的数据里留一个只对我们有意义的字段。 */
  var aiRev = {};
  /* ★★ v0.26.0：这里原来住着 `aiWeekly()`（本周小结）—— 连同它的 wkCache、AIWK
     （`taskboard.ai.weekly` 缓存）、以及 ai.js 里的 `weeklyLine` 一起删干净了。
     老大原话：「不希望呈现出无关的乱七八糟的内容」。
     ★ 为什么整段删而不是留着不调用：底栏那段「本周完成 5 件·这周总算有进展，
       上周还完全没动。」里，前半是算出来的、后半是**模型现写的** —— 而它写什么
       完全不受控（那句「上周还完全没动」就是在替用户下判断）。
       删掉之后 AI 设置页的「本周小结」开关也没了落点，所以那个开关跟着删，
       别留一个拨了没反应的死开关。
     ★ 顺带被删的还有 `scenes.weekly`：SCENES 是**配置读写的遍历表**，
       从表里摘掉一项，老配置里那个字段会被 readCfg 自然丢弃，不用写迁移。 */

  /* 解析兜底。base 是正则的结果，只用来判断「哪个槽位还空着」。 */
  function aiFallback(id, raw, base){
    if (typeof AI === "undefined" || aiAsked[id]) return;
    aiAsked[id] = 1;

    AI.suggestTask(raw, projectNames()).then(function (s) {
      if (!s) return;                            // 失败 = 什么都不发生

      var t = null;
      for (var i = 0; i < st.tasks.length; i++) if (st.tasks[i].id === id) t = st.tasks[i];
      if (!t) return;                            // 已经被删了
      /* ★ 用户已经把标题改过了 → 这条已经不是刚才那条了，收手。
         判据用「标题变没变」而不是「过了几秒」：时间是猜的，标题是事实。 */
      if (t.title !== base.title) return;

      var patch = {}, bits = [];

      /* 日期：★ 模型只给了个相对词，换算交给上面那张现成的规则表（nlParse）。
         不让模型直接给 YYYY-MM-DD —— 它算日期必然会错，而且错得毫无规律。 */
      if (!base.date && s.dateWord) {
        var dr = nlParse(s.dateWord, []);
        if (dr.date && dr.date !== t.date) { patch.date = dr.date; bits.push(dateLabel(dr.date)); }
      }
      if (!base.project && s.project && s.project !== t.project) {
        patch.project = s.project; bits.push("#" + s.project);
      }
      if (!base.priority && s.priority) {
        patch.priority = s.priority; bits.push(nlPriLabel(s.priority));
      }
      /* 备注：★ 只填空着的（正则认出来的显式「备注：」一个字都不动），
         而且**不落优先级/日期的位置** —— 它是补充说明，不是第二个标题。
         这一条正是「要提前定会议室」那类话的去处：它是任务的内容，不是任务本身。 */
      var tookNote = false;
      if (!base.note && s.note && s.note !== t.note) {
        patch.note = s.note; bits.push("备注");
        /* ★★ 收下备注之后，把它**从标题里摘掉** —— 不摘的话同一段话会在标题和备注里
           各出现一次（卡片上看着就是重复）。仍然只摘、不写：
           删掉的正是刚放进备注的那一段，模型没机会往标题里塞新词。 */
        if (t.title.indexOf(s.note) >= 0) {
          patch.title = tidyTitle(t.title.replace(s.note, ""));
          tookNote = true;
          bits.push("标题");
        }
      }
      /* 标题：只能摘、不能改写（见文件头那段）。
         ★ 已经因为「摘备注」动过标题就不再动它 —— 一次只做一件事，出了错好归因。 */
      if (!tookNote && s.title && s.title.length >= 2 && s.title.length < t.title.length &&
          t.title.indexOf(s.title) >= 0) {
        patch.title = s.title; bits.push("标题");
      }

      if (!bits.length) return;                  // 一个槽位都没补上 → 静默

      var before = { title: t.title, date: t.date, project: t.project,
                     priority: t.priority, note: t.note };
      var ok = false;
      for (var k in patch) { if (patch.hasOwnProperty(k)) { t[k] = patch[k]; ok = true; } }
      if (!ok) return;

      var rev = (t._aiRev = (t._aiRev || 0) + 1);
      save().then(function () {
        render();
        toast("补上了：" + bits.slice(0, 2).join(" · "), "撤销", function () {
          /* ★ 撤销前先确认这期间用户没再动过这一条：
             否则「撤销」会把用户自己刚做的修改一起抹掉，那比不改还糟。 */
          if (t._aiRev !== rev) return;
          for (var k2 in before) { if (before.hasOwnProperty(k2)) t[k2] = before[k2]; }
          save().then(render);
        });
      });
    });
  }

  /* ---------- 状态 ---------- */
  var st = { view:"today", tasks:[] };
  var projects = defaultProjects();
  /* 有能力探测才有降级：支持 showPicker() 的浏览器（Chrome 99+）才隐藏原生小图标、
     换成我们自己的满铺命中层；不支持就整块保持原样（原生图标还在，还是能点）。 */
  if (typeof HTMLInputElement !== "undefined" && HTMLInputElement.prototype &&
      typeof HTMLInputElement.prototype.showPicker === "function") {
    document.documentElement.classList.add("has-showpicker");
  }

  var dragState = null;
  var activeCommit = null;   // 当前就地编辑的提交函数（保证一次只有一张卡在编辑）
  var pendingRender = null;  // 刚提交完、重绘还没落地的那次 render（打开下一张卡前要等它）
  var flyOpen = false;
  /* 完成反馈的「播报窗口」。
     ★ 不能只记一个待播 id：拖进「已完成」之后 save() 要写 storage，而写 storage 会触发
       chrome.storage.onChanged，那个监听里**也会 render() 一次** —— 于是刚贴上动画的那张卡
       立刻被整列重建换掉，动画当场死掉。用户看到的就是「什么反馈都没有」。
       改成窗口（id + 截止时刻）：窗口期内不管被重绘几次，动画都会重新贴到新卡上。
       CELEBRATE_MS 比动画本身（约 620ms）长一点，留出重绘的余量。 */
  var celebrating = null;        // { id, until }
  var CELEBRATE_MS = 900;
  var searching = "";            // 搜索关键词（小写；空 = 没在搜）
  var qpop = null;               // 快速改期浮层（挂 body 下 + fixed）

  /* ---------- 归档 ----------
     归档 = 打一个**本地标记**，数据一条不动地留在 chrome.storage.local 里（导出 JSON 能看到），
     只是不再出现在看板/搜索结果里。
     ★ 刻意不进飞书快照：快照是「内容比对」的基线，多一个本地字段就会让两边永远觉得对方变过。
       archived 只在本地生效，飞书那边这条记录照旧，不会产生假冲突。 */
  function isArchived(t){ return !!(t && t.archived); }

  /* ---------- 「这活交出去了吗」（v0.43.0）----------
     ★★ **判据本体不在这里**，在 `inbox.js` 的 `Inbox.isGivenAway` —— 因为球
       （`ballpage.js` 的角标）和吉祥物（`notify.js` 开口）也要用同一条，
       而 `inbox.js` 是**三个 runtime 唯一共用的模块**。这里只是一层同名的薄包装，
       让本文件读起来不必到处写 `Inbox.` 前缀。

     ★ 「交出去」为什么等于「不属于个人待办」：个人清单回答的是「我现在要做什么」，
       而一件已经在别人桌上的事留在里面，会让「今天要做几件事」这个数字**永远偏大**，
       而那正是这个工具最核心的数字。⇒ 交出去的活只在团队视图/发件箱里出现。

     ★★★ `revoked` / `failed` / `sending` **都不算交出去**（白名单，见 `inbox.js` 的
       判据本体）。本文件里尤其要紧的是 `revoked`：`revokeAssign` 的实现是
       「**保留 `assign`、只把 `st` 改成 `revoked`**」，判据写成最自然的 `!!t.assign`
       会把撤回的活**永久藏掉**，比原来的 bug 更糟（原来至少看得见）。

     ★★★★ **兜底不再重写判据。** 本版初稿的 6 个薄包装（本文件 + `ballpage.js` +
       `notify.js` + `background.js` + `board.js` + `manage.js`）**各自抄了一份**
       `!!(a && a.to && a.st !== "revoked")` —— 那就是这个 bug 的成因本身
       （「同一个判断在多处各写一遍」）在收口之后**又长回来一次**。
       而且抄的那份语义已经是错的：它把「派发失败」的活也当成交出去了。
       ⇒ 现在只留一句「拿不到就退化成 `false`」——**安全方向**（宁可多显示一条，
       不可把活藏掉），并且**门盯着本函数体里不许再出现 `recorded` / `failed` /
       `a.to` 这类判据字面量**（G11）。谁把判据抄回来，门就红。

     ★ 与 `isArchived` 并列：两者都回答「这条任务该不该出现在个人清单里」，
       只是理由不同（一个是我收起来了，一个是我交出去了）。 */
  function isGivenAway(t){
    if (typeof Inbox === "undefined" || !Inbox.isGivenAway) return false;
    return Inbox.isGivenAway(t);
  }

  /* ---------- 「这条算我的『我派的』那一摞吗」（v0.43.0）----------
     ★★★★ **与上面那个是两件事**，别合并（初稿合并过，是一个真 bug）：
       `isGivenAway` 过滤**个人视图**；`isOutgoing` 填**「我派的」那一摞**。
       `failed`（派发失败）与 `sending`（派发中）在两边**答案正好相反** ——
       没离开我的手（要留在个人视图）**但**我确实派过（要出现在「我派的」里）。
       ★ 后者不是口味问题：「重派一次」那颗按钮**只画在「我派的」那一行上**，
         排除掉 = 派发失败之后**再没有任何地方能重派**。
     ★ 判据本体在 `inbox.js`（`Inbox.isOutgoing`），本函数只是一层薄包装；
       退化方向与上面那条一致 —— 拿不到就 `false`（**安全方向**）。 */
  function isOutgoing(t){
    if (typeof Inbox === "undefined" || !Inbox.isOutgoing) return false;
    return Inbox.isOutgoing(t);
  }

  /* ---------- 「我手头的活」（v0.43.0）----------
     = 未归档、且还没交出去。**全项目唯一的「我的活」口径。**
     底栏计数、三个个人视图、挂起浮层、归档已完成的判定、「按项目」批量派发的候选集，
     全部走它。

     ★★ 为什么要抽这一层，而不是在哪里用就在哪里写两个 `!`：
       「未归档 + 未交出」这个组合在本版初稿里出现在 **6 处**，而 PRD 当初只列了 3 处。
       另外 3 处（`outItems` / `clearDone` 的两个条件 / `runProjDispatch` 的候选集）
       是**量现场**时逐个找出来的 —— 漏掉它们**不会报任何错**，
       只会让「看得见的」和「动得了的」悄悄对不上：
         · `outItems` 漏 ⇒ 「发件箱说交出去了、个人视图说还在我手上」；
         · `clearDone` 漏 ⇒ 看得见 2 条、点一下说归档了 3 条；
         · `runProjDispatch` 漏 ⇒ 列表里看不见的活被批量改派给别人。
       这三条都是同一个形状：**同一个判断在多处各写一遍，改的时候只改到一半。**
       ⇒ 收口成一个函数，改坏了是**一起**坏（门盯得住），不会一半对一半错。

     ★ 注意方向：`isGivenAway` 是「交出去了吗」，这里是「还在我手上吗」——
       两者互为反面，**都保留**：`outItems` 要的是前者，其余要的是后者。
       写成一个、在别处加 `!` 会让人读的时候要绕一圈（`!isGivenAway` 出现在 6 个地方，
       总有一天有人手滑少写一个 `!`，而那种错**语法完全合法**）。 */
  function myTasks(){
    return (st.tasks || []).filter(function(t){
      return !isArchived(t) && !isGivenAway(t);
    });
  }

  /* ---------- 搜索 ----------
     命中标题或备注。★ 不用 innerHTML 拼高亮：标题/备注是用户输入，拼 HTML 就是注入。 */
  function hitTask(t, q){
    if (!q) return false;
    return String(t.title == null ? "" : t.title).toLowerCase().indexOf(q) >= 0 ||
           String(t.note  == null ? "" : t.note ).toLowerCase().indexOf(q) >= 0;
  }

  function setHit(el, text, q){
    text = String(text == null ? "" : text);
    el.textContent = "";
    if (!q) { el.textContent = text; return; }
    var low = text.toLowerCase(), i = 0;
    for (;;) {
      var k = low.indexOf(q, i);
      if (k < 0) { el.appendChild(document.createTextNode(text.slice(i))); return; }
      if (k > i) el.appendChild(document.createTextNode(text.slice(i, k)));
      var m = document.createElement("mark");
      m.textContent = text.slice(k, k + q.length);
      el.appendChild(m);
      i = k + q.length;
    }
  }

  /* 快速改期用的日期：今天+n 天 */
  function dateOffset(n){
    var d = new Date();
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  /* 日历小图标。★ createElementNS 必须 —— SVG 命名空间之外建的 <rect>/<path>
     浏览器不认，静默不渲染（和完成勾那处同一个坑）。 */
  function calIcon(){
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("width", "12"); svg.setAttribute("height", "12");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.1");
    svg.setAttribute("stroke-linecap", "round");
    var r = document.createElementNS(NS, "rect");
    r.setAttribute("x", "1.3"); r.setAttribute("y", "2.4");
    r.setAttribute("width", "9.4"); r.setAttribute("height", "8.3");
    r.setAttribute("rx", "1.7");
    svg.appendChild(r);
    var l = document.createElementNS(NS, "path");
    l.setAttribute("d", "M1.3 5h9.4M3.9 1.3v2.1M8.1 1.3v2.1");
    svg.appendChild(l);
    return svg;
  }

  function uid(){ return Math.random().toString(36).slice(2,9); }

  function projColor(name){
    for (var i=0;i<projects.length;i++) if (projects[i].name === name) return projects[i].color;
    return "#9aa1ac";
  }
  function projIndex(name){
    for (var i=0;i<projects.length;i++) if (projects[i].name === name) return i;
    return 99;
  }

  /* ---------- 优先级 ----------
     两套机制并存：优先级是「手动覆盖」，位置是「零操作默认」。
       · 设了 priority 的任务 → 严格按档位渲染；
       · 没设的 → 按它在列内的位置，前 3 条按高亮档渲染。
     这样新用户一个设置都不用碰，就能得到「最上面三件最显眼」；
     想精确控制的人也有地方设。两者不打架 —— 设了的那条只影响它自己。 */
  var P_RANK = { high: 0, mid: 1, "": 2 };
  var AUTO_TOP = 3;                       // 位置驱动：每列前几条算高优

  function normPriority(v){
    return (v === "high" || v === "mid") ? v : "";
  }

  /* 决定这张卡用哪一档亮度。idx = 它在所属列内排序后的位置。 */
  function resolvePriority(t, idx){
    var p = normPriority(t.priority);
    if (p) return p;
    return idx < AUTO_TOP ? "high" : "";
  }

  /* ---------- 排序 ---------- */
  function byDate(a,b){
    var ra = dateRank(a.date), rb = dateRank(b.date);
    if (ra !== rb) return ra - rb;
    return (a.createdAt||0) - (b.createdAt||0);
  }
  function byProject(a,b){
    var ia = projIndex(a.project), ib = projIndex(b.project);
    if (ia !== ib) return ia - ib;
    return dateRank(a.date) - dateRank(b.date);
  }
  function byDoneDesc(a,b){ return (b.doneAt||0) - (a.doneAt||0); }

  /* 列内出场顺序 = 显式序位 → 优先级 → 视图原本的规则。
     ★ 显式序位（order）排最前，是为了让「在飞书表里把某行挪到第一」真的生效 ——
       那是唯一一个能表达「我就要它排第一」的手动信号。
     ★ 优先级排第二，是为了让亮度和位置一致：高优的真的在列顶。
       否则一条高优任务躺在列尾发光，人会以为亮度是随机给的，规则就白定了。 */
  function cmpInCol(base){
    return function(a,b){
      var oa = (typeof a.order === "number" && isFinite(a.order)) ? a.order : null;
      var ob = (typeof b.order === "number" && isFinite(b.order)) ? b.order : null;
      if (oa !== null || ob !== null) {
        if (oa === null) return 1;      // 没序号的一律排在有序号的后面
        if (ob === null) return -1;
        if (oa !== ob) return oa - ob;
      }
      var pa = P_RANK[normPriority(a.priority)], pb = P_RANK[normPriority(b.priority)];
      if (pa !== pb) return pa - pb;
      return base(a, b);
    };
  }

  /* ---------- 渲染 ---------- */
  /* 哪些任务出现在看板上。
     ① 归档的一律不出现（它是「收起来」，不是「删掉」）；
     ② 正在搜索时**忽略视图筛选** —— 搜索的目的就是「把找不回来的东西找回来」，
        还守着「今天」这一格等于白搜。
     ★★★ v0.43.0：交出去的活（`isGivenAway`）也不出现。
       **这一处是全项目个人视图的唯一出口**（「今天 / 按日期 / 按项目」三个视图
       共用它，见 `render()`）。为什么必须收在这一处、不逐视图加条件：
       逐视图改要写 5 处（今天 / 按日期 / 按项目 / 挂起浮层 / 底栏计数），
       少写一处就会出现「按日期藏了、按项目没藏」—— 而**那种不一致正是本版这个
       bug 的形态本身**（同一条任务在两套视图里各露一次脸）。
       收口一处的收益是**验收能一句话证完**：个人视图取数的唯一入口带判据。 */
  function visibleTasks(){
    if (searching) {
      return myTasks().filter(function(t){ return hitTask(t, searching); });
    }
    var list = myTasks();
    return st.view === "today" ? list.filter(inToday) : list;
  }

  function render(){
    /* ★★★ v0.40.0：团队任务视图是一块**独立的容器**（两个分区），它不画本地任务 ——
       所以在这里**整块分流**：切到 team 就立刻交给 `renderTeam()`，下面这 200 行一行都不跑。
       ★ P0-1 的验收是「切回『今天』时的行为与改动前**逐字一致**」——
         靠的就是这一刀切干净，而不是到既有分支里到处塞 `if (st.view === "team")`
         （那种改法会让「今天」那条路径也沾上团队逻辑，验收根本没法证）。
       ★ `renderTeamCount()` 在两个分支之前调：入口上那个数字与当前在哪一屏无关。 */
    renderTeamCount();
    if (st.view === "team") { setTeamMode(true); renderTeam(); return; }
    setTeamMode(false);

    var vis = visibleTasks();
    var buckets = {todo:[],doing:[],done:[]};
    vis.forEach(function(t){ if (buckets[t.status]) buckets[t.status].push(t); });

    // 挂起【不】跟着视图筛选走。它是「停车场」，数量不能随视角变：
    // 否则在「今天」视图里，一件下周才该做、被你挂起的事会连数字都不剩，
    // 那就等于把人忘了 —— 挂起是「暂时不做」，不是「假装没有」。
    /* ★★ 搜索时挂起也必须跟着筛。不筛的话底栏那句「搜索命中 N 项」会把
       **不匹配**的挂起任务也算成命中 —— 搜一个词明明只出来 2 张卡，却说命中 3 项，
       而第 3 条还得点开挂起浮层才找得到。数字和眼前看到的对不上，是最伤信任的一类。
       （这个 bug 是出验收图时盯着底栏数字发现的：当时的种子数据里没有挂起项，测试没覆盖到。） */
    /* ★ v0.43.0：挂起浮层同样要排除「交出去的活」—— 它是**个人**停车场，
       一辆已经开走的车不该还占着车位。 */
    var holds = myTasks().filter(function(t){
      return t.status === HOLD && (!searching || hitTask(t, searching));
    });

    var cmp = cmpInCol(st.view === "project" ? byProject : byDate);

    /* ★ v0.36.0：「按项目」视图里插**项目分组行**，并在待办列那一行右侧放派发入口。
       为什么：老大开了团队派发却在界面上找不到「派发给其他人」——
       原来那个入口只藏在任务抽屉里，而且要先勾「派给团队成员」才出现；
       「按项目」视图里一个都没有。拍板就是把入口放到项目那一行上。
       ★ 已完成列**不分组**：它按完成时间倒序（刚完成的最上），
         分组会把这条最有用的顺序打碎；已完成的东西也不需要再派人。 */
    var grouped = (st.view === "project");

    STATUSES.forEach(function(s){
      // 已完成列按完成时间倒序：刚完成的排最上面
      buckets[s].sort(s === "done" ? byDoneDesc : cmp);

      var body = document.querySelector('.col-body[data-status="'+s+'"]');
      body.dataset.empty = emptyText(s);
      body.innerHTML = "";
      // 把列内位置传进去：优先级亮度里「没设档就看位置」那一条依赖它
      if (grouped && s !== "done") appendGrouped(body, buckets[s], s);
      else buckets[s].forEach(function(t, i){ body.appendChild(cardEl(t, false, i)); });

      var cntEl = document.querySelector('.col[data-status="'+s+'"] .count');
      cntEl.textContent = buckets[s].length;
      // 认知科学结论：手头选项超过 7 个，决策质量明显下滑 → 待办列给个温和提示
      cntEl.classList.toggle("hot", s === "todo" && st.view === "today" && buckets[s].length > 7);
    });

    renderHold(holds);
    /* ★ v0.39.0：底栏那个「我派的 N」跟着一起更新。
       ★ 计数**只看 `st.tasks`**、与当前视图/搜索无关 —— 它回答的是
         「我交出去了多少活」，不是「这一屏筛选出了几条」。 */
    renderOutbox();

    var hits = buckets.todo.length + buckets.doing.length + buckets.done.length + holds.length;
    var hc = document.getElementById("hitCount");
    if (hc) hc.textContent = searching ? (hits ? "命中 " + hits + " 项" : "没有命中") : "";

    /* ★★ v0.26.0：「本周完成 N 件」整段删了（v0.9.0 加进来的那一段回顾）。
       它是底栏超宽的元凶之一 —— 那句 276px 的「本周完成 5 件·这周总算有进展，
       上周还完全没动。」直接吃掉了底栏 532px 里的一半多。
       ★ 底栏从此只回答一个问题：**现在手头是什么状况**。
         回顾、鼓励、替用户下判断的话，都不属于这里。 */

    /* 底栏：「未完成」不含挂起（挂起是停车场，不算手头的活），也不含已归档。
       ★ v0.43.0：也不含「交出去的活」。`live` 是底栏三处**共用的基础集合**
         （`open` 计数 / `doneLive` 可归档数 / `live.length === 0` 判空），
         改这一处三处一起对。
         ★ 特别是 `doneLive`：漏了它，一条「派出去 + 已完成」的活会让
           「归档已完成」按钮冒出来，而点下去会把一条**用户根本看不见的**任务归档掉
           —— 看得见的和动得了的对不上，是最伤信任的一类。 */
    var live = myTasks();
    var open = live.filter(function(t){ return t.status !== "done" && t.status !== HOLD; }).length;
    var statEl = document.getElementById("stat");
    if (searching) {
      statEl.textContent = hits ? "搜索命中 " + hits + " 项" : "没有命中";
    } else if (st.view === "today") {
      var n = buckets.todo.length + buckets.doing.length;
      statEl.textContent = live.length === 0
        ? "还没有任务"
        : (n === 0 ? "今天清空了" : "今天 " + n + " 项");
    } else {
      /* ★★ v0.26.0：去掉了尾巴上的「，按日期排列 / 按项目排列」。
         那句话是**对当前视图的复述** —— 顶部那排标签自己就写着「按日期 / 按项目」，
         用户在哪儿站着不需要底栏再告诉他一遍。它占着 75px，正是那 67px 超宽的大头，
         而它提供的信息量是零。
         ★ 判据：底栏每一段都必须能回答「现在手头什么样」。
           「东西是按什么排的」不是现状，是设置。 */
      statEl.textContent = live.length === 0
        ? "还没有任务"
        : "未完成 " + open + " 项";
    }

    var hs = document.getElementById("holdStat");
    hs.hidden = holds.length === 0;
    hs.textContent = holds.length + " 项已挂起";

    // 「归档已完成」只在真有可归档的条目时出现（没有就完全看不见，不占底栏）
    var doneLive = live.filter(function(t){ return t.status === "done"; }).length;
    document.getElementById("clearDone").style.visibility = doneLive ? "visible" : "hidden";

    /* 底栏入口：没有归档就整条隐藏；文案是「归档 N」，点开是抽屉。
       ★ 不再是「恢复归档 N」那种「一键把 N 条全倒回看板」的按钮 ——
         那正是用户说的「来回操作把已有信息打乱」的来源。 */
    var archN = st.tasks.filter(isArchived).length;
    var abEl = document.getElementById("archBtn");
    abEl.hidden = archN === 0;
    abEl.textContent = "归档 " + archN;
    if (archOpen) renderArch();

    /* 键盘光标要跟着重绘一起重画：render() 每次都整列重建节点，
       旧节点上的 .kb-on 自然就没了（这也是光标只用 id 记、不存节点的原因）。 */
    kbPaint();

    /* 归档抽屉里的卡片是**只读清单**：能看、能一键取回，但不在这里拖、也不在这里改内容 ——
       已归档的条目就地编辑，会让人分不清改的是「归档里的那条」还是看板上的原任务。 */

    /* 完成反馈必须等 DOM 重建完再播 —— render() 会整列重建，
       动手太早那张卡就被换掉了，动画跟着一起没。 */
    if (celebrating) {
      if (Date.now() > celebrating.until) celebrating = null;
      else celebrateDone(celebrating.id);
    }
  }

  function renderHold(holds){
    holds.sort(byDate);

    var cnt = document.getElementById("holdCount");
    cnt.textContent = holds.length;
    document.getElementById("holdFlyCount").textContent = holds.length;

    var body = document.getElementById("holdFlyBody");
    body.innerHTML = "";
    if (!holds.length) {
      var e = document.createElement("div");
      e.className = "holdfly-empty";
      e.textContent = "把卡片拖到右边的紫条上，就能把任务挂起";
      body.appendChild(e);
    } else {
      holds.forEach(function(t){ body.appendChild(cardEl(t, true)); });
    }
  }

  /* ---------- 团队派发（v0.32.0）----------
     这一块分两半，两半的**数据完全隔离**：
       · 派出去的 —— 写进团队表，本地那条任务留着并挂 `assign` 标记；
       · 收到的   —— 存 Inbox.ITK，绝不进 st.tasks（进了就会污染角标、
         导出 JSON、以及个人镜像那张表，而且没有任何报错）。
     ★★ 这条隔离是硬的不变量，不是「暂时这么写」。 */
  var inboxItems = [];
  var inboxCfg = null;
  /* 上次认人为什么没认出来（v0.37.0）。★ 必须留一份「原因」：
     认人失败时 `cfg.me` 是空的，而界面上原来只会说「先认一下你是谁」——
     真实原因（读不到组员表 / 写不进去 / 飞书没给名字）全被
     `refreshPeople` 结尾那个光秃的 catch 吃掉了（v0.36.1 的铁律：失败要说得出原因）。 */
  var meWhy = "";
  var inboxOpen = false;
  var inboxTimer = null;
  /* ★ v0.39.0：「我派出去的」——与收件箱**并列**的第二个方向。
     在此之前这个弹窗只有一扇单向的门（收件箱），派出去的活除了抽屉里那句
     「已派给 X」之外没有任何落点（PRD §7.4 ②）。 */
  var outOpen = false;
  var outTimer = null;
  /* 后台轮询写下的回读快照（`Inbox.OUTK`）。★ popup **只读它、不写它** ——
     写入者是后台那趟轮询，两个写入者会互相覆盖（见 inbox.js 的 OUTK 注释）。 */
  var outRows = [];
  /* 抽屉里「派发给」当前选中的人。空串 = 不派给任何人。 */
  var dAssignTo = "";
  /* 项目行派发的重入闸门（v0.36.0）：点一下要先去拉组员表，
     拉的过程中再点一下会开出两个选人面板 —— 同一个按钮上只允许一个在跑。 */
  var projBusy = false;

  function inboxLive(){
    return (inboxItems || []).filter(function (x) { return x && x.status !== "done"; });
  }

  function loadInbox(){
    if (typeof Inbox === "undefined") return Promise.resolve();
    return Promise.all([Store.get(Inbox.CFK), Store.get(Inbox.ITK), Store.get(Inbox.OUTK)]).then(function (r) {
      /* ★★★ v0.34.0 修：`Store.get(key)` 的返回值**就是那个 key 对应的值**
         （它内部已经 `return o[key]` 了），所以**不能再按 key 索引一次** ——
         `r[0][Inbox.CFK]` 恒为 undefined，`readCfg(undefined)` 拿到的是**全默认值**，
         于是「团队派发开着」这件事在弹窗里**永远读不到**：
           · 抽屉里那个「派给团队成员」永远灰着（哪怕设置页开得好好的）；
           · 底栏「派给我 N」永远是 0（哪怕表里真的有派给你的任务）。
         而它零症状 —— 看起来完全像「还没配好」，没有人会怀疑是读取写错了。
         ★ 同一个错在 manage.js 里也有两处（v0.33.0 修的：`Inbox.readCfg(o && o[IKKEY])`），
           这两处是那次漏网的 —— 因为当时只查了「写配置」那条链路，
           popup 这条读链路没在排查范围里。 */
      inboxCfg = Inbox.readCfg(r[0]);
      inboxItems = Array.isArray(r[1]) ? r[1] : [];
      renderInbox();
      /* ★★★ v0.39.0：把「我派出去的那些」的回读结果并回本地任务。
         ★ 为什么就在这一个地方做：抽屉里的徽标与发件箱列表**都从 `t.assign` 读**，
           所以两边天然同一个口径（PRD §7.4 ③ 的验收：两处显示的状态必须一致，
           **不许各算一遍**）。而合并只发生在 popup —— 任务数组的唯一写入者。
         ★ 只有真变了才落盘 + 重绘：否则每开一次弹窗都会白写一次盘、白重绘一次。 */
      var o = r[2];
      outRows = (o && Array.isArray(o.rows)) ? o.rows : [];
      if (outRows.length) {
        var mg = Inbox.applyOutbox(st.tasks, outRows);
        if (mg.changed) save().then(render);
      }
      /* ★★★ v0.36.0：配置读完必须**重绘一次看板**。
         为什么：项目行上那颗派发按钮的存在与否取决于 `inboxCfg.on`，而
         `inboxCfg` 是**异步**读回来的 —— 首帧那次 render() 跑在它之前，
         于是按钮永远不出现，直到用户碰巧触发了另一次 render（拖一下、改个日期）。
         症状和老大报的那句一模一样：「开启了团队派发，但是在项目里面
         没有看到派发给其他人这个选项」—— 而设置页里那个开关明明开着。
         ★ 这一条是**写这批测试时被自己的断言抓出来的**：先量到 `.prow .pgo` 为 0，
           才回头发现是加载顺序，不是 CSS 也不是 on 判断。
         ★ 只在「按项目」视图下重绘：别的视图里 `.prow` 根本不存在，
           这次 render() 是纯浪费（而且它会重建整列 DOM，会打断正在进行的拖拽）。 */
      if (st.view === "project") render();
      /* ★★★ v0.40.0：入口上那个团队计数**只有 `render()` 会刷**（它进 `renderTeamCount`），
         而 `renderInbox()` 只管收件箱那扇门上的数字。于是：
           · 首帧 render() 跑的时候 `ITK` 还没读回来（`inboxItems` 是空的）；
           · 数据回来这一趟只调了 `renderInbox()`，`segTeamN` 就停在首帧那个数。
         症状：按钮上写着「团队任务 3」，点进去两个分区加起来是 5 ——
         **数字与眼前看到的行数对不上**，而这正是本项目最贵的那一类
         （v0.26.0 起反复栽：数字骗人比不显示更伤信任）。
         ★ 修法有两半，缺一不可：
           ① 计数**无条件**刷一次 —— 它回答的是「有没有人给你派活」，
              与「现在站在哪一屏」无关（见 renderTeamCount 的注释）；
           ② 站在团队屏上时把两个分区也重画。只加 ① 的话：数据回来了、数字对了，
              但两个分区还是空的 —— 那是「空态在骗人」，更糟。
         ★ 为什么不像 project 那样一律 render()：别的视图里这次 render() 会把整列
           DOM 重建一遍，会打断正在进行的拖拽（就是上面刚写过的那个理由）。
         ★ 两半都收在 `refreshTeamUI()` 里 —— 同一批异步数据还有另外两个入口
           （`ITK` / `CFK` 的 onChanged），三处必须同一个口径。 */
      refreshTeamUI();
      /* ★★★ v0.38.3：名单**不能只等后台轮询**。抽屉里那个派发下拉读的就是
         `cfg.people` 这份本地缓存，缓存空的时候它是灰的 ——
         实测老大的现场正是 `people:""` / `peopleAt:0`（收件轮询从没启动过，
         见 background.js 的 ensureInboxAlarm）。
         后台那条轮询这一版接通了，但它 1 分钟才一轮；刚装好、刚在飞书里改完
         组员表、或者扩展刚被唤醒的那一刻，下拉还是会先灰一次。
         ⇒ 补一条**按需拉取**：开着团队派发、而名单是空的，现在就去拉；
           拉完补绘抽屉（「异步读完必须补绘」是本项目栽过好几次的那条）。 */
      if (inboxCfg && inboxCfg.on && !assignNames().length) {
        refreshPeople().then(function () {
          if (drawerOpen) buildDAssign();
        });
      }
    });
  }

  function renderInbox(){
    var btn = document.getElementById("inboxBtn");
    if (!btn) return;
    var n = inboxLive().length;
    /* ★ 没有就整条隐藏：摆一个「派给我 0」的按钮，用户点开发现是空的，
       会以为功能没配好。 */
    btn.hidden = n === 0;
    var n1 = document.getElementById("inboxN");
    var n2 = document.getElementById("inboxFlyN");
    if (n1) n1.textContent = n;
    if (n2) n2.textContent = n;
    if (inboxOpen) renderInboxBody();
  }

  /* 「派给我的」的排序 —— ★ v0.40.0：**浮层与团队视图共用这一处**
     （同 `outSorted` 的理由：抄一份，两处的顺序迟早不一样）。
     规则：按**任务日期**升序、没有日期的排最后（`"9999"` 兜底）—— 早该做的排前面。
     这是 v0.32.0 起就有的规则，本版**没有新造**。 */
  function inSorted(){
    return (inboxItems || []).slice().sort(function (a, b) {
      return String(a.date || "9999").localeCompare(String(b.date || "9999"));
    });
  }

  function renderInboxBody(){
    var body = document.getElementById("inboxFlyBody");
    if (!body) return;
    body.innerHTML = "";
    var list = inSorted();
    if (!list.length) {
      var e = document.createElement("div");
      e.className = "holdfly-empty";
      e.textContent = teamEmptyText("mine");
      body.appendChild(e);
      return;
    }
    list.forEach(function (it) { body.appendChild(inboxCardEl(it)); });
  }

  /* ★ 自绘而不是复用 cardEl：cardEl 是给**本地任务**画的，它的点击/拖拽/
     就地编辑全都拿 `dataset.id` 去 st.tasks 里找那条任务 —— inbox 里的任务
     根本不在那里，复用会得到一个「点下去什么都没发生」的卡片。
     它只有两个能做的动作：看、标完成。

     ★★ v0.40.0：多了第二个参数 `withState` —— 团队视图要在这张卡上多画一个
     **状态词徽标**（P0-3 的验收），而**浮层里不画**（不改已发布的样子）。
     ★ 为什么用参数而不是另写一张卡：两张卡就是两份渲染口径，
       而 D2 拍板的正是「两处入口共用同一份渲染口径」。差异由参数**显式**表达。 */
  function inboxCardEl(it, withState){
    var el = document.createElement("article");
    el.className = "card" + (it.status === "done" ? " is-done" : "");
    el.dataset.inboxId = it.id || "";

    var title = document.createElement("div");
    title.className = "ctitle";
    title.textContent = it.title || "（没写标题）";
    el.appendChild(title);

    var meta = document.createElement("div");
    meta.className = "cmeta";
    if (it.from) {
      var who = document.createElement("span");
      who.className = "txt";
      who.textContent = it.from;
      meta.appendChild(who);
    }
    if (it.date) {
      var when = document.createElement("span");
      when.className = "txt";
      when.textContent = (typeof Inbox !== "undefined") ? Inbox.dateWord(it.date) : it.date;
      meta.appendChild(when);
    }
    /* ★★ v0.40.0：收件侧的状态词。码从 `it.status` 来（**收件侧的统一口径**，
       理由见 `Inbox.stateFromLocalStatus` 的注释），词从 `stText(_, "in")` 来
       —— 「还没动」在接收人这儿叫「待办」（D7）。 */
    if (withState) {
      var st = (typeof Inbox !== "undefined") ? Inbox.stateFromLocalStatus(it.status) : "";
      var bd = stateBadge(st, "in");
      if (bd) meta.appendChild(bd);
    }
    el.appendChild(meta);

    /* 标完成：★ 这是 inbox 里唯一允许的动作。不能改标题、不能拖、不能删 ——
       这条任务的主人不是你，你只能说「我做完了」。 */
    if (it.status !== "done") {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ibdone";
      b.textContent = "完成";
      b.addEventListener("click", function () { inboxDone(it.id); });
      el.appendChild(b);
    }
    return el;
  }

  function inboxDone(id){
    var hit = null;
    inboxItems.forEach(function (x) { if (x && x.id === id) hit = x; });
    if (!hit) return;
    hit.status = "done";
    hit.doneAt = Date.now();
    saveInbox();
    /* 回写团队表让派发人看见。★ 失败也**不回滚**本地：本地「我做完了」
       是你的事实，团队表只是通知对方；回滚会让按钮点下去毫无反应。 */
    if (typeof Inbox !== "undefined" && typeof Sync !== "undefined") {
      Sync.readCfg().then(function (sc) {
        var full = Inbox.withCred(inboxCfg, sc);
        if (!Inbox.ready(full)) return;
        return Inbox.syncBack(full, [hit]);
      }).catch(function () {});
    }
  }

  function saveInbox(){
    if (typeof Inbox === "undefined") return Promise.resolve();
    var p = {}; p[Inbox.ITK] = inboxItems;
    return Store.set(p).then(function () { renderInbox(); });
  }

  function setInbox(open){
    inboxOpen = open;
    var el = document.getElementById("inboxFly");
    if (!el) return;
    clearTimeout(inboxTimer);
    if (open) {
      /* 互斥：几个浮层盖在同一片区域，同时开只会互相压。 */
      setFly(false);
      setArch(false);
      setOutbox(false);
      renderInboxBody();
      el.hidden = false;
      nextFrame(function () { el.classList.add("show"); });
    } else {
      el.classList.remove("show");
      inboxTimer = setTimeout(function () { if (!inboxOpen) el.hidden = true; }, 200);
    }
  }

  /* ============================================================
     我派出去的（v0.39.0）—— 与收件箱**并列**的第二扇门
     ============================================================
     ★★★ 为什么必须有它：在此之前派发是**一条单向的路**。`mineOnly` 只留
       「接收人 == 我」，派发人从不读取自己派出去的那一行 —— 于是
       「我派出去几条、分别到哪一步了」这个问题**在界面上无解**
       （老大原话：「也不确定有没有派发成功，对方有没有接收到，我也不知道」）。
     ★ 数据来源只有一个：本地任务的 `t.assign`（状态由后台回读灌进来）。
       这里**绝不另读一次团队表** —— 那就会变成同一件事的第二种口径。 */

  /* ★★ v0.40.0（D5 拍板）：多久算「他还没回应」。
     一天太吵（人家可能只是还没打开表）、三天太晚（事已经黄了）——
     沿用上一版 PRD 催办窗口的思路。
     ★★★ 这个数**只有一处**（v0.40.0 收口到 `Inbox.NO_REPLY_MS` + `Inbox.staleOf`）：
       它原来就长在这儿，然后看板的团队块也要用同一个门槛 ——
       差一点就写成第二份，那样「浮层说还没回应、看板说没事」这种自相矛盾
       迟早会出现，而用户只会觉得这两个数字里有一个是假的。
       ⇒ 弹窗侧一行判定都不留，全交给 `Inbox.staleOf`。 */

  /* ★★★★ v0.43.0：这一摞走 **`isOutgoing`**，不是 `isGivenAway` —— 它们是**两个问题**。
     初稿把它收口成 `filter(isGivenAway)`（在「收口」这面旗帜下写的，所以格外值得记）：
     `isGivenAway` 是**白名单**（只认确定到了对方手上那三档），于是
     `failed`（派发失败）/ `sending`（派发中）会被**排除**在「我派的」之外 ——
     而「重派一次」那颗按钮只画在这一行上（`outCardEl` 里的 `re`），
     排除掉就等于**失败之后再没有任何地方能重派**。
     ★ 原来这里写的是 `!!(a && a.to && a.st !== "revoked")`（与 `isGivenAway` 的黑名单版
       恰好逐字相同，所以「看着像同一件事」）—— 收口成 `isGivenAway` 白名单版之后，
       两个问题的答案第一次**分开**了，这才是它们的真面目。
     ★ 判据本体在 `inbox.js`（`Inbox.isOutgoing`），本函数只是薄包装
       （与 `isGivenAway` 并排，两个名字放在一起才看得出「它们不是一个东西」）。 */
  function outItems(){
    return (st.tasks || []).filter(isOutgoing);
  }

  /* 状态徽标 —— **全项目唯一的画法**（任务抽屉、发件箱浮层、团队视图三处都用它）。
     ★ 认不出来的码、以及**当前没有生产者的档**一律不画 ——
       `Inbox.uiState` 是过滤的唯一口径（它背后是 `ST_LIVE`）：
       既不把裸状态码漏到界面上，也不画一个永远不来的词。
     ★ `side`：`"in"` = 接收人视角（`recorded` 要叫「待办」，D7 拍板）。
       ★★ popup **不许自己写词表** —— 词汇只有 `Inbox.stText` 一处；
       这也是「两处入口共用同一份渲染口径」（D2）能成立的前提。 */
  function stateBadge(st, side){
    var s = (typeof Inbox !== "undefined") ? Inbox.uiState(st) : (st || "");
    if (!s) return null;
    var txt = (typeof Inbox !== "undefined") ? Inbox.stText(s, side) : "";
    if (!txt) return null;
    var b = document.createElement("i");
    b.className = "astate st-" + s;
    b.textContent = txt;
    return b;
  }

  /* 「我派的」那一行的徽标：状态从 `assign` 来。 */
  function stBadge(a){
    if (!a || !a.to) return null;
    /* ★ 状态的推断**只有一处**（`Inbox.assignState`：老数据缺 `st` 时按「已派发」算）——
       这里再写一遍的话，抽屉那句与徽标就会是两个口径。 */
    var st = (typeof Inbox !== "undefined") ? Inbox.assignState(a) : (a.st || "recorded");
    return stateBadge(st);
  }

  function renderOutbox(){
    var btn = document.getElementById("outBtn");
    if (!btn) return;
    var n = outItems().length;
    btn.hidden = n === 0;
    var n1 = document.getElementById("outN");
    var n2 = document.getElementById("outFlyN");
    if (n1) n1.textContent = n;
    if (n2) n2.textContent = n;
    if (outOpen) renderOutboxBody();
  }

  /* 「我派的」的排序 —— ★ v0.40.0：**浮层与团队视图共用这一处**。
     抄一份的话两处的顺序迟早不一样，而顺序正是「我该先关心哪一条」的答案
     （本项目已经为「同一件事两种口径」付过两次账：v0.38.0、v0.39.0）。
     规则：**没走完的在前、最近的在上** —— 排的是「我该关心什么」，
     不是「我什么时候派的」（已完成的活不该常年顶在最上面）。 */
  function outSorted(){
    return outItems().slice().sort(function (a, b) {
      var da = ((a.assign || {}).st === "done") ? 1 : 0;
      var db = ((b.assign || {}).st === "done") ? 1 : 0;
      if (da !== db) return da - db;
      return (Number((b.assign || {}).at) || 0) - (Number((a.assign || {}).at) || 0);
    });
  }

  function renderOutboxBody(){
    var body = document.getElementById("outFlyBody");
    if (!body) return;
    body.innerHTML = "";
    var list = outSorted();
    if (!list.length) {
      var e = document.createElement("div");
      e.className = "holdfly-empty";
      e.textContent = teamEmptyText("out");
      body.appendChild(e);
      return;
    }
    list.forEach(function (t) { body.appendChild(outCardEl(t)); });
  }

  /* ★ 与收件箱卡片是**两套**，别合并：那边是「我的活」的完整卡（能就地编辑、能拖），
     这边是「我交出去的活」的一行 —— 只看状态、只能撤回 / 重派。
     复用 cardEl 会得到一个**能编辑、能拖动**的假卡，而它改的是我本地这条任务、
     不是表里那一行 —— 那等于凭空制造误导。 */
  function outCardEl(t){
    var a = t.assign || {};
    var el = document.createElement("article");
    el.className = "card outcard";
    el.dataset.outId = t.id || "";
    if (a.st === "failed") el.classList.add("is-failed");

    var title = document.createElement("div");
    title.className = "ctitle";
    title.textContent = t.title || "（没写标题）";
    el.appendChild(title);

    var meta = document.createElement("div");
    meta.className = "cmeta";
    var to = document.createElement("span");
    to.className = "txt";
    to.textContent = "派给 " + (a.to || "？");
    meta.appendChild(to);
    var bd = stBadge(a);
    if (bd) meta.appendChild(bd);
    el.appendChild(meta);

    /* ★★ v0.40.0（P0-3 / D5）：「还没回应」—— 学 PagerDuty 把 `unacknowledged`
       当**一等公民状态**，而不是「等一等自然就有的东西」。
       ★ 判定**只有一处**（`Inbox.staleOf`：只看 `recorded`，起点 `stAt` 退 `at`，
         凑不够 48 小时就返回 0）—— 这里不再自己算毫秒数（理由见 `NO_REPLY_MS` 那段）。 */
    if (typeof Inbox !== "undefined" && Inbox.staleOf(a)) {
      var nr = document.createElement("div");
      nr.className = "onoreply";
      nr.textContent = "还没回应";
      el.appendChild(nr);
    }

    /* ★ 失败原因必须**留在卡片上**，不是弹一次就没了（P0-5 的验收：
       那条显示原因 + 一句能照做的话）。 */
    if (a.st === "failed" && a.why) {
      var why = document.createElement("div");
      why.className = "owhy";
      why.textContent = a.why;
      el.appendChild(why);
    }

    var acts = document.createElement("div");
    acts.className = "oacts";
    if (a.st === "failed") {
      var re = document.createElement("button");
      re.type = "button";
      re.className = "obtn";
      re.textContent = "重派一次";
      re.addEventListener("click", function () { retryDispatch(t); });
      acts.appendChild(re);
    }
    var rv = document.createElement("button");
    rv.type = "button";
    rv.className = "obtn";
    rv.textContent = "撤回";
    rv.title = "只在本机标记为已撤回；团队表那一行保留（远程删除不可逆）";
    rv.addEventListener("click", function () { revokeAssign(t.id); });
    acts.appendChild(rv);
    el.appendChild(acts);
    return el;
  }

  /* 撤回（P0-6）：**只标本地，不删远端那一行** —— 远程删除不可逆，
     而那一行可能已经被对方看过、引用过（沿用现有 P0 纪律）。 */
  function revokeAssign(id){
    var hit = null;
    (st.tasks || []).forEach(function (t) { if (t && t.id === id) hit = t; });
    if (!hit || !hit.assign) return;
    hit.assign.st = "revoked";
    hit.assign.stAt = Date.now();
    save().then(function () {
      render();
      toast("已撤回（团队表那一行保留着）");
    });
  }

  /* 重派：失败那条再走一次同一条路。★ 复用 `runDispatch`，不另写一遍 ——
     两处各写一份派发逻辑，迟早有一处漏了落账，而漏掉的那一处**零症状**。 */
  function retryDispatch(t){
    if (!t || !t.assign || !t.assign.to) return;
    runDispatch(t, t.assign.to);
  }

  function setOutbox(open){
    open = !!open;
    if (open === outOpen) return;
    outOpen = open;
    var el = document.getElementById("outFly");
    if (!el) return;
    clearTimeout(outTimer);
    if (open) {
      /* 互斥：几个浮层盖在同一片区域，同时开只会互相压。 */
      setFly(false);
      setArch(false);
      setInbox(false);
      renderOutboxBody();
      el.hidden = false;
      nextFrame(function () { el.classList.add("show"); });
    } else {
      el.classList.remove("show");
      /* 等收起动画播完再真正隐藏，否则淡出会被 display:none 掐掉
         （和 holdFly / inboxFly 同一处理）。 */
      outTimer = setTimeout(function () { if (!outOpen) el.hidden = true; }, 200);
    }
  }

  /* ============================================================
     团队任务视图（v0.40.0 · P0-1 / P0-2 / P0-3）
     ============================================================
     ★★★ 这一屏回答两个问题、**并列**呈现：
       · 「派给我的」—— 源头是 `Inbox.ITK`（后台轮询时已过 `mineOnly`）
       · 「我派的」  —— 源头是本地任务的 `t.assign`（状态由后台回读灌进来）
     两个筛子**互补**（`outboxOf` 要求接收人 != 我），所以同一条记录只可能落在
     一边 —— 这就是「同一件事不许出现在两处」的保证（P0-2 的验收）。
     ★★ 两边都**不落地成本地任务**（D3 拍板）：一落地就有「本地改了、远端没改」
       的双向冲突，而那是本项目血债最多的地方（PRD §9 反对意见②）。
     ★★ 两处入口（本视图 / 底栏浮层）**共用同一份渲染口径**（D2）：
       「我派的」两边都走 `outSorted()` + `outCardEl()`；
       「派给我的」两边都走 `inSorted()` + `inboxCardEl()`（后者多一个徽标参数）。
       状态词、排序、卡片三样都只有一处实现 —— 这是本版最容易写歪的地方。 */

  /* 主区在两块容器之间切换。★ `hidden` 只在这一处改 —— 别处再改一次就会打架。 */
  function setTeamMode(on){
    var b = document.getElementById("board");
    var w = document.getElementById("teamWrap");
    if (b) b.hidden = !!on;
    if (w) w.hidden = !on;
  }

  /* 空态：**必须说清为什么空**（PRD §7.4 ②）。
     「还没开派发」与「没有人派活给你」是两件事，混成一句会让人以为功能坏了。
     ★★★ v0.40.0：字面量**不在这里**（全部搬到 `Inbox.EMPTY_*`，看板读同一份）——
       这两句话同时出现在四个地方（收件箱浮层 / 发件箱浮层 / 团队视图两个分区），
       散着写就是四次漂开的机会，而「同一件事两种口径」是本项目付过两次账的病。
     ★★★ 名字里必须带 `team`。**这个函数一开始就叫 `emptyText`，跟下面看板列那个
       `emptyText(s)` 撞了名** —— 函数声明提升下**后出现的赢**，于是这四处
       （收件箱浮层 / 发件箱浮层 / 团队视图两分区）拿到的全是**看板列**的文案
       （「拖任务到这里」），而 `Inbox.EMPTY_*` 那三句话**一个字都没上过屏**。
       症状：没有报错、没有异常、静态扫描也全绿，只有把文案断言写进测试才看得见。
       ⇒ 教训不是「小心重名」，是**「新函数的名字必须带得出它属于哪一支」**；
         同族判据见 `_validate.py` 里的「popup.js 顶层函数声明不得重名」那扇门。 */
  function teamEmptyText(kind){
    if (typeof Inbox === "undefined") return "";
    if (kind === "mine") return (inboxCfg && inboxCfg.on) ? Inbox.EMPTY_MINE : Inbox.EMPTY_OFF;
    return Inbox.EMPTY_OUT;
  }

  function teamEmptyEl(text){
    var e = document.createElement("div");
    e.className = "holdfly-empty";
    e.textContent = text;
    return e;
  }

  /* 视图按钮上那个总数 —— **任何视图**都要更新：它回答的是「有没有人给你派活」，
     与你现在站在哪一屏无关。口径 = 两个分区的条数之和，这样
     「按钮上的数字」与「点进去看到的行数」永远一致
     （数字和眼前看到的对不上，是最伤信任的一类 —— 与 v0.26.0 那条同源）。 */
  function renderTeamCount(){
    var n = inSorted().length + outItems().length;
    var e = document.getElementById("segTeamN");
    if (!e) return;
    e.textContent = n;
    e.hidden = (n === 0);
    /* ★★★ 这个数字长在**一个按钮里面**，所以改它一定会改那个按钮的宽度 ——
       而滑块（`.seg-thumb`）的宽是按「当前按钮」量出来的（`moveSegThumb`）。
       不重排的话，数字从隐藏变可见（或位数变多）之后，
       滑块就**比按钮窄**（或位置偏），症状是「选中的那块底色没对齐」。
       这不是理论风险：计数是**数据回来之后**才对的，而 `syncSeg()`（唯一另一处
       调 `moveSegThumb` 的地方）跑在它**之前** ——
       于是「打开弹窗时正好站在团队任务上 + 后台刚拉回几条」这个组合必然错位。
       ★ 一处修全部：把这个数**永远**当几何变化处理，别去猜这次改没改宽度
         （`tabular-nums` 只保证同位数等宽，9→10 真的会变宽）。 */
    moveSegThumb();
  }

  /* ★★ 团队相关的**异步**数据（`ITK` / `CFK` / 首次 `loadInbox`）到了之后，
     该刷的一次刷够 —— 三处调用点共用这一处实现。
     ★ 为什么抽出来：本项目已经为「同一件事两种口径」付过两次账（v0.38.0、v0.39.0），
       而这里是一个更阴的变体 —— 「同一件事**三处各刷一半**」：
       漏掉哪一处，症状都长得像「数据没到」（数字不动 / 分区还空），
       而实际上数据早就在内存里了。**看不见的那一半才是坏的。**
     ★ 与 `render()` 的分工：`render()` 是「整屏重画」，会重建看板整列 DOM
       （会打断拖拽、正在就地编辑的卡也会被打断）；这个只补团队那一小块。
       ⇒ 数据到了但用户不在团队屏上时，**只刷数字**，不重建任何东西。 */
  function refreshTeamUI(){
    renderTeamCount();
    if (st.view === "team") renderTeam();
  }

  function renderTeam(){
    var bodyM = document.getElementById("tmBody");
    var bodyO = document.getElementById("toBody");
    if (!bodyM || !bodyO) return;

    /* ★★ 「派给我的」= `inboxItems` **本身**，这里**不再筛一次**：
       后台轮询写 `ITK` 时走的就是 `mineOnly`（inbox.js 的 `pull`）。
       多筛一道 = 第二个口径，而且它看起来毫无害处 —— 一旦分叉没人查得出来。 */
    var mine = inSorted();
    var out = outSorted();

    var cM = document.getElementById("tmCount");
    var cO = document.getElementById("toCount");
    if (cM) cM.textContent = mine.length;
    if (cO) cO.textContent = out.length;

    bodyM.innerHTML = "";
    bodyO.innerHTML = "";
    if (!mine.length) bodyM.appendChild(teamEmptyEl(teamEmptyText("mine")));
    else mine.forEach(function (it) { bodyM.appendChild(inboxCardEl(it, true)); });

    if (!out.length) bodyO.appendChild(teamEmptyEl(teamEmptyText("out")));
    else out.forEach(function (t) { bodyO.appendChild(outCardEl(t)); });

    /* 底栏：团队视图只回答**团队**的事 —— 本地任务那几段（挂起 / 归档 / 搜索命中）
       全部让位。不让位的话会出现「团队任务 7 条、底栏写着未完成 3 项」
       这种一句话里两个口径的句子。 */
    var statEl = document.getElementById("stat");
    if (statEl) {
      statEl.textContent = (inboxCfg && inboxCfg.on)
        ? ("派给我的 " + mine.length + " · 我派的 " + out.length)
        : "团队派发还没打开";
    }
    var hs = document.getElementById("holdStat"); if (hs) hs.hidden = true;
    var ab = document.getElementById("archBtn");  if (ab) ab.hidden = true;
    var hc = document.getElementById("hitCount"); if (hc) hc.textContent = "";
  }

  /* ---------- 抽屉里的「派发给」 ---------- */
  /* 名单为空时**唯一**那句话（v0.38.3）。抽成常量是为了让「抽屉里的下拉」和
     「项目行上的按钮」说的**一字不差** —— 同一个现场用两句话，用户会以为是两回事。
     ★ v0.41.0：「身份」列删掉了，这句跟着改 —— 只剩两样要填（姓名 + 成员）。
       留着「+ 身份」的话，用户会去找一个**表里根本不存在**的列。 */
  var NO_PEOPLE_HINT = "组员表里还没有人：去飞书打开「组员」表添几行（姓名 + 成员）";

  function assignNames(){
    if (typeof Inbox === "undefined" || !inboxCfg) return [];
    var me = inboxCfg.me || "";
    return Inbox.peopleOf(inboxCfg).filter(function (n) { return n !== me; });
  }

  /* ---------- 抽屉里的「派给团队成员」（v0.34.0 重写）----------
     ★★★ 这一整块在 v0.32.0 是**死的**，而且是三重死：
       ① popup.html 里根本没有 id="dAssign" 这个元素 → `if (!btn) return;` 静默退出；
       ② runDispatch **只有定义、没有任何调用点**（全项目就那一处 function 声明）；
       ③ t.assign 从来没有被写入过（dApply 不写、dFlush 不写）。
       于是「把任务派出去」这条链路在真机上一步都没走通过 —— 而单测全绿，
       因为单测里也没有一条断言碰过它（命中的全是 JS 内置的 Object.assign）。
       这一版按老大拍板的样子重做：**先选中，再选人**。
     ★ 置灰规则（老大原话「默认置灰无法选中，开启团队派发之后，可选」）：
       团队派发没开 → 复选框 disabled，但**这一行还在**。
       灰着比藏着好 —— 藏起来只会让人以为功能不存在（老大正是这么以为的）。
     ★ 名单为空时下拉自己 disabled：没得选的时候点开一个空面板，
       按本项目的界面约束**一个字都不会显示**，用户只会觉得点坏了。 */
  function buildDAssign(){
    var wrap = document.getElementById("dAssignWrap");
    var onBox = document.getElementById("dAssignOn");
    var btn = document.getElementById("dAssign");
    if (!wrap || !onBox || !btn) return;

    var enabled = !!(inboxCfg && inboxCfg.on);
    var names = assignNames();
    var t = dTask();
    var cur = (t && t.assign && t.assign.to) || "";
    /* 任务已经派给过某人、而那人不在名单里（名单改过）→ 补一项，
       否则会静默显示成名单第一个人，下次一存就把接收人改掉了。 */
    if (cur && names.indexOf(cur) < 0) names.push(cur);
    dAssignTo = cur;

    /* ★ 灰要灰在**整行**上（label 挂 .off）：input 自己的默认灰太轻，
       一眼看不出「这个还不能用」。 */
    onBox.disabled = !enabled;
    wrap.classList.toggle("off", !enabled);
    /* ★ 没启用时强制不勾 —— 留着上次的勾会让人以为这条已经派出去了，
       而它其实一条都没发。 */
    onBox.checked = enabled && !!cur;
    btn.hidden = !onBox.checked;
    /* ★★★ v0.38.3：这里原来是 `btn.disabled = !names.length` —— 撤掉。
       原因：**disabled 的 <button> 连 click 都不派发**，于是「名单还没拉下来」
       这件事在界面上只剩一个灰块：点它毫无反应、也没有第二句话 ——
       老大报的「这里还是灰色的」就是它（实测他的现场是 `people:""`，
       根本原因是收件轮询从没启动，见 background.js 的 ensureInboxAlarm）。
       ★ 改成跟项目行那颗按钮**同一条规矩**（见 openProjDispatch 那段）：
         动作按钮不灰着，名单为空时让它能按，按了就说一句能照做的话。 */
    paintDAssign();

    function pick(v){ dAssignTo = v; paintDAssign(); dTouch(); }
    /* ★ onclick / onchange 用**赋值**（不是 addEventListener）：抽屉每次打开
       都会重建这几个控件，累加监听器会让选一次触发 N 次。 */
    onBox.onchange = function(){
      if (!onBox.checked) dAssignTo = "";
      btn.hidden = !onBox.checked;
      paintDAssign();
      dTouch();
      if (!onBox.checked) return;
      /* 勾上就顺手把下拉弹开：老大要走的是「选中 → 选人」两步，
         不弹的话勾完还得自己去找那个按钮。 */
      if (names.length) { toggleSelPop(btn, names, dAssignTo, pick); return; }
      /* ★ 勾上了、却没人可选 —— 这一声必须有（同一个现场跟项目行说同一句话） */
      toast(NO_PEOPLE_HINT);
    };
    btn.onclick = function () {
      if (!names.length) { toast(NO_PEOPLE_HINT); return; }
      toggleSelPop(btn, names, dAssignTo, pick);
    };
  }

  /* ★ 只写 .seltxt，不走 setSelValue —— 后者空值会写成「未分类」，
     而这儿空值的意思是「还没选人」。 */
  function paintDAssign(){
    var btn = document.getElementById("dAssign");
    if (!btn) return;
    var tx = btn.querySelector(".seltxt");
    if (tx) tx.textContent = dAssignTo || "选谁";
    btn.classList.toggle("selon", !!dAssignTo);
  }

  /* 派发动作（v0.39.0 起**落账**）。
     ★ 不阻塞保存（fire and forget）：派发要走网络，等它返回再让抽屉保存的话，
       抽屉会卡在网络上 —— 而本地那条任务是本地的事。
     ★★★ 这一版的三处改动，逐条对应老大那三句话：
       ① 先落 `sending`，界面上**立刻**出现徽标（不再是一句 2 秒就消失的 toast）；
       ② 成功时把 `recordId` 与 `recorded` **写进本地那条任务** ——
          这是回读的锚点（`recordId` 以前拿到就丢，所以那一行永远读不回来）；
       ③ 失败时把状态与**原因**留在本地（`failed` + `why`）——
          它不会随 toast 一起消失，发件箱里随时能查。
     ★ 注意：这里是**覆盖式**赋值。P1 要加 `msgId` 时记得一并列出来 ——
       覆盖式赋值会把没列出的字段清掉，而那种丢法零报错。 */
  function runDispatch(t, to){
    if (typeof Inbox === "undefined" || typeof Sync === "undefined") return;
    if (!t) return;
    var at = Date.now();
    t.assign = { to: to, at: at, rid: "", st: "sending", stAt: at, why: "" };
    save().then(render);
    Sync.readCfg().then(function (sc) {
      var full = Inbox.withCred(inboxCfg, sc);
      if (!Inbox.ready(full)) throw new Error("团队派发没配好");
      return Inbox.dispatch(full, t, to).then(function (r) {
        t.assign = {
          to: to, at: at,
          rid: (r && r.recordId) || "",
          st: "recorded", stAt: Date.now(), why: ""
        };
        save().then(function () {
          render();
          toast("已派给 " + to + "（状态在「我派的」里看）");
        });
      });
    }).catch(function (e) {
      /* ★ 失败也**落账**：这是本版最重要的一条「留痕」——
         原来只弹一句 2 秒的话，用户关掉弹窗就再也查不到刚才那次到底怎么了。 */
      t.assign = {
        to: to, at: at, rid: "",
        st: "failed", stAt: Date.now(),
        why: (typeof Inbox !== "undefined") ? Inbox.failText(e) : "未知原因"
      };
      save().then(function () {
        render();
        toast("没派出去：" + t.assign.why);
      });
    });
  }

  /* ---------- 「按项目」视图：项目分组行 + 派发入口（v0.36.0）----------
     每换一个项目就插一行 .prow：色点 + 项目名（+ 待办列上一颗派发按钮）。
     ★ 卡片仍由 cardEl 生成，`i` 仍然是**它在整列里的序号** ——
       优先级亮度「没设档就看位置」那条依赖它，分组不许把它重排。
     ★ 分组行不是 .card，所以全局那套「点卡片开始拖拽」的 pointerdown 兜底
       （`e.target.closest(".card")`）会直接放行，不会误判成拖动。
     ★ 拖拽只改「列归属」、不按节点序号插入（见 activateDrag / pointerup），
       所以往列里塞非 .card 的节点不会打乱落点判定。 */
  function appendGrouped(body, list, status){
    var last = null, seen = false;
    list.forEach(function(t, i){
      if (!seen || t.project !== last) {
        body.appendChild(projRow(t.project, status));
        last = t.project; seen = true;
      }
      body.appendChild(cardEl(t, false, i));
    });
  }

  function projRow(proj, status){
    var r = document.createElement("div");
    r.className = "prow";
    r.dataset.project = proj;

    var dot = document.createElement("i");
    dot.className = "pdot";
    dot.style.background = projColor(proj);
    var nm = document.createElement("span");
    nm.className = "pname";
    nm.textContent = proj;
    r.appendChild(dot);
    r.appendChild(nm);

    /* ★ 按钮**只在待办列**出现：派发的对象是「待办的活」。
       三列各放一颗同样的按钮，点哪颗效果都一样，只会让人犹豫。
       ★ 只在团队派发**开着**时出现（不是灰着）：项目行是每屏都要看的区域，
         常驻一颗永远点不动的按钮属于噪声；而「开了就该看见」这个诉求
         由 teamOn 保证 —— 老大这次报的就是开了却看不见。 */
    if (status === "todo" && inboxCfg && inboxCfg.on) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pgo";
      b.title = "把「" + proj + "」派给团队成员";
      b.setAttribute("aria-label", "派发");
      b.appendChild(sendIcon());
      /* ★ mousedown 必须拦掉：不拦的话按下时焦点会跑到按钮上，
         正在就地编辑的那张卡会「失焦提交」—— 和 .dexp / .selopt 是同一个坑。 */
      b.addEventListener("mousedown", function(e){ e.preventDefault(); });
      b.addEventListener("click", function(){ openProjDispatch(proj, b); });
      r.appendChild(b);
    }
    return r;
  }

  /* 现拉一次组员表，把名单并进内存里的配置。
     ★ 为什么要「点的时候才拉」：名单的唯一事实源是组员表，本地 cfg.people 只是缓存。
       实测老大那边 peopleAt=0（一次都没拉过）⇒ 缓存是空的 ⇒ 入口做出来下拉也是空的。
       点一下就现拉，比等他去设置页按「现在拉一次」靠谱得多。
     ★ **永不 reject**：调用方只关心「现在手上有没有名单」。拉不到就用旧的 ——
       一次网络抖动不该让整个入口点不动（跟 fromPeopleRecords 那条同一个理由）。 */
  /* 拉名单 **+ 认人**（v0.37.0 合成一次读）。
     ★★ 为什么把认人放进来：这里是「按项目派发」那条路的入口，而派发必须先知道
       「我是谁」。v0.36.0 那套认人关在「一键生成」里、是个局部函数，
       派发这条路够不着 —— 老大原话那句「现在提示缺少派发人」就是这么来的。
     ★★ 认人**会往组员表补一行**（幂等，已有就不写）。放在这里是刻意的：
       认人发生在**用户主动动作**里（打开派发 / 点一键生成 / 点设置页的测试），
       而不是后台轮询 —— 「扩展写了你的表」这件事必须是可预期的。
     ★ 认完落盘：不落盘的话，下一次打开弹窗又得重认一遍。 */
  function refreshPeople(){
    if (typeof Inbox === "undefined" || typeof Sync === "undefined") {
      meWhy = "扩展没加载全（Inbox / Sync 有一个没起来）";
      return Promise.resolve();
    }
    return Sync.readCfg().then(function(sc){
      var full = Inbox.withCred(inboxCfg, sc);
      /* ★★★ v0.38.0：这两个短路原本**一个字都不说**，而它们恰恰是最常见的
         两种「认不出人」：
           ① 团队派发没配好（缺应用凭据 / 团队表 ID）—— 凭据是从「飞书同步」
              那边借来的（`withCred`），同步那边一改，这边就跟着失效；
           ② 还没配「组员」表。
         不说的话，界面上只剩一句笼统的「先认一下你是谁」—— 而它把用户
         **指向了错误的方向**（去组员表里标「本人」）。老大这次就是被它带偏的：
         他真正的现场是「组员表配了、就是没认出人」。
         ★ v0.41.0：「身份」列不存在了，那条错方向**在结构上被堵死**（没得标了）。
         ⇒ 沉默的兜底改掉：每种短路都留下一句**能照做**的原因。 */
      if (!Inbox.ready(full) || !full.peopleTableId) {
        meWhy = !Inbox.ready(full)
          ? "团队派发还没配好（缺应用凭据或团队表 ID）"
          : "还没配「组员」表";
        return null;
      }
      return Inbox.resolveMe(full).then(function(got){
        inboxCfg = Inbox.applyPeople(inboxCfg, got);
        /* ★ 来源与「这个名字可疑」都要留下来：设置页要显示「认的是谁、从哪认的」，
           而**占位名**（`用户613803` 那种）必须让人一眼看见 ——
           它是一条合法的非空字符串，当成正常名字用掉是不会报任何错的。 */
        if (got && got.src) inboxCfg.meSrc = got.src;
        inboxCfg.meSuspect = !!(got && got.suspect);
        if (got && got.meId) inboxCfg.meId = got.meId;
        /* ★★ v0.38.0：「名字」与「id」分开算 —— 拿到 id 只是没名字，
           那是**可接受的**（派发照走，派发人写 id，见 Inbox.whoOf）；
           只有两样都没拿到才算真失败。原来这里按 `!got.me` 判，
           于是「飞书没给名字」被当成「认不出你是谁」，派发跟着一起停。 */
        meWhy = (got && got.why && !(got.me || got.meId)) ? got.why : "";
        inboxCfg.meWhy = meWhy;
        return Inbox.saveCfg(inboxCfg);
      });
    }).catch(function(e){
      /* ★★ 原来是 `.catch(function(){ return null; })` —— 整条链静默吞异常。
         认人失败就一点痕迹都不留：界面上只会说「先认一下你是谁」，
         而真因（读不到表 / 写不进去 / 飞书没给名字）全被吃掉。 */
      meWhy = (e && e.message) || "认人失败";
      /* ★★ v0.38.0：原因**落盘**。只写内存的话关掉弹窗就没了 ——
         下一次只剩那句笼统的提示，真因再也拿不回来。 */
      if (inboxCfg) {
        inboxCfg.meWhy = meWhy;
        return Inbox.saveCfg(inboxCfg).catch(function(){ return null; });
      }
      return null;
    });
  }

  /* 点项目行上的派发按钮。两步：先拉名单，再弹选人。 */
  function openProjDispatch(proj, anchor){
    if (typeof Inbox === "undefined" || projBusy) return;
    projBusy = true;
    refreshPeople().then(function(){
      projBusy = false;
      var names = assignNames();
      /* ★ 名单为空时**不禁用按钮**，而是给一句能照做的话。
         v0.34.0 那条「灰着比藏着好」在这里不适用：抽屉里的开关是个**状态**，
         灰着看得见状态；而项目行上的按钮是个**动作**，灰着按不动又不说为什么，
         人只会觉得点坏了。toast 是动作反馈，不是界面上的解释文字。 */
      if (!names.length) {
        toast(NO_PEOPLE_HINT);
        return;
      }
      /* 派发要写「我是谁」那一列（团队表里谁是派发人），所以先得有「我」。
         ★★★ v0.38.0：判据从「有没有**名字**」改成「有没有**身份**」
           （`Inbox.whoOf` = 真名 → open_id → 占位名）。
           这一格是本功能的命门：飞书对姓名做了字段级管控，
           **名字是它唯一不肯给的那个字段**，而 open_id 零配置就有
           （应用所有者）。把判据挂在名字上，等于「飞书给不给名字」
           决定你能不能派活 —— 老大那句「派发人不需要去填写，默认 = 飞书 openid」
           说的就是这个。还空着就是**真认不出来**（连应用所有者也查不到），
           那就把 `meWhy`（真因）说出来，而不是甩一句笼统的话。 */
      if (!(typeof Inbox !== "undefined" && Inbox.whoOf(inboxCfg))) {
        toast(meWhy ? ("还没认出你是谁：" + meWhy)
                    : "还没认出你是谁：去设置页点一下「测试连接」会顺手认一次");
        return;
      }
      toggleSelPop(anchor, names, "", function(who){ runProjDispatch(proj, who); });
    });
  }

  /* 项目行上的派发 = 把该项目**所有未完成**的任务派给这个人
     （老大拍板的默认语义，他否决就改）。抽屉里那个是**单条**派发，两条路并存。
     ★ 串行、不并发：飞书对同一张表的并发写会回 1254608，
       而这里一按就是好几条。串行慢一点，但每条的结果都能单独交代。
     ★ 一条失败**不中断**：剩下的继续派，最后把成败一起说 —— 半路停下的话
       用户不知道剩下的到底派出去了没有。 */
  function runProjDispatch(proj, who){
    /* ★ v0.43.0：`mine` 要真的是「我的」—— 交出去的活不算。
       不加这一条会怎样：用户在「按项目」视图里点「派发给小王」，
       而这个视图**已经不再显示**那些派出去的活，
       于是他会看到「派 3 条」实际却把小张已经在做的那 2 条**抢给了小王**
       （同名同项目，谁也没报错）。列表里看不见的东西不该被批量动到。 */
    var mine = myTasks().filter(function(t){
      return t.project === proj && t.status !== "done" && t.status !== HOLD;
    });
    if (!mine.length) return;
    Sync.readCfg().then(function(sc){
      var full = Inbox.withCred(inboxCfg, sc);
      if (!Inbox.ready(full)) {
        toast("派发没配好：去设置页检查一下团队表");
        return;
      }
      var ok = 0, bad = 0, i = 0;
      function step(){
        if (i >= mine.length) return Promise.resolve();
        var t = mine[i++];
        return Inbox.dispatch(full, t, who).then(function(){
          /* 本地也记一笔：否则抽屉再打开时「派给」那格还是空的，
             人会以为没派出去，然后再派一次（于是飞书表里出现两条）。 */
          t.assign = { to: who, at: Date.now() };
          ok++;
          return step();
        }, function(){ bad++; return step(); });
      }
      return step().then(function(){ return save(); }).then(function(){
        render();
        toast(bad ? ("派了 " + ok + " 条，" + bad + " 条没派出去")
                  : ("把「" + proj + "」的 " + ok + " 条派给 " + who + " 了"));
      });
    }).catch(function(e){
      toast("派失败：" + ((e && e.message) || "未知原因"));
    });
  }

  function emptyText(s){
    if (searching) return "没有命中的";
    /* ★ v0.43.0：「是不是一条都没有」要按**我手头的活**算，不能按 `st.tasks.length`。
       否则「活全派出去了」的那种人，待办列空着却说「今天没有这一项」，
       而底栏（走 `myTasks`）说的是「还没有任务」—— 同一屏两句话互相打架。
       原判据 `st.tasks.length === 0` 在本地还留着派出去那几条时恒为假。 */
    if (s === "todo" && myTasks().length === 0) return "在上面输入框记第一笔";
    if (s === "done") return st.view === "today" ? "今天还没完成项" : "拖到这里算完成";
    return st.view === "today" ? "今天没有这一项" : "拖任务到这里";
  }

  function cardEl(t, inFly, idx){
    var el = document.createElement("article");
    el.className = "card";
    el.dataset.id = t.id;
    if (t.status === HOLD) el.classList.add("is-hold");
    if (t.status === "done") el.classList.add("is-done");
    /* 优先级亮度只给「待办 / 进行中」两列 —— 已完成靠透明度后退、挂起在浮层里独立，
       再叠一层优先级属于双重编码，两套「次要」会互相削弱。 */
    if (!inFly && (t.status === "todo" || t.status === "doing")) {
      el.dataset.p = resolvePriority(t, idx || 0);
    }

    /* ★ v0.21.0：过期状态从「meta 行里三个字」改成「右上角一个点」。
       ★ 三档：未到期＝不挂 / 今天到期＝橙点 / 已过期＝红点套声波环。
       ★ 挂起卡不标（挂起＝主动放下，再提醒它过期没有意义，那一栏里它本来就只有一条日期）；
         已完成卡不标（已完成列整列 opacity 后退，再叠一个过期的点属于双重编码）。
       ★ 判据用 diffDays 而不是拿日期字符串比大小 —— 日期是本地时区的
         "YYYY-MM-DD"，字符串比较只在同年同月同位数时才等价，跨年就会错。
       ★ 这里不再区分视图：原来那三个字只在「今天 / 按日期」两个视图里出现，
         而「这张卡过期了没有」是个**与视图无关的事实**。
       ★★ v0.43.0 附注：下面这个 `done` / `HOLD` 前置条件与 `overdueOf()` 的**完全同源** ——
         两者的区别只在「要不要把『今天到期』也算进去」。**改一处必须看另一处。**
         （这一段本身是本版**唯一没有改**的过期相关代码：它 v0.21.0 就判对了，
           本版修的是它旁边两处漏网的。） */
    if (t.status !== "done" && t.status !== HOLD) {
      var dd = diffDays(t.date);
      if (!isNaN(dd) && dd <= 0) {
        var cd = document.createElement("i");
        cd.className = "cdot " + (dd < 0 ? "late" : "due");
        cd.title = dd < 0 ? "已过期" : "今天到期";
        el.appendChild(cd);
        el.classList.add("has-dot");
      }
    }

    var title = document.createElement("div");
    title.className = "ctitle";
    setHit(title, t.title, searching);   // 搜索时把命中的字包成 <mark>
    el.appendChild(title);

    if (t.status === "done") el.appendChild(tickEl());

    var meta = document.createElement("div");
    meta.className = "cmeta";
    /* ★★ v0.43.0：改成 `overdueOf(t)`，它自带「已完成 / 挂起 ⇒ 不成立」的判断。
       原来这里写的是 `diffDays(t.date) < 0`（**完全不看 status**），
       于是「昨天做完的活」今天在「按项目」视图里被染成过期色 —— 老大报的就是这个。
       ★ 挂起卡的日期**照常显示**（挂起要看"搁了多久"），只是不再由它表达"过期"：
         过期一律交给 `overdueOf` + 右上角那个点。 */
    var overdue = overdueOf(t);

    if (t.status === HOLD) {
      // 挂起卡：显示日期，方便判断「搁了多久」。日期本身可点 → 快速改期
      var hl = document.createElement("span");
      hl.className = "txt datelink";
      hl.title = "点一下快速改期";
      hl.textContent = dateLabel(t.date);
      meta.appendChild(hl);
    } else if (st.view === "project") {
      // 按项目视图：顺序已经表达了项目，卡片上改显示日期。日期本身可点 → 快速改期
      var dl = document.createElement("span");
      dl.className = "txt datelink";
      dl.title = "点一下快速改期";
      dl.textContent = dateLabel(t.date);
      if (overdue) dl.style.color = "#c07a4a";
      meta.appendChild(dl);
    } else {
      // 今天 / 按日期视图：顺序已经表达了日期，卡片上改显示项目
      var dot = document.createElement("i");
      dot.className = "pdot";
      dot.style.background = projColor(t.project);
      var nm = document.createElement("span");
      nm.className = "txt";
      nm.textContent = t.project;
      meta.appendChild(dot); meta.appendChild(nm);
    }
    el.appendChild(meta);

    /* ★ v0.39.0：派出去的任务，卡片上**常年**带着状态徽标 ——
       这是「一条派出去的活在两处可见、且两处状态一致」的那个「两处」之一
       （另一处是发件箱；两边都读同一个 `t.assign.st`，所以不可能不一致 ——
       PRD §7.4 ③ 的验收）。
       ★ 塞进 meta 行、而不是另起一行：卡片高度是硬约束（窄列 138px），
         为一个徽标多一行会把每张卡都撑高。 */
    var asg = stBadge(t.assign);
    if (asg) meta.appendChild(asg);

    /* 命中在备注里时补一行备注片段 —— 否则用户看到一张标题毫无高亮的卡，
       会以为「这功能搜错了」。只在标题没命中时补，避免重复。 */
    if (searching && t.note &&
        String(t.title == null ? "" : t.title).toLowerCase().indexOf(searching) < 0) {
      var nh = document.createElement("div");
      nh.className = "nhit";
      setHit(nh, t.note, searching);
      el.appendChild(nh);
    }

    if (t.url) {
      var a = document.createElement("a");
      a.className = "clink";
      a.href = t.url;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = "\u2197 " + shortHost(t.url);
      el.appendChild(a);
    }

    if (inFly) {
      // 浮层里点一下卡片就是「取消挂起」，比再拖一次省事
      var ch = document.createElement("div");
      ch.className = "chint";
      ch.textContent = "点一下恢复到待办";
      el.appendChild(ch);
    }

    /* 快速改期入口：hover 才出现的日历按钮（右下角，×在右上角）。
       放在右下角是因为标题那行 width 太金贵（窄列 138px），
       为了一个偶发操作常年给它让出 30px 不值得。 */
    if (!inFly) {
      var qd = document.createElement("button");
      qd.className = "qdate";
      qd.type = "button";
      qd.title = "快速改期";
      qd.setAttribute("aria-label", "快速改期");
      qd.appendChild(calIcon());
      el.appendChild(qd);
    }

    /* 展开按钮（hover 出现，和日历并排）。
       它是编辑抽屉**看得见的入口** —— 只有键盘快捷键的入口等于没有入口。 */
    if (!inFly) {
      var ex = document.createElement("button");
      ex.className = "dexp";
      ex.type = "button";
      ex.title = "大编辑（标题 / 备注 / 日期 / 项目一屏改）";
      ex.setAttribute("aria-label", "大编辑");
      ex.appendChild(expIcon());
      ex.addEventListener("mousedown", function(e){ e.preventDefault(); });
      ex.addEventListener("click", function(){
        var c = ex.closest(".card");
        if (c) openDrawer(c.dataset.id);
      });
      el.appendChild(ex);
    }

    var del = document.createElement("button");
    del.className = "del";
    del.title = "删除";
    del.textContent = "\u00d7";
    el.appendChild(del);

    return el;
  }

  /* 展开图标（四角向外）。用 SVG 不用字符「⤢」—— 那个码位在多数中文字体里缺字，
     会静默变成一个豆腐块（不报错，就是难看）。 */
  function expIcon(){
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 14 14");
    svg.setAttribute("width", "11");
    svg.setAttribute("height", "11");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    var p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M8.4 2h3.6v3.6M11.6 2.4L7.9 6.1M5.6 12H2V8.4M2.4 11.6L6.1 7.9");
    svg.appendChild(p);
    return svg;
  }

  /* 派发图标（v0.36.0）：一个朝右的箭头从方框里射出去 —— 「把这条交出去」。
     ★ 为什么用图标而不是「派发」两个字：项目分组行只有一行高，
       写上两个字会把项目名挤成省略号，而项目名是那一行的主角。
     ★ 同上一条：SVG 不用字符（「⇥」之类的码位在中文字体里同样缺字，会变豆腐块）。 */
  function sendIcon(){
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 14 14");
    svg.setAttribute("width", "11");
    svg.setAttribute("height", "11");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    var box = document.createElementNS(NS, "path");
    box.setAttribute("d", "M6.2 2.2H3.1a1.4 1.4 0 0 0-1.4 1.4v6.9a1.4 1.4 0 0 0 1.4 1.4h6.9a1.4 1.4 0 0 0 1.4-1.4V7.4");
    var arrow = document.createElementNS(NS, "path");
    arrow.setAttribute("d", "M8.6 1.9h3.5v3.5M12.1 1.9 7.2 6.8");
    svg.appendChild(box);
    svg.appendChild(arrow);
    return svg;
  }

  /* 完成勾。用 SVG 而不是字符 ✓ —— 字符没有笔画可描，做不出「描出来」的动画。
     ★ createElementNS 是必须的：在 SVG 命名空间之外建出来的 <path> 浏览器不认，
       会静默不渲染（不报错，就是空白）。 */
  function tickEl(){
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "tick");
    svg.setAttribute("viewBox", "0 0 14 14");
    var p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M3 7.4l2.6 2.6L11 4.4");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
    return svg;
  }

  /* 「减少动态效果」是系统级偏好，不是装饰开关。
     开着它就换一种**不动的**表达：勾直接出现、划掉直接画上，信息一点没少。 */
  function reduceMotion(){
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) { return false; }
  }

  /* ★ v0.20.0：这六颗原来是「三绿两蓝一灰」—— 一屏彩色粒子，跟新色板打架。
   收敛到紫蓝一系（仍是 6 颗，视觉上靠明度差区分，不靠色相差）。 */
  var SPARK_COLORS = ["#7c6ae0","#8f86f0","#6f8ef0","#a79cf4","#8ea6f2","#b4aaf6"];

  /* ★ v0.30.0：14 颗粒子、**椭圆**散开（横向 ×1.3 / 纵向 ×0.72）。
     ★★ 为什么是椭圆不是正圆：卡片实测约 140×60，纵向只有 60 ——
     纵向飞 46px 就会撞到列的上下边界，被 .col 的 overflow-y:auto 裁掉；
     而横向还有富余。椭圆用同样的力跑得更远，还不会被裁。
     ★ 仍然不做满屏彩带：这是个每天做二十次的动作，不是一次成就解锁。
     这次加的是**密度与距离**（14 颗、飞到约 60px），不是**面积**（全屏）——
     吵人的是满屏乱飞，不是卡片周围这一小簇。 */
  function sparks(card){
    for (var i = 0; i < 14; i++) {
      var a = (Math.PI * 2 * i) / 14 + Math.random() * 0.42;
      var d = 46 * (0.6 + Math.random() * 0.62);
      var s = document.createElement("i");
      s.className = "spark";
      s.style.setProperty("--dx", (Math.cos(a) * d * 1.3).toFixed(1) + "px");
      s.style.setProperty("--dy", (Math.sin(a) * d * 0.72).toFixed(1) + "px");
      s.style.setProperty("--s", (4.2 + Math.random() * 2.8).toFixed(1) + "px");
      s.style.setProperty("--c", SPARK_COLORS[i % SPARK_COLORS.length]);
      s.style.setProperty("--dur", (620 + Math.random() * 200).toFixed(0) + "ms");
      card.appendChild(s);
    }
    // 粒子纯装饰，动画完就摘掉，别在卡片里留 DOM 垃圾（每完成一次留 14 个，很快就是一堆）
    setTimeout(function(){ clearFx(card, ".spark"); }, 1500);
  }

  /* 装饰层统一清掉。三个都是「每次完成插一次」的东西：不摘会越积越多，
     而且卡片节点会被复用（拖出去再拖回来），残留的装饰会跟着一起回来。 */
  function clearFx(card, sel){
    var dead = card.querySelectorAll(sel);
    for (var k = 0; k < dead.length; k++) {
      if (dead[k].parentNode) dead[k].parentNode.removeChild(dead[k]);
    }
  }

  /* ★ v0.30.0：第二圈环 + 一道高光。
     为什么这两个是**插元素**、而不是再加两条 CSS 动画挂到 .land-B 上：
       ① 环 —— 两个动画改同一个 box-shadow，后者整条覆盖前者，不会叠加；
       ② 高光 —— 卡片不能加 overflow:hidden（拖拽态 fixed、编辑态撑开都会被裁），
          所以裁切只能交给一个自己带 overflow 的子元素。 */
  function fx(card){
    var r = document.createElement("i");
    r.className = "ripple";
    card.appendChild(r);
    var sh = document.createElement("i");
    sh.className = "sheen";
    card.appendChild(sh);
    setTimeout(function(){ clearFx(card, ".ripple,.sheen"); }, 1500);
  }

  /* 播放完成反馈。必须在 render() 之后调用 —— 那时这张卡才是新建出来的。 */
  function celebrateDone(id){
    var card = document.querySelector('.card[data-id="' + id + '"]');
    if (!card) return;

    card.classList.add("ticked");     // 勾（.is-done 平时也让它显示，两者最终一致）

    if (reduceMotion()) return;       // 尊重系统偏好：不位移、不撒粒子
    // 同一张卡已经贴上了就别重来；重绘后是新节点，不会命中这条
    if (card.classList.contains("land-B")) return;

    card.classList.add("land-B");
    sparks(card);
    fx(card);   // 第二圈环 + 高光（reduceMotion 已在上面 return 过，这里不用再判一次）

    // 动画类用完即撤：不撤的话这张卡被复用（拖出去再拖回来）不会重播
    setTimeout(function(){
      if (!card.parentNode) return;
      card.classList.remove("land-B");
    }, 780);
  }

  function shortHost(u){
    try { return new URL(u).hostname.replace(/^www\./, ""); }
    catch(e){ return "来源"; }
  }

  /* ---------- 挂起浮层 ---------- */
  // jsdom 里没有 requestAnimationFrame 时退回 setTimeout，否则测试环境会直接抛错
  var raf = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : function(f){ return setTimeout(f, 16); };

  /* ★★ rAF 不能当唯一保险（v0.8.1 真机踩到，诊断证据：hidden=false 但没拿到 .show）。
     窗口被遮挡 / 后台 / 无头环境里，浏览器会节流甚至完全暂停 rAF —— 回调不跑，
     元素就永远拿不到 .show，停在 opacity:0 + pointer-events:none。
     用户看到的是「点了没反应」，而且浮层里面的按钮**全都点不动**（静默失效，
     不报错、不弹窗、控制台也干净）。
     所以 raf 与 setTimeout 双保险：谁先到算谁，只跑一次。
     ★ 别再改回裸 raf —— popup.js 里的 raf 只剩 nextFrame 内部这一处调用。 */
  function nextFrame(fn){
    var called = false;
    function once(){ if (called) return; called = true; fn(); }
    raf(once);
    setTimeout(once, 48);
  }

  var flyTimer = null;

  function setFly(open){
    flyOpen = open;
    var el = document.getElementById("holdFly");
    clearTimeout(flyTimer);
    if (open) {
      setArch(false);   // 两个抽屉盖在同一片区域，同时开只会互相压 —— 开一个就关另一个
      el.hidden = false;                                  // 先取消 display:none
      nextFrame(function(){ el.classList.add("show"); });  // 先让 display 生效，再加过渡类，动画才播得出来
    } else {
      el.classList.remove("show");
      // 等过渡播完再真正隐藏，否则淡出动画会被 display:none 直接掐掉
      flyTimer = setTimeout(function(){ if (!flyOpen) el.hidden = true; }, 200);
    }
  }

  function toggleFly(){ setFly(!flyOpen); }

  /* ---------- 拖拽 ----------
     弹窗里拖拽的真实约束是「指针一旦移出弹窗就收不到事件」，
     所以拖拽激活后立刻 setPointerCapture，把后续 pointermove / pointerup 锁到这张卡上。
     另外 activated 之前不捕获，否则会改变 pointerup 的 target，把点删除、点链接判错。 */
  function clearHighlight(){
    var cols = document.querySelectorAll(".col, .rail");
    for (var i=0;i<cols.length;i++) cols[i].classList.remove("drop-target");
  }

  /* 落点(x,y) → 目标列。pointermove（改高亮）与 pointerup（真落位）**必须共用这一个函数**：
     各写一套的话就会出现「高亮在已完成、实际落到进行中」，那是最伤信任的一类 bug。
     ★ 为什么不能只用 elementFromPoint：指针压在列与列之间的缝里、或压在列外的留白上时，
       它返回的是 #board（不命中任何列）→ 旧代码 target=null → render() 把卡片原样退回原列。
       用户看到的就是「拖过去了，它自己退回来」。真机诊断 11 个场景里这一条最常复现。
     兜底顺序：直接命中 → 挂起窄条容差 → 板子范围内的横向最近列 → 放弃（不动）。 */
  function colAtPoint(x, y){
    var under = document.elementFromPoint(x, y);
    var hit = (under && under.closest) ? under.closest(".col, .rail") : null;
    if (hit) return hit;

    var rail = document.getElementById("holdRail");
    if (rail) {
      var rr = rail.getBoundingClientRect();
      /* 窄条只有 36px 宽，差几个像素就擦肩而过会很难用 —— 给它一点横向容差。
         但绝不放进下面的「最近列」计算里：否则往右多拖一点点就会误挂起。 */
      if (x >= rr.left - 8 && x <= rr.right + 8 && y >= rr.top - 14 && y <= rr.bottom + 14) return rail;
    }

    var board = document.getElementById("board");
    if (!board) return null;
    var br = board.getBoundingClientRect();
    if (y < br.top - 14 || y > br.bottom + 14) return null;   // 拖到板子外面去了，不动

    var best = null, bestD = Infinity;
    /* ★★★ v0.40.0：这里必须只数**看板的列**（`.col[data-status]`），不能写成 `.col`。
       团队任务那个容器里也有两个 `.col`（它的两个分区复用了列的皮肤），
       而它们在「今天」视图下是 `hidden` ⇒ rect 是 **0×0、中心在 (0,0)**。
       于是「指针落在列外留白上」时，「最近列」会被算成那个**隐藏的 0 宽列**：
       x=3 时它距离 3，而真的最近列（待办，中心 89）距离 89 —— 它赢。
       它的 `dataset.status` 是 `undefined` ⇒ `target` 无效 ⇒ 卡片**静默退回原列**，
       也就是用户说的「拖过去了，它自己又退回来」。
       ★ 这不是理论风险：真机套件里 ⑭ 那条断言 5/5 打红，量出来的现场就是它
         （`.col` 数出 5 个，其中两个 `undefined:0-0`）。
       ★ 为什么原来没这毛病：v0.40.0 之前全项目只有看板那三列是 `.col`。
         同一个坑在 `clearHighlight()` 里无害（多摘两个不存在的 class），
         但**落点计算**里它直接改结果。
       ★ 同族教训：`ALL_STATUSES.indexOf(target)` 那道守卫只是**兜住**了无效 target、
         并不会报警 —— 无效值被静默吃掉，看起来像「什么都没发生」。
         所以这里要从**源头**把非状态列排除，而不是靠下游守卫。 */
    var cols = document.querySelectorAll(".col[data-status]");
    for (var i=0;i<cols.length;i++){
      var r = cols[i].getBoundingClientRect();
      var d = Math.abs(x - (r.left + r.width / 2));
      if (d < bestD) { bestD = d; best = cols[i]; }
    }
    return best;
  }

  /* ---------- 磁吸位移 ----------
     纯视觉：算一个「朝目标列中心」的横向位移，写进 --magx。
     上限 14px —— 卡片必须始终跟在指针底下。再吸多一点，人就会觉得
     「它自己跑了 / 甩不开」，连续微调落点时最难受（Kanban 类产品的手感基准就在这附近）。
     只在指针进入「列宽的 40% 吸引区」之后才开始吸，超出就是 0：
     列外留白、列间缝隙不吸，这样「吸」才是个有边界的信号，而不是处处都在吸。
     ★ 和 colAtPoint 用同一个 col：高亮在哪、卡片就被吸向哪、松手就落到哪，三者永远一致。 */
  var MAG_MAX = 14, MAG_ZONE = 0.4;
  function magnetOffset(x, col){
    if (!col) return 0;
    var r = col.getBoundingClientRect();
    if (!r.width) return 0;
    var d = (r.left + r.width / 2) - x;
    if (Math.abs(d) > r.width * MAG_ZONE) return 0;
    var off = d * 0.35;
    return off > MAG_MAX ? MAG_MAX : (off < -MAG_MAX ? -MAG_MAX : off);
  }

  function activateDrag(){
    /* ★ 如果 pointerdown 之后的提交把这列重绘了，手上这个节点已经脱离文档 ——
       按 id 重新取一张当前的卡，否则拖的是个看不见的幽灵（松手还会静默失败）。 */
    if (!dragState.el.isConnected) {
      var fresh = document.querySelector('.card[data-id="' + dragState.id + '"]');
      if (!fresh || fresh.classList.contains("editing")) { dragState = null; return false; }
      dragState.el = fresh;
    }
    var el = dragState.el;
    var r = el.getBoundingClientRect();

    // 占位元素留在原地撑住高度，真正的卡片被挪走
    var ph = document.createElement("div");
    ph.className = "ph";
    ph.style.height = r.height + "px";
    el.parentNode.insertBefore(ph, el);
    dragState.ph = ph;

    el.style.width = r.width + "px";
    el.style.height = r.height + "px";
    el.style.left = r.left + "px";
    el.style.top = r.top + "px";
    /* ★★★★★ v0.21.0：这里原来要把 --tint 拷进 inline style —— 卡片一旦挂到 body 下
       就不在 .col / .holdfly 里了，继承链断掉，`.card.dragging` 里那句
       rgba(var(--tint),…) 会 fallback 成灰，于是拖起来就褪色。
       现在拖拽态**不再用状态色**（拍板「卡里不要放颜色」），这条拷贝随之作废。
       ⇒ 但将来若拖拽态又要用 --tint 上色，**必须**在这一行之前重新拷一次；
         症状是「拖起来就褪色」，而且只出现在拖动的那几百毫秒里，很难复现。 */
    el.classList.add("dragging");

    /* ★ 这一句不能删：必须先把卡片挪到 body 下，再做 fixed 定位。
       .col 和 .holdfly 上都有 backdrop-filter（毛玻璃），而按规范，
       backdrop-filter 不为 none 的元素会成为 position:fixed 后代的「包含块」——
       卡片如果还留在列里，下面按视口坐标算出来的 left/top 就会以那一列为原点，
       拖起来整张卡会偏移一个列的位置，看着就是「飞了」。
       body 上没有 transform / filter / backdrop-filter，定位才以视口为准。 */
    document.body.appendChild(el);

    document.body.classList.add("dragging-on");
    dragState.active = true;
    return true;
  }

  function endDragVisual(d){
    d.el.classList.remove("dragging");
    d.el.removeAttribute("style");
    if (d.pid !== undefined && d.el.releasePointerCapture) {
      try { d.el.releasePointerCapture(d.pid); } catch(err){}
    }
    if (d.ph && d.ph.parentNode) d.ph.parentNode.removeChild(d.ph);
    // 卡片已经被挪到 body 下了，列里已经没有它；这里直接把这个临时节点删掉，
    // 随后的 render() 会按数据重新生成一张。不删的话 body 里会留一张幽灵卡。
    if (d.el.parentNode) d.el.parentNode.removeChild(d.el);
    document.body.classList.remove("dragging-on");
    clearHighlight();
  }

  /* ★ 点编辑卡以外的**任何地方**都算保存。
     原来只有两条提交路径：回车，或者焦点移出卡片（blur + 120ms 延迟）。
     后者在很多点击下并不可靠 —— 点在不可聚焦的区域、或点在被 preventDefault 掉的元素上，
     焦点压根不会移走，blur 不触发，人就以为「我点了别处，它没保存」。
     这里在**捕获阶段**补一条确定性的路径：只要落点在编辑卡外面就立刻提交，
     而且先于拖拽逻辑执行，不会出现「开始拖了才发现编辑没提交」。 */
  document.addEventListener("pointerdown", function(e){
    if (!activeCommit) return;
    /* 卡内操作（输入框/三档/日期命中层）不算离开 —— 用 closest 比 querySelector 准。
       ★ .selpop 必须一起放行：自绘下拉的浮层挂在 body 下，不在 .card.editing 里，
         不放行的话「在编辑卡里点一下项目下拉选个值」就等于「点了卡片以外的地方」，
         面板会当场关掉、内容被提交 —— 和 qpop / pseg 是同一类坑。 */
    if (e.target && e.target.closest &&
        e.target.closest(".card.editing, .selpop")) return;
    var fn = activeCommit;
    activeCommit = null;
    pendingRender = Promise.resolve(fn());
    pendingRender.then(function(){ pendingRender = null; });
  }, true);

  document.addEventListener("pointerdown", function(e){
    if (e.button !== 0) return;

    /* ★★ 点在「正在编辑的那张卡」里面（标题框/备注/日期/项目/三档开关）＝ 用户正在填内容，
       绝不能当成「点了别处」去提交。这一条必须排在下面的提交兜底**之前**。
       上一版顺序反了：点一下标题输入框就先提交 + 关面板再往下走，
       结果就是「点开卡片之后根本没法填」——2026-09-15 老大报的就是它。
       捕获阶段那条监听虽然已经放过了卡内点击，但没拦住这里的兜底。 */
    if (e.target && e.target.closest && e.target.closest(".card.editing")) return;

    /* 兜底：正在编辑时又要去动别的地方 → 先把编辑提交掉（捕获阶段那条通常已经做了）。 */
    if (activeCommit) {
      var _c = activeCommit; activeCommit = null;
      pendingRender = Promise.resolve(_c());
      pendingRender.then(function(){ pendingRender = null; });
    }
    if (e.target.closest(".del") || e.target.closest(".clink") || e.target.closest(".cedit") ||
        e.target.closest(".dexp") ||
        e.target.closest(".qdate") || e.target.closest(".datelink")) return;
    if (e.target.closest("#holdRail")) return;   // 窄条是按钮，不是卡片
    var card = e.target.closest(".card");
    if (!card || card.classList.contains("editing")) return;
    // 归档抽屉里的是只读清单：不拖、不就地编辑（见 renderArch 那段说明）
    if (card.closest("#archFly")) return;

    var r = card.getBoundingClientRect();
    dragState = {
      id: card.dataset.id, el: card, ph: null, active: false, pid: undefined,
      fly: !!card.closest("#holdFly"),
      dx: e.clientX - r.left, dy: e.clientY - r.top,
      sx: e.clientX, sy: e.clientY
    };
    e.preventDefault();
  });

  document.addEventListener("pointermove", function(e){
    if (!dragState) return;

    if (!dragState.active) {
      if (Math.abs(e.clientX - dragState.sx) + Math.abs(e.clientY - dragState.sy) < 5) return;
      if (!activateDrag()) return;   // 卡片已被重绘换掉 → 这次拖拽作废
      dragState.pid = e.pointerId;
      if (dragState.el.setPointerCapture) {
        try { dragState.el.setPointerCapture(e.pointerId); } catch(err){}
      }
    }

    dragState.el.style.left = (e.clientX - dragState.dx) + "px";
    dragState.el.style.top  = (e.clientY - dragState.dy) + "px";

    // 卡片和占位都设了 pointer-events:none，浮层在拖拽时也让路，这里能直接穿到列上
    var col = colAtPoint(e.clientX, e.clientY);
    var cols = document.querySelectorAll(".col, .rail");
    for (var i=0;i<cols.length;i++) cols[i].classList.toggle("drop-target", cols[i] === col);
    // 磁吸：卡片朝目标列中心偏移一点（上限 14px，指针仍主导位置）
    dragState.el.style.setProperty("--magx", magnetOffset(e.clientX, col) + "px");
  });

  document.addEventListener("pointerup", function(e){
    if (!dragState) return;
    var d = dragState;
    dragState = null;

    // 没超过 5px 阈值 = 单击
    if (!d.active) {
      if (d.fly) resumeTask(d.id);   // 浮层里的卡片：单击 = 取消挂起
      else startEdit(d.id);          // 主列的卡片：单击 = 就地编辑
      return;
    }

    /* ★ 和 pointermove 用同一个函数算落点 —— 高亮在哪就应该落到哪。 */
    var col = colAtPoint(e.clientX, e.clientY);
    var target = col ? col.dataset.status : null;

    endDragVisual(d);

    if (target && ALL_STATUSES.indexOf(target) >= 0) {
      var t = null;
      for (var i=0;i<st.tasks.length;i++) if (st.tasks[i].id === d.id) t = st.tasks[i];
      if (t && t.status !== target) {
        t.status = target;
        t.doneAt = target === "done" ? Date.now() : null;
        /* 进「已完成」→ 开一个 900ms 的播报窗口。
           不在这里直接操作 DOM（render() 会整列重建，此刻这张卡马上就成废节点），
           也不只记一个 id —— 见 celebrating 那段注释：紧接着还会有一次 storage.onChanged 触发的 render。 */
        if (target === "done") celebrating = { id: t.id, until: Date.now() + CELEBRATE_MS };
        save().then(function(){
          render();
          if (target === HOLD) toast("已挂起，先不想它");
        });
        return;
      }
    }
    render();   // 没换列也要把浮起的卡片还原回原位
  });

  // 超出边界松开、系统打断、弹窗失焦 —— 三种兜底，避免卡片卡在 fixed 状态
  document.addEventListener("pointercancel", cancelDrag);
  window.addEventListener("blur", cancelDrag);

  function cancelDrag(){
    if (dragState && dragState.active) endDragVisual(dragState);
    dragState = null;
  }

  /* ---------- 取消挂起 ---------- */
  function resumeTask(id){
    for (var i=0;i<st.tasks.length;i++){
      if (st.tasks[i].id === id) {
        st.tasks[i].status = "todo";
        st.tasks[i].doneAt = null;
        save().then(function(){ render(); toast("已放回待办"); });
        return;
      }
    }
  }

  /* ---------- 就地编辑 ---------- */
  function startEdit(cardOrId){
    // 还有一张卡在编辑 → 先把它提交掉，等重绘完成后再开这一张
    if (activeCommit) {
      var prev = activeCommit;
      activeCommit = null;
      pendingRender = Promise.resolve(prev());
      pendingRender.then(function(){ startEdit(cardOrId); });
      return;
    }
    /* 刚提交完、重绘还没落地 → 等它落地再开。
       不等的话，新建的编辑面板会被这次重绘一起冲掉，看起来就是「点了另一张卡没反应」。 */
    if (pendingRender) {
      var pp = pendingRender;
      pendingRender = null;
      pp.then(function(){ startEdit(cardOrId); });
      return;
    }
    var id = (typeof cardOrId === "string") ? cardOrId
           : (cardOrId && cardOrId.dataset ? cardOrId.dataset.id : null);
    if (!id) return;

    // 重绘后旧元素会失效，统一按 id 重新取当前的卡片
    var card = document.querySelector('.card[data-id="' + id + '"]');
    if (!card || card.classList.contains("editing")) return;

    var t = null;
    for (var i = 0; i < st.tasks.length; i++) if (st.tasks[i].id === id) t = st.tasks[i];
    if (!t) return;

    card.classList.add("editing");

    var box = document.createElement("div");
    box.className = "cedit";

    var ti = document.createElement("input");
    ti.value = t.title;
    ti.placeholder = "任务标题";

    /* ★ 备注从单行 <input> 换成多行 <textarea>（v0.9.0）。
       用户原话「如果我要填写很多内容，修改起来会比较麻烦」—— 「内容多」基本都发生在备注上，
       而它此前是个单行框，长备注只能横着爬，既看不全也改不动。
       rows=3 起步、可手动往下拉（见 .cedit textarea 的 resize:vertical）。
       Enter 在它里面必须是**换行**，保存走 Ctrl/Cmd+Enter —— 见下面 keydown 那条。 */
    var ni = document.createElement("textarea");
    ni.rows = 3;
    ni.value = t.note || "";
    ni.placeholder = "备注（可留空）";

    /* 日期与项目：这两个字段此前**完全不可改** —— 建任务时日期被写死成当天，
       之后再也没有入口，等于「今天建的永远是今天的」。
       这是盘代码时挖出来的硬缺口，不是锦上添花。 */
    var two = document.createElement("div");
    two.className = "two";

    var di = document.createElement("input");
    di.type = "date";
    di.value = t.date || "";
    di.title = "计划日期";

    /* 日期框外面包一层 + 盖一个透明的满铺命中按钮。
       原生只在最右侧的小日历图标上响应点击，框里其他地方点了没反应 ——
       对这么小的控件等于「必须瞄准」。★ showPicker() 必须由真实点击触发
       （浏览器要求用户激活，异步里调会被拒），所以只能放在 click 里。 */
    var dwrap = document.createElement("div");
    dwrap.className = "datewrap";
    dwrap.appendChild(di);
    var dhit = document.createElement("button");
    dhit.type = "button";
    dhit.className = "datehit";
    dhit.title = "选择日期";
    dhit.setAttribute("aria-label", "选择日期");
    dhit.addEventListener("click", function(){
      try { di.focus(); } catch (e) {}
      try { if (typeof di.showPicker === "function") di.showPicker(); } catch (e) {}
    });
    dwrap.appendChild(dhit);

    /* 项目下拉：同样换成自绘的 .selbtn（原生 select 的下拉列表改不了样式）。
       项目被删掉之后老任务还挂着那个名字 —— 补一项兜住，
       否则会静默落到第一个项目上，一提交就把任务改到别的项目去了。 */
    var names = projects.map(function(p){ return p.name; });
    if (t.project && names.indexOf(t.project) < 0) names.push(t.project);
    var pv2 = t.project || (names[0] || "");
    var psel = document.createElement("button");
    psel.type = "button";
    psel.className = "selbtn";
    psel.title = "所属项目";
    psel.setAttribute("aria-haspopup", "listbox");
    psel.setAttribute("aria-expanded", "false");
    var psTx = document.createElement("span");
    psTx.className = "seltxt";
    psel.appendChild(psTx);
    var psChev = document.createElement("i");
    psChev.className = "chev";
    psel.appendChild(psChev);
    setSelValue(psel, pv2);
    psel.addEventListener("click", function(){
      toggleSelPop(psel, names, pv2, function(v){ pv2 = v; setSelValue(psel, v); });
    });

    two.appendChild(dwrap); two.appendChild(psel);

    /* 三档优先级。第三档就是「没设」—— 所以只需要两个真值 + 一个默认，
       不额外存 "normal"，飞书那格留空也就是默认档。 */
    var pv = normPriority(t.priority);
    var pseg = document.createElement("div");
    pseg.className = "pseg";
    [["high","高"],["mid","中"],["","普通"]].forEach(function(pair){
      var b = document.createElement("button");
      b.type = "button";
      b.dataset.p = pair[0];
      b.textContent = pair[1];
      if (pair[0] === pv) b.classList.add("on");
      /* ★ mousedown 必须拦掉：不拦的话按钮会抢走输入框的焦点 →
         输入框失焦 → 触发下面的 blur 提交 → 想点「高」，面板先关了。 */
      b.addEventListener("mousedown", function(e){ e.preventDefault(); });
      b.addEventListener("click", function(){
        pv = pair[0];
        var all = pseg.querySelectorAll("button");
        for (var k = 0; k < all.length; k++) all[k].classList.toggle("on", all[k] === b);
      });
      pseg.appendChild(b);
    });

    /* ★ 这里原来挂了一行「回车或点别处都能保存」的提示，已按用户要求删除 ——
       两条保存路径都真的能用，这行就只是占地方。别再补回来。 */
    /* 「展开到大编辑」（v0.9.1）。
       ★ 先把当前输入写回任务再开抽屉 —— 不写的话，用户在这里改了标题又点展开，
         抽屉里显示的还是旧标题，看着就像刚才那段输入被吞了。
       ★ 然后 closed 置位：不置位的话，blur 那条兜底（120ms 后）还会再提交一次。 */
    var expBtn = document.createElement("button");
    expBtn.type = "button";
    expBtn.className = "cexp";
    expBtn.textContent = "展开到大编辑";
    expBtn.addEventListener("mousedown", function(e){ e.preventDefault(); });
    expBtn.addEventListener("click", function(){
      var v0 = ti.value.trim();
      if (v0) t.title = v0;
      t.note = ni.value.trim();
      if (di.value) t.date = di.value;
      if (pv2) t.project = pv2;
      t.priority = pv;
      closed = true;
      activeCommit = null;
      pendingRender = save().then(render);
      pendingRender.then(function(){ pendingRender = null; });
      openDrawer(id);
    });

    box.appendChild(ti); box.appendChild(ni); box.appendChild(two);
    box.appendChild(pseg);
    box.appendChild(expBtn);
    card.appendChild(box);

    /* ★★ 备注框跟着内容长高（上限由 CSS 的 max-height 夹住，132px ≈ 7 行）。
       用户原话是「如果我要填写很多内容，修改起来会比较麻烦」——
       只把它从单行换成多行**还不够**：备注一长，框里照样只看得见头三行、得在里面滚，
       等于把「横着爬」换成了「竖着滚」。所以让它随内容长，长到 max-height 为止；
       再长就交给滚动条 + 右下角手动拉高。自动长高是多行输入框的通行做法。
       ★ 高度用 scrollHeight 量，不用 value.length 估 —— 中英混排、折行位置都会影响
         实际占几行，估出来的高度必然对不上，还得为每种字符配一个系数。
       ★ 必须放在 appendChild **之后**：元素还没进文档时 scrollHeight 恒为 0。 */
    var autosize = function(){
      ni.style.height = "auto";
      ni.style.height = Math.min(ni.scrollHeight + 2, 132) + "px";
    };
    ni.addEventListener("input", autosize);
    autosize();     // 打开时就按已有备注撑开：旧备注本来就长的话，更该一眼看全

    ti.focus();
    ti.select();

    var closed = false;

    function commit(){
      if (closed) return Promise.resolve();
      closed = true;
      activeCommit = null;
      var v = ti.value.trim();
      if (v) {
        // 按 id 重新取一次：期间可能被右键捕获等外部写入替换过 st.tasks
        var cur = null;
        for (var k = 0; k < st.tasks.length; k++) if (st.tasks[k].id === id) cur = st.tasks[k];
        if (cur) {
          cur.title = v;
          cur.note = ni.value.trim();
          // 日期留空 = 保持原值。允许清空的话任务会当场从「今天」视图里消失，
          // 看起来就像被删了 —— 这个误会比「改不了日期」贵得多。
          if (di.value) cur.date = di.value;
          if (pv2) cur.project = pv2;
          cur.priority = pv;
        }
        pendingRender = save().then(render);
        pendingRender.then(function(){ pendingRender = null; });
        /* ★ 自动保存必须**显式报状态**（v0.9.0）。调研里 autosave 的标准配套就是这个：
           「Saving… → Saved」两态可见。以前是静默保存，改完心里没底 —— 这是整个
           「填写交互」里最便宜也最容易被忽略的一条。走既有的 toast 通道，不新开一套
           （同一屏里混用两套保存语义，是调研里点名的坑）。
           1.2s 就收：编辑是高频动作，提示别赖着不走。
           ⚠️ 只在**写成功**时报，失败分支留空 —— 报错的通道是同步状态那条，别抢。 */
        pendingRender.then(function(){ toast("已保存", null, null, 1200); },
                           function(){});
        return pendingRender;
      }
      render();
      return Promise.resolve();
    }
    function cancel(){
      if (closed) return Promise.resolve();
      closed = true;
      activeCommit = null;
      render();
      return Promise.resolve();
    }
    activeCommit = commit;

    /* ★ 这里原来还有第 4 个元素 ps（原生 select），它已被换成自绘的 psel。
       删变量时漏了这一处引用 —— 数组里多一个 undefined，forEach 走到它就抛 TypeError，
       于是**下面所有初始化全部不执行**：回车提交、blur 提交、activeCommit 兜底全都没绑上，
       表现就是「点开编辑卡之后怎么都保存不了、面板也关不掉」。
       psel 是按钮，本来也不该进这个列表（它靠 .card.editing 判断豁免，不需要 blur 提交）。 */
    [ti, ni, di].forEach(function(inp){
      inp.addEventListener("keydown", function(e){
        // select 上的 Enter 是「确认这个选项」，不该当成保存
        if (inp.tagName === "SELECT") return;
        if (e.key === "Enter") {
          /* ★ 备注是多行框：Enter 在它里面是「换行」，不是「保存」。
             多行框里按回车就提交 = 永远写不出一段有分段的备注。
             保存改走 Ctrl/Cmd+Enter —— 多行输入框的通行约定。 */
          if (inp === ni && !(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          commit();
        }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
      });
      // 焦点移出整张卡片才提交，卡片内控件之间切换不提交
      inp.addEventListener("blur", function(){
        setTimeout(function(){
          if (!closed && !card.contains(document.activeElement)) commit();
        }, 120);
      });
    });
  }

  // 弹窗随时可能被关掉，关之前把编辑中的内容抢存一次
  window.addEventListener("pagehide", function(){
    if (activeCommit) { try { activeCommit(); } catch(e){} }
    if (drawerOpen) { try { dFlush(); } catch(e){} }
  });

  /* ---------- 编辑抽屉（v0.9.1）----------

     为什么要有**第二套**编辑界面：就地编辑住在一列里，可用宽度只有约 138px，
     字段一多就竖向挤成一条 —— 这就是「要填很多内容、改起来比较麻烦」的根因。
     抽屉给的是整幅宽度 + 整块高度：标题 / 备注 / 日期 / 项目 / 状态 / 优先级一次全在。

     ★ 不是替换关系：就地编辑继续负责「顺手改个标题」（单击卡片就有），
       抽屉负责「认真改一条」。三条入口：
         · 卡片右下角的展开图标（hover 出现）
         · 就地编辑卡底部的「展开到大编辑」← 用户意识到框太小的那一刻，它正好在眼前
         · 键盘 e（光标停的那张卡）

     保存语义 = **改了就自动存**（320ms 防抖），头部那行小字报状态：
       「编辑中… → 保存中… → 已保存」。
     为什么不放「保存」按钮：就地编辑已经是「点别处就提交」，同一个弹窗里再冒出第二套
     保存语义，用户每次都得为「这次要不要点保存」停顿一下 —— 而那个停顿没有任何收益。
     但**状态必须可见**：静默自动保存是这条设计唯一真正会被骂的点（改完心里没底）。 */

  var drawerOpen = false;
  var drawerId = null;
  var dDirty = false;
  var dTimer = null;
  var dStateT = null;
  var dPri = "", dProj = "", dStatus = "todo";

  function dTask(){
    for (var i = 0; i < st.tasks.length; i++)
      if (st.tasks[i].id === drawerId) return st.tasks[i];
    return null;
  }

  /* 保存状态那行小字。「已保存」给 1.4s 滞留就自己淡掉 ——
     常驻的「已保存」看三天就成了噪音，和那行被删掉的引导条一个下场。 */
  function dState(txt, stay){
    var el = document.getElementById("dState");
    if (!el) return;
    clearTimeout(dStateT);
    if (!txt) { el.classList.remove("on"); return; }
    el.textContent = txt;
    el.classList.add("on");
    if (stay) dStateT = setTimeout(function(){ el.classList.remove("on"); }, stay);
  }

  /* 高度用 scrollHeight 量、不用 value.length 估（中英混排折行位置不同，估不准）；
     必须在元素已入文档之后调（没入文档时 scrollHeight 恒为 0）。两条都是 v0.9.0 踩过的。 */
  function dAutosize(el, max){
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight + 2, max) + "px";
  }

  function fmtDay(ts){
    var d = new Date(ts);
    return (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  function renderDMeta(){
    var el = document.getElementById("dMeta");
    if (!el) return;
    var t = dTask();
    if (!t) { el.textContent = ""; return; }
    var parts = [];
    /* ★ v0.34.0：派出去的活要**看得见**。它在角标上是被排除的（那是刻意的，
       交出去的活不占「我还有几件没干」），所以抽屉里必须有个地方说清它去哪了 ——
       否则这条任务在本地看起来跟没派过一模一样，你会一遍遍地重新处理它。 */
    /* ★ v0.39.0：抽屉里也要说清「到哪一步了」。光留一句「已派给 X」等于没说 ——
       那句话在派出去之后**永远不变**，而老大要问的恰恰是「后来怎么样了」。 */
    if (t.assign && t.assign.to) {
      var sw = (typeof Inbox !== "undefined")
        ? Inbox.stText(Inbox.assignState(t.assign)) : "";
      parts.push("已派给 " + t.assign.to + (sw ? "（" + sw + "）" : ""));
    }
    /* 失败原因一直留在抽屉里，直到重派成功把它清掉（P0-5）。 */
    if (t.assign && t.assign.st === "failed" && t.assign.why) parts.push(t.assign.why);
    if (t.createdAt) parts.push("建于 " + fmtDay(t.createdAt));
    if (t.doneAt)    parts.push("完成于 " + fmtDay(t.doneAt));
    if (t.archived)  parts.push("已归档");
    el.textContent = parts.join("，");
  }

  /* 状态三档。★ 必须和拖拽 / 键盘走**同一套语义**（doneAt 的写法 + 开播报窗口），
     三条路径各写一份迟早长出「拖过去有动画、这里没有」这种莫名其妙的不一致。 */
  function setDStatus(status){
    var seg = document.getElementById("dSeg");
    var t = dTask();
    if (!seg) return;
    var all = seg.querySelectorAll("button");
    for (var i = 0; i < all.length; i++) all[i].classList.toggle("on", all[i].dataset.v === status);
    if (!t || t.status === status) { dStatus = status; return; }
    dStatus = status;
    t.status = status;
    t.doneAt = status === "done" ? Date.now() : null;
    if (status === "done") celebrating = { id: t.id, until: Date.now() + CELEBRATE_MS };
    dDirty = true;
    dState("编辑中…");
    clearTimeout(dTimer);
    dTimer = setTimeout(dFlush, 80);      // 状态是「一下点完」的，别等满 320ms
    renderDMeta();
  }

  function buildDSeg(){
    var seg = document.getElementById("dSeg");
    var pr  = document.getElementById("dPseg");
    if (seg) {
      seg.innerHTML = "";
      [["todo","待办"],["doing","进行中"],["done","已完成"]].forEach(function(p){
        var b = document.createElement("button");
        b.type = "button"; b.dataset.v = p[0]; b.textContent = p[1];
        if (p[0] === dStatus) b.classList.add("on");
        /* mousedown 拦掉：不拦会抢走标题/备注的焦点，然后 blur 那条兜底来提交一次多余的。 */
        b.addEventListener("mousedown", function(e){ e.preventDefault(); });
        b.addEventListener("click", function(){ setDStatus(p[0]); });
        seg.appendChild(b);
      });
    }
    if (pr) {
      pr.innerHTML = "";
      [["high","高"],["mid","中"],["","普通"]].forEach(function(p){
        var b = document.createElement("button");
        b.type = "button"; b.dataset.v = p[0]; b.textContent = p[1];
        if (p[0] === dPri) b.classList.add("on");
        b.addEventListener("mousedown", function(e){ e.preventDefault(); });
        b.addEventListener("click", function(){
          dPri = p[0];
          var all = pr.querySelectorAll("button");
          for (var k = 0; k < all.length; k++) all[k].classList.toggle("on", all[k] === b);
          dTouch();
        });
        pr.appendChild(b);
      });
    }
  }

  function buildDProject(){
    var btn = document.getElementById("dProject");
    if (!btn) return;
    var names = projectNames();
    /* 项目被删掉之后老任务还挂着那个名字 —— 补一项兜住，
       否则会静默落到第一个项目上，下次一存就把任务改到别的项目去了（就地编辑同一处坑）。 */
    if (dProj && names.indexOf(dProj) < 0) names.push(dProj);
    if (!names.length) { btn.hidden = true; return; }
    btn.hidden = false;
    setSelValue(btn, dProj || names[0]);
    /* ★ 用 onclick 赋值而不是 addEventListener：抽屉每次打开都会重建这一处，
       累加监听器会让「选一次项目」触发 N 次（N = 开过几次抽屉）。 */
    btn.onclick = function(){
      toggleSelPop(btn, names, dProj || names[0], function(v){
        dProj = v;
        setSelValue(btn, v);
        dTouch();
      });
    };
  }

  /* 把抽屉里的控件值写回任务对象。返回「有没有真的改动」。
     ★ 标题空着就**不动原标题**：允许把标题删空会让任务在看板上变成一个空格子，
       而用户多半只是全选之后还没想好。关抽屉时会告诉他一声（见 closeDrawer）。 */
  function dApply(){
    var t = dTask();
    if (!t) return false;
    var ch = false;
    var ti = document.getElementById("dTitle");
    var ni = document.getElementById("dNote");
    var di = document.getElementById("dDate");
    var v = ti ? ti.value.trim() : "";
    if (v && v !== t.title) { t.title = v; ch = true; }
    var n = ni ? ni.value.trim() : "";
    if (n !== (t.note || "")) { t.note = n; ch = true; }
    var dv = di ? di.value : "";
    if (dv && dv !== (t.date || "")) { t.date = dv; ch = true; }
    if (dProj && dProj !== t.project) { t.project = dProj; ch = true; }
    if (dPri !== normPriority(t.priority)) { t.priority = dPri; ch = true; }

    /* ---------- 派给团队成员（v0.34.0）----------
       ★★★ v0.32.0 缺的就是这一段：dApply 从来没写过 t.assign，
         于是「派发」在本地连痕迹都留不下、runDispatch 也就没人调 ——
         整条链路在真机上一步都没走通过，而单测全绿。
       ★ 只在**目标变了**的时候发一次：dApply 在每次收起抽屉、以及编辑中
         每 320ms 的自动保存时都会被调用，不比较的话会反复往团队表里写同一条任务
         （接收人那边收到一串一模一样的重复）。
       ★ 改派（A → B）在这里是「再写一条」，旧的那条留在表里 —— A 仍然看得见它。
         这是**刻意**的：我们手上没有旧记录的 recordId，而为了改派去读一遍全表、
         再删掉一条别人正在看的记录，代价和风险都不成比例。
       ★ 取消勾选同理：只摘掉本地的 assign，不去删团队表里那条 ——
         对方看到的那条仍然是「他确实被派过」的事实。
       ★★ 拿不到那个复选框时**什么都不做**（而不是当成「没勾」）：
         当成没勾的话，这个元素哪天出点问题，保存一次就会静默把所有派发标记抹掉。 */
    var onBox = document.getElementById("dAssignOn");
    if (onBox) {
      var wantTo = onBox.checked ? dAssignTo : "";
      var curTo = (t.assign && t.assign.to) || "";
      if (wantTo !== curTo) {
        if (wantTo) {
          t.assign = { to: wantTo, at: Date.now() };
          runDispatch(t, wantTo);    /* fire and forget，理由见 runDispatch */
        } else {
          delete t.assign;
        }
        ch = true;
      }
    }
    return ch;
  }

  function dTouch(){
    dDirty = true;
    dState("编辑中…");
    clearTimeout(dTimer);
    dTimer = setTimeout(dFlush, 320);
  }

  function dFlush(){
    clearTimeout(dTimer); dTimer = null;
    if (!dDirty) return Promise.resolve();
    dDirty = false;
    if (!dApply()) { dState("已保存", 1400); return Promise.resolve(); }
    dState("保存中…");
    pendingRender = save().then(function(){
      render();
      dState("已保存", 1400);
    });
    pendingRender.then(function(){ pendingRender = null; });
    return pendingRender;
  }

  function openDrawer(cardOrId){
    /* 和 startEdit 一样的排队：先把挂着的就地编辑提交掉 / 等上一次重绘落地，
       否则抽屉里的值会被紧接着的那次 render 用旧数据覆盖。 */
    if (activeCommit) {
      var p0 = activeCommit; activeCommit = null;
      pendingRender = Promise.resolve(p0());
      pendingRender.then(function(){ openDrawer(cardOrId); });
      return;
    }
    if (pendingRender) {
      var p1 = pendingRender; pendingRender = null;
      p1.then(function(){ openDrawer(cardOrId); });
      return;
    }
    var id = (typeof cardOrId === "string") ? cardOrId
           : (cardOrId && cardOrId.dataset ? cardOrId.dataset.id : null);
    if (!id) return;
    var t = null;
    for (var i = 0; i < st.tasks.length; i++) if (st.tasks[i].id === id) t = st.tasks[i];
    if (!t) return;

    /* 抽屉盖在最上面，下面那几层同时开着只会互相压（而且它们状态还记着「我开着」，
       抽屉一关就全都冒出来）。开抽屉就是一次视角切换，顺手全收掉。 */
    setFly(false);
    setArch(false);
    setInbox(false);
    closeQuickDate();
    closeSelPop();

    drawerId = id;
    dStatus = t.status;
    dPri = normPriority(t.priority);
    dProj = t.project || (projectNames()[0] || "");
    dDirty = false;
    clearTimeout(dTimer);
    dState("");

    var ti = document.getElementById("dTitle");
    var ni = document.getElementById("dNote");
    var di = document.getElementById("dDate");
    if (ti) ti.value = t.title || "";
    if (ni) ni.value = t.note || "";
    if (di) di.value = t.date || "";
    buildDSeg();
    buildDProject();
    /* ★ 必须在 buildDProject 之后：它要读 dTask() 拿到这条任务**当前**的接收人，
       而 dTask() 靠 drawerId —— 上面那几行已经把 drawerId 设好了。
       顺序反过来会读到上一条任务的接收人（症状：打开 A 的抽屉，显示的是 B 的接收人）。 */
    buildDAssign();
    renderDMeta();

    var veil = document.getElementById("dVeil");
    var dr = document.getElementById("drawer");
    if (!veil || !dr) return;
    veil.hidden = false;
    dr.hidden = false;
    /* ★ 出场走 nextFrame（rAF + 48ms 兜底），不用裸 rAF：
       窗口被遮挡 / 后台时 rAF 会被节流甚至暂停，面板会停在 opacity:0 且点不动 ——
       表现是「点了没反应」，而且不报错。这是 v0.8.1 用血换来的那条。 */
    nextFrame(function(){
      veil.classList.add("show");
      dr.classList.add("show");
      /* 尺寸要等元素**可见之后**才能量（hidden 时 scrollHeight 全 0） */
      dAutosize(ti, 72);
      dAutosize(ni, 196);
    });
    drawerOpen = true;
    /* 光标放在标题末尾而不是全选：这是个「继续改」的界面，不是重命名框。
       全选之后随手一打字就把原标题抹了，代价太大。 */
    try {
      ti.focus();
      ti.setSelectionRange(ti.value.length, ti.value.length);
    } catch (e) {}
  }

  function closeDrawer(){
    if (!drawerOpen) return;
    drawerOpen = false;
    var ti = document.getElementById("dTitle");
    var blank = !!(ti && !ti.value.trim());
    clearTimeout(dTimer);
    dTimer = null;
    var p = dFlush();        // ★ 必须在 drawerId 置空之前调：dApply 靠 drawerId 找任务
    drawerId = null;
    dDirty = false;
    if (blank) {
      p.then(function(){ toast("标题不能为空，已保留原标题"); }, function(){});
    } else {
      p.then(function(){}, function(){});
    }
    /* 项目下拉是挂在 body 下的浮层，不跟着抽屉一起走 —— 不显式收掉的话，
       抽屉关了它还在半空中飘着（它的锚点已经跟着抽屉一起藏了）。 */
    closeSelPop();
    var veil = document.getElementById("dVeil");
    var dr = document.getElementById("drawer");
    if (veil) veil.classList.remove("show");
    if (dr) dr.classList.remove("show");
    /* 收起动画播完再真正隐藏 —— 否则淡出会被 display:none 掐掉
       （挂起浮层 / 归档抽屉两处都是这么处理的）。 */
    setTimeout(function(){
      if (drawerOpen) return;
      if (veil) veil.hidden = true;
      if (dr) dr.hidden = true;
    }, 280);
    render();
  }

  /* 抽屉里所有控件的绑定（这些元素是静态的，只绑一次） */
  (function wireDrawer(){
    var dr = document.getElementById("drawer");
    if (!dr) return;
    var ti = document.getElementById("dTitle");
    var ni = document.getElementById("dNote");
    var di = document.getElementById("dDate");
    var hit = document.getElementById("dDateHit");

    if (ti) ti.addEventListener("input", function(){ dAutosize(ti, 72); dTouch(); });
    if (ni) ni.addEventListener("input", function(){ dAutosize(ni, 196); dTouch(); });
    if (di) di.addEventListener("change", dTouch);
    /* 左键点击（pointerdown）触发，不是 click：showPicker() 需要用户激活，
       异步里调会被拒。和就地编辑那个日期命中层同一处理。 */
    if (hit) hit.addEventListener("click", function(){
      try { di.focus(); } catch(e) {}
      try { if (typeof di.showPicker === "function") di.showPicker(); } catch(e) {}
    });

    /* Enter 在标题/备注里都是换行（备注要能分段），保存走 Ctrl/Cmd+Enter；
       Esc 先 stopPropagation —— 不拦的话 document 那条会接着把下面几层也关掉。 */
    [ti, ni].forEach(function(el){
      if (!el) return;
      el.addEventListener("keydown", function(e){
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDrawer(); return; }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          var pr = dFlush();
          pr.then(function(){ closeDrawer(); }, function(){ closeDrawer(); });
        }
      });
    });

    var c1 = document.getElementById("dClose");
    var c2 = document.getElementById("dClose2");
    var veil = document.getElementById("dVeil");
    if (c1) c1.addEventListener("click", closeDrawer);
    if (c2) c2.addEventListener("click", closeDrawer);
    if (veil) veil.addEventListener("click", closeDrawer);

    /* 删除 + 撤销：抽屉里的删除和卡片上那个 × 是两条路径，撤销语义也共用一套
       （只保留最近一次、不做栈 —— 撤销按钮只有一颗，栈会让「撤销的是哪一条」变得不确定）。 */
    var ddel = document.getElementById("dDel");
    if (ddel) ddel.addEventListener("click", function(){
      var t = dTask();
      if (!t) return;
      var at = st.tasks.indexOf(t);
      if (at < 0) return;
      var gone = t;
      st.tasks.splice(at, 1);
      /* ★ 先撤掉待写的自动保存：任务已经从 st.tasks 里拿走了，
         dApply 找不到它会返回 false，但 dDirty 留着就会白写一次盘。 */
      dDirty = false;
      clearTimeout(dTimer);
      dTimer = null;
      closeDrawer();
      save().then(function(){
        render();
        toast("已删除「" + String(gone.title || "").slice(0, 12) + "」", "撤销", function(){
          st.tasks.splice(Math.min(at, st.tasks.length), 0, gone);
          save().then(function(){ render(); toast("已恢复"); });
        });
      });
    });
  })();

  /* ---------- 轻提示 ---------- */
  var toastTimer = null;
  /* 轻提示。带 action 时右边多一个按钮（目前只用于「删除撤销」）。
     时长：普通 1.8s；带撤销 5s —— 短了人反应不过来，长了挡视线。 */
  function toast(msg, action, onAction, ms){
    var el = document.getElementById("toast");
    el.textContent = "";
    el.appendChild(document.createTextNode(msg));
    if (action && onAction) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "undo";
      b.textContent = action;
      b.addEventListener("click", function(){
        el.classList.remove("show");
        try { onAction(); } catch (e) {}
      });
      el.appendChild(b);
    }
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ el.classList.remove("show"); },
                            ms || (action ? 5000 : 1800));
  }

  /* ---------- 分段控件的滑块 ---------- */
  function moveSegThumb(){
    var on = document.querySelector("#seg button.on");
    var th = document.getElementById("segThumb");
    if (!on || !th) return;
    th.style.width = on.offsetWidth + "px";
    th.style.transform = "translateX(" + (on.offsetLeft - 2) + "px)";
  }

  /* ---------- 事件绑定 ---------- */
  document.getElementById("seg").addEventListener("click", function(e){
    var b = e.target.closest("button[data-view]");
    if (!b) return;
    st.view = b.dataset.view;
    var all = this.querySelectorAll("button");
    for (var i=0;i<all.length;i++) all[i].classList.toggle("on", all[i] === b);
    moveSegThumb();
    save().then(render);
  });

  // 窄条：点一下开合浮层
  document.getElementById("holdRail").addEventListener("click", function(){
    toggleFly();
  });

  // 点别处关掉浮层（浮层内部和窄条自己除外）
  document.addEventListener("click", function(e){
    if (!flyOpen) return;
    if (e.target.closest("#holdFly") || e.target.closest("#holdRail")) return;
    setFly(false);
  });

  // 派给我的：点别处收起（同上，浮层内部与入口按钮除外）
  document.addEventListener("click", function(e){
    if (!inboxOpen) return;
    if (e.target.closest("#inboxFly") || e.target.closest("#inboxBtn")) return;
    setInbox(false);
  });

  /* ★ v0.39.0：发件箱的「点空白收起」。★ 漏掉这一段的症状很别扭 ——
     浮层点不掉，而用户已经没有别的办法关它（只能点那个 ×），
     于是整个弹窗看起来像卡住了。 */
  document.addEventListener("pointerdown", function(e){
    if (!outOpen) return;
    if (e.target.closest("#outFly") || e.target.closest("#outBtn")) return;
    setOutbox(false);
  });

  /* 捕获行：回车即建。
     ★ v0.9.1 起先过一遍自然语言解析（设置页可关）：日期 / 项目 / 优先级从文字里摘出来，
       摘干净的那些词就是标题。解析结果实时显示在下面那条 .nlpbar 里 ——
       猜错了当场看得见，这是这条功能敢不敢用的分水岭。 */
  var newTitleEl = document.getElementById("newTitle");
  newTitleEl.addEventListener("input", function(){
    renderNlpBar();                                  // 正则的结果是同步的，立刻出
    /* ★ 模型的结果要等网络，所以**停顿一下再问**（见 aiPreTick 那节）。
       每次 input 都问的话，打十个字就是十次请求 —— 而用户一个字都没多得到。 */
    if (aiPreTimer) clearTimeout(aiPreTimer);
    aiPreTimer = setTimeout(aiPreTick, AI_PRE_MS);
  });
  newTitleEl.addEventListener("keydown", function(e){
    if (e.key !== "Enter") return;
    var raw = this.value.trim();
    if (!raw) return;
    var proj = document.getElementById("newProject").dataset.v || projects[0].name;
    var due = todayStr();
    var pri = "";
    var title = raw;
    var nl = null;
    var pre = aiPreShot ? aiPreShot[raw] : null;
    /* ★ 只认**已经有内容**的那份结果：占位对象（请求还在飞）没有内容，
       把它当结果用会得到一个空的合并。 */
    var preDone = (pre && (pre.dateWord || pre.project || pre.priority || pre.note)) ? pre : null;
    if (prefs.nlp) {
      var r = nlParse(raw, projectNames());
      /* ★ 停顿那会儿已经问过模型：把它的判断并进解析结果。
         —— 预览上写着什么，回车后就落什么；这是「预览」这个承诺的全部意义。 */
      if (preDone) mergeAi(r, preDone);
      title = r.title || raw;
      if (r.date) due = r.date;
      /* 解析出来的项目**优先于**捕获行当前选的那个：用户把它写在句子里，
         就是对这一条任务的明确指定，比「上次用的项目」更算数。 */
      if (r.project) proj = r.project;
      pri = r.priority;
      nl = r;
    }
    /* ★ 请求还在飞（有占位、但还没内容）就回车了 → **把它取消掉，统一交给下面那条
       aiFallback 处理**。理由是两套东西同时想「补这条任务」会出两个后果：
       用户收到两条 toast，而第二条的撤销会把第一条刚做的修改一起抹掉。
       代价是白花一次请求 —— 用户输入快于 900ms 时才会有。 */
    if (!preDone) {
      if (aiPreTimer) { clearTimeout(aiPreTimer); aiPreTimer = null; }
      if (aiPreShot && Object.prototype.hasOwnProperty.call(aiPreShot, raw)) delete aiPreShot[raw];
    }
    var newId = uid();
    /* ★ v0.16.0：正则没认出日期或项目时，异步问一次 AI。
       注意是**建完任务之后**才问 —— 顺序反过来的话，每次回车都要等模型，
       而模型可能永远不回来（超时上限 10 秒）。回车必须立刻有结果。
       ★ v0.24.0 尾：备注也纳入「缺什么补什么」——那是这一版新增的能力，
       正则只认显式的「备注：」，剩下的话得靠模型读。
       ★ 但要先过一道「值不值得问」：短句没有可拆的东西（「买咖啡豆」），
       问了只是白花一次调用，还会让界面上多一次「补上了」的打扰。 */
    var worthAI = worthAsk(raw);
    if (nl && worthAI && !preDone && (!nl.date || !nl.project || !nl.note)) {
      aiFallback(newId, raw, { title: title, date: due === todayStr() ? "" : due,
                               project: nl.project || "", priority: pri,
                               note: nl.note || "" });
    }
    st.tasks.unshift({
      id: newId, title: title, status: "todo",
      project: proj, date: due,
      note: nl && nl.note ? nl.note : "", url: "",
      createdAt: Date.now(), doneAt: null,
      priority: pri, order: null
    });
    Store.set(proj, "lastProject");   // 记住上次用的项目，右键捕获会继承
    this.value = "";
    renderNlpBar();
    save().then(render);
  });

  /* 删除 + 撤销。
     卡片右上角那个 × 是一点就没、且不可恢复的唯一入口 —— 所以必须给后悔药。
     只保留**最近一次**可撤销（不做栈）：撤销按钮只有一颗，栈会让「撤销的是哪一条」变得不确定。 */
  document.addEventListener("click", function(e){
    var del = e.target.closest(".del");
    if (!del) return;
    var card = del.closest(".card");
    if (!card) return;
    var id = card.dataset.id;
    var idx = -1;
    for (var i=0;i<st.tasks.length;i++) if (st.tasks[i].id === id) idx = i;
    if (idx < 0) return;
    var gone = st.tasks[idx];
    st.tasks.splice(idx, 1);
    var at = idx;
    save().then(function(){
      render();
      toast("已删除「" + String(gone.title || "").slice(0, 12) + "」", "撤销", function(){
        st.tasks.splice(Math.min(at, st.tasks.length), 0, gone);
        save().then(function(){ render(); toast("已恢复"); });
      });
    });
  });

  /* 「归档已完成」——★ 不是「清空」。
     老大明确说过「我不需要有清空数据的这个选项」。这里打的是本地归档标记：
     数据一条不删地留在 storage 里（导出 JSON 能看到），只是不再占着已完成列。
     底栏那个「恢复归档 N」只在真有归档时才出现，平时不占位置。
     ★★★ v0.43.0：**两处条件必须与底栏 `doneLive` 同口径**（都排除交出去的活）。
       原因不是"整齐"，是**不改就会当场露馅**：
       按钮的**可见性**由 `doneLive` 决定（它已排除派出去的），
       而按钮**实际归档**的条数由这里的 `n` 决定。不同口径就出现
       「看得见 2 条已完成，点一下说已归档 3 条」——
       多出来的那条用户**根本看不见**，却被动了。看得见的和动得了的对不上，
       是最伤信任的一类（底栏那条注释里写过同一句话）。
       ⇒ 改一处必须改另一处，这类"平行判据"要靠门钉住，不能靠记性。 */
  document.getElementById("clearDone").addEventListener("click", function(){
    /* ★ v0.43.0：**一次 `myTasks()` 取到候选集，计数与动作共用同一个数组** ——
       原来是两处各写一遍同样的条件（`n` 一处、`touched` 一处）。它们今天一致，
       但那是"恰好一致"：改一处忘另一处就会出现「说归档 3 条、实际归档 2 条」。
       共用数组之后，**物理上不可能不一致**。 */
    var touched = myTasks().filter(function(t){ return t.status === "done"; });
    if (!touched.length) return;
    var n = touched.length;
    touched.forEach(function(t){ t.archived = true; });
    save().then(function(){
      render();
      toast("已归档 " + n + " 条（数据还在，可恢复）", "撤销", function(){
        touched.forEach(function(t){ t.archived = false; });
        save().then(function(){ render(); toast("已恢复 " + touched.length + " 条"); });
      });
    });
  });

  /* ---------- 归档抽屉 ----------
     归档是一份**只读的历史清单**：能查看有哪些、能逐条取回，而不是「归档 ↔ 恢复归档」
     两个按钮来回切。用户原话：「点击归档后又恢复归档，这样来回操作会把我已有的信息打乱掉」。
     ★ 原来的「恢复全部归档」已经删除，并且不要再加回来：
       全量恢复就是那个把看板一次翻乱的动作；逐条取回才让人能挑着要。 */
  var archOpen = false;

  function setArch(on){
    on = !!on;
    if (on === archOpen) return;
    archOpen = on;
    var el = document.getElementById("archFly");
    if (!el) return;
    if (on) {
      setFly(false);              // 互斥：两个抽屉盖在同一片区域
      renderArch();
      el.hidden = false;
      nextFrame(function(){ el.classList.add("show"); });
    } else {
      el.classList.remove("show");
      // 等收起动画播完再真正隐藏，否则淡出会被 display:none 掐掉（和 holdFly 同一处理）
      setTimeout(function(){ if (!archOpen) el.hidden = true; }, 200);
    }
  }

  function renderArch(){
    var body = document.getElementById("archFlyBody");
    if (!body) return;
    var list = st.tasks.filter(isArchived);
    document.getElementById("archFlyN").textContent = list.length ? String(list.length) : "";
    body.innerHTML = "";
    if (!list.length) {
      var em = document.createElement("div");
      em.className = "archfly-empty";
      em.textContent = "还没有归档的任务";
      body.appendChild(em);
      return;
    }
    /* ★ 一律 createElement + textContent 建节点，不拼 HTML 串 ——
       标题是用户输入，拼串就是注入（设置页的高亮那次已经栽过一回）。 */
    list.forEach(function(t){
      var row = document.createElement("div");
      row.className = "archfly-row";
      row.appendChild(cardEl(t, true));      // inFly=true：不挂快速改期按钮，清单里不需要
      var b = document.createElement("button");
      b.type = "button";
      b.className = "back";
      b.textContent = "恢复";
      b.title = "把它放回原来的列";
      b.addEventListener("click", function(){ unreserve(t.id); });
      row.appendChild(b);
      body.appendChild(row);
    });
  }

  /* 逐条取回：只动这一条的 archived 标记，其余原样 —— 这正是「不把信息打乱」的关键。
     撤销按钮留着：一条也可能点错，有退路比弹确认框省事。 */
  function unreserve(id){
    var t = null;
    for (var i = 0; i < st.tasks.length; i++) if (st.tasks[i].id === id) t = st.tasks[i];
    if (!t) return;
    t.archived = false;
    save().then(function(){
      render();
      toast("已取回「" + String(t.title || "").slice(0, 12) + "」", "撤销", function(){
        t.archived = true;
        save().then(render);
      });
    });
  }

  document.getElementById("archBtn").addEventListener("click", function(){ setArch(true); });
  document.getElementById("archClose").addEventListener("click", function(){ setArch(false); });

  /* ---------- 搜索（C1）----------
     用一个「模式」实现：进搜索就把捕获行换成搜索行，退出就换回来。
     不新增常驻控件、不用弹层 —— 弹窗只有 560×580，多一个常驻输入框就是少一行卡片。 */
  function openSearch(){
    document.getElementById("composerRow").hidden = true;
    /* 预览条跟着捕获行一起收：它是对捕获行里那段文字的注解，
       捕获行都不在了，注解留着就是一条悬空的横线。 */
    var _nb = document.getElementById("nlpBar");
    if (_nb) _nb.hidden = true;
    document.getElementById("searchRow").hidden = false;
    var i = document.getElementById("searchInput");
    try { i.focus(); i.select(); } catch (e) {}
  }
  function closeSearch(){
    var i = document.getElementById("searchInput");
    i.value = "";
    searching = "";
    document.getElementById("searchRow").hidden = true;
    document.getElementById("composerRow").hidden = false;
    renderNlpBar();
    render();
    try { document.getElementById("newTitle").focus(); } catch (e) {}
  }
  document.getElementById("btnSearch").addEventListener("click", openSearch);
  document.getElementById("searchInput").addEventListener("input", function(){
    searching = this.value.trim().toLowerCase();
    render();     // 不做防抖：几十条数据的重绘是瞬时的，即时反馈比省几毫秒重要
  });
  document.getElementById("searchInput").addEventListener("keydown", function(e){
    if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
  });

  /* ---------- 快速改期（B3）----------
     点卡片右下角日历（或「按项目/挂起」视图里那行日期）→ 四个选项，一次点击生效。
     浮层挂 body 下 + fixed：.col / .holdfly 有 backdrop-filter，会成为 fixed 后代的包含块，
     留在列里定位会以列为原点算，浮层会飞出去（和拖拽浮卡是同一个坑）。 */
  function closeQuickDate(){
    if (qpop && qpop.parentNode) qpop.parentNode.removeChild(qpop);
    qpop = null;
  }
  function openQuickDate(anchor, id){
    closeQuickDate();
    var t = null;
    for (var i=0;i<st.tasks.length;i++) if (st.tasks[i].id === id) t = st.tasks[i];
    if (!t) return;

    var box = document.createElement("div");
    box.className = "qpop";
    box.dataset.for = id;
    [["今天", dateOffset(0)], ["明天", dateOffset(1)], ["下周", dateOffset(7)], ["清除日期", ""]]
      .forEach(function(o){
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = o[0];
        if ((t.date || "") === (o[1] || "")) b.classList.add("on");
        b.addEventListener("click", function(){
          t.date = o[1];
          closeQuickDate();
          save().then(function(){ render(); });
        });
        box.appendChild(b);
      });
    document.body.appendChild(box);

    // 贴着触发点放，但不许越出弹窗（越出去就点不到了）
    var r = anchor.getBoundingClientRect();
    // ★ 用 offset* 而不是 getBoundingClientRect()：后者会被 transform 缩放
    //   （.selpop 就是这么被少算了 14%），.qpop 眼下没有入场动画、量出来一样，
    //   但同一条规则不该有两套写法 —— 哪天给它加入场动画，这行就是下一个静默失效。
    var bw = box.offsetWidth, bh = box.offsetHeight;
    var W = document.documentElement.clientWidth || 560;
    var H = document.documentElement.clientHeight || 580;
    var left = Math.min(Math.max(4, r.left - 8), Math.max(4, W - bw - 4));
    var top = r.bottom + 5;
    if (top + bh > H - 4) top = Math.max(4, r.top - bh - 5);
    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(top) + "px";
    qpop = box;
  }

  document.addEventListener("click", function(e){
    var trig = e.target.closest ? e.target.closest(".qdate, .datelink") : null;
    if (trig) {
      var card = trig.closest(".card");
      if (!card) return;
      // 再点同一个触发点 = 收起（浮层上的按钮自己处理，不会走到这里）
      if (qpop && qpop.dataset.for === card.dataset.id) { closeQuickDate(); return; }
      openQuickDate(trig, card.dataset.id);
      return;
    }
    if (qpop && !qpop.contains(e.target)) closeQuickDate();
  }, true);

  document.addEventListener("keydown", function(e){
    var tag = ((e.target && e.target.tagName) || "").toLowerCase();
    var typing = tag === "input" || tag === "textarea" || tag === "select";
    if (e.key === "Escape") {
      /* ★ 抽屉排最前 —— 后进先出。抽屉是从底部盖上来的最后一层，
         它开着的时候按 Esc 必须收它，不能跳过去把底下的归档抽屉关了。 */
      if (drawerOpen) { closeDrawer(); return; }
      if (archOpen) { setArch(false); return; }
      if (selOpen) { closeSelPop(); return; }
      if (qpop) { closeQuickDate(); return; }
      if (typing && e.target === document.getElementById("searchInput")) return;  // 它自己处理
      return;
    }
    if (typing) return;

    /* ---------- 面板内键盘流（v0.9.0）----------
       竞品调研里「键盘流」是「每天别扭」档，也是高频用户的爽感来源（Linear / Things 3）。
       两条规矩：
         1. 只在**没在输入**的时候生效 —— 上面那行 `if (typing) return;` 已经拦掉了；
         2. 只认**单键**，不带修饰符 —— Ctrl/Cmd 组合留给浏览器自己（不然会抢掉
            Ctrl+W 这种系统级快捷键，那是不可原谅的）。 */
    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      try { document.getElementById("newTitle").focus(); } catch (err) {}
      return;
    }
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); kbMove(1);  return; }
    if (e.key === "ArrowUp"   || e.key === "k") { e.preventDefault(); kbMove(-1); return; }

    var kc = kbCard();
    if (kc) {
      var kid = kc.dataset.id;
      if (e.key === "Enter") { e.preventDefault(); startEdit(kid); return; }
      /* e = 打开编辑抽屉。和 Enter（就地编辑）是并存的两条路：
         顺手改个标题用 Enter，认真改一条用 e。 */
      if (e.key === "e" || e.key === "E") { e.preventDefault(); openDrawer(kid); return; }
      /* d = 快速改期。复用卡片上那个日历触发点作为浮层锚点 ——
         锚点位置决定浮层朝上还是朝下弹，自己另算一套迟早和鼠标路径不一致。 */
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        var dl = kc.querySelector(".qdate, .datelink");
        if (dl) openQuickDate(dl, kid);
        return;
      }
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        e.preventDefault();
        setStatusByKey(kid, { "1": "todo", "2": "doing", "3": "done" }[e.key]);
        return;
      }
    }

    if (e.key === "/") { e.preventDefault(); openSearch(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) { e.preventDefault(); openSearch(); }
  });

  /* ---------- 面板内键盘流：光标与状态切换（v0.9.0）----------
     光标只用 **id** 记，绝不存节点 —— render() 每次都整列重建，存节点等于存一堆废引用
     （这个坑在 dragState 那套里已经踩过一次）。 */
  var kbId = null;
  function kbList(){
    /* 只有看板上的卡能走。归档抽屉是**只读清单**（不能拖、不能就地编辑），
       所以不进光标序列 —— 让键盘能走到一个「按 Enter 没反应」的地方，
       用户只会觉得键盘流是坏的。 */
    return Array.prototype.slice.call(
      document.querySelectorAll(".col .card, .holdfly .card"));
  }
  function kbPaint(){
    var list = kbList();
    for (var i = 0; i < list.length; i++)
      list[i].classList.toggle("kb-on", list[i].dataset.id === kbId);
  }
  function kbMove(step){
    var list = kbList();
    if (!list.length) return;
    var cur = -1;
    for (var i = 0; i < list.length; i++) if (list[i].dataset.id === kbId) cur = i;
    /* 还没有光标时：往下从第一条起，往上从最后一条起 ——
       按 ↑ 却跳到第一个是很不体面的。 */
    var next = cur < 0 ? (step > 0 ? 0 : list.length - 1) : cur + step;
    if (next < 0) next = 0;
    if (next > list.length - 1) next = list.length - 1;
    kbId = list[next].dataset.id;
    kbPaint();
    try { list[next].scrollIntoView({ block: "nearest" }); } catch (err) {}
  }
  function kbCard(){
    var list = kbList();
    for (var i = 0; i < list.length; i++)
      if (list[i].dataset.id === kbId) return list[i];
    return null;
  }
  /* ★ 键盘改状态必须和拖拽**走同一套语义**：doneAt 的写法、进「已完成」时开播报窗口、
     挂起时那句 toast。两条路径各写一份，迟早长出「拖过去有动画、按键盘没有」这种
     莫名其妙的不一致 —— 而那种不一致最难查，因为两边单看都对。 */
  function setStatusByKey(id, status){
    var t = null;
    for (var i = 0; i < st.tasks.length; i++) if (st.tasks[i].id === id) t = st.tasks[i];
    if (!t || t.status === status) return;
    t.status = status;
    t.doneAt = status === "done" ? Date.now() : null;
    if (status === "done") celebrating = { id: t.id, until: Date.now() + CELEBRATE_MS };
    save().then(function(){
      render();
      if (status === HOLD) toast("已挂起，先不想它");
    });
  }

  // 打开数据管理页（导出/导入必须在新标签页里做，弹窗里选文件会让弹窗失焦关闭）
  document.getElementById("btnData").addEventListener("click", function(){
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
      // 只有在弹窗里才关自己；如果本页本身就是个标签页，别把用户的标签页关掉。
      // 浮窗（as-pip）里同样不关：window.close() 对「不是脚本自己打开的窗口」是无效操作，
      // 各 Chromium 分支行为不一致，索性一次都不碰。
      if (!root.classList.contains("as-tab") && !IS_PIP) window.close();
    }
  });

  /* ★ 这里原来是首次引导条的关闭按钮绑定（hintbar / OKEY）。
     引导条已按用户要求整块删除，绑定也一并清掉 —— 留着会是个对空元素的 addEventListener。 */

  /* ---------- 「浮到桌面」那条旧路：v0.10.0 加的，v0.14.0 拆掉 ----------
     这里原来有 FLOATKEY / floatHostAlive / makeFloatHost，以及 #btnFloat 的绑定：
     点它 -> chrome.windows.create 开一个宿主小窗 -> 宿主再开画中画浮窗。

     ★★ 为什么拆：这条路的**入口按钮**待在弹窗里，等于「点图标（第一次）+
        点按钮（第二次）」两步才见到东西 —— 老大的原话是「他要连点两次才会
        弹出这个悬浮球，这个交互感太差了，而且太 low 了」。而球已经搬到网页上、
        打开网页它就在（零点击），这条路彻底没有存在理由了。
     ★ popup.html 里那条 `html.as-pip #btnFloat{display:none}` 一起删了 ——
        留着就是给一个不存在的元素写规则。
     ★ host.html / host.js 先留着（没人调用就是死代码）。删文件要牵动
        打包清单与三道断言，等确认没人惦记再动。 */

  window.addEventListener("resize", moveSegThumb);

  function save(){ return Store.set(st); }

  /* ---------- 自绘下拉（苹果风玻璃）----------
     为什么不用原生 <select>：它的下拉列表由**操作系统绘制**，CSS 完全碰不到，
     所谓「下拉效果简陋」不是样式没写好，是根本改不了。
     ★ 浮层必须挂 body + fixed：触发按钮带 .glass（backdrop-filter），
       而 backdrop-filter 不为 none 的元素会成为 fixed 后代的「包含块」——
       浮层留在按钮里的话，坐标会以按钮为原点算，一展开就飞出去。
       （和拖动浮卡、快速改期浮层同一个坑，那两处注释里也写了。） */
  var selOpen = null;

  function closeSelPop(){
    if (!selOpen) return;
    var s = selOpen;
    selOpen = null;
    s.pop.classList.remove("show");
    s.anchor.classList.remove("selon");
    s.anchor.setAttribute("aria-expanded", "false");
    var p = s.pop;
    // 等收起动画播完再摘节点，不然淡出会被 removeChild 直接掐掉
    setTimeout(function(){ if (p.parentNode) p.parentNode.removeChild(p); }, 150);
  }

  /* ★ v0.18.0：三处触发点共用同一条「再点一次 = 收起」规则。
     原来每个 click 回调都**直接**调 openSelPop（那个函数第一步就是 closeSelPop，
     所以它永远「只开不关」），而下面那条 pointerdown 又特意把 anchor 排除在外 ——
     不排除的话 pointerdown 会先关掉、click 再打开，看着像闪一下。
     两边一凑，用户看到的正是「点第一次展开、点第二次收不回去」。
     ★ 规则收成一处，不在三处各写一遍 if：三处 = 三个将来会走散的地方。 */
  function toggleSelPop(anchor, items, cur, onPick){
    if (selOpen && selOpen.anchor === anchor) { closeSelPop(); return; }
    openSelPop(anchor, items, cur, onPick);
  }

  function openSelPop(anchor, items, cur, onPick){
    closeSelPop();
    var pop = document.createElement("div");
    pop.className = "selpop";
    pop.setAttribute("role", "listbox");

    items.forEach(function(v){
      var b = document.createElement("button");
      b.type = "button";
      b.className = "selopt" + (v === cur ? " on" : "");
      b.dataset.v = v;
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", v === cur ? "true" : "false");
      var sp = document.createElement("span");
      sp.textContent = v;
      b.appendChild(sp);
      /* ★ mousedown 必须拦掉：不拦的话按钮抢走焦点 → 编辑卡里的输入框失焦 →
         blur 那条兜底（120ms 后看焦点还在不在卡片内）就会提交，想选个项目面板先关了。
         和 .pseg 三档按钮是同一个坑。 */
      b.addEventListener("mousedown", function(e){ e.preventDefault(); });
      b.addEventListener("click", function(){
        closeSelPop();
        onPick(v);
      });
      pop.appendChild(b);
    });

    document.body.appendChild(pop);

    /* 定位：先量高度，再决定朝下弹还是朝上弹（弹窗只有 580 高，靠底的锚点必须翻上去）。
       横向钳在视口内 8px，右沿对齐锚点 —— 下拉贴着它的触发按钮长。 */
    var r = anchor.getBoundingClientRect();
    var W = document.documentElement.clientWidth || 560;
    var H = document.documentElement.clientHeight || 580;
    /* ★★★ 面板自己的宽高只能用 offset*，**不能用 getBoundingClientRect()**。
       原因：.selpop 一创建就带着入场动画的 transform:scaleY(.86)，
       rect 量到的是「动画还没开始」的尺寸 —— 上限 320px 会被量成 275px（少 45px / 14%）。
       后果是两道保险一起判错：锚点上方明明只塞得下 275，代码却按「275 放得下」判定，
       于是朝上弹，面板把自己的触发按钮整个盖住（真机量到：vh=484、锚点 top=295、
       rect 275 / offsetHeight 320 → 翻上去落在 top=14，压住按钮）。
       offsetWidth/offsetHeight 是布局尺寸，与 transform 无关。 */
    var bw = pop.offsetWidth, bh = pop.offsetHeight;
    var left = Math.min(Math.max(8, r.right - bw), Math.max(8, W - bw - 8));
    var top = r.bottom + 6, up = false;
    if (top + bh > H - 8 && r.top - bh - 6 >= 8) {
      top = r.top - bh - 6;
      up = true;
    }
    /* ★★ 定位完再**显式夹一次**，两个方向都夹（横向原来就夹了，纵向是补的）。
       夹取的意义：只要有一点点没夹住，用户看到的就是「下拉弹出来但一半在窗外」，
       而且**没有任何报错** —— 静默失效比报错难查得多。
       夹取会让面板不再严格贴边，所以只在真的越界时才生效（正常情况是个恒等操作）。 */
    left = Math.min(Math.max(8, left), Math.max(8, W - bw - 8));
    top = Math.min(Math.max(8, top), Math.max(8, H - bh - 8));
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
    // 朝上弹时 origin 要翻到下面，否则「从下往上拉开」会变成「从下往下跌」
    if (up) pop.style.transformOrigin = "bottom center";

    selOpen = { anchor: anchor, pop: pop };
    anchor.classList.add("selon");
    anchor.setAttribute("aria-expanded", "true");
    nextFrame(function(){ pop.classList.add("show"); });
  }

  /* 按钮的「值」存在 dataset.v 上，显示的是 .seltxt 里的文字 —— 两处一起更新。 */
  function setSelValue(btn, v){
    btn.dataset.v = v || "";
    var tx = btn.querySelector(".seltxt");
    if (tx) tx.textContent = v || "未分类";
  }

  var newProjBtn = document.getElementById("newProject");
  newProjBtn.addEventListener("click", function(){
    var cur = newProjBtn.dataset.v;
    toggleSelPop(newProjBtn,
      projects.map(function(p){ return p.name; }),
      cur,
      function(v){
        setSelValue(newProjBtn, v);
        Store.set(v, "lastProject");
      });
  });
  // 点浮层或触发按钮以外的地方 → 收起
  document.addEventListener("pointerdown", function(e){
    if (!selOpen) return;
    if (selOpen.pop.contains(e.target)) return;
    if (selOpen.anchor === e.target || selOpen.anchor.contains(e.target)) return;
    closeSelPop();
  }, true);

  /* 名字沿用 buildSelect，但它现在只是「把当前项目刷到自绘按钮上」——
     选项列表改为每次点开时现取（projects 变了自然就是新的，不用再手工重建）。 */
  function buildSelect(wantName){
    var want = wantName;
    if (!want || !projects.some(function(p){ return p.name === want; })) {
      want = projects.length ? projects[0].name : "";
    }
    setSelValue(document.getElementById("newProject"), want);
  }

  function syncSeg(){
    var btns = document.querySelectorAll("#seg button");
    for (var i=0;i<btns.length;i++) btns[i].classList.toggle("on", btns[i].dataset.view === st.view);
    moveSegThumb();
  }

  /* ---------- 飞书同步状态 ----------
     弹窗自己不同步，只显示状态 + 叫醒后台。
     同步必须只在 background 一个地方跑：两个上下文同时写同一张表，
     会撞上飞书「同表不支持并发写」（1254291）。 */
  var SKEY = (typeof Sync !== "undefined") ? Sync.STAT : "taskboard.syncstatus";

  function renderSyncInd(s){
    var ind = document.getElementById("syncInd");
    var txt = document.getElementById("syncTxt");
    if (!ind || !txt) return;
    if (!s || (!s.at && (!s.state || s.state === "idle"))) { ind.hidden = true; return; }
    ind.hidden = false;
    ind.classList.remove("s-ok", "s-run", "s-err");
    if (s.state === "running") {
      ind.classList.add("s-run"); txt.textContent = "同步中"; ind.title = "";
      return;
    }
    if (s.state === "error") {
      ind.classList.add("s-err"); txt.textContent = "同步失败";
      ind.title = s.message || "打开设置看详情";
      return;
    }
    var n = (s.stats && s.stats.conflicts) || 0;
    var k = (s.stats && s.stats.skippedDeletes) || 0;
    ind.classList.add("s-ok");
    txt.textContent = n ? ("已同步，" + n + " 处冲突") : (k ? "已同步，有待确认删除" : "已同步");
    ind.title = "点这里打开设置，可立即同步或改配置";
  }

  function wakeSync(){
    if (typeof Sync === "undefined") return;
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
    Sync.readCfg().then(function(cfg){
      if (!Sync.ready(cfg)) return;
      try { chrome.runtime.sendMessage({ type: "sync-wake" }); } catch (e) {}
    });
  }

  var syncIndEl = document.getElementById("syncInd");
  if (syncIndEl) {
    syncIndEl.addEventListener("click", function(){
      if (typeof chrome === "undefined" || !chrome.runtime) return;
      // manage.html 就是 options 页，走官方入口最稳；没有就退回开标签页
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url: chrome.runtime.getURL("manage.html") });
      // 同 btnData：标签页 / 浮窗里都不能关自己（原来这里是无条件关的，在浮窗里会误伤）
      if (!root.classList.contains("as-tab") && !IS_PIP) window.close();
    });
  }

  /* ---------- 启动 ---------- */
  function boot(){
    Promise.all([Store.get(PKEY), Store.get("lastProject"), Store.get(), Store.get(SKEY), Store.get(PREFKEY)])
      .then(function(r){
        var list = r[0], last = r[1], data = r[2], syncStat = r[3];
        prefs = readPrefs(r[4]);
        renderNlpBar();

        if (Array.isArray(list) && list.length) projects = list;
        buildSelect(last);

        /* ★★★ v0.40.0：`view` 与「有没有本地任务」**解耦**。
           改之前这里是 `if (data && data.tasks && data.tasks.length) { st.view = ... }` ——
           即「一条本地任务都没有」时，**视图偏好整个丢掉**、静默回落「今天」。
           在 v0.40.0 之前这么写没毛病：四个视图全是「本地任务的一种切法」，
           没有任务就没有视图可言，回落和记忆是同一件事。
           但「团队任务」这一屏画的是**别人派给我的 / 我派出去的**，
           与本地任务列表无关 —— 于是「我本地一条都没有，但我正站在团队任务上」
           是完全正常的状态（表刚建、刚清空、只想看别人派了什么）。
           症状：在团队任务视图里关掉弹窗再打开 ⇒ 回到「今天」，
           而且**看起来像「没记住」**，没人会想到是 boot 里那个 length 判断。
           ★ 这条是写 ⑧ 段测试时被自己的断言抓出来的（种了 view:"team" + tasks:[]），
             不是猜的 —— 断言先红了，才回头找到这里。 */
        if (data) st.view = data.view || "today";
        if (data && Array.isArray(data.tasks) && data.tasks.length) {
          st.tasks = data.tasks.map(function(t){
            // 补齐早期版本可能缺的字段
            t.note = t.note || "";
            t.url = t.url || "";
            // 认不出的状态一律退回待办，别让任务因为状态字段丢失而消失
            if (ALL_STATUSES.indexOf(t.status) < 0) t.status = "todo";
            /* v0.7.0 新增两个字段，老数据没有 —— 这里补默认值。
               关键是「补默认」而不是「丢掉」：认不出来就当默认档，任务照常显示。 */
            t.priority = normPriority(t.priority);
            if (typeof t.order !== "number" || !isFinite(t.order)) t.order = null;
            // v0.8.0 新增：归档标记。老数据没有 = 没归档（补 false，别丢掉任务）
            t.archived = !!t.archived;
            return t;
          });
        } else {
          st.tasks = [];   // 干净起步，不预置任何示例任务
        }

        syncSeg();
        render();
        renderSyncInd(syncStat);
        wakeSync();   // 隔太久没同步就顺手拉一次

        /* 团队派发：读配置 + 收到的任务，并把两个入口接上。
           ★ 放在 boot 里而不是模块顶层：这几个元素都在 DOM 里是静态的，
             但 setInbox / renderInbox 要用到上面那些已经初始化好的状态。 */
        loadInbox();
        var ibBtn = document.getElementById("inboxBtn");
        if (ibBtn) ibBtn.addEventListener("click", function(){ setInbox(!inboxOpen); });
        var ibX = document.getElementById("inboxClose");
        if (ibX) ibX.addEventListener("click", function(){ setInbox(false); });
        /* ★ v0.39.0：「我派的」入口 —— 与收件箱并列的那扇门。 */
        var obBtn = document.getElementById("outBtn");
        if (obBtn) obBtn.addEventListener("click", function(){ setOutbox(!outOpen); });
        var obX = document.getElementById("outClose");
        if (obX) obX.addEventListener("click", function(){ setOutbox(false); });

        var ti = document.getElementById("newTitle");
        if (ti) { try { ti.focus(); } catch(e){} }
      });
  }

  // 弹窗开着的时候，外部（右键捕获、数据页改项目）写进来的变化要同步过来
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function(changes, area){
      if (area !== "local") return;

      if (changes[PKEY]) {
        var nv = changes[PKEY].newValue;
        if (Array.isArray(nv) && nv.length) {
          projects = nv;
          buildSelect(document.getElementById("newProject").dataset.v);
          render();
        }
      }
      if (changes[KEY]) {
        var nd = changes[KEY].newValue;
        if (!nd || !nd.tasks) return;
        st.tasks = nd.tasks;
        if (nd.view) st.view = nd.view;
        // 正在就地编辑时不打断，等提交后再重绘
        if (!document.querySelector(".card.editing")) { syncSeg(); render(); }
      }
      // 后台同步的状态变化要实时反映到底栏
      if (changes[SKEY]) renderSyncInd(changes[SKEY].newValue);
      /* 后台轮询拉到了新派发任务 → 底栏那个数**当场**变。
         ★ 不加这条的话，正在开着弹窗的人要等下一次开弹窗才看见 ——
           而「派过来一条任务」恰恰是希望他立刻看见的事。 */
      if (typeof Inbox !== "undefined" && changes[Inbox.ITK]) {
        var ni = changes[Inbox.ITK].newValue;
        inboxItems = Array.isArray(ni) ? ni : [];
        renderInbox();
        /* ★ v0.40.0：收件箱那扇门上的数字与**团队计数**是两件事，`renderInbox()`
           只管前者。不补这一下，后台刚拉回来一条派给我的活时，
           正开着的弹窗上「团队任务」那个数**不动** —— 而人正等着它动。 */
        refreshTeamUI();
      }
      /* ★ v0.39.0：后台回读完「我派出去的那些」→ 当场并进本地任务并重绘。
         ★ 不接这条的话，用户正开着弹窗时状态不会变（要等下次开弹窗）——
           而「对方点完成」恰恰是最希望当场看见的事（指标里写的是 ≤1 分钟）。 */
      if (typeof Inbox !== "undefined" && changes[Inbox.OUTK]) {
        var ov = changes[Inbox.OUTK].newValue;
        outRows = (ov && Array.isArray(ov.rows)) ? ov.rows : [];
        if (outRows.length) {
          var om = Inbox.applyOutbox(st.tasks, outRows);
          if (om.changed) save().then(render);
        }
      }
      /* 设置页改了使用偏好要**立刻**生效 —— 「数据」按钮就在顶栏上，
         一边开着弹窗一边改设置是很常见的一条路径。 */
      if (changes[PREFKEY]) { prefs = readPrefs(changes[PREFKEY].newValue); renderNlpBar(); }

      /* ★ v0.36.0：设置页里「团队派发」那个开关一动，项目行上那颗派发按钮
         要**当场**跟着出现/消失。不接这条的话，用户开着弹窗去设置页打开开关、
         回来看板还是「看不到派发选项」—— 又绕回老大报的那个现象。 */
      if (typeof Inbox !== "undefined" && changes[Inbox.CFK]) {
        inboxCfg = Inbox.readCfg(changes[Inbox.CFK].newValue);
        renderInbox();
        if (st.view === "project") render();
        /* ★ v0.40.0：`CFK` 也决定团队屏那句空态说的是「还没打开」还是
           「还没有人派任务给你」（`teamEmptyMineText`）—— 开关一动，
           这两句必须当场换过来；不换的话用户看到的是**上一状态**的解释，
           而那句解释恰好是在教他「去哪儿打开」。 */
        refreshTeamUI();
        /* ★ v0.38.3：名单和「我是谁」是**后台轮询**写进来的，而用户很可能正开着
           抽屉 —— 不补这一下，他得先收起抽屉再打开才看得见下拉活过来，
           然后就会觉得「还是灰的」。 */
        if (drawerOpen) buildDAssign();
      }
    });
  }

  boot();
})();
