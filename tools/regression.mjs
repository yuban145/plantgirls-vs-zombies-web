import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

export default async function ({ send, sleep }) {
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const click = async (x,y) => {
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
  };
  const screenshot = async name => {
    const r=await send('Page.captureScreenshot',{format:'png'});
    writeFileSync(`docs/shots/${name}.png`,Buffer.from(r.data,'base64'));
  };
  const load = async level => {
    await send('Page.navigate',{url:`http://127.0.0.1:5188/?autostart=1&level=${level}`});
    for(let i=0;i<100;i++) {
      await sleep(100);
      if(await evaluate(`!!window.__board`)) return;
    }
    throw new Error(`Level ${level} did not load`);
  };
  for(let level=1;level<=10;level++) {
    await load(level);
    const data=await evaluate(`(() => {const b=window.__board;return {rows:b.activeRows,mowers:b.mowers.filter(m=>m.state==='ready').length,state:b.state,mode:b.loadout.kind,missing:b.plants.flat().filter(p=>p&&!p.spine&&!p.reanim).length};})()`);
    assert.equal(data.missing,0);
    assert.equal(data.rows.length,level===1?1:level<=3?3:5);
    assert.equal(data.mowers,data.rows.length);
    assert.equal(data.state,[8,9].includes(level)?'choosing':'playing');
    console.log('SMOKE',level,JSON.stringify(data));
  }
  await load(9);
  await sleep(400);
  assert.equal(await evaluate('window.__board.tickCount'),0,'chooser must freeze waves');
  for(const i of [0,1,3,5,6,7]) await click(180+i%7*100,260+Math.floor(i/7)*125);
  await screenshot('audit-selected-loadout');
  await click(500,510);
  assert.equal(await evaluate('window.__board.state'),'playing');
  assert.deepEqual(await evaluate('window.__board.packets.map(p=>p.seed)'),['Peashooter','Sunflower','Wallnut','Snowpea','Chomper','Repeater']);
  await click(40,123); await click(180,130);
  assert.equal(await evaluate('window.__board.plants[0][0]?.seed'),'Sunflower');
  // Animation poses must move over actual wall time.
  const pose=()=>evaluate('window.__board.plants[0][0].spine.skeleton.bones.map(b=>[b.a,b.b,b.worldX,b.worldY])');
  const before=await pose(); await screenshot('audit-spine-motion-a'); await sleep(450);
  assert.notDeepEqual(await pose(),before); await screenshot('audit-spine-motion-b');
  // Controlled combat diagnostics are separate from the real-input playthrough.
  const combat=await evaluate(`(() => {
    const b=window.__board; b.state='paused'; b.zombies=[]; b.projectiles=[];
    const add=(type,x,row=2)=>{b.spawnZombie(b.assets.zombies.get(type),row,false);const z=b.zombies.at(-1);z.x=x;return z;};
    const far=add('Normal',600), near=add('Normal',500);
    b.projectiles.push({x:530,y:291,row:2,damage:20,kind:'Pea',chillTicks:0});b.updateProjectiles();
    const nearest=near.hp===near.maxHp-20 && far.hp===far.maxHp;
    const helm=add('Pail',650), hp=helm.hp;b.damageZombie(helm,helm.helmHp);
    const armor=helm.hp===hp && helm.helmHp===0 && helm.hidden.includes('anim_bucket');
    const wall=b.addPlant(b.assets.plants.get('Wallnut'),5,1);
    const pole=add('Polevaulter',wall.x+50,1);b.updateZombies();
    const vaultStart=pole.state==='vault' && pole.vaultDuration===180;
    for(let i=0;i<60;i++)b.updateZombies();const vaultMiddle=pole.state==='vault';
    for(let i=0;i<130;i++)b.updateZombies();const vaultEnd=pole.vaulted && pole.state==='walk' && pole.x<wall.x;
    b.zombies=[];const p=b.addPlant(b.assets.plants.get('Repeater'),2,4);b.fireProjectile(p);b.plants[4][2]=null;b.projectiles=[];
    for(let i=0;i<100;i++)b.updateSecondShots();const canceled=b.projectiles.length===0;
    const mine=b.addPlant(b.assets.plants.get('Potatomine'),1,3);
    for(let i=0;i<1500;i++)b.updatePlants();const armed=mine.armed;
    b.zombies=[];const victim=add('Normal',mine.x+40,3);b.updatePlants();b.updatePlants();
    const mineHit=victim.state==='die' && b.plants[3][1]===null;
    return {nearest,armor,vaultStart,vaultMiddle,vaultEnd,canceled,armed,mineHit};
  })()`);
  for(const [name,passed] of Object.entries(combat)) assert.ok(passed,name);
  console.log('COMBAT',JSON.stringify(combat));
  await load(5);
  // Wait for the first conveyor card to become accessible through normal motion.
  for(let i=0;i<150;i++) {if(await evaluate('window.__board.conveyor.cards[0]?.y < 445'))break;await sleep(100);}
  const y=await evaluate('window.__board.conveyor.cards[0].y+20');
  await click(40,y); await click(660,330);
  assert.equal(await evaluate('window.__board.rollingNuts.length'),0,'bowling red line');
  await click(340,330);
  assert.equal(await evaluate('window.__board.rollingNuts.length'),1);
  const x=await evaluate('window.__board.rollingNuts[0].plant.x');await sleep(350);
  assert.ok(await evaluate('window.__board.rollingNuts[0].plant.x')>x,'nut must roll');
  await screenshot('audit-bowling-motion');
  const bowling=await evaluate(`(() => {
    const b=window.__board;b.state='paused';const nut=b.rollingNuts[0];b.zombies=[];
    b.spawnZombie(b.assets.zombies.get('Normal'),nut.plant.row,false);const z=b.zombies[0];z.x=nut.plant.x+20;b.updateBowling();
    const hit=z.state==='die' && nut.direction!==0;
    b.rollingNuts=[];const p=b.addPlant(b.assets.plants.get('ExplodeONut'),1,0);b.plants[0][1]=null;b.rollingNuts.push({plant:p,direction:0,targetRow:0});
    b.spawnZombie(b.assets.zombies.get('Normal'),0,false);const z2=b.zombies.at(-1);z2.x=p.x+20;b.updateBowling();
    return {hit,exploded:b.rollingNuts.length===0 && z2.state==='die'};
  })()`);
  assert.ok(bowling.hit);assert.ok(bowling.exploded);
  console.log('BOWLING',JSON.stringify(bowling));
  await screenshot('audit-bowling-explosion');
}
