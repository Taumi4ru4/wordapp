// ====== 単語帳アプリ ロジック本体 ======
// 元のPython(Jupyter Notebook)版と同じ間隔反復ロジックをJavaScriptで再現しています。

const app = document.getElementById("app");

// ---------- Firebase初期化 ----------
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.warn("オフライン永続化を有効化できませんでした:", err.code);
});

// ---------- デフォルトデータ ----------
function defaultData() {
  return {
    toi: [], kotae: [], stage: [], ato: [],
    newtoi: [], newkotae: [],
    owaritoi: [], owarikotae: [],
    tuika: 2,
    stageday: [0, 0, 1, 4, 19, 29],
    lastSessionDate: null,
    newWordsAddedToday: false,
  };
}

// ---------- グローバル状態 ----------
let currentUser = null;
let data = null;          // Firestoreに保存される本体データ
let phase = "loading";    // loading / auth / home / review / mistakes / finished
let session = null;       // { queue, pos, mistakes, mistakePos, showAnswer }
let authError = "";
let authMode = "login";   // login / register

function userDocRef() {
  return db.collection("users").doc(currentUser.uid);
}

async function loadUserData() {
  const snap = await userDocRef().get();
  if (snap.exists) {
    data = Object.assign(defaultData(), snap.data());
  } else {
    data = defaultData();
    await userDocRef().set(data);
  }
}

function saveUserData() {
  // Firestoreのオフライン永続化により、オフライン時はローカルに保存され、
  // 接続が戻った時点で自動的にクラウドへ同期されます。
  userDocRef().set(data).catch((e) => console.warn("保存待機中(オフライン):", e));
}

// ---------- 学習セッションのロジック ----------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startSession() {
  const today = todayStr();
  if (data.lastSessionDate !== today) {
    for (let i = 0; i < data.ato.length; i++) {
      if (data.ato[i] !== 0) data.ato[i] -= 1;
    }
    data.lastSessionDate = today;
    data.newWordsAddedToday = false;
    saveUserData();
  }
  const queue = [];
  for (let i = 0; i < data.ato.length; i++) {
    if (data.ato[i] === 0) queue.push(i);
  }
  session = { queue, pos: 0, mistakes: [], mistakePos: 0, showAnswer: false };
  phase = "review";
  render();
}

function addNewWordsIfNeeded() {
  if (data.newWordsAddedToday) return;
  let k = 0;
  while (k < data.tuika && data.newtoi.length > 0) {
    const t = Math.floor(Math.random() * data.newtoi.length);
    data.toi.push(data.newtoi.splice(t, 1)[0]);
    data.kotae.push(data.newkotae.splice(t, 1)[0]);
    data.stage.push(0);
    data.ato.push(0);
    k++;
  }
  data.newWordsAddedToday = true;
  saveUserData();
}

function answerCorrect(idx) {
  if (data.stage[idx] < 5) {
    data.stage[idx] += 1;
    data.ato[idx] = data.stageday[data.stage[idx]];
  } else {
    data.owaritoi.push(data.toi[idx]);
    data.owarikotae.push(data.kotae[idx]);
    data.toi.splice(idx, 1);
    data.kotae.splice(idx, 1);
    data.stage.splice(idx, 1);
    data.ato.splice(idx, 1);
    session.queue = session.queue.filter((q) => q !== idx).map((q) => (q > idx ? q - 1 : q));
  }
  saveUserData();
}

function answerWrong(idx) {
  session.mistakes.push({ toi: data.toi[idx], kotae: data.kotae[idx] });
  data.stage[idx] = 0;
  data.ato[idx] = 0;
  saveUserData();
}

// ---------- 認証 ----------
async function handleAuthSubmit(email, password) {
  authError = "";
  try {
    if (authMode === "login") {
      await auth.signInWithEmailAndPassword(email, password);
    } else {
      await auth.createUserWithEmailAndPassword(email, password);
    }
  } catch (e) {
    authError = translateAuthError(e.code) || e.message;
    render();
  }
}

function translateAuthError(code) {
  const map = {
    "auth/invalid-email": "メールアドレスの形式が正しくありません。",
    "auth/user-not-found": "ユーザーが見つかりません。新規登録してください。",
    "auth/wrong-password": "パスワードが間違っています。",
    "auth/email-already-in-use": "そのメールアドレスは既に登録されています。",
    "auth/weak-password": "パスワードは6文字以上にしてください。",
    "auth/network-request-failed": "通信エラー。オフラインの場合、初回ログインにはネット接続が必要です。",
  };
  return map[code];
}

auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    phase = "boot";
    render();
    await loadUserData();
    phase = "home";
    render();
  } else {
    currentUser = null;
    data = null;
    phase = "auth";
    render();
  }
});

// ---------- 既存データのインポート ----------
function importJsonFile(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      data = Object.assign(defaultData(), imported);
      await userDocRef().set(data);
      alert("インポートしました！");
      phase = "home";
      render();
    } catch (err) {
      alert("読み込みに失敗しました。JSON形式を確認してください。\n" + err.message);
    }
  };
  reader.readAsText(file);
}

// ---------- 画面描画 ----------
function render() {
  if (phase === "loading" || phase === "boot") {
    app.innerHTML = `<div class="spinner"></div>`;
    return;
  }
  if (phase === "auth") {
    renderAuth();
    return;
  }
  if (!navigator.onLine) {
    // オフラインバッジは各画面の先頭に付ける
  }
  if (phase === "home") renderHome();
  else if (phase === "review") renderReview();
  else if (phase === "mistakes") renderMistakes();
  else if (phase === "finished") renderFinished();
}

function offlineBadge() {
  return navigator.onLine ? "" : `<div class="offline-badge">📴 オフラインで動作中（ネット接続時に自動同期されます）</div>`;
}

function renderAuth() {
  app.innerHTML = `
    <h1>📘 単語帳アプリ</h1>
    <div class="card">
      <div style="display:flex; gap:8px; margin-bottom:16px;">
        <button id="tab-login" class="${authMode === "login" ? "btn-primary" : "btn-secondary"}" style="flex:1;">ログイン</button>
        <button id="tab-register" class="${authMode === "register" ? "btn-primary" : "btn-secondary"}" style="flex:1;">新規登録</button>
      </div>
      ${authError ? `<div class="error-msg">${authError}</div>` : ""}
      <label>メールアドレス</label>
      <input type="email" id="auth-email" placeholder="example@email.com">
      <label>パスワード（6文字以上）</label>
      <input type="password" id="auth-password" placeholder="••••••">
      <button id="auth-submit" class="btn-primary" style="width:100%; margin-top:6px;">
        ${authMode === "login" ? "ログイン" : "登録する"}
      </button>
      <p class="caption" style="margin-top:14px;">
        ※初回ログイン・登録にはインターネット接続が必要です。一度ログインすればオフラインでも使えます。
      </p>
    </div>
  `;
  document.getElementById("tab-login").onclick = () => { authMode = "login"; authError = ""; render(); };
  document.getElementById("tab-register").onclick = () => { authMode = "register"; authError = ""; render(); };
  document.getElementById("auth-submit").onclick = () => {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    if (!email || !password) {
      authError = "メールアドレスとパスワードを入力してください。";
      render();
      return;
    }
    handleAuthSubmit(email, password);
  };
}

function renderHome() {
  const dueCount = data.ato.filter((a) => a === 0).length;
  const newCount = Math.min(data.tuika, data.newtoi.length);
  app.innerHTML = `
    <h1>📘 単語帳アプリ</h1>
    ${offlineBadge()}
    <div class="stats">
      <div class="stat"><div class="num">${data.toi.length}</div><div class="label">復習中</div></div>
      <div class="stat"><div class="num">${data.newtoi.length}</div><div class="label">新規プール</div></div>
      <div class="stat"><div class="num">${data.owaritoi.length}</div><div class="label">習得済み</div></div>
    </div>
    <div class="card">
      <p>今日学習できる単語: <b>${dueCount}個</b><br>新規追加予定: <b>${newCount}個</b></p>
      <button class="btn-primary" id="start-btn">▶️ 今日の学習を始める</button>
    </div>

    <details class="card">
      <summary>➕ 新しい単語を追加する</summary>
      <div style="margin-top:10px;">
        <label>問題（表面）</label>
        <input type="text" id="new-toi">
        <label>答え（裏面）</label>
        <input type="text" id="new-kotae">
        <button class="btn-primary" id="add-word-btn" style="width:100%;">プールに追加</button>
        <div id="add-word-msg"></div>
      </div>
    </details>

    <details class="card">
      <summary>⚙️ 設定</summary>
      <div style="margin-top:10px;">
        <label>1日に追加する新規単語数</label>
        <input type="number" id="tuika-input" min="0" max="20" value="${data.tuika}">
        <button class="btn-secondary" id="save-tuika-btn" style="width:100%;">保存</button>
      </div>
    </details>

    <details class="card">
      <summary>📥 以前のデータをインポート（最初の1回だけ）</summary>
      <div style="margin-top:10px;">
        <p class="caption">以前Pythonで使っていた tangocho_data.json を読み込んで移行できます。<br>
        ⚠️ 現在のクラウド上のデータは上書きされます。</p>
        <input type="file" id="import-file" accept="application/json">
      </div>
    </details>

    <button class="link-btn" id="logout-btn" style="margin-top:10px;">ログアウト</button>
  `;

  document.getElementById("start-btn").onclick = startSession;

  document.getElementById("add-word-btn").onclick = () => {
    const t = document.getElementById("new-toi").value.trim();
    const k = document.getElementById("new-kotae").value.trim();
    if (t && k) {
      data.newtoi.push(t);
      data.newkotae.push(k);
      saveUserData();
      document.getElementById("add-word-msg").innerHTML = `<div class="success-msg">追加しました！</div>`;
      document.getElementById("new-toi").value = "";
      document.getElementById("new-kotae").value = "";
    }
  };

  document.getElementById("save-tuika-btn").onclick = () => {
    const v = parseInt(document.getElementById("tuika-input").value, 10);
    if (!isNaN(v) && v >= 0) {
      data.tuika = v;
      saveUserData();
      render();
    }
  };

  document.getElementById("import-file").onchange = (e) => {
    if (e.target.files[0] && confirm("現在のクラウドデータを上書きします。よろしいですか？")) {
      importJsonFile(e.target.files[0]);
    }
  };

  document.getElementById("logout-btn").onclick = () => auth.signOut();
}

function renderReview() {
  if (session.pos >= session.queue.length) {
    addNewWordsIfNeeded();
    phase = "mistakes";
    render();
    return;
  }
  const idx = session.queue[session.pos];
  const progressPct = (session.pos / Math.max(session.queue.length, 1)) * 100;

  app.innerHTML = `
    ${offlineBadge()}
    <div class="progress-bar"><div class="progress-bar-fill" style="width:${progressPct}%"></div></div>
    <div class="caption">復習 ${session.pos + 1} / ${session.queue.length}</div>
    <div class="card question-card">
      <div class="question-text">${escapeHtml(data.toi[idx])}</div>
      ${session.showAnswer ? `<div class="answer-text">${escapeHtml(data.kotae[idx])}</div>` : ""}
    </div>
    ${
      session.showAnswer
        ? `<div class="row-2">
             <button class="btn-success" id="correct-btn">✅ 正解</button>
             <button class="btn-danger" id="wrong-btn">❌ 間違い</button>
           </div>`
        : `<button class="btn-primary" id="show-answer-btn">👁️ 答えを見る</button>`
    }
  `;

  if (session.showAnswer) {
    document.getElementById("correct-btn").onclick = () => {
      answerCorrect(idx);
      session.pos++;
      session.showAnswer = false;
      render();
    };
    document.getElementById("wrong-btn").onclick = () => {
      answerWrong(idx);
      session.pos++;
      session.showAnswer = false;
      render();
    };
  } else {
    document.getElementById("show-answer-btn").onclick = () => {
      session.showAnswer = true;
      render();
    };
  }
}

function renderMistakes() {
  if (session.mistakes.length === 0) {
    phase = "finished";
    render();
    return;
  }
  const pos = session.mistakePos % session.mistakes.length;
  const item = session.mistakes[pos];

  app.innerHTML = `
    ${offlineBadge()}
    <div class="caption">間違えた単語の再挑戦（残り ${session.mistakes.length}個）</div>
    <div class="card question-card">
      <div class="question-text">${escapeHtml(item.toi)}</div>
      ${session.showAnswer ? `<div class="answer-text">${escapeHtml(item.kotae)}</div>` : ""}
    </div>
    ${
      session.showAnswer
        ? `<div class="row-2">
             <button class="btn-success" id="correct-btn">✅ 正解</button>
             <button class="btn-danger" id="wrong-btn">❌ もう一度</button>
           </div>`
        : `<button class="btn-primary" id="show-answer-btn">👁️ 答えを見る</button>`
    }
  `;

  if (session.showAnswer) {
    document.getElementById("correct-btn").onclick = () => {
      session.mistakes.splice(pos, 1);
      if (session.mistakes.length > 0) session.mistakePos = pos % session.mistakes.length;
      session.showAnswer = false;
      render();
    };
    document.getElementById("wrong-btn").onclick = () => {
      session.mistakePos = (pos + 1) % session.mistakes.length;
      session.showAnswer = false;
      render();
    };
  } else {
    document.getElementById("show-answer-btn").onclick = () => {
      session.showAnswer = true;
      render();
    };
  }
}

function renderFinished() {
  app.innerHTML = `
    ${offlineBadge()}
    <div class="card center">
      <div class="icon">🎉</div>
      <p>今日の学習はすべて終了しました！<br>お疲れさまでした。</p>
      <button class="btn-primary" id="home-btn" style="width:100%;">🏠 ホームに戻る</button>
    </div>
  `;
  document.getElementById("home-btn").onclick = () => {
    phase = "home";
    render();
  };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// オンライン/オフライン切り替え時にバッジを更新
window.addEventListener("online", render);
window.addEventListener("offline", render);

// ---------- Service Worker登録 ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((e) => console.warn("SW登録失敗:", e));
  });
}
