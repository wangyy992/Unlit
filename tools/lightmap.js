// 逐关打印「哪一格站得住、对谁安全」的明暗图。用的是玩法判定本身的
// lightAt()，不是渲染出来的亮度 —— 两者的边界不一样，看图会看错。
//
//   node tools/lightmap.js          全部关卡
//   node tools/lightmap.js 17 18    指定关卡
//
//   +  够亮，光灵可以站        -  够暗，影灵可以站
//   #  实心（墙或关着的门）    空白  悬空，脚下没有地面
const { chromium } = require('playwright');

(async () => {
  // 环境里预装的 Chromium 可能和本地 playwright 版本对不上，允许用
  // PW_CHROMIUM 指定可执行文件（例如 /opt/pw-browsers/chromium）
  const browser = await chromium.launch(
    process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(process.env.URL || 'http://127.0.0.1:8810/index.html');
  await page.waitForTimeout(400);
  await page.click('#startBtn');

  const total = await page.evaluate(() => window.LEVELS.length);
  const wanted = process.argv.slice(2).map(Number).filter(Boolean);
  const list = wanted.length ? wanted : Array.from({ length: total }, (_, i) => i + 1);

  for (const lv of list) {
    const out = await page.evaluate(k => {
      window.__LS.jump(k);
      const L = window.__LS.level, T = 32, TH = 0.45;
      const solid = (tx, ty) => {
        if (tx < 0 || ty < 0 || tx >= L.cols || ty >= L.rows) return true;
        const i = ty * L.cols + tx;
        if (L.walls[i]) return true;
        const g = L.gateGroup[i];
        return g >= 0 && !L.gateOpen[g];
      };
      const lines = [];
      for (let ty = 0; ty < L.rows; ty++) {
        let s = '';
        for (let tx = 0; tx < L.cols; tx++) {
          if (solid(tx, ty)) { s += '#'; continue; }
          if (!solid(tx, ty + 1)) { s += ' '; continue; }      // 脚下没地面
          // 站在这一格上时角色中心所在的位置
          const v = window.__LS.lightAt(tx * T + T / 2, (ty + 1) * T - 13);
          s += v >= TH ? '+' : '-';
        }
        lines.push(s);
      }
      return { name: L.def.name, lines };
    }, lv);
    console.log(`=== ${lv}. ${out.name}`);
    out.lines.forEach((l, i) => console.log(String(i).padStart(2) + ' ' + l));
    console.log();
  }
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
