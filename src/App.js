import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import {
  doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
  collection, getDocs, query, where,
  runTransaction, onSnapshot,
} from "firebase/firestore";

const CFG = {
  MAX_SLOTS: 100,
  TIMER_SEC: 300,
  RENEW_SEC: 300,
  MAX_RENEWALS: 1,
  ADMIN_PWD: "pascoa2026",
  SUPERADMIN_PWD: "superalpha2026",
  ADMIN_PATH: "/alpha-admin",
  OPEN_AT: new Date(Date.now() - 1000),
  EVENT_DATE_LABEL: "04 de abril de 2026",
  EVENT_DAY_LABEL: "Sábado",
  EVENT_TIME_LABEL: "Recepção aberta entre 9h e 10h30",
  EVENT_LIMITED: "Vagas limitadas - garanta a sua!",
  LOCATION_LABEL: "RP, Gardênia e Araticum",
  ADDRESS_LABEL: "Av. Engenheiro Souza Filho, 3555 (ao lado da Malibu)",
  ORG_LABEL: "Ministério Alpha",
  ORG_SUBTITLE: "A Igreja da Família",
  // Logo como SVG inline baseado na identidade visual
  LOGO_URL: "https://i.imgur.com/placeholder.png", // substituir pela URL real
};

// ── DB FIRESTORE ──────────────────────────────────────────────────────────────
const SESS_KEY = "easter_sess_v3";
const slotsRef = doc(db, "config", "slots");

async function ensureSlots() {
  const snap = await getDoc(slotsRef);
  if (!snap.exists()) await setDoc(slotsRef, { available: CFG.MAX_SLOTS, nextRegNumber: 1 });
}
async function reserveSlots(n) {
  const sid=`S${Date.now()}${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  const expiresAt=new Date(Date.now()+CFG.TIMER_SEC*1000).toISOString();
  try {
    await runTransaction(db, async (t) => {
      const snap=await t.get(slotsRef);
      const available=snap.data()?.available??0;
      if(available<n) throw new Error("full");
      t.update(slotsRef,{available:available-n});
      t.set(doc(db,"reservations",sid),{sid,count:n,expiresAt,renewals:0});
    });
    return {ok:true,sid,expiresAt};
  } catch { return {ok:false}; }
}
async function upgradeReservation(sid) {
  const resRef=doc(db,"reservations",sid);
  try {
    await runTransaction(db, async (t) => {
      const [sSnap,rSnap]=await Promise.all([t.get(slotsRef),t.get(resRef)]);
      if(!rSnap.exists()||new Date(rSnap.data().expiresAt).getTime()<Date.now()) throw new Error("expired");
      const available=sSnap.data()?.available??0;
      if(available<1) throw new Error("full");
      t.update(slotsRef,{available:available-1});
      t.update(resRef,{count:rSnap.data().count+1});
    });
    return {ok:true};
  } catch(e) { return {ok:false,reason:e.message}; }
}
async function renewReservation(sid) {
  const resRef=doc(db,"reservations",sid);
  const snap=await getDoc(resRef);
  if(!snap.exists()||new Date(snap.data().expiresAt).getTime()<Date.now()) return {ok:false,reason:"expired"};
  if(snap.data().renewals>=CFG.MAX_RENEWALS) return {ok:false,reason:"max"};
  const expiresAt=new Date(Date.now()+CFG.RENEW_SEC*1000).toISOString();
  await updateDoc(resRef,{expiresAt,renewals:snap.data().renewals+1});
  return {ok:true,expiresAt};
}
async function cancelReservation(sid) {
  const resRef=doc(db,"reservations",sid);
  try {
    await runTransaction(db, async (t) => {
      const rSnap=await t.get(resRef);
      if(!rSnap.exists()) return;
      const sSnap=await t.get(slotsRef);
      t.update(slotsRef,{available:(sSnap.data()?.available??0)+rSnap.data().count});
      t.delete(resRef);
    });
  } catch {}
}
async function deleteRegistrationDoc(regId,count) {
  await runTransaction(db,async(t)=>{
    const sSnap=await t.get(slotsRef);
    t.delete(doc(db,"registrations",regId));
    t.update(slotsRef,{available:(sSnap.data()?.available??0)+count});
  });
}
async function deleteWaitlistDoc(id) {
  await deleteDoc(doc(db,"waitlist",id));
}
async function adjustAvailableSlots(delta) {
  await runTransaction(db,async(t)=>{
    const snap=await t.get(slotsRef);
    t.update(slotsRef,{available:Math.max(0,(snap.data()?.available??0)+delta)});
  });
}
async function setRegistrationClosed(closed) {
  await updateDoc(slotsRef,{registrationClosed:closed});
}
async function confirmRegistration(sid,data) {
  const cpfQ=query(collection(db,"registrations"),where("adult.cpf","==",data.adult.cpf));
  const cpfSnap=await getDocs(cpfQ);
  if(!cpfSnap.empty) return {ok:false,reason:"Esse CPF já possui um cadastro neste evento."};
  const resRef=doc(db,"reservations",sid);
  let reg;
  try {
    await runTransaction(db, async (t) => {
      const [rSnap,sSnap]=await Promise.all([t.get(resRef),t.get(slotsRef)]);
      if(!rSnap.exists()||new Date(rSnap.data().expiresAt).getTime()<Date.now())
        throw new Error("Sua reserva expirou. Reinicie o cadastro.");
      const nextNum=sSnap.data()?.nextRegNumber??1;
      const regId=`REG-${String(nextNum).padStart(4,"0")}`;
      const childNumbers=data.children.map((_,i)=>nextNum*10+i+1);
      t.update(slotsRef,{nextRegNumber:nextNum+1});
      t.set(doc(db,"registrations",regId),{...data,regId,confirmedAt:new Date().toISOString(),checkedIn:false,checkedInAt:null,childNumbers});
      t.delete(resRef);
      reg={...data,regId,confirmedAt:new Date().toISOString(),checkedIn:false,checkedInAt:null,childNumbers};
    });
    sessionStorage.setItem(SESS_KEY,JSON.stringify({regId:reg.regId}));
    return {ok:true,reg};
  } catch(e) { return {ok:false,reason:e.message}; }
}
async function getSessionReg() {
  try {
    const s=sessionStorage.getItem(SESS_KEY); if(!s) return null;
    const {regId}=JSON.parse(s);
    const snap=await getDoc(doc(db,"registrations",regId));
    return snap.exists()?snap.data():null;
  } catch { return null; }
}
function clearSession() { sessionStorage.removeItem(SESS_KEY); }
async function findRegByCPF(cpf) {
  const q=query(collection(db,"registrations"),where("adult.cpf","==",cpf));
  const snap=await getDocs(q);
  if(snap.empty) return null;
  const reg=snap.docs[0].data();
  sessionStorage.setItem(SESS_KEY,JSON.stringify({regId:reg.regId}));
  return reg;
}
async function addWaitlist(name,phone) {
  const snap=await getDocs(collection(db,"waitlist"));
  await addDoc(collection(db,"waitlist"),{name,phone,at:new Date().toISOString()});
  return snap.size+1;
}
async function doCheckIn(regId) {
  const ref=doc(db,"registrations",regId);
  const snap=await getDoc(ref);
  if(!snap.exists()) return false;
  await updateDoc(ref,{checkedIn:true,checkedInAt:new Date().toISOString()});
  return true;
}
async function doCancelCheckIn(regId) {
  await updateDoc(doc(db,"registrations",regId),{checkedIn:false,checkedInAt:null});
}
async function createBypassToken(name,phone) {
  const token=`BP${Date.now()}${Math.random().toString(36).slice(2,8).toUpperCase()}`;
  const expiresAt=new Date(Date.now()+48*3600*1000).toISOString();
  await setDoc(doc(db,"bypass_tokens",token),{name,phone,expiresAt,used:false,createdAt:new Date().toISOString()});
  return token;
}
async function redeemBypassToken(token,n) {
  const sid=`S${Date.now()}${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  const expiresAt=new Date(Date.now()+CFG.TIMER_SEC*1000).toISOString();
  try {
    await runTransaction(db,async(t)=>{
      const ref=doc(db,"bypass_tokens",token);
      const snap=await t.get(ref);
      if(!snap.exists()) throw new Error("invalid");
      const td=snap.data();
      if(td.used) throw new Error("used");
      if(new Date(td.expiresAt)<new Date()) throw new Error("expired");
      t.update(ref,{used:true,usedAt:new Date().toISOString()});
      t.set(doc(db,"reservations",sid),{sid,count:n,expiresAt,renewals:0,bypass:true});
    });
    return {ok:true,sid,expiresAt};
  } catch(e) { return {ok:false,reason:e.message}; }
}
async function getAllStats() {
  const now=Date.now();
  const [sSnap,regsSnap,waitSnap,resSnap]=await Promise.all([
    getDoc(slotsRef),
    getDocs(collection(db,"registrations")),
    getDocs(collection(db,"waitlist")),
    getDocs(collection(db,"reservations")),
  ]);
  const regs=regsSnap.docs.map(d=>d.data());
  const confirmed=regs.reduce((s,r)=>s+r.children.length,0);
  const reserved=resSnap.docs.filter(d=>new Date(d.data().expiresAt).getTime()>now).reduce((s,d)=>s+d.data().count,0);
  const waitlistItems=waitSnap.docs.map(d=>({...d.data(),_id:d.id})).sort((a,b)=>new Date(a.at)-new Date(b.at));
  return {confirmed,reserved,available:sSnap.data()?.available??0,registrationClosed:sSnap.data()?.registrationClosed??false,waitlist:waitSnap.size,regs,waitlistItems};
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
const fmtTime = s=>`${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
const maskCPF = v=>v.replace(/\D/g,"").replace(/(\d{3})(\d)/,"$1.$2").replace(/(\d{3})(\d)/,"$1.$2").replace(/(\d{3})(\d{1,2})$/,"$1-$2").slice(0,14);
const maskPhone = v=>v.replace(/\D/g,"").replace(/(\d{2})(\d)/,"($1) $2").replace(/(\d{5})(\d)/,"$1-$2").slice(0,15);
const maskDate = v=>v.replace(/\D/g,"").replace(/(\d{2})(\d)/,"$1/$2").replace(/(\d{2})(\d)/,"$1/$2").slice(0,10);
function validateCPF(cpf) {
  cpf=cpf.replace(/\D/g,"");
  if(cpf.length!==11||/^(\d)\1+$/.test(cpf)) return false;
  let s=0; for(let i=0;i<9;i++) s+=+cpf[i]*(10-i);
  let r=(s*10)%11; if(r>=10) r=0; if(r!==+cpf[9]) return false;
  s=0; for(let i=0;i<10;i++) s+=+cpf[i]*(11-i);
  r=(s*10)%11; if(r>=10) r=0; return r===+cpf[10];
}
function validateAge(dob) {
  const [d,m,y]=dob.split("/").map(Number);
  if(!d||!m||!y||y<2010||m>12||d>31) return {ok:false,msg:"Data inválida"};
  const dt=new Date(y,m-1,d),today=new Date();
  let age=today.getFullYear()-dt.getFullYear();
  if(today.getMonth()<dt.getMonth()||(today.getMonth()===dt.getMonth()&&today.getDate()<dt.getDate())) age--;
  if(age<3) return {ok:false,msg:"A criança precisa ter pelo menos 3 anos"};
  if(age>12) return {ok:false,msg:"A criança deve ter no máximo 12 anos"};
  return {ok:true,age};
}
function fullName(v) { return v.trim().split(/\s+/).length>=2; }

// ── DESIGN TOKENS — identidade Ministério Alpha ───────────────────────────────
const T = {
  blue:      "#1B5BA8",
  blueD:     "#134080",
  blueL:     "#E8F0FB",
  blueM:     "#D0E2F7",
  gold:      "#F0A500",
  goldL:     "#FFF6E0",
  goldD:     "#C8850A",
  white:     "#FFFFFF",
  bg:        "#F4F7FC",
  bgAlt:     "#EBF1FA",
  text:      "#1A2A3A",
  muted:     "#5A6A7A",
  border:    "#C8D8EC",
  red:       "#C0392B",
  green:     "#1A7A47",
  greenL:    "#E0F5EB",
  shadow:    "0 4px 20px rgba(27,91,168,0.10)",
  shadowMd:  "0 8px 36px rgba(27,91,168,0.18)",
};

const FONTS = `
  @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800;900&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Montserrat', sans-serif; background: ${T.bg}; }
  input, select, button { font-family: 'Montserrat', sans-serif; }
  button { cursor: pointer; transition: all .18s ease; }
  button:hover { opacity: .9; transform: translateY(-1px); }
  button:active { transform: translateY(0); }
  input:focus, select:focus { outline: none; border-color: ${T.blue} !important; box-shadow: 0 0 0 3px rgba(27,91,168,0.14); }
  @keyframes fadeUp { from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)} }
  @keyframes pulse { 0%,100%{opacity:1}50%{opacity:.5} }
  @keyframes pop { 0%{transform:scale(.92);opacity:0}100%{transform:scale(1);opacity:1} }
  @keyframes spin { to{transform:rotate(360deg)} }
  @media print {
    .no-print { display:none !important; }
    body { background: white; }
    .ticket { box-shadow: none !important; }
  }
`;

function Styles() { return <style>{FONTS}</style>; }

const LOGO_SRC = "data:image/png;base64,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";
function AlphaLogo({ size = 64 }) {
  return <img src={LOGO_SRC} alt="Ministério Alpha" width={size} height={size} style={{ objectFit:"contain", display:"block" }} />;
}

// ── MICRO COMPONENTS ──────────────────────────────────────────────────────────
function Card({ children, style={} }) {
  return <div style={{ background:T.white, borderRadius:16, padding:"22px 20px", boxShadow:T.shadow, border:`1px solid ${T.border}`, ...style }}>{children}</div>;
}

function Btn({ children, onClick, variant="primary", style={}, disabled=false }) {
  const variants = {
    primary: { background:T.blue, color:T.white },
    gold:    { background:T.gold, color:T.white },
    ghost:   { background:T.blueL, color:T.blue },
    green:   { background:T.green, color:T.white },
    danger:  { background:T.red, color:T.white },
    whats:   { background:"#25D366", color:T.white },
    outline: { background:"transparent", color:T.blue, border:`2px solid ${T.blue}` },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      border:"none", borderRadius:10, padding:"13px 20px", fontSize:14, fontWeight:700,
      display:"flex", alignItems:"center", justifyContent:"center", gap:8,
      opacity:disabled?.55:1, letterSpacing:.3,
      ...variants[variant], ...style,
    }}>{children}</button>
  );
}

function Field({ label, error, hint, children }) {
  return (
    <div style={{ marginBottom:14 }}>
      <label style={{ display:"block", fontSize:12, fontWeight:700, color:T.blue, marginBottom:5, textTransform:"uppercase", letterSpacing:.5 }}>{label}</label>
      {children}
      {error && <p style={{ color:T.red, fontSize:12, marginTop:4, fontWeight:500 }}>⚠ {error}</p>}
      {hint && !error && <p style={{ color:T.muted, fontSize:12, marginTop:4 }}>{hint}</p>}
    </div>
  );
}

function TInput({ value, onChange, placeholder, maxLength, type="text" }) {
  return (
    <input type={type} value={value} onChange={onChange} placeholder={placeholder} maxLength={maxLength}
      style={{ width:"100%", padding:"11px 13px", borderRadius:9, border:`1.5px solid ${T.border}`, fontSize:14, color:T.text, background:T.white }} />
  );
}

function SlotBar({ available }) {
  const used=CFG.MAX_SLOTS-available, pct=Math.round((used/CFG.MAX_SLOTS)*100);
  const bc=available>20?T.green:available>5?T.gold:T.red;
  return (
    <div style={{ background:T.blueL, borderRadius:14, padding:"14px 16px", marginBottom:14, animation:"fadeUp .4s ease", border:`1px solid ${T.blueM}` }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <span style={{ fontSize:13, fontWeight:700, color:T.blue, textTransform:"uppercase", letterSpacing:.4 }}>Vagas disponíveis</span>
        <span style={{ fontSize:26, fontWeight:900, color:bc }}>{available}</span>
      </div>
      <div style={{ height:8, background:"rgba(27,91,168,.12)", borderRadius:6, overflow:"hidden" }}>
        <div style={{ height:"100%", width:`${pct}%`, background:bc, borderRadius:6, transition:"width .6s ease" }} />
      </div>
      <p style={{ fontSize:12, color:T.muted, marginTop:6, fontWeight:500 }}>{used} de {CFG.MAX_SLOTS} vagas preenchidas</p>
    </div>
  );
}

function PageHeader() {
  return (
    <div style={{ textAlign:"center", padding:"0px 0 14px", animation:"fadeUp .5s ease" }}>
      <div style={{ display:"flex", justifyContent:"center" }}>
        <AlphaLogo size={160} />
      </div>
      <div style={{ width:40, height:3, background:T.gold, borderRadius:2, margin:"0px auto 0" }} />
    </div>
  );
}

function Modal({ show, icon, title, body, actions }) {
  if(!show) return null;
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(20,40,80,.78)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:16 }}>
      <div style={{ background:T.white, borderRadius:18, padding:"28px 22px", maxWidth:360, width:"100%", textAlign:"center", animation:"pop .25s ease", boxShadow:T.shadowMd }}>
        <div style={{ fontSize:36, marginBottom:10 }}>{icon}</div>
        <h3 style={{ fontSize:20, fontWeight:800, color:T.blue, marginBottom:10 }}>{title}</h3>
        <p style={{ color:T.muted, fontSize:14, lineHeight:1.65, marginBottom:20, fontWeight:500 }}>{body}</p>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>{actions}</div>
      </div>
    </div>
  );
}

// ── HOME ──────────────────────────────────────────────────────────────────────
function HomeScreen({ available, regClosed, onStart, onRecover }) {
  const steps = [
    ["🎟️","Escolha quantas crianças vai inscrever (1 ou 2)"],
    ["📝","Preencha o cadastro com seus dados e os da(s) criança(s)"],
    ["📲","Ao final você receberá um comprovante com QR Code (guarde ele para apresentar no dia)"],
    ["🎁",`Compareça: ${CFG.EVENT_DAY_LABEL}, ${CFG.EVENT_DATE_LABEL} · ${CFG.EVENT_TIME_LABEL}\n${CFG.ADDRESS_LABEL}`],
  ];
  return (
    <div style={{ minHeight:"100vh", background:T.bg }}>
      <Styles />
      <div style={{ background:T.blue, height:6 }} />
      <div style={{ maxWidth:460, margin:"0 auto", padding:"0 16px 32px" }}>
        <PageHeader />
        <div style={{ background:`linear-gradient(135deg,${T.blue},${T.blueD})`, borderRadius:16, padding:"18px 20px", marginBottom:14, boxShadow:T.shadowMd }}>
          <p style={{ color:T.gold, fontSize:11, fontWeight:800, letterSpacing:2, textTransform:"uppercase" }}>Ação Social de Páscoa</p>
          <h2 style={{ color:T.white, fontSize:20, fontWeight:800, margin:"4px 0 6px", lineHeight:1.3 }}>Distribuição de 1 CAIXA DE BOMBOM para crianças de 3 a 12 anos, moradores do RP, Gardênia e Araticum</h2>
          <div style={{ display:"flex", gap:14, flexWrap:"wrap" }}>
            <p style={{ color:"rgba(255,255,255,.8)", fontSize:13, fontWeight:600 }}>📅 {CFG.EVENT_DAY_LABEL}, {CFG.EVENT_DATE_LABEL}</p>
            <p style={{ color:"rgba(255,255,255,.8)", fontSize:13, fontWeight:600 }}>🕘 {CFG.EVENT_TIME_LABEL}</p>
            <p style={{ color:"rgba(255,255,255,.8)", fontSize:13, fontWeight:600 }}>📍 {CFG.ADDRESS_LABEL}</p>
            <p style={{ color:"rgba(255,255,255,.8)", fontSize:13, fontWeight:600 }}>🎁 {CFG.EVENT_LIMITED}</p>
          </div>
        </div>
        <SlotBar available={available} />

        {/* Aviso exclusividade */}
        <div style={{ background:T.blue, border:`2px solid ${T.blueD}`, borderRadius:14, padding:"14px 16px", marginBottom:14, display:"flex", gap:12, alignItems:"flex-start" }}>
          <span style={{ fontSize:22, flexShrink:0, marginTop:1 }}>🚫</span>
          <div>
            <p style={{ fontSize:14, fontWeight:800, color:T.white, marginBottom:4 }}>Evento exclusivo para cadastrados</p>
            <p style={{ fontSize:13, color:"rgba(255,255,255,.82)", lineHeight:1.7, fontWeight:500 }}>
              A entrada será permitida <strong style={{color:T.gold}}>somente mediante apresentação do comprovante</strong> (QR Code ou código). Não haverá atendimento no local para quem não tiver cadastro, sem exceção.
            </p>
          </div>
        </div>

        {/* Regras em destaque */}
        <div style={{ background:T.goldL, border:`2px solid ${T.gold}`, borderRadius:14, padding:"14px 16px", marginBottom:14 }}>
          <p style={{ fontSize:13, fontWeight:800, color:T.goldD, marginBottom:8, textTransform:"uppercase", letterSpacing:.4 }}>⚠️ Leia antes de se cadastrar</p>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {[
              ["👶","Crianças de 3 a 12 anos completos"],
              ["👨‍👧","Máximo de 2 crianças por adulto responsável (cada criança receberá 1 CAIXA DE BOMBOM)"],
              ["📄","O CPF do responsável é obrigatório e vincula o cadastro — um CPF = um cadastro"],
              ["🚪","O responsável cadastrado deve estar presente junto com as crianças para efetuar a entrada no evento"],
            ].map(([e,t])=>(
              <div key={t} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                <span style={{ fontSize:15, flexShrink:0, marginTop:1 }}>{e}</span>
                <p style={{ fontSize:13, color:T.goldD, lineHeight:1.6, fontWeight:600 }}>{t}</p>
              </div>
            ))}
          </div>
        </div>

        <Card style={{ marginBottom:14 }}>
          <h2 style={{ fontSize:14, fontWeight:800, color:T.blue, marginBottom:14, textTransform:"uppercase", letterSpacing:.5 }}>Como funciona</h2>
          {steps.map(([e,t])=>(
            <div key={t} style={{ display:"flex", gap:12, alignItems:"flex-start", marginBottom:12 }}>
              <span style={{ fontSize:18, lineHeight:1.5, flexShrink:0 }}>{e}</span>
              <p style={{ fontSize:14, color:T.muted, lineHeight:1.6, fontWeight:500, whiteSpace:"pre-line" }}>{t}</p>
            </div>
          ))}
        </Card>
        {regClosed?(
          <div style={{background:"#FFECEC",border:`2px solid ${T.red}`,borderRadius:14,padding:"16px 20px",marginBottom:14,textAlign:"center"}}>
            <p style={{fontWeight:800,color:T.red,fontSize:16,marginBottom:4}}>🔴 Cadastro encerrado</p>
            <p style={{fontSize:13,color:T.muted,fontWeight:500}}>O período de inscrições foi encerrado.</p>
          </div>
        ):(
          <Btn onClick={onStart} style={{ width:"100%", fontSize:15, padding:"16px 20px", borderRadius:12 }}>
            Quero me cadastrar →
          </Btn>
        )}
        <Btn variant="ghost" onClick={onRecover} style={{ width:"100%", marginTop:10, fontSize:14 }}>
          Já me cadastrei — recuperar comprovante
        </Btn>
        <p style={{ textAlign:"center", fontSize:12, color:T.muted, marginTop:20, fontWeight:500 }}>
          Dúvidas: <a href="mailto:contato@ministerioalpha.com.br" style={{ color:T.blue, fontWeight:700, textDecoration:"none" }}>contato@ministerioalpha.com.br</a>
        </p>
      </div>
    </div>
  );
}

// ── SELECT COUNT ──────────────────────────────────────────────────────────────
function SelectCountScreen({ available, onSelect, onBack, bypass }) {
  return (
    <div style={{ minHeight:"100vh", background:T.bg }}>
      <Styles />
      <div style={{ background:T.blue, height:6 }} />
      <div style={{ maxWidth:460, margin:"0 auto", padding:"0 16px 32px" }}>
        <PageHeader />
        <p style={{ textAlign:"center", color:T.muted, fontSize:15, marginBottom:18, fontWeight:600 }}>
          Quantas crianças você vai cadastrar?
        </p>
        <SlotBar available={available} />
        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:14 }}>
          {[1,2].filter(n=>bypass||n<=available).map(n=>(
            <button key={n} onClick={()=>onSelect(n)} style={{
              background:T.white, border:`2px solid ${T.border}`, borderRadius:14, padding:"18px 20px",
              display:"flex", alignItems:"center", gap:16, textAlign:"left", boxShadow:T.shadow, width:"100%",
              transition:"border-color .2s, box-shadow .2s",
            }}
              onMouseEnter={e=>{e.currentTarget.style.borderColor=T.blue;e.currentTarget.style.boxShadow=T.shadowMd;}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.boxShadow=T.shadow;}}
            >
              <span style={{ fontSize:36 }}>{n===1?"👦":"👧👦"}</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:17, fontWeight:800, color:T.blue }}>{n===1?"1 criança":"2 crianças"}</div>
                <div style={{ fontSize:13, color:T.muted, marginTop:3, fontWeight:500 }}>
                  Reserva {n} vaga{n>1?"s":""} agora
                </div>
              </div>
              <span style={{ color:T.gold, fontSize:22, fontWeight:900 }}>›</span>
            </button>
          ))}
          {available===0&&!bypass&&<p style={{ textAlign:"center", color:T.red, fontSize:14, fontWeight:600 }}>Sem vagas disponíveis no momento.</p>}
        </div>
        <Btn variant="ghost" onClick={onBack} style={{ width:"100%", fontSize:14 }}>← Voltar</Btn>
        <p style={{ textAlign:"center", fontSize:12, color:T.muted, marginTop:20, fontWeight:500 }}>
          Dúvidas: <a href="mailto:contato@ministerioalpha.com.br" style={{ color:T.blue, fontWeight:700, textDecoration:"none" }}>contato@ministerioalpha.com.br</a>
        </p>
      </div>
    </div>
  );
}

// ── FORM ──────────────────────────────────────────────────────────────────────
function FormScreen({ sid, initialExpiresAt, initialCount, onSuccess, onExpired, onRecover, onBack }) {
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt);
  const [timeLeft, setTimeLeft]   = useState(CFG.TIMER_SEC);
  const [renewals, setRenewals]   = useState(0);
  const [modal, setModal]         = useState(null);
  const warned = useRef(false);
  const [adult, setAdult]   = useState({name:"",cpf:"",phone:"",dob:"",street:"",num:"",hood:""});
  const [aErr, setAErr]     = useState({});
  const [children, setCh]   = useState(Array.from({length:initialCount},()=>({name:"",dob:"",cpf:""})));
  const [cErr, setCErr]     = useState(Array.from({length:initialCount},()=>({})));
  const [resCount, setRes]  = useState(initialCount);
  const [subErr, setSubErr] = useState("");
  const [loading, setLoad]  = useState(false);
  const [cpfCheck, setCpfCheck] = useState("idle"); // idle | checking | taken | free

  useEffect(()=>{
    const tick=()=>{
      const diff=Math.max(0,Math.floor((new Date(expiresAt)-Date.now())/1000));
      setTimeLeft(diff);
      if(diff<=60&&!warned.current&&!modal){warned.current=true;setModal("warn");}
      if(diff===0&&modal!=="expired") setModal("expired");
    };
    tick(); const t=setInterval(tick,1000); return()=>clearInterval(t);
  },[expiresAt,modal]);

  const handleRenew=async()=>{
    const res=await renewReservation(sid);
    if(res.ok){setExpiresAt(res.expiresAt);setRenewals(r=>r+1);warned.current=false;setModal(null);}
    else setModal("expired");
  };

  const checkCPF=async(cpf)=>{
    setCpfCheck("checking");
    const q=query(collection(db,"registrations"),where("adult.cpf","==",cpf));
    const snap=await getDocs(q);
    setCpfCheck(snap.empty?"free":"taken");
  };
  const setA=(k,raw)=>{
    let v=raw;
    if(k==="cpf") v=maskCPF(raw); if(k==="phone") v=maskPhone(raw); if(k==="dob") v=maskDate(raw);
    setAdult(a=>({...a,[k]:v})); setAErr(e=>({...e,[k]:""}));
    if(k==="cpf"){
      setCpfCheck("idle");
      if(v.length===14&&validateCPF(v)) checkCPF(v);
    }
  };
  const setC=(i,k,raw)=>{
    let v=raw;
    if(k==="cpf") v=maskCPF(raw); if(k==="dob") v=maskDate(raw);
    setCh(c=>c.map((ch,idx)=>idx===i?{...ch,[k]:v}:ch));
    setCErr(e=>e.map((ce,idx)=>idx===i?{...ce,[k]:""}:ce));
  };
  const handleAddChild=async()=>{
    const res=await upgradeReservation(sid);
    if(res.ok){setRes(2);setCh(c=>[...c,{name:"",dob:"",cpf:""}]);setCErr(e=>[...e,{}]);}
    else setModal("addFail");
  };
  const validate=()=>{
    let ok=true; const ae={};
    if(!fullName(adult.name)){ae.name="Nome completo obrigatório";ok=false;}
    if(!validateCPF(adult.cpf)){ae.cpf="CPF inválido";ok=false;}
    if(adult.phone.replace(/\D/g,"").length<10){ae.phone="Telefone inválido";ok=false;}
    if(adult.dob.length<10){ae.dob="Data inválida";ok=false;}
    if(!adult.street.trim()){ae.street="Obrigatório";ok=false;}
    if(!adult.num.trim()){ae.num="Obrigatório";ok=false;}
    if(!adult.hood.trim()){ae.hood="Obrigatório";ok=false;}
    setAErr(ae);
    const ce=children.map(ch=>{
      const e={};
      if(!fullName(ch.name)){e.name="Nome completo obrigatório";ok=false;}
      if(ch.dob.length<10){e.dob="Data obrigatória";ok=false;}
      else{const v=validateAge(ch.dob);if(!v.ok){e.dob=v.msg;ok=false;}}
      if(ch.cpf&&!validateCPF(ch.cpf)){e.cpf="CPF inválido (ou deixe em branco)";ok=false;}
      return e;
    });
    setCErr(ce); return ok;
  };
  const handleSubmit=async()=>{
    if(!validate()) return; setLoad(true); setSubErr("");
    const res=await confirmRegistration(sid,{adult,children});
    setLoad(false);
    if(res.ok) onSuccess(res.reg); else setSubErr(res.reason);
  };

  const tc=timeLeft<=60?T.red:timeLeft<=120?T.gold:T.white;

  return (
    <div style={{ minHeight:"100vh", background:T.bg, paddingBottom:32 }}>
      <Styles />
      {/* Timer sticky */}
      <div style={{ position:"sticky", top:0, zIndex:100, background:T.blue, padding:"10px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", boxShadow:"0 2px 12px rgba(27,91,168,.4)" }} className="no-print">
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <AlphaLogo size={26} />
          <span style={{ color:"rgba(255,255,255,.8)", fontSize:13, fontWeight:600 }}>Tempo restante</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {timeLeft<=60&&<div style={{ width:8, height:8, borderRadius:"50%", background:T.red, animation:"pulse 1s infinite" }} />}
          <span style={{ fontSize:24, fontWeight:900, color:tc, fontVariantNumeric:"tabular-nums", letterSpacing:1 }}>{fmtTime(timeLeft)}</span>
        </div>
      </div>

      <div style={{ maxWidth:460, margin:"0 auto", padding:"0 16px" }}>
        <div style={{ display:"flex", alignItems:"center", padding:"12px 0 0" }}>
          <button onClick={onBack} style={{ background:"none", border:"none", padding:"6px 0", color:T.muted, fontSize:14, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", gap:4 }}>← Voltar</button>
        </div>
        <div style={{ textAlign:"center", padding:"6px 0 12px" }}>
          <h2 style={{ fontSize:20, fontWeight:800, color:T.blue }}>Cadastro</h2>
          <p style={{ color:T.muted, fontSize:13, marginTop:4, fontWeight:500 }}>Campos com * são obrigatórios</p>
        </div>

        {/* Adulto */}
        <Card style={{ marginBottom:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16, paddingBottom:12, borderBottom:`2px solid ${T.blueL}` }}>
            <div style={{ width:36, height:36, borderRadius:10, background:T.blueL, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>👤</div>
            <h2 style={{ fontSize:15, fontWeight:800, color:T.blue }}>Dados do Responsável</h2>
          </div>
          <Field label="CPF do responsável *" error={aErr.cpf}>
            <TInput value={adult.cpf} onChange={e=>setA("cpf",e.target.value)} placeholder="000.000.000-00" maxLength={14}/>
          </Field>
          {cpfCheck==="checking"&&<p style={{fontSize:12,color:T.muted,fontWeight:600,marginTop:-10,marginBottom:12}}>⏳ Verificando CPF...</p>}
          {cpfCheck==="taken"&&(
            <div style={{background:"#FFECEC",border:`1.5px solid ${T.red}`,borderRadius:10,padding:"12px 14px",marginTop:-10,marginBottom:12}}>
              <p style={{fontSize:13,color:T.red,fontWeight:800,marginBottom:4}}>⚠ CPF já cadastrado neste evento</p>
              <p style={{fontSize:12,color:T.red,fontWeight:500,lineHeight:1.5}}>Esse CPF já possui uma inscrição. Se você perdeu o comprovante, <button onClick={onRecover} style={{background:"none",border:"none",padding:0,color:T.red,fontWeight:800,fontSize:12,textDecoration:"underline",cursor:"pointer",fontFamily:"inherit"}}>clique aqui para recuperá-lo →</button></p>
            </div>
          )}
          {cpfCheck==="free"&&<p style={{fontSize:12,color:T.green,fontWeight:700,marginTop:-10,marginBottom:12}}>✅ CPF disponível</p>}
          <div style={cpfCheck!=="free"?{opacity:.35,pointerEvents:"none",userSelect:"none"}:{}}>
            <Field label="Nome completo *" error={aErr.name}><TInput value={adult.name} onChange={e=>setA("name",e.target.value)} placeholder="Nome e sobrenome"/></Field>
            <div style={{display:"flex",gap:10}}>
              <div style={{flex:1}}><Field label="Data de nasc. *" error={aErr.dob}><TInput value={adult.dob} onChange={e=>setA("dob",e.target.value)} placeholder="DD/MM/AAAA" maxLength={10}/></Field></div>
              <div style={{flex:1}}><Field label="WhatsApp *" error={aErr.phone}><TInput value={adult.phone} onChange={e=>setA("phone",e.target.value)} placeholder="(00) 00000-0000"/></Field></div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <div style={{flex:3}}><Field label="Rua *" error={aErr.street}><TInput value={adult.street} onChange={e=>setA("street",e.target.value)} placeholder="Nome da rua"/></Field></div>
              <div style={{flex:1}}><Field label="Número *" error={aErr.num}><TInput value={adult.num} onChange={e=>setA("num",e.target.value)} placeholder="Nº"/></Field></div>
            </div>
            <Field label="Bairro *" error={aErr.hood}><TInput value={adult.hood} onChange={e=>setA("hood",e.target.value)} placeholder="Bairro"/></Field>
          </div>
        </Card>

        {/* Crianças + submit — bloqueados até CPF verificado */}
        <div style={cpfCheck!=="free"?{opacity:.35,pointerEvents:"none",userSelect:"none"}:{}}>
          {children.map((ch,i)=>(
            <Card key={i} style={{ marginBottom:14 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16, paddingBottom:12, borderBottom:`2px solid ${T.blueL}` }}>
                <div style={{ width:36, height:36, borderRadius:10, background:T.goldL, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>🍫</div>
                <h2 style={{ fontSize:15, fontWeight:800, color:T.blue }}>{children.length>1?`Criança ${i+1}`:"Dados da Criança"}</h2>
              </div>
              <Field label="Nome completo *" error={cErr[i]?.name}><TInput value={ch.name} onChange={e=>setC(i,"name",e.target.value)} placeholder="Nome e sobrenome" /></Field>
              <div style={{ display:"flex", gap:10 }}>
                <div style={{ flex:1 }}><Field label="Data de nasc. *" error={cErr[i]?.dob} hint="Idade: 3 a 12 anos"><TInput value={ch.dob} onChange={e=>setC(i,"dob",e.target.value)} placeholder="DD/MM/AAAA" maxLength={10} /></Field></div>
                <div style={{ flex:1 }}><Field label="CPF (opcional)" error={cErr[i]?.cpf}><TInput value={ch.cpf} onChange={e=>setC(i,"cpf",e.target.value)} placeholder="000.000.000-00" maxLength={14} /></Field></div>
              </div>
            </Card>
          ))}
          {resCount===1&&(
            <button onClick={handleAddChild} style={{ width:"100%", marginBottom:14, background:T.blueL, border:`2px dashed ${T.blue}`, borderRadius:12, padding:"13px 20px", fontSize:14, fontWeight:700, color:T.blue, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
              + Adicionar segunda criança
            </button>
          )}
          {subErr&&<div style={{ background:"#FFECEC", border:`1px solid ${T.red}`, borderRadius:10, padding:"12px 14px", marginBottom:14, color:T.red, fontSize:14, fontWeight:600 }}>⚠ {subErr}</div>}
          <Btn onClick={handleSubmit} disabled={loading||cpfCheck!=="free"} style={{ width:"100%", fontSize:15, padding:"16px", borderRadius:12 }}>
            {loading?"Confirmando...":"Confirmar Cadastro 🎉"}
          </Btn>
          <p style={{ textAlign:"center", fontSize:12, color:T.muted, marginTop:10, fontWeight:500 }}>
            Ao confirmar, suas vagas são efetivadas imediatamente
          </p>
        </div>
      </div>

      <Modal show={modal==="warn"} icon="⏳" title="Tempo quase esgotando!"
        body={renewals<CFG.MAX_RENEWALS?"Você tem menos de 1 minuto. Deseja renovar por mais 5 minutos? Só é permitido renovar uma vez.":"Você já renovou uma vez. Conclua o cadastro agora!"}
        actions={renewals<CFG.MAX_RENEWALS?[
          <Btn key="r" onClick={handleRenew} style={{width:"100%"}}>Sim, renovar por +5 min</Btn>,
          <Btn key="c" variant="ghost" onClick={()=>setModal(null)} style={{width:"100%",fontSize:14}}>Continuar sem renovar</Btn>,
        ]:[<Btn key="ok" onClick={()=>setModal(null)} style={{width:"100%"}}>Entendido, terminar agora</Btn>]}
      />
      <Modal show={modal==="expired"} icon="⌛" title="Tempo esgotado"
        body="Sua reserva expirou e as vagas foram liberadas. Você precisará iniciar um novo cadastro."
        actions={[<Btn key="x" variant="danger" onClick={onExpired} style={{width:"100%"}}>Iniciar novo cadastro</Btn>]}
      />
      <Modal show={modal==="addFail"} icon="😔" title="Não foi possível adicionar"
        body="Não há vagas disponíveis para uma segunda criança no momento."
        actions={[<Btn key="ok" variant="ghost" onClick={()=>setModal(null)} style={{width:"100%"}}>Ok, entendi</Btn>]}
      />
    </div>
  );
}

// ── GERADOR DE PDF ────────────────────────────────────────────────────────────
async function urlToDataURL(url) {
  const blob = await fetch(url).then(r => r.blob());
  return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}
async function generatePDF(reg) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation:"portrait", unit:"mm", format:"a5" });
  const W = doc.internal.pageSize.getWidth();
  const blue=[27,91,168], gold=[240,165,0], white=[255,255,255];
  const dark=[26,42,58], muted=[90,106,122], bg=[244,247,252], bord=[200,216,236];
  const goldL=[255,246,224], goldD=[200,133,10];
  let y=0;

  // Barra azul + faixa gold no topo
  doc.setFillColor(...blue); doc.rect(0,0,W,30,'F');
  doc.setFillColor(...gold); doc.rect(0,0,W,2,'F');

  doc.setTextColor(...gold); doc.setFont("helvetica","bold"); doc.setFontSize(8);
  doc.text("ACAO SOCIAL DE PASCOA",W/2,11,{align:"center"});
  doc.setTextColor(...white); doc.setFontSize(13);
  doc.text("Ministerio Alpha",W/2,19,{align:"center"});
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.text("A Igreja da Familia",W/2,25,{align:"center"});
  y=36;

  // Box do evento
  doc.setFillColor(...bg); doc.rect(8,y,W-16,22,'F');
  doc.setDrawColor(...bord); doc.rect(8,y,W-16,22,'S');
  doc.setTextColor(...dark); doc.setFont("helvetica","bold"); doc.setFontSize(10);
  doc.text(`${CFG.EVENT_DAY_LABEL}, ${CFG.EVENT_DATE_LABEL}`,W/2,y+8,{align:"center"});
  // doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(...muted);
  doc.text(CFG.EVENT_TIME_LABEL,W/2,y+14,{align:"center"});
  doc.text(CFG.ADDRESS_LABEL,W/2,y+20,{align:"center"});
  y=64;

  // Separador tracejado
  const dash=()=>{ doc.setLineDashPattern([2,2],0); doc.setDrawColor(...bord); doc.line(8,y,W-8,y); doc.setLineDashPattern([],0); };
  dash(); y+=7;

  // Responsável
  doc.setTextColor(...muted); doc.setFont("helvetica","bold"); doc.setFontSize(7);
  doc.text("RESPONSAVEL",10,y); doc.text("CODIGO",W-38,y);
  y+=5;
  doc.setTextColor(...dark); doc.setFont("helvetica","bold"); doc.setFontSize(11);
  doc.text(reg.adult.name,10,y);
  doc.setTextColor(...blue); doc.setFontSize(14);
  doc.text(reg.regId,W-10,y,{align:"right"});
  y+=5; doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(...muted);
  doc.text(reg.adult.cpf,10,y); y+=5;
  doc.text(reg.adult.phone,10,y); y+=8;
  dash(); y+=7;

  // Crianças
  doc.setTextColor(...muted); doc.setFont("helvetica","bold"); doc.setFontSize(7);
  doc.text(reg.children.length>1?"CRIANCAS INSCRITAS":"CRIANCA INSCRITA",10,y);
  y+=5;
  reg.children.forEach((ch,i)=>{
    doc.setFillColor(...goldL); doc.rect(10,y-4,W-20,9,'F');
    doc.setDrawColor(...gold); doc.rect(10,y-4,W-20,9,'S');
    doc.setTextColor(...goldD); doc.setFont("helvetica","bold"); doc.setFontSize(10);
    doc.text(ch.name,14,y+1);
    doc.text(`Pulseira #${reg.childNumbers[i]}`,W-14,y+1,{align:"right"});
    y+=11;
  });
  y+=4; dash(); y+=8;

  // QR Code
  try {
    const qrUrl=`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(reg.regId)}&color=1B5BA8&bgcolor=F4F7FC`;
    const qrData=await urlToDataURL(qrUrl);
    const sz=36; doc.addImage(qrData,"PNG",(W-sz)/2,y,sz,sz); y+=sz+5;
  } catch { y+=5; }
  doc.setTextColor(...muted); doc.setFont("helvetica","normal"); doc.setFontSize(8);
  doc.text(`Apresente o QR Code ou o codigo ${reg.regId} na entrada`,W/2,y,{align:"center"});
  y+=5;
  doc.text(CFG.ORG_LABEL+" - "+CFG.ORG_SUBTITLE,W/2,y,{align:"center"});

  doc.save(`comprovante-pascoa-${reg.regId}.pdf`);
}

// ── CONFIRMAÇÃO ───────────────────────────────────────────────────────────────
function ConfirmationScreen({ reg, onClear }) {
  const [pdfLoading,setPdfLoading]=useState(false);
  const handlePDF=async()=>{ setPdfLoading(true); try{ await generatePDF(reg); }finally{ setPdfLoading(false); } };
  const qrUrl=`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(reg.regId)}&color=1B5BA8&bgcolor=F4F7FC`;

  return (
    <div style={{ minHeight:"100vh", background:T.bg, paddingBottom:32 }}>
      <Styles />
      <div style={{ background:T.blue, height:6 }} />
      <div style={{ maxWidth: 460, margin: "0 auto", padding: "0 16px" }}>
        <PageHeader />
        {/* Cabeçalho */}
        <div style={{ textAlign:"center", padding:"0 0 12px" }} className="no-print">
          {/* <div style={{ width:64, height:64, borderRadius:"50%", background:T.greenL, border:`3px solid ${T.green}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:30, margin:"0 auto 12px", animation:"pop .4s ease" }}>✅</div> */}
          <h1 style={{ fontSize:22, fontWeight:900, color:T.green }}>Cadastro confirmado!</h1>
          <p style={{ color:T.muted, fontSize:14, marginTop:5, fontWeight:500 }}>Salve seu comprovante abaixo</p>
        </div>

        {/* Ticket */}
        <div className="ticket" style={{ borderRadius:18, overflow:"hidden", boxShadow:T.shadowMd, animation:"fadeUp .5s ease" }}>
          {/* Header do ticket */}
          <div style={{ background:`linear-gradient(135deg,${T.blue},${T.blueD})`, borderRadius:16, padding:"18px 20px", marginBottom:14, boxShadow:T.shadowMd }}>
            <p style={{ color:T.gold, fontSize:11, fontWeight:800, letterSpacing:2, textTransform:"uppercase" }}>Ação Social de Páscoa</p>
            <h2 style={{ color:T.white, fontSize:20, fontWeight:800, margin:"4px 0 6px", lineHeight:1.3 }}>Distribuição de 1 CAIXA DE BOMBOM para crianças de 3 a 12 anos, moradores do RP, Gardênia e Araticum</h2>
            <div style={{ display:"flex", gap:14, flexWrap:"wrap" }}>
              <p style={{ color:"rgba(255,255,255,.8)", fontSize:13, fontWeight:600 }}>📅 {CFG.EVENT_DAY_LABEL}, {CFG.EVENT_DATE_LABEL}</p>
              <p style={{ color:"rgba(255,255,255,.8)", fontSize:13, fontWeight:600 }}>🕘 {CFG.EVENT_TIME_LABEL}</p>
              <p style={{ color:"rgba(255,255,255,.8)", fontSize:13, fontWeight:600 }}>📍 {CFG.ADDRESS_LABEL}</p>
            </div>
          </div>

          {/* Linha pontilhada */}
          <div style={{ background:`repeating-linear-gradient(90deg,${T.blueL} 0,${T.blueL} 8px,transparent 8px,transparent 16px)`, height:2 }} />

          {/* Dados responsável */}
          <div style={{ background:T.white, padding:"16px 22px", borderBottom:`1.5px solid ${T.border}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:8 }}>
              <div>
                <p style={{ color:T.muted, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:.5 }}>Responsável</p>
                <p style={{ fontSize:16, fontWeight:800, color:T.text, marginTop:3 }}>{reg.adult.name}</p>
                <p style={{ fontSize:13, color:T.muted, fontWeight:500, marginTop:2 }}>{reg.adult.cpf}</p>
                <p style={{ fontSize:13, color:T.muted, fontWeight:500, marginTop:2 }}>{reg.adult.phone}</p>
              </div>
              <div style={{ textAlign:"right" }}>
                <p style={{ color:T.muted, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:.5 }}>Código</p>
                <p style={{ fontSize:22, fontWeight:900, color:T.blue, marginTop:3, letterSpacing:1 }}>{reg.regId}</p>
              </div>
            </div>
          </div>

          {/* Crianças */}
          <div style={{ background:T.white, padding:"14px 22px", borderBottom:`1.5px solid ${T.border}` }}>
            <p style={{ color:T.muted, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:.5, marginBottom:10 }}>
              {reg.children.length>1?"Crianças inscritas":"Criança inscrita"}
            </p>
            {reg.children.map((ch,i)=>(
              <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                <p style={{ fontSize:14, fontWeight:700, color:T.text }}>🍫 {ch.name}</p>
                <div style={{ background:T.gold, color:T.white, borderRadius:8, padding:"4px 12px", fontSize:12, fontWeight:800 }}>
                  Pulseira #{reg.childNumbers[i]}
                </div>
              </div>
            ))}
          </div>

          {/* QR Code */}
          <div style={{ background:T.blueL, padding:"18px 22px", display:"flex", justifyContent:"center", alignItems:"center", gap:16, flexWrap:"wrap" }}>
            <div style={{ background:T.white, borderRadius:12, padding:10, boxShadow:T.shadow }}>
              <img src={qrUrl} alt="QR Code" width={130} height={130} style={{ display:"block", borderRadius:6 }} onError={e=>e.target.style.display="none"} />
              <p style={{ textAlign:"center", fontSize:11, color:T.muted, marginTop:6, fontWeight:800, letterSpacing:1 }}>{reg.regId}</p>
            </div>
            <div style={{ fontSize:13, color:T.blue, lineHeight:1.7, maxWidth:160, fontWeight:600 }}>
              <p>📲 Apresente o QR Code ou o código <strong style={{color:T.blue}}>{reg.regId}</strong> na entrada do evento.</p>
              <p style={{ marginTop:8, color:T.muted, fontWeight:500, fontSize:12 }}>
                {CFG.ORG_LABEL}<br />{CFG.ORG_SUBTITLE}
              </p>
            </div>
          </div>
        </div>

        {/* Ações */}
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginTop:16 }} className="no-print">
          <Btn variant="outline" onClick={handlePDF} disabled={pdfLoading} style={{width:"100%",fontSize:15}}>
            <span>📄</span> {pdfLoading?"Gerando PDF...":"Baixar comprovante em PDF"}
          </Btn>
          <button onClick={onClear} style={{ background:"none", border:"none", color:T.text, fontSize:11, marginTop:2 }}>
            Voltar para o início
          </button>
          <p style={{ textAlign:"center", fontSize:12, color:T.muted, marginTop:14, fontWeight:500 }}>
            Dúvidas: <a href="mailto:contato@ministerioalpha.com.br" style={{ color:T.blue, fontWeight:700, textDecoration:"none" }}>contato@ministerioalpha.com.br</a>
          </p>
        </div>
      </div>
    </div>
  );
}

// ── RECUPERAR INSCRIÇÃO ───────────────────────────────────────────────────────
function RecoverScreen({ onFound, onBack }) {
  const [cpf,setCpf]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const handle=async()=>{
    if(cpf.replace(/\D/g,"").length!==11){setError("CPF inválido");return;}
    setLoading(true); setError("");
    const reg=await findRegByCPF(cpf);
    setLoading(false);
    if(reg) onFound(reg);
    else setError("Nenhuma inscrição encontrada para esse CPF.");
  };
  return (
    <div style={{minHeight:"100vh",background:T.bg}}><Styles />
      <div style={{background:T.blue,height:6}}/>
      <div style={{maxWidth:460,margin:"0 auto",padding:"0 16px 32px"}}>
        <PageHeader/>
        <Card>
          <h2 style={{fontSize:16,fontWeight:800,color:T.blue,marginBottom:6}}>Recuperar inscrição</h2>
          <p style={{fontSize:13,color:T.muted,fontWeight:500,marginBottom:18,lineHeight:1.6}}>Digite o CPF do adulto responsável que foi usado no cadastro.</p>
          <label style={{fontSize:13,fontWeight:700,color:T.text,display:"block",marginBottom:6}}>CPF do responsável</label>
          <input
            value={cpf} placeholder="000.000.000-00"
            onChange={e=>{setCpf(maskCPF(e.target.value));setError("");}}
            onKeyDown={e=>e.key==="Enter"&&handle()}
            style={{width:"100%",boxSizing:"border-box",border:`1.5px solid ${error?T.red:T.border}`,borderRadius:10,padding:"12px 14px",fontSize:15,fontFamily:"Montserrat,sans-serif",outline:"none",marginBottom:error?6:16}}
          />
          {error&&<p style={{fontSize:13,color:T.red,fontWeight:600,marginBottom:12}}>{error}</p>}
          <Btn onClick={handle} disabled={loading} style={{width:"100%",marginBottom:10}}>
            {loading?"Buscando...":"Buscar minha inscrição →"}
          </Btn>
          <Btn variant="ghost" onClick={onBack} style={{width:"100%",fontSize:13}}>Voltar</Btn>
        </Card>
      </div>
    </div>
  );
}

// ── LISTA DE ESPERA ───────────────────────────────────────────────────────────
function WaitlistScreen() {
  const [name,setName]=useState(""); const [phone,setPhone]=useState("");
  const [errors,setErrors]=useState({}); const [pos,setPos]=useState(null);
  const submit=async()=>{
    const e={};
    if(!fullName(name)) e.name="Nome completo obrigatório";
    if(phone.replace(/\D/g,"").length<10) e.phone="WhatsApp inválido";
    if(Object.keys(e).length){setErrors(e);return;}
    setPos(await addWaitlist(name,phone));
  };
  if(pos) return (
    <div style={{minHeight:"100vh",background:T.bg}}><Styles />
      <div style={{background:T.blue,height:6}}/>
      <div style={{maxWidth:460,margin:"0 auto",padding:"0 16px"}}><PageHeader />
        <Card style={{textAlign:"center",padding:32}}>
          <div style={{fontSize:40,marginBottom:12}}>🍫</div>
          <h2 style={{fontSize:20,fontWeight:800,color:T.blue,marginBottom:10}}>Você está na lista de espera!</h2>
          <p style={{ color: T.muted, fontSize: 14, lineHeight: 1.65, fontWeight: 500 }}>
            {/* Você é o <strong style={{ color: T.blue }}>#{pos}º</strong> na lista de espera.<br /> */}
            Entraremos em contato pelo <br/><strong>{phone}</strong> se uma vaga for liberada.</p>
          <p style={{ color: T.red, fontSize: 14, lineHeight: 1.65, fontWeight: 500 }}><br/><strong>IMPORTANTE!</strong><br/> Não comparecer no dia do evento sem a confirmação e inscrição prévia. <br/>Agradecemos a compreensão!</p>
        </Card>
      </div>
    </div> 
  );
  return (
    <div style={{minHeight:"100vh",background:T.bg}}><Styles />
      <div style={{background:T.blue,height:6}}/>
      <div style={{maxWidth:460,margin:"0 auto",padding:"0 16px 32px"}}><PageHeader />
        <Card style={{textAlign:"center",marginBottom:14,padding:"20px"}}>
          <div style={{fontSize:36,marginBottom:8}}>😔</div>
          <h2 style={{fontSize:18,fontWeight:800,color:T.blue,marginBottom:8}}>Vagas esgotadas</h2>
          <p style={{ color: T.muted, fontSize: 14, lineHeight: 1.65, fontWeight: 500 }}>Todas as {CFG.MAX_SLOTS} vagas foram preenchidas. Cadastre-se na lista de espera e avisaremos pelo WhatsApp se uma vaga for liberada.</p>
          <p style={{ color: T.red, fontSize: 14, lineHeight: 1.65, fontWeight: 500 }}><br/><strong>IMPORTANTE!</strong><br/> Não comparecer no dia do evento sem a confirmação e inscrição prévia. Agradecemos a compreensão!</p>
        </Card>
        <Card>
          <Field label="Nome completo" error={errors.name}><TInput value={name} onChange={e=>setName(e.target.value)} placeholder="Nome e sobrenome"/></Field>
          <Field label="WhatsApp" error={errors.phone}><TInput value={phone} onChange={e=>setPhone(maskPhone(e.target.value))} placeholder="(00) 00000-0000"/></Field>
          <Btn onClick={submit} style={{width:"100%"}}>Entrar na lista de espera</Btn>
        </Card>
      </div>
    </div>
  );
}

// ── CAMERA SCANNER ────────────────────────────────────────────────────────────
function CameraScanner({ onScan, onClose }) {
  const videoRef=useRef(null);
  const streamRef=useRef(null);
  const rafRef=useRef(null);
  const [err,setErr]=useState("");
  const supported="BarcodeDetector" in window;
  useEffect(()=>{
    if(!supported) return;
    let active=true;
    const detector=new window.BarcodeDetector({formats:["qr_code"]});
    const stop=()=>{
      active=false;
      if(rafRef.current) cancelAnimationFrame(rafRef.current);
      if(streamRef.current) streamRef.current.getTracks().forEach(t=>t.stop());
    };
    navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}})
      .then(stream=>{
        streamRef.current=stream;
        if(!videoRef.current){stop();return;}
        videoRef.current.srcObject=stream;
        videoRef.current.play();
        const tick=async()=>{
          if(!active||!videoRef.current) return;
          try{
            const codes=await detector.detect(videoRef.current);
            if(codes.length>0){stop();onScan(codes[0].rawValue.trim().toUpperCase());return;}
          }catch{}
          rafRef.current=requestAnimationFrame(tick);
        };
        rafRef.current=requestAnimationFrame(tick);
      })
      .catch(e=>setErr(e.name==="NotAllowedError"?"Permissão de câmera negada.":"Câmera indisponível: "+e.message));
    return stop;
  },[]);// eslint-disable-line react-hooks/exhaustive-deps
  if(!supported) return (
    <div style={{background:"#FFF3CD",border:`1px solid ${T.gold}`,borderRadius:10,padding:"12px 14px",marginBottom:14,fontSize:13,color:T.goldD,fontWeight:600}}>
      Seu navegador não suporta scanner automático. Use o campo manual abaixo.
    </div>
  );
  return (
    <div style={{marginBottom:14,borderRadius:12,overflow:"hidden",position:"relative",background:"#000",minHeight:220}}>
      <video ref={videoRef} playsInline muted style={{width:"100%",display:"block",maxHeight:280,objectFit:"cover"}}/>
      <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
        <div style={{width:180,height:180,border:`3px solid ${T.gold}`,borderRadius:16,boxShadow:"0 0 0 2000px rgba(0,0,0,.5)"}}/>
      </div>
      <p style={{position:"absolute",bottom:44,left:0,right:0,textAlign:"center",color:"rgba(255,255,255,.8)",fontSize:12,fontWeight:600}}>Aponte para o QR Code do comprovante</p>
      <button onClick={onClose} style={{position:"absolute",bottom:10,left:"50%",transform:"translateX(-50%)",background:"rgba(0,0,0,.6)",border:"none",color:"#fff",borderRadius:8,padding:"7px 18px",fontSize:13,cursor:"pointer",fontFamily:"Montserrat,sans-serif",fontWeight:700}}>✕ Fechar câmera</button>
      {err&&<p style={{position:"absolute",top:8,left:8,right:8,textAlign:"center",color:T.red,background:"rgba(255,255,255,.9)",borderRadius:6,padding:6,fontSize:12,fontWeight:700}}>{err}</p>}
    </div>
  );
}

// ── ADMIN ─────────────────────────────────────────────────────────────────────
function AdminScreen({ onBack }) {
  const [role,setRole]=useState(null); // null | "admin" | "superadmin"
  const [pwd,setPwd]=useState(""); const [pwdErr,setPwdErr]=useState("");
  const [stats,setStats]=useState({confirmed:0,reserved:0,available:CFG.MAX_SLOTS,registrationClosed:false,waitlist:0,regs:[],waitlistItems:[]});
  const [search,setSearch]=useState(""); const [filter,setFilter]=useState("all");
  const [ciSearch,setCiSearch]=useState("");
  const [scanRes,setScanRes]=useState(null);
  const [tab,setTab]=useState("checkin"); const [scanning,setScanning]=useState(false);
  const [cancelCIModal,setCancelCIModal]=useState({show:false,regId:null,name:""});
  const [deleteRegModal,setDeleteRegModal]=useState({show:false,regId:null,name:"",count:0});
  const [deleteWaitModal,setDeleteWaitModal]=useState({show:false,id:null,name:""});
  const [clearWaitModal,setClearWaitModal]=useState(false);
  const [promoteModal,setPromoteModal]=useState({show:false,link:"",name:""});
  const [promoteLoading,setPromoteLoading]=useState(null);
  const [slotLoading,setSlotLoading]=useState(false);
  const refresh=async()=>setStats(await getAllStats());
  useEffect(()=>{if(role)refresh();},[role]);
  const handleCI=async(regId)=>{await doCheckIn(regId);refresh();if(scanRes?.reg?.regId===regId)setScanRes(r=>({...r,reg:{...r.reg,checkedIn:true,checkedInAt:new Date().toISOString()}}));};
  const handleCancelCI=async()=>{await doCancelCheckIn(cancelCIModal.regId);refresh();setCancelCIModal({show:false,regId:null,name:""});if(scanRes?.reg?.regId===cancelCIModal.regId)setScanRes(r=>({...r,reg:{...r.reg,checkedIn:false,checkedInAt:null}}));};
  const handlePromote=async(item)=>{
    setPromoteLoading(item.phone);
    const token=await createBypassToken(item.name,item.phone);
    const link=`${window.location.origin}${window.location.pathname}?t=${token}`;
    setPromoteLoading(null);
    setPromoteModal({show:true,link,name:item.name});
  };
  const handleDeleteReg=async()=>{await deleteRegistrationDoc(deleteRegModal.regId,deleteRegModal.count);refresh();setDeleteRegModal({show:false,regId:null,name:"",count:0});};
  const handleDeleteWait=async()=>{await deleteWaitlistDoc(deleteWaitModal.id);refresh();setDeleteWaitModal({show:false,id:null,name:""});};
  const handleClearWait=async()=>{await Promise.all(stats.waitlistItems.map(w=>deleteWaitlistDoc(w._id)));refresh();setClearWaitModal(false);};
  const handleAdjustSlots=async(delta)=>{setSlotLoading(true);await adjustAvailableSlots(delta);await refresh();setSlotLoading(false);};
  const scanCode=(id)=>{const reg=stats.regs.find(r=>r.regId===id);setScanRes(reg?{found:true,reg}:{found:false});};
  const normStr=s=>s.replace(/\D/g,"");
  const matchReg=(r,q)=>{
    const ql=q.toLowerCase(); const qd=normStr(q);
    return r.adult.name.toLowerCase().includes(ql)||r.regId.toLowerCase().includes(ql)||
      r.adult.cpf.includes(ql)||(qd.length>=3&&normStr(r.adult.cpf).includes(qd))||
      (qd.length>=3&&normStr(r.adult.phone).includes(qd));
  };
  const searchActive=search.trim().length>=3;
  const filtered=stats.regs.filter(r=>{
    if(searchActive&&!matchReg(r,search.trim())) return false;
    if(filter==="done") return r.checkedIn; if(filter==="pending") return !r.checkedIn; return true;
  });
  const ciActive=ciSearch.trim().length>=3;
  const ciFiltered=ciActive?stats.regs.filter(r=>matchReg(r,ciSearch.trim())):[];
  if(!role) return (
    <div style={{minHeight:"100vh",background:T.bg}}><Styles />
      <div style={{background:T.blue,height:6}}/>
      <div style={{maxWidth:400,margin:"0 auto",padding:"0 16px"}}><PageHeader />
        <Card>
          <h2 style={{fontSize:16,fontWeight:800,color:T.blue,marginBottom:16,textTransform:"uppercase",letterSpacing:.5}}>Acesso administrativo</h2>
          <Field label="Senha" error={pwdErr}><TInput type="password" value={pwd} onChange={e=>setPwd(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){if(pwd===CFG.ADMIN_PWD)setRole("admin");else if(pwd===CFG.SUPERADMIN_PWD)setRole("superadmin");else setPwdErr("Senha incorreta");}}} placeholder="••••••••"/></Field>
          <Btn onClick={()=>{if(pwd===CFG.ADMIN_PWD)setRole("admin");else if(pwd===CFG.SUPERADMIN_PWD)setRole("superadmin");else setPwdErr("Senha incorreta");}} style={{width:"100%",marginBottom:10}}>Entrar</Btn>
          <Btn variant="ghost" onClick={onBack} style={{width:"100%",fontSize:14}}>← Voltar</Btn>
        </Card>
      </div>
    </div>
  );
  const TabBtn=({id,label})=><button onClick={()=>setTab(id)} style={{flex:1,border:"none",borderRadius:9,padding:"10px",fontSize:13,fontWeight:700,fontFamily:"'Montserrat',sans-serif",background:tab===id?T.blue:T.blueL,color:tab===id?T.white:T.blue}}>{label}</button>;
  return (
    <div style={{minHeight:"100vh",background:T.bg,paddingBottom:32}}><Styles />
      <div style={{background:T.blue,padding:"10px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{color:T.white,fontSize:14,fontWeight:800}}>Admin · Páscoa 2026</span>
          {role==="superadmin"&&<span style={{background:T.gold,color:"#000",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:900,letterSpacing:.5}}>SUPER</span>}
        </div>
        <div style={{display:"flex",gap:8}}><Btn variant="ghost" onClick={refresh} style={{padding:"7px 12px",fontSize:12}}>🔄</Btn><Btn variant="ghost" onClick={onBack} style={{padding:"7px 12px",fontSize:12}}>← Sair</Btn></div>
      </div>
      <PageHeader />
      <div style={{maxWidth:600,margin:"0 auto",padding:"16px 16px 0"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:16}}>
          {[["✅",stats.confirmed,T.green,"confirmados"],["🎫",stats.available,T.blue,"disponíveis"],["⏳",stats.reserved,T.gold,"no form"],["📋",stats.waitlist,T.muted,"espera"]].map(([e,v,c,l])=>(
            <div key={l} style={{background:T.white,borderRadius:12,padding:"12px 8px",textAlign:"center",boxShadow:T.shadow}}>
              <div style={{fontSize:16}}>{e}</div>
              <div style={{fontSize:24,fontWeight:900,color:c}}>{v}</div>
              <div style={{fontSize:10,color:T.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:.5}}>{l}</div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
          <TabBtn id="checkin" label="Check-in"/>
          <TabBtn id="list" label={`Lista (${stats.regs.length})`}/>
          <TabBtn id="waitlist" label={`Espera (${stats.waitlist})`}/>
          {role==="superadmin"&&<TabBtn id="super" label="⚙️ Config"/>}
        </div>

        {tab==="checkin"&&(
          <Card style={{marginBottom:14}}>
            <Btn onClick={()=>setScanning(s=>!s)} style={{width:"100%",marginBottom:12,background:scanning?T.red:T.blue,fontSize:14}}>
              {scanning?"✕ Fechar câmera":"📷 Escanear QR Code"}
            </Btn>
            {scanning&&<CameraScanner onScan={code=>{setScanning(false);scanCode(code);}} onClose={()=>setScanning(false)}/>}
            {scanRes&&(
              <div style={{marginBottom:14,padding:"14px 16px",borderRadius:12,background:scanRes.found?T.greenL:"#FFECEC",border:`1px solid ${scanRes.found?T.green:T.red}`}}>
                {scanRes.found?(
                  <div>
                    <p style={{fontWeight:800,color:T.green,fontSize:14}}>✅ {scanRes.reg.regId}</p>
                    <p style={{fontSize:16,color:T.text,marginTop:4,fontWeight:800}}>{scanRes.reg.adult.name}</p>
                    <p style={{fontSize:13,color:T.muted,fontWeight:500,marginTop:2}}>{scanRes.reg.adult.phone}</p>
                    {scanRes.reg.children.map((c,i)=>(<p key={i} style={{fontSize:13,color:T.text,marginTop:3,fontWeight:600}}>🍫 {c.name} <span style={{color:T.gold,fontWeight:800}}>Pulseira #{scanRes.reg.childNumbers[i]}</span></p>))}
                    {!scanRes.reg.checkedIn?(
                      <Btn variant="green" onClick={()=>handleCI(scanRes.reg.regId)} style={{width:"100%",marginTop:14,fontSize:17,padding:"16px",fontWeight:900,letterSpacing:.5}}>FAZER CHECK-IN ✅</Btn>
                    ):(
                      <p style={{color:T.green,fontSize:13,marginTop:10,fontWeight:700}}>✅ Entrada registrada às {new Date(scanRes.reg.checkedInAt).toLocaleTimeString("pt-BR")}</p>
                    )}
                  </div>
                ):(
                  <p style={{color:T.red,fontSize:14,fontWeight:700}}>Código não encontrado</p>
                )}
              </div>
            )}
            <input
              placeholder="Buscar por nome, CPF, código, telefone..."
              value={ciSearch} onChange={e=>{setCiSearch(e.target.value);setScanRes(null);}}
              style={{width:"100%",boxSizing:"border-box",padding:"11px 13px",borderRadius:9,border:`1.5px solid ${T.border}`,fontSize:14,fontFamily:"'Montserrat',sans-serif",marginBottom:8}}
            />
            {ciSearch.trim().length>0&&ciSearch.trim().length<3&&(
              <p style={{textAlign:"center",color:T.muted,padding:"12px 0",fontSize:13,fontWeight:500}}>Continue digitando...</p>
            )}
            {ciActive&&ciFiltered.length===0&&(
              <p style={{textAlign:"center",color:T.muted,padding:"12px 0",fontSize:14,fontWeight:500}}>Nenhum resultado</p>
            )}
            {ciFiltered.map(r=>(
              <div key={r.regId} style={{borderBottom:`1px solid ${T.border}`,padding:"12px 0"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginBottom:4}}>
                  <div>
                    <p style={{fontWeight:800,fontSize:14,color:T.text}}>{r.adult.name}</p>
                    <p style={{fontSize:12,color:T.muted,fontWeight:500}}>{r.adult.phone} · <span style={{color:T.blue,fontWeight:700}}>{r.regId}</span></p>
                    {r.children.map((ch,i)=>(<p key={i} style={{fontSize:12,color:T.text,marginTop:2,fontWeight:600}}>🍫 {ch.name} <span style={{color:T.gold,fontWeight:800}}>#{r.childNumbers[i]}</span></p>))}
                  </div>
                  {r.checkedIn?<span style={{background:T.greenL,color:T.green,borderRadius:8,padding:"4px 10px",fontSize:11,fontWeight:800,whiteSpace:"nowrap"}}>✅ FEITO</span>:null}
                </div>
                {!r.checkedIn&&<Btn variant="green" onClick={()=>handleCI(r.regId)} style={{width:"100%",fontSize:15,padding:"12px",fontWeight:900,letterSpacing:.5}}>FAZER CHECK-IN ✅</Btn>}
                {r.checkedIn&&<button onClick={()=>setCancelCIModal({show:true,regId:r.regId,name:r.adult.name})} style={{background:"none",border:"none",padding:"4px 0",color:T.muted,fontSize:11,fontWeight:600,textDecoration:"underline",cursor:"pointer"}}>Cancelar check-in</button>}
              </div>
            ))}
          </Card>
        )}

        {tab==="list"&&(
          <Card>
            <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
              <input placeholder="Nome, CPF, código, telefone..." value={search} onChange={e=>setSearch(e.target.value)} style={{flex:1,minWidth:160,padding:"10px 13px",borderRadius:9,border:`1.5px solid ${T.border}`,fontSize:13,fontFamily:"'Montserrat',sans-serif"}}/>
              <select value={filter} onChange={e=>setFilter(e.target.value)} style={{padding:"10px 12px",borderRadius:9,border:`1.5px solid ${T.border}`,fontSize:13,fontFamily:"'Montserrat',sans-serif",background:T.white,color:T.text}}>
                <option value="all">Todos</option><option value="pending">Sem check-in</option><option value="done">Check-in feito</option>
              </select>
            </div>
            {search.trim().length>0&&search.trim().length<3&&(
              <p style={{fontSize:12,color:T.muted,marginBottom:8,fontWeight:500}}>Continue digitando...</p>
            )}
            <p style={{fontSize:12,color:T.muted,marginBottom:10,fontWeight:600}}>{filtered.length} registro(s)</p>
            {filtered.length===0&&<p style={{textAlign:"center",color:T.muted,padding:20,fontSize:14,fontWeight:500}}>Nenhum registro encontrado</p>}
            {filtered.map(reg=>(
              <div key={reg.regId} style={{borderBottom:`1px solid ${T.border}`,padding:"12px 0",display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                <div style={{flex:1}}>
                  <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",marginBottom:3}}>
                    <span style={{fontWeight:700,fontSize:14,color:T.text}}>{reg.adult.name}</span>
                    <span style={{background:T.blueL,color:T.blue,borderRadius:6,padding:"2px 7px",fontSize:11,fontWeight:800}}>{reg.regId}</span>
                    {reg.checkedIn&&<span style={{background:T.greenL,color:T.green,borderRadius:6,padding:"2px 7px",fontSize:11,fontWeight:800}}>✅ CHECK-IN</span>}
                  </div>
                  <p style={{color:T.muted,fontSize:12,fontWeight:500}}>{reg.adult.phone} · {reg.adult.hood}</p>
                  {reg.children.map((ch,i)=>(<p key={i} style={{fontSize:13,color:T.text,marginTop:3,fontWeight:600}}>🍫 {ch.name} <span style={{color:T.gold,fontWeight:800}}>#{reg.childNumbers[i]}</span></p>))}
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>
                  {!reg.checkedIn&&(<Btn variant="green" onClick={()=>handleCI(reg.regId)} style={{padding:"7px 12px",fontSize:12,whiteSpace:"nowrap"}}>Check-in</Btn>)}
                  {reg.checkedIn&&(<button onClick={()=>setCancelCIModal({show:true,regId:reg.regId,name:reg.adult.name})} style={{background:"none",border:`1px solid ${T.border}`,borderRadius:7,padding:"5px 10px",color:T.muted,fontSize:11,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>↩ Cancelar</button>)}
                  {role==="superadmin"&&(<button onClick={()=>setDeleteRegModal({show:true,regId:reg.regId,name:reg.adult.name,count:reg.children.length})} style={{background:"none",border:`1px solid ${T.red}`,borderRadius:7,padding:"5px 10px",color:T.red,fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>🗑 Apagar</button>)}
                </div>
              </div>
            ))}
          </Card>
        )}

        {tab==="waitlist"&&(
          <Card>
            {stats.waitlistItems.length===0&&<p style={{textAlign:"center",color:T.muted,padding:20,fontSize:14,fontWeight:500}}>Lista de espera vazia</p>}
            {stats.waitlistItems.map((w,i)=>(
              <div key={w._id} style={{borderBottom:`1px solid ${T.border}`,padding:"12px 0",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{background:T.blueL,color:T.blue,borderRadius:8,padding:"4px 9px",fontSize:12,fontWeight:900,minWidth:28,textAlign:"center"}}>{i+1}</span>
                  <div>
                    <p style={{fontWeight:700,fontSize:14,color:T.text}}>{w.name}</p>
                    <p style={{fontSize:12,color:T.muted,fontWeight:500}}>{w.phone}</p>
                  </div>
                </div>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
                  <p style={{fontSize:11,color:T.muted,fontWeight:500,whiteSpace:"nowrap"}}>{new Date(w.at).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</p>
                  <div style={{display:"flex",gap:6}}>
                    <Btn onClick={()=>handlePromote(w)} disabled={promoteLoading===w.phone} style={{padding:"5px 12px",fontSize:12,background:T.gold,whiteSpace:"nowrap"}}>{promoteLoading===w.phone?"...":"🔗 Promover"}</Btn>
                    {role==="superadmin"&&(<button onClick={()=>setDeleteWaitModal({show:true,id:w._id,name:w.name})} style={{background:"none",border:`1px solid ${T.red}`,borderRadius:7,padding:"5px 10px",color:T.red,fontSize:11,fontWeight:700,cursor:"pointer"}}>🗑</button>)}
                  </div>
                </div>
              </div>
            ))}
          </Card>
        )}

        {tab==="super"&&role==="superadmin"&&(
          <div>
            {/* Status do cadastro */}
            <Card style={{marginBottom:14}}>
              <h3 style={{fontSize:13,fontWeight:800,color:T.blue,marginBottom:14,textTransform:"uppercase",letterSpacing:.5}}>Status do cadastro público</h3>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
                <div>
                  <p style={{fontWeight:800,fontSize:16,color:stats.registrationClosed?T.red:T.green}}>
                    {stats.registrationClosed?"🔴 Fechado":"🟢 Aberto"}
                  </p>
                  <p style={{fontSize:12,color:T.muted,marginTop:3,fontWeight:500}}>
                    {stats.registrationClosed?"Novos cadastros desativados no site":"Novos cadastros habilitados no site"}
                  </p>
                </div>
                <Btn onClick={async()=>{await setRegistrationClosed(!stats.registrationClosed);refresh();}} style={{background:stats.registrationClosed?T.green:T.red,whiteSpace:"nowrap",minWidth:100}}>
                  {stats.registrationClosed?"🟢 Abrir":"🔴 Fechar"}
                </Btn>
              </div>
            </Card>

            {/* Vagas disponíveis */}
            <Card style={{marginBottom:14}}>
              <h3 style={{fontSize:13,fontWeight:800,color:T.blue,marginBottom:14,textTransform:"uppercase",letterSpacing:.5}}>Vagas disponíveis</h3>
              <div style={{display:"flex",alignItems:"center",gap:16,justifyContent:"center"}}>
                <button onClick={()=>handleAdjustSlots(-1)} disabled={slotLoading||stats.available===0} style={{width:44,height:44,borderRadius:10,border:`2px solid ${T.red}`,background:"#FFECEC",color:T.red,fontSize:22,fontWeight:900,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>−</button>
                <span style={{fontSize:36,fontWeight:900,color:T.blue,minWidth:60,textAlign:"center"}}>{stats.available}</span>
                <button onClick={()=>handleAdjustSlots(1)} disabled={slotLoading} style={{width:44,height:44,borderRadius:10,border:`2px solid ${T.blue}`,background:T.blueL,color:T.blue,fontSize:22,fontWeight:900,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
              </div>
              <p style={{textAlign:"center",fontSize:12,color:T.muted,marginTop:10,fontWeight:500}}>Confirmados: {stats.confirmed} · Reservados (form aberto): {stats.reserved}</p>
            </Card>

            {/* Zona de perigo */}
            <Card style={{border:`2px solid ${T.red}`,marginBottom:14}}>
              <h3 style={{fontSize:13,fontWeight:800,color:T.red,marginBottom:14,textTransform:"uppercase",letterSpacing:.5}}>⚠️ Zona de perigo</h3>
              <Btn variant="danger" onClick={()=>setClearWaitModal(true)} style={{width:"100%"}} disabled={stats.waitlist===0}>
                🗑 Limpar toda a lista de espera ({stats.waitlist} {stats.waitlist===1?"pessoa":"pessoas"})
              </Btn>
            </Card>
          </div>
        )}
      </div>

      {/* Modal: cancelar check-in */}
      <Modal show={cancelCIModal.show} icon="↩" title="Cancelar check-in?"
        body={`Tem certeza que deseja cancelar o check-in de ${cancelCIModal.name}?`}
        actions={[
          <Btn key="y" variant="danger" onClick={handleCancelCI} style={{width:"100%"}}>Sim, cancelar check-in</Btn>,
          <Btn key="n" variant="ghost" onClick={()=>setCancelCIModal({show:false,regId:null,name:""})} style={{width:"100%",fontSize:14}}>Não</Btn>,
        ]}
      />

      {/* Modal: apagar cadastro */}
      <Modal show={deleteRegModal.show} icon="🗑" title="Apagar cadastro?"
        body={`Isso irá apagar o cadastro de "${deleteRegModal.name}" e devolver ${deleteRegModal.count} vaga${deleteRegModal.count>1?"s":""} ao sistema. Essa ação não pode ser desfeita.`}
        actions={[
          <Btn key="y" variant="danger" onClick={handleDeleteReg} style={{width:"100%"}}>Sim, apagar cadastro</Btn>,
          <Btn key="n" variant="ghost" onClick={()=>setDeleteRegModal({show:false,regId:null,name:"",count:0})} style={{width:"100%",fontSize:14}}>Cancelar</Btn>,
        ]}
      />

      {/* Modal: apagar da lista de espera */}
      <Modal show={deleteWaitModal.show} icon="🗑" title="Remover da lista de espera?"
        body={`Remover "${deleteWaitModal.name}" da lista de espera? Essa ação não pode ser desfeita.`}
        actions={[
          <Btn key="y" variant="danger" onClick={handleDeleteWait} style={{width:"100%"}}>Sim, remover</Btn>,
          <Btn key="n" variant="ghost" onClick={()=>setDeleteWaitModal({show:false,id:null,name:""})} style={{width:"100%",fontSize:14}}>Cancelar</Btn>,
        ]}
      />

      {/* Modal: limpar lista de espera */}
      <Modal show={clearWaitModal} icon="⚠️" title="Limpar toda a lista de espera?"
        body={`Isso vai remover todas as ${stats.waitlist} pessoas da lista de espera permanentemente.`}
        actions={[
          <Btn key="y" variant="danger" onClick={handleClearWait} style={{width:"100%"}}>Sim, limpar tudo</Btn>,
          <Btn key="n" variant="ghost" onClick={()=>setClearWaitModal(false)} style={{width:"100%",fontSize:14}}>Cancelar</Btn>,
        ]}
      />

      {/* Modal: link de promoção */}
      <Modal show={promoteModal.show} icon="🔗" title={`Link para ${promoteModal.name}`}
        body={<>
          <p style={{fontSize:13,color:T.muted,marginBottom:12,fontWeight:500}}>Envie este link via WhatsApp. Válido por 48h, uso único.</p>
          <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:"10px 12px",wordBreak:"break-all",fontSize:12,color:T.blue,fontWeight:700,marginBottom:12,textAlign:"left"}}>{promoteModal.link}</div>
        </>}
        actions={[
          <Btn key="copy" onClick={()=>navigator.clipboard.writeText(promoteModal.link)} style={{width:"100%"}}>📋 Copiar link</Btn>,
          <Btn key="close" variant="ghost" onClick={()=>setPromoteModal({show:false,link:"",name:""})} style={{width:"100%",fontSize:14}}>Fechar</Btn>,
        ]}
      />
    </div>
  );
}

// ── APP ROOT ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,setScreen]=useState("loading");
  const [available,setAvail]=useState(CFG.MAX_SLOTS);
  const [regClosed,setRegClosed]=useState(false);
  const [sid,setSid]=useState(null);
  const [count,setCount]=useState(0);
  const [expiresAt,setExp]=useState(null);
  const [reg,setReg]=useState(null);
  const [bypassToken,setBypassToken]=useState(null);
  useEffect(()=>{
    const unsub=onSnapshot(slotsRef,snap=>{setAvail(snap.data()?.available??0);setRegClosed(snap.data()?.registrationClosed??false);});
    return unsub;
  },[]);
  useEffect(()=>{
    (async()=>{
      try {
        if(window.location.pathname===CFG.ADMIN_PATH){setScreen("admin");return;}
        await ensureSlots();
        const existing=await getSessionReg();
        if(existing){setReg(existing);setScreen("confirmation");return;}
        if(Date.now()<CFG.OPEN_AT.getTime()){setScreen("pre-open");return;}
        const params=new URLSearchParams(window.location.search);
        const t=params.get("t");
        if(t){
          const snap=await getDoc(doc(db,"bypass_tokens",t));
          if(snap.exists()&&!snap.data().used&&new Date(snap.data().expiresAt)>new Date()){
            setBypassToken(t); setScreen("select"); return;
          }
        }
        setScreen("home");
      } catch(e) { console.error("App init failed:",e); setScreen("home"); }
    })();
  },[]);
  useEffect(()=>{if(["home","select"].includes(screen)&&available===0&&!bypassToken)setScreen("waitlist");},[available,screen,bypassToken]);
  const goHome=()=>setScreen("home");
  const handleSelect=async(n)=>{
    const res=bypassToken ? await redeemBypassToken(bypassToken,n) : await reserveSlots(n);
    if(!res.ok) return;
    if(bypassToken) setBypassToken(null);
    setSid(res.sid);setCount(n);setExp(res.expiresAt);setScreen("form");
  };
  if(screen==="loading") return <div style={{minHeight:"100vh",background:T.bg,display:"flex",alignItems:"center",justifyContent:"center"}}><Styles /><p style={{color:T.muted,fontFamily:"Montserrat,sans-serif",fontSize:14}}>Carregando...</p></div>;
  if(screen==="waitlist") return <WaitlistScreen />;
  if(screen==="admin") return <AdminScreen onBack={goHome}/>;
  if(screen==="confirmation") return <ConfirmationScreen reg={reg} onClear={()=>{clearSession();setReg(null);goHome();}}/>;
  if(screen==="recover") return <RecoverScreen onFound={r=>{setReg(r);setScreen("confirmation");}} onBack={goHome}/>;
  if(screen==="home") return <HomeScreen available={available} regClosed={regClosed} onStart={()=>setScreen("select")} onRecover={()=>setScreen("recover")}/>;
  if(screen==="select") return <SelectCountScreen available={available} onSelect={handleSelect} onBack={goHome} bypass={!!bypassToken}/>;
  if(screen==="form") return <FormScreen sid={sid} initialExpiresAt={expiresAt} initialCount={count} onSuccess={r=>{setReg(r);setScreen("confirmation");}} onExpired={async()=>{if(sid)await cancelReservation(sid);setSid(null);setCount(0);setExp(null);setScreen("home");}} onRecover={async()=>{if(sid)await cancelReservation(sid);setSid(null);setCount(0);setExp(null);setScreen("recover");}} onBack={async()=>{if(sid)await cancelReservation(sid);setSid(null);setCount(0);setExp(null);setScreen("select");}}/>;
  return null;
}