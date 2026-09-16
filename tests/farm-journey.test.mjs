import assert from 'node:assert/strict';
import test from 'node:test';
import { readFarmJourney, journeyCamera, JOURNEY_MS } from '../browser/v0/core/farm-journey.mjs';
import { normaliseCardBoard } from '../browser/v0/core/card-board.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { signatureOf } from '../browser/v0/app/timeline-player.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { createStateCursor } from '../browser/v0/core/state/cursor.mjs';
import { paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { fakeContext } from './_dom.mjs';

const actors = [
  {slug:'animal_cow', kind:'object', x:25, feetY:61, heightPx:240, opacity:1},
  {slug:'animal_sheep', kind:'object', x:40, feetY:62, heightPx:170, opacity:1},
  {slug:'animal_goat', kind:'object', x:53, feetY:79, heightPx:180, opacity:1},
  {slug:'animal_pig', kind:'object', x:80, feetY:66, heightPx:150, opacity:1},
  {slug:'animal_horse', kind:'object', x:50, feetY:43, heightPx:155, opacity:1},
  {slug:'animal_donkey', kind:'object', x:65, feetY:44, heightPx:135, opacity:1},
];
const frame = (from,to,tMs=0) => ({tMs, actors, camera:{scale:1,x:0,y:0},plate:{resolution:[1920,1080]},
  slate:{mode:'cards',cards:[`animal_${to === 'wide' ? 'cow' : to}`,`farm_view_${from}_${to}`],prompt:to === 'wide' ? '' : to,focus:null,sinceMs:0}});
const sheets={prop:slug=>({url:`assets/${slug}.svg`}),sheet:()=>null};
test('settled camera centers the teaching animal on both axes',()=>{
  for (const actor of actors) {
    const name=actor.slug.slice(7),camera=journeyCamera(frame('wide',name,4400));
    assert.ok(Math.abs(actor.x*camera.scale+camera.x-50)<.001, name+' horizontal center');
    assert.ok(Math.abs((actor.feetY-actor.heightPx/1080*50)*camera.scale+camera.y-50)<.001,name+' vertical center');
  }
});
test('name label paints with the supported older canvas context',()=>{
  const ctx=fakeContext();
  assert.equal(ctx.roundRect,undefined);
  assert.doesNotThrow(()=>paintDrawList(ctx,buildDrawList(frame('wide','cow',4400),sheets),{lookup:()=>({width:1254,height:1254})}));
  assert.ok(ctx.of('fillText').some(call=>call.includes('cow')));
});
test('native journey reports missing placed targets instead of a silent wide fallback',()=>{
  const marker='farm_view_wide_cow';
  const bundle={storylang_version:0,title:'Missing target',cast:{},audio:{sfx:{},bgm:{}},
    objects:Object.fromEntries(['animal_cow',marker].map(slug=>[slug,{svg:`assets/${slug}.svg`,height_cm:35}])),
    scenes:[{place:'farm',plate:{resolution:[1920,1080],zones:[]},steps:[
      {kind:'cmd',cmd:'board',cards:['animal_cow',marker],prompt:'Cow',line:2},
      {kind:'cmd',cmd:'pause',seconds:8,line:3}]}]};
  const warnings=compileTimeline(bundle).events.filter(e=>e.kind==='warning');
  assert.ok(warnings.some(e=>e.detail?.policy==='farm-camera-target-missing'));
});
test('journey refuses unknown endpoints, absent base and control focus',()=>{
  for(const value of [17,{},null,[],true]) assert.equal(readFarmJourney({cards:[value,'farm_view_wide_cow']}).kind,'invalid');
  for(const cards of [['farm_view_wide_cow'],['animal_cow','farm_view_wide_bad'],['animal_cow','farm_view_bad_cow'],['animal_cow','farm_view_wide_cow','extra']])
    assert.equal(normaliseCardBoard({cards}),null);
  assert.equal(normaliseCardBoard({...frame('wide','cow').slate,focus:2}),null);
  assert.equal(readFarmJourney({cards:['animal_cow']}),null);
});
test('camera endpoints join continuously and clamp to the background without exposing borders',()=>{
  for(const [from,to,next] of [['wide','cow','sheep'],['cow','sheep','goat'],['sheep','goat','pig'],['goat','pig','horse'],['pig','horse','donkey'],['horse','donkey','wide']]){
    assert.deepEqual(journeyCamera(frame(from,to,JOURNEY_MS)),journeyCamera(frame(to,next,0)));
    for(const t of [0,700,1400,2100,2800,7000]){
      const camera=journeyCamera(frame(from,to,t));
      for(const axis of ['x','y']) assert.ok(camera[axis]<=0 && camera[axis]>=100*(1-camera.scale)-0.0001);
    }
  }
});
test('habitat scenes render each animal once and no board; name waits for arrival',()=>{
  for(const t of [0,1400,2800,3800,4400]){
    const state=frame('wide','cow',t),draw=buildDrawList(state,sheets);
    assert.deepEqual(draw.camera,journeyCamera(state));
    assert.equal(draw.commands.filter(c=>c.op==='prop').length,6);
    assert.equal(draw.commands.filter(c=>c.op==='slate').length,0);
    assert.equal(draw.commands.some(c=>c.op==='farm-label'),t>3800);
    const label=draw.commands.find(c=>c.op==='farm-label');
    if(label) assert.equal(label.x+label.w/2,(25*draw.camera.scale+draw.camera.x)/100*1920,'name must align with the named animal, not a neighbouring animal');
    const cow=draw.commands.find(c=>c.slug==='animal_cow' && c.op==='prop');
    assert.ok(cow.dy*draw.camera.scale+draw.camera.y/100*1080>=0);
  }
  assert.notEqual(signatureOf(frame('wide','cow',500)),signatureOf(frame('wide','cow',1000)));
  assert.equal(signatureOf(frame('wide','cow',4500)),signatureOf(frame('wide','cow',8000)));
});
test('all six home friends have centered camera views and no exposed plate edges',()=>{
  const homes=[['dog',26,73,195],['cat',17,47,120],['rabbit',43,60,105],['chicken',60,51,115],['duck',55,70,120],['goose',75,87,150]];
  const homeActors=homes.map(([name,x,feetY,heightPx])=>({slug:`animal_${name}`,kind:'object',x,feetY,heightPx,opacity:1}));
  for(const [name,x,y,h] of homes){
    const state={...frame('wide',name,4400),actors:homeActors};
    const camera=journeyCamera(state),draw=buildDrawList(state,sheets);
    assert.equal(readFarmJourney(state.slate)?.kind,'journey');
    assert.ok(Math.abs(x*camera.scale+camera.x-50)<.001,name+' x');
    assert.ok(Math.abs((y-h/1080*50)*camera.scale+camera.y-50)<.001,name+' y');
    assert.equal(draw.commands.filter(c=>c.op==='prop').length,6);
    for(const axis of ['x','y']) assert.ok(camera[axis]<=0 && camera[axis]>=100*(1-camera.scale)-.001);
  }
});
test('distant pen and stable animals stay fully framed, with labels over their own bodies',()=>{
  for(const [from,to] of [['goat','pig'],['pig','horse'],['horse','donkey']]) {
    const state=frame(from,to,4400),draw=buildDrawList(state,sheets);
    assert.ok(readFarmJourney(state.slate)?.kind==='journey');
    const animal=draw.commands.find(c=>c.op==='prop' && c.slug===`animal_${to}`);
    const label=draw.commands.find(c=>c.op==='farm-label');
    assert.ok(label);
    const top=animal.dy*draw.camera.scale+draw.camera.y/100*1080;
    const bottom=(animal.dy+animal.dh)*draw.camera.scale+draw.camera.y/100*1080;
    assert.ok(top>=0 && bottom<1080*.75);
    assert.ok(draw.camera.scale>=3 && draw.camera.scale<=3.2);
  }
});
test('native cursor and reverse seek restore identical camera and label state',()=>{
  const marker='farm_view_wide_cow';
  const bundle={storylang_version:0,title:'Journey',cast:{},audio:{sfx:{},bgm:{}},
    objects:Object.fromEntries(['animal_cow',marker].map(slug=>[slug,{svg:`assets/${slug}.svg`,height_cm:35}])),
    scenes:[{place:'farm',plate:{resolution:[1920,1080],zones:[]},steps:[
      {kind:'cmd',cmd:'put',subjects:['animal_cow'],objects:['animal_cow'],position:'center',line:1},
      {kind:'cmd',cmd:'board',cards:['animal_cow',marker],prompt:'Cow',line:2},
      {kind:'cmd',cmd:'pause',seconds:8,line:3}]}]};
  const timeline=compileTimeline(bundle),cursor=createStateCursor(timeline,bundle);
  assert.equal(timeline.events.filter(e=>e.kind==='warning').length,0);
  for(const t of [0,1400,4400,7999,700,4400]) assert.deepEqual(buildDrawList(cursor.at(t),sheets),buildDrawList(stateAt(timeline,bundle,t),sheets));
});


for (const replaceTarget of [false, true]) {
  test(`an inherited farm camera ${replaceTarget ? 'allows a target replaced at the cut' : 'reports a target lost at the cut'}`, () => {
    const marker = 'farm_view_wide_cow';
    const put = {kind:'cmd',cmd:'put',subjects:['animal_cow'],objects:['animal_cow'],position:'center',line:1};
    const pause = seconds => ({kind:'cmd',cmd:'pause',seconds,line:3});
    const plate = {resolution:[1920,1080],zones:[]};
    const bundle = {storylang_version:0,title:'Inherited camera',cast:{},audio:{sfx:{},bgm:{}},
      objects:Object.fromEntries(['animal_cow',marker].map(slug=>[slug,{svg:`assets/${slug}.svg`,height_cm:35}])),
      scenes:[{place:'farm',plate,steps:[put,{kind:'cmd',cmd:'board',cards:['animal_cow',marker],prompt:'Cow',line:2},pause(8)]},
        {place:'farm',plate,steps:[...(replaceTarget ? [put] : []),pause(5)]}]};
    const timeline = compileTimeline(bundle);
    const warnings = timeline.events.filter(e=>e.detail?.policy==='farm-camera-target-missing');
    assert.equal(warnings.length, replaceTarget ? 0 : 1);
    if (!replaceTarget) {
      assert.equal(warnings[0].t_ms, 8000);
      assert.equal(warnings[0].scene_index, 1);
      assert.deepEqual(warnings[0].detail.targets, ['cow']);
    }
    assert.equal(timeline.events.at(-1).op, 'end');
    assert.deepEqual(compileTimeline(bundle), timeline);
  });
}
