// ====== 単語帳アプリ ロジック本体 ======
// 複数の単語帳（デッキ）に対応：書き / 読み / 画像
// 元のPython(Jupyter Notebook)版と同じ間隔反復ロジックをJavaScriptで再現しています。

const app = document.getElementById("app");

// ---------- Firebase初期化 ----------
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.warn("オフライン永続化を有効化できませんでした:", err.code);
});

// ---------- デッキ（単語帳）の定義 ----------
const DECK_DEFS = [
  { id: "kaki", label: "✍️ 書き" },
  { id: "yomi", label: "📖 読み" },
  { id: "gazou", label: "🖼️ 画像" },
];

function emptyDeck() {
  return {
    toi: [], kotae: [], stage: [], ato: [],
    newtoi: [], newkotae: [],
    owaritoi: [], owarikotae: [],
    tuika: 2,
    lastSessionDate: null,
    newWordsAddedToday: false,
  };
}

function defaultData() {
  const decks = {};
  DECK_DEFS.forEach((d) => { decks[d.id] = emptyDeck(); });
  return {
    decks: decks,
    stageday: [0, 0, 1, 4, 19, 29],
  };
}

// 古い形式(単一デッキ)のデータを「書き」デッキとして移行する
function migrateIfNeeded(raw) {
  if (raw && raw.decks) {
    // 既に新形式。デッキが足りなければ補完する。
    const fixed = Object.assign(defaultData(), raw);
    DECK_DEFS.forEach((d) => {
      if (!fixed.decks[d.id]) fixed.decks[d.id] = emptyDeck();
      fixed.decks[d.id] = Object.assign(emptyDeck(), fixed.decks[d.id]);
    });
    if (!fixed.stageday) fixed.stageday = [0, 0, 1, 4, 19, 29];
    return fixed;
  }
  // 旧形式 -> 「書き」デッキへ移行
  const fresh = defaultData();
  if (raw && Array.isArray(raw.toi)) {
    fresh.decks.kaki = Object.assign(emptyDeck(), {
      toi: raw.toi || [], kotae: raw.kotae || [],
      stage: raw.stage || [], ato: raw.ato || [],
      newtoi: raw.newtoi || [], newkotae: raw.newkotae || [],
      owaritoi: raw.owaritoi || [], owarikotae: raw.owarikotae || [],
      tuika: raw.tuika != null ? raw.tuika : 2,
      lastSessionDate: raw.lastSessionDate || null,
      newWordsAddedToday: raw.newWordsAddedToday || false,
    });
  }
  if (raw && raw.stageday) fresh.stageday = raw.stageday;
  return fresh;
}

// ---------- グローバル状態 ----------
let currentUser = null;
let data = null;            // Firestoreに保存される本体データ
let currentDeckId = "kaki"; // 現在選択中のデッキ
let phase = "loading";      // loading / auth / home / review / mistakes / finished / list
let session = null;         // { queue, pos, mistakes, mistakePos, showAnswer }
let listTab = "toi";        // list画面内のタブ: toi / new / owari
let authError = "";
let authMode = "login";
let imageCache = {};        // { imageId: dataURL } 写真(圧縮済みbase64)のキャッシュ
let addFormPhoto = { toi: null, kotae: null }; // 単語追加フォームで選択中の写真の参照

function userDocRef() {
  return db.collection("users").doc(currentUser.uid);
}

function imagesCollectionRef() {
  return userDocRef().collection("images");
}

function deck() {
  return data.decks[currentDeckId];
}

async function loadUserData() {
  const snap = await userDocRef().get();
  if (snap.exists) {
    data = migrateIfNeeded(snap.data());
  } else {
    data = defaultData();
  }
  await userDocRef().set(data);
}

// 写真(圧縮済みbase64)を全部読み込んでキャッシュする。
// Firestoreのオフライン永続化により、一度読み込んでいればオフラインでも参照できる。
async function loadImageCache() {
  try {
    const snap = await imagesCollectionRef().get();
    snap.forEach((doc) => {
      const d = doc.data();
      if (d && d.data) imageCache[doc.id] = d.data;
    });
  } catch (e) {
    console.warn("画像キャッシュの読み込みに失敗(オフラインの可能性):", e);
  }
}

function saveUserData() {
  userDocRef().set(data).catch((e) => console.warn("保存待機中(オフライン):", e));
}

// ---------- 日付 ----------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- 重み付きランダム選択 ----------
// newtoi/newkotaeは「追加した順（古い→新しい）」に並んでいる前提。
// 添字が小さい(=古い)ほど重みを大きくし、選ばれやすくする。
function weightedRandomIndex(n) {
  if (n <= 0) return -1;
  let total = 0;
  const weights = [];
  for (let i = 0; i < n; i++) {
    const w = n - i; // 最初の要素が最も重い
    weights.push(w);
    total += w;
  }
  let r = Math.random() * total;
  for (let i = 0; i < n; i++) {
    if (r < weights[i]) return i;
    r -= weights[i];
  }
  return n - 1;
}

// Fisher-Yatesシャッフル(配列を直接並び替える)
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- 学習セッションのロジック ----------
function startSession() {
  const d = deck();
  const today = todayStr();
  if (d.lastSessionDate !== today) {
    for (let i = 0; i < d.ato.length; i++) {
      if (d.ato[i] !== 0) d.ato[i] -= 1;
    }
    d.lastSessionDate = today;
    d.newWordsAddedToday = false;
    saveUserData();
  }
  const queue = [];
  for (let i = 0; i < d.ato.length; i++) {
    if (d.ato[i] === 0) queue.push(i);
  }
  // 「画像」デッキは、出題する単語は変えずに最初の一周の順番だけランダムにする
  if (currentDeckId === "gazou") {
    shuffleArray(queue);
  }
  session = { queue, pos: 0, mistakes: [], mistakePos: 0, showAnswer: false };
  phase = "review";
  render();
}

function addNewWordsIfNeeded() {
  const d = deck();
  if (d.newWordsAddedToday) return;
  let k = 0;
  while (k < d.tuika && d.newtoi.length > 0) {
    const t = weightedRandomIndex(d.newtoi.length);
    d.toi.push(d.newtoi.splice(t, 1)[0]);
    d.kotae.push(d.newkotae.splice(t, 1)[0]);
    d.stage.push(0);
    d.ato.push(0);
    k++;
  }
  d.newWordsAddedToday = true;
  saveUserData();
}

function answerCorrect(idx) {
  const d = deck();
  if (d.stage[idx] < 5) {
    d.stage[idx] += 1;
    d.ato[idx] = data.stageday[d.stage[idx]];
  } else {
    d.owaritoi.push(d.toi[idx]);
    d.owarikotae.push(d.kotae[idx]);
    d.toi.splice(idx, 1);
    d.kotae.splice(idx, 1);
    d.stage.splice(idx, 1);
    d.ato.splice(idx, 1);
    session.queue = session.queue.filter((q) => q !== idx).map((q) => (q > idx ? q - 1 : q));
  }
  saveUserData();
}

function answerWrong(idx) {
  const d = deck();
  session.mistakes.push({ toi: d.toi[idx], kotae: d.kotae[idx] });
  d.stage[idx] = 0;
  d.ato[idx] = 0;
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
    "auth/invalid-credential": "メールアドレスかパスワードが正しくありません。初めての場合は「新規登録」を使ってください。",
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
    await loadImageCache();
    phase = "home";
    render();
  } else {
    currentUser = null;
    data = null;
    imageCache = {};
    phase = "auth";
    render();
  }
});

// ---------- 既存データのインポート ----------
function importJsonFile(file, targetDeckId) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      let deckData;
      if (imported.decks) {
        // 新形式のファイル全体が来た場合は、選択したデッキ分だけ抜き出す
        deckData = imported.decks[targetDeckId] || imported.decks.kaki;
      } else {
        deckData = imported; // 旧形式（toi/kotaeなどが直接入っている）
      }
      data.decks[targetDeckId] = Object.assign(emptyDeck(), {
        toi: deckData.toi || [], kotae: deckData.kotae || [],
        stage: deckData.stage || [], ato: deckData.ato || [],
        newtoi: deckData.newtoi || [], newkotae: deckData.newkotae || [],
        owaritoi: deckData.owaritoi || [], owarikotae: deckData.owarikotae || [],
        tuika: deckData.tuika != null ? deckData.tuika : 2,
      });
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

// ---------- 配列形式（Pythonのリスト文字列）からの一括パース ----------
// toi=['a', 'b','c'] のような文字列から、カンマ直後のスペースの有無に関わらず
// 引用符で囲まれた要素だけを正確に取り出す。
function parseArrayLiteral(text) {
  const items = [];
  const regex = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    let inner = match[1] !== undefined ? match[1] : match[2];
    const quoteChar = match[1] !== undefined ? "'" : '"';
    inner = inner.replace(new RegExp("\\\\" + quoteChar, "g"), quoteChar).replace(/\\\\/g, "\\");
    items.push(inner);
  }
  if (items.length > 0) return items;
  // 引用符が見つからない場合は、1行1単語として扱う
  return text.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

function bulkAddToNewPool(toiText, kotaeText) {
  const toiItems = parseArrayLiteral(toiText);
  const kotaeItems = parseArrayLiteral(kotaeText);
  if (toiItems.length === 0 || kotaeItems.length === 0) {
    return { ok: false, message: "問題・答えのどちらかが空、または読み取れませんでした。" };
  }
  if (toiItems.length !== kotaeItems.length) {
    return {
      ok: false,
      message: `問題(${toiItems.length}個)と答え(${kotaeItems.length}個)の数が一致しません。両方の数を確認してください。`,
    };
  }
  const d = deck();
  d.newtoi.push(...toiItems);
  d.newkotae.push(...kotaeItems);
  saveUserData();
  return { ok: true, message: `${toiItems.length}個の単語を新規プールに追加しました。` };
}

// ---------- 写真の圧縮・保存 ----------
// 選択した画像ファイルを、長辺maxDimpx・JPEG品質qualityに圧縮してdata URLにする
function compressImageFile(file, maxDim = 800, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w >= h && w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
        else if (h > w && h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"));
    reader.readAsDataURL(file);
  });
}

// 圧縮した写真をFirestoreの images コレクションに保存し、参照文字列を返す
async function saveImageAndGetRef(file) {
  const dataUrl = await compressImageFile(file);
  const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  imageCache[id] = dataUrl; // 即座にローカルキャッシュへ反映(オフラインでも即表示できる)
  imagesCollectionRef().doc(id).set({ data: dataUrl }).catch((e) => {
    console.warn("画像の保存待機中(オフライン):", e);
  });
  return `firestoreimg:${id}`;
}

// ---------- 画像判定・表示ヘルパー ----------
function isImagePath(str) {
  return (
    typeof str === "string" &&
    (/\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(str.trim()) || /^data:image\//i.test(str.trim()))
  );
}

function renderField(str, maxHeight) {
  if (typeof str === "string" && str.startsWith("firestoreimg:")) {
    const id = str.slice("firestoreimg:".length);
    const dataUrl = imageCache[id];
    if (dataUrl) {
      return `<img src="${dataUrl}" alt="" style="max-width:100%; max-height:${maxHeight || 260}px; border-radius:8px;">`;
    }
    return `<span class="caption">📷 画像を読み込み中...</span>`;
  }
  if (isImagePath(str)) {
    const safeSrc = String(str).replace(/"/g, "%22");
    return `<img src="${safeSrc}" alt="" style="max-width:100%; max-height:${maxHeight || 260}px; border-radius:8px;">`;
  }
  return escapeHtml(str);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// ---------- 画面描画 ----------
function render() {
  if (phase === "loading" || phase === "boot") {
    app.innerHTML = `<div class="spinner"></div>`;
    return;
  }
  if (phase === "auth") { renderAuth(); return; }
  if (phase === "home") renderHome();
  else if (phase === "review") renderReview();
  else if (phase === "mistakes") renderMistakes();
  else if (phase === "finished") renderFinished();
  else if (phase === "list") renderList();
}

function offlineBadge() {
  return navigator.onLine ? "" : `<div class="offline-badge">📴 オフラインで動作中（ネット接続時に自動同期されます）</div>`;
}

function deckTabsHtml() {
  return `<div class="deck-tabs">
    ${DECK_DEFS.map((dd) => `<div class="deck-tab ${dd.id === currentDeckId ? "active" : ""}" data-deck="${dd.id}">${dd.label}</div>`).join("")}
  </div>`;
}

function bindDeckTabs() {
  document.querySelectorAll(".deck-tab").forEach((el) => {
    el.onclick = () => {
      currentDeckId = el.getAttribute("data-deck");
      addFormPhoto = { toi: null, kotae: null };
      phase = "home";
      render();
    };
  });
}

// 単語追加フォームの「問題」「答え」欄: テキスト入力 or 写真サムネイル表示を切り替える
function addFieldHtml(fieldKey, label) {
  const photoRef = addFormPhoto[fieldKey];
  if (photoRef) {
    const id = photoRef.slice("firestoreimg:".length);
    const dataUrl = imageCache[id] || "";
    return `
      <label>${label}</label>
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
        <img src="${dataUrl}" style="width:56px;height:56px;object-fit:cover;border-radius:8px; flex-shrink:0;">
        <span style="flex:1; color:var(--muted); font-size:0.85rem;">写真が選択されています</span>
        <button class="btn-secondary" data-clear-photo="${fieldKey}" type="button">✕</button>
      </div>
    `;
  }
  return `
    <label>${label}</label>
    <div style="display:flex; gap:8px; margin-bottom:10px;">
      <input type="text" id="new-${fieldKey}" placeholder="テキストを入力" style="flex:1; margin-bottom:0;">
      <button class="btn-secondary" data-photo-btn="${fieldKey}" type="button" style="white-space:nowrap;">📷写真</button>
    </div>
    <input type="file" accept="image/*" id="photo-input-${fieldKey}" style="display:none;">
  `;
}

function refreshAddWordFields() {
  document.getElementById("add-word-fields").innerHTML =
    addFieldHtml("toi", "問題（表面）") + addFieldHtml("kotae", "答え（裏面）");
  bindAddWordFields();
}

function bindAddWordFields() {
  ["toi", "kotae"].forEach((fieldKey) => {
    const photoBtn = document.querySelector(`[data-photo-btn="${fieldKey}"]`);
    if (photoBtn) {
      photoBtn.onclick = () => document.getElementById(`photo-input-${fieldKey}`).click();
      const fileInput = document.getElementById(`photo-input-${fieldKey}`);
      fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const fieldsEl = document.getElementById("add-word-fields");
        const prevHtml = fieldsEl.innerHTML;
        fieldsEl.innerHTML = `<div class="caption">📷 写真を処理中...</div>` + prevHtml;
        try {
          const ref = await saveImageAndGetRef(file);
          addFormPhoto[fieldKey] = ref;
        } catch (err) {
          alert("写真の処理に失敗しました: " + err.message);
        }
        refreshAddWordFields();
      };
    }
    const clearBtn = document.querySelector(`[data-clear-photo="${fieldKey}"]`);
    if (clearBtn) {
      clearBtn.onclick = () => {
        addFormPhoto[fieldKey] = null;
        refreshAddWordFields();
      };
    }
  });
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
  const d = deck();
  const dueCount = d.ato.filter((a) => a === 0).length;
  const newCount = Math.min(d.tuika, d.newtoi.length);
  const deckLabel = DECK_DEFS.find((x) => x.id === currentDeckId).label;

  app.innerHTML = `
    <h1>📘 単語帳アプリ</h1>
    ${deckTabsHtml()}
    ${offlineBadge()}
    <div class="stats">
      <div class="stat"><div class="num">${d.toi.length}</div><div class="label">復習中</div></div>
      <div class="stat"><div class="num">${d.newtoi.length}</div><div class="label">新規プール</div></div>
      <div class="stat"><div class="num">${d.owaritoi.length}</div><div class="label">習得済み</div></div>
    </div>
    <div class="card">
      <p>「${deckLabel}」で今日学習できる単語: <b>${dueCount}個</b><br>新規追加予定: <b>${newCount}個</b></p>
      <button class="btn-primary" id="start-btn">▶️ 今日の学習を始める</button>
    </div>

    <button class="btn-secondary" id="list-btn" style="width:100%; margin-bottom:16px;">📚 単語一覧を見る</button>

    <details class="card">
      <summary>➕ 新しい単語を追加する（${deckLabel}）</summary>
      <div style="margin-top:10px;">
        <div id="add-word-fields">
          ${addFieldHtml("toi", "問題（表面）")}
          ${addFieldHtml("kotae", "答え（裏面）")}
        </div>
        <button class="btn-primary" id="add-word-btn" style="width:100%;">プールに追加</button>
        <div id="add-word-msg"></div>
      </div>
    </details>

    <details class="card">
      <summary>📋 配列から一括追加（${deckLabel}）</summary>
      <div style="margin-top:10px;">
        <p class="caption">Pythonの <code>toi=['...', '...']</code> 形式のテキストをそのまま貼り付けられます。</p>
        <label>問題の配列（toi）</label>
        <textarea id="bulk-toi" rows="4" style="width:100%; padding:10px; border-radius:10px; border:1px solid var(--border); font-family:inherit; margin-bottom:10px;" placeholder="toi=['apple', 'banana', 'cherry']"></textarea>
        <label>答えの配列（kotae）</label>
        <textarea id="bulk-kotae" rows="4" style="width:100%; padding:10px; border-radius:10px; border:1px solid var(--border); font-family:inherit; margin-bottom:10px;" placeholder="kotae=['りんご', 'バナナ', 'さくらんぼ']"></textarea>
        <button class="btn-primary" id="bulk-add-btn" style="width:100%;">一括追加（新規プールへ）</button>
        <div id="bulk-add-msg"></div>
      </div>
    </details>

    <details class="card">
      <summary>⚙️ 設定（${deckLabel}）</summary>
      <div style="margin-top:10px;">
        <label>1日に追加する新規単語数</label>
        <input type="number" id="tuika-input" min="0" max="20" value="${d.tuika}">
        <button class="btn-secondary" id="save-tuika-btn" style="width:100%;">保存</button>
      </div>
    </details>

    <details class="card">
      <summary>📥 データをインポート</summary>
      <div style="margin-top:10px;">
        <p class="caption">JSONファイルを読み込んで、指定したデッキのデータを上書きします。</p>
        <label>インポート先のデッキ</label>
        <select id="import-deck-select">
          ${DECK_DEFS.map((dd) => `<option value="${dd.id}" ${dd.id === currentDeckId ? "selected" : ""}>${dd.label}</option>`).join("")}
        </select>
        <input type="file" id="import-file" accept="application/json" style="margin-top:8px;">
      </div>
    </details>

    <button class="link-btn" id="logout-btn" style="margin-top:10px;">ログアウト</button>
  `;

  bindDeckTabs();
  bindAddWordFields();

  document.getElementById("start-btn").onclick = startSession;
  document.getElementById("list-btn").onclick = () => { phase = "list"; listTab = "toi"; render(); };

  document.getElementById("add-word-btn").onclick = () => {
    const tInput = document.getElementById("new-toi");
    const kInput = document.getElementById("new-kotae");
    const t = addFormPhoto.toi || (tInput ? tInput.value.trim() : "");
    const k = addFormPhoto.kotae || (kInput ? kInput.value.trim() : "");
    const msgEl = document.getElementById("add-word-msg");
    if (t && k) {
      deck().newtoi.push(t);
      deck().newkotae.push(k);
      saveUserData();
      msgEl.innerHTML = `<div class="success-msg">追加しました！</div>`;
      addFormPhoto = { toi: null, kotae: null };
      refreshAddWordFields();
    } else {
      msgEl.innerHTML = `<div class="error-msg">問題と答えの両方を入力(または写真を選択)してください。</div>`;
    }
  };

  document.getElementById("bulk-add-btn").onclick = () => {
    const toiText = document.getElementById("bulk-toi").value;
    const kotaeText = document.getElementById("bulk-kotae").value;
    const result = bulkAddToNewPool(toiText, kotaeText);
    const msgEl = document.getElementById("bulk-add-msg");
    if (result.ok) {
      msgEl.innerHTML = `<div class="success-msg">${result.message}</div>`;
      document.getElementById("bulk-toi").value = "";
      document.getElementById("bulk-kotae").value = "";
    } else {
      msgEl.innerHTML = `<div class="error-msg">${result.message}</div>`;
    }
  };

  document.getElementById("save-tuika-btn").onclick = () => {
    const v = parseInt(document.getElementById("tuika-input").value, 10);
    if (!isNaN(v) && v >= 0) {
      deck().tuika = v;
      saveUserData();
      render();
    }
  };

  document.getElementById("import-file").onchange = (e) => {
    const targetDeckId = document.getElementById("import-deck-select").value;
    const deckLbl = DECK_DEFS.find((x) => x.id === targetDeckId).label;
    if (e.target.files[0] && confirm(`「${deckLbl}」のデータを上書きします。よろしいですか？`)) {
      importJsonFile(e.target.files[0], targetDeckId);
    }
  };

  document.getElementById("logout-btn").onclick = () => auth.signOut();
}

function renderReview() {
  const d = deck();
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
    <div class="caption">${DECK_DEFS.find((x) => x.id === currentDeckId).label} - 復習 ${session.pos + 1} / ${session.queue.length}</div>
    <div class="card question-card">
      <div class="question-text">${renderField(d.toi[idx])}</div>
      ${session.showAnswer ? `<div class="answer-text">${renderField(d.kotae[idx])}</div>` : ""}
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
      <div class="question-text">${renderField(item.toi)}</div>
      ${session.showAnswer ? `<div class="answer-text">${renderField(item.kotae)}</div>` : ""}
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

function renderList() {
  const d = deck();
  const deckLabel = DECK_DEFS.find((x) => x.id === currentDeckId).label;

  let items = [];
  let badgeFn = null;
  if (listTab === "toi") {
    items = d.toi.map((t, i) => ({ toi: t, kotae: d.kotae[i], stage: d.stage[i] }));
    badgeFn = (it) => `ステージ${it.stage}`;
  } else if (listTab === "new") {
    items = d.newtoi.map((t, i) => ({ toi: t, kotae: d.newkotae[i] }));
  } else if (listTab === "owari") {
    items = d.owaritoi.map((t, i) => ({ toi: t, kotae: d.owarikotae[i] }));
  }

  app.innerHTML = `
    <button class="link-btn back-link" id="back-btn">← ホームに戻る</button>
    <h1>📚 単語一覧（${deckLabel}）</h1>
    <div class="list-tabs">
      <div class="list-tab ${listTab === "toi" ? "active" : ""}" data-tab="toi">復習中 (${d.toi.length})</div>
      <div class="list-tab ${listTab === "new" ? "active" : ""}" data-tab="new">新規プール (${d.newtoi.length})</div>
      <div class="list-tab ${listTab === "owari" ? "active" : ""}" data-tab="owari">習得済み (${d.owaritoi.length})</div>
    </div>
    <div class="card">
      ${
        items.length === 0
          ? `<div class="empty-msg">該当する単語はありません</div>`
          : items.map((it) => `
              <div class="word-item">
                <div class="qa">
                  <div class="q">${renderField(it.toi, 80)}</div>
                  <div class="a">${renderField(it.kotae, 80)}</div>
                </div>
                ${badgeFn ? `<div class="badge">${badgeFn(it)}</div>` : ""}
              </div>
            `).join("")
      }
    </div>
  `;

  document.getElementById("back-btn").onclick = () => { phase = "home"; render(); };
  document.querySelectorAll(".list-tab").forEach((el) => {
    el.onclick = () => { listTab = el.getAttribute("data-tab"); render(); };
  });
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
