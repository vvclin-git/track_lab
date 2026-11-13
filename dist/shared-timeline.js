/* A single UTC timeline controls sensor replay and a paired local video. */
const SharedTimeline = (() => {
    let dragging = false;
    let coverageKey;
    const node = id => document.getElementById(id);
    function fullBounds() {
        const starts = [], ends = [];
        if (data.length) {
            starts.push(Date.parse(data[0].utc) / 1000);
            ends.push(Date.parse(data.at(-1).utc) / 1000);
        }
        const videos = VideoCatalog.active() ? VideoCatalog.clips() : [videoSelected()];
        for (const video of videos) if (video?.frames.length) {
            starts.push(video.frames[0].t);
            ends.push(video.frames.at(-1).t);
        }
        return starts.length ? [Math.min(...starts), Math.max(...ends)] : [0, 1];
    }
    function bounds() { return AnalysisTools.bounds(fullBounds()); }
    function current() {
        return cursorTime ?? (data[index] ? Date.parse(data[index].utc) / 1000 : bounds()[0]);
    }
    function update() {
        const [start, end] = bounds();
        const seek = node('seek');
        seek.max = Math.max(0.001, end - start);
        if (!dragging) seek.value = current() - start;
        const band = node('videoCoverage');
        const loaded = VideoPlayback.coverage();
        node('returnVideoOverview').hidden = !loaded;
        const intervals = loaded ? [[...loaded,true]] : VideoCatalog.active()
            ? VideoCatalog.clips().map(clip=>[...VideoCatalog.bounds(clip),VideoCatalog.hasFile(clip)])
            : [];
        const key = JSON.stringify([start,end,intervals]);
        if (key !== coverageKey) {
            coverageKey = key;
            band.replaceChildren();
            const length = Math.max(0.001,end-start);
            for (const [a,b,matched] of intervals) {
                if (a>end || b<start) continue;
                const span = document.createElement('span');
                span.dataset.matched = matched;
                span.style.left = ((Math.max(a,start)-start)/length*100)+'%';
                span.style.width = ((Math.min(b,end)-Math.max(a,start))/length*100)+'%';
                band.append(span);
            }
            band.hidden = !band.childElementCount;
        }
        VideoCatalog.render(current());
        AnalysisTools.refreshVideoTrack();
        const workspace = AnalysisTools.workspace();
        node('timelineStart').textContent = (workspace?.[0]===start?'工作區起點 · ':'')+timeLabel(start);
        node('timelineEnd').textContent = (workspace?.[1]===end?'工作區終點 · ':'')+timeLabel(end);
    }
    function seekUtc(time, {syncVideo = true} = {}) {
        if (!data.length) return;
        const [start,end] = bounds();
        time = Math.max(start,Math.min(end,time));
        playing = false;
        node('play').textContent = '▶ 播放';
        if (syncVideo) {
            if (VideoPlayback.seekUtc(time)) return;
        } else VideoPlayback.pauseForPreview();
        cursorTime = time;
        index = Math.max(0, FusionCore.lower(data, time, row => Date.parse(row.utc) / 1000));
        acc = 0;
        render();
    }
    function timeAtFraction(fraction) {
        const [start, end] = bounds();
        return start + Math.max(0, Math.min(1, fraction)) * (end - start);
    }
    function setup() {
        const seek = node('seek');
        seek.onpointerdown = () => {
            dragging = true;
            playing = false;
            VideoPlayback.beginMapSeek();
        };
        seek.oninput = () => {
            dragging = true;
            playing = false;
            VideoPlayback.beginMapSeek();
            const time = bounds()[0] + Number(seek.value);
            node('timelinePreview').textContent = '預覽 ' + new Date(time * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', hour12:false});
        };
        seek.onchange = () => {
            const time = bounds()[0] + Number(seek.value);
            dragging = false;
            node('timelinePreview').textContent = '';
            seekUtc(time);
        };
        seek.onpointercancel = () => {
            dragging = false;
            node('timelinePreview').textContent = '';
            VideoPlayback.endMapSeek();
            update();
        };
        node('toggleVideo').onclick = () => {
            const hidden = document.querySelector('.workspace').classList.toggle('video-hidden');
            if (hidden) node('localVideo').pause();
            node('toggleVideo').textContent = hidden ? '展開影片' : '收合影片';
            node('toggleVideo').setAttribute('aria-expanded', String(!hidden));
            requestAnimationFrame(() => {
                map?.invalidateSize();
                if (data.length) render();
            });
        };
        node('toggleSettings').onclick = () => {
            const hidden = document.querySelector('main').classList.toggle('settings-hidden');
            node('toggleSettings').textContent = hidden ? '展開設定' : '收合設定';
            node('toggleSettings').setAttribute('aria-expanded', String(!hidden));
            requestAnimationFrame(() => {
                map?.invalidateSize();
                if (data.length) render();
            });
        };
        node('openVideoSettings').onclick = () => node('videoSettings').showModal();
        node('closeVideoSettings').onclick = () => node('videoSettings').close();
        node('videoBindingSelect').onchange = event => {
            node('videoSelect').value = event.target.value;
            node('videoSelect').dispatchEvent(new Event('change'));
        };
        update();
    }
    return {setup, update, bounds, fullBounds, current, seekUtc, timeAtFraction};
})();
