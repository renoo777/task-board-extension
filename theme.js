/* theme.js —— 主题的「早期应用」+ 开关的读写（v0.18.0）
 *
 * ★★ 为什么是一个独立的小文件、而且必须在 <head> 里同步加载：
 *    MV3 禁内联脚本，所以「一读到偏好就把 data-theme 挂上」这件事没法写在 HTML 里；
 *    而如果塞进 manage.js（在 <body> 末尾），页面会**先用亮色画一遍、再跳成暗色** ——
 *    那一帧白闪在暗色下极其刺眼。<head> 里的外部 <script src> 是阻塞的，
 *    会在首次绘制之前执行完，所以「打开就是暗的」，没有过渡帧。
 *
 * ★ 为什么用 localStorage 而不是 chrome.storage：
 *    这里必须**同步**读。chrome.storage 只有异步 API，等它回来首帧早就画完了。
 *    代价是主题不参与跨设备/跨浏览器同步 —— 但那本来就是**每台机器的偏好**，
 *    不是任务数据（它绝不进导出的 JSON，和 AI 的 Key 同理）。
 *    manage 页和 popup 是同一个扩展 origin，所以两边天然共享这个键。
 *
 * ★ 认不出的值（老版本写的、手改坏的、null）一律当「没设过」→ 回落到系统设置。
 *    「–」≠「0」：坏值不是「用户选了亮色」，不该被当成一个明确的选择。
 *
 * ★ 不设「跟随系统」这个第三态：开关只有亮/暗两档（参考图就是两档）。
 *    「没表态过」时自动跟系统 —— 这是默认值，不是用户能点出来的选项。
 *    一旦用户点过，就不再跟系统：他明确选了亮色，系统入夜不该把它抢回去。
 */
(function () {
  var KEY = "taskboard.theme";
  var root = document.documentElement;

  function sysTheme() {
    try {
      return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
        ? "dark" : "light";
    } catch (e) { return "light"; }
  }

  /* 用户明确选过的值；没选过 / 值是坏的 → 空字符串。 */
  function saved() {
    var v = "";
    try { v = localStorage.getItem(KEY) || ""; } catch (e) { v = ""; }
    return (v === "light" || v === "dark") ? v : "";
  }

  // ---- 第一件事：在上面的 <style> 生效前就把属性挂上（这就是这个文件存在的全部理由）----
  root.setAttribute("data-theme", saved() || sysTheme());

  function isDark() { return root.getAttribute("data-theme") === "dark"; }

  /* 把开关的 aria / title 拉回跟实际主题一致。
     ★ 只改属性，不改文案结构 —— 无障碍状态必须和视觉状态同一份来源，
       否则会出现「看着是暗的、读屏说是亮的」。 */
  function paint() {
    var sw = document.getElementById("themeSw");
    if (!sw) return isDark();
    var dark = isDark();
    sw.setAttribute("aria-checked", dark ? "true" : "false");
    sw.setAttribute("title", dark ? "切到亮色" : "切到暗色");
    sw.setAttribute("aria-label", dark ? "当前是暗色，点一下切到亮色" : "当前是亮色，点一下切到暗色");
    return dark;
  }

  /* ★★ 主题切换（v0.23.0）：不再用 View Transitions 的圆扩散，改成**颜色令牌自己插值**。
     ★ 为什么换（实测，不是推理）：圆扩散是 clip-path 动画，而 clip-path 是**主线程**属性 ——
       每帧都要按新半径重新光栅化，成本随覆盖面积（半径的平方）增长。
       CDP 采真实帧：clip-path 那版最坏帧 33.4ms / 4 次切换掉 20 帧；
       换成颜色令牌插值（theme.css 里注册 + transition）后
       **最坏帧 16.8ms（满帧）、掉帧 0 次**，与「完全不动画」的对照组同值。
     ★ 所以这个函数现在只做一件事：**改状态**。过渡交给 CSS ——
       少一层机制就少一处会烂的地方，而且「哪一帧画什么」不再由 JS 决定。
     ★ 降级：不认 @property 的浏览器，theme.css 那条 transition 自然失效 → 颜色直接切，
       功能完整（和原来「没有 View Transitions 就直接切」是同一条原则：
       动画是锦上添花，绝不能做成「点了没反应」）。 */
  function flip() {
    /* ★★ next 从**落盘的偏好**取，不从 data-theme 取：连点两下时，
       DOM 可能还停在上一拍的值上（属性写下去到重绘之间有窗口）。
       若按 DOM 取，第二次点击会被算成「又选了一遍同一个值」——
       两次点击只翻一次，那一次选择被静静吞掉（真机量到过：同拍双击 ls 从 light 停在 dark）。
       ★ 存储是状态、DOM 是视图：判断「用户的意图」只认状态。 */
    var cur = saved() || (isDark() ? "dark" : "light");
    var next = cur === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch (e) {}
    root.setAttribute("data-theme", next);
    paint();     /* ★ 属性一变就同步 aria，不等下一帧 */
    return next;
  }

  window.Theme = {
    key: KEY,
    isDark: isDark,
    /* 用户有没有明确表态过（false = 现在跟的是系统设置） */
    chosen: function () { return saved() !== ""; },
    sync: paint,
    /* 亮 ↔ 暗。★ 颜色过渡在 CSS 里（theme.css 的令牌 transition），这里只改状态。
       ★ 入参留着但不再用（历史调用点传过开关本体）：签名变化对调用方是破坏性的，
         而它现在唯一的作用是「从哪个元素扩散」—— 那件事已经不存在了。 */
    toggle: flip
  };

  /* 系统主题变了、而用户**从没表态过** → 跟着变。
     ★ 表态过就不跟。否则「我明明选了亮色，天一黑它自己变暗了」= 用户的选择被吞掉。 */
  try {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onSys = function () { if (!saved()) { root.setAttribute("data-theme", sysTheme()); paint(); } };
    if (mq.addEventListener) mq.addEventListener("change", onSys);
    else if (mq.addListener) mq.addListener(onSys);
  } catch (e) {}

  var booted = false;
  function boot() {
    /* ★ 幂等：这个函数只该跑一次。DOMContentLoaded 被触发两次（宿主/测试里都可能）
       就会在同一个按钮上挂两遍 click —— 症状是点一次 toggle 两次，
       属性原地打转、看着像「开关偶尔失灵」。挂监听的函数一律幂等，别赌只跑一次。 */
    if (booted) return;
    booted = true;
    var sw = document.getElementById("themeSw");
    if (sw) sw.addEventListener("click", function () { window.Theme.toggle(); });
    paint();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
