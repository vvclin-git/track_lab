/* A single UTC timeline controls sensor replay and a paired local video. */
const SharedTimeline = (() => {
    let dragging = false;
    const node = id => document.getElementById(id);
    function fullBounds() {
        const starts = [], ends = [];
        if (data.length) {
            starts.push(Date.parse(data[0].utc) / 1000);
            ends.push(Date.parse(data.at(-1).utc) / 1000);
        }
        const video = videoSelected();
        if (video?.frames.length) {
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
        const clip = VideoPlayback.coverage();
        const coverage = clip && clip[0]<=end && clip[1]>=start ? [Math.max(start,clip[0]),Math.min(end,clip[1])] : null;
        const band = node('videoCoverage');
        band.hidden = !coverage;
        if (coverage) {
            const length = Math.max(0.001, end - start);
            band.style.left = Math.max(0, (coverage[0] - start) / length * 100) + '%';
            band.style.width = Math.max(0, (coverage[1] - coverage[0]) / length * 100) + '%';
        }
        node('timelineStart').textContent = timeLabel(start);
        node('timelineEnd').textContent = timeLabel(end);
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
