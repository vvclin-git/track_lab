/* Parsing and geodesic fusion stay in a browser-local worker. */
self.window=self;
importScripts('vendor/geographiclib-geodesic.min.js','fusion-core.js?v=10','import-core.js?v=9','file-fingerprint.js');
let entries=[];
function videos(){return entries.filter(e=>e.type==='frames').flatMap(e=>{if(e.clips)return [...e.clips.values()].map(clip=>({...clip,id:e.fingerprint+':'+clip.sourceFile,path:e.name,label:clip.sourceFile,errors:e.errors}));let folder=e.name.replace(/[^/]+$/,''),model=entries.filter(x=>x.type==='frames'&&x.name.replace(/[^/]+$/,'')===folder).length===1&&entries.find(m=>m.type==='model'&&m.name.replace(/[^/]+$/,'')===folder)?.model;return {id:e.fingerprint,path:e.name,...FusionCore.identity(e.name,e.frames),frames:e.frames,model:model||null,errors:e.errors}})}
async function readFile(file,id,path){let name=path||file.webkitRelativePath||file.name,fp=await fingerprint(file);if(entries.some(e=>e.fingerprint===fp))return {id,name,size:file.size,status:'duplicate',note:'相同內容指紋，未重複加入'};
 if(/^(anchors|candidates|ocr_results)\.csv$/i.test(file.name)||/^(summary|decoder_settings)\.json$/i.test(file.name))return {id,name,size:file.size,status:'excluded',note:'輔助輸出，無須匯入；影格資訊以 frame_utc.csv 為準'};
 if(/\.json$/i.test(file.name)){if(file.size>1048576)throw Error('模型 JSON 超過1 MB');let model=JSON.parse(await file.text());if(model.schema_version!==1||!['offset','affine'].includes(model.model_type)||!Number.isFinite(model.slope)||model.slope<=0||!Number.isFinite(model.reference_pts_ns)||!Number.isFinite(model.reference_utc_ns))throw Error('只支援 schema_version=1 的 time_model.json；專案設定請用「載入專案設定」');let summary={id,name,size:file.size,type:'model',fingerprint:fp,status:'ok',valid:1,errors:0,note:'時間模型（同資料夾配對）'};entries.push({...summary,model});return summary}
 let reader=file.stream().getReader(),decoder=new TextDecoder(),pending='',type=null,streams=new Map(),frames=[],clips=null,fields=null,count=0,errors=0,samples=[],min=null,max=null,last=null,backward=0,largeGaps=0,maxGap=0,pgs=new Set(),sources=new Set(),valid=0,ignored=0;
 function line(s){s=s.trim();if(!s)return;count++;if(!type){const header=FusionCore.csvLine(s.replace(/^\uFEFF/,''));
 if(['camera','segment','position','source_file','source_frame','pts_time_s','utc_iso','utc_unix_ns','time_source'].every(key=>header.includes(key))){
   if(new Set(header).size!==header.length)throw Error('總表表頭重複');
   clips=new Map();fields=header;type='frames';return;
 }
 type=ImportCore.detect(s);if(!type&&s.includes('frame_number')){fields=FusionCore.frameHeader(s);type='frames';return}if(!type)throw Error('無法辨識格式；支援 NMEA CSV、AIS TXT 與 frame–UTC CSV');if(type==='ahrs')throw Error('這是 AHRS CSV，姿態功能尚未支援')}
 try{if(type==='frames'){let sequence=frames,f;
 if(clips){
   const values=FusionCore.csvLine(s);
   if(values.length!==fields.length)throw Error('總表欄數不符');
   const row=Object.fromEntries(fields.map((key,i)=>[key,values[i]]));
   const {camera,segment,source_file:sourceFile,position}=row;
   if(!/^cam[0-3]$/i.test(camera)||!segment||!/^\d+$/.test(position)||
      !new RegExp('_'+camera+'\\.[^.]+$','i').test(sourceFile)||/[\\/]/.test(sourceFile))throw Error('總表影片識別無效');
   f=FusionCore.frameRow([row.source_frame,row.pts_time_s,row.utc_iso,row.utc_unix_ns,row.time_source,sourceFile].map(FusionCore.csvCell).join(','),['frame_number','pts_time_s','utc_estimated','utc_unix_ns','utc_assignment','filename']);
   let clip=clips.get(sourceFile);
   if(!clip){
     clip={camera,segment,position:Number(position),sourceFile,frames:[]};
     clips.set(sourceFile,clip);
   }
   if(clip.camera!==camera||clip.segment!==segment||clip.position!==Number(position)){
     const error=Error('同一影片的分段或順序不一致');error.fatal=true;throw error;
   }
   sequence=clip.frames;
 }else f=FusionCore.frameRow(s,fields);
 let p=sequence.at(-1);if(p&&(f.frame<=p.frame||f.pts<=p.pts||f.t<=p.t)){let error=Error('frame、PTS 與 UTC 必須嚴格遞增，不可重複或倒退');error.fatal=true;throw error}sequence.push(f);min=min===null?f.t:Math.min(min,f.t);max=max===null?f.t:Math.max(max,f.t);valid++;return}
 let r=ImportCore.parseLine(s,type);if(r.header||r.empty)return;if(r.t!==undefined){min=min===null?r.t:Math.min(min,r.t);max=max===null?r.t:Math.max(max,r.t);if(last!==null){let gap=r.t-last;if(gap<0)backward++;if(gap>5){largeGaps++;maxGap=Math.max(maxGap,gap)}}last=r.t}if(r.p){pgs.add(r.p);sources.add(r.src)}if(r.skip){ignored++;return}if(r.key&&(r.value||r.p===129025)){if(!streams.has(r.key))streams.set(r.key,[]);streams.get(r.key).push([r.t,r.value]);valid++}else ignored++;
 }catch(e){if(e.fatal)throw Error(`第 ${count} 列：${e.message}（整份配對表未納入）`);errors++;if(samples.length<5)samples.push(`第 ${count} 列：${e.message}`)}}
 try{while(true){let {value,done}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});let parts=pending.split('\n');pending=parts.pop();for(let s of parts)line(s);if(count%1000<200)postMessage({type:'progress',text:`${file.name}：已讀 ${count.toLocaleString()} 列`})}pending+=decoder.decode();if(pending)line(pending)}finally{reader.releaseLock()}
 if(min===null)throw Error('檔案沒有有效時間資料');let summary={id,name,size:file.size,type,rows:count,valid,errors,samples,start:min,end:max,backward,largeGaps,maxGap,sources:[...sources],pgns:[...pgs],ignored,fingerprint:fp,status:valid?'ok':'empty',note:valid?'':'無本版支援的工程量'};if(valid)entries.push({...summary,...(type==='frames'?{frames,clips}:{streams:[...streams]})});return summary;
}
self.onmessage=async e=>{try{if(e.data.action==='parse'){if(e.data.reset)entries=[];let results=[];for(let i=0;i<e.data.files.length;i++){let f=e.data.files[i],id=e.data.ids[i];try{results.push(await readFile(f,id,e.data.paths?.[i]))}catch(err){results.push({id,name:f.webkitRelativePath||f.name,size:f.size,status:'error',note:err.message})}}postMessage({type:'parsed',results})}else if(e.data.action==='remove'){entries=entries.filter(x=>x.id!==e.data.id);postMessage({type:'removed'})}else if(e.data.action==='frames'){postMessage({type:'frames',videos:videos()})}else if(e.data.action==='build'){let r=ImportCore.build(entries,e.data.settings);postMessage({type:'built',...r,videos:videos(),settings:e.data.settings})}else if(e.data.action==='clear'){entries=[];postMessage({type:'cleared'})}}catch(err){postMessage({type:'error',message:err.message})}};
