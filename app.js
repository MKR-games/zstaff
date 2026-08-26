/*
 * v16.1 Firebase local/GitHub compatible loader
 * - file:// 직접 실행 가능
 * - GitHub Pages 실행 가능
 * - Node.js / npm 불필요
 */
(async () => {
  const startupStatus = document.querySelector("#cloudStatus");
  const mobileStartupStatus = document.querySelector("#mobileCloudStatus");

  function startupMessage(text, mode = "syncing", title = "") {
    for (const el of [startupStatus, mobileStartupStatus]) {
      if (!el) continue;
      el.textContent = text;
      el.title = title || text;
      if (el === startupStatus) {
        el.className = `cloud-status ${mode}`;
      } else {
        el.className = `mobile-sync ${mode}`;
      }
    }
  }

  if (location.protocol === "file:") {
    startupMessage(
      "Firebase 연결 준비…",
      "syncing",
      "로컬 파일 모드에서 Firebase SDK를 불러오는 중입니다."
    );
  }

  try {
    const [firebaseAppModule, firebaseAppCheckModule, firestoreModule] =
      await Promise.all([
        import("https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js"),
        import("https://www.gstatic.com/firebasejs/12.17.1/firebase-app-check.js"),
        import("https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js")
      ]);

    const { initializeApp } = firebaseAppModule;
    const {
      initializeAppCheck,
      ReCaptchaEnterpriseProvider
    } = firebaseAppCheckModule;
    const {
      getFirestore,
      doc,
      setDoc,
      deleteDoc,
      onSnapshot,
      serverTimestamp
    } = firestoreModule;


  const firebaseConfig = {
    apiKey: "AIzaSyCaFeq4Anf4nbT1HxhX9W_ag-1Np4nr8KI",
    authDomain: "staff-scheduler-82408.firebaseapp.com",
    projectId: "staff-scheduler-82408",
    storageBucket: "staff-scheduler-82408.firebasestorage.app",
    messagingSenderId: "259211057546",
    appId: "1:259211057546:web:37185040e11d811a155073"
  };

  const schedulerCloudConfig = {
    schedulerCollection: "scheduler",
    employeesDocument: "employees",
    weeksCollection: "scheduleWeeks",
    retentionWeeks: 8,
    saveDebounceMs: 900,
    appCheck: {
      enabled: false,
      recaptchaEnterpriseSiteKey: "PASTE_RECAPTCHA_ENTERPRISE_SITE_KEY"
    }
  };

  function isFirebaseConfigured() {
    return Boolean(
      firebaseConfig.apiKey &&
      firebaseConfig.projectId &&
      firebaseConfig.appId
    );
  }

(() => {
  // v1과 같은 저장 키를 사용해 기존 등록 직원/일정 데이터를 그대로 이어받습니다.
  const STORE_KEY = "kr_staff_scheduler_v1";

  const PALETTE = [
    "#5167d8","#d05a70","#3c9b72","#d07b35","#7a5bc7",
    "#298ca8","#b65da8","#7b8750","#b04a45","#3d7c9c"
  ];

  const START_MIN = 9 * 60 + 30; // 09:30
  const END_MIN = 22 * 60;       // 22:00
  const SNAP_MIN = 30;
  const SLOT_W = 36;
  const TOTAL_SLOTS = (END_MIN - START_MIN) / SNAP_MIN;
  const TIMELINE_W = TOTAL_SLOTS * SLOT_W;

  const $ = (s) => document.querySelector(s);

  const state = loadState();

  const cloudRuntime = {
    app: null,
    appCheck: null,
    db: null,

    employeesRef: null,
    employeesUnsubscribe: null,
    weekRef: null,
    weekUnsubscribe: null,
    activeWeekKey: null,

    saveTimer: null,
    applyingRemote: false,
    configured: isFirebaseConfigured(),

    employeesReady: false,
    weekReady: false,
    knownWeeks: [],

    lastEmployeesHash: "",
    lastWeekHashes: new Map(),
    cleanupRunning: false
  };

  let weekOffset = 0;
  let mobileViewMode = "week";
  let mobileSelectedDate = null;

  function isMobileMode() {
    return window.matchMedia("(max-width: 850px)").matches;
  }
  const scheduleMode = true;
  let personalMonth = new Date();
  personalMonth.setDate(1);

  function loadState() {
    try {
      const x = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      const employees = Array.isArray(x.employees) ? x.employees : [];
      employees.forEach((e, i) => {
        if (!e.color) e.color = PALETTE[i % PALETTE.length];
        if (!["관리자", "정직원", "주말아르바이트"].includes(e.role)) e.role = "정직원";
      });

      const shifts = Array.isArray(x.shifts) ? x.shifts : [];
      // 기존 주말 데이터가 있다면 v2 규칙에 맞춰 퇴근 시간을 제거합니다.
      shifts.forEach((s) => {
        if (s.date && isWeekend(s.date)) s.end = null;
      });

      return {
        employees,
        personal: Array.isArray(x.personal) ? x.personal : [],
        shifts
      };
    } catch {
      return { employees: [], personal: [], shifts: [] };
    }
  }

  function retentionCutoffMonday() {
    const weeks = Math.max(
      2,
      Number(schedulerCloudConfig.retentionWeeks) || 8
    );

    // 현재 주 포함 최근 N주 보존:
    // 8주라면 현재 주 + 과거 7주.
    return addDays(mondayOf(new Date()), -(weeks - 1) * 7);
  }

  function isWeekRetained(weekKey) {
    if (!weekKey) return false;
    return parseDate(weekKey) >= retentionCutoffMonday();
  }

  function pruneExpiredState() {
    const cutoffKey = ymd(retentionCutoffMonday());

    const beforeShifts = state.shifts.length;
    const beforePersonal = state.personal.length;

    // 미래 스케줄은 유지, 과거는 최근 N주까지만 유지.
    state.shifts = state.shifts.filter(
      (item) => !item.date || item.date >= cutoffKey
    );
    state.personal = state.personal.filter(
      (item) => !item.date || item.date >= cutoffKey
    );

    return (beforeShifts - state.shifts.length) +
      (beforePersonal - state.personal.length);
  }

  function saveLocalBackup() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }

  function saveState() {
    pruneExpiredState();
    saveLocalBackup();

    if (!cloudRuntime.applyingRemote) {
      queueCloudWrite();
    }
  }

  function uid(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function ymd(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function parseDate(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function mondayOf(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    const day = x.getDay();
    x.setDate(x.getDate() - (day === 0 ? 6 : day - 1));
    return x;
  }

  function currentMonday() {
    return addDays(mondayOf(new Date()), weekOffset * 7);
  }

  function isWeekend(dateString) {
    const day = parseDate(dateString).getDay();
    return day === 0 || day === 6;
  }

  function minFromTime(t) {
    if (!t) return null;
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  }

  function timeFromMin(min) {
    min = Math.max(0, Math.min(1440, Math.round(min / SNAP_MIN) * SNAP_MIN));
    return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  }

  function clampWorkMin(min) {
    return Math.max(START_MIN, Math.min(END_MIN, min));
  }

  function xFromMin(min) {
    return ((min - START_MIN) / SNAP_MIN) * SLOT_W;
  }

  function minFromX(x) {
    return clampWorkMin(START_MIN + (x / SLOT_W) * SNAP_MIN);
  }

  function esc(s = "") {
    return String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[m]));
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove("show"), 2100);
  }

  function employeeById(id) {
    return state.employees.find((e) => e.id === id);
  }

  function overlap(a1, a2, b1, b2) {
    return Math.max(a1, b1) < Math.min(a2, b2);
  }

  function effectiveShiftEnd(s) {
    return isWeekend(s.date) || !s.end ? END_MIN : minFromTime(s.end);
  }

  function conflictsPersonal(employeeId, date, start, end) {
    return state.personal.some((p) => {
      if (p.employeeId !== employeeId || p.date !== date) return false;
      if (p.allDay) return true;

      const ps = minFromTime(p.start);
      const pe = minFromTime(p.end);
      if (ps == null || pe == null) return false;
      return overlap(start, end, ps, pe);
    });
  }

  function conflictsShift(employeeId, date, start, end, exceptId = null) {
    return state.shifts.some((s) => {
      if (s.employeeId !== employeeId || s.date !== date || s.id === exceptId) return false;
      return overlap(start, end, minFromTime(s.start), effectiveShiftEnd(s));
    });
  }

  function validWorkStart(min) {
    return min >= START_MIN && min < END_MIN;
  }

  function validWeekdayEnd(min) {
    return min > START_MIN && min <= END_MIN;
  }

  function renderAll() {
    renderEmployeeList();
    renderCalendar();
    renderMobileUI();
  }

  function renderEmployeeList() {
    $("#employeeCount").textContent = `${state.employees.length}명`;
    const root = $("#employeeList");

    if (!state.employees.length) {
      root.innerHTML = '<div class="empty-state">직원을 먼저 등록하세요.</div>';
      return;
    }

    root.innerHTML = state.employees.map((e, index) => `
      <div class="employee-card ${e.role === "관리자" ? "manager-card" : ""}" data-emp="${e.id}">
        <span class="employee-dot" style="background:${e.color}"></span>
        <div class="employee-info">
          <div class="employee-name">
            ${e.role === "관리자" ? '<span class="manager-star" title="관리자">★</span>' : ""}
            ${index + 1}. ${esc(e.name)}
          </div>
          <div class="employee-role">${esc(e.role)}</div>
        </div>
        <div class="employee-actions">
          <button class="edit-emp" type="button" data-edit-emp="${e.id}" title="수정">✎</button>
          <button class="delete-emp" type="button" data-delete-emp="${e.id}" title="삭제">×</button>
        </div>
      </div>
    `).join("");

    root.querySelectorAll("[data-edit-emp]").forEach((btn) => {
      btn.onclick = () => openEmployee(btn.dataset.editEmp);
    });

    root.querySelectorAll("[data-delete-emp]").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        deleteEmployeeById(btn.dataset.deleteEmp);
      };
    });

    bindEmployeePointerDrag();
  }



  function animateEmployeeReflow(root, mutate) {
    const cards = [...root.querySelectorAll(".employee-card")];
    const before = new Map(cards.map((card) => [card.dataset.emp, card.getBoundingClientRect()]));

    mutate();

    const afterCards = [...root.querySelectorAll(".employee-card")];
    afterCards.forEach((card) => {
      const oldRect = before.get(card.dataset.emp);
      if (!oldRect) return;

      const newRect = card.getBoundingClientRect();
      const dy = oldRect.top - newRect.top;
      if (Math.abs(dy) < 1) return;

      card.style.transition = "none";
      card.style.transform = `translateY(${dy}px)`;

      requestAnimationFrame(() => {
        card.style.transition = "";
        card.style.transform = "";
      });
    });
  }

  function commitEmployeeOrderFromDom(render = true) {
    const root = $("#employeeList");
    const ids = [...root.querySelectorAll(".employee-card")].map((card) => card.dataset.emp);
    if (!ids.length) return;

    const byId = new Map(state.employees.map((e) => [e.id, e]));
    const reordered = ids.map((id) => byId.get(id)).filter(Boolean);

    if (reordered.length !== state.employees.length) return;

    state.employees = reordered;
    saveState();

    if (render) {
      renderEmployeeList();
      renderCalendar();
    }
  }

  function clearEmployeeDropTargets() {
    document.querySelectorAll(".timeline.employee-drop-target").forEach((el) => {
      el.classList.remove("employee-drop-target");
    });
  }

  function bindEmployeePointerDrag() {
    if (isMobileMode()) return;

    const root = $("#employeeList");

    root.querySelectorAll(".employee-card").forEach((card) => {
      card.addEventListener("pointerdown", (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        if (event.target.closest("button")) return;

        const employee = employeeById(card.dataset.emp);
        if (!employee) return;

        const startX = event.clientX;
        const startY = event.clientY;
        let active = false;
        let reordered = false;
        let ghost = null;
        let lastTimeline = null;

        const beginDrag = () => {
          if (active) return;
          active = true;
          card.classList.add("sorting-source");

          ghost = document.createElement("div");
          ghost.className = "employee-drag-ghost";
          ghost.innerHTML = `
            <span class="ghost-dot" style="background:${employee.color}"></span>
            <span class="ghost-text">${employee.role === "관리자" ? "★ " : ""}${esc(employee.name)} · ${esc(employee.role)}</span>
          `;
          document.body.appendChild(ghost);
        };

        const placeGhost = (x, y) => {
          if (!ghost) return;
          ghost.style.left = `${x}px`;
          ghost.style.top = `${y}px`;
        };

        const reorderInsideList = (pointerY) => {
          const listRect = root.getBoundingClientRect();
          if (pointerY < listRect.top - 10 || pointerY > listRect.bottom + 10) return false;

          const others = [...root.querySelectorAll(".employee-card")]
            .filter((item) => item !== card);

          let beforeCard = null;
          for (const item of others) {
            const rect = item.getBoundingClientRect();
            if (pointerY < rect.top + rect.height / 2) {
              beforeCard = item;
              break;
            }
          }

          const currentNext = card.nextElementSibling;

          if (beforeCard) {
            if (beforeCard !== card && currentNext !== beforeCard) {
              animateEmployeeReflow(root, () => root.insertBefore(card, beforeCard));
              reordered = true;
            }
          } else if (root.lastElementChild !== card) {
            animateEmployeeReflow(root, () => root.appendChild(card));
            reordered = true;
          }

          return true;
        };

        const move = (e) => {
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;

          if (!active && Math.hypot(dx, dy) < 6) return;

          beginDrag();
          e.preventDefault();
          placeGhost(e.clientX, e.clientY);

          clearEmployeeDropTargets();
          lastTimeline = null;

          const listRect = root.getBoundingClientRect();
          const insideList =
            e.clientX >= listRect.left - 20 &&
            e.clientX <= listRect.right + 20 &&
            e.clientY >= listRect.top - 10 &&
            e.clientY <= listRect.bottom + 10;

          if (insideList) {
            reorderInsideList(e.clientY);
            return;
          }

          const el = document.elementFromPoint(e.clientX, e.clientY);
          const timeline = el && el.closest ? el.closest(".timeline") : null;
          if (timeline) {
            timeline.classList.add("employee-drop-target");
            lastTimeline = timeline;
          }
        };

        const end = (e) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", end);
          window.removeEventListener("pointercancel", cancel);

          if (!active) return;

          const el = document.elementFromPoint(e.clientX, e.clientY);
          const timeline = (el && el.closest) ? el.closest(".timeline") : lastTimeline;

          // 먼저 사용자가 정렬해 둔 직원 순서를 저장
          if (reordered) {
            commitEmployeeOrderFromDom(false);
          }

          // 캘린더 위에 놓았다면 기존 직원 드래그와 동일하게 근무 생성
          if (timeline) {
            const rect = timeline.getBoundingClientRect();
            let start = Math.round(minFromX(e.clientX - rect.left) / SNAP_MIN) * SNAP_MIN;
            start = Math.max(START_MIN, Math.min(END_MIN - SNAP_MIN, start));

            if (isWeekend(timeline.dataset.date)) {
              createShift(employee.id, timeline.dataset.date, start, null);
            } else {
              const shiftEnd = Math.min(END_MIN, start + 4 * 60);
              createShift(employee.id, timeline.dataset.date, start, shiftEnd);
            }

            renderEmployeeList();
          } else if (reordered) {
            renderEmployeeList();
            renderCalendar();
          }

          cleanup();
        };

        const cancel = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", end);
          window.removeEventListener("pointercancel", cancel);
          cleanup();
          renderEmployeeList();
        };

        const cleanup = () => {
          card.classList.remove("sorting-source");
          clearEmployeeDropTargets();
          if (ghost) ghost.remove();
        };

        window.addEventListener("pointermove", move, { passive: false });
        window.addEventListener("pointerup", end, { once: true });
        window.addEventListener("pointercancel", cancel, { once: true });
      });
    });
  }

  function renderTimeHeader() {
    const labels = [];

    // 09:30은 근무 입력 가능 구간으로만 유지하고 시간표 숫자는 표시하지 않습니다.
    // 실제 기본 출근 기준인 10:00을 첫 강조 시간으로 표시합니다.
    for (let m = 10 * 60; m < END_MIN; m += 60) {
      const x = xFromMin(m);
      const cls = m === 10 * 60 ? "start-mark" : "hour-mark";
      labels.push(
        `<span class="time-label ${cls}" style="left:${x}px">${timeFromMin(m)}</span>`
      );
    }

    // 마지막 22:00 강조
    labels.push(
      `<span class="time-label last end-mark" style="left:${TIMELINE_W}px">22:00</span>`
    );

    return labels.join("");
  }

  function renderCalendar() {
    const start = currentMonday();
    const end = addDays(start, 6);

    $("#weekTitle").textContent =
      `${start.getFullYear()}. ${start.getMonth() + 1}. ${start.getDate()}. — ` +
      `${end.getFullYear()}. ${end.getMonth() + 1}. ${end.getDate()}.`;

    const cal = $("#calendar");

    if (!state.employees.length) {
      cal.innerHTML =
        '<div class="empty-state" style="padding:70px">직원을 등록하면 주간 스케줄 캘린더가 생성됩니다.</div>';
      return;
    }

    const koDays = ["일", "월", "화", "수", "목", "금", "토"];
    let html = "";

    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      const ds = ymd(d);
      const dow = d.getDay();

      html += `
        <section class="day-section" data-date="${ds}">
          <div class="day-head">
            <div class="day-label ${dow === 0 ? "sun" : dow === 6 ? "sat" : ""}">
              <strong>${koDays[dow]}요일</strong>
              <span class="date-num">${d.getMonth() + 1}/${d.getDate()}</span>
            </div>
            <div class="hour-header">${renderTimeHeader()}</div>
          </div>
          ${state.employees.map((e) => renderLane(e, ds)).join("")}
        </section>
      `;
    }

    cal.innerHTML = html;
    bindTimelineEvents();
    bindShiftEvents();
    bindPersonalEvents();

    if (isMobileMode()) {
      renderMobileUI();
    }
  }


  function earliestWeekendStart(date) {
    if (!isWeekend(date)) return null;

    const starts = state.shifts
      .filter((s) => s.date === date && s.start)
      .map((s) => minFromTime(s.start))
      .filter((m) => Number.isFinite(m));

    return starts.length ? Math.min(...starts) : null;
  }

  function renderLane(e, date) {
    const weekend = isWeekend(date);

    const unavailable = state.personal
      .filter((p) => p.employeeId === e.id && p.date === date)
      .map((p) => {
        if (p.allDay) {
          return `
            <div class="unavailable-block all-day" data-personal="${p.id}" title="우클릭하여 수정 · ${esc(p.memo || "개인 일정")}">
              <div class="u-text">종일 근무 불가${p.memo ? ` · ${esc(p.memo)}` : ""}</div>
            </div>
          `;
        }

        const rawStart = minFromTime(p.start);
        const rawEnd = minFromTime(p.end);

        // 스케줄 화면은 09:30~22:00만 보이므로 개인 일정도 보이는 구간만 잘라 표시
        const st = Math.max(START_MIN, rawStart);
        const en = Math.min(END_MIN, rawEnd);
        if (en <= st) return "";

        const left = xFromMin(st);
        const width = xFromMin(en) - left;

        return `
          <div class="unavailable-block"
               data-personal="${p.id}"
               style="left:${left}px;width:${Math.max(8, width)}px"
               title="우클릭하여 수정 · ${esc(p.memo || "개인 일정")}">
            <div class="u-text">${p.start}–${p.end}${p.memo ? ` · ${esc(p.memo)}` : ""}</div>
          </div>
        `;
      }).join("");

    const weekendFirstStart = weekend ? earliestWeekendStart(date) : null;

    const weekendPrep = weekend
      ? state.shifts
          .filter((s) => s.employeeId === e.id && s.date === date && s.start)
          .map((s) => {
            const st = minFromTime(s.start);

            // 최초 출근 시각과 같은 직원은 전부 제외(동률도 최초 출근자로 취급)
            if (weekendFirstStart == null || st <= weekendFirstStart) return "";

            const prepStart = Math.max(START_MIN, st - 60);
            const prepEnd = st;
            if (prepEnd <= prepStart) return "";

            const left = xFromMin(prepStart);
            const width = xFromMin(prepEnd) - left;

            return `
              <div class="weekend-prep-block"
                   style="left:${left}px;width:${Math.max(8, width)}px"
                   aria-hidden="true">
              </div>
            `;
          })
          .join("")
      : "";

    const shifts = state.shifts
      .filter((s) => s.employeeId === e.id && s.date === date)
      .map((s) => {
        const st = minFromTime(s.start);

        if (weekend) {
          const left = xFromMin(st);
          const width = TIMELINE_W - left;
          const invalid = conflictsPersonal(e.id, date, st, END_MIN);

          return `
            <div class="shift weekend-shift ${invalid ? "invalid" : ""}"
                 data-shift="${s.id}"
                 style="left:${left}px;width:${Math.max(20, width)}px;background-color:${e.color}">
              <div class="shift-content"
                   title="${esc(e.name)} ${s.start} 출근 · 퇴근 미정">
                ${esc(e.name)} · ${s.start} 출근 · 퇴근 미정
              </div>
            </div>
          `;
        }

        const en = minFromTime(s.end);
        const left = xFromMin(st);
        const width = xFromMin(en) - left;
        const invalid = conflictsPersonal(e.id, date, st, en);

        return `
          <div class="shift ${invalid ? "invalid" : ""}"
               data-shift="${s.id}"
               style="left:${left}px;width:${Math.max(16, width)}px;background:${e.color}">
            <div class="resize-handle left" data-resize="left"></div>
            <div class="shift-content"
                 title="${esc(e.name)} ${s.start}–${s.end}">
              ${esc(e.name)} · ${s.start}–${s.end}
            </div>
            <div class="resize-handle right" data-resize="right"></div>
          </div>
        `;
      }).join("");

    return `
      <div class="lane">
        <div class="lane-person ${e.role === "관리자" ? "manager-lane" : ""}">
          <span class="tiny-dot" style="background:${e.color}"></span>
          <span>${e.role === "관리자" ? '<span class="manager-star small" title="관리자">★</span> ' : ""}${esc(e.name)}</span>
        </div>
        <div class="timeline schedule-mode"
             data-date="${date}" data-emp="${e.id}">
          ${unavailable}
          ${weekendPrep}
          ${shifts}
        </div>
      </div>
    `;
  }

  function bindTimelineEvents() {
    if (isMobileMode()) return;

    document.querySelectorAll(".timeline").forEach((tl) => {
      tl.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".shift")) return;

        const date = tl.dataset.date;
        const weekend = isWeekend(date);
        const r = tl.getBoundingClientRect();
        const start0 = Math.round(minFromX(e.clientX - r.left) / SNAP_MIN) * SNAP_MIN;

        if (!validWorkStart(start0)) return;

        const preview = document.createElement("div");
        preview.className = `drag-preview${weekend ? " weekend" : ""}`;
        tl.appendChild(preview);

        let end0 = start0;

        const redraw = () => {
          if (weekend) {
            preview.style.left = `${xFromMin(start0)}px`;
            preview.style.width = `${TIMELINE_W - xFromMin(start0)}px`;
          } else {
            const a = Math.min(start0, end0);
            const b = Math.max(start0, end0);
            preview.style.left = `${xFromMin(a)}px`;
            preview.style.width = `${Math.max(8, xFromMin(b) - xFromMin(a))}px`;
          }
        };

        redraw();

        const move = (ev) => {
          if (weekend) return;
          end0 = Math.round(minFromX(ev.clientX - r.left) / SNAP_MIN) * SNAP_MIN;
          redraw();
        };

        const up = () => {
          window.removeEventListener("pointermove", move);
          preview.remove();

          if (weekend) {
            createShift(tl.dataset.emp, date, start0, null);
            return;
          }

          let a = Math.min(start0, end0);
          let b = Math.max(start0, end0);

          if (b - a < SNAP_MIN) {
            b = Math.min(END_MIN, a + 2 * 60);
          }

          createShift(tl.dataset.emp, date, a, b);
        };

        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up, { once: true });
      });
    });
  }

  function createShift(empId, date, start, end) {
    if (isMobileMode()) {
      toast("모바일에서는 근무 스케줄을 등록할 수 없습니다.");
      return;
    }

    start = Math.round(clampWorkMin(start) / SNAP_MIN) * SNAP_MIN;

    if (!validWorkStart(start)) {
      toast("출근 시각은 09:30부터 21:30까지 등록할 수 있습니다.");
      return;
    }

    const weekend = isWeekend(date);

    if (weekend) {
      if (conflictsPersonal(empId, date, start, END_MIN)) {
        toast("개인 일정과 겹쳐 주말 근무를 넣을 수 없습니다.");
        return;
      }
      if (conflictsShift(empId, date, start, END_MIN)) {
        toast("이미 등록된 주말 근무가 있습니다.");
        return;
      }

      state.shifts.push({
        id: uid("shift"),
        employeeId: empId,
        date,
        start: timeFromMin(start),
        end: null
      });

      saveState();
      renderCalendar();
      return;
    }

    end = Math.round(clampWorkMin(end) / SNAP_MIN) * SNAP_MIN;

    if (!validWeekdayEnd(end) || end <= start) {
      toast("평일 근무는 09:30~22:00 안에서 등록하세요.");
      return;
    }

    if (conflictsPersonal(empId, date, start, end)) {
      toast("개인 일정과 겹쳐 근무를 넣을 수 없습니다.");
      return;
    }

    if (conflictsShift(empId, date, start, end)) {
      toast("이미 등록된 근무와 시간이 겹칩니다.");
      return;
    }

    state.shifts.push({
      id: uid("shift"),
      employeeId: empId,
      date,
      start: timeFromMin(start),
      end: timeFromMin(end)
    });

    saveState();
    renderCalendar();
  }

  function bindShiftEvents() {
    if (isMobileMode()) return;

    document.querySelectorAll(".shift").forEach((shiftEl) => {
      shiftEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openShift(shiftEl.dataset.shift);
      });
    });

    document.querySelectorAll(".shift-content").forEach((el) => {
      let moved = false;

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (moved) {
          moved = false;
          return;
        }
        openShift(el.closest(".shift").dataset.shift);
      });

      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();

        const shiftEl = el.closest(".shift");
        const id = shiftEl.dataset.shift;
        const s = state.shifts.find((x) => x.id === id);
        if (!s) return;

        const tl = shiftEl.parentElement;
        const rect = tl.getBoundingClientRect();

        const originalStart = minFromTime(s.start);
        const originalEnd = isWeekend(s.date) ? END_MIN : minFromTime(s.end);
        const duration = originalEnd - originalStart;

        const pointerStartX = e.clientX;
        let tempStart = originalStart;
        let tempEnd = originalEnd;
        moved = false;

        shiftEl.classList.add("dragging");

        const move = (ev) => {
          const deltaPx = ev.clientX - pointerStartX;
          const deltaSlots = Math.round(deltaPx / SLOT_W);
          let nextStart = originalStart + deltaSlots * SNAP_MIN;

          if (isWeekend(s.date)) {
            // 주말은 출근 시각만 저장하므로 블록의 시작점만 이동.
            nextStart = Math.max(START_MIN, Math.min(END_MIN - SNAP_MIN, nextStart));
            tempStart = nextStart;
            tempEnd = END_MIN;

            shiftEl.style.left = `${xFromMin(tempStart)}px`;
            shiftEl.style.width = `${TIMELINE_W - xFromMin(tempStart)}px`;

            const emp = employeeById(s.employeeId);
            el.textContent = `${emp.name} · ${timeFromMin(tempStart)} 출근 · 퇴근 미정`;
          } else {
            // 평일은 기존 근무시간 길이를 유지한 채 좌우 이동.
            nextStart = Math.max(START_MIN, Math.min(END_MIN - duration, nextStart));
            tempStart = nextStart;
            tempEnd = nextStart + duration;

            shiftEl.style.left = `${xFromMin(tempStart)}px`;
            shiftEl.style.width = `${xFromMin(tempEnd) - xFromMin(tempStart)}px`;

            const emp = employeeById(s.employeeId);
            el.textContent = `${emp.name} · ${timeFromMin(tempStart)}–${timeFromMin(tempEnd)}`;
          }

          if (Math.abs(ev.clientX - pointerStartX) > 4) moved = true;
        };

        const up = () => {
          window.removeEventListener("pointermove", move);
          shiftEl.classList.remove("dragging");

          const checkEnd = isWeekend(s.date) ? END_MIN : tempEnd;

          if (
            conflictsPersonal(s.employeeId, s.date, tempStart, checkEnd) ||
            conflictsShift(s.employeeId, s.date, tempStart, checkEnd, s.id)
          ) {
            toast("겹치는 일정이 있어 이동을 취소했습니다.");
            renderCalendar();
            return;
          }

          s.start = timeFromMin(tempStart);
          s.end = isWeekend(s.date) ? null : timeFromMin(tempEnd);
          saveState();
          renderCalendar();
        };

        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up, { once: true });
      });
    });

    document.querySelectorAll(".resize-handle").forEach((handle) => {
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();

        const shiftEl = handle.closest(".shift");
        const id = shiftEl.dataset.shift;
        const s = state.shifts.find((x) => x.id === id);

        if (!s || isWeekend(s.date)) return;

        const tl = shiftEl.parentElement;
        const r = tl.getBoundingClientRect();
        const side = handle.dataset.resize;
        const originalStart = minFromTime(s.start);
        const originalEnd = minFromTime(s.end);

        const move = (ev) => {
          const m = Math.round(minFromX(ev.clientX - r.left) / SNAP_MIN) * SNAP_MIN;

          let st = originalStart;
          let en = originalEnd;

          if (side === "left") {
            st = Math.min(m, en - SNAP_MIN);
          } else {
            en = Math.max(m, st + SNAP_MIN);
          }

          st = Math.max(START_MIN, Math.min(END_MIN - SNAP_MIN, st));
          en = Math.max(START_MIN + SNAP_MIN, Math.min(END_MIN, en));

          shiftEl.style.left = `${xFromMin(st)}px`;
          shiftEl.style.width = `${xFromMin(en) - xFromMin(st)}px`;
          shiftEl.dataset.tempStart = timeFromMin(st);
          shiftEl.dataset.tempEnd = timeFromMin(en);

          const emp = employeeById(s.employeeId);
          shiftEl.querySelector(".shift-content").textContent =
            `${emp.name} · ${timeFromMin(st)}–${timeFromMin(en)}`;
        };

        const up = () => {
          window.removeEventListener("pointermove", move);

          const st = minFromTime(shiftEl.dataset.tempStart || s.start);
          const en = minFromTime(shiftEl.dataset.tempEnd || s.end);

          if (
            conflictsPersonal(s.employeeId, s.date, st, en) ||
            conflictsShift(s.employeeId, s.date, st, en, s.id)
          ) {
            toast("겹치는 일정이 있어 변경을 취소했습니다.");
          } else {
            s.start = timeFromMin(st);
            s.end = timeFromMin(en);
            saveState();
          }

          renderCalendar();
        };

        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up, { once: true });
      });
    });
  }



  function bindPersonalEvents() {
    if (isMobileMode()) return;

    document.querySelectorAll(".unavailable-block[data-personal]").forEach((block) => {
      block.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPersonal(block.dataset.personal);
      });
    });
  }



  function setCloudStatus(mode, text, title = "") {
    const el = $("#cloudStatus");
    if (!el) return;

    el.className = `cloud-status ${mode}`;
    el.textContent = text;
    el.title = title || text;

    syncMobileCloudStatus();
  }

  function weekKeyForDate(dateString) {
    if (!dateString) return null;
    return ymd(mondayOf(parseDate(dateString)));
  }

  function weekRangeFromKey(weekKey) {
    const start = parseDate(weekKey);
    return {
      start,
      end: addDays(start, 6),
      startKey: weekKey,
      endKey: ymd(addDays(start, 6))
    };
  }

  function getLocalWeekPayload(weekKey) {
    const { startKey, endKey } = weekRangeFromKey(weekKey);

    return {
      schemaVersion: 2,
      weekStart: weekKey,
      shifts: state.shifts.filter(
        (item) => item.date >= startKey && item.date <= endKey
      ),
      personal: state.personal.filter(
        (item) => item.date >= startKey && item.date <= endKey
      ),
      updatedAt: serverTimestamp(),
      client: "staff-scheduler-github-pages"
    };
  }

  function weekHasData(payload) {
    return payload.shifts.length > 0 || payload.personal.length > 0;
  }

  function stableWeekHash(payload) {
    return JSON.stringify({
      weekStart: payload.weekStart,
      shifts: payload.shifts,
      personal: payload.personal
    });
  }

  function stableEmployeesHash(employees, knownWeeks) {
    return JSON.stringify({
      employees,
      knownWeeks: [...knownWeeks].sort()
    });
  }

  function normalizeEmployees(employees) {
    const result = Array.isArray(employees) ? employees : [];

    result.forEach((employee, index) => {
      if (!employee.color) {
        employee.color = PALETTE[index % PALETTE.length];
      }

      if (!["관리자", "정직원", "주말아르바이트"].includes(employee.role)) {
        employee.role = "정직원";
      }
    });

    return result;
  }

  function replaceLocalWeekData(weekKey, remoteData) {
    const { startKey, endKey } = weekRangeFromKey(weekKey);

    state.shifts = state.shifts.filter(
      (item) => !(item.date >= startKey && item.date <= endKey)
    );
    state.personal = state.personal.filter(
      (item) => !(item.date >= startKey && item.date <= endKey)
    );

    const shifts = Array.isArray(remoteData?.shifts) ? remoteData.shifts : [];
    const personal = Array.isArray(remoteData?.personal) ? remoteData.personal : [];

    shifts.forEach((shift) => {
      if (shift.date && isWeekend(shift.date)) {
        shift.end = null;
      }
    });

    state.shifts.push(...shifts);
    state.personal.push(...personal);

    pruneExpiredState();
    saveLocalBackup();
    renderCalendar();
  }

  function collectLocalWeekKeys() {
    const keys = new Set();

    for (const item of [...state.shifts, ...state.personal]) {
      const key = weekKeyForDate(item.date);
      if (key && isWeekRetained(key)) {
        keys.add(key);
      }
    }

    // 현재 보고 있는 주는 비어 있어도 구독 대상.
    keys.add(ymd(currentMonday()));

    return [...keys].sort();
  }

  async function cleanupOldCloudWeeks() {
    if (
      !cloudRuntime.db ||
      cloudRuntime.cleanupRunning ||
      !cloudRuntime.employeesReady
    ) {
      return;
    }

    const stale = cloudRuntime.knownWeeks.filter(
      (weekKey) => !isWeekRetained(weekKey)
    );

    if (!stale.length) return;

    cloudRuntime.cleanupRunning = true;

    try {
      // 일반적으로 최근 8주만 남기므로 삭제량은 매우 작습니다.
      for (const weekKey of stale) {
        await deleteDoc(
          doc(
            cloudRuntime.db,
            schedulerCloudConfig.weeksCollection || "scheduleWeeks",
            weekKey
          )
        );
        cloudRuntime.lastWeekHashes.delete(weekKey);
      }

      cloudRuntime.knownWeeks = cloudRuntime.knownWeeks.filter(
        (weekKey) => isWeekRetained(weekKey)
      );

      cloudRuntime.lastEmployeesHash = "";
      queueCloudWrite(true);
    } catch (error) {
      console.error("Old week cleanup failed:", error);
      setCloudStatus(
        "error",
        "정리 오류",
        error?.message || "오래된 주차 데이터 삭제 실패"
      );
    } finally {
      cloudRuntime.cleanupRunning = false;
    }
  }

  async function pushEmployeesIfChanged() {
    if (!cloudRuntime.employeesRef || !cloudRuntime.employeesReady) return;

    const hash = stableEmployeesHash(
      state.employees,
      cloudRuntime.knownWeeks
    );

    if (hash === cloudRuntime.lastEmployeesHash) return;

    await setDoc(cloudRuntime.employeesRef, {
      schemaVersion: 2,
      employees: state.employees,
      knownWeeks: [...cloudRuntime.knownWeeks].sort(),
      retentionWeeks: Math.max(
        2,
        Number(schedulerCloudConfig.retentionWeeks) || 8
      ),
      updatedAt: serverTimestamp(),
      client: "staff-scheduler-github-pages"
    });

    cloudRuntime.lastEmployeesHash = hash;
  }

  async function pushWeeksIfChanged() {
    if (!cloudRuntime.db || !cloudRuntime.employeesReady) return;

    const keys = new Set([
      ...cloudRuntime.knownWeeks,
      ...collectLocalWeekKeys()
    ]);

    const retainedKeys = [...keys].filter(isWeekRetained).sort();
    const activeKey = ymd(currentMonday());

    for (const weekKey of retainedKeys) {
      const payload = getLocalWeekPayload(weekKey);
      const hash = stableWeekHash(payload);
      const previousHash = cloudRuntime.lastWeekHashes.get(weekKey);

      if (!weekHasData(payload)) {
        // 기존에 Firestore 문서가 있던 주가 비었다면 삭제.
        if (cloudRuntime.knownWeeks.includes(weekKey)) {
          await deleteDoc(
            doc(
              cloudRuntime.db,
              schedulerCloudConfig.weeksCollection || "scheduleWeeks",
              weekKey
            )
          );

          cloudRuntime.knownWeeks = cloudRuntime.knownWeeks.filter(
            (key) => key !== weekKey
          );
          cloudRuntime.lastWeekHashes.delete(weekKey);
          cloudRuntime.lastEmployeesHash = "";
        }
        continue;
      }

      if (hash === previousHash) continue;

      await setDoc(
        doc(
          cloudRuntime.db,
          schedulerCloudConfig.weeksCollection || "scheduleWeeks",
          weekKey
        ),
        payload
      );

      cloudRuntime.lastWeekHashes.set(weekKey, hash);

      if (!cloudRuntime.knownWeeks.includes(weekKey)) {
        cloudRuntime.knownWeeks.push(weekKey);
        cloudRuntime.knownWeeks.sort();
        cloudRuntime.lastEmployeesHash = "";
      }
    }

    // 현재 주가 로컬에서 비었고 knownWeeks에도 없다면 아무 문서도 만들지 않음.
    if (!retainedKeys.includes(activeKey)) {
      cloudRuntime.lastWeekHashes.delete(activeKey);
    }
  }

  async function pushCloudState() {
    if (
      !cloudRuntime.configured ||
      !cloudRuntime.db ||
      !cloudRuntime.employeesReady ||
      cloudRuntime.applyingRemote
    ) {
      return;
    }

    try {
      setCloudStatus("syncing", "동기화 중…");

      await pushWeeksIfChanged();
      await pushEmployeesIfChanged();
      await cleanupOldCloudWeeks();

      setCloudStatus(
        "connected",
        cloudRuntime.appCheck ? "Firebase + App Check" : "Firebase 동기화",
        cloudRuntime.appCheck
          ? "주차별 저장 · App Check 활성"
          : "주차별 저장 · App Check 설정 전"
      );
    } catch (error) {
      console.error("Firebase save failed:", error);
      setCloudStatus(
        "error",
        "동기화 오류",
        error?.message || "Firebase 저장 실패"
      );
    }
  }

  function queueCloudWrite(immediate = false) {
    if (
      !cloudRuntime.configured ||
      !cloudRuntime.db ||
      !cloudRuntime.employeesReady ||
      cloudRuntime.applyingRemote
    ) {
      return;
    }

    clearTimeout(cloudRuntime.saveTimer);

    cloudRuntime.saveTimer = setTimeout(
      pushCloudState,
      immediate
        ? 0
        : Math.max(
            500,
            Number(schedulerCloudConfig.saveDebounceMs) || 900
          )
    );
  }

  function stopWeekListener() {
    if (cloudRuntime.weekUnsubscribe) {
      cloudRuntime.weekUnsubscribe();
      cloudRuntime.weekUnsubscribe = null;
    }

    cloudRuntime.weekRef = null;
    cloudRuntime.weekReady = false;
  }

  function subscribeToWeek(weekKey) {
    if (!cloudRuntime.db) return;
    if (cloudRuntime.activeWeekKey === weekKey && cloudRuntime.weekUnsubscribe) {
      return;
    }

    stopWeekListener();

    cloudRuntime.activeWeekKey = weekKey;
    cloudRuntime.weekRef = doc(
      cloudRuntime.db,
      schedulerCloudConfig.weeksCollection || "scheduleWeeks",
      weekKey
    );

    setCloudStatus(
      "syncing",
      "주차 불러오는 중…",
      `${weekKey} 스케줄 동기화`
    );

    cloudRuntime.weekUnsubscribe = onSnapshot(
      cloudRuntime.weekRef,
      (snapshot) => {
        cloudRuntime.applyingRemote = true;

        try {
          if (snapshot.exists()) {
            const data = snapshot.data();
            replaceLocalWeekData(weekKey, data);

            cloudRuntime.lastWeekHashes.set(
              weekKey,
              stableWeekHash({
                weekStart: weekKey,
                shifts: Array.isArray(data.shifts) ? data.shifts : [],
                personal: Array.isArray(data.personal) ? data.personal : []
              })
            );

            if (!cloudRuntime.knownWeeks.includes(weekKey)) {
              cloudRuntime.knownWeeks.push(weekKey);
              cloudRuntime.knownWeeks.sort();
            }
          } else {
            // Firestore에 아직 없는 주는 현재 브라우저의 로컬 데이터를 그대로 보여줌.
            cloudRuntime.lastWeekHashes.delete(weekKey);
          }

          cloudRuntime.weekReady = true;
          saveLocalBackup();

          setCloudStatus(
            "connected",
            cloudRuntime.appCheck ? "Firebase + App Check" : "Firebase 동기화",
            cloudRuntime.appCheck
              ? "주차별 저장 · App Check 활성"
              : "주차별 저장 · App Check 설정 전"
          );
        } finally {
          cloudRuntime.applyingRemote = false;
        }
      },
      (error) => {
        console.error("Week listener failed:", error);
        setCloudStatus(
          "error",
          "주차 연결 오류",
          error?.message || "주차 데이터 접근 실패"
        );
      }
    );
  }

  function subscribeToEmployees() {
    cloudRuntime.employeesRef = doc(
      cloudRuntime.db,
      schedulerCloudConfig.schedulerCollection || "scheduler",
      schedulerCloudConfig.employeesDocument || "employees"
    );

    cloudRuntime.employeesUnsubscribe = onSnapshot(
      cloudRuntime.employeesRef,
      async (snapshot) => {
        cloudRuntime.applyingRemote = true;

        try {
          if (snapshot.exists()) {
            const data = snapshot.data();

            state.employees = normalizeEmployees(data.employees);
            cloudRuntime.knownWeeks = Array.isArray(data.knownWeeks)
              ? data.knownWeeks.filter((key) => typeof key === "string")
              : [];

            cloudRuntime.lastEmployeesHash = stableEmployeesHash(
              state.employees,
              cloudRuntime.knownWeeks
            );
          } else {
            // 첫 실행: 기존 localStorage 직원 목록을 그대로 초기 Firestore 데이터로 사용.
            state.employees = normalizeEmployees(state.employees);
            cloudRuntime.knownWeeks = collectLocalWeekKeys().filter((key) => {
              const payload = getLocalWeekPayload(key);
              return weekHasData(payload);
            });
            cloudRuntime.lastEmployeesHash = "";
          }

          pruneExpiredState();
          saveLocalBackup();
          renderEmployeeList();
          renderCalendar();

          cloudRuntime.employeesReady = true;
        } finally {
          cloudRuntime.applyingRemote = false;
        }

        if (!snapshot.exists()) {
          queueCloudWrite(true);
        } else {
          await cleanupOldCloudWeeks();
        }
      },
      (error) => {
        console.error("Employees listener failed:", error);
        cloudRuntime.employeesReady = false;
        setCloudStatus(
          "error",
          "권한/연결 오류",
          error?.message || "직원 데이터 접근 실패"
        );
      }
    );
  }

  function switchCloudWeekToCurrentView() {
    if (!cloudRuntime.db) return;
    subscribeToWeek(ymd(currentMonday()));
  }

  function initOptionalAppCheck(app) {
    const config = schedulerCloudConfig.appCheck || {};
    const siteKey = String(config.recaptchaEnterpriseSiteKey || "");

    const enabled =
      config.enabled === true &&
      siteKey &&
      !siteKey.startsWith("PASTE_");

    if (!enabled) {
      return null;
    }

    try {
      return initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(siteKey),
        isTokenAutoRefreshEnabled: true
      });
    } catch (error) {
      console.error("App Check init failed:", error);
      setCloudStatus(
        "error",
        "App Check 오류",
        error?.message || "App Check 초기화 실패"
      );
      return null;
    }
  }

  async function initFirebaseBridge() {
    if (!cloudRuntime.configured) {
      setCloudStatus(
        "error",
        "Firebase 설정 필요",
        "firebase-config.js 설정값을 확인하세요."
      );
      return;
    }

    try {
      cloudRuntime.app = initializeApp(firebaseConfig);

      // App Check는 Firestore보다 먼저 초기화해야 합니다.
      cloudRuntime.appCheck = initOptionalAppCheck(cloudRuntime.app);

      cloudRuntime.db = getFirestore(cloudRuntime.app);

      setCloudStatus(
        "syncing",
        "Firebase 연결 중…",
        "직원 + 주차별 스케줄 구조"
      );

      subscribeToEmployees();
      switchCloudWeekToCurrentView();
    } catch (error) {
      console.error("Firebase init failed:", error);
      setCloudStatus(
        "error",
        "Firebase 설정 오류",
        error?.message || "초기화 실패"
      );
    }
  }

  function bindDialogCloseButtons() {
    document.querySelectorAll(".dialog-close, .dialog-cancel").forEach((btn) => {
      btn.addEventListener("click", () => {
        const dialog = btn.closest("dialog");
        if (dialog && dialog.open) dialog.close();
      });
    });
  }

  // --------------------
  // 직원
  // --------------------
  function openEmployee(id = null) {
    const dlg = $("#employeeDialog");
    const isEdit = !!id;
    const emp = isEdit ? employeeById(id) : null;

    $("#employeeDialogTitle").textContent = isEdit ? "직원 수정" : "직원 등록";
    $("#employeeId").value = id || "";
    $("#employeeName").value = emp?.name || "";
    $("#employeeRole").value = emp?.role || "정직원";
    $("#deleteEmployeeBtn").classList.toggle("hidden", !isEdit);

    dlg.showModal();
    setTimeout(() => $("#employeeName").focus(), 50);
  }

  $("#employeeForm").addEventListener("submit", (e) => {
    e.preventDefault();

    const id = $("#employeeId").value;
    const name = $("#employeeName").value.trim();
    const role = $("#employeeRole").value;

    if (!name) return;

    if (id) {
      const emp = employeeById(id);
      emp.name = name;
      emp.role = role;
    } else {
      state.employees.push({
        id: uid("emp"),
        name,
        role,
        color: PALETTE[state.employees.length % PALETTE.length]
      });
    }

    saveState();
    $("#employeeDialog").close();
    renderAll();
  });

  function deleteEmployeeById(id) {
    const emp = employeeById(id);
    if (!emp) return;

    if (!confirm(`${emp.name} 직원을 삭제할까요?\n해당 직원의 근무 스케줄과 개인 일정도 함께 삭제됩니다.`)) {
      return;
    }

    state.employees = state.employees.filter((e) => e.id !== id);
    state.shifts = state.shifts.filter((s) => s.employeeId !== id);
    state.personal = state.personal.filter((p) => p.employeeId !== id);

    saveState();

    if ($("#employeeDialog").open) {
      $("#employeeDialog").close();
    }

    renderAll();
    toast(`${emp.name} 직원을 삭제했습니다.`);
  }

  $("#deleteEmployeeBtn").onclick = () => {
    deleteEmployeeById($("#employeeId").value);
  };

  // --------------------
  // 개인 일정
  // --------------------
  function openPersonal(id = null) {
    if (!state.employees.length) {
      toast("직원을 먼저 등록하세요.");
      return;
    }

    const isEdit = !!id;
    const item = isEdit ? state.personal.find((p) => p.id === id) : null;

    if (isEdit && !item) {
      toast("개인 일정을 찾을 수 없습니다.");
      return;
    }

    $("#personalEmployee").innerHTML = state.employees.map((e) =>
      `<option value="${e.id}">${esc(e.name)} · ${esc(e.role)}</option>`
    ).join("");

    $("#personalId").value = item?.id || "";
    $("#personalDialogTitle").textContent = isEdit ? "개인 일정 수정" : "개인 일정 추가";
    $("#personalDialogDesc").textContent = isEdit
      ? "직원, 날짜, 시간, 메모를 수정하거나 이 일정을 삭제할 수 있습니다."
      : "직원과 날짜를 선택해 근무할 수 없는 시간을 등록합니다.";
    $("#savePersonalBtn").textContent = isEdit ? "수정 저장" : "일정 저장";
    $("#deletePersonalBtn").classList.toggle("hidden", !isEdit);

    if (isEdit) {
      $("#personalEmployee").value = item.employeeId;
      $("#personalDate").value = item.date;
      $("#allDay").checked = !!item.allDay;
      $("#personalStart").value = item.allDay ? "10:00" : (item.start || "10:00");
      $("#personalEnd").value = item.allDay ? "18:00" : (item.end || "18:00");
      $("#personalMemo").value = item.memo || "";

      const d = parseDate(item.date);
      personalMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    } else {
      const today = new Date();
      personalMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      $("#personalDate").value = ymd(today);
      $("#personalEmployee").value = state.employees[0]?.id || "";
      $("#allDay").checked = false;
      $("#personalStart").value = "10:00";
      $("#personalEnd").value = "18:00";
      $("#personalMemo").value = "";
    }

    $("#personalTimeFields").classList.toggle("hidden", $("#allDay").checked);

    renderMiniCalendar();
    $("#personalDialog").showModal();
  }

  function renderMiniCalendar() {
    $("#personalMonthTitle").textContent =
      `${personalMonth.getFullYear()}년 ${personalMonth.getMonth() + 1}월`;

    const first = new Date(
      personalMonth.getFullYear(),
      personalMonth.getMonth(),
      1
    );

    const start = addDays(first, -((first.getDay() + 6) % 7));
    const selected = $("#personalDate").value;
    const dows = ["월", "화", "수", "목", "금", "토", "일"];

    let html = dows.map((d, i) =>
      `<div class="mini-dow ${i === 5 ? "sat" : i === 6 ? "sun" : ""}">${d}</div>`
    ).join("");

    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const ds = ymd(d);
      const dow = d.getDay();

      html += `
        <button type="button"
                class="mini-day
                  ${d.getMonth() !== personalMonth.getMonth() ? "other" : ""}
                  ${selected === ds ? "selected" : ""}
                  ${dow === 0 ? "sun" : dow === 6 ? "sat" : ""}"
                data-date="${ds}">
          ${d.getDate()}
        </button>
      `;
    }

    $("#miniCalendar").innerHTML = html;

    document.querySelectorAll(".mini-day").forEach((b) => {
      b.onclick = () => {
        $("#personalDate").value = b.dataset.date;
        const d = parseDate(b.dataset.date);
        personalMonth = new Date(d.getFullYear(), d.getMonth(), 1);
        renderMiniCalendar();
      };
    });
  }

  $("#personalPrev").onclick = () => {
    personalMonth = new Date(
      personalMonth.getFullYear(),
      personalMonth.getMonth() - 1,
      1
    );
    renderMiniCalendar();
  };

  $("#personalNext").onclick = () => {
    personalMonth = new Date(
      personalMonth.getFullYear(),
      personalMonth.getMonth() + 1,
      1
    );
    renderMiniCalendar();
  };

  $("#personalDate").onchange = () => {
    const d = parseDate($("#personalDate").value);
    personalMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    renderMiniCalendar();
  };

  $("#allDay").onchange = () => {
    $("#personalTimeFields").classList.toggle("hidden", $("#allDay").checked);
  };

  $("#personalForm").addEventListener("submit", (e) => {
    e.preventDefault();

    const id = $("#personalId").value;
    const employeeId = $("#personalEmployee").value;
    const date = $("#personalDate").value;
    const allDay = $("#allDay").checked;
    const start = allDay ? "00:00" : $("#personalStart").value;
    const end = allDay ? "24:00" : $("#personalEnd").value;

    if (!allDay && minFromTime(end) <= minFromTime(start)) {
      toast("개인 일정 종료 시간을 확인하세요.");
      return;
    }

    const ps = allDay ? 0 : minFromTime(start);
    const pe = allDay ? 1440 : minFromTime(end);

    const conflict = state.shifts.some((s) =>
      s.employeeId === employeeId &&
      s.date === date &&
      overlap(ps, pe, minFromTime(s.start), effectiveShiftEnd(s))
    );

    if (
      conflict &&
      !confirm(
        "이미 등록된 근무 스케줄과 겹칩니다.\n" +
        "개인 일정을 저장하면 해당 근무가 충돌 표시됩니다. 계속할까요?"
      )
    ) {
      return;
    }

    if (id) {
      const item = state.personal.find((p) => p.id === id);
      if (!item) {
        toast("수정할 개인 일정을 찾을 수 없습니다.");
        return;
      }

      item.employeeId = employeeId;
      item.date = date;
      item.allDay = allDay;
      item.start = start;
      item.end = end;
      item.memo = $("#personalMemo").value.trim();
    } else {
      state.personal.push({
        id: uid("personal"),
        employeeId,
        date,
        allDay,
        start,
        end,
        memo: $("#personalMemo").value.trim()
      });
    }

    saveState();
    $("#personalDialog").close();
    renderCalendar();
    toast(id ? "개인 일정이 수정되었습니다." : "개인 일정이 저장되었습니다.");
  });

  $("#deletePersonalBtn").onclick = () => {
    const id = $("#personalId").value;
    const item = state.personal.find((p) => p.id === id);

    if (!item) {
      toast("삭제할 개인 일정을 찾을 수 없습니다.");
      return;
    }

    const emp = employeeById(item.employeeId);
    const label = emp ? emp.name : "해당 직원";

    if (!confirm(`${label}의 ${item.date} 개인 일정을 삭제할까요?`)) {
      return;
    }

    state.personal = state.personal.filter((p) => p.id !== id);
    saveState();
    $("#personalDialog").close();
    renderCalendar();
    toast("개인 일정이 삭제되었습니다.");
  };

  // --------------------
  // 근무 수정
  // --------------------
  function syncShiftDialogForDate() {
    const date = $("#shiftDate").value;
    const weekend = isWeekend(date);

    $("#weekendNotice").classList.toggle("hidden", !weekend);

    const endLabel = $("#shiftEnd").closest("label");
    endLabel.classList.toggle("hidden", weekend);
    $("#shiftEnd").required = !weekend;

    const start = minFromTime($("#shiftStart").value);
    if (start == null || start < START_MIN || start >= END_MIN) {
      $("#shiftStart").value = "09:30";
    }

    if (!weekend) {
      const end = minFromTime($("#shiftEnd").value);
      if (end == null || end <= minFromTime($("#shiftStart").value) || end > END_MIN) {
        $("#shiftEnd").value = "18:00";
      }
    }
  }

  function openShift(id) {
    if (isMobileMode()) {
      toast("근무 스케줄 수정은 PC에서만 가능합니다.");
      return;
    }

    const s = state.shifts.find((x) => x.id === id);
    const emp = s && employeeById(s.employeeId);
    if (!s || !emp) return;

    $("#shiftId").value = s.id;
    $("#shiftDate").value = s.date;
    $("#shiftStart").value = s.start;
    $("#shiftEnd").value = s.end || "18:00";

    $("#shiftEmployeeLabel").innerHTML =
      `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${emp.color};margin-right:7px"></span>` +
      `${esc(emp.name)} · ${esc(emp.role)}`;

    syncShiftDialogForDate();
    $("#shiftDialog").showModal();
  }

  $("#shiftDate").addEventListener("change", syncShiftDialogForDate);

  $("#shiftForm").addEventListener("submit", (e) => {
    e.preventDefault();

    const s = state.shifts.find((x) => x.id === $("#shiftId").value);
    if (!s) return;

    const date = $("#shiftDate").value;
    const weekend = isWeekend(date);
    const st = minFromTime($("#shiftStart").value);

    if (!validWorkStart(st)) {
      toast("출근은 09:30부터 21:30까지만 등록할 수 있습니다.");
      return;
    }

    if (weekend) {
      if (conflictsPersonal(s.employeeId, date, st, END_MIN)) {
        toast("개인 일정과 겹칩니다.");
        return;
      }
      if (conflictsShift(s.employeeId, date, st, END_MIN, s.id)) {
        toast("다른 근무와 겹칩니다.");
        return;
      }

      s.date = date;
      s.start = timeFromMin(st);
      s.end = null;

      saveState();
      $("#shiftDialog").close();
      renderCalendar();
      return;
    }

    const en = minFromTime($("#shiftEnd").value);

    if (en == null || en <= st || en > END_MIN) {
      toast("평일 퇴근은 출근 이후부터 22:00까지만 가능합니다.");
      return;
    }

    if (conflictsPersonal(s.employeeId, date, st, en)) {
      toast("개인 일정과 겹칩니다.");
      return;
    }

    if (conflictsShift(s.employeeId, date, st, en, s.id)) {
      toast("다른 근무와 겹칩니다.");
      return;
    }

    s.date = date;
    s.start = timeFromMin(st);
    s.end = timeFromMin(en);

    saveState();
    $("#shiftDialog").close();
    renderCalendar();
  });

  $("#deleteShiftBtn").onclick = () => {
    const id = $("#shiftId").value;
    state.shifts = state.shifts.filter((s) => s.id !== id);
    saveState();
    $("#shiftDialog").close();
    renderCalendar();
  };

  // --------------------
  // 주간표 전체 이미지 → 클립보드 복사
  // --------------------
  function hexToRgb(hex) {
    const clean = hex.replace("#", "");
    const full = clean.length === 3
      ? clean.split("").map((c) => c + c).join("")
      : clean;

    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16)
    };
  }

  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawText(ctx, text, x, y, maxWidth) {
    if (maxWidth == null) {
      ctx.fillText(text, x, y);
      return;
    }

    let value = String(text);
    if (ctx.measureText(value).width <= maxWidth) {
      ctx.fillText(value, x, y);
      return;
    }

    while (value.length > 1 && ctx.measureText(value + "…").width > maxWidth) {
      value = value.slice(0, -1);
    }
    ctx.fillText(value + "…", x, y);
  }

  function buildScheduleCanvas(range = "all") {
    const weekStart = currentMonday();
    const fullWeekEnd = addDays(weekStart, 6);

    const rangeMap = {
      all: { startOffset: 0, dayCount: 7, label: "전체 · 월~일" },
      weekday: { startOffset: 0, dayCount: 5, label: "주간 · 월~금" },
      weekend: { startOffset: 5, dayCount: 2, label: "주말 · 토~일" }
    };
    const selected = rangeMap[range] || rangeMap.all;
    const captureStart = addDays(weekStart, selected.startOffset);
    const captureEnd = addDays(captureStart, selected.dayCount - 1);

    const scale = 2;
    const margin = 32;
    const leftW = 230;
    const timeW = 1180;
    const titleH = 96;
    const dayHeadH = 48;
    const rowH = 50;
    const footerH = 44;
    const contentW = leftW + timeW;
    const dayH = dayHeadH + Math.max(1, state.employees.length) * rowH;
    const width = margin * 2 + contentW;
    const height = margin * 2 + titleH + dayH * selected.dayCount + footerH;

    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;

    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    ctx.fillStyle = "#f4f6f8";
    ctx.fillRect(0, 0, width, height);

    // 전체 카드
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, margin, margin, contentW, height - margin * 2, 16);
    ctx.fill();

    // 제목
    ctx.fillStyle = "#15191f";
    ctx.font = '800 26px "Noto Sans KR", Arial, sans-serif';
    ctx.fillText("직원 주간 스케줄", margin + 22, margin + 36);

    ctx.fillStyle = "#737c88";
    ctx.font = '600 13px "Noto Sans KR", Arial, sans-serif';
    ctx.fillText(
      `${captureStart.getFullYear()}. ${captureStart.getMonth() + 1}. ${captureStart.getDate()}.  —  ` +
      `${captureEnd.getFullYear()}. ${captureEnd.getMonth() + 1}. ${captureEnd.getDate()}.`,
      margin + 22,
      margin + 61
    );

    ctx.font = '500 11px "Noto Sans KR", Arial, sans-serif';
    ctx.fillText(
      `${selected.label} · 근무 입력 09:30–22:00 · 토/일 퇴근 미정`,
      margin + 22,
      margin + 81
    );

    const koDays = ["일", "월", "화", "수", "목", "금", "토"];
    let y = margin + titleH;

    for (let di = 0; di < selected.dayCount; di++) {
      const d = addDays(captureStart, di);
      const ds = ymd(d);
      const dow = d.getDay();

      // 요일 헤더
      ctx.fillStyle = "#f7f8fa";
      ctx.fillRect(margin, y, contentW, dayHeadH);

      ctx.strokeStyle = "#dfe4ea";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(margin, y + dayHeadH);
      ctx.lineTo(margin + contentW, y + dayHeadH);
      ctx.stroke();

      ctx.fillStyle = dow === 0 ? "#d64545" : dow === 6 ? "#2267d8" : "#15191f";
      ctx.font = '800 15px "Noto Sans KR", Arial, sans-serif';
      ctx.fillText(
        `${koDays[dow]}요일  ${d.getMonth() + 1}/${d.getDate()}`,
        margin + 14,
        y + 30
      );

      // 시간 눈금
      ctx.fillStyle = "#747d89";
      ctx.font = '600 9px Arial, sans-serif';

      // 09:30은 여유 입력 구간이므로 숫자를 표시하지 않고,
      // 실제 출근 기준인 10:00부터 정각만 표시합니다.
      for (let m = 10 * 60; m < END_MIN; m += 60) {
        const px = margin + leftW + ((m - START_MIN) / (END_MIN - START_MIN)) * timeW;

        if (m === 10 * 60) {
          ctx.fillStyle = "#111827";
          roundRect(ctx, px - 3, y + 13, 39, 21, 5);
          ctx.fill();

          ctx.fillStyle = "#ffffff";
          ctx.font = '800 9px Arial, sans-serif';
          ctx.fillText("10:00", px + 2, y + 27);
        } else {
          ctx.fillStyle = "#4f5965";
          ctx.font = '700 9px Arial, sans-serif';
          ctx.fillText(timeFromMin(m), px + 3, y + 29);
        }
      }

      ctx.fillStyle = "#111827";
      ctx.font = '800 9px Arial, sans-serif';
      ctx.fillText("22:00", margin + leftW + timeW - 30, y + 29);

      y += dayHeadH;

      const employees = state.employees.length ? state.employees : [null];

      employees.forEach((emp) => {
        // 행 배경
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(margin, y, contentW, rowH);

        ctx.strokeStyle = "#edf0f3";
        ctx.beginPath();
        ctx.moveTo(margin, y + rowH);
        ctx.lineTo(margin + contentW, y + rowH);
        ctx.stroke();

        ctx.strokeStyle = "#dfe4ea";
        ctx.beginPath();
        ctx.moveTo(margin + leftW, y);
        ctx.lineTo(margin + leftW, y + rowH);
        ctx.stroke();

        // 30분 그리드
        for (let slot = 0; slot <= TOTAL_SLOTS; slot++) {
          const gx = margin + leftW + (slot / TOTAL_SLOTS) * timeW;
          ctx.strokeStyle = slot % 2 === 0 ? "#e1e5ea" : "#f0f2f4";
          ctx.beginPath();
          ctx.moveTo(gx, y);
          ctx.lineTo(gx, y + rowH);
          ctx.stroke();
        }

        if (!emp) {
          ctx.fillStyle = "#8a929d";
          ctx.font = '600 12px "Noto Sans KR", Arial, sans-serif';
          ctx.fillText("등록 직원 없음", margin + 14, y + 30);
          y += rowH;
          return;
        }

        // 직원명
        ctx.fillStyle = emp.color;
        ctx.beginPath();
        ctx.arc(margin + 16, y + rowH / 2, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#15191f";
        ctx.font = '800 12px "Noto Sans KR", Arial, sans-serif';
        drawText(
          ctx,
          `${emp.role === "관리자" ? "★ " : ""}${emp.name}`,
          margin + 29,
          y + 21,
          leftW - 44
        );

        ctx.fillStyle = "#747d89";
        ctx.font = '500 9px "Noto Sans KR", Arial, sans-serif';
        drawText(ctx, emp.role, margin + 29, y + 36, leftW - 44);

        const timeX = (minute) =>
          margin + leftW + ((minute - START_MIN) / (END_MIN - START_MIN)) * timeW;

        // 개인 일정
        state.personal
          .filter((p) => p.employeeId === emp.id && p.date === ds)
          .forEach((p) => {
            let st, en;
            if (p.allDay) {
              st = START_MIN;
              en = END_MIN;
            } else {
              st = Math.max(START_MIN, minFromTime(p.start));
              en = Math.min(END_MIN, minFromTime(p.end));
            }

            if (en <= st) return;

            const x1 = timeX(st);
            const x2 = timeX(en);

            ctx.fillStyle = "rgba(80,88,98,.18)";
            roundRect(ctx, x1, y + 7, x2 - x1, rowH - 14, 6);
            ctx.fill();

            ctx.strokeStyle = "rgba(80,88,98,.32)";
            ctx.stroke();

            ctx.fillStyle = "#5b626c";
            ctx.font = '600 8px "Noto Sans KR", Arial, sans-serif';
            const label = p.allDay
              ? "개인 일정 · 종일"
              : `개인 ${p.start}–${p.end}`;
            drawText(ctx, label, x1 + 5, y + 27, Math.max(0, x2 - x1 - 10));
          });

        // 주말: 최초 출근자(동률 포함)를 제외한 직원의 출근 직전 1시간
        if (isWeekend(ds)) {
          const firstStart = earliestWeekendStart(ds);

          state.shifts
            .filter((s) => s.employeeId === emp.id && s.date === ds && s.start)
            .forEach((s) => {
              const st = minFromTime(s.start);
              if (firstStart == null || st <= firstStart) return;

              const prepStart = Math.max(START_MIN, st - 60);
              const prepEnd = st;
              if (prepEnd <= prepStart) return;

              const x1 = timeX(prepStart);
              const x2 = timeX(prepEnd);

              ctx.fillStyle = "#FFD400";
              roundRect(ctx, x1, y + 7, Math.max(8, x2 - x1), rowH - 14, 6);
              ctx.fill();

              ctx.strokeStyle = "#D8B400";
              ctx.stroke();
            });
        }

        // 근무
        state.shifts
          .filter((s) => s.employeeId === emp.id && s.date === ds)
          .forEach((s) => {
            const st = minFromTime(s.start);
            const weekend = isWeekend(ds);
            const en = weekend ? END_MIN : minFromTime(s.end);

            if (st == null || en == null) return;

            const x1 = timeX(st);
            const x2 = timeX(en);

            ctx.fillStyle = weekend ? rgba(emp.color, .72) : emp.color;
            roundRect(ctx, x1, y + 10, Math.max(20, x2 - x1), rowH - 20, 7);
            ctx.fill();

            // 주말은 오른쪽으로 옅어지는 느낌을 흰색 오버레이로 표현
            if (weekend) {
              const grad = ctx.createLinearGradient(x1, 0, x2, 0);
              grad.addColorStop(0, "rgba(255,255,255,0)");
              grad.addColorStop(.45, "rgba(255,255,255,.06)");
              grad.addColorStop(1, "rgba(255,255,255,.68)");
              ctx.fillStyle = grad;
              roundRect(ctx, x1, y + 10, Math.max(20, x2 - x1), rowH - 20, 7);
              ctx.fill();
            }

            ctx.fillStyle = "#ffffff";
            ctx.font = '800 9px "Noto Sans KR", Arial, sans-serif';
            const label = weekend
              ? `${emp.name} · ${s.start} 출근 · 퇴근 미정`
              : `${emp.name} · ${s.start}–${s.end}`;

            drawText(
              ctx,
              label,
              x1 + 7,
              y + 30,
              Math.max(0, x2 - x1 - 14)
            );
          });

        y += rowH;
      });
    }

    // 하단 안내
    ctx.fillStyle = "#747d89";
    ctx.font = '500 10px "Noto Sans KR", Arial, sans-serif';
    ctx.fillText(
      "※ 회색 영역은 개인 일정/근무 불가 시간입니다. 주말 근무는 출근 시각만 확정된 상태입니다.",
      margin + 16,
      height - margin - 16
    );

    return canvas;
  }

  async function canvasToBlob(canvas) {
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG 생성 실패"));
      }, "image/png");
    });
  }

  async function fallbackCopyImage(blob) {
    const url = URL.createObjectURL(blob);
    const box = document.createElement("div");
    box.contentEditable = "true";
    box.style.position = "fixed";
    box.style.left = "-99999px";
    box.style.top = "0";

    const img = document.createElement("img");
    img.src = url;
    box.appendChild(img);
    document.body.appendChild(box);

    await img.decode();

    const range = document.createRange();
    range.selectNode(img);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const ok = document.execCommand("copy");

    selection.removeAllRanges();
    box.remove();
    URL.revokeObjectURL(url);

    if (!ok) throw new Error("fallback copy failed");
  }

  async function copyScheduleAsImage(range = "all") {
    if (!state.employees.length) {
      toast("복사할 직원 스케줄이 없습니다.");
      return;
    }

    try {
      const canvas = buildScheduleCanvas(range);
      const blob = await canvasToBlob(canvas);

      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob })
        ]);
      } else {
        await fallbackCopyImage(blob);
      }

      toast("선택한 범위의 스케줄을 이미지로 복사했습니다. Ctrl+V로 붙여넣으세요.");
    } catch (err) {
      console.error(err);

      // 최신 Chrome/Edge의 file:// 또는 보안 정책에서 Clipboard API가 막히는 경우를 위한 2차 시도
      try {
        const canvas = buildScheduleCanvas(range);
        const blob = await canvasToBlob(canvas);
        await fallbackCopyImage(blob);
        toast("주간표를 이미지로 복사했습니다. Ctrl+V로 붙여넣으세요.");
      } catch (fallbackErr) {
        console.error(fallbackErr);
        alert(
          "브라우저가 이미지 클립보드 복사를 차단했습니다.\n\n" +
          "Chrome 또는 Edge에서 이 페이지를 열고 클립보드 권한을 허용한 뒤 다시 시도해 주세요."
        );
      }
    }
  }



  // =========================================================
  // 모바일 전용 UI
  // 근무 스케줄은 조회 전용 / 개인 일정만 추가·수정 가능
  // =========================================================
  function mobileWeekDates() {
    const start = currentMonday();
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }

  function mobileShortTime(time) {
    if (!time) return "";
    return time.replace(/^0/, "");
  }

  function mobileShiftLabel(shift, date) {
    if (!shift) return null;

    if (isWeekend(date)) {
      return {
        top: mobileShortTime(shift.start),
        bottom: "출근 · 퇴근 미정"
      };
    }

    return {
      top: `${mobileShortTime(shift.start)}–${mobileShortTime(shift.end)}`,
      bottom: ""
    };
  }

  function personalsFor(employeeId, date) {
    return state.personal.filter(
      (item) => item.employeeId === employeeId && item.date === date
    );
  }

  function shiftsFor(employeeId, date) {
    return state.shifts.filter(
      (item) => item.employeeId === employeeId && item.date === date
    );
  }

  function mobilePersonalLabel(item) {
    if (item.allDay) {
      return item.memo ? `종일 · ${item.memo}` : "종일 근무 불가";
    }

    const time = `${mobileShortTime(item.start)}–${mobileShortTime(item.end)}`;
    return item.memo ? `${time} · ${item.memo}` : time;
  }

  function ensureMobileSelectedDate() {
    const dates = mobileWeekDates().map(ymd);

    if (mobileSelectedDate && dates.includes(mobileSelectedDate)) {
      return;
    }

    const today = ymd(new Date());

    if (dates.includes(today)) {
      mobileSelectedDate = today;
    } else {
      mobileSelectedDate = dates[0];
    }
  }

  function renderMobileWeekOverview() {
    const root = $("#mobileOverview");
    if (!root) return;

    const dates = mobileWeekDates();
    const koDays = ["일", "월", "화", "수", "목", "금", "토"];

    let html = `
      <div class="mobile-overview">
        <div class="mobile-overview-head">
          <div class="mobile-overview-name-head">직원</div>
          ${dates.map((date) => {
            const dow = date.getDay();
            return `
              <div class="mobile-overview-day ${dow === 0 ? "sun" : dow === 6 ? "sat" : ""}">
                ${koDays[dow]}
                <span>${date.getMonth() + 1}/${date.getDate()}</span>
              </div>
            `;
          }).join("")}
        </div>
    `;

    if (!state.employees.length) {
      html += `<div class="mobile-empty" style="margin:12px">등록된 직원이 없습니다.</div></div>`;
      root.innerHTML = html;
      return;
    }

    for (const employee of state.employees) {
      html += `
        <div class="mobile-overview-row">
          <div class="mobile-overview-person ${employee.role === "관리자" ? "manager" : ""}">
            <span class="mobile-overview-dot" style="background:${employee.color}"></span>
            <div class="mobile-overview-person-text">
              <div class="mobile-overview-person-name">
                ${employee.role === "관리자" ? "★ " : ""}${esc(employee.name)}
              </div>
              <div class="mobile-overview-person-role">${esc(employee.role)}</div>
            </div>
          </div>
      `;

      for (const dateObj of dates) {
        const date = ymd(dateObj);
        const shift = shiftsFor(employee.id, date)[0] || null;
        const personal = personalsFor(employee.id, date);
        const label = mobileShiftLabel(shift, date);

        let content = "";

        if (label) {
          content = `
            <div class="mobile-shift-pill ${isWeekend(date) ? "weekend" : ""}"
                 style="background-color:${employee.color}">
              <span>${esc(label.top)}</span>
              ${label.bottom ? `<span style="font-size:7px;font-weight:700">${esc(label.bottom)}</span>` : ""}
            </div>
          `;
        } else if (personal.some((item) => item.allDay)) {
          content = `<div class="mobile-personal-only">개인 일정</div>`;
        } else {
          content = `<span class="mobile-no-shift">—</span>`;
        }

        html += `
          <div class="mobile-shift-cell">
            ${content}
            ${personal.length ? '<span class="mobile-personal-dot" title="개인 일정"></span>' : ""}
          </div>
        `;
      }

      html += `</div>`;
    }

    html += `</div>`;
    root.innerHTML = html;
  }

  function renderMobileDayTabs() {
    const root = $("#mobileDayTabs");
    if (!root) return;

    const koDays = ["일", "월", "화", "수", "목", "금", "토"];

    root.innerHTML = mobileWeekDates().map((dateObj) => {
      const date = ymd(dateObj);
      const dow = dateObj.getDay();

      return `
        <button type="button"
                class="mobile-day-tab ${date === mobileSelectedDate ? "active" : ""} ${dow === 0 ? "sun" : dow === 6 ? "sat" : ""}"
                data-mobile-date="${date}">
          <strong>${koDays[dow]}</strong>
          <span>${dateObj.getMonth() + 1}/${dateObj.getDate()}</span>
        </button>
      `;
    }).join("");

    root.querySelectorAll("[data-mobile-date]").forEach((button) => {
      button.addEventListener("click", () => {
        mobileSelectedDate = button.dataset.mobileDate;
        renderMobileDayTabs();
        renderMobileDaySummary();

        button.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center"
        });
      });
    });
  }

  function renderMobileDaySummary() {
    const root = $("#mobileDaySummary");
    if (!root || !mobileSelectedDate) return;

    const dateObj = parseDate(mobileSelectedDate);
    const koDays = ["일", "월", "화", "수", "목", "금", "토"];
    const dayName = `${dateObj.getMonth() + 1}월 ${dateObj.getDate()}일 ${koDays[dateObj.getDay()]}요일`;

    const workingCount = state.employees.filter(
      (employee) => shiftsFor(employee.id, mobileSelectedDate).length > 0
    ).length;

    let html = `
      <div class="mobile-day-heading">
        <strong>${dayName}</strong>
        <span>근무 ${workingCount}명</span>
      </div>
    `;

    if (!state.employees.length) {
      root.innerHTML = html + `<div class="mobile-empty">등록된 직원이 없습니다.</div>`;
      return;
    }

    for (const employee of state.employees) {
      const shift = shiftsFor(employee.id, mobileSelectedDate)[0] || null;
      const personal = personalsFor(employee.id, mobileSelectedDate);
      const shiftLabel = mobileShiftLabel(shift, mobileSelectedDate);

      let timeHtml = shiftLabel
        ? `<div class="mobile-person-time">${esc(shiftLabel.top)}${shiftLabel.bottom ? ` · ${esc(shiftLabel.bottom)}` : ""}</div>`
        : `<div class="mobile-person-time off">근무 없음</div>`;

      const personalHtml = personal.length
        ? `<div class="mobile-personal-info">
            ${personal.map((item) => `
              <span class="mobile-personal-chip">${esc(mobilePersonalLabel(item))}</span>
            `).join("")}
          </div>`
        : "";

      html += `
        <div class="mobile-person-card ${employee.role === "관리자" ? "manager" : ""}">
          <div class="mobile-person-color" style="background:${employee.color}">
            ${employee.role === "관리자" ? "★" : esc(employee.name.slice(0,1))}
          </div>

          <div class="mobile-person-main">
            <div class="mobile-person-name">
              ${employee.role === "관리자" ? '<span style="color:#d49b00">★</span>' : ""}
              ${esc(employee.name)}
            </div>
            <div class="mobile-person-role">${esc(employee.role)}</div>
            ${timeHtml}
            ${personalHtml}
          </div>

          <div>
            ${personal.map((item) => `
              <button type="button"
                      class="mobile-edit-personal"
                      data-edit-mobile-personal="${item.id}">
                일정 수정
              </button>
            `).join("")}
          </div>
        </div>
      `;
    }

    root.innerHTML = html;

    root.querySelectorAll("[data-edit-mobile-personal]").forEach((button) => {
      button.addEventListener("click", () => {
        openPersonal(button.dataset.editMobilePersonal);
      });
    });
  }

  function renderMobileWeekTitle() {
    const root = $("#mobileWeekTitle");
    if (!root) return;

    const start = currentMonday();
    const end = addDays(start, 6);

    root.textContent =
      `${start.getMonth() + 1}.${start.getDate()} – ${end.getMonth() + 1}.${end.getDate()}`;
  }

  function renderMobileUI() {
    if (!isMobileMode()) return;

    ensureMobileSelectedDate();
    renderMobileWeekTitle();

    const weekView = $("#mobileWeekView");
    const dayView = $("#mobileDayView");

    if (weekView && dayView) {
      weekView.classList.toggle("hidden", mobileViewMode !== "week");
      dayView.classList.toggle("hidden", mobileViewMode !== "day");
    }

    document.querySelectorAll("[data-mobile-view]").forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.mobileView === mobileViewMode
      );
    });

    renderMobileWeekOverview();
    renderMobileDayTabs();
    renderMobileDaySummary();
  }

  function syncMobileCloudStatus() {
    const source = $("#cloudStatus");
    const target = $("#mobileCloudStatus");

    if (!source || !target) return;

    target.textContent = source.textContent;

    target.classList.toggle(
      "connected",
      source.classList.contains("connected")
    );
    target.classList.toggle(
      "error",
      source.classList.contains("error")
    );
  }

  // --------------------
  // 현재 선택 주의 근무 스케줄 초기화
  // 개인 일정은 유지합니다.
  // --------------------
  function resetCurrentWeekShifts() {
    const weekStart = currentMonday();
    const weekEnd = addDays(weekStart, 6);
    const startKey = ymd(weekStart);
    const endKey = ymd(weekEnd);

    const count = state.shifts.filter(
      (s) => s.date >= startKey && s.date <= endKey
    ).length;

    if (!count) {
      toast("현재 주에 초기화할 근무 스케줄이 없습니다.");
      return;
    }

    const ok = confirm(
      `${startKey} ~ ${endKey}\\n` +
      `이 주의 근무 스케줄 ${count}개를 전부 삭제할까요?\\n\\n` +
      `개인 일정은 삭제되지 않습니다.`
    );

    if (!ok) return;

    state.shifts = state.shifts.filter(
      (s) => !(s.date >= startKey && s.date <= endKey)
    );

    saveState();
    renderCalendar();
    toast("현재 주의 근무 스케줄을 모두 초기화했습니다.");
  }


  function openCaptureDialog() {
    if (!state.employees.length) {
      toast("복사할 직원 스케줄이 없습니다.");
      return;
    }
    $("#captureDialog").showModal();
  }

  document.querySelectorAll("[data-capture-range]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const range = btn.dataset.captureRange;
      $("#captureDialog").close();
      await copyScheduleAsImage(range);
    });
  });


  // --------------------
  // 버튼
  // --------------------
  document.querySelectorAll("[data-mobile-view]").forEach((button) => {
    button.addEventListener("click", () => {
      mobileViewMode = button.dataset.mobileView;
      renderMobileUI();
    });
  });

  $("#mobilePersonalBtn").onclick = () => openPersonal();

  $("#mobilePrevWeek").onclick = () => {
    weekOffset--;
    mobileSelectedDate = null;
    renderCalendar();
    switchCloudWeekToCurrentView();
    renderMobileUI();
  };

  $("#mobileNextWeek").onclick = () => {
    weekOffset++;
    mobileSelectedDate = null;
    renderCalendar();
    switchCloudWeekToCurrentView();
    renderMobileUI();
  };

  $("#mobileTodayWeek").onclick = () => {
    weekOffset = 0;
    mobileSelectedDate = null;
    renderCalendar();
    switchCloudWeekToCurrentView();
    renderMobileUI();
  };

  $("#employeeBtn").onclick = () => openEmployee();
  $("#personalBtn").onclick = () => openPersonal();
  $("#copyWeekBtn").onclick = openCaptureDialog;
  $("#resetWeekBtn").onclick = resetCurrentWeekShifts;

  $("#prevWeek").onclick = () => {
    weekOffset--;
    renderCalendar();
    switchCloudWeekToCurrentView();
  };

  $("#nextWeek").onclick = () => {
    weekOffset++;
    renderCalendar();
    switchCloudWeekToCurrentView();
  };

  $("#todayWeek").onclick = () => {
    weekOffset = 0;
    renderCalendar();
    switchCloudWeekToCurrentView();
  };

  window.addEventListener("online", () => queueCloudWrite(true));

  window.addEventListener("resize", () => {
    renderMobileUI();
  });

  bindDialogCloseButtons();
  saveState();
  renderAll();
  initFirebaseBridge();
})();

  } catch (error) {
    console.error("Firebase SDK startup failed:", error);

    const message =
      location.protocol === "file:"
        ? "Firebase SDK 로드 실패"
        : "Firebase 시작 오류";

    startupMessage(
      message,
      "error",
      error?.message || "Firebase SDK를 불러오지 못했습니다."
    );

    const mobile = document.querySelector("#mobileCloudStatus");
    if (mobile) {
      mobile.textContent = message;
      mobile.classList.add("error");
    }
  }
})();
