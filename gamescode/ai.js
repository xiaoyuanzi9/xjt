// ===== ai.js：AI 大脑 =====
// 依赖 game.js 的全局变量：SIZE, rotateShape, emptyBoard, boards, guesses,
// headsFound, gameRule, aiLevel
//
// 机队数据通过 buildEngine(舰队) 构建，舰队是形状矩阵的数组（如 [A,A,B]），
// 因此支持自定义飞机样式。组合空间用 Int32Array（comboStore）存储，
// 不再建 100×N 的取值大表，取值/机头都按需从摆法数据读取，
// 这样几十万到几百万的组合规模也能在浏览器里运行。
// 铁律：AI 永远不读 boards[0]（玩家真实布置），只根据 guesses[1] 的观察推理。

const MAX_COMBOS = 4000000;   // 组合数上限（内存约束），超过则 buildEngine 报错

const RECHECK_W = 0.65;  // 复查折扣：低概率复查让位于新格探索
// 各档思考预算：cap=信念子样本规模；K=真相样本数；
// stages=逐级精化阶梯 [样本数, 保留组数]（hard 求快，exact 不限时求准）
const THINK = {
    hard:   { cap: 6000, K: 16, stages: [[4, 8], [16, 3]] },
    answer: { cap: 8000, K: 20 },   // lunatic 回答评估（候选只有 2~3 个值）
    exact:  { cap: 8000, K: 192, stages: [[16, 16], [64, 6], [192, 3]] },
    // 兜底策略：与 exact 同精度，但按"最坏情况的步数"聚合（对真相取最大）
    worst:  { cap: 8000, K: 256, stages: [[24, 12], [96, 4], [256, 2]] },
};

let FLEET = null;             // 当前机队的形状矩阵（副本）
let shapeLists = [];          // 每个机型的摆法列表（相同形状共享同一列表）
let NCOMBOS = 0;              // 合法组合总数
let comboStore = null;        // Int32Array(3*NCOMBOS)：组合 ci 的三张摆法下标

// AI 对玩家场地的信念（组合下标数组 + 有效长度）与 lunatic 的故事集
let atkArr = null, atkCount = 0, atkObs = null;
let ansArr = null, ansCount = 0;
// lunatic 读取"提问方观察"的棋盘下标：主游戏（玩家攻击 AI 的故事板）= 0，
// aicheck 的 L 挑战（AI 回答玩家对 guesses[1] 的观察）= 1。由各入口设置。
let lunaticAskBoard = 0;

// 快表：组合空间较小时（≤ VALTABLE_MAX，含经典机队）预建取值/机头表，
// 热路径单次查表；过大时（自定义小飞机）置 null，退回按需读取。
const VALTABLE_MAX = 400000;
let valTable = null;   // Uint8Array(100 * NCOMBOS)
let headArr = null;    // Int32Array(3 * NCOMBOS)

// ---------- 组合的取值 / 机头 ----------
function comboValAt(ci, cell) {
    if (valTable) return valTable[cell * NCOMBOS + ci];
    const b = ci * 3;
    return shapeLists[0][comboStore[b]].vals[cell] |
           shapeLists[1][comboStore[b + 1]].vals[cell] |
           shapeLists[2][comboStore[b + 2]].vals[cell];
}
function headOfAt(ci, k) {
    if (headArr) return headArr[ci * 3 + k];
    return shapeLists[k][comboStore[ci * 3 + k]].head;
}

// ---------- 引擎构建 ----------
// 单机型摆法枚举：4 种旋转 × 所有位置，按棋盘位掩码去重
// （自定义样式可能有旋转对称性，不去重会重复计数）
function genPlacementsOf(shape) {
    const list = [];
    const seen = new Set();
    let s = shape;
    for (let rot = 0; rot < 4; rot++) {
        const rows = s.length, cols = s[0].length;
        for (let r = 0; r + rows <= SIZE; r++)
            for (let c = 0; c + cols <= SIZE; c++) {
                const vals = new Uint8Array(SIZE * SIZE);
                const cells = [];
                let head = -1, g0 = 0, g1 = 0, g2 = 0, g3 = 0;
                for (let i = 0; i < rows; i++)
                    for (let j = 0; j < cols; j++) {
                        const v = s[i][j];
                        if (!v) continue;
                        const idx = (r + i) * SIZE + (c + j);
                        vals[idx] = v;
                        cells.push(idx);
                        if (v === 2) head = idx;
                        // 100 位拆成 4×25 位（JS 位运算按 32 位回绕，不能超 31 位）
                        if (idx < 25) g0 |= (1 << idx);
                        else if (idx < 50) g1 |= (1 << (idx - 25));
                        else if (idx < 75) g2 |= (1 << (idx - 50));
                        else g3 |= (1 << (idx - 75));
                    }
                const key = g0 + "," + g1 + "," + g2 + "," + g3 + "|" + head;
                if (seen.has(key)) continue;
                seen.add(key);
                list.push({ vals, cells, head, g0, g1, g2, g3 });
            }
        s = rotateShape(s);
    }
    return list;
}

function ovl(a, b) {
    return (a.g0 & b.g0) !== 0 || (a.g1 & b.g1) !== 0 ||
           (a.g2 & b.g2) !== 0 || (a.g3 & b.g3) !== 0;
}

// 三机组合枚举：相同机型按下标递增去序（i<j<k），不同机型自由组合。
// count 与 fill 共用同一循环结构（先数后填，避免中间大数组）。
function scanCombos(L0, L1, L2, store) {
    let n = 0;
    const put = function (i, j, k) {
        if (store) {
            store[n * 3] = i; store[n * 3 + 1] = j; store[n * 3 + 2] = k;
        }
        n++;
    };
    if (L0 === L1 && L1 === L2) {                 // 三架同型
        for (let i = 0; i < L0.length; i++)
            for (let j = i + 1; j < L1.length; j++) {
                if (ovl(L0[i], L1[j])) continue;
                for (let k = j + 1; k < L2.length; k++) {
                    if (ovl(L0[i], L2[k]) || ovl(L1[j], L2[k])) continue;
                    put(i, j, k);
                }
            }
    } else if (L0 === L1) {                        // 前两架同型
        for (let i = 0; i < L0.length; i++)
            for (let j = i + 1; j < L1.length; j++) {
                if (ovl(L0[i], L1[j])) continue;
                for (let k = 0; k < L2.length; k++)
                    if (!ovl(L0[i], L2[k]) && !ovl(L1[j], L2[k])) put(i, j, k);
            }
    } else {                                       // 三架异型
        for (let i = 0; i < L0.length; i++)
            for (let j = 0; j < L1.length; j++) {
                if (ovl(L0[i], L1[j])) continue;
                for (let k = 0; k < L2.length; k++)
                    if (!ovl(L0[i], L2[k]) && !ovl(L1[j], L2[k])) put(i, j, k);
            }
    }
    return n;
}

// 构建引擎。成功返回 null，失败返回错误信息（不改变已有引擎状态）。
function buildEngine(fleet) {
    const patternKey = sh => JSON.stringify(sh);
    const byPattern = new Map();
    const lists = fleet.map(sh => {
        const k = patternKey(sh);
        if (!byPattern.has(k)) byPattern.set(k, genPlacementsOf(sh));
        return byPattern.get(k);
    });
    const count = scanCombos(lists[0], lists[1], lists[2], null);
    if (count === 0)
        return "该机队无法在 10×10 场地内互不重叠地布阵，请检查样式";
    if (count > MAX_COMBOS)
        return "该样式产生的布局组合达 " + Math.round(count / 10000) + " 万种，" +
               "超过 AI 支持上限（" + Math.round(MAX_COMBOS / 10000) + " 万），" +
               "请把机身画得更大一些";

    const store = new Int32Array(3 * count);
    scanCombos(lists[0], lists[1], lists[2], store);

    FLEET = fleet.map(row => row.slice());
    shapeLists = lists;
    NCOMBOS = count;
    comboStore = store;

    // 小组合空间建快表（先置 null，用慢路径填充自身）
    valTable = null;
    headArr = null;
    if (count <= VALTABLE_MAX) {
        const vt = new Uint8Array(SIZE * SIZE * count);
        const ha = new Int32Array(3 * count);
        for (let ci = 0; ci < count; ci++) {
            const b = ci * 3;
            for (let cell = 0; cell < SIZE * SIZE; cell++)
                vt[cell * count + ci] =
                    lists[0][store[b]].vals[cell] |
                    lists[1][store[b + 1]].vals[cell] |
                    lists[2][store[b + 2]].vals[cell];
            for (let k = 0; k < 3; k++) ha[b + k] = lists[k][store[b + k]].head;
        }
        valTable = vt;
        headArr = ha;
    }
    return null;
}

// ---------- 对局中的 AI 状态 ----------
function aiInit() {
    atkArr = new Int32Array(NCOMBOS);
    ansArr = new Int32Array(NCOMBOS);
    for (let i = 0; i < NCOMBOS; i++) { atkArr[i] = i; ansArr[i] = i; }
    atkCount = NCOMBOS;
    ansCount = NCOMBOS;
    atkObs = new Int8Array(SIZE * SIZE).fill(-1);   // 每格已应用的观察值
}

// ---------- AI 随机布置自己的场地（保证三架全部放上） ----------
function aiPlaceRandom() {
    // 单架飞机 1000 次都放不下时整个布局重掷，杜绝静默缺飞机
    for (let attempt = 0; attempt < 50; attempt++) {
        boards[1] = emptyBoard();
        let complete = true;
        for (const shape of PLANES) {
            let placed = false;
            for (let t = 0; t < 1000 && !placed; t++) {
                let s = shape;
                const rot = Math.floor(Math.random() * 4);
                for (let m = 0; m < rot; m++) s = rotateShape(s);
                const r = Math.floor(Math.random() * (SIZE - s.length + 1));
                const c = Math.floor(Math.random() * (SIZE - s[0].length + 1));
                let ok = true;
                for (let i = 0; i < s.length && ok; i++)
                    for (let j = 0; j < s[i].length && ok; j++)
                        if (s[i][j] && boards[1][r + i][c + j]) ok = false;
                if (!ok) continue;
                for (let i = 0; i < s.length; i++)
                    for (let j = 0; j < s[i].length; j++)
                        if (s[i][j]) boards[1][r + i][c + j] = s[i][j];
                placed = true;
            }
            if (!placed) { complete = false; break; }
        }
        if (complete) return;
    }
}

// ---------- 就地划分（信念过滤的核心） ----------
// 仅保留 set[0..n) 中在 cell 处与观察 obs 一致的组合，返回新数量。
// 经典：obs = 0/1/2 精确匹配；伪装：obs=1 表示"≥1"（机头伪装成机身），
// obs=3 表示"确认真机身"（值为 1）。
function partitionBy(cell, obs, set, n, fake) {
    let m = 0;
    if (fake && obs === 1) {
        for (let i = 0; i < n; i++) {
            const ci = set[i];
            if (comboValAt(ci, cell) >= 1) set[m++] = ci;
        }
    } else if (fake && obs === 3) {
        for (let i = 0; i < n; i++) {
            const ci = set[i];
            if (comboValAt(ci, cell) === 1) set[m++] = ci;
        }
    } else {
        for (let i = 0; i < n; i++) {
            const ci = set[i];
            if (comboValAt(ci, cell) === obs) set[m++] = ci;
        }
    }
    return m;
}

// 增量同步 AI 的攻击知识（伪装模式下按模糊规则过滤）。
// 注意：伪装模式同一格会被询问两次（首击答 0/1，复查揭示 2/3），
// 观察值变化后必须重新过滤（在既有信念上做单调细化），不能只处理一次。
function syncAtk() {
    const fake = gameRule === "fake";
    for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++) {
            const idx = r * SIZE + c;
            const v = guesses[1][r][c];
            if (v !== null && atkObs[idx] !== v) {
                atkCount = partitionBy(idx, v, atkArr, atkCount, fake);
                atkObs[idx] = v;
            }
        }
}

// ---------- 每个格子是机头的概率 ----------
function headProbs() {
    const cnt = new Float64Array(SIZE * SIZE);
    for (let i = 0; i < atkCount; i++) {
        const ci = atkArr[i];
        cnt[headOfAt(ci, 0)]++;
        cnt[headOfAt(ci, 1)]++;
        cnt[headOfAt(ci, 2)]++;
    }
    const total = atkCount || 1;
    for (let i = 0; i < cnt.length; i++) cnt[i] /= total;
    return cnt;
}

// 每个格子被当前信念中的组合覆盖的次数
function coverCounts() {
    const cnt = new Float64Array(SIZE * SIZE);
    for (let i = 0; i < atkCount; i++) {
        const ci = atkArr[i];
        for (let k = 0; k < 3; k++) {
            const cells = shapeLists[k][comboStore[ci * 3 + k]].cells;
            for (const idx of cells) cnt[idx]++;
        }
    }
    return cnt;
}

// 未攻击过的格子列表
function unattacked() {
    const list = [];
    for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++)
            if (guesses[1][r][c] === null) list.push(r * SIZE + c);
    return list;
}

// 伪装模式可行动格：未攻击的格 + 显示1（未复查）的格
function actionable() {
    const list = [];
    for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++) {
            const v = guesses[1][r][c];
            if (v === null || v === 1) list.push(r * SIZE + c);
        }
    return list;
}

// 某玩家的观察标记：Int8Array，-1=未攻击；经典 0/1/2；伪装 0/1/2/3
function marksObs(player) {
    const mk = new Int8Array(SIZE * SIZE).fill(-1);
    for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++) {
            const v = guesses[player][r][c];
            if (v !== null) mk[r * SIZE + c] = v;
        }
    return mk;
}

// ---------- AI 选攻击格（入口，game.js 的 aiTurn 调用） ----------
function aiChooseAttack() {
    syncAtk();
    if (gameRule === "fake") {
        if (aiLevel === "easy") return aiEasyFake();
        if (aiLevel === "normal") return aiNormalFake();
        return hardCore(true, aiLevel === "worst" ? "max" : "mean");
    }
    if (aiLevel === "easy") return aiEasy();
    if (aiLevel === "normal") return aiNormal();
    return hardCore(false, aiLevel === "worst" ? "max" : "mean");
}

// easy（经典）：从未确定的格子中随机选一个攻击。
// "未确定" = 该格取值列在当前信念中不唯一（可能 0/1 混合或 1/2 混合）；
// 必空格（cover=0，开局即 4 个角）与必机身格（全覆盖且无机头）进攻必无收益，跳过。
function aiEasy() {
    const probs = headProbs();
    const cover = coverCounts();
    const total = atkCount;
    const list = unattacked().filter(cell =>
        cover[cell] > 0 && !(cover[cell] === total && probs[cell] === 0));
    if (list.length === 0) {
        const all = unattacked();
        return all[(Math.random() * all.length) | 0];
    }
    return list[(Math.random() * list.length) | 0];
}

// normal（经典）：每步严格打当前机头概率最大的格子（并列随机选）
function aiNormal() {
    const probs = headProbs();
    const cover = coverCounts();
    const list = unattacked().filter(cell => cover[cell] > 0);
    if (list.length === 0) {
        const all = unattacked();
        return all[(Math.random() * all.length) | 0];
    }
    let best = -1, bestCells = [];
    for (const cell of list) {
        if (probs[cell] > best) { best = probs[cell]; bestCells = [cell]; }
        else if (probs[cell] === best) bestCells.push(cell);
    }
    return bestCells[(Math.random() * bestCells.length) | 0];
}

// easy（伪装）：从未确定的格子中随机选一个攻击——
// 新格需非必空且非必机身；复查格需仍可能是机头（已确定必机身的复查无意义）
function aiEasyFake() {
    const probs = headProbs();
    const cover = coverCounts();
    const total = atkCount;
    const list = actionable().filter(cell => {
        const isRe = guesses[1][(cell / SIZE) | 0][cell % SIZE] === 1;
        if (isRe) return probs[cell] > 0 && probs[cell] < 1;
        return cover[cell] > 0 && !(cover[cell] === total && probs[cell] === 0);
    });
    if (list.length === 0) {
        const all = actionable();
        return all[(Math.random() * all.length) | 0];
    }
    return list[(Math.random() * list.length) | 0];
}

// normal（伪装）：严格按策略——机头概率最大，复查打折（低概率复查让位于探索）
function aiNormalFake() {
    const probs = headProbs();
    const cover = coverCounts();
    const total = atkCount;
    const list = actionable().filter(cell => {
        if (guesses[1][Math.floor(cell / SIZE)][cell % SIZE] === 1)
            return probs[cell] > 0.01;              // 复查格：机头概率≈0则剔除
        if (cover[cell] === 0) return false;         // 必然为0：剔除
        if (cover[cell] === total && probs[cell] === 0)
            return false;                            // 必然为机身：剔除
        return true;
    });
    if (list.length === 0) {
        const all = actionable();
        return all[(Math.random() * all.length) | 0];
    }
    let best = -1, bestCells = [];
    for (const cell of list) {
        const isRe = guesses[1][Math.floor(cell / SIZE)][cell % SIZE] === 1;
        const s = isRe ? probs[cell] * RECHECK_W : probs[cell];
        if (s > best) { best = s; bestCells = [cell]; }
        else if (s === best) bestCells.push(cell);
    }
    return bestCells[(Math.random() * bestCells.length) | 0];
}

// ===== 期望步数推演引擎（hard / lunatic / exact 共用） =====

// 就地划分：同 partitionBy（引擎内部热路径）
// 贪心收尾推演：从当前状态（marks+set）出发，按贪心策略打完 3 个机头所需步数。
// 策略与 normal 的实际打法完全一致（机头概率最大，复查格打折）——
// 这样"选期望步数最小的格"才真正是在优化实际会发生的后续对局。
// 注意：会原地修改 set 和 mk，调用方必须传入副本。
function rolloutSteps(set, n, truth, found, mk, fake) {
    let m = n, f = found, steps = 0;
    const cnt = new Float64Array(SIZE * SIZE);
    while (f < 3 && steps < 120) {
        cnt.fill(0);
        for (let i = 0; i < m; i++) {
            const ci = set[i];
            cnt[headOfAt(ci, 0)]++; cnt[headOfAt(ci, 1)]++; cnt[headOfAt(ci, 2)]++;
        }
        let best = -1, bs = -1;
        for (let cell = 0; cell < SIZE * SIZE; cell++) {
            const v = mk[cell];
            if (fake) {
                if (v === 0 || v === 2 || v === 3) continue;
                const s = (v === 1) ? cnt[cell] * RECHECK_W : cnt[cell];
                if (s > bs) { bs = s; best = cell; }
            } else {
                if (v >= 0) continue;
                if (cnt[cell] > bs) { bs = cnt[cell]; best = cell; }
            }
        }
        if (best === -1) break;
        steps++;
        const tv = comboValAt(truth, best);
        let obs;
        if (fake && mk[best] === 1) {            // 复查揭示真相
            obs = (tv === 2) ? 2 : 3;
            if (obs === 2) f++;
        } else if (fake) {                        // 首击机头伪装成 1
            obs = (tv === 2) ? 1 : tv;
        } else {
            obs = tv;
            if (tv === 2) f++;
        }
        mk[best] = obs;
        m = partitionBy(best, obs, set, m, fake);
    }
    return steps;
}

// 评估环境：信念子样本（cap 上限）+ K 个共享真相样本。
// 所有候选格共用同一批样本（公共随机数），比较噪声相互抵消。
function evalSetup(arr, n, budget) {
    const cap = Math.min(budget.cap, n);
    const set = new Int32Array(cap);
    if (n <= cap)
        for (let i = 0; i < cap; i++) set[i] = arr[i];
    else
        for (let i = 0; i < cap; i++) set[i] = arr[(Math.random() * n) | 0];
    const K = Math.min(budget.K, cap);
    const truths = new Int32Array(K);
    for (let k = 0; k < K; k++) truths[k] = set[(Math.random() * cap) | 0];
    return { set, cap, K, truths };
}

// 等价格分组：信念子样本上"取值列"完全相同的格子，无论攻哪一格、
// 真相是什么、后续信念如何，推演结果都严格相同 → 期望步数必然相等。
// 因此每个等价组只需评估一个代表格，结果对整组精确成立。
function groupCandidates(cands, set, cap) {
    const groups = new Map();
    for (const cell of cands) {
        let h = 0;
        for (let i = 0; i < cap; i++)
            h = (Math.imul(h, 31) + comboValAt(set[i], cell)) | 0;
        if (!groups.has(h)) groups.set(h, []);
        groups.get(h).push(cell);
    }
    return [...groups.values()];
}

// hard / lunatic / exact / worst 的攻击决策：
// 对每个候选格（等价组代表）计算"先攻它，再贪心打完"的步数，取最小者。
// agg='mean'：对真相样本取平均（期望步数，hard/exact）；
// agg='max' ：取最坏情况（对真相样本取最大，兜底/minimax，worst）。
//
// 候选格必须满足以下两条件之一（最优策略的必要条件）：
//   ① 进攻后剩余情况数减少 —— 该格取值列在当前信念中不唯一；
//   ② 该格是机头所在格。
// 因此取值唯一且非机头的格（必空 / 必机身）进攻必然白费一步，直接排除：
//   cover===0                    → 必空（所有组合都不覆盖它）；
//   cover===total && probs===0   → 必机身（所有组合都覆盖且无机头）。
// 伪装模式的例外：新格"全被覆盖且含机头可能"（列 ⊆ {1,2}）的首击虽不缩信念，
// 却是后续复查确认机头的必要铺垫，必须保留。
// 逐级精化（successive halving）抑制估计噪声的"胜者诅咒"。
function hardCore(fake, agg) {
    agg = agg || "mean";
    const probs = headProbs();
    const cover = coverCounts();
    const total = atkCount;
    const cands = [];
    if (fake) {
        for (const cell of actionable()) {
            const isRe = guesses[1][(cell / SIZE) | 0][cell % SIZE] === 1;
            if (isRe) {
                if (probs[cell] > 0) cands.push(cell);   // 复查：可确认机头或缩小信念
            } else if (cover[cell] > 0 &&
                       !(cover[cell] === total && probs[cell] === 0)) {
                cands.push(cell);                        // 新格：非必空且非必机身
            }
        }
    } else {
        for (const cell of unattacked())
            if (cover[cell] > 0 &&
                !(cover[cell] === total && probs[cell] === 0)) cands.push(cell);
    }
    if (cands.length === 0) {
        const all = fake ? actionable() : unattacked();
        return all[(Math.random() * all.length) | 0];
    }
    const budget = aiLevel === "exact" ? THINK.exact
                 : aiLevel === "worst" ? THINK.worst
                 : THINK.hard;
    const ev = evalSetup(atkArr, atkCount, budget);
    const groups = groupCandidates(cands, ev.set, ev.cap);
    const mk = marksObs(1);
    const found = headsFound[1];

    // 评估一个代表格：先攻 cell，再按贪心策略收尾的步数
    // （前 kCount 个真相样本；mean 取平均，max 取最坏）
    function evalGroupAt(cell, kCount) {
        let sum = 0, mx = -1;
        for (let k = 0; k < kCount; k++) {
            const mk2 = Int8Array.from(mk);
            const set2 = Int32Array.from(ev.set);
            let m = ev.cap, f = found;
            const tv = comboValAt(ev.truths[k], cell);
            let obs;
            if (fake && mk2[cell] === 1) {        // 复查
                obs = (tv === 2) ? 2 : 3;
                if (obs === 2) f++;
            } else {                               // 首击
                obs = (fake && tv === 2) ? 1 : tv;
                if (!fake && tv === 2) f++;
            }
            mk2[cell] = obs;
            m = partitionBy(cell, obs, set2, m, fake);
            const st = rolloutSteps(set2, m, ev.truths[k], f, mk2, fake);
            sum += st;
            if (st > mx) mx = st;
        }
        return agg === "max" ? mx : sum / kCount;
    }

    // 逐级精化（successive halving）：小样本粗筛全部等价组，
    // 每级用更多样本重评存活组、淘汰大半，最后一级以最大样本定胜负。
    // 终局信念可能小于满额样本数，kCount 需截断到实际可用的 truths 数。
    const stages = budget.stages || [[budget.K, budget.finalists || 6]];
    let survivors = groups, best = null;
    for (const [kCount, keep] of stages) {
        const kc = Math.min(kCount, ev.K);
        let scored = survivors.map(g => ({ g: g, E: evalGroupAt(g[0], kc) }));
        scored.sort(function (a, b) { return a.E - b.E; });
        const m = Math.min(keep, scored.length);
        survivors = scored.slice(0, m).map(x => x.g);
        best = scored.slice(0, m);
        if (m <= 1) break;
    }
    const g = (best && best.length ? best[0].g : [cands[0]]);
    return g[(Math.random() * g.length) | 0];
}

// lunatic 回答评估用：post 信念下玩家按贪心策略收尾的"最短步数"
// （对真相样本取最小 = 玩家运气最好时的步数；LUNATIC 要让这个最好情况尽量长）
function minSteps(arr, n, found, mk, budget, fake) {
    if (n === 0) return 100;
    const ev = evalSetup(arr, n, budget);
    let best = Infinity;
    for (let k = 0; k < ev.K; k++)
        best = Math.min(best, rolloutSteps(Int32Array.from(ev.set), ev.cap, ev.truths[k],
            found, Int8Array.from(mk), fake));
    return best;
}

// lunatic（经典）：不布置。玩家每次行动，从与已给回答一致的自洽数值中，
// 选使玩家"最短步数"（运气最好时的收尾步数）最长的那个显示，
// 即便玩家运气最好也要花很多步。并列时偏向泄露少的回答（v 越小越保守）。
function lunaticAnswer(r, c) {
    if (gameRule === "fake") return lunaticAnswerFake(r, c);
    const cell = r * SIZE + c;
    if (ansCount === 0) return (Math.random() * 3) | 0;
    const mk = marksObs(lunaticAskBoard);
    let bestVal = -1, bestScore = -Infinity;
    for (let v = 0; v <= 2; v++) {
        const post = Int32Array.from(ansArr.subarray(0, ansCount));
        let postN = partitionBy(cell, v, post, ansCount, false);
        if (postN === 0) continue;   // 会穿帮（自相矛盾）的回答不能给
        mk[cell] = v;
        const found = headsFound[lunaticAskBoard] + (v === 2 ? 1 : 0);   // 回答2=送提问方1个机头
        const score = minSteps(post, postN, found, mk, THINK.answer, false);
        if (score > bestScore + 1e-9) { bestScore = score; bestVal = v; }
    }
    if (bestVal === -1) return (Math.random() * 3) | 0;
    ansCount = partitionBy(cell, bestVal, ansArr, ansCount, false);   // 收紧"故事"
    return bestVal;
}

// lunatic（伪装）：同样不布置。首击可答 0（空）或 1（机身/伪装机头，模糊），
// 复查可答 2（机头）或 3（真机身），选使玩家"最短步数"最长的显示。
// isRe 读取 lunaticAskBoard 指定的观察板（主游戏=guesses[0]，检定=guesses[1]）。
function lunaticAnswerFake(r, c) {
    const cell = r * SIZE + c;
    const isRe = (guesses[lunaticAskBoard][r][c] === 1);   // 是否复查
    if (ansCount === 0)
        return isRe ? ((Math.random() < 0.5) ? 2 : 3)
                    : ((Math.random() < 0.5) ? 0 : 1);
    const mk = marksObs(lunaticAskBoard);
    const options = isRe ? [2, 3] : [0, 1];
    let bestVal = options[0], bestScore = -Infinity, any = false;
    for (const v of options) {
        const post = Int32Array.from(ansArr.subarray(0, ansCount));
        const postN = partitionBy(cell, v, post, ansCount, true);
        if (postN === 0) continue;   // 会穿帮（自相矛盾）的回答不能给
        mk[cell] = v;
        const found = headsFound[lunaticAskBoard] + (v === 2 ? 1 : 0);   // 回答2=送提问方1个机头
        const score = minSteps(post, postN, found, mk, THINK.answer, true);
        if (!any || score > bestScore + 1e-9) { bestScore = score; bestVal = v; any = true; }
    }
    if (!any) return options[(Math.random() * options.length) | 0];
    ansCount = partitionBy(cell, bestVal, ansArr, ansCount, true);   // 收紧"故事"
    return bestVal;
}

// lunatic 结算：从与所有已给回答一致的组合中，随机选一个作为展示布阵
function lunaticReveal() {
    const board = emptyBoard();
    if (ansCount === 0) return board;
    const ci = ansArr[(Math.random() * ansCount) | 0];
    for (let k = 0; k < 3; k++) {
        const p = shapeLists[k][comboStore[ci * 3 + k]];
        for (const idx of p.cells)
            board[Math.floor(idx / SIZE)][idx % SIZE] = p.vals[idx];
    }
    return board;
}
