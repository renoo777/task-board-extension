/* 任务台 · 浮窗宿主（v0.10.0 起；v0.13.0 去掉小球模式）
   ==================================================================
   这个页面只干一件事：持有一个 Document Picture-in-Picture 浮窗，
   把**整块任务台**（560×580）浮在整个桌面最上层。

   ★ v0.12.0 曾在这里做「小方窗里一颗小球」，v0.13.0 删掉了。原因是两条
     **浏览器画的线**（MDN 有明文，不是我们没调好）：
       ① requestWindow() 要求「调用它的那个文档」里有真实点击（transient
          activation），而扩展图标那一下的手势传不进新开的窗口
          → 最少要点两次，且第二次必须落在我们自己开的那个窗口上；
       ② 请求的宽高浏览器会「按实现夹取或忽略」→ 我们要 52×52，它给一个它认为
          合理的最小值，球外面永远剩一片空白；而且画中画窗口自带一条顶栏
          （标题就是这里设的「任务台」）→ 观感成了「一个叫任务台的空盒子跟着球一起浮」。
     小球因此搬到了网页上（content_scripts 注入的 ballpage.js）：真圆、真透明、
     零点击。想「任何界面都在」的那颗球，仍然是桌面球 exe 那条路，两条路共用同一份数据。

   为什么必须有它（三条都是实测/官方文档确认的硬约束）：
     1. 工具栏弹窗一失焦就被浏览器销毁；而官方写明画中画窗口的「生命周期永远不会
        超过打开窗口」—— 从弹窗里开浮窗，弹窗一关浮窗就跟着没了。
     2. chrome.windows.create 开的独立小窗不会被失焦影响，是唯一合适的 opener。
     3. 扩展自己的窗口永远无法置顶：`alwaysOnTop` 在 windows.create/update 里根本
        不接受，`type:"panel"` 已弃用、传进去会静默降级成 popup。
        → 想要「浮在桌面最上层」，画中画文档是唯一的路。

   浮窗里装什么（真机实测结论，见 taskboard_v10_probe）：
     · 宿主往浮窗 document 里注入 <script src="chrome-extension://...">  → 不通。
       浮窗文档 origin 是 null，脚本被当成普通网页脚本跑，没有 chrome.runtime。
     · 宿主用同源 iframe 装 popup.html                                  → 通 ✓
       iframe 里 chrome.runtime.id 正常、标题正常，等于一整套任务台零改动复用。
     所以走 iframe。

   手势问题：
     官方要求 requestWindow() 必须在真实用户手势里调用，而新开的窗口是全新文档、
     没有手势。所以这里先无声地试一次（部分分支放行），被拒就退回「点一下」形态。
     → 首次可能是点一下、也可能是点两下，取决于浏览器实现，代码两种情况都能走。

   ★★ 画中画窗口收不到「点了外面」：自动收起做不到，只能给一个显式的「收起」按钮。
      这是画中画通道天生缺的信号，跟桌面球 exe 靠窗口失焦收起（Rust 侧 OnWindowEvent）
      完全不是一回事 —— 也是「纯扩展」和「桌面程序」之间那道真实的边界，不是偷懒。

   宿主被最小化之后浮窗会怎样：不受影响。宿主此后彻底无关 ——
     浮窗里的 iframe 是挂在「浮窗自己的 document」上的独立文档，不依赖宿主的
     渲染进程存活，更不依赖宿主是否可见（探针实测：宿主 document.hidden=true 时
     iframe 里的点击回调与 chrome.storage 读取全部正常）。
     唯一需要宿主活着的事，是「浮窗被关时替它收尾」—— 见 cleanup()。
   ================================================================== */
(function () {
  "use strict";

  /* ---------- 浮什么（v0.13.0：只剩整块任务台一种）---------- */
  /* 尺寸只是**请求**：画中画窗口的最小尺寸由浏览器决定，各分支不一样。 */
  var WANT_W = 560;
  var WANT_H = 580;
  var FLOATKEY = "taskboard.float";  /* 弹窗那边靠它判断「是不是已经浮过了」 */
  var PIP_URL = chrome.runtime.getURL("popup.html") + "?pip=1";

  var dot = document.getElementById("dot");
  var ttl = document.getElementById("ttl");
  var msg = document.getElementById("msg");
  var foot = document.getElementById("foot");
  var goBtn = document.getElementById("go");
  var backBtn = document.getElementById("back");

  var myWinId = null;   /* 自己的窗口号，收尾时用 */
  var pip = null;       /* 浮窗的 window 对象 */
  var gone = false;     /* 已经收尾过了？防重入 */

  function say(title, text, state) {
    ttl.textContent = title;
    if (text != null) msg.textContent = text;
    dot.className = "dot" + (state ? " " + state : "");
  }
  function note(t) { if (foot) foot.textContent = t; }

  /* ---------- 把任务台装进浮窗 ---------- */
  function dress(w) {
    var d = w.document;
    d.title = "任务台";
    var st = d.createElement("style");
    st.textContent =
      /* 浮窗内尺寸实测比请求值各多 1px（561×581），所以 iframe 一律铺满 100%，
         不写死 560×580 —— 写死就会在右下角露一条缝。 */
      "html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#f5f6fa}" +
      "iframe{position:absolute;left:0;top:0;width:100%;height:100%;border:0;display:block}";
    d.head.appendChild(st);
    var f = d.createElement("iframe");
    f.setAttribute("src", PIP_URL);
    f.setAttribute("title", "任务台");
    d.body.appendChild(f);

    /* ★ 这里原来有一段 postMessage 通道（wan-resize / wan-close），是给 v0.12.0
       那颗「画中画小球」用的：页面改不了窗口尺寸，只能求宿主转一次 resizeTo。
       v0.13.0 小球搬到网页上之后，没有任何人再发这两条消息了 —— 留着就是死代码，
       而且「跨文件消息名两边必须逐字一致、写错了不报错」这个坑不该白白留着。
       下面 backBtn 的关闭路径照旧走 pip.close() + cleanup()。 */
  }

  /* ---------- 收尾：浮窗没了，宿主跟着退场 ----------
     不这么做的话，任务栏里会永远留一个没人认领的小窗。
     storage 里的记录也一并清掉，否则弹窗那边会以为「已经浮过了」而拒绝新开。 */
  function cleanup() {
    if (gone) return;
    gone = true;
    try { chrome.storage.local.remove(FLOATKEY); } catch (e) {}
    if (myWinId != null) {
      try { chrome.windows.remove(myWinId); } catch (e) {}
    }
  }

  /* ---------- 浮窗开了之后 ---------- */
  function afterOpen(w) {
    pip = w;
    dress(w);

    /* 感知浮窗被关。两条路都铺上：
       pagehide 是官方推荐的事件；轮询 pip.closed 兜住「pagehide 没派发」的分支。 */
    try { w.addEventListener("pagehide", cleanup); } catch (e) {}
    setInterval(function () { if (pip && pip.closed) cleanup(); }, 900);

    say("已浮在桌面上",
        "任务台已经浮在整个桌面最上层，任何界面都能点开记一笔。",
        "ok");
    note("本窗口会自动收起，从任务栏能找回来。");
    goBtn.hidden = true;
    if (backBtn) backBtn.hidden = false;

    /* 把自己藏起来 —— 桌面上只留浮窗。
       稍等一下再收（260ms）：刚创建的小窗立刻最小化，某些 Windows 版本会连焦点一起丢掉，
       浮窗跟着闪一下。 */
    if (myWinId != null) {
      setTimeout(function () {
        try { chrome.windows.update(myWinId, { state: "minimized" }); } catch (e) {}
      }, 260);
    }
  }

  /* ---------- 开浮窗 ---------- */
  function openPip() {
    return documentPictureInPicture.requestWindow({
      width: WANT_W,
      height: WANT_H,
      /* 禁掉浮窗上的「返回原窗口」按钮：宿主是藏起来的最小化小窗，
         点它会弹出一个空壳，反而让人困惑。 */
      disallowReturnToOpener: true,
      /* 交给系统按「画中画首次出现」的惯例位置摆，比硬编码坐标更合平台习惯。 */
      preferInitialWindowPlacement: true
    });
  }

  function tryOpen(onFail) {
    try {
      var p = openPip();
      if (p && typeof p.then === "function") {
        p.then(afterOpen, onFail);
      } else {
        onFail();
      }
    } catch (e) {
      onFail();
    }
  }

  /* ---------- 手动态：让用户点一下 ---------- */
  var manualArmed = false;
  function manual() {
    if (gone || pip) return;      /* 已经浮起来了就别再切回来 */
    say("需要点一下", "浏览器要求「浮起来」必须由你亲自点一次，这是它防止滥用的规矩 —— 点完就不用再点了。", "bad");
    goBtn.hidden = false;
    note("点完本窗口会自动收起，从任务栏能找回来。");

    if (manualArmed || !goBtn) return;
    manualArmed = true;
    goBtn.addEventListener("click", function () {
      goBtn.disabled = true;
      say("正在浮起来…", "稍等…", "run");
      tryOpen(function () {
        goBtn.disabled = false;
        say("没浮起来", "再点一次试试。若一直不行，说明这个浏览器版本还不支持桌面浮窗。", "bad");
        note("任务台本身不受影响，点工具栏图标照常用。");
      });
    });
  }

  /* ---------- 从任务栏点回来时：把浮窗收掉 ---------- */
  if (backBtn) {
    backBtn.addEventListener("click", function () {
      if (pip && !pip.closed) {
        try { pip.close(); } catch (e) {}
      }
      /* close() 万一没触发 pagehide，这里补一刀 */
      setTimeout(cleanup, 400);
    });
  }

  /* ---------- 启动 ---------- */
  document.title = "任务台浮窗";

  if (!("documentPictureInPicture" in window)) {
    say("这个浏览器浮不起来", "桌面浮窗需要 Chromium 116 或更新的内核（画中画文档 API）。", "bad");
    goBtn.hidden = true;
    note("任务台本身不受影响，点工具栏图标照常用。");
    return;
  }

  try {
    chrome.windows.getCurrent(function (w) {
      if (w && w.id != null) {
        myWinId = w.id;
        var p = {}; p[FLOATKEY] = { hostId: w.id, at: Date.now() };
        chrome.storage.local.set(p);
      }
      /* 先无声地试一次。有的分支允许无手势开浮窗，那就一步到位；
         被拒就走手动态。 */
      tryOpen(manual);
      /* 兜底：requestWindow 要是既不 resolve 也不 reject（挂住了），1.8 秒后照样切手动态，
         别让用户对着「正在浮起来…」干等。 */
      setTimeout(function () { if (!pip && !gone) manual(); }, 1800);
    });
  } catch (e) {
    manual();
  }
})();
