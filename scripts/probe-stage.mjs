/** 快速探针：新演出引擎交互冒烟（不是最终验收脚本） */
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
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push(`EXC: ${m.params.exceptionDetails.text} | ${m.params.exceptionDetails.exception?.description?.slice(0, 240)}`)
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errs.push(`LOG: ${m.params.entry.text?.slice(0, 200)}`)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Page.bringToFront')
await sleep(600)

console.log('visibility:', await ev('document.visibilityState'))

// 1) 导入
console.log(
  '\n[导入]',
  JSON.stringify(
    await ev(`(async()=>{const r=await window.feather.importPackage(${JSON.stringify(P)});
      const i=document.querySelector('#app').__vue_app__._instance;
      i.setupState.summary=r.summary; i.setupState.view=null; i.setupState.viewError='';
      return {ok:r.ok,title:r.summary&&r.summary.project.title,verify:r.summary&&r.summary.verify};})()`)
  )
)

// 2) 打开设置面板（应出现新区块）——设置自批2起为独立标签页（tab='settings'）
await ev(`(()=>{const i=document.querySelector('#app').__vue_app__._instance; i.setupState.tab='settings'; return true})()`)
await sleep(500)
console.log(
  '[设置面板]',
  JSON.stringify(
    await ev(`(()=>({
      h2:[...document.querySelectorAll('.card h2')].map(h=>h.innerText),
      ttsTest:!!document.querySelector('[data-testid=tts-test]'),
      bgmPick:!!document.querySelector('[data-testid=bgm-pick]'),
      zoom:!!document.querySelector('[data-testid=stage-zoom]'),
      dialogMode:!!document.querySelector('[data-testid=dialog-mode]'),
      policy:!!document.querySelector('[data-testid=autoplay-policy]'),
      colors:[...document.querySelectorAll('[data-testid^=color-]')].map(c=>c.dataset.testid)}))()`)
  )
)

// 3) TTS 未配置 → 应返回可读错误且不发请求
console.log(
  '[TTS 未配置]',
  JSON.stringify(await ev(`(async()=>{const r=await window.feather.speak('测试一句话'); return {ok:r.ok,error:r.error};})()`))
)

// 4) 保存设置（dialogMode=transparent + zoom=1.3 + tts 策略）
console.log(
  '[保存设置]',
  JSON.stringify(
    await ev(`(async()=>{const r=await window.feather.saveSettings({dialogMode:'transparent',stageZoom:1.3,autoplayPolicy:'tts',ttsVoice:'中性旁白'});
      const s=await window.feather.getSettings();
      return {ok:r.ok, dialogMode:s.dialogMode, stageZoom:s.stageZoom, policy:s.autoplayPolicy, voiceVolume:s.voiceVolume, bgmVolume:s.bgmVolume, roleColors:s.roleColors};})()`)
  )
)
await ev(`(()=>{const i=document.querySelector('#app').__vue_app__._instance; i.setupState.tab='library'; return true})()`)
await sleep(400)

// 5) 演出视图
await ev(`(()=>{const i=document.querySelector('#app').__vue_app__._instance; i.setupState.tab='stage'; return true})()`)
console.log('ensureView:', await ev(`(async()=>{const i=document.querySelector('#app').__vue_app__._instance;
  if(i.setupState.view) return 'already'; const r=await window.feather.getView(); if(!r.ok) return 'fail:'+r.error;
  i.setupState.view=r.data; return 'loaded';})()`))
await sleep(1500)

console.log(
  '[舞台初始]',
  JSON.stringify(
    await ev(`(()=>{const tf=(s)=>{const e=document.querySelector(s);return e?getComputedStyle(e).transform:null};
      return {
      zoom:document.querySelector('[data-testid=stage]')?.dataset.zoom,
      uiScaleVar:document.querySelector('[data-testid=stage]')?.style.getPropertyValue('--ui-scale'),
      dialogTransform:tf('.stage-textbox'),
      portraitTransform:tf('[data-testid=stage-portrait]'),
      bgTransform:tf('.stage-bg'),
      dialogTestid:document.querySelector('[data-testid^=dialog-]')?.dataset.testid,
      dialogTransparent:!!document.querySelector('.dialog-transparent'),
      textLen:document.querySelector('[data-testid=stage-text]')?.textContent.length,
      caret:!!document.querySelector('.typing-caret'),
      chips:[...document.querySelectorAll('.stage-chips .chip')].map(c=>c.innerText),
      speaker:document.querySelector('.stage-textbox .speaker')?.textContent,
      speakerColor:document.querySelector('.stage-textbox .speaker')?.style.color,
      levelChip:[...document.querySelectorAll('.level-chip')].map(c=>c.innerText),
      dubbingChip:!!document.querySelector('[data-testid=chip-dubbing]')}})()`)
  )
)

// 6) 打字机推进：等 1.2s 看文本变长
const t1 = await ev(`document.querySelector('[data-testid=stage-text]')?.textContent.length`)
await sleep(1200)
const t2 = await ev(`document.querySelector('[data-testid=stage-text]')?.textContent.length`)
console.log('[打字机] len:', t1, '→', t2, '增长:', t2 > t1)

// 7) 点击舞台：先显全，再推进
await ev(`document.querySelector('[data-testid=stage]').click()`)
await sleep(300)
const afterFinish = await ev(`({len:document.querySelector('[data-testid=stage-text]')?.textContent.length, caret:!!document.querySelector('.typing-caret')})`)
console.log('[点击显全]', JSON.stringify(afterFinish))
const before = await ev(`document.querySelector('.stage-toolbar .hint').innerText`)
await ev(`document.querySelector('[data-testid=stage]').click()`)
await sleep(600)
const after = await ev(`document.querySelector('.stage-toolbar .hint').innerText`)
console.log('[点击推进]', JSON.stringify({ before, after, advanced: before !== after }))

// 8) 右键隐藏对话框
await ev(`document.querySelector('[data-testid=stage]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
await sleep(300)
console.log('[右键隐藏对话框] dialogVisible:', await ev(`!!document.querySelector('.stage-textbox')`))
await ev(`document.querySelector('[data-testid=stage]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
await sleep(300)
console.log('[右键恢复] dialogVisible:', await ev(`!!document.querySelector('.stage-textbox')`))

// 9) 缩放
const z0 = await ev(`document.querySelector('[data-testid=zoom-value]').innerText`)
await ev(`document.querySelector('[data-testid=zoom-in]').click()`)
await ev(`document.querySelector('[data-testid=zoom-in]').click()`)
const z1 = await ev(`document.querySelector('[data-testid=zoom-value]').innerText`)
await ev(`document.querySelector('[data-testid=zoom-out]').click()`)
const z2 = await ev(`document.querySelector('[data-testid=zoom-value]').innerText`)
await ev(`document.querySelector('[data-testid=zoom-reset]').click()`)
const z3 = await ev(`document.querySelector('[data-testid=zoom-value]').innerText`)
console.log('[缩放]', JSON.stringify({ z0, z1, z2, z3 }))

// 10) 立绘模态：找一个有立绘的角色
console.log(
  '[立绘模态]',
  JSON.stringify(
    await ev(`(async()=>{
      const i=document.querySelector('#app').__vue_app__._instance; const v=i.setupState.view;
      const withPortrait=v.characters.find(c=>c.imageUrl);
      if(!withPortrait) return {note:'无立绘角色'};
      const p=document.querySelector('[data-testid=stage-portrait]');
      if(!p) return {note:'当前句无立绘元素'};
      p.click(); await new Promise(r=>setTimeout(r,600));
      const modal=document.querySelector('[data-testid=portrait-modal]');
      const tabs=[...document.querySelectorAll('[data-testid^=pm-tab-]')].map(t=>t.innerText);
      const before={count:document.querySelector('[data-testid=pm-count]').innerText, src:document.querySelector('[data-testid=pm-image]')?.src.slice(0,40)};
      document.querySelector('[data-testid=pm-next]').click(); await new Promise(r=>setTimeout(r,400));
      const afterNext={count:document.querySelector('[data-testid=pm-count]').innerText, src:document.querySelector('[data-testid=pm-image]')?.src.slice(0,40)};
      const back=document.querySelector('[data-testid=pm-prev]').click();
      return {modal:!!modal, name:document.querySelector('[data-testid=pm-name]').innerText,
        level:document.querySelector('.pm-level')?.innerText, tabs, portraits:withPortrait.portraits.length,
        before, afterNext,
        meta:[...document.querySelectorAll('.pm-row')].map(r=>r.innerText.replace(/\\s+/g,' ')),
        kw:[...document.querySelectorAll('.pm-kw .chip')].length};})()`
    , null, 2)
  )
)
await ev(`document.querySelector('[data-testid=pm-close]')?.click()`)
await sleep(300)

// 11) 自动播放 + 配音（该包有 69 条配音）
console.log(
  '[自动播放·配音]',
  JSON.stringify(
    await ev(`(async()=>{
      const i=document.querySelector('#app').__vue_app__._instance;
      const sv=i.setupState.view;
      // 找第一条有配音的 narration
      let target=null;
      sv.actions.forEach((a,idx)=>{ if(target) return; const k=a.type+'|'+a.chapterSeq+'|'+a.order;
        if(sv.dubbing.some(d=>d.key===k)) target={idx,a}; });
      if(!target) return {note:'无配音'};
      const ch=sv.chapters.findIndex(c=>c.chapterSeq===target.a.chapterSeq);
      const pills=document.querySelectorAll('.chapter-pills .pill-btn'); pills[ch].click();
      await new Promise(r=>setTimeout(r,300));
      const nextBtn=[...document.querySelectorAll('.stage-controls .btn')].find(b=>b.textContent.includes('下一句'));
      const need=Math.min(target.idx-sv.chapters[ch].start, 1500);
      for(let k=0;k<need;k++){ nextBtn.click(); if(k%50===0) await new Promise(r=>setTimeout(r,10)); }
      await new Promise(r=>setTimeout(r,800));
      document.querySelector('[data-testid=autoplay]').click();
      const t0=document.querySelector('.stage-toolbar .hint').innerText;
      await new Promise(r=>setTimeout(r,2500));
      const t1b=document.querySelector('.stage-toolbar .hint').innerText;
      const pace=document.querySelector('.pace-chip')?.innerText;
      return {clipCount:sv.dubbing.length, clicks:need, hintBefore:t0, hintAfter:t1b, advanced:t0!==t1b, pace};})()`)
  )
)

// 12) SearchSelect
console.log(
  '[跳章搜索]',
  JSON.stringify(
    await ev(`(async()=>{
      document.querySelector('[data-testid=search-select-trigger]').click();
      await new Promise(r=>setTimeout(r,300));
      const panel=!!document.querySelector('[data-testid=search-select-panel]');
      const input=document.querySelector('[data-testid=search-select-input]');
      input.value='5'; input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,200));
      const items=[...document.querySelectorAll('[data-testid^=search-select-item-]')].map(e=>e.innerText.replace(/\\s+/g,' '));
      const first=document.querySelector('[data-testid^=search-select-item-]');
      if(first) first.click();
      await new Promise(r=>setTimeout(r,400));
      return {panel, filtered:items.slice(0,4), total:items.length,
        activeChapter:document.querySelector('.pill-btn.active')?.innerText,
        hint:document.querySelector('.stage-toolbar .hint').innerText};})()`
    , null, 2)
  )
)

console.log('\n[运行期异常]', errs.length)
errs.forEach((e) => console.log('  ' + e))
ws.close()
