#!/bin/bash
# 执行者被 owner 圈到后运行；ask 由执行者 app 发出（BOTMUX_LARK_APP_ID 已由 botmux 注入）；转换由轮末 eval 的独立 plan 完成。
exec python3 "$(dirname "$0")/p5-ask.py" reopen "$1"
