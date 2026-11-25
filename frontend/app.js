"use strict";

/* ==========================================================================
 * SmartCare VR · 前端交互层
 * --------------------------------------------------------------------------
 * index.html 负责骨架，scene.js 负责 3D，这个文件只做三件事：
 *   1. 从后端取数据（题库 / 课程 / 成绩）
 *   2. 把数据显示到页面上
 *   3. 把用户的选择发回后端
 *
 * 接口一览：
 *   GET  /api/scenarios              题库（不含正确答案）
 *   GET  /api/courses                课程目录
 *   POST /api/scenarios/{id}/check   单步判题
 *   POST /api/attempts               提交整轮成绩（服务端算分）
 *   GET  /api/profile?learner_id=    能力画像 + 历史记录
 * ========================================================================== */

/* ------------------------------ 一、全局状态 ------------------------------ */

let scenarios = {}; // 题库：来自 /api/scenarios
let courses = []; // 课程：来自 /api/courses
let history = []; // 训练记录：来自 /api/profile
let profile = null; // 能力画像：来自 /api/profile

// 六阶段学习闭环是纯展示文案，不需要后端，留在前端
const journeyData = [
  { title: "护理员登录系统", description: "建立学习档案，查看个人进度与本次训练任务，为能力评估建立清晰起点。", metric: "LEARNER PROFILE", value: "学习档案已建立", evidence: "证据：课程记录与任务起点" },
  { title: "AI 导师推荐课程", description: "根据已有表现推荐知识内容与情景任务，并说明推荐对应的能力缺口。", metric: "PERSONALIZED PATH", value: "推荐跌倒情景复盘", evidence: "证据：上一轮遗漏的观察步骤" },
  { title: "进入虚拟养老院", description: "用 2D 图谱熟悉空间与任务，再进入 3D 房间，以第一或第三视角练习。", metric: "DUAL MODE", value: "2D + 3D 已连接", evidence: "证据：空间观察与视角切换记录" },
  { title: "AI 虚拟老人互动", description: "面对不同状态与情绪的老人，练习解释、倾听、安抚和尊重式沟通。", metric: "HUMAN INTERACTION", value: "先回应需要，再处理任务", evidence: "证据：对话选择与沟通行为" },
  { title: "完成护理任务", description: "把知识转化为可观察的行动顺序，错误分支即时反馈，可安全地重复练习。", metric: "PRACTICE & FEEDBACK", value: "每一步都有行为证据", evidence: "证据：选择、顺序、观察与复盘" },
  { title: "生成报告并再推荐", description: "汇总表现形成能力画像，把薄弱步骤转化为下一轮训练建议，完成闭环。", metric: "CLOSED LOOP", value: "评估回到下一轮学习", evidence: "证据：能力画像与可解释建议" }
];

// 匿名学员 ID：同一个浏览器固定一个，用来区分不同学员
// 注意：某些浏览器在 file:// 下会禁用 localStorage，所以整段包了异常保护
const learnerId = (() => {
  const key = "smartcare-learner-id";
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = window.crypto?.randomUUID?.() || `learner-${Date.now().toString(36)}`;
      localStorage.setItem(key, id);
    }
    return id;
  } catch (error) {
    return `learner-${Date.now().toString(36)}`;
  }
})();

/* ---------------------- 运行模式：在线（接口）/ 离线（内置） ----------------------
 * 启动时探一下 /api/health：
 *   - 通了  → 用 FastAPI 的接口（判题在服务端、成绩进数据库）
 *   - 不通  → 用内置数据（判题在本地、成绩存 localStorage、对话用预设规则）
 * 这样同一份前端既能跑在服务器上，也能打包成一个双击可开的离线网页。
 * ---------------------------------------------------------------------------- */

const STANDALONE = { value: false };
const LOCAL_ATTEMPTS_KEY = "smartcare-offline-attempts";

const FALLBACK_DIMENSIONS = {
  baseValues: [86, 78, 82, 74, 76, 88],
  scenarioDimensions: { fall: [1], acute: [0, 1], dementia: [2], daily: [0, 5] }
};

function offlineData() {
  return window.SMART_CARE_DATA || null;
}

async function detectMode() {
  if (location.protocol === "file:") return true;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch("/api/health", { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    return !response.ok;
  } catch (error) {
    return true;
  }
}

function readLocalAttempts() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_ATTEMPTS_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch (error) {
    return [];
  }
}

function writeLocalAttempt(record) {
  const rows = readLocalAttempts();
  rows.unshift(record);
  try {
    localStorage.setItem(LOCAL_ATTEMPTS_KEY, JSON.stringify(rows.slice(0, 30)));
  } catch (error) {
    /* 隐私模式下 localStorage 可能不可用，忽略即可 */
  }
}

function checkLocally(stepIndex, choice) {
  const step = scenarios[currentScenario].steps[stepIndex];
  return {
    step: stepIndex,
    choice,
    correct: choice === step.correct,
    answer: step.correct,
    feedback: step.feedback
  };
}

function buildLocalRecommendation(latest) {
  if (!latest) {
    return {
      title: "先完成一次跌倒情景训练",
      text: "建立“观察—评估—呼救—记录”的行为基线，再决定下一步。"
    };
  }
  if (latest.score >= 75) {
    return {
      title: `保持${latest.title}判断，尝试下一情景`,
      text: `本次得分 ${latest.score}。建议切换第一与第三视角检查行动顺序，再把能力迁移到其他情景。`
    };
  }
  return {
    title: `复盘${latest.title}的关键步骤`,
    text: `本次得分 ${latest.score}。推荐依据是答错的具体步骤，而不是笼统的“能力不足”；重新练习后再比较成绩。`
  };
}

function computeLocalProfile() {
  const rows = readLocalAttempts();
  const config = offlineData()?.dimensions || FALLBACK_DIMENSIONS;
  const values = [...config.baseValues];
  const best = {};

  rows.forEach((row) => {
    best[row.scenario] = Math.max(best[row.scenario] ?? 0, row.score);
  });
  Object.entries(best).forEach(([scenarioId, score]) => {
    (config.scenarioDimensions[scenarioId] || []).forEach((index) => {
      values[index] = Math.round((values[index] + score) / 2);
    });
  });

  return {
    learner_id: learnerId,
    completed: Object.keys(best).length,
    total_scenarios: Object.keys(scenarios).length || 4,
    best,
    values,
    dimensions: values.map((value, index) => ({
      label: ["护理知识", "应急处理", "沟通关怀", "数字技能", "学习进度", "职业伦理"][index],
      value
    })),
    recommendation: buildLocalRecommendation(rows[0] || null),
    history: rows
  };
}

/* 离线时的角色回复：关键词命中就返回对应台词，逻辑与后端 ai.py 保持一致 */
const LOCAL_RULES = {
  fall: [
    [["疼", "痛", "髋", "腿"], "哎哟……别拉我，一动就疼得厉害。"],
    [["别动", "看", "检查", "伤", "怎么样"], "你先看看吧……右边腿一动就疼，髋这儿也疼。"],
    [["扶", "起来", "站", "床"], "我自己起不来……你先别硬拉，我怕再摔一次。"],
    [["叫", "帮", "医", "护", "人"], "那麻烦你快去叫人，我就在这儿等着，别走太久。"],
    [["冷", "毯", "盖"], "是有点凉……你要是能给我搭件衣服就好了。"]
  ],
  acute: [
    [["胸", "闷", "喘", "气", "呼吸"], "胸口发闷，喘不上气……你在我旁边吗？"],
    [["看", "检查", "怎么"], "别光看着，我难受得很，你帮我叫医生。"],
    [["药", "吃"], "我自己的药不敢乱吃，你帮我叫医生来吧。"],
    [["躺", "睡"], "我不想躺下，坐着还舒服一点……"]
  ],
  dementia: [
    [["吃", "饭", "餐"], "我明明吃过了，你们怎么又要我吃？"],
    [["谁", "哪", "家"], "我……我记不太清了，你是我女儿吗？"],
    [["坐", "等"], "我不想坐这儿，我想回房间。"]
  ],
  daily: [
    [["自己", "试试", "来"], "让我自己来，你在旁边看着就行。"],
    [["慢", "等", "别急"], "好，我慢一点，你别催我。"],
    [["扶", "帮"], "那你扶着我胳膊，别拽我衣服。"]
  ]
};

const LOCAL_DEFAULTS = {
  fall: "我坐在这儿有点慌，你先别走开。",
  acute: "我还是不太舒服，你多看我一会儿。",
  dementia: "我不太想说话……你别逼我。",
  daily: "我还没准备好，你等我一下。"
};

function localChatReply(scenarioId, message) {
  const text = String(message || "").replace(/<[^>]*>/g, "").trim();
  for (const [keywords, reply] of LOCAL_RULES[scenarioId] || []) {
    if (keywords.some((keyword) => text.includes(keyword))) return reply;
  }
  return LOCAL_DEFAULTS[scenarioId] || "……你说什么？我没太听清。";
}

function showModeBadge() {
  const badge = document.createElement("div");
  badge.className = "mode-badge";
  badge.innerHTML = '<i></i> 离线模式 · 成绩保存在本机';
  document.body.appendChild(badge);
}

// 每个情景的答题状态，只存在内存里：刷新页面就重新开始
const progress = {};

// 和虚拟老人的对话上下文（只在当前页面有效，切换情景时清空）
const chatHistory = [];
let chatPending = false;

let currentScenario = "fall";
let currentView = "3d";
let currentCamera = "third";
let sceneReady = false;
let toastTimer;
let journeyIndex = 0;
let journeyTimer = null;

// 给 scene.js 读的初始状态（它在模块顶层只会读一次，所以必须同步赋值）
window.smartCareState = { scenario: currentScenario, view: currentView, camera: currentCamera };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

/* ------------------------------ 二、接口封装 ------------------------------ */

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body && body.detail) detail = body.detail;
    } catch (error) {
      /* 响应不是 JSON 时，保留默认提示 */
    }
    throw new Error(detail);
  }
  return response.json();
}

function postJSON(path, data) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
}

async function loadScenarios() {
  if (STANDALONE.value) {
    scenarios = offlineData()?.scenarios || {};
  } else {
    scenarios = await api("/api/scenarios");
  }
  Object.keys(scenarios).forEach((id) => {
    progress[id] = { index: 0, answers: [], results: [], score: 0, completed: false, recorded: false, pending: false };
  });
}

async function loadCourses() {
  courses = STANDALONE.value ? offlineData()?.courses || [] : await api("/api/courses");
}

async function loadProfile() {
  if (STANDALONE.value) {
    profile = computeLocalProfile();
  } else {
    profile = await api(`/api/profile?learner_id=${encodeURIComponent(learnerId)}`);
  }
  history = profile.history;
  renderAssessment();
}

/* ------------------------------- 三、通用 UI ------------------------------- */

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function showToast(message) {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

/* --------------------------- 四、视图 / 相机 / 情景 --------------------------- */

function setView(view) {
  currentView = view;
  window.smartCareState.view = view;
  $$("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#sceneContainer").hidden = view !== "3d";
  $("#mapView").hidden = view !== "2d";
  $("#cameraControls").hidden = view !== "3d";
  $(".move-pad").hidden = view !== "3d";
  $(".control-hints").innerHTML = view === "3d"
    ? '<span><kbd>WASD</kbd> 移动</span><span><kbd>拖动</kbd> 环顾</span><span><kbd>滚轮</kbd> 第三视角缩放</span><span><kbd>V</kbd> 切换视角</span>'
    : '<span><kbd>点击</kbd> 编号标记观察线索</span><span><kbd>选择</kbd> 右侧答案继续任务</span>';
  $("#crosshair").classList.toggle("is-visible", view === "3d" && currentCamera === "first");
  $("#viewBadge").innerHTML = view === "3d" ? '<svg><use href="#i-cube"/></svg> 3D LIVE' : '<svg><use href="#i-map"/></svg> 2D MAP';
  $("#cameraBadge").textContent = view === "3d"
    ? `${currentCamera === "third" ? "第三视角" : "第一视角"} · 按 V 切换`
    : "俯视情景 · 点击线索标记";
  $("#sceneLoading").classList.toggle("is-hidden", sceneReady || view === "2d");
  if (view === "2d") renderMap();
  emit("smartcare:view", view);
}

function setCamera(mode) {
  currentCamera = mode;
  window.smartCareState.camera = mode;
  $$("[data-camera]").forEach((button) => {
    const active = button.dataset.camera === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#cameraBadge").textContent = `${mode === "third" ? "第三视角" : "第一视角"} · 按 V 切换`;
  $("#crosshair").classList.toggle("is-visible", currentView === "3d" && mode === "first");
  emit("smartcare:camera", mode);
}

function setScenario(id) {
  if (!scenarios[id]) return;
  currentScenario = id;
  window.smartCareState.scenario = id;
  const scenario = scenarios[id];
  $$(".scenario-tab").forEach((button) => {
    const active = button.dataset.scenario === id;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#sceneCode").textContent = scenario.code;
  $("#sceneTitle").textContent = scenario.title;
  $("#elderLine").textContent = scenario.elderLine;
  $("#mentorTip").textContent = scenario.mentor;
  $("#stageObservation span").textContent = scenario.mapNote;
  resetChat();
  renderMission();
  renderMap();
  emit("smartcare:scenario", id);
}

function renderMap() {
  const scenario = scenarios[currentScenario];
  if (!scenario) return;
  const elder = scenario.elderPos;
  const caregiver = scenario.caregiverPos;
  const hotspots = scenario.hotspots.map((spot, index) => `<g class="map-hotspot" data-hotspot="${index}" tabindex="0" role="button" aria-label="观察${spot.label}"><circle cx="${spot.x}" cy="${spot.y}" r="17"/><text x="${spot.x}" y="${spot.y + 4}" text-anchor="middle">${index + 1}</text><text class="map-person-label" x="${spot.x + 24}" y="${spot.y + 4}">${spot.label}</text></g>`).join("");
  $("#mapView").innerHTML = `<svg viewBox="0 0 800 560" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${scenario.title}二维俯视情景图">
    <rect width="800" height="560" fill="#e6eee7"/><path d="M0 80H800M0 160H800M0 240H800M0 320H800M0 400H800M0 480H800" stroke="#dce6de"/>
    <rect class="map-room" x="100" y="65" width="600" height="425" rx="8"/>
    <path class="map-route" d="M${caregiver[0]} ${caregiver[1]} Q460 400 ${elder[0]} ${elder[1]}"/>
    <rect class="map-furniture" x="130" y="100" width="170" height="100" rx="12"/><rect x="145" y="112" width="140" height="25" rx="8" fill="#f7faf5"/><text class="map-label" x="215" y="180" text-anchor="middle">护理床</text>
    <rect class="map-furniture" x="525" y="100" width="140" height="65" rx="10"/><text class="map-label" x="595" y="140" text-anchor="middle">储物柜</text>
    <rect class="map-furniture" x="135" y="385" width="135" height="65" rx="16"/><text class="map-label" x="202" y="425" text-anchor="middle">休息沙发</text>
    <circle class="map-furniture" cx="410" cy="180" r="52"/><text class="map-label" x="410" y="184" text-anchor="middle">餐桌</text>
    <rect x="330" y="65" width="150" height="9" fill="#9ec7bb"/><text class="map-label" x="405" y="55" text-anchor="middle">自然采光窗</text>
    <path d="M690 300v85" stroke="#173b3a" stroke-width="5"/><text class="map-label" x="665" y="410">出口</text>
    <circle class="map-person" cx="${elder[0]}" cy="${elder[1]}" r="25" fill="${scenario.color}"/><circle cx="${elder[0]}" cy="${elder[1] - 6}" r="7" fill="#f4d4b8"/><path d="M${elder[0] - 11} ${elder[1] + 13}q11-19 22 0" fill="#fff" opacity=".8"/>
    <text class="map-person-label" x="${elder[0]}" y="${elder[1] + 45}" text-anchor="middle">陈奶奶</text>
    <circle class="map-person" cx="${caregiver[0]}" cy="${caregiver[1]}" r="25" fill="#176f63"/><path d="M${caregiver[0]} ${caregiver[1] - 14}l8 14-8 14-8-14Z" fill="#fff"/>
    <text class="map-person-label" x="${caregiver[0]}" y="${caregiver[1] + 45}" text-anchor="middle">你 · 护理员</text>
    ${hotspots}
    <g transform="translate(120 515)"><circle r="5" fill="#e98763"/><text class="map-label" x="14" y="4">编号标记可点击观察</text><path d="M200 0h30" class="map-route"/><text class="map-label" x="240" y="4">建议接近路线</text></g>
  </svg>`;
  $$(".map-hotspot").forEach((node) => {
    const activate = () => showObservation(Number(node.dataset.hotspot));
    node.addEventListener("click", activate);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });
}

function showObservation(index) {
  const scenario = scenarios[currentScenario];
  if (!scenario) return;
  const spot = scenario.hotspots[index];
  if (!spot) return;
  $("#stageObservation span").textContent = spot.observation;
  showToast(`现场线索 · ${spot.label}`);
}

/* ------------------------ 五点五、和虚拟老人对话 ------------------------ */

function resetChat() {
  chatHistory.length = 0;
  const echo = $("#chatEcho");
  const badge = $("#elderSource");
  const input = $("#chatInput");
  if (echo) echo.textContent = "";
  if (badge) {
    badge.textContent = "";
    badge.removeAttribute("data-source");
  }
  if (input) input.value = "";
}

function setChatBadge(source) {
  const badge = $("#elderSource");
  if (!badge) return;
  badge.dataset.source = source;
  badge.textContent = source === "ai" ? "AI" : source === "rule" ? "预设" : "离线";
}

async function sendChat(event) {
  event.preventDefault();
  if (chatPending) return;

  const input = $("#chatInput");
  const message = (input?.value || "").trim();
  if (!message) return;

  chatPending = true;
  const button = $("#chatForm button");
  if (button) button.disabled = true;
  if (input) input.value = "";
  $("#chatEcho").textContent = `你：${message}`;
  $("#elderLine").textContent = "……（陈奶奶正在听）";

  try {
    const result = STANDALONE.value
      ? { reply: localChatReply(currentScenario, message), source: "rule", model: null, fallback_reason: "离线模式" }
      : await postJSON("/api/chat", {
          scenario: currentScenario,
          message,
          history: chatHistory.slice(-8)
        });
    $("#elderLine").textContent = `“${result.reply}”`;
    setChatBadge(result.source);
    chatHistory.push({ role: "user", content: message }, { role: "assistant", content: result.reply });
    if (result.source === "rule" && result.fallback_reason) {
      console.info("[SmartCare] AI 降级为规则回复：", result.fallback_reason);
    }
  } catch (error) {
    $("#elderLine").textContent = "“……”";
    setChatBadge("offline");
    showToast(`对话失败：${error.message}`);
  } finally {
    chatPending = false;
    if (button) button.disabled = false;
    input?.focus();
  }
}

/* -------------------------------- 五、任务 -------------------------------- */

function renderMission() {
  const scenario = scenarios[currentScenario];
  const state = progress[currentScenario];
  if (!scenario || !state) return;

  const total = scenario.steps.length;
  $("#missionScore").textContent = `${state.score} / ${total}`;
  const completedSteps = state.completed ? total : state.index + (state.results[state.index] ? 1 : 0);
  $("#missionProgress").style.width = `${(completedSteps / total) * 100}%`;

  const content = $("#missionContent");

  if (state.completed) {
    const percent = Math.round((state.score / total) * 100);
    const message = percent >= 75
      ? "关键判断顺序较稳固，可以切换视角复盘空间位置，或进入下一情景。"
      : "建议先查看错题对应的行为证据，再重新开始本情景，巩固判断顺序。";
    content.innerHTML = `<div class="mission-complete"><div class="completion-ring">${percent}</div><p class="eyebrow">SCENARIO COMPLETE</p><h3>本次训练已完成</h3><p>${message}</p><div class="completion-actions"><button class="button button-coral" id="nextScenario" type="button">进入下一情景 <svg><use href="#i-arrow"/></svg></button><button class="button button-outline" id="reviewAssessment" type="button">查看能力复盘</button></div></div>`;
    $("#nextScenario").addEventListener("click", () => {
      const ids = Object.keys(scenarios);
      setScenario(ids[(ids.indexOf(currentScenario) + 1) % ids.length]);
    });
    $("#reviewAssessment").addEventListener("click", () => $("#assessment").scrollIntoView({ behavior: "smooth" }));
    return;
  }

  const step = scenario.steps[state.index];
  const result = state.results[state.index];
  const answered = Boolean(result);
  const letters = ["A", "B", "C"];
  const choices = step.choices.map((choice, index) => {
    let className = "choice-button";
    if (answered && index === result.answer) className += " is-correct";
    if (answered && index === state.answers[state.index] && !result.correct) className += " is-wrong";
    return `<button type="button" class="${className}" data-choice="${index}" data-letter="${letters[index]}" ${answered ? "disabled" : ""}>${choice}</button>`;
  }).join("");

  const feedback = answered
    ? `<div class="feedback-box ${result.correct ? "" : "is-review"}"><strong>${result.correct ? "判断合适 · 已记录行为证据" : "这一步需要复盘"}</strong><p>${result.feedback}</p></div><button class="button button-coral mission-next" id="missionNext" type="button">${state.index === total - 1 ? "完成并生成复盘" : "下一步"} <svg><use href="#i-arrow"/></svg></button>`
    : "";

  content.innerHTML = `<div class="mission-step-label"><span>STEP ${String(state.index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</span><span>${scenario.short}</span></div><h3>${step.title}</h3><p class="mission-context">${step.context}</p><div class="choice-list">${choices}</div>${feedback}`;
  $$("[data-choice]").forEach((button) => button.addEventListener("click", () => selectChoice(Number(button.dataset.choice))));
  if (answered) $("#missionNext").addEventListener("click", nextStep);
}

async function selectChoice(choice) {
  const state = progress[currentScenario];
  if (!state || state.pending || state.results[state.index]) return;

  const stepIndex = state.index;
  state.pending = true;
  $$("[data-choice]").forEach((button) => { button.disabled = true; });

  try {
    // 判题：在线交给后端；离线在本地比对（答案随数据一起打包）
    const result = STANDALONE.value
      ? checkLocally(stepIndex, choice)
      : await postJSON(`/api/scenarios/${currentScenario}/check`, { step: stepIndex, choice });
    state.answers[stepIndex] = choice;
    state.results[stepIndex] = result;
    state.score = state.results.filter((item) => item && item.correct).length;
    renderMission();
  } catch (error) {
    showToast(`判题失败：${error.message}`);
    renderMission();
  } finally {
    state.pending = false;
  }
}

function nextStep() {
  const state = progress[currentScenario];
  if (!state || !state.results[state.index]) return;
  if (state.index < scenarios[currentScenario].steps.length - 1) {
    state.index += 1;
  } else {
    state.completed = true;
    recordCompletion();
  }
  renderMission();
}

async function recordCompletion() {
  const state = progress[currentScenario];
  if (!state || state.recorded) return;
  state.recorded = true;

  try {
    if (STANDALONE.value) {
      const scenario = scenarios[currentScenario];
      writeLocalAttempt({
        id: Date.now(),
        learner_id: learnerId,
        scenario: currentScenario,
        title: scenario.title,
        score: Math.round((state.score / scenario.steps.length) * 100),
        correct: state.score,
        total: scenario.steps.length,
        created_at: new Date().toISOString()
      });
      await loadProfile();
      showToast("成绩已保存到本机");
      return;
    }

    // 只提交选项，分数由后端计算
    await postJSON("/api/attempts", {
      learner_id: learnerId,
      scenario: currentScenario,
      answers: state.answers
    });
    await loadProfile();
    showToast("成绩已保存到服务器");
  } catch (error) {
    state.recorded = false; // 保存失败时允许重试
    showToast(`成绩保存失败：${error.message}`);
  }
}

function restartScenario() {
  const state = progress[currentScenario];
  if (!state) return;
  progress[currentScenario] = { index: 0, answers: [], results: [], score: 0, completed: false, recorded: false, pending: false };
  renderMission();
  showToast("本情景已重置，历史复盘记录仍保留");
}

/* -------------------------------- 六、课程 -------------------------------- */

function renderCourses() {
  $("#courseGrid").innerHTML = courses.map((course, index) => `<article class="course-card" data-category="${course.category}"><div class="course-card-top"><span class="course-number">COURSE ${String(index + 1).padStart(2, "0")}</span><span class="course-category">${course.categoryName}</span></div><h3>${course.title}</h3><span class="course-en">${course.en}</span><p>${course.description}</p><div class="course-meta"><span>${course.hours}</span><span>${course.mode}</span></div><div class="course-outcome">${course.outcome}</div><button class="course-open" type="button" data-course="${course.id}">查看学习目标与评价 <svg><use href="#i-arrow"/></svg></button></article>`).join("");
  $$("[data-course]").forEach((button) => button.addEventListener("click", () => openCourse(button.dataset.course)));
}

function openCourse(id) {
  const course = courses.find((item) => item.id === id);
  if (!course) return;
  $("#dialogContent").innerHTML = `<span class="dialog-tag">${course.categoryName} · ${course.hours}</span><h2>${course.title}</h2><span class="course-en">${course.en}</span><p class="dialog-description">${course.description}</p><h4>完成课程后，你能够：</h4><ul>${course.objectives.map((item) => `<li>${item}</li>`).join("")}</ul><h4>评价证据</h4><p class="dialog-description">${course.assessment}</p><a class="button button-coral" href="#training" id="dialogTraining">进入相关情景训练 <svg><use href="#i-arrow"/></svg></a>`;
  $("#dialogTraining").addEventListener("click", () => $("#courseDialog").close());
  $("#courseDialog").showModal();
}

/* ------------------------------ 七、学习闭环 ------------------------------ */

function renderJourney() {
  $("#journeySteps").innerHTML = journeyData.map((item, index) => `<button class="journey-step ${index === journeyIndex ? "is-active" : ""} ${index < journeyIndex ? "is-past" : ""}" type="button" data-journey="${index}" aria-pressed="${index === journeyIndex}"><span>${String(index + 1).padStart(2, "0")}</span><b>${item.title}</b></button>`).join("");
  $$("[data-journey]").forEach((button) => button.addEventListener("click", () => { stopJourney(); journeyIndex = Number(button.dataset.journey); renderJourney(); }));
  const item = journeyData[journeyIndex];
  $("#journeyLabel").textContent = `STEP ${String(journeyIndex + 1).padStart(2, "0")} / 06`;
  $("#journeyTitle").textContent = item.title;
  $("#journeyDescription").textContent = item.description;
  $("#journeyMetric").textContent = item.metric;
  $("#journeyValue").textContent = item.value;
  $("#journeyEvidence").textContent = item.evidence;
  $("#journeyProgress").style.width = `${((journeyIndex + 1) / journeyData.length) * 100}%`;
}

function stopJourney() {
  clearInterval(journeyTimer);
  journeyTimer = null;
  $("#journeyPlay").disabled = false;
  $("#journeyPause").disabled = true;
}

function playJourney() {
  if (journeyTimer) return;
  $("#journeyPlay").disabled = true;
  $("#journeyPause").disabled = false;
  journeyTimer = setInterval(() => {
    if (journeyIndex >= journeyData.length - 1) { stopJourney(); return; }
    journeyIndex += 1;
    renderJourney();
  }, 3500);
}

/* ------------------------------- 八、评估 ------------------------------- */

function renderRadar(values) {
  const labels = ["护理知识", "应急处理", "沟通关怀", "数字技能", "学习进度", "职业伦理"];
  const cx = 210, cy = 156, radius = 98;
  const point = (index, scale = 1) => {
    const angle = ((-90 + index * 60) * Math.PI) / 180;
    return [cx + Math.cos(angle) * radius * scale, cy + Math.sin(angle) * radius * scale];
  };
  let markup = "";
  [0.25, 0.5, 0.75, 1].forEach((scale) => {
    const points = labels.map((_, index) => point(index, scale).join(",")).join(" ");
    markup += `<polygon class="radar-grid" points="${points}"/>`;
  });
  labels.forEach((label, index) => {
    const axisEnd = point(index, 1);
    const labelPoint = point(index, 1.32);
    const valuePoint = point(index, 1.17);
    markup += `<line class="radar-axis" x1="${cx}" y1="${cy}" x2="${axisEnd[0]}" y2="${axisEnd[1]}"/><text class="radar-label" x="${labelPoint[0]}" y="${labelPoint[1]}" text-anchor="middle">${label}</text><text class="radar-value" x="${valuePoint[0]}" y="${valuePoint[1]}" text-anchor="middle">${values[index]}</text>`;
  });
  const valuePoints = values.map((value, index) => point(index, value / 100));
  markup += `<polygon class="radar-shape" points="${valuePoints.map((p) => p.join(",")).join(" ")}"/>`;
  valuePoints.forEach((p) => { markup += `<circle class="radar-dot" cx="${p[0]}" cy="${p[1]}" r="4"/>`; });
  $("#abilityRadar").innerHTML = markup;
}

function renderAssessment() {
  if (!profile) return;

  renderRadar(profile.values);
  $("#completedScenarioCount").innerHTML = `${profile.completed}<small>/${profile.total_scenarios}</small>`;

  const recommendation = profile.recommendation;
  if (recommendation) {
    $("#recommendationTitle").textContent = recommendation.title;
    $("#recommendationText").textContent = recommendation.text;
  }

  const container = $("#trainingHistory");
  if (!history.length) {
    container.innerHTML = '<div class="history-empty">尚未完成情景训练。进入上方训练台完成四个判断步骤后，这里会显示成绩、时间与下一步建议。</div>';
    return;
  }

  container.innerHTML = history.slice(0, 8).map((record) => {
    const date = new Date(record.created_at);
    const dateText = Number.isNaN(date.getTime())
      ? "本地记录"
      : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const advice = record.score >= 75 ? "可进入下一情景，并切换视角复盘" : "建议重做本情景，重点阅读错误反馈";
    return `<div class="history-row"><strong>${record.title}</strong><span class="history-score">${record.score} 分</span><span class="history-advice">${advice}</span><time>${dateText}</time></div>`;
  }).join("");
}

function downloadReport() {
  const lines = [
    "SmartCare VR · 情景训练复盘",
    "================================",
    `导出时间：${new Date().toLocaleString("zh-CN")}`,
    `学员编号：${learnerId}`,
    ""
  ];
  if (!history.length) lines.push("尚未完成情景训练。请先进入训练台完成至少一个情景。", "");
  history.forEach((record, index) => {
    const time = new Date(record.created_at).toLocaleString("zh-CN");
    lines.push(
      `${index + 1}. ${record.title}｜${record.score} 分｜答对 ${record.correct}/${record.total}`,
      `   时间：${time}`,
      `   建议：${record.score >= 75 ? "进入下一情景，并用双视角复盘。" : "重新练习本情景，重点阅读错误步骤反馈。"}`,
      ""
    );
  });
  lines.push(
    "说明：本文件来自课程交互原型，仅记录当前学员的演示训练，不代表真实护理资格或临床能力。",
    "AI 与 VR 仅作教学辅助，不替代专业护理判断与真实导师监督实践。"
  );

  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "SmartCare-训练复盘.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("复盘摘要已导出");
}

/* ------------------------------ 九、事件绑定 ------------------------------ */

function bindEvents() {
  $$(".scenario-tab").forEach((button) => button.addEventListener("click", () => setScenario(button.dataset.scenario)));
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$("[data-camera]").forEach((button) => button.addEventListener("click", () => setCamera(button.dataset.camera)));
  $$("[data-set-view]").forEach((link) => link.addEventListener("click", () => setView(link.dataset.setView)));

  $("#observeButton").addEventListener("click", () => (currentView === "3d" ? emit("smartcare:observe") : showObservation(0)));
  $("#resetCamera").addEventListener("click", () => (currentView === "3d" ? emit("smartcare:reset-camera") : showToast("2D 已显示完整俯视情景")));
  $("#restartScenario").addEventListener("click", restartScenario);
  $("#fallback2d").addEventListener("click", () => setView("2d"));

  $("#journeyPlay").addEventListener("click", playJourney);
  $("#journeyPause").addEventListener("click", stopJourney);
  $("#journeyReplay").addEventListener("click", () => { stopJourney(); journeyIndex = 0; renderJourney(); playJourney(); });

  $$("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    $$("[data-filter]").forEach((item) => item.classList.toggle("is-active", item === button));
    $$(".course-card").forEach((card) => card.classList.toggle("is-hidden", button.dataset.filter !== "all" && card.dataset.category !== button.dataset.filter));
  }));

  $("#dialogClose").addEventListener("click", () => $("#courseDialog").close());
  $("#courseDialog").addEventListener("click", (event) => { if (event.target === $("#courseDialog")) $("#courseDialog").close(); });

  $("#downloadReport").addEventListener("click", downloadReport);
  $("#chatForm").addEventListener("submit", sendChat);

  $("#menuToggle").addEventListener("click", () => {
    const open = !$("#mobileNav").classList.contains("is-open");
    $("#mobileNav").classList.toggle("is-open", open);
    $("#menuToggle").setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("menu-open", open);
  });
  $$("#mobileNav a").forEach((link) => link.addEventListener("click", () => {
    $("#mobileNav").classList.remove("is-open");
    $("#menuToggle").setAttribute("aria-expanded", "false");
    document.body.classList.remove("menu-open");
  }));

  $$("[data-move]").forEach((button) => {
    const start = (event) => { event.preventDefault(); emit("smartcare:move", { direction: button.dataset.move, active: true }); };
    const end = () => emit("smartcare:move", { direction: button.dataset.move, active: false });
    button.addEventListener("pointerdown", start);
    button.addEventListener("pointerup", end);
    button.addEventListener("pointercancel", end);
    button.addEventListener("pointerleave", end);
  });

  // 3D 场景把线索点结果广播出来，这里负责显示到面板
  window.addEventListener("smartcare:hotspot", (event) => {
    $("#stageObservation span").textContent = event.detail.observation;
    showToast(`现场线索 · ${event.detail.label}`);
  });
  window.addEventListener("smartcare:camera-changed", (event) => setCamera(event.detail));
  window.addEventListener("smartcare:scene-ready", (event) => {
    sceneReady = event.detail.ready;
    $("#sceneLoading").classList.toggle("is-hidden", sceneReady || currentView === "2d");
    if (!sceneReady && currentView === "3d") $("#sceneFallback").hidden = false;
  });

  window.addEventListener("scroll", () => $("#siteHeader").classList.toggle("is-scrolled", window.scrollY > 30), { passive: true });
}

function setupReveal() {
  if (!("IntersectionObserver" in window)) {
    $$(".reveal").forEach((item) => item.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }), { threshold: 0.08 });
  $$(".reveal").forEach((item) => observer.observe(item));

  const sections = $$("main section[id]");
  const navObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) {
      $$(".desktop-nav a").forEach((link) => link.classList.toggle("is-active", link.getAttribute("href") === `#${entry.target.id}`));
    }
  }), { rootMargin: "-25% 0px -65% 0px" });
  sections.forEach((section) => navObserver.observe(section));
}

/* -------------------------------- 十、启动 -------------------------------- */

function showBootError(error) {
  $("#sceneLoading").classList.add("is-hidden");
  $("#missionContent").innerHTML = `<div class="history-empty">无法连接后端接口：${error.message}<br>请确认服务已启动，并访问 http://127.0.0.1:8000</div>`;
  showToast("后端未连接，训练数据无法加载");
}

async function bootstrap() {
  bindEvents();
  renderJourney();
  setupReveal();

  STANDALONE.value = await detectMode();
  if (STANDALONE.value && !offlineData()) {
    showBootError(new Error("离线数据缺失，请使用离线版页面"));
    return;
  }
  if (STANDALONE.value) showModeBadge();

  try {
    await Promise.all([loadScenarios(), loadCourses()]);
    renderCourses();
    setScenario("fall");
    setCamera("third");
    setView("3d");
    await loadProfile();
  } catch (error) {
    console.error("[SmartCare] 初始化失败：", error);
    showBootError(error);
  }
}

bootstrap();
