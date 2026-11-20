/* A catalog entry is a recording batch with one reference UTC table. */
const VideoCatalog = (() => {
    const node = id => document.getElementById(id);
    const cameras = ['cam0','cam1','cam2','cam3'];
    const segments = new Map();
    const checks = new Map();
    let paths = new Map(), offsets = new Map(), original = [];
    let folder = '', generation = 0, loading = false;
    const group = clip => clip.catalogGroup;
    const clips = () => frameVideos.filter(clip=>clip.sourceFile);
    const active = () => clips().length > 0;
    const bounds = clip => [clip.frames[0].t,clip.frames.at(-1).t];
    const filename = (clip,camera) => clip.sourceFile.replace(/_cam[0-3](?=\.[^.]+$)/i,'_'+camera);
    const key = (clip,camera) => filename(clip,camera).toLowerCase();
    const lookup = (clip,camera) => paths.get(key(clip,camera)) || [];
    const nsIso = ns => {
        const seconds = ns / 1000000000n;
        return new Date(Number(seconds)*1000).toISOString().slice(0,19)+'.'+
            String(ns % 1000000000n).padStart(9,'0')+'Z';
    };

    function replace(videos, settings) {
        original = videos.filter(video=>video.sourceFile);
        offsets = new Map(Object.entries(settings?.offsets || {}).filter(([,ms])=>
            Number.isSafeInteger(ms) && Math.abs(ms)<=86400000));
        folder = settings?.folder || '';
        paths = new Map(Object.entries(settings?.paths || {}).filter(([,items])=>
            Array.isArray(items) && items.every(path=>typeof path==='string')));
        checks.clear();
        generation++;
        node('catalogFolder').value = folder;
        node('catalogExportCamera').value = cameras.includes(settings?.camera) ? settings.camera : '';
        segments.clear();
        for (const clip of original) {
            clip.catalogGroup = JSON.stringify([clip.path,clip.camera,clip.segment]);
            if (!segments.has(group(clip))) segments.set(group(clip),[]);
            segments.get(group(clip)).push(clip);
        }
        for (const batch of segments.values()) batch.sort((a,b)=>a.position-b.position);
        return videos.map(correct);
    }

    function correct(clip) {
        if (!clip.sourceFile) return clip;
        const offset = offsets.get(group(clip)) || 0;
        const delta = BigInt(offset)*1000000n;
        const frames = offset ? clip.frames.map(frame=>{
            const ns = BigInt(frame.utcNs)+delta;
            return {...frame,t:Number(ns)/1e9,utc:nsIso(ns),utcNs:String(ns),
                originalUtc:frame.utc,offsetMs:offset};
        }) : clip.frames;
        return {...clip,frames};
    }

    function refreshOptions() {
        node('videoCatalog').hidden = !active();
        const select = node('catalogSegment');
        const previous = select.value;
        select.replaceChildren();
        for (const [id,batch] of segments) {
            const first = batch[0];
            select.add(new Option(`${first.path} · ${first.camera} 第 ${first.segment} 段`,id));
        }
        if (segments.has(previous)) select.value = previous;
        else if (select.options.length) select.selectedIndex = 0;
        showSegment();
    }

    function showSegment() {
        const id = node('catalogSegment').value;
        const batch = segments.get(id);
        if (!batch) return;
        const ms = offsets.get(id) || 0;
        const first = batch[0].frames[0];
        node('catalogOffset').value = ms;
        node('catalogStart').value = nsIso(BigInt(first.utcNs)+BigInt(ms)*1000000n);
        const sources = [...new Set(batch.map(clip=>clip.frames[0].assignment))];
        const before = clips().filter(clip=>group(clip)!==id && clip.camera===batch[0].camera &&
            clip.frames[0].t<first.t).sort((a,b)=>b.frames.at(-1).t-a.frames.at(-1).t)[0];
        const delta = before ? Number(BigInt(first.utcNs)+BigInt(ms)*1000000n-
            BigInt(before.frames.at(-1).utcNs))/1e9 : null;
        const gap = delta===null ? '' : ` · 與前段${delta<0?'重疊':'間隔'} ${Math.abs(delta).toFixed(3)} s`;
        const last = batch.at(-1).frames.at(-1);
        const end = nsIso(BigInt(last.utcNs)+BigInt(ms)*1000000n);
        node('catalogSegmentInfo').textContent = `原始首幀 ${first.utc} · 修正後末幀 ${end} · ${batch.length} 個批次 · ${sources.join(' / ')}${gap}`;
    }

    function applyOffset(ms) {
        const id = node('catalogSegment').value;
        if (!segments.has(id) || !Number.isSafeInteger(ms) || Math.abs(ms)>86400000)
            return alert('請輸入 ±86400000 範圍內的整數毫秒。');
        const originalById = new Map(original.map(clip=>[clip.id,clip]));
        const time = SharedTimeline.current();
        if (loading) return alert('請等待影片載入完成。');
        VideoPlayback.close();
        generation++;
        offsets.set(id,ms);
        frameVideos = frameVideos.map(clip=>{
            const source = originalById.get(clip.id);
            return source && group(source)===id ? {...clip,frames:correct(source).frames} : clip;
        });
        analysisRevision++;
        analysisCache = null;
        showSegment();
        fillVideos();
        SharedTimeline.seekUtc(time);
    }

    function indexPaths(entries) {
        paths = new Map();
        const wanted = new Set(clips().flatMap(clip=>cameras.map(camera=>key(clip,camera))));
        for (const path of entries) {
            const name = path.split('/').at(-1).toLowerCase();
            if (!wanted.has(name)) continue;
            if (!paths.has(name)) paths.set(name,[]);
            paths.get(name).push(path);
        }
        render(SharedTimeline.current(),true);
        SharedTimeline.update();
    }

    async function request(endpoint, body) {
        const response = await fetch('/api/'+endpoint,{method:'POST',headers:{'X-Track-Lab':globalThis.trackLabToken},
            body:JSON.stringify(body)});
        if (!response.ok) throw Error((await response.json()).error);
        return response;
    }

    async function scan() {
        const root = node('catalogFolder').value.trim();
        if (!root) return alert('請輸入影片資料夾相對於專案資料夾的路徑。');
        const token = ++generation;
        try {
            const projectRoot = node('projectRoot').value.trim();
            const {paths:entries} = await (await request('catalog-scan',{root:projectRoot,folder:root})).json();
            if (token !== generation) return;
            folder = root;
            checks.clear();
            indexPaths(entries);
        } catch (error) { if (token===generation) alert(error.message); }
    }

    async function open(clip,path,camera) {
        if (loading) return;
        loading = true;
        const token = generation;
        const time = SharedTimeline.current();
        try {
            if (!folder) throw Error('請重新選擇影片資料夾，或設定可還原的相對路徑。');
            const result = await (await request('catalog-open',{
                root:node('projectRoot').value.trim(),folder,path
            })).json();
            const file = {name:path.split('/').at(-1),size:result.size,lastModified:result.modified,serverId:result.id};
            if (token!==generation) return;
            await VideoPlayback.restoreProjectFile(file,{tableId:clip.id,first:clip.frames[0].frame,origin:0},result.url,time);
            if (token!==generation) return;
            node('catalogExportCamera').value = camera;
            const tableSelect = node('videoSelect');
            tableSelect.value = clip.id;
            tableSelect.onchange();
        } catch (error) { alert(error.message); }
        finally { loading = false; }
    }

    const checkKey = (clip,path) => JSON.stringify([clip.id,path]);

    async function verify(clip,path,button) {
        const token = generation;
        button.disabled = true;
        try {
            const {pts} = await (await request('catalog-probe',{
                root:node('projectRoot').value.trim(),folder,path
            })).json();
            if (token!==generation) return;
            const first = clip.frames[0].pts;
            const matches = pts.length===clip.frames.length &&
                clip.frames.every((frame,i)=>frame.frame===i &&
                    Math.abs((pts[i]-pts[0])-(frame.pts-first))<=0.001);
            checks.set(checkKey(clip,path),matches);
            render(SharedTimeline.current(),true);
        } catch(error) { if (token===generation) alert(error.message); }
        finally { button.disabled = false; }
    }

    let lastRender = '';
    function render(time,force=false) {
        if (!active()) { lastRender = ''; return; }
        const matches = clips().filter(clip=>{
            const [start,end] = bounds(clip);
            return start<=time && time<=end;
        });
        const signature = JSON.stringify([generation,matches.map(clip=>clip.id)]);
        if (!force && signature===lastRender) return;
        lastRender = signature;
        const list = node('catalogCandidates');
        list.replaceChildren();
        if (!matches.length) list.textContent = '目前游標沒有影片對照。';
        for (const clip of matches) {
            const row = document.createElement('div');
            row.append(document.createTextNode(clip.sourceFile+' '));
            for (const camera of cameras) {
                const candidates = lookup(clip,camera);
                const button = document.createElement('button');
                const checked = checks.get(checkKey(clip,candidates[0]));
                button.textContent = candidates.length===1
                    ? '載入 '+camera+(checked===true?'（PTS 相符）':checked===false?'（PTS 不符）':'（待核對）')
                    : camera+(candidates.length?' 有多個候選':' 缺檔');
                button.disabled = candidates.length!==1 || checked===false;
                button.onclick = ()=>open(clip,candidates[0],camera);
                row.append(button);
                if (candidates.length===1 && checked===undefined) {
                    const verifyButton = document.createElement('button');
                    verifyButton.textContent = '核對 '+camera;
                    verifyButton.onclick = ()=>verify(clip,candidates[0],verifyButton);
                    row.append(verifyButton);
                }
            }
            list.append(row);
        }
        const counts = clips().flatMap(clip=>cameras.map(camera=>lookup(clip,camera).length));
        node('catalogStatus').textContent = `${clips().length} 批 · ${counts.filter(n=>n===1).length} 個檔名配對 · ${counts.filter(n=>n===0).length} 缺檔 · ${counts.filter(n=>n>1).length} 多重候選`;
    }

    function exportVideo() {
        const clip = videoSelected();
        const camera = node('catalogExportCamera').value;
        if (!clip?.sourceFile || !cameras.includes(camera)) return null;
        const candidates = lookup(clip,camera);
        const verified = checks.get(checkKey(clip,candidates[0]));
        if (candidates.length>1 || verified===false) return null;
        const mediaFilename = candidates[0]?.split('/').at(-1) || filename(clip,camera);
        return {...clip,camera,mediaFilename,id:clip.id+':'+camera,
            timingLabel:camera===clip.camera?'原表時間':'沿用 '+clip.camera+' 對時'+(verified?'，相對 PTS 已核對':'，待逐幀核對')};
    }

    function setup() {
        node('catalogScan').onclick = scan;
        node('catalogSegment').onchange = showSegment;
        node('catalogApplyOffset').onclick = ()=>applyOffset(node('catalogOffset').valueAsNumber);
        node('catalogApplyStart').onclick = ()=>{
            try {
                const first = segments.get(node('catalogSegment').value)[0].frames[0];
                const delta = FusionCore.isoNs(node('catalogStart').value.trim())-BigInt(first.utcNs);
                applyOffset(Math.round(Number(delta)/1000000));
            } catch(error) { alert(error.message); }
        };

    }

    return {setup,replace,active,clips,bounds,refreshOptions,render,exportVideo,
        hasFile:clip=>cameras.some(camera=>lookup(clip,camera).length===1),
        settings:()=>({folder,paths:Object.fromEntries(paths),offsets:Object.fromEntries(offsets),camera:node('catalogExportCamera').value})};
})();
