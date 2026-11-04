/** 探针 3：干净状态下验证配音播放 + 自动播放推进（先 reload） */
const CDP = 'http://127.0.0.1:9222'
const P = process.argv[2] ?? 'D:/aaaTemp/基督山伯爵 · 前十章｜归航与陷阱 (1).t2w'
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
  if (m.method === 'Runtime.exceptionThrown') errs.push(`EXC: ${m.params.exceptionDetails.text} | ${m.params.exceptionDetails.exception?.description?.slice(0, 200)}`)
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

// 干净状态：reload 后重新导入
await send('Page.reload', { ignoreCache: false })
await sleep(2500)
await send('Page.bringToFront')
await sleep(500)
console.log('[导入]', JSON.stringify(await ev(`(async()=>{const r=await window.feather.importPackage(${JSON.stringify(P)});
  const i=document.querySelector('#app').__vue_app__._instance;
  i.setupState.summary=r.summary; i.setupState.view=null; i.setupState.viewError='';
  return {ok:r.ok,verify:r.summary&&r.summary.verify};})()`)))

console.log('[设置] policy=dubbing', JSON.stringify(await ev(`(async()=>{const r=await window.feather.saveSettings({autoplayPolicy:'dubbing',dialogMode:'normal',stageZoom:1}); const s=await window.feather.getSettings(); return {ok:r.ok,policy:s.autoplayPolicy};})()`)))
await sleep(400)

// mp3 直播放验证（干净页面，用户手势已由 click 提供）
console.log(
  '[mp3 直播放]',
  JSON.stringify(
    await ev(`(async()=>{
      const r=await window.feather.getView(); const d=r.data;
      if(!d.dubbing.length) return {note:'无配音'};
      const u=d.dubbing[0].url;
      // 1) Range fetch（带 CORS 头后应放行）
      const res=await fetch(u,{headers:{Range:'bytes=0-1023'}});
      const buf=await res.arrayBuffer();
      // 2) 元数据 + 播放到 ended
      const a=new Audio(); a.src=u;
      const meta=await new Promise(ok=>{ a.addEventListener('loadedmetadata',()=>ok({duration:a.duration, readyState:a.readyState}));
        a.addEventListener('error',()=>ok({errorCode:a.error&&a.error.code, errorMsg:a.error&&a.error.message})); setTimeout(()=>ok({timeout:true}),10000); });
      const played=await new Promise(ok=>{ const t=setTimeout(()=>ok({timeout:true}),25000);
        a.addEventListener('ended',()=>{clearTimeout(t); ok({ended:true, currentTime:a.currentTime});});
        a.addEventListener('error',()=>{clearTimeout(t); ok({error:true});});
        a.volume=0.05; a.play().then(()=>{}).catch(e=>{clearTimeout(t); ok({playErr:e.name});}); });
      return {url:u.slice(0,46), rangeStatus:res.status, rangeLen:buf.byteLength,
        contentRange:res.headers.get('content-range'), acceptRanges:res.headers.get('accept-ranges'),
        contentType:res.headers.get('content-type'), acao:res.headers.get('access-control-allow-origin'),
        meta, played};})()`
    , null, 2)
  )
)

// 自动播放：干净状态
console.log(
  '[自动播放·配音优先]',
  JSON.stringify(
    await ev(`(async()=>{
      const i=document.querySelector('#app').__vue_app__._instance; const v=i.setupState.view;
      const dubKeys=new Set(v.dubbing.map(d=>d.key));
      let best=null;
      v.actions.forEach((a,idx)=>{ if(best) return; if(!dubKeys.has(a.type+'|'+a.chapterSeq+'|'+a.order)) return;
        const ci=v.chapters.findIndex(c=>c.chapterSeq===a.chapterSeq); if(ci<0) return;
        best={ci,off:idx-v.chapters[ci].start,ch:a.chapterSeq}; });
      if(!best) return {note:'该包无配音'};
      document.querySelectorAll('.chapter-pills .pill-btn')[best.ci].click();
      await new Promise(r=>setTimeout(r,300));
      const nextBtn=[...document.querySelectorAll('.stage-controls .btn')].find(b=>b.textContent.includes('下一句'));
      for(let k=0;k<best.off;k++){ nextBtn.click(); if(k%60===0) await new Promise(r=>setTimeout(r,10)); }
      await new Promise(r=>setTimeout(r,1200));
      document.querySelector('[data-testid=autoplay]').click();
      const t0=document.querySelector('.stage-toolbar .hint').innerText;
      let advanced=false,t1=t0,pace='';
      for(let k=0;k<40;k++){
        await new Promise(r=>setTimeout(r,500));
        t1=document.querySelector('.stage-toolbar .hint').innerText;
        pace=document.querySelector('.pace-chip')?.innerText||'';
        if(t1!==t0){ advanced=true; break; }
      }
      document.querySelector('[data-testid=autoplay]').click();
      return {clipCount:v.dubbing.length, clicks:best.off, hintBefore:t0, hintAfter:t1, advanced, pace};})()`
    , null, 2)
  )
)

// 暂停后不应再推进
const p1 = await ev(`document.querySelector('.stage-toolbar .hint').innerText`)
await sleep(2500)
const p2 = await ev(`document.querySelector('.stage-toolbar .hint').innerText`)
console.log('[暂停后静止]', JSON.stringify({ p1, p2, frozen: p1 === p2 }))

console.log('\n[运行期异常]', errs.length)
errs.forEach((e) => console.log('  ' + e))
ws.close()
