@echo off
chcp 65001 > nul
set PYTHONIOENCODING=utf-8
set NODE_DISABLE_COLORS=
call node_modules\.bin\tsx.CMD %*
