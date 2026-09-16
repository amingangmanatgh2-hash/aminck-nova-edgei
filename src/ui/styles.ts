/**
 * Shared stylesheet.
 *
 * RTL-first, dark by default, no external font or CDN: everything the browser
 * needs is served from this Worker. Persian text falls back to the system
 * stack rather than downloading a webfont, which matters on the metered and
 * high-latency connections this product targets.
 */
export const CSS = `/*NOVA-CSS-START*/
:root{
  --bg:#0b0f16; --bg2:#121826; --bg3:#1a2233; --card:#141b2a;
  --fg:#e8eef7; --fg2:#93a1b8; --line:#26314a;
  --brand:#8b5cf6; --brand2:#a78bfa; --gold:#fbbf24;
  --ok:#22c55e; --warn:#f59e0b; --err:#ef4444; --info:#38bdf8;
  --r:14px; --shadow:0 10px 34px rgba(0,0,0,.45);
}
html[data-theme=light]{
  --bg:#f3f5fa; --bg2:#fff; --bg3:#eef1f8; --card:#fff;
  --fg:#111827; --fg2:#5b6675; --line:#dde3ef;
  --shadow:0 8px 26px rgba(20,30,60,.10);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:"Vazirmatn","Segoe UI",Tahoma,system-ui,sans-serif;
  background:var(--bg); color:var(--fg); line-height:1.7;
  direction:rtl; min-height:100vh;
}
a{color:var(--brand2);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{line-height:1.3;margin:0 0 .6em}
h1{font-size:2rem}h2{font-size:1.4rem}h3{font-size:1.1rem}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;direction:ltr;text-align:left}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
.muted{color:var(--fg2)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px;box-shadow:var(--shadow)}
.grid{display:grid;gap:16px}
.g2{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.g4{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.spread{justify-content:space-between}
.btn{
  display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);
  background:var(--bg3);color:var(--fg);padding:10px 18px;border-radius:10px;
  cursor:pointer;font:inherit;font-weight:600;transition:.15s;
}
.btn:hover{border-color:var(--brand);text-decoration:none}
.btn.primary{background:linear-gradient(135deg,var(--brand),var(--brand2));border-color:transparent;color:#fff}
.btn.gold{background:linear-gradient(135deg,#b45309,var(--gold));border-color:transparent;color:#1a1200}
.btn.danger{background:var(--err);border-color:transparent;color:#fff}
.btn.sm{padding:6px 12px;font-size:.85rem}
.btn[disabled]{opacity:.5;cursor:not-allowed}
input,select,textarea{
  width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);
  background:var(--bg2);color:var(--fg);font:inherit;
}
input:focus,select:focus,textarea:focus{outline:2px solid var(--brand);outline-offset:1px}
label{display:block;font-size:.85rem;color:var(--fg2);margin-bottom:4px}
.field{margin-bottom:14px}
nav.top{
  position:sticky;top:0;z-index:50;backdrop-filter:blur(10px);
  background:color-mix(in srgb,var(--bg) 88%,transparent);border-bottom:1px solid var(--line);
}
nav.top .inner{display:flex;align-items:center;gap:18px;padding:12px 20px;max-width:1180px;margin:0 auto}
nav.top .brand{font-weight:800;font-size:1.15rem;color:var(--fg)}
nav.top .links{display:flex;gap:14px;margin-inline-start:auto;flex-wrap:wrap}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.75rem;font-weight:700}
.badge.ok{background:rgba(34,197,94,.16);color:var(--ok)}
.badge.warn{background:rgba(245,158,11,.16);color:var(--warn)}
.badge.err{background:rgba(239,68,68,.16);color:var(--err)}
.badge.info{background:rgba(56,189,248,.16);color:var(--info)}
.badge.off{background:rgba(147,161,184,.16);color:var(--fg2)}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:right}
th{color:var(--fg2);font-weight:600;font-size:.82rem;text-transform:uppercase;letter-spacing:.03em}
tr:hover td{background:color-mix(in srgb,var(--bg3) 55%,transparent)}
.hero{padding:64px 0 40px;text-align:center;background:
  radial-gradient(900px 340px at 50% -80px,rgba(139,92,246,.30),transparent 70%)}
.hero h1{font-size:2.7rem;background:linear-gradient(135deg,#fff,var(--brand2));
  -webkit-background-clip:text;background-clip:text;color:transparent}
.price{font-size:1.7rem;font-weight:800;color:var(--gold)}
.price s{color:var(--fg2);font-size:.95rem;font-weight:400;margin-inline-start:8px}
.tag{display:inline-block;padding:2px 8px;border-radius:6px;font-weight:800;font-size:.78rem}
.stat{text-align:center}
.stat .n{font-size:1.9rem;font-weight:800;color:var(--brand2)}
.stat .l{font-size:.82rem;color:var(--fg2)}
.toast{
  position:fixed;bottom:22px;inset-inline-start:22px;z-index:200;
  background:var(--bg3);border:1px solid var(--line);border-radius:12px;
  padding:12px 18px;box-shadow:var(--shadow);max-width:340px;
}
.toast.ok{border-color:var(--ok)} .toast.err{border-color:var(--err)}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;
  align-items:center;justify-content:center;z-index:150;padding:20px}
.modal{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
  padding:22px;max-width:520px;width:100%;max-height:88vh;overflow:auto}
.hidden{display:none!important}
.sidebar{display:grid;grid-template-columns:230px 1fr;gap:18px}
.sidebar .menu{display:flex;flex-direction:column;gap:4px}
.sidebar .menu a{padding:9px 12px;border-radius:9px;color:var(--fg2);font-weight:600}
.sidebar .menu a.on,.sidebar .menu a:hover{background:var(--bg3);color:var(--fg);text-decoration:none}
@media(max-width:860px){
  .sidebar{grid-template-columns:1fr}
  .hero h1{font-size:1.9rem}
  table{font-size:.82rem}
  th,td{padding:6px}
}
.evidence{direction:ltr;text-align:left;font-size:.8rem;white-space:pre-wrap;
  background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;
  max-height:340px;overflow:auto}
.bar{height:7px;background:var(--bg3);border-radius:999px;overflow:hidden}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--brand),var(--brand2))}
/*NOVA-CSS-END*/`;
