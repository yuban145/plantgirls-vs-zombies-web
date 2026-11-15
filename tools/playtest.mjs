import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

// Run using shot.mjs --scenario tools/playtest.mjs. All play actions use CDP
// mouse input; no sun/health/wave overrides or direct simulation advancement.
export default async function ({ send, sleep }) {
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const shot = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`docs/shots/${name}.png`, Buffer.from(data, 'base64'));
  };
  const read = () => evaluate(`(() => { const b=window.__board; return { state:b.state, tick:b.tickCount, sun:b.sun, wave:b.waveIndex, plants:b.plants.flat().filter(Boolean).map(p=>({row:p.row,col:p.col})), zombies:b.zombies.map(z=>({x:z.x,hp:z.hp,state:z.state})), suns:b.suns.filter(s=>s.state!=='collect').map(s=>({x:s.x+121.5,y:s.y+21.5})), cooldown:b.packets[0]?.cooldown }; })()`);
  // Actual planting on the single tutorial lane.
  await click(40, 45);
  await click(340, 330);
  assert.equal((await read()).plants.length, 1);
  // Pause must freeze simulation while still rendering.
  await click(732, 25);
  const paused = await read();
  await sleep(600);
  assert.equal((await read()).tick, paused.tick);
  await click(732, 25);
  // Use the game's exposed 3x control, just as a player can.
  await click(775, 25); await click(775, 25);
  const start = Date.now();
  let combatShot = false;
  let won = false;
  while (Date.now() - start < 150000) {
    await sleep(400);
    const s = await read();
    for (const sun of s.suns) await click(sun.x, sun.y);
    if (s.sun >= 100 && !s.cooldown && s.plants.length < 4) {
      const col = [3, 1, 4].find(col => !s.plants.some(p=>p.col===col));
      if (col !== undefined) { await click(40,45); await click(180+80*col,330); }
    }
    if (s.zombies.length && !combatShot) { await shot('audit-real-combat'); combatShot=true; }
    if (s.state === 'won') { won=true; break; }
    assert.notEqual(s.state, 'lost', 'level 1 was lost during real play');
  }
  assert.ok(won, 'real level 1 play did not reach victory');
  await shot('audit-real-victory');
  console.log('PLAYTEST: real mouse input, natural sun and waves, pause/resume, 3x, level 1 victory', JSON.stringify(await read()));
}
