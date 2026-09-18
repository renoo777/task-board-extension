/* 任务台 · 吉祥物核心（v0.24.0）
 *
 * 来源与许可：机制来自 page-mascot（github.com/nilbuild/page-mascot，MIT）。
 *   上游是可插拔的 React 组件（5.6 KB / 232 行）。这里重写成**零依赖原生实现**，
 *   原因有三，每条都是「上游那样写在我们的场景里会出问题」：
 *
 *   ① 我们有两个宿主（网页球的 Shadow DOM / 桌面球的 WebView），
 *      不可能为了一个会动的小人把 React 拖进包里。
 *   ② 上游每次 pointermove 都直接 getBoundingClientRect()。它是演示页里的孤例，
 *      无所谓；我们要挂在**每一个网页**上，那是每帧一次强制同步布局。
 *      → 这里改成 rAF 合并 + rect 缓存（失效点：scroll / resize / 尺寸变）。
 *   ③ 上游 DEAD_ZONE 写死 70px。它按 140px 的组件调的；我们组件更小，
 *      70px 死区等于「鼠标都快贴在脸上了还不转头」。→ 改成按尺寸比例算。
 *
 * ★ 机制的全部（别把它想复杂）：两张 3×3 雪碧图，靠
 *     background-size:300% + background-position 0/50/100% 切格。
 *   一张是「头朝哪边」，一张是「什么表情」。没有 canvas、没有引擎。
 *
 * ★ 上游有一处极其容易抄错的东西：**两个数组的顺序就是九宫格的 index**。
 *   DIRECTIONS 是「左上、上、右上、左、中、右、左下、下、右下」——
 *   不是按角度排的；REACTIONS 是「眨眼、爱心、闪光、惊讶、眨眼笑、害羞、
 *   困、晕、开心」。顺序错一格，表情就全错位（而且看起来"也能动"，
 *   所以这种错最容易活到线上）。这里照抄并加了自检。
 */
(function (root) {
  "use strict";

  /* 九宫格顺序 = index 顺序，改动它等于改动所有素材的含义。 */
  var DIRECTIONS = [
    "up-left", "up", "up-right",
    "left", "center", "right",
    "down-left", "down", "down-right"
  ];
  var REACTIONS = [
    "blink", "heart", "sparkle",
    "surprised", "wink", "bashful",
    "sleepy", "dizzy", "delighted"
  ];

  /* 从「正右」起顺时针，对应 atan2 角度（屏幕坐标 y 向下时角度顺时针增）。 */
  var CLOCKWISE = [
    "right", "down-right", "down", "down-left",
    "left", "up-left", "up", "up-right"
  ];
  var SECTOR = (Math.PI * 2) / CLOCKWISE.length;   /* 45° */
  var HYSTERESIS = 0.12;                           /* 抗抖：进了新扇区就别在边界上弹 */

  /* 戳一戳的时序（毫秒），与上游一致。 */
  var BOOP_PAYOFF = 120;      /* 「眨眼」先闪一下，再换成奖励表情 */
  var BOOP_END = 560;         /* 表情收回 */
  var SQUASH_MS = 420;
  var DIZZY_AFTER = 4;        /* 1.6 秒内连戳 4 下 → 晕 */
  var DIZZY_WINDOW = 1600;
  var DIZZY_END = 1100;
  var PAYOFFS = ["heart", "sparkle", "delighted"];

  var SQUASH = [
    { transform: "scale(1,1)", easing: "ease-in" },
    { transform: "scale(1.10,0.86)", offset: 0.18, easing: "ease-out" },
    { transform: "scale(0.95,1.08)", offset: 0.45, easing: "ease-in-out" },
    { transform: "scale(1.03,0.97)", offset: 0.72, easing: "ease-in-out" },
    { transform: "scale(1,1)" }
  ];

  var SIZE = { min: 44, def: 72, max: 120 };

  /* ============================================================ 自定义图（v0.24.1）
     用户在设置页传一张图，那一页用 canvas 把它**烘成两张 3×3 雪碧**存进 storage；
     之后两个宿主走的就是跟内置角色**一字不差**的那条路（`charUrls` 里换个地址而已）。

     ★★ 一张图没有九个朝向，这是物理事实 —— 所以九格是「同一张图 + 九种微变换」：
        左右镜像 + 旋转 + 非等比缩放（拉长＝仰头 / 压扁＝低头）+ 一点点位移。
        72px 上看，那就是「它转头了」。
        ★ 说清楚代价：自定义图**不会换表情**，只会换姿态（内置角色的九个表情是
          真的九张画）。这是这个方案的天花板，不是实现没做到。

     ★ BASE 是统一缩放，所有变换都乘它。**这个数是算出来的，不是调出来的**：
       旋转 + 非等比缩放 + 位移会叠着把图推出格子，而雪碧是 3×3 紧挨着的 ——
       出了框就画到**隔壁格**去，隔壁是另一个朝向的脸，72px 上看着像"重影"。
       第一版取 0.86，`atlasOverflow()` 直接报「最多出框 6.2%」，而且
       `_test_mascot.js` 里另一套独立算法（四角旋转坐标）算出同一个数 ——
       两套算法一致，说明那是真出框。收到 0.80 之后最大值 0.943，留了余量。
       代价：自定义图比内置角色小一圈（内置本体约占格子的 83%），这是不串格的必要代价。
       ★ 这两个数都由断言钉着，改表就必须重算 —— 别靠眼睛估。 */
  var CUSTOM = {
    SRC: 160,      /* 归一化后的原图边长。球最大 120px，2x 屏也够 */
    THUMB: 68,     /* 设置页缩略图，与内置角色的 thumb 同规格 */
    BASE: 0.80,
    /* 九朝向。顺序 = DIRECTIONS（左上/上/右上 · 左/中/右 · 左下/下/右下） */
    DIRS: [
      { dx: -3, dy: -3, rot: -6, flip: 0, sx: 1.03, sy: 1.03 },  /* up-left   */
      { dx: 0, dy: -4, rot: 0, flip: 0, sx: 1.00, sy: 1.07 },    /* up        */
      { dx: 3, dy: -3, rot: 6, flip: 0, sx: 1.03, sy: 1.03 },    /* up-right  */
      { dx: -4, dy: 0, rot: 0, flip: 0, sx: 0.96, sy: 1.00 },    /* left      */
      { dx: 0, dy: 0, rot: 0, flip: 0, sx: 1.00, sy: 1.00 },     /* center    */
      { dx: 4, dy: 0, rot: 0, flip: 1, sx: 0.96, sy: 1.00 },     /* right ★镜像 */
      { dx: -3, dy: 3, rot: -4, flip: 0, sx: 1.02, sy: 0.96 },   /* down-left */
      { dx: 0, dy: 4, rot: 0, flip: 0, sx: 1.00, sy: 0.92 },     /* down      */
      { dx: 3, dy: 3, rot: 4, flip: 0, sx: 1.02, sy: 0.96 }      /* down-right*/
    ],
    /* 九反应。顺序 = REACTIONS（眨眼/爱心/闪光 · 惊讶/眨眼笑/害羞 · 困/晕/开心） */
    REACTS: [
      { dx: 0, dy: 1, rot: 0, flip: 0, sx: 1.00, sy: 0.96 },     /* blink     */
      { dx: 0, dy: -2, rot: 0, flip: 0, sx: 1.06, sy: 1.06 },    /* heart     */
      { dx: 0, dy: -1, rot: -7, flip: 0, sx: 1.04, sy: 1.04 },   /* sparkle   */
      { dx: 0, dy: -3, rot: 0, flip: 0, sx: 0.96, sy: 1.08 },    /* surprised */
      { dx: 0, dy: -1, rot: 7, flip: 0, sx: 1.02, sy: 1.02 },    /* wink      */
      { dx: 0, dy: 2, rot: -6, flip: 0, sx: 0.96, sy: 0.96 },    /* bashful   */
      { dx: 2, dy: 2, rot: 11, flip: 0, sx: 1.00, sy: 1.00 },    /* sleepy    */
      { dx: 0, dy: 2, rot: -14, flip: 0, sx: 0.94, sy: 0.94 },   /* dizzy     */
      { dx: 0, dy: -3, rot: 5, flip: 0, sx: 1.06, sy: 1.06 }     /* delighted */
    ]
  };

  /* 把一张图按 plan 画成 3×3（9 格，每格 box×box）。设置页用它烘雪碧。
     ★ img 必须是**已经归一化到 CUSTOM.SRC 见方**的（canvas 或 ImageBitmap）——
       这里按 img.width / img.height 居中，不假设尺寸，这样单测能喂一个
       `{width:160,height:160}` 的假对象进来把九格都走一遍。 */
  function drawAtlas(ctx, img, plan, box) {
    var i, t, col, row, rad;
    for (i = 0; i < 9; i++) {
      t = plan[i % plan.length];
      col = i % 3;
      row = Math.floor(i / 3);
      rad = (t.rot || 0) * Math.PI / 180;
      ctx.save();
      ctx.translate((col + 0.5) * box + (t.dx || 0), (row + 0.5) * box + (t.dy || 0));
      if (rad) ctx.rotate(rad);
      ctx.scale((t.flip ? -1 : 1) * (t.sx || 1) * CUSTOM.BASE,
                (t.sy || 1) * CUSTOM.BASE);
      ctx.drawImage(img, -img.width / 2, -img.height / 2, img.width, img.height);
      ctx.restore();
    }
    return ctx;
  }

  /* 最"胀"的那一格超出格子的比例（0 = 完全在框内）。
     ★ 为什么要有它：旋转 + 放大 + 位移叠一起，很容易就画到隔壁格去了
       （隔壁就是另一个朝向的脸，串味了在 72px 上看着像"重影"）。
       这个量算得出来，所以它该被断言钉住，而不是靠出图时肉眼扫一遍。
     判据用**四个角点旋转后的坐标**，跟上面画图那条路是独立的算法。 */
  function atlasOverflow(plan, base) {
    base = typeof base === "number" ? base : CUSTOM.BASE;
    var worst = 0, box = CUSTOM.SRC;
    for (var i = 0; i < plan.length; i++) {
      var t = plan[i];
      var hw = (box / 2) * (t.sx || 1) * base;
      var hh = (box / 2) * (t.sy || 1) * base;
      var rad = (t.rot || 0) * Math.PI / 180;
      var cos = Math.cos(rad), sin = Math.sin(rad);
      var corner = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (var k = 0; k < 4; k++) {
        var x = hw * corner[k][0], y = hh * corner[k][1];
        var rx = x * cos - y * sin, ry = x * sin + y * cos;
        var ox = Math.abs(rx + (t.dx || 0)) / (box / 2);
        var oy = Math.abs(ry + (t.dy || 0)) / (box / 2);
        if (ox > worst) worst = ox;
        if (oy > worst) worst = oy;
      }
    }
    return Math.round(worst * 1000) / 1000;
  }

  /* cover 裁切：把任意长宽比的图铺进 box 见方的框里 —— 短边铺满、长边居中裁掉。
     ★ 为什么抽出来单独一个函数：jsdom 里没有 canvas，「人脸有没有被压扁」在测试里
       就验不到 —— 可它是个**纯算术**，不该因为环境缺 canvas 就没人管。
       拉伸（直接拉满）在方图上看不出来，等用户传一张 16:9 的横截图，脸会被压成饼。 */
  function coverRect(iw, ih, box) {
    if (!(iw > 0) || !(ih > 0)) return { x: 0, y: 0, w: box, h: box };
    var k = Math.max(box / iw, box / ih);
    var w = iw * k, h = ih * k;
    return { x: (box - w) / 2, y: (box - h) / 2, w: w, h: h };
  }

  /* 从一份**已解析**的配置里取出两张图的地址。
     ★★ 这段必须在 mascot.js 里，不能各宿主各写一份：内置角色要拼路径、
       自定义走 dataURL —— 两处口径不一致会造出「设置页是自定义图、网页上还是狐狸」
       这种查半天的怪事，而两边单测各测各的、全绿。本仓库在 readWb / readPrefs
       上已经栽过同一形状的坑，所以这里用**共享函数**兜住，不靠注释互相提醒。
     base 由宿主给：网页球要 chrome.runtime.getURL（其他人打不开扩展的目录），
     桌面球是 WebView 里的相对路径。 */
  function charUrls(cfg, base) {
    cfg = cfg || {};
    if (cfg.char === "custom" && cfg.custom) {
      return { dirs: cfg.custom.dirs, reacts: cfg.custom.reacts };
    }
    return {
      dirs: base + "/" + cfg.char + "-directions.webp",
      reacts: base + "/" + cfg.char + "-reactions.webp"
    };
  }

  function clampSize(n) {
    n = Math.round(Number(n) || SIZE.def);
    if (n < SIZE.min) n = SIZE.min;
    if (n > SIZE.max) n = SIZE.max;
    return n;
  }

  /* 一格 → background-position。300% 的尺寸让三档正好是 0 / 50 / 100%。 */
  function cell(index) {
    return ((index % 3) * 50) + "% " + (Math.floor(index / 3) * 50) + "%";
  }

  function wrapAngle(a) {
    return Math.atan2(Math.sin(a), Math.cos(a));
  }

  /* 角度 → 扇区号（0..7，CLOCKWISE 的下标）。-1 表示「不换」。 */
  function sectorFor(angle, prevSector) {
    if (prevSector !== -1 &&
        Math.abs(wrapAngle(angle - prevSector * SECTOR)) < SECTOR / 2 + HYSTERESIS) {
      return prevSector;
    }
    return (Math.round(angle / SECTOR) + CLOCKWISE.length) % CLOCKWISE.length;
  }

  function dirOf(sector) {
    return CLOCKWISE[((sector % CLOCKWISE.length) + CLOCKWISE.length) % CLOCKWISE.length];
  }

  /* ================================================================ 实例 */

  function create(opts) {
    opts = opts || {};
    var size = clampSize(opts.size);
    var dirs = opts.dirs || "";
    var reacts = opts.reacts || "";
    var onBoop = typeof opts.onBoop === "function" ? opts.onBoop : null;
    var reduced = !!opts.reduced;

    var timers = [];
    var boops = { count: 0, at: 0 };
    var reaction = null;
    var direction = "center";
    /* ★★ undefined = 「还没定过基线」，与 null = 「档位就是常态」是两件事。
       这两个值混用会让「首屏就蔫一下」和「常态不吭声」互相打架（见 mood()）。 */
    var lastMood;
    var shell = null, squash = null, layerDir = null, layerRea = null;
    var mounted = false;
    var destroyed = false;

    /* 跟随状态 —— 全部只在 mounted 时才动 */
    var pointer = null;       /* 最近一次指针位置（视口坐标） */
    var sector = -1;
    var rect = null;          /* 缓存的组件盒子 */
    var rafId = 0;

    function el(tag, cls) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      return e;
    }

    function build() {
      if (shell) return;
      /* 外层 span 而不是 div：content script 会被注入到 <p>、<a>、<h1> 里，
         div 是非法子元素，某些站点（严格 HTML 校验 / 富文本编辑器）会把它挪走
         或者直接折平 —— 那是一类很难查的「球偶尔消失」。span 到处都合法。 */
      shell = el("span", "tmc");
      shell.setAttribute("aria-hidden", "true");
      squash = el("span", "tmc-squash");
      layerDir = el("span", "tmc-l tmc-dir");
      layerRea = el("span", "tmc-l tmc-rea");
      /* ★★ 样式必须**先**写好再设图，不能反过来 ——
         `style.cssText = ...` 是**整体替换**，写在后面的那几句 backgroundImage /
         backgroundPosition 会被它一次清空（浏览器和 jsdom 都是这个行为）。
         症状是：组件建出来了、尺寸也对，但永远是**空白的**（图没被引用），
         而且没有任何报错。这个顺序是单测抓出来的。 */
      var layerCss =
        "display:block;position:absolute;left:0;top:0;right:0;bottom:0;" +
        "background-size:300% 300%;background-repeat:no-repeat;" +
        "transition:opacity .12s linear";
      layerDir.style.cssText = layerCss;
      layerRea.style.cssText = layerCss;

      /* ★ 两层都挂上、都设 backgroundImage：上游那句注释是对的 ——
         反应图必须**一开始就加载**，否则第一次戳下去要等图回来，那一瞬间是空白。
         代价只是当前角色的两张图，不是全部 58 个。 */
      layerDir.style.backgroundImage = dirs ? 'url("' + dirs + '")' : "none";
      layerRea.style.backgroundImage = reacts ? 'url("' + reacts + '")' : "none";
      layerDir.style.backgroundPosition = cell(DIRECTIONS.indexOf("center"));
      layerRea.style.backgroundPosition = cell(REACTIONS.indexOf("blink"));
      layerRea.style.opacity = "0";
      squash.appendChild(layerDir);
      squash.appendChild(layerRea);
      shell.appendChild(squash);

      /* 内联样式而不是外部 CSS：这个组件要被塞进「别人家的 Shadow DOM」，
         还得能跟着 58 个角色换尺寸。内联是唯一不依赖加载顺序的做法。 */
      shell.style.cssText = [
        "display:none", "position:relative", "flex:none", "padding:0", "border:0",
        "background:transparent", "box-sizing:border-box",
        "width:" + size + "px", "height:" + size + "px",
        "pointer-events:none", "user-select:none", "-webkit-user-select:none",
        "line-height:0", "font-size:0"
      ].join(";");
      squash.style.cssText =
        "display:block;position:relative;width:100%;height:100%;" +
        "transform-origin:50% 78%";
    }

    /* ---------------- 跟随 ---------------- */

    function invalidate() { rect = null; }
    invalidate();

    function box() {
      if (!rect && squash && squash.getBoundingClientRect) {
        rect = squash.getBoundingClientRect();
      }
      return rect;
    }

    /* 把「按尺寸缩放的死区」算出来。上游是写死的 70px（配它的 140px 组件），
       我们组件最小 44px —— 照抄 70 会让小组件几乎不转头。 */
    function deadZone() {
      return Math.max(22, size * 0.5);
    }

    function aim() {
      rafId = 0;
      if (!mounted || !pointer || !squash) return;
      var b = box();
      if (!b || (!b.width && !b.height)) return;
      var dx = pointer.x - (b.left + b.width / 2);
      var dy = pointer.y - (b.top + b.height / 2);
      if (Math.sqrt(dx * dx + dy * dy) < deadZone()) {
        sector = -1;
        setDirection("center");
        return;
      }
      var next = sectorFor(Math.atan2(dy, dx), sector);
      if (next !== sector) {
        sector = next;
        setDirection(dirOf(next));
      }
    }

    function schedule() {
      if (rafId || !mounted) return;
      rafId = (root.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(aim);
    }

    function onPointerMove(e) {
      /* ★ 只记坐标，不算 —— 一次 pointermove 就是一次 JS 调用，
         高刷屏 + 大量鼠标事件下，每帧可能来十几个。真正的计算推迟到 rAF。 */
      pointer = { x: e.clientX, y: e.clientY };
      schedule();
    }

    function onViewport() {    /* resize：窗口变了，球会被 clamp 挪动，缓存作废 */
      invalidate();
      schedule();
    }

    function attach() {
      root.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
      root.addEventListener("resize", onViewport, { passive: true });
      /* ★★ 这里比上游**少一个 scroll 监听**，是故意的。
         上游的 mascot 处在正常文档流里，页面一滚它就跟着走，所以它必须监听 scroll
         重算盒子。我们的两个宿主（网页球 / 桌面球）都是 `position:fixed` 的
         视口坐标 —— **滚动根本不改变它的位置**。
         留着这个监听不是「更保险」，是「每次滚动都白丢一次 getBoundingClientRect」
         （强制同步布局），在长页面上滚动时是实打实的钱。位置真变了的时候，
         宿主会自己调 refresh()（place() 里那一句）。 */
    }

    function detach() {
      root.removeEventListener("pointermove", onPointerMove, { capture: true });
      root.removeEventListener("resize", onViewport);
      if (rafId) {
        (root.cancelAnimationFrame || clearTimeout)(rafId);
        rafId = 0;
      }
    }

    /* ---------------- 渲染 ---------------- */

    function setDirection(name) {
      if (name === direction) return;
      var i = DIRECTIONS.indexOf(name);
      if (i < 0) return;                      /* 不认识的朝向：忽略，别写坏 index */
      direction = name;
      /* ★ 反应表情在的时候不换方向层 —— 否则「正在爱心」的脸上又叠一层转头，
         两层半透明一混合就是一张鬼脸。 */
      if (!reaction) layerDir.style.backgroundPosition = cell(i);
    }

    function setReaction(name) {
      reaction = name;
      if (name) {
        layerRea.style.backgroundPosition = cell(REACTIONS.indexOf(name));
        layerRea.style.opacity = "1";
        layerDir.style.opacity = "0";
      } else {
        layerRea.style.opacity = "0";
        layerDir.style.opacity = "1";
        layerDir.style.backgroundPosition = cell(DIRECTIONS.indexOf(direction));
      }
    }

    function clearTimers() {
      for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
      timers = [];
    }

    function later(ms, name) {
      timers.push(setTimeout(function () { setReaction(name); }, ms));
    }

    function boop() {
      if (!shell) return;
      clearTimers();
      var now = Date.now();
      boops.count = (now - boops.at < DIZZY_WINDOW) ? boops.count + 1 : 1;
      boops.at = now;
      if (boops.count >= DIZZY_AFTER) {
        boops.count = 0;
        setReaction("dizzy");
        later(DIZZY_END, null);
      } else {
        setReaction("blink");
        later(BOOP_PAYOFF, PAYOFFS[(boops.count - 1) % PAYOFFS.length]);
        later(BOOP_END, null);
      }
      if (!reduced && squash && squash.animate) {
        /* ★ easing 给在 effect 上会把每个关键帧的 offset 重新解释一遍
           （整段动画被前移）—— 所以 effect 用 linear，缓动写在关键帧里。
           上游这行注释是对的，照抄。 */
        squash.animate(SQUASH, { duration: SQUASH_MS, easing: "linear" });
      }
      if (onBoop) { try { onBoop(); } catch (e) {} }
    }

    /* ---------------- 对外 ---------------- */

    var api = {
      get el() { build(); return shell; },
      get size() { return size; },
      get direction() { return direction; },
      get reaction() { return reaction; },

      /* ★ mount / unmount 都必须是**幂等**的。
         调用方（网页球）已经用 isMounted() 挡了一层，但这层不能只靠它：
         重复 mount 会重复 attach —— 监听器越积越多，用户来回拨几十次开关
         之后，鼠标一动就有几十个回调在跑，而**没有任何可见症状**，
         只是在某个页面上莫名其妙地卡。 */
      mount: function () {
        build();
        if (destroyed || mounted) return api;
        mounted = true;
        shell.style.display = "block";
        attach();
        return api;
      },

      unmount: function () {
        if (mounted) {
          mounted = false;
          detach();
        }
        if (shell) shell.style.display = "none";
        return api;
      },

      isMounted: function () { return mounted; },

      /* 外层（球）在自己的 rect 变化后必须叫一声，否则缓存会指向旧位置。 */
      refresh: function () { invalidate(); schedule(); return api; },

      /* 直接喂一个坐标（**桌面球专用**）。
         ★★ 为什么要有这个口子：桌面球那扇窗只有几十像素见方，鼠标绝大多数时间
            在窗口**外面**，DOM 的 pointermove 根本收不到 —— 光靠 attach() 那套，
            吉祥物只有"鼠标正好压在它身上"那半秒才会转头，等于把效果砍掉。
            所以桌面球由 Rust 轮询系统光标（cursor-move 事件）从这个口子喂进来。
         ★ 传进来的必须是**视口坐标**（和 clientX / clientY 同一套），
            别传屏幕坐标 —— 那会让它朝着完全错误的方向看，而且没有任何报错。 */
      aimAt: function (x, y) {
        pointer = { x: x, y: y };
        schedule();
        return api;
      },

      setSize: function (n) {
        size = clampSize(n);
        if (shell) {
          shell.style.width = size + "px";
          shell.style.height = size + "px";
        }
        invalidate();
        schedule();
        return api;
      },

      /* 换角色。
         ★ 这里试过「先 new Image() 预加载，两张都 onload 了再换」——**放弃了**。
           收益是省掉换图那一帧空白，但尾部风险更大：图慢或者加载失败时，
           用户点下去**没反应**，而上游那套得靠一个兜底定时器收场 ——
           兜底设短了等于没预加载，设长了就是「点了没反应」。
           我们换的是**扩展包里的本地文件**，赋 backgroundImage 和 new Image()
           走的是同一份资源、同一个缓存，所以直接换，让它自己加载。 */
      setChar: function (next) {
        var nd = next && next.dirs, nr = next && next.reacts;
        if (!nd || !nr) return api;
        dirs = nd; reacts = nr;
        if (layerDir) {
          layerDir.style.backgroundImage = 'url("' + nd + '")';
          /* 换图后位置要按**当前方向**重设一次：只换图不重设，浏览器会保留
             旧的 background-position（看起来是对的），但万一在新图上该 index
             的含义不同，就会「朝向没变、脸换了张不对的」。 */
          layerDir.style.backgroundPosition = cell(DIRECTIONS.indexOf(direction));
        }
        if (layerRea) layerRea.style.backgroundImage = 'url("' + nr + '")';
        return api;
      },

      boop: boop,

      /* 直接给一个表情（不走「戳」那套连击计时）。
         用途：宿主的功能反馈。球上原来保存成功是闪一个绿勾，吉祥物形态下
         改成给一个「开心」的表情 —— 比在脸上盖一个勾自然得多。 */
      react: function (name, ms) {
        if (!shell || REACTIONS.indexOf(name) < 0) return api;
        clearTimers();
        setReaction(name);
        later(ms || BOOP_END, null);
        return api;
      },

      setReduced: function (v) { reduced = !!v; return api; },

      /* 把「今天什么状况」交给它 —— **跨档才给一次表情**，同档不动。
         ★★ 去重必须在这一层，不能交给各个宿主：这份代码有两个宿主
            （网页球 / 桌面球）＋ 设置页的预览，三处各写一遍「记一个 lastMood」
            是最典型的「两边默认值不一致」温床。放在这里只有一处。
         ★★ 第一次调用**只定基线、不给表情**：页面刚打开时它不知道自己是刚醒
            还是刚发现你今天有逾期 —— 把「刚挂上」演成「有变化」，
            结果就是用户每换一个网页都看见它蔫一下。那是骚扰，不是外显。
         ★ 传进来的必须是 { over, open } 两个**已算好的数**（见 moodOf 抬头）。 */
      mood: function (stats, ms) {
        var m = moodOf(stats);
        if (m === lastMood) return api;
        var first = (lastMood === undefined);
        lastMood = m;
        /* 常态（空串）不下发 —— setReaction("") 会去 indexOf 一个空名字，
           而 REACTIONS.indexOf("") === -1，那会把 background-position 写坏。 */
        if (!first && m) api.react(m, ms || MOOD_MS);
        return api;
      },

      destroy: function () {
        clearTimers();
        api.unmount();
        if (shell && shell.parentNode) shell.parentNode.removeChild(shell);
        destroyed = true;
        shell = squash = layerDir = layerRea = null;
        return api;
      }
    };

    return api;
  }

  function availableChars(base, list) {
    return (list || []).map(function (c) {
      return {
        id: c.id,
        name: c.name,
        group: c.group,
        dirs: base + "/" + c.id + "-directions.webp",
        reacts: base + "/" + c.id + "-reactions.webp",
        thumb: base + "/thumb/" + c.id + ".webp"
      };
    });
  }

  /* ============================================================ 心情映射（v0.25.0）

     「让它知道我今天的状况」—— 但**只做外显，不做提醒**。

     ★★ 为什么是「三档」而不是一条连续的曲线：这套素材只有九张表情，而且
        表情层和朝向层**互斥**（两张都是 3×3 雪碧，同一时刻只显示一层）。
        所以「常驻蔫着」的代价是**它从此不转头了** —— 那是用一个更贵的东西
        （跟着你鼠标看的活物感）换一个更便宜的东西（一张不高兴的脸）。
        → 结论：心情只以**短表情**的形式出现，给完就把脸还给它自己。

     ★★ 为什么触发条件是「跨档」而不是「每次数据变化」：球挂在每一个网页上，
        每存一次任务、每同步一次飞书都会推一次新数据。照单全收的话，
        用户拖一下球、改一个字都换来一次表情 —— 那是噪声，不是反馈。
        只有**档位真的变了**才给一次，那才叫「它看见了」。

     ★★ 判据只吃**已经算好的两个数**（over / open），不吃任务数组：
        任务长什么样是宿主的事，这里只负责「两个数字 → 一张脸」。
        这样它是个纯函数，jsdom 里能直接验，不用造一整个 storage。 */
  var MOODS = { over: "sleepy", clear: "delighted", busy: "" };
  /* 心情表情停留多久。★ 比「戳一下」的 560ms 长得多：那个是你自己戳的，
     你知道发生了什么；这个是它自己变的，用户得先**注意到**才谈得上理解。
     2 秒是「转头看一眼能看清」的最短时长，再长就开始挡着界面了。 */
  var MOOD_MS = 2000;
  function moodOf(s) {
    /* ★★ 「没给我信息」和「信息是零」必须分开 —— 这是两个不同的世界：
         · 没给（undefined / null / 不是对象）→ 返回空串 = **不给表情**；
         · 给了 `{over:0, open:0}` → 是「它确实知道你清零了」→ 庆祝。
       混成一个的后果：调用方漏传一次参数，球就对着一份**还没读到的数据**
       欢呼一下（「今天清空了」），而屏幕上的角标明明是「–」。
       这类「把不知道当成好结果」的错在界面上看起来完全正常，只能靠这里挡住。 */
    if (!s || typeof s !== "object") return MOODS.busy;
    var over = Math.max(0, parseInt(s.over, 10) || 0);
    var open = Math.max(0, parseInt(s.open, 10) || 0);
    /* 优先级：逾期 > 清零 > 常态。
       ★ 「有逾期」必须压过「今天清零」：旧账没还清、今天却清空了，
         这时候庆祝是错的判断 —— 用户会立刻觉得这东西不懂事。 */
    if (over > 0) return MOODS.over;
    if (open === 0) return MOODS.clear;
    /* ★ 常态返回空串 = **不给表情**（交回调「什么都不做」）。
       给一个 blink 常驻听起来更"活"，代价是表情层一直占着，
       它就不转头了 —— 而转头才是它每分钟都在做的事。 */
    return MOODS.busy;
  }

  /* ★★ v0.26.0：`talk` = 「点了它，它说不说话」。默认开，口径 `v.talk !== false`
     （没存过 = 开），跟 on / reacts 逐字一致。
     ★ 为什么它住在 mascot 这份配置里、而不是另开一个 key：
       两个宿主都要看得见它 —— 网页球点一下要读（ballpage.js 的 sayNow），
       设置页要写（manage.js 的 mcCfg）。readConfig 已经是这两边**唯一**一份
       解析口径，加在这里等于零成本；另开一个 key 就要在 ballpage 的 storage
       监听、manage 的启动读、export/import 清单里各加一处，而漏掉任何一处的
       症状都是「设置页关掉了、网页上照旧在说」—— 那种 bug 只会在真机上露面。
     ★ 它是**行为**字段（跟 reacts 同类），读它的地方只有网页球一处。
       桌面球收到这个字段也不会说话：它压根没做「点球开口」那条路，
       所以这个开关对桌面球是**无影响**的（不是坏了）。 */
  var DEFAULT = { on: true, char: "fox", size: SIZE.def, reacts: true, talk: true };

  /* ★★ 配置只有这一份解析口径，两个宿主（网页球 / 设置页）都调它。
     为什么不各写一份：本项目已经栽过 —— 两处默认值不一致会造出
     「设置页显示开着、网页上没有」这种查半天的怪事，而单测各测各的、全绿。
     同一条规矩在 readWb / readPrefs 上写过一遍了，这里直接用代码兜住，不靠注释。

     ★ on 的口径是 `v.on !== false`（**没存过 = 开**），与网页球开关 readWb 逐字一致。
       理由：这两个开关是同一类东西（都在问「要不要在别人的网页上多画点东西」），
       默认值不一致就会出现「网页球默认开着、吉祥物默认关着」——
       用户看到的是半截功能，还得自己找到那个开关。
     ★ size 一定要过 clampSize：storage 是用户能改的，一个 size:9999
       会让球占掉半个屏幕。 */
  /* ★★ 自定义图读进来要挡住两件事（都是"看着像坏了但没有任何报错"那类）：
       ① 只认**两张雪碧都在**的那种 —— 少一张就是个空白球，而空白球在别人的
          网页上不报错、只是"那个位置什么都没有"，最难查。
       ② `char === "custom"` 但数据不全时**回退到默认角色**（不是硬渲染 custom）——
          否则用户得到一个透明的球，却以为是自己图没传好。
       ③ thumb 允许缺（设置页大不了显示个空框），不参与「算不算数」的判断。 */
  function readCustom(v) {
    var c = (v && typeof v === "object" && v.custom && typeof v.custom === "object")
      ? v.custom : null;
    if (!c) return null;
    var d = (typeof c.dirs === "string" && c.dirs) ? c.dirs : "";
    var r = (typeof c.reacts === "string" && c.reacts) ? c.reacts : "";
    if (!d || !r) return null;
    return {
      dirs: d,
      reacts: r,
      thumb: (typeof c.thumb === "string" && c.thumb) ? c.thumb : "",
      /* sig：换图时刷新，专供桌面球的快照指纹用 —— char 一直是 "custom"，
         只看 char 的话「换了一张自定义图」在球那边是**看不出变化**的。 */
      sig: (typeof c.sig === "string" && c.sig) ? c.sig : ""
    };
  }

  function readConfig(v) {
    v = (v && typeof v === "object") ? v : {};
    var custom = readCustom(v);
    var char = (typeof v.char === "string" && v.char) ? v.char : DEFAULT.char;
    /* ★ 数据没了就退回默认角色 —— 留一个 char:"custom" 的空壳等于留一个看不见的球 */
    if (char === "custom" && !custom) char = DEFAULT.char;
    return {
      on: v.on !== false,
      char: char,
      size: clampSize(v.size),
      reacts: v.reacts !== false,
      /* ★★ v0.26.0：说话开关（见 DEFAULT 上面那段）。判据必须写成
         `v.talk !== false` —— 写成 `!!v.talk` 的话，**所有老用户升级后直接静音**
         （他们没存过这个字段），而「升级完球突然不吭声了」是没人会往配置上想的现象。
         ★ 它**故意不受 `on` 门控**：普通圆球（on:false）点一下照样会说话，
           所以这个开关必须在 on 关着时也读得到、也拨得动 —— 否则就是
           Clippy 判决书里那条「用户找不到关掉它的办法」。 */
      talk: v.talk !== false,
      custom: custom
    };
  }

  root.TaskMascot = {
    create: create,
    availableChars: availableChars,
    readConfig: readConfig,
    DEFAULT: DEFAULT,
    DIRECTIONS: DIRECTIONS,
    REACTIONS: REACTIONS,
    CLOCKWISE: CLOCKWISE,
    SIZE: SIZE,
    clampSize: clampSize,
    CUSTOM: CUSTOM,
    charUrls: charUrls,
    coverRect: coverRect,
    drawAtlas: drawAtlas,
    atlasOverflow: atlasOverflow,
    readCustom: readCustom,
    moodOf: moodOf,
    MOODS: MOODS,
    MOOD_MS: MOOD_MS,
    /* 给测试用的纯函数 —— jsdom 里量不到 rect，但这两个能覆盖住核心映射 */
    _cell: cell,
    _dirOf: dirOf,
    _sectorFor: sectorFor,
    _deadZone: function (size) { return Math.max(22, size * 0.5); }
  };
})(typeof window !== "undefined" ? window : this);
