const LocalFFmpeg = (() => {
    let file, videoId;
    const token = {'X-Track-Lab':globalThis.trackLabToken};
    const timestamp = (clip,frame) => Math.round(clip.mediaTime(frame)*1e6);

    async function call(path, body, signal) {
        const response = await fetch('/api/'+path,{
            method:body === undefined ? 'GET' : 'POST',
            headers:token, body:body instanceof Blob ? body : JSON.stringify(body), signal
        });
        if (response.ok) return response;
        const detail = await response.json().catch(()=>null);
        throw Error(detail?.error || '本機服務錯誤 '+response.status);
    }

    async function image(clip,frame,toleranceUs) {
        if (!globalThis.trackLabToken || file !== clip.file || !videoId) return null;
        const target = timestamp(clip,frame);
        const response = await fetch(`/api/image/${videoId}/${toleranceUs}/${target}`,{headers:token});
        if (!response.ok) return null;
        return {blob:await response.blob(), deltaUs:Number(response.headers.get('X-Preview-PTS-Us'))-target};
    }

    async function register(clip,signal) {
        if (file === clip.file && videoId) return videoId;
        const result = await (await call('video',clip.file,signal)).json();
        file = clip.file;
        videoId = result.id;
        return result.id;
    }

    async function build(clip,frames,toleranceUs,signal,report) {
        report('正在把影片交給本機服務…');
        const video = await register(clip,signal);
        if (signal.aborted) return;
        const targets = [...new Set(frames.map(frame=>timestamp(clip,frame)))];
        const {id} = await (await call('jobs',{video,targets,toleranceUs})).json();
        const cancel = () => call('cancel',{id}).catch(()=>{});
        signal.addEventListener('abort',cancel,{once:true});
        if (signal.aborted) cancel();
        try {
            while (true) {
                const job = await (await call('jobs/'+id)).json();
                const approximate = Object.entries(job.matches || {}).filter(([target,actual])=>Math.abs(actual-Number(target))>1000).length;
                report(job.done ? (job.stop ? '已停止' : '預覽完成')+
                    ` · 重用 ${job.reused || 0} · 近似 ${approximate} · 缺少 ${job.failed?.length || 0}`
                    : `FFmpeg 已解出 ${job.decodedCandidates || 0} 格候選 · 重用 ${job.reused || 0}`,job);
                if (job.done) {
                    if (job.error) throw Error(job.error);
                    if (!job.stop && job.diagnostics?.exitCode) throw Error('FFmpeg 回傳錯誤，請查看預覽除錯。');
                    return;
                }
                await new Promise(resolve=>setTimeout(resolve,400));
            }
        } finally { signal.removeEventListener('abort',cancel); }
    }
    return {build,image,register};
})();
