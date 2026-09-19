/* 九张朝向图 → 一张 3×3 雪碧（v0.28.0）
   ============================================================
   为什么单开一个文件、而不是塞进 mascot.js：
   ★ mascot.js 要跟桌面球那份**逐字节相同**（见 README「两份 mascot.js 为什么必须一样」），
     动它就得重新 copy + cargo build 桌面球。而这段逻辑**只有设置页上传时用一次** ——
     球那边（网页球 / 桌面球）从头到尾只吃最终那张 `custom.dirs`，永远不需要它。
     所以它跟 qrcode.js 同类：设置页专用、不进共享面。

   它到底解决什么：
   老路（v0.24.1）是「一张图 + 九组几何变换」烘出九个朝向 —— 身体跟着头一起转，
   而原项目实测过：身体跟着头重画 = 漂移 22%，正确画法 5%，
   **且没有任何对齐算法救得回来**（见 page-mascot 的 design-rules.md）。
   所以现在收**九张真朝向图**，这个文件负责把它们归一成同一套几何，再拼成雪碧。

   对齐凭什么钉「肩」（这是本文件最重要的一条设计）：
   ★ 九张里**头在动、身体不动**（原项目那条 "draw the BODY ONCE and reuse it"），
     所以「肩」是九张之间唯一可靠的不变量。量整个人会被「换了朝向后头探出去一点」
     带着走 —— 那正是原项目踩过的坑（量剪影高度被蓬头发骗、量头宽被大帽子骗）。
   ★ 肩带取「角色自身高度最下面 15%」，与 page-mascot 的 verify.py 量肩宽同一个比例。

   三步：
     ① 每张求「本体」（最大连通块）+ 肩带包围盒 —— 浮动符号（心/星/zzz）不算本体
     ② 在「肩心为原点」的公共坐标系里：肩同宽 → 取九张并集 → 整体缩进格子
     ③ 缺格（②A）用几何变换补：拿**最正面**的那张当底，套共享的 CUSTOM.DIRS 表
   ============================================================ */
(function (root) {
  "use strict";

  var SLOTS = 9;

  /* 肩带：角色自身高度最下面的这个比例 */
  var SHOULDER = 0.15;
  /* 判定「不透明」的 alpha 门槛（与 page-mascot 的 build.py / verify.py 同一个量级） */
  var THR = 128;
  /* 单张被放大超过这个倍数就提示换图（再大就是糊的，而不是"对齐没做对"） */
  var MAX_UP = 2.5;

  /* 缺格拿哪一格当底 —— 越正面越优先：正脸 → 左右 → 上下 → 四角。
     ★ 为什么不是「第一张」：拿一张侧面图去烘「左上/右上」会得到双份倾斜；
       正脸烘任何一格都不离谱。 */
  var BASE_ORDER = [4, 3, 5, 1, 7, 0, 2, 6, 8];

  function median(xs) {
    var a = xs.slice().sort(function (p, q) { return p - q; });
    var n = a.length;
    if (!n) return 0;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  /* 一张 alpha 图 → 本体信息。纯函数（喂一个 Uint8Array 进来就能测，不需要 canvas）。

     ★ 为什么只认**最大连通块**当本体：朝向表里可能有头顶的心心 / 星星 / zzz，
       它们跟角色不连在一起。把符号算进包围盒，角色会在恰好有符号的那几格里
       被往下压 —— 原项目 build.py 的抬头就写着这个 bug（旧的 content 档把符号
       算进了框里，"shoved the character down in exactly those cells"）。

     返回 null = 这张图整个是透明的（调用方要把它当成「这一格没给」）。 */
  function analyze(alpha, w, h, thr) {
    if (!(w > 0) || !(h > 0) || !alpha) return null;
    thr = typeof thr === "number" ? thr : THR;
    var n = w * h, i;
    var mask = new Uint8Array(n);
    for (i = 0; i < n; i++) mask[i] = alpha[i] > thr ? 1 : 0;

    var labels = new Int32Array(n);
    var sizes = [0];
    var stack = new Int32Array(n);
    var count = 0;
    for (i = 0; i < n; i++) {
      if (!mask[i] || labels[i]) continue;
      var id = ++count, sp = 0, cnt = 0;
      stack[sp++] = i; labels[i] = id;
      while (sp) {
        var p = stack[--sp]; cnt++;
        var x = p % w, y = (p - x) / w;
        if (x > 0     && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = id; stack[sp++] = p - 1; }
        if (x + 1 < w && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0     && mask[p - w] && !labels[p - w]) { labels[p - w] = id; stack[sp++] = p - w; }
        if (y + 1 < h && mask[p + w] && !labels[p + w]) { labels[p + w] = id; stack[sp++] = p + w; }
      }
      sizes[id] = cnt;
    }
    if (!count) return null;
    var best = 1;
    for (i = 2; i <= count; i++) if (sizes[i] > sizes[best]) best = i;

    var bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    for (i = 0; i < n; i++) {
      if (labels[i] !== best) continue;
      var ax = i % w, ay = (i - ax) / w;
      if (ax < bx0) bx0 = ax;
      if (ax > bx1) bx1 = ax;
      if (ay < by0) by0 = ay;
      if (ay > by1) by1 = ay;
    }
    /* 肩带 = 本体最下面 SHOULDER 那一条（行号闭区间） */
    var shTop = by1 - Math.max(0, Math.round((by1 - by0 + 1) * SHOULDER) - 1);
    if (shTop < by0) shTop = by0;
    var sx0 = w, sx1 = -1, sy0 = h, sy1 = -1;
    for (i = 0; i < n; i++) {
      if (labels[i] !== best) continue;
      var qx = i % w, qy = (i - qx) / w;
      if (qy < shTop) continue;
      if (qx < sx0) sx0 = qx;
      if (qx > sx1) sx1 = qx;
      if (qy < sy0) sy0 = qy;
      if (qy > sy1) sy1 = qy;
    }
    return {
      w: w, h: h,
      bx0: bx0, by0: by0, bx1: bx1, by1: by1,
      shX0: sx0, shX1: sx1, shY0: sy0, shY1: sy1,
      px: sizes[best]
    };
  }

  /* 九格该拿哪一张当「缺格的底」—— 全空返回 -1 */
  function pickBase(metas) {
    for (var i = 0; i < BASE_ORDER.length; i++) {
      var k = BASE_ORDER[i];
      if (metas[k]) return k;
    }
    return -1;
  }

  /* 左右对调：外两列整列换（中列不动）。
     ★ 纯数组操作，不碰任何图像 —— 所以它同时改掉「九格预览」和「烘出来的雪碧」，
       两处不可能是两套口径。
     ★ 为什么需要它：原项目 52 个角色里有 1 个是**左右画反**的，
       而那一个在 shift / palette / width / overlap 四个指标上**全绿** ——
       它是唯一一个「只能人眼看、测不出来」的缺陷（design-rules.md「A sheet can come back mirrored」）。
       修法是换格序，不是重画。 */
  function swapColumns(list) {
    var out = list.slice();
    var pairs = [[0, 2], [3, 5], [6, 8]];
    for (var i = 0; i < pairs.length; i++) {
      var a = pairs[i][0], b = pairs[i][1];
      out[a] = list[b];
      out[b] = list[a];
    }
    return out;
  }

  /* 对齐计划：把九张（metas[i] 为 null 表示这一格没给）算成画进格子的参数。

     返回 { cells: [{s, ox, oy} × 9]（缺格为 null）, base, maxUp }
       s  = 原图像素 → 格子画布的倍数
       ox / oy = 画布左上角该把原图摆在哪儿
     即调用方画 `drawImage(img, ox, oy, img.width * s, img.height * s)`。

     ★★ 为什么「肩同宽」之后还要一步整体缩放：
       光让肩同宽是没有量纲的 —— 九张各自 1024、2048 都能算，但没人保证它装得进格子。
       所以第二步在「肩心为原点」的公共坐标系里取**九张并集**，再整体缩到格子大小。
       这一步必须**九张共用一个系数**，否则每张各缩各的 = 又变成九个不同大小。
     ★ 横向不能按「肩心对齐」直接收工：头探出去的那张（looking left 会带出远侧的耳朵）
       本体左右并不对称，实测能把格子撑破 —— 所以横向上量的是**并集**，不是肩心。 */
  function alignPlans(metas, box) {
    var i, m, present = [];
    for (i = 0; i < SLOTS; i++) if (metas[i]) present.push(i);
    if (!present.length || !(box > 0)) return null;

    var shW = [], shBottom = [];
    for (i = 0; i < present.length; i++) {
      m = metas[present[i]];
      shW.push(m.shX1 - m.shX0 + 1);
      shBottom.push(m.shY1 + 1);
    }
    /* ★ 用中位数不用平均数。
       ★★★ 2026-09-19（写 `_mut_310.py` 时算出来、并用数值**验证过**）：
       这个选择在本实现里**完全观察不到** —— target 是个**全局缩放因子**，
       k_i = target / shW_i，于是并集 uw / uh 与所有 k 成正比，
       S = min(box / uw, box / uh) 与 target 成反比，最后
       **s_i = k_i · S 里 target 被约掉**（每格画出来的肩宽都等于并集拟合出来的那个值）。
       实测：把这一行换成平均数，alignPlans 的输出**逐字节相同**。
       → 所以它是**结构选择、不是行为**：留中位数是因为「不吃离群值」这个口径更稳 ——
         将来若有人把 target 当**绝对量**用（拿它去 clamp 放大倍数之类），
         中位数不会被一张裁歪的图带跑。
       ★ 但它**不可能有行为门**：谁写「中位数抗离群」的行为断言，谁就是在写假牙
         （`_test_mascotfit.js` 里那条原来就是，已改成钉「与绝对尺度无关」）。
       ★ 一句真话：真正会被「一张裁歪的图」带跑的**不是** target，而是**并集** ——
         肩窄一半 ⇒ k 翻倍 ⇒ 那一张的偏移量翻倍、独自撑大并集，九格一起变小。
         那才是这条链上真正值得防的东西，而它跟中位数无关。 */
    var target = median(shW);
    if (!(target > 0)) return null;

    var k = [], shCx = [];
    for (i = 0; i < present.length; i++) {
      k.push(target / shW[i]);
      shCx.push((metas[present[i]].shX0 + metas[present[i]].shX1 + 1) / 2);
    }

    /* 公共坐标系：x 以「肩心」为 0，y 以「肩底」为 0（于是每张的本体底边都在 y = 0） */
    var ux0 = Infinity, ux1 = -Infinity, uy0 = Infinity;
    for (i = 0; i < present.length; i++) {
      m = metas[present[i]];
      var l = (m.bx0 - shCx[i]) * k[i];
      var r = (m.bx1 + 1 - shCx[i]) * k[i];
      var t = (m.by0 - shBottom[i]) * k[i];
      if (l < ux0) ux0 = l;
      if (r > ux1) ux1 = r;
      if (t < uy0) uy0 = t;
    }
    var uw = ux1 - ux0, uh = 0 - uy0;
    if (!(uw > 0) || !(uh > 0)) return null;

    var S = Math.min(box / uw, box / uh);
    /* 并集横向居中、底部贴住格子底边 —— 底边贴齐是「一排角色一样高」那条同一个道理，
       留白由后面叠的那层 BASE 缩放统一补出来（所以这里不留 margin）。 */
    var bx = box / 2 - (ux0 + ux1) / 2 * S;
    var by = box;

    var cells = new Array(SLOTS), maxUp = 0;
    for (i = 0; i < present.length; i++) {
      m = metas[present[i]];
      var s = k[i] * S;
      if (s > maxUp) maxUp = s;
      cells[present[i]] = { s: s, ox: bx - shCx[i] * s, oy: by - shBottom[i] * s };
    }
    return { cells: cells, base: pickBase(metas), maxUp: maxUp };
  }

  /* —— 以下要真 canvas —— */

  /* 一张图 → 它的 alpha 通道。
     ★ 可选 maxSide：超过就先等比缩到这个边长再取。
       分析只需要**比例**，而 1024×1024 跑一遍连通块是 100 万像素、九张就是 900 万，
       每加一张都卡一下；缩到 480 边长后精度损失约 0.2%，
       远小于「九张各自裁切不同」本身带来的差异。
     返回 { alpha, w, h, k }，k = 实际用的缩放（1 = 没缩）。调用方要拿它把
     坐标乘回**原图尺度** —— 不乘回去的话，缩略图上量到的 30px 肩宽会被当成
     原图的 30px，整张角色缩小一圈。 */
  function alphaOf(img, maxSide) {
    var sw = img.width, sh = img.height, k = 1;
    if (maxSide > 0) {
      k = Math.min(1, maxSide / Math.max(sw, sh));
      sw = Math.max(1, Math.round(sw * k));
      sh = Math.max(1, Math.round(sh * k));
    }
    var c = root.document.createElement("canvas");
    c.width = sw; c.height = sh;
    var g = c.getContext("2d");
    if (k < 1) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; }
    g.drawImage(img, 0, 0, sw, sh);
    var d = g.getImageData(0, 0, sw, sh).data;
    var a = new Uint8Array(sw * sh);
    for (var i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
    return { alpha: a, w: sw, h: sh, k: k };
  }

  /* 分析用的最大边长（见 alphaOf 的注释） */
  var ANALYZE_MAX = 480;

  /* 一张图 → 本体信息。坐标**已乘回原图尺度**，所以调用方拿到它就跟直接
     在整张原图上量过一样。图整个是透明的 → null（等于「这一格没给」）。 */
  function metaOfImage(img, maxSide) {
    if (!img || !(img.width > 0) || !(img.height > 0)) return null;
    var r = alphaOf(img, maxSide > 0 ? maxSide : ANALYZE_MAX);
    var m = analyze(r.alpha, r.w, r.h);
    if (!m || r.k >= 1) return m;
    var q = 1 / r.k;
    return {
      w: img.width, h: img.height,
      bx0: m.bx0 * q, by0: m.by0 * q, bx1: m.bx1 * q, by1: m.by1 * q,
      shX0: m.shX0 * q, shX1: m.shX1 * q, shY0: m.shY0 * q, shY1: m.shY1 * q,
      px: m.px * q * q
    };
  }

  /* 九张图 → 一张 3×3 雪碧（**一站式**，设置页只调这一个）。
     images 长度 9，元素是图片对象或 null（= 这一格没给，走 ②A 的几何补）。

     返回 { dirs: canvas(3box), cells: [canvas(box) × 9]，缺格 undefined,
            base, maxUp } —— 拿不到计划（一张都没有）时返回 null，
     调用方据此**拒绝写配置**，而不是烘一张全空的雪碧上去。 */
  function buildDirs(images, box, maxSide) {
    var i, metas = new Array(SLOTS);
    for (i = 0; i < SLOTS; i++) metas[i] = images[i] ? metaOfImage(images[i], maxSide) : null;
    var fit = alignPlans(metas, box);
    if (!fit) return null;
    var cells = new Array(SLOTS);
    for (i = 0; i < SLOTS; i++) if (metas[i]) cells[i] = paintCell(images[i], fit.cells[i], box);
    var out = root.document.createElement("canvas");
    out.width = box * 3;
    out.height = box * 3;
    if (!paintDirs(out.getContext("2d"), cells, fit, box)) return null;
    return { dirs: out, cells: cells, base: fit.base, maxUp: fit.maxUp };
  }

  /* 一张图 → 按对齐参数画成 box×box 的格子图 */
  function paintCell(img, p, box) {
    var c = root.document.createElement("canvas");
    c.width = box; c.height = box;
    if (!img || !p) return c;
    var g = c.getContext("2d");
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, p.ox, p.oy, img.width * p.s, img.height * p.s);
    return c;
  }

  /* 一张整图 → 九张等分（①C 那条「传整张 3×3」入口）。
     ★ 这就是原项目 tiles() 的全部作用（把 sheet crop 九刀）——
       它下游的对齐**不关心**这九块来自一张图还是九个文件，所以两条入口能共用同一条路。 */
  function splitSheet(img, w, h) {
    var tw = Math.floor((w || img.width) / 3);
    var th = Math.floor((h || img.height) / 3);
    var out = [];
    if (!(tw > 0) || !(th > 0)) return null;
    for (var i = 0; i < SLOTS; i++) {
      var col = i % 3, row = (i - col) / 3;
      var c = root.document.createElement("canvas");
      c.width = tw; c.height = th;
      var g = c.getContext("2d");
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      g.drawImage(img, col * tw, row * th, tw, th, 0, 0, tw, th);
      out.push(c);
    }
    return out;
  }

  /* 小预览（格子里的缩略图）。★ 用 dataURL 而不是 objectURL：
     objectURL 得有人负责 revoke，而这条路上「换了 / 清了 / 删了」三个时机
     都要记得 revoke —— 漏一个就是内存泄漏，且肉眼永远看不出来。 */
  function thumbOf(img, px) {
    px = px || 48;
    var c = root.document.createElement("canvas");
    c.width = px; c.height = px;
    var g = c.getContext("2d");
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    if (img && img.width > 0 && img.height > 0) {
      var r = containRect(img.width, img.height, px);
      g.drawImage(img, r.x, r.y, r.w, r.h);
    }
    return c.toDataURL("image/webp", 0.75);
  }

  /* 等比缩放置中（跟 coverRect 是同一族，但这条**不裁** ——
     九张朝向图裁掉一块就是永久损失，而留白由对齐那一步自己收掉）。 */
  function containRect(iw, ih, box) {
    if (!(iw > 0) || !(ih > 0)) return { x: 0, y: 0, w: box, h: box };
    var k = Math.min(box / iw, box / ih);
    var w = iw * k, h = ih * k;
    return { x: (box - w) / 2, y: (box - h) / 2, w: w, h: h };
  }

  /* 朝向雪碧：先让共享的 drawAtlas 把「底」铺满九格（缺格就靠它），
     再把有真图的格子**覆盖**掉。
     ★★ 为什么真图也要覆盖成「BASE 缩放居中」而不是直接铺满：
       直接铺满的话，有真图的那几格是 1.0、补出来的那几格是 0.80 ——
       一转头角色就在两种大小之间跳。两边都走 BASE，才不会跳。 */
  function paintDirs(ctx, canvases, fit, box) {
    var TM = root.TaskMascot;
    var base = canvases[fit.base];
    if (!base) return false;
    TM.drawAtlas(ctx, base, TM.CUSTOM.DIRS, box);
    var inner = box * TM.CUSTOM.BASE;
    var off = (box - inner) / 2;
    for (var i = 0; i < SLOTS; i++) {
      if (!canvases[i] || !fit.cells[i]) continue;
      var col = i % 3, row = (i - col) / 3;
      ctx.clearRect(col * box, row * box, box, box);
      ctx.drawImage(canvases[i], col * box + off, row * box + off, inner, inner);
    }
    return true;
  }

  root.TaskMascotFit = {
    SLOTS: SLOTS,
    SHOULDER: SHOULDER,
    MAX_UP: MAX_UP,
    ANALYZE_MAX: ANALYZE_MAX,
    BASE_ORDER: BASE_ORDER,
    /* 纯函数（node 里不需要 canvas 就能测） */
    median: median,
    analyze: analyze,
    pickBase: pickBase,
    swapColumns: swapColumns,
    alignPlans: alignPlans,
    containRect: containRect,
    /* 要 canvas */
    alphaOf: alphaOf,
    metaOfImage: metaOfImage,
    paintCell: paintCell,
    splitSheet: splitSheet,
    thumbOf: thumbOf,
    paintDirs: paintDirs,
    buildDirs: buildDirs
  };
})(typeof window !== "undefined" ? window : this);
