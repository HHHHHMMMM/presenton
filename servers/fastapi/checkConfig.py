#!/usr/bin/env python3
"""
诊断脚本 - 检查当前配置
运行方式: python check_config.py
"""

import os
import sys

# 添加项目路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils.get_env import (
    get_tool_calls_env,
    get_disable_thinking_env,
    get_custom_llm_url_env,
    get_custom_llm_api_key_env,
)
from utils.llm_provider import get_llm_provider, get_model
from utils.parsers import parse_bool_or_none
from enums.llm_provider import LLMProvider

print("=" * 60)
print("环境变量配置诊断")
print("=" * 60)

# 检查 LLM Provider
provider = get_llm_provider()
print(f"\n✓ LLM Provider: {provider}")
print(f"  Type: {type(provider)}")
print(f"  Is CUSTOM: {provider == LLMProvider.CUSTOM}")

# 检查模型
model = get_model()
print(f"\n✓ Model: {model}")

# 检查 Custom LLM 配置
if provider == LLMProvider.CUSTOM:
    custom_url = get_custom_llm_url_env()
    custom_key = get_custom_llm_api_key_env()
    print(f"\n✓ Custom LLM URL: {custom_url}")
    print(f"✓ Custom LLM API Key: {'*' * 10 if custom_key else 'None'}")

# 检查关键配置
tool_calls_raw = get_tool_calls_env()
tool_calls_parsed = parse_bool_or_none(tool_calls_raw)
disable_thinking_raw = get_disable_thinking_env()
disable_thinking_parsed = parse_bool_or_none(disable_thinking_raw)

print(f"\n✓ TOOL_CALLS 环境变量:")
print(f"  Raw value: {repr(tool_calls_raw)}")
print(f"  Parsed value: {tool_calls_parsed}")
print(f"  Will use tool calls: {tool_calls_parsed or False}")

print(f"\n✓ DISABLE_THINKING 环境变量:")
print(f"  Raw value: {repr(disable_thinking_raw)}")
print(f"  Parsed value: {disable_thinking_parsed}")

# 模拟 LLMClient 的判断
print(f"\n{'=' * 60}")
print("LLMClient 行为预测")
print("=" * 60)

if provider == LLMProvider.CUSTOM:
    use_tool_calls = parse_bool_or_none(tool_calls_raw) or False
    disable_thinking = parse_bool_or_none(disable_thinking_raw) or False

    print(f"\n✓ use_tool_calls_for_structured_output(): {use_tool_calls}")
    print(f"✓ disable_thinking(): {disable_thinking}")

    if use_tool_calls:
        print(f"\n⚠️  警告: TOOL_CALLS=true")
        print(f"   模型将使用 tool calls 来实现 structured output")
        print(f"   如果模型不支持 streaming tool calls，会导致提前截断")
        print(f"\n   建议: 设置 TOOL_CALLS=false 或删除该环境变量")
    else:
        print(f"\n✓ 正常: 将使用 json_schema 模式")
else:
    print(f"\n✓ 非 CUSTOM provider，不使用 tool calls")

print(f"\n{'=' * 60}")
print("所有相关环境变量")
print("=" * 60)
env_vars = [
    'LLM_PROVIDER',
    'MODEL',
    'CUSTOM_LLM_URL',
    'CUSTOM_LLM_API_KEY',
    'TOOL_CALLS',
    'DISABLE_THINKING',
    'WEB_GROUNDING',
]

for var in env_vars:
    value = os.getenv(var)
    if value:
        # 隐藏敏感信息
        if 'KEY' in var or 'TOKEN' in var:
            display_value = '*' * 10
        else:
            display_value = value
        print(f"  {var} = {display_value}")
    else:
        print(f"  {var} = (未设置)")

print(f"\n{'=' * 60}\n")