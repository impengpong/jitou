// ═══════════════════════════════════════════════════════════════════
// WS 诊断探针 — MAIN world + document_start，在 BOSS 建 WebSocket 前 hook
// 记录每次 send 的 readyState/visibilityState + close/error 事件，写 DOM 属性
// 经 osascript 读 data-ws-probe 取证；纯诊断，不改 BOSS 行为
// ── findConv 探针增强：额外捕获 send/recv 帧二进制 payload(base64) → data-ws-pcap
//    用于验证「打开会话」的 WS 帧是否携带 friendId/encBossId（治本回验 oracle 调研）
// ═══════════════════════════════════════════════════════════════════
(function () {
  if (window.__ztWsProbe) return;
  window.__ztWsProbe = true;
  var log = [];
  var pcap = [];           // payload-bearing frames ring
  var sockets = 0;

  function ab2b64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    try { return btoa(s); } catch (e) { return 'B64ERR'; }
  }
  function toU8(d) {
    if (d == null) return null;
    if (typeof d === 'string') return { str: d };
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    return null; // Blob handled async by caller
  }
  function pushP(dir, id, d, capBytes) {
    try {
      if (d && typeof d.arrayBuffer === 'function' && (d instanceof Blob)) {
        var entry = { k: dir, id: id, len: d.size || 0, t: Date.now(), b64: null, blob: 1 };
        pcap.push(entry); if (pcap.length > 40) pcap.shift();
        d.arrayBuffer().then(function (ab) {
          var u = new Uint8Array(ab, 0, Math.min(ab.byteLength, capBytes));
          entry.b64 = ab2b64(u); flushP();
        }).catch(function () {});
        flushP();
        return;
      }
      var conv = toU8(d);
      var e = { k: dir, id: id, t: Date.now() };
      if (!conv) { e.b64 = null; e.note = 'unhandled'; }
      else if (conv.str != null) { e.str = conv.str.slice(0, 4000); e.len = conv.str.length; }
      else { e.len = conv.length; e.b64 = ab2b64(conv.subarray(0, Math.min(conv.length, capBytes))); }
      pcap.push(e); if (pcap.length > 40) pcap.shift();
      flushP();
    } catch (err) { pcap.push({ k: dir, id: id, perr: String(err) }); flushP(); }
  }
  function flushP() {
    try { document.documentElement.setAttribute('data-ws-pcap', JSON.stringify({ n: pcap.length, tail: pcap.slice(-14) })); } catch (e) {}
  }

  // ── open-conv friendId oracle（2026-06-27 验通）──────────────────
  // 打开会话 → BOSS 立刻发紧凑"进入会话"帧:  .. 08 06 42 <len> 08 <varint friendId> ..
  // 抽出 friendId 写 data-jitou-openconv={friendId,t,seq}。content.js(ISOLATED)读它做发送前 ID 回验。
  // 只读 BOSS 自发帧、不构造/不改帧。friendId === uid === encBossId 空间(已知映射)。
  var openSeq = 0;
  function extractOpenFriendId(u8) {
    if (!u8) return null;
    for (var i = 0; i + 4 < u8.length; i++) {
      // field1=6(进入会话) + field8 LEN + 内层 field1 varint = friendId
      if (u8[i] === 0x08 && u8[i + 1] === 0x06 && u8[i + 2] === 0x42 && u8[i + 4] === 0x08) {
        var v = 0, s = 0, k = i + 5;
        while (k < u8.length) { var b = u8[k]; v += (b & 0x7f) * Math.pow(2, s); k++; if (!(b & 0x80)) break; s += 7; }
        if (v > 0 && v < 1e15) return v;
      }
    }
    return null;
  }
  function emitOpenConv(d) {
    try {
      var u8 = toU8(d);
      if (!u8 || u8.str != null) return;           // 进入会话帧是二进制,字符串帧跳过
      var fid = extractOpenFriendId(u8);
      if (fid == null) return;
      document.documentElement.setAttribute('data-jitou-openconv', JSON.stringify({ friendId: String(fid), t: Date.now(), seq: ++openSeq }));
    } catch (e) {}
  }

  function flush() {
    try {
      document.documentElement.setAttribute('data-ws-probe', JSON.stringify({
        n: log.length, sockets: sockets, tail: log.slice(-50),
      }));
    } catch (e) {}
  }
  function rec(o) {
    o.t = Date.now();
    o.vis = document.visibilityState;
    log.push(o);
    if (log.length > 400) log.shift();
    flush();
  }
  var OWS = window.WebSocket;
  function Hooked(url, proto) {
    var ws = proto ? new OWS(url, proto) : new OWS(url);
    var id = sockets++;
    rec({ k: 'open', id: id, url: String(url).slice(0, 80) });
    var oSend = ws.send;
    ws.send = function (d) {
      var len = 0;
      try { len = (d && (d.byteLength || d.length || d.size)) || 0; } catch (e) {}
      rec({ k: 'send', id: id, len: len, rs: ws.readyState });
      try { emitOpenConv(d); } catch (e) {}
      try { pushP('send', id, d, 6000); } catch (e) {}
      try {
        return oSend.apply(ws, arguments);
      } catch (e) {
        rec({ k: 'send_err', id: id, err: String(e && e.message) });
        throw e;
      }
    };
    ws.addEventListener('message', function (ev) {
      rec({ k: 'recv', id: id });
      try {
        var d = ev.data;
        var sz = (d && (d.byteLength || d.size || (typeof d === 'string' ? d.length : 0))) || 0;
        if (sz >= 12) pushP('recv', id, d, 3000);
      } catch (e) {}
    });
    ws.addEventListener('close', function (e) { rec({ k: 'close', id: id, code: e.code }); });
    ws.addEventListener('error', function () { rec({ k: 'error', id: id }); });
    return ws;
  }
  Hooked.prototype = OWS.prototype;
  Hooked.CONNECTING = 0; Hooked.OPEN = 1; Hooked.CLOSING = 2; Hooked.CLOSED = 3;
  window.WebSocket = Hooked;
  rec({ k: 'probe_installed' });
})();
