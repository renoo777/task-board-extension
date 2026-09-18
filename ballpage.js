/* 任务台 · 网页悬浮球（v0.14.0，纯扩展）
 * ==================================================================
 * 这是「只装浏览器扩展、什么都不用再装」那条路上的那颗球。
 *
 * ★★ 沿革（三版都记着，免得下次又走回去）：
 *    v0.12.0 走「画中画浮窗」，被否 —— 两条**浏览器画的线**：
 *      ① 开浮窗必须在**调用它的那个文档**里有真实点击（MDN 明文要求
 *         transient activation），扩展图标那一下的手势传不进去 → 最少点两次；
 *      ② 请求的宽高会被「按实现夹取或忽略」（MDN 同一页明文）→ 球外面永远
 *         剩一片空白，还自带一条标题为「任务台」的顶栏 = 老大说的
 *         「后面会展现一个任务台一起悬浮」。
 *    v0.13.0 改成注入网页，真圆真透明零点击 —— 方向对了，但**自己又做了三层**：
 *       悬停滑出滑杆 → 点开迷你列表 → 才到输入框；形态机五态；
 *       而且 popup 里那条画中画旧路的「浮到桌面」按钮没删干净 ——
 *       点图标弹窗（第一次）+ 点那个按钮（第二次），老大看到的「点两次」就是它。
 *    v0.14.0（本版）照竞品把骨架砍到最简。依据是官方文档 + 竞品源码两条：
 *      · 官方：`action.onClicked` 在设了 `default_popup` 时**不会触发**
 *        （chrome.action 文档原文："The action.onClicked event won't be sent
 *        if the extension action has specified a popup"）→ 想「点图标直接出球」
 *        在浏览器层面就不可能，所以零点击只能靠 content script，这条路是对的；
 *      · 竞品「轻氧翻译」（开源：github.com/Kobshobe/qy_translate）：
 *        球 30px 贴边、平时 opacity .65、悬停才露一个小圆钮、**点球直接执行主功能**、
 *        拖走吸附到最近的边、全屏时隐藏。**一共一层**。
 *
 * ★★ 本版的规矩（照着竞品立的，别再往上加层）：
 *    ① **点球 = 记一笔**。当场弹输入框，回车存下，没有滑杆、没有列表、没有第二层。
 *    ② 悬停只多一个**小齿轮**（进设置）。它不在主路径上，鼠标不上去就看不见。
 *    ③ 球**贴边待着**：默认贴右边缘、垂直居中；拖走后吸附到**最近的边**。
 *    ④ 平时半透明 .65，鼠标上去才实心 —— 不挡网页正文。
 *    ⑤ 全屏（视频/图片）时自己藏起来。
 *    形态只有两个：`idle`（球）/ `input`（输入框）。
 *
 * 这一版为什么 CSS / DOM 全塞进一个文件：
 *    · 样式必须进 shadow root 才有隔离，而 shadow root 里加载外部样式表要闯
 *      页面 CSP 和 web_accessible_resources 两道关；内联 <style> 一步到位。
 *    · content script 的 JS 本身不受页面 CSP 约束（跑在 isolated world）。
 *    · 一个文件 = 一处真相。
 *
 * 预览（不用装扩展、不用起浮窗）：
 *   ballwan.html?demo=1               塞几条示例数据
 *   ballwan.html?demo=1&form=input    直接以某个形态启动（idle / input）
 *   ballwan.html?demo=1&side=left     启动在左边（看吸附的另一侧）
 * demo 开关只在「不是网页」的地方认（扩展页 chrome-extension: 与本地预览壳 file:），
 * 防止某个网站 URL 恰好带 demo= 就切到假数据。
 * ================================================================== */
(function () {
  "use strict";

  /* ================================================================ 常量 */

  var HOST_ID = "taskboard-web-ball";

  var KEY = "taskboard.v1";
  var PKEY = "taskboard.projects";
  var POSKEY = "taskboard.ballpos";   /* 球的位置，全局一份（所有网站共用） */
  /* ★★ 网页球总开关（v0.22.0）。存 { on: bool } 一个对象而不是裸布尔 ——
     跟 taskboard.prefs 里 nlp 的做法一致：以后要再加「球的大小 / 默认停哪一侧」
     这类偏好时不用换 key，老数据也不会因为多一个字段就读不出来。
     ★ 为什么**不**并进 taskboard.prefs：那个 key 的写是**整块覆盖**
       （设置页 Store.set({nlp:...}, PREFKEY)），并进去的话用户拨一下
       「识别句子」就会把这个开关悄悄抹掉。独立 key 是本仓库对这类问题的既定解法。 */
  var ONKEY = "taskboard.webball";

  /* 吉祥物配置（v0.24.0）。
     ★ 独立 key，不塞进 taskboard.v1 —— 那是「任务数据」，这是「外观偏好」，
       混在一起的话「换个脸」会顺带触发全量重画（onChanged 那条路会把它当数据变）。
     ★ 默认 on:true：老大要的就是「活跃上班氛围」，开关是后悔药不是前提。 */
  var MKEY = "taskboard.mascot";
  var MCHAR_DEF = "fox";
  var MSIZE_DEF = 72;

  var BALL = 32;        /* **普通形态**的球直径，与 CSS 里的兜底值同步 */
  var GAP = 6;          /* 球和输入框之间的距离 */
  var PAD = 8;          /* 离视口边缘至少留这么多 —— 贴死不美观，也像滚动条 */
  var INPUT_W = 240;    /* 输入框宽度 */
  var NEED_W = BALL + GAP + INPUT_W;   /* 输入态的容器总宽（普通形态） */

  /* ★★ 球直径从常量变成**函数**，是这一版最容易漏的一处：
     吉祥物形态下球是 56/72/96，而几何函数（snapX / snap / clamp / place）
     里有 6 处在用 BALL。漏一处就会出现「球变大了但吸附位置还按 32 算」——
     表现是球贴边时半个身子在屏幕外，而且**只在换过形态之后**才发生。 */
  function ballSize() {
    return (state.mc && state.mc.on) ? state.mc.size : BALL;
  }
  function needW() { return ballSize() + GAP + INPUT_W; }

  var QS = (function () {
    try { return new URLSearchParams(location.search); } catch (e) { return null; }
  })();
  /* ★ demo 开关只在「不是网页」的地方认：扩展页（chrome-extension:）与本地预览壳（file:）。
     判据写成「不是 http/https」而不是「列举两个协议」：真正要防的是
     「某个网站 URL 恰好带 demo= 就切到假数据」，而 http/https 上本来就跑的是真数据。 */
  var DEMO = !!(QS && QS.has("demo") &&
                location.protocol !== "http:" && location.protocol !== "https:");
  var HAS_CHROME = (typeof chrome !== "undefined") &&
                   !!(chrome.storage && chrome.storage.local);

  /* ★★ 开关的口径：「–」≠「0」（本项目最贵的一条铁律）。
     键不存在（老版本写的、手清过 storage、刚装）**一律当「开」** ——
     不能因为我们新加了一个开关，就把老用户本来一直有的球当成「他自己关掉了」。
     只有**显式存了 false** 才算关。设置页那边的 readWb 是同一份口径，必须逐字一致：
     两边不一致的症状是「设置页显示开着、网页上却没有球」，最难查的那种。 */
  function readOn(v) { return !(v && v.on === false); }

  /* ================================================================ 样式
     全部塞进 shadow root 的 <style> 里。
     ★ .wrap 上那句 `all: initial` 不是多余的：可继承属性（font / color /
       direction / text-align / letter-spacing…）**会跨 shadow 边界继承**，
       光靠 shadow DOM 挡不住排版诡异的老网站。all:initial 把继承链掐断，
       下面的声明再一条条把我们要的写回来。 */

  var CSS = [
    "*{box-sizing:border-box}",
    ".wrap{",
    "  all:initial;",
    "  position:fixed;left:0;top:0;",
    "  display:flex;align-items:center;gap:6px;",
    /* ★ 球直径走变量：普通形态 32、吉祥物形态 56/72/96。
       兜底值必须写（var(--bs) 没有兜底 + 变量没设 ⇒ 整条 height 声明作废，
       球会塌成 0 高）—— 这条坑本项目栽过，别再犯。 */
    "  --bs:32px;",
    "  height:var(--bs,32px);",
    "  font:400 13px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif;",
    "  color:#16171a;",
    "  -webkit-font-smoothing:antialiased;",
    "  user-select:none;-webkit-user-select:none;",
    "  pointer-events:auto;",
    "  --ink:#16171a;--dim:#6b7078;--line:#e4e7ee;",
    "  --blue:#002FA7;--blue-hi:#1d45bd;--good:#1a7f4b;",
    "}",
    "/* ★ 球在容器里的哪一头，由「吸附在哪一侧」决定，不是靠挪坐标：",
    "   row-reverse 把视觉顺序整个翻过来，球仍然钉在贴着的那条边上。 */",
    ".wrap.side-right{flex-direction:row-reverse}",
    ".wrap.side-left{flex-direction:row}",

    /* ---------- 球 ---------- */
    ".ball{",
    "  flex:none;position:relative;width:var(--bs,32px);height:var(--bs,32px);",
    "  display:flex;align-items:center;justify-content:center;",
    "  padding:0;border:0;border-radius:50%;",
    "  background:radial-gradient(120% 120% at 32% 24%,var(--blue-hi) 0%,var(--blue) 62%,#001f73 100%);",
    "  box-shadow:0 2px 8px rgba(0,31,115,.32),inset 0 1px 0 rgba(255,255,255,.22);",
    "  cursor:grab;touch-action:none;",
    "  /* ★ 平时半透明、鼠标上来才实心：贴边的球不挡正文才敢一直待着 */",
    "  opacity:.65;",
    "  transition:opacity .16s ease,transform .13s ease,box-shadow .13s ease;",
    "}",
    ".wrap:hover .ball{opacity:1}",
    ".ball:hover{transform:scale(1.06)}",
    ".ball:active{cursor:grabbing;transform:scale(.94)}",
    ".ball.drag{cursor:grabbing;opacity:1;transform:scale(1.04);box-shadow:0 6px 18px rgba(0,31,115,.45)}",
    "/* 存下之后球上闪一个白勾（0.9 秒）—— 比弹一行提示轻得多 */",
    ".ball.ok{background:var(--good);opacity:1}",
    ".ball.ok .badge{display:none}",
    ".ball.ok::after{",
    "  content:\"\";position:absolute;width:7px;height:12px;",
    "  margin-top:-3px;border:solid #fff;border-width:0 2px 2px 0;",
    "  transform:rotate(43deg);",
    "}",
    ".ring{position:absolute;width:26px;height:26px;border:1px solid rgba(255,255,255,.26);border-radius:50%;pointer-events:none}",
    ".badge{position:relative;color:#fff;font-size:12px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}",

    /* ---------- ★ v0.24.0 尾：原来这里挂着一个「悬停才露的小齿轮」 ----------
       它是进设置页的唯一入口（点它 = chrome.runtime.openOptionsPage()），
       老大看完真机截图后点名删掉：球旁边不该再多出任何东西。
       → 这一版把它**连根拔掉**，而且必须三处一起走，留一处就是半成品：
           ① 结构：MARKUP 里那个 <button class="gear">  →  删
           ② 样式：原本这一整段（absolute / opacity:0 / hover 才露 / 内侧定位）→ 删
           ③ 行为：$("gear").addEventListener("click", …)          → 删
         · 只删样式、留着结构：按钮看不见但**还在 DOM 里**（能被 Tab 聚焦、
           能被指针点上，而且读屏软件会念出来）；
         · 只删结构、留着样式：那段 CSS 变成死代码，下一个人以为功能还在。
       ★ 进设置页的入口没有消失：扩展图标 → 弹窗里两处都能开设置页；
         桌面球那条线上也有自己的设置行。
       ★ 判据已经改成**否定式**（_validate.py / _pack.py 各一条），钉的就是
         「这三处一个都不许回来」—— 本段注释里虽然点着那个类名，但判据是
         **剥注释之后**再搜的，不会被自己顶包。 */

    /* ---------- 输入框（点了球才出现，就在球内侧） ---------- */
    "#edit{",
    "  flex:1 1 auto;min-width:0;display:none;",
    "  height:32px;padding:0 12px;",
    "  font:inherit;font-size:12.5px;color:var(--ink);",
    "  background:#fff;border:1px solid var(--line);border-radius:16px;",
    "  box-shadow:0 6px 20px rgba(16,20,32,.14);",
    "  outline:none;user-select:text;-webkit-user-select:text;",
    "}",
    ".wrap.form-input #edit{display:block}",
    "#edit::placeholder{color:#aeb3bc}",
    "#edit:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,47,167,.08),0 6px 20px rgba(16,20,32,.14)}",

    /* ---------- 吉祥物形态（v0.24.0）----------
       ★ 形态切换**不动 DOM 结构**：吉祥物那两层 span 一开始就塞在 .ball 里
         （只是 display:none），开着的时候把 .ball 自己「变成」吉祥物的底。
         为什么不换成两个互斥的元素：拖拽 / 点击 / 吸附全都绑在 .ball 上，
         换元素等于把这些逻辑复制一份到新元素上，早晚两边行为不一致。
         改样式是**零风险**的，改结构不是。 */
    ".wrap.mc-on .ball{",
    "  background:none;box-shadow:none;border-radius:0;",
    "  opacity:.8;",
    "}",
    ".wrap.mc-on .ball:hover{transform:none;opacity:1}",           /* 放大跟图叠一起会晃 */
    ".wrap.mc-on .ball:active{transform:none}",
    ".wrap.mc-on .ball.drag{transform:none;box-shadow:none;opacity:1}",
    "/* 原形态的两个装饰（蓝环、数字）必须让位，不然会画在脸上 */",
    ".wrap.mc-on .ring,.wrap.mc-on .badge{display:none}",
    "/* 「存下了」的绿勾也收掉 —— 吉祥物形态改用表情回报（见 flashOk） */",
    ".wrap.mc-on .ball.ok{background:none}",
    ".wrap.mc-on .ball.ok::after{display:none}",

    /* ---------- 气泡：它开口说话的地方（v0.25.0）----------
       ★★★ 三个定位决定，每一个都是为了不跟已有东西打架：

       ① **absolute，不进 flex 流**。wrap 是 shrink-to-fit 的 fixed 盒子，
          而 `place()` 拿 `ballSize()` 算贴边坐标 —— 气泡一旦成为 flex 子项，
          它就把 wrap 撑宽，球的视觉位置跟着往内挪，于是「贴边的球不贴边了」，
          而且只在气泡出现的那几秒里错（最难复现的那种）。
          absolute 脱离布局流 = 对几何零影响。

       ② **挂在球的正上方，不在球的侧边**。侧边已经被输入框占了
          （点球同时会推输入框出来，见 endDrag）—— 气泡也放侧边的话，
          两者会叠在一起，用户看到的是一团字压着一个输入框。

       ③ **左右对齐靠 side-* 那一对选择器**。因为 DOM 顺序是 [球, 输入框]，
          `side-right` 用 row-reverse 把球翻到最右 ⇒ wrap 的**右**边界就是球
          的右边界，所以右对齐写 right:0 就行，不必去算式子。side-left 同理。 */
    ".say{",
    "  position:absolute;bottom:calc(100% + 6px);",
    "  width:max-content;max-width:min(224px,calc(100vw - 32px));",
    "  padding:7px 10px;border-radius:10px;",
    "  background:#16171a;color:#fff;",
    "  font-size:12.5px;line-height:1.45;text-align:left;",
    "  box-shadow:0 6px 22px rgba(16,20,32,.26);",
    "  opacity:0;transform:translateY(4px);pointer-events:none;",
    "  transition:opacity .16s ease,transform .16s ease;",
    "}",
    ".wrap.side-right .say{right:0}",
    ".wrap.side-left .say{left:0}",
    ".wrap.say-on .say{opacity:1;transform:none;pointer-events:auto}",
    /* 动作按钮：**只在有逾期时才有**（见 Notify.actionOf）——
       没有动作就不画按钮，而不是画一个点了没事干的按钮 */
    ".saydo{",
    "  display:block;margin:6px 0 0;padding:4px 9px;",
    "  font:inherit;font-size:12px;font-weight:600;",
    "  color:#16171a;background:#fff;border:0;border-radius:7px;",
    "  cursor:pointer;",
    "}",
    ".saydo:hover{background:#e8eaef}",
    /* ★ 这一条不是冗余：.saydo 上面写了 display:block，而 [hidden] 的默认
       display:none 是**被作者样式盖掉**的 —— 少了它，「没有动作」时按钮
       照样显示（只是没字），气泡上会多出一个空白的白框。 */
    ".saydo[hidden]{display:none}",

    /* ★ 关掉动画偏好：气泡不做位移淡入（只留可点性，不留动效）。
       与 mascot.js 里 reduced 那条同一个意图 —— 转场可以是零成本的，
       但不该是「用户明确说过不要动」的那种。 */
    "@media (prefers-reduced-motion: reduce){",
    "  .say{transform:none;transition:none}",
    "}"
  ].join("\n");

  /* ================================================================ 骨架 */

  var old = document.getElementById(HOST_ID);
  if (old && old.parentNode) old.parentNode.removeChild(old);   /* 扩展重载后重来一次 */

  var host = document.createElement("div");
  host.id = HOST_ID;
  /* ★ 用 inline + !important 定住这几条：:host 规则的优先级低于页面样式，
     老网站里一句 `div{margin:0}` 就能把我们的定位改掉。inline 谁也盖不过。 */
  host.style.cssText =
    "all:initial!important;position:fixed!important;left:0!important;top:0!important;" +
    "width:0!important;height:0!important;margin:0!important;padding:0!important;" +
    "border:0!important;background:none!important;z-index:2147483647!important;" +
    "pointer-events:none!important;";

  var root = host.attachShadow({ mode: "open" });

  /* ★ 这里原来还夹着一个「设置」小按钮（悬停才露）。已按老大要求删掉 ——
     它就是那个按钮的**结构**那一半，另两半在上面那段 CSS 和下面的交互段。
     现在骨架只剩三件：容器、球、输入框。 */
  var MARKUP =
    '<div class="wrap side-right" id="wrap">' +
      '<button class="ball" id="ball" type="button" title="点一下记一笔，按住可拖到边上">' +
        '<span class="ring"></span><span class="badge" id="badge">–</span>' +
      '</button>' +
      '<input id="edit" type="text" placeholder="记一笔，回车新建…" autocomplete="off">' +
      /* ★ v0.25.0 气泡。aria-live="polite" 不是为了好看 —— 它是「这个元素
         会在你不操作的时候自己变」的标准声明方式，读屏软件会念出来。
         一个会自己开口的浮层如果不声明，对读屏用户就是「页面莫名其妙响了一下」。 */
      '<div class="say" id="say" role="status" aria-live="polite">' +
        '<span id="sayText"></span>' +
        '<button class="saydo" id="sayDo" type="button" hidden></button>' +
      '</div>' +
    '</div>';

  root.innerHTML = "<style></style>" + MARKUP;

  /* ★ 先占位、再填 textContent，而不是把 CSS 直接拼进 innerHTML ——
     拼进去的话，任何一处 "</style>" 都会被 HTML 解析器当成结束标签。
     我们自己的 CSS 里没有，但这条规矩不该靠运气。 */
  root.querySelector("style").textContent = CSS;

  var $ = function (id) { return root.getElementById(id); };
  var wrap = $("wrap"), ball = $("ball");
  var sayBox = $("say"), sayText = $("sayText"), sayDo = $("sayDo");

  /* ================================================================ 吉祥物（v0.24.0）
     机制全部在 mascot.js（零依赖原生实现，跟桌面球共用同一份代码）。
     这一节只做三件事：**读配置 / 挂上去 / 摘下来**。

     ★ 硬约束：关掉的时候必须**一个监听都不留**。这是本功能唯一可能伤到
       别人的地方 —— 它会往每一个网页上挂全局 pointermove。所以
       「关掉 = unmount（监听全摘）」不是优化，是底线。 */
  var mc = null;

  function mcBase() {
    if (HAS_CHROME && chrome.runtime && chrome.runtime.getURL) {
      try { return chrome.runtime.getURL("mascots"); } catch (e) {}
    }
    return "mascots";     /* 预览壳与扩展目录同级时走相对路径 */
  }

  /* ★★ 换 v0.24.1：「一套配置 → 两个地址」的口径收进 mascot.js 的 charUrls，
     宿主只负责交出 base。为什么不让这里自己判断 char === "custom" ——
     桌面球那边也要判断同一个东西，两处各写一份的典型后果是
     「设置页显示自己的图、桌面球上还是狐狸」，而两个宿主各测各的、全绿。 */
  function mcUrls(cfg) {
    return window.TaskMascot.charUrls(cfg, mcBase());
  }

  function mcReduced() {
    try {
      return !!(window.matchMedia &&
                window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) { return false; }
  }

  /* 把 storage 里那坨（可能是脏数据/老版本）读成一份干净的配置。
     ★ 委托给 mascot.js 的 readConfig —— 设置页读的是同一份实现。
       「口径逐字一致」这条规矩，用共享函数兜住比用注释互相提醒可靠。 */
  function readMc(v) {
    var tm = window.TaskMascot;
    if (!tm || !tm.readConfig) {
      /* ★ v0.26.0：talk 跟 TaskMascot.readConfig 的默认口径逐字对齐（没存过 = 开）。
         这条兜底只在 mascot.js 压根没加载时走，但口径少一个字段就是一次分叉 ——
         而「两处默认值不一致」正是这个文件反复警告过的那类怪事。 */
      return { on: false, char: MCHAR_DEF, size: MSIZE_DEF, reacts: true, talk: true };
    }
    return tm.readConfig(v);
  }

  function ensureMc() {
    if (mc || !window.TaskMascot) return mc;
    var u = mcUrls(state.mc);
    mc = window.TaskMascot.create({
      dirs: u.dirs,
      reacts: u.reacts,
      size: state.mc.size,
      reduced: mcReduced()
    });
    ball.appendChild(mc.el);
    return mc;
  }

  /* 配置落定。三条路都汇到这里：首次 load / storage.onChanged / 预览参数。
     skipGeom：load() 里位置还没读出来，那时算几何是白算（还会用旧坐标）。 */
  function applyMc(cfg, skipGeom) {
    state.mc = cfg;
    var on = !!cfg.on && !!window.TaskMascot;
    if (on) {
      ensureMc();
      if (mc) {
        mc.setSize(cfg.size);
        mc.setChar(mcUrls(cfg));
        if (!mc.isMounted()) mc.mount();
      }
    } else if (mc) {
      mc.unmount();
    }
    wrap.classList.toggle("mc-on", on && !!mc);
    /* 挂上/换脸之后把基线定下来。★ 这一步同时是「首屏不给表情」的实现：
       mood() 第一次调用只记档，所以页面刚打开时它不会对着你蔫一下。 */
    maybeMood();
    /* ★★ v0.26.0：拨成静音时，正在说的那句要**跟着收**。
       不收的话，用户拨完开关切回网页，会看见球还在那儿吐着一句话 ——
       他的结论是「开关没生效」，而不是「这是拨之前那一句」。
       ★ 走 hideSay 而不是只 remove 那个 class：hideSay 会顺手 ++saySeq，
         把**在途的模型结果作废掉**。少了这一步，拨完开关之后半秒，
         那句话会自己冒出来 —— 症状比不收还糟。 */
    if (cfg.talk === false && wrap.classList.contains("say-on")) hideSay();
    if (!skipGeom) { clamp(); place(); }
  }

  /* 预览 / 调试用：不改 storage，直接看某个角色长什么样 */
  function previewMc(id, size) {
    if (!window.TaskMascot) return false;
    ensureMc();
    /* ★ custom 也要带过去：预览壳上 ?mc=custom 时它才是那张图 */
    var cfg = { on: true, char: id || state.mc.char,
                size: size || state.mc.size, reacts: state.mc.reacts,
                talk: state.mc.talk,
                custom: state.mc.custom };
    applyMc(cfg);
    return true;
  }

  var state = {
    form: "idle",       /* idle | input */
    side: "right",      /* right | left —— 吸附在哪条边上 */
    x: 0, y: 0,         /* 球的**视觉**左上角（视口坐标） */
    tasks: [],
    projects: [],
    connected: false,
    draft: "",
    lockUntil: 0,
    /* ★ 初始必须是 false（=「还不知道，先别挂」），**不能乐观写 true**：
       乐观写 true 的话，开关关着时球会先挂上去、等 storage 回来再摘掉 ——
       那就是一帧闪现（页面右下角闪一颗球），比晚出现难看得多。
       宁可晚一拍出现，也不要闪一下。storage 的回调本来就在启动路径上，
       所以「先不挂、等它回来」不额外增加延迟。 */
    on: false,
    /* 吉祥物配置（v0.24.0）。★ 初始一律「关」——与 on 同理：宁可晚一拍，
       也不能先按默认值画出来再改（那样会看见球「从小忽然变大」）。
       ★ talk 的初值跟 reacts 同档取 true（不是 false）：这两个都是**行为**
         开关，而 on 那个 false 是「还不知道挂不挂」。区别在于会不会被误用 ——
         talk:false 的初值会让「storage 还没回来的那几百毫秒里点球」变成
         默认静音，而用户根本不知道自己在测一个中间态。 */
    mc: { on: false, char: MCHAR_DEF, size: MSIZE_DEF, reacts: true, talk: true }
  };

  /* ================================================================ 数据 */

  function isLive(t) { return !t.archived; }
  function isOpen(t) { return t.status === "todo" || t.status === "doing"; }

  function openCount() {
    return state.tasks.filter(function (t) { return isLive(t) && isOpen(t); }).length;
  }

  function save(data) {
    if (!HAS_CHROME) return;
    var patch = {};
    patch[KEY] = data;
    try { chrome.storage.local.set(patch); } catch (e) {}
  }

  /* 读一次真实数据。球不存东西 —— 这份只是内存里的画。 */
  function load(cb) {
    if (!HAS_CHROME) { if (cb) cb(); return; }
    chrome.storage.local.get([KEY, PKEY, POSKEY, ONKEY, MKEY], function (o) {
      var d = o && o[KEY];
      state.tasks = (d && Array.isArray(d.tasks)) ? d.tasks : [];
      state.projects = (o && Array.isArray(o[PKEY])) ? o[PKEY] : [];
      state.connected = true;
      /* ★ 在这里落定开关（而不是在调用方）：启动回调与 5 秒兜底**都过 load**，
         放这儿能保证「不管从哪条路进来，开关都是最新读到的那个值」。
         写在调用方的话，兜底那条路迟早会漏掉这一句。 */
      setOn(readOn(o && o[ONKEY]));
      /* ★★ 吉祥物配置必须落在**位置之前**：下面的 defaultPos() 用 ballSize()，
         而 ballSize() 读 state.mc。顺序反了就会拿「普通形态的 32」去算一次位置，
         再按 72 画出来 —— 球会偏出边缘一截（而且只在第一次打开时错，很难复现）。 */
      applyMc(readMc(o && o[MKEY]), true);
      var p = o && o[POSKEY];
      if (p && typeof p.x === "number" && typeof p.y === "number") {
        state.x = p.x; state.y = p.y;
        if (p.side === "left" || p.side === "right") state.side = p.side;
        else snap();                       /* 老数据没存 side：按坐标推一次 */
      } else {
        defaultPos();
      }
      if (cb) cb();
    });
  }

  function savePos() {
    if (!HAS_CHROME) return;
    var patch = {};
    patch[POSKEY] = { x: Math.round(state.x), y: Math.round(state.y), side: state.side };
    try { chrome.storage.local.set(patch); } catch (e) {}
  }

  /* ================================================================ 几何
     ★★ 唯一的不变量：**球不动**。
        换形态时只改「容器多宽、往哪边长、贴着哪条边」；
        球的视觉坐标 (state.x, state.y) 从进入某个形态到离开都不变。 */

  /* 把球贴到它当前那一侧的边上 */
  function snapX() {
    state.x = state.side === "right"
      ? window.innerWidth - ballSize() - PAD
      : PAD;
  }

  /* 吸附：松手后贴到**最近的边**。★ 判据用球心，不是球左边 ——
     球心过中线才算翻边，否则「刚过一半就翻」会让手感很怪。 */
  function snap() {
    state.side = (state.x + ballSize() / 2 < window.innerWidth / 2) ? "left" : "right";
    snapX();
    clamp();
  }

  /* 默认位置：贴右边缘、垂直居中。★ 竞品就是这么放的 ——
     垂直居中比右下角更容易被眼角扫到，也不跟任何网站的浮动按钮抢地盘。 */
  function defaultPos() {
    state.side = "right";
    snapX();
    state.y = Math.round((window.innerHeight - ballSize()) / 2);
  }

  function clamp() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var b = ballSize();
    state.x = Math.min(Math.max(PAD, state.x), Math.max(PAD, vw - b - PAD));
    state.y = Math.min(Math.max(PAD, state.y), Math.max(PAD, vh - b - PAD));
  }

  function place() {
    var vw = window.innerWidth;
    var b = ballSize();
    var w = state.form === "input" ? needW() : b;

    wrap.classList.toggle("side-right", state.side === "right");
    wrap.classList.toggle("side-left", state.side === "left");
    wrap.style.width = w + "px";
    /* ★ 球直径用 CSS 变量下发，而不是让 .ball 自己猜。
       换形态时「球变大」和「几何按新尺寸算」必须是**同一拍**的事，
       分两处写就会有一帧不一致（球已经大了、位置还是旧的）。 */
    wrap.style.setProperty("--bs", b + "px");

    /* 容器**贴着球的那一边**对齐：球在右就右对齐（宽形态往左长），
       球在左就左对齐（往右长）。无论哪种，球在屏幕上原地不动。 */
    var left = state.side === "right" ? (state.x + b - w) : state.x;
    left = Math.min(Math.max(0, left), Math.max(0, vw - w));
    wrap.style.left = Math.round(left) + "px";
    wrap.style.top = Math.round(state.y) + "px";

    /* ★ 球挪了 → 吉祥物缓存的盒子作废。
       少这一句的症状很隐蔽：球被拖到新位置后，头还是朝着**旧位置**看的
       （因为 rect 还是上一次的），直到窗口 resize 才恢复。 */
    if (mc) mc.refresh();
  }

  function paint() {
    wrap.classList.toggle("form-input", state.form === "input");
  }

  function setForm(f) {
    var want = f || "idle";
    if (state.form === want) return;
    state.lockUntil = Date.now() + 300;
    state.form = want;
    paint();
    place();
    if (want === "input") {
      $("edit").value = state.draft;
      setTimeout(function () { try { $("edit").focus(); } catch (e) {} }, 60);
    }
  }

  /* ================================================================ 它开口说话（v0.25.0）

     ★★ 这里只做**界面**（什么时候把气泡亮出来、点亮之后干什么），
        「说什么」和「什么时候允许主动说」全在 notify.js 里，一句话都不在这儿拼。
        原因：桌面球那边也要说同一句话，两个宿主各拼一版文案，迟早会
        「网页上说得对、桌面上说得怪」，而两边单测各测各的、全绿。

     ★★ 这个球**不会主动开口**。它只在两种情况下说话，两种都由用户发起：
         ① 你点了它（下面 endDrag 的点击分支）；
         ② 你点了气泡上那个动作按钮之后（回你一句「做完了」）。
         —— 「主动提醒」是这个功能的第 3 级，走的是**系统通知**，
            不在球上：桌面球静息只有几十像素，网页球在别人家的页面上，
            两者都不是一个适合「突然弹一句话出来」的位置。 */
  var sayTimer = null;
  var saySeq = 0;          /* ★ 序号：晚了回来的模型结果不许覆盖新的一句话 */
  var sayAct = null;       /* 当前气泡上挂着的动作（null = 这条没有动作） */
  var SAY_MS = 7000;       /* 只报个状态：看一眼就够 */
  var SAY_ACT_MS = 12000;  /* 带动作：要留出「看懂 → 移鼠标 → 点」的时间。
                              ★ 比上面长一倍是有意的 —— 一条来不及点的按钮
                                等于没有按钮，而用户会把「点不到」记成「这球没用」。 */

  function armSayTimer() {
    if (sayTimer) clearTimeout(sayTimer);
    sayTimer = setTimeout(hideSay, sayAct ? SAY_ACT_MS : SAY_MS);
  }

  function hideSay() {
    if (sayTimer) { clearTimeout(sayTimer); sayTimer = 0; }
    /* ★ 作废在途的模型结果：不 ++ 的话，收起之后回来的那句话会把气泡
       重新点亮（用户已经把目光移走了，它又冒出来一次）。 */
    saySeq++;
    sayAct = null;
    wrap.classList.remove("say-on");
    sayText.textContent = "";
    sayDo.hidden = true;
    sayDo.textContent = "";
  }

  function showSay(text, action) {
    sayAct = action || null;
    sayText.textContent = (text == null) ? "" : String(text);
    if (sayAct) {
      sayDo.textContent = sayAct.label || "处理一下";
      sayDo.hidden = false;
    } else {
      sayDo.textContent = "";
      sayDo.hidden = true;
    }
    wrap.classList.add("say-on");
    armSayTimer();
  }

  /* 用户点了它 → 说一句。
     ★★ v0.26.0：这里是「说话」开关的**唯一**门控点（设置页球那段的
        「点它的时候说一句」）。放在最前面而不是放在 showSay 里：
        showSay 还要给 doAction 的回执用（「3 件已经拉回今天」），
        把门控塞进 showSay 会连回执一起静音 —— 那是个更难查的 bug，
        因为「点了按钮什么都没发生」看起来像按钮坏了。
     ★ 只关说话，**不关表情**：戳一下它的反应（endDrag 里的 mc.boop）
       走的是另一条路，跟这里无关。这正是老大拍板的那条 ——
       「只关说话，表情留着」。 */
  function sayNow() {
    if (!state.connected || !window.Notify) return;
    if (state.mc.talk === false) return;
    var N = window.Notify;
    var f = N.facts({ tasks: state.tasks });
    var me = ++saySeq;
    var act = N.actionOf(f);
    /* ★★ 先本地句、再润色。反过来（等模型回来才显示）的症状是
       「用户点下去之后十几秒什么都没有」—— 模型超时上限就是 15 秒，
       而这里又不是一个「等得起」的位置。与「记一笔」那条路同一个套路：
       立刻给出能用的结果，异步把更聪明的那一版补上。 */
    showSay(N.localLine(f), act);
    N.compose(f, window.AI).then(function (r) {
      if (me !== saySeq || !r || !r.text) return;      /* 已经翻篇了就别改口 */
      /* ★ 一样就别重写：无意义的赋值会打断那段淡入过渡，看起来像闪一下。
         没配模型时 compose 立刻返回本地句，正好走这条早退。 */
      if (r.text !== sayText.textContent) showSay(r.text, r.action);
    });
  }

  /* 气泡上那个按钮：**替用户动手**，不是再催他一句。
     ★ 这是整个功能里唯一「有用的」那一块 —— 一个能替你动手的提醒，
       比一个会说话的提醒值十倍（见 notify.js 抬头）。 */
  function doAction() {
    if (!sayAct || sayAct.kind !== "today" || !HAS_CHROME) return;
    var t = new Date();
    var today = t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") +
                "-" + String(t.getDate());
    chrome.storage.local.get([KEY], function (o) {
      var data = (o && o[KEY]) ? o[KEY] : null;
      if (!data || !Array.isArray(data.tasks)) return;
      /* ★ 改哪些任务由 notify.js 的 applyToday() 说了算 ——
         桌面通知上那个按钮改的是同一件事，两处各写一份判断，
         迟早「网页上点改了 3 条、通知里点改了 4 条」。 */
      var n = window.Notify.applyToday(data.tasks, today);
      if (!n) return;
      save(data);
      /* ★ 做完必须回一句「做完了」，不能默默消失：
         用户点了按钮之后要看见「它确实替我动了」，否则下次他就不点了。
         （表情反馈不在这里给 —— 上面的 save() 会推 storage.onChanged，
            render() → maybeMood() 会因为「逾期归零」自然给一个开心的表情。） */
      showSay(n + " 件已经拉回今天", null);
    });
  }

  /* 状态 → 表情。★ 去重（跨档才给）在 mascot.js 的 mood() 里，
     这里只负责把事实算出来喂给它 —— 两个宿主都别自己记 lastMood。
     ★★ `state.connected` 是这里唯一能区分「清零了」和「还没读到」的东西：
        没读到的时候 tasks 也是空数组，facts() 会给出 {over:0, open:0}，
        那跟真的全清一模一样。不挡的话，球会对着一份还没读到的数据显示成开心。 */
  function maybeMood() {
    if (!state.connected || !mc || !state.mc.on || !window.Notify) return;
    mc.mood(window.Notify.facts({ tasks: state.tasks }));
  }

  /* ================================================================ 渲染 */

  function render() {
    /* ★ 只有读到了才报数字；没读到就是「–」。
       「–」= 我还不知道，「0」= 真的没有 —— 这两件事不能混。 */
    $("badge").textContent = state.connected
      ? (openCount() > 99 ? "99+" : String(openCount())) : "–";
    $("edit").placeholder = state.connected
      ? "记一笔，回车新建…" : "还没读到浏览器里的数据";
    /* ★ 心情外显挂在这里，因为 render() 是**所有**「数据变了」的汇合点
       （首次 load / storage.onChanged / 5 秒兜底）。放在调用方要写三遍，
       漏掉兜底那条的症状是「跨档了但它没反应」，而且只在漏事件时出现。 */
    maybeMood();
  }

  /* ================================================================ 拖动
     ★ 跟「点一下记一笔」共用一次 pointerdown：位移超过 4px 才算拖，
       否则算点。阈值不能是 0 —— 手指/触控板点一下总有几个像素的抖动。 */

  var drag = null;

  ball.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    drag = { sx: e.clientX, sy: e.clientY, ox: state.x, oy: state.y, moved: false };
    try { ball.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });

  ball.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      ball.classList.add("drag");
      setForm("idle");                 /* 拖的时候把输入框收掉，不然手感很乱 */
      hideSay();                       /* 一句话钉在拖动路径上也一样乱 */
      state.lockUntil = 0;
    }
    state.x = drag.ox + dx;
    state.y = drag.oy + dy;
    clamp();
    /* ★ 拖动途中**不吸附**（吸附会让球在手指底下乱跳）；
       松手的时候再贴边 —— 就是下面 endDrag 里那一下。 */
    place();
    e.preventDefault();
  });

  function endDrag(e) {
    if (!drag) return;
    var moved = drag.moved;
    drag = null;
    ball.classList.remove("drag");
    try { ball.releasePointerCapture(e.pointerId); } catch (err) {}
    if (moved) {
      snap();                          /* ★ 吸附到最近的边 */
      place();
      savePos();
    } else {
      /* ★ 吉祥物形态下，点一下先「戳」它一把再开输入框。
         这两件事不冲突：一个发生在脸上（表情有反应），一个在旁边（输入框推出来）。
         ★ 为什么不把「记一笔」挪到双击或别的键上：那是拿**功能**换**趣味**，
           这笔买卖不划算 —— 顺手记一笔是这个球存在的理由。 */
      if (mc && state.mc.on) mc.boop();
      /* ★ v0.25.0：点了它就说话（第 2 级「应答」）。
         ★ 只挂在这一条路上 —— 这里**必定是用户点的**（位移没超过 4px 才算点，
           见上面 drag 的阈值）。所以「球开口」这件事天然满足那条最硬的产品约束：
           提醒必须是用户动作的回声，不能是它自己的主意。 */
      sayNow();
      setForm(state.form === "input" ? "idle" : "input");
    }
  }
  ball.addEventListener("pointerup", endDrag);
  ball.addEventListener("pointercancel", endDrag);

  /* ================================================================ 交互 */

  /* ★ 这里原来绑着那个小齿轮的 click（= 打开设置页）。按钮已经删掉，
     事件绑定跟着一起走 —— 留着的唯一后果是 `$("gear")` 返回 null、
     整段脚本在控制台抛 TypeError（球直接不出来）。 */

  /* 气泡上的动作按钮。★ stopPropagation 不是防冒泡到页面（shadow 边界已经挡了），
     是防它冒到**我们自己的** pointerdown 那条捕获监听上 —— 那条会顺手续掉输入框，
     而「既要执行动作、又顺手打乱另一个控件」是最典型的复合 bug。 */
  sayDo.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    doAction();
  });

  /* ★ 鼠标一挪到气泡上就停掉倒计时。没有这两句，那 SAY_MS / SAY_ACT_MS
     就只是两个好看的数字 —— 用户正要点击时它会在他手指底下消失，
     而他只会记住「这东西点不到」。 */
  sayBox.addEventListener("mouseenter", function () {
    if (sayTimer) { clearTimeout(sayTimer); sayTimer = 0; }
  });
  sayBox.addEventListener("mouseleave", function () {
    if (wrap.classList.contains("say-on")) armSayTimer();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    /* 气泡比输入框「更新」：先收它。反过来的话，用户按 Esc 想关掉那句
       挡在眼前的话，结果是把输入框关了 —— 而输入框本来就没开着，什么都
       没发生，看起来像 Esc 失灵。 */
    if (wrap.classList.contains("say-on")) { hideSay(); return; }
    if (state.form === "input") setForm("idle");
  }, true);

  /* 点页面别处就收起来。★ 判断用 e.target === host：shadow 内部的事件
     会被重定目标到宿主元素上，所以「目标就是宿主」等价于「点在我们界面里」。 */
  document.addEventListener("pointerdown", function (e) {
    if (e.target === host) return;
    if (state.form === "input") setForm("idle");
  }, true);

  /* 全屏（视频 / 图片 / 整页）时自己藏起来 —— 竞品也是这么做的，
     不然全屏看片的时候边上一颗球很碍事。 */
  function onFullscreen() {
    var el = document.fullscreenElement ||
             (document.webkitFullscreenElement || null);
    host.style.display = el ? "none" : "";
  }
  document.addEventListener("fullscreenchange", onFullscreen);
  document.addEventListener("webkitfullscreenchange", onFullscreen);

  /* ---------------------------------------------------------------- 记一笔
     ★ 直接写 storage（跟后台右键建任务同一条路、同一个字段形状），
       写完 background.js 的 storage.onChanged 会照旧推给桌面球 + 安排飞书同步。
       字段形状必须跟 background.js 的 addTask 逐字一致，少一个都会让两地数据分家。 */
  function createTask(text) {
    if (!state.connected || !HAS_CHROME) return;
    chrome.storage.local.get([KEY, PKEY, "lastProject"], function (o) {
      var data = (o && o[KEY]) ? o[KEY] : { view: "today", tasks: [] };
      if (!data.tasks) data.tasks = [];
      var list = (o && Array.isArray(o[PKEY]) && o[PKEY].length) ? o[PKEY] : null;
      var t = new Date();
      data.tasks.unshift({
        id: Math.random().toString(36).slice(2, 9),
        title: text,
        status: "todo",
        project: (o && o.lastProject) || (list ? list[0].name : "工作"),
        date: t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") +
              "-" + String(t.getDate()).padStart(2, "0"),
        note: "", url: "",
        createdAt: Date.now(), doneAt: null,
        priority: "", order: null
      });
      save(data);
    });
  }

  var okTimer = null;
  function flashOk() {
    /* ★ 吉祥物形态下不打绿勾 —— 勾会直接画在脸上。
       改用表情回报：「存下了」这件事，一张笑脸比一个对勾更贴切，
       而且这正好是这套素材原本的用法（reactions 那张图里的 delighted）。 */
    if (mc && state.mc.on) { mc.react("delighted", 900); return; }
    ball.classList.add("ok");
    if (okTimer) clearTimeout(okTimer);
    okTimer = setTimeout(function () { ball.classList.remove("ok"); }, 900);
  }

  function submit() {
    var input = $("edit");
    var text = input.value.trim();
    if (!text || !state.connected) return;
    input.value = "";
    state.draft = "";
    createTask(text);
    flashOk();
    setForm("idle");
    /* ★ 记完一笔那句话就过期了（「还剩 3 件」在刚才那一笔之后已经是 4 件）。
       留着它 = 界面上挂着一句已知是错的话。 */
    hideSay();
  }

  $("edit").addEventListener("input", function () { state.draft = $("edit").value; });
  $("edit").addEventListener("keydown", function (e) {
    if (e.isComposing) return;
    if (e.key === "Escape") { state.draft = ""; $("edit").value = ""; setForm("idle"); return; }
    if (e.key === "Enter") submit();
  });

  window.addEventListener("resize", function () {
    if (state.side === "right") snapX();   /* 窗口宽度变了，贴边的球跟着走 */
    clamp();
    place();
  });

  /* ================================================================ 启动 */

  function demo() {
    var d = function (off) {
      var t = new Date(); t.setDate(t.getDate() + off);
      return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") +
             "-" + String(t.getDate()).padStart(2, "0");
    };
    state.projects = [
      { name: "任务台", color: "#002FA7" },
      { name: "公众号", color: "#c2410c" },
      { name: "备婚", color: "#7c3aed" }
    ];
    state.tasks = [
      { id: "d1", title: "把悬浮球接到网页上", status: "doing", project: "任务台", date: d(0) },
      { id: "d2", title: "周末前定下装修主材清单", status: "todo", project: "备婚", date: d(-2) },
      { id: "d3", title: "写「动手学AI吧」这周的选题", status: "todo", project: "公众号", date: d(1) },
      { id: "d4", title: "球拖动的阈值改到 4px", status: "done", project: "任务台", doneAt: Date.now() - 3600e3 }
    ];
    state.connected = true;
  }

  function mount() {
    /* ★ 所有「把球挂回去」的路径（boot / 3 秒兜底 / 开关重新打开）都汇到这一句，
       所以开关判断放这里就够 —— 别在四个调用点各写一遍，早晚漏一个。
       漏掉的症状是「关了开关，切到另一个网页（或页面自己 SPA 换 body）之后球又冒出来」。 */
    if (!state.on) return;
    var parent = document.documentElement || document.body;
    if (parent && !host.isConnected) parent.appendChild(host);
  }

  /* 从页面上摘掉。**不销毁 host** —— 它的 shadow 内容、球的位置、输入框里的草稿
     全都还在，开关开回来时 mount() 直接挂回原样，用户看不到「重来一遍」的痕迹。 */
  function unmount() {
    if (host.parentNode) host.parentNode.removeChild(host);
  }

  /* 开关状态落定（首次读到 / onChanged 推来，两条路都走这里）。
     ★ 相等就早退：chrome.storage.onChanged 会因为**任何**一次 storage 写入而触发
       （任务改动、位置保存、飞书同步都在写）。不早退的话，用户拖一下球就会
       重排一次 DOM，球的 CSS 过渡被反复打断 —— 看起来像抖动。 */
  function setOn(v) {
    if (v === state.on) return;
    state.on = v;
    if (v) {
      mount();
      /* 球回来的时候吉祥物也要接着跟 —— 否则「关了再开」之后它就不转头了 */
      if (mc && state.mc.on && !mc.isMounted()) mc.mount();
    } else {
      /* ★ 球整颗下线时，吉祥物的监听必须跟着停。它是「每个网页一个全局
         pointermove」，球都不在屏幕上了还收鼠标事件是纯浪费 ——
         而且这一条最容易漏：只调 unmount()（摘 host）是看不出问题的，
         因为没有人会去数监听器。单测里那条「unmount 必须摘掉 pointermove」
         就是为它写的。 */
      if (mc) mc.unmount();
      unmount();
    }
  }

  function boot() {
    mount();
    /* mount() 已经早退了，这里再挡一次是为了省掉后面那一串「量位置 / 算吸附 /
       写 DOM 样式」—— 关着的时候那些全是白算的，而且件件都会摸 DOM。 */
    if (!state.on) return;
    if (DEMO) demo();
    if (!state.x && !state.y) defaultPos();
    clamp();
    render();
    paint();
    place();

    /* 预览 / 测试可以用 URL 直接落到某个形态与某一侧 */
    var start = QS && QS.get("form");
    if (start === "input") state.form = "input";
    var sd = QS && QS.get("side");
    if (sd === "left" || sd === "right") { state.side = sd; snapX(); }
    clamp();
    paint();
    place();
    onFullscreen();
  }

  if (DEMO) {
    /* 预览壳（ballwan.html?demo=1）没有 storage，直接当开 ——
       不然预览页是一片空白，调试样式时会以为是自己改坏了。 */
    state.on = true;
    /* ★ 预览壳默认**开着**吉祥物：这个壳存在的意义就是看它。
       要看普通形态加 ?nomc=1 —— 真机验收两个形态都要出图，所以这个口子必须有。
       ?mc=<id>&mcs=<尺寸> 可以直接落到某个角色上试。 */
    applyMc({
      on: !(QS && QS.has("nomc")),
      char: (QS && QS.get("mc")) || MCHAR_DEF,
      size: (QS && QS.get("mcs")) || MSIZE_DEF,
      reacts: true
    }, true);
    boot();
  } else if (HAS_CHROME) {
    load(function () { boot(); });
    /* 数据变了就重画（写 storage 的地方全都走这条路，不用各写一遍） */
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      /* ★★ 设置页拨开关 → 这边立刻上/下线。
         没有这一条的话，关掉开关后**已经开着的那些网页**会一直挂着球到下次刷新，
         用户会直接判「开关没生效」—— 而重开浏览器才消失，那体验更糟。 */
      if (changes[ONKEY]) setOn(readOn(changes[ONKEY].newValue));
      /* 换了角色 / 改了尺寸 / 开关：立刻生效，跟形态开关同一条路。
         这一条不写的话，用户在设置页换了个脸，得刷新页面才看得到。 */
      if (changes[MKEY]) applyMc(readMc(changes[MKEY].newValue));
      if (!changes[KEY]) return;
      var nv = changes[KEY].newValue;
      state.tasks = (nv && Array.isArray(nv.tasks)) ? nv.tasks : [];
      state.connected = true;
      render();
    });
    /* 兜底对表：万一漏了事件，最多 5 秒后自己纠正 */
    setInterval(function () { load(function () { if (state.on) render(); }); }, 5000);
  } else {
    boot();
  }

  /* ★ SPA 会把 body 整个换掉，我们的宿主就跟着没了 —— 每 3 秒确认一次，
     不在了就挂回 documentElement（挂 html 上比 body 稳得多）。 */
  setInterval(mount, 3000);

  /* 给预览页和测试用的把手（网页里就是一个普通全局变量，不污染页面）。
     ★ paint 也放出来：尺寸矩阵要直接落到某个形态上，而 setForm 有
       「形态没变就早退」的短路 —— 从把手走 setForm 会被它悄悄跳过（假绿）。 */
  try {
    window.__taskboardBall = {
      state: state, place: place, paint: paint, setForm: setForm, host: host,
      snap: snap, snapX: snapX, clamp: clamp,
      /* 开关也放出来：真机/jsdom 要能「拨一下开关」再断言球挂没挂上，
         而不是隔着 storage 绕一圈（绕了就只能测到 storage，测不到 DOM）。 */
      setOn: setOn, unmount: unmount,
      /* 吉祥物：测试要能直接落到某个角色/尺寸上（隔着 storage 绕一圈
         就只能测到 storage，测不到 DOM —— 这条教训本项目写过）。 */
      applyMc: applyMc, readMc: readMc, previewMc: previewMc,
      getMc: function () { return mc; },
      /* ★ v0.26.0：说话开关的判据必须落在**行为**上（气泡亮不亮），
         而不是「配置里那个布尔是什么」。所以把 sayNow 也放出来 ——
         隔着 storage 绕一圈只能测到配置，测不到「它到底开没开口」；
         而 jsdom 里点球那条路要过 pointer 事件 + 位移阈值，
         测起来一大半功夫花在造事件上，反而不稳。 */
      sayNow: sayNow,
      ballSize: ballSize, needW: needW,
      MKEY: MKEY, MCHAR_DEF: MCHAR_DEF, MSIZE_DEF: MSIZE_DEF,
      BALL: BALL, PAD: PAD, GAP: GAP, INPUT_W: INPUT_W, NEED_W: NEED_W
    };
  } catch (e) {}
})();
