// ===== 寻机头 game.js 前半：数据 + 布置逻辑 =====

// ---------- 常量与飞机形状 ----------
const SIZE = 10;

// 0=空 1=机身 2=机头
const SHAPE_A = [
    [0,0,2,0,0],
    [1,1,1,1,1],
    [0,0,1,0,0],
    [0,1,1,1,0]
];
const SHAPE_B = [
    [0,0,2,0,0],
    [0,1,1,1,0],
    [1,0,1,0,1],
    [0,0,1,0,0],
    [0,1,1,1,0]
];
const CLASSIC_PLANES = [SHAPE_A, SHAPE_A, SHAPE_B];
let PLANES = [SHAPE_A, SHAPE_A, SHAPE_B];   // 当前机队（可被自定义样式替换）
let customFleet = null;                      // 当前自定义样式（null = 经典机队）

// ---------- 游戏状态 ----------
let phase = "start";        // start / place / battle / over
let boards;                 // boards[p]: 玩家p的场地(0/1/2)
let guesses;                // guesses[p]: 玩家p探知的对手场地(null/0/1/2)
let moves = [0, 0];         // 双方步数
let headsFound = [0, 0];    // 已找到机头数
let currentPlayer = 0;
let lastChance = false;     // 后手补走一步标记

// 布置阶段状态
let placingPlayer = 0;
let planeStates;            // [{placed, r, c, shape}]
let selectedPlane = 0;
let previewCells = [];
let lastHover = null;
let passNext = null;
// 人机模式状态
let vsAI = false;
let aiLevel = "easy";   // easy / normal / hard / lunatic
let gameRule = "classic";   // classic / fake（伪装机头）
// 联机对战状态（连接与大厅在 net.js；对局中本地玩家固定为下标 0，对方为 1）
let online = {
    active: false, isHost: false, firstLocal: 0, rule: "classic", limit: 0,
    placedMe: false, placedOpp: false, started: false, remoteBoard: null
};


// ---------- 工具函数 ----------
const $ = id => document.getElementById(id);

function showScreen(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    $(id).classList.add("active");
}

function emptyBoard() {
    return Array.from({length: SIZE}, () => Array(SIZE).fill(0));
}

function emptyGuesses() {
    return Array.from({length: SIZE}, () => Array(SIZE).fill(null));
}

// 矩阵顺时针旋转90°
function rotateShape(shape) {
    const rows = shape.length, cols = shape[0].length;
    const res = Array.from({length: cols}, () => Array(rows).fill(0));
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
            res[c][rows - 1 - r] = shape[r][c];
    return res;
}

// ---------- 棋盘与机库 ----------
function buildBoard(el) {
    el.innerHTML = "";
    for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++) {
            const cell = document.createElement("div");
            cell.className = "cell";
            cell.dataset.r = r;
            cell.dataset.c = c;
            el.appendChild(cell);
        }
}

function cellAt(el, r, c) {
    return el.children[r * SIZE + c];
}

function buildHangar() {
    document.querySelectorAll(".plane-slot").forEach(slot => {
        const i = +slot.dataset.plane;
        const shape = PLANES[i];
        slot.innerHTML = "";                      // 重建机库（自定义样式后形状会变）
        const grid = document.createElement("div");
        grid.className = "mini-grid";
        grid.style.gridTemplateColumns = `repeat(${shape[0].length}, 12px)`;
        for (const row of shape)
            for (const v of row) {
                const mc = document.createElement("div");
                mc.className = "mini-cell" + (v === 1 ? " b" : v === 2 ? " h" : "");
                grid.appendChild(mc);
            }
        slot.appendChild(grid);
        slot.onclick = () => selectPlane(i);   // 用 onclick 赋值，避免重复 buildHangar 时累积监听器
    });
}

// ---------- 布置阶段 ----------
function startPlacement(player) {
    placingPlayer = player;
    phase = "place";
    planeStates = PLANES.map(() => ({ placed: false, r: 0, c: 0, shape: null }));
    selectedPlane = 0;
    lastHover = null;
    previewCells = [];
    $("place-title").textContent = "玩家 " + (player + 1) + "：布置你的机队";
    buildBoard($("place-board"));
    updateHangar();
    updateConfirm();   // 场地初始为空，三架都放好后才能确认
    // 联机确认布置后会把这三个按钮锁死，新的一局布置要恢复可用
    $("btn-rotate").disabled = $("btn-clear").disabled = $("btn-random").disabled = false;
    showScreen("screen-place");
}

function selectPlane(i) {
    if (!planeStates[i].placed) selectedPlane = i;
    updateHangar();
}

function updateHangar() {
    document.querySelectorAll(".plane-slot").forEach(slot => {
        const i = +slot.dataset.plane;
        slot.classList.toggle("selected", i === selectedPlane && !planeStates[i].placed);
        slot.classList.toggle("placed", planeStates[i].placed);
    });
}

// 当前选中飞机的形状（含旋转）
function getCurrentShape() {
    return planeStates[selectedPlane].shape || PLANES[selectedPlane];
}

function rotateCurrent() {
    if (phase !== "place" || planeStates[selectedPlane].placed) return;
    if (online && online.active && online.placedMe) return;   // 联机：已确认布置，禁止再改动
    planeStates[selectedPlane].shape = rotateShape(getCurrentShape());
    if (lastHover) showPreview(lastHover[0], lastHover[1]);
}

// 锚点：让飞机中心对准鼠标所在格
function anchor(r, c, shape) {
    return [r - (shape.length >> 1), c - (shape[0].length >> 1)];
}

function canPlace(shape, r, c) {
    if (r < 0 || c < 0 || r + shape.length > SIZE || c + shape[0].length > SIZE) return false;
    for (let i = 0; i < shape.length; i++)
        for (let j = 0; j < shape[i].length; j++)
            if (shape[i][j] && boards[placingPlayer][r + i][c + j]) return false;
    return true;
}

function showPreview(r, c) {
    clearPreview();
    if (online && online.active && online.placedMe) return;
    if (planeStates[selectedPlane].placed) return;
    lastHover = [r, c];
    const shape = getCurrentShape();
    const [ar, ac] = anchor(r, c, shape);
    const ok = canPlace(shape, ar, ac);
    for (let i = 0; i < shape.length; i++)
        for (let j = 0; j < shape[i].length; j++) {
            if (!shape[i][j]) continue;
            const rr = ar + i, cc = ac + j;
            if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE) continue;
            const cell = cellAt($("place-board"), rr, cc);
            cell.classList.add(ok ? "preview-ok" : "preview-bad");
            previewCells.push(cell);
        }
}

function clearPreview() {
    previewCells.forEach(cell => cell.classList.remove("preview-ok", "preview-bad"));
    previewCells = [];
}

function tryPlace(r, c) {
    if (online && online.active && online.placedMe) return;   // 联机：已确认布置，禁止再改动
    // 点击已放置飞机的机头 → 移除该飞机
    if (boards[placingPlayer][r][c] === 2) { removePlaneAt(r, c); return; }
    if (planeStates[selectedPlane].placed) return;
    const shape = getCurrentShape();
    const [ar, ac] = anchor(r, c, shape);
    // 点击格只是锚点：镂空/中心为空的机型锚点格本身可以不占格，
    // 所以这里不能因"点击格被占用"而拦截，交给 canPlace 判断实际重叠
    if (!canPlace(shape, ar, ac)) return;
    planeStates[selectedPlane] = { placed: true, r: ar, c: ac, shape: shape };
    for (let i = 0; i < shape.length; i++)
        for (let j = 0; j < shape[i].length; j++)
            if (shape[i][j]) boards[placingPlayer][ar + i][ac + j] = shape[i][j];
    const next = planeStates.findIndex(p => !p.placed);
    if (next !== -1) selectedPlane = next;
    renderPlaceBoard();
    updateHangar();
    updateConfirm();
}

function removePlaneAt(r, c) {
    const idx = planeStates.findIndex(p => p.placed &&
        r >= p.r && r < p.r + p.shape.length &&
        c >= p.c && c < p.c + p.shape[0].length &&
        p.shape[r - p.r][c - p.c] > 0);
    if (idx === -1) return;
    const p = planeStates[idx];
    for (let i = 0; i < p.shape.length; i++)
        for (let j = 0; j < p.shape[i].length; j++)
            if (p.shape[i][j]) boards[placingPlayer][p.r + i][p.c + j] = 0;
    p.placed = false;
    p.shape = null;
    selectedPlane = idx;
    renderPlaceBoard();
    updateHangar();
    updateConfirm();
}

function renderPlaceBoard() {
    const board = boards[placingPlayer];
    for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++) {
            const v = board[r][c];
            cellAt($("place-board"), r, c).className =
                "cell" + (v === 1 ? " p1" : v === 2 ? " p2" : "");
        }
}

function updateConfirm() {
    $("btn-confirm").disabled = !planeStates.every(p => p.placed);
}

function clearAll() {
    if (online && online.active && online.placedMe) return;   // 联机：已确认布置，禁止清空
    boards[placingPlayer] = emptyBoard();
    planeStates.forEach(p => { p.placed = false; p.shape = null; });
    selectedPlane = 0;
    renderPlaceBoard();
    updateHangar();
    updateConfirm();
}

// ---------- 灵感：尝试把未放置的飞机随机摆上场地 ----------
// 已放置的飞机不动；某架飞机找不到空位时保持原样（无事发生）
function randomPlace() {
    if (online && online.active && online.placedMe) return;   // 联机：已确认布置，禁止再改动
    clearPreview();
    for (let i = 0; i < PLANES.length; i++) {
        if (planeStates[i].placed) continue;
        for (let tries = 0; tries < 200; tries++) {
            let shape = PLANES[i];
            const rot = Math.floor(Math.random() * 4);
            for (let k = 0; k < rot; k++) shape = rotateShape(shape);
            const r = Math.floor(Math.random() * (SIZE - shape.length + 1));
            const c = Math.floor(Math.random() * (SIZE - shape[0].length + 1));
            if (!canPlace(shape, r, c)) continue;
            planeStates[i] = { placed: true, r: r, c: c, shape: shape };
            for (let a = 0; a < shape.length; a++)
                for (let b = 0; b < shape[a].length; b++)
                    if (shape[a][b]) boards[placingPlayer][r + a][c + b] = shape[a][b];
            break;
        }
    }
    const left = planeStates.findIndex(p => !p.placed);
    selectedPlane = left === -1 ? 0 : left;
    renderPlaceBoard();
    updateHangar();
    updateConfirm();
}

// ---------- 交接画面 ----------
function showPass(title, text, next) {
    $("pass-title").textContent = title;
    $("pass-text").textContent = text;
    passNext = next;
    showScreen("screen-pass");
}

// ---------- 新对局 ----------
function resetGameState() {
    boards = [emptyBoard(), emptyBoard()];
    guesses = [emptyGuesses(), emptyGuesses()];
    moves = [0, 0];
    headsFound = [0, 0];
    lastChance = false;
}

function newGame(ai, level) {
    vsAI = ai;
    aiLevel = level || "easy";
    lunaticAskBoard = 0;    // 主游戏：lunatic 读玩家（人）的观察
    resetGameState();
    if (vsAI) {
        showPass("布置机队", "请布置你的机队（AI 不会偷看）", () => startPlacement(0));
    } else {
        showPass("玩家 1 布置", "请玩家 1 布置机队（玩家 2 请回避屏幕）", () => startPlacement(0));
    }
}

// ===== 自定义飞机样式 =====
const EDITOR_SIZE = 5;
const EDITOR_DEFAULTS = [SHAPE_A, SHAPE_A, SHAPE_B];
let editorGrids = [[], [], []];   // 三架飞机各自的编辑器内容（0/1/2）
let editorReturnScreen = "screen-start";   // 编辑器关闭后回到哪个画面（开始画面 / 联机大厅）

function openEditor() {
    for (let k = 0; k < 3; k++) {
        const base = (customFleet && PLANES[k]) || EDITOR_DEFAULTS[k];
        editorGrids[k] = [];
        for (let r = 0; r < EDITOR_SIZE; r++) {
            editorGrids[k].push([]);
            for (let c = 0; c < EDITOR_SIZE; c++)
                editorGrids[k][r].push((base[r] && base[r][c]) || 0);
        }
    }
    buildEditorGrids();
    updateEditorStatus();
    showScreen("screen-editor");
}

function buildEditorGrids() {
    for (let k = 0; k < 3; k++) {
        const el = $("shape-editor-" + k);
        el.innerHTML = "";
        for (let r = 0; r < EDITOR_SIZE; r++)
            for (let c = 0; c < EDITOR_SIZE; c++) {
                const cell = document.createElement("div");
                cell.addEventListener("click", () => {
                    editorGrids[k][r][c] = (editorGrids[k][r][c] + 1) % 3;
                    renderEditorCell(cell, editorGrids[k][r][c]);
                    updateEditorStatus();
                });
                el.appendChild(cell);
            }
        renderEditorGrid(k);
    }
}

function renderEditorGrid(k) {
    const el = $("shape-editor-" + k);
    for (let r = 0; r < EDITOR_SIZE; r++)
        for (let c = 0; c < EDITOR_SIZE; c++)
            renderEditorCell(el.children[r * EDITOR_SIZE + c], editorGrids[k][r][c]);
}

function renderEditorCell(cell, v) {
    cell.className = "cell" + (v === 1 ? " p1" : v === 2 ? " p2" : "");
}

function planeCounts(k) {
    let twos = 0, ones = 0;
    for (const row of editorGrids[k])
        for (const v of row) {
            if (v === 2) twos++;
            else if (v === 1) ones++;
        }
    return { twos, ones };
}

function planeLegal(k) {
    const { twos, ones } = planeCounts(k);
    return twos === 1 && ones >= 1;
}

function updateEditorStatus() {
    const parts = [0, 1, 2].map(k => {
        const { twos, ones } = planeCounts(k);
        const ok = twos === 1 && ones >= 1;
        return "机" + (k + 1) + "：头 " + twos + " / 身 " + ones + (ok ? " ✅" : " ⚠");
    });
    const allOk = [0, 1, 2].every(planeLegal);
    $("editor-status").innerHTML = parts.join("<br>") + "<br>" +
        (allOk ? "<span class='ok-text'>✅ 三架样式均合法，可以确认</span>"
               : "<span class='bad-text'>⚠ 每架需恰好 1 个机头、至少 1 格机身</span>");
    $("btn-shape-confirm").disabled = !allOk;
}

function clearEditorPlane(k) {
    editorGrids[k] = editorGrids[k].map(row => row.map(() => 0));
    renderEditorGrid(k);
    updateEditorStatus();
}

// 裁掉全空的边缘行列，让机头居中定位更自然
function trimShape(shape) {
    let r0 = shape.length, r1 = -1, c0 = shape[0].length, c1 = -1;
    for (let r = 0; r < shape.length; r++)
        for (let c = 0; c < shape[0].length; c++)
            if (shape[r][c] > 0) {
                if (r < r0) r0 = r;
                if (r > r1) r1 = r;
                if (c < c0) c0 = c;
                if (c > c1) c1 = c;
            }
    const out = [];
    for (let r = r0; r <= r1; r++) out.push(shape[r].slice(c0, c1 + 1));
    return out;
}

function confirmShape() {
    if (![0, 1, 2].every(planeLegal)) return;
    const fleet = [0, 1, 2].map(k => trimShape(editorGrids[k]).map(row => row.slice()));
    $("editor-status").innerHTML = "正在计算布局组合…（样式越简单组合越多，稍候）";
    $("btn-shape-confirm").disabled = true;
    setTimeout(() => {
        const err = buildEngine(fleet);
        if (err) {
            // 构建失败：保持原机队不变，显示错误（保留确认键便于调整重试）
            $("editor-status").innerHTML = "<span class='bad-text'>⚠ " + err + "</span>";
            $("btn-shape-confirm").disabled = false;
            return;
        }
        PLANES = fleet;
        customFleet = fleet.map(sh => sh.map(row => row.slice()));
        buildHangar();
        refreshStartUI();
        showScreen(editorReturnScreen);
        if (typeof netOnFleetApplied === "function") netOnFleetApplied();
    }, 50);
}

// ===== 开始画面：三个切换按钮 + 开始游戏 =====
const DIFF_NAMES = { easy: "EASY", normal: "NORMAL", hard: "HARD", lunatic: "LUNATIC" };
const DIFF_ORDER = ["easy", "normal", "hard", "lunatic"];
let selRule = "classic";
let selMode = "pvp";           // pvp / ai
let selDiff = "normal";
let selFleetCustom = false;    // 机队按钮的显示状态（进入编辑器即亮起，确认后生效）

function refreshStartUI() {
    $("btn-rule-toggle").textContent =
        selRule === "classic" ? "📜 规则：经典规则" : "🎭 规则：伪装机头";
    $("btn-mode-toggle").textContent =
        selMode === "pvp" ? "👥 模式：双人对战" : "🤖 模式：人机对战";
    const third = $("btn-third-toggle");
    if (selMode === "pvp")
        third.textContent = selFleetCustom ? "✏️ 机队：自定义机队" : "✈️ 机队：经典机队";
    else
        third.textContent = "⚙ 难度：" + DIFF_NAMES[selDiff];
    // 自定义机队暂不支持人机对战
    const unsupported = selMode === "ai" && selFleetCustom;
    $("btn-start-game").disabled = unsupported;
    $("btn-start-game").title = unsupported ? "自定义机队暂不支持人机对战" : "";
}

function restoreClassicFleet() {
    customFleet = null;
    PLANES = CLASSIC_PLANES.map(row => row.slice());
    const err = buildEngine(PLANES);
    if (err) { console.error(err); return; }
    buildHangar();
}

// ---------- 事件绑定 ----------
// 开始画面：三个切换按钮
$("btn-rule-toggle").addEventListener("click", () => {
    selRule = selRule === "classic" ? "fake" : "classic";
    gameRule = selRule;
    showRules(selRule);
    refreshStartUI();
});
$("btn-mode-toggle").addEventListener("click", () => {
    selMode = selMode === "pvp" ? "ai" : "pvp";
    refreshStartUI();
});
$("btn-third-toggle").addEventListener("click", () => {
    if (selMode === "ai") {
        selDiff = DIFF_ORDER[(DIFF_ORDER.indexOf(selDiff) + 1) % DIFF_ORDER.length];
    } else if (selFleetCustom) {
        restoreClassicFleet();          // 自定义 → 切回经典机队
        selFleetCustom = false;
    } else {
        editorReturnScreen = "screen-start";
        openEditor();                   // 经典 → 打开自定义编辑器
        selFleetCustom = true;          // 按钮立即显示自定义机队（确认后生效）
    }
    refreshStartUI();
});
$("btn-start-game").addEventListener("click", () => {
    if ($("btn-start-game").disabled) return;
    if (selMode === "pvp") newGame(false);
    else newGame(true, selDiff);
});
// 布置编辑器
document.querySelectorAll(".editor-clear").forEach(b =>
    b.addEventListener("click", () => clearEditorPlane(+b.dataset.plane)));
$("btn-shape-default").addEventListener("click", () => {
    // EDITOR_DEFAULTS 里 SHAPE_A 是 4×5，编辑器是 5×5 —— 需补零填充到 5×5
    editorGrids = EDITOR_DEFAULTS.map(sh => {
        const g = [];
        for (let r = 0; r < EDITOR_SIZE; r++) {
            g.push([]);
            for (let c = 0; c < EDITOR_SIZE; c++)
                g[r].push((sh[r] && sh[r][c]) || 0);
        }
        return g;
    });
    buildEditorGrids();
    updateEditorStatus();
});
$("btn-shape-confirm").addEventListener("click", confirmShape);
$("btn-shape-back").addEventListener("click", () => {
    // 未确认的自定义不算数：按当前生效机队恢复按钮状态
    selFleetCustom = !!customFleet;
    refreshStartUI();
    showScreen(editorReturnScreen);
    if (typeof netOnFleetApplied === "function") netOnFleetApplied();
});
// 对战帮助
$("btn-help").addEventListener("click", () => {
    const p = $("help-popup");
    p.style.display = p.style.display === "block" ? "none" : "block";
});
$("btn-help-close").addEventListener("click", () => {
    $("help-popup").style.display = "none";
});

// 规则说明（开始画面随所选规则切换）
const RULE_TEXTS = {
    classic: {
        title: "游戏规则 · 📜 经典",
        list: `
            <li>双方各在 10×10 的场地内秘密布置 <b>3 架飞机</b>（可旋转、不可重叠、不可出界）</li>
            <li>轮流攻击对方一个格子，得知：<b>0</b>=空地 / <b>1</b>=机身 / <b>2</b>=机头</li>
            <li>先找出对方全部 <b>3 个机头</b> 者获胜</li>
            <li>若先手先找齐，后手可补走一步；步数相同则平局</li>`,
    },
    fake: {
        title: "游戏规则 · 🎭 伪装机头",
        list: `
            <li>双方各在 10×10 的场地内秘密布置 <b>3 架飞机</b>（可旋转、不可重叠、不可出界）</li>
            <li>轮流攻击对方一个格子：空地显示 <b>0</b>；打中飞机则一律显示 <b>1</b>——<b>机头会伪装成机身</b></li>
            <li><b>复查</b>：再次攻击一个显示 1 的格子验证真相——是机头则改显示 <b>2</b>；是真机身则仍显示 1，但格子会<b>变为暗金色</b>以示区分（每次攻击都计一步）</li>
            <li>先找出对方全部 <b>3 个机头</b> 者获胜；若先手先找齐，后手可补走一步；步数相同则平局</li>`,
    },
};

function showRules(rule) {
    $("rules-title").textContent = RULE_TEXTS[rule].title;
    $("rules-list").innerHTML = RULE_TEXTS[rule].list;
}

$("place-board").addEventListener("mouseover", e => {
    if (!e.target.classList.contains("cell")) return;
    showPreview(+e.target.dataset.r, +e.target.dataset.c);
});
$("place-board").addEventListener("mouseleave", () => { clearPreview(); lastHover = null; });
$("place-board").addEventListener("click", e => {
    if (!e.target.classList.contains("cell")) return;
    clearPreview();
    tryPlace(+e.target.dataset.r, +e.target.dataset.c);
    if (lastHover) showPreview(lastHover[0], lastHover[1]);
});
$("btn-rotate").addEventListener("click", rotateCurrent);
$("btn-clear").addEventListener("click", clearAll);
$("btn-random").addEventListener("click", randomPlace);
$("btn-pass").addEventListener("click", () => passNext && passNext());

$("btn-confirm").addEventListener("click", () => {
    if (online && online.active) {
        // 联机：布置完成只通知对方，等双方都确认后才自动开战；
        // 锁死确认键与全部布置操作，防止等待期间把已确认的机队改掉
        online.placedMe = true;
        $("btn-confirm").disabled = true;
        $("btn-rotate").disabled = true;
        $("btn-clear").disabled = true;
        $("btn-random").disabled = true;
        $("place-title").textContent = "✅ 已布置，等待对方完成布置…";
        netSend({ t: "placed" });
        onlineMaybeStartBattle();
        return;
    }
    if (vsAI) {
        // 人机模式：玩家布置完 → AI 布置（lunatic 不布置）→ 直接开战
        if (aiLevel !== "lunatic") aiPlaceRandom();
        else boards[1] = emptyBoard();
        aiInit();
        startBattle(0);
        return;
    }
    if (placingPlayer === 0) {
        showPass("玩家 2 布置", "请将设备交给玩家 2（玩家 1 请回避）", () => startPlacement(1));
    } else {
        startBattle(0);
    }
});
document.addEventListener("keydown", e => {
    if (phase === "place" && (e.key === "r" || e.key === "R")) rotateCurrent();
});

// 引擎构建（ai.js）：支持经典机队与自定义样式机队
buildEngine(PLANES);

// 机库初始化 + 开始画面初始状态
buildHangar();
refreshStartUI();

// ===== 前半部分结束，对战逻辑请拼接在下方 =====
// ===== game.js 后半：对战逻辑 + 胜负判定 =====
// ===== game.js 后半：对战逻辑（双人 + 人机） =====

let busy = false;   // 攻击后短暂锁定，防止连点
let turnTimer = null;   // “换手/结算”延时句柄（联机收到对方新着时需要撤销未完成的换手）
// easy/normal 计算量趋近于零，只留很短的节奏延时；
// hard/lunatic 的实际思考时间 = 期望步数推演的真实计算耗时，不人为拖延
const AI_THINK = { easy: 400, normal: 600, hard: 30, lunatic: 30 };

// ---------- 对战阶段 ----------
// 帮助弹窗：按当前机队与规则刷新内容
function updateHelpPanel() {
    const fleetEl = $("help-fleet");
    fleetEl.innerHTML = "";
    PLANES.forEach(shape => {
        const wrap = document.createElement("div");
        const grid = document.createElement("div");
        grid.className = "mini-grid";
        grid.style.gridTemplateColumns = `repeat(${shape[0].length}, 14px)`;
        for (const row of shape)
            for (const v of row) {
                const mc = document.createElement("div");
                mc.className = "mini-cell" + (v === 1 ? " b" : v === 2 ? " h" : "");
                grid.appendChild(mc);
            }
        wrap.appendChild(grid);
        fleetEl.appendChild(wrap);
    });
    $("help-rules").innerHTML = RULE_TEXTS[gameRule].list;
}

function startBattle(firstPlayer) {
    phase = "battle";
    currentPlayer = firstPlayer;
    busy = false;
    stopMoveTimer();
    $("help-popup").style.display = "none";   // 新对局收起上一局可能打开的帮助
    updateHelpPanel();
    buildBoard($("board-p1"));
    buildBoard($("board-p2"));
    renderBattle();
    showScreen("screen-battle");
}

// 只绘制攻击痕迹，不显示飞机
function drawMarks(el, marks) {
    for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++) {
            let cls = "cell";
            const g = marks[r][c];
            if (g === 0) cls += " miss";
            if (g === 1) cls += " hit1";
            if (g === 2) cls += " hit2";
            if (g === 3) cls += " hit1c";
            cellAt(el, r, c).className = cls;
        }
}

function renderBattle() {
    drawMarks($("board-p1"), guesses[1]);   // 左：玩家1场地（被打记录）
    drawMarks($("board-p2"), guesses[0]);   // 右：玩家2/AI场地（被打记录）

    $("board-p1").classList.toggle("active", currentPlayer === 1);
    $("board-p2").classList.toggle("active", currentPlayer === 0);

    const fakeHint = gameRule === "fake" ? "（攻击显示1的格子可复查：机头变2，真机身的1会变色）" : "";
    if (online && online.active) {
        $("battle-title").textContent = currentPlayer === 0
            ? "你的回合：点击右侧（对方）场地攻击" + fakeHint
            : "等待对方行动…";
    } else if (vsAI) {
        $("battle-title").textContent = currentPlayer === 0
            ? "你的回合：点击右侧 AI 场地攻击" + fakeHint
            : "🤖 AI 回合…";
    } else {
        $("battle-title").textContent =
            "玩家 " + (currentPlayer + 1) + " 的回合：点击对方场地进行攻击" + fakeHint;
    }
    let extra = "";
    if (lastChance && currentPlayer !== onlineFirst())
        extra = "⚡ 最后一步！找齐机头则平局，否则先手获胜";
    updateBattleStatus(extra);
}

function updateBattleStatus(text) {
    const ln = (vsAI || (online && online.active)) ? "你" : "玩家1";
    const rn = vsAI ? "AI" : (online && online.active) ? "对方" : "玩家2";
    const left = ln + "：机头 " + headsFound[0] + "/3 · " + moves[0] + " 步";
    const right = rn + "：机头 " + headsFound[1] + "/3 · " + moves[1] + " 步";
    $("battle-status").textContent = left + " ｜ " + right + (text ? " ｜ " + text : "");
}

// ---------- 玩家攻击 ----------
function handleAttack(r, c) {
    if (online && online.active) { onlineAttack(r, c); return; }   // 联机：攻击走消息，见文件末尾联机核心段
    const p = currentPlayer;
    const g = guesses[p][r][c];

    if (gameRule === "fake") {
        // ===== 伪装机头规则 =====
        if (g === 0 || g === 2 || g === 3) return;   // 这些格子复查无意义
        busy = true;
        const lun = vsAI && p === 0 && aiLevel === "lunatic";
        if (g === 1) {
            // 复查：揭示真相（2=机头 / 3=真机身）
            const val = lun ? lunaticAnswer(r, c)
                            : (boards[1 - p][r][c] === 2 ? 2 : 3);
            moves[p]++;
            guesses[p][r][c] = val;
            let msg;
            if (val === 2) { headsFound[p]++; msg = "💥 复查命中：是机头！"; }
            else { msg = "复查结果：真机身"; }
            finishAttack(p, r, c, msg);
            return;
        }
        // g === null：首次攻击（机头伪装成机身显示）
        const truth = boards[1 - p][r][c];
        const val = lun ? lunaticAnswer(r, c) : ((truth === 2) ? 1 : truth);
        moves[p]++;
        guesses[p][r][c] = val;
        finishAttack(p, r, c, val === 0 ? "未命中" : "命中机身");
        return;
    }

    // ===== 经典规则 =====
    if (g !== null) return;
    busy = true;
    let val;
    if (vsAI && p === 0 && aiLevel === "lunatic") val = lunaticAnswer(r, c);
    else val = boards[1 - p][r][c];
    guesses[p][r][c] = val;
    moves[p]++;
    let msg;
    if (val === 2) { headsFound[p]++; msg = "💥 命中机头！"; }
    else if (val === 1) { msg = "命中机身"; }
    else { msg = "未命中"; }
    if (vsAI) msg = (p === 0 ? "你" : "AI") + "：" + msg;
    finishAttack(p, r, c, msg);
}

// 攻击收尾：渲染 + 胜负判定 + 换手（双人/人机/联机共用）。
// 联机时“全局先手”在本端的下标可能不是 0（由 onlineFirst 换算），
// 补走/平局规则按全局先手判断，逻辑与热座完全一致。
function finishAttack(p, r, c, msg) {
    renderBattle();
    const target = p === 0 ? $("board-p2") : $("board-p1");
    cellAt(target, r, c).classList.add("last");
    updateBattleStatus(msg);

    const first = onlineFirst();
    if (lastChance) {
        const second = 1 - first;
        turnTimer = setTimeout(() => endGame(headsFound[second] === 3 ? -1 : first), 1500);
        return;
    }
    if (headsFound[p] === 3) {
        if (p === first) {   // 先手先找齐：后手可补走一步
            lastChance = true;
            turnTimer = setTimeout(() => {
                currentPlayer = 1 - p; busy = false; renderBattle();
                if (vsAI) scheduleAI();
                onlineMaybeStartTimer();
            }, 1500);
            return;
        }
        turnTimer = setTimeout(() => endGame(p), 1500);   // 后手先找齐：直接获胜
        return;
    }
    turnTimer = setTimeout(() => {
        currentPlayer = 1 - p; busy = false; renderBattle();
        if (vsAI && currentPlayer === 1) scheduleAI();
        onlineMaybeStartTimer();
    }, 1500);
}

// ---------- AI 回合 ----------
function scheduleAI() {
    setTimeout(aiTurn, AI_THINK[aiLevel] || 800);
}

function aiTurn() {
    if (phase !== "battle" || !vsAI || currentPlayer !== 1) return;
    const cell = aiChooseAttack();
    const r = Math.floor(cell / SIZE), c = cell % SIZE;
    const val = boards[0][r][c];                // 玩家场地的真实值
    moves[1]++;

    let msg;
    if (gameRule === "fake") {
        const g = guesses[1][r][c];
        if (g === 1) {
            // 复查：揭示真相
            if (val === 2) {
                guesses[1][r][c] = 2;
                headsFound[1]++;
                msg = "💥 AI 复查命中：是机头！";
            } else {
                guesses[1][r][c] = 3;
                msg = "AI 复查：真机身";
            }
        } else {
            // 首次攻击：机头伪装成1显示
            guesses[1][r][c] = (val === 2) ? 1 : val;
            msg = (val === 0) ? "AI：未命中" : "AI：命中机身";
        }
    } else {
        guesses[1][r][c] = val;
        if (val === 2) { headsFound[1]++; msg = "💥 AI：命中机头！"; }
        else if (val === 1) { msg = "AI：命中机身"; }
        else { msg = "AI：未命中"; }
    }

    renderBattle();
    cellAt($("board-p1"), r, c).classList.add("last");
    updateBattleStatus(msg);

    // 胜负判定（与玩家侧规则一致）
    if (lastChance) {
        setTimeout(() => endGame(headsFound[1] === 3 ? -1 : 0), 1500);
        return;
    }
    if (headsFound[1] === 3) {
        setTimeout(() => endGame(1), 1500);
        return;
    }
    setTimeout(() => { currentPlayer = 0; busy = false; renderBattle(); }, 1500);
}


// ---------- 点击监听 ----------
$("board-p1").addEventListener("click", e => {
    if (vsAI || (online && online.active)) return;   // 人机/联机模式：不能点自己的场地
    if (phase !== "battle" || busy || currentPlayer !== 1) return;
    if (!e.target.classList.contains("cell")) return;
    handleAttack(+e.target.dataset.r, +e.target.dataset.c);
});
$("board-p2").addEventListener("click", e => {
    if (phase !== "battle" || busy || currentPlayer !== 0) return;
    if (!e.target.classList.contains("cell")) return;
    handleAttack(+e.target.dataset.r, +e.target.dataset.c);
});

// ---------- 结束画面 ----------
function endGame(winner) {
    phase = "over";
    busy = false;
    stopMoveTimer();
    clearTurnTimer();
    if (online && online.active) netSend({ t: "reveal", board: boards[0] });   // 联机：互换真实布阵
    if (winner === -1) {
        $("over-title").textContent = "🤝 平局！";
        $("over-detail").textContent = "双方都在 " + moves[0] + " 步内找齐了全部机头";
    } else if (online && online.active) {
        if (winner === 0) {
            $("over-title").textContent = "🎉 你获胜！";
            $("over-detail").textContent =
                "你用 " + moves[0] + " 步找齐全部机头（对方已找到 " + headsFound[1] + "/3）";
        } else {
            $("over-title").textContent = "😔 对方获胜！";
            $("over-detail").textContent =
                "对方用 " + moves[1] + " 步找齐全部机头（你已找到 " + headsFound[0] + "/3）";
        }
    } else if (vsAI) {
        if (winner === 0) {
            $("over-title").textContent = "🎉 你获胜！";
            $("over-detail").textContent =
                "你用 " + moves[0] + " 步找齐全部机头（AI 已找到 " + headsFound[1] + "/3）";
        } else {
            $("over-title").textContent = "🤖 AI 获胜！";
            $("over-detail").textContent =
                "AI 用 " + moves[1] + " 步找齐全部机头（你已找到 " + headsFound[0] + "/3）";
        }
    } else {
        $("over-title").textContent = "🎉 玩家 " + (winner + 1) + " 获胜！";
        $("over-detail").textContent =
            "玩家 " + (winner + 1) + " 用 " + moves[winner] + " 步找齐全部机头（对方已找到 " +
            headsFound[1 - winner] + "/3）";
    }

    // ---- 结算：揭示双方布阵 ----
    if (vsAI && aiLevel === "lunatic")
        boards[1] = lunaticReveal();   // lunatic 无真实布阵，随机选一个与所有回答一致的
    const remoteBoard = (online && online.active && online.remoteBoard)
        ? online.remoteBoard : boards[1];   // 联机：对方的布阵由对方发来（可能稍后到达）
    $("reveal-name-p1").textContent =
        (vsAI || (online && online.active)) ? "你的布阵" : "玩家 1 的布阵";
    $("reveal-name-p2").textContent =
        vsAI ? "AI 的布阵" : (online && online.active) ? "对方的布阵" : "玩家 2 的布阵";
    buildBoard($("board-reveal-p1"));
    buildBoard($("board-reveal-p2"));
    drawReveal($("board-reveal-p1"), boards[0], guesses[1]);
    drawReveal($("board-reveal-p2"), remoteBoard, guesses[0]);

    showScreen("screen-over");
}

// 结算揭示：显示场地上的飞机 + 双方攻击痕迹
function drawReveal(el, board, marks) {
    for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++) {
            let cls = "cell";
            if (board[r][c] === 1) cls += " p1";
            if (board[r][c] === 2) cls += " p2";
            const m = marks[r][c];
            if (m === 0) cls += " miss";
            if (m === 1) cls += " hit1";
            if (m === 2) cls += " hit2";
            if (m === 3) cls += " hit1c";
            cellAt(el, r, c).className = cls;
        }
}

// 再来一局：联机回大厅（连接保持），否则回开始画面
$("btn-restart").addEventListener("click", () => {
    if (online && online.active) { netBackToLobby(); return; }
    phase = "start";
    showScreen("screen-start");
});

// ===== 联机对战核心（连接与大厅在 net.js；对局中本地玩家固定为下标 0，对方为 1）=====

// 全局先手在本端的下标：联机按房主的先后手选择换算，其余模式固定 0
function onlineFirst() {
    return (online && online.active && online.firstLocal != null) ? online.firstLocal : 0;
}

// 进入一局联机对局：初始化状态并布置（房主点击开始 / 访客收到 start 消息）
function onlineBeginMatch(firstLocal, rule, fleetShapes, limitSec) {
    online.firstLocal = firstLocal;
    online.rule = rule;
    online.limit = limitSec || 0;
    online.placedMe = false;
    online.placedOpp = false;
    online.started = false;
    online.remoteBoard = null;
    if (fleetShapes && fleetShapes.length === 3) {
        PLANES = fleetShapes.map(sh => sh.map(row => row.slice()));   // 使用房主下发的机队
        buildHangar();
    }
    gameRule = rule;
    resetGameState();
    startPlacement(0);
    $("place-title").textContent = "🌐 联机对战：布置你的机队（对方看不到）";
}

// 双方都确认布置后自动开战
function onlineMaybeStartBattle() {
    if (online.started || !(online.placedMe && online.placedOpp)) return;
    online.started = true;
    startBattle(online.firstLocal);
    onlineMaybeStartTimer();
}

// 本地发起攻击：不查对方板（也查不到），发给对方等答复
function onlineAttack(r, c) {
    if (phase !== "battle" || busy || currentPlayer !== 0) return;
    const g = guesses[0][r][c];
    if (gameRule === "fake") {
        if (g === 0 || g === 2 || g === 3) return;
    } else if (g !== null) return;
    busy = true;
    stopMoveTimer();
    netSend({ t: "attack", r: r, c: c });
    updateBattleStatus("⚔ 已攻击 (" + (r + 1) + "," + (c + 1) + ")，等待对方确认…");
}

// 攻击方收到防守方的答复。
// 注意：这里不解锁 busy——busy 保持 true 直到 finishAttack 的换手延时结束，
// 这是“一回合只能打一次”的关键；提前解锁会让玩家在换手完成前又能发射第二发。
function onlineApplyResult(r, c, val) {
    if (phase !== "battle" || !busy) return;   // 没有待答复的攻击：忽略（防重复消息）
    const g = guesses[0][r][c];
    if (gameRule === "fake") {
        if (g === 0 || g === 2 || g === 3) return;
        if (g === null && val !== 0 && val !== 1) return;   // 首击只能显示 0/1
        if (g === 1 && val !== 2 && val !== 3) return;      // 复查只能显示 2/3
    } else {
        if (g !== null) return;
        if (val !== 0 && val !== 1 && val !== 2) return;
    }
    clearTurnTimer();
    moves[0]++;
    guesses[0][r][c] = val;
    let msg;
    if (val === 2) { headsFound[0]++; msg = "💥 命中机头！"; }
    else if (val === 1) { msg = "命中机身"; }
    else { msg = "未命中"; }
    finishAttack(0, r, c, msg);
}

// 防守方收到攻击：本地查板 → 按规则算显示值 → 回执（真实布阵不出本机）。
// 同样不在此处解锁 busy：换手延时结束后才允许下一击；
// 双方时钟/延迟导致“换手画面还没切完就收到新攻击”由 clearTurnTimer 撤销本地未完成的换手来消化。
function onlineOnAttack(r, c) {
    if (phase !== "battle") return;
    const g = guesses[1][r][c];
    if (gameRule === "fake") {
        if (g !== null && g !== 1) return;
    } else if (g !== null) return;
    clearTurnTimer();
    const truth = boards[0][r][c];
    const val = gameRule === "fake"
        ? (g === 1 ? (truth === 2 ? 2 : 3) : (truth === 2 ? 1 : truth))
        : truth;
    moves[1]++;
    guesses[1][r][c] = val;
    if (val === 2) headsFound[1]++;
    const msg = val === 2 ? "💥 对方命中你的机头！"
             : val === 1 ? "对方命中你的机身" : "对方未命中";
    netSend({ t: "result", r: r, c: c, val: val });
    finishAttack(1, r, c, msg);
}

// 对方的真实布阵到达（可能早于/晚于本端进入结算画面）
function onlineRemoteReveal(board) {
    online.remoteBoard = board;
    if (phase === "over")
        drawReveal($("board-reveal-p2"), board, guesses[0]);
}

function clearTurnTimer() {
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
}

// 每步限时：只在轮到本地攻击时计时，超时自动随机攻击一格
let moveTimer = null, moveDeadline = 0;
function onlineMaybeStartTimer() {
    stopMoveTimer();
    if (!online.active || !online.limit || phase !== "battle" || currentPlayer !== 0) return;
    moveDeadline = Date.now() + online.limit * 1000;
    moveTimer = setInterval(() => {
        const left = Math.max(0, Math.ceil((moveDeadline - Date.now()) / 1000));
        updateBattleStatus("⏱ 本步剩余 " + left + " 秒");
        if (left <= 0) { stopMoveTimer(); onlineAutoAttack(); }
    }, 250);
}
function stopMoveTimer() {
    if (moveTimer) { clearInterval(moveTimer); moveTimer = null; }
}
function onlineAutoAttack() {
    if (phase !== "battle" || busy || currentPlayer !== 0) return;
    const cands = [];
    for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++) {
            const g = guesses[0][r][c];
            const legal = gameRule === "fake" ? (g === null || g === 1) : g === null;
            if (legal) cands.push([r, c]);
        }
    if (!cands.length) return;
    const pick = cands[(Math.random() * cands.length) | 0];
    onlineAttack(pick[0], pick[1]);
}