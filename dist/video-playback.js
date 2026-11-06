/* Synchronize the map from compositor timestamps on the local media timeline. */
function matchMediaFrame(frames, pts) {
    const before = FusionCore.lower(frames, pts, frame => frame.pts);
    const left = frames[before];
    const right = frames[before + 1];
    const index = !left ? 0 : right && right.pts - pts < pts - left.pts ? before + 1 : before;
    const frame = frames[index];
    if (!frame) return null;
    const previousGap = index ? frame.pts - frames[index - 1].pts : Infinity;
    const nextGap = frames[index + 1] ? frames[index + 1].pts - frame.pts : Infinity;
    const tolerance = Math.min(0.001, previousGap / 3, nextGap / 3);
    return Math.abs(frame.pts - pts) <= tolerance ? frame : null;
}

const VideoPlayback = (() => {
    let media, url, file, binding, confirmed, pending, timer, callback, lastMap = -Infinity, dragging = false, mapDragging = false, outside = false;
    const node = id => document.getElementById(id);
    const status = message => { node('mediaStatus').textContent = message; };
    const clearPending = () => { clearTimeout(timer); pending = null; };
    const active = () => Boolean(binding && binding.table === videoSelected());
    const toMedia = frame => binding.mediaOrigin + frame.pts - binding.first.pts;
    const inClip = frame => toMedia(frame) >= binding.mediaOrigin - 1e-6 && toMedia(frame) < media.duration;
    function showFrame(frame, force = false) {
        if (!AnalysisTools.inside(frame.t)) { media.pause(); return; }
        const now = performance.now();
        if (!force && now - lastMap < 125) return;
        lastMap = now;
        moveReplayToFrame(frame);
        node('play').textContent = media.paused ? '▶ 播放' : 'Ⅱ 暫停';
    }
    function observe() {
        if (callback != null || !url || !media.requestVideoFrameCallback) return;
        callback = media.requestVideoFrameCallback((_, metadata) => {
            callback = null;
            observe();
            if (!active() || outside) return;
            const pts = binding.first.pts + metadata.mediaTime - binding.mediaOrigin;
            const frame = matchMediaFrame(binding.table.frames, pts);
            if (pending && frame !== pending.frame && media.seeking) return;
            if (!frame || !inClip(frame)) {
                confirmed = null;
                if (!pending) status('目前畫面的 PTS 在配對表中找不到對應影格。');
                return;
            }
            confirmed = frame;
            const requested = pending;
            clearPending();
            if (requested && requested.frame !== frame) {
                status(`要求 frame ${requested.frame.frame}，實際呈現 frame ${frame.frame}`);
            } else {
                const elapsed = requested ? ` · 跳轉 ${Math.round(performance.now() - requested.start)} ms` : '';
                status(`畫面 frame ${frame.frame} · ${frame.utc}${elapsed}`);
            }
            showFrame(frame, Boolean(requested) || media.paused);
        });
    }
    function unbind() {
        if (!media) return;
        globalThis.FramePreview?.reset();
        media.pause();
        binding = confirmed = null;
        outside = false;
        mapDragging = false;
        clearPending();
        if (url) status('選擇對應的 frame–UTC 表，確認片段起點後套用。');
    }
    function open(nextFile) {
        unbind();
        file = nextFile;
        if (callback != null) media.cancelVideoFrameCallback(callback);
        callback = null;
        if (url) URL.revokeObjectURL(url);
        url = file ? URL.createObjectURL(file) : null;
        node('mediaName').textContent = file?.name || '本機影片';
        node('videoUnavailable').hidden = Boolean(url);
        if (node('loadVideoEmpty')) node('loadVideoEmpty').hidden = Boolean(url);
        if (!url) {
            media.removeAttribute('src');
            media.load();
            status('選擇本機影片開始播放。');
            return;
        }
        media.src = url;
        status('正在讀取影片資訊…');
        observe();
    }
    function seek(frame) {
        if (!AnalysisTools.inside(frame.t)) return false;
        if (!active()) return false;
        if (!inClip(frame)) {
            status(`frame ${frame.frame} 超出本機片段範圍。`);
            return true;
        }
        globalThis.FramePreview?.hide();
        outside = false;
        node('videoUnavailable').hidden = true;
        media.pause();
        if (!media.seeking && confirmed === frame && !pending) {
            showFrame(frame, true);
            status(`畫面 frame ${frame.frame} · ${frame.utc}`);
            return true;
        }
        clearPending();
        pending = {frame, start: performance.now()};
        status(`正在定位 frame ${frame.frame}…`);
        const next = binding.table.frames[FusionCore.lower(binding.table.frames, frame.pts, row => row.pts) + 1];
        const inset = Math.min(0.002, next ? (next.pts - frame.pts) / 4 : 0.002);
        media.currentTime = Math.min(toMedia(frame) + inset, media.duration - 0.000001);
        timer = setTimeout(() => {
            clearPending();
            confirmed = null;
            status(`定位 frame ${frame.frame} 逾時，尚未核對畫面。`);
        }, 15000);
        return true;
    }
    function seekUtc(time) {
        mapDragging = false;
        globalThis.FramePreview?.hide();
        if (!active()) return false;
        const frame = FusionCore.nearestFrame(binding.table.frames, time);
        if (frame && inClip(frame) && seek(frame)) return true;
        outside = true;
        clearPending();
        confirmed = null;
        media.pause();
        node('videoUnavailable').hidden = false;
        node('videoUnavailable').textContent = '此時間沒有對應的本機影片畫面';
        status('所選 UTC 超出影片涵蓋範圍，地圖依所選時間更新。');
        return false;
    }
    function coverage() {
        if (!active()) return null;
        const frames = binding.table.frames;
        const lastPts = binding.first.pts + media.duration - binding.mediaOrigin;
        const last = frames[FusionCore.lower(frames, lastPts - 0.000001, frame => frame.pts)];
        return last ? [binding.first.t, last.t] : null;
    }
    function fillTables() {
        const select = node('videoBindingSelect');
        if (!select) return;
        select.replaceChildren(new Option('請選擇已匯入的配對表', ''));
        for (const video of frameVideos) select.append(new Option(video.label, video.id));
        select.value = selectedVideo;
    }
    function setRate(rate) {
        media.playbackRate = Number(rate);
        node('mediaRate').value = String(rate);
    }
    function step(direction) {
        if (!active() || pending || !confirmed) return;
        const frames = binding.table.frames;
        const current = FusionCore.lower(frames, confirmed.pts, row => row.pts);
        const next = frames[current + direction];
        if (next) seek(next);
    }
    function toggle() {
        if (globalThis.FramePreview?.openVideo()) return;
        if (!url || media.readyState < 1) return;
        if (media.paused) {
            clearPending();
            media.play().catch(() => status('影片無法播放，請確認檔案與瀏覽器支援的編碼。'));
        } else media.pause();
    }
    function bind() {
        const table = videoSelected();
        const firstText = node('mediaFirst').value.trim();
        const originText = node('mediaOrigin').value.trim();
        const first = table?.frames.find(frame => frame.frame === Number(firstText));
        const mediaOrigin = Number(originText);
        if (!url || !Number.isFinite(media.duration) || !table || !firstText || !first ||
            !originText || !Number.isFinite(mediaOrigin) || mediaOrigin < 0 || mediaOrigin >= media.duration) {
            status('請載入影片、選擇配對表，並輸入有效的片段起始 frame 與播放器秒數。');
            return;
        }
        if (!media.requestVideoFrameCallback) {
            status('此瀏覽器可播放影片，但無法核對呈現畫面的時間戳。');
            return;
        }
        unbind();
        binding = {table, first, mediaOrigin};
        node('speed').value = String(media.playbackRate);
        node('videoSettings').close?.();
        const start = table.frames.find(frame => AnalysisTools.inside(frame.t) && inClip(frame));
        if (start) seekUtc(start.t);
    }
    function setup() {
        media = node('localVideo');
        if (node('loadVideoEmpty')) node('loadVideoEmpty').onclick = () => node('openVideoSettings').click();
        node('mediaFile').onchange = event => { open(event.target.files[0]); event.target.value = ''; };
        node('mediaClose').onclick = () => open(null);
        node('mediaBind').onclick = bind;
        node('mediaPlay').onclick = toggle;
        node('mediaPrev').onclick = () => step(-1);
        node('mediaNext').onclick = () => step(1);
        node('mediaRate').onchange = event => { setRate(event.target.value); };
        media.onratechange = () => {
            node('mediaRate').value = String(media.playbackRate);
            if (active()) node('speed').value = String(media.playbackRate);
        };
        node('mediaFullscreen').onclick = () => {
            media.requestFullscreen?.().catch(() => status('瀏覽器無法開啟全螢幕。'));
        };
        media.onloadedmetadata = () => {
            status('影片已載入。可直接播放，或套用 frame–UTC 表以同步地圖。');
        };
        media.onerror = () => { unbind(); status('影片無法讀取，請確認檔案與瀏覽器支援的編碼。'); };
        media.onplay = () => {
            if (active()) {
                playing = false;
                node('play').textContent = '▶ 播放';
            }
            node('mediaPlay').textContent = '暫停影片';
            observe();
        };
        media.onpause = () => {
            node('mediaPlay').textContent = '播放影片';
            if (active() && confirmed && !pending && !outside) showFrame(confirmed, true);
        };
    }

    function beginMapSeek() {
        if (!active()) return;
        mapDragging = true;
        media.pause();
    }
    function previewSource() {
        if (!active() || !file) return null;
        const bound = binding;
        const duration = media.duration;
        const mediaTime = frame => bound.mediaOrigin + frame.pts - bound.first.pts;
        const limits = coverage();
        return {binding:bound,file,name:file.name,mediaTime,
            identity:[file.name,file.size,file.lastModified,bound.table.id,bound.first.frame,bound.mediaOrigin],
            frameAt(time) {
                if (!limits || time < limits[0] || time > limits[1]) return null;
                const frame = FusionCore.nearestFrame(bound.table.frames,time);
                return frame && mediaTime(frame) < duration ? frame : null;
            }};
    }

    function pauseForPreview() {
        outside = true;
        clearPending();
        media.pause();
    }

    return {
        setup, active, unbind, seek, seekUtc, toggle, beginMapSeek,
        coverage, fillTables, setRate, previewSource, pauseForPreview,
        filename: id => active() && binding.table.id === id ? node('mediaName').textContent : '',
        endMapSeek: () => { mapDragging = false; },
        isMapDragging: () => mapDragging
    };
})();
