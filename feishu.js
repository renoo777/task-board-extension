/* 任务台 · 飞书多维表格（Bitable）客户端
 *
 * 这一层只管「怎么跟飞书说话」，不管「什么时候说」——同步时机与合并逻辑在 sync.js。
 *
 * 端点已逐条对过官方文档（2026-09 核对），不要凭记忆改：
 *   换 token          POST /open-apis/auth/v3/tenant_access_token/internal
 *   列记录（拉全量）  GET  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records
 *   批量新增          POST .../records/batch_create   单次上限 1000
 *   批量更新          POST .../records/batch_update   单次上限 1000
 *   批量删除          POST .../records/batch_delete   单次上限 500
 *
 * 飞书侧有三个脾气必须顺着：
 *  1) 同一个表不支持并发写（1254291）。所有写操作串行、分块、块间留延迟。
 *  2) 字段名必须完全匹配，差一个空格就是 1254045。字段名常量集中在 F，别散落到别处去。
 *  3) 字段值类型敏感：
 *       - 日期 → 毫秒时间戳（数字），不是字符串
 *       - 单选 → 写入传字符串，读回来是数组（所以 normSelect 两边都要认）
 *       - 超链接字段（text + style.url）→ 传字符串
 *     对应 toFields / fromFields 两个函数，别在这里另起一套。
 */

var Feishu = (function () {
  var API = "https://open.feishu.cn/open-apis";
  var TOKEN_CACHE = "taskboard.feishu.token";

  /* 字段名 —— 必须与多维表格里的实际列名逐字一致 */
  var F = {
    title: "任务",
    status: "状态",
    project: "项目",
    date: "日期",
    note: "备注",
    url: "链接",
    localId: "本地ID",
    createdAt: "创建时间",
    doneAt: "完成时间",
    priority: "优先级",
    order: "排序序位"
  };

  var STATUS_TEXT = { todo: "待办", doing: "进行中", done: "已完成", hold: "挂起" };
  var STATUS_BACK = { "待办": "todo", "进行中": "doing", "已完成": "done", "挂起": "hold" };

  /* 优先级：本地存 "high" / "mid" / ""（空 ＝ 默认档，也就是「普通」）。
     飞书那边用单选，且**只在真设了优先级时才写值** ——
     空就不写，那格留白 = 默认档。这样「从没设过」和「设成默认档」语义一致，
     不会因为多存了一个 "普通" 选项而把飞书表的选项表搞脏。
     第三档不进选项是有意的：三档里只有前两档需要表达「比别人重要」。 */
  var PRIORITY_TEXT = { high: "高", mid: "中" };
  var PRIORITY_BACK = { "高": "high", "中": "mid" };

  /* 分块大小：刻意压在 100，而不是用满 1000。
     官方明确提示批量过大容易触发 1254607（服务端算不过来），
     对个人任务台这种量级，多几次小请求比一次大请求翻车划算。 */
  var CHUNK = 100;
  var CHUNK_DELAY = 500;   // 块间延迟，官方建议 0.5~1s，用来躲 1254291 写冲突

  /* 可以重试的错误码：全是「稍后重试」性质的。
     永久性错误（token 错、表 id 错、字段名错、权限不足）不重试，重试也没用。 */
  var RETRY_CODES = [1254290, 1254291, 1254607, 1255001, 1255002, 1255003, 1255004, 1255005, 1255040];
  var TOKEN_BAD_CODES = [99991661, 99991663, 99991664, 99991668];
  var BACKOFF = [600, 1400, 3000];

  /* ---------- 存储通道：扩展里用 chrome.storage.local，测试里可整体替换 ---------- */
  var memory = {};
  function chromeStore() {
    return (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
  }
  var defaultStore = {
    get: function (key) {
      var cs = chromeStore();
      if (cs) {
        return new Promise(function (res) { cs.get(key, function (o) { res(o || {}); }); });
      }
      var out = {};
      if (key in memory) out[key] = memory[key];
      return Promise.resolve(out);
    },
    set: function (obj) {
      var cs = chromeStore();
      if (cs) {
        return new Promise(function (res) { cs.set(obj, function () { res(); }); });
      }
      Object.keys(obj).forEach(function (k) { memory[k] = obj[k]; });
      return Promise.resolve();
    },
    remove: function (key) {
      var cs = chromeStore();
      if (cs) {
        return new Promise(function (res) { cs.remove(key, function () { res(); }); });
      }
      delete memory[key];
      return Promise.resolve();
    }
  };

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function joinUrl(cfg, path) {
    return API + "/bitable/v1/apps/" + encodeURIComponent(cfg.baseToken) +
           "/tables/" + encodeURIComponent(cfg.tableId) + path;
  }

  /* ---------- token ---------- */
  function fetchToken(cfg) {
    return api.store.get(TOKEN_CACHE).then(function () {
      return api.rawFetch(API + "/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret })
      });
    }).then(function (r) {
      if (!r.ok) throw api.err("TOKEN_HTTP", "换取 token 失败（HTTP " + r.status + "）");
      return r.json();
    }).then(function (j) {
      if (!j || j.code !== 0 || !j.tenant_access_token) {
        throw api.err("TOKEN_FAIL", "换取 token 被拒：" + ((j && j.msg) || "未知原因") +
          "（App ID / App Secret 是否正确？应用是否已开通多维表格权限？）", j && j.code);
      }
      // 留 5 分钟余量。官方说剩余有效期小于 30 分钟时才会发新 token，
      // 所以提前 5 分钟来要，拿到的一定是新的。
      // ★ 记下是哪个 App ID 换来的：换了应用之后不能继续用上一个应用的 token。
      var rec = { token: j.tenant_access_token, appId: cfg.appId,
                  exp: Date.now() + (j.expire || 7200) * 1000 - 5 * 60 * 1000 };
      var patch = {};
      patch[TOKEN_CACHE] = rec;
      return api.store.set(patch).then(function () { return rec.token; });
    });
  }

  function getToken(cfg, force) {
    return api.store.get(TOKEN_CACHE).then(function (o) {
      var rec = o[TOKEN_CACHE];
      if (!force && rec && rec.token && rec.exp > Date.now() && rec.appId === cfg.appId) {
        return rec.token;
      }
      return fetchToken(cfg);
    });
  }

  function clearToken() {
    return api.store.remove(TOKEN_CACHE);
  }

  /* ---------- 底层请求：自动带 token、自动重试 ---------- */
  function call(cfg, method, url, body, opt) {
    opt = opt || {};
    var attempt = 0;
    var tokenRefreshed = false;

    function once() {
      return getToken(cfg).then(function (token) {
        var headers = { "Content-Type": "application/json; charset=utf-8" };
        if (token) headers.Authorization = "Bearer " + token;
        var init = { method: method, headers: headers };
        if (body !== undefined && body !== null) init.body = JSON.stringify(body);

        return api.rawFetch(url, init).then(function (r) {
          return r.json().catch(function () { return null; }).then(function (j) {
            return { http: r.status, json: j };
          });
        }).then(function (res) {
          var j = res.json;
          // token 失效：清掉缓存，原地重来一次（只给一次机会，防死循环）
          if (j && TOKEN_BAD_CODES.indexOf(j.code) >= 0 && !tokenRefreshed) {
            tokenRefreshed = true;
            return clearToken().then(function () { return once(); });
          }
          if (res.http >= 500) {
            return retryOrThrow("HTTP " + res.http + " 服务端异常");
          }
          if (!j) return retryOrThrow("响应不是合法 JSON（HTTP " + res.http + "）");
          if (j.code !== 0) {
            if (RETRY_CODES.indexOf(j.code) >= 0) return retryOrThrow(j.msg, j.code);
            throw api.err("API", describeError(j.code, j.msg), j.code);
          }
          return j.data;
        });
      });
    }

    function retryOrThrow(msg, code) {
      if (attempt >= BACKOFF.length) {
        throw api.err("RETRY_EXHAUSTED",
          "重试 " + BACKOFF.length + " 次仍失败：" + msg + (code ? "（" + code + "）" : "") +
          "。多半是同一时间操作太频繁，稍等几秒会好。", code);
      }
      var wait = BACKOFF[attempt++];
      return sleep(wait).then(once);
    }

    return once();
  }

  /* 从飞书的错误文案里抠出「申请权限」的直达链接。
     99991672 的 msg 末尾带一个 open.feishu.cn/app/<app_id>/auth?... 的 URL，
     直接甩给用户点，比让他自己去开放平台翻菜单快得多。 */
  function authUrlFrom(msg) {
    var m = /https:\/\/open\.feishu\.cn\/\S+/.exec(String(msg || ""));
    return m ? m[0] : "";
  }

  /* 把飞书错误码翻译成人话。只覆盖实际会遇到的那几个。 */
  function describeError(code, msg) {
    var m = {
      1254003: "Base token 不对（多维表格链接里 /base/ 后面那串就是）",
      1254004: "数据表 ID 不对（表名前那个 tbl 开头的串）",
      1254045: "字段名对不上。飞书要求字段名逐字一致，空格换行都算不一致 —— 检查表里的列名有没有被改过",
      1254015: "字段类型不匹配，可能是某一列被改成了别的类型",
      1254062: "单选字段值不对",
      1254064: "日期字段值不对",
      1254068: "「链接」列的值格式不对。飞书这个是超链接类型字段，要传 {link, text} 对象，" +
        "不能传裸 URL —— 如果是你自己改过这张表的结构，把「链接」列的类型检查一下",
      1254301: "这个多维表格没开高级权限，当前应用改不了",
      1254302: "权限不足：要么没在表格里给应用授权，要么应用缺少多维表格权限",
      1254303: "没有写附件的权限",
      1254103: "记录数超过 2 万条上限",
      1254608: "短时间内重复提交了同一个请求",
      1063002: "应用对这张表没权限。两种可能：① 你接的是自己手建的旧表 —— 去表格右上角「⋯」→ " +
        "更多 → 添加文档应用，把这个应用加进去并给「可编辑」；② 一键创建出来的表不该出现这个" +
        "（那张表归应用自己），真出现了就先点「测试连接」重新鉴权试试",
      1063003: "这个操作不被允许。常见原因是企业安全策略限制，或对象本身就是所有者",
      1063004: "当前身份没有分享这张表的权限",
      1066002: "飞书那边并发出错，重试一次通常就好",
      1062501: "没有操作这个文件的权限：你不是它的所有者。这个文件可能属于某个应用，" +
        "得由它自己来删",
      99991672: "应用还没开通所需权限。去开放平台「权限管理」加权限：读写任务数据要 bitable:app。" +
        "别只开 readonly —— 只读的话读表能过、写记录会挂。开完必须「创建版本并发布」才生效，" +
        "光勾选不发布等于没开",
      99991663: "应用凭据或权限有问题，自动重换 token 后仍失败，请点「测试连接」重新鉴权",
      99991664: "应用凭据或权限有问题，自动重换 token 后仍失败，请点「测试连接」重新鉴权",
      99991668: "应用凭据或权限有问题，自动重换 token 后仍失败，请点「测试连接」重新鉴权"
    };
    var base = m[code] ? m[code] : (msg || "未知错误");
    var url = authUrlFrom(msg);
    if (url) base += "。申请权限直达链接：" + url;
    return base + "（错误码 " + code + "）";
  }

  function err(type, message, code) {
    var e = new Error(message);
    e.type = type;
    e.code = code;
    return e;
  }

  /* ---------- 字段映射：本地 task ⇄ 飞书 fields ---------- */

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  /* "2026-09-14" → 本地零点毫秒时间戳。手写解析而不是 new Date(str)，
     因为 "2026-09-14" 被 JS 当 UTC 解析，东八区会退到前一天。 */
  function dateStrToMs(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
    return d.getTime();
  }

  function msToDateStr(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  /* 本地 task → 飞书 fields。只写我们管的字段，不碰任何系统字段。 */
  function toFields(t) {
    var f = {};
    f[F.title] = String(t.title == null ? "" : t.title);
    f[F.localId] = String(t.id == null ? "" : t.id);
    if (t.status && STATUS_TEXT[t.status]) f[F.status] = STATUS_TEXT[t.status];
    if (t.project) f[F.project] = String(t.project);
    var d = dateStrToMs(t.date);
    if (d !== null) f[F.date] = d;
    f[F.note] = String(t.note == null ? "" : t.note);
    /* ★「链接」在飞书里是 Url 类型字段（type 15），不是文本。
       公开的 bitable/v1 只认 {link, text} 对象 —— 传裸 URL 字符串会被拒，
       报 1254068 URLFieldConvFail。这里两种都归一成对象。
       读回来也是对象，normUrl 取 .link，所以快照比对不受 text 影响。 */
    f[F.url] = t.url ? urlCell(t.url) : null;
    if (t.createdAt) f[F.createdAt] = Number(t.createdAt);
    if (t.doneAt) f[F.doneAt] = Number(t.doneAt);
    /* 优先级：只有设过才写。单选字段写入传字符串（读回来是数组，normSelect 两边都认）。 */
    if (t.priority && PRIORITY_TEXT[t.priority]) f[F.priority] = PRIORITY_TEXT[t.priority];
    /* 排序序位：数字字段，直接传 number。没值就别写 —— 传 null 会把已有值清掉。 */
    if (typeof t.order === "number" && isFinite(t.order)) f[F.order] = t.order;
    return f;
  }

  /* 把 URL 包成飞书 Url 字段要的 CellValue。
     已测：bitable/v1 上裸串必失败、{link,text} 必成功、null 可清空。 */
  function urlCell(v) {
    if (v == null || v === "") return null;
    if (typeof v === "object" && !Array.isArray(v) && v.link) {
      return { link: String(v.link), text: String(v.text || v.link) };
    }
    var s = String(v);
    return { link: s, text: s };
  }

  /* 单选：写入传字符串，读回来是数组。两边都归一成一个字符串。 */
  function normSelect(v) {
    if (v == null) return "";
    if (Array.isArray(v)) {
      if (!v.length) return "";
      var first = v[0];
      if (typeof first === "string") return first;
      if (first && typeof first === "object") {
        return String(first.text || first.name || first.value || "");
      }
      return String(first);
    }
    if (typeof v === "object") return String(v.text || v.name || v.value || "");
    return String(v);
  }

  /* 文本类字段：可能是字符串，也可能是富文本片段数组。归一成字符串。 */
  function normText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) {
      return v.map(function (seg) {
        if (typeof seg === "string") return seg;
        if (seg && typeof seg === "object") return String(seg.text || seg.link || "");
        return "";
      }).join("");
    }
    if (typeof v === "object") return String(v.text || v.link || "");
    return String(v);
  }

  /* 超链接字段：可能是字符串，也可能是 {text, link}。归一成 URL 字符串。 */
  function normUrl(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return normUrl(v[0]);
    if (typeof v === "object") {
      if (v.link) return String(v.link);
      if (v.text && /^https?:/i.test(String(v.text))) return String(v.text);
      // text 是 Markdown 链接的情况：[标题](https://…)
      var md = /\[[^\]]*\]\((https?:\/\/[^)]+)\)/.exec(String(v.text || ""));
      if (md) return md[1];
      return String(v.text || "");
    }
    return String(v);
  }

  /* 日期字段：可能是毫秒数，也可能是 ISO 字符串。归一成毫秒数。 */
  function normMs(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      var t = Date.parse(v);
      return isNaN(t) ? null : t;
    }
    if (Array.isArray(v)) return normMs(v[0]);
    if (typeof v === "object" && v.value) return normMs(v.value);
    return null;
  }

  /* 数字字段：可能是数字，也可能是字符串。归一成数字，取不到给 null。
     ★ 别用 `Number(v) || fallback` 这种写法：序位 0 是合法值，
       被 `||` 吞掉之后会变成 fallback，序位就整列错位。 */
  function normNum(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string") {
      var n = Number(v.trim());
      return isFinite(n) ? n : null;
    }
    if (Array.isArray(v)) return normNum(v[0]);
    if (typeof v === "object" && v.value != null) return normNum(v.value);
    return null;
  }

  /* 飞书 fields → 本地 task 的「业务部分」（不含 id，id 由 本地ID 兜底生成）。
     fallback 提供兜底：飞书那边没填的字段，用本地已有值，不要被空值抹掉。 */
  function fromFields(fields, fallback) {
    fields = fields || {};
    fallback = fallback || {};
    var status = STATUS_BACK[normSelect(fields[F.status])] || fallback.status || "todo";
    var dateMs = normMs(fields[F.date]);
    var createdAt = normMs(fields[F.createdAt]);
    var doneAt = normMs(fields[F.doneAt]);
    var orderNum = normNum(fields[F.order]);
    return {
      id: normText(fields[F.localId]) || fallback.id || "",
      title: normText(fields[F.title]),
      status: status,
      project: normSelect(fields[F.project]) || fallback.project || "",
      date: dateMs ? msToDateStr(dateMs) : (fallback.date || ""),
      note: normText(fields[F.note]),
      url: normUrl(fields[F.url]),
      createdAt: createdAt || fallback.createdAt || Date.now(),
      doneAt: doneAt || null,
      /* 远端没填优先级 = 默认档，但别把本地已设的冲掉（fallback 生效）。 */
      priority: PRIORITY_BACK[normSelect(fields[F.priority])] || fallback.priority || "",
      order: orderNum === null
        ? (typeof fallback.order === "number" ? fallback.order : null)
        : orderNum
    };
  }

  /* 只取参与同步的字段，做成可比较的规范化快照。
     用途：判断「飞书那边到底改没改」。比时间戳可靠 —— 因为自己推一次
     就会刷新飞书的修改时间，用时间戳判会把「我自己写的」误判成「别人改的」。

     ★ 这里刻意不走 fromFields。fromFields 里「创建时间」缺省时会兜一个 Date.now()，
       那是给业务用的合理缺省，但拿来做快照就成了**每次调用都不一样的值** ——
       于是「飞书那条记录没填创建时间」会被永远判成「远端刚改过」，
       一直回流、一直报冲突。快照必须是纯函数：同样的字段，永远同样的串。 */
  function snapshot(fields) {
    fields = fields || {};
    var d = normMs(fields[F.date]);
    var c = normMs(fields[F.createdAt]);
    var f = normMs(fields[F.doneAt]);
    var o = normNum(fields[F.order]);
    return [
      normText(fields[F.title]),
      STATUS_BACK[normSelect(fields[F.status])] || "todo",
      normSelect(fields[F.project]),
      d ? msToDateStr(d) : "",
      normText(fields[F.note]),
      normUrl(fields[F.url]),
      c || 0,
      f || 0,
      PRIORITY_BACK[normSelect(fields[F.priority])] || "",
      o === null ? "" : o
    ].join("\u0001");
  }

  /* ---------- 记录级操作 ---------- */

  /* 拉全量记录（自动翻页）。page_size 上限 500。 */
  function listAll(cfg) {
    var out = [];
    function page(token) {
      var url = joinUrl(cfg, "/records?page_size=500" + (token ? "&page_token=" + encodeURIComponent(token) : ""));
      return call(cfg, "GET", url, null).then(function (data) {
        var items = (data && data.items) || [];
        items.forEach(function (it) {
          out.push({ recordId: it.record_id, fields: it.fields || {} });
        });
        if (data && data.has_more && data.page_token) return page(data.page_token);
        return out;
      });
    }
    return page(null);
  }

  function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /* ★ 写请求一律不带 ignore_consistency_check，这是有意为之，别再打开。
     这个参数是官方给「同表写冲突 1254291」开的性能后门，但它有代价，官方原文写得很清楚：
       true  ——「忽略读写一致性检查，提高性能，但可能会导致某些节点的数据不同步，出现暂时不一致」
       false ——「开启读写一致性检查，确保数据在读写过程中一致」（默认值）
     我们踩过这个坑：自检写完立刻读回，读到的是还没同步过来的旧副本，报「刚写进去的
     记录读不回来」，后面依赖这次读回的两步连着一块儿挂。同步那边同理 —— 你推完想马上
     在飞书网页里看到，也可能看不到，看起来就像「同步失效」。
     我们的写入量本来就小（CHUNK=100、块间还留 500ms），不靠这个参数提速；
     而「写完就能读到」是这个扩展的命脉。 */
  function seqWrite(cfg, path, wrap, items, resultKey) {
    var groups = chunk(items, CHUNK);
    var acc = [];
    var i = 0;
    function step() {
      if (i >= groups.length) return acc;
      var g = groups[i++];
      var url = joinUrl(cfg, path);
      return call(cfg, "POST", url, wrap(g)).then(function (data) {
        var got = (data && resultKey && data[resultKey]) || [];
        acc = acc.concat(got);
        if (i < groups.length) return sleep(CHUNK_DELAY).then(step);
        return acc;
      });
    }
    return items.length ? step() : Promise.resolve([]);
  }

  /* 批量新增。返回 [{record_id, fields}]，用来回填 recordId。 */
  function batchCreate(cfg, tasks) {
    var recs = tasks.map(function (t) { return { fields: toFields(t) }; });
    return seqWrite(cfg, "/records/batch_create", function (g) { return { records: g }; }, recs, "records")
      .then(function (got) {
        return got.map(function (r) { return { recordId: r.record_id, fields: r.fields || {} }; });
      });
  }

  /* 批量更新。pairs = [{recordId, task}] */
  function batchUpdate(cfg, pairs) {
    var recs = pairs.map(function (p) { return { record_id: p.recordId, fields: toFields(p.task) }; });
    return seqWrite(cfg, "/records/batch_update", function (g) { return { records: g }; }, recs, "records")
      .then(function (got) {
        return got.map(function (r) { return { recordId: r.record_id, fields: r.fields || {} }; });
      });
  }

  /* ---------- 原始 fields 写入（v0.32.0：团队派发表用）----------
     ★★ 为什么另开两个函数，而不是给 batchCreate 加个「字段集」参数：
        团队表的列名与个人的那张**不是同一套**（多了「接收人」「派发人」），
        而 toFields() 认的是模块级常量 F —— 给它传参意味着每条调用都要想
        「这次用哪套」，一旦漏传就静默写进个人表的字段名里（1254045 才报，
        而且报的是「字段不存在」，看不出是传错了）。
        开两个只吃**原始 fields** 的函数，团队表那条路从头到尾不碰 F，
        两套字段集物理隔离，不存在「这次用哪套」这个问题。
     ★ 复用 seqWrite：分块、块间延迟、重试那些脾气跟个人表是同一套，
       不在这里另写一份。 */
  function createRaw(cfg, fieldsArr) {
    var recs = (fieldsArr || []).map(function (f) { return { fields: f || {} }; });
    return seqWrite(cfg, "/records/batch_create", function (g) { return { records: g }; }, recs, "records")
      .then(function (got) {
        return got.map(function (r) { return { recordId: r.record_id, fields: r.fields || {} }; });
      });
  }

  /* pairs = [{recordId, fields}]
     ★★ 只传**要改的那几列**（v0.32.0 铁律 486）：飞书 batch_update 是
        按传入的列做覆盖写的，把整行 fields 传回去会**静默盖掉**别人在你
        读取之后改的那一列（比如派发人刚把日期改了，你回写整行就把它改回去），
        而且不报任何错。所以调用方只准传增量。 */
  function updateRaw(cfg, pairs) {
    var recs = (pairs || []).map(function (p) { return { record_id: p.recordId, fields: p.fields || {} }; });
    return seqWrite(cfg, "/records/batch_update", function (g) { return { records: g }; }, recs, "records")
      .then(function (got) {
        return got.map(function (r) { return { recordId: r.record_id, fields: r.fields || {} }; });
      });
  }

  /* 批量删除。上限 500，CHUNK 是 100，安全。 */
  function batchDelete(cfg, recordIds) {
    return seqWrite(cfg, "/records/batch_delete", function (g) { return { records: g }; }, recordIds, null)
      .then(function () { return recordIds.length; });
  }

  /* ---------- 自检：把每种字段类型都真写一遍 ----------
     本机没有 App Secret 时这条链路测不了，所以做成按钮让使用者一次验完。
     只要有任何一种字段类型写错，这里会立刻抛出带错误码的明确提示。

     ★ 两条设计纪律，都是踩出来的，别退回旧写法：
       1) 每一步只用**它自己造出来的证据**，不复用「上一步碰巧留下的东西」。
          读回要比对的那条记录，就用写入时返回的 record_id 去找 —— 而不是把整张表
          拉回来、再按「本地ID」这一列的文本去猜哪条是刚写的。后者一旦匹配不上，
          就只剩一句含糊的「读不回来」，看不出到底哪一环断了。
       2) 失败判据要落到**业务字段**（标题/状态/日期/链接），不要拿对账用的内部键
          当唯一判据 —— 那样会把「字段类型映射错了」和「读写一致性没守住」
          两种完全不同的问题混成同一句话。 */
  function selftest(cfg) {
    var report = [];
    var probeId = "selftest-" + Date.now().toString(36);
    var probe = {
      id: probeId, title: "任务台自检（可删）", status: "doing", project: "工作",
      date: msToDateStr(Date.now()), note: "由任务台自检写入，若你看到这条说明清理失败，直接删掉即可",
      url: "https://open.feishu.cn", createdAt: Date.now(), doneAt: null,
      priority: "high", order: 7
    };
    var createdId = null;
    var leftovers = [];      // 上一轮自检没清干净的探针
    var total = 0;

    function ok(name, extra) { report.push({ name: name, ok: true, detail: extra || "" }); }
    function fail(name, e) { report.push({ name: name, ok: false, detail: (e && e.message) || String(e) }); }
    function isProbe(fields) { return normText(fields[F.localId]).indexOf("selftest-") === 0; }

    /* 逐字段比对。label 用来区分是「写入回显」还是「读回来的」，
       这样报告能直接指出断在哪一段。 */
    function verify(fields, label) {
      var back = fromFields(fields, {});
      if (back.title !== probe.title) throw err("SELFTEST", label + "：标题不一致（拿到「" + back.title + "」）");
      if (back.status !== "doing") throw err("SELFTEST", label + "：单选「状态」不一致（拿到「" + back.status + "」，说明单选字段没写进去）");
      if (back.date !== probe.date) throw err("SELFTEST", label + "：日期不一致（拿到「" + back.date + "」，日期要传毫秒时间戳）");
      if (String(back.url).indexOf("open.feishu.cn") < 0) throw err("SELFTEST", label + "：超链接不一致（拿到「" + back.url + "」，该列要 {link,text} 对象）");
      if (back.priority !== "high") throw err("SELFTEST", label + "：单选「优先级」不一致（拿到「" + back.priority + "」）");
      // 序位用 7 而不是 0：0 是合法值，拿 0 当探针就分不清「没写进去」和「写进去了是 0」
      if (back.order !== 7) throw err("SELFTEST", label + "：数字「排序序位」不一致（拿到「" + back.order + "」）");
      var lid = normText(fields[F.localId]);
      if (lid !== probeId) throw err("SELFTEST", label + "：本地ID 不一致（拿到「" + lid + "」）");
      return back;
    }

    /* 按 record_id 把刚写的那条找回来。找不到就等 1.2 秒再试一次：
       真出现过「写完立刻读读不到」的暂时不一致，重试一次能兜住。 */
    function readBack() {
      function find() {
        return listAll(cfg).then(function (items) {
          total = items.length;
          var hit = items.filter(function (i) { return i.recordId === createdId; })[0];
          if (hit) return hit;
          return null;
        });
      }
      return find().then(function (hit) {
        if (hit) return hit;
        return sleep(1200).then(find).then(function (again) {
          if (again) return again;
          throw err("SELFTEST",
            "写入时拿到了 record_id（" + createdId + "），但读回时表里找不到它；" +
            "这张表当前共 " + total + " 条记录。若稍后它自己又出现了，说明读写一致性被跳过了 —— " +
            "写请求不该带 ignore_consistency_check=true");
        });
      });
    }

    return clearToken()                                  // 强制重新鉴权，顺便验证 App ID / Secret
      .then(function () { return getToken(cfg, true); })
      .then(function () { ok("换取 tenant_access_token"); })
      .catch(function (e) { fail("换取 tenant_access_token", e); throw e; })
      /* 先保证表结构齐（缺列就顺手补上）。
         放在最前面是为了挡掉误诊：缺列时后面会撞一串 1254045，
         而那句报错只说「字段名对不上」，不看这一步根本想不到是列不存在。 */
      .then(function () { return ensureFields(cfg); })
      .then(function (r) {
        if (!r.ok) throw err("SELFTEST", describeEnsure(r));
        ok("检查表结构", r.added.length
          ? ("自动补了 " + r.added.join("、") + " 列")
          : ("字段齐全（" + FIELD_SCHEMA.length + " 列）"));
      })
      .catch(function (e) { fail("检查表结构", e); throw e; })
      .then(function () { return listAll(cfg); })
      .then(function (items) {
        total = items.length;
        leftovers = items.filter(function (i) { return isProbe(i.fields); })
          .map(function (i) { return i.recordId; });
        ok("读取数据表", "当前已有 " + total + " 条记录" +
          (leftovers.length ? "，其中 " + leftovers.length + " 条是上次自检没清掉的探针（这次顺带清掉）" : "") +
          "　·　" + cfg.baseToken.slice(0, 8) + "…/" + cfg.tableId);
      })
      .catch(function (e) { fail("读取数据表", e); throw e; })
      .then(function () { return batchCreate(cfg, [probe]); })
      .then(function (recs) {
        var r = recs[0] || {};
        createdId = r.recordId;
        if (!createdId) throw err("SELFTEST", "写入成功但没拿到 record_id");
        // 写入接口会把存进去的字段回显回来 —— 这就能验「四种字段类型都写得进」，
        // 不必依赖后面那次读回（两件事分开报，才不会一挂全挂）。
        verify(r.fields || {}, "写入回显");
        ok("写入记录（覆盖文本/单选/日期/超链接/数字五种字段类型）");
      })
      .catch(function (e) { fail("写入记录（覆盖文本/单选/日期/超链接/数字五种字段类型）", e); throw e; })
      .then(readBack)
      .then(function (hit) {
        verify(hit.fields, "读回");
        ok("读回并逐字段比对", "标题/状态/日期/链接/本地ID 全部一致");
      })
      .catch(function (e) { fail("读回并逐字段比对", e); throw e; })
      .then(function () {
        var changed = JSON.parse(JSON.stringify(probe));
        changed.title = probe.title + " · 已改";
        changed.status = "hold";
        return batchUpdate(cfg, [{ recordId: createdId, task: changed }]);
      })
      .then(readBack)
      .then(function (hit) {
        var back = fromFields(hit.fields, {});
        if (back.status !== "hold") throw err("SELFTEST", "改状态没生效，读回来还是 " + back.status);
        if (back.title.indexOf("已改") < 0) throw err("SELFTEST", "改标题没生效，读回来是 " + back.title);
        ok("更新记录（改标题与状态）");
      })
      .catch(function (e) { fail("更新记录（改标题与状态）", e); throw e; })
      .then(function () { return batchDelete(cfg, [createdId].concat(leftovers)); })
      .then(function () {
        ok("删除记录（清理探针）", leftovers.length ? "连同上次残留的 " + leftovers.length + " 条一起清掉了" : "");
      })
      .catch(function (e) { fail("删除记录（清理探针）", e); throw e; })
      .then(function () {
        return { ok: report.every(function (r) { return r.ok; }), steps: report };
      }, function () {
        // 出错时也尽力清掉探针，别在人家表里留垃圾。
        // ★ 清理失败必须说出来 —— 否则表里会悄悄多一条记录，下一轮自检的
        //   记录数又多 1，人会以为「谁动了我的表」。
        var kill = [createdId].concat(leftovers).filter(Boolean);
        var cleanup = kill.length ? batchDelete(cfg, kill).catch(function (ce) {
          report.push({
            name: "清理探针", ok: false, optional: false,
            detail: "探针没删掉（" + ((ce && ce.message) || "未知原因") + "）。你表里会留下标题为" +
              "「任务台自检（可删）」的记录，手动删掉即可；留着也不影响使用"
          });
        }) : Promise.resolve();
        return cleanup.then(function () {
          return { ok: false, steps: report };
        });
      });
  }

  /* ---------- 一键创建多维表格 ----------
     给新同事用的：填好 App ID / App Secret，点一下把表建出来，
     连同 base_token 和 table_id 一起填回设置页，不用自己去搓 9 个字段。

     ★ 建表要什么权限：只要 bitable:app。不需要邮箱、不需要用户身份、
       也不需要「把应用加进表」那一步。

     ★ 有一件事必须知道：应用身份（tenant_access_token）建出来的多维表格，
       所有权属于**应用**（飞书官方新手教程明文），也就是说 ——
       扩展自己读写这张表毫无问题（应用就是所有者），
       但人打开飞书网页时默认只能看、不能改。想「在飞书里手动改数据」就会卡在这。
       补法有两个：
         ① 用邮箱把某个账号加成协作者 —— 要先知道他是谁，还得让他填邮箱，啰嗦；
         ② 把这张表的链接分享设成「组织内获得链接的人可编辑」—— **不需要知道你是谁**。
       走 ②。应用本身就是所有者，有资格改自己这张表的分享设置。

     四个请求都走应用身份，复用同步那套 token 缓存与重试（call）。 */

  /* 字段定义。type 编号已对官方文档《字段编辑指南》逐条核实（2026-09-14）：
       1=文本  2=数字  3=单选  4=多选  5=日期  7=复选框  15=超链接
     编号写错飞书不一定报错，可能静默建成别的类型（数字列变成文本列之类），
     所以逐条对着 F 写，别手抄数字；补完列后还要回读校验一次 type —— 见 ensureFields。

     ★ 15（超链接）的 property 必须是 null：官方原文列的「没有其他功能属性」清单里就有它。 */
  var FIELD_SCHEMA = [
    { field_name: F.title, type: 1 },
    { field_name: F.status, type: 3, property: { options: [
      { name: "待办" }, { name: "进行中" }, { name: "已完成" }, { name: "挂起" }] } },
    { field_name: F.project, type: 3, property: { options: [
      { name: "工作" }, { name: "个人" }, { name: "学习" }, { name: "生活" }] } },
    { field_name: F.date, type: 5, property: { date_formatter: "yyyy/MM/dd", auto_fill: false } },
    { field_name: F.note, type: 1 },
    { field_name: F.url, type: 15 },
    { field_name: F.localId, type: 1 },
    { field_name: F.createdAt, type: 5, property: { date_formatter: "yyyy/MM/dd HH:mm", auto_fill: false } },
    { field_name: F.doneAt, type: 5, property: { date_formatter: "yyyy/MM/dd HH:mm", auto_fill: false } },
    /* v0.7.0 新增。优先级只给「高 / 中」两个选项 —— 默认档不设选项，
       理由见 PRIORITY_TEXT 那段。 */
    { field_name: F.priority, type: 3, property: { options: [{ name: "高" }, { name: "中" }] } },
    { field_name: F.order, type: 2, property: { formatter: "0" } }
  ];

  var BASE_NAME = "任务台";
  var TABLE_NAME = "任务";

  /* 建一个空的多维表格。飞书会自动塞一张平台默认表，id 在 default_table_id 里。 */
  function createBase(cfg, name) {
    return call(cfg, "POST", API + "/bitable/v1/apps", { name: name || BASE_NAME })
      .then(function (d) {
        var app = (d && d.app) || {};
        if (!app.app_token) throw err("CREATE_BASE", "飞书没有返回 app_token");
        return {
          appToken: app.app_token,
          defaultTableId: app.default_table_id || "",
          url: app.url || ""
        };
      });
  }

  /* 建数据表 + 全套字段。一次请求建完一整列，比一列一列加稳。
     ★ v0.33.0：第 4 个参数 schema 可以传**另一套字段集** —— 团队派发要在同一个
       Base 里建两张表（任务 / 组员），字段集跟个人表不是同一套。不传就还是
       FIELD_SCHEMA，老调用点一个字都不用改。
     ★ 为什么字段必须在**建表这一次请求**里带上，而不是建完空表再补列：
       分两步做，中途失败会在用户的 Base 里留一张空表 ——
       而他看见的只是「我的表里多了一张没用的」，根本不知道是半截产物。 */
  function createTable(cfg, appToken, name, schema) {
    var url = API + "/bitable/v1/apps/" + encodeURIComponent(appToken) + "/tables";
    return call(cfg, "POST", url, {
      table: { name: name || TABLE_NAME, fields: schema || FIELD_SCHEMA }
    }).then(function (d) {
      if (!d || !d.table_id) throw err("CREATE_TABLE", "飞书没有返回 table_id");
      return d.table_id;
    });
  }

  function dropTable(cfg, appToken, tableId) {
    var url = API + "/bitable/v1/apps/" + encodeURIComponent(appToken) +
      "/tables/" + encodeURIComponent(tableId);
    return call(cfg, "DELETE", url, null);
  }

  /* 把这张表设成「组织内拿到链接的人都能编辑」。
     ★ 为什么不走邮箱：见上面的说明 —— 扩展读写这张表本来就不需要任何额外授权
       （应用是所有者）。缺的只是「人手动在飞书网页改」这一件事，
       而这件事不需要知道他是谁，改分享设置就够了。
     ★ 端点：现行的公开文档是 drive/v2/permissions/:token/public?type=bitable。
       少数租户只认 v1，所以兜一层；两次都失败就把后一个错误抛出去。
     ★ 可选步骤：这个函数失败不代表建表失败，调用方负责降级成一行提示。 */
  function setLinkEditable(cfg, appToken) {
    var body = { link_share_entity: "tenant_editable" };
    var path = "/permissions/" + encodeURIComponent(appToken) + "/public?type=bitable";
    return call(cfg, "PATCH", API + "/drive/v2" + path, body)
      .then(null, function () {
        return call(cfg, "PATCH", API + "/drive/v1" + path, body);
      });
  }

  /* 把这张多维表格的**归属**转给某个人（v0.34.0）。
     ★★★ 为什么非有它不可（老大真机反馈的原话：「我的飞书账号没有编辑跟管理权限，
       我需要一键创建多维表格，多维表格的归属人是我」）：
       应用（tenant_access_token）建的云文档**归应用自己**，人在飞书里只是
       「被邀请的协作者」。上一版靠 setLinkEditable 把链接设成「组织内可编辑」——
       那确实让人**能改**，但**所有者仍然不是他**：看不到管理入口、改不了权限、
       也移不走这个文档。要「归属人是我」只有转移所有者这一条路。
     ★ 谁能调：接口要求**调用身份必须是该文档的所有者** —— 应用正好是，
       所以这条路不需要用户做任何额外授权、也不需要知道他是谁。
     ★★ `remove_old_owner` **故意不传**（默认 false）：转移后应用保留
       `old_owner_perm`（默认 full_access）——不保留的话一转完扩展自己就写不进去了，
       症状是「归属对了，但派发/回写全失败」，而且看起来像权限没配好。
     ★ `need_notification=false`：这是他自己点的按钮，不必再收一条系统通知。
     ★ member_type 支持 email / openid / userid：
       email 是**唯一不需要先知道 open_id** 的一种（所以「我记得我的邮箱」就够）；
       openid 则从组员表的人员字段里读（见 inbox.js provision 的最后一步）。 */
  function transferOwner(cfg, appToken, memberType, memberId) {
    var mt = String(memberType == null ? "" : memberType).trim() || "email";
    var mid = String(memberId == null ? "" : memberId).trim();
    if (!mid) return Promise.reject(err("TRANSFER_OWNER", "没给新的所有者"));
    if (!appToken) return Promise.reject(err("TRANSFER_OWNER", "没给多维表格的 token"));
    var url = API + "/drive/v1/permissions/" + encodeURIComponent(appToken) +
      "/members/transfer_owner?type=bitable&need_notification=false";
    return call(cfg, "POST", url, { member_type: mt, member_id: mid });
  }

  /* 列出某个 base 下的数据表。用于「粘了链接但链接里没带 table 参数」时自动补全。 */
  function listTables(cfg, appToken) {
    var url = API + "/bitable/v1/apps/" + encodeURIComponent(appToken) + "/tables?page_size=100";
    return call(cfg, "GET", url, null).then(function (d) {
      return ((d && d.items) || []).map(function (t) {
        return { tableId: t.table_id, name: t.name };
      });
    });
  }

  /* ---------- 表结构：读、建、自动补齐 ---------- */

  /* 列出表里已有的字段（含 type，用来校验）。自动翻页。 */
  function listFields(cfg) {
    var out = [];
    function page(tok) {
      var url = joinUrl(cfg, "/fields?page_size=200" +
        (tok ? "&page_token=" + encodeURIComponent(tok) : ""));
      return call(cfg, "GET", url, null).then(function (d) {
        ((d && d.items) || []).forEach(function (it) {
          out.push({ name: String(it.field_name || ""), type: it.type, uiType: it.ui_type || "" });
        });
        if (d && d.has_more && d.page_token) return page(d.page_token);
        return out;
      });
    }
    return page(null);
  }

  /* 建一列。★ 字段创建接口一次只收**一个**字段对象，不是数组 ——
     别照抄建表接口那种 { table: { fields: [...] } } 的形状。 */
  function createField(cfg, field) {
    return call(cfg, "POST", joinUrl(cfg, "/fields"), field);
  }

  /* 把「字段不齐」翻译成一句能照做的话。 */
  function describeEnsure(r) {
    if (!r) return "表结构检查没有返回结果";
    var bits = [];
    if (r.failed && r.failed.length) {
      bits.push("有 " + r.failed.length + " 列没建上（" + r.failed.map(function (f) {
        return f.name + "：" + f.why;
      }).join("；") + "）");
    }
    if (r.missing && r.missing.length) bits.push("表里还缺：" + r.missing.join("、"));
    if (r.badType && r.badType.length) {
      bits.push("类型不对：" + r.badType.map(function (b) {
        return b.name + "（应为 type " + b.want + "，实际 " + b.got + "）";
      }).join("、"));
    }
    return "表结构不齐 —— " + bits.join("；") +
      "。补列需要应用有 bitable:app 权限（只开 readonly 建不了列），且不能在权限上只给「可阅读」。";
  }

  /* ★ 自动补列：老表（含手建的 9 列表）没有「优先级」「排序序位」两列，
     而 v0.7.0 起要写它们。不补的话写入会报 1254045（字段名对不上），
     而且报错文案只说「字段名对不上」，人第一反应是「谁改了列名」——
     实际是那列压根不存在。这是个很贵的误诊，所以在同步前置里挡掉。

     三条纪律：
       ① 先 GET 读一遍现有列。列都齐就一个请求都不多发（零成本）。
       ② 补完**必须回读校验 type**。写错编号飞书不一定报错，可能静默建成别的
          类型（数字列变文本列），此后读写全是脏数据 —— 这一步是唯一能抓住
          那种静默失败的地方。
       ③ 这是「前置条件」：补不上就返回 ok:false，让调用方明确失败并说清缺哪列，
          而不是揣着一列不存在的字段去撞一串 1254045。

     返回 { ok, added[], missing[], failed[], badType[] }。 */
  function ensureFields(cfg) {
    function audit(byName, added, failed) {
      var absent = [], badType = [];
      FIELD_SCHEMA.forEach(function (fd) {
        var got = byName[fd.field_name];
        if (!got) { absent.push(fd.field_name); return; }
        if (got.type !== fd.type) {
          badType.push({ name: fd.field_name, want: fd.type, got: got.type });
        }
      });
      return {
        ok: !absent.length && !badType.length && !(failed && failed.length),
        added: added || [], missing: absent, failed: failed || [], badType: badType
      };
    }

    function index(items) {
      var m = {};
      (items || []).forEach(function (f) { m[f.name] = f; });
      return m;
    }

    return listFields(cfg).then(function (before) {
      /* ★ 读回来 0 列 = 读取有问题，不是「这张表是空的」。
         任何多维表格至少有一列（主键列），所以空列表只可能是分页没走完、
         或应用只被授权看见一部分字段。这时若照常往下走，就会以为「11 列全缺」，
         然后往人家好好的表里建 11 列 —— 其中「任务」很可能已经存在。
         宁可在这里停住，把表原样留给用户。 */
      if (!before.length) {
        throw err("ENSURE",
          "读字段列表返回 0 列。任何多维表格至少有一列主键列，所以这不是「表是空的」，" +
          "而是读取出了问题（分页没走完，或应用只能看到部分字段）。已停下，没有改这张表的结构");
      }
      var byName = index(before);
      var missing = FIELD_SCHEMA.filter(function (fd) { return !byName[fd.field_name]; });
      if (!missing.length) return audit(byName, [], []);

      var added = [], failed = [];
      var i = 0;
      function step() {
        if (i >= missing.length) return Promise.resolve();
        var fd = missing[i++];
        return createField(cfg, fd).then(function () {
          added.push(fd.field_name);
          return sleep(200).then(step);      // 串行 + 间隔，躲同表写冲突
        }, function (e) {
          // 一列失败不拦后面的：能补多少补多少，最后一次性报清楚缺什么
          failed.push({ name: fd.field_name, why: (e && e.message) || String(e) });
          return step();
        });
      }
      return step().then(function () {
        if (failed.length) return audit(byName, added, failed);
        // ② 回读校验真实类型
        return listFields(cfg).then(function (after) {
          return audit(index(after), added, []);
        });
      });
    });
  }

  /* ★ 反查一张多维表格的「网址」和「名字」。
     为什么需要它：网址只在「创建多维表格」的响应里出现过，而 v0.6.6 之前的版本
     根本没存 —— 于是升级之后，设置页「底表」那一行的两个按钮拿不到网址，
     早年又写成「没网址就 disabled」，结果点上去一点反应都没有（v0.6.7 修）。

     走的是 Drive 的 metas/batch_query。★ 别改用 bitable 的「获取多维表格元数据」
     （GET /bitable/v1/apps/:app_token）—— 那个接口**不返回 url**，实测响应里只有
     app_token / name / revision / is_advanced / time_zone，白跑一趟。

     ★ 这是「尽力而为」的一条路：它要 Drive 的读权限，只开了 bitable:app 的应用可能被拒。
       所以失败一律 resolve(null)，绝不 throw —— 调用方拿到空就给人话提示，别把它当致命错。 */
  function metaUrl(cfg, appToken) {
    if (!appToken) return Promise.resolve(null);
    var body = { request_docs: [{ doc_token: appToken, doc_type: "bitable" }], with_url: true };
    return call(cfg, "POST", API + "/drive/v1/metas/batch_query", body).then(function (d) {
      var m = ((d && d.metas) || [])[0];
      if (!m || !m.url) return null;
      return { url: m.url, title: m.title || "" };
    }, function () { return null; });
  }

  /* 一步到位。返回 {appToken, tableId, tableName, url, steps[], ok, error}。
     ★ 分步留痕：三步的失败原因完全不同（权限 / 字段 / 邮箱），
       报告里能看出卡在哪一步，比一句「创建失败」有用得多。
     ★ 这里不 throw：让设置页把已完成的步骤照常展示出来。
     ★ url / tableName 要带回去存进配置 —— 有了它们，设置页就能直接给出
       「在飞书打开这张表」的入口，用户不用自己去飞书里翻是哪张表。 */
  function provision(cfg, opts) {
    opts = opts || {};
    var steps = [];
    var out = { appToken: "", tableId: "", tableName: "", url: "", steps: steps, ok: false, error: "" };
    /* optional=true 的步骤失败不算「建表失败」，报告里单独标一档，
       别让「加个可选的分享设置没设上」看起来像整件事挂了。 */
    function rec(name, ok, detail, optional) {
      steps.push({ name: name, ok: !!ok, detail: detail || "", optional: !!optional });
    }

    return createBase(cfg, opts.baseName).then(function (b) {
      out.appToken = b.appToken;
      out.url = b.url;
      rec("创建多维表格", true, b.url || b.appToken);

      return createTable(cfg, b.appToken, opts.tableName).then(function (tid) {
        out.tableId = tid;
        out.tableName = opts.tableName || TABLE_NAME;
        rec("建数据表与 " + FIELD_SCHEMA.length + " 个字段", true, "表名「" + out.tableName + "」");
        if (!b.defaultTableId || b.defaultTableId === tid) return null;
        return dropTable(cfg, b.appToken, b.defaultTableId).then(function () {
          rec("清掉平台自带的那张空表", true, "");
        }, function (e) {
          rec("清掉平台自带的那张空表", false, (e && e.message) || "删除失败，留着不影响使用");
        });
      });
    }).then(function () {
      return setLinkEditable(cfg, out.appToken).then(function () {
        rec("让拿到链接的人能编辑", true, "你和同事在飞书网页里可以直接改这张表", true);
      }, function (e) {
        rec("让拿到链接的人能编辑", false,
          "没设上（" + ((e && e.message) || "未知原因") + "）。" +
          "不影响扩展读写，只是你在飞书网页里打开它只能看", true);
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

  var api = {
    F: F,
    STATUS_TEXT: STATUS_TEXT,
    STATUS_BACK: STATUS_BACK,
    PRIORITY_TEXT: PRIORITY_TEXT,
    PRIORITY_BACK: PRIORITY_BACK,
    CHUNK: CHUNK,
    API: API,
    store: defaultStore,
    rawFetch: function (url, init) { return fetch(url, init); },
    err: err,
    getToken: getToken,
    clearToken: clearToken,
    listAll: listAll,
    batchCreate: batchCreate,
    batchUpdate: batchUpdate,
    batchDelete: batchDelete,
    createRaw: createRaw,
    updateRaw: updateRaw,
    selftest: selftest,
    toFields: toFields,
    urlCell: urlCell,
    fromFields: fromFields,
    snapshot: snapshot,
    normSelect: normSelect,
    normText: normText,
    normUrl: normUrl,
    normMs: normMs,
    normNum: normNum,
    dateStrToMs: dateStrToMs,
    msToDateStr: msToDateStr,
    describeError: describeError,
    authUrlFrom: authUrlFrom,
    FIELD_SCHEMA: FIELD_SCHEMA,
    createBase: createBase,
    createTable: createTable,
    dropTable: dropTable,
    setLinkEditable: setLinkEditable,
    transferOwner: transferOwner,
    listTables: listTables,
    listFields: listFields,
    createField: createField,
    ensureFields: ensureFields,
    describeEnsure: describeEnsure,
    metaUrl: metaUrl,
    provision: provision,
    RETRY_CODES: RETRY_CODES
  };
  return api;
})();

if (typeof module !== "undefined" && module.exports) module.exports = Feishu;
