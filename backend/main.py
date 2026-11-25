"""SmartCare VR 后端。

四组接口 + 静态托管：
  GET  /api/health                   健康检查
  GET  /api/scenarios                情景题库（不含答案）
  GET  /api/courses                  课程目录
  POST /api/scenarios/{id}/check     单步判题（答案只在后端）
  POST /api/attempts                 提交一次完整训练，服务端算分并入库
  GET  /api/profile?learner_id=...   能力画像 + 历史记录
"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ai, db
from .data import (
    BASE_VALUES,
    COURSES,
    DIMENSION_LABELS,
    SCENARIO_DIMENSIONS,
    SCENARIOS,
    public_scenario,
)

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()  # 启动时建表，幂等
    yield


app = FastAPI(
    title="SmartCare VR API",
    version="1.0.0",
    description="智慧康养情景训练原型后端：题库、即时判题、训练成绩与能力画像。",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# 请求体模型：Pydantic 会校验类型和范围，传错直接返回 422，不用手写 if
# ---------------------------------------------------------------------------


class CheckPayload(BaseModel):
    step: int = Field(..., ge=0, description="第几题，从 0 开始")
    choice: int = Field(..., ge=0, description="学员选择的选项下标")


class AttemptPayload(BaseModel):
    learner_id: str = Field(..., min_length=1, max_length=64)
    scenario: str = Field(..., min_length=1, max_length=32)
    answers: list[int] = Field(..., min_length=1, description="按题目顺序提交的选项下标")


class ChatTurn(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str = Field(..., max_length=400)


class ChatPayload(BaseModel):
    scenario: str = Field(..., min_length=1, max_length=32)
    message: str = Field(..., min_length=1, max_length=200)
    history: list[ChatTurn] = Field(default_factory=list, max_length=12)


# ---------------------------------------------------------------------------
# 题库与课程
# ---------------------------------------------------------------------------


@app.get("/api/health", summary="健康检查")
def health() -> dict:
    return {"status": "ok", "scenarios": len(SCENARIOS), "courses": len(COURSES)}


@app.get("/api/scenarios", summary="全部情景（不含正确答案）")
def list_scenarios() -> dict:
    return {sid: public_scenario(item) for sid, item in SCENARIOS.items()}


@app.get("/api/courses", summary="课程目录")
def list_courses() -> list:
    return COURSES


# ---------------------------------------------------------------------------
# 判题
# ---------------------------------------------------------------------------


@app.post("/api/scenarios/{scenario_id}/check", summary="单步判题")
def check_answer(scenario_id: str, payload: CheckPayload) -> dict:
    scenario = SCENARIOS.get(scenario_id)
    if scenario is None:
        raise HTTPException(status_code=404, detail="情景不存在")

    steps = scenario["steps"]
    if payload.step >= len(steps):
        raise HTTPException(status_code=400, detail="题号超出范围")

    step = steps[payload.step]
    if payload.choice >= len(step["choices"]):
        raise HTTPException(status_code=400, detail="选项超出范围")

    return {
        "step": payload.step,
        "choice": payload.choice,
        "correct": payload.choice == step["correct"],
        "answer": step["correct"],
        "feedback": step["feedback"],
    }


# ---------------------------------------------------------------------------
# 生成式 AI 对话（可选能力，不配置 Key 时自动降级为规则回复）
# ---------------------------------------------------------------------------


@app.post("/api/chat", summary="和虚拟老人对话")
def chat(payload: ChatPayload) -> dict:
    scenario = SCENARIOS.get(payload.scenario)
    if scenario is None:
        raise HTTPException(status_code=404, detail="情景不存在")

    result = ai.chat(scenario, payload.message, [turn.model_dump() for turn in payload.history])
    return {
        "scenario": payload.scenario,
        "message": payload.message,
        "reply": result["reply"],
        "source": result["source"],
        "model": result["model"],
        "fallback_reason": result["fallback_reason"],
    }


# ---------------------------------------------------------------------------
# 成绩
# ---------------------------------------------------------------------------


def _decorate(row: dict) -> dict:
    """给数据库记录补上情景标题，前端拿去直接显示。"""
    title = SCENARIOS.get(row["scenario"], {}).get("title", row["scenario"])
    return {**row, "title": title}


@app.post("/api/attempts", status_code=201, summary="提交一次完整训练")
def create_attempt(payload: AttemptPayload) -> dict:
    scenario = SCENARIOS.get(payload.scenario)
    if scenario is None:
        raise HTTPException(status_code=404, detail="情景不存在")

    steps = scenario["steps"]
    if len(payload.answers) != len(steps):
        raise HTTPException(
            status_code=400,
            detail=f"需要 {len(steps)} 个答案，收到 {len(payload.answers)} 个",
        )

    # 分数由服务端计算，前端改不了
    correct = sum(1 for index, choice in enumerate(payload.answers) if choice == steps[index]["correct"])
    total = len(steps)
    score = round(correct / total * 100)

    record = db.insert_attempt(payload.learner_id, payload.scenario, score, correct, total)
    return _decorate(record)


# ---------------------------------------------------------------------------
# 能力画像
# ---------------------------------------------------------------------------


def _recommendation(latest: dict | None) -> dict:
    if latest is None:
        return {
            "title": "先完成一次跌倒情景训练",
            "text": "建立“观察—评估—呼救—记录”的行为基线，再决定下一步。",
        }
    if latest["score"] >= 75:
        return {
            "title": f"保持{latest['title']}判断，尝试下一情景",
            "text": f"本次得分 {latest['score']}。建议切换第一与第三视角检查行动顺序，再把能力迁移到其他情景。",
        }
    return {
        "title": f"复盘{latest['title']}的关键步骤",
        "text": f"本次得分 {latest['score']}。推荐依据是答错的具体步骤，而不是笼统的“能力不足”；重新练习后再比较成绩。",
    }


@app.get("/api/profile", summary="能力画像与训练记录")
def get_profile(learner_id: str = Query(..., min_length=1, max_length=64)) -> dict:
    rows = [_decorate(row) for row in db.list_attempts(learner_id, limit=30)]

    best: dict[str, int] = {}
    for row in rows:
        best[row["scenario"]] = max(best.get(row["scenario"], 0), row["score"])

    values = list(BASE_VALUES)
    for scenario_id, score in best.items():
        for index in SCENARIO_DIMENSIONS.get(scenario_id, []):
            values[index] = round((values[index] + score) / 2)

    latest = rows[0] if rows else None

    return {
        "learner_id": learner_id,
        "completed": len(best),
        "total_scenarios": len(SCENARIOS),
        "best": best,
        "values": values,
        "dimensions": [
            {"label": label, "value": value}
            for label, value in zip(DIMENSION_LABELS, values)
        ],
        "recommendation": _recommendation(latest),
        "history": rows,
    }


# ---------------------------------------------------------------------------
# 静态托管：必须放在所有 /api 路由之后
# 这样前后端同源，https:// 页面和接口在同一个地址，不需要处理 CORS
# ---------------------------------------------------------------------------

if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
