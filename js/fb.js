// Firebase 초기화와 공용 함수. 설정값이 없으면 enabled=false로 두고, 화면은 읽기 전용으로 동작합니다.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit,
  onSnapshot, writeBatch, serverTimestamp, getCountFromServer, getDocs, addDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const enabled = !!(firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith("YOUR"));
export let auth = null, db = null;
if (enabled) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

/** 방문자용: 익명 로그인까지 마친 사용자를 돌려줍니다. */
export function anonUser() {
  return new Promise((resolve, reject) => {
    const off = onAuthStateChanged(auth, u => {
      if (u) { off(); resolve(u); }
      else signInAnonymously(auth).catch(err => { off(); reject(err); });
    });
  });
}

export const P = {
  prd: id => doc(db, "prds", id),
  secret: id => doc(db, "secrets", id),
  key: (id, uid) => doc(db, "prds", id, "authorKeys", uid),
  like: (id, uid) => doc(db, "prds", id, "likes", uid),
  likes: id => collection(db, "prds", id, "likes"),
  comments: id => collection(db, "prds", id, "comments"),
  comment: (id, cid) => doc(db, "prds", id, "comments", cid),
  apps: id => collection(db, "prds", id, "applications"),
  app: (id, uid) => doc(db, "prds", id, "applications", uid),
  admin: uid => doc(db, "admins", uid),
  logs: () => collection(db, "adminLogs"),
};

export const isDenied = e => e && (e.code === "permission-denied" || /permission/i.test(e.message || ""));

export {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit,
  onSnapshot, writeBatch, serverTimestamp, getCountFromServer, getDocs, addDoc
};
