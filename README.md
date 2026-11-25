# SmartCare VR｜2D + 3D 智慧康养情景训练（FastAPI 版）

在原来的静态网站基础上加了一层 Python 后端：**题库、判题、成绩、能力画像全部走接口**，
前端仍然是原生 HTML + CSS + JavaScript（无构建、无框架），3D 部分继续由 Three.js 驱动。

```
浏览器（HTML/CSS/JS + Three.js）
        ↕  HTTP / JSON
FastAPI（题库 · 判题 · 成绩 · 画像 · 静态托管）
        ↕  SQL
SQLite（backend/smartcare.db）
```

---

## 一、快速开始

### 1. 建虚拟环境并装依赖（只需一次）

在 PyCharm 的终端里，**确保当前目录是项目根目录**：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

> PowerShell 提示“禁止运行脚本”时，先执行一次：
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

### 2. 启动

```powershell
uvicorn backend.main:app --reload
```

或者直接在 PyCharm 里运行根目录的 `main.py`（效果相同）。

### 3. 打开

| 地址 | 内容 |
|---|---|
| http://127.0.0.1:8000 | 网站 |
| http://127.0.0.1:8000/docs | 自动生成的接口文档（可点 “Try it out” 直接调） |

**不要双击 `index.html`** —— 那样打开的是 `file://`，接口会全部失败。

---

## 二、目录结构

```
SmartCare-VR-GitHubPages/
├── backend/
│   ├── __init__.py        包标记
│   ├── main.py            路由、请求校验、静态托管
│   ├── data.py            4 个情景 + 5 门课程 + 评估配置
│   ├── db.py              SQLite 建表与读写
│   ├── ai.py              大模型对话（无 Key 时自动降级）
│   └── smartcare.db       首次启动自动生成
├── frontend/
│   ├── index.html         页面骨架（未改动）
│   ├── styles.css         样式（未改动）
│   ├── app.js             取数、渲染、提交成绩（本次重写）
│   ├── scene.js           Three.js 3D 场景（未改动）
│   ├── assets/            图片与图标
│   └── vendor/            本地 Three.js r160
├── main.py                本地启动入口
├── requirements.txt
├── .env.example           AI 配置模板（复制成 .env）
├── render.yaml            Render 一键部署描述
├── Procfile               Railway / Heroku 入口
├── docs/
│   └── 代码导读.md         30 分钟看懂全部代码（含练习）
├── .gitignore
└── README.md
```

---

## 三、接口清单

| 方法 | 路径 | 作用 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 健康检查 | 返回情景数与课程数 |
| GET | `/api/scenarios` | 全部情景 | **不含 `correct` 与 `feedback`**，前端看不到答案 |
| GET | `/api/courses` | 课程目录 | 支持前端筛选 |
| POST | `/api/scenarios/{id}/check` | 单步判题 | 入参 `{step, choice}`，返回对错、正确项、解释 |
| POST | `/api/attempts` | 提交整轮成绩 | 只提交选项，**分数由服务端计算**后入库 |
| GET | `/api/profile?learner_id=` | 能力画像 | 六维数值、完成数、推荐语、历史记录 |
| POST | `/api/chat` | 和虚拟老人对话 | 入参 `{scenario, message, history}`；无 Key 时返回预设回复 |

示例：

```bash
curl -X POST http://127.0.0.1:8000/api/scenarios/fall/check \
  -H "Content-Type: application/json" \
  -d '{"step":0,"choice":1}'
```

```json
{"step":0,"choice":1,"correct":true,"answer":1,"feedback":"立即扶起可能加重损伤。..."}
```

数据库表只有一张：

```sql
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id TEXT, scenario TEXT,
  score INTEGER, correct INTEGER, total INTEGER,
  created_at TEXT
);
```

---

## 四、学员身份怎么处理

没有做注册登录。前端第一次访问时生成一个随机 `learner_id` 存进 `localStorage`，
之后每次请求带上它，后端据此区分不同学员的成绩。

- 换浏览器 / 无痕窗口 → 不同的 `learner_id` → 看不到之前的记录（这是预期的）
- 想验证“成绩真的在服务器”，用 `/docs` 里的 `GET /api/profile?learner_id=...` 查任意 ID

如果要多人共用一个身份（比如答辩演示“换设备成绩还在”），把前端 `learnerId`
写死成一个固定字符串即可，例如 `"demo-learner"`。

---

## 五、前端改了哪几处

原来的 `app.js` 里数据是写死的，现在改成等接口返回：

| 原来 | 现在 |
|---|---|
| `const scenarios = {...}` | `await api("/api/scenarios")` |
| `const courses = [...]` | `await api("/api/courses")` |
| `localStorage` 存成绩 | `POST /api/attempts` + `GET /api/profile` |
| 点击选项直接判对错 | `POST /api/scenarios/{id}/check` 让后端判 |

其余函数（渲染地图、切换视角、学习闭环、雷达图）逻辑没变，只是数据来源换了。
`index.html`、`styles.css`、`scene.js` **一行未改**。

---

## 六、答辩演示脚本（约 5 分钟）

```
0:00  终端：uvicorn backend.main:app --reload
0:15  打开 http://127.0.0.1:8000
0:30  进入训练台，选一个情景
1:00  点 3D 里的线索 / 切第一视角走两步
1:40  答 4 道题，故意答错一题看即时解释
2:10  在左下角对话框和奶奶说一句话，看气泡右上角「AI / 预设」标记
2:40  完成后右侧出现评分
3:10  滚到能力评估，看雷达图和历史记录
3:40  打开 /docs，展示 GET /api/profile 与 POST /api/chat
4:10  打开 backend/smartcare.db 展示数据表
4:40  点“下载复盘摘要”导出 txt
```

---

## 七、常见问题

**Q：`uvicorn` 不是内部或外部命令？**
虚拟环境没激活，或没装依赖。确认提示符前有 `(.venv)`，再 `pip install -r requirements.txt`。

**Q：页面一直显示“正在布置护理情景…”？**
3D 引擎加载失败，会自动降级提示切 2D；若整页空白，按 F12 看 Console 第一条红字。

**Q：接口 404 / 页面能开但没数据？**
多半是没通过 `http://127.0.0.1:8000` 访问，而是直接双击了 html 文件。

**Q：`Directory 'frontend' does not exist`？**
启动时的工作目录不对。必须在项目根目录执行，不能进到 `backend/` 里执行。

**Q：换电脑数据没了？**
数据库是 `backend/smartcare.db` 这一个文件，拷走它即可。

**Q：和奶奶说话，回复总是预设的那几句？**
说明现在走的是降级回复。看 `/api/chat` 返回里的 `fallback_reason`：
`未配置 AI_API_KEY` 表示没读到 Key；`URLError` 表示网络或地址不对。
检查 `.env` 是否在**项目根目录**、Key 是否过期，改完必须**重启服务**。

---

## 八、AI 对话（可选，默认不开也能用）

舞台左下角「陈奶奶」的框里可以直接打字和老人说话。**不配置任何 Key 也能用**，
此时走的是角色预设回复，气泡右上角会显示「预设」；配置 Key 后显示「AI」。

### 开启方式（三步）

1. 复制 `.env.example` 为 `.env`
2. 填入你的 Key：`AI_API_KEY=sk-xxxx`
3. 重启服务

也支持直接用环境变量（优先级高于 `.env`）：

```powershell
$env:AI_API_KEY  = "sk-xxxx"
$env:AI_BASE_URL = "https://api.deepseek.com/v1"
$env:AI_MODEL    = "deepseek-chat"
uvicorn backend.main:app --reload
```

任何 **OpenAI 兼容**服务都能接：DeepSeek、OpenAI、通义千问、智谱、Kimi 等，
只改 `AI_BASE_URL` 和 `AI_MODEL` 两个值。

### 三条安全设计（答辩可以直接讲）

1. **Key 只在服务端**：前端只发消息，永远拿不到 Key，也不会写进代码或数据库。
2. **永不 500**：没配 Key、超时、返回格式异常，全部降级为角色预设回复，演示不会因网络翻车。
3. **提示词有约束**：老人不提医疗建议、不评价学员、不透露答案，输入会去标签并截断到 200 字。

### 怎么验证生效

打开 `http://127.0.0.1:8000/docs` → `POST /api/chat` → Try it out：

```json
{"scenario": "fall", "message": "奶奶你哪里疼？", "history": []}
```

返回里的 `source` 字段：`ai` 表示走了大模型，`rule` 表示用了预设回复；
`fallback_reason` 会告诉你降级原因（例如“未配置 AI_API_KEY”）。

---

## 九、部署到 Render（免费，公网可访问）

> 提醒：GitHub Pages 只能托管静态文件，**跑不了 Python**，所以必须换平台。

1. 把项目推到 GitHub 仓库
2. 打开 [render.com](https://render.com) → New → **Web Service** → 选你的仓库
3. Render 会自动读取 `render.yaml`（构建、启动命令、健康检查都已写好）
4. 在 Environment 里填 `AI_API_KEY`（**可以不填**，不填就用预设回复）
5. 点 Deploy，等 2—3 分钟，拿到 `https://xxx.onrender.com`

其他平台：

| 平台 | 说明 |
|---|---|
| Railway | 直接识别 `Procfile` |
| 阿里云 / 腾讯云轻量 | 装 Python，`uvicorn` 起服务，Nginx 反代 80/443 |
| 校园内网服务器 | 同上，注意开放端口与 HTTPS |

**两个真实的坑：**

- 免费实例 **15 分钟无访问会休眠**，老师点开要等 30—60 秒冷启动 → **演示以本地为主，公网链接当备份**。
- 免费实例的文件系统是临时的，**重启后 SQLite 数据会丢**。演示前重新跑一遍情景即可；
  真要持久化得挂载磁盘或换 PostgreSQL。

---

## 十、离线单文件版（双击即可打开）

`SmartCare-VR-离线版.html` 是打包好的单文件网页：**样式、题库、3D 引擎、图片全部内嵌**，
不需要 Python、不需要联网，双击就能用，也可以直接发给别人。

### 能做什么

- 四个情景的完整训练、判题与即时解释
- 3D 房间、第一 / 第三视角、WASD 移动、线索点
- 虚拟老人对话（使用预设回复）
- 课程体系、能力雷达、训练历史、导出复盘摘要
- 成绩保存在浏览器本地，关掉再开还在

### 不能做什么

| 缺失 | 原因 |
|---|---|
| 真实大模型对话 | 需要后端持有 API Key，离线版只有预设回复 |
| 成绩跨设备同步 | 数据在 `localStorage` 里，换浏览器就没了 |
| `/docs` 接口文档 | 没有后端进程 |

### 原理

前端启动时先探一次 `/api/health`：

- 通了 → 走接口（服务端判题、写数据库）
- 不通或 `file://` → 切离线模式，用内置数据判题、成绩存本地

这就是为什么同一份 `app.js` 既能跑在服务器上，也能打进单文件。

### 重新生成

改完前端或题库后，在项目根目录执行：

```powershell
.\.venv\Scripts\python.exe build_offline.py . SmartCare-VR-离线版.html
```

> 注意：`file://` 下部分浏览器（如 Safari）会限制 `localStorage`，Chrome / Edge 正常。
> 如果 3D 不显示，说明当前设备的 WebGL 被禁用，页面会提示切换到 2D。

---

## 十一、教学边界

- 本项目是课程交互原型，默认不连接任何外部 AI 服务、不连接真实 VR 硬件。
- 仅当你自行配置 `AI_API_KEY` 时，才会把学员输入的对话内容发送给你所配置的模型服务；
  未配置时使用本地预设回复，数据不出服务器。
- 情景与评分用于教学演示，不替代现实急救规范、机构流程或专业护理判断。
- 成绩只保存当前学员的演示数据，不含任何真实个人健康信息。
- Three.js 使用 MIT 许可证，许可证原文在 `frontend/vendor/THREE-LICENSE.txt`。
- 原网站素材（照片、头像）沿用初代课程项目，公开商用需另行确认授权。
