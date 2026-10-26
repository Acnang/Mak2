let THREE;

const THREE_CDNS = [
  'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js',
  'https://unpkg.com/three@0.180.0/build/three.module.js'
];

async function loadThree() {
  let lastError;

  for (const url of THREE_CDNS) {
    try {
      THREE = await import(url);
      return;
    } catch (error) {
      lastError = error;
      console.error('Three.js 로딩 실패:', url, error);
    }
  }

  throw new Error(
    'Three.js를 불러오지 못했습니다. 인터넷 연결 또는 CDN 접근을 확인하세요. ' +
    (lastError?.message || '')
  );
}

const $ = (id) => document.getElementById(id);
const CHUNK = 16;
const WORLD_SIZE = 64;
const WORLD_HEIGHT = 28;
const REACH = 6;
const PLAYER_RADIUS = 0.32;
const PLAYER_HEIGHT = 1.78;
const EYE_HEIGHT = 1.58;
const GRAVITY = 22;
const JUMP_SPEED = 8.2;

const BLOCKS = {
  grass: { name: '잔디', color: 0x69a94c, top: 0x78bd55, side: 0x6b9846, hardness: 0.45, solid: true },
  dirt: { name: '흙', color: 0x8b603d, hardness: 0.4, solid: true },
  stone: { name: '돌', color: 0x858d98, hardness: 1.1, solid: true },
  sand: { name: '모래', color: 0xd8c17a, hardness: 0.35, solid: true },
  wood: { name: '통나무', color: 0x90633c, hardness: 0.8, solid: true },
  leaves: { name: '나뭇잎', color: 0x397e46, hardness: 0.25, solid: true },
  plank: { name: '판자', color: 0xb88652, hardness: 0.6, solid: true },
  glass: { name: '유리', color: 0x9bdfe5, hardness: 0.3, solid: true },
  coal: { name: '석탄 광석', color: 0x434952, hardness: 1.4, solid: true },
  iron: { name: '철 광석', color: 0xa87f69, hardness: 1.5, solid: true },
  bedrock: { name: '기반암', color: 0x353b45, hardness: Infinity, solid: true },
  water: { name: '물', color: 0x397fca, hardness: 0, solid: false }
};
const PLACEABLE = ['grass','dirt','stone','sand','wood','leaves','plank','glass','coal','iron'];
const COLORS = Object.fromEntries(Object.entries(BLOCKS).map(([id, b]) => [id, b.color]));

let scene, camera, renderer, clock;
let running = false, paused = false, inventoryOpen = false;
let seed = 'wave-' + Math.random().toString(36).slice(2, 8);
let seedNumber = 0;
let randomState = 0;
let blocks = new Map();
let chunkMeshes = new Map();
let dirtyChunks = new Set();
let selectedSlot = 0;
let hotbar = ['grass','dirt','stone','wood','sand','plank','glass','coal','iron'];
let keys = new Set();
let pointerLocked = false;
let target = null;
let mining = null;
let mineHeld = false;
let player = { x: 0.5, y: 12, z: 0.5, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, grounded: false, lastSafeY: 12 };
let jumpQueued = false;
let joystick = { active:false, id:null, x:0, y:0, cx:0, cy:0 };
let touchLook = { id:null, x:0, y:0 };
let activePointers = new Map();
let lastAutosave = 0;
let messageTimer = null;
let worldLoaded = false;
let isMobile = matchMedia('(pointer: coarse), (max-width: 800px)').matches;

function hashString(str) {
  let h = 2166136261;
  for (let i=0; i<str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seededRandom() {
  let t = randomState += 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function keyOf(x,y,z) { return `${x},${y},${z}`; }
function chunkKey(cx,cz) { return `${cx},${cz}`; }
function parseKey(k) { return k.split(',').map(Number); }
function getBlock(x,y,z) {
  if (y < 0) return 'bedrock';
  if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE || y >= WORLD_HEIGHT) return null;
  return blocks.get(keyOf(x,y,z)) || null;
}
function setBlock(x,y,z,id) {
  if (x<0 || z<0 || x>=WORLD_SIZE || z>=WORLD_SIZE || y<1 || y>=WORLD_HEIGHT) return false;
  const k = keyOf(x,y,z);
  if (id) blocks.set(k,id); else blocks.delete(k);
  markChunkDirty(x,z);
  if (x%CHUNK===0) markChunkDirty(x-1,z);
  if (x%CHUNK===CHUNK-1) markChunkDirty(x+1,z);
  if (z%CHUNK===0) markChunkDirty(x,z-1);
  if (z%CHUNK===CHUNK-1) markChunkDirty(x,z+1);
  return true;
}
function markChunkDirty(x,z) {
  if (x<0 || z<0 || x>=WORLD_SIZE || z>=WORLD_SIZE) return;
  dirtyChunks.add(chunkKey(Math.floor(x/CHUNK),Math.floor(z/CHUNK)));
}
function heightAt(x,z) {
  const n = Math.sin((x+seedNumber%37)*0.19)*1.7 + Math.cos((z-seedNumber%23)*0.16)*1.9 +
    Math.sin((x+z)*0.095)*2.1 + Math.cos((x-z)*0.07)*1.1;
  return Math.max(3, Math.min(14, Math.floor(7+n)));
}
function generateWorld(newSeed) {
  seed = newSeed || ('wave-' + Math.random().toString(36).slice(2,8));
  seedNumber = hashString(seed);
  randomState = seedNumber;
  blocks.clear(); chunkMeshes.forEach(m => { scene.remove(m); m.geometry.dispose(); }); chunkMeshes.clear(); dirtyChunks.clear();
  const rand = seededRandom;
  const heights = [];
  for (let x=0; x<WORLD_SIZE; x++) {
    heights[x] = [];
    for (let z=0; z<WORLD_SIZE; z++) {
      let h = heightAt(x,z);
      // Broad, low coastal basin gives the terrain a little variation.
      if (Math.sin(x*0.11 + seedNumber%7) + Math.cos(z*0.13) > 1.55) h = Math.min(h,4);
      heights[x][z] = h;
      for (let y=0; y<=h; y++) {
        let id = y===0 ? 'bedrock' : (y===h ? (h<=4 ? 'sand':'grass') : (y>=h-3 ? (h<=4?'sand':'dirt') : 'stone'));
        if (y>1 && y<h-3 && rand()<0.018) id = rand()<0.6 ? 'coal' : 'iron';
        blocks.set(keyOf(x,y,z),id);
      }
    }
  }
  // Small trees on grassy ground.
  for (let x=3; x<WORLD_SIZE-3; x++) for (let z=3; z<WORLD_SIZE-3; z++) {
    if (rand()>0.018) continue;
    const h=heights[x][z];
    if (h<5 || getBlock(x,h,z)!=='grass') continue;
    const trunk=3+Math.floor(rand()*2);
    for (let y=1; y<=trunk; y++) blocks.set(keyOf(x,h+y,z),'wood');
    for (let dy=trunk-1; dy<=trunk+2; dy++) {
      const r=dy===trunk+2?1:2;
      for (let dx=-r; dx<=r; dx++) for (let dz=-r; dz<=r; dz++) {
        if (Math.abs(dx)+Math.abs(dz)>r+1) continue;
        const tx=x+dx,tz=z+dz,ty=h+dy;
        if (!blocks.has(keyOf(tx,ty,tz))) blocks.set(keyOf(tx,ty,tz),'leaves');
      }
    }
  }
  // Shallow water fills low ground in selected areas.
  for (let x=0;x<WORLD_SIZE;x++) for (let z=0;z<WORLD_SIZE;z++) {
    const h=heights[x][z];
    if (h<=4) for(let y=h+1;y<=4;y++) blocks.set(keyOf(x,y,z),'water');
  }
  // Rebuild all chunks once.
  for (let cx=0;cx<WORLD_SIZE/CHUNK;cx++) for(let cz=0;cz<WORLD_SIZE/CHUNK;cz++) dirtyChunks.add(chunkKey(cx,cz));
  rebuildDirtyChunks();
  const sx=Math.floor(WORLD_SIZE/2), sz=Math.floor(WORLD_SIZE/2), sh=heightAt(sx,sz);
  player.x=sx+0.5; player.z=sz+0.5; player.y=sh+1.05;
  // Clear a small spawn pocket from generated foliage only.
  for(let x=sx-1;x<=sx+1;x++) for(let z=sz-1;z<=sz+1;z++) for(let y=sh+1;y<sh+4;y++) {
    const id=getBlock(x,y,z); if(id==='leaves'||id==='wood') setBlock(x,y,z,null);
  }
  player.vx=player.vy=player.vz=0; player.yaw=0; player.pitch=0; player.grounded=false; player.lastSafeY=player.y;
  camera.rotation.order='YXZ';
  worldLoaded=true;
  updateHotbar(); saveLocal();
  showMessage(`월드 생성 완료 · 시드 ${seed}`);
}
function faceColor(id, face) {
  const b=BLOCKS[id]; if(!b) return new THREE.Color(0xffffff);
  let c = id==='grass' && face===2 ? b.top : (id==='grass' && face!==3 ? b.side : b.color);
  const shade = face===2 ? 1.0 : face===3 ? 0.58 : (face===0 || face===1 ? 0.82 : 0.72);
  return new THREE.Color(c).multiplyScalar(shade);
}
const FACES = [
  { n:[1,0,0], p:[[1,0,0],[1,1,0],[1,1,1],[1,0,0],[1,1,1],[1,0,1]], shade:0 },
  { n:[-1,0,0], p:[[0,0,1],[0,1,1],[0,1,0],[0,0,1],[0,1,0],[0,0,0]], shade:1 },
  { n:[0,1,0], p:[[0,1,1],[1,1,1],[1,1,0],[0,1,1],[1,1,0],[0,1,0]], shade:2 },
  { n:[0,-1,0], p:[[0,0,0],[1,0,0],[1,0,1],[0,0,0],[1,0,1],[0,0,1]], shade:3 },
  { n:[0,0,1], p:[[1,0,1],[1,1,1],[0,1,1],[1,0,1],[0,1,1],[0,0,1]], shade:4 },
  { n:[0,0,-1], p:[[0,0,0],[0,1,0],[1,1,0],[0,0,0],[1,1,0],[1,0,0]], shade:5 }
];
function rebuildChunk(cx,cz) {
  const ck=chunkKey(cx,cz), old=chunkMeshes.get(ck);
  if(old) { scene.remove(old); old.geometry.dispose(); chunkMeshes.delete(ck); }
  const positions=[], colors=[], faceBlocks=[];
  const x0=cx*CHUNK,z0=cz*CHUNK;
  for(let x=x0;x<Math.min(x0+CHUNK,WORLD_SIZE);x++) for(let z=z0;z<Math.min(z0+CHUNK,WORLD_SIZE);z++) {
    for(let y=0;y<WORLD_HEIGHT;y++) {
      const id=getBlock(x,y,z); if(!id || id==='water') continue;
      for(let fi=0;fi<FACES.length;fi++) {
        const f=FACES[fi], nx=x+f.n[0],ny=y+f.n[1],nz=z+f.n[2], neighbor=getBlock(nx,ny,nz);
        if(neighbor && neighbor!=='water') continue;
        const color=faceColor(id,fi===0?0:fi===1?1:fi===2?2:fi===3?3:4);
        for(const p of f.p) {
          positions.push(x+p[0],y+p[1],z+p[2]);
          colors.push(color.r,color.g,color.b);
        }
        faceBlocks.push({x,y,z,id,normal:f.n});
      }
    }
  }
  if(!positions.length) return;
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geo.computeVertexNormals();
  const mat=new THREE.MeshLambertMaterial({vertexColors:true});
  const mesh=new THREE.Mesh(geo,mat);
  mesh.userData={chunkKey:ck,faceBlocks};
  mesh.frustumCulled=true;
  scene.add(mesh); chunkMeshes.set(ck,mesh);
}
function rebuildDirtyChunks() {
  for(const k of dirtyChunks) { const [cx,cz]=k.split(',').map(Number); rebuildChunk(cx,cz); }
  dirtyChunks.clear();
}
function solidAt(x,y,z) {
  const id=getBlock(x,y,z);
  return !!id && BLOCKS[id]?.solid && id!=='water';
}
function collides(px,py,pz) {
  const minX=Math.floor(px-PLAYER_RADIUS), maxX=Math.floor(px+PLAYER_RADIUS);
  const minY=Math.floor(py+0.04), maxY=Math.floor(py+PLAYER_HEIGHT-0.04);
  const minZ=Math.floor(pz-PLAYER_RADIUS), maxZ=Math.floor(pz+PLAYER_RADIUS);
  for(let x=minX;x<=maxX;x++) for(let y=minY;y<=maxY;y++) for(let z=minZ;z<=maxZ;z++) if(solidAt(x,y,z)) return true;
  return false;
}
function moveAxis(axis, amount) {
  if(!amount) return;
  const steps=Math.max(1,Math.ceil(Math.abs(amount)/0.18)), step=amount/steps;
  for(let i=0;i<steps;i++) {
    const nx=player.x+(axis==='x'?step:0), ny=player.y+(axis==='y'?step:0), nz=player.z+(axis==='z'?step:0);
    if(!collides(nx,ny,nz)) { player.x=nx; player.y=ny; player.z=nz; }
    else {
      if(axis==='y') { if(step<0) player.grounded=true; player.vy=0; }
      if(axis==='x') player.vx=0;
      if(axis==='z') player.vz=0;
      break;
    }
  }
}
function updatePlayer(dt) {
  const forward=(keys.has('KeyW')?1:0)-(keys.has('KeyS')?1:0)-joystick.y;
  const side=(keys.has('KeyD')?1:0)-(keys.has('KeyA')?1:0)+joystick.x;
  const sprint=keys.has('ShiftLeft')||keys.has('ShiftRight');
  const speed=sprint?7.2:4.8;
  const fx=-Math.sin(player.yaw), fz=-Math.cos(player.yaw);
  const rx=Math.cos(player.yaw), rz=-Math.sin(player.yaw);
  let dx=fx*forward+rx*side, dz=fz*forward+rz*side;
  const len=Math.hypot(dx,dz); if(len>1){dx/=len;dz/=len;}
  const accel=player.grounded?18:7;
  player.vx += (dx*speed-player.vx)*Math.min(1,accel*dt);
  player.vz += (dz*speed-player.vz)*Math.min(1,accel*dt);
  if(jumpQueued && player.grounded) { player.vy=JUMP_SPEED; player.grounded=false; }
  jumpQueued=false;
  player.vy-=GRAVITY*dt;
  player.grounded=false;
  moveAxis('x',player.vx*dt); moveAxis('z',player.vz*dt); moveAxis('y',player.vy*dt);
  if(player.y< -8) {
    player.x=WORLD_SIZE/2+0.5; player.z=WORLD_SIZE/2+0.5; player.y=heightAt(Math.floor(player.x),Math.floor(player.z))+2;
    player.vx=player.vy=player.vz=0; showMessage('너무 깊이 떨어져 시작 지점으로 돌아왔습니다.');
  }
  camera.position.set(player.x,player.y+EYE_HEIGHT,player.z);
  camera.rotation.order='YXZ'; camera.rotation.y=player.yaw; camera.rotation.x=player.pitch;
}
function getLookTarget() {
  const raycaster=new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0,0),camera);
  const meshes=[...chunkMeshes.values()];
  const hits=raycaster.intersectObjects(meshes,false);
  if(!hits.length || hits[0].distance>REACH) return null;
  const hit=hits[0], data=hit.object.userData.faceBlocks[Math.floor(hit.faceIndex/2)];
  if(!data) return null;
  return {...data, distance:hit.distance, point:hit.point};
}
function mineBlock() {
  if(!target) return;
  const id=getBlock(target.x,target.y,target.z);
  
  if(!id || id==='bedrock') { showMessage('이 블록은 부술 수 없습니다.'); return; }
  setBlock(target.x,target.y,target.z,null);
  rebuildDirtyChunks();
  const slot=hotbar.indexOf(id);
  if(slot>=0) { selectedSlot=slot; }
  else { hotbar[selectedSlot]=id; }
  updateHotbar();
  showMessage(`${BLOCKS[id]?.name||id} 블록을 획득했습니다.`);
  playTone(150,0.06,'square');
}
function placeBlock() {
  if(!target) { showMessage('설치할 블록을 바라보세요.'); return; }
  const id=hotbar[selectedSlot];
  if(!id || !BLOCKS[id]) return;
  const nx=target.x+target.normal[0], ny=target.y+target.normal[1], nz=target.z+target.normal[2];
  if(getBlock(nx,ny,nz)) { showMessage('그 위치에는 설치할 수 없습니다.'); return; }
  // Avoid placing a block inside the player's body.
  const overlaps = player.x+PLAYER_RADIUS>nx && player.x-PLAYER_RADIUS<nx+1 &&
    player.y+PLAYER_HEIGHT>ny && player.y<ny+1 &&
    player.z+PLAYER_RADIUS>nz && player.z-PLAYER_RADIUS<nz+1;
  if(overlaps) { showMessage('플레이어와 겹치는 위치에는 설치할 수 없습니다.'); return; }
  if(setBlock(nx,ny,nz,id)) { rebuildDirtyChunks(); playTone(280,0.05,'triangle'); }
}
function updateTarget() {
  target=getLookTarget();
  $('target-label').textContent=target ? BLOCKS[target.id]?.name||target.id : '';
}
function updateHotbar() {
  const bar=$('hotbar'); bar.innerHTML='';
  hotbar.forEach((id,i)=>{
    const b=BLOCKS[id]||BLOCKS.grass;
    const el=document.createElement('button');
    el.className='slot'+(i===selectedSlot?' selected':'');
    el.setAttribute('aria-label',`${i+1}번 ${b.name}`);
    el.innerHTML=`<span class="slot-key">${i+1}</span><span class="swatch" style="background:#${b.color.toString(16).padStart(6,'0')}"></span><span class="slot-name">${b.name}</span>`;
    el.addEventListener('click',()=>{selectedSlot=i;updateHotbar();});
    bar.appendChild(el);
  });
  const grid=$('inventory-grid'); grid.innerHTML='';
  PLACEABLE.forEach(id=>{
    const b=BLOCKS[id], el=document.createElement('button');
    el.className='inventory-choice';
    el.innerHTML=`<span class="swatch" style="background:#${b.color.toString(16).padStart(6,'0')}"></span><span>${b.name}</span>`;
    el.addEventListener('click',()=>{
      hotbar[selectedSlot]=id; updateHotbar(); closeInventory(); showMessage(`${b.name} 선택`);
    });
    grid.appendChild(el);
  });
}
function showMessage(text) {
  const el=$('message'); el.textContent=text; el.classList.add('show');
  clearTimeout(messageTimer); messageTimer=setTimeout(()=>el.classList.remove('show'),1900);
}
let audioCtx=null;
function playTone(freq,duration,type='sine') {
  try {
    audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') audioCtx.resume();
    const osc=audioCtx.createOscillator(), gain=audioCtx.createGain();
    osc.type=type; osc.frequency.value=freq; gain.gain.setValueAtTime(0.055,audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+duration);
    osc.connect(gain);gain.connect(audioCtx.destination);osc.start();osc.stop(audioCtx.currentTime+duration);
  } catch {}
}
function saveLocal() {
  try {
    const data={version:1,seed,blocks:[...blocks.entries()],player:{x:player.x,y:player.y,z:player.z,yaw:player.yaw,pitch:player.pitch},hotbar,selectedSlot};
    localStorage.setItem('blockwave-save-v1',JSON.stringify(data));
    $('status-text').textContent='자동 저장됨';
  } catch { $('status-text').textContent='저장 실패'; showMessage('저장 공간이 부족하거나 저장이 차단되었습니다.'); }
}
function loadLocal() {
  try {
    const raw=localStorage.getItem('blockwave-save-v1'); if(!raw) return false;
    const data=JSON.parse(raw); if(data.version!==1 || !Array.isArray(data.blocks)) return false;
    seed=data.seed||seed; seedNumber=hashString(seed); blocks=new Map(data.blocks);
    if(data.player) Object.assign(player,data.player);
    if(Array.isArray(data.hotbar)&&data.hotbar.length===9) hotbar=data.hotbar;
    selectedSlot=Math.max(0,Math.min(8,data.selectedSlot||0));
    for(let cx=0;cx<WORLD_SIZE/CHUNK;cx++) for(let cz=0;cz<WORLD_SIZE/CHUNK;cz++) dirtyChunks.add(chunkKey(cx,cz));
    rebuildDirtyChunks(); updateHotbar(); worldLoaded=true; return true;
  } catch { showMessage('저장 데이터가 손상되어 새 월드를 만듭니다.'); return false; }
}
function exportWorld() {
  try {
    const data={version:1,seed,blocks:[...blocks.entries()],player:{x:player.x,y:player.y,z:player.z,yaw:player.yaw,pitch:player.pitch},hotbar,selectedSlot};
    const blob=new Blob([JSON.stringify(data)],{type:'application/json'});
    const url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url;a.download=`blockwave-${seed.replace(/[^a-z0-9_-]/gi,'_')}.json`;a.click();URL.revokeObjectURL(url);
    showMessage('월드 백업 파일을 내보냈습니다.');
  } catch { showMessage('월드 내보내기에 실패했습니다.'); }
}
function openInventory() {
  inventoryOpen=true; $('inventory-screen').classList.remove('hidden');
  if(pointerLocked) document.exitPointerLock?.();
}
function closeInventory() { inventoryOpen=false; $('inventory-screen').classList.add('hidden'); }
function pauseGame() {
  if(!running) return;
  paused=true; $('pause-screen').classList.remove('hidden');
  if(pointerLocked) document.exitPointerLock?.();
}
function resumeGame() {
  paused=false; $('pause-screen').classList.add('hidden');
  if(!isMobile) $('game-canvas').requestPointerLock?.();
}
function setupScene() {
  scene=new THREE.Scene(); scene.background=new THREE.Color(0x8cc8ed); scene.fog=new THREE.Fog(0x8cc8ed,35,95);
  camera=new THREE.PerspectiveCamera(75,innerWidth/innerHeight,0.1,150);
  renderer=new THREE.WebGLRenderer({canvas:$('game-canvas'),antialias:!isMobile,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,isMobile?1.35:1.8)); renderer.setSize(innerWidth,innerHeight);
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.shadowMap.enabled=!isMobile; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  scene.add(new THREE.HemisphereLight(0xd9efff,0x5d604b,2.0));
  const sun=new THREE.DirectionalLight(0xfff0d1,2.1); sun.position.set(40,70,20); scene.add(sun);
  const skyGeo=new THREE.SphereGeometry(120,24,12);
  const skyMat=new THREE.MeshBasicMaterial({color:0x8cc8ed,side:THREE.BackSide});
  const sky=new THREE.Mesh(skyGeo,skyMat); scene.add(sky);
  clock=new THREE.Clock();
}
function bindEvents() {
  const canvas=$('game-canvas');
  $('start-button').addEventListener('click',()=>{
    const requestedSeed=$('seed-input').value.trim();
    $('start-screen').classList.add('hidden'); $('hud').classList.remove('hidden');
    if(!worldLoaded) {
      if(!loadLocal()) generateWorld(requestedSeed);
      else showMessage('저장된 월드를 불러왔습니다.');
    }
    running=true; paused=false;
    if(!isMobile) canvas.requestPointerLock?.();
    playTone(440,0.08);
  });
  $('resume-button').addEventListener('click',resumeGame);
  $('save-button').addEventListener('click',()=>{saveLocal();exportWorld();});
  $('menu-button').addEventListener('click',()=>{saveLocal();paused=false;running=false;$('pause-screen').classList.add('hidden');$('hud').classList.add('hidden');$('start-screen').classList.remove('hidden');});
  $('inventory-close').addEventListener('click',closeInventory);
  $('mobile-inventory').addEventListener('click',()=>inventoryOpen?closeInventory():openInventory());
  $('mobile-jump').addEventListener('pointerdown',e=>{e.preventDefault();jumpQueued=true;});
  $('mobile-mine').addEventListener('pointerdown',e=>{e.preventDefault();mineHeld=true;});
  $('mobile-mine').addEventListener('pointerup',()=>{mineHeld=false;mineBlock();});
  $('mobile-mine').addEventListener('pointercancel',()=>mineHeld=false);
  $('mobile-place').addEventListener('pointerdown',e=>{e.preventDefault();placeBlock();});
  canvas.addEventListener('click',()=>{
    if(!isMobile && running && !paused && !inventoryOpen && !pointerLocked) canvas.requestPointerLock?.();
    else if(isMobile && running && !paused && !inventoryOpen) mineBlock();
  });
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  document.addEventListener('pointerlockchange',()=>{pointerLocked=document.pointerLockElement===canvas;});
  document.addEventListener('mousemove',e=>{
    if(pointerLocked && running && !paused && !inventoryOpen) {
      player.yaw-=e.movementX*0.0022; player.pitch-=e.movementY*0.0022;
      player.pitch=Math.max(-Math.PI/2+0.02,Math.min(Math.PI/2-0.02,player.pitch));
    }
  });
  canvas.addEventListener('pointerdown',e=>{
    if(!isMobile || !running || paused || inventoryOpen) return;
    activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,button:e.button});
    if(e.clientX>innerWidth*0.35 && e.clientY<innerHeight-175) touchLook={id:e.pointerId,x:e.clientX,y:e.clientY};
  });
  canvas.addEventListener('pointermove',e=>{
    if(!isMobile || touchLook.id!==e.pointerId || !activePointers.has(e.pointerId)) return;
    const prev=activePointers.get(e.pointerId);
    const dx=e.clientX-prev.x,dy=e.clientY-prev.y;
    player.yaw-=dx*0.006; player.pitch-=dy*0.006;
    player.pitch=Math.max(-1.48,Math.min(1.48,player.pitch));
    prev.x=e.clientX;prev.y=e.clientY;
  });
  const endTouch=e=>{activePointers.delete(e.pointerId);if(touchLook.id===e.pointerId)touchLook.id=null;};
  canvas.addEventListener('pointerup',endTouch);canvas.addEventListener('pointercancel',endTouch);
  window.addEventListener('keydown',e=>{
    if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
    if(e.code==='Escape') { if(inventoryOpen) closeInventory(); else if(running) pauseGame(); return; }
    if(e.code==='KeyE' && running && !paused) { inventoryOpen?closeInventory():openInventory(); return; }
    if(e.code==='Space' && !paused && running) jumpQueued=true;
    if(/^Digit[1-9]$/.test(e.code)) { selectedSlot=Number(e.code.slice(-1))-1; updateHotbar(); }
    if(e.code==='KeyQ' && running && !paused) { hotbar[selectedSlot]=null; updateHotbar(); showMessage('선택 슬롯을 비웠습니다.'); }
    keys.add(e.code);
  });
  window.addEventListener('keyup',e=>keys.delete(e.code));
  window.addEventListener('blur',()=>{keys.clear();mineHeld=false;});
  window.addEventListener('resize',()=>{
    if(!camera||!renderer)return;
    camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
    renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,isMobile?1.2:1.8));
    isMobile=matchMedia('(pointer: coarse), (max-width: 800px)').matches;
  });
  const zone=$('joystick-zone'), base=$('joystick-base'), knob=$('joystick-knob');
  zone.addEventListener('pointerdown',e=>{
    e.preventDefault(); zone.setPointerCapture(e.pointerId);
    joystick.active=true;joystick.id=e.pointerId;
    const r=base.getBoundingClientRect();joystick.cx=r.left+r.width/2;joystick.cy=r.top+r.height/2;
    updateStick(e.clientX,e.clientY);
  });
  zone.addEventListener('pointermove',e=>{if(joystick.active&&e.pointerId===joystick.id){e.preventDefault();updateStick(e.clientX,e.clientY);}});
  const endStick=e=>{if(e.pointerId===joystick.id){joystick.active=false;joystick.id=null;joystick.x=joystick.y=0;knob.style.transform='translate(0px,0px)';}};
  zone.addEventListener('pointerup',endStick);zone.addEventListener('pointercancel',endStick);
  function updateStick(x,y) {
    const dx=x-joystick.cx,dy=y-joystick.cy,len=Math.hypot(dx,dy),max=38,scale=len>max?max/len:1;
    const sx=dx*scale,sy=dy*scale;joystick.x=sx/max;joystick.y=sy/max;
    knob.style.transform=`translate(${sx}px,${sy}px)`;
  }
  document.addEventListener('mousedown',e=>{
    if(!running||paused||inventoryOpen||isMobile)return;
    if(e.button===0){mineHeld=true;}
    if(e.button===2)placeBlock();
  });
  document.addEventListener('mouseup',e=>{if(e.button===0&&mineHeld){mineHeld=false;mineBlock();}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){saveLocal();keys.clear();}});
}
function updateDayNight(t) {
  const cycle=(t%240)/240, daylight=(Math.sin(cycle*Math.PI*2-Math.PI/2)+1)/2;
  const skyColor=new THREE.Color().setHSL(0.57,0.52,0.13+daylight*0.42);
  scene.background.copy(skyColor); scene.fog.color.copy(skyColor);
}
function loop() {
  requestAnimationFrame(loop);
  const dt=Math.min(clock.getDelta(),0.04);
  if(running&&!paused&&!inventoryOpen&&worldLoaded) {
    updatePlayer(dt);
    if(mineHeld && !isMobile) { /* held mining resolves on release to avoid accidental repeat */ }
    updateTarget();
    const now=performance.now();
    if(now-lastAutosave>15000){saveLocal();lastAutosave=now;}
    $('coords-text').textContent=`X ${Math.floor(player.x)} · Y ${Math.floor(player.y)} · Z ${Math.floor(player.z)}`;
    updateDayNight(now/1000);
  }
  if(scene&&camera&&renderer) renderer.render(scene,camera);
}
async function init() {
  try {
    await loadThree();

    const testCanvas = document.createElement('canvas');
    const gl = testCanvas.getContext('webgl2');

    if (!gl) {
      throw new Error(
        '이 브라우저에서 WebGL 2를 사용할 수 없습니다. ' +
        'Safari 업데이트와 그래픽 가속 환경을 확인하세요.'
      );
    }

    const loseContext = gl.getExtension('WEBGL_lose_context');
    if (loseContext) loseContext.loseContext();

    setupScene();
    bindEvents();
    updateHotbar();
    loop();

  } catch (err) {
    console.error('게임 초기화 오류:', err);

    $('error-screen').classList.remove('hidden');

    $('error-text').textContent =
      err?.message || String(err) || '알 수 없는 초기화 오류';
  }
}

init();
