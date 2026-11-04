/** 探针 2：立绘模态 + 配音真实播放 */
const CDP = 'http://127.0.0.1:9222'
const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const errs = []
const send = (m, pr = {}) =>
  new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: pr }))
  })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errs.push(`EXC: ${m.params.exceptionDetails.text}`)
  else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push(`LOG: ${m.params.entry.text?.slice(0, 200)}`)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Page.bringToFront')
await sleep(500)

// 策略改回 dubbing
await ev(`(async()=>{await window.feather.saveSettings({autoplayPolicy:'dubbing', dialogMode:'normal', stageZoom:1}); return true})()`)
await sleep(300)

// 导航到「有立绘的 say 句」
console.log(
  '[导航到立绘对话句]',
  JSON.stringify(
    await ev(`(async()=>{
      const i=document.querySelector('#app').__vue_app__._instance; const v=i.setupState.view;
      const withImg=new Set(v.characters.filter(c=>c.imageUrl).map(c=>c.id));
      let best=null;
      v.actions.forEach((a,idx)=>{
        if(a.type!=='say'||!a.characterId||!withImg.has(a.characterId)) return;
        const ci=v.chapters.findIndex(c=>c.chapterSeq===a.chapterSeq); if(ci<0) return;
        const off=idx-v.chapters[ci].start;
        if(!best||off<best.off) best={ci,off,ch:a.chapterSeq,idx,cid:a.characterId};
      });
      if(!best) return {note:'没有带立绘的 say 句'};
      document.querySelectorAll('.chapter-pills .pill-btn')[best.ci].click();
      await new Promise(r=>setTimeout(r,300));
      const nextBtn=[...document.querySelectorAll('.stage-controls .btn')].find(b=>b.textContent.includes('下一句'));
      for(let k=0;k<best.off;k++){ nextBtn.click(); if(k%60===0) await new Promise(r=>setTimeout(r,10)); }
      await new Promise(r=>setTimeout(r,1500));
      const p=document.querySelector('[data-testid=stage-portrait]');
      return {target:best, clicks:best.off,
        portraitSrc:(p&&p.src||'').slice(0,46), portraitDecoded:!!(p&&p.naturalWidth>0),
        portraitDim:p?p.naturalWidth+'x'+p.naturalHeight:null,
        speaker:document.querySelector('.stage-textbox .speaker')?.innerText,
        speakerColor:document.querySelector('.stage-textbox .speaker')?.style.color,
        levelChip:[...document.querySelectorAll('.level-chip')].map(c=>c.innerText),
        dialogMode:document.querySelector('[data-testid^=dialog-]')?.dataset.testid};})()`
    , null, 2)
  )
)

// 立绘模态
console.log(
  '[立绘模态]',
  JSON.stringify(
    await ev(`(async()=>{
      const p=document.querySelector('[data-testid=stage-portrait]');
      if(!p) return {note:'当前句无立绘'};
      p.click(); await new Promise(r=>setTimeout(r,700));
      const tabs=[...document.querySelectorAll('[data-testid^=pm-tab-]')].map(t=>t.innerText);
      const img=document.querySelector('[data-testid=pm-image]');
      const before={count:document.querySelector('[data-testid=pm-count]').innerText, dim:img?img.naturalWidth+'x'+img.naturalHeight:null};
      document.querySelector('[data-testid=pm-next]').click(); await new Promise(r=>setTimeout(r,500));
      const img2=document.querySelector('[data-testid=pm-image]');
      const afterNext={count:document.querySelector('[data-testid=pm-count]').innerText, dim:img2?img2.naturalWidth+'x'+img2.naturalHeight:null};
      document.querySelector('[data-testid=pm-prev]').click(); await new Promise(r=>setTimeout(r,400));
      document.querySelector('[data-testid=pm-tab-0]').click(); await new Promise(r=>setTimeout(r,400));
      return {name:document.querySelector('[data-testid=pm-name]').innerText,
        level:document.querySelector('.pm-level')?.innerText,
        aliases:document.querySelector('.pm-aliases')?.innerText,
        tabs, before, afterNext,
        rows:[...document.querySelectorAll('.pm-row')].map(r=>r.innerText.replace(/\\s+/g,' ')),
        kw:[...document.querySelectorAll('.pm-kw .chip')].map(c=>c.innerText),
        summary:(document.querySelector('.pm-block p')?.innerText||'').slice(0,60)};})()`
    , null, 2)
  )
)
await ev(`document.querySelector('[data-testid=pm-close]')?.click()`)
await sleep(300)

// 配音播放：导航到第一条有配音的句，开自动播放，轮询推进 + pace
console.log(
  '[配音自动播放]',
  JSON.stringify(
    await ev(`(async()=>{
      const i=document.querySelector('#app').__vue_app__._instance; const v=i.setupState.view;
      const dubKeys=new Set(v.dubbing.map(d=>d.key));
      let best=null;
      v.actions.forEach((a,idx)=>{ if(best) return; if(!dubKeys.has(a.type+'|'+a.chapterSeq+'|'+a.order)) return;
        const ci=v.chapters.findIndex(c=>c.chapterSeq===a.chapterSeq); if(ci<0) return;
        best={ci,off:idx-v.chapters[ci].start,ch:a.chapterSeq,idx}; });
      if(!best) return {note:'该包无配音'};
      document.querySelectorAll('.chapter-pills .pill-btn')[best.ci].click();
      await new Promise(r=>setTimeout(r,300));
      const nextBtn=[...document.querySelectorAll('.stage-controls .btn')].find(b=>b.textContent.includes('下一句'));
      for(let k=0;k<best.off;k++){ nextBtn.click(); if(k%60===0) await new Promise(r=>setTimeout(r,10)); }
      await new Promise(r=>setTimeout(r,1200));
      document.querySelector('[data-testid=autoplay]').click();
      const t0=document.querySelector('.stage-toolbar .hint').innerText;
      const pace0=document.querySelector('.pace-chip')?.innerText;
      // 轮询最多 15s
      let advanced=false, t1=t0, pace1=pace0;
      for(let k=0;k<30;k++){
        await new Promise(r=>setTimeout(r,500));
        t1=document.querySelector('.stage-toolbar .hint').innerText;
        pace1=document.querySelector('.pace-chip')?.innerText;
        if(t1!==t0){ advanced=true; break; }
      }
      document.querySelector('[data-testid=autoplay]').click(); // 暂停
      return {clipCount:v.dubbing.length, clicks:best.off, hintBefore:t0, hintAfter:t1, advanced, pace0, pace1};})()`
    , null, 2)
  )
)

// 直接验证配音 mp3 可播放（读元数据 + 播放 + ended）
console.log(
  '[mp3 直播验证]',
  JSON.stringify(
    await ev(`(async()=>{
      const r=await window.feather.getView(); const d=r.data;
      if(!d.dubbing.length) return {note:'无配音'};
      const u=d.dubbing[0].url;
      const res=await fetch(u,{headers:{Range:'bytes=0-1023'}});
      const buf=await res.arrayBuffer();
      const a=new Audio(); a.src=u; a.volume=0;
      const meta=await new Promise(ok=>{ a.addEventListener('loadedmetadata',()=>ok({duration:a.duration})); a.addEventListener('error',()=>ok({error:a.error&&a.error.code})); setTimeout(()=>ok({timeout:true}),8000); });
      const played=await new Promise(ok=>{ a.addEventListener('ended',()=>ok({ended:true})); a.addEventListener('error',()=>ok({error:true})); a.play().then(()=>{}).catch(e=>ok({playErr:e.name})); setTimeout(()=>ok({timeout:true}),20000); });
      return {url:u.slice(0,44), rangeStatus:res.status, rangeLen:buf.byteLength,
        contentRange:res.headers.get('content-range'), contentType:res.headers.get('content-type'),
        acceptRanges:res.headers.get('accept-ranges'), meta, played};})()`
    , null, 2)
  )
)

// cache:// 路径穿越防护
console.log(
  '[cache:// 防护]',
  JSON.stringify(
    await ev(`(async()=>{
      const out={};
      const probe=async(name,url)=>{ try{ const r=await fetch(url); out[name]={status:r.status}; }catch(e){ out[name]={err:String(e).slice(0,60)}; } };
      await probe('ttsMissing','cache://tts/'+'0'.repeat(64)+'.mp3');
      await probe('traversal','cache://tts/..%2F..%2Fsettings.json');
      await probe('badHost','cache://etc/'+'0'.repeat(64)+'.mp3');
      await probe('badName','cache://tts/settings.json');
      await probe('bgmMissing','cache://bgm/'+'a'.repeat(32)+'.mp3');
      return out;})()`
    , null, 2)
  )
)

console.log('\n[运行期异常]', errs.length)
errs.forEach((e) => console.log('  ' + e))
ws.close()
