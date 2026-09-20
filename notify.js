/* 任务台 · 吉祥物开口说话的规则（v0.25.0）
 *
 * 这个文件管两件事，两件都**必须只有一份**：
 *   ① 说什么 —— 把任务数据算成一组事实（facts），再变成一句话。
 *   ② 什么时候**允许**主动说 —— 四道闸门。
 *
 * ============================================================
 * 一、为什么要有这个文件（而不是散在三个调用点里）
 *
 * 「逾期」和「未完成」这两个数，界面上已经有三处各算了一遍：
 *   ballpage.js 的 openCount() / popup.js 的 diffDays()。
 * 它们口径碰巧一致（`!archived && (todo||doing)`），但那是**巧合**不是保证 ——
 * 多说一句话就多一个「球上显示 3、气泡说 2」的机会，而这类数不一致用户一定会看见。
 * 所以 facts() 是**唯一**的算法，谁要这两个数都来调它。
 *
 * ============================================================
 * 二、这个功能的产品底线（都是调研里用别人的失败换来的）
 *
 * ★★★ 提醒必须是「你动作的回声」，不能是「AI 自己的主意」。
 *     行业里唯一一条硬数据：**行为触发的通知不计入打扰预算** —— 购物车放弃提醒、
 *     发货通知，用户不嫌烦，因为**它和你自己的动作有关，是你预期它会来的**。
 *     翻译到这儿：球开口的三种合规时机，全都是「你刚做了/你刚点了」；
 *     没有任何前置动作的开口，默认就不该允许（这就是 gate() 存在的全部理由）。
 *
 * ★★★ 别让它「催你」，让它「替你动手」。
 *     「你有 3 个活没干」跟 Clippy 那句「看起来你在写信」是同一个东西 ——
 *     纯粹的索取。而「这 3 件过期了，拉回今天？」是**交换**：你看我两秒，
 *     我帮你省三十秒。所以 actionOf() 和措辞是绑在一起设计的：
 *     有逾期才配得上开口，而开口的同时必须给一个能点的动作。
 *     ★ 动作**永远由代码决定**（不进模型）—— 沿用本项目「模型只出候选、
 *       代码做裁决」的既有规矩：模型猜错一个动作，用户点下去改的是他的数据。
 *
 * ★★★ Clippy 的死刑判决书里有一条是「用户找不到关掉它的办法」。
 *     所以默认值是**关**（on: false），开关明写在设置页，而且关掉之后
 *     吉祥物**不许表现出难过** —— 那一步跨过去就是情绪操控。
 *
 * ============================================================
 * 三、四道闸门（顺序即 why 的取值顺序）
 *
 *   ① off     用户没开这个开关（默认就是没开 —— 同意必须是显式的）
 *   ② nothing 确实没有可说的内容（没有逾期）。宁可不说，不能说错。
 *   ③ recent  距上次动过任务台不到 GAP_H 小时 —— 他正在用，这时候叫他纯属添乱
 *   ④ sent    今天已经发过一条了（每天最多一条，硬上限）
 *
 *   ★ ③ 的依据是 Duolingo 那条最实用的结论：**「上次使用后 24 小时」是最佳时机**。
 *     理由朴素到好笑：你昨天下午 3 点有空，今天下午 3 点大概也有空。
 *     时机来自**行为数据**，不是 AI 的自由心证 —— 所以这个判断写死在代码里。
 *   ★ ③ 是「至少隔了这么久」而不是「正好这么久」：我们只有每小时一次的机会窗，
 *     追精确时刻没有意义，反而会为了凑时长而不发。
 */
(function (root) {
  "use strict";

  /* 通知配置。★ 与 taskboard.v1（任务数据）分开存 —— 它跟任务无关，
     而且「上次什么时候发的」这种字段混进任务数据会污染导出与飞书镜像。 */
  var KEY = "taskboard.notify";

  /* 距上次动过任务台至少这么久（小时）才允许主动开口。见抬头 ③。 */
  var GAP_H = 20;

  function max0(v) { v = parseInt(v, 10); return (isNaN(v) || v < 0) ? 0 : v; }

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function sameDay(a, b) {
    if (!a || !b) return false;
    return ymd(new Date(a)) === ymd(new Date(b));
  }

  /* ---------- 配置 ----------
     ★ `on` 的口径是**严格 true**（不是 `!== false`）。这与网页球 / 吉祥物的
       「没存过 = 开」是**故意相反的**：
         · 那两个开关决定「要不要在别人的网页上多画点东西」，用户的预期是它本来就有；
         · 这个开关决定「要不要在你不看它的时候跳出来打扰你」—— 打扰必须先被同意。
       ★ 风险不对称，默认值就不该对称。这条和 ai.js 里总开关默认关是同一条理由。 */
  function readCfg(v) {
    v = (v && typeof v === "object") ? v : {};
    return {
      on: v.on === true,
      lastAt: max0(v.lastAt)
    };
  }

  /* ---------- 事实 ----------
     从任务数据算出一组数。**所有**「逾期几件 / 还剩几件」都从这里来。

     ★ hold（挂起）一个数都不算：挂起的意思就是「这事先不占我的心力」，
       再把它推进「你还有 N 件没干」里，等于白挂。这条与 updateBadge() 一致。
     ★ 完成的沉底不算 open、也不算 over —— 逾期的定义是「该做没做」，
       已经做完的事不管日期是什么都不该出现在催办里。 */
  function facts(data, today) {
    var tasks = (data && Array.isArray(data.tasks)) ? data.tasks : [];
    var t = today || ymd(new Date());
    var over = 0, open = 0, todayN = 0, done = 0;
    /* 只留最多 3 条标题：给「点它说话」那条路用的（见 localLine）。 */
    var titles = [];
    var i, x, isOpen;
    for (i = 0; i < tasks.length; i++) {
      x = tasks[i] || {};
      if (x.archived) continue;
      if (x.status === "done") { done++; continue; }
      isOpen = (x.status === "todo" || x.status === "doing");
      if (!isOpen) continue;
      open++;
      if (x.date && x.date < t) {
        over++;
        if (titles.length < 3) titles.push(String(x.title == null ? "" : x.title).slice(0, 20));
      }
      if (x.date === t) todayN++;
    }
    return { over: over, open: open, today: todayN, done: done, titles: titles };
  }

  /* ---------- 说什么 ----------
     ★★ 这是**没有说话模型时**的那一句。它必须自己就站得住：
        模型可能没配（AI 总开关默认关）、可能超时、可能返回垃圾 ——
        三种情况下用户看到的就是这一句，而不是一个不说话也不报错的球。
        所以它不是「降级文案」，它是**正式文案**，模型句只是它的一种变体。
     ★ 与 weeklyLine 的区别：那边禁止写数字（数字界面上已经有了，重复没意义），
        这边**必须**写数字 —— 气泡是这些数字唯一的显示面。 */
  function localLine(f) {
    f = f || {};
    var over = max0(f.over);
    var open = max0(f.open);
    if (over > 0) {
      if (over === 1 && f.titles && f.titles.length) {
        return "「" + f.titles[0] + "」已过期，还留在清单上";
      }
      return over + " 件已经过期了，还留在清单上";
    }
    if (open === 0) return "今天清空了";
    if (open === 1) return "今天还剩 1 件";
    return "今天还剩 " + open + " 件";
  }

  /* ---------- 给什么动作 ----------
     ★ 只在这一种情况下给：**有逾期**。理由见抬头「别让它催你，让它替你动手」。
       没有逾期时返回 null —— 界面就不画按钮，而不是画一个点了没事干的按钮。
     ★ 动作是「拉回今天」而不是「推到明天」：逾期的意思是**该做没做**，
       拉到今天才是把它放回你的视野；推到明天只是替用户又拖了一天。 */
  function actionOf(f) {
    f = f || {};
    var over = max0(f.over);
    if (over <= 0) return null;
    return {
      kind: "today",
      label: over > 1 ? ("把 " + over + " 件拉回今天") : "拉回今天",
      count: over
    };
  }

  /* ---------- 模型优先、本地兜底 ----------
     ★ 要兜住**三条**失败路径，缺一条就是「球忽然不说话了」：
         ① AI 模块没加载 / 没配 → 本地句；
         ② speakLine 返回 null（关着 / 超时 / 网络错 / 格式非法）→ 本地句；
         ③ speakLine 直接抛 → 本地句。
       ★ 动作不参与兜底 —— 它本来就不经过模型。

     ★★★ 第 ③ 条在本版**真的漏过一次**（写成 `.then(ok, fail)` 就以为兜住了）：
       `AI.speakLine(f)` 是在 `.then()` **之前**求值的 —— 同步 throw 会直接穿过
       compose 抛给调用方，而 `.then` 的第二个参数只能接住「返回了一个 rejected
       promise」那一种。两者长得极像，差别只在「抛在返回之前」还是「抛在返回之后」。
       → 修法两层：`try { p = AI.speakLine(f) } catch` 接同步 throw，
         再 `Promise.resolve(p)` 把「返回了个 undefined」也归一成 promise。
       ★ 而静态门当时是**假绿**的：它只检查 `{ text: local, action: action }`
         这个字面量出现过 —— 而另一个分支里本来就有同一句。判据必须钉在
         「有没有那个 try」，不能钉「有没有那句兜底文案」。 */
  function compose(f, AI) {
    var local = localLine(f);
    var action = actionOf(f);
    var fallback = { text: local, action: action };
    if (!AI || typeof AI.speakLine !== "function") {
      return Promise.resolve(fallback);
    }
    var p;
    try {
      p = AI.speakLine(f);
    } catch (e) {
      return Promise.resolve(fallback);
    }
    return Promise.resolve(p).then(function (line) {
      var t = (line == null) ? "" : String(line).trim();
      return { text: t || local, action: action };
    }, function () {
      return { text: local, action: action };
    });
  }

  /* ---------- 什么时候允许主动开口（四道闸门，见抬头）----------
     ★ 返回里那条 **why 是关键**：只有布尔值的话，「为什么没发」在真机上
       永远只能靠猜，而「没发通知」这件事本身没有任何可见症状。
       带一个原因码，测试可以直接断言语义而不是断言一个 true/false。
     ★★ 判据按**严重程度**排序而不是按代码写得顺手的顺序：
        没同意 > 没内容 > 时机不对 > 今天发过。 */
  function gate(i) {
    i = i || {};
    if (i.on !== true) return { ok: false, why: "off" };
    var over = max0(i.over);
    if (over <= 0) return { ok: false, why: "nothing" };
    var gap = (Number(i.now) || 0) - (Number(i.lastUse) || 0);
    if (gap < GAP_H * 3600e3) return { ok: false, why: "recent" };
    if (i.lastAt && sameDay(i.lastAt, i.now)) return { ok: false, why: "sent" };
    return { ok: true, why: "ok", count: over };
  }

  /* ---------- 动作的实际执行（纯函数，只改传入的数组）----------
     「把逾期任务挪到今天」。返回改了几条。
     ★★ 抽出来是因为**两个地方要干同一件事**：网页球气泡上那个按钮、
        系统通知上那个按钮。各写一份的话，「哪些任务算逾期」「挂起的算不算」
        这些判断迟早漂成两个版本 —— 而它们改的是**用户的数据**，
        漂了的后果是「点网页上的按钮改了 3 条、点通知里的改了 4 条」。
     ★ hold（挂起）不动：挂起是用户明确说过「这事先别占我心力的」，
       替他把日期改了等于把他那句决定作废。
     ★ 只**改日期、不新建、不删** —— 一个「帮你干活」的动作越界成「替你决定」，
       就是 Clippy 那一格的开始。 */
  function applyToday(tasks, today) {
    if (!Array.isArray(tasks)) return 0;
    var t = today || ymd(new Date());
    var n = 0;
    for (var i = 0; i < tasks.length; i++) {
      var x = tasks[i] || {};
      if (x.archived) continue;
      if (x.status !== "todo" && x.status !== "doing") continue;
      if (x.date && x.date < t) { x.date = t; n++; }
    }
    return n;
  }

  root.Notify = {
    KEY: KEY,
    GAP_H: GAP_H,
    readCfg: readCfg,
    facts: facts,
    localLine: localLine,
    actionOf: actionOf,
    applyToday: applyToday,
    compose: compose,
    gate: gate,
    /* 给测试用的纯函数 */
    _ymd: ymd,
    _sameDay: sameDay
  };
})(typeof window !== "undefined" ? window : this);
