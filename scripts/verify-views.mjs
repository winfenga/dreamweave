/**
 * 地图互动 / 印象图谱 / 视觉演出 三个视图的端到端验证（走 CDP 连进真实渲染进程，不是 mock）。
 *
 * 前置：
 *   1) 应用必须以调试端口启动： npm run dev -- --remote-debugging-port=9222
 *   2) 本机 shell 若带 ELECTRON_RUN_AS_NODE=1，需 env -u ELECTRON_RUN_AS_NODE
 * 用法：
 *   npm run verify:views                      # 默认《基督山伯爵》
 *   npm run verify:views -- "<某个 .t2w 绝对路径>"
 *
 * 可用环境变量覆盖截图落点（默认都写到 recon/）：
 *   OUT_MAP / OUT_STAGE / OUT_IMPRESSION / OUT_MOVE / OUT_BATTLE
 * 注意：不含 move / battle 的包会跳过对应截图并如实说明。
 *
 * 注意：截图前先重新 Page.bringToFront —— 窗口被遮挡时 visibilityState='hidden'，
 * Chromium 会停止合成新帧，Page.captureScreenshot 将永久挂死（已加超时 + 3 次重试）。
 */
import { writeFile, stat } from 'node:fs/promises'

const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const OUT_MAP = process.env.OUT_MAP ?? 'C:/Users/wfsyb/WorkBuddy/tx/recon/feather_map.png'
const OUT_STAGE = process.env.OUT_STAGE ?? 'C:/Users/wfsyb/WorkBuddy/tx/recon/feather_stage.png'
const OUT_IMPRESSION = process.env.OUT_IMPRESSION ?? 'C:/Users/wfsyb/WorkBuddy/tx/recon/feather_impression.png'
const OUT_MOVE = process.env.OUT_MOVE ?? 'C:/Users/wfsyb/WorkBuddy/tx/recon/feather_move.png'
const OUT_BATTLE = process.env.OUT_BATTLE ?? 'C:/Users/wfsyb/WorkBuddy/tx/recon/feather_battle.png'

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
/** 渲染进程运行期异常 / console.error（用于证明「降级分支未报错」） */
const runtimeErrors = []
const send = (m, pr = {}) =>
  new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: pr }))
  })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    runtimeErrors.push(`EXCEPTION: ${d.text} | ${d.exception?.description?.slice(0, 300)}`)
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    runtimeErrors.push(`LOG.error: ${m.params.entry.text?.slice(0, 200)}`)
  }
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 900))
  return r.result.value
}
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT ' + label)), ms))])

/**
 * 截图前必须重新 bringToFront：窗口一旦被遮挡，visibilityState 变回 hidden，
 * Chromium 停止合成新帧，captureScreenshot 就会一直不返回。带重试 + 超时兜底。
 */
const shot = async (path) => {
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await send('Page.bringToFront')
      await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
      await new Promise((r) => setTimeout(r, 500))
      const s = await withTimeout(send('Page.captureScreenshot', { format: 'png', fromSurface: true }), 15000, path)
      await writeFile(path, Buffer.from(s.data, 'base64'))
      return (await stat(path)).size
    } catch (e) {
      lastErr = e
      console.log(`  [截图重试 ${attempt + 1}/3] ${e.message}`)
    }
  }
  throw lastErr
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Page.bringToFront')
await new Promise((r) => setTimeout(r, 500))
console.log('visibility:', await ev('document.visibilityState'))

const P = process.argv[2] ?? 'D:/aaaTemp/基督山伯爵 · 前十章｜归航与陷阱.t2w'

console.log('\n=== 1) 导入（并把结果注入 App 状态，等价于点了「导入」按钮后的界面） ===')
console.log(
  JSON.stringify(
    await ev(`(async()=>{const r=await window.feather.importPackage(${JSON.stringify(P)});
      const i=document.querySelector('#app').__vue_app__._instance;
      i.setupState.summary=r.summary; i.setupState.view=null; i.setupState.viewError='';
      return {ok:r.ok,title:r.summary&&r.summary.project.title,verify:r.summary&&r.summary.verify};})()`)
  )
)
console.log(
  '注入后 DOM:',
  JSON.stringify(await ev(`({buttons:[...document.querySelectorAll('.tabs button')].map(b=>b.textContent.trim()), mapNodes:document.querySelectorAll('.map-node').length})`))
)

console.log('\n=== 2) getView() 渲染模型 ===')
console.log(
  JSON.stringify(
    await ev(`(async()=>{
      const r=await window.feather.getView(); if(!r.ok) return {ok:false,error:r.error};
      const d=r.data; const tc=(n)=>1+n.children.reduce((s,c)=>s+tc(c),0);
      return {ok:true, assetBase:d.assetBase, protocol:d.protocol,
        treeNodeCount: tc(d.mapRoot), flatLocations: d.mapNodes.length, stats: d.stats,
        chapters: d.chapters.map(c=>({seq:c.chapterSeq,count:c.count,scenes:c.sceneIds.length})),
        scenesWithImage: d.scenes.filter(s=>s.imageUrl).length,
        charactersWithImage: d.characters.filter(c=>c.imageUrl).length,
        sampleSceneUrl: d.scenes[0]&&d.scenes[0].imageUrl,
        sampleCharUrl: d.characters[0]&&d.characters[0].imageUrl,
        artStyleLen: {character:d.artStyles.character.length, scene:d.artStyles.scene.length}};})()`)
    , null, 2)
)

/** 确保 App 已拿到渲染模型（等价于用户点开了地图/演出标签） */
const ensureView = () =>
  ev(`(async()=>{const i=document.querySelector('#app').__vue_app__._instance;
    if(i.setupState.view) return 'already';
    const r=await window.feather.getView(); if(!r.ok) return 'fail:'+r.error;
    i.setupState.view=r.data; return 'loaded';})()`)

console.log('\n=== 3) 地图互动视图 ===')
await ev(`(()=>{const i=document.querySelector('#app').__vue_app__._instance; i.setupState.tab='overview'; return true})()`)
await new Promise((r) => setTimeout(r, 300))
await ev(`(()=>{const i=document.querySelector('#app').__vue_app__._instance; i.setupState.tab='map'; return true})()`)
console.log('ensureView:', await ensureView())
await new Promise((r) => setTimeout(r, 1800))
console.log(
  JSON.stringify(
    await ev(`(()=>{
      const nodes=[...document.querySelectorAll('.map-node')];
      const edges=[...document.querySelectorAll('.map-edges path')];
      const types={}; for(const n of nodes){const t=(n.querySelector('.type')?.textContent||'').trim(); types[t]=(types[t]||0)+1;}
      return {mapNodesInDom:nodes.length, edgesInDom:edges.length, typeDist:types,
        withSceneBadge:nodes.filter(n=>n.querySelector('.badge-scene')).length,
        zoom:(document.querySelector('.map-toolbar .hint')?.textContent||'').trim()};})()`)
    , null, 2)
)

console.log('\n--- 点击「法老号」节点 ---')
console.log(
  JSON.stringify(
    await ev(`(async()=>{
      // 优先点「剧本条目最多」的场景节点，截图更有代表性；找不到再退回第一个节点
      const all=[...document.querySelectorAll('.map-node')];
      const i2=document.querySelector('#app').__vue_app__._instance;
      const vv=i2.setupState.view;
      const byNode=new Map();
      for(const s of vv.scenes){ if(s.mapLocationId) byNode.set(s.mapLocationId,(byNode.get(s.mapLocationId)||0)+s.actionCount); }
      const ranked=all.filter(n=>n.querySelector('.badge-scene'))
        .map(n=>({n,c:byNode.get(n.dataset.nodeId)||0}));
      const node=(ranked.length? ranked.sort((a,b)=>b.c-a.c)[0].n : all[0]);
      if(!node) return {error:'地图里没有任何节点', nodeCount:0};
      node.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      await new Promise(r=>setTimeout(r,1300));
      const img=document.querySelector('.map-detail .scene-img');
      const clean=(s)=>(s||'').replace(/\\s+/g,' ').trim();
      return {clicked:node.querySelector('.name')?.textContent,
        detailName:document.querySelector('.map-detail h3')&&document.querySelector('.map-detail h3').textContent,
        detailType:clean(document.querySelector('.map-detail .pill')&&document.querySelector('.map-detail .pill').textContent),
        crumbs:clean(document.querySelector('.map-detail .crumbs')&&document.querySelector('.map-detail .crumbs').innerText),
        stats:[...document.querySelectorAll('.map-detail .stat')].map(s=>clean(s.innerText)),
        sceneBlocks:[...document.querySelectorAll('.map-detail .scene-block h4')].map(h=>clean(h.innerText)),
        sceneImgSrc:(img&&img.src||'').slice(0,60), sceneImgDim:img?img.naturalWidth+'x'+img.naturalHeight:null,
        identInfos:[...document.querySelectorAll('.map-detail .block p')].slice(0,2).map(p=>clean(p.innerText).slice(0,70))};})()`)
    , null, 2)
)
console.log('地图截图 bytes:', await shot(OUT_MAP))
console.log('title:', await ev('document.title'))

console.log('\n=== 3.5) 印象图谱视图 ===')
await ev(`(()=>{const i=document.querySelector('#app').__vue_app__._instance; i.setupState.tab='impression'; return true})()`)
console.log('ensureView:', await ensureView())
await new Promise((r) => setTimeout(r, 1500))
console.log(
  JSON.stringify(
    await ev(`(async()=>{
      const i=document.querySelector('#app').__vue_app__._instance;
      const v=i.setupState.view;
      const boxes=[...document.querySelectorAll('.imp-box')];
      const depths=(()=>{const d=[];for(const b of boxes){let n=0,p=b.parentElement;while(p){if(p.classList&&p.classList.contains('imp-box'))n++;p=p.parentElement;}d.push(n);}return d;})();
      const maxDepth=depths.length?Math.max(...depths)+1:0;
      const rects=boxes.slice(0,3).map(b=>({id:b.dataset.impId, left:b.style.left, top:b.style.top, w:b.style.width, h:b.style.height}));
      // 点击一个「带场景角标」的矩形，验证联动
      // 只认「自己的标签上带角标」的矩形（子矩形嵌套在父矩形内，
      // 用 querySelector 会命中外层祖先，必须用 :scope 限定直接子级）
      const withScene=boxes.find(b=>b.querySelector(':scope > .imp-label > .badge-scene'))||boxes[boxes.length-1]||boxes[0];
      let link=null;
      if(withScene){
        withScene.dispatchEvent(new MouseEvent('click',{bubbles:true}));
        await new Promise(r=>setTimeout(r,1200));
        const img=document.querySelector('.map-detail .scene-img');
        link={clicked:withScene.dataset.impId,
          detailName:document.querySelector('.map-detail h3')?.textContent,
          detailType:document.querySelector('.map-detail .pill')?.textContent?.trim(),
          stats:[...document.querySelectorAll('.map-detail .stat')].map(s=>s.innerText.replace(/\\n/g,' ')),
          sceneBlocks:[...document.querySelectorAll('.map-detail .scene-block h4')].map(h=>h.innerText.replace(/\\s+/g,' ')),
          sceneImgDim:img?img.naturalWidth+'x'+img.naturalHeight:null,
          sceneImgSrc:(img&&img.src||'').slice(0,50)};
      }
      return {impressionDataPresent: !!v.impression,
        gridSize: v.impression&&v.impression.gridSize,
        layoutGroupCount: v.impression?v.impression.layouts.length:0,
        statPlacementCount: v.stats.impressionPlacementCount,
        statLevelCount: v.stats.impressionLevelCount,
        rootParentId: v.impression&&v.impression.rootParentId,
        boxesInDom: boxes.length, maxDepthFromDom: maxDepth,
        legend: (document.querySelector('.imp-legend')?.innerText||'').replace(/\\s+/g,' ').trim(),
        firstRects: rects, link};
    })()`),
    null,
    2
  )
)
console.log('印象图谱截图 bytes:', await shot(OUT_IMPRESSION))

console.log('\n=== 4) 视觉演出视图 ===')
await ev(`(()=>{const i=document.querySelector('#app').__vue_app__._instance; i.setupState.tab='stage'; return true})()`)
console.log('ensureView:', await ensureView())
await new Promise((r) => setTimeout(r, 1300))
// 先用数据定位「有场景图」的那一句，再驱动界面跳过去 —— 对任意包都确定性可复现，
// 不依赖盲点「下一句」（无立绘的包盲点会走空）。
console.log(
  JSON.stringify(
    await ev(`(async()=>{
      const i=document.querySelector('#app').__vue_app__._instance;
      const v=i.setupState.view;
      const withImg=new Set(v.scenes.filter(s=>s.imageUrl).map(s=>s.id));
      const portraitIds=new Set(v.characters.filter(c=>c.imageUrl).map(c=>c.id));
      const actionsWithImg=v.actions.filter(a=>a.locationId&&withImg.has(a.locationId)).length;
      if(!v.scenes.some(s=>s.imageUrl)) return {note:'该包没有任何场景图，跳过定位', actionsWithImg, scenesWithImage:0};

      // 选目标句优先级：①有背景图+立绘的对话句 ②有背景图+立绘 ③有背景图；同类里取「距章首最近」的
      let best=null;
      v.actions.forEach((a,idx)=>{
        if(!a.locationId||!withImg.has(a.locationId)) return;
        const hasPortrait=!!(a.characterId&&portraitIds.has(a.characterId));
        const isSay=a.type==='say';
        const rank = (hasPortrait&&isSay)?0 : hasPortrait?1 : 2;
        const ci=v.chapters.findIndex(c=>c.chapterSeq===a.chapterSeq);
        if(ci<0) return;
        const off=idx-v.chapters[ci].start;
        if(!best||rank<best.rank||(rank===best.rank&&off<best.off)) best={ci,off,loc:a.locationId,ch:a.chapterSeq,idx,rank,hasPortrait,isSay};
      });
      if(!best) return {note:'未能定位目标句', actionsWithImg};
      // 跳章：点章节药丸（跳章下拉已换成可搜索的 SearchSelect，药丸对所有包都稳定存在）
      const pill=document.querySelectorAll('.chapter-pills .pill-btn')[best.ci];
      if(pill) pill.click();
      await new Promise(r=>setTimeout(r,400));
      // 精确前进到目标偏移（不能「一有背景就停」——章节标题句往往也带背景）
      const nextBtn=[...document.querySelectorAll('.stage-controls .btn')].find(b=>b.textContent.includes('下一句'));
      let clicks=0;
      const need=Math.min(best.off, 1200);
      for(let k=0;k<need;k++){ nextBtn.click(); clicks++; if(k%40===0) await new Promise(r=>setTimeout(r,12)); }
      await new Promise(r=>setTimeout(r,1200));
      const bg=document.querySelector('img.stage-bg');
      const port=document.querySelector('img.stage-portrait');
      return {scenesWithImage:v.scenes.filter(s=>s.imageUrl).length, actionsWithImg,
        target:{chapterSeq:best.ch, chapterIdx:best.ci, offsetInChapter:best.off, locationId:best.loc,
          hasPortrait:best.hasPortrait, isSay:best.isSay, rank:best.rank},
        clicks,
        bgSrcPrefix:(bg&&bg.src||'').slice(0,52), bgDecoded:!!(bg&&bg.naturalWidth>0), bgDim:bg?bg.naturalWidth+'x'+bg.naturalHeight:null,
        portraitSrcPrefix:(port&&port.src||'').slice(0,52), portraitDecoded:!!(port&&port.naturalWidth>0), portraitDim:port?port.naturalWidth+'x'+port.naturalHeight:null,
        chips:[...document.querySelectorAll('.stage-chips .chip')].map(c=>c.innerText),
        speaker:document.querySelector('.stage-textbox .speaker')&&document.querySelector('.stage-textbox .speaker').textContent,
        textboxClass:document.querySelector('.stage-textbox').className,
        text:document.querySelector('.stage-text').textContent.slice(0,80),
        progress:document.querySelector('.stage-toolbar .hint').innerText};})()`)
    , null, 2)
)
console.log('演出截图 bytes:', await shot(OUT_STAGE))

console.log('title:', await ev('document.title'))

/** 驱动界面跳到某一类动作（move / battle）；返回时让动画仍在播（约 700ms）以便截图 */
async function driveTo(type) {
  return ev(`(async()=>{
    const i=document.querySelector('#app').__vue_app__._instance;
    const v=i.setupState.view;
    const T='${type}';
    let best=null;
    v.actions.forEach((a,idx)=>{
      if(a.type!==T) return;
      const ci=v.chapters.findIndex(c=>c.chapterSeq===a.chapterSeq);
      if(ci<0) return;
      const off=idx-v.chapters[ci].start;
      // move 优先「有起点也有终点」，其次只有起点；battle 优先「有 targetIds」
      const pref = T==='move'
        ? ((a.fromLocationId&&a.toLocationId)?0:(a.fromLocationId?1:2))
        : (((a.targetIds??[]).length)?0:1);
      if(!best||pref<best.pref||(pref===best.pref&&off<best.off))
        best={ci,off,pref,idx,ch:a.chapterSeq,fl:a.fromLocationId,tl:a.toLocationId,targets:a.targetIds};
    });
    if(!best) return {note:'该包没有 '+T};
    // 跳章：点章节药丸（跳章下拉已换成可搜索的 SearchSelect，药丸对所有包都稳定存在）
    const pill=document.querySelectorAll('.chapter-pills .pill-btn')[best.ci];
    if(pill) pill.click();
    await new Promise(r=>setTimeout(r,400));
    const nextBtn=[...document.querySelectorAll('.stage-controls .btn')].find(b=>b.textContent.includes('下一句'));
    const need=Math.min(best.off,1200);
    for(let k=0;k<need;k++){ nextBtn.click(); if(k%40===0) await new Promise(r=>setTimeout(r,12)); }
    await new Promise(r=>setTimeout(r,700));
    const stage=document.querySelector('.stage');
    const box=document.querySelector('.stage-textbox');
    return {target:best, clicks:need,
      stageClass:stage?stage.className:null,
      boxClass:box?box.className:null,
      moveCard:(document.querySelector('.move-card')?.innerText||'').replace(/\\s+/g,' ').trim()||null,
      moveLayerKind:document.querySelector('.move-layer')?.className||null,
      battleBadge:(document.querySelector('.battle-badge')?.innerText||'').trim()||null,
      battleTargets:[...document.querySelectorAll('.battle-target')].map(t=>t.innerText.replace(/\\s+/g,' ').trim()),
      battleTargetImgs:[...document.querySelectorAll('.battle-target img')].filter(im=>im.naturalWidth>0).length,
      chips:[...document.querySelectorAll('.stage-chips .chip')].map(c=>c.innerText),
      text:(document.querySelector('.stage-text')?.textContent||'').slice(0,70),
      progress:document.querySelector('.stage-toolbar .hint').innerText};
  })()`)
}

console.log('\n=== 4.6) move 表现 ===')
const mv = await driveTo('move')
console.log(JSON.stringify(mv, null, 2))
let moveShot = null
if (!mv?.note) moveShot = await shot(OUT_MOVE)
console.log('move 截图 bytes:', moveShot ?? '（跳过：该包无 move）', moveShot ? `→ ${OUT_MOVE}` : '')

console.log('\n=== 4.7) battle 表现 ===')
const bt = await driveTo('battle')
console.log(JSON.stringify(bt, null, 2))
let battleShot = null
if (!bt?.note) battleShot = await shot(OUT_BATTLE)
console.log('battle 截图 bytes:', battleShot ?? '（跳过：该包无 battle）', battleShot ? `→ ${OUT_BATTLE}` : '')

console.log('\n=== 4.8) move 降级分支（缺 toLocationId） ===')
console.log(
  JSON.stringify(
    await ev(`(async()=>{
      const i=document.querySelector('#app').__vue_app__._instance;
      const v=i.setupState.view;
      // 只找「有起点、没终点」的 move —— 实测 29 条里有 3 条属于这种
      let best=null;
      v.actions.forEach((a,idx)=>{
        if(a.type!=='move') return;
        if(!(a.fromLocationId && !a.toLocationId)) return;
        const ci=v.chapters.findIndex(c=>c.chapterSeq===a.chapterSeq);
        if(ci<0) return;
        const off=idx-v.chapters[ci].start;
        if(!best||off<best.off) best={ci,off,ch:a.chapterSeq,fl:a.fromLocationId,tl:a.toLocationId,idx};
      });
      if(!best) return {note:'该包没有「缺终点」的 move', totalMoves:v.stats.moveCount, moveWithoutTarget:v.stats.moveWithoutTarget};
      // 跳章：点章节药丸（跳章下拉已换成可搜索的 SearchSelect，药丸对所有包都稳定存在）
      const pill=document.querySelectorAll('.chapter-pills .pill-btn')[best.ci];
      if(pill) pill.click();
      await new Promise(r=>setTimeout(r,400));
      const nextBtn=[...document.querySelectorAll('.stage-controls .btn')].find(b=>b.textContent.includes('下一句'));
      const need=Math.min(best.off,1200);
      for(let k=0;k<need;k++){ nextBtn.click(); if(k%40===0) await new Promise(r=>setTimeout(r,12)); }
      await new Promise(r=>setTimeout(r,700));
      const stage=document.querySelector('.stage');
      return {statsMoveWithoutTarget:v.stats.moveWithoutTarget, moveCount:v.stats.moveCount,
        target:best, clicks:need,
        stageClass:stage?stage.className:null,
        boxClass:document.querySelector('.stage-textbox')?.className,
        moveLayerKind:document.querySelector('.move-layer')?.className||null,
        moveCard:(document.querySelector('.move-card')?.innerText||'').replace(/\\s+/g,' ').trim()||null,
        hasUnknownLabel: !!document.querySelector('.move-unknown'),
        stageNotBlank: !!document.querySelector('.stage-bg, .stage-bg-missing'),
        text:(document.querySelector('.stage-text')?.textContent||'').slice(0,60),
        progress:document.querySelector('.stage-toolbar .hint').innerText};
    })()`),
    null,
    2
  )
)

console.log('\n=== 4.5) 美术风格面板（仅展示，不生成） ===')
console.log(
  JSON.stringify(
    await ev(`(async()=>{
      const btn=[...document.querySelectorAll('.stage-toolbar .btn')].find(b=>b.textContent.includes('美术风格'));
      if(!btn) return {error:'未找到美术风格按钮'};
      btn.click(); await new Promise(r=>setTimeout(r,500));
      const pres=[...document.querySelectorAll('.art-panel .art-text')];
      return {panelVisible:!!document.querySelector('.art-panel'),
        heads:[...document.querySelectorAll('.art-panel h4')].map(h=>h.innerText),
        textLens:pres.map(p=>p.innerText.length),
        charPreview:pres[0]?pres[0].innerText.slice(0,80):null,
        scenePreview:pres[1]?pres[1].innerText.slice(0,80):null};})()`),
    null,
    2
  )
)

console.log('\n=== 5) t2w:// 全量图片解码 ===')
console.log(
  JSON.stringify(
    await ev(`(async()=>{
      const r=await window.feather.getView(); const d=r.data;
      const urls=[...d.scenes.map(s=>s.imageUrl).filter(Boolean), ...d.characters.map(c=>c.imageUrl).filter(Boolean)];
      const uniq=[...new Set(urls)];
      const dec=(u)=>new Promise(ok=>{const im=new Image(); im.onload=()=>ok({ok:true,w:im.naturalWidth,h:im.naturalHeight});
        im.onerror=()=>ok({ok:false}); im.src=u;});
      const res=await Promise.all(uniq.map(dec));
      const good=res.filter(x=>x.ok); const dims={}; for(const x of good){const k=x.w+'x'+x.h; dims[k]=(dims[k]||0)+1;}
      return {uniqueUrls:uniq.length, decoded:good.length, failed:res.length-good.length, dims, sampleSrc:uniq[0]};})()`)
    , null, 2)
)

console.log('=== 6) t2w:// 响应头 ===')
console.log(
  JSON.stringify(
    await ev(`(async()=>{
      const r=await window.feather.getView(); const u=r.data.scenes[0].imageUrl;
      const res=await fetch(u); const buf=await res.arrayBuffer();
      const b=new Uint8Array(buf.slice(0,8));
      return {url:u, status:res.status, contentType:res.headers.get('content-type'),
        cacheControl:res.headers.get('cache-control'), contentLength:res.headers.get('content-length'),
        bytes:buf.byteLength, magicHex:[...b].map(x=>x.toString(16).padStart(2,'0')).join('')};})()`)
    , null, 2
  )
)
console.log('\n=== 7) 渲染进程运行期异常汇总 ===')
console.log(`共 ${runtimeErrors.length} 条`)
runtimeErrors.forEach((e) => console.log('  ' + e))
if (!runtimeErrors.length) console.log('  （无 exception / 无 console.error —— 含 move 缺终点的降级分支）')

ws.close()
