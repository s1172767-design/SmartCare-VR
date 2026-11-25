"""启动入口。

在 PyCharm 里直接点绿色三角运行这个文件，等价于在终端执行：

    uvicorn backend.main:app --reload

启动后打开 http://127.0.0.1:8000 看网站，打开 http://127.0.0.1:8000/docs 看接口文档。
"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=True)
