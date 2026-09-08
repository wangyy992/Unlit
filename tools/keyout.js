// 从 JPG 里抠掉「画上去的」棋盘格/纯色背景。
// 环境里没有图像库，借 Chromium 的 canvas 解码与重编码。
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');

const PORT = 8767;
const jobs = JSON.parse(process.argv[2]);

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    // 只访问本地；Chromium 的 phone-home 请求经代理会挂住
    args: ['--no-proxy-server', '--disable-background-networking', '--disable-component-update'],
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`);

  for (const job of jobs) {
    const url = '/' + job.in.split('/').map(encodeURIComponent).join('/');
    const res = await page.evaluate(async ([url, outW, tol, bT, crop]) => {
      const im = new Image();
      const ok = await new Promise(r => { im.onload = () => r(1); im.onerror = () => r(0); im.src = url; });
      if (!ok) return { err: '图片加载失败' };

      // 先缩到工作分辨率：最终只要一两百像素宽
      // 可选的预裁切：有些图远处有大面积的背景色差残留，
      // 先裁到物件所在区域，比反复调容差稳得多
      const cr = crop || [0, 0, 1, 1];
      const sx = im.naturalWidth * cr[0], sy = im.naturalHeight * cr[1];
      const sw = im.naturalWidth * (cr[2]-cr[0]), sh = im.naturalHeight * (cr[3]-cr[1]);
      const k = Math.min(1, 800 / Math.max(sw, sh));
      const W = Math.round(sw * k), H = Math.round(sh * k);
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(im, sx, sy, sw, sh, 0, 0, W, H);
      const img = cx.getImageData(0, 0, W, H), p = img.data;

      // 从四角取样背景调色板：物件可能压在某条边上（底部被裁的门），
      // 沿整圈统计会把物件自身的颜色算成背景
      const S = Math.max(10, Math.round(Math.min(W, H) * 0.05));
      const pal = [];
      for (const [ox, oy] of [[0,0],[W-S,0],[0,H-S],[W-S,H-S]])
        for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
          const i = ((oy+dy)*W + ox+dx) * 4;
          let hit = false;
          for (const q of pal)
            if (Math.abs(q[0]-p[i]) + Math.abs(q[1]-p[i+1]) + Math.abs(q[2]-p[i+2]) <= 14) { q[3]++; hit = true; break; }
          if (!hit) pal.push([p[i], p[i+1], p[i+2], 1]);
        }
      const total = 4*S*S;
      let bg = pal.filter(q => q[3] > total * 0.05).sort((a,b) => b[3]-a[3]).slice(0, 3);
      // 补上两两之间的中间色：JPEG 让格子边界发虚，不补的话填充会被虚边挡住
      const mids = [];
      for (let a = 0; a < bg.length; a++) for (let b = a+1; b < bg.length; b++)
        mids.push([(bg[a][0]+bg[b][0])>>1, (bg[a][1]+bg[b][1])>>1, (bg[a][2]+bg[b][2])>>1]);
      bg = bg.concat(mids);

      // 用 15 位量化色做查表，避免每像素都遍历调色板
      const lut = new Uint8Array(32768);
      for (let r = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++) {
        const R = r*8+4, G = g*8+4, B = b*8+4;
        for (const q of bg)
          if (Math.abs(R-q[0]) + Math.abs(G-q[1]) + Math.abs(B-q[2]) <= tol) { lut[(r<<10)|(g<<5)|b] = 1; break; }
      }
      const isBg = i => lut[((p[i]>>3)<<10) | ((p[i+1]>>3)<<5) | (p[i+2]>>3)];

      // 洪水填充：只删从边缘连通进来的背景，物件内部的同色区域保留。
      // 入栈即标记，否则非背景像素会被邻居反复入栈把栈撑爆
      const seen = new Uint8Array(W*H), st = new Int32Array(W*H);
      let sp = 0;
      const push = q => { if (!seen[q]) { seen[q] = 1; st[sp++] = q; } };
      for (let i = 0; i < W; i++) { push(i); push((H-1)*W + i); }
      for (let j = 0; j < H; j++) { push(j*W); push(j*W + W-1); }
      let keyed = 0;
      while (sp > 0) {
        const q = st[--sp], i = q*4;
        if (!isBg(i)) continue;
        p[i+3] = 0; keyed++;
        const px = q % W, py = (q / W) | 0;
        if (px > 0) push(q-1);
        if (px < W-1) push(q+1);
        if (py > 0) push(q-W);
        if (py < H-1) push(q+W);
      }
      cx.putImageData(img, 0, 0);

      // 行列直方图求包围盒：滤掉角落零星残留，比连通块标记快得多
      const rowN = new Int32Array(H), colN = new Int32Array(W);
      for (let q = 0; q < W*H; q++) if (p[q*4+3] > 16) { rowN[(q/W)|0]++; colN[q%W]++; }
      let maxR = 0, maxC = 0;
      for (let i = 0; i < H; i++) maxR = Math.max(maxR, rowN[i]);
      for (let i = 0; i < W; i++) maxC = Math.max(maxC, colN[i]);
      const rT = Math.max(2, maxR*bT), cT = Math.max(2, maxC*bT);   // 阈值放高才滤得掉稀疏残留
      let y0 = 0, y1 = H-1, x0 = 0, x1 = W-1;
      while (y0 < y1 && rowN[y0] < rT) y0++;
      while (y1 > y0 && rowN[y1] < rT) y1--;
      while (x0 < x1 && colN[x0] < cT) x0++;
      while (x1 > x0 && colN[x1] < cT) x1--;

      const bw = x1-x0+1, bh = y1-y0+1;
      const out = document.createElement('canvas');
      out.width = outW; out.height = Math.max(1, Math.round(outW * bh / bw));
      const oc = out.getContext('2d');
      oc.imageSmoothingQuality = 'high';
      oc.drawImage(cv, x0, y0, bw, bh, 0, 0, out.width, out.height);
      return { url: out.toDataURL('image/png'), src: im.naturalWidth+'x'+im.naturalHeight,
               box: bw+'x'+bh, out: out.width+'x'+out.height,
               keyed: Math.round(100*keyed/(W*H)) + '%',
               pal: bg.slice(0,3).map(q => q[0]+','+q[1]+','+q[2]).join(' / ') };
    }, [url, job.w, job.tol ?? 46, job.bT ?? 0.10, job.crop || null]);

    if (res.err) { console.log(path.basename(job.in), res.err); continue; }
    fs.writeFileSync(job.out, Buffer.from(res.url.split(',')[1], 'base64'));
    console.log(`${path.basename(job.in).slice(0, 44).padEnd(46)} 抠掉${res.keyed.padStart(4)}  物件${res.box.padEnd(9)} 背景[${res.pal}]`);
  }
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
