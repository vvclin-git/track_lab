globalThis.FramePreview = (() => {
    const node = id => document.getElementById(id);
    let generation = null, imageUrl, shown, request = 0, database;
    const key = (clip, frame) => JSON.stringify([...clip.identity, frame.frame, frame.pts, frame.t]);
    const memory = new Map();

    function db() {
        return database ??= new Promise(resolve => {
            const open = indexedDB.open('track-lab-frame-previews', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('jpg');
            open.onsuccess = () => resolve(open.result);
            open.onerror = open.onblocked = () => resolve(null);
        }).catch(() => null);
    }

    async function cached(id, blob) {
        if (!blob && memory.has(id)) return memory.get(id);
        const store = await db();
        if (store) {
            const result = await new Promise(resolve => {
                const tx = store.transaction('jpg', blob ? 'readwrite' : 'readonly');
                const op = blob ? tx.objectStore('jpg').put(blob,id) : tx.objectStore('jpg').get(id);
                tx.oncomplete = () => resolve(blob ? true : op.result);
                tx.onerror = tx.onabort = () => resolve(null);
            }).catch(() => null);
            if (result) return result;
        }
        if (blob) {
            if (memory.size >= 1200) memory.delete(memory.keys().next().value);
            memory.set(id,blob);
        }
        return null;
    }

    function hide() {
        request++;
        shown = null;
        const panel = node('framePreview');
        if (!panel) return;
        if (document.fullscreenElement === panel) document.exitFullscreen().catch(()=>{});
        panel.hidden = true;
        node('previewImage').removeAttribute('src');
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = null;
    }

    async function show(time) {
        hide();
        const token = request;
        const clip = VideoPlayback.previewSource();
        const frame = clip?.frameAt(time);
        if (!frame) { SharedTimeline.seekUtc(time); return; }
        SharedTimeline.seekUtc(time, {syncVideo:false});
        const local = globalThis.trackLabToken && await LocalFFmpeg.image(
            clip,frame,node('previewTolerance').valueAsNumber*1000).catch(()=>null);
        const blob = globalThis.trackLabToken ? local?.blob : await cached(key(clip,frame));
        if (token !== request || VideoPlayback.previewSource()?.binding !== clip.binding) return;
        if (!blob) { SharedTimeline.seekUtc(time); return; }
        shown = frame;
        imageUrl = URL.createObjectURL(blob);
        node('previewImage').src = imageUrl;
        let caption = `${clip.name} · 目標 frame ${frame.frame} · ${frame.utc}`;
        if (local) {
            const ms = (Math.abs(local.deltaUs)/1000).toFixed(3);
            caption += Math.abs(local.deltaUs) <= 1000 ? ' · 吻合'
                : ` · 近似 · ${local.deltaUs < 0 ? '早' : '晚'} ${ms} ms`;
        }
        node('previewCaption').textContent = caption;
        node('framePreview').hidden = false;
    }

    function mediaState(video) {
        return {
            currentTime:video.currentTime, duration:video.duration,
            readyState:video.readyState, networkState:video.networkState,
            seeking:video.seeking, paused:video.paused, pageVisibility:document.visibilityState,
            mediaError:video.error ? {code:video.error.code,message:video.error.message} : null
        };
    }

    function capture(video, clip, frame, signal) {
        return new Promise((resolve,reject) => {
            const target = clip.mediaTime(frame);
            const frames = clip.binding.table.frames;
            const next = frames[FusionCore.lower(frames,frame.pts,row=>row.pts)+1];
            const inset = Math.min(.002,next ? (next.pts-frame.pts)/4 : .002);
            let observed = null, observedMediaTime = null, callbacks = 0;
            const started = performance.now();
            const seekTime = Math.min(target+inset,video.duration-.000001);
            const done = (error, blob) => {
                clearTimeout(timeout);
                video.cancelVideoFrameCallback(callback);
                signal.removeEventListener('abort',cancel);
                video.removeEventListener('error',mediaError);
                if (error) {
                    error.details = {frame:frame.frame,utc:frame.utc,expectedPts:frame.pts,
                        receivedPts:observed,receivedMediaTime:observedMediaTime,seekTime,callbacks,
                        elapsedMs:Math.round(performance.now()-started),...mediaState(video)};
                    reject(error);
                } else resolve(blob);
            };
            const cancel = () => done(new Error('已停止'));
            const mediaError = () => done(new Error('瀏覽器回報影片錯誤'));
            const timeout = setTimeout(() => done(new Error(observed === null
                ? `frame ${frame.frame} 解碼逾時`
                : `frame ${frame.frame} 未核對成功（收到 PTS ${observed.toFixed(6)} 秒）`)),30000);
            let callback;
            const observe = () => {
                callback = video.requestVideoFrameCallback((_, metadata) => {
                    callbacks++;
                    observedMediaTime = metadata.mediaTime;
                    observed = clip.binding.first.pts + metadata.mediaTime - clip.binding.mediaOrigin;
                    const actual = matchMediaFrame(frames,observed);
                    if (actual !== frame) { observe(); return; }
                    const canvas = document.createElement('canvas');
                    const scale = Math.min(1, 640 / Math.max(video.videoWidth,video.videoHeight));
                    canvas.width = Math.max(1,Math.round(video.videoWidth*scale));
                    canvas.height = Math.max(1,Math.round(video.videoHeight*scale));
                    canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
                    canvas.toBlob(blob => done(blob ? null : new Error('無法產生 JPG'),blob),'image/jpeg',.82);
                });
            };
            signal.addEventListener('abort',cancel,{once:true});
            video.addEventListener('error',mediaError,{once:true});
            try {
                observe();
                video.currentTime = seekTime;
            } catch (error) { done(error); }
        });
    }

    async function build() {
        const label = node('previewStatus');
        if (generation) { generation.abort(); return; }
        const clip = VideoPlayback.previewSource();
        if (!clip) { label.textContent = '請先載入影片並套用 frame–UTC 配對表。'; return; }
        const frames = [...new Set(AnalysisTools.pointTimes(5).map(clip.frameAt).filter(Boolean))];
        if (!frames.length) { label.textContent = '目前工作區沒有對應影片的航跡點。'; return; }
        const controller = generation = new AbortController();
        if (globalThis.trackLabToken) {
            const button = node('buildPreviews');
            const log = node('previewLog');
            const tolerance = node('previewTolerance');
            if (!tolerance.checkValidity()) {
                label.textContent = '請在影片設定輸入 1–250 ms 的整數。';
                generation = null;
                return;
            }
            tolerance.disabled = true;
            button.textContent = '停止建立預覽';
            log.value = '';
            try {
                await LocalFFmpeg.build(clip,frames,tolerance.valueAsNumber*1000,controller.signal,(message,details)=>{
                    label.textContent = message;
                    if (details) log.value = JSON.stringify(details,null,2);
                });
            } catch (error) {
                label.textContent = controller.signal.aborted ? '已停止' : error.message;
                log.value += '\n'+error.message;
            } finally {
                generation = null;
                tolerance.disabled = false;
                button.textContent = '建立航跡預覽';
            }
            return;
        }
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.className = 'previewDecoder';
        document.body.append(video);
        const url = URL.createObjectURL(clip.file);
        const button = node('buildPreviews');
        button.textContent = '停止建立預覽';
        const log = node('previewLog');
        const entries = [{video:clip.name, bytes:clip.file.size,
            table:clip.binding.table.label || clip.binding.table.id,
            firstFrame:clip.binding.first.frame, mediaOrigin:clip.binding.mediaOrigin,
            workspaceUtc:SharedTimeline.bounds().map(t=>new Date(t*1000).toISOString()),
            requestedFrames:frames.length, browser:navigator.userAgent}];
        const record = entry => {
            entries.push(entry);
            log.value = entries.map(item=>JSON.stringify(item)).join('\n');
        };
        log.value = JSON.stringify(entries[0]);
        let count = 0, temporary = 0, reused = 0, failed = 0, lastFailure = '';
        try {
            await new Promise((resolve,reject) => {
                const timer = setTimeout(()=>finish(new Error('影片讀取逾時')),15000);
                const cancel = () => finish(new Error('已停止'));
                const finish = error => {
                    clearTimeout(timer);
                    controller.signal.removeEventListener('abort',cancel);
                    video.onloadeddata = video.onerror = null;
                    if (error) reject(error); else resolve();
                };
                controller.signal.addEventListener('abort',cancel,{once:true});
                video.onloadeddata = () => finish();
                video.onerror = () => finish(new Error('無法讀取本機影片'));
                video.src = url;
            });
            for (const frame of frames) {
                if (controller.signal.aborted) break;
                label.textContent = `影格預覽 ${count + failed} / ${frames.length} · 完成 ${count} · 重用 ${reused} · 失敗 ${failed}`;
                const id = key(clip,frame);
                if (!(await cached(id))) {
                    if (controller.signal.aborted) break;
                    try {
                        const blob = await capture(video,clip,frame,controller.signal);
                        if (!(await cached(id,blob))) temporary++;
                    } catch (error) {
                        if (controller.signal.aborted) break;
                        failed++;
                        lastFailure = error.message;
                        record({stage:'capture',message:error.message,...error.details});
                        continue;
                    }
                } else reused++;
                count++;
            }
            label.textContent = `${controller.signal.aborted ? '已停止' : failed ? '已完成，部分影格略過' : '預覽就緒'} · ${count} / ${frames.length} 張 · 重用 ${reused}${temporary ? '（部分僅暫存本次）' : ''}${failed ? ` · 失敗 ${failed} 張 · ${lastFailure}` : ''}`;
        } catch (error) {
            label.textContent = `預覽 ${count} / ${frames.length} 張 · ${error.message}`;
            record({stage:controller.signal.aborted ? 'cancelled' : 'load',message:error.message,...mediaState(video)});
        } finally {
            record({stage:'summary',completed:count,failed,temporary,stopped:controller.signal.aborted});
            video.removeAttribute('src');
            video.load();
            video.remove();
            URL.revokeObjectURL(url);
            generation = null;
            button.textContent = '建立航跡預覽';
        }
    }

    function openVideo() {
        const frame = shown;
        hide();
        if (frame) VideoPlayback.seek(frame);
        return Boolean(frame);
    }

    function setup() {
        node('buildPreviews').onclick = build;
        if (globalThis.trackLabToken) {
            const tolerance = node('previewTolerance');
            node('previewToleranceSetting').hidden = false;
            const saved = Number(localStorage.getItem('trackLab.previewToleranceMs'));
            if (Number.isInteger(saved) && saved >= 1 && saved <= 250) tolerance.value = saved;
            tolerance.onchange = () => {
                if (!tolerance.reportValidity()) return;
                localStorage.setItem('trackLab.previewToleranceMs',tolerance.value);
                hide();
                node('previewStatus').textContent = '已更新容許誤差，可重新建立航跡預覽。';
            };
        }
        node('copyPreviewLog').onclick = async () => {
            const log = node('previewLog');
            try {
                await navigator.clipboard.writeText(log.value);
                node('previewLogStatus').textContent = '已複製';
            } catch {
                log.focus();
                log.select();
                node('previewLogStatus').textContent = '請按 Ctrl+C 複製';
            }
        };
        node('previewFullscreen').onclick = () => {
            node('framePreview').requestFullscreen().catch(() => {
                node('previewStatus').textContent = '瀏覽器無法開啟預覽全螢幕。';
            });
        };
        node('previewOpenVideo').onclick = openVideo;
    }

    return {setup,show,hide,openVideo,reset:()=>{generation?.abort();hide();}};
})();
