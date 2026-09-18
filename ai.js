/* ============================================================
   AI 能力（v0.16.0）—— provider 抽象层

   两种运行位置：

     ① local —— 浏览器内置模型（Chrome 138+ 的 Prompt API，模型是 Gemini Nano）
                  零 Key、零 token 费用、零网络请求、数据不出本机。
                  它的可用性**极不稳定**：要足够空闲存储 + 显存，首次还要下载多 GB。
                  所以「相当一部分用户看不到这个功能」是**正常设计**，不是降级妥协。
     ② cloud —— 用户自己填 Key 的 OpenAI 兼容端点（BYOK）。
                  内置模型用不了的机器上的唯一一条路；数据出本机由**用户主动选**。

   三条硬约束写在这里，不是写在文档里：
     H1 关掉不能有残留 —— 总开关为关时 run() 一律返回 null，
        调用方拿到的行为与 v0.15.0 逐字段一致。
     H2 Key 不进导出 JSON —— 配置存在独立的 taskboard.ai；
        而导出用的是白名单对象（app/version/view/projects/tasks），天然不含 Key。
     H3 不自动下载模型 —— availability 是 downloadable 时 run() 直接返回 null。
        只有用户在设置页显式点「下载模型」才会 create()。

   比上面三条更贵的一条（P4「宁可不说，不能说错」）：
     ★ 模型永远会给一个答案，它不会说「我不确定」。所以本模块的**所有**失败路径
       —— 不可用 / 超时 / 网络错 / 响应格式非法 / 取值越界 —— 全部收敛成同一个返回值
       null，**且不给任何提示文案**。调用方看到 null 就退回原行为，
       用户根本不知道刚才发生过什么。宁可不说，不能说错。

   还有一条贯穿全篇的设计（P4 的另一半）：**模型只出候选，代码做裁决。**
     · 日期 —— 模型不许直接给 YYYY-MM-DD，只许给「明天」「下周三」「3天后」
       这种相对词，由调用方拿现成的 NL_DATES 规则表换算。模型算日期必然会错。
     · 项目名 —— 必须在调用方给的候选列表里，不在就丢掉。
     · 优先级 —— 只认 high / mid / "" 三个值，其余丢掉。
   下面这些函数只做**格式与白名单校验**，不做任何语义换算。
   ============================================================ */
(function (global) {
  "use strict";

  var AIKEY = "taskboard.ai";

  /* 默认值。★ 总开关默认关 —— 这与 prefs 里 nlp 的「默认全开」是有意的不一致：
     nlp 是纯本机的字符串处理，开着的代价是零；而 AI 要占显存、可能要下几个 G、
     走云端时数据还要出本机。**风险不对称，默认值就不该对称。**
     设置页里给开关是为了能关掉，这里给它默认关是为了让人先想一次。 */
  var DEFAULTS = {
    on: false,
    scenes: { parse: true, weekly: true, split: false },
    where: "local",
    cloud: { base: "", model: "", key: "" },
    /* ★ v0.18.0：云端从「一个」变成「一串」。
       `where` 保留不动 —— 本机模型是**浏览器的能力**，不是一条配置；
       硬塞进列表会让「删掉本机模型」变成一个荒谬的操作。
       两条路的分工：where 选走哪条路，activeId 选路上用哪一个。 */
    models: [],
    activeId: ""
  };

  var SCENES = ["parse", "weekly", "split"];
  var WHERES = ["local", "cloud"];
  /* 系统提示词。★ 抽成常量是因为「自定义 Prompt」要**附加**在它后面 ——
     两处各写一遍的话，改一处不改另一处，用户填的 Prompt 会悄悄失效。 */
  var SYSTEM = "你是一个严谨的助手。只输出被要求的格式，不要解释，不要 markdown 代码块。";
  var TIMEOUT = 10000;          // 单次调用上限（毫秒）。超时 = 什么都没发生。
  var MAX_IN = 200;             // 送出去的正文长度上限。S1 的输入是单行，200 字够用。

  /* ---------- 存储（自带一份，不依赖调用方；扩展里走 chrome.storage，直开页面退回 localStorage） ---------- */
  var Store = {
    get: function (key) {
      if (global.chrome && chrome.storage && chrome.storage.local) {
        return chrome.storage.local.get(key).then(function (o) {
          return o[key] !== undefined ? o[key] : null;
        });
      }
      try {
        var v = global.localStorage.getItem(key);
        return Promise.resolve(v ? JSON.parse(v) : null);
      } catch (e) { return Promise.resolve(null); }
    },
    set: function (v, key) {
      if (global.chrome && chrome.storage && chrome.storage.local) {
        var o = {}; o[key] = v; return chrome.storage.local.set(o);
      }
      try { global.localStorage.setItem(key, JSON.stringify(v)); } catch (e) {}
      return Promise.resolve();
    }
  };

  /* ---------- 配置 ----------
     ★ 逐字段白名单式归一化，而不是 Object.assign 一把梭：
     存储里的值可能来自旧版本、手改的导出文件、或者别的什么。
     读的时候就把它夹成合法形状，后面所有代码就不用再判一遍。 */
  /* 一条模型配置的归一化。★ 和 readCfg 同一个思路：读的时候就夹成合法形状，
     后面所有代码（渲染、调用、测试连接）都不用再判一遍。
     ★ 全空的条目直接丢掉（返回 null），不是补一堆空串 ——
       空条目会在界面上变成一个点不动的空格子。 */
  function normModel(v, i) {
    v = (v && typeof v === "object") ? v : {};
    var base  = typeof v.base  === "string" ? v.base.trim()  : "";
    var key   = typeof v.key   === "string" ? v.key          : "";
    var model = typeof v.model === "string" ? v.model.trim() : "";
    var name  = typeof v.name  === "string" ? v.name.trim()  : "";
    if (!base && !key && !model && !name) return null;
    return {
      id: typeof v.id === "string" && v.id
        ? v.id
        : ("m" + i + "_" + Math.random().toString(36).slice(2, 7)),
      name: name || model || "未命名",
      /* prov = 快速选择里点了哪一家（只用来画那个小图标，不参与调用） */
      prov: typeof v.prov === "string" ? v.prov : "",
      base: base, model: model, key: key,
      /* ★ prompt 是**额外**附加在系统提示词后面的指令，可空。
         存成独立字段而不是拼进 base/model —— 用户改供应商时不该丢掉它。 */
      prompt: typeof v.prompt === "string" ? v.prompt : ""
    };
  }

  /* activeId 的收口：认不出来就退回第一条。
     ★ 抽成函数是因为**读盘（readCfg）和写完（saveCfg）两条路都要它**。
       只写在一边的话，删掉「当前选中的那条」之后，磁盘上会留一个指向空气的 id，
       下次打开界面就是「一条都没选中」。 */
  function fixActive(c) {
    if (!c.models.length) { c.activeId = ""; return c; }
    for (var i = 0; i < c.models.length; i++) {
      if (c.models[i].id === c.activeId) return c;
    }
    c.activeId = c.models[0].id;
    return c;
  }

  /* 当前生效的那条云端凭据。
     ★ 三级兜底：activeId 指向的 → 列表第一条 → 老的 cfg.cloud。
       老 cloud 那一级是给「迁移还没写回磁盘」的那一瞬间用的：读的时候迁移过，
       但如果调用方手里是个老对象（spread 出来的、或者缓存的），还得能跑。 */
  function activeCloud(cfg) {
    var list = (cfg && Array.isArray(cfg.models)) ? cfg.models : [];
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === (cfg && cfg.activeId)) hit = list[i];
    }
    if (!hit && list.length) hit = list[0];
    if (hit) {
      return { base: hit.base, model: hit.model, key: hit.key, prompt: hit.prompt || "" };
    }
    var c = (cfg && cfg.cloud) || {};
    return { base: c.base || "", model: c.model || "", key: c.key || "", prompt: "" };
  }

  function readCfg(v) {
    v = (v && typeof v === "object") ? v : {};
    var c = {
      /* ★ 默认值**只从 DEFAULTS 取**，不要在这里再写一遍字面量。
         写两遍的后果是：改 DEFAULTS 不起作用（它是文档），
         而读配置的人以为自己改对了 —— 变异测试正是靠这一点发现它的。 */
      on: v.on === undefined ? DEFAULTS.on : v.on === true,
      scenes: {},
      where: WHERES.indexOf(v.where) >= 0 ? v.where : DEFAULTS.where,
      cloud: {}
    };
    var sc = (v.scenes && typeof v.scenes === "object") ? v.scenes : {};
    for (var i = 0; i < SCENES.length; i++) {
      var k = SCENES[i];
      /* ★ 场景开关逐个判 undefined：写成 !!sc[k] 的话，旧配置里缺一个字段
         就会被当成「用户关掉了」，功能静默消失。 */
      c.scenes[k] = sc[k] === undefined ? DEFAULTS.scenes[k] : sc[k] === true;
    }

    var cl = (v.cloud && typeof v.cloud === "object") ? v.cloud : {};
    c.cloud.base  = typeof cl.base  === "string" ? cl.base.trim()  : "";
    c.cloud.model = typeof cl.model === "string" ? cl.model.trim() : "";
    c.cloud.key   = typeof cl.key   === "string" ? cl.key          : "";

    /* ---------- 大模型列表（v0.18.0）----------
       ★ 老配置必须原样读得出来：老版本只存 cfg.cloud 一处，
         这里只要它有东西就**迁移成列表第一条并选中**。
         不迁移的后果不是报错，是**用户的 Key 静默消失**（AI 突然不好用，
         而他不会知道为什么）—— 「没报错的错」最难查。
       ★ 迁移只发生在读的时候；写回由下一次 saveCfg 完成。
         所以 readCfg 必须是**幂等**的：已迁移过的配置再读一次，
         因为 c.cloud 也有值，会不会又造一条？
         不会 —— 迁移的前置条件是 `models 为空`。 */
    c.models = [];
    var ml = Array.isArray(v.models) ? v.models : [];
    for (var j = 0; j < ml.length; j++) {
      var m = normModel(ml[j], j);
      if (m) c.models.push(m);
    }
    c.activeId = typeof v.activeId === "string" ? v.activeId : "";
    if (!c.models.length && (c.cloud.base || c.cloud.key || c.cloud.model)) {
      var legacy = normModel({
        id: "m_legacy",
        name: c.cloud.model || "已配置的模型",
        base: c.cloud.base, model: c.cloud.model, key: c.cloud.key, prompt: ""
      }, 0);
      if (legacy) {
        c.models.push(legacy);
        c.activeId = legacy.id;
      }
    }
    return fixActive(c);
  }

  function getCfg() { return Store.get(AIKEY).then(readCfg); }

  /* 局部更新。★ 读-改-写，不是整块覆盖 ——
     整块覆盖会让「改一个开关」冲掉另一个开关，这类 bug 只在用户同时用两个功能时才现形。 */
  function saveCfg(patch) {
    return getCfg().then(function (c) {
      var next = readCfg(c);
      if (patch) {
        if (patch.on !== undefined) next.on = patch.on === true;
        if (patch.where !== undefined && WHERES.indexOf(patch.where) >= 0) next.where = patch.where;
        if (patch.scenes) for (var i = 0; i < SCENES.length; i++) {
          var k = SCENES[i];
          if (patch.scenes[k] !== undefined) next.scenes[k] = patch.scenes[k] === true;
        }
        if (patch.cloud) for (var j in patch.cloud) {
          if (patch.cloud.hasOwnProperty(j) && next.cloud.hasOwnProperty(j)) {
            next.cloud[j] = String(patch.cloud[j] == null ? "" : patch.cloud[j]);
          }
        }
        /* ★ models 是**整串替换**，不是逐项合并：增删改一条都是在页面里
           先把新数组拼好再提交。逐项合并要在这里再实现一遍「按 id 找」，
           而那个逻辑页面上本来就有 —— 两处实现迟早漂成两个版本。 */
        if (Array.isArray(patch.models)) {
          next.models = [];
          for (var n = 0; n < patch.models.length; n++) {
            var mm = normModel(patch.models[n], n);
            if (mm) next.models.push(mm);
          }
          /* ★★ 一旦 models 被显式写过，老 cloud 就**退休**（清空）。
             不清的话会有个「删不掉的幽灵」：用户把模型删光 → models 存 [] →
             下次读盘时 readCfg 看见「models 空 + cloud 还有值」→ 又迁移回来一条。
             ★ 语义：cloud 是「待迁移的老字段」，不是「另一份配置」。
               两份并存的字段迟早会有一处读错，而错的那处往往没人发现。 */
          next.cloud = { base: "", model: "", key: "" };
        }
        if (typeof patch.activeId === "string") next.activeId = patch.activeId;
        /* ★ 收口必须在**所有字段合并完**之后 —— 放在 activeId 那一行后面的话，
           同一次 patch 里「删掉当前选中的那条 + 指定新选中」会被判成「新 id 不存在」
           而退回第一条，把调用方的明确指定吞掉。 */
        fixActive(next);
      }
      return Store.set(next, AIKEY).then(function () { return next; });
    });
  }

  /* 这个场景现在能不能跑。★ 唯一入口 —— 别的地方不要自己拼判断条件，
     三处判断条件迟早会漂成三个版本。 */
  function enabled(scene, cfg) {
    if (!cfg || !cfg.on) return false;
    if (scene && cfg.scenes[scene] !== true) return false;
    return true;
  }

  /* ---------- 内置模型探测 ----------
     ★ 名字有两代，四个位置都要试：
       chrome.languageModel（扩展侧，138+ GA）/ chrome.ai.languageModel（更早的实验名）
       self.LanguageModel（网页侧）/ self.ai.languageModel（更早的实验名）
     只认一个名字的后果是：在新版浏览器上判定「不支持」，
     于是做了一整套功能却谁也看不见 —— 这是最难查的一类 bug。 */
  function lmAPI() {
    var c = (global.chrome && global.chrome.languageModel) ? global.chrome.languageModel : null;
    if (c && typeof c.create === "function") return c;
    var a = (global.chrome && global.chrome.ai && global.chrome.ai.languageModel) ? global.chrome.ai.languageModel : null;
    if (a && typeof a.create === "function") return a;
    var w = (global.LanguageModel) ? global.LanguageModel : null;
    if (w && typeof w.create === "function") return w;
    var b = (global.ai && global.ai.languageModel) ? global.ai.languageModel : null;
    if (b && typeof b.create === "function") return b;
    return null;
  }

  /* 四态：available / downloadable / downloading / unavailable。
     ★ 是一个四态而不是一个布尔。四个都要处理：
       available    → 直接用
       downloadable → 能下，但**不自动下**（H3），要用户在设置页点
       downloading  → 正在下，等着
       unavailable  → 整块不显示（设置页里也不摆灰色假入口） */
  function normAvail(v) {
    v = String(v || "");
    if (v === "available" || v === "readily") return "available";
    if (v === "downloadable" || v === "after-download") return "downloadable";
    if (v === "downloading") return "downloading";
    return "unavailable";
  }

  /* 探测。★ 只探测、永不创建 —— 光调 availability() 不会触发下载，
     这正是 H3 的实现方式：把「知道能不能用」和「开始用」拆成两件事。
     ★ capabilities() 是旧接口（返回 {available:'readily'|'after-download'|'no'}），
       availability() 是新接口（直接返回四态字符串）。两个都留着 —— 升级是渐进的，
       同一台机器上可能只有一个存在。 */
  function probeLocal() {
    var api = lmAPI();
    if (!api) return Promise.resolve("unavailable");
    try {
      if (typeof api.availability === "function") {
        return Promise.resolve(api.availability())
          .then(normAvail)
          .catch(function () { return "unavailable"; });
      }
      if (typeof api.capabilities === "function") {
        return Promise.resolve(api.capabilities()).then(function (c) {
          var a = c && (c.available !== undefined ? c.available
                       : (c.languageModel ? c.languageModel.available : undefined));
          return normAvail(a);
        }).catch(function () { return "unavailable"; });
      }
    } catch (e) {}
    return Promise.resolve("unavailable");
  }

  /* ---------- 本地会话 ----------
     缓存一个 session 复用：每次 create() 都要把模型装进内存，代价远大于一次推理。
     失败或超时后**主动销毁**（_sess = null），因为卡住的 session 会一直拖慢后面每一次。 */
  var _sess = null;

  function localSession(allowDownload) {
    if (_sess) return Promise.resolve(_sess);
    var api = lmAPI();
    if (!api) return Promise.resolve(null);
    return probeLocal().then(function (a) {
      /* ★ H3：downloadable 时绝不 create —— 那会静默触发几个 G 的下载，
         用户只会发现磁盘少了一块而不知道为什么。 */
      if (a !== "available" && !(allowDownload && a === "downloadable")) return null;
      try {
        var opts = { temperature: 0, topK: 1 };
        return Promise.resolve(api.create(opts)).then(function (s) {
          if (!s) return null;
          _sess = s;
          return s;
        }).catch(function () { return null; });
      } catch (e) { return null; }
    });
  }

  function localRun(prompt, opts) {
    /* ★ H3 的旁路就是这么堵上的：这里**写死 false**，不接受调用方传进来的任何开关。
       上一版写的是 localSession(opts && opts.allowDownload) —— 那等于给 H3 开了一道门：
       run() 是「用一次模型」，不是「决定要不要下模型」；只要哪天有人在调用点顺手写了
       allowDownload: true，就会在用户毫不知情的情况下拉几个 G。
       下载只有 downloadLocal() 一个入口，别的地方连这个参数都拿不到。 */
    return localSession(false).then(function (s) {
      if (!s) return null;
      var p;
      try {
        p = Promise.resolve(s.prompt(prompt)).then(function (t) {
          return (typeof t === "string" && t) ? t : null;
        }).catch(function () { _sess = null; return null; });
      } catch (e) { _sess = null; return null; }
      /* ★ 本地也要超时。低配机器上第一次推理能拖到十几秒，
         而两个调用点（回车后的异步修正、footer 的小结）都假定它「很快或永不回来」。 */
      return withTimeout(p, null, opts && opts.timeout);
    });
  }

  /* 用户在设置页点「下载模型」时才会走到这里。返回后 availability 会变成 available。 */
  function downloadLocal(onProgress) {
    return localSession(true).then(function (s) {
      return s ? "available" : probeLocal();
    });
  }

  /* ---------- 云端（OpenAI 兼容） ----------
     ★ 不自动补 /v1：端点风格各家不同（DeepSeek 有无 /v1 都行、OpenAI 必须带、
       自建的 ollama-oneapi 又不一样）。自动补一半的后果是「有的人能用有的人不能用」，
       而报错信息还指向我们。让用户在 UI 上填完整 base，placeholder 里给样例。 */
  function cloudRun(prompt, cfg, ms) {
    /* ★ v0.18.0：从「当前选中的那条」取凭据，而不是唯一的 cfg.cloud。
       取不到就自然落到老 cloud（见 activeCloud 的三级兜底）。 */
    var cred = activeCloud(cfg);
    var base = String(cred.base || "").replace(/\/+$/, "");
    if (!base) return Promise.resolve(null);
    if (!/^https?:\/\//i.test(base)) return Promise.resolve(null);
    var url = base + "/chat/completions";

    var ctl = null, timer = null;
    try { ctl = new AbortController(); } catch (e) {}

    var body = {
      model: cred.model || "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM + (cred.prompt ? "\n" + cred.prompt : "") },
        { role: "user", content: prompt }
      ],
      temperature: 0,             /* ★ 要确定性，不要发挥 */
      max_tokens: 200,
      stream: false
    };

    var p = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + (cred.key || "")
      },
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      if (!r || !r.ok) return null;
      return r.json();
    }).then(function (d) {
      var t = d && d.choices && d.choices[0] && d.choices[0].message
            ? d.choices[0].message.content : null;
      return (typeof t === "string" && t) ? t : null;
    }).catch(function () { return null; });

    return withTimeout(p, ctl, ms);
  }

  /* 超时。★ 超时不是「失败提示」，是「当没发生过」——
     本地模型在低配机器上第一次推理可能十几秒，等下去会把 popup 拖成卡顿的观感。
     ★ ms 是可传的：不同场景能忍的时长差很多（回车后的异步修正忍 10 秒，
       footer 那句话忍 15 秒）。写死一个常量在表面上更简单，代价是
       调用方没法表达「这个我更不急」——于是只能统一迁就最急的那个。 */
  function withTimeout(p, ctl, ms) {
    ms = ms || TIMEOUT;
    return new Promise(function (res) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        try { if (ctl) ctl.abort(); } catch (e) {}
        res(null);
      }, ms);
      p.then(function (v) {
        if (done) return;
        done = true; clearTimeout(t); res(v);
      }, function () {
        if (done) return;
        done = true; clearTimeout(t); res(null);
      });
    });
  }

  /* ---------- 沙箱：剥掉 markdown 围栏 ----------
     提示词里写了「不要代码块」，但这句话约有 20% 的概率被无视
     （不同模型、不同版本、不同温度下比例还不一样）。
     与其把提示词改得更凶，不如在收口处剥一次 —— 更省事也更可靠。 */
  function stripFence(s) {
    s = String(s == null ? "" : s).trim();
    var m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(s);
    if (m) s = m[1].trim();
    return s;
  }

  /* 只取第一个平衡的 JSON 对象。★ 不能直接 JSON.parse 整段：
     模型经常在 JSON 后面多写一句「以上」，或者在前面写「好的」。 */
  function firstJson(s) {
    s = stripFence(s);
    var i = s.indexOf("{");
    if (i < 0) return null;
    var depth = 0, inStr = false, esc = false;
    for (var j = i; j < s.length; j++) {
      var ch = s.charAt(j);
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  /* ---------- 统一入口。
     成功 → 字符串；任何失败 → null。没有第二种失败形态。 ---------- */
  function run(prompt, opts) {
    opts = opts || {};
    return getCfg().then(function (cfg) {
      if (!enabled(opts.scene, cfg)) return null;
      var text = String(prompt == null ? "" : prompt).slice(0, opts.maxIn || 4000);
      if (!text) return null;

      /* ★ 只把 timeout 透传下去，**不透传 allowDownload**（见 localRun 里的说明）。
         run() 的调用方永远没法让它下载模型 —— 这条约束靠代码形状保证，不靠自觉。 */
      if (cfg.where === "local") {
        return localRun(text, { timeout: opts.timeout });
      }
      return cloudRun(text, cfg, opts.timeout);
    }).catch(function () { return null; });
  }

  /* ============================================================
     场景 1：把一句话拆成「标题 / 相对日期词 / 项目 / 优先级」

     ★ 这个函数**只在调用方的正则一个槽位都没认出来时**才该被调用。
       正则认出了一些 = 用户在用它熟悉的写法，这时再插一层模型判断，
       出错时的归因就变成两套规则互相指认，没法修。
     ★ 日期只出相对词（「明天」「下周三」「3天后」），不出 YYYY-MM-DD ——
       模型算日期必然会错，而且错得毫无规律。换算交给调用方现成的规则表。
     ============================================================ */
  function suggestTask(raw, names) {
    names = (names || []).slice(0, 20);
    var list = names.length ? names.join("、") : "（无）";
    var prompt =
      "从下面这句话里提取任务信息，输出一个 JSON 对象，不要任何其它文字。\n" +
      "\n" +
      "句子：" + raw + "\n" +
      "\n" +
      "JSON 字段：\n" +
      "  title     任务本身要做什么，去掉时间和标记后的干净短语\n" +
      "  dateWord  时间说法，只许用这些形式：今天 / 明天 / 后天 / 大后天 / N天后 / " +
                  "周一到周日 / 下周X / 下下周X / 本周末 / 下周末 / 月底 / X月X日。" +
                  "没提到时间就填空字符串\n" +
      "  project   只能是这其中一个：" + list + "。都不是就填空字符串\n" +
      "  priority  高 / 中 / 普通。没提到就填「普通」\n" +
      "\n" +
      "只输出 JSON。";

    return run(prompt, { scene: "parse" }).then(function (t) {
      if (!t) return null;
      var o = firstJson(t);
      if (!o || typeof o !== "object") return null;

      var out = { title: "", dateWord: "", project: "", priority: "" };
      if (typeof o.title === "string") {
        /* ★ 必须把换行 / 制表符压成空格：模型在 JSON 字符串里写 \n 是合规输出，
           JSON.parse 会把它变成**真换行**，而卡片标题是单行的 ——
           一个换行就能把整张卡的版式捅穿。压平的成本是一行代码，不压平的代价是一次版式事故。 */
        out.title = o.title.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 80);
      }

      /* ★ 项目名做白名单复核 —— 提示词里给了候选，但模型仍可能编一个更像样的名字出来。
         名字对不上就不能用：这个产品的项目是用户自己建的，凭空多一个出来等于数据出错。 */
      if (typeof o.project === "string") {
        var pj = o.project.trim();
        for (var i = 0; i < names.length; i++) {
          if (names[i] && names[i] === pj) { out.project = pj; break; }
        }
      }

      if (typeof o.dateWord === "string") out.dateWord = o.dateWord.trim().slice(0, 12);

      var pr = String(o.priority == null ? "" : o.priority).trim();
      out.priority = pr === "高" ? "high" : (pr === "中" ? "mid" : "");

      /* 三个槽位全空 = 模型什么也没给出来，等于失败。 */
      if (!out.title && !out.dateWord && !out.project && !out.priority) return null;
      return out;
    });
  }

  /* ============================================================
     场景 2：给「本周完成 N 件」配一句话

     ★ 数字由代码算、措辞由模型写 —— 送进去的**只有数字，不含任何任务标题**。
       所以即使跑在云端，也没有一条内容离开本机。这是数据最小化能做到的极限。
     ★ 提示词里**明确禁止它复述数字**。这一条不是为了好看，是为了让缓存能按「周」而不是
       按「数字」来存：句子一旦不含数字，它和界面上实时变化的件数就永远不会冲突，
       于是这一周可以只问一次。否则每完成一件就要重问一次，一天几十次，
       而那点差别用户根本看不出来。
     ★ 模型返回空 / 失败 / 超时 → 调用方什么都不加，界面与 v0.15.0 完全一致。
     ============================================================ */
  function weeklyLine(s) {
    s = s || {};
    var done = Math.max(0, parseInt(s.done, 10) || 0);
    var prev = Math.max(0, parseInt(s.prev, 10) || 0);
    var today = Math.max(0, parseInt(s.today, 10) || 0);
    var hold = Math.max(0, parseInt(s.hold, 10) || 0);

    var prompt =
      "把下面这组数字写成一短句中文，不超过 18 个字。\n" +
      "数字：本周完成 " + done + " 件，上周完成 " + prev + " 件，" +
      "其中今天完成 " + today + " 件，另有挂起 " + hold + " 件。\n" +
      "要求：像同事随口说的一句，不要「恭喜」「太棒了」这种打气话，" +
      "不要 emoji，不要标点结尾的感叹号，" +
      "**不要写出任何数字**（这些数字界面上已经有了，你只需要说一句感觉）。" +
      "只输出这一句本身。";

    return run(prompt, { scene: "weekly", maxIn: 400, timeout: 15000 }).then(function (t) {
      if (!t) return null;
      var line = stripFence(t).replace(/\s+/g, " ").trim();
      /* ★ 两重夹取：长度和形状。模型爱写长句和加引号，
         而这里的位置是 footer 里的一行小字，多一个字就把布局挤歪。 */
      line = line.replace(/^["'「『]|["'」』]$/g, "").trim();
      if (!line || line.length > 24) return null;
      if (line.indexOf("\n") >= 0) return null;
      return line;
    });
  }

  /* 内置模型可用吗？设置页用它决定那块显示什么。 */
  function status() {
    return getCfg().then(function (cfg) {
      return probeLocal().then(function (a) {
        return { cfg: cfg, avail: a, hasAPI: !!lmAPI() };
      });
    });
  }

  global.AI = {
    AIKEY: AIKEY,
    DEFAULTS: DEFAULTS,
    readCfg: readCfg,
    getCfg: getCfg,
    saveCfg: saveCfg,
    enabled: enabled,
    activeCloud: activeCloud,
    normModel: normModel,
    probeLocal: probeLocal,
    downloadLocal: downloadLocal,
    run: run,
    suggestTask: suggestTask,
    weeklyLine: weeklyLine,
    status: status
  };
})(typeof window !== "undefined" ? window : this);
