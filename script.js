import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getDatabase, ref, onValue, query, orderByChild, limitToLast } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { firebaseConfig, DEVICE_ID, HEARTBEAT_TIMEOUT_MS } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const state = { status:null, history:[], filteredHistory:[], connected:false, lastSeen:0, historyReady:false };
const chart = $("flowChart");
const ctx = chart.getContext("2d");
let heartbeatTimer = null;

function fmt(n, digits=2) { return Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : "—"; }
function timeLabel(value=Date.now(), includeDate=false) {
  const d = value instanceof Date ? value : new Date(Number(value));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], includeDate ? {year:"numeric",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"} : {hour:"2-digit",minute:"2-digit",second:"2-digit"});
}
function validConfig() {
  return firebaseConfig.apiKey && !firebaseConfig.apiKey.includes("PASTE_") &&
    firebaseConfig.projectId && !firebaseConfig.projectId.includes("YOUR_") &&
    firebaseConfig.databaseURL && !firebaseConfig.databaseURL.includes("YOUR_");
}
function setBanner(mode, title, message, tag) {
  const notice=$("demoNotice"); notice.classList.toggle("connected-notice", mode==="connected"); notice.classList.toggle("disconnected-notice", mode!=="connected");
  $("noticeTitle").textContent=title; $("noticeText").textContent=message; $("noticeTag").textContent=tag;
}
function setConnection(online, lastSeen=0) {
  state.connected=online; state.lastSeen=lastSeen;
  const pill=$("modePill"); pill.classList.toggle("connected",online); pill.classList.toggle("disconnected",!online);
  pill.innerHTML=`<span class="tiny-dot"></span> ${online ? "DEVICE CONNECTED" : "DEVICE OFFLINE"}`;
  $("connectionDot").classList.toggle("online",online); $("connectionDot").classList.toggle("offline",!online);
  $("connectionText").textContent=online ? "Connected" : "Offline";
  $("connectionText").classList.toggle("online",online); $("connectionText").classList.toggle("offline",!online);
  $("signalText").textContent=online ? (state.status?.wifiRssi != null ? `${state.status.wifiRssi} dBm Wi-Fi` : "Heartbeat received") : (lastSeen ? `Last seen ${timeLabel(lastSeen)}` : "No heartbeat received");
  $("linkStatus").textContent=online ? `Receiving data from ${DEVICE_ID}` : (lastSeen ? `Last heartbeat ${timeLabel(lastSeen)}` : "Waiting for first heartbeat");
  $("linkState").textContent=online ? "CONNECTED" : "OFFLINE";
  $("linkState").classList.toggle("pending-text",!online);
  $("linkIcon").className=online ? "status-icon good" : "status-icon pending";
  $("linkIcon").textContent=online ? "✓" : "↗";
  $("sidebarDevice").textContent=online ? "ESP32 connected" : "Device offline";
  $("liveLabel").textContent=online ? "LIVE DEVICE DATA" : "NO LIVE DATA";
  $("flowTrend").textContent=online ? `Updated ${timeLabel(lastSeen)}` : "Waiting for device heartbeat";
  $("dataSource").textContent=online ? "Firebase / ESP32" : "Cloud · no current heartbeat";
  $("systemFoot").innerHTML=online ? '<span class="pulse-dot"></span> Live device heartbeat received' : '<span class="pulse-dot"></span> Device is not currently reporting';
  if (online) setBanner("connected","ESP32 is connected","Live readings are arriving from the monitoring node. Historical samples are being saved to the cloud database.","LIVE");
  else setBanner("offline",lastSeen ? "ESP32 connection lost or stale" : "Waiting for ESP32 connection",lastSeen ? "No recent heartbeat has arrived. The device will show connected again when fresh data is received." : "Add Firebase settings and power on the ESP32. The dashboard will not display simulated measurements.",validConfig()?"OFFLINE":"SETUP");
}
function drawChart() {
  const rect=chart.getBoundingClientRect(); if(!rect.width||!rect.height)return;
  const dpr=window.devicePixelRatio||1; chart.width=Math.round(rect.width*dpr); chart.height=Math.round(rect.height*dpr); ctx.setTransform(dpr,0,0,dpr,0,0);
  const w=rect.width,h=rect.height,pad={left:4,right:6,top:10,bottom:7},cw=w-pad.left-pad.right,ch=h-pad.top-pad.bottom;
  ctx.clearRect(0,0,w,h); const samples=state.history.slice(-50); const max=Math.max(5,...samples.map(x=>Number(x.flowRate)||0))*1.1;
  for(let i=0;i<=4;i++){const y=pad.top+ch*i/4;ctx.strokeStyle="#edf2f4";ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(w-pad.right,y);ctx.stroke();}
  const pts=samples.map((s,i)=>({x:pad.left+(samples.length<2?cw:cw*i/(samples.length-1)),y:pad.top+ch-Math.max(0,Number(s.flowRate)||0)/max*ch}));
  if(!pts.length)return;
  ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.lineTo(pts.at(-1).x,h-pad.bottom);ctx.lineTo(pts[0].x,h-pad.bottom);ctx.closePath();const grad=ctx.createLinearGradient(0,pad.top,0,h);grad.addColorStop(0,"rgba(17,168,160,.18)");grad.addColorStop(1,"rgba(17,168,160,.01)");ctx.fillStyle=grad;ctx.fill();
  ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.strokeStyle="#0fa79d";ctx.lineWidth=2.3;ctx.lineJoin="round";ctx.lineCap="round";ctx.stroke();
  $("chartStart").textContent=samples.length?timeLabel(samples[0].timestamp):"No data yet";
}
function renderRecent() {
  const body=$("readingsBody");body.replaceChildren();
  const rows=state.history.slice(-6).reverse();
  if(!rows.length){body.innerHTML='<tr><td colspan="4" class="empty-history">No readings received yet.</td></tr>';}
  rows.forEach(s=>{const tr=document.createElement("tr");[timeLabel(s.timestamp),`${fmt(s.flowRate)} <span style="color:#8a9aa3;font-weight:500">L/min</span>`,`${fmt(s.totalLitres)} L`,`<span class="mini-state">${Number(s.flowRate)>0.05?"Flowing":"No flow"}</span>`].forEach((v,i)=>{const td=document.createElement("td");if(i===1||i===2)td.className="flow-number";td.innerHTML=v;tr.appendChild(td);});body.appendChild(tr);});
  $("sampleCount").textContent=`${state.history.length} samples`;
}
function renderHistory() {
  const from=$("historyFrom").value ? new Date(`${$("historyFrom").value}T00:00:00`).getTime() : -Infinity;
  const to=$("historyTo").value ? new Date(`${$("historyTo").value}T23:59:59.999`).getTime() : Infinity;
  state.filteredHistory=state.history.filter(x=>Number(x.timestamp)>=from&&Number(x.timestamp)<=to).slice().reverse();
  const body=$("historyBody");body.replaceChildren();
  if(!state.filteredHistory.length){body.innerHTML='<tr><td colspan="4" class="empty-history">No saved readings match this date range.</td></tr>';}
  state.filteredHistory.forEach(s=>{const tr=document.createElement("tr");[timeLabel(s.timestamp,true),`${fmt(s.flowRate)} L/min`,`${fmt(s.totalLitres)} L`,s.nodeId||DEVICE_ID].forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td);});body.appendChild(tr);});
  $("historyCount").textContent=`${state.filteredHistory.length} records`;
}
function render() {
  const s=state.status;if(!s)return;
  $("flowRate").textContent=fmt(s.flowRate);$("totalLitres").textContent=fmt(s.totalLitres);$("chartCurrent").textContent=fmt(s.flowRate);$("lastUpdate").textContent=timeLabel(s.lastSeen||s.updatedAt||s.timestamp,true);$("footerTime").textContent=timeLabel(Date.now());
  const flowing=Number(s.flowRate)>0.05;$("flowState").textContent=flowing?"Flow detected":"No flow";$("stateBadge").textContent=flowing?"ACTIVE":"IDLE";$("stateBadge").style.background=flowing?"#e2f7ed":"#eef2f5";$("stateBadge").style.color=flowing?"#168d68":"#758792";
  renderRecent();renderHistory();drawChart();
}
function startHeartbeatWatch(){if(heartbeatTimer)clearInterval(heartbeatTimer);heartbeatTimer=setInterval(()=>{const age=Date.now()-Number(state.lastSeen||0);setConnection(Boolean(state.lastSeen&&age<=HEARTBEAT_TIMEOUT_MS),state.lastSeen);},2000);}
function showSetupError(message) {setConnection(false,0);setBanner("offline","Firebase setup required",message,"SETUP");$("linkStatus").textContent="Configuration incomplete";}
async function connect() {
  if(!validConfig()){showSetupError("Open firebase-config.js and paste your Firebase Web App config. Follow README.txt to enable Realtime Database and Anonymous Authentication.");return;}
  try {
    const app=initializeApp(firebaseConfig);const auth=getAuth(app);const db=getDatabase(app);
    await signInAnonymously(auth);
    const statusRef=ref(db,`devices/${DEVICE_ID}/status`);
    onValue(statusRef,snap=>{state.status=snap.val();if(!state.status){setConnection(false,0);return;}
      state.lastSeen=Number(state.status.lastSeen||state.status.updatedAt||state.status.timestamp||0);
      setConnection(Boolean(state.lastSeen&&Date.now()-state.lastSeen<=HEARTBEAT_TIMEOUT_MS),state.lastSeen);render();
    },err=>{showSetupError(`Could not read device status: ${err.message}. Check Firebase rules and configuration.`);});
    const historyRef=query(ref(db,`devices/${DEVICE_ID}/history`),orderByChild("timestamp"),limitToLast(1000));
    onValue(historyRef,snap=>{const val=snap.val()||{};state.history=Object.values(val).filter(x=>x&&Number.isFinite(Number(x.timestamp))).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp));state.historyReady=true;renderRecent();renderHistory();drawChart();},err=>{const body=$("historyBody");body.innerHTML=`<tr><td colspan="4" class="empty-history">History read failed: ${err.message}</td></tr>`;});
    startHeartbeatWatch();
  } catch(err) {showSetupError(`Connection failed: ${err.message}. Check internet access, Firebase config, and Anonymous Authentication.`);}
}
function exportCsv(){
  const rows=state.filteredHistory;if(!rows.length){alert("There are no history records to export for this filter.");return;}
  const quote=v=>`"${String(v??"").replaceAll('"','""')}"`;
  const lines=[["timestamp","date_time","node_id","flow_rate_l_min","total_litres"],...rows.map(x=>[x.timestamp,timeLabel(x.timestamp,true),x.nodeId||DEVICE_ID,x.flowRate,x.totalLitres])].map(r=>r.map(quote).join(","));
  const blob=new Blob([lines.join("\r\n")],{type:"text/csv;charset=utf-8;"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`flowguard-history-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);
}
function openDialog(title, bodyHtml) {$("dialogTitle").textContent=title;if(bodyHtml)$("dialogBody").innerHTML=bodyHtml;$("infoDialog").showModal();}
$("helpBtn").addEventListener("click",()=>openDialog("About this dashboard"));
$("connectInfoBtn").addEventListener("click",()=>openDialog("Connect your ESP32"));
$("deviceMenu").addEventListener("click",()=>openDialog("Monitoring node details",`<p><b>Node ID:</b> ${DEVICE_ID}</p><p><b>Connection:</b> ${state.connected?"Connected":"Offline"}</p><p><b>Data source:</b> Firebase Realtime Database</p><p>Device status is based on the latest heartbeat. A stale heartbeat marks the device offline even if the website remains open.</p>`));
$("closeDialog").addEventListener("click",()=>$("infoDialog").close());$("infoDialog").addEventListener("click",e=>{if(e.target===$("infoDialog"))$("infoDialog").close()});
$("filterHistoryBtn").addEventListener("click",renderHistory);$("clearHistoryFilterBtn").addEventListener("click",()=>{$("historyFrom").value="";$("historyTo").value="";renderHistory();});$("exportCsvBtn").addEventListener("click",exportCsv);
$("todayLabel").textContent=new Date().toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"});
setConnection(false,0);drawChart();connect();window.addEventListener("resize",drawChart);
