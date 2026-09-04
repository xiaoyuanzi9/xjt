// ===== net.js：联机对战大厅 + PeerJS 连接/消息分发 =====
// 依赖 game.js 的全局与函数：showScreen、RULE_TEXTS、PLANES、CLASSIC_PLANES、phase、
// online、openEditor、restoreClassicFleet、editorReturnScreen、stopMoveTimer、
// onlineBeginMatch、onlineMaybeStartBattle、onlineApplyResult、onlineOnAttack、
// onlineRemoteReveal；并向 game.js 提供 netSend / netBackToLobby / netOnFleetApplied。
// 传输：PeerJS 公共信令服务器完成 WebRTC 握手，之后两浏览器 P2P 直连；
// 只互传 攻击坐标 / 显示值 / 设置 / 结算布阵，双方真实布阵永不出本机。
"use strict";

const ROOM_PREFIX = "xjt";   // 房间号前缀：避免与 PeerJS 网络里其它用户的 ID 撞车

let peer = null;
let conn = null;
let myCode = "";
let guestReady = false;
let onlineSettings = { rule: "classic", limit: 0, firstIsHost: true };

const $o = id => document.getElementById(id);

function netSend(obj) {
    if (conn && conn.open) conn.send(obj);
}

// ---------- 面板切换 ----------
function showOnlinePanel(which) {
    $o("online-home").style.display = which === "home" ? "block" : "none";
    $o("online-join").style.display = which === "join" ? "block" : "none";
    $o("online-host").style.display = which === "host" ? "block" : "none";
    $o("online-guest").style.display = which === "guest" ? "block" : "none";
}

function onlineFleetIsCustom() {
    return JSON.stringify(PLANES) !== JSON.stringify(CLASSIC_PLANES);
}

function refreshHostUI() {
    $o("btn-online-rule").textContent = onlineSettings.rule === "classic"
        ? "📜 规则：经典规则" : "🎭 规则：伪装机头";
    $o("btn-online-fleet").textContent = onlineFleetIsCustom()
        ? "✏️ 机队：自定义机队" : "✈️ 机队：经典机队";
    $o("btn-online-limit").textContent = onlineSettings.limit
        ? "⏱ 每步限时：" + onlineSettings.limit + " 秒" : "⏱ 每步限时：不限时";
    $o("btn-online-first").textContent = onlineSettings.firstIsHost
        ? "🎯 先后手：我先手" : "🎯 先后手：对方先手";
    $o("btn-host-start").disabled = !(guestReady && conn && conn.open);
    $o("host-conn-status").textContent = !conn
        ? "等待访客加入…"
        : guestReady ? "✅ 访客已准备，可以开始对战" : "访客已加入，等待对方点击准备…";
}

// 设置（含当前机队形状）同步给访客，供其查看规则与机队
function sendSettings() {
    if (conn && conn.open)
        netSend({ t: "settings", rule: onlineSettings.rule, limit: onlineSettings.limit, fleet: PLANES });
}

// ---------- 连接管理 ----------
function cleanupPeer() {
    if (conn) { try { conn.close(); } catch (e) {} conn = null; }
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
}

function wireConn(c, isHostSide) {
    conn = c;
    c.on("open", () => {
        online.active = true;
        online.isHost = isHostSide;
        guestReady = false;
        if (isHostSide) {
            showOnlinePanel("host");
            refreshHostUI();
            sendSettings();
        } else {
            $o("guest-conn-status").textContent = "已连接房主";
            setGuestReady(false);
            showOnlinePanel("guest");
        }
    });
    c.on("data", onNetMsg);
    c.on("close", () => onNetDown("对方已断开连接"));
    c.on("error", () => onNetDown("连接发生错误"));
}

function onNetDown(reason) {
    const wasInGame = online.active;
    cleanupPeer();
    online.active = false;
    stopMoveTimer();
    phase = "start";
    showOnlinePanel("home");
    $o("online-home-status").textContent =
        "⚠ " + reason + (wasInGame ? "，本局作废" : "") + "，可重新创建/加入房间";
}

// ---------- 消息分发 ----------
function onNetMsg(m) {
    if (!m || !m.t) return;
    switch (m.t) {
        case "settings": applySettings(m); break;
        case "ready":
            guestReady = !!m.v;
            refreshHostUI();
            break;
        case "start":
            // 我是访客：房主先手 → 全局先手是对方（本地下标 1）
            onlineBeginMatch(m.firstIsHost ? 1 : 0, m.rule, m.fleet, m.limit);
            break;
        case "placed":
            online.placedOpp = true;
            onlineMaybeStartBattle();
            break;
        case "attack":
            onlineOnAttack(m.r, m.c);
            break;
        case "result":
            onlineApplyResult(m.r, m.c, m.val);
            break;
        case "reveal":
            onlineRemoteReveal(m.board);
            break;
    }
}

// 访客：应用房主设置（规则说明 + 机队缩略图 + 限时）
function applySettings(m) {
    const rt = RULE_TEXTS[m.rule] || RULE_TEXTS.classic;
    $o("guest-rules-title").textContent = rt.title;
    $o("guest-rules-list").innerHTML = rt.list;
    const box = $o("guest-fleet");
    box.innerHTML = "";
    (m.fleet || []).forEach(shape => {
        const grid = document.createElement("div");
        grid.className = "mini-grid";
        grid.style.gridTemplateColumns = "repeat(" + shape[0].length + ", 12px)";
        for (const row of shape)
            for (const v of row) {
                const mc = document.createElement("div");
                mc.className = "mini-cell" + (v === 1 ? " b" : v === 2 ? " h" : "");
                grid.appendChild(mc);
            }
        box.appendChild(grid);
    });
    $o("guest-settings").textContent =
        "机队：" + (onlineFleetShapesCustom(m.fleet) ? "房主自定义" : "经典机队") +
        " ｜ 每步限时：" + (m.limit ? m.limit + " 秒" : "不限时");
}

function onlineFleetShapesCustom(fleet) {
    return !!fleet && JSON.stringify(fleet) !== JSON.stringify(CLASSIC_PLANES);
}

// ---------- 房主 ----------
function genCode() {
    return String(100000 + Math.floor(Math.random() * 900000));
}

function startHost() {
    cleanupPeer();
    myCode = genCode();
    peer = new Peer(ROOM_PREFIX + "-" + myCode);
    peer.on("open", () => {
        $o("host-code").textContent = myCode;
        showOnlinePanel("host");
        refreshHostUI();
    });
    peer.on("connection", c => {
        if (conn && conn.open) { c.close(); return; }   // 一房只收一位访客
        wireConn(c, true);
    });
    peer.on("error", err => {
        if (err.type === "unavailable-id") { startHost(); return; }   // 房间码撞车，换码重来
        onNetDown("房间创建失败（" + err.type + "）");
    });
}

$o("btn-host").addEventListener("click", () => {
    if (typeof Peer === "undefined") {
        $o("online-home-status").textContent = "⚠ 联机组件（PeerJS）加载失败，请联网后刷新页面";
        return;
    }
    $o("online-home-status").textContent = "正在创建房间…";
    startHost();
});

$o("btn-online-rule").addEventListener("click", () => {
    onlineSettings.rule = onlineSettings.rule === "classic" ? "fake" : "classic";
    refreshHostUI(); sendSettings();
});
$o("btn-online-fleet").addEventListener("click", () => {
    if (onlineFleetIsCustom()) restoreClassicFleet();
    else { editorReturnScreen = "screen-online"; openEditor(); }
    refreshHostUI(); sendSettings();
});
$o("btn-online-limit").addEventListener("click", () => {
    onlineSettings.limit = onlineSettings.limit ? 0 : 60;   // 不限时 ⇄ 60 秒
    refreshHostUI(); sendSettings();
});
$o("btn-online-first").addEventListener("click", () => {
    onlineSettings.firstIsHost = !onlineSettings.firstIsHost;
    refreshHostUI();
});
$o("btn-host-start").addEventListener("click", () => {
    if (!conn || !conn.open || !guestReady) return;
    $o("btn-host-start").disabled = true;   // 防连点造成重复开局
    const fleet = PLANES.map(sh => sh.map(row => row.slice()));
    netSend({ t: "start", firstIsHost: onlineSettings.firstIsHost,
              rule: onlineSettings.rule, fleet: fleet, limit: onlineSettings.limit });
    onlineBeginMatch(onlineSettings.firstIsHost ? 0 : 1, onlineSettings.rule, fleet, onlineSettings.limit);
});

// ---------- 访客 ----------
function setGuestReady(v) {
    guestReady = v;
    $o("btn-guest-ready").textContent = v ? "↩ 取消准备" : "✅ 准备";
}

$o("btn-join").addEventListener("click", () => {
    showOnlinePanel("join");
    $o("join-status").textContent = "";
    $o("join-code").value = "";
});
$o("btn-join-go").addEventListener("click", () => {
    const code = $o("join-code").value.trim();
    if (!/^\d{6}$/.test(code)) { $o("join-status").textContent = "⚠ 请输入 6 位数字房间码"; return; }
    if (typeof Peer === "undefined") {
        $o("join-status").textContent = "⚠ 联机组件（PeerJS）加载失败，请联网后刷新页面";
        return;
    }
    cleanupPeer();
    $o("join-status").textContent = "正在连接房主…";
    peer = new Peer();
    peer.on("open", () => {
        wireConn(peer.connect(ROOM_PREFIX + "-" + code, { reliable: true }), false);
    });
    peer.on("error", err => {
        if (err.type === "peer-unavailable") {
            cleanupPeer();
            $o("join-status").textContent = "⚠ 找不到该房间，请核对房间码或让房主确认已创建";
        } else {
            $o("join-status").textContent = "⚠ 连接出错：" + err.type;
        }
    });
});
$o("join-code").addEventListener("keydown", e => {
    if (e.key === "Enter") $o("btn-join-go").click();
});
$o("btn-guest-ready").addEventListener("click", () => {
    setGuestReady(!guestReady);
    netSend({ t: "ready", v: guestReady });
});

// ---------- 公共 ----------
$o("btn-online").addEventListener("click", () => {
    showOnlinePanel("home");
    $o("online-home-status").textContent = "";
    showScreen("screen-online");
});
$o("btn-online-back").addEventListener("click", () => {
    cleanupPeer();
    online.active = false;
    stopMoveTimer();
    phase = "start";
    showScreen("screen-start");
});

// game.js“再来一局”（联机）回调：回到大厅，连接保持，重新准备
function netBackToLobby() {
    phase = "start";
    stopMoveTimer();
    online.placedMe = false;
    online.placedOpp = false;
    online.started = false;
    online.remoteBoard = null;
    showScreen("screen-online");
    if (online.isHost) {
        guestReady = false;
        showOnlinePanel("host");
        refreshHostUI();
        sendSettings();
    } else {
        setGuestReady(false);
        netSend({ t: "ready", v: false });
        showOnlinePanel("guest");
        $o("guest-conn-status").textContent = "上一局已结束，准备好后再次点击准备";
    }
}

// 编辑器确认/返回后回调（game.js 的 confirmShape / 返回按钮调用）：刷新机队按钮并同步设置
function netOnFleetApplied() {
    if (online.active && online.isHost) { refreshHostUI(); sendSettings(); }
}
