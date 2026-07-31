# Pi 模型配置指南

Web、Android 原生 UI 和 Pi CLI 应读写同一份 Pi 模型配置。测试草稿不能污染已保存配置；命名配置只保存 `provider/modelId` 绑定，只有用户明确操作时才修改全局默认模型。

模型探测应尝试 OpenAI、Claude、Gemini 等适配方式，并允许用户手动填写模型 ID。
