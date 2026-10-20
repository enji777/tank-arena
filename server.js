import express from 'express';
import {createServer} from 'node:http';
import {Server} from 'socket.io';
import {randomBytes} from 'node:crypto';
const app=express(),http=createServer(app),io=new Server(http);
app.use(express.static('public'));
const rooms=new Map(),W=960,H=640;
const base=[];for(let x=130;x<850;x+=120)for(let y=110;y<570;y+=110)if((x+y)%3!==0)base.push({x,y,w:46,h:46,hp:3});
function tank(id,x,y,color,bot=false){return{id,x,y,a:0,hp:3,score:0,color,bot,fire:0,dead:0,input:{}}}
function room(id,solo){const r={id,solo,players:new Map(),bots:[],bullets:[],walls:base.map(w=>({...w})),tick:0};rooms.set(id,r);return r}
function collide(x,y,r){return x<20||y<20||x>W-20||y>H-20||r.walls.some(w=>w.hp>0&&x+17>w.x&&x-17<w.x+w.w&&y+17>w.y&&y-17<w.y+w.h)}
function update(r){r.tick++;const all=[...r.players.values(),...r.bots];for(const t of all){if(t.hp<=0){if(--t.dead<=0){t.hp=3;t.x=45+Math.random()*850;t.y=45+Math.random()*550}continue}
if(t.bot){const p=[...r.players.values()].find(p=>p.hp>0);if(p){t.a=Math.atan2(p.y-t.y,p.x-t.x);t.input={shoot:Math.random()<.18}}}
else{const i=t.input,dx=Number(!!i.right)-Number(!!i.left),dy=Number(!!i.down)-Number(!!i.up);if(dx||dy)t.a=Math.atan2(dy,dx)}
const i=t.input,dx=t.bot?Math.cos(t.a):Number(!!i.right)-Number(!!i.left),dy=t.bot?Math.sin(t.a):Number(!!i.down)-Number(!!i.up),len=Math.hypot(dx,dy)||1,nx=t.x+dx/len*2.6,ny=t.y+dy/len*2.6;
if(!collide(nx,t.y,r))t.x=nx;if(!collide(t.x,ny,r))t.y=ny;
if(t.fire>0)t.fire--;if(i.shoot&&t.fire===0){r.bullets.push({x:t.x+Math.cos(t.a)*22,y:t.y+Math.sin(t.a)*22,vx:Math.cos(t.a)*8,vy:Math.sin(t.a)*8,owner:t.id,life:100});t.fire=15}}
for(const b of r.bullets){b.x+=b.vx;b.y+=b.vy;b.life--;if(b.x<0||b.x>W||b.y<0||b.y>H){b.life=0;continue}const w=r.walls.find(w=>w.hp>0&&b.x>w.x&&b.x<w.x+w.w&&b.y>w.y&&b.y<w.y+w.h);if(w){w.hp--;b.life=0;continue}for(const t of all){if(t.id!==b.owner&&t.hp>0&&Math.hypot(t.x-b.x,t.y-b.y)<18){t.hp--;b.life=0;if(t.hp<=0){t.dead=90;const killer=all.find(p=>p.id===b.owner);if(killer)killer.score++}break}}}
r.bullets=r.bullets.filter(b=>b.life>0);
io.to(r.id).emit('state',{players:[...r.players.values()].map(({input,...p})=>p),bots:r.bots.map(({input,...p})=>p),walls:r.walls,bullets:r.bullets})}
function leave(s){const r=rooms.get(s.data.room);if(!r)return;r.players.delete(s.id);s.leave(r.id);s.data.room=null;if(!r.players.size)rooms.delete(r.id)}
io.on('connection',s=>{s.on('join',(data={},cb=()=>{})=>{if(typeof data.code!=='string'||data.code.length>20)return cb({error:'Неверный код'});if(s.data.room)leave(s);const solo=!!data.solo,id=solo?'solo-'+s.id:(data.code.trim().toUpperCase()||randomBytes(3).toString('hex').toUpperCase());let r=rooms.get(id);if(!r)r=room(id,solo);if(r.players.size>=4)return cb({error:'Комната заполнена'});s.join(id);s.data.room=id;const p=tank(s.id,65+Math.random()*40,65+Math.random()*40,['#52d6ff','#f7d154','#ab8aff','#78e09d'][r.players.size]);r.players.set(s.id,p);if(solo)for(let j=0;j<4;j++)r.bots.push(tank('bot'+j,230+j*155,320,'#ef6461',true));cb({id,playerId:s.id})});s.on('input',i=>{const p=rooms.get(s.data.room)?.players.get(s.id);if(p&&i&&typeof i==='object')p.input={up:!!i.up,down:!!i.down,left:!!i.left,right:!!i.right,shoot:!!i.shoot}});s.on('disconnect',()=>leave(s))});
setInterval(()=>{for(const r of rooms.values())update(r)},1000/30);
http.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('Tank Arena ready'));