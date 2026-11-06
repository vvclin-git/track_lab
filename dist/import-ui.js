/* File chooser, validation preview and portable project settings. */
let importWorker=null,importRows=[],importBusy=false,importSeq=0,pendingSettings=null;
const importFiles = new Map();
let autoRestore = null, lastProjectRoot = '', restoreRequest = null;
const missingInputs = project => project.files.filter(f=>!importRows.some(r=>
    r.status==='ok' && r.name===f.name && r.size===f.size && (!f.fingerprint||r.fingerprint===f.fingerprint)));

const projectIds=['source','radius','age','exclude','cameraOffset','fov','fovRange','follow','compare','showFov','showSun','showWind','chartMode','sampleStep','ownGap','headingSource','windSource','nmeaOffset','aisOffset'];
function info(msg){document.getElementById('importStatus').textContent=msg}
function makeWorker(){if(importWorker)return importWorker;importWorker=new Worker('import-worker.js?v=10');importWorker.onmessage=e=>{let m=e.data;if(m.type==='progress')info(m.text);if(m.type==='parsed'){importRows.push(...m.results);for(const r of m.results)if(r.status!=='ok')importFiles.delete(r.id);setBusy(false);previewImports();info('解析完成。請核對檔案範圍與時間設定，再建立回放。');if(autoRestore&&!missingInputs(autoRestore.project).length){
    if(importRows.some(r=>r.type==='nmea'&&r.status==='ok'))buildImported();
    else if(autoRestore.project.kind==='demo'){
        setBusy(true);
        makeWorker().postMessage({action:'frames'});
    }
}else if(autoRestore)info('請補齊上方列出的檔案，再建立回放。'+autoRestore.errors.join('；'))}if(m.type==='frames'){setBusy(false);setFusionData(m.videos);if(autoRestore)finishAutoRestore();else document.getElementById('importDialog').close()}if(m.type==='built'){setBusy(false);rawPositions=m.positions;setFusionData(m.videos,m.positions);applyReplay(m.data,{kind:'import',files:importRows.filter(r=>r.status==='ok').map(({name,size,fingerprint})=>({name,size,fingerprint})),meta:m.meta,sources:m.sources,settings:m.settings,aisReports:m.aisReports,nmeaFiles:importRows.filter(r=>r.status==='ok'&&r.type==='nmea').map(r=>importFiles.get(r.id)).filter(Boolean)});AnalysisTools.restore(pendingSettings?.ais);render();if(autoRestore)finishAutoRestore(true);else{document.getElementById('importDialog').close();info('資料已套用')}}if(m.type==='error'){autoRestore=null;setBusy(false);info('無法建立：'+m.message)}if(m.type==='removed')previewImports()};importWorker.onerror=e=>{autoRestore=null;setBusy(false);info('解析程序錯誤：'+e.message)};return importWorker}
function setBusy(v){importBusy=v;for(let id of ['attachFrames','addFiles','addFolder','buildReplay','clearFiles','loadSettings','saveSettings','demoData'])document.getElementById(id).disabled=v;document.getElementById('cancelParse').hidden=!v;document.getElementById('skipBad').disabled=v}
function addFiles(files,paths){if(importBusy||!files.length)return;let list=[...files].filter(f=>/\.(csv|txt|json)$/i.test(f.name));if(!list.length){info('請選取 NMEA CSV、AIS TXT、frame–UTC CSV 或 time_model.json。ZIP 請先解壓縮；專案 JSON 請用「載入專案設定」。');return}setBusy(true);info('正在辨識與解析，原始資料只在此瀏覽器讀取…');const ids=list.map(f=>{const id=String(++importSeq);importFiles.set(id,f);return id});makeWorker().postMessage({action:'parse',files:list,ids,paths})}
function timeLabel(t){return Number.isFinite(t)?new Date(t*1000).toLocaleString('sv-SE',{timeZone:'Asia/Taipei'}):'—'}
function el(tag,text,cls){let e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e}
function previewImports(){let box=document.getElementById('filePreview');box.replaceChildren();let table=el('table');let head=el('tr');for(let t of ['檔案／類型','臺灣時間範圍','解析狀態','操作'])head.append(el('th',t));table.append(head);
 for(let r of importRows){let row=el('tr'),name=el('td'),range=el('td'),state=el('td'),act=el('td');name.append(el('strong',r.name),el('div',`${r.type==='nmea'?'NMEA':r.type==='ais'?'AIS':r.type==='frames'?'frame–UTC':r.type==='model'?'時間模型':'未納入'} · ${(r.size/1048576).toFixed(2)} MB`,'note'));range.textContent=r.start!==undefined?`${timeLabel(r.start)} ～ ${timeLabel(r.end)}`:'—';state.append(el('div',r.status==='ok'?`可用 ${r.valid.toLocaleString()} 筆紀錄`:(r.note||r.status)));if(r.rows)state.append(el('div',`共 ${r.rows.toLocaleString()} 列；錯誤 ${r.errors}；倒退 ${r.backward}；>5秒間隔 ${r.largeGaps}`,'note'));if(r.sources?.length)state.append(el('div','來源：'+r.sources.join(' / '),'note'));if(r.pgns?.length){let detail=el('details'),sum=el('summary','PGN／錯誤明細');detail.append(sum,el('div','PGN：'+r.pgns.join(', '),'note'));for(let msg of r.samples||[])detail.append(el('div',msg,'note'));state.append(detail)}else for(let msg of r.samples||[])state.append(el('div',msg,'note'));let b=el('button','移除');b.onclick=()=>{if(importBusy)return;importRows=importRows.filter(x=>x.id!==r.id);importFiles.delete(r.id);makeWorker().postMessage({action:'remove',id:r.id});previewImports()};act.append(b);row.append(name,range,state,act);table.append(row)}box.append(table);
 let n=importRows.filter(r=>r.status==='ok'&&r.type==='nmea'),a=importRows.filter(r=>r.status==='ok'&&r.type==='ais'),overlap=0;for(let x of n)for(let y of a)overlap+=Math.max(0,Math.min(x.end,y.end)-Math.max(x.start,y.start));document.getElementById('importSummary').textContent=`可用 NMEA ${n.length} 份／AIS ${a.length} 份／frame–UTC ${importRows.filter(r=>r.status==='ok'&&r.type==='frames').length} 份。${a.length?(overlap>0?'時間範圍有重疊；實際目標仍受資料年齡與缺口限制。':'目前 NMEA 與 AIS 沒有重疊，地圖可顯示本船，AIS 將無有效目標。'):'沒有 AIS 時仍可建立本船航跡。'} 同時間重複紀錄合併；內容衝突採先匯入檔案，會列出筆數。`;
 if(pendingSettings){const missing=missingInputs(pendingSettings);$('settingsHint').textContent=missing.length?'尚未符合的檔案：'+missing.map(f=>f.name).join('、'):'原始資料檔案全部符合。'}
}
function numeric(id,min,max){let v=document.getElementById(id).value,n=Number(v);if(v.trim()===''||!Number.isFinite(n)||n<min||n>max)throw Error(id+' 的數值不在允許範圍');return n}
function buildImported(){if(importBusy)return;try{if(!importRows.some(r=>r.status==='ok'&&r.type==='nmea'))throw Error('至少需要一份可用 NMEA');if(importRows.some(r=>r.status==='ok'&&r.errors>0)&&!document.getElementById('skipBad').checked)throw Error('有錯誤列，請移除檔案或勾選允許跳過錯誤列');let settings={source:document.getElementById('source').value,step:numeric('sampleStep',1,60),ownGap:numeric('ownGap',.01,60),headingSource:String(numeric('headingSource',0,255)),windSource:String(numeric('windSource',0,255)),nmeaOffset:numeric('nmeaOffset',-86400,86400),aisOffset:numeric('aisOffset',-86400,86400)};if(!Number.isInteger(Number(settings.headingSource))||!Number.isInteger(Number(settings.windSource)))throw Error('來源位址需為整數');setBusy(true);info('正在合併與建立回放快照…');makeWorker().postMessage({action:'build',settings})}catch(e){autoRestore=null;info(e.message)}}
function applyReplay(next,project){VideoPlayback.unbind();if(!Array.isArray(next)||!next.length)throw Error('回放沒有資料');playing=false;lastTick=0;acc=0;index=0;selected='';data=next;activeProject=project;AnalysisTools.reset(project.nmeaFiles,project.aisReports);cursorTime=null;if(project.kind==='demo'){rawPositions=Object.fromEntries(Object.keys(next[0].sources).map(src=>[src,next.map(s=>[Date.parse(s.utc)/1000,s.sources[src]?.position||null])]));frameVideos=[];selectedVideo='';fillVideos()}analysisRevision++;analysisCache=null;$('seek').max=data.length-1;$('seek').value=0;let select=$('source'),current=select.value,sources=project.sources||Object.keys(data[0].sources);select.replaceChildren();for(let src of sources){let opt=document.createElement('option');opt.value=src;opt.textContent='來源 '+src;select.append(opt)}select.value=sources.includes(current)?current:(sources.includes('4')?'4':sources[0]);$('play').textContent='▶ 播放';$('rangeLabel').textContent='尚未選取區間';$('datasetLabel').textContent=project.kind==='import'?`已匯入 ${project.files.length} 份檔案 · ${timeLabel(project.meta.start)} ～ ${timeLabel(project.meta.end)} · 每 ${project.meta.step} 秒回放`:'2026.10.21 內建範例 · 本船定位 × AIS';$('dataNote').textContent=project.kind==='import'?`本機解析。每 ${project.meta.step} 秒快照，共 ${data.length} 筆；可查看距離≤5 km且年齡≤30秒的AIS。重複紀錄 ${project.meta.duplicates} 筆，衝突 ${project.meta.conflicts} 筆。${project.meta.truncated?'部分時間目標超過500筆，僅保留較近目標。':''}`:'內建資料約每秒一筆，距離上限5 km／AIS年齡30秒。';if(map){rebuildTrack();markers.clearLayers();connection.clearLayers();if(track.getBounds().isValid())map.fitBounds(track.getBounds().pad(.2))}else initMap();render()}
async function captureSettings(){
    const controls=Object.fromEntries(projectIds.map(id=>[id,$(id).type==='checkbox'?$(id).checked:$(id).value]));
    const source=importRows.some(r=>r.status==='ok')?importRows.filter(r=>r.status==='ok'):activeProject.files||[];
    const relativePath=name=>name.includes('/')?name.slice(name.indexOf('/')+1):name;
    const files=source.map(({name,size,fingerprint})=>({name,size,fingerprint,path:relativePath(name)}));
    const media=VideoPlayback.projectFile();
    const root=$('projectRoot').value.trim();
    let video;
    if(media&&root){
        const {file,...binding}=media;
        video={...binding,name:file.name,path:$('projectVideoPath').value.trim()||file.name,
            size:file.size,fingerprint:await fingerprint(file)};
    }
    return {format:'track-lab-project',version:3,fusion:fusionSettings(),created:new Date().toISOString(),
        timezone:'Asia/Taipei',kind:activeProject.kind,files,controls,root,video,
        ais:AnalysisTools.settings(),skipBad:$('skipBad').checked};
}

async function downloadSettings(){
    setBusy(true);
    info('正在記錄專案與檔案指紋…');
    try {
        const settings=await captureSettings();
        const a=document.createElement('a');
        const url=URL.createObjectURL(new Blob([JSON.stringify(settings,null,2)],{type:'application/json'}));
        a.href=url;
        a.download='track_lab_project.json';
        a.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
        info(settings.root?'專案設定已下載。':'專案設定已下載。填入本機專案資料夾可啟用自動載入。');
    } catch(e) { info('無法儲存專案：'+e.message); }
    finally { setBusy(false); }
}

async function readProjectFile(root, entry,signal){
    if(typeof entry.path!=='string'||typeof entry.fingerprint!=='string')throw Error('缺少檔案位置或指紋');
    const response=await fetch('/api/project-file',{method:'POST',signal,headers:{'X-Track-Lab':globalThis.trackLabToken},
        body:JSON.stringify({root,path:entry.path,size:entry.size,fingerprint:entry.fingerprint})});
    if(!response.ok)throw Error((await response.json()).error);
    return new File([await response.blob()],entry.name.split('/').at(-1));
}

async function finishAutoRestore(built=false){
    const {project,errors,video}=autoRestore;
    autoRestore=null;
    setBusy(true);
    try {
        if(video&&(built||project.kind==='demo')){
            try {
                $('projectVideoPath').value=project.video.path;
                await VideoPlayback.restoreProjectFile(video,project.video);
            } catch(e) { errors.push(project.video.name+'：'+e.message); }
        }
        if(errors.length){
            $('importDialog').showModal();
            info('以下檔案需重新指定：'+errors.join('；'));
        } else if(built||project.kind==='demo'){
            $('importDialog').close();
            info('已自動載入專案資料。');
        } else info('請補齊上方列出的檔案，再建立回放。');
    } finally { setBusy(false); }
}

async function restoreProjectInputs(project,root){
    const request=restoreRequest=new AbortController();
    setBusy(true);
    info('正在核對並載入本機專案檔案…');
    const files=[],paths=[],errors=[];
    let video;
    try {
        for(const entry of project.files){
            try { files.push(await readProjectFile(root,entry,request.signal)); paths.push(entry.name); }
            catch(e) { if(request.signal.aborted)return; errors.push(entry.name+'：'+e.message); }
        }
        if(project.video){
            try { video=await readProjectFile(root,project.video,request.signal); }
            catch(e) { if(request.signal.aborted)return; errors.push(project.video.name+'：'+e.message); }
        }
    } finally { if(restoreRequest===request){restoreRequest=null;setBusy(false);} }
    autoRestore={project,errors,video};
    if(files.length)addFiles(files,paths);
    else await finishAutoRestore();
}

async function loadSettings(file){try{if(file.size>1048576)throw Error('設定檔超過1 MB');let v=JSON.parse(await file.text());if(v.format!=='track-lab-project'||![1,2,3].includes(v.version)||!v.controls||!Array.isArray(v.files))throw Error('不支援的專案設定格式／版本');validateFusionSettings(v.fusion);for(let id of projectIds){let val=v.controls[id],e=document.getElementById(id);if(val===undefined)continue;if(e.type==='checkbox'){if(typeof val!=='boolean')throw Error('設定型別錯誤：'+id)}else if(typeof val!=='string'||val.length>100)throw Error('設定型別錯誤：'+id)}if(v.files.some(f=>typeof f.name!=='string'||!Number.isFinite(f.size)))throw Error('檔案清單格式不符');for(let id of projectIds){let val=v.controls[id],e=document.getElementById(id);if(val===undefined)continue;if(e.type==='checkbox')e.checked=val;else if(e.tagName==='SELECT'&&!Array.from(e.options).some(o=>o.value===val)){if(id==='source'){let o=document.createElement('option');o.value=val;o.textContent='來源 '+val;e.append(o);e.value=val}}else e.value=val}importWorker?.terminate();importWorker=null;importRows=[];importFiles.clear();autoRestore=null;
pendingSettings=v;$('skipBad').checked=v.skipBad===true;
const typedRoot=$('projectRoot').value.trim();
const rootOverride=typedRoot!==lastProjectRoot?typedRoot:'';
const root=(typeof v.root==='string'&&v.root)||rootOverride;
$('projectRoot').value=lastProjectRoot=rootOverride||root;
restoreFusionSettings(v.fusion);AnalysisTools.restore(v.ais);previewImports();if(data.length){rebuildTrack();render()}if(v.version===3&&root&&globalThis.trackLabToken){
    await restoreProjectInputs(v,rootOverride||root);

}else info('專案設定已載入；請選取相符原始檔案後建立回放。')}catch(e){info('設定載入失敗：'+e.message)}}
function setupImportUI(){let dialog=document.getElementById('importDialog');$('openImport').onclick=()=>{dialog.showModal();previewImports()};$('closeImport').onclick=()=>dialog.close();$('addFiles').onclick=()=>$('rawFiles').click();$('addFolder').onclick=()=>$('rawFolder').click();for(let id of ['rawFiles','rawFolder'])$(id).onchange=e=>{addFiles(e.target.files);e.target.value=''};$('buildReplay').onclick=buildImported;$('attachFrames').onclick=()=>{if(!importRows.some(r=>r.status==='ok'&&r.type==='frames')){info('請先匯入至少一份可用 frame–UTC CSV。');return}if(importRows.some(r=>r.type==='frames'&&r.errors)&&!$('skipBad').checked){info('配對表有錯誤列，請核對或勾選允許跳過。');return}setBusy(true);makeWorker().postMessage({action:'frames'})};$('clearFiles').onclick=()=>{importRows=[];importFiles.clear();pendingSettings=autoRestore=null;makeWorker().postMessage({action:'clear'});$('settingsHint').textContent='';previewImports();info('待匯入清單已清空，目前地圖保留不變。')};$('cancelParse').onclick=()=>{restoreRequest?.abort();restoreRequest=null;importWorker?.terminate();importWorker=null;autoRestore=null;importRows=[];importFiles.clear();setBusy(false);previewImports();info('已停止解析並清空候選資料，原地圖保留不變。')};$('saveSettings').onclick=downloadSettings;$('loadSettings').onclick=()=>$('settingsFile').click();$('settingsFile').onchange=e=>{if(e.target.files[0])loadSettings(e.target.files[0]);e.target.value=''};$('demoData').onclick=async()=>{try{let r=await fetch('data.json?v=4');if(!r.ok)throw Error('範例讀取失敗');applyReplay(await r.json(),{kind:'demo'});dialog.close()}catch(e){info(e.message)}};previewImports()}
