/* Workspace display and analysis exports use independent UTC ranges. */
const AnalysisTools = (() => {
    let workspace = null, locked = '', pointLayer, rawFiles = [], ais = {};
    const utc = s => s.replayTime ?? Date.parse(s.utc) / 1000;
    const inside = t => !workspace || t >= workspace[0] && t <= workspace[1];
    const bounds = full => workspace || full;
    const samples = () => workspace ? data.filter(s => inside(utc(s))) : data;
    const range = () => $('chartMode').value === 'pinDistance'
        ? [pinRangeStart, pinRangeEnd] : [begin, end];
    const valid = ([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a <= b;

    function download(content, name) {
        const url = URL.createObjectURL(new Blob(content, {type:'text/csv;charset=utf-8'}));
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function refreshWorkspace() {
        $('workspaceLabel').textContent = workspace
            ? workspace.map(timeLabel).join(' ～ ') : '全程';
        rebuildTrack();
        SharedTimeline.seekUtc(Math.max(SharedTimeline.bounds()[0],
            Math.min(SharedTimeline.bounds()[1], SharedTimeline.current())));
    }

    function drawExportRange(g, x, top, bottom, domainStart, domainEnd) {
        const [start, end] = range();
        g.save();
        if (valid([start,end]) && start <= domainEnd && end >= domainStart) {
            const left = x(Math.max(start, domainStart));
            const right = x(Math.min(end, domainEnd));
            g.fillStyle = '#4167bd18';
            g.fillRect(left, top, right-left, bottom-top);
        }
        for (const [time, label, color] of [[start,'起點','#2458a6'],[end,'終點','#8537a2']]) {
            if (!Number.isFinite(time) || time < domainStart || time > domainEnd) continue;
            const px = x(time);
            g.strokeStyle = g.fillStyle = color;
            g.lineWidth = 1;
            g.setLineDash([3,2]);
            g.beginPath();
            g.moveTo(px,top);
            g.lineTo(px,bottom);
            g.stroke();
            g.font = '11px system-ui';
            const leftAligned = label === '終點' && x(domainEnd)-px >= 30;
            g.textAlign = leftAligned ? 'left' : 'right';
            g.fillText(label,px + (leftAligned ? 3 : -3),top+(label === '起點' ? 10 : 21));
        }
        g.restore();
    }

    function pointTimes(step) {
        const [start,end] = SharedTimeline.bounds();
        const rows = framePositionRows();
        const times = [];
        for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
            if (FusionCore.position(rows,t,analysisGap())) times.push(t);
        }
        return times;
    }

    function points() {
        if (!map) return;
        if (!pointLayer) {
            pointLayer = L.layerGroup().addTo(map);
            map.on('zoomend', points);
        }
        pointLayer.clearLayers();
        for (const id of ['previousTrackPoint','nextTrackPoint']) $(id).disabled = !$('trackPoints').checked;
        if (!$('trackPoints').checked) return;
        const [start, end] = SharedTimeline.bounds();
        const defaultStep = 5;
        const pointBudget = map.getZoom() >= 17 ? 10000 : 1200;
        const step = defaultStep * Math.max(1, Math.ceil((end - start) / (pointBudget * defaultStep)));
        for (const t of pointTimes(step)) {
            const p = FusionCore.position(framePositionRows(), t, analysisGap());
            const marker = L.circleMarker([p.lat,p.lon], {
                radius:3, weight:1, color:'#087d77', fillOpacity:.65, bubblingMouseEvents:false
            }).addTo(pointLayer);
            marker.bindTooltip(timeLabel(t));
            marker.on('click', () => addingPin ? (createPin(p.lat,p.lon),setAddingPin(false)) : FramePreview.show(t));
        }
    }

    function report(mmsi, t) {
        const rows = ais[mmsi];
        const i = rows ? FusionCore.lower(rows,t,row=>row[0]) : -1;
        if (i < 0) return null;
        let j = i;
        while (j >= 0 && rows[j][1].invalid) j--;
        if (j < 0) return null;
        const [time, value] = rows[j];
        return {time, value, stale:j !== i || t - time > Number($('age').value)};
    }

    function target(mmsi, s) {
        const t = utc(s), r = report(mmsi,t) || (locked === mmsi ? demoReport(mmsi,t) : null), p = ownAt(s);
        if (!r && ais[mmsi]) return null;
        if (!r) return targetsAt(s).find(x=>x[0]===mmsi && visible(x)) || null;
        const d = r.value;
        const held = r.stale && locked === mmsi && $('holdAis').checked &&
            inside(t);
        if (!p || r.stale && !held) return null;
        const row = [mmsi,d.name,d.lat,d.lon,FusionCore.distance(p,d),t-r.time,d.sog,d.cog,d.heading,r.time,held];
        return locked === mmsi || visible(row) ? row : null;
    }

    function renderLock(s) {
        $('lockAis').disabled = !selected && !locked;
        $('lockAis').textContent = locked ? '解除鎖定 ' + locked : '鎖定所選船隻';
        $('holdAisLabel').hidden = !locked;
        const r = locked && report(locked,utc(s));
        const fallback = locked && !r ? demoReport(locked,utc(s)) : null;
        const last = r || fallback;
        $('lockedAisInfo').textContent = locked ? (last
            ? `${last.value.name || locked} · 最後回報 ${timeLabel(last.time)} · ${(utc(s)-last.time).toFixed(1)} 秒前`
            : locked + ' · 此刻之前無位置回報') : '';
        if (!last || !map) return;
        L.circleMarker([last.value.lat,last.value.lon], {
            radius:8,color:'#713b9e',weight:2,fillOpacity:last.stale?.2:.65
        }).addTo(markers).bindTooltip('鎖定 AIS · '+locked).on('click',()=>choose(locked));
    }

    function demoReport(mmsi,t) {
        for (let i=FusionCore.lower(data,t,utc);i>=0;i--) {
            const row = data[i].targets.find(x=>x[0]===mmsi);
            if (row) return {time:utc(data[i])-row[5],value:{name:row[1],lat:row[2],lon:row[3],sog:row[6],cog:row[7],heading:row[8]},stale:t-(utc(data[i])-row[5])>Number($('age').value)};
        }
        return null;
    }

    function clips(a,b) {
        return frameVideos.filter(v => v.frames.some(f => f.t >= a && f.t <= b));
    }

    function videoName(v,f) {
        return FusionCore.videoFilename({...v,mediaFilename:VideoPlayback.filename?.(v.id)},f);
    }

    function exportAis() {
        const [a,b] = range(), mmsi = locked || selected;
        if (!mmsi || !valid([a,b])) return alert('請先選取 AIS 目標，並設定有效的匯出起點與終點。');
        const rows = [['sample_or_frame','utc','mmsi','distance_m','ais_age_s','own_source','own_sog_kn','own_cog_true_deg','heading_true_deg','wind_speed_ms','wind_from_true_deg','target_sog_kn','target_cog_true_deg','sun_azimuth_deg','sun_altitude_deg','camera_relative_heading_deg','horizontal_fov_deg','utc_assignment','video_filename','frame_utc_file','video_id','frame_number','frame_utc','ais_report_utc','ais_position_status']];
        const add = (s,v,f) => {
            const t = target(mmsi,s);
            const fields = t ? exportRow(s,t) : [s.frame??'',s.utc,mmsi,...Array(14).fill(''),s.quality?.assignment];
            if (f) fields[17] = f.assignment;
            rows.push([...fields,v ? videoName(v,f) : '',v?.path,v?.id,f?.frame,f?.utc,
                t ? new Date((t[9]??utc(s)-t[5])*1000).toISOString() : '',
                t ? t[10] ? 'held' : 'within_age_limit' : 'missing']);
        };
        const videos = clips(a,b);
        for (const v of videos) for (const f of v.frames) {
            if (f.t >= a && f.t <= b) add({...currentReplaySample(f.t),utc:f.utc,frame:f.frame,replayTime:f.t},v,f);
        }
        if (!videos.length) for (const s of data) if (utc(s)>=a && utc(s)<=b) add(s);
        if (rows.length === 1) return alert('所選區間內沒有可匯出的時間點。');
        download(['\ufeff',rows.map(r=>r.map(FusionCore.csvCell).join(',')).join('\r\n')],'selected_target_interval.csv');
    }

    const nmeaRange = () => $('nmeaExportRange').value === 'workspace'
        ? SharedTimeline.bounds() : range();
    const duration = (a,b) => `${Math.floor((b-a)/60)} 分 ${((b-a)%60).toFixed(3)} 秒`;
    function updateNmeaExport() {
        const selection = nmeaRange();
        $('nmeaExportSummary').textContent = valid(selection)
            ? selection.map(timeLabel).join(' ～ ') + '（臺灣時間，' + duration(...selection) + '）'
            : '請先在圖表設定有效的匯出起點與終點。';
        $('exportNmea').disabled = !rawFiles.length || !valid(selection);
    }

    async function exportNmea() {
        const [a,b] = nmeaRange();
        if (!valid([a,b])) return alert('請先設定有效的匯出起點與終點。');
        if (!rawFiles.length) return alert('請先匯入原始 NMEA 並建立回放。');
        const files = rawFiles;
        const offset = activeProject.settings?.nmeaOffset || 0;
        const status = $('nmeaExportStatus');
        $('exportNmea').disabled = $('nmeaExportRange').disabled = true;
        status.textContent = '正在讀取原始 NMEA…';
        try {
            const parts = [];
            let header = '', count = 0;
            for (const file of files) {
                const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
                let pending = '';
                const addLine = line => {
                    const clean = line.trim();
                    const fields = clean.split(',');
                    if (fields.length !== 4) return;
                    if (/^(time|timestamp|epoch)/i.test(fields[0])) { header ||= clean; return; }
                    const t = Number(fields[0]) + offset;
                    if (!fields[0] || t<a || t>b || !Number.isFinite(t)) return;
                    parts.push(line.replace(/\r$/,'')+'\r\n');
                    count++;
                };
                try {
                    while (true) {
                        const {value,done} = await reader.read();
                        if (done) break;
                        const lines = (pending+value).split('\n');
                        pending = lines.pop();
                        lines.forEach(addLine);
                    }
                    addLine(pending);
                } finally { reader.releaseLock(); }
            }
            if (!count) return status.textContent = '所選區間沒有 NMEA 紀錄。';
            if (header) parts.unshift(header+'\r\n');
            download(parts,'nmea_interval.csv');
            status.textContent = `已匯出 ${count.toLocaleString()} 筆紀錄。`;
        } catch (e) {
            status.textContent = 'NMEA 匯出失敗：'+e.message;
        } finally { $('nmeaExportRange').disabled = false; updateNmeaExport(); }
    }

    function reset(files = [], reports = {}) {
        workspace = null;
        locked = '';
        rawFiles = files;
        ais = reports;
        $('holdAis').checked = false;
        $('workspaceLabel').textContent = '全程';
    }

    function setup() {
        const local = t => new Date((t+28800)*1000).toISOString().slice(0,23).replace('T',' ');
        const read = id => {
            const value = $(id).value.trim();
            return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)
                ? Date.parse(value.replace(' ','T')+'+08:00')/1000 : NaN;
        };
        const workspaceInputs = () => [read('workspaceStart'),read('workspaceEnd')];
        const showDuration = () => {
            const times = workspaceInputs();
            $('workspaceDuration').textContent = valid(times) ? duration(...times) : '請輸入有效起訖時間。';
        };
        for (const [input,button] of [['workspaceStart','workspaceUseStart'],['workspaceEnd','workspaceUseEnd']]) {
            $(input).oninput = showDuration;
            $(button).onclick = () => { $(input).value = local(SharedTimeline.current()); showDuration(); };
        }
        $('workspaceUseExport').onclick = () => {
            const times = range();
            if (!valid(times)) { $('workspaceDuration').textContent = '請先設定匯出起訖。'; return; }
            [$('workspaceStart').value,$('workspaceEnd').value] = times.map(local);
            showDuration();
        };
        $('workspaceOpen').onclick = () => {
            const [a,b] = SharedTimeline.bounds();
            $('workspaceStart').value = local(a);
            $('workspaceEnd').value = local(b);
            showDuration();
            $('workspaceDialog').showModal();
        };
        $('workspaceApply').onclick = () => {
            const selection = workspaceInputs();
            const [a,b] = SharedTimeline.fullBounds();
            if (!valid(selection) || selection[0]>=selection[1] || selection[0]<a-.001 || selection[1]>b+.001) {
                $('workspaceDuration').textContent = '請輸入資料時間範圍內的有效起訖時間。';
                return;
            }
            workspace = [Math.max(a,selection[0]),Math.min(b,selection[1])];
            $('workspaceDialog').close();
            refreshWorkspace();
        };
        $('workspaceFromExport').onclick = () => {
            const [start,end] = range();
            const [first,last] = SharedTimeline.fullBounds();
            if (!valid([start,end]) || start >= end || start < first || end > last) {
                alert('請先設定有效的匯出起點與終點。');
                return;
            }
            workspace = [start,end];
            refreshWorkspace();
        };
        $('workspaceClear').onclick = () => { workspace = null; refreshWorkspace(); };
        $('trackPoints').onchange = points;
        $('openNmeaExport').onclick = () => {
            $('nmeaExportStatus').textContent = rawFiles.length ? '' : '請先匯入原始 NMEA 並建立回放。';
            updateNmeaExport();
            $('nmeaExportDialog').showModal();
        };
        $('nmeaExportRange').onchange = updateNmeaExport;
        $('exportNmea').onclick = exportNmea;
        for (const [id,forward] of [['previousTrackPoint',false],['nextTrackPoint',true]]) {
            $(id).onclick = () => {
                const now = SharedTimeline.current();
                const times = pointTimes(5);
                const time = forward ? times.find(t=>t>now+.05) : times.findLast(t=>t<now-.05);
                if (time !== undefined) FramePreview.show(time);
            };
        }
        $('lockAis').onclick = () => { locked = locked ? '' : selected; $('holdAis').checked = false; render(); };
        $('holdAis').onchange = () => render();
        $('addCoordinatePin').onclick = () => {
            const latText = $('newPinLat').value.trim(), lonText = $('newPinLon').value.trim();
            const lat = Number(latText), lon = Number(lonText);
            if (!latText || !lonText || !Number.isFinite(lat) || !Number.isFinite(lon) ||
                Math.abs(lat)>90 || Math.abs(lon)>180) return alert('請輸入有效的 WGS84 緯度與經度。');
            setAddingPin(false);
            $('follow').checked = false;
            createPin(lat,lon);
            map?.panTo([lat,lon]);
        };
    }
    return {setup,reset,drawExportRange,inside,bounds,samples,points,pointTimes,clips,videoName,download,exportAis,target,renderLock,
        locked:()=>locked};
})();
