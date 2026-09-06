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
  var DRAIN_RATE = 1 / 0.4;    // 待错地方 0.4 秒消散：够容错，但不足以硬闯光柱
  var REFILL_RATE = 1 / 0.3;   // 回到安全区 0.3 秒回满

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
    if (e.code === 'KeyM') { muted = !muted; syncChrome(); }
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
  function beep(freq, dur, type, gain) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t = audioCtx.currentTime;
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
    death: function () { beep(150, 0.35, 'sawtooth', 0.05); },
    plate: function () { beep(760, 0.12, 'triangle', 0.05); beep(1140, 0.16, 'triangle', 0.03); },
    win: function () { beep(660, 0.13, 'triangle', 0.05); setTimeout(function () { beep(880, 0.22, 'triangle', 0.05); }, 120); },
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
        moveLampX(lamp, want);
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
    lightCtx.clearRect(0, 0, L.w, L.h);

    for (var i = 0; i < L.lamps.length; i++) {
      var lamp = L.lamps[i];
      var cx = lamp.x + lamp.w / 2;
      var cy = lamp.y + lamp.h / 2;
      var r = lamp.radius;

      lampCtx.clearRect(0, 0, L.w, L.h);
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

      lightCtx.globalCompositeOperation = 'lighter';
      lightCtx.drawImage(lampCanvas, 0, 0);
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
    p.onGround = false;
    movePlayerX(p, p.vx * dt);
    movePlayerY(p, p.vy * dt);

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
      if (want[g]) SFX.plate();
    }
  }

  function atDoor(p, door) {
    if (!door) return false;
    var zone = { x: door.x + 4, y: door.y - TILE + 6, w: TILE - 8, h: TILE * 2 - 8 };
    return overlap(p, zone);
  }

  function update(dt) {
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
    updatePlates();
    updateMeter(level.lumen, dt);
    updateMeter(level.umbra, dt);

    if (level.lumen.meter <= 0 || level.umbra.meter <= 0) {
      deaths++;
      state = 'dying';
      stateTimer = DEATH_TIME;
      SFX.death();
      syncChrome();
      return;
    }

    level.lumen.atDoor = atDoor(level.lumen, level.doors.lumen);
    level.umbra.atDoor = atDoor(level.umbra, level.doors.umbra);
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
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 死亡时轻微抖动
    if (state === 'dying') {
      var k = stateTimer / DEATH_TIME;
      ctx.translate((Math.random() - 0.5) * 8 * k, (Math.random() - 0.5) * 8 * k);
    }

    ctx.fillStyle = '#07070d';
    ctx.fillRect(-20, -20, L.w + 40, L.h + 40);
    drawTiles();

    if (lightDirty) renderLightMap();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(lightCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    drawPlates();
    drawDoor(L.doors.umbra, 'umbra', L.umbra.atDoor);
    drawDoor(L.doors.lumen, 'lumen', L.lumen.atDoor);
    drawLamps();
    drawPlayer(L.umbra);
    drawPlayer(L.lumen);

    if (state === 'dying') {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(120, 20, 40, ' + (0.45 * (stateTimer / DEATH_TIME)) + ')';
      ctx.fillRect(0, 0, L.w, L.h);
    }
    if (state === 'won') {
      ctx.fillStyle = 'rgba(255, 240, 210, ' + (0.35 * (1 - stateTimer / WIN_TIME)) + ')';
      ctx.fillRect(0, 0, L.w, L.h);
    }
  }

  function drawTiles() {
    var L = level;
    for (var ty = 0; ty < L.rows; ty++) {
      for (var tx = 0; tx < L.cols; tx++) {
        var i = ty * L.cols + tx;
        var x = tx * TILE, y = ty * TILE;
        var g = L.gateGroup[i];

        if (L.walls[i]) {
          ctx.fillStyle = '#1b1d2b';
          ctx.fillRect(x, y, TILE, TILE);
          if (!isSolidTile(tx, ty - 1)) {           // 顶面高光，让地形轮廓看得清
            ctx.fillStyle = '#2b2f45';
            ctx.fillRect(x, y, TILE, 3);
          }
        } else if (g >= 0) {
          if (L.gateOpen[g]) {
            ctx.fillStyle = 'rgba(90, 200, 170, 0.10)';
            ctx.fillRect(x + 12, y, 8, TILE);
          } else {
            ctx.fillStyle = '#243040';
            ctx.fillRect(x, y, TILE, TILE);
            ctx.fillStyle = GATE_COLORS[g];
            ctx.fillRect(x + 4, y, 3, TILE);
            ctx.fillRect(x + TILE - 7, y, 3, TILE);
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
    var x = door.x, y = door.y - TILE;
    var warm = type === 'lumen';
    var base = warm ? '255, 208, 120' : '164, 130, 255';
    var t = performance.now() / 600;
    var pulse = active ? 0.55 + 0.2 * Math.sin(t * 3) : 0.24;

    ctx.fillStyle = 'rgba(' + base + ', ' + (pulse * 0.35) + ')';
    ctx.fillRect(x + 3, y + 6, TILE - 6, TILE * 2 - 6);
    ctx.strokeStyle = 'rgba(' + base + ', ' + pulse + ')';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 3.5, y + 6.5, TILE - 7, TILE * 2 - 7);
    ctx.fillStyle = 'rgba(' + base + ', ' + (pulse + 0.25) + ')';
    ctx.fillRect(x + 3, y + TILE * 2 - 3, TILE - 6, 3);
  }

  function drawLamps() {
    level.lamps.forEach(function (lamp) {
      var cx = lamp.x + lamp.w / 2, cy = lamp.y + lamp.h / 2;
      if (lamp.fixed) {                            // 固定灯：吊在支架上，推不动
        ctx.strokeStyle = 'rgba(150, 150, 170, 0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, lamp.y - 8);
        ctx.lineTo(cx, lamp.y + 2);
        ctx.stroke();
      }
      ctx.fillStyle = lamp.pushable ? '#3b3324' : '#2a2a34';
      ctx.fillRect(lamp.x, lamp.y, lamp.w, lamp.h);
      ctx.strokeStyle = lamp.pushable ? 'rgba(255, 208, 130, 0.9)' : 'rgba(190, 186, 172, 0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(lamp.x + 1, lamp.y + 1, lamp.w - 2, lamp.h - 2);

      var glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 22);
      glow.addColorStop(0, 'rgba(255, 236, 190, 0.95)');
      glow.addColorStop(1, 'rgba(255, 200, 120, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, 22, 0, Math.PI * 2);
      ctx.fill();

      if (lamp.pushable) {                        // 可推的灯：两侧画箭头提示
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
    var cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    var danger = 1 - p.meter;

    // 角色自带一圈微光，保证在纯黑里也看得见
    var aura = ctx.createRadialGradient(cx, cy, 0, cx, cy, 30);
    aura.addColorStop(0, warm ? 'rgba(255, 214, 140, 0.42)' : 'rgba(150, 120, 255, 0.42)');
    aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(cx, cy, 30, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = warm ? '#ffd77a' : '#9b7bff';
    if (danger > 0.35) {                          // 濒死时闪烁
      var blink = 0.55 + 0.45 * Math.sin(performance.now() / (60 + 120 * p.meter));
      ctx.globalAlpha = 0.45 + 0.55 * blink;
    }
    roundRect(p.x, p.y, p.w, p.h, 5);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 眼睛：朝向移动方向
    ctx.fillStyle = warm ? '#3a2a08' : '#160f30';
    var ex = cx + p.facing * 3.5;
    ctx.fillRect(ex - 4, p.y + 8, 3, 4);
    ctx.fillRect(ex + 2, p.y + 8, 3, 4);
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
    els.hint.textContent = level.def.hint;
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
      btn.title = def.name;
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

  function loadLevel(i) {
    levelIndex = i;
    level = parseLevel(window.LEVELS[i]);
    canvas.width = lightCanvas.width = lampCanvas.width = level.w;
    canvas.height = lightCanvas.height = lampCanvas.height = level.h;
    canvas.style.setProperty('--natural-width', level.w + 'px');
    resetLevel();
    state = 'playing';
    syncChrome();
    fitCanvas();
  }

  function restart() {
    if (state === 'title' || state === 'complete') return;
    resetLevel();
    state = 'playing';
    syncChrome();
  }

  // 全屏时按原始比例把画布放到最大；退出时交还给 CSS
  function fitCanvas() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      canvas.style.width = '';
      canvas.style.height = '';
      return;
    }
    var box = canvas.parentElement.getBoundingClientRect();
    var scale = Math.min(box.width / level.w, box.height / level.h);
    canvas.style.width = Math.floor(level.w * scale) + 'px';
    canvas.style.height = Math.floor(level.h * scale) + 'px';
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
    state = 'playing';
    syncChrome();
    canvas.focus();
  }

  // ---------- 主循环 ----------
  function frame(now) {
    var dt = Math.min((now - lastTime) / 1000, 1 / 30);   // 卡顿时钳制步长，避免穿墙
    lastTime = now;
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

    ['levelName', 'hint', 'deaths', 'levels', 'lumenBar', 'umbraBar',
      'lumenMeter', 'umbraMeter', 'title', 'complete', 'mute'].forEach(function (id) {
      els[id] = document.getElementById(id);
    });

    els.mute.addEventListener('click', function () { muted = !muted; syncChrome(); canvas.focus(); });
    document.getElementById('fs').addEventListener('click', function () { toggleFullscreen(); canvas.focus(); });
    document.getElementById('startBtn').addEventListener('click', start);
    document.getElementById('replayBtn').addEventListener('click', function () { deaths = 0; loadLevel(0); });
    document.getElementById('restartBtn').addEventListener('click', function () { restart(); canvas.focus(); });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', fitCanvas);
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
