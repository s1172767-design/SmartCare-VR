"""把 FastAPI 版前端打包成一个自包含的离线 HTML。

用法：
    python build_offline.py <项目目录> <输出 html>

做法：
   1. 从 backend/data.py 导出题库与课程（唯一数据源，避免两份不一致）
   2. 把 ESM 版 Three.js 的 export 块改成 window.THREE 赋值，变成普通脚本
   3. 去掉 scene.js 的 import，整体包进 IIFE
   4. 把 CSS、JS、图片全部内联进一个 .html
"""

import base64
import json
import re
import sys
from pathlib import Path

MIME = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}


def data_uri(path: Path) -> str:
    mime = MIME.get(path.suffix.lower(), "application/octet-stream")
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def convert_three(source: str) -> str:
    """ESM → 普通脚本：把结尾的 export{a as B,...} 改成 window.THREE={B:a,...}"""
    if "import.meta" in source:
        raise SystemExit("three.js 使用了 import.meta，无法直接转换")

    index = source.rfind("export{")
    if index == -1:
        raise SystemExit("没有找到 three.js 的 export 块")

    body = source[:index].rstrip()
    export_block = source[index + len("export{"):]
    end = export_block.rfind("}")
    if end == -1:
        raise SystemExit("export 块格式异常")

    pairs = []
    for item in export_block[:end].split(","):
        item = item.strip()
        if not item:
            continue
        if " as " in item:
            local, exported = item.split(" as ")
            pairs.append((exported.strip(), local.strip()))
        else:
            pairs.append((item, item))

    mapping = ",".join(f"{exported}:{local}" for exported, local in pairs)
    return f"(function(){{\n{body}\nwindow.THREE={{{mapping}}};\n}})();"


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 1

    project = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    frontend = project / "frontend"

    sys.path.insert(0, str(project))
    from backend import data as backend_data  # noqa: E402

    payload = {
        "scenarios": backend_data.SCENARIOS,
        "courses": backend_data.COURSES,
        "dimensions": {
            "baseValues": backend_data.BASE_VALUES,
            "scenarioDimensions": backend_data.SCENARIO_DIMENSIONS,
            "labels": backend_data.DIMENSION_LABELS,
        },
        "meta": {"mode": "offline", "generated": "build_offline.py"},
    }
    data_js = "window.SMART_CARE_DATA = " + json.dumps(payload, ensure_ascii=False) + ";"

    three_js = convert_three((frontend / "vendor" / "three.module.min.js").read_text(encoding="utf-8"))

    scene_src = (frontend / "scene.js").read_text(encoding="utf-8")
    scene_src = re.sub(r'^\s*import\s+\*\s+as\s+THREE\s+from\s+"[^"]+";\s*', "", scene_src, count=1)
    scene_js = "(function(){\n" + scene_src.strip() + "\n})();"

    app_js = "(function(){\n" + (frontend / "app.js").read_text(encoding="utf-8").strip() + "\n})();"

    css = (frontend / "styles.css").read_text(encoding="utf-8")
    html = (frontend / "index.html").read_text(encoding="utf-8")

    # 内联样式与图片
    html = html.replace('<link rel="stylesheet" href="./styles.css">', "<style>\n" + css + "\n</style>")
    for asset in sorted({m.group(1) for m in re.finditer(r'(?:src|href)="(\./assets/[^"]+)"', html)}):
        file_path = frontend / asset.replace("./", "")
        if not file_path.is_file():
            raise SystemExit(f"缺少资源文件：{file_path}")
        html = html.replace(asset, data_uri(file_path))

    # 去掉外链脚本，改为结尾内联
    html = html.replace('<script src="./app.js" defer></script>', "")
    html = html.replace('<script type="module" src="./scene.js"></script>', "")

    def wrap(js: str) -> str:
        return "<script>\n" + js.replace("</script", "<\\/script") + "\n</script>"

    scripts = "\n".join([wrap(three_js), wrap(data_js), wrap(app_js), wrap(scene_js)])
    if "</body>" not in html:
        raise SystemExit("index.html 缺少 </body>")
    html = html.replace("</body>", scripts + "\n</body>")

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html, encoding="utf-8")

    # 可选：同时导出中间产物，便于自动化测试
    if len(sys.argv) > 3:
        emit = Path(sys.argv[3])
        emit.mkdir(parents=True, exist_ok=True)
        (emit / "three.global.js").write_text(three_js, encoding="utf-8")
        (emit / "data.generated.js").write_text(data_js, encoding="utf-8")
        (emit / "app.js").write_text(app_js, encoding="utf-8")
        (emit / "scene.js").write_text(scene_js, encoding="utf-8")

    size_mb = output.stat().st_size / 1024 / 1024
    print(f"生成完成：{output}")
    print(f"体积：{size_mb:.2f} MB（three.js {len(three_js)/1024:.0f} KB，题库 {len(data_js)/1024:.0f} KB）")
    print(f"情景数：{len(backend_data.SCENARIOS)}，课程数：{len(backend_data.COURSES)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
