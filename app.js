/* ============================================================
   GÖRME KESKİNLİĞİ TESTİ — app.js (FİNAL SÜRÜM)
   - PeerJS + Html5Qrcode + yerel QR üretimi
   - Hasta: QR tarama VEYA manuel ID ile bağlanma
   - Doktor: ID kopyalama + QR yedek zinciri
   ============================================================ */

/* ===================== SABİTLER ===================== */
const LETTERS_WITH_O = "ABCDEFGHJKLMNOPQRSTUVWXYZ"; // O dahil (uyarı metni buna göre)

const EYE_LETTER_COUNT    = 8;   // her göz için harf sayısı
const WAIT_BETWEEN_EYES   = 30;  // iki göz arası bekleme (sn) — sadece doktor
const INIT_WAIT           = 60;  // ilk geri sayım (sn)
const PATIENT_LETTER_TIME = 5;   // hasta her harf için süre (sn)

// Harf boyutları (vh) — büyükten küçüğe
const SIZES_LEFT  = [38, 32, 26, 21, 17, 13, 10, 8];
const SIZES_RIGHT = [34, 28, 23, 18, 14, 11, 9, 7];

/* ===================== DURUM ===================== */
const state = {
  role: null,
  peer: null,
  conn: null,
  phase: "idle",              // idle | wait | letters | between | done
  eye: "left",                // left | right
  index: 0,                   // 0..7
  currentLetter: null,
  currentSize: null,
  results: [],                // {eye, letter, answer, correct, size, timedOut}
  timers: [],                 // Interval ID'leri (temizlik)
  currentLetterPending: false // hasta cevap kilidi
};

/* ===================== YARDIMCI ===================== */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function showScreen(id) {
  $$(".screen").forEach((s) => s.classList.remove("active"));
  $("#" + id).classList.add("active");
}

function showPanel(panelId) {
  const parent = $(panelId).closest(".screen");
  parent.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
  $(panelId).classList.remove("hidden");
}

function clearTimers() {
  state.timers.forEach((t) => clearInterval(t));
  state.timers = [];
}

function randomLetter() {
  return LETTERS_WITH_O[Math.floor(Math.random() * LETTERS_WITH_O.length)];
}

/* ===================== ROL SEÇİMİ ===================== */
$("#btnDoctor").addEventListener("click", () => {
  state.role = "doctor";
  showScreen("doctorScreen");
  initDoctor();
});

$("#btnPatient").addEventListener("click", () => {
  state.role = "patient";
  showScreen("patientScreen");
  initPatient();
});

$$("[data-back]").forEach((b) =>
  b.addEventListener("click", () => {
    clearTimers();
    stopQrScanner();
    if (state.conn && state.conn.open) state.conn.close();
    if (state.peer) state.peer.destroy();
    location.reload();
  })
);

/* ===================== DOKTOR TARAFI ===================== */
function initDoctor() {
  $("#btnStartTest").addEventListener("click", startDoctorSession);

  // ID kopyalama butonu
  const copyBtn = $("#btnCopyId");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const id = $("#peerIdText").textContent;
      if (!id || id === "—") return;
      try {
        await navigator.clipboard.writeText(id);
      } catch {
        // clipboard API yoksa fallback
        const ta = document.createElement("textarea");
        ta.value = id;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      copyBtn.textContent = "✓ Kopyalandı";
      setTimeout(() => (copyBtn.textContent = "📋 Kopyala"), 1500);
    });
  }
}

function startDoctorSession() {
  $("#btnStartTest").disabled = true;
  $("#docStatus").textContent = "Oda oluşturuluyor…";

  state.peer = new Peer(undefined, { debug: 1 });

  state.peer.on("open", (id) => {
    $("#peerIdText").textContent = id;
    $("#qrArea").classList.remove("hidden");
    $("#docStatus").textContent = "Hasta bekleniyor";
    renderQr(id);
  });

  state.peer.on("connection", (conn) => {
    // Aynı anda tek hasta
    if (state.conn && state.conn.open) {
      console.warn("İkinci bağlantı reddedildi:", conn.peer);
      conn.close();
      return;
    }

    state.conn = conn;
    $("#docStatus").textContent = "Bağlandı ✓";

    conn.on("open", () => {
      showPanel("#docTest");
      startDoctorFlow();
    });

    conn.on("data", handleDoctorData);
    conn.on("close", () => {
      $("#docStatus").textContent = "Bağlantı kapandı";
    });
  });

  state.peer.on("error", (err) => {
    console.error(err);
    $("#docStatus").textContent = "Hata: " + err.type;
    $("#btnStartTest").disabled = false;
  });
}

/* --- Doktor akışı --- */
function startDoctorFlow() {
  state.phase = "wait";
  state.eye = "left";
  state.index = 0;
  state.results = [];

  $("#docPhase").textContent = "Sol Göz — Hazırlık";
  $("#docIndex").textContent = "—";
  $("#docLetter").textContent = "";
  $("#docLetter").style.fontSize = "";

  runCountdown(INIT_WAIT, () => startEye("left"));
}

function runCountdown(seconds, onDone) {
  clearTimers();
  let t = seconds;
  $("#docTimer").textContent = t;
  const iv = setInterval(() => {
    t--;
    $("#docTimer").textContent = t;
    if (t <= 0) {
      clearInterval(iv);
      onDone();
    }
  }, 1000);
  state.timers.push(iv);
}

function startEye(eye) {
  state.eye = eye;
  state.index = 0;
  state.phase = "letters";

  $("#docPhase").textContent = eye === "left" ? "Sol Göz" : "Sağ Göz";
  $("#docTimer").textContent = "—";
  nextLetter();
}

function nextLetter() {
  if (state.index >= EYE_LETTER_COUNT) {
    if (state.eye === "left") {
      state.phase = "between";
      $("#docLetter").textContent = "";
      $("#docLetter").style.fontSize = "";
      $("#docIndex").textContent = "—";
      $("#docPhase").textContent = "Sağ göz için hazırlanın";
      runCountdown(WAIT_BETWEEN_EYES, () => startEye("right"));
    } else {
      finishTest();
    }
    return;
  }

  const letter = randomLetter();
  const sizes = state.eye === "left" ? SIZES_LEFT : SIZES_RIGHT;
  const size = sizes[state.index];

  state.currentLetter = letter;
  state.currentSize = size;

  const el = $("#docLetter");
  el.textContent = letter;
  el.style.fontSize = `min(${size}vh, ${Math.round(size * 1.6)}vw)`;
  $("#docIndex").textContent = `${state.index + 1} / ${EYE_LETTER_COUNT}`;
  $("#docTimer").textContent = "—";

  sendToPatient({
    type: "letter",
    letter,
    index: state.index,
    eye: state.eye,
    total: EYE_LETTER_COUNT
  });
}

/* --- Doktor veri alma --- */
function handleDoctorData(msg) {
  if (!msg || msg.type !== "answer") return;
  if (state.phase !== "letters") return; // geç cevapları yoksay

  const correct = msg.answer === state.currentLetter;
  state.results.push({
    eye: state.eye,
    letter: state.currentLetter,
    answer: msg.answer,
    correct,
    size: state.currentSize,
    timedOut: !!msg.timedOut
  });

  sendToPatient({ type: "feedback", correct });

  state.index++;
  setTimeout(() => nextLetter(), 400);
}

function sendToPatient(obj) {
  if (state.conn && state.conn.open) state.conn.send(obj);
}

/* --- Test bitişi --- */
function finishTest() {
  state.phase = "done";
  $("#docLetter").textContent = "";
  $("#docLetter").style.fontSize = "";
  $("#docPhase").textContent = "Test tamamlandı";
  $("#docIndex").textContent = `${EYE_LETTER_COUNT * 2} harf`;

  const result = analyzeResults(state.results);
  sendToPatient({ type: "result", result });

  showPanel("#docResult");
  $("#resDiagnosisDoc").textContent = result.diagnosis;
  $("#resDegreeDoc").textContent    = result.degree;
  $("#resCorrectDoc").textContent   = result.correct;
  $("#resWrongDoc").textContent     = result.wrong;
}

/* ===================== HASTA TARAFI ===================== */
function initPatient() {
  const chk = $("#chkUnderstand");
  const btn = $("#btnOpenCamera");

  chk.addEventListener("change", () => {
    btn.disabled = !chk.checked;
  });

  btn.addEventListener("click", () => {
    // Kamera OTOMATİK açılmaz — sekmeli ekran gelir
    showPanel("#patScan");
    $("#patStatus").textContent = "Bağlantı yöntemi seçin";
  });

  // Sekme geçişleri
  const tabQr = $("#tabQr");
  const tabManual = $("#tabManual");
  const paneQr = $("#paneQr");
  const paneManual = $("#paneManual");

  function activateTab(which) {
    const isQr = which === "qr";
    tabQr.classList.toggle("active", isQr);
    tabManual.classList.toggle("active", !isQr);
    paneQr.classList.toggle("active", isQr);
    paneManual.classList.toggle("active", !isQr);

    if (isQr) {
      startQrScanner();
    } else {
      stopQrScanner();
      $("#manualPeerId").focus();
    }
  }

  tabQr.addEventListener("click", () => activateTab("qr"));
  tabManual.addEventListener("click", () => activateTab("manual"));

  // Manuel ID ile bağlan
  $("#btnManualConnect").addEventListener("click", () => {
    const id = $("#manualPeerId").value.trim();
    $("#manualError").textContent = "";
    if (!id) {
      $("#manualError").textContent = "Lütfen bir ID girin.";
      return;
    }
    if (id.length < 8) {
      $("#manualError").textContent = "ID çok kısa görünüyor. Kontrol edin.";
      return;
    }
    stopQrScanner();
    connectToDoctor(id);
  });

  // Enter tuşu ile bağlan
  $("#manualPeerId").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btnManualConnect").click();
  });

  // Hasta harf girişi (bir kez bağlanır)
  const input = $("#patInput");
  input.addEventListener("input", (e) => {
    const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, "");
    e.target.value = v;
    if (v.length === 1 && state.currentLetterPending) {
      setTimeout(() => {
        if (e.target.value.length === 1 && state.currentLetterPending) {
          submitAnswer(e.target.value, false);
        }
      }, 150);
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.length === 1 && state.currentLetterPending) {
      submitAnswer(e.target.value, false);
    }
  });
}

/* ===================== QR TARAYICI (hasta) ===================== */
let qrScanner = null;

function startQrScanner() {
  if (qrScanner && qrScanner.isScanning) return;

  $("#patStatus").textContent = "Kamera açılıyor…";

  qrScanner = new Html5Qrcode("qrReader");

  qrScanner
    .start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        const id = decodedText.trim();
        stopQrScanner();
        connectToDoctor(id);
      },
      () => { /* kare hataları yoksay */ }
    )
    .catch((err) => {
      console.error(err);
      $("#patStatus").textContent = "Kamera açılamadı — ID ile deneyin";
      $("#manualError").textContent =
        "Kamera erişimi başarısız. 'ID ile Bağlan' sekmesini kullanın.";
      // Otomatik olarak manuel sekmeye geç
      $("#tabManual").click();
    });
}

function stopQrScanner() {
  if (qrScanner && qrScanner.isScanning) {
    qrScanner.stop().catch(() => {});
  }
}

/* ===================== HASTA → DOKTOR BAĞLANTI ===================== */
function connectToDoctor(doctorId) {
  stopQrScanner();
  $("#patStatus").textContent = "Bağlanıyor…";

  state.peer = new Peer(undefined, { debug: 1 });

  state.peer.on("open", () => {
    state.conn = state.peer.connect(doctorId, { reliable: true });

    state.conn.on("open", () => {
      $("#patStatus").textContent = "Bağlandı ✓";
      showPanel("#patTest");
      startPatientFlow();
    });

    state.conn.on("data", handlePatientData);
    state.conn.on("error", (e) => {
      console.error(e);
      $("#patStatus").textContent = "Bağlantı hatası";
    });
  });

  state.peer.on("error", (err) => {
    console.error(err);
    $("#patStatus").textContent = "Hata: " + err.type;
    $("#manualError").textContent = "Bağlantı kurulamadı: " + (err.type || "bilinmeyen hata");
  });
}

/* --- Hasta akışı --- */
let patientTimerIv = null;

function startPatientFlow() {
  let t = INIT_WAIT;
  $("#patTimer").textContent = t;
  const iv = setInterval(() => {
    t--;
    $("#patTimer").textContent = t;
    if (t <= 0) {
      clearInterval(iv);
      $("#patTimer").textContent = "—";
    }
  }, 1000);
  state.timers.push(iv);

  $("#patLetterHint").textContent = "Doktorun yönlendirmesini bekleyin…";
  $("#patInput").disabled = true;
  state.currentLetterPending = false;
}

function handlePatientData(msg) {
  if (!msg) return;

  if (msg.type === "letter") {
    clearInterval(patientTimerIv);
    state.currentLetterPending = true;
    $("#patInput").disabled = false;
    $("#patInput").value = "";
    $("#patInput").focus();
    $("#patFeedback").textContent = "";
    $("#patFeedback").className = "feedback";
    $("#patPhase").textContent = msg.eye === "left" ? "Sol Göz" : "Sağ Göz";
    $("#patIndex").textContent = `${msg.index + 1} / ${msg.total}`;
    $("#patTimer").textContent = PATIENT_LETTER_TIME;

    let t = PATIENT_LETTER_TIME;
    patientTimerIv = setInterval(() => {
      t--;
      $("#patTimer").textContent = t;
      if (t <= 0) {
        clearInterval(patientTimerIv);
        if (state.currentLetterPending) submitAnswer("", true);
      }
    }, 1000);
  }

  else if (msg.type === "between") {
    clearInterval(patientTimerIv);
    state.currentLetterPending = false;
    $("#patInput").disabled = true;
    $("#patInput").value = "";
    $("#patFeedback").textContent = "Diğer göz için hazırlanın…";
    $("#patFeedback").className = "feedback";
    $("#patPhase").textContent = "Ara";
    $("#patIndex").textContent = "—";
  }

  else if (msg.type === "feedback") {
    const fb = $("#patFeedback");
    fb.textContent = msg.correct ? "✓ Doğru" : "✗ Yanlış";
    fb.className = "feedback " + (msg.correct ? "ok" : "err");
  }

  else if (msg.type === "result") {
    clearInterval(patientTimerIv);
    state.currentLetterPending = false;
    showPatientResult(msg.result);
  }
}

function submitAnswer(answer, timedOut) {
  if (!state.conn || !state.conn.open) return;
  if (!state.currentLetterPending) return;
  state.currentLetterPending = false;
  $("#patInput").disabled = true;
  clearInterval(patientTimerIv);
  state.conn.send({ type: "answer", answer, timedOut });
}

function showPatientResult(result) {
  showPanel("#patResult");
  $("#resDiagnosisPat").textContent = result.diagnosis;
  $("#resDegreePat").textContent    = result.degree;
  $("#resCorrectPat").textContent   = result.correct;
  $("#resWrongPat").textContent     = result.wrong;
}

/* ===================== QR ÜRETİMİ (doktor) ===================== */
function renderQr(id) {
  const target = $("#qrCode");
  target.innerHTML = "";

  // QRCode kütüphanesi yüklü değilse yedeğe geç
  if (typeof QRCode === "undefined" || typeof QRCode.toCanvas !== "function") {
    console.warn("QRCode kütüphanesi yüklenemedi, yedek servis kullanılacak.");
    renderQrFallback(id, target);
    return;
  }

  try {
    const canvas = document.createElement("canvas");
    QRCode.toCanvas(
      canvas,
      id,
      { width: 240, margin: 1, errorCorrectionLevel: "M" },
      (err) => {
        if (err) {
          console.error("QR üretim hatası:", err);
          renderQrFallback(id, target);
          return;
        }
        target.appendChild(canvas);
      }
    );
  } catch (e) {
    console.error("QR istisnası:", e);
    renderQrFallback(id, target);
  }
}

function renderQrFallback(id, target) {
  const img = document.createElement("img");
  img.width = 240;
  img.height = 240;
  img.alt = "QR kod";
  img.src =
    "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" +
    encodeURIComponent(id);
  img.onerror = () => {
    target.innerHTML =
      '<div class="qr-fallback">QR üretilemedi.<br>ID\'yi elle girin:<br>' +
      '<code style="font-size:1.1rem;word-break:break-all;">' + id + "</code></div>";
  };
  target.appendChild(img);
}

/* ===================== TEŞHİS ALGORİTMASI ===================== */
function analyzeResults(results) {
  if (!results || results.length === 0) {
    return {
      diagnosis: "Test tamamlanmadı",
      degree: "—",
      correct: 0,
      wrong: 0,
      total: 0,
      accuracy: 0
    };
  }

  const total   = results.length;
  const correct = results.filter((r) => r.correct).length;
  const wrong   = total - correct;
  const acc     = correct / total;

  const correctSizes = results.filter((r) => r.correct).map((r) => r.size);
  const avgCorrectSize = correctSizes.length
    ? correctSizes.reduce((a, b) => a + b, 0) / correctSizes.length
    : 40;

  let degreeNum = 0;
  if (avgCorrectSize >= 38)      degreeNum = -6.0;
  else if (avgCorrectSize <= 8)  degreeNum = 0;
  else degreeNum = -6 * ((avgCorrectSize - 8) / (38 - 8));

  degreeNum -= (1 - acc) * 2;
  degreeNum = Math.max(-8, Math.min(0, degreeNum));

  const degree = (Math.round(degreeNum * 4) / 4).toFixed(2).replace(".", ",");

  const diagnosis = simulateDiagnosis(results, acc, avgCorrectSize);

  return {
    diagnosis,
    degree: degree + " D",
    correct,
    wrong,
    total,
    accuracy: Math.round(acc * 100)
  };
}

function simulateDiagnosis(results, acc, avgSize) {
  const confusables = ["B", "D", "E", "F", "H", "K", "N", "P", "R", "S", "U", "V", "Y", "Z"];
  const wrongItems = results.filter((r) => !r.correct);
  const confusableWrong = wrongItems.filter((r) => confusables.includes(r.letter)).length;
  const smallWrong = wrongItems.filter((r) => r.size <= 14).length;
  const bigWrong   = wrongItems.filter((r) => r.size > 14).length;

  if (acc >= 0.9) return "Normal görme (simülasyon)";
  if (confusableWrong >= 2 && confusableWrong >= wrongItems.length * 0.5) {
    return "Astigmat (simülasyon)";
  }
  if (smallWrong > bigWrong && smallWrong >= 2) {
    return "Miyop (simülasyon)";
  }
  if (bigWrong >= 3 && smallWrong >= 2) {
    return "Hipermetrop (simülasyon)";
  }
  if (acc < 0.4) return "Belirgin görme kaybı (simülasyon)";
  return "Hafif görme bozukluğu (simülasyon)";
}

/* ===================== SERVICE WORKER ===================== */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => console.log("SW kayıtlı:", reg.scope))
      .catch((err) => console.warn("SW kaydı başarısız:", err));
  });
}

/* ===================== SAYFA KAPANIRKEN TEMİZLİK ===================== */
window.addEventListener("beforeunload", () => {
  clearTimers();
  stopQrScanner();
  if (state.conn && state.conn.open) state.conn.close();
  if (state.peer) state.peer.destroy();
});