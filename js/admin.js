import * as F from "./fb.js";
import { $, $$, esc, timeAgo, toast } from "./util.js";

const { enabled, P } = F;
const PRDS = window.PRDS || [];
let user = null;
const rows = {};   // prdId -> {prd, secret, apps, likes, comments}
const reveal = {}; // prdId -> 비밀번호 보이기

function tempPassword() {
  const L = "abcdefghjkmnpqrstuvwxyz", D = "23456789", A = L + D;
  const pick = s => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  let p = pick(L) + pick(D);
  while (p.length < 8) p += pick(A);
  return p.split("").sort(() => crypto.getRandomValues(new Uint8Array(1))[0] - 128).join("");
}
const log = (action, prdId, detail = "") =>
  F.addDoc(P.logs(), { action, prdId, by: user.email || user.uid, at: F.serverTimestamp(), detail }).catch(() => {});
const teamLabel = { closed: "닫힘", open: "모집 중", finalized: "확정" };

/* ---------- 로그인 ---------- */
async function checkAdmin(u) {
  user = u;
  $("#btnLogin").hidden = true; $("#btnLogout").hidden = false;
  try {
    const a = await F.getDoc(P.admin(u.uid));
    if (!a.exists()) throw { code: "permission-denied" };
    $("#loginMsg").textContent = `${u.email} 계정으로 로그인했습니다.`;
    $("#adminArea").hidden = false;
    loadAll(); loadLogs();
  } catch {
    $("#adminArea").hidden = true;
    $("#loginMsg").innerHTML = `${esc(u.email || "")} 계정은 관리자로 등록되어 있지 않습니다.<br>
      Firebase 콘솔 &gt; Firestore에서 <b>admins</b> 컬렉션에 아래 ID로 문서를 만들면 관리자가 됩니다.<br>
      <span class="mono">${esc(u.uid)}</span>`;
  }
}

/* ---------- PRD 현황 ---------- */
async function loadAll() {
  $("#tbl").innerHTML = '<tr><td class="hint">불러오는 중입니다.</td></tr>';
  await Promise.all(PRDS.map(async p => {
    const r = rows[p.id] = { prd: null, secret: null, apps: 0, likes: 0, comments: 0 };
    try {
      const [prd, sec, apps, likes, cm] = await Promise.all([
        F.getDoc(P.prd(p.id)), F.getDoc(P.secret(p.id)),
        F.getCountFromServer(P.apps(p.id)), F.getCountFromServer(P.likes(p.id)), F.getCountFromServer(P.comments(p.id)),
      ]);
      r.prd = prd.exists() ? prd.data() : null; r.secret = sec.exists() ? sec.data() : null;
      r.apps = apps.data().count; r.likes = likes.data().count; r.comments = cm.data().count;
    } catch { /* 표에서 빈칸으로 표시 */ }
  }));
  renderTable();
}
function renderTable() {
  $("#tbl").innerHTML = `<thead><tr><th>PRD</th><th>작성자 비밀번호</th><th>설정</th><th>팀</th><th>신청</th><th>좋아요</th><th>덧글</th><th>관리</th></tr></thead>
  <tbody>${PRDS.map(p => {
    const r = rows[p.id] || {}, s = r.secret, t = (r.prd && r.prd.team) || null;
    const pw = s ? (reveal[p.id] ? `<span class="mono">${esc(s.password)}</span>` : "••••••") : '<span class="hint">미설정</span>';
    const set = s ? `${timeAgo(s.setAt)}${s.resetByAdmin ? " · 임시" : ""}<br><span class="hint mono" title="설정한 기기 ID">${esc((s.setBy || "").slice(0, 8))}</span>` : "";
    const team = !r.prd ? '<span class="hint">초기 데이터 없음</span>'
      : `${teamLabel[t.status] || t.status} · ${1 + (t.members || []).length}/${t.capacity}${t.teamName ? `<br><span class="hint">${esc(t.teamName)}</span>` : ""}`;
    return `<tr>
      <td><b>${esc(p.org)} ${esc(p.name)}</b><br><span class="hint">${esc(p.title)}</span></td>
      <td>${pw} ${s ? `<button class="btn small" data-a="reveal" data-id="${p.id}">${reveal[p.id] ? "가리기" : "보기"}</button>` : ""}</td>
      <td>${set}</td><td>${team}</td><td>${r.apps ?? ""}</td><td>${r.likes ?? ""}</td><td>${r.comments ?? ""}</td>
      <td><div class="actions" style="justify-content:flex-start">
        <button class="btn small primary" data-a="temp" data-id="${p.id}" ${r.prd ? "" : "disabled"}>임시 비밀번호</button>
        <button class="btn small danger" data-a="delpw" data-id="${p.id}" ${s ? "" : "disabled"}>비밀번호 삭제</button>
        <button class="btn small" data-a="team" data-id="${p.id}" ${r.prd ? "" : "disabled"}>팀 초기화</button>
        <button class="btn small" data-a="cap" data-id="${p.id}" ${r.prd ? "" : "disabled"}>정원</button>
      </div></td></tr>`;
  }).join("")}</tbody>`;
}

async function act(a, id) {
  const r = rows[id] || {}, p = PRDS.find(x => x.id === id);
  try {
    if (a === "reveal") { reveal[id] = !reveal[id]; renderTable(); return; }
    if (a === "temp") {
      if (!confirm(`${p.org} ${p.name} 선생님의 비밀번호를 임시 비밀번호로 바꿀까요?\n이 PRD의 기존 작성자 확인은 모두 풀립니다.`)) return;
      const pw = tempPassword(), b = F.writeBatch(F.db);
      b.set(P.secret(id), { password: pw, setBy: user.uid, setAt: F.serverTimestamp(), resetByAdmin: true });
      b.update(P.prd(id), { passwordSet: true });
      await b.commit(); await log("임시 비밀번호 발급", id);
      reveal[id] = true; await loadAll();
      alert(`임시 비밀번호: ${pw}\n\n선생님께 전달해 주세요. 작성자 확인 후 「비밀번호 변경」으로 바꿀 수 있습니다.`);
    }
    if (a === "delpw") {
      if (!confirm("비밀번호를 삭제할까요? 누구나 새 비밀번호를 먼저 정할 수 있는 상태가 됩니다.\n보통은 「임시 비밀번호」를 권합니다.")) return;
      const b = F.writeBatch(F.db);
      b.delete(P.secret(id)); b.update(P.prd(id), { passwordSet: false });
      await b.commit(); await log("비밀번호 삭제", id); await loadAll(); toast("비밀번호를 삭제했습니다.");
    }
    if (a === "team") {
      if (!confirm("팀 상태를 처음(닫힘)으로 되돌리고, 선정 명단과 참여 신청을 모두 지울까요?")) return;
      const apps = await F.getDocs(P.apps(id)), b = F.writeBatch(F.db);
      apps.forEach(d => b.delete(d.ref));
      b.update(P.prd(id), { team: { status: "closed", capacity: r.prd.team.capacity || 3, members: [], teamName: "" } });
      await b.commit(); await log("팀 초기화", id, `신청 ${apps.size}건 삭제`); await loadAll(); toast("팀을 초기화했습니다.");
    }
    if (a === "cap") {
      const cur = r.prd.team.capacity || 3;
      const v = prompt("팀 전체 인원(작성자 포함)을 입력하세요. 2~6", String(cur)); if (v == null) return;
      const n = parseInt(v, 10);
      if (!(n >= 2 && n <= 6)) { toast("2에서 6 사이 숫자를 입력해 주세요."); return; }
      if ((r.prd.team.members || []).length > n - 1) { toast("이미 선정된 팀원이 새 정원보다 많습니다. 먼저 팀을 정리해 주세요."); return; }
      await F.updateDoc(P.prd(id), { "team.capacity": n }); await log("정원 변경", id, `${cur} → ${n}`); await loadAll(); toast("정원을 바꿨습니다.");
    }
  } catch (e) { toast(F.isDenied(e) ? "권한이 없습니다. 관리자 등록을 확인해 주세요." : "처리하지 못했습니다."); }
  loadLogs();
}

async function seed() {
  if (!confirm(`${PRDS.length}개 PRD의 기본 정보를 만들거나 갱신할까요? 팀 상태와 비밀번호는 그대로 둡니다.`)) return;
  try {
    for (const p of PRDS) {
      const ref = P.prd(p.id), cur = await F.getDoc(ref);
      if (cur.exists()) await F.updateDoc(ref, { org: p.org, name: p.name, title: p.title });
      else await F.setDoc(ref, { org: p.org, name: p.name, title: p.title, passwordSet: false,
        team: { status: "closed", capacity: 3, members: [], teamName: "" } });
    }
    await log("초기 데이터 만들기·갱신", "-"); await loadAll(); toast("초기 데이터를 반영했습니다.");
  } catch (e) { toast(F.isDenied(e) ? "권한이 없습니다." : "초기 데이터를 반영하지 못했습니다."); }
}

/* ---------- 덧글 관리 ---------- */
async function loadComments() {
  const id = $("#cmtPrd").value, tbl = $("#cmtTbl");
  tbl.innerHTML = '<tr><td class="hint">불러오는 중입니다.</td></tr>';
  try {
    const snap = await F.getDocs(F.query(P.comments(id), F.orderBy("createdAt", "desc")));
    if (snap.empty) { tbl.innerHTML = '<tr><td class="hint">덧글이 없습니다.</td></tr>'; return; }
    const st = { visible: "보임", hidden: "숨김", deleted: "삭제됨" };
    tbl.innerHTML = `<thead><tr><th>시각</th><th>작성</th><th>내용</th><th>상태</th><th>관리</th></tr></thead><tbody>${snap.docs.map(d => {
      const c = d.data();
      return `<tr><td>${timeAgo(c.createdAt)}</td><td>${esc(c.name)}<br><span class="hint">${esc(c.org)}${c.depth ? " · 답글" : ""}</span></td>
        <td style="max-width:420px">${esc(c.body || "")}</td><td>${st[c.status] || c.status}</td>
        <td><div class="actions" style="justify-content:flex-start">
          ${c.status === "visible" ? `<button class="btn small" data-c="hidden" data-cid="${d.id}">숨기기</button>` : ""}
          ${c.status === "hidden" ? `<button class="btn small" data-c="visible" data-cid="${d.id}">다시 보이기</button>` : ""}
          <button class="btn small danger" data-c="remove" data-cid="${d.id}">완전 삭제</button></div></td></tr>`;
    }).join("")}</tbody>`;
  } catch { tbl.innerHTML = '<tr><td class="hint">덧글을 불러오지 못했습니다.</td></tr>'; }
}
async function commentAct(kind, cid) {
  const id = $("#cmtPrd").value;
  try {
    if (kind === "remove") {
      if (!confirm("이 덧글을 완전히 지울까요? 되돌릴 수 없습니다. 달린 답글은 남습니다.")) return;
      await F.deleteDoc(P.comment(id, cid)); await log("덧글 완전 삭제", id, cid);
    } else {
      await F.updateDoc(P.comment(id, cid), { status: kind }); await log(kind === "hidden" ? "덧글 숨김" : "덧글 복원", id, cid);
    }
    loadComments(); loadLogs();
  } catch { toast("처리하지 못했습니다."); }
}

/* ---------- 작업 기록 ---------- */
async function loadLogs() {
  try {
    const snap = await F.getDocs(F.query(P.logs(), F.orderBy("at", "desc"), F.limit(50)));
    $("#logTbl").innerHTML = snap.empty ? '<tr><td class="hint">기록이 없습니다.</td></tr>'
      : `<thead><tr><th>시각</th><th>작업</th><th>PRD</th><th>관리자</th><th>내용</th></tr></thead><tbody>${snap.docs.map(d => {
        const l = d.data(), p = PRDS.find(x => x.id === l.prdId);
        return `<tr><td>${timeAgo(l.at)}</td><td>${esc(l.action)}</td><td>${p ? esc(`${p.org} ${p.name}`) : esc(l.prdId)}</td><td>${esc(l.by)}</td><td class="hint">${esc(l.detail || "")}</td></tr>`;
      }).join("")}</tbody>`;
  } catch { $("#logTbl").innerHTML = '<tr><td class="hint">기록을 불러오지 못했습니다.</td></tr>'; }
}

/* ---------- 시작 ---------- */
function start() {
  if (!enabled) { $("#loginMsg").textContent = "js/firebase-config.js에 Firebase 설정값을 먼저 넣어 주세요."; $("#btnLogin").disabled = true; return; }
  $("#cmtPrd").innerHTML = PRDS.map(p => `<option value="${p.id}">${esc(p.org)} ${esc(p.name)} · ${esc(p.title)}</option>`).join("");
  $("#cmtPrd").addEventListener("change", loadComments);
  $("#btnLogin").addEventListener("click", () => F.signInWithPopup(F.auth, new F.GoogleAuthProvider()).catch(() => toast("로그인하지 못했습니다.")));
  $("#btnLogout").addEventListener("click", () => F.signOut(F.auth).then(() => location.reload()));
  $("#btnRefresh").addEventListener("click", () => { loadAll(); loadLogs(); });
  $("#btnSeed").addEventListener("click", seed);
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-a]"); if (b) act(b.dataset.a, b.dataset.id);
    const c = e.target.closest("[data-c]"); if (c) commentAct(c.dataset.c, c.dataset.cid);
  });
  F.onAuthStateChanged(F.auth, u => {
    if (u && !u.isAnonymous) { checkAdmin(u); loadComments(); }
    else { $("#btnLogin").hidden = false; $("#btnLogout").hidden = true; $("#adminArea").hidden = true; }
  });
}
start();
