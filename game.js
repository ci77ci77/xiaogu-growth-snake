/* ============================================================
   小桔成长贪吃蛇
   摄像头 → MediaPipe 手部关键点 → 指尖 → 桔子蛇头
   蓝色正向变大加分，灰色负向变小扣分。成绩记在本机。
   ============================================================ */

import { FilesetResolver, HandLandmarker } from './vendor/vision_bundle.mjs';

const CFG = {
  EMA: 0.55,
  MIN_STEP: 1.1,
  HEAD_R: 17,
  TAIL_R: 3.2,
  BODY_LEN0: 160,
  BODY_MIN: 78,
  BODY_MAX: 980,
  TRAIL_KEEP: 420,
  SAMPLES: 380,
  ROUND_SEC: 30,
  FIELD_N: 6,
  BAD_KEEP: 2
};

{
  const r = parseFloat(new URLSearchParams(location.search).get('round'));
  if (Number.isFinite(r) && r > 0) CFG.ROUND_SEC = Math.min(600, Math.round(r));
}

const ITEMS = {
  knowledge: { name: '知识', emoji: '📚', good: true,  score: 12, grow: 60, hit: 30 },
  goal:      { name: '目标', emoji: '🧭', good: true,  score: 12, grow: 60, hit: 30 },
  challenge: { name: '挑战', emoji: '💪', good: true,  score: 12, grow: 60, hit: 30 },
  collab:    { name: '协作', emoji: '🤝', good: true,  score: 12, grow: 60, hit: 30 },
  innovate:  { name: '创新', emoji: '💡', good: true,  score: 12, grow: 60, hit: 30 },
  skill:     { name: '技能', emoji: '🔧', good: true,  score: 12, grow: 60, hit: 30 },
  review:    { name: '复盘', emoji: '🌱', good: true,  score: 12, grow: 60, hit: 30 },
  comfort:   { name: '安逸', emoji: '😴', good: false, score: -10, grow: -68, hit: 30 },
  delay:     { name: '拖延', emoji: '😰', good: false, score: -10, grow: -68, hit: 30 },
  negative:  { name: '消极', emoji: '😤', good: false, score: -10, grow: -68, hit: 30 },
  anxiety:   { name: '焦虑', emoji: '😫', good: false, score: -10, grow: -68, hit: 30 },
  drain:     { name: '内耗', emoji: '🎭', good: false, score: -10, grow: -68, hit: 30 }
};
const GOOD_TYPES = Object.keys(ITEMS).filter(k => ITEMS[k].good);
const BAD_TYPES = Object.keys(ITEMS).filter(k => !ITEMS[k].good);

const CTRL_PTS = [
  { i: 8,  n: '食指尖' },
  { i: 12, n: '中指尖' },
  { i: 4,  n: '拇指尖' },
  { i: 16, n: '无名指尖' },
  { i: 20, n: '小指尖' },
  { i: 0,  n: '手腕' }
];
const CONN = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17]
];
const TIP_IDX = new Set([4, 8, 12, 16, 20]);

const BOARD_KEY = 'orange-snake-board-v1';
const MUTE_KEY = 'orange-snake-mute';

const $ = s => document.querySelector(s);
const stage = $('#stage');
const stagewrap = $('#stagewrap');
const titlebar = $('.titlebar');
const board = $('#board');
const overlay = $('#overlay');
const video = $('#video');
const camBox = $('#cam');
const screen = $('#screen');
const toastEl = $('#toast');
const legend = $('#legend');
const nameBox = $('#nameBox');
const nameInput = $('#nameInput');
const bctx = board.getContext('2d');
const octx = overlay.getContext('2d');
const ui = {
  score: $('#uiScore'), size: $('#uiSize'), fps: $('#uiFps'), time: $('#uiTime'),
  name: $('#uiName'),
  stat: $('#stat'), led: $('#led'), hint: $('#hint'),
  scrTitle: $('#scrTitle'), scrSub: $('#scrSub'), scrScore: $('#scrScore'),
  scrActions: $('#scrActions'), scrRules: $('#scrRules'), scrBoard: $('#scrBoard'),
  ctrlName: $('#ctrlptName'), ctrlId: $('#ctrlptId')
};

let W = 0, H = 0, DPR = 1;
let state = 'idle';          // idle | loading | ready | playing | over | error
let mode = 'cam';            // cam | demo
let running = false;
let ctrlIdx = 0;

let landmarker = null;
let lastVideoTime = -1;
let lastResult = null;

let pointer = null;
let handInfo = null;
let handStreak = 0, lostStreak = 99, overAt = 0;
let handLostAt = 0, lostGap = 0;

let trail = [];
let bodyLen = CFG.BODY_LEN0;
let score = 0;
let eaten = emptyEaten();
let timeLeft = CFG.ROUND_SEC;
let playStartAt = 0;
let foods = [];
let particles = [];
let mousePt = { x: 0, y: 0, inside: false };
let lastWholeSec = 0;
let toastTimer = 0;
let playerName = '';
let shake = 0;
let pulse = 0;
let mood = 'ok';
let moodUntil = 0;
let lastResultRank = null;
let leftAfterOver = false;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rand = (a, b) => a + Math.random() * (b - a);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function emptyEaten(){
  const o = {};
  for (const k of Object.keys(ITEMS)) o[k] = 0;
  return o;
}
function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function setStatus(text, led = ''){
  ui.stat.textContent = text;
  ui.led.className = 'led' + (led ? ' ' + led : '');
}
function toast(msg, ms = 1600){
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms);
}
function fmtTime(s){
  s = Math.max(0, Math.ceil(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function boardScale(){
  if (!W || !H) return 1;
  return clamp(Math.min(W, H) / 700, 1, 1.9);
}
function orangeScale(){
  const t = clamp((bodyLen - CFG.BODY_MIN) / 520, 0, 1);
  return 0.78 + t * 1.22;
}
function headRadius(){ return CFG.HEAD_R * boardScale() * orangeScale() * (1 + pulse * 0.06); }
function itemHit(type){ return ITEMS[type].hit * boardScale(); }
function sizeName(len){
  if (len >= 560) return '巨桔';
  if (len >= 380) return '大桔';
  if (len >= 240) return '中桔';
  if (len >= 140) return '小桔';
  return '桔核';
}
function tierOf(s){
  if (s >= 200) return { name: '橙王之王', cls: 't4' };
  if (s >= 140) return { name: '大胃桔', cls: 't3' };
  if (s >= 80) return { name: '阳光桔', cls: 't2' };
  return { name: '小桔芽', cls: 't1' };
}
function roundRect(c, x, y, w, h, r){
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

/* ---------------- 排行榜（本机） ---------------- */
function loadBoard(){
  try {
    const raw = JSON.parse(localStorage.getItem(BOARD_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(x => x && typeof x.name === 'string' && Number.isFinite(x.score));
  } catch { return []; }
}
function saveBoard(rows){
  localStorage.setItem(BOARD_KEY, JSON.stringify(rows.slice(0, 40)));
}
function commitScore(name, finalScore){
  const board = loadBoard();
  const key = name.trim();
  let row = board.find(x => x.name === key);
  let improved = false;
  if (!row){
    row = { name: key, score: finalScore, size: bodyLen, at: Date.now(), runs: 1 };
    board.push(row);
    improved = true;
  } else {
    row.runs = (row.runs || 1) + 1;
    if (finalScore > row.score){
      row.score = finalScore;
      row.size = bodyLen;
      row.at = Date.now();
      improved = true;
    }
  }
  board.sort((a, b) => b.score - a.score || a.at - b.at);
  saveBoard(board);
  const rank = board.findIndex(x => x.name === key) + 1;
  return { rank, total: board.length, improved, best: row.score, board };
}
function renderBoard(board, me){
  ui.scrBoard.classList.add('on');
  if (!board.length){
    ui.scrBoard.innerHTML = '<li class="empty">还没有成绩。这一局就能占第一名。</li>';
    return;
  }
  const top = board.slice(0, 6);
  const mine = me ? board.findIndex(x => x.name === me) : -1;
  const rows = top.map((row, i) => boardRow(row, i, me));
  if (mine >= 6){
    rows.push('<li class="gap"></li>');
    rows.push(boardRow(board[mine], mine, me));
  }
  ui.scrBoard.innerHTML = rows.join('');
}
function boardRow(row, index, me){
  const cls = ['r' + (index + 1), row.name === me ? 'me' : ''].filter(Boolean).join(' ');
  return '<li class="' + cls + '"><span class="rk">' + (index + 1) + '</span><span class="nm">' +
    esc(row.name) + '</span><span class="sc">' + row.score + '</span></li>';
}
function clearBoard(){
  if (!confirm('清空这台设备上的排行榜？')) return;
  localStorage.removeItem(BOARD_KEY);
  toast('排行榜已清空');
  if (state === 'over'){
    lastResultRank = { rank: '—', total: 0, improved: false, best: score, board: [] };
    timeUp(true);
  } else showRanks();
}

function captureName(){
  const name = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 12);
  if (!name){
    nameInput.classList.add('bad');
    nameBox.classList.add('on');
    toast('先写上你的名字');
    nameInput.focus();
    return null;
  }
  nameInput.classList.remove('bad');
  nameInput.value = name;
  playerName = name;
  ui.name.textContent = name;
  return name;
}

/* ---------------- 画面尺寸 ---------------- */
let lastStageW = 0, lastStageH = 0;

function fitStage(){
  const r = stagewrap.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  const useVideo = mode === 'cam' && video.videoWidth;
  const vw = useVideo ? video.videoWidth : 16;
  const vh = useVideo ? video.videoHeight : 10;
  const ar = vw / vh;
  const chrome = titlebar ? titlebar.offsetHeight : 0;
  const pad = 28;
  let w = r.width - pad;
  let h = w / ar + chrome;
  if (h > r.height - pad){ h = r.height - pad; w = (h - chrome) * ar; }
  w = Math.max(280, Math.floor(w));
  h = Math.max(200, Math.floor(h));
  if (w === lastStageW && h === lastStageH) return;
  lastStageW = w; lastStageH = h;
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  void stage.offsetWidth;
  resizeBoard();
}
function resizeBoard(){
  const r = board.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  const d = Math.min(window.devicePixelRatio || 1, 2);
  if (w === W && h === H && d === DPR && backdrop.width) return;
  DPR = d; W = w; H = h;
  board.width = Math.round(W * DPR);
  board.height = Math.round(H * DPR);
  bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  buildBackdrop();
  initLeaves();
  if (state === 'playing' || state === 'ready' || state === 'over') relocateFoods(performance.now());
}
function relocateFoods(now){
  if (!W || !H) return;
  const pad = 42;
  const ok = foods.every(f => f.x >= pad && f.x <= W - pad && f.y >= pad && f.y <= H - pad);
  if (ok && foods.length >= CFG.FIELD_N) return;
  foods.length = 0;
  refill(now);
}
function toBoard(nx, ny){
  if (mode !== 'cam' || !video.videoWidth) return { x: nx * W, y: ny * H };
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.min(W / vw, H / vh);
  const dw = vw * s, dh = vh * s;
  return { x: (W - dw) / 2 + nx * dw, y: (H - dh) / 2 + ny * dh };
}

/* ---------------- 背景 ---------------- */
const backdrop = document.createElement('canvas');
let leaves = [];

function buildBackdrop(){
  if (!W || !H) return;
  backdrop.width = Math.round(W * DPR);
  backdrop.height = Math.round(H * DPR);
  const c = backdrop.getContext('2d');
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  const R = Math.max(W, H);
  const CX = W * 0.5, CY = H * 0.42;
  const g = c.createRadialGradient(CX, CY, 0, CX, CY, R * 0.78);
  g.addColorStop(0, '#FFFDF8');
  g.addColorStop(0.42, '#FFF1DE');
  g.addColorStop(1, '#FFD7A6');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);

  c.save();
  c.translate(CX, CY);
  for (let i = 0; i < 28; i++){
    const a = (i / 28) * Math.PI * 2;
    const w1 = 0.045 + (i % 3) * 0.012;
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, R, a - w1, a + w1);
    c.closePath();
    c.fillStyle = 'rgba(255,255,255,' + (0.08 + (i % 2) * 0.07) + ')';
    c.fill();
  }
  c.restore();

  const glow = c.createRadialGradient(CX, CY, 0, CX, CY, R * 0.34);
  glow.addColorStop(0, 'rgba(255,255,255,.72)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = glow;
  c.fillRect(0, 0, W, H);

  citrusSlice(c, W * 0.07, H * 0.9, Math.min(W, H) * 0.055);
  citrusSlice(c, W * 0.94, H * 0.08, Math.min(W, H) * 0.04);
}
function citrusSlice(c, x, y, r){
  c.save();
  c.translate(x, y);
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  const g = c.createRadialGradient(-r * 0.2, -r * 0.2, r * 0.1, 0, 0, r);
  g.addColorStop(0, 'rgba(255,214,140,.55)');
  g.addColorStop(1, 'rgba(255,140,40,.28)');
  c.fillStyle = g;
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,.7)';
  c.lineWidth = Math.max(2, r * 0.08);
  c.stroke();
  c.strokeStyle = 'rgba(255,255,255,.45)';
  c.lineWidth = 1;
  for (let i = 0; i < 6; i++){
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(Math.cos(i) * r * 0.86, Math.sin(i) * r * 0.86);
    c.stroke();
  }
  c.restore();
}
function initLeaves(){
  leaves = [];
  const n = Math.round(clamp(W / 110, 7, 14));
  for (let i = 0; i < n; i++) leaves.push(newLeaf(false));
}
function newLeaf(fromTop){
  return {
    x: rand(0, Math.max(W, 1)),
    y: fromTop ? rand(-40, -8) : rand(0, Math.max(H, 1)),
    s: rand(5, 11),
    vy: rand(0.22, 0.55),
    rot: rand(0, 6),
    vr: rand(-0.01, 0.01),
    ph: rand(0, 6),
    green: Math.random() > 0.35
  };
}
function drawLeaves(now){
  for (let i = 0; i < leaves.length; i++){
    const p = leaves[i];
    p.y += p.vy;
    p.x += Math.sin(now / 900 + p.ph) * 0.35;
    p.rot += p.vr;
    if (p.y > H + 16){ leaves[i] = newLeaf(true); continue; }
    bctx.save();
    bctx.translate(p.x, p.y);
    bctx.rotate(p.rot);
    bctx.fillStyle = p.green ? 'rgba(80,170,90,.28)' : 'rgba(255,150,40,.28)';
    bctx.beginPath();
    bctx.ellipse(0, 0, p.s, p.s * 0.46, 0, 0, Math.PI * 2);
    bctx.fill();
    bctx.restore();
  }
}

/* ---------------- 食物 ---------------- */
function pickFrom(list){
  const present = new Set(foods.map(f => f.type));
  const avail = list.filter(t => !present.has(t));
  const pool = avail.length ? avail : list;
  return pool[Math.floor(Math.random() * pool.length)];
}
function trailClearance(x, y){
  let best = Infinity;
  const head = trail.length ? trail[trail.length - 1] : null;
  if (head) best = Math.hypot(head.x - x, head.y - y);
  for (let i = 0; i < trail.length; i += 6){
    const d = Math.hypot(trail[i].x - x, trail[i].y - y);
    if (d < best) best = d;
  }
  for (const f of foods){
    const d = Math.hypot(f.x - x, f.y - y);
    if (d < best) best = d;
  }
  return best;
}
function spawnOne(now, wantBad){
  const type = wantBad ? pickFrom(BAD_TYPES) : pickFrom(GOOD_TYPES);
  const pad = Math.max(72, itemHit(type) + 36);
  let best = null, bestD = -1;
  const x1 = Math.max(pad + 8, W - pad);
  const y1 = Math.max(pad + 8, H - pad);
  for (let k = 0; k < 80; k++){
    const x = rand(pad, x1);
    const y = rand(pad, y1);
    const d = trailClearance(x, y);
    if (d > 64 * boardScale() + 36){ best = { x, y }; break; }
    if (d > bestD){ bestD = d; best = { x, y }; }
  }
  if (!best) best = { x: rand(pad, x1), y: rand(pad, y1) };
  foods.push({ x: best.x, y: best.y, type, seed: rand(0, 6.28), born: now });
}
function refill(now){
  if (!W || !H) return;
  while (foods.length < CFG.FIELD_N){
    const badCount = foods.filter(f => !ITEMS[f.type].good).length;
    spawnOne(now, badCount < CFG.BAD_KEEP);
  }
}

function applyEat(item, spec){
  score = Math.max(0, score + spec.score);
  bodyLen = clamp(bodyLen + spec.grow, CFG.BODY_MIN, CFG.BODY_MAX);
  eaten[item.type] += 1;
  pulse = spec.good ? 1 : -1;
  mood = spec.good ? 'yum' : 'cry';
  moodUntil = performance.now() + (spec.good ? 420 : 1100);
  if (!spec.good) shake = 7;
  burst(item.x, item.y, spec.good);
  floatText(item.x, item.y, spec);
  Sound.sfx(spec.good ? 'catch' : 'bad');
  syncUI();
  const verb = spec.good ? '变大了' : '缩小了';
  ui.hint.textContent = '// ' + spec.name + ' ' + (spec.score > 0 ? '+' : '') + spec.score + ' · ' + verb + ' · ' + sizeName(bodyLen);
}
function checkFood(){
  const head = liveHead();
  if (!head) return;
  const hr = headRadius();
  let ate = false;
  for (let i = foods.length - 1; i >= 0; i--){
    const f = foods[i];
    if (dist(head, f) <= hr + itemHit(f.type)){
      const spec = ITEMS[f.type];
      foods.splice(i, 1);
      applyEat(f, spec);
      ate = true;
    }
  }
  if (ate) refill(performance.now());
}
function burst(x, y, good){
  const n = good ? 14 : 10;
  for (let i = 0; i < n; i++){
    const a = rand(0, Math.PI * 2), sp = rand(0.6, 3.1);
    particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (good ? 0.4 : 0),
      life: 1, kind: 'chip', good,
      rot: rand(0, 6), vr: rand(-0.2, 0.2),
      len: rand(3, 7), wid: rand(1.4, 2.8)
    });
  }
}
function floatText(x, y, spec){
  const sign = spec.score > 0 ? '+' : '';
  particles.push({
    x, y: y - 22, vx: 0, vy: -0.5, life: 1, kind: 'score',
    text: sign + spec.score + ' ' + spec.name,
    color: spec.good ? '#C2410C' : '#57534E'
  });
}

/* ---------------- 音效 ---------------- */
const Sound = (() => {
  let ctx = null, master = null, musicBus = null, sfxBus = null;
  let muted = localStorage.getItem(MUTE_KEY) === '1';
  let musicOn = false, schedTimer = 0, step = 0, nextT = 0;
  const BPM = 108, STEP = 60 / BPM / 2;
  const m2f = m => 440 * Math.pow(2, (m - 69) / 12);
  const PROG = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [57, 60, 64]];
  const ARP = [0, 1, 2, 1, 0, 2, 1, 2];
  const MEL = [76, 0, 79, 0, 76, 72, 74, 0, 72, 0, 67, 0, 69, 72, 74, 0];

  function ensure(){
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 1; master.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = 0.42; musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master);
    return true;
  }
  function unlock(){ if (ensure() && ctx.state === 'suspended') ctx.resume(); }
  function tone(t, f, dur, vol, type, bus){
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'triangle';
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus || musicBus);
    o.start(t); o.stop(t + dur + 0.04);
  }
  function schedule(){
    const ahead = ctx.currentTime + 0.2;
    while (nextT < ahead){
      const bar = Math.floor(step / 8) % 4, inBar = step % 8;
      const ch = PROG[bar];
      tone(nextT, m2f(ch[ARP[inBar]]), 0.28, 0.09, 'triangle');
      if (inBar === 0 || inBar === 4) tone(nextT, m2f(ch[0] - 12), 0.5, 0.11, 'sine');
      const m = MEL[step % MEL.length];
      if (m) tone(nextT, m2f(m), 0.42, 0.04, 'sine');
      nextT += STEP; step++;
    }
  }
  function startMusic(){
    unlock();
    if (!ctx || musicOn) return;
    musicOn = true; step = 0; nextT = ctx.currentTime + 0.05;
    schedTimer = setInterval(schedule, 40);
  }
  function stopMusic(){
    musicOn = false;
    if (schedTimer){ clearInterval(schedTimer); schedTimer = 0; }
  }
  function sfx(kind){
    if (!ensure()) return;
    const t = ctx.currentTime;
    if (kind === 'catch'){
      tone(t, m2f(79), 0.12, 0.18, 'sine', sfxBus);
      tone(t + 0.07, m2f(84), 0.16, 0.16, 'sine', sfxBus);
      tone(t + 0.14, m2f(88), 0.26, 0.14, 'sine', sfxBus);
    } else if (kind === 'bad'){
      tone(t, m2f(58), 0.16, 0.16, 'triangle', sfxBus);
      tone(t + 0.09, m2f(50), 0.28, 0.16, 'triangle', sfxBus);
    } else if (kind === 'timeup'){
      tone(t, m2f(72), 0.22, 0.16, 'triangle', sfxBus);
      tone(t + 0.16, m2f(67), 0.22, 0.16, 'triangle', sfxBus);
      tone(t + 0.32, m2f(64), 0.4, 0.18, 'triangle', sfxBus);
    } else if (kind === 'start'){
      tone(t, m2f(67), 0.1, 0.14, 'square', sfxBus);
      tone(t + 0.09, m2f(72), 0.1, 0.14, 'square', sfxBus);
      tone(t + 0.18, m2f(79), 0.24, 0.15, 'square', sfxBus);
    } else if (kind === 'tick'){
      tone(t, m2f(91), 0.06, 0.1, 'sine', sfxBus);
    }
  }
  function toggle(){
    muted = !muted;
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    if (ctx) master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02);
    return muted;
  }
  return { unlock, startMusic, stopMusic, sfx, toggle, get muted(){ return muted; } };
})();

/* ---------------- 流程 ---------------- */
function syncUI(){
  ui.score.textContent = score;
  ui.time.textContent = fmtTime(timeLeft);
  ui.size.textContent = sizeName(bodyLen);
  ui.time.classList.toggle('urgent', state === 'playing' && timeLeft <= 8);
  if (playerName) ui.name.textContent = playerName;
}
function eatenLine(){
  const bits = [];
  for (const key of Object.keys(ITEMS)){
    if (eaten[key]) bits.push(ITEMS[key].name + '×' + eaten[key]);
  }
  return bits.length ? bits.join('  ') : '这一局还没吃到东西';
}
function resetRound(){
  trail.length = 0;
  particles.length = 0;
  foods.length = 0;
  bodyLen = CFG.BODY_LEN0;
  score = 0;
  eaten = emptyEaten();
  timeLeft = CFG.ROUND_SEC;
  pulse = 0;
  mood = 'ok';
  shake = 0;
  refill(performance.now());
  syncUI();
}
function showPanel({ title, sub, name, rules, board, scoreCard }){
  ui.scrTitle.textContent = title;
  ui.scrSub.textContent = sub || '';
  nameBox.classList.toggle('on', !!name);
  ui.scrRules.classList.toggle('off', !rules);
  ui.scrRules.innerHTML = rules || '';
  if (!board){ ui.scrBoard.classList.remove('on'); ui.scrBoard.innerHTML = ''; }
  if (!scoreCard){ ui.scrScore.className = 'scorecard'; ui.scrScore.innerHTML = ''; }
  legend.classList.add('hide');
  screen.classList.remove('hide');
}
function hidePanel(){
  screen.classList.add('hide');
  legend.classList.remove('hide');
}

function showMenu(){
  stopCamera();
  state = 'idle';
  running = false;
  Sound.stopMusic();
  timeLeft = CFG.ROUND_SEC;
  syncUI();
  setStatus('待机 · 写下名字再开始');
  ui.hint.textContent = '// 成绩记在这台设备上，同一名字留最高分';
  showPanel({
    title: '小桔成长贪吃蛇',
    sub: '伸出食指，带动小桔去吃。蓝底变大，灰底缩小。限时 ' + CFG.ROUND_SEC + ' 秒。',
    name: true,
    rules:
      '<li><b>伸食指</b> 指尖就是小桔。整只手在画面里更好认。</li>' +
      '<li><b>吃蓝底</b> 知识、目标、挑战、协作、创新、技能、复盘，<span class="plus">+12</span> 并且变大。</li>' +
      '<li><b>躲开灰底</b> 安逸、拖延、消极、焦虑、内耗，<span class="minus">−10</span> 并且缩小。</li>' +
      '<li><b>限时 ' + CFG.ROUND_SEC + ' 秒</b> 结束看排行。同一名字只留最高分。</li>'
  });
  ui.scrActions.innerHTML =
    '<button class="btn primary" id="btnStart" type="button">开始<i>开启摄像头</i></button>' +
    '<button class="btn" id="btnDemo" type="button">演示<i>鼠标带动小桔</i></button>' +
    '<button class="btn ghost" id="btnRanks" type="button">看排行</button>';
  $('#btnStart').onclick = startCamera;
  $('#btnDemo').onclick = startDemo;
  $('#btnRanks').onclick = showRanks;
}

function showRanks(){
  state = 'idle';
  setStatus('排行榜 · 本机最高分');
  showPanel({
    title: '排行榜',
    sub: '保存在这台设备上。同一个名字只保留最高的一局。',
    name: false,
    rules: ''
  });
  renderBoard(loadBoard(), playerName || nameInput.value.trim());
  ui.scrActions.innerHTML =
    '<button class="btn primary" id="btnBackRank" type="button">返回<i>回到首页</i></button>' +
    '<button class="btn ghost" id="btnClear" type="button">清空排行</button>';
  $('#btnBackRank').onclick = showMenu;
  $('#btnClear').onclick = clearBoard;
}

function startPlay(){
  resetRound();
  state = 'playing';
  lostStreak = 0;
  playStartAt = performance.now();
  timeLeft = CFG.ROUND_SEC;
  lastWholeSec = Math.ceil(CFG.ROUND_SEC);
  leftAfterOver = false;
  Sound.startMusic();
  Sound.sfx('start');
  hidePanel();
  setStatus('开吃 · ' + playerName, 'on');
  ui.hint.textContent = '// 吃蓝底，绕开灰底';
}

function timeUp(refreshOnly){
  if (state === 'over' && !refreshOnly) return;
  if (!refreshOnly){
    state = 'over';
    overAt = performance.now();
    timeLeft = 0;
    syncUI();
    Sound.stopMusic();
    Sound.sfx('timeup');
    lastResultRank = commitScore(playerName, score);
  }
  const rank = lastResultRank;
  const tier = tierOf(score);
  setStatus('时间到 · ' + score + ' 分 · 第 ' + (rank ? rank.rank : '-') + ' 名', 'err');
  ui.hint.textContent = '// ' + eatenLine();
  showPanel({
    title: '时间到',
    sub: rank && rank.improved ? '这一局写进排行榜了。' : '本局没有超过你在这台设备上的最高分。',
    name: false,
    rules:
      '<li><b>再来一局</b> 还是这个名字，直接开。</li>' +
      '<li><b>手势重开</b> 把手移出画面，再伸回来即可。</li>',
    scoreCard: true
  });
  ui.scrScore.className = 'scorecard on';
  ui.scrScore.innerHTML =
    '<div class="sclbl">本局得分</div>' +
    '<div class="scnum">' + score + '</div>' +
    '<div class="sctier ' + tier.cls + '">' + esc(tier.name) + '</div>' +
    '<div class="scmeta">' + esc(playerName) + ' · 最佳 ' + (rank ? rank.best : score) +
      ' · 第 ' + (rank ? rank.rank : 1) + ' 名 / ' + (rank ? rank.total : 1) + '</div>' +
    '<div class="eaten">' + esc(sizeName(bodyLen)) + ' · ' + esc(eatenLine()) + '</div>';
  if (rank) renderBoard(rank.board, playerName);
  ui.scrActions.innerHTML =
    '<button class="btn primary" id="btnAgain" type="button">再来一局<i>同一个名字</i></button>' +
    '<button class="btn" id="btnBack" type="button">首页<i>换一位玩家</i></button>' +
    '<button class="btn ghost" id="btnClear2" type="button">清空排行</button>';
  $('#btnAgain').onclick = () => startPlay();
  $('#btnBack').onclick = () => showMenu();
  $('#btnClear2').onclick = clearBoard;
}

function stopCamera(){
  const stream = video.srcObject;
  if (stream){
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
  camBox.classList.add('hide');
  running = false;
}

/* ---------------- 摄像头 / 模型 ---------------- */
async function ensureModel(){
  if (landmarker) return landmarker;
  setStatus('加载中 · 手部识别模型', 'wait');
  ui.hint.textContent = '// 模型在本地，第一次会稍等';
  const vision = await FilesetResolver.forVisionTasks('./vendor/wasm');
  const base = delegate => ({
    baseOptions: { modelAssetPath: './models/hand_landmarker.task', delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
  try {
    landmarker = await HandLandmarker.createFromOptions(vision, base('GPU'));
  } catch {
    landmarker = await HandLandmarker.createFromOptions(vision, base('CPU'));
  }
  return landmarker;
}

async function startCamera(){
  if (!captureName()) return;
  if (state === 'loading') return;
  mode = 'cam';
  Sound.unlock();
  state = 'loading';
  camBox.classList.remove('hide');
  showPanel({ title: '加载中', sub: '正在准备手部识别…', name: false, rules: '' });
  ui.scrActions.innerHTML = '';
  try {
    await ensureModel();
    ui.scrSub.textContent = '正在请求摄像头…';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    await new Promise(res => {
      if (video.videoWidth) return res();
      video.addEventListener('loadedmetadata', res, { once: true });
    });
    resizeOverlay();
    lastStageW = 0;
    fitStage();
    running = true;
    state = 'ready';
    resetRound();
    hidePanel();
    setStatus('摄像头就绪 · 把手伸进画面', 'wait');
    ui.hint.textContent = '// ' + video.videoWidth + '×' + video.videoHeight + ' · ' + CTRL_PTS[ctrlIdx].n;
    toast(playerName + '，伸出食指就开始');
  } catch (err){
    console.error(err);
    state = 'error';
    stopCamera();
    setStatus('摄像头没打开', 'err');
    showPanel({
      title: '摄像头没打开',
      sub: String(err && (err.message || err.name) || err),
      name: true,
      rules:
        '<li>页面需要 https 或 localhost 才能用摄像头。</li>' +
        '<li>到系统设置里允许浏览器使用摄像头。</li>' +
        '<li>没有摄像头时，用演示模式用鼠标玩。</li>'
    });
    ui.scrActions.innerHTML =
      '<button class="btn primary" id="btnDemo2" type="button">进入演示<i>鼠标带动小桔</i></button>' +
      '<button class="btn" id="btnRetry" type="button">重试<i>再要一次权限</i></button>';
    $('#btnDemo2').onclick = startDemo;
    $('#btnRetry').onclick = startCamera;
  }
}

function startDemo(){
  if (!captureName()) return;
  mode = 'demo';
  Sound.unlock();
  stopCamera();
  running = true;
  state = 'ready';
  lastStageW = 0;
  fitStage();
  resetRound();
  hidePanel();
  setStatus('演示 · 鼠标在场地里移动', 'wait');
  ui.hint.textContent = '// 演示模式，鼠标的位置就是小桔';
  toast(playerName + '，移动鼠标开始');
}

/* ---------------- 手 ---------------- */
function handLabel(cat){
  const n = cat && (cat.categoryName || '');
  if (n === 'Left') return '左手';
  if (n === 'Right') return '右手';
  return (cat && (cat.displayName || n)) || '手';
}
function sampleHand(res){
  if (!res || !res.landmarks || !res.landmarks.length) return null;
  let best = null, bestScore = -1;
  for (let i = 0; i < res.landmarks.length; i++){
    const hd = (res.handedness && res.handedness[i]) || (res.handednesses && res.handednesses[i]);
    const cat = hd && hd[0] ? hd[0] : null;
    const s = cat ? (cat.score ?? 0) : 1;
    if (s > bestScore){
      bestScore = s;
      best = { lm: res.landmarks[i], label: handLabel(cat), score: s };
    }
  }
  return best;
}
function updatePointer(now){
  let nx = null, ny = null;
  if (!running){
    pointer = null;
    return false;
  }
  if (mode === 'demo'){
    if (mousePt.inside){ nx = mousePt.x; ny = mousePt.y; }
    handInfo = mousePt.inside ? { label: '鼠标', score: 1 } : null;
  } else if (lastResult){
    const h = sampleHand(lastResult);
    handInfo = h;
    if (h){
      const p = h.lm[CTRL_PTS[ctrlIdx].i];
      nx = 1 - p.x;
      ny = p.y;
    }
  }
  if (nx === null){
    lostStreak++;
    handStreak = 0;
    if (!handLostAt) handLostAt = now;
    return false;
  }
  if (handLostAt){ lostGap = now - handLostAt; handLostAt = 0; }
  lostStreak = 0;
  handStreak++;
  if (!pointer) pointer = { x: nx, y: ny };
  else {
    pointer.x += (nx - pointer.x) * CFG.EMA;
    pointer.y += (ny - pointer.y) * CFG.EMA;
  }
  return true;
}

function pushTrail(now){
  if (!pointer) return;
  const b = toBoard(pointer.x, pointer.y);
  const hr = headRadius();
  b.x = clamp(b.x, hr, W - hr);
  b.y = clamp(b.y, hr, H - hr);
  const last = trail[trail.length - 1];
  if (!last || dist(b, last) >= CFG.MIN_STEP){
    trail.push({ x: b.x, y: b.y, t: now });
    pruneTrail();
  }
}
function pruneTrail(){
  const maxLen = bodyLen + CFG.TRAIL_KEEP;
  let acc = 0;
  for (let i = trail.length - 1; i > 0; i--){
    acc += dist(trail[i], trail[i - 1]);
    if (acc > maxLen){
      trail.splice(0, Math.max(0, i - 1));
      return;
    }
  }
}
function bodySlice(lenPx){
  if (trail.length < 2) return trail.slice();
  const pts = [trail[trail.length - 1]];
  let acc = 0;
  for (let i = trail.length - 1; i > 0; i--){
    const a = trail[i], b = trail[i - 1];
    const d = dist(a, b) || 0.0001;
    if (acc + d >= lenPx){
      const k = (lenPx - acc) / d;
      pts.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
      break;
    }
    acc += d;
    pts.push(b);
  }
  pts.reverse();
  return pts;
}
function liveHead(){
  if (pointer && W && (state === 'playing' || state === 'ready' || state === 'over')){
    const b = toBoard(pointer.x, pointer.y);
    const hr = Math.min(headRadius(), Math.min(W, H) * 0.45);
    return { x: clamp(b.x, hr, W - hr), y: clamp(b.y, hr, H - hr) };
  }
  return trail.length ? trail[trail.length - 1] : null;
}

/* ---------------- 绘制 ---------------- */
function render(now){
  bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  bctx.clearRect(0, 0, W, H);
  if (shake > 0.4){
    bctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    shake *= 0.88;
  }
  if (backdrop.width) bctx.drawImage(backdrop, 0, 0, W, H);
  drawLeaves(now);
  drawSnake(now);
  for (const f of foods) drawItem(f, now);
  const head = liveHead();
  if (head) drawOrange(head.x, head.y, now);
  drawParticles();
  drawTimer();
  if (pulse) pulse *= 0.9;
  if (Math.abs(pulse) < 0.02) pulse = 0;
}

function drawItem(f, now){
  const spec = ITEMS[f.type];
  const age = now - f.born;
  const pop = age < 280 ? 1 - age / 280 : 0;
  const bob = Math.sin(now / 380 + f.seed) * 2.2;
  const sc = boardScale() * 1.42 * (1 + pop * 0.22);
  bctx.save();
  bctx.translate(f.x, f.y + bob);
  bctx.scale(sc, sc);

  bctx.beginPath();
  bctx.fillStyle = spec.good ? 'rgba(14,165,233,.12)' : 'rgba(120,113,108,.1)';
  bctx.ellipse(0, 24, 18, 5.5, 0, 0, Math.PI * 2);
  bctx.fill();

  const g = bctx.createLinearGradient(-18, -22, 18, 16);
  if (spec.good){
    g.addColorStop(0, 'rgba(224, 242, 254, .78)');
    g.addColorStop(1, 'rgba(56, 189, 248, .58)');
  } else {
    g.addColorStop(0, 'rgba(245, 245, 244, .72)');
    g.addColorStop(1, 'rgba(168, 162, 158, .5)');
  }
  bctx.beginPath();
  bctx.arc(0, -2, 22, 0, Math.PI * 2);
  bctx.fillStyle = g;
  bctx.fill();
  bctx.lineWidth = 2;
  bctx.strokeStyle = 'rgba(255,255,255,.7)';
  bctx.stroke();

  bctx.font = '22px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  bctx.textAlign = 'center';
  bctx.textBaseline = 'middle';
  bctx.fillText(spec.emoji, 0, -1);

  bctx.font = '700 13px "PingFang SC", sans-serif';
  bctx.fillStyle = spec.good ? '#0369A1' : '#57534E';
  bctx.textBaseline = 'alphabetic';
  bctx.fillText(spec.name, 0, 36);
  bctx.restore();
}

function smoothArr(a, n, passes){
  for (let p = 0; p < passes; p++){
    let prev = a[0];
    for (let i = 1; i < n - 1; i++){
      const cur = a[i], next = a[i + 1];
      a[i] = (prev + cur * 2 + next) / 4;
      prev = cur;
    }
  }
}
function smoothNormal(nx, ny, n, passes){
  for (let p = 0; p < passes; p++){
    let px = nx[0], py = ny[0];
    for (let i = 1; i < n - 1; i++){
      const cx = nx[i], cy = ny[i], xn = nx[i + 1], yn = ny[i + 1];
      let x = (px + cx * 2 + xn) / 4, y = (py + cy * 2 + yn) / 4;
      const L = Math.hypot(x, y) || 1;
      nx[i] = x / L; ny[i] = y / L;
      px = cx; py = cy;
    }
  }
}
function ribbonPath(pts, nx, ny, off, half){
  const n = pts.length, p = new Path2D();
  for (let i = 0; i < n; i++){
    const w = off[i] + half[i];
    const x = pts[i].x + nx[i] * w, y = pts[i].y + ny[i] * w;
    if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
  }
  for (let i = n - 1; i >= 0; i--){
    const w = off[i] - half[i];
    p.lineTo(pts[i].x + nx[i] * w, pts[i].y + ny[i] * w);
  }
  p.closePath();
  return p;
}
function resample(pts, maxN){
  const n = pts.length;
  if (n < 2) return pts.slice();
  const cum = [0];
  let total = 0;
  for (let i = 1; i < n; i++){ total += dist(pts[i], pts[i - 1]); cum.push(total); }
  if (total <= 0) return [pts[n - 1]];
  const count = Math.min(maxN, Math.max(8, Math.floor(total / 2.1)));
  const out = [];
  let j = 0;
  for (let i = 0; i < count; i++){
    const target = total * (i / (count - 1));
    while (j < n - 2 && cum[j + 1] < target) j++;
    const seg = (cum[j + 1] - cum[j]) || 0.0001;
    const t = clamp((target - cum[j]) / seg, 0, 1);
    out.push({
      x: pts[j].x + (pts[j + 1].x - pts[j].x) * t,
      y: pts[j].y + (pts[j + 1].y - pts[j].y) * t
    });
  }
  return out;
}
function drawSnake(){
  const slice = bodySlice(bodyLen);
  if (slice.length < 2) return;
  const pts = resample(slice, CFG.SAMPLES);
  const n = pts.length;
  if (n < 2) return;
  const sc = boardScale() * (0.82 + orangeScale() * 0.28);
  const rad = new Float32Array(n);
  for (let i = 0; i < n; i++){
    const k = i / (n - 1);
    rad[i] = (CFG.TAIL_R + (CFG.HEAD_R * 0.62 - CFG.TAIL_R) * Math.pow(k, 0.6)) * sc;
  }
  smoothArr(rad, n, 3);
  const nx = new Float32Array(n), ny = new Float32Array(n);
  for (let i = 0; i < n; i++){
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const tx = b.x - a.x, ty = b.y - a.y;
    const L = Math.hypot(tx, ty) || 1;
    nx[i] = -ty / L; ny[i] = tx / L;
  }
  smoothNormal(nx, ny, n, 2);
  const zeros = new Float32Array(n);
  const g = bctx.createLinearGradient(pts[0].x, pts[0].y, pts[n - 1].x, pts[n - 1].y);
  g.addColorStop(0, 'rgba(255, 196, 120, 0)');
  g.addColorStop(0.25, 'rgba(255, 176, 70, .38)');
  g.addColorStop(0.65, 'rgba(255, 140, 30, .7)');
  g.addColorStop(1, 'rgba(255, 106, 0, .92)');
  bctx.save();
  bctx.fillStyle = g;
  bctx.shadowColor = 'rgba(232,93,4,.25)';
  bctx.shadowBlur = 14;
  bctx.fill(ribbonPath(pts, nx, ny, zeros, rad));
  bctx.shadowBlur = 0;
  bctx.beginPath();
  bctx.arc(pts[n - 1].x, pts[n - 1].y, rad[n - 1], 0, Math.PI * 2);
  bctx.fill();
  bctx.restore();
}

function drawOrange(x, y, now){
  const sc = orangeScale() * (1 + Math.max(0, pulse) * 0.12 - Math.max(0, -pulse) * 0.08);
  const r = CFG.HEAD_R;
  const cry = mood === 'cry' && now < moodUntil;
  const yum = mood === 'yum' && now < moodUntil;
  bctx.save();
  bctx.translate(x, y);
  bctx.scale(sc, sc * (cry ? 0.96 : 1));
  bctx.beginPath();
  bctx.fillStyle = 'rgba(180, 70, 10, .16)';
  bctx.ellipse(0, r * 0.72, r * 0.72, r * 0.28, 0, 0, Math.PI * 2);
  bctx.fill();

  const g = bctx.createRadialGradient(-r * 0.38, -r * 0.42, r * 0.15, 0, 0, r);
  g.addColorStop(0, '#FFF3C4');
  g.addColorStop(0.38, '#FFB020');
  g.addColorStop(0.78, '#FF7A00');
  g.addColorStop(1, '#E25500');
  bctx.beginPath();
  bctx.arc(0, 0, r, 0, Math.PI * 2);
  bctx.fillStyle = g;
  bctx.shadowColor = 'rgba(232, 93, 4, .35)';
  bctx.shadowBlur = 16;
  bctx.fill();
  bctx.shadowBlur = 0;

  bctx.strokeStyle = 'rgba(255,255,255,.28)';
  bctx.lineWidth = 1;
  for (let i = -2; i <= 2; i++){
    bctx.beginPath();
    bctx.arc(i * 1.2, 2, r * 0.92, 1.15, 1.95);
    bctx.stroke();
  }
  bctx.beginPath();
  bctx.fillStyle = 'rgba(255,255,255,.82)';
  bctx.ellipse(-r * 0.32, -r * 0.36, r * 0.28, r * 0.16, -0.6, 0, Math.PI * 2);
  bctx.fill();

  bctx.save();
  bctx.translate(r * 0.08, -r * 0.92);
  bctx.rotate(-0.5);
  bctx.fillStyle = '#2F8A3E';
  bctx.beginPath();
  bctx.ellipse(0, 0, r * 0.34, r * 0.16, 0, 0, Math.PI * 2);
  bctx.fill();
  bctx.fillStyle = '#246B30';
  bctx.fillRect(-1, -1, 2.4, r * 0.34);
  bctx.restore();

  bctx.strokeStyle = '#6A2B09';
  bctx.fillStyle = '#6A2B09';
  bctx.lineWidth = 1.45;
  bctx.lineCap = 'round';
  if (cry){
    bctx.lineWidth = 2.1;
    for (const s of [-1, 1]){
      bctx.beginPath();
      bctx.moveTo(s * 2.2, -6.4);
      bctx.quadraticCurveTo(s * 5.2, -3.6, s * 8.2, -6.6);
      bctx.stroke();
      bctx.beginPath();
      bctx.arc(s * 5.2, -1.1, 2.7, 0.08 * Math.PI, 0.92 * Math.PI);
      bctx.stroke();
    }
    const drip = (now % 520) / 520;
    bctx.fillStyle = 'rgba(56, 189, 248, .95)';
    for (const s of [-1, 1]){
      const ty = 2.4 + drip * 11;
      bctx.beginPath();
      bctx.moveTo(s * 7.1, ty - 2.4);
      bctx.quadraticCurveTo(s * 9.4, ty + 0.6, s * 7.1, ty + 3.4);
      bctx.quadraticCurveTo(s * 4.8, ty + 0.6, s * 7.1, ty - 2.4);
      bctx.fill();
    }
    bctx.beginPath();
    bctx.ellipse(0, 6.4, 4.3, 3.3, 0, 0, Math.PI * 2);
    bctx.fillStyle = '#6A2B09';
    bctx.fill();
    bctx.beginPath();
    bctx.ellipse(0, 5.7, 2.6, 1.7, 0, 0, Math.PI * 2);
    bctx.fillStyle = '#F7B4B4';
    bctx.fill();
  } else {
    for (const s of [-1, 1]){
      bctx.beginPath();
      bctx.ellipse(s * 5.2, -1.2, 1.35, 1.5, 0, 0, Math.PI * 2);
      bctx.fill();
    }
    bctx.beginPath();
    bctx.arc(0, yum ? 3.2 : 4.2, yum ? 3.6 : 2.8, 0.15 * Math.PI, 0.85 * Math.PI);
    bctx.stroke();
    if (yum){
      bctx.beginPath();
      bctx.ellipse(0, 7.4, 1.8, 1.1, 0, 0, Math.PI * 2);
      bctx.fillStyle = '#E25500';
      bctx.fill();
    }
  }
  bctx.restore();
}

function drawParticles(){
  for (let i = particles.length - 1; i >= 0; i--){
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    if (p.kind === 'score'){ p.vy *= 0.97; p.life -= 0.012; }
    else { p.vx *= 0.96; p.vy *= 0.96; p.life -= 0.02; }
    if (p.life <= 0){ particles.splice(i, 1); continue; }
    bctx.save();
    bctx.globalAlpha = Math.max(0, p.life);
    if (p.kind === 'score'){
      bctx.fillStyle = p.color;
      bctx.font = '800 14px ui-sans-serif, PingFang SC, sans-serif';
      bctx.textAlign = 'center';
      bctx.fillText(p.text, p.x, p.y);
    } else {
      p.rot += p.vr;
      bctx.translate(p.x, p.y);
      bctx.rotate(p.rot);
      bctx.fillStyle = p.good ? (p.life > 0.5 ? '#FF8A1E' : '#FFD59A') : '#A8A29E';
      roundRect(bctx, -p.len / 2, -p.wid / 2, p.len, p.wid, 1);
      bctx.fill();
    }
    bctx.restore();
  }
}
function drawTimer(){
  if (state !== 'playing' && state !== 'over') return;
  const ratio = clamp(timeLeft / CFG.ROUND_SEC, 0, 1);
  const urgent = timeLeft <= 8 && state === 'playing';
  const x = 22, w = W - 44, y = H - 18, h = 5;
  bctx.save();
  bctx.fillStyle = 'rgba(194,65,12,.12)';
  roundRect(bctx, x, y, w, h, 3);
  bctx.fill();
  bctx.fillStyle = urgent ? '#E11D48' : '#E85D04';
  roundRect(bctx, x, y, Math.max(2, w * ratio), h, 3);
  bctx.fill();
  bctx.font = '700 11px ui-monospace, Menlo, monospace';
  bctx.fillText(fmtTime(timeLeft), x, y - 6);
  bctx.restore();
}

/* ---------------- 摄像头小窗 ---------------- */
const trailPts = [];
function resizeOverlay(){
  const r = camBox.getBoundingClientRect();
  const d = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width = Math.round(r.width * d);
  overlay.height = Math.round(r.height * d);
}
function camMap(nx, ny){
  const r = camBox.getBoundingClientRect();
  const vw = video.videoWidth || 4, vh = video.videoHeight || 3;
  const s = Math.max(r.width / vw, r.height / vh);
  const dw = vw * s, dh = vh * s;
  return { x: (r.width - dw) / 2 + nx * dw, y: (r.height - dh) / 2 + ny * dh };
}
function renderOverlay(){
  const d = Math.min(window.devicePixelRatio || 1, 2);
  const r = camBox.getBoundingClientRect();
  if (!r.width) return;
  octx.setTransform(d, 0, 0, d, 0, 0);
  octx.clearRect(0, 0, r.width, r.height);
  if (mode !== 'cam' || video.readyState < 2){ trailPts.length = 0; return; }
  octx.save();
  octx.translate(r.width, 0);
  octx.scale(-1, 1);
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(r.width / vw, r.height / vh);
  const dw = vw * s, dh = vh * s;
  octx.drawImage(video, (r.width - dw) / 2, (r.height - dh) / 2, dw, dh);
  octx.restore();

  const lm = handInfo && handInfo.lm;
  if (!lm){ trailPts.length = 0; return; }
  octx.lineWidth = 1.6;
  octx.strokeStyle = 'rgba(125, 211, 252, .95)';
  octx.beginPath();
  for (const [a, b] of CONN){
    const pa = camMap(1 - lm[a].x, lm[a].y);
    const pb = camMap(1 - lm[b].x, lm[b].y);
    octx.moveTo(pa.x, pa.y); octx.lineTo(pb.x, pb.y);
  }
  octx.stroke();
  for (let i = 0; i < lm.length; i++){
    const p = camMap(1 - lm[i].x, lm[i].y);
    const isCtrl = i === CTRL_PTS[ctrlIdx].i;
    octx.beginPath();
    octx.arc(p.x, p.y, isCtrl ? 4.2 : 2, 0, Math.PI * 2);
    octx.fillStyle = isCtrl ? '#FFD166' : (TIP_IDX.has(i) ? '#FFFFFF' : '#86EFAC');
    octx.fill();
  }
  const cp = camMap(1 - lm[CTRL_PTS[ctrlIdx].i].x, lm[CTRL_PTS[ctrlIdx].i].y);
  trailPts.push(cp);
  if (trailPts.length > 48) trailPts.shift();
  octx.strokeStyle = 'rgba(255, 209, 102, .95)';
  octx.lineWidth = 1.6;
  octx.beginPath();
  trailPts.forEach((p, i) => i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y));
  octx.stroke();
}

/* ---------------- 主循环 ---------------- */
let lastT = 0, fpsAcc = 0, fpsN = 0, fpsT = 0;
let loopOn = false;

function frame(now){
  requestAnimationFrame(frame);
  const dt = lastT ? now - lastT : 16;
  lastT = now;

  if (mode === 'cam' && running && landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime){
    lastVideoTime = video.currentTime;
    try { lastResult = landmarker.detectForVideo(video, now); }
    catch { /* 单帧失败就跳过 */ }
  }

  const hasPointer = updatePointer(now);

  if (state === 'ready' && hasPointer && handStreak > 6){
    startPlay();
  } else if (state === 'playing'){
    if (hasPointer) pushTrail(now);
    timeLeft = Math.max(0, CFG.ROUND_SEC - (now - playStartAt) / 1000);
    const whole = Math.ceil(timeLeft);
    if (whole !== lastWholeSec){
      lastWholeSec = whole;
      if (whole <= 3 && whole > 0) Sound.sfx('tick');
    }
    if (timeLeft <= 0) timeUp(false);
    else checkFood();
    syncUI();
  } else if (state === 'over'){
    if (!hasPointer) leftAfterOver = true;
    else if (leftAfterOver && handStreak > 4 && lostGap > 400 && now - overAt > 900){
      leftAfterOver = false;
      lostGap = 0;
      startPlay();
      toast('再来一局');
    }
  }

  if (W && H){
    render(now);
    if (mode === 'cam') renderOverlay();
  }

  fpsAcc += dt; fpsN++;
  if (now - fpsT > 500){
    ui.fps.textContent = Math.round(1000 / (fpsAcc / Math.max(1, fpsN)));
    fpsAcc = 0; fpsN = 0; fpsT = now;
  }

  if (state === 'playing'){
    if (!hasPointer && lostStreak > 12) setStatus('没看到手 · 把手伸进画面', 'wait');
    else if (hasPointer){
      const tag = mode === 'demo' ? '鼠标' : (handInfo ? handInfo.label : '手');
      setStatus(playerName + ' · ' + tag + ' · ' + CTRL_PTS[ctrlIdx].n, 'on');
    }
  }
}
function loop(){
  if (loopOn) return;
  loopOn = true;
  requestAnimationFrame(frame);
}

/* ---------------- 事件 ---------------- */
function pointFromEvent(e){
  const r = board.getBoundingClientRect();
  mousePt.x = clamp((e.clientX - r.left) / r.width, 0, 1);
  mousePt.y = clamp((e.clientY - r.top) / r.height, 0, 1);
  mousePt.inside = true;
}
stage.addEventListener('mousemove', e => { if (mode === 'demo') pointFromEvent(e); });
stage.addEventListener('mouseleave', () => { if (mode === 'demo') mousePt.inside = false; });
stage.addEventListener('touchstart', e => {
  if (mode !== 'demo') return;
  pointFromEvent(e.touches[0]);
}, { passive: true });
stage.addEventListener('touchmove', e => {
  if (mode !== 'demo') return;
  pointFromEvent(e.touches[0]);
  e.preventDefault();
}, { passive: false });
stage.addEventListener('touchend', () => { if (mode === 'demo') mousePt.inside = false; });

function cycleCtrl(){
  ctrlIdx = (ctrlIdx + 1) % CTRL_PTS.length;
  ui.ctrlName.textContent = CTRL_PTS[ctrlIdx].n;
  ui.ctrlId.textContent = '#' + CTRL_PTS[ctrlIdx].i;
  pointer = null;
  trailPts.length = 0;
  toast('控制点换成' + CTRL_PTS[ctrlIdx].n);
}
$('#ctrlpt').addEventListener('click', cycleCtrl);

const btnMusic = $('#btnMusic');
function syncMusicBtn(){
  btnMusic.classList.toggle('off', Sound.muted);
  btnMusic.title = Sound.muted ? '打开音乐' : '关闭音乐';
}
btnMusic.addEventListener('click', () => { Sound.toggle(); syncMusicBtn(); });
syncMusicBtn();

nameInput.addEventListener('input', () => nameInput.classList.remove('bad'));
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (state === 'idle' || state === 'error')){
    e.preventDefault();
    startCamera();
  }
});

window.addEventListener('resize', () => { resizeOverlay(); fitStage(); });
if (window.ResizeObserver){
  new ResizeObserver(() => { resizeOverlay(); fitStage(); }).observe(stagewrap);
}
window.addEventListener('keydown', e => {
  if (e.target && e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'c') cycleCtrl();
  if (k === 'r' && (state === 'playing' || state === 'over' || state === 'ready')) startPlay();
  if (k === 'escape') showMenu();
});

resizeOverlay();
fitStage();
showMenu();
loop();

window.__gs = {
  get state(){ return state; },
  get score(){ return score; },
  get bodyLen(){ return bodyLen; },
  get size(){ return sizeName(bodyLen); },
  get foods(){ return foods.map(f => ({ type: f.type, x: f.x, y: f.y })); },
  get name(){ return playerName; },
  board: loadBoard
};
