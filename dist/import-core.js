/* Shared parsing and fusion functions. Raw timestamps remain in seconds since Unix epoch. */
(function(root){
'use strict';
const Fusion=typeof module!=='undefined'&&module.exports?require('./fusion-core.js'):root.FusionCore;
const RAD=180/Math.PI;
function num(x){return typeof x==='number'&&Number.isFinite(x)}
function epoch(x){let t=Number(x);return Number.isFinite(t)&&t>=946684800&&t<4102444800?t:null}
function angle(v,signed=false){if(signed){if(v>=32765||Math.abs(v*.0001)>Math.PI)return null}else if(v>=65533||v*.0001>2*Math.PI)return null;return v*.0001*RAD}
function decode(p,hex){if(!/^[0-9a-f]{16}$/i.test(hex))return null;let b=Uint8Array.from(hex.match(/../g).map(x=>parseInt(x,16))),v=new DataView(b.buffer),u=i=>{let n=v.getUint16(i,true);return n<65533?n:null},a=(i,s=false)=>angle(s?v.getInt16(i,true):v.getUint16(i,true),s);
 if(p===129025){let lat=v.getInt32(0,true)*1e-7,lon=v.getInt32(4,true)*1e-7;return Math.abs(lat)<=90&&Math.abs(lon)<=180?{lat,lon}:null}
 if(p===129026){let n=u(4);return {cog:a(2),sog:n===null?null:n*.01,ref:b[1]&3}}
 if(p===127250)return {heading:a(1),variation:a(5,true),deviation:a(3,true),ref:b[7]&3};
 if(p===127258)return {variation:a(4,true)};
 if(p===130306){let n=u(1);return {speed:n===null?null:n*.01,angle:a(3),ref:b[5]&7}}
 if(p===126992){let d=u(2),t=v.getUint32(4,true);return d!==null&&t<=864010000?{epoch:d*86400+t*.0001,ref:b[1]&15}:null}return null;
}
function detect(line){line=line.replace(/^\uFEFF/,'').trim();if(!line)return null;if(line.includes('\t')&&line.includes('{'))return 'ais';let r=line.split(',');if(r.length===4&&epoch(r[0])!==null&&/^\d+$/.test(r[1])&&/^\d+$/.test(r[2]))return 'nmea';if(r.length===9&&epoch(r[0])!==null)return 'ahrs';if(/^(time|timestamp|epoch)/i.test(line)&&r.length===4)return 'nmea';return null}
function parseLine(line,type){line=line.replace(/^\uFEFF/,'').trim();if(!line)return {empty:true};if(type==='nmea'){
 let r=line.split(',');if(/^(time|timestamp|epoch)/i.test(r[0]))return {header:true};if(r.length!==4)throw Error('NMEA 必須為4欄：epoch,PGN,source,payload');let t=epoch(r[0]),p=Number(r[1]),src=Number(r[2]),hex=r[3].trim();if(t===null||!Number.isInteger(p)||p<0||p>262143||!Number.isInteger(src)||src<0||src>255||!/^([0-9a-f]{2}){1,8}$/i.test(hex))throw Error('NMEA 時間、PGN、來源或payload格式不符');let value=decode(p,hex);return {t,key:p+':'+src+(p===130306&&value?':'+value.ref:''),value,p,src};
 }
 let sep=line.indexOf('\t');if(sep<0)throw Error('AIS 必須是時間文字＋Tab＋JSON');let d=JSON.parse(line.slice(sep+1)),t=epoch(d.dataTime);if(t===null)throw Error('AIS 缺少有效 dataTime（epoch秒）');let m=String(d.mmsi??'');if(!/^\d{9}$/.test(m))throw Error('AIS MMSI 需為9位數');if(![1,2,3,18,19].includes(d.msg_type))return {t,skip:true};if(!num(d.lat)||!num(d.lon)||Math.abs(d.lat)>90||Math.abs(d.lon)>180)return {t,key:'ais:'+m,value:{invalid:true}};
 return {t,key:'ais:'+m,value:{mmsi:m,name:String(d.shipname||'').slice(0,100),lat:d.lat,lon:d.lon,sog:num(d.speed)&&d.speed>=0&&d.speed<102.3?d.speed:null,cog:num(d.course)&&d.course>=0&&d.course<360?d.course:null,heading:num(d.heading)&&d.heading>=0&&d.heading<360?d.heading:null}};
}
function idx(rows,t){let l=0,h=rows.length;while(l<h){let m=(l+h)>>1;if(rows[m][0]<=t)l=m+1;else h=m}return l-1}
function previous(rows,t,maxAge){if(!rows?.length)return null;let i=idx(rows,t);if(i<0||t-rows[i][0]>maxAge)return null;return {...rows[i][1],age:t-rows[i][0]}}
function position(rows,t,maxGap=2){return Fusion.position(rows,t,maxGap)}
function distance(a,b){return Fusion.distance(a,b)}
function merged(entries){let map=new Map(),dups=0,conflicts=0;for(let e of entries)for(let [key,rows]of e.streams){if(!map.has(key))map.set(key,[]);for(let r of rows)map.get(key).push(r)}for(let [k,rows]of map){rows.sort((a,b)=>a[0]-b[0]);let result=[];for(let row of rows){let prev=result[result.length-1];if(prev&&prev[0]===row[0]){if(JSON.stringify(prev[1])===JSON.stringify(row[1]))dups++;else conflicts++;continue}result.push(row)}map.set(k,result)}return {map,dups,conflicts}}
function build(entries,settings){let shifted=entries.filter(e=>e.streams).map(e=>({streams:e.streams.map(([k,rows])=>[k,rows.map(([t,v])=>[t+(k.startsWith('ais:')?settings.aisOffset:settings.nmeaOffset),v])])})),{map,dups,conflicts}=merged(shifted),sources=[...map.keys()].filter(k=>k.startsWith('129025:')).map(k=>k.split(':')[1]);if(!sources.length)throw Error('沒有可用的 PGN129025 本船定位。尚未支援以129029 fast-packet取代。');
 let posRows=sources.map(s=>map.get('129025:'+s)).flat().filter(r=>r[1]);let start=Infinity,end=-Infinity;for(let r of posRows){start=Math.min(start,r[0]);end=Math.max(end,r[0])}if(!Number.isFinite(start)||end<start)throw Error('沒有有效本船位置');let step=Math.max(settings.step,Math.ceil((end-start)/9999));let times=[];for(let t=start;t<end;t+=step)times.push(t);times.push(end);let targets=[...map.keys()].filter(k=>k.startsWith('ais:')),data=[];let truncated=0;
 const at=(p,src,t,age=2,ref)=>previous(map.get(p+':'+src+(ref===undefined?'':':'+ref)),t,age);
 for(let i=0;i<times.length;i++){let t=times[i],s={frame:null,pts:t-start,utc:new Date(t*1000).toISOString(),sources:{},targets:[],quality:{assignment:'sensor',pts_estimated:false,nmea_offset:settings.nmeaOffset,ais_offset:settings.aisOffset},clock:{}};
  for(let src of sources){let rows=map.get('129025:'+src),pos=position(rows,t,settings.ownGap);if(pos&&i>0){let a=Math.max(1,idx(rows,times[i-1])+1),b=idx(rows,t);for(let j=a;j<=b;j++)if(!rows[j][1]||!rows[j-1][1]||rows[j][0]-rows[j-1][0]>settings.ownGap){pos.breakBefore=true;break}}let motion=at(129026,src,t);if(motion&&motion.ref===1&&num(motion.cog)){let v=at(127258,src,t,30);motion.cog=v&&num(v.variation)?(motion.cog+v.variation+360)%360:null;if(motion.cog!==null)motion.ref=0}s.sources[src]={position:pos,motion};s.clock[src]=at(126992,src,t,3)}
  let ref=s.sources[settings.source]?.position||sources.map(src=>s.sources[src].position).find(Boolean);s.lat=ref?.lat??null;s.lon=ref?.lon??null;
  let h=at(127250,settings.headingSource,t),v=at(127258,settings.headingSource,t,30);if(h){let variation=h.variation??v?.variation??null;h.true_heading=num(h.heading)&&(h.ref===0||h.ref===1&&num(variation))?(h.heading+(h.ref===1?variation:0)+360)%360:null;h.variation_used=variation;h.source=settings.headingSource}s.heading=h;s.variation=v;s.wind=at(130306,settings.windSource,t,5,0);s.apparentWind=at(130306,settings.windSource,t,5,2);
  if(ref)for(let key of targets){let d=previous(map.get(key),t,30);if(!d||d.invalid)continue;let ds=Object.values(s.sources).filter(o=>o.position).map(o=>distance(o.position,d));let range=Math.min(...ds);if(range<=5000)s.targets.push([d.mmsi,d.name,d.lat,d.lon,range,d.age,d.sog,d.cog,d.heading])}
  s.targets.sort((a,b)=>a[4]-b[4]);if(s.targets.length>500){s.targets=s.targets.slice(0,500);truncated++}data.push(s);
 }
 return {data,sources,aisReports:Object.fromEntries(targets.map(k=>[k.slice(4),map.get(k)])),positions:Object.fromEntries(sources.map(s=>[s,map.get('129025:'+s)])),meta:{start,end,step,snapshots:data.length,duplicates:dups,conflicts,truncated,aisTargets:targets.length}};
}
root.ImportCore={decode,detect,parseLine,idx,previous,position,distance,merged,build,epoch};if(typeof module!=='undefined')module.exports=root.ImportCore;
})(typeof self!=='undefined'?self:globalThis);
