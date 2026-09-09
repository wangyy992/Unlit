// 关卡可解性回归：给每一关写一条通关路线，用真实 KeyboardEvent 驱动，走完整输入链路。
// 截图看不出关卡能不能过 —— 门开在够不着的行、光柱宽到跳不过去、
// 灯被推下井之后再也回不来，这些都只有真跑一遍才知道。
//
//   npx playwright ...   先起一个静态服务器指向仓库根目录：
//   python3 -m http.server 8810      （单线程会被浏览器的长连接堵住，用 ThreadingHTTPServer）
//   node tools/playthrough.js        跑全部关卡
//   ONLY=17,18 node tools/playthrough.js   只跑指定关卡
const { chromium } = require('playwright');

// 每关的通关路线。全部用真实键盘事件驱动，走完整输入链路。
const BUDGET = { 17: 60000, 18: 90000 };

const SCRIPTS = {
  1: {
    lumen: [{ go: 26 }],
    umbra: [{ go: 26 }],
  },
  2: {
    // 光灵把灯一路推到门口；影灵必须等光柱移开才能跨缝
    lumen: [{ go: 25 }],
    umbra: [{ waitLampPast: 20 }, { runJump: [13, 17] }, { go: 25 }],
  },
  3: {
    lumen: [{ go: 8 }, { waitGate: 1 }, { go: 27 }],
    umbra: [{ waitGate: 0 }, { go: 17 }, { waitGate: 1 }, { go: 25 }],
  },
  4: {
    // 影灵先踩板开门 → 光灵推灯到墙边，跳上灯翻过 3 格墙 → 踩板放影灵过去
    umbra: [{ go: 9 }, { waitGate: 0 }, { go: 24 }],
    lumen: [{ waitGate: 1 }, { go: 18 }, { climbLamp: 21 }, { go: 26 }],  // 落地后走过压力板
  },
  5: {
    lumen: [{ go: 11 }, { waitGate: 0 }, { go: 20 }, { go: 25 }],
    umbra: [{ waitLampPast: 12 }, { runJump: [5, 9] }, { go: 11 },
            { waitLampPast: 21 }, { runJump: [13, 17] }, { go: 25 }],
  },
  6: {
    // 把灯推上常压板，跳过它，再走到门（前方有固定灯照路）
    lumen: [{ goX: 390 }, { hop: 15 }, { go: 26 }],
    umbra: [{ waitGate: 0 }, { go: 24 }],
  },
  7: {
    // 影灵先横穿井底并踩板；光灵才能把灯推下井，灯落在常压板上放影灵通行
    umbra: [{ go: 24 }, { waitGate: 0 }, { go: 27 }],
    lumen: [{ waitGate: 1 }, { goX: 502 }, { wait: 900 }, { goX: 545 }, { go: 21 }],
  },
  8: {
    // 一盏灯压板，另一盏当台阶翻墙
    umbra: [{ waitGate: 0 }, { go: 23 }],
    lumen: [{ goX: 280 }, { hop: 12 }, { goX: 429 }, { climbLamp: 17 }, { go: 25 }],
  },
  9: {
    // 先把灯送过去让影灵过第二道缝，再翻过灯把它推回来压住板子
    lumen: [{ go: 11 }, { waitUmbraPast: 9 }, { go: 20 }, { waitUmbraPast: 17 },
            { hop: 23 }, { goX: 500 }, { go: 27 }],
    umbra: [{ waitLampPast: 12 }, { runJump: [5, 9] }, { go: 11 },
            { waitLampPast: 21 }, { runJump: [13, 17] }, { go: 26 }],
  },
  10: {
    // 三层：影灵先开 B 门 → 光灵把灯丢到 C 层并跟下去 → 影灵过缝踩板开 A 门 → 各自进门
    umbra: [{ go: 4 }, { waitLampY: 400 }, { runJump: [5, 9] }, { runJump: [13, 17] },
            { go: 20 }, { go: 26 }, { go: 21 }],
    lumen: [{ waitGate: 1 }, { go: 12 }, { waitGate: 0 }, { go: 8 }],
  },
  12: {
    // 一盏灯两块常压板：先压 a 放影灵过第一道门，再挪到 b 放他过第二道
    lumen: [{ goX: 250 }, { waitUmbraPast: 17 }, { goX: 570 }, { waitGate: 2 }, { go: 27 }],
    umbra: [{ waitGate: 0 }, { runJump: [12, 16] }, { go: 19 },
            { waitGate: 1 }, { go: 24 }, { go: 27 }],
  },
  13: {
    // 灯1 留在常压板上，灯2 丢进井里照亮下层；人得先绕过灯1
    lumen: [{ goX: 110 }, { goX: 366 }, { goX: 400 }, { go: 9 }, { waitGate: 2 }, { go: 6 }],
    umbra: [{ waitGate: 0 }, { go: 8 }, { waitLampY: 400 },
            { runJump: [8, 12] }, { runJump: [18, 22] }, { go: 26 },
            { go: 21 }, { go: 25 }],
  },
  14: {
    // 影灵用身体压住板子给光灵开门；光灵把灯停在另一块板上再放影灵走
    umbra: [{ go: 5 }, { waitGate: 1 }, { go: 24 }],
    lumen: [{ waitGate: 0 }, { goX: 440 }, { hop: 17 }, { go: 22 }],
  },
  15: {
    // 光灵没有灯，全靠头顶漏下的光斑；黑暗处不能停
    umbra: [{ go: 10 }, { waitGate: 1 }, { go: 25 }],
    lumen: [{ waitGate: 0 }, { go: 20 }, { go: 25 }],
  },
  16: {
    // 两人反向走：影灵抢在光柱扫到之前穿过前两道缝，最后一道等灯过去再走
    lumen: [{ goX: 135 }],
    umbra: [{ runJump: [5, 9] }, { runJump: [13, 17] }, { go: 19 },
            { waitLampBefore: 19 }, { runJump: [21, 25] }, { go: 25 }],
  },
  17: {
    // 一盏灯压住 a 放影灵过第一道门；再踩死 3 号板开 C 门，人过去压住 b 放他过第二道
    lumen: [{ goX: 200 }, { waitGate: 0 }, { hop: 9 }, { goX: 310 }, { waitGate: 2 },
            { runJump: [13, 17] }, { goX: 590 }, { waitUmbraPast: 21 }, { go: 25 }],
    umbra: [{ waitGate: 0 }, { runJump: [5, 9] }, { runJump: [13, 17] },
            { waitGate: 1 }, { runJump: [21, 25] }, { go: 26 }],
  },
  18: {
    // 四层：牺牲一盏灯填进坑里开 A 门，另一盏一路带下去当光源和垫脚石
    lumen: [{ goX: 312 }, { waitGate: 0 }, { goX: 40 },
            { waitGate: 1 }, { go: 12 },
            { goX: 422 }, { goX: 292 }, { climbLeft: 1 }, { goX: 176 }, { waitGate: 2 },
            { goX: 486 }, { waitGate: 3 }, { go: 3 }],
    umbra: [{ waitGate: 0 }, { goX: 560 }, { runJump: [18.5, 22] }, { go: 24 },
            { goX: 860 }, { waitGate: 2 }, { goX: 646 },
            { goX: 710 }, { waitLumenBefore: [7, 17] }, { go: 27 }],
  },
  11: {
    // 四层：灯要往下丢两次；影灵在封死的竖井里等光灵抵达最底层踩板
    // 落到 C 层时人是站在灯顶上的，得先绕到灯的右侧才能把它往左推
    lumen: [{ go: 12 }, { goX: 460 }, { goX: 240 }, { wait: 600 },
            { goX: 205 }, { go: 9 }, { go: 12 }],
    umbra: [{ waitLampY: 400 }, { runJump: [7, 11] }, { runJump: [15, 19] },
            { go: 26 }, { waitGate: 0 }, { go: 22 }],
  },
};

(async () => {
  // 环境里预装的 Chromium 可能和本地 playwright 版本对不上，允许用
  // PW_CHROMIUM 指定可执行文件（例如 /opt/pw-browsers/chromium）
  const browser = await chromium.launch(
    process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(process.env.URL || 'http://127.0.0.1:8810/index.html');
  await page.waitForTimeout(300);
  await page.click('#startBtn');

  let allPass = true;
  for (const lv of (process.env.ONLY ? process.env.ONLY.split(',').map(Number) : Object.keys(SCRIPTS).map(Number))) {
    const result = await page.evaluate(async ([lv, script, budget]) => {
      window.__LS.jump(lv);
      const L = window.__LS.level, T = 32;
      const KEYS = { lumen: { l: 'ArrowLeft', r: 'ArrowRight', j: 'ArrowUp' },
                     umbra: { l: 'KeyA', r: 'KeyD', j: 'KeyW' } };
      const down = {};
      const press = (c, want) => {
        if (!!down[c] === !!want) return;
        down[c] = want;
        window.dispatchEvent(new KeyboardEvent(want ? 'keydown' : 'keyup', { code: c, bubbles: true }));
      };
      const releaseAll = () => Object.keys(down).forEach(c => press(c, false));

      const pushLamp = () => L.lamps.find(m => m.pushable);
      const tileOf = e => Math.round(e.x / T);

      // 每个角色跑自己的动作队列，两条队列并行推进
      const runners = {};
      for (const who of ['lumen', 'umbra']) {
        runners[who] = { queue: (script[who] || []).slice(), phase: null, t0: 0 };
      }

      const start = performance.now();
      let deathAt = null, dead = null, deadAt = null, lampAt = null;
      const initialDeaths = 0;

      while (performance.now() - start < budget) {
        await new Promise(r => requestAnimationFrame(r));
        const now = performance.now();

        if (window.__LS.state === 'dying') {
          deathAt = Math.round(now - start);
          dead = L.lumen.meter <= 0 ? '光灵' : '影灵';
          lampAt = L.lamps.filter(m => m.pushable)
            .map(m => `可推灯 格${(m.x / T).toFixed(1)} y=${Math.round(m.y)}`).join('; ');
          deadAt = `格${(( L.lumen.meter <= 0 ? L.lumen : L.umbra).x / T).toFixed(1)},y=${
            Math.round((L.lumen.meter <= 0 ? L.lumen : L.umbra).y)}`;
          break;
        }
        if (window.__LS.state !== 'playing') break;      // 过关

        for (const who of ['lumen', 'umbra']) {
          const R = runners[who], p = L[who], K = KEYS[who];
          const act = R.queue[0];
          if (!act) { press(K.l, false); press(K.r, false); continue; }

          if (act.wait !== undefined) {
            press(K.l, false); press(K.r, false);
            if (!R.t0) R.t0 = now;
            if (now - R.t0 > act.wait) { R.t0 = 0; R.queue.shift(); }

          } else if (act.go !== undefined || act.goX !== undefined) {
            const target = act.goX !== undefined ? act.goX : act.go * T + 6;
            const d = target - p.x;
            // 顶到墙或灯上就走不动了，卡住 600ms 也算这一步走完
            if (Math.abs(p.x - (R.lastX === undefined ? 1e9 : R.lastX)) > 1.5) { R.lastX = p.x; R.stillSince = now; }
            const stuck = p.onGround && R.stillSince && now - R.stillSince > 600;
            if (Math.abs(d) < 5 || stuck) {
              press(K.l, false); press(K.r, false);
              R.lastX = undefined; R.stillSince = 0; R.queue.shift();
            } else { press(K.r, d > 0); press(K.l, d < 0); }

          } else if (act.waitGate !== undefined) {
            press(K.l, false); press(K.r, false);
            if (L.gateOpen[act.waitGate]) R.queue.shift();

          } else if (act.waitLampY !== undefined) {
            press(K.l, false); press(K.r, false);
            if (L.lamps.some(m => m.pushable && m.y >= act.waitLampY)) R.queue.shift();

          } else if (act.waitLampBefore !== undefined) {
            press(K.l, false); press(K.r, false);
            if (tileOf(pushLamp()) <= act.waitLampBefore) R.queue.shift();

          } else if (act.waitLampPast !== undefined) {
            press(K.l, false); press(K.r, false);
            if (tileOf(pushLamp()) >= act.waitLampPast) R.queue.shift();

          } else if (act.waitUmbraPast !== undefined) {
            press(K.l, false); press(K.r, false);
            if (tileOf(L.umbra) >= act.waitUmbraPast) R.queue.shift();

          } else if (act.runJump) {                       // 助跑起跳跨过缝隙
            const [from, to] = act.runJump;
            press(K.r, true);
            if (!R.phase && p.x >= from * T + 8 && p.onGround) { press(K.j, true); R.phase = 'air'; R.t0 = now; }
            if (R.phase === 'air' && now - R.t0 > 380) press(K.j, false);
            if (R.phase === 'air' && p.onGround && p.x >= to * T - 8) {
              press(K.r, false); press(K.j, false); R.phase = null; R.queue.shift();
            } else if (R.phase === 'air' && p.onGround && now - R.t0 > 900) {
              press(K.r, false); press(K.j, false); R.phase = null;   // 没跳上去，退回去重来
              R.queue.unshift({ goX: from * T - 40 });
            }

          } else if (act.hop !== undefined) {
            if (!R.phase) { R.dir = act.hop * T > p.x ? 1 : -1; R.phase = 'go'; R.t0 = now; }
            press(R.dir > 0 ? K.r : K.l, true);
            press(R.dir > 0 ? K.l : K.r, false);
            if (R.phase === 'go' && p.onGround) { press(K.j, true); R.phase = 'air'; R.t0 = now; }
            if (R.phase === 'air' && now - R.t0 > 400) press(K.j, false);
            if (R.phase === 'air' && now - R.t0 > 520 && p.onGround) {
              const past = R.dir > 0 ? p.x > act.hop * T : p.x < act.hop * T;
              press(K.l, false); press(K.r, false); press(K.j, false);
              R.phase = past ? null : 'go';               // 没跳过去就再试一次
              if (past) R.queue.shift();
            }

          } else if (act.waitLumenBefore !== undefined) {
            press(K.l, false); press(K.r, false);
            const [col, row] = act.waitLumenBefore;
            if (L.lumen.x < col * T && L.lumen.y > row * T) R.queue.shift();

          } else if (act.climbLeft !== undefined) {       // 反复往左跳：地面 → 灯顶 → 高台
            const lamp = L.lamps.filter(m => m.pushable)
              .sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0];
            if (p.onGround && p.y + p.h < lamp.y - 8) {
              press(K.l, false); press(K.j, false); R.t0 = 0; R.queue.shift();
            } else if (p.onGround && (!R.t0 || now - R.t0 > 900)) {
              R.t0 = now; press(K.j, false); press(K.j, true); press(K.l, true);
            } else {
              if (now - R.t0 > 380) press(K.j, false);
              press(K.l, true);
            }

          } else if (act.climbLamp !== undefined) {       // 跳上灯 → 再跳过 3 格墙
            if (!R.phase) { R.phase = 'hop1'; R.t0 = now; press(K.r, false); press(K.j, true); }
            else if (R.phase === 'hop1') {
              if (now - R.t0 > 380) press(K.j, false);
              if (now - R.t0 > 120) press(K.r, true);
              const lampTop = pushLamp().y;
              if (p.onGround && Math.abs(p.y + p.h - lampTop) < 4) {   // 站到灯顶了
                press(K.r, false); press(K.j, false); R.phase = 'hop2'; R.t0 = now;
              } else if (now - R.t0 > 2000) { R.phase = null; }        // 没跳上去就重来
            } else if (R.phase === 'hop2') {
              if (now - R.t0 > 60) press(K.j, true);
              if (now - R.t0 > 440) press(K.j, false);
              if (now - R.t0 > 100) press(K.r, true);
              if (p.onGround && now - R.t0 > 700) {
                press(K.r, false); press(K.j, false); R.phase = null; R.queue.shift();
              } else if (now - R.t0 > 3000) { R.phase = null; }
            }
          }
        }
      }

      releaseAll();
      return {
        state: window.__LS.state,
        deathAt: deathAt, dead: dead, deadAt: deadAt, lampAt: lampAt,
        elapsed: Math.round(performance.now() - start),
        lumenTile: Math.round(L.lumen.x / T),
        umbraTile: Math.round(L.umbra.x / T),
        gates: L.gateOpen.slice(0, 2),
      };
    }, [lv, SCRIPTS[lv], BUDGET[lv] || 45000]);

    const ok = result.state === 'won' || result.state === 'complete';
    if (!ok) allPass = false;
    console.log(
      `第 ${lv} 关: ${ok ? '✅ 通关' : '❌ 未通关'}  用时 ${(result.elapsed / 1000).toFixed(1)}s` +
      (result.deathAt ? `  (${result.dead} 在 ${(result.deathAt / 1000).toFixed(1)}s 于 ${result.deadAt} 消散; ${result.lampAt})` : '') +
      `  终点: 光灵@${result.lumenTile} 影灵@${result.umbraTile}  机关门=${result.gates}`);
    await page.waitForTimeout(1400);   // 等过关动画走完
  }
  console.log(allPass ? '\n全部通关 ✅' : '\n有关卡打不通 ❌');
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
