#!/usr/bin/env node
// Operator capture: same source JSON/timestamps as an existing native receipt.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

const {values: args} = parseArgs({options: {native: {type:'string'}, out:{type:'string'}, story:{type:'string'}}});
if (!args.native || !args.out) throw new Error('--native and --out required');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const native=path.resolve(args.native), out=path.resolve(args.out);
const manifest=JSON.parse(fs.readFileSync(path.join(native,'manifest.json')));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=`
import {compileTimeline} from ${JSON.stringify(path.join(root,'browser/v0/core/timeline/compile.mjs'))};
import {stateAt} from ${JSON.stringify(path.join(root,'browser/v0/core/state/state.mjs'))};
import {resolveStoryAssets} from ${JSON.stringify(path.join(root,'browser/v0/app/urls.mjs'))};
import {buildDrawList} from ${JSON.stringify(path.join(root,'browser/v0/app/stage/draw-list.mjs'))};
import {paintDrawList} from ${JSON.stringify(path.join(root,'browser/v0/app/stage/canvas-stage.mjs'))};
let story,timeline,images=new Map();
window.loadReview=async()=>{
 story=resolveStoryAssets(await(await fetch('/story.json')).json(),${JSON.stringify(manifest.asset_base)});
 timeline=compileTimeline(story);
 await Promise.all(Object.values(story.assets).filter(a=>a.type!=='shape').map(async asset=>{
  if(images.has(asset.url))return;
  const response=await fetch(asset.url); if(!response.ok)throw Error('Media '+response.status+': '+asset.media);
  images.set(asset.url,await createImageBitmap(await response.blob()));
 }));
};
window.drawReview=ms=>{
 const state=stateAt(timeline,story,ms),list=buildDrawList(state),canvas=document.querySelector('canvas');
 canvas.width=640;canvas.height=360;const missing=[];
 paintDrawList(canvas.getContext('2d'),list,{scale:640/list.width,lookup:url=>{const image=images.get(url);if(!image)missing.push(url);return image;}});
 if(missing.length)throw Error('Missing '+missing.join(','));
 return {data:canvas.toDataURL('image/png'),layers:state.renderNodes.map(n=>n.id)};
};`;
const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'native-comparison.js'},bundle:true,platform:'browser',format:'iife',write:false});
let current;
const server=http.createServer((req,res)=>{
 if(req.url==='/story.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(current));}
 else if(req.url==='/audit.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}
 else{res.setHeader('Content-Type','text/html');res.end('<canvas></canvas><script src="/audit.js"></script>');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true}), reports=[];
fs.mkdirSync(out,{recursive:true});
try{
 for(const entry of manifest.stories){
  if(args.story&&!entry.id.includes(args.story))continue;
  const bytes=fs.readFileSync(path.join(native,entry.url));
  if(hash(bytes)!==entry.sha256)throw Error('Fixture SHA '+entry.id);
  const fixture=JSON.parse(bytes), receipt=JSON.parse(fs.readFileSync(path.join(native,'receipts',entry.id+'.json')));
  if(!receipt.passed||receipt.source_sha256!==fixture.source_sha256)throw Error('Unmatched native receipt '+entry.id);
  current=fixture.story;
  const row={id:entry.id,source_sha256:fixture.source_sha256,samples:[],errors:[]};
  const page=await browser.newPage({viewport:{width:640,height:360}});
  page.on('pageerror',error=>row.errors.push(error.message));
  try{
   await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>window.loadReview());
   fs.mkdirSync(path.join(out,'browser',entry.id),{recursive:true});
   for(const sample of receipt.renders){
    const captured=await page.evaluate(ms=>window.drawReview(ms),sample.ms);
    if(JSON.stringify(captured.layers)!==JSON.stringify(sample.layers))throw Error('Layer order '+sample.ms);
    const png=Buffer.from(captured.data.split(',')[1],'base64');
    const file=entry.id+'/'+String(sample.index).padStart(4,'0')+'.png';
    fs.writeFileSync(path.join(out,'browser',file),png);
    row.samples.push({...sample,browser_png:'browser/'+file,browser_sha256:hash(png)});
   }
  }catch(error){row.errors.push(error.stack??String(error));}
  finally{await page.close();}
  reports.push(row);
  fs.writeFileSync(path.join(out,'captures.json'),JSON.stringify({native,render_size:[640,360],capture_bundle_sha256:hash(bundle.outputFiles[0].contents),reports},null,2)+'\n');
  console.log(JSON.stringify({id:entry.id,samples:row.samples.length,errors:row.errors.length,processed:reports.length}));
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
if(reports.some(r=>r.errors.length))process.exitCode=1;
