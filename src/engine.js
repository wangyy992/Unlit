/* 《光与影》引擎
 *
 * 纯原生 JS + Canvas，没有任何依赖。三块核心：
 *   1. 平台跳跃物理（AABB 网格碰撞 + coyote time + 跳跃缓冲）
 *   2. 2D 光线投射阴影（每盏灯把面向自己的墙边缘向外挤出成阴影多边形）
 *   3. 光暗判定（从灯到角色做一次视线检测，累加光强）
 */
(function () {
  'use strict';

  // ---------- 常量 ----------
  var TILE = 32;

  var GRAVITY = 1500;
  var MOVE_SPEED = 190;
  var ACCEL_GROUND = 2200;
  var ACCEL_AIR = 1200;
  var FRICTION = 2600;
  var JUMP_VEL = -490;   // 最高跳 80px = 2.5 格
  var MAX_FALL = 780;
  var COYOTE_TIME = 0.09;      // 离开地面后仍可起跳的宽限
  var JUMP_BUFFER = 0.10;      // 落地前提前按跳跃的宽限
  var JUMP_CUT = 0.45;         // 松开跳跃键时的速度衰减（短按 = 矮跳）

  var PLAYER_W = 20;
  var PLAYER_H = 26;

  var LAMP_SIZE = 30;    // 站上去后能翻过 3 格高的墙
  var LAMP_RADIUS = 400;
  var PUSH_FACTOR = 0.6;       // 推灯时的移速惩罚

  var LIT_THRESHOLD = 0.45;    // 光强超过这个值算「在光里」（= 半径的 55%，正好是肉眼可见的亮核）
  var DRAIN_RATE = 1 / 0.28;   // 0.28 秒消散：短于跳跃穿过光柱所需的 0.34 秒，光柱才真拦得住
  var REFILL_RATE = 1 / 0.25;  // 回到安全区 0.25 秒回满

  var DEATH_TIME = 0.55;
  var WIN_TIME = 1.1;

  var STORE_KEY = 'light-and-shadow/progress';

  // ---------- 全局状态 ----------
  var canvas, ctx, lightCanvas, lightCtx, lampCanvas, lampCtx;
  var level = null;
  var levelIndex = 0;
  var unlocked = 1;
  var state = 'title';   // title | playing | dying | won | complete
  var stateTimer = 0;
  var deaths = 0;
  var lightDirty = true;
  var muted = false;
  var lastTime = 0;
  var frameCount = 0;
  // 画布的内部分辨率必须跟上实际显示的物理像素，否则高清屏和全屏下
  // 相当于把一张 960 宽的图拉到两三千像素上，整个画面是糊的
  var renderScale = 1;
  var dust = [];
  var bursts = [];
  var booted = false;          // 首次载入时还没有用户手势，音频上下文会是挂起的
  var pushNoise = false;
  var pushTimer = 0;

  var keys = Object.create(null);
  var els = {};

  // ---------- 输入 ----------
  var BLOCKED = {
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1,
  };

  function onKeyDown(e) {
    if (BLOCKED[e.code]) e.preventDefault();
    if (keys[e.code]) return;          // 忽略按住时的重复触发
    keys[e.code] = true;

    if (e.code === 'KeyR') restart();
    if (e.code === 'KeyM') { toggleMute(); }
    if (e.code === 'KeyF') toggleFullscreen();
    if (state === 'title' && (e.code === 'Enter' || e.code === 'Space')) start();
    if (state === 'complete' && e.code === 'Enter') { loadLevel(0); }

    // 跳跃缓冲：按下的瞬间记一笔，落地时兑现
    if (level && state === 'playing') {
      if (e.code === 'ArrowUp') level.lumen.jumpBuffer = JUMP_BUFFER;
      if (e.code === 'KeyW') level.umbra.jumpBuffer = JUMP_BUFFER;
    }
  }

  function onKeyUp(e) {
    keys[e.code] = false;
    // 松键即断跳，做出可控的跳跃高度
    if (level && state === 'playing') {
      if (e.code === 'ArrowUp' && level.lumen.vy < 0) level.lumen.vy *= JUMP_CUT;
      if (e.code === 'KeyW' && level.umbra.vy < 0) level.umbra.vy *= JUMP_CUT;
    }
  }

  // ---------- 音效（WebAudio 现场合成，不需要素材文件）----------
  var audioCtx = null;
  function beep(freq, dur, type, gain, delay) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t = audioCtx.currentTime + (delay || 0);
      var osc = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(gain || 0.06, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + dur);
    } catch (err) { /* 音频不可用就静默跳过 */ }
  }
  var SFX = {
    jump: function () { beep(520, 0.09, 'square', 0.035); },
    land: function () { beep(170, 0.07, 'sine', 0.03); },
    push: function () { beep(88, 0.06, 'sawtooth', 0.022); },
    gate: function () { beep(520, 0.10, 'triangle', 0.045); beep(780, 0.18, 'triangle', 0.03, 0.09); },
    door: function () { beep(920, 0.16, 'sine', 0.035); },
    death: function () { beep(150, 0.35, 'sawtooth', 0.05); },
    levelStart: function () { beep(440, 0.10, 'sine', 0.03); beep(660, 0.14, 'sine', 0.025, 0.09); },
    win: function () { beep(660, 0.13, 'triangle', 0.05); beep(880, 0.22, 'triangle', 0.05, 0.12); },
  };

  // ---------- 关卡解析 ----------
  function parseLevel(def) {
    var grid = def.grid;
    var rows = grid.length;
    var cols = grid[0].length;
    var L = {
      def: def,
      cols: cols,
      rows: rows,
      w: cols * TILE,
      h: rows * TILE,
      walls: new Uint8Array(cols * rows),
      gateGroup: new Int8Array(cols * rows),
      gateOpen: [false, false, false, false],
      plates: [],
      lamps: [],
      doors: {},
      edges: [],
    };
    L.gateGroup.fill(-1);

    for (var ty = 0; ty < rows; ty++) {
      var row = grid[ty];
      for (var tx = 0; tx < cols; tx++) {
        var ch = row.charAt(tx);
        var i = ty * cols + tx;
        var px = tx * TILE;
        var py = ty * TILE;

        if (ch === '#') {
          L.walls[i] = 1;
        } else if (ch === 'L' || ch === 'U') {
          var p = makePlayer(ch === 'L' ? 'lumen' : 'umbra', px, py);
          if (ch === 'L') L.lumen = p; else L.umbra = p;
        } else if (ch === 'l' || ch === 'u') {
          L.doors[ch === 'l' ? 'lumen' : 'umbra'] = { tx: tx, ty: ty, x: px, y: py };
        } else if (ch === '*' || ch === 'o') {
          L.lamps.push({
            x: px + (TILE - LAMP_SIZE) / 2,
            y: py + TILE - LAMP_SIZE,
            w: LAMP_SIZE, h: LAMP_SIZE,
            vy: 0,
            pushable: ch === 'o',
            fixed: ch === '*',
            radius: LAMP_RADIUS,
            homeX: px + (TILE - LAMP_SIZE) / 2,
            homeY: py + TILE - LAMP_SIZE,
          });
        } else if (ch >= '1' && ch <= '4') {
          L.plates.push({ tx: tx, ty: ty, x: px, y: py, group: +ch - 1, hold: false, pressed: false });
        } else if (ch >= 'a' && ch <= 'd') {
          // 常压板：只在被压住时开门，松开就关。灯可以当配重压在上面。
          L.plates.push({ tx: tx, ty: ty, x: px, y: py, group: ch.charCodeAt(0) - 97, hold: true, pressed: false });
        } else if (ch >= 'A' && ch <= 'D') {
          L.gateGroup[i] = ch.charCodeAt(0) - 65;
        }
      }
    }
    return L;
  }

  function makePlayer(type, px, py) {
    return {
      type: type,
      x: px + (TILE - PLAYER_W) / 2,
      y: py + TILE - PLAYER_H,
      homeX: px + (TILE - PLAYER_W) / 2,
      homeY: py + TILE - PLAYER_H,
      w: PLAYER_W, h: PLAYER_H,
      vx: 0, vy: 0,
      onGround: false,
      coyote: 0,
      jumpBuffer: 0,
      facing: 1,
      meter: 1,
      lit: false,
      atDoor: false,
      anim: 0,
    };
  }

  function resetLevel() {
    var L = level;
    [L.lumen, L.umbra].forEach(function (p) {
      p.x = p.homeX; p.y = p.homeY;
      p.vx = 0; p.vy = 0;
      p.meter = 1; p.onGround = false;
      p.coyote = 0; p.jumpBuffer = 0; p.atDoor = false;
    });
    L.lamps.forEach(function (m) { m.x = m.homeX; m.y = m.homeY; m.vy = 0; });
    L.plates.forEach(function (pl) { pl.pressed = false; });
    L.gateOpen = [false, false, false, false];
    rebuildGeometry();
  }

  // ---------- 网格查询 ----------
  function isSolidTile(tx, ty) {
    var L = level;
    if (tx < 0 || ty < 0 || tx >= L.cols || ty >= L.rows) return true;  // 界外视为实心
    var i = ty * L.cols + tx;
    if (L.walls[i]) return true;
    var g = L.gateGroup[i];
    return g >= 0 && !L.gateOpen[g];
  }

  function rectHitsSolid(b) {
    var x0 = Math.floor(b.x / TILE);
    var x1 = Math.floor((b.x + b.w - 0.001) / TILE);
    var y0 = Math.floor(b.y / TILE);
    var y1 = Math.floor((b.y + b.h - 0.001) / TILE);
    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        if (isSolidTile(tx, ty)) return true;
      }
    }
    return false;
  }

  function overlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---------- 碰撞解算 ----------
  // 所有活动盒子都窄于一个格子，所以最多跨两列/两行，直接吸附到格子边界即可。
  function collideTilesX(b, dx) {
    if (!rectHitsSolid(b)) return false;
    if (dx > 0) b.x = Math.floor((b.x + b.w) / TILE) * TILE - b.w - 0.001;
    else b.x = (Math.floor(b.x / TILE) + 1) * TILE + 0.001;
    b.vx = 0;
    return true;
  }

  function collideTilesY(b, dy) {
    if (!rectHitsSolid(b)) return false;
    if (dy > 0) b.y = Math.floor((b.y + b.h) / TILE) * TILE - b.h - 0.001;
    else b.y = (Math.floor(b.y / TILE) + 1) * TILE + 0.001;
    b.vy = 0;
    return true;
  }

  function moveLampX(lamp, dx) {
    var startX = lamp.x;
    lamp.x += dx;
    collideTilesX(lamp, dx);
    level.lamps.forEach(function (other) {
      if (other === lamp || !overlap(lamp, other)) return;
      lamp.x = dx > 0 ? other.x - lamp.w : other.x + other.w;
    });
    if (lamp.x !== startX) lightDirty = true;
    return lamp.x - startX;
  }

  function movePlayerX(p, dx) {
    p.x += dx;
    collideTilesX(p, dx);

    for (var i = 0; i < level.lamps.length; i++) {
      var lamp = level.lamps[i];
      if (!overlap(p, lamp)) continue;
      if (lamp.pushable) {
        // 把灯推到刚好贴着玩家的位置
        var want = (dx > 0 ? p.x + p.w : p.x - lamp.w) - lamp.x;
        if (Math.abs(moveLampX(lamp, want)) > 0.2) pushNoise = true;
      }
      if (overlap(p, lamp)) {           // 灯推不动 → 玩家被挡住
        p.x = dx > 0 ? lamp.x - p.w : lamp.x + lamp.w;
        p.vx = 0;
      }
    }
  }

  function movePlayerY(p, dy) {
    p.y += dy;
    if (collideTilesY(p, dy) && dy > 0) p.onGround = true;

    for (var i = 0; i < level.lamps.length; i++) {
      var lamp = level.lamps[i];
      if (!overlap(p, lamp)) continue;
      if (dy > 0) { p.y = lamp.y - p.h; p.onGround = true; }
      else p.y = lamp.y + lamp.h;
      p.vy = 0;
    }
  }

  // 玩家正前方紧贴着一盏可推的灯 → 减速
  function isPushing(p, dir) {
    if (!dir) return false;
    var probe = { x: p.x + dir * 3, y: p.y, w: p.w, h: p.h };
    for (var i = 0; i < level.lamps.length; i++) {
      var lamp = level.lamps[i];
      if (lamp.pushable && overlap(probe, lamp)) return true;
    }
    return false;
  }

  // ---------- 光照 ----------
  // 把相邻的同向墙面合并成长边，大幅减少阴影多边形数量
  function rebuildGeometry() {
    var L = level;
    var edges = [];

    function run(horizontal, fixed, from, to, nx, ny) {
      if (horizontal) {
        // 水平边：法线朝上时从左往右，朝下时从右往左（保持一致绕向）
        if (ny < 0) edges.push({ ax: from * TILE, ay: fixed * TILE, bx: to * TILE, by: fixed * TILE, nx: nx, ny: ny });
        else edges.push({ ax: to * TILE, ay: fixed * TILE, bx: from * TILE, by: fixed * TILE, nx: nx, ny: ny });
      } else {
        if (nx < 0) edges.push({ ax: fixed * TILE, ay: to * TILE, bx: fixed * TILE, by: from * TILE, nx: nx, ny: ny });
        else edges.push({ ax: fixed * TILE, ay: from * TILE, bx: fixed * TILE, by: to * TILE, nx: nx, ny: ny });
      }
    }

    // 上下边：逐行扫描
    for (var ty = 0; ty < L.rows; ty++) {
      collectRun(ty, L.cols, function (tx) { return isSolidTile(tx, ty) && !isSolidTile(tx, ty - 1); },
        function (a, b) { run(true, ty, a, b, 0, -1); });
      collectRun(ty, L.cols, function (tx) { return isSolidTile(tx, ty) && !isSolidTile(tx, ty + 1); },
        function (a, b) { run(true, ty + 1, a, b, 0, 1); });
    }
    // 左右边：逐列扫描
    for (var tx2 = 0; tx2 < L.cols; tx2++) {
      collectRun(tx2, L.rows, function (ty) { return isSolidTile(tx2, ty) && !isSolidTile(tx2 - 1, ty); },
        function (a, b) { run(false, tx2, a, b, -1, 0); });
      collectRun(tx2, L.rows, function (ty) { return isSolidTile(tx2, ty) && !isSolidTile(tx2 + 1, ty); },
        function (a, b) { run(false, tx2 + 1, a, b, 1, 0); });
    }

    L.edges = edges;
    lightDirty = true;
  }

  function collectRun(_line, count, test, emit) {
    var start = -1;
    for (var i = 0; i < count; i++) {
      if (test(i)) { if (start < 0) start = i; }
      else if (start >= 0) { emit(start, i); start = -1; }
    }
    if (start >= 0) emit(start, count);
  }

  function project(px, py, cx, cy) {
    var dx = px - cx, dy = py - cy;
    var len = Math.hypot(dx, dy) || 1;
    var far = 4000;
    return { x: px + (dx / len) * far, y: py + (dy / len) * far };
  }

  function renderLightMap() {
    var L = level;
    lightCtx.setTransform(1, 0, 0, 1, 0, 0);
    lightCtx.clearRect(0, 0, lightCanvas.width, lightCanvas.height);
    lightCtx.setTransform(renderScale, 0, 0, renderScale, 0, 0);

    for (var i = 0; i < L.lamps.length; i++) {
      var lamp = L.lamps[i];
      var cx = lamp.x + lamp.w / 2;
      var cy = lamp.y + lamp.h / 2;
      var r = lamp.radius;

      lampCtx.setTransform(1, 0, 0, 1, 0, 0);
      lampCtx.clearRect(0, 0, lampCanvas.width, lampCanvas.height);
      lampCtx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
      var g = lampCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
      // 亮度必须在判定边界（半径的 55%）之后迅速收掉，
      // 否则玩家会看到一片「看着危险其实安全」的光晕，读不准哪里能站。
      g.addColorStop(0.00, 'rgba(255, 232, 178, 0.95)');
      g.addColorStop(0.20, 'rgba(255, 212, 142, 0.72)');
      g.addColorStop(0.40, 'rgba(250, 186, 106, 0.45)');
      g.addColorStop(0.55, 'rgba(238, 158, 82, 0.22)');
      g.addColorStop(0.68, 'rgba(214, 128, 62, 0.02)');
      g.addColorStop(1.00, 'rgba(200, 115, 55, 0)');
      lampCtx.fillStyle = g;
      lampCtx.beginPath();
      lampCtx.arc(cx, cy, r, 0, Math.PI * 2);
      lampCtx.fill();

      // 挖掉阴影：把每条面向灯的墙边缘沿光线方向挤出去
      lampCtx.globalCompositeOperation = 'destination-out';
      lampCtx.fillStyle = '#000';
      for (var e = 0; e < L.edges.length; e++) {
        var ed = L.edges[e];
        if ((ed.ax - cx) * ed.nx + (ed.ay - cy) * ed.ny >= 0) continue;  // 背光面不投影
        var p1 = project(ed.ax, ed.ay, cx, cy);
        var p2 = project(ed.bx, ed.by, cx, cy);
        lampCtx.beginPath();
        lampCtx.moveTo(ed.ax, ed.ay);
        lampCtx.lineTo(ed.bx, ed.by);
        lampCtx.lineTo(p2.x, p2.y);
        lampCtx.lineTo(p1.x, p1.y);
        lampCtx.closePath();
        lampCtx.fill();
      }
      lampCtx.globalCompositeOperation = 'source-over';

      lightCtx.setTransform(1, 0, 0, 1, 0, 0);   // 两层同尺寸，按物理像素 1:1 叠加
      lightCtx.globalCompositeOperation = 'lighter';
      lightCtx.drawImage(lampCanvas, 0, 0);
      lightCtx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    }
    lightCtx.globalCompositeOperation = 'source-over';
    lightDirty = false;
  }

  // 视线检测：灯和目标之间是否被实心格子挡住
  function blocked(x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0;
    var dist = Math.hypot(dx, dy);
    var steps = Math.ceil(dist / 6);
    for (var i = 1; i < steps; i++) {
      var t = i / steps;
      if (isSolidTile(((x0 + dx * t) / TILE) | 0, ((y0 + dy * t) / TILE) | 0)) return true;
    }
    return false;
  }

  function lightAt(px, py) {
    var total = 0;
    for (var i = 0; i < level.lamps.length; i++) {
      var lamp = level.lamps[i];
      var cx = lamp.x + lamp.w / 2, cy = lamp.y + lamp.h / 2;
      var d = Math.hypot(px - cx, py - cy);
      if (d >= lamp.radius) continue;
      if (blocked(cx, cy, px, py)) continue;
      total += 1 - d / lamp.radius;
    }
    return total;
  }

  // ---------- 更新 ----------
  function updatePlayer(p, dt, leftKey, rightKey, jumpKey) {
    var dir = (keys[rightKey] ? 1 : 0) - (keys[leftKey] ? 1 : 0);
    if (dir) p.facing = dir;

    var target = dir * MOVE_SPEED * (isPushing(p, dir) ? PUSH_FACTOR : 1);
    var rate = dir ? (p.onGround ? ACCEL_GROUND : ACCEL_AIR) : FRICTION;
    if (p.vx < target) p.vx = Math.min(target, p.vx + rate * dt);
    else if (p.vx > target) p.vx = Math.max(target, p.vx - rate * dt);

    p.coyote = p.onGround ? COYOTE_TIME : Math.max(0, p.coyote - dt);
    p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
    if (p.jumpBuffer > 0 && p.coyote > 0) {
      p.vy = JUMP_VEL;
      p.jumpBuffer = 0;
      p.coyote = 0;
      p.onGround = false;
      SFX.jump();
    }

    p.vy = Math.min(MAX_FALL, p.vy + GRAVITY * dt);
    var fallSpeed = p.vy;
    var wasGround = p.onGround;
    p.onGround = false;
    movePlayerX(p, p.vx * dt);
    movePlayerY(p, p.vy * dt);
    if (p.onGround && !wasGround && fallSpeed > 240) SFX.land();

    p.anim += Math.abs(p.vx) * dt * 0.05;
  }

  function updateMeter(p, dt) {
    var cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    p.lit = lightAt(cx, cy) >= LIT_THRESHOLD;
    var safe = p.type === 'lumen' ? p.lit : !p.lit;
    p.meter = Math.max(0, Math.min(1, p.meter + (safe ? REFILL_RATE : -DRAIN_RATE) * dt));
  }

  function updateLamps(dt) {
    level.lamps.forEach(function (lamp) {
      if (lamp.fixed) return;                 // 固定灯挂在墙上，不受重力
      lamp.vy = Math.min(MAX_FALL, lamp.vy + GRAVITY * dt);
      var before = lamp.y;
      lamp.y += lamp.vy * dt;
      collideTilesY(lamp, lamp.vy * dt);
      level.lamps.forEach(function (other) {
        if (other === lamp || !overlap(lamp, other)) return;
        if (lamp.vy > 0) { lamp.y = other.y - lamp.h; lamp.vy = 0; }
      });
      if (Math.abs(lamp.y - before) > 0.01) lightDirty = true;
    });
  }

  function updatePlates() {
    var L = level;
    var want = [false, false, false, false];

    L.plates.forEach(function (pl) {
      var box = { x: pl.x, y: pl.y + TILE - 10, w: TILE, h: 12 };
      var on = overlap(L.lumen, box) || overlap(L.umbra, box) ||
        L.lamps.some(function (m) { return overlap(m, box); });   // 灯也能压住板子
      pl.pressed = pl.hold ? on : (pl.pressed || on);             // 常闭板踩过一次就锁住
      if (pl.pressed) want[pl.group] = true;
    });

    for (var g = 0; g < 4; g++) {
      if (L.gateOpen[g] === want[g]) continue;
      L.gateOpen[g] = want[g];
      rebuildGeometry();                                          // 门的开合会改变阴影
      if (want[g]) SFX.gate();
    }
  }

  function atDoor(p, door) {
    if (!door) return false;
    var zone = { x: door.x + 4, y: door.y - TILE + 6, w: TILE - 8, h: TILE * 2 - 8 };
    return overlap(p, zone);
  }

  function update(dt) {
    updateBursts(dt);
    if (state === 'dying') {
      stateTimer -= dt;
      if (stateTimer <= 0) { resetLevel(); state = 'playing'; }
      return;
    }
    if (state === 'won') {
      stateTimer -= dt;
      if (stateTimer <= 0) {
        if (levelIndex + 1 < window.LEVELS.length) loadLevel(levelIndex + 1);
        else { state = 'complete'; syncChrome(); }
      }
      return;
    }
    if (state !== 'playing') return;

    updateLamps(dt);
    updatePlayer(level.lumen, dt, 'ArrowLeft', 'ArrowRight', 'ArrowUp');
    updatePlayer(level.umbra, dt, 'KeyA', 'KeyD', 'KeyW');
    updateDust(dt);
    pushTimer -= dt;
    if (pushNoise && pushTimer <= 0) { SFX.push(); pushTimer = 0.16; }
    pushNoise = false;

    updatePlates();
    updateMeter(level.lumen, dt);
    updateMeter(level.umbra, dt);

    if (level.lumen.meter <= 0 || level.umbra.meter <= 0) {
      var victim = level.lumen.meter <= 0 ? level.lumen : level.umbra;
      spawnBurst(victim.x + victim.w / 2, victim.y + victim.h / 2, victim === level.lumen);
      deaths++;
      state = 'dying';
      stateTimer = DEATH_TIME;
      SFX.death();
      syncChrome();
      return;
    }

    var wasAtDoor = level.lumen.atDoor && level.umbra.atDoor;
    var lumenWas = level.lumen.atDoor, umbraWas = level.umbra.atDoor;
    level.lumen.atDoor = atDoor(level.lumen, level.doors.lumen);
    level.umbra.atDoor = atDoor(level.umbra, level.doors.umbra);
    if ((level.lumen.atDoor && !lumenWas) || (level.umbra.atDoor && !umbraWas)) SFX.door();
    void wasAtDoor;
    if (level.lumen.atDoor && level.umbra.atDoor) {
      state = 'won';
      stateTimer = WIN_TIME;
      unlocked = Math.max(unlocked, Math.min(window.LEVELS.length, levelIndex + 2));
      saveProgress();
      SFX.win();
      syncChrome();
    }
  }

  // ---------- 绘制 ----------
  function draw() {
    var L = level;
    ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);

    // 死亡时轻微抖动
    if (state === 'dying') {
      var k = stateTimer / DEATH_TIME;
      ctx.translate((Math.random() - 0.5) * 8 * k, (Math.random() - 0.5) * 8 * k);
    }

    ctx.fillStyle = '#07070d';
    ctx.fillRect(-20, -20, L.w + 40, L.h + 40);
    if (ART.bg) {                                  // 有背景图就铺上，等比裁切填满
      var s = Math.max(L.w / ART.bg.naturalWidth, L.h / ART.bg.naturalHeight);
      var bw = ART.bg.naturalWidth * s, bh = ART.bg.naturalHeight * s;
      ctx.drawImage(ART.bg, (L.w - bw) / 2, (L.h - bh) / 2, bw, bh);
    }
    drawTiles();

    if (lightDirty) renderLightMap();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(lightCanvas, 0, 0, L.w, L.h);
    ctx.globalCompositeOperation = 'source-over';

    drawPlates();
    drawDoor(L.doors.umbra, 'umbra', L.umbra.atDoor);
    drawDoor(L.doors.lumen, 'lumen', L.lumen.atDoor);
    drawLamps();
    drawDust();
    drawPlayer(L.umbra);
    drawPlayer(L.lumen);
    drawBursts();
    drawVignette();

    if (state === 'dying') {
      ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
      ctx.fillStyle = 'rgba(120, 20, 40, ' + (0.45 * (stateTimer / DEATH_TIME)) + ')';
      ctx.fillRect(0, 0, L.w, L.h);
    }
    if (state === 'won') {
      ctx.fillStyle = 'rgba(255, 240, 210, ' + (0.35 * (1 - stateTimer / WIN_TIME)) + ')';
      ctx.fillRect(0, 0, L.w, L.h);
    }
  }

  // 四边压暗，把注意力收到画面中间
  function drawVignette() {
    var L = level;
    if (!vignette) {
      vignette = document.createElement('canvas');
      vignette.width = Math.round(L.w * renderScale);
      vignette.height = Math.round(L.h * renderScale);
      var vc = vignette.getContext('2d');
      vc.setTransform(renderScale, 0, 0, renderScale, 0, 0);
      var g = vc.createRadialGradient(L.w / 2, L.h / 2, Math.min(L.w, L.h) * 0.35,
                                      L.w / 2, L.h / 2, Math.max(L.w, L.h) * 0.72);
      g.addColorStop(0, 'rgba(0, 0, 0, 0)');
      g.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
      vc.fillStyle = g;
      vc.fillRect(0, 0, L.w, L.h);
    }
    ctx.drawImage(vignette, 0, 0, L.w, L.h);
  }

  var vignette = null;

  // 素材是可选的：任何一张加载失败都只是回退到程序绘制，不影响游戏运行
  var ART = {};
  function loadArt(map) {
    Object.keys(map).forEach(function (key) {
      var img = new Image();
      img.onload = function () { if (img.naturalWidth) ART[key] = img; };
      img.onerror = function () { /* 没有这张图就用程序画 */ };
      img.src = map[key];
    });
  }
  loadArt({
    wall: 'art/wall.jpg',
    bg: 'art/bg.jpg',
    doorLumen: 'art/door-lumen.png',
    doorUmbra: 'art/door-umbra.png',
    lampFixed: 'art/lamp-fixed.png',
    lampPush: 'art/lamp-push.png',
    ghostLumen: 'art/ghost-lumen.png',
    ghostUmbra: 'art/ghost-umbra.png',
    pressurePlate: 'art/pressure-plate.png',
    gateBlock: 'art/gate-block.png',
  });

  var tileLayer = null;
  var tileLayerArt = null;

  // 墙体每帧都重画的话，图案填充要跑几百次；它是静态的，预渲染一次即可
  function renderTileLayer() {
    var L = level;
    if (!tileLayer) tileLayer = document.createElement('canvas');
    tileLayer.width = Math.round(L.w * renderScale);
    tileLayer.height = Math.round(L.h * renderScale);
    var c = tileLayer.getContext('2d');
    c.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    var pat = ART.wall ? c.createPattern(ART.wall, 'repeat') : null;

    for (var ty = 0; ty < L.rows; ty++) {
      for (var tx = 0; tx < L.cols; tx++) {
        if (!L.walls[ty * L.cols + tx]) continue;
        var x = tx * TILE, y = ty * TILE;
        if (pat) {
          c.save();
          c.fillStyle = pat;
          // 贴图 8 格一个循环：一块面板正好两格宽，和角色尺寸相称
          c.setTransform(0.5, 0, 0, 0.5, 0, 0);
          c.fillRect(x * 2, y * 2, TILE * 2, TILE * 2);
          c.restore();
        } else {
          var jitter = (((tx * 73856093) ^ (ty * 19349663)) & 7) - 3.5;
          c.fillStyle = 'rgb(' + (26 + jitter) + ',' + (28 + jitter) + ',' + (42 + jitter) + ')';
          c.fillRect(x, y, TILE, TILE);
        }
        if (!isSolidTile(tx, ty - 1)) {            // 受光顶面：亮边 + 细高光
          c.fillStyle = 'rgba(70, 78, 116, 0.55)';
          c.fillRect(x, y, TILE, 4);
          c.fillStyle = 'rgba(96, 106, 150, 0.5)';
          c.fillRect(x, y, TILE, 1);
        }
        if (!isSolidTile(tx - 1, ty)) { c.fillStyle = 'rgba(60, 66, 96, 0.30)'; c.fillRect(x, y, 2, TILE); }
        if (!isSolidTile(tx + 1, ty)) { c.fillStyle = 'rgba(0, 0, 0, 0.45)'; c.fillRect(x + TILE - 2, y, 2, TILE); }
        if (!isSolidTile(tx, ty + 1)) { c.fillStyle = 'rgba(0, 0, 0, 0.55)'; c.fillRect(x, y + TILE - 3, TILE, 3); }
      }
    }
  }

  function drawTiles() {
    var L = level;
    // 贴图可能在开局之后才加载完，加载好了就重建一次
    if (!tileLayer || tileLayerArt !== !!ART.wall) { tileLayerArt = !!ART.wall; renderTileLayer(); }
    ctx.drawImage(tileLayer, 0, 0, L.w, L.h);

    for (var ty = 0; ty < L.rows; ty++) {          // 墙已经在离屏图里，这里只画会动的机关门
      for (var tx = 0; tx < L.cols; tx++) {
        var g = L.gateGroup[ty * L.cols + tx];
        if (g < 0) continue;
        var x = tx * TILE, y = ty * TILE;
        {
          var col = GATE_COLORS[g];
          if (L.gateOpen[g]) {                       // 已开：只剩两侧的门框余辉
            ctx.fillStyle = hexToRgba(col, 0.16);
            ctx.fillRect(x + 2, y, 2, TILE);
            ctx.fillRect(x + TILE - 4, y, 2, TILE);
          } else if (ART.gateBlock) {
            // 连续的竖向门只绘制一次完整机构，避免把门头和底座逐格重复。
            if (ty > 0 && L.gateGroup[(ty - 1) * L.cols + tx] === g) continue;
            var run = 1;
            while (ty + run < L.rows && L.gateGroup[(ty + run) * L.cols + tx] === g) run++;
            ctx.drawImage(ART.gateBlock, x - 2, y, TILE + 4, run * TILE);
            var gateGlow = ctx.createLinearGradient(x, y, x + TILE, y);
            gateGlow.addColorStop(0, hexToRgba(col, 0));
            gateGlow.addColorStop(0.5, hexToRgba(col, 0.38));
            gateGlow.addColorStop(1, hexToRgba(col, 0));
            ctx.fillStyle = gateGlow;
            ctx.fillRect(x + 6, y + 7, TILE - 12, run * TILE - 14);
          } else {
            ctx.fillStyle = '#1e2634';
            ctx.fillRect(x, y, TILE, TILE);
            // 能量条向上流动，让「关着」这件事是活的
            var flow = (performance.now() / 900 + tx * 0.13) % 1;
            var grd = ctx.createLinearGradient(x, y + TILE, x, y);
            grd.addColorStop(Math.max(0, flow - 0.35), hexToRgba(col, 0.28));
            grd.addColorStop(flow, hexToRgba(col, 0.95));
            grd.addColorStop(Math.min(1, flow + 0.35), hexToRgba(col, 0.28));
            ctx.fillStyle = grd;
            ctx.fillRect(x + 4, y, 3, TILE);
            ctx.fillRect(x + TILE - 7, y, 3, TILE);
            ctx.fillStyle = hexToRgba(col, 0.07);
            ctx.fillRect(x + 7, y, TILE - 14, TILE);
          }
        }
      }
    }
  }

  var GATE_COLORS = ['#6fe3c4', '#7fb3ff', '#d79bff', '#ffb37f'];

  function drawPlates() {
    level.plates.forEach(function (pl) {
      var color = GATE_COLORS[pl.group];
      var h = pl.pressed ? 5 : 10;
      var y = pl.y + TILE - h;

      if (ART.pressurePlate) {
        var ph = pl.pressed ? 10 : 15;
        ctx.drawImage(ART.pressurePlate, pl.x - 3, pl.y + TILE - ph, TILE + 6, ph);
        ctx.fillStyle = hexToRgba(color, pl.pressed ? 0.44 : 0.24);
        ctx.fillRect(pl.x + 5, pl.y + TILE - ph + 4, TILE - 10, 3);
        if (pl.hold) {
          ctx.strokeStyle = hexToRgba(color, 0.9);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(pl.x + 1, pl.y + TILE - ph - 2, TILE - 2, ph + 2);
        }
        return;
      }

      // 底座 + 与机关门同色的顶面，让「这块板对应那扇门」一眼可读
      ctx.fillStyle = 'rgba(20, 24, 38, 0.9)';
      ctx.fillRect(pl.x + 2, y, TILE - 4, h);
      ctx.fillStyle = pl.pressed ? color : 'rgba(150, 162, 196, 0.9)';
      ctx.fillRect(pl.x + 2, y, TILE - 4, 3);
      if (pl.hold) {                                    // 常压板：画一对卡口，表示「压住才算」
        ctx.fillStyle = hexToRgba(color, 0.75);
        ctx.fillRect(pl.x + 1, y - 5, 3, 6);
        ctx.fillRect(pl.x + TILE - 4, y - 5, 3, 6);
      }

      var glow = ctx.createRadialGradient(
        pl.x + TILE / 2, y, 0, pl.x + TILE / 2, y, pl.pressed ? 26 : 16);
      glow.addColorStop(0, hexToRgba(color, pl.pressed ? 0.5 : 0.22));
      glow.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(pl.x - 12, y - 22, TILE + 24, 26);
    });
  }

  function hexToRgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function drawDoor(door, type, active) {
    if (!door) return;
    var warm = type === 'lumen';
    var base = warm ? '255, 208, 120' : '164, 130, 255';
    var t = performance.now() / 600;
    var pulse = active ? 0.62 + 0.18 * Math.sin(t * 3) : 0.26;

    var x = door.x + 3, w = TILE - 6;
    var top = door.y - TILE + 6, bottom = door.y + TILE;
    var r = w / 2;

    var artDoor = warm ? ART.doorLumen : ART.doorUmbra;
    if (artDoor) {
      // 贴图门：底边对齐地面（金门原图底部被裁掉一截，正好被地板挡住）
      var dw = 38, dh = 64;
      var dx = door.x + (TILE - dw) / 2;
      ctx.drawImage(artDoor, dx, bottom - dh, dw, dh);
      if (active) {                                   // 站进去时门口亮起来
        var g2 = ctx.createRadialGradient(dx + dw / 2, bottom - 14, 0, dx + dw / 2, bottom - 14, 30);
        g2.addColorStop(0, 'rgba(' + base + ', 0.45)');
        g2.addColorStop(1, 'rgba(' + base + ', 0)');
        ctx.fillStyle = g2;
        ctx.fillRect(dx - 30, bottom - 44, dw + 60, 60);
      }
      return;
    }

    ctx.save();
    ctx.beginPath();                                  // 拱形轮廓：半圆顶 + 直墙
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, top + r);
    ctx.arc(x + r, top + r, r, Math.PI, 0);
    ctx.lineTo(x + w, bottom);
    ctx.closePath();

    // 门是墙上的一个洞：内腔画暗，才能在明亮区域里也看得出来
    ctx.fillStyle = 'rgba(8, 7, 14, 0.88)';
    ctx.fill();
    var grd = ctx.createLinearGradient(0, top, 0, bottom);
    grd.addColorStop(0, 'rgba(' + base + ', 0)');
    grd.addColorStop(1, 'rgba(' + base + ', ' + (pulse * 0.7) + ')');
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.strokeStyle = 'rgba(' + base + ', ' + Math.min(1, pulse + 0.35) + ')';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = 'rgba(' + base + ', ' + Math.min(1, pulse + 0.3) + ')';
    ctx.fillRect(x, bottom - 3, w, 3);                // 门槛

    if (active) {                                     // 站进去时整扇门亮起来
      var halo = ctx.createRadialGradient(x + r, bottom - 12, 0, x + r, bottom - 12, 34);
      halo.addColorStop(0, 'rgba(' + base + ', 0.38)');
      halo.addColorStop(1, 'rgba(' + base + ', 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(x - 34, bottom - 46, w + 68, 68);
    }
  }

  function drawLamps() {
    level.lamps.forEach(function (lamp) {
      var cx = lamp.x + lamp.w / 2, cy = lamp.y + lamp.h / 2;
      var artLamp = lamp.fixed ? ART.lampFixed : ART.lampPush;
      if (artLamp) {
        // 贴图灯：按原比例画，底边对齐碰撞盒底部（碰撞盒仍是 30x30，贴图只是外观）
        var lw = lamp.w + 4;
        var lh = lw * artLamp.naturalHeight / artLamp.naturalWidth;
        ctx.drawImage(artLamp, cx - lw / 2, lamp.y + lamp.h - lh, lw, lh);
        var core = ctx.createRadialGradient(cx, cy - lh * 0.18, 0, cx, cy - lh * 0.18, lw * 0.75);
        core.addColorStop(0, 'rgba(255, 246, 214, 0.95)');   // 灯芯：正好盖住玻璃罩里的残留
        core.addColorStop(0.5, 'rgba(255, 208, 130, 0.45)');
        core.addColorStop(1, 'rgba(255, 180, 90, 0)');
        ctx.fillStyle = core;
        ctx.fillRect(cx - lw, cy - lh, lw * 2, lh * 1.5);
        return;
      }

      if (lamp.fixed) {                            // 固定灯：吊在支架上，推不动
        ctx.strokeStyle = 'rgba(150, 150, 170, 0.45)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, lamp.y - 10);
        ctx.lineTo(cx, lamp.y + 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(150, 150, 170, 0.4)';
        ctx.fillRect(cx - 6, lamp.y - 12, 12, 3);
      }

      ctx.fillStyle = lamp.pushable ? '#3a3226' : '#2b2b35';   // 灯壳
      ctx.fillRect(lamp.x, lamp.y, lamp.w, lamp.h);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';                   // 底部阴影，做出厚度
      ctx.fillRect(lamp.x, lamp.y + lamp.h - 4, lamp.w, 4);

      var inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, lamp.w * 0.55);
      inner.addColorStop(0, 'rgba(255, 248, 224, 0.98)');      // 灯芯
      inner.addColorStop(0.45, 'rgba(255, 214, 140, 0.75)');
      inner.addColorStop(1, 'rgba(255, 180, 90, 0.05)');
      ctx.fillStyle = inner;
      ctx.fillRect(lamp.x + 3, lamp.y + 3, lamp.w - 6, lamp.h - 6);

      ctx.strokeStyle = lamp.pushable ? 'rgba(255, 214, 140, 0.9)' : 'rgba(190, 186, 172, 0.5)';
      ctx.lineWidth = 2;
      ctx.strokeRect(lamp.x + 1, lamp.y + 1, lamp.w - 2, lamp.h - 2);

      var glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 22);
      glow.addColorStop(0, 'rgba(255, 236, 190, 0.95)');
      glow.addColorStop(1, 'rgba(255, 200, 120, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, 22, 0, Math.PI * 2);
      ctx.fill();

      if (lamp.pushable) {                        // 可推的灯：滚轮 + 两侧箭头
        ctx.fillStyle = 'rgba(20, 16, 10, 0.85)';
        ctx.beginPath(); ctx.arc(lamp.x + 7, lamp.y + lamp.h - 1, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(lamp.x + lamp.w - 7, lamp.y + lamp.h - 1, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255, 224, 170, 0.55)';
        [[-7, -1], [lamp.w + 4, 1]].forEach(function (a) {
          ctx.beginPath();
          ctx.moveTo(lamp.x + a[0] + (a[1] < 0 ? 4 : 0), cy - 4);
          ctx.lineTo(lamp.x + a[0] + (a[1] < 0 ? 0 : 4), cy);
          ctx.lineTo(lamp.x + a[0] + (a[1] < 0 ? 4 : 0), cy + 4);
          ctx.closePath();
          ctx.fill();
        });
      }
    });
  }

  function drawPlayer(p) {
    var warm = p.type === 'lumen';
    var danger = 1 - p.meter;
    var now = performance.now();

    // 上升拉长、下落压扁 —— 一点点就够，跳跃立刻有了重量感
    var k = Math.max(-0.16, Math.min(0.16, -p.vy / 3000));
    var h = p.h * (1 + k), w = p.w * (1 - k * 0.8);
    var x = p.x + (p.w - w) / 2, y = p.y + (p.h - h);
    var cx = x + w / 2, cy = y + h / 2;

    if (p.onGround) {                             // 脚下的接触阴影，把人「放」在地面上
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.beginPath();
      ctx.ellipse(p.x + p.w / 2, p.y + p.h, p.w * 0.5, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 角色自带一圈微光，保证在纯黑里也看得见
    var aura = ctx.createRadialGradient(cx, cy, 0, cx, cy, 32);
    aura.addColorStop(0, warm ? 'rgba(255, 214, 140, 0.44)' : 'rgba(150, 120, 255, 0.44)');
    aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(cx, cy, 32, 0, Math.PI * 2);
    ctx.fill();

    if (danger > 0.3) {                           // 濒死时闪烁
      var flash = 0.55 + 0.45 * Math.sin(now / (55 + 110 * p.meter));
      ctx.globalAlpha = 0.4 + 0.6 * flash;
    }
    var ghostArt = warm ? ART.ghostLumen : ART.ghostUmbra;
    if (ghostArt) {
      // 美术角色略大于碰撞盒，让轮廓和微光在 32px 网格里仍然清楚。
      var spriteW = 31 * (1 - k * 0.45), spriteH = 31 * (1 + k * 0.55);
      ctx.save();
      ctx.translate(p.x + p.w / 2, p.y + p.h);
      ctx.scale(p.facing, 1);
      ctx.drawImage(ghostArt, -spriteW / 2, -spriteH, spriteW, spriteH);
      ctx.restore();
      ctx.globalAlpha = 1;
      return;
    }
    var body = ctx.createLinearGradient(0, y, 0, y + h);
    body.addColorStop(0, warm ? '#ffe6a4' : '#b79bff');
    body.addColorStop(1, warm ? '#f0b846' : '#7f5df0');
    ctx.fillStyle = body;
    roundRect(x, y, w, h, 6);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 眼睛：朝向移动方向，偶尔眨一下
    p.blink = (p.blink || 0) - 1;
    if (p.blink < -260) p.blink = 7;
    var shut = p.blink > 0;
    ctx.fillStyle = warm ? '#3a2a08' : '#180f34';
    var ex = cx + p.facing * 3.5, ey = y + h * 0.32;
    if (shut) {
      ctx.fillRect(ex - 4, ey + 1, 3, 1.5);
      ctx.fillRect(ex + 2, ey + 1, 3, 1.5);
    } else {
      ctx.fillRect(ex - 4, ey, 3, 4);
      ctx.fillRect(ex + 2, ey, 3, 4);
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- 界面外壳 ----------
  function syncChrome() {
    els.levelName.textContent = (levelIndex + 1) + '. ' + level.def.name;
    els.deaths.textContent = deaths;
    els.mute.textContent = muted ? '🔇 已静音 (M)' : '🔊 音效开 (M)';
    els.lumenBar.style.width = (level.lumen.meter * 100).toFixed(1) + '%';
    els.umbraBar.style.width = (level.umbra.meter * 100).toFixed(1) + '%';
    els.lumenMeter.classList.toggle('danger', level.lumen.meter < 0.4);
    els.umbraMeter.classList.toggle('danger', level.umbra.meter < 0.4);
    els.complete.hidden = state !== 'complete';
    els.title.hidden = state !== 'title';
    renderLevelButtons();
  }

  function renderLevelButtons() {
    if (els.levels.childElementCount === window.LEVELS.length) {
      Array.prototype.forEach.call(els.levels.children, function (btn, i) {
        btn.disabled = i >= unlocked;
        btn.classList.toggle('current', i === levelIndex);
      });
      return;
    }
    els.levels.innerHTML = '';
    window.LEVELS.forEach(function (def, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = (i + 1);
      btn.title = def.name + ' — ' + def.hint;
      btn.disabled = i >= unlocked;
      btn.classList.toggle('current', i === levelIndex);
      btn.addEventListener('click', function () { loadLevel(i); canvas.focus(); });
      els.levels.appendChild(btn);
    });
  }

  function loadProgress() {
    try {
      var v = parseInt(localStorage.getItem(STORE_KEY), 10);
      if (v >= 1) unlocked = Math.min(v, window.LEVELS.length);
    } catch (e) { /* 隐私模式下读不到就用默认值 */ }
  }

  function saveProgress() {
    try { localStorage.setItem(STORE_KEY, String(unlocked)); } catch (e) { /* 忽略 */ }
  }

  // 浮尘只在光里看得见 —— 正好把这个游戏的主题画出来
  function seedDust() {
    dust = [];
    for (var i = 0; i < 46; i++) {
      dust.push({
        x: Math.random() * level.w,
        y: Math.random() * level.h,
        vx: (Math.random() - 0.5) * 7,
        vy: -3 - Math.random() * 7,
        r: 0.6 + Math.random() * 1.3,
        lit: 0,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  function updateDust(dt) {
    for (var i = 0; i < dust.length; i++) {
      var d = dust[i];
      d.phase += dt * 1.6;
      d.x += (d.vx + Math.sin(d.phase) * 5) * dt;
      d.y += d.vy * dt;
      if (d.y < -4) { d.y = level.h + 4; d.x = Math.random() * level.w; }
      if (d.x < -4) d.x = level.w + 4;
      if (d.x > level.w + 4) d.x = -4;
      // 光强逐帧只算一部分粒子，避免每帧几千次视线检测
      if ((frameCount + i) % 5 === 0) d.lit = Math.min(1, lightAt(d.x, d.y) / LIT_THRESHOLD);
    }
  }

  function drawDust() {
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < dust.length; i++) {
      var d = dust[i];
      if (d.lit < 0.12) continue;                 // 暗处的尘埃本来就看不见
      ctx.fillStyle = 'rgba(255, 232, 190, ' + (0.30 * Math.min(1, d.lit)) + ')';
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function spawnBurst(px, py, warm) {
    for (var i = 0; i < 22; i++) {
      var a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 150;
      bursts.push({ x: px, y: py, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
                    life: 1, warm: warm });
    }
  }

  function updateBursts(dt) {
    for (var i = bursts.length - 1; i >= 0; i--) {
      var b = bursts[i];
      b.life -= dt * 1.8;
      if (b.life <= 0) { bursts.splice(i, 1); continue; }
      b.vy += 420 * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
  }

  function drawBursts() {
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < bursts.length; i++) {
      var b = bursts[i];
      ctx.fillStyle = (b.warm ? 'rgba(255, 206, 120, ' : 'rgba(160, 128, 255, ') + (b.life * 0.85) + ')';
      ctx.beginPath();
      ctx.arc(b.x, b.y, 1.2 + b.life * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function loadLevel(i) {
    levelIndex = i;
    level = parseLevel(window.LEVELS[i]);
    canvas.style.setProperty('--natural-width', level.w + 'px');
    applyScale(true);
    resetLevel();
    tileLayer = null;          // 关卡尺寸变了，墙体层要重建
    seedDust();
    bursts = [];
    state = 'playing';
    syncChrome();
    fitCanvas();
    if (booted) SFX.levelStart();
  }

  function restart() {
    if (state === 'title' || state === 'complete') return;
    resetLevel();
    state = 'playing';
    syncChrome();
  }

  // 按「CSS 显示宽度 × 设备像素比」决定画布的内部分辨率。
  // 精确匹配 CSS 像素与设备像素；量化会触发浏览器二次缩放，细线美术会发糊。
  function applyScale(force) {
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.getBoundingClientRect().width || level.w;
    var s = Math.min(4, Math.max(1, dpr * cssW / level.w));
    if (!force && Math.abs(s - renderScale) < 0.01) return;
    renderScale = s;
    var pw = Math.round(level.w * s), ph = Math.round(level.h * s);
    canvas.width = lightCanvas.width = lampCanvas.width = pw;
    canvas.height = lightCanvas.height = lampCanvas.height = ph;
    [ctx, lightCtx, lampCtx].forEach(function (c) {
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
    });
    tileLayer = null;                      // 各离屏层都要按新分辨率重建
    vignette = null;
    lightDirty = true;
  }

  // 全屏时按原始比例把画布放到最大；退出时交还给 CSS
  function fitCanvas() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      canvas.style.width = '';
      canvas.style.height = '';
      applyScale();
      return;
    }
    var box = canvas.parentElement.getBoundingClientRect();
    var scale = Math.min(box.width / level.w, box.height / level.h);
    canvas.style.width = Math.floor(level.w * scale) + 'px';
    canvas.style.height = Math.floor(level.h * scale) + 'px';
    applyScale();
  }

  function toggleMute() {
    muted = !muted;
    if (!muted) SFX.door();               // 开启时响一下，让人知道确实有声音
    syncChrome();
  }

  function toggleFullscreen() {
    var el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    }
  }

  function start() {
    booted = true;
    beep(0.0001, 0.01, 'sine', 0.0001);   // 借开始按钮这次点击解锁音频
    state = 'playing';
    syncChrome();
    canvas.focus();
  }

  // ---------- 主循环 ----------
  function frame(now) {
    var dt = Math.min((now - lastTime) / 1000, 1 / 30);   // 卡顿时钳制步长，避免穿墙
    lastTime = now;
    frameCount++;
    update(dt);
    draw();
    syncMeters();
    requestAnimationFrame(frame);
  }

  function syncMeters() {
    els.lumenBar.style.width = (level.lumen.meter * 100).toFixed(1) + '%';
    els.umbraBar.style.width = (level.umbra.meter * 100).toFixed(1) + '%';
    els.lumenMeter.classList.toggle('danger', level.lumen.meter < 0.4);
    els.umbraMeter.classList.toggle('danger', level.umbra.meter < 0.4);
  }

  function init() {
    canvas = document.getElementById('game');
    ctx = canvas.getContext('2d');
    lightCanvas = document.createElement('canvas');
    lightCtx = lightCanvas.getContext('2d');
    lampCanvas = document.createElement('canvas');
    lampCtx = lampCanvas.getContext('2d');

    ['levelName', 'deaths', 'levels', 'lumenBar', 'umbraBar',
      'lumenMeter', 'umbraMeter', 'title', 'complete', 'mute'].forEach(function (id) {
      els[id] = document.getElementById(id);
    });

    els.mute.addEventListener('click', function () { toggleMute(); canvas.focus(); });
    document.getElementById('fs').addEventListener('click', function () { toggleFullscreen(); canvas.focus(); });
    document.getElementById('startBtn').addEventListener('click', start);
    document.getElementById('replayBtn').addEventListener('click', function () { deaths = 0; loadLevel(0); });
    document.getElementById('restartBtn').addEventListener('click', function () { restart(); canvas.focus(); });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', function () { fitCanvas(); applyScale(); });
    document.addEventListener('fullscreenchange', fitCanvas);
    document.addEventListener('webkitfullscreenchange', fitCanvas);

    loadProgress();
    loadLevel(0);
    state = 'title';
    syncChrome();

    lastTime = performance.now();
    requestAnimationFrame(frame);
  }

  // 关卡调试 / 自动试玩用的钩子：window.__LS.jump(3) 直接跳到第 3 关
  window.__LS = {
    jump: function (n) { unlocked = window.LEVELS.length; loadLevel(n - 1); state = 'playing'; },
    get level() { return level; },
    get state() { return state; },
    lightAt: function (x, y) { return lightAt(x, y); },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
