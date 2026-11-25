"""backend 包标记文件。

有这个文件，Python 才会把 backend 当成一个包，
`uvicorn backend.main:app` 才能正确找到 backend/main.py 里的 app。
"""
