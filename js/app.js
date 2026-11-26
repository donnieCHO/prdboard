import * as F from "./fb.js";
import { $, $$, esc, store, timeAgo, toast, goodPassword, ICON } from "./util.js";

const { enabled, P } = F;
const PRDS = window.PRDS || [];
const byId = Object.fromEntries(PRDS.map(p => [p.id, p]));

const S = {
  uid: null, filter: "all", q: "",
  prd: {},            // Firestore prds 문서 (실시간)
  likeCount: {}, myLike: {}, commentCount: {},
  author: {},         // prdId -> 이 브라우저가 작성자로 확인되었는지
  openId: null, tab: "doc", comments: [], apps: [], unsub: [],
  replyFor: null,     // {root, to:{name,org}|null}
  editing: null,      // 수정 중인 덧글 id
  applyOpen: false, applyEdit: false, pwChange: false,
  draft: {}, docCache: {}, busy: false,
};

const me = () => store.get("prd.me", { org: "", name: "" });
const saveMe = (org, name) => store.set("prd.me", { org, name });
const kind = t => t.includes("교사") && t.includes("학생") ? "b" : t.includes("학생") ? "s" : "t";
const audText = t => ({ t: "교사용", s: "학생용", b: "교사·학생" })[kind(t)];
const teamOf = id => {
  const t = (S.prd[id] && S.prd[id].team) || {};
  return { status: t.status || "closed", capacity: t.capacity || 3, members: t.members || [], teamName: t.teamName || "" };
};
const len = (s, lo, hi) => s.length >= lo && s.length <= hi;

/* ---------------- 카드 ---------------- */
function teamBtn(id) {
  const t = teamOf(id), n = 1 + t.members.length;
  const st = S.prd[id] ? t.status : "none";
  const word = { open: "모집 중", finalized: "확정", closed: "", none: "" }[st];
  const label = { open: "팀 모집 중", finalized: "팀 확정", closed: "팀 모집 전", none: "팀" }[st];
  return `<button class="chipbtn team ${st}" data-open="${id}" data-tab="team" aria-label="${label}, ${n}/${t.capacity}명. 팀 구성 보기">${ICON.team}<span>${n}/${t.capacity}</span>${word ? `<em>${word}</em>` : ""}</button>`;
}
function likeBtn(id, cls = "") {
  const n = S.likeCount[id] ?? 0, on = !!S.myLike[id];
  return `<button class="chipbtn ${on ? "liked" : ""} ${cls}" data-like="${id}" aria-pressed="${on}" aria-label="좋아요 ${n}개" ${enabled ? "" : "disabled"}>${ICON.heart}<span>${n}</span></button>`;
}
function renderCards() {
  const list = PRDS.filter(d =>
    (S.filter === "all" || d.target.includes(S.filter)) &&
    (!S.q || [d.org, d.name, d.title, d.concept, d.feature, d.target_note].join(" ").toLowerCase().includes(S.q)));
  $("#grid").innerHTML = list.length ? list.map(d => `
    <article class="card glass">
      <div class="top"><span class="org">${esc(d.org)}</span><span class="name">${esc(d.name)}</span><span class="aud ${kind(d.target)}">${audText(d.target)}</span></div>
      <h2>${esc(d.title)}</h2>
      <dl class="facts">
        <div><dt>컨셉</dt><dd>${esc(d.concept)}</dd></div>
        <div><dt>대상</dt><dd>${esc(d.target_note)}</dd></div>
        <div><dt>특징</dt><dd>${esc(d.feature)}</dd></div>
      </dl>
      <div class="stats">
        ${likeBtn(d.id)}
        <button class="chipbtn" data-open="${d.id}" data-tab="comments" aria-label="덧글 보기">${ICON.chat}<span>${S.commentCount[d.id] ?? 0}</span></button>
        ${teamBtn(d.id)}
      </div>
      <button class="open" data-open="${d.id}" data-tab="doc">전체 PRD 문서 보기</button>
    </article>`).join("") : '<p class="empty glass">찾는 과제가 없습니다. 다른 낱말로 찾아보세요.</p>';
  $("#tally").textContent = S.filter === "all" && !S.q ? `제출된 과제 ${PRDS.length}편` : `${list.length}편을 찾았습니다`;
}

/* ---------------- 좋아요 ---------------- */
async function toggleLike(id) {
  if (!enabled || !S.uid) return;
  const was = !!S.myLike[id];
  S.myLike[id] = !was; S.likeCount[id] = Math.max(0, (S.likeCount[id] || 0) + (was ? -1 : 1));
  paintLikes();
  try {
    if (was) await F.deleteDoc(P.like(id, S.uid));
    else await F.setDoc(P.like(id, S.uid), { at: F.serverTimestamp() });
  } catch (e) {
    S.myLike[id] = was; S.likeCount[id] = Math.max(0, (S.likeCount[id] || 0) + (was ? 1 : -1));
    paintLikes(); toast("좋아요를 저장하지 못했습니다. 잠시 후 다시 눌러 주세요.");
  }
}
function paintLikes() {
  renderCards();
  if (S.openId) $("#vlike").outerHTML = likeBtn(S.openId).replace("<button", '<button id="vlike"');
}

async function loadCounts() {
  await Promise.all(PRDS.map(async p => {
    try {
      const [l, c, mine] = await Promise.all([
        F.getCountFromServer(P.likes(p.id)),
        F.getCountFromServer(F.query(P.comments(p.id), F.where("status", "==", "visible"))),
        F.getDoc(P.like(p.id, S.uid)),
      ]);
      S.likeCount[p.id] = l.data().count; S.commentCount[p.id] = c.data().count; S.myLike[p.id] = mine.exists();
    } catch { /* 초기 데이터가 없을 때 등 */ }
  }));
  paintLikes();
}

/* ---------------- 원문 시트 ---------------- */
async function openDoc(id, tab = "doc") {
  const d = byId[id]; if (!d) return;
  S.openId = id; S.replyFor = null; S.editing = null; S.applyOpen = false; S.applyEdit = false; S.pwChange = false; S.comments = []; S.apps = []; S.appsLoaded = false;
  $("#vtitle").textContent = d.title;
  $("#vwho").textContent = `${d.org} ${d.name}`;
  $("#vlike").outerHTML = likeBtn(id).replace("<button", '<button id="vlike"');
  $("#tabComments").textContent = `덧글 ${S.commentCount[id] ?? 0}`;
  paintTeamTab();
  $("#vdoc").innerHTML = '<p class="hint">원문을 불러오는 중입니다.</p>';
  $("#viewer").classList.add("on"); $("#viewer").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  history.replaceState(null, "", "#" + id);
  setTab(tab);
  $("#vclose").focus();

  loadDoc(id);
  renderCommentsShell(); renderComments(); renderTeam();
  if (!enabled || !S.uid) return;

  try { S.author[id] = (await F.getDoc(P.key(id, S.uid))).exists(); } catch { S.author[id] = false; }
  if (S.openId !== id) return;
  S.unsub.push(F.onSnapshot(F.query(P.comments(id), F.orderBy("createdAt")), snap => {
    S.comments = snap.docs.map(x => ({ id: x.id, ...x.data({ serverTimestamps: "estimate" }) }));
    S.commentCount[id] = S.comments.filter(c => c.status === "visible").length;
    $("#tabComments").textContent = `덧글 ${S.commentCount[id]}`;
    renderComments(); renderCards();
  }, () => {}));
  S.unsub.push(F.onSnapshot(F.query(P.apps(id), F.orderBy("at")), snap => {
    S.apps = snap.docs.map(x => ({ id: x.id, ...x.data({ serverTimestamps: "estimate" }) }));
    S.appsLoaded = true;
    renderTeam();
  }, () => {}));
  renderComments(); renderTeam();
}
async function loadDoc(id) {
  try {
    if (!S.docCache[id]) {
      const r = await fetch(`docs/${id}.html`);
      if (!r.ok) throw new Error(r.status);
      S.docCache[id] = await r.text();
    }
    if (S.openId === id) $("#vdoc").innerHTML = S.docCache[id];
  } catch {
    if (S.openId === id) $("#vdoc").innerHTML = '<p class="hint">원문을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 열어 주세요.</p>';
  }
}
function closeDoc() {
  S.unsub.forEach(u => u()); S.unsub = []; S.openId = null;
  $("#viewer").classList.remove("on"); $("#viewer").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  history.replaceState(null, "", location.pathname + location.search);
}
function setTab(tab) {
  S.tab = tab;
  const btns = $$("#tabs button");
  btns.forEach((b, i) => {
    const on = b.dataset.tab === tab;
    b.setAttribute("aria-selected", on);
    if (on) $("#tabs .thumb").style.transform = `translateX(${i * 100}%)`;
  });
  ["doc", "comments", "team"].forEach(t => { $("#pane-" + t).hidden = t !== tab; });
  $("#paper").scrollTop = 0;
}

/* ---------------- 덧글 ---------------- */
function idForm(prefix) {
  const m = me();
  return `<div class="row">
    <input class="in" data-f="org" data-draft="${prefix}-org" maxlength="30" placeholder="소속 (예: 동산초)" value="${esc(m.org)}" aria-label="소속">
    <input class="in" data-f="name" data-draft="${prefix}-name" maxlength="20" placeholder="이름" value="${esc(m.name)}" aria-label="이름">
  </div>`;
}
function renderCommentsShell() {
  const pane = $("#pane-comments");
  if (!enabled) { pane.innerHTML = '<p class="hint">덧글 기능은 아직 연결 전입니다.</p>'; return; }
  pane.innerHTML = `
    <h3 class="sec-title">덧글</h3>
    <form class="form" data-kind="new">
      ${idForm("new")}
      <textarea class="in" data-f="body" data-draft="new-body" maxlength="500" placeholder="이 설계서에 대한 생각을 남겨 주세요. 학생 개인정보는 쓰지 않습니다." aria-label="덧글 내용"></textarea>
      <div class="actions"><span class="counter" data-counter>0/500</span><button class="btn primary" type="submit">덧글 남기기</button></div>
    </form>
    <div id="clist"></div>`;
  restoreDrafts(pane);
}
function cHTML(c, top) {
  const mine = c.uid === S.uid, author = !!S.author[S.openId];
  if (c.status === "deleted") return `<div class="c"><p class="gone">삭제된 덧글입니다.</p></div>`;
  if (c.status === "hidden" && !author) return `<div class="c"><p class="gone">숨겨진 덧글입니다.</p></div>`;
  const who = `<div class="who"><b>${esc(c.name)}</b><span class="o">${esc(c.org)}</span>${c.isPrdAuthor ? '<span class="badge">작성자</span>' : ""}<time>${timeAgo(c.createdAt)}${c.editedAt ? " · 수정됨" : ""}</time></div>`;
  if (S.editing === c.id) {
    return `<div class="c">${who}
      <form class="form" data-kind="edit" data-id="${c.id}">
        <textarea class="in" data-f="body" data-draft="edit-${c.id}" maxlength="500" aria-label="덧글 수정">${esc(c.body)}</textarea>
        <div class="actions"><span class="counter" data-counter></span><button class="btn" type="button" data-act="cancel-edit">취소</button><button class="btn primary" type="submit">수정 저장</button></div>
      </form></div>`;
  }
  const at = c.replyTo && c.replyTo.name ? `<span class="at">@${esc(c.replyTo.name)}</span>` : "";
  const hidden = c.status === "hidden";
  const ops = [];
  if (!hidden) ops.push(`<button data-act="reply" data-root="${top.id}" data-cid="${c.id}">답글</button>`);
  if (!hidden && mine) ops.push(`<button data-act="edit" data-cid="${c.id}">수정</button>`, `<button data-act="del" data-cid="${c.id}">삭제</button>`);
  if (author && !hidden) ops.push(`<button data-act="hide" data-cid="${c.id}">숨기기</button>`);
  if (author && hidden) ops.push(`<button data-act="unhide" data-cid="${c.id}">다시 보이기</button>`);
  return `<div class="c">${who}
    <p class="body ${hidden ? "faded" : ""}">${at}${esc(c.body)}</p>
    ${hidden ? '<p class="gone">숨긴 덧글입니다. 다른 분에게는 내용이 보이지 않습니다.</p>' : ""}
    ${enabled && S.uid ? `<div class="ops">${ops.join("")}</div>` : ""}</div>`;
}
function renderComments() {
  const box = $("#clist"); if (!box) return;
  const tops = S.comments.filter(c => c.depth === 0);
  const kids = id => S.comments.filter(c => c.depth === 1 && c.parentId === id);
  if (!tops.length) { box.innerHTML = '<p class="hint" style="margin-top:16px">아직 덧글이 없습니다. 첫 덧글을 남겨 보세요.</p>'; return; }
  box.innerHTML = tops.map(t => {
    const rs = kids(t.id);
    const rf = S.replyFor && S.replyFor.root === t.id ? `
      <form class="form reply-form" data-kind="reply" data-root="${t.id}">
        ${S.replyFor.to ? `<p class="hint">@${esc(S.replyFor.to.name)}님에게 답글</p>` : ""}
        ${idForm("reply")}
        <textarea class="in" data-f="body" data-draft="reply-${t.id}" maxlength="500" placeholder="답글을 남겨 주세요." aria-label="답글 내용"></textarea>
        <div class="actions"><span class="counter" data-counter>0/500</span><button class="btn" type="button" data-act="cancel-reply">취소</button><button class="btn primary" type="submit">답글 남기기</button></div>
      </form>` : "";
    return `<div class="thread">${cHTML(t, t)}${rs.length || rf ? `<div class="replies">${rs.map(r => cHTML(r, t)).join("")}${rf}</div>` : ""}</div>`;
  }).join("");
  restoreDrafts(box);
}
function readIdent(form) {
  const org = $('[data-f="org"]', form).value.trim(), name = $('[data-f="name"]', form).value.trim();
  if (!len(org, 1, 30)) { toast("소속을 1~30자로 적어 주세요."); return null; }
  if (!len(name, 1, 20)) { toast("이름을 1~20자로 적어 주세요."); return null; }
  saveMe(org, name);
  return { org, name };
}
async function addComment(form, parent) {
  const id = S.openId, ident = readIdent(form); if (!ident) return;
  const body = $('[data-f="body"]', form).value.trim();
  if (!len(body, 1, 500)) { toast("내용을 1~500자로 적어 주세요."); return; }
  const data = {
    parentId: parent ? parent.root : null, depth: parent ? 1 : 0, replyTo: parent && parent.to ? parent.to : null,
    uid: S.uid, org: ident.org, name: ident.name, body, status: "visible",
    createdAt: F.serverTimestamp(), editedAt: null, isPrdAuthor: !!S.author[id],
  };
  try {
    await F.addDoc(P.comments(id), data);
  } catch (e) {
    if (F.isDenied(e) && data.isPrdAuthor) {        // 작성자 확인이 풀린 경우 일반 덧글로 다시 시도
      S.author[id] = false; data.isPrdAuthor = false;
      try { await F.addDoc(P.comments(id), data); } catch { toast("덧글을 저장하지 못했습니다."); return; }
    } else { toast("덧글을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요."); return; }
  }
  const key = parent ? `reply-${parent.root}` : "new-body";
  delete S.draft[key];
  if (parent) { S.replyFor = null; renderComments(); }
  else { $('[data-f="body"]', form).value = ""; updateCounter(form); }
  toast(parent ? "답글을 남겼습니다." : "덧글을 남겼습니다.");
}
async function commentAct(act, el) {
  const id = S.openId, cid = el.dataset.cid, c = S.comments.find(x => x.id === cid);
  if (act === "reply") {
    const root = el.dataset.root;
    S.replyFor = { root, to: c && c.depth === 1 ? { name: c.name, org: c.org } : null };
    renderComments(); const f = $(`form[data-kind="reply"] textarea`); if (f) f.focus(); return;
  }
  if (act === "cancel-reply") { S.replyFor = null; renderComments(); return; }
  if (act === "edit") { S.editing = cid; renderComments(); return; }
  if (act === "cancel-edit") { S.editing = null; renderComments(); return; }
  try {
    if (act === "del") {
      if (!confirm("이 덧글을 삭제할까요? 답글은 그대로 남습니다.")) return;
      await F.updateDoc(P.comment(id, cid), { status: "deleted", body: "" });
      toast("덧글을 삭제했습니다.");
    }
    if (act === "hide" || act === "unhide") {
      await F.updateDoc(P.comment(id, cid), { status: act === "hide" ? "hidden" : "visible" });
      toast(act === "hide" ? "덧글을 숨겼습니다." : "덧글을 다시 보이게 했습니다.");
    }
  } catch (e) {
    if (F.isDenied(e) && (act === "hide" || act === "unhide")) authorLost();
    else toast("처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
}
async function saveEdit(form) {
  const body = $('[data-f="body"]', form).value.trim();
  if (!len(body, 1, 500)) { toast("내용을 1~500자로 적어 주세요."); return; }
  try {
    await F.updateDoc(P.comment(S.openId, form.dataset.id), { body, editedAt: F.serverTimestamp() });
    delete S.draft[`edit-${form.dataset.id}`]; S.editing = null; renderComments(); toast("덧글을 수정했습니다.");
  } catch { toast("수정하지 못했습니다."); }
}

/* ---------------- 팀 ----------------
   규칙: 1번 자리는 PRD 작성자(고정). 다른 교사는 신청만 하고,
   작성자가 신청자 중 (정원-1)명 = 기본 2명을 골라 총 3명이 되면 확정할 수 있다. */
function paintTeamTab() {
  const b = $("#tabTeam"); if (!b || !S.openId) return;
  const t = teamOf(S.openId);
  b.textContent = S.prd[S.openId] ? `팀 ${1 + t.members.length}/${t.capacity}` : "팀";
}
function teamStep(t) {
  const slots = t.capacity - 1;
  if (t.status === "finalized") return 4;
  if (t.status === "open") return t.members.length >= slots ? 3 : 2;
  return 1;
}
function renderTeam() {
  const pane = $("#pane-team"), id = S.openId; if (!id) return;
  if (!enabled) { pane.innerHTML = '<h3 class="sec-title">팀 만들기</h3><p class="hint">팀 만들기 기능은 아직 연결 전입니다.</p>'; return; }
  if (!S.prd[id]) { pane.innerHTML = '<h3 class="sec-title">팀 만들기</h3><p class="hint">운영진이 초기 설정을 마치면 팀 만들기를 쓸 수 있습니다.</p>'; return; }
  const info = byId[id], prd = S.prd[id], t = teamOf(id), author = !!S.author[id];
  const slots = t.capacity - 1, left = Math.max(0, slots - t.members.length);
  const seatNo = uid => t.members.findIndex(m => m.uid === uid) + 2;   // 선정 순서대로 2번, 3번
  const isSel = uid => t.members.some(m => m.uid === uid);
  const mine = S.apps.find(a => a.id === S.uid);
  const step = teamStep(t);

  // 진행 단계
  const steps = [["모집 열기", "작성자"], [`팀원 ${slots}명 선정`, "작성자"], ["팀 확정", "작성자"]]
    .map(([txt], i) => { const n = i + 1, cls = step > n ? "done" : step === n ? "now" : "";
      return `<li class="${cls}"><span>${step > n ? "✓" : n}</span>${txt}</li>`; }).join("");

  // 자리
  const canApply = t.status === "open" && !author && !mine;
  const seatHTML = [];
  seatHTML.push(`<div class="seat filled owner"><span class="no">1</span><div><small>작성자</small><b>${esc(info.name)}</b> <span>${esc(info.org)}</span></div></div>`);
  t.members.forEach((m, i) => {
    const gone = S.appsLoaded && !S.apps.some(a => a.id === m.uid);
    seatHTML.push(`<div class="seat filled"><span class="no">${i + 2}</span><div><small>팀원</small><b>${esc(m.name)}</b> <span>${esc(m.org)}</span>${gone ? '<em class="warn">신청을 취소했습니다</em>' : ""}</div></div>`);
  });
  for (let i = t.members.length; i < slots; i++) {
    const body = canApply ? `<button class="btn small primary" data-act="apply-open">이 팀에 신청하기</button>`
      : `<span>${t.status === "open" ? "작성자가 신청자 중에서 고릅니다" : "빈자리"}</span>`;
    seatHTML.push(`<div class="seat"><span class="no">${i + 2}</span><div><small>팀원</small>${body}</div></div>`);
  }

  const statusText = {
    closed: author ? "아래에서 「팀 만들기 활성화」를 누르면 다른 선생님들이 신청할 수 있습니다." : "작성자가 아직 팀 모집을 열지 않았습니다.",
    open: author
      ? (left ? `신청자 중 ${left}명을 더 고르면 팀을 확정할 수 있습니다.` : "팀원을 모두 골랐습니다. 「팀 확정」을 누르면 팀이 완성됩니다.")
      : `팀원을 모집하고 있습니다. 누구나 신청할 수 있고, 작성자가 신청자 중 ${slots}명을 골라 ${t.capacity}명 팀을 만듭니다.`,
    finalized: `작성자를 포함한 ${1 + t.members.length}명으로 팀 구성이 확정되었습니다.`,
  }[t.status];

  // 신청 영역
  let applyBlock = "";
  if (t.status === "open" && !author) {
    if (mine && !S.applyEdit) {
      applyBlock = `<div class="box"><b>${isSel(S.uid) ? `${seatNo(S.uid)}번 자리 팀원으로 선정되었습니다.` : "신청을 마쳤습니다. 작성자의 선정을 기다려 주세요."}</b>
        <div class="actions" style="justify-content:flex-start;margin-top:10px"><button class="btn small" data-act="apply-edit">신청 내용 수정</button><button class="btn small danger" data-act="apply-cancel">신청 취소</button></div></div>`;
    } else if (S.applyOpen || S.applyEdit) {
      const v = mine || me();
      applyBlock = `<form class="form" data-kind="apply" style="margin:16px 0">
        <p class="hint" style="margin:0">소속과 이름을 적어 신청합니다. 작성자가 신청자 중에서 팀원을 고릅니다.</p>
        <div class="row">
          <input class="in" data-f="org" data-draft="apply-org" maxlength="30" placeholder="소속 (예: 동산초)" value="${esc(v.org || "")}" aria-label="소속">
          <input class="in" data-f="name" data-draft="apply-name" maxlength="20" placeholder="이름" value="${esc(v.name || "")}" aria-label="이름">
        </div>
        <input class="in" data-f="note" data-draft="apply-note" maxlength="100" placeholder="한마디 (선택, 100자 이내)" value="${esc(mine ? mine.note || "" : "")}" aria-label="한마디">
        <div class="actions"><button class="btn" type="button" data-act="apply-close">취소</button><button class="btn primary" type="submit">${mine ? "수정 저장" : "신청하기"}</button></div>
      </form>`;
    } else {
      applyBlock = `<button class="open" data-act="apply-open" style="width:100%;margin:16px 0">팀으로 참여하기</button>`;
    }
  }

  // 신청자 목록
  const apps = t.status !== "closed" && S.apps.length ? `
    <h4 style="margin:22px 0 6px">신청자 ${S.apps.length}명${author && t.status === "open" ? ` <span class="hint">· ${t.members.length}/${slots}명 선정</span>` : ""}</h4>
    <div class="apps">${S.apps.map(a => {
      const sel = isSel(a.id);
      const btn = author && t.status === "open"
        ? `<button class="btn small ${sel ? "" : "primary"}" data-act="pick" data-uid="${a.id}" ${!sel && left === 0 ? "disabled" : ""}>${sel ? "선정 취소" : left === 0 ? "자리 없음" : `${t.members.length + 2}번 자리로 선정`}</button>` : "";
      return `<div class="app ${sel ? "picked" : ""}"><div class="info"><b>${esc(a.name)}</b><span>${esc(a.org)}</span>${a.note ? `<p>${esc(a.note)}</p>` : ""}</div>${sel ? `<span class="sel">${seatNo(a.id)}번 자리</span>` : ""}${btn}</div>`;
    }).join("")}</div>` : (t.status === "open" ? '<p class="hint" style="margin-top:14px">아직 신청자가 없습니다.</p>' : "");

  // 작성자 영역
  let authorBlock;
  if (author) {
    const ctl = {
      closed: `<input class="in" data-f="teamName" data-draft="teamName" maxlength="30" placeholder="팀 이름 (선택)" value="${esc(t.teamName)}" style="flex:1 1 180px" aria-label="팀 이름"><button class="btn primary" data-act="activate">팀 만들기 활성화</button>`,
      open: `<button class="btn primary" data-act="finalize" ${left ? "disabled" : ""}>팀 확정 (${t.members.length}/${slots}명 선정)</button><button class="btn" data-act="close">모집 닫기</button>`,
      finalized: `<button class="btn" data-act="reopen">다시 열기</button>`,
    }[t.status];
    authorBlock = `<div class="author-bar"><b>작성자로 확인되었습니다.</b>${ctl}</div>
      <div class="actions" style="justify-content:flex-start">
        <button class="btn small" data-act="pw-toggle">비밀번호 변경</button>
        <button class="btn small" data-act="author-out">이 기기에서 작성자 확인 해제</button>
      </div>
      ${S.pwChange ? `<form class="form" data-kind="pw-change" style="margin-top:10px">
        <div class="row"><input class="in" type="password" data-f="pw" placeholder="새 비밀번호" autocomplete="new-password" aria-label="새 비밀번호"><input class="in" type="password" data-f="pw2" placeholder="새 비밀번호 확인" autocomplete="new-password" aria-label="새 비밀번호 확인"></div>
        <p class="hint">영문과 숫자를 섞어 6자 이상으로 정합니다.</p>
        <div class="actions"><button class="btn primary" type="submit">변경</button></div></form>` : ""}`;
  } else if (!prd.passwordSet) {
    authorBlock = `<details class="box"><summary><b>이 PRD를 쓰신 선생님이신가요?</b></summary>
      <p class="hint" style="margin:10px 0">비밀번호를 정하면 1번 자리의 작성자로 팀 만들기를 시작할 수 있습니다. 영문과 숫자를 섞어 6자 이상으로 정하고, 평소 쓰는 비밀번호는 쓰지 마세요. 잊으면 연수 운영진에게 초기화를 요청합니다.</p>
      <form class="form" data-kind="pw-setup"><div class="row">
        <input class="in" type="password" data-f="pw" placeholder="비밀번호" autocomplete="new-password" aria-label="비밀번호">
        <input class="in" type="password" data-f="pw2" placeholder="비밀번호 확인" autocomplete="new-password" aria-label="비밀번호 확인"></div>
        <div class="actions"><button class="btn primary" type="submit">비밀번호 설정</button></div></form></details>`;
  } else {
    authorBlock = `<details class="box"><summary><b>작성자이신가요?</b></summary>
      <form class="form" data-kind="pw-verify" style="margin-top:12px"><input class="in" type="password" data-f="pw" placeholder="작성자 비밀번호" autocomplete="current-password" aria-label="작성자 비밀번호">
        <div class="actions"><span class="counter">비밀번호를 잊으셨다면 연수 운영진에게 초기화를 요청해 주세요.</span><button class="btn primary" type="submit">작성자 확인</button></div></form></details>`;
  }

  pane.innerHTML = `
    <h3 class="sec-title">팀 만들기${t.teamName ? ` · ${esc(t.teamName)}` : ""}</h3>
    <ol class="steps" aria-label="팀 만들기 단계">${steps}</ol>
    <p class="hint">${statusText}</p>
    <div class="seats">${seatHTML.join("")}</div>
    ${applyBlock}${apps}${authorBlock}`;
  restoreDrafts(pane);
}

function authorLost() {
  S.author[S.openId] = false;
  toast("작성자 확인이 풀렸습니다. 비밀번호를 다시 입력해 주세요.");
  renderTeam(); renderComments();
}
async function authorWrite(fn, ok) {
  if (S.busy) return; S.busy = true;
  try { await fn(); if (ok) toast(ok); }
  catch (e) { if (F.isDenied(e)) authorLost(); else toast("처리하지 못했습니다. 잠시 후 다시 시도해 주세요."); }
  finally { S.busy = false; }
}
async function teamAct(act, el) {
  const id = S.openId, t = teamOf(id), ref = P.prd(id);
  switch (act) {
    case "apply-open": S.applyOpen = true; renderTeam(); return;
    case "apply-close": S.applyOpen = false; S.applyEdit = false; renderTeam(); return;
    case "apply-edit": S.applyEdit = true; renderTeam(); return;
    case "apply-cancel":
      if (!confirm("참여 신청을 취소할까요?")) return;
      try { await F.deleteDoc(P.app(id, S.uid)); toast("신청을 취소했습니다."); }
      catch { toast("취소하지 못했습니다. 모집이 닫혔을 수 있습니다."); }
      return;
    case "pw-toggle": S.pwChange = !S.pwChange; renderTeam(); return;
    case "author-out":
      try { await F.deleteDoc(P.key(id, S.uid)); } catch { /* 이미 없음 */ }
      S.author[id] = false; renderTeam(); renderComments(); toast("이 기기에서 작성자 확인을 해제했습니다."); return;
    case "activate": {
      const name = ($('[data-f="teamName"]') || {}).value?.trim() || "";
      return authorWrite(() => F.updateDoc(ref, { "team.status": "open", "team.teamName": name, "team.activatedAt": F.serverTimestamp() }), "팀 모집을 열었습니다.");
    }
    case "pick": {
      const uid = el.dataset.uid, a = S.apps.find(x => x.id === uid); if (!a) return;
      const sel = t.members.some(m => m.uid === uid);
      if (!sel && t.members.length >= t.capacity - 1) { toast(`작성자 포함 ${t.capacity}명이 모두 찼습니다. 다른 분을 고르려면 먼저 선정을 취소해 주세요.`); return; }
      const members = sel ? t.members.filter(m => m.uid !== uid) : [...t.members, { uid, org: a.org, name: a.name }];
      return authorWrite(() => F.updateDoc(ref, { "team.members": members }), sel ? `${a.name} 선생님 선정을 취소했습니다.` : `${a.name} 선생님을 ${members.length + 1}번 자리로 선정했습니다.`);
    }
    case "finalize": {
      const left = t.capacity - 1 - t.members.length;
      if (left > 0) { toast(`팀원 ${t.capacity - 1}명을 모두 고른 뒤 확정할 수 있습니다. ${left}명이 남았습니다.`); return; }
      if (!confirm(`작성자 포함 ${t.capacity}명으로 팀을 확정할까요? 확정하면 새 신청을 받지 않습니다.`)) return;
      return authorWrite(() => F.updateDoc(ref, { "team.status": "finalized", "team.finalizedAt": F.serverTimestamp() }), "팀을 확정했습니다.");
    }
    case "close": return authorWrite(() => F.updateDoc(ref, { "team.status": "closed" }), "모집을 닫았습니다.");
    case "reopen": return authorWrite(() => F.updateDoc(ref, { "team.status": "open" }), "모집을 다시 열었습니다.");
  }
}
async function submitApply(form) {
  const id = S.openId, ident = readIdent(form); if (!ident) return;
  const note = $('[data-f="note"]', form).value.trim().slice(0, 100);
  try {
    await F.setDoc(P.app(id, S.uid), { ...ident, note, at: F.serverTimestamp() });
    ["apply-org", "apply-name", "apply-note"].forEach(k => delete S.draft[k]);
    S.applyOpen = false; S.applyEdit = false; renderTeam(); toast("팀 참여를 신청했습니다.");
  } catch { toast("신청하지 못했습니다. 모집이 닫혔는지 확인해 주세요."); }
}
async function submitPw(kindName, form) {
  const id = S.openId, pw = $('[data-f="pw"]', form).value, pw2f = $('[data-f="pw2"]', form);
  if (kindName !== "pw-verify") {
    if (!goodPassword(pw)) { toast("영문과 숫자를 섞어 6~30자로 정해 주세요."); return; }
    if (pw2f && pw !== pw2f.value) { toast("두 비밀번호가 서로 다릅니다."); return; }
  }
  if (S.busy) return; S.busy = true;
  try {
    if (kindName === "pw-setup") {
      const b = F.writeBatch(F.db);
      b.set(P.secret(id), { password: pw, setBy: S.uid, setAt: F.serverTimestamp(), resetByAdmin: false });
      b.set(P.key(id, S.uid), { password: pw, at: F.serverTimestamp() });
      b.update(P.prd(id), { passwordSet: true });
      await b.commit();
      S.author[id] = true; toast("비밀번호를 설정했습니다. 이제 팀 만들기를 활성화할 수 있습니다.");
    } else if (kindName === "pw-verify") {
      await F.setDoc(P.key(id, S.uid), { password: pw, at: F.serverTimestamp() });
      S.author[id] = true; toast("작성자로 확인되었습니다.");
    } else {
      const b = F.writeBatch(F.db);
      b.update(P.secret(id), { password: pw, setBy: S.uid, setAt: F.serverTimestamp(), resetByAdmin: false });
      b.set(P.key(id, S.uid), { password: pw, at: F.serverTimestamp() });
      await b.commit();
      S.pwChange = false; toast("비밀번호를 바꿨습니다.");
    }
    renderTeam(); renderComments();
  } catch (e) {
    if (kindName === "pw-verify") toast("비밀번호가 맞지 않습니다.");
    else if (kindName === "pw-setup") toast("이미 비밀번호가 설정되어 있습니다. 작성자 확인으로 들어가 주세요.");
    else if (F.isDenied(e)) authorLost();
    else toast("처리하지 못했습니다.");
  } finally { S.busy = false; }
}

/* ---------------- 입력 보존 ---------------- */
function updateCounter(form) {
  const c = $("[data-counter]", form), b = $('[data-f="body"]', form);
  if (c && b) c.textContent = `${b.value.length}/500`;
}
function restoreDrafts(root) {
  $$("[data-draft]", root).forEach(el => { if (S.draft[el.dataset.draft] != null) el.value = S.draft[el.dataset.draft]; });
  $$("form", root).forEach(updateCounter);
}

/* ---------------- 이벤트 ---------------- */
function bind() {
  document.addEventListener("click", e => {
    const like = e.target.closest("[data-like]"); if (like) { toggleLike(like.dataset.like); return; }
    const op = e.target.closest("[data-open]"); if (op) { openDoc(op.dataset.open, op.dataset.tab); return; }
    const act = e.target.closest("[data-act]");
    if (act && S.openId) {
      const a = act.dataset.act;
      if (["reply", "cancel-reply", "edit", "cancel-edit", "del", "hide", "unhide"].includes(a)) commentAct(a, act);
      else teamAct(a, act);
    }
  });
  $("#paper").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target, k = f.dataset.kind;
    if (k === "new") addComment(f, null);
    else if (k === "reply") addComment(f, { root: f.dataset.root, to: S.replyFor && S.replyFor.root === f.dataset.root ? S.replyFor.to : null });
    else if (k === "edit") saveEdit(f);
    else if (k === "apply") submitApply(f);
    else if (k && k.startsWith("pw-")) submitPw(k, f);
  });
  $("#paper").addEventListener("input", e => {
    const el = e.target;
    if (el.dataset.draft) S.draft[el.dataset.draft] = el.value;
    const f = el.closest("form"); if (f) updateCounter(f);
  });
  $$("#tabs button").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("#vclose").addEventListener("click", closeDoc);
  $("#scrim").addEventListener("click", closeDoc);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && S.openId) closeDoc(); });
  $("#vprint").addEventListener("click", () => {
    setTab("doc"); document.body.classList.add("printing"); window.print(); document.body.classList.remove("printing");
  });
  const fb = $$("#filter button");
  fb.forEach((b, i) => b.addEventListener("click", () => {
    S.filter = b.dataset.f; fb.forEach(x => x.setAttribute("aria-pressed", x === b));
    $("#filter .thumb").style.transform = `translateX(${i * 100}%)`; renderCards();
  }));
  $("#q").addEventListener("input", e => { S.q = e.target.value.trim().toLowerCase(); renderCards(); });
  $$(".seg").forEach(s => { s.querySelector(".thumb").style.width = `calc((100% - 6px) / ${s.querySelectorAll("button").length})`; });
}

/* ---------------- 시작 ---------------- */
async function start() {
  bind(); renderCards();
  const hash = location.hash.slice(1);
  if (byId[hash]) openDoc(hash);
  if (!enabled) { $("#offline").hidden = false; return; }
  try {
    const u = await F.anonUser(); S.uid = u.uid;
  } catch {
    $("#offline").textContent = "서버에 연결하지 못했습니다. 원문은 볼 수 있고, 좋아요·덧글은 잠시 후 새로고침하면 쓸 수 있습니다.";
    $("#offline").hidden = false; return;
  }
  F.onSnapshot(F.collection(F.db, "prds"), snap => {
    snap.docs.forEach(d => { S.prd[d.id] = d.data(); });
    renderCards(); if (S.openId) { renderTeam(); paintTeamTab(); }
  }, () => {});
  loadCounts();
  if (S.openId) openDoc(S.openId, S.tab);
}
start();
