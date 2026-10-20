import express from 'express';
import {createServer} from 'node:http';
import {Server} from 'socket.io';
import {randomBytes} from 'node:crypto';

const app = express();
const http = createServer(app);
const io = new Server(http);
app.use(express.static('public'));

const W = 960;
const H = 640;
const PLAYER_RADIUS = 15;
const TILE = 20;
const COLS = Math.floor((W - 40) / TILE) + 1;
const ROWS = Math.floor((H - 40) / TILE) + 1;
const rooms = new Map();
const arenaWalls = [
  {x: 205, y: 110, w: 48, h: 145},
  {x: 205, y: 380, w: 48, h: 145},
  {x: 335, y: 225, w: 130, h: 42},
  {x: 335, y: 375, w: 130, h: 42},
  {x: 520, y: 125, w: 45, h: 135},
  {x: 520, y: 380, w: 45, h: 135},
  {x: 650, y: 220, w: 135, h: 42},
  {x: 650, y: 380, w: 135, h: 42}
];

const enemySpecs = {
  hollow: {name: 'Пустой страж', hp: 70, speed: 1.45, range: 46, damage: 17, reward: 70, color: '#c78a62'},
  lancer: {name: 'Копейщик', hp: 95, speed: 1.15, range: 88, damage: 25, reward: 110, color: '#b7a067'},
  archer: {name: 'Пепельный лучник', hp: 62, speed: 0.9, range: 310, damage: 15, reward: 95, color: '#9ba875'},
  boss: {name: 'Страж Пепельных Врат', hp: 560, speed: 1.15, range: 70, damage: 34, reward: 1200, color: '#b54845'}
};

function makeEnemy(id, type, x, y) {
  const spec = enemySpecs[type];
  return {
    id, type, name: spec.name, x, y, a: Math.PI, hp: spec.hp, maxHp: spec.hp,
    speed: spec.speed, range: spec.range, damage: spec.damage, reward: spec.reward,
    color: spec.color, attack: null, attackCooldown: 0, path: [], pathIndex: 0,
    nextPathTick: 0, targetId: null, alive: true
  };
}

function makeEnemies(bossDefeated = false) {
  const enemies = [
    makeEnemy('hollow-1', 'hollow', 300, 165),
    makeEnemy('lancer-1', 'lancer', 420, 320),
    makeEnemy('archer-1', 'archer', 610, 180),
    makeEnemy('hollow-2', 'hollow', 595, 475)
  ];
  if (!bossDefeated) enemies.push(makeEnemy('boss-1', 'boss', 835, 320));
  return enemies;
}

function createRoom(id, bossDefeated = false) {
  const value = {
    id, tick: 0, players: new Map(), enemies: makeEnemies(bossDefeated),
    walls: arenaWalls.map(wall => ({...wall})), bullets: [], soulsDrops: [],
    bonfire: {x: 90, y: 320}, bossDefeated
  };
  rooms.set(id, value);
  return value;
}

function makePlayer(id, x, y, color, spawnOffset, profile = {}) {
  const level = Math.max(0, Math.min(10, Math.floor(Number(profile.level) || 0)));
  const maxHp = 100 + level * 8;
  const maxStamina = 100 + level * 5;
  return {
    id, name: 'Путник', x, y, a: 0, hp: maxHp, maxHp,
    stamina: maxStamina, maxStamina, souls: Math.max(0, Math.min(999999, Math.floor(Number(profile.souls) || 0))),
    level, flasks: 3, maxFlasks: 3,
    color, spawnOffset, input: {}, action: null, attack: null, attackCooldown: 0,
    dodge: null, parryTicks: 0, riposteWindow: 0, parryFlash: 0,
    invulnerable: 0, hurtTicks: 0, deadTicks: 0, alive: true
  };
}

function pointCollides(x, y, radius, value) {
  if (x < 20 + radius || y < 20 + radius || x > W - 20 - radius || y > H - 20 - radius) return true;
  return value.walls.some(wall => wall.hp !== 0 &&
    x + radius > wall.x && x - radius < wall.x + wall.w &&
    y + radius > wall.y && y - radius < wall.y + wall.h
  );
}

function canOccupy(x, y, radius, value) {
  return !pointCollides(x, y, radius, value);
}

function moveEntity(entity, dx, dy, radius, value) {
  const nextX = entity.x + dx;
  const nextY = entity.y + dy;
  if (canOccupy(nextX, entity.y, radius, value)) entity.x = nextX;
  if (canOccupy(entity.x, nextY, radius, value)) entity.y = nextY;
}

function gridPoint(index) {
  return {x: 20 + (index % COLS) * TILE, y: 20 + Math.floor(index / COLS) * TILE};
}

function nearestOpenNode(x, y, value) {
  let nearest = -1;
  let distance = Infinity;
  for (let index = 0; index < COLS * ROWS; index++) {
    const point = gridPoint(index);
    if (!canOccupy(point.x, point.y, PLAYER_RADIUS, value)) continue;
    const nextDistance = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (nextDistance < distance) {
      nearest = index;
      distance = nextDistance;
    }
  }
  return nearest;
}

function pathTo(value, from, to) {
  const start = nearestOpenNode(from.x, from.y, value);
  const goal = nearestOpenNode(to.x, to.y, value);
  if (start < 0 || goal < 0) return [];
  if (start === goal) return [gridPoint(start)];
  const count = COLS * ROWS;
  const parent = new Int32Array(count).fill(-1);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  parent[start] = start;

  while (head < tail && parent[goal] < 0) {
    const current = queue[head++];
    const column = current % COLS;
    const neighbors = [];
    if (column > 0) neighbors.push(current - 1);
    if (column < COLS - 1) neighbors.push(current + 1);
    if (current >= COLS) neighbors.push(current - COLS);
    if (current < count - COLS) neighbors.push(current + COLS);
    const here = gridPoint(current);
    for (const next of neighbors) {
      if (parent[next] >= 0) continue;
      const there = gridPoint(next);
      if (!canOccupy(there.x, there.y, PLAYER_RADIUS, value) ||
          !canOccupy((here.x + there.x) / 2, (here.y + there.y) / 2, PLAYER_RADIUS, value)) continue;
      parent[next] = current;
      queue[tail++] = next;
    }
  }
  if (parent[goal] < 0) return [];
  const path = [];
  for (let cursor = goal; cursor !== start; cursor = parent[cursor]) path.push(gridPoint(cursor));
  path.reverse();
  return path;
}

function angleDifference(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function damagePlayer(value, player, damage, attacker = null) {
  if (player.hp <= 0 || player.invulnerable > 0) return;
  if (attacker && player.parryTicks > 0) {
    const incomingAngle = Math.atan2(attacker.y - player.y, attacker.x - player.x);
    if (Math.abs(angleDifference(incomingAngle, player.a)) < 1.2) {
      player.parryTicks = 0;
      player.riposteWindow = 50;
      player.parryFlash = 18;
      player.stamina = Math.min(player.maxStamina, player.stamina + 20);
      attacker.attack = null;
      attacker.attackCooldown = Math.max(attacker.attackCooldown, attacker.type === 'boss' ? 48 : 62);
      attacker.hitTicks = 18;
      return;
    }
  }
  player.hp = Math.max(0, player.hp - damage);
  player.hurtTicks = 14;
  if (player.hp === 0) {
    player.deadTicks = 120;
    const oldDrop = value.soulsDrops.find(drop => drop.owner === player.id);
    if (oldDrop) value.soulsDrops = value.soulsDrops.filter(drop => drop.owner !== player.id);
    if (player.souls > 0) value.soulsDrops.push({owner: player.id, x: player.x, y: player.y, souls: player.souls});
    player.souls = 0;
    player.attack = null;
    player.dodge = null;
    player.parryTicks = 0;
    player.riposteWindow = 0;
  }
}

function useBonfire(value, player) {
  player.hp = player.maxHp;
  player.stamina = player.maxStamina;
  player.flasks = player.maxFlasks;
  player.attack = null;
  player.dodge = null;
  player.parryTicks = 0;
  player.riposteWindow = 0;
  player.parryFlash = 0;
  player.attackCooldown = 0;
  value.bullets = [];
  value.enemies = makeEnemies(value.bossDefeated);
}

function startPlayerAction(value, player, action) {
  if (!action || player.hp <= 0 || player.deadTicks > 0) return;
  if (action === 'interact') {
    if (Math.hypot(player.x - value.bonfire.x, player.y - value.bonfire.y) < 62) useBonfire(value, player);
    const drop = value.soulsDrops.find(item => item.owner === player.id && Math.hypot(player.x - item.x, player.y - item.y) < 38);
    if (drop) {
      player.souls += drop.souls;
      value.soulsDrops = value.soulsDrops.filter(item => item !== drop);
    }
    return;
  }
  if (action === 'flask') {
    if (player.flasks > 0 && player.hp > 0 && player.hp < player.maxHp) {
      player.flasks--;
      player.hp = Math.min(player.maxHp, player.hp + 42);
    }
    return;
  }
  if (action === 'level') {
    if (Math.hypot(player.x - value.bonfire.x, player.y - value.bonfire.y) >= 62 || player.level >= 10) return;
    const cost = (player.level + 1) * 180;
    if (player.souls >= cost) {
      player.souls -= cost;
      player.level++;
      player.maxHp += 8;
      player.maxStamina += 5;
      player.hp = player.maxHp;
      player.stamina = player.maxStamina;
    }
    return;
  }
  if (action === 'dodge') {
    if (player.dodge || player.stamina < 25) return;
    player.stamina -= 25;
    const x = Number(!!player.input.right) - Number(!!player.input.left);
    const y = Number(!!player.input.down) - Number(!!player.input.up);
    const direction = Math.hypot(x, y) ? Math.atan2(y, x) : player.a;
    player.dodge = {ticks: 12, dx: Math.cos(direction), dy: Math.sin(direction)};
    player.invulnerable = 10;
    player.attack = null;
    return;
  }
  if (action === 'parry') {
    if (player.attack || player.dodge || player.parryTicks > 0 || player.stamina < 18) return;
    player.stamina -= 18;
    player.parryTicks = 11;
    return;
  }
  if ((action === 'light' || action === 'heavy') && !player.attack && player.attackCooldown === 0) {
    const heavy = action === 'heavy';
    const cost = heavy ? 36 : 20;
    if (player.stamina < cost) return;
    player.stamina -= cost;
    player.attack = {type: action, ticks: 0, hit: false, riposte: player.riposteWindow > 0};
    player.riposteWindow = 0;
    player.attackCooldown = heavy ? 30 : 18;
  }
}

function updatePlayer(value, player) {
  if (player.hp <= 0) {
    if (player.deadTicks > 0) player.deadTicks--;
    if (player.deadTicks === 0) {
      player.hp = player.maxHp;
      player.stamina = player.maxStamina;
      player.flasks = player.maxFlasks;
      player.x = value.bonfire.x + player.spawnOffset;
      player.y = value.bonfire.y + 42;
    }
    player.input = {};
    return;
  }

  if (Number.isFinite(player.input.aim)) player.a = player.input.aim;
  const moveX = Number(!!player.input.right) - Number(!!player.input.left);
  const moveY = Number(!!player.input.down) - Number(!!player.input.up);
  const moveLength = Math.hypot(moveX, moveY) || 1;

  startPlayerAction(value, player, player.action);
  player.action = null;
  if (player.attackCooldown > 0) player.attackCooldown--;
  if (player.invulnerable > 0) player.invulnerable--;
  if (player.hurtTicks > 0) player.hurtTicks--;
  if (player.parryTicks > 0) player.parryTicks--;
  if (player.riposteWindow > 0) player.riposteWindow--;
  if (player.parryFlash > 0) player.parryFlash--;

  if (player.dodge) {
    moveEntity(player, player.dodge.dx * 6.2, player.dodge.dy * 6.2, PLAYER_RADIUS, value);
    player.dodge.ticks--;
    if (player.dodge.ticks <= 0) player.dodge = null;
  } else if (moveX || moveY) {
    const speed = player.attack ? 1.25 : 2.55;
    moveEntity(player, moveX / moveLength * speed, moveY / moveLength * speed, PLAYER_RADIUS, value);
    if (!Number.isFinite(player.input.aim)) player.a = Math.atan2(moveY, moveX);
  }

  if (player.attack) {
    player.attack.ticks++;
    const impactTick = player.attack.type === 'heavy' ? 13 : 7;
    if (!player.attack.hit && player.attack.ticks === impactTick) {
      player.attack.hit = true;
      const range = player.attack.type === 'heavy' ? 68 : 52;
      const baseDamage = (player.attack.type === 'heavy' ? 62 : 34) + player.level * (player.attack.type === 'heavy' ? 7 : 4);
      const damage = Math.round(baseDamage * (player.attack.riposte ? 1.7 : 1));
      for (const enemy of value.enemies) {
        if (enemy.hp <= 0) continue;
        const dx = enemy.x - player.x;
        const dy = enemy.y - player.y;
        const distance = Math.hypot(dx, dy);
        const bearing = Math.atan2(dy, dx);
        if (distance <= range + (enemy.type === 'boss' ? 14 : 0) && Math.abs(angleDifference(bearing, player.a)) < 0.9) {
          enemy.hp = Math.max(0, enemy.hp - damage);
          enemy.hitTicks = 10;
          if (enemy.hp === 0) {
            player.souls += enemy.reward;
            if (enemy.type === 'boss') value.bossDefeated = true;
          }
        }
      }
    }
    if (player.attack.ticks >= (player.attack.type === 'heavy' ? 28 : 19)) player.attack = null;
  }

  if (player.stamina < player.maxStamina && !player.attack && !player.dodge) player.stamina = Math.min(player.maxStamina, player.stamina + 0.42);
  const drop = value.soulsDrops.find(item => item.owner === player.id && Math.hypot(player.x - item.x, player.y - item.y) < 30);
  if (drop) {
    player.souls += drop.souls;
    value.soulsDrops = value.soulsDrops.filter(item => item !== drop);
  }
}

function beginEnemyAttack(enemy, target, kind = 'strike') {
  const boss = enemy.type === 'boss';
  const enraged = boss && enemy.hp <= enemy.maxHp / 2;
  enemy.attack = {
    kind,
    phase: 'windup',
    remaining: kind === 'arrow' ? 34 : kind === 'slam' ? (enraged ? 31 : 43) : (enraged ? 23 : 32),
    targetId: target.id,
    direction: Math.atan2(target.y - enemy.y, target.x - enemy.x)
  };
}

function updateEnemy(value, enemy) {
  if (enemy.hp <= 0) return;
  if (enemy.hitTicks > 0) enemy.hitTicks--;
  const target = [...value.players.values()]
    .filter(player => player.hp > 0)
    .sort((left, right) => Math.hypot(left.x - enemy.x, left.y - enemy.y) - Math.hypot(right.x - enemy.x, right.y - enemy.y))[0];
  if (!target) return;

  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const distance = Math.hypot(dx, dy);
  enemy.a = Math.atan2(dy, dx);
  if (enemy.attackCooldown > 0) enemy.attackCooldown--;

  if (enemy.attack) {
    enemy.attack.remaining--;
    if (enemy.attack.phase === 'windup' && enemy.attack.remaining <= 0) {
      if (enemy.attack.kind === 'arrow') {
        const angle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
        value.bullets.push({x: enemy.x + Math.cos(angle) * 20, y: enemy.y + Math.sin(angle) * 20, vx: Math.cos(angle) * 5.2, vy: Math.sin(angle) * 5.2, damage: enemy.damage, life: 120});
        enemy.attack.phase = 'recover';
        enemy.attack.remaining = 38;
      } else {
        const slam = enemy.attack.kind === 'slam';
        const range = slam ? 108 : enemy.range + (enemy.type === 'boss' ? 20 : 8);
        const bearing = Math.atan2(target.y - enemy.y, target.x - enemy.x);
        const inRange = distance <= range && (slam || Math.abs(angleDifference(bearing, enemy.attack.direction)) < (enemy.type === 'lancer' ? 0.48 : 0.88));
        if (inRange) damagePlayer(value, target, slam ? enemy.damage + 12 : enemy.damage, enemy);
        enemy.attack.phase = 'recover';
        enemy.attack.remaining = slam ? 44 : 28;
      }
    } else if (enemy.attack.phase === 'recover' && enemy.attack.remaining <= 0) {
      enemy.attack = null;
      enemy.attackCooldown = enemy.type === 'boss' ? 28 : enemy.type === 'archer' ? 48 : 24;
    }
    return;
  }

  if (enemy.attackCooldown === 0) {
    if (enemy.type === 'archer' && distance < 340 && distance > 105) {
      beginEnemyAttack(enemy, target, 'arrow');
      return;
    }
    if (enemy.type === 'boss' && distance < 125) {
      beginEnemyAttack(enemy, target, distance < 93 && Math.random() < 0.42 ? 'slam' : 'strike');
      return;
    }
    if (distance <= enemy.range) {
      beginEnemyAttack(enemy, target, 'strike');
      return;
    }
  }

  if (enemy.type === 'archer' && distance < 125) {
    moveEntity(enemy, -dx / (distance || 1) * enemy.speed, -dy / (distance || 1) * enemy.speed, 14, value);
    return;
  }
  if (distance > enemy.range * 0.82) {
    if (value.tick >= enemy.nextPathTick || enemy.targetId !== target.id || enemy.path.length === 0) {
      enemy.path = pathTo(value, enemy, target);
      enemy.pathIndex = 0;
      enemy.targetId = target.id;
      enemy.nextPathTick = value.tick + 18;
    }
    while (enemy.pathIndex < enemy.path.length - 1 && Math.hypot(enemy.path[enemy.pathIndex].x - enemy.x, enemy.path[enemy.pathIndex].y - enemy.y) < 14) enemy.pathIndex++;
    const waypoint = enemy.path[enemy.pathIndex];
    if (waypoint) {
      const angle = Math.atan2(waypoint.y - enemy.y, waypoint.x - enemy.x);
      const speed = enemy.type === 'boss' && enemy.hp <= enemy.maxHp / 2 ? enemy.speed * 1.35 : enemy.speed;
      moveEntity(enemy, Math.cos(angle) * speed, Math.sin(angle) * speed, 14, value);
    }
  }
}

function updateBullets(value) {
  for (const bullet of value.bullets) {
    bullet.x += bullet.vx;
    bullet.y += bullet.vy;
    bullet.life--;
    if (bullet.life <= 0 || bullet.x < 0 || bullet.x > W || bullet.y < 0 || bullet.y > H || value.walls.some(wall => bullet.x > wall.x && bullet.x < wall.x + wall.w && bullet.y > wall.y && bullet.y < wall.y + wall.h)) {
      bullet.life = 0;
      continue;
    }
    for (const player of value.players.values()) {
      if (Math.hypot(player.x - bullet.x, player.y - bullet.y) < 18) {
        damagePlayer(value, player, bullet.damage);
        bullet.life = 0;
        break;
      }
    }
  }
  value.bullets = value.bullets.filter(bullet => bullet.life > 0);
}

function publicState(value) {
  return {
    players: [...value.players.values()].map(({input, action, ...player}) => player),
    enemies: value.enemies.map(({path, ...enemy}) => enemy),
    walls: value.walls,
    bullets: value.bullets,
    soulsDrops: value.soulsDrops,
    bonfire: value.bonfire,
    bossDefeated: value.bossDefeated
  };
}

function update(value) {
  value.tick++;
  for (const player of value.players.values()) updatePlayer(value, player);
  for (const enemy of value.enemies) updateEnemy(value, enemy);
  updateBullets(value);
  io.to(value.id).emit('state', publicState(value));
}

function leave(socket) {
  const value = rooms.get(socket.data.room);
  if (!value) return;
  value.players.delete(socket.id);
  socket.leave(value.id);
  socket.data.room = null;
  if (!value.players.size) rooms.delete(value.id);
}

io.on('connection', socket => {
  socket.on('join', (data = {}, callback = () => {}) => {
    if (!data || typeof data.code !== 'string' || data.code.length > 20) return callback({error: 'Неверный код комнаты'});
    if (socket.data.room) leave(socket);
    const id = data.code.trim().toUpperCase() || randomBytes(3).toString('hex').toUpperCase();
    const profile = data.profile && typeof data.profile === 'object' ? data.profile : {};
    let value = rooms.get(id);
    if (!value) value = createRoom(id, !!profile.bossDefeated);
    if (value.players.size >= 2) return callback({error: 'В комнате уже два путника'});

    const colors = ['#7fc0d1', '#d7ab73'];
    const usedOffsets = new Set([...value.players.values()].map(player => player.spawnOffset));
    const offset = usedOffsets.has(-44) ? 44 : -44;
    const player = makePlayer(socket.id, value.bonfire.x + offset, value.bonfire.y + 42, colors[value.players.size], offset, profile);
    value.players.set(socket.id, player);
    socket.join(id);
    socket.data.room = id;
    callback({id, playerId: socket.id});
  });

  socket.on('input', input => {
    const player = rooms.get(socket.data.room)?.players.get(socket.id);
    if (!player || !input || typeof input !== 'object') return;
    player.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right,
      aim: Number.isFinite(input.aim) ? input.aim : null
    };
    if (['light', 'heavy', 'dodge', 'parry', 'flask', 'interact', 'level'].includes(input.action)) player.action = input.action;
  });
  socket.on('disconnect', () => leave(socket));
});

setInterval(() => {
  for (const value of rooms.values()) update(value);
}, 1000 / 30);

http.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Ashen Arena ready'));

