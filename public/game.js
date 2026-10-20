const WIDTH = 960;
const HEIGHT = 640;
const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const socket = io();
const status = document.querySelector('#status');
const roomInput = document.querySelector('#code');
const PROFILE_KEY = 'ashenArenaProfile';

let myId = null;
let roomId = '';
let aimPoint = null;
let lockedTargetId = null;
let reconnecting = false;
let state = {players: [], enemies: [], walls: [], bullets: [], soulsDrops: [], bonfire: {x: 90, y: 320}, bossDefeated: false};
let lastProfileSave = 0;
const pressedKeys = new Set();
const pointers = new Map();
const actionQueue = [];
const embers = Array.from({length: 48}, () => ({x: Math.random() * WIDTH, y: Math.random() * HEIGHT, speed: 0.2 + Math.random() * 0.7, size: 0.7 + Math.random() * 1.8, alpha: 0.15 + Math.random() * 0.5}));

function resizeCanvas() {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = WIDTH * pixelRatio;
  canvas.height = HEIGHT * pixelRatio;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

function setStatus(message, kind = 'info') {
  status.textContent = message;
  status.dataset.kind = kind;
}

function readProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); }
  catch { return {}; }
}

function saveProfile(player, bossDefeated = false) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify({level: player.level, souls: player.souls, bossDefeated})); }
  catch { /* The game remains playable when browser storage is disabled. */ }
}

function joinRoom(requestedCode = roomInput.value, quiet = false) {
  const roomCode = String(requestedCode || '').trim();
  if (!quiet) setStatus(roomCode ? 'Ищем путь к комнате…' : 'Зажигаем костёр…');
  socket.emit('join', {code: roomCode, profile: readProfile()}, result => {
    if (!result || result.error) {
      setStatus(result?.error || 'Не удалось войти в комнату', 'error');
      return;
    }
    myId = result.playerId;
    roomId = result.id;
    reconnecting = false;
    roomInput.value = roomId;
    history.replaceState(null, '', `?room=${encodeURIComponent(roomId)}`);
    setStatus(`Комната ${roomId} · отправь ссылку второму путнику`, 'success');
  });
}

document.querySelector('#solo').addEventListener('click', () => joinRoom(''));
document.querySelector('#join').addEventListener('click', () => joinRoom());
document.querySelector('#copy').addEventListener('click', async () => {
  if (!roomId) {
    setStatus('Сначала начни странствие или войди в комнату', 'error');
    return;
  }
  const url = `${location.origin}/?room=${encodeURIComponent(roomId)}`;
  try {
    await navigator.clipboard.writeText(url);
    setStatus('Ссылка скопирована — позови второго путника', 'success');
  } catch {
    setStatus(url, 'success');
  }
});

const linkedRoom = new URLSearchParams(location.search).get('room');
if (linkedRoom) {
  roomInput.value = linkedRoom;
  joinRoom(linkedRoom);
}

const moveKeys = {
  w: 'up', ArrowUp: 'up',
  s: 'down', ArrowDown: 'down',
  a: 'left', ArrowLeft: 'left',
  d: 'right', ArrowRight: 'right'
};

function queueAction(action) {
  if (myId && ['light', 'heavy', 'dodge', 'parry', 'flask', 'interact', 'level'].includes(action)) actionQueue.push(action);
}

document.addEventListener('keydown', event => {
  if (document.activeElement === roomInput) return;
  const recognized = moveKeys[event.key] || ['Space', 'ShiftLeft', 'ShiftRight', 'KeyF', 'KeyQ', 'KeyE', 'KeyR'].includes(event.code);
  if (!recognized) return;
  event.preventDefault();
  if (event.repeat) return;
  pressedKeys.add(event.key === ' ' ? 'Space' : event.key);
  if (event.code === 'Space') queueAction('dodge');
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') queueAction('heavy');
  if (event.code === 'KeyF') queueAction('parry');
  if (event.code === 'KeyQ') queueAction('flask');
  if (event.code === 'KeyE') queueAction('interact');
  if (event.code === 'KeyR') queueAction('level');
});

document.addEventListener('keyup', event => pressedKeys.delete(event.key === ' ' ? 'Space' : event.key));
window.addEventListener('blur', () => {
  pressedKeys.clear();
  pointers.clear();
});
window.addEventListener('contextmenu', event => {
  if (event.target === canvas) event.preventDefault();
});

function canvasPoint(event) {
  const rectangle = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(WIDTH, (event.clientX - rectangle.left) * WIDTH / rectangle.width)),
    y: Math.max(0, Math.min(HEIGHT, (event.clientY - rectangle.top) * HEIGHT / rectangle.height))
  };
}

function updateAim(event) {
  aimPoint = canvasPoint(event);
  const enemy = state.enemies
    .filter(item => item.hp > 0)
    .sort((left, right) => Math.hypot(left.x - aimPoint.x, left.y - aimPoint.y) - Math.hypot(right.x - aimPoint.x, right.y - aimPoint.y))[0];
  if (enemy && Math.hypot(enemy.x - aimPoint.x, enemy.y - aimPoint.y) < 48) lockedTargetId = enemy.id;
  else if (event.pointerType !== 'mouse' || event.button === 2) lockedTargetId = null;
}

canvas.addEventListener('pointerdown', event => {
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  updateAim(event);
  pointers.set(event.pointerId, event.pointerType === 'mouse' ? 'aim' : 'aim-touch');
  if (event.pointerType === 'mouse' && event.button === 0) queueAction('light');
});

canvas.addEventListener('pointermove', event => {
  if (event.pointerType === 'mouse' || pointers.get(event.pointerId) === 'aim-touch') updateAim(event);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(type, event => pointers.delete(event.pointerId));
}

document.querySelectorAll('[data-move]').forEach(button => {
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, button.dataset.move);
    button.classList.add('pressed');
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, event => {
      pointers.delete(event.pointerId);
      button.classList.remove('pressed');
    });
  }
});

document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    button.classList.add('pressed');
    queueAction(button.dataset.action);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, () => button.classList.remove('pressed'));
  }
});

function currentInput() {
  const actions = [...pointers.values()];
  const me = state.players.find(player => player.id === myId);
  let aim = null;
  const locked = state.enemies.find(enemy => enemy.id === lockedTargetId && enemy.hp > 0);
  if (me && locked) aim = Math.atan2(locked.y - me.y, locked.x - me.x);
  else if (me && aimPoint) aim = Math.atan2(aimPoint.y - me.y, aimPoint.x - me.x);
  return {
    up: pressedKeys.has('w') || pressedKeys.has('ArrowUp') || actions.includes('up'),
    down: pressedKeys.has('s') || pressedKeys.has('ArrowDown') || actions.includes('down'),
    left: pressedKeys.has('a') || pressedKeys.has('ArrowLeft') || actions.includes('left'),
    right: pressedKeys.has('d') || pressedKeys.has('ArrowRight') || actions.includes('right'),
    aim,
    action: actionQueue.shift() || null
  };
}

setInterval(() => {
  if (myId && socket.connected) socket.emit('input', currentInput());
}, 33);

socket.on('state', nextState => {
  state = nextState;
  const now = Date.now();
  const me = state.players.find(player => player.id === myId);
  if (me && now - lastProfileSave > 1000) {
    saveProfile(me, state.bossDefeated);
    lastProfileSave = now;
  }
});
window.addEventListener('beforeunload', () => {
  const me = state.players.find(player => player.id === myId);
  if (me) saveProfile(me, state.bossDefeated);
});
socket.on('disconnect', () => {
  reconnecting = !!roomId;
  actionQueue.length = 0;
  if (reconnecting) setStatus('Связь прервалась — возвращаемся к костру…', 'error');
});
socket.on('connect', () => {
  if (reconnecting && roomId) {
    setStatus('Связь восстановлена — возвращаемся в мир…');
    joinRoom(roomId, true);
  }
});
socket.on('connect_error', () => setStatus('Не удалось подключиться к серверу', 'error'));

function roundedRect(x, y, width, height, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function drawGround() {
  ctx.fillStyle = '#1b1a1d';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const glow = ctx.createRadialGradient(95, 320, 5, 95, 320, 500);
  glow.addColorStop(0, '#3b3027');
  glow.addColorStop(1, '#1b1a1d00');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = '#302c2a';
  ctx.lineWidth = 1;
  for (let x = 0; x <= WIDTH; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, HEIGHT); ctx.stroke();
  }
  for (let y = 0; y <= HEIGHT; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WIDTH, y); ctx.stroke();
  }
  for (const ember of embers) {
    ember.y -= ember.speed;
    if (ember.y < 0) { ember.y = HEIGHT; ember.x = Math.random() * WIDTH; }
    ctx.fillStyle = `rgba(218, 142, 82, ${ember.alpha})`;
    ctx.beginPath(); ctx.arc(ember.x, ember.y, ember.size, 0, Math.PI * 2); ctx.fill();
  }
}

function drawWall(wall) {
  ctx.fillStyle = '#08090d66';
  ctx.fillRect(wall.x + 5, wall.y + 7, wall.w, wall.h);
  const gradient = ctx.createLinearGradient(wall.x, wall.y, wall.x + wall.w, wall.y + wall.h);
  gradient.addColorStop(0, '#68605a');
  gradient.addColorStop(0.45, '#403c3a');
  gradient.addColorStop(1, '#29292d');
  ctx.fillStyle = gradient;
  ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
  ctx.strokeStyle = '#81766a';
  ctx.lineWidth = 2;
  ctx.strokeRect(wall.x + 2, wall.y + 2, wall.w - 4, wall.h - 4);
  ctx.strokeStyle = '#252529';
  ctx.lineWidth = 1;
  for (let y = wall.y + 25; y < wall.y + wall.h; y += 32) {
    ctx.beginPath(); ctx.moveTo(wall.x + 3, y); ctx.lineTo(wall.x + wall.w - 3, y); ctx.stroke();
  }
}

function drawBonfire() {
  const {x, y} = state.bonfire;
  const pulse = 1 + Math.sin(performance.now() / 180) * 0.08;
  const glow = ctx.createRadialGradient(x, y, 3, x, y, 76 * pulse);
  glow.addColorStop(0, '#ffd67a99'); glow.addColorStop(0.35, '#e9753a44'); glow.addColorStop(1, '#d2582200');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, 76 * pulse, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#73695c';
  ctx.beginPath(); ctx.ellipse(x, y + 11, 25, 12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#9f7950'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(x - 17, y + 8); ctx.lineTo(x + 17, y - 7); ctx.moveTo(x - 16, y - 7); ctx.lineTo(x + 17, y + 8); ctx.stroke();
  ctx.fillStyle = '#ffcf6b';
  ctx.beginPath(); ctx.moveTo(x, y + 7); ctx.quadraticCurveTo(x - 17, y - 3, x - 2, y - 28); ctx.quadraticCurveTo(x + 3, y - 12, x + 6, y - 20); ctx.quadraticCurveTo(x + 22, y - 2, x, y + 7); ctx.fill();
  ctx.fillStyle = '#fff0a6';
  ctx.beginPath(); ctx.ellipse(x + 1, y - 4, 5, 10, 0, 0, Math.PI * 2); ctx.fill();
}

function drawTelegraph(enemy) {
  const attack = enemy.attack;
  if (!attack || attack.phase !== 'windup') return;
  ctx.save();
  ctx.fillStyle = 'rgba(193, 52, 48, 0.2)';
  ctx.strokeStyle = 'rgba(238, 92, 76, 0.72)';
  ctx.lineWidth = 2;
  if (attack.kind === 'slam') {
    ctx.beginPath(); ctx.arc(enemy.x, enemy.y, 108, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else if (attack.kind === 'arrow') {
    ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.moveTo(enemy.x, enemy.y); ctx.lineTo(enemy.x + Math.cos(attack.direction) * 360, enemy.y + Math.sin(attack.direction) * 360); ctx.stroke();
  } else {
    const spread = enemy.type === 'lancer' ? 0.48 : 0.88;
    ctx.beginPath(); ctx.moveTo(enemy.x, enemy.y);
    ctx.arc(enemy.x, enemy.y, enemy.range + 24, attack.direction - spread, attack.direction + spread);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function drawEnemy(enemy) {
  if (enemy.hp <= 0) return;
  drawTelegraph(enemy);
  const boss = enemy.type === 'boss';
  const scale = boss ? 1.65 : enemy.type === 'lancer' ? 1.12 : 1;
  const radius = boss ? 22 : 15;
  ctx.save();
  ctx.translate(enemy.x, enemy.y);
  ctx.rotate(enemy.a);
  if (enemy.hitTicks > 0) ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#0a0a0dcc';
  ctx.fillRect(-radius * scale, -radius * scale * 0.72, radius * 2 * scale, radius * 1.44 * scale);
  ctx.fillStyle = enemy.color;
  ctx.beginPath(); ctx.ellipse(0, 0, radius * scale, radius * scale * 0.78, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e0c7a0';
  ctx.beginPath(); ctx.arc(radius * scale * 0.28, -radius * scale * 0.1, radius * 0.55 * scale, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#312c2b';
  ctx.fillRect(radius * 0.15 * scale, -radius * 0.15 * scale, radius * 1.7 * scale, Math.max(3, radius * 0.18 * scale));
  if (enemy.type === 'lancer' || boss) {
    ctx.strokeStyle = '#d4c7ae'; ctx.lineWidth = boss ? 4 : 3;
    ctx.beginPath(); ctx.moveTo(radius * 0.5, 1); ctx.lineTo(radius * 2.5 * scale, 1); ctx.stroke();
  } else if (enemy.type === 'archer') {
    ctx.strokeStyle = '#b9a27b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(radius * 1.35, 0, radius * 0.8, -1.1, 1.1); ctx.stroke();
  }
  ctx.restore();

  const barWidth = boss ? 82 : 42;
  ctx.fillStyle = '#0b0b0ddd'; ctx.fillRect(enemy.x - barWidth / 2, enemy.y - radius - 12, barWidth, 5);
  ctx.fillStyle = boss ? '#b94943' : '#9c7861';
  ctx.fillRect(enemy.x - barWidth / 2, enemy.y - radius - 12, barWidth * enemy.hp / enemy.maxHp, 5);
}

function drawPlayer(player) {
  if (player.hp <= 0) return;
  const dodging = player.invulnerable > 0;
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.a);
  ctx.globalAlpha = dodging ? 0.62 : 1;
  ctx.fillStyle = '#11131a';
  ctx.beginPath(); ctx.ellipse(0, 4, 17, 13, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = player.color;
  ctx.beginPath(); ctx.ellipse(-2, 0, 13, 11, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#c8c1b2';
  ctx.beginPath(); ctx.arc(4, -1, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#48484a';
  ctx.beginPath(); ctx.arc(6, -3, 7, Math.PI, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#eee0bf'; ctx.fillRect(5, -2, 3, 1.5);
  ctx.fillStyle = '#8b755e'; ctx.fillRect(11, -2, 25, 4);
  ctx.fillStyle = '#d9d0ba'; ctx.beginPath(); ctx.moveTo(36, 0); ctx.lineTo(43, -2); ctx.lineTo(43, 2); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#a68b65'; ctx.fillRect(0, 9, 9, 7);
  ctx.restore();

  if (player.attack) {
    ctx.save(); ctx.strokeStyle = player.attack.riposte ? '#fff0a6' : player.attack.type === 'heavy' ? '#f4c46d' : '#d9e0dc';
    ctx.globalAlpha = 0.8; ctx.lineWidth = player.attack.type === 'heavy' ? 6 : 4;
    ctx.beginPath(); ctx.arc(player.x, player.y, player.attack.type === 'heavy' ? 46 : 35, player.a - 0.72, player.a + 0.72); ctx.stroke(); ctx.restore();
  }
  if (player.parryTicks > 0 || player.parryFlash > 0) {
    const success = player.parryFlash > 0;
    ctx.save();
    ctx.strokeStyle = success ? '#fff0a6' : '#93c7c4';
    ctx.globalAlpha = success ? Math.min(1, player.parryFlash / 8) : 0.7;
    ctx.lineWidth = success ? 4 : 2;
    ctx.beginPath(); ctx.arc(player.x, player.y, success ? 34 : 25, player.a - 0.92, player.a + 0.92); ctx.stroke();
    ctx.restore();
  }
  if (player.id === myId) {
    ctx.fillStyle = '#f2deb1'; ctx.font = 'bold 15px system-ui'; ctx.textAlign = 'center'; ctx.fillText('▼', player.x, player.y - 24);
    if (player.riposteWindow > 0) {
      ctx.fillStyle = '#ffe39a'; ctx.font = 'bold 12px system-ui'; ctx.fillText('ОТВЕТНЫЙ УДАР', player.x, player.y - 42);
    }
  }
}

function drawDrop(drop) {
  const pulse = 1 + Math.sin(performance.now() / 220 + drop.y) * 0.13;
  const glow = ctx.createRadialGradient(drop.x, drop.y, 1, drop.x, drop.y, 23 * pulse);
  glow.addColorStop(0, '#ffe9a8dd'); glow.addColorStop(1, '#dfa84400');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(drop.x, drop.y, 23 * pulse, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffdc83'; ctx.beginPath(); ctx.arc(drop.x, drop.y, 6 * pulse, 0, Math.PI * 2); ctx.fill();
}

function drawHud(me) {
  roundedRect(15, 15, 250, 78, 8, 'rgba(12, 13, 17, 0.82)');
  ctx.fillStyle = '#e9e1d1'; ctx.font = 'bold 15px Georgia, serif'; ctx.textAlign = 'left';
  ctx.fillText('ПУТНИК', 28, 37);
  ctx.fillStyle = '#3a2527'; ctx.fillRect(28, 46, 178, 9);
  ctx.fillStyle = '#b84b46'; ctx.fillRect(28, 46, 178 * me.hp / me.maxHp, 9);
  ctx.fillStyle = '#28372f'; ctx.fillRect(28, 61, 178, 7);
  ctx.fillStyle = '#9cc782'; ctx.fillRect(28, 61, 178 * me.stamina / me.maxStamina, 7);
  ctx.fillStyle = '#e9d59e'; ctx.font = '14px system-ui'; ctx.fillText(`✦ ${me.souls}    Ур. ${me.level}    Фляга ×${me.flasks}`, 28, 84);
  if (Math.hypot(me.x - state.bonfire.x, me.y - state.bonfire.y) < 72) {
    ctx.fillStyle = '#f3d99f'; ctx.font = '12px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(`КОСТЁР · E отдых · R улучшение (${(me.level + 1) * 180} душ)`, WIDTH / 2, HEIGHT - 18);
  }

  const boss = state.enemies.find(enemy => enemy.type === 'boss' && enemy.hp > 0);
  if (boss) {
    ctx.textAlign = 'center'; ctx.font = 'bold 14px Georgia, serif'; ctx.fillStyle = '#e7d4c4'; ctx.fillText(boss.name, WIDTH / 2, 27);
    ctx.fillStyle = '#1e1719'; ctx.fillRect(WIDTH / 2 - 210, 36, 420, 10);
    ctx.fillStyle = '#a74540'; ctx.fillRect(WIDTH / 2 - 208, 38, 416 * boss.hp / boss.maxHp, 6);
  } else if (state.bossDefeated) {
    ctx.textAlign = 'center'; ctx.font = 'bold 14px Georgia, serif'; ctx.fillStyle = '#edcc85'; ctx.fillText('СТРАЖ ПОВЕРЖЕН', WIDTH / 2, 33);
  }

  const partner = state.players.find(player => player.id !== myId);
  if (partner) {
    ctx.textAlign = 'right'; ctx.font = '13px system-ui'; ctx.fillStyle = '#d6cbb9'; ctx.fillText(`Спутник · ${Math.max(0, partner.hp)} HP`, WIDTH - 18, 28);
    ctx.fillStyle = '#392628'; ctx.fillRect(WIDTH - 150, 36, 132, 7);
    ctx.fillStyle = '#bd6558'; ctx.fillRect(WIDTH - 148, 38, 128 * partner.hp / partner.maxHp, 3);
  }
}

function render() {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  drawGround();
  for (const wall of state.walls) drawWall(wall);
  drawBonfire();
  for (const drop of state.soulsDrops) if (drop.owner === myId) drawDrop(drop);
  for (const enemy of state.enemies) drawEnemy(enemy);
  for (const bullet of state.bullets) {
    ctx.fillStyle = '#e7bd77'; ctx.beginPath(); ctx.arc(bullet.x, bullet.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#d2a56488'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bullet.x, bullet.y); ctx.lineTo(bullet.x - bullet.vx * 2, bullet.y - bullet.vy * 2); ctx.stroke();
  }
  for (const player of state.players) drawPlayer(player);

  const me = state.players.find(player => player.id === myId);
  if (me) {
    drawHud(me);
    if (me.hp <= 0) {
      ctx.fillStyle = '#090a0dcc'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.textAlign = 'center'; ctx.fillStyle = '#e5d7bd'; ctx.font = 'bold 32px Georgia, serif'; ctx.fillText('ПУТНИК ПАЛ', WIDTH / 2, HEIGHT / 2 - 14);
      ctx.font = '17px system-ui'; ctx.fillStyle = '#d4bd8d'; ctx.fillText('Души ждут там, где оборвался путь', WIDTH / 2, HEIGHT / 2 + 22);
    }
    if (me.parryFlash > 0) {
      ctx.save(); ctx.textAlign = 'center'; ctx.font = 'bold 22px Georgia, serif';
      ctx.fillStyle = '#ffe7a7'; ctx.shadowColor = '#e99c47'; ctx.shadowBlur = 16;
      ctx.fillText('ПАРИРОВАНИЕ!', WIDTH / 2, HEIGHT / 2 + 90); ctx.restore();
    }
  }

  if (aimPoint && roomId) {
    ctx.strokeStyle = lockedTargetId ? '#e6b870' : '#d5d2c6aa'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(aimPoint.x, aimPoint.y, lockedTargetId ? 12 : 8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(aimPoint.x - 15, aimPoint.y); ctx.lineTo(aimPoint.x - 5, aimPoint.y); ctx.moveTo(aimPoint.x + 5, aimPoint.y); ctx.lineTo(aimPoint.x + 15, aimPoint.y); ctx.stroke();
  }
  requestAnimationFrame(render);
}
render();

